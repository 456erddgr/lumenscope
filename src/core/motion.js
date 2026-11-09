'use strict';
// 全局运动估计与稳像，方法参考 vid.stab（Georg Martius, LGPL-2.1）与 One-Euro 滤波（Casiez 2012）。
// 要点（全部由 vid.stab 源码核实）：
//   1. 选场：用 Michelson 对比度 (max-min)/(max+min+0.1) 给每个测量块打分，取对比度最高的若干块，
//      纹理不足的块直接丢弃 —— 这是它比"均匀网格全用"更稳的关键。
//   2. 搜索：粗到细（stepSize 逐次减半）在对数范围内找 SAD 最小；命中已优于当前最优就提前终止。
//   3. 局部→全局：块位移按对比度加权做最小二乘，拟合相似变换（平移 + 旋转 + 缩放）。
//   4. 平滑：滑动平均低通（s = 1/(smoothing+1)），高频部分作为补偿量；补偿越界就自动加一点 zoom。
(function (g) {
  const ANALYSIS_W = 480;     // 分析层宽度（480×270 足够估全局运动，CPU 便宜）
  const FINE_W = 960;         // 精细层宽度

  // ---------- 取帧 ----------
  function createGrabber() {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true, alpha: false, desynchronized: true });
    return {
      c, ctx,
      grab(el, sw, sh, targetW) {
        const h = Math.max(2, Math.round(targetW * sh / sw));
        if (c.width !== targetW || c.height !== h) { c.width = targetW; c.height = h; }
        ctx.drawImage(el, 0, 0, sw, sh, 0, 0, targetW, h);
        return ctx.getImageData(0, 0, targetW, h);
      },
    };
  }

  function toLuma(img) {
    const { data, width, height } = img;
    const out = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      // 整数亮度（BT.601），比浮点快，精度足够做块匹配
      out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    return { data: out, w: width, h: height };
  }

  function half(level) {
    const w = Math.max(2, level.w >> 1), h = Math.max(2, level.h >> 1);
    const out = new Uint8Array(w * h);
    const s = level.data, sw = level.w;
    for (let y = 0; y < h; y++) {
      const r0 = (y * 2) * sw, r1 = r0 + sw;
      for (let x = 0; x < w; x++) {
        const x0 = x * 2;
        out[y * w + x] = (s[r0 + x0] + s[r0 + x0 + 1] + s[r1 + x0] + s[r1 + x0 + 1]) >> 2;
      }
    }
    return { data: out, w, h };
  }

  // ---------- 对比度（vid.stab 的 Michelson 对比度）----------
  function michelson(img, cx, cy, size) {
    const { data, w, h } = img;
    const r = size >> 1;
    const x0 = Math.max(0, cx - r), x1 = Math.min(w - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(h - 1, cy + r);
    let mn = 255, mx = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const v = data[row + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    return (mx - mn) / (mx + mn + 0.1);
  }

  // SAD 比较：dst 为当前帧，src 为上一帧；早停阈值 best
  function sad(cur, prev, cx, cy, size, dx, dy, best) {
    const { data: C, w, h } = cur;
    const { data: P } = prev;
    const r = size >> 1;
    let sum = 0;
    for (let y = 0; y < size; y++) {
      const py = cy - r + y;
      const sy = py + dy;
      if (sy < 0 || sy >= h) return Infinity;
      const cr = (py) * w, sr = (sy) * w;
      for (let x = 0; x < size; x++) {
        const px = cx - r + x;
        const sx = px + dx;
        if (sx < 0 || sx >= w) return Infinity;
        sum += Math.abs(C[cr + px] - P[sr + sx]);
        if (sum > best) return sum;  // 早停
      }
      if (sum > best) return sum;
    }
    return sum;
  }

  // 单块粗到细搜索
  function matchField(cur, prev, cx, cy, size, maxShift, stepSize, seedDx, seedDy) {
    let best = Infinity, bdx = seedDx, bdy = seedDy;
    const tryShift = (dx, dy) => {
      const e = sad(cur, prev, cx, cy, size, dx, dy, best);
      if (e < best) { best = e; bdx = dx; bdy = dy; }
    };
    // 先试预测位置，命中好值能大幅剪枝
    tryShift(seedDx, seedDy);
    tryShift(0, 0);
    let step = stepSize;
    while (step >= 1) {
      const around = [];
      for (let dx = -step; dx <= step; dx += step) {
        for (let dy = -step; dy <= step; dy += step) {
          if (!dx && !dy) continue;
          around.push([dx, dy]);
        }
      }
      for (const [dx, dy] of around) {
        const nx = bdx + dx, ny = bdy + dy;
        if (Math.abs(nx) > maxShift || Math.abs(ny) > maxShift) continue;
        tryShift(nx, ny);
      }
      step = step >> 1;
    }
    if (!isFinite(best)) return null;
    // 亚像素细化：整数格点搜索在分析层（480 宽）上相当于原生 2.67 像素一格，
    // 不细化会系统性少读运动（实测 6px 的运动只报 5.33px）。
    // 用最优格点及其 4 邻域的 SAD 做抛物线拟合，精度到 ~0.1 像素。
    const par = (a, b, c) => {
      const den = a - 2 * b + c;
      if (Math.abs(den) < 1e-9) return 0;
      const t = 0.5 * (a - c) / den;
      return t > 0.5 ? 0.5 : (t < -0.5 ? -0.5 : t);
    };
    const e0 = sad(cur, prev, cx, cy, size, bdx, bdy, Infinity);
    let sx = 0, sy = 0;
    if (isFinite(e0)) {
      const ex1 = sad(cur, prev, cx, cy, size, bdx + 1, bdy, Infinity);
      const ex0 = sad(cur, prev, cx, cy, size, bdx - 1, bdy, Infinity);
      const ey1 = sad(cur, prev, cx, cy, size, bdx, bdy + 1, Infinity);
      const ey0 = sad(cur, prev, cx, cy, size, bdx, bdy - 1, Infinity);
      if (isFinite(ex1) && isFinite(ex0)) sx = par(ex0, e0, ex1);
      if (isFinite(ey1) && isFinite(ey0)) sy = par(ey0, e0, ey1);
    }
    return { dx: bdx + sx, dy: bdy + sy, error: best / (size * size) };
  }

  // ---------- 相似变换拟合 ----------
  // 位移 d = t + ω·perp(p) + (s-1)·p；返回 {tx, ty, rot, scale, ok}
  function fitSimilarity(samples, scale) {
    if (samples.length < 4) return { tx: 0, ty: 0, rot: 0, scale: 1, ok: false };
    let mx = 0, my = 0, wsum = 0;
    for (const s of samples) { mx += s.x * s.w; my += s.y * s.w; wsum += s.w; }
    mx /= wsum; my /= wsum;

    let A00 = 0, A02 = 0, A03 = 0, A11 = 0, A12 = 0, A13 = 0, A22 = 0, A33 = 0;
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
    for (const s of samples) {
      const x = s.x - mx, y = s.y - my, w = s.w;
      A00 += w; A11 += w;
      A02 += -w * y; A03 += w * x;
      A12 += w * x; A13 += w * y;
      A22 += w * (x * x + y * y);
      A33 += w * (x * x + y * y);
      b0 += w * s.dx; b1 += w * s.dy;
      b2 += w * (-y * s.dx + x * s.dy);
      b3 += w * (x * s.dx + y * s.dy);
    }
    // 4x4 对称正定 → 高斯消元
    const M = [
      [A00, 0, A02, A03, b0],
      [0, A11, A12, A13, b1],
      [A02, A12, A22, 0, b2],
      [A03, A13, 0, A33, b3],
    ];
    for (let i = 0; i < 4; i++) {
      let piv = i;
      for (let k = i + 1; k < 4; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      if (Math.abs(M[piv][i]) < 1e-7) return { tx: 0, ty: 0, rot: 0, scale: 1, ok: false };
      if (piv !== i) { const t = M[i]; M[i] = M[piv]; M[piv] = t; }
      const p = M[i][i];
      for (let j = i; j <= 4; j++) M[i][j] /= p;
      for (let k = 0; k < 4; k++) {
        if (k === i) continue;
        const f = M[k][i];
        if (!f) continue;
        for (let j = i; j <= 4; j++) M[k][j] -= f * M[i][j];
      }
    }
    const omega = M[2][4], ds = M[3][4];
    return {
      tx: M[0][4] * scale,
      ty: M[1][4] * scale,
      rot: Math.max(-0.08, Math.min(0.08, omega)),
      scale: Math.max(0.96, Math.min(1.04, 1 + ds)),
      ok: true,
    };
  }

  // ---------- 滑动平均低通（vid.stab vsLowPassTransforms）----------
  class Smoothing {
    constructor() { this.reset(15); }
    reset(frames) { this.n = frames; this.init = false; this.avg = { x: 0, y: 0, a: 0 }; this.zoomAvg = 0; this.accum = { x: 0, y: 0, a: 0 }; }
    // 输入相对位移，输出应施加的补偿（同样相对）与所需 zoom（像素比例）
    step(t, w, h) {
      if (!this.init) { this.avg = { ...t }; this.init = true; return { x: 0, y: 0, a: 0, zoom: 0 }; }
      const s = 1 / (this.n + 1);
      const tau = 1 / (3 * (this.n + 1));
      this.avg.x += (t.x - this.avg.x) * s;
      this.avg.y += (t.y - this.avg.y) * s;
      this.avg.a += (t.a - this.avg.a) * s;
      // 低通：高频就是抖动量
      let nx = t.x - this.avg.x;
      let ny = t.y - this.avg.y;
      let na = t.a - this.avg.a;
      // 补偿量 = 当前轨迹与平滑轨迹之差（即"抖动"本身）。
      // 注意：这里刻意不做绝对累积——累积会把恒定的漂移不断放大成几十像素的偏移。
      // 用 tau 做一阶低通，让补偿量本身也平滑，避免逐帧跳动。
      this.accum.x += (nx - this.accum.x) * (1 - tau);
      this.accum.y += (ny - this.accum.y) * (1 - tau);
      this.accum.a += (na - this.accum.a) * (1 - tau);
      // 自适应 zoom：补偿越大越要放大，保证不露出黑边（按像素归一化）
      const need = Math.max(Math.abs(this.accum.x) / w, Math.abs(this.accum.y) / h) * 1.35;
      this.zoomAvg = this.zoomAvg * (1 - s) + need * s;
      return { x: this.accum.x, y: this.accum.y, a: this.accum.a, zoom: this.zoomAvg + 0.004 };
    }
  }

  class MotionAnalyzer {
    constructor() {
      this.grabber = createGrabber();
      this.prev = null;
      this.prevW = 0;
      this.grid = { cols: 8, rows: 6 };
      this.fieldSize = 0;
      this.maxShift = 0;
      this.pred = { dx: 0, dy: 0 };
      this.smooth = new Smoothing();
      this.last = { tx: 0, ty: 0, rot: 0, scale: 1, conf: 0, zoom: 1, raw: { x: 0, y: 0 } };
      this.prevMotion = { dx: 0, dy: 0 };
    }

    analyze(video, vw, vh, nowSec) {
      const img = this.grabber.grab(video, vw, vh, ANALYSIS_W);
      const cur = toLuma(img);

      if (!this.prev || this.prevW !== cur.w) {
        this.prev = cur; this.prevW = cur.w;
        this.fieldSize = Math.max(12, Math.round(cur.w / 22) | 0);
        this.maxShift = Math.max(6, Math.round(cur.w / 40) | 0);
        this.smooth.reset(this.smooth.n);
        return { ...this.last, conf: 0, zoom: 1 };
      }

      const { cols, rows } = this.grid;
      const stepX = (cur.w - 2 * this.maxShift - this.fieldSize) / cols;
      const stepY = (cur.h - 2 * this.maxShift - this.fieldSize) / rows;
      const size = this.fieldSize;

      // 1) 选场：算所有块的对比度，取最高的 60%（vid.stab 的做法）
      const fields = [];
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          const cx = Math.round(this.maxShift + size / 2 + stepX * (rx + 0.5));
          const cy = Math.round(this.maxShift + size / 2 + stepY * (ry + 0.5));
          const contrast = michelson(cur, cx, cy, size);
          fields.push({ cx, cy, contrast });
        }
      }
      fields.sort((a, b) => b.contrast - a.contrast);
      const keepN = Math.max(6, Math.round(fields.length * 0.6));
      const selected = fields.slice(0, keepN).filter(f => f.contrast > 0.02);

      // 2) 逐块粗到细搜索
      const samples = [];
      for (const f of selected) {
        const m = matchField(cur, this.prev, f.cx, f.cy, size, this.maxShift, Math.max(2, this.maxShift >> 1), this.prevMotion.dx, this.prevMotion.dy);
        if (!m) continue;
        // 匹配质量：误差越低越可信；对比度越高越可信
        const quality = 1 / (1 + m.error * 0.55);
        const w = quality * quality * (1 + f.contrast * 6);
        if (quality < 0.25) continue;
        samples.push({ x: f.cx, y: f.cy, dx: m.dx, dy: m.dy, w, contrast: f.contrast, err: m.error });
      }

      if (samples.length < 4) {
        this.prev = cur;
        return { ...this.last, conf: 0 };
      }

      // 3) 拟合相似变换（全分辨率比例）
      const scale = vw / cur.w;
      const fit = fitSimilarity(samples, scale);
      // 旋转量在分析层是像素，这里换算成弧度：块中心到图片中心的最大半径
      const radius = cur.w * 0.5;
      const rot = fit.ok ? fit.rot / radius : 0;

      // 置信度：参与块数 × 平均质量
      let qsum = 0;
      for (const s of samples) qsum += s.w;
      const conf = Math.min(1, (samples.length / (cols * rows)) * 1.8) * Math.min(1, qsum / samples.length / 0.6);

      // 4) 低通平滑 → 补偿量
      const comp = this.smooth.step({ x: fit.tx, y: fit.ty, a: rot }, vw, vh);

      this.prev = cur;
      this.prevMotion = { dx: Math.round(fit.tx / scale), dy: Math.round(fit.ty / scale) };
      this.last = {
        tx: fit.tx, ty: fit.ty, rot, scale: fit.scale,
        conf,
        dz: comp.x, dy: comp.y, drot: comp.a,
        zoom: 1 + Math.max(0, comp.zoom),
        raw: { x: fit.tx, y: fit.ty },
        jitter: Math.hypot(fit.tx - this.smooth.avg.x, fit.ty - this.smooth.avg.y),
      };
      return this.last;
    }

    reset() { this.prev = null; this.prevW = 0; this.smooth.reset(this.smooth.n); this.prevMotion = { dx: 0, dy: 0 }; }
  }

  g.LumenMotion = { MotionAnalyzer, Smoothing };
})(window);
