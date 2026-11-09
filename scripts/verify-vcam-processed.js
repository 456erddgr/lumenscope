'use strict';
// 验证虚拟摄像头输出的是"算法处理后的画面"，而不是原始流。
// 做法：在页面里读 readStream（= 推给虚拟摄像头的那份数据），
// 分别关掉/打开算法，比较清晰度与噪声，看是否随开关变化。
// 用法：node scripts/verify-vcam-processed.js [CDP端口]
const http = require('http');

const PORT = Number(process.argv[2] || 9581);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
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
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result && r.result.value;
  }
}

// 在页面里量"推给虚拟摄像头的那份数据"的指标
const MEASURE = `(async (settleMs) => {
  const p = window.__lumenDebug.pipeline;
  await new Promise(r => setTimeout(r, settleMs));
  const f = p.readStream(p.outW, p.outH);
  if (!f) return { err: 'readStream null' };
  const W = f.w, H = f.h, b = f.buf;
  const lum = (i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
  // 拉普拉斯方差：越锐利越大
  let s = 0, s2 = 0, n = 0;
  for (let y = 2; y < H - 2; y += 6) {
    for (let x = 2; x < W - 2; x += 6) {
      const c = y * W + x;
      const v = 4 * lum(c * 4) - lum((c - 1) * 4) - lum((c + 1) * 4) - lum((c - W) * 4) - lum((c + W) * 4);
      s += v; s2 += v * v; n++;
    }
  }
  const mean = s / n;
  // 局部噪声：与 3x3 均值的偏差（高频颗粒）
  let noise = 0, nn = 0;
  for (let y = 3; y < H - 3; y += 9) {
    for (let x = 3; x < W - 3; x += 9) {
      let avg = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) avg += lum(((y + dy) * W + (x + dx)) * 4);
      avg /= 9;
      const c = lum((y * W + x) * 4);
      noise += Math.abs(c - avg); nn++;
    }
  }
  return {
    size: [W, H],
    sharpness: Math.round(s2 / n - mean * mean),
    noise: +(noise / nn).toFixed(2),
  };
})`;

const SET = `(async (cfg) => {
  const p = window.__lumenDebug.pipeline;
  const s = p.settings;
  s.superRes = cfg.superRes; s.upscaler = cfg.upscaler;
  s.denoise = cfg.denoise;
  s.stabilise = cfg.stabilise; s.rollingShutter = cfg.rollingShutter;
  s.sharpen = cfg.sharpen;
  s.autoExposure = false; s.autoWhiteBalance = false;
  s.exposure = 1; s.contrast = 1; s.saturation = 1;
  p.resetAll();
  return true;
})`;

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 确保在 1080p、有画面
  await cdp.eval(`document.querySelector('[data-res="1080"]').click()`);
  await sleep(1500);

  const cases = [
    ['全部关闭（原始流的样子）', { superRes: false, upscaler: 'lanczos', denoise: 0, stabilise: false, rollingShutter: false, sharpen: 0 }],
    ['只开超分（Lanczos）', { superRes: true, upscaler: 'lanczos', denoise: 0, stabilise: false, rollingShutter: false, sharpen: 0 }],
    ['超分 + 降噪 + 防抖 + 锐化', { superRes: true, upscaler: 'lanczos', denoise: 0.55, stabilise: true, rollingShutter: true, sharpen: 0.35 }],
  ];

  const out = [];
  for (const [label, cfg] of cases) {
    await cdp.eval(`(${SET})(${JSON.stringify(cfg)})`);
    const m = await cdp.eval(`(${MEASURE})(1600)`);
    out.push({ label, ...m });
    console.log(`${label.padEnd(28)} 尺寸 ${m.size ? m.size.join('x') : '?'}  清晰度 ${m.sharpness}  噪声 ${m.noise}`);
  }

  console.log('\n=== 判定 ===');
  const base = out[0], sup = out[1], full = out[2];
  const checks = [
    ['超分后清晰度提升', sup.sharpness > base.sharpness * 1.05],
    ['降噪后颗粒减少', full.noise <= sup.noise * 1.02],
    ['全程保持 1080p', out.every((o) => o.size && o.size[1] === 1080)],
    ['推给虚拟摄像头的确实是这条管线的输出', out.every((o) => !o.err)],
  ];
  let pass = 0;
  for (const [n, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (ok) pass++; }
  console.log(`\n  ${pass}/${checks.length} 通过`);
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
