'use strict';
// 定量基准：同一段 720p 片源，逐项开关，测量帧间残差（稳不稳）与拉普拉斯方差（清不清晰）
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4183';
const PORT = Number(process.env.CDP_PORT || 9333);
const OUTDIR = path.join(__dirname, '..', 'docs', 'bench');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, t = 60000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时 ' + method)); } }, t);
    });
  }
}

const MEASURE_FN = `
window.__bench = async function(frames) {
  const p = window.__lumenDebug.pipeline;
  const W = 640, H = 360;
  const keep = [];
  for (let i = 0; i < frames; i++) {
    await new Promise(r => requestAnimationFrame(r));
    const f = p.readSmall(W, H);
    if (!f) continue;
    const lum = new Float32Array(W * H);
    for (let k = 0; k < lum.length; k++) lum[k] = f.buf[k*4]*0.299 + f.buf[k*4+1]*0.587 + f.buf[k*4+2]*0.114;
    keep.push(lum);
  }
  const diffs = [];
  for (let i = 1; i < keep.length; i++) {
    let s = 0;
    for (let k = 0; k < keep[i].length; k++) s += Math.abs(keep[i][k] - keep[i-1][k]);
    diffs.push(s / keep[i].length);
  }
  const sorted = [...diffs].sort((a,b) => a-b);
  const med = sorted[Math.floor(sorted.length/2)] || 0;
  const p90 = sorted[Math.floor(sorted.length*0.9)] || 0;
  const last = keep[keep.length-1];
  let lap = 0, n = 0;
  for (let y = 1; y < H-1; y++) for (let x = 1; x < W-1; x++) {
    const i = y*W+x;
    const v = 4*last[i] - last[i-1] - last[i+1] - last[i-W] - last[i+W];
    lap += v*v; n++;
  }
  const st = p.lastStats;
  return {
    frameDiffMedian: +med.toFixed(3),
    frameDiffP90: +p90.toFixed(3),
    sharpnessLaplacianVar: +(lap/n).toFixed(1),
    cpuMs: +st.cpuMs.toFixed(2),
    outW: p.outW, outH: p.outH,
    frames: keep.length,
  };
};
'1'`;

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const dir = path.join(os.tmpdir(), 'lumen-bench-' + Date.now());
  const y4m = process.env.Y4M || path.join(__dirname, '..', 'docs', 'test-720p.y4m');
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--window-size=1440,900', '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); ready = true; } catch (_) { await sleep(250); } }
  if (!ready) { chrome.kill(); throw new Error('chrome 未起'); }

  const target = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej); req.end();
  });
  if (process.env.DBG) console.error('target ok:', !!target.webSocketDebuggerUrl);
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  if (process.env.DBG) console.error('ws connected');
  await cdp.send('Runtime.enable', {}, 8000);
  if (process.env.DBG) console.error('runtime enabled');
  await cdp.send('Page.enable', {}, 8000);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/src/index.html' });
  await sleep(3400);
  await cdp.send('Runtime.evaluate', { expression: MEASURE_FN });

  const cases = [
    { name: '全部关闭（原始 720p）', superRes: false, stabilise: false, denoise: 0, rollingShutter: false, res: 720 },
    { name: '仅降噪', superRes: false, stabilise: false, denoise: 0.55, rollingShutter: false, res: 720 },
    { name: '仅防抖', superRes: false, stabilise: true, denoise: 0, rollingShutter: false, res: 720 },
    { name: '防抖 + 降噪', superRes: false, stabilise: true, denoise: 0.55, rollingShutter: false, res: 720 },
    { name: '全套 1080p', superRes: true, stabilise: true, denoise: 0.55, rollingShutter: true, res: 1080 },
    { name: '全套 2K', superRes: true, stabilise: true, denoise: 0.55, rollingShutter: true, res: 1440 },
  ];

  const results = [];
  for (const c of cases) {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const p = window.__lumenDebug.pipeline;
        p.settings.superRes = ${c.superRes};
        p.settings.stabilise = ${c.stabilise};
        p.settings.denoise = ${c.denoise};
        p.settings.rollingShutter = ${c.rollingShutter};
        p.setOutput(${c.res});
        p.resetAll();
      })()`,
    });
    await sleep(1000);
    const r = await cdp.send('Runtime.evaluate', { expression: 'window.__bench(24)', awaitPromise: true, returnByValue: true });
    if (r.result.value) results.push({ case: c.name, ...r.result.value });
    else results.push({ case: c.name, error: r.exceptionDetails?.text });
  }

  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUTDIR, 'bench.json'), JSON.stringify(results, null, 2));
  chrome.kill();
})().catch(e => { console.error('BENCH FAIL', e.message); process.exit(1); });
