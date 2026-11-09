'use strict';
// 超分引擎基准：把 1080p 高清图降采样成 720p 当作"摄像头输入"，
// 再用不同超分引擎放大回 1080p，与原始 1080p 比较 PSNR / 结构相似度。
// 只测"重建保真度"这一件事：防抖/降噪/自动曝光全部关掉。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { listen } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT_CDP = Number(process.env.CDP_PORT || 9371);
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); }
  static async connect(u) { const ws = new WebSocket(u); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result && r.result.value; }
}

// 在页面里执行的基准代码
const PAGE_CODE = `
window.__benchUp = function (engine) {
  const p = window.__lumenDebug.pipeline;
  const s = p.settings;
  s.upscaler = engine; s.superRes = true; s.outputHeight = 1080;
  s.stabilise = false; s.rollingShutter = false; s.denoise = 0; s.cropRatio = 0;
  s.autoExposure = false; s.autoWhiteBalance = false;
  s.exposure = 1; s.contrast = 1; s.saturation = 1; s.sharpen = 0.35; s.userZoom = 1;

  if (!window.__gt) window.__gt = makeScene();
  const { gt, input } = window.__gt;

  const orig = p.r.uploadSource;
  p.r.uploadSource = (src, w, h) => orig(input, w, h);
  p.resetAll && p.resetAll();
  p.render({ videoWidth: 1280, videoHeight: 720, readyState: 4 });
  p.r.uploadSource = orig;

  const f = p.readStream(1920, 1080);           // 已做垂直翻转
  const got = new Uint8ClampedArray(f.buf.buffer, f.buf.byteOffset, f.buf.length);
  // 对齐搜索：超分输出与参考帧可能有 ±1px 相位差或整体翻转，先找最佳对齐再算指标
  let best = null;
  for (const flip of [false, true]) {
    const ref = flip ? window.__gtRaw : window.__gtRef;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const m = metrics(got, ref, 1920, 1080, dx, dy);
        if (!best || m.psnr > best.psnr) best = Object.assign({ dx, dy, flip }, m);
      }
    }
  }
  return best;
};

function makeScene() {
  const W = 1920, H = 1080;
  const gt = document.createElement('canvas'); gt.width = W; gt.height = H;
  const g = gt.getContext('2d');
  // 背景
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#14202c'); bg.addColorStop(0.5, '#20303f'); bg.addColorStop(1, '#101a24');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // 细胞/颗粒
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 220; i++) {
    const x = rnd() * W, y = rnd() * H, r = 6 + rnd() * 46;
    const v = 90 + rnd() * 140;
    const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    grd.addColorStop(0, 'rgba(' + (v | 0) + ',' + ((v * 0.98) | 0) + ',' + ((v * 0.9) | 0) + ',0.95)');
    grd.addColorStop(1, 'rgba(' + ((v * 0.35) | 0) + ',' + ((v * 0.4) | 0) + ',' + ((v * 0.45) | 0) + ',0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  // 高频细节：细线网格 + 细长纤维（超分最容易糊掉的东西）
  g.strokeStyle = 'rgba(210,235,255,0.55)';
  for (let i = 0; i < 90; i++) {
    g.lineWidth = 1 + rnd() * 1.6;
    g.beginPath();
    const x0 = rnd() * W, y0 = rnd() * H;
    g.moveTo(x0, y0);
    g.bezierCurveTo(x0 + rnd() * 200 - 100, y0 + rnd() * 200 - 100, x0 + rnd() * 300 - 150, y0 + rnd() * 300 - 150, x0 + rnd() * 260 - 130, y0 + rnd() * 260 - 130);
    g.stroke();
  }
  g.strokeStyle = 'rgba(120,160,200,0.35)'; g.lineWidth = 1;
  for (let x = 0; x < W; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y < H; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  // 噪声（模拟传感器）
  const id = g.getImageData(0, 0, W, H);
  for (let i = 0; i < id.data.length; i += 4) {
    const n = (rnd() - 0.5) * 8;
    id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
  }
  g.putImageData(id, 0, 0);

  // 720p 输入：面积平均降采样（浏览器高质量缩放）
  const input = document.createElement('canvas'); input.width = 1280; input.height = 720;
  const ig = input.getContext('2d');
  ig.imageSmoothingEnabled = true; ig.imageSmoothingQuality = 'high';
  ig.drawImage(gt, 0, 0, 1280, 720);

  // 参考帧：把 GT 转成与 readPixels 一致的"自下而上"像素序
  const rc = document.createElement('canvas'); rc.width = W; rc.height = H;
  const rg = rc.getContext('2d');
  rg.translate(0, H); rg.scale(1, -1); rg.drawImage(gt, 0, 0);
  window.__gtRef = rg.getImageData(0, 0, W, H).data;
  const rc2 = document.createElement('canvas'); rc2.width = W; rc2.height = H;
  rc2.getContext('2d').drawImage(gt, 0, 0);
  window.__gtRaw = rc2.getContext('2d').getImageData(0, 0, W, H).data;
  return { gt, input };
}

function metrics(a, b, W, H, sx, sy) {
  sx = sx || 0; sy = sy || 0;
  let se = 0, n = 0;
  let ma = 0, mb = 0;
  const la = new Float32Array(W * H), lb = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      const ia = p * 4, ib = ((y + sy) * W + (x + sx)) * 4;
      const ya = 0.2126 * a[ia] + 0.7152 * a[ia + 1] + 0.0722 * a[ia + 2];
      const yb = 0.2126 * b[ib] + 0.7152 * b[ib + 1] + 0.0722 * b[ib + 2];
      la[p] = ya; lb[p] = yb; ma += ya; mb += yb;
      const d = ya - yb; se += d * d; n++;
    }
  }
  ma /= n; mb /= n;
  const mse = se / n;
  const psnr = mse <= 0.0001 ? 99 : 10 * Math.log10((255 * 255) / mse);
  // 全局 SSIM（简化版，按 8x8 块统计）
  const C1 = 6.5025, C2 = 58.5225;
  let ssimSum = 0, blocks = 0;
  const B = 8;
  for (let by = 0; by + B <= H; by += B) {
    for (let bx = 0; bx + B <= W; bx += B) {
      let s1 = 0, s2 = 0, s11 = 0, s22 = 0, s12 = 0;
      for (let y = by; y < by + B; y++) {
        for (let x = bx; x < bx + B; x++) {
          const p = y * W + x; const v1 = la[p], v2 = lb[p];
          s1 += v1; s2 += v2; s11 += v1 * v1; s22 += v2 * v2; s12 += v1 * v2;
        }
      }
      const k = B * B;
      const u1 = s1 / k, u2 = s2 / k;
      const v1 = s11 / k - u1 * u1, v2 = s22 / k - u2 * u2, cv = s12 / k - u1 * u2;
      ssimSum += ((2 * u1 * u2 + C1) * (2 * cv + C2)) / ((u1 * u1 + u2 * u2 + C1) * (v1 + v2 + C2));
      blocks++;
    }
  }
  // 锐度：拉普拉斯方差
  let lap = 0, cnt = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    const l = 4 * la[p] - la[p - 1] - la[p + 1] - la[p - W] - la[p + W];
    lap += l * l; cnt++;
  }
  return { psnr: +psnr.toFixed(3), ssim: +(ssimSum / blocks).toFixed(4), sharpness: +(lap / cnt).toFixed(1) };
}
`;

