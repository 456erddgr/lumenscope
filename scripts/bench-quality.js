'use strict';
// 画质基准：① 防果冻（逐行卷帘校正）② 时域降噪强度
// 用法：node scripts/bench-quality.js
// 做法：在页面里直接 new 一个 Pipeline，用合成片源喂进去（不依赖真实摄像头），
//   ① 合成"整体平移 + 逐行错位"的卷帘片源 → 量各行位移对 y 的斜率（斜率越小越直）
//   ② 合成"静态高细节 + 每帧随机噪声"片源 → 量时域噪声（相邻帧/多帧标准差）与细节保留
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.CHROME,
].filter(Boolean).find((p) => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9411);
const URL = process.env.URL_BASE || 'http://127.0.0.1:4173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    return new CDP(ws);
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error((ex && (ex.description || ex.value)) || r.exceptionDetails.text);
    }
    return r.result && r.result.value;
  }
}

const PAGE = `(() => {
  const W = 1280, H = 720;

  // —— 静态高细节底图（细胞斑点 + 纤维 + 可选细网格），宽 2*W 便于平移取窗 ——
  // 卷帘测量必须关掉网格：16px 周期图案会让逐行 SAD 匹配产生周期性歧义（测出来全是噪声）
  function makeScene(withGrid) {
    const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#101215'; c.fillRect(0, 0, W * 2, H);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 420; i++) {
      const x = rnd() * W * 2, y = rnd() * H, r = 4 + rnd() * 26;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      const v = 60 + rnd() * 150;
      g.addColorStop(0, 'rgba(' + (v + 60) + ',' + (v + 55) + ',' + (v + 40) + ',0.95)');
      g.addColorStop(0.65, 'rgba(' + v + ',' + v + ',' + (v - 10) + ',0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    }
    c.lineWidth = 1.6;
    for (let i = 0; i < 160; i++) {
      const x = rnd() * W * 2, y = rnd() * H;
      c.strokeStyle = 'rgba(180,200,215,' + (0.15 + rnd() * 0.4) + ')';
      c.beginPath(); c.moveTo(x, y);
      c.bezierCurveTo(x + 40 - rnd() * 80, y + 30 - rnd() * 60, x + 90 - rnd() * 120, y + 70 - rnd() * 90, x + 120 - rnd() * 160, y + 90 - rnd() * 120);
      c.stroke();
    }
    if (withGrid) {
      c.strokeStyle = 'rgba(255,255,255,0.13)';
      for (let x = 0; x < W * 2; x += 16) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
      for (let y = 0; y < H; y += 16) { c.beginPath(); c.moveTo(0, y); c.lineTo(W * 2, y); c.stroke(); }
    }
    // 非周期性竖条：给每一行都留下强水平结构，逐行位移测量才可靠
    let x = 8;
    while (x < W * 2 - 40) {
      const bw = 3 + Math.floor(rnd() * 22);
      const a = 0.25 + rnd() * 0.55;
      c.fillStyle = 'rgba(240,244,250,' + a.toFixed(2) + ')';
      c.fillRect(x, 0, bw, H);
      x += bw + 6 + Math.floor(rnd() * 30);
    }
    return cv;
  }

  // 卷帘片源：整体平移 pan 像素 + 每行额外错位 skew*(y/H-0.5) 像素
  // 单帧生成：便于按真实帧间隔动态注入（注入量与"一帧内的实际运动"必须自洽）
  function rollingFrame(scene, pan, skew) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const band = 2;
    for (let y = 0; y < H; y += band) {
      const extra = skew * ((y + band / 2) / H - 0.5);
      const sx = Math.max(0, Math.min(W - 1, pan + extra + (W / 2)));
      c.drawImage(scene, sx, y, W, band, 0, y, W, band);
    }
    return cv;
  }

  function makeRollingFrames(scene, n, panPer, skew) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(rollingFrame(scene, i * panPer, skew));
    return out;
  }

  // 噪声片源：静态底图 + 每帧独立高斯噪声（σ = sigma/255）
  function makeNoisyFrames(scene, n, sigma) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.drawImage(scene, W / 2, 0, W, H, 0, 0, W, H);
      const img = c.getImageData(0, 0, W, H);
      const d = img.data;
      // Box-Muller，成对生成
      for (let p = 0; p < d.length; p += 4) {
        const u1 = Math.max(1e-6, Math.random()), u2 = Math.random();
        const g1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(6.2832 * u2);
        const g2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(6.2832 * u2);
        const n1 = g1 * sigma, n2 = g2 * sigma;
        d[p] = Math.max(0, Math.min(255, d[p] + n1));
        d[p + 1] = Math.max(0, Math.min(255, d[p + 1] + n1));
        d[p + 2] = Math.max(0, Math.min(255, d[p + 2] + n2));
      }
      c.putImageData(img, 0, 0);
      out.push(cv);
    }
    return out;
  }

  function luma(img, W, H) {
    const out = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (img[p] * 77 + img[p + 1] * 150 + img[p + 2] * 29) >> 8;
    return out;
  }

  // 逐行位移：每行亮度剖面与中心行做 SAD 匹配，返回 (y, dx) 列表
  function rowShifts(L, W, H) {
    const ref = H >> 1, out = [];
    for (let y = 60; y < H - 60; y += 16) {
      const sads = [];
      for (let dx = -10; dx <= 10; dx++) {
        let s = 0;
        for (let x = 80; x < W - 80; x++) s += Math.abs(L[y * W + x] - L[ref * W + x + dx]);
        sads.push(s);
      }
      let bi = 0;
      for (let i = 1; i < sads.length; i++) if (sads[i] < sads[bi]) bi = i;
      // 抛物线亚像素细化，避免整数量化把斜率测歪
      const s0 = sads[Math.max(0, bi - 1)], s1 = sads[bi], s2 = sads[Math.min(sads.length - 1, bi + 1)];
      const den = s0 - 2 * s1 + s2;
      const sub = Math.abs(den) > 1e-9 ? 0.5 * (s0 - s2) / den : 0;
      out.push([y, (bi - 10) + Math.max(-0.5, Math.min(0.5, sub))]);
    }
    return out;
  }

  // PSNR（RGB，忽略 alpha）
  function psnr(a, b) {
    let se = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      for (let k = 0; k < 3; k++) { const d = a[i + k] - b[i + k]; se += d * d; n++; }
    }
    const mse = se / n;
    return mse <= 1e-9 ? 99 : 10 * Math.log10(255 * 255 / mse);
  }

  // 拟合 dx = a*y + b，返回斜率（像素/帧高）与去线性后的残差 RMS
  function fitSlope(pairs, H) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = pairs.length;
    for (const [y, dx] of pairs) { const t = y / H; sx += t; sy += dx; sxx += t * t; sxy += t * dx; }
    const a = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
    const b = (sy - a * sx) / n;
    let rms = 0;
    for (const [y, dx] of pairs) { const e = dx - (a * (y / H) + b); rms += e * e; }
    return { slope: a, rms: Math.sqrt(rms / n) };
  }

  function laplacianVar(L, W, H) {
    let m = 0, m2 = 0, n = 0;
    for (let y = 2; y < H - 2; y += 2) {
      for (let x = 2; x < W - 2; x += 2) {
        const i = y * W + x;
        const v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - W] - L[i + W];
        m += v; m2 += v * v; n++;
      }
    }
    m /= n; m2 /= n;
    return m2 - m * m;
  }

  window.__Q = {
    W, H, makeScene, makeRollingFrames, rollingFrame, makeNoisyFrames, luma, rowShifts, fitSlope, laplacianVar, psnr,
    // 干净参考帧（与噪声片源同一裁剪、同一尺寸），用于算 PSNR
    cleanFrame() {
      const s = makeScene(true);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      cv.getContext('2d').drawImage(s, W / 2, 0, W, H, 0, 0, W, H);
      const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
      return new Uint8ClampedArray(d).slice();
    },
    mk(settings) {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      cv.style.cssText = 'width:' + W + 'px;height:' + H + 'px;position:fixed;left:-9999px';
      document.body.appendChild(cv);
      const p = new window.LumenPipeline.Pipeline(cv);
      Object.assign(p.settings, settings);
      p._benchCanvas = cv;
      p._benchOrigUpload = p.r.uploadSource;
      return p;
    },
    feed(p, frame) {
      p.r.uploadSource = (src, w, h) => p._benchOrigUpload(frame, W, H);
      p.render(frame);
    },
    read(p) {
      const f = p.readStream(W, H);
      return new Uint8ClampedArray(f.buf.buffer, f.buf.byteOffset, f.buf.length).slice();
    },
  };
  return 'ok';
})()`;

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'lumen-bench-' + PORT),
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
    '--window-size=1400,900', '--force-device-scale-factor=1',
    URL + '/src/index.html',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(400);
      try { target = (await get(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch (_) {}
    }
    if (!target) throw new Error('无法连接 Chrome');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await sleep(1500);
    await cdp.eval(PAGE);

    const RESULT = { rolling: [], denoise: [] };

    // ============ ① 防果冻 ============
    const RS_N = 22, PAN = 6, SKEW = 6;
    for (const rolling of [false, true]) {
      const r = await cdp.eval(`(async () => {
        const Q = window.__Q;
        const s = Q.makeScene(false);
        const p = Q.mk({
          outputHeight: 720, stabilise: false, rollingShutter: ${rolling}, rollingStrength: 1.0,
          denoise: 0, sharpen: 0, superRes: false, autoExposure: false, autoWhiteBalance: false,
          dither: 0, exposure: 1, contrast: 1, saturation: 1, userZoom: 1,
        });
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let last = null, tPrev = 0, pan = 0, lastSkew = 0;
        for (let i = 0; i < ${RS_N}; i++) {
          const now = performance.now();
          const dt = tPrev ? (now - tPrev) : 33.3;
          tPrev = now;
          // 注入的逐行错位 = 一帧内的实际运动 × 读出时间占比(0.92)，
          // 与流水线内部"读出时间 = 0.92 × 帧周期"的假设保持自洽
          const skew = ${PAN} * 0.92 * (dt / 1000) / (1 / 30);
          lastSkew = skew;
          Q.feed(p, Q.rollingFrame(s, pan, skew));
          pan += ${PAN};
          if (i === ${RS_N} - 1) last = Q.read(p);
          await wait(34);
        }
        const L = Q.luma(last, Q.W, Q.H);
        const fit = Q.fitSlope(Q.rowShifts(L, Q.W, Q.H), Q.H);
        // 诊断：流水线实际施加的逐行采样偏移跨度（像素）与最后注入的错位量（像素）
        let lo = 1e9, hi = -1e9;
        for (let i = 0; i < 16; i++) { const v = p.rsRows[i * 2] * Q.W; if (v < lo) lo = v; if (v > hi) hi = v; }
        return { slope: +fit.slope.toFixed(3), rms: +fit.rms.toFixed(3),
                 appliedSpanPx: +(hi - lo).toFixed(2), lastSkewPx: +lastSkew.toFixed(2), rsOn: !!p.rsOn,
                 histN: p.camHist.length, mvTx: +(((p.motion || {}).last || {}).tx || 0).toFixed(3) };
      })()`);
      RESULT.rolling.push({ rolling, ...r });
      await sleep(200);
    }

    // ============ ② 时域降噪 ============
    const DN_N = 26, WARM = 10, SIGMA = 9;
    for (const denoise of [0, 0.35, 0.55, 0.9]) {
      const r = await cdp.eval(`(async () => {
        const Q = window.__Q;
        const s = Q.makeScene(true);
        const frames = Q.makeNoisyFrames(s, ${DN_N}, ${SIGMA});
        const clean = Q.cleanFrame();
        const p = Q.mk({
          outputHeight: 720, stabilise: false, rollingShutter: false, denoise: ${denoise},
          sharpen: 0, superRes: false, autoExposure: false, autoWhiteBalance: false,
          dither: 0, exposure: 1, contrast: 1, saturation: 1, userZoom: 1,
        });
        const keep = [];
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < frames.length; i++) {
          Q.feed(p, frames[i]);
          if (i >= ${WARM}) keep.push(Q.read(p));
          await wait(34);
        }
        const n = keep.length, N = Q.W * Q.H;
        const sums = new Float64Array(N), sums2 = new Float64Array(N);
        const lumas = keep.map((f) => Q.luma(f, Q.W, Q.H));
        for (const L of lumas) for (let i = 0; i < N; i++) { const v = L[i]; sums[i] += v; sums2[i] += v * v; }
        let tnoise = 0;
        for (let i = 0; i < N; i++) { const m = sums[i] / n; tnoise += Math.max(0, sums2[i] / n - m * m); }
        tnoise = Math.sqrt(tnoise / N);
        const lastL = lumas[lumas.length - 1];
        // 落盘一张便于肉眼看：把最后一帧画到 canvas 再取 dataURL
        const dbgCv = document.createElement('canvas'); dbgCv.width = Q.W; dbgCv.height = Q.H;
        const dbgCtx = dbgCv.getContext('2d');
        const im = dbgCtx.createImageData(Q.W, Q.H);
        im.data.set(keep[keep.length - 1]);
        dbgCtx.putImageData(im, 0, 0);
        return { tnoise: +tnoise.toFixed(3), lap: +Q.laplacianVar(lastL, Q.W, Q.H).toFixed(0),
                 psnr: +Q.psnr(keep[keep.length - 1], clean).toFixed(2), png: dbgCv.toDataURL('image/png') };
      })()`);
      RESULT.denoise.push({ denoise, ...r });
      if (r.png) {
        fs.writeFileSync(path.join(__dirname, '..', 'docs', 'shots', `bench-dn-${String(denoise).replace('.', '')}.png`),
          Buffer.from(String(r.png).split(',')[1], 'base64'));
        delete r.png;
      }
      await sleep(200);
    }

    // 参考：无噪声输入的清晰度上限
    const cleanLap = await cdp.eval(`(() => {
      const Q = window.__Q;
      const s = Q.makeScene();
      const cv = document.createElement('canvas'); cv.width = Q.W; cv.height = Q.H;
      const c = cv.getContext('2d'); c.drawImage(s, Q.W / 2, 0, Q.W, Q.H, 0, 0, Q.W, Q.H);
      const L = Q.luma(c.getImageData(0, 0, Q.W, Q.H).data, Q.W, Q.H);
      return +Q.laplacianVar(L, Q.W, Q.H).toFixed(0);
    })()`);

    console.log('\n=== ① 防果冻（注入 ' + SKEW + 'px 逐行错位，整体平移 ' + PAN + 'px/帧）===');
    console.log('  行位移-高度 斜率（越接近 0 越直）  去线性残差 RMS');
    for (const r of RESULT.rolling) {
      console.log(`  ${r.rolling ? '校正开' : '校正关'}: slope ${String(r.slope).padStart(7)} px   rms ${r.rms} px   [补偿 ${r.appliedSpanPx}px / 注入 ${r.lastSkewPx}px / mv.tx ${r.mvTx}px]`);
    }
    const off = RESULT.rolling.find((r) => !r.rolling), on = RESULT.rolling.find((r) => r.rolling);
    if (off && on) console.log(`  → 果冻幅度降低 ${(100 * (1 - Math.abs(on.slope) / Math.max(1e-6, Math.abs(off.slope)))).toFixed(1)}%`);

    console.log('\n=== ② 时域降噪（输入噪声 σ=' + SIGMA + '/255，静态场景）===');
    console.log('  降噪强度   时域噪声   清晰度    PSNR(vs 干净参考)');
    console.log(`  （干净参考清晰度 = ${cleanLap}；输入本身的 PSNR ≈ ${(20 * Math.log10(255 / SIGMA)).toFixed(1)} dB）`);
    for (const r of RESULT.denoise) {
      console.log(`  ${String(r.denoise).padEnd(9)}  ${String(r.tnoise).padStart(8)}   ${String(r.lap).padStart(6)}    ${r.psnr} dB`);
    }

    // 只存数值结果：截图（dataURL）不进 JSON，否则文件涨到十几 MB
    const slim = (rows) => rows.map(({ png, ...rest }) => rest);
    const json = {
      sigma: SIGMA, cleanLap,
      rolling: RESULT.rolling.map(({ png, ...r }) => r),
      denoise: slim(RESULT.denoise),
    };
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'bench-quality.json'), JSON.stringify(json, null, 2) + '\n');
    console.log('\n结果已写入 docs/bench-quality.json');
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('基准失败：', e.message); process.exit(1); });