(async () => {
  const { server, port } = await listen(ROOT, 0);
  const args = ['--headless=new', `--remote-debugging-port=${PORT_CDP}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
    '--no-first-run', `--user-data-dir=${path.join(os.tmpdir(), 'lumen-bench-' + Date.now())}`,
    `http://127.0.0.1:${port}/`];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(300);
      try { target = (await get(`http://127.0.0.1:${PORT_CDP}/json/list`)).find((t) => t.type === 'page'); } catch (_) {}
    }
    if (!target) throw new Error('找不到页面');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await sleep(3500);
    await cdp.eval(PAGE_CODE);
    const out = {};
    for (const eng of ['lanczos', 'easu']) {
      out[eng] = await cdp.eval(`window.__benchUp(${JSON.stringify(eng)})`);
      await sleep(300);
    }
    console.log('超分基准（720p → 1080p，对照真实 1080p 参考帧）');
    for (const k of Object.keys(out)) {
      console.log(`  ${k.padEnd(9)} PSNR ${String(out[k].psnr).padStart(7)} dB   SSIM ${out[k].ssim}   清晰度 ${out[k].sharpness}`);
    }
    fs.writeFileSync(path.join(ROOT, 'docs', 'bench-upscale.json'), JSON.stringify(out, null, 2));
    cdp.ws.close();
  } finally { chrome.kill(); server.close(); process.exit(0); }
})();
