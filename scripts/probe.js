'use strict';
// 复用 smoke 的 CDP 逻辑，但输出布局几何与更细的探针
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4183';
const PAGE = process.env.PAGE || '/src/index.html';
const PORT = Number(process.env.CDP_PORT || 9332);
const WIDTH = Number(process.env.W || 1440);
const HEIGHT = Number(process.env.H || 900);
const TAG = process.env.TAG || 'probe';
const OUTDIR = path.join(__dirname, '..', 'docs', 'shots');
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
        const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, t = 30000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时 ' + method)); } }, t);
    });
  }
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const dir = path.join(os.tmpdir(), 'lumen-probe-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    `--window-size=${WIDTH},${HEIGHT}`, '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ...(process.env.Y4M ? ['--use-file-for-fake-video-capture=' + process.env.Y4M] : []),
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); ok = true; } catch (_) { await sleep(250); } }
  if (!ok) { console.error('chrome 未起'); chrome.kill(); process.exit(1); }

  const target = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej); req.end();
  });

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const errors = [], logs = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + (m.params.args || []).map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + PAGE });
  await sleep(Number(process.env.WAIT || 3000));

  const expr = `(() => {
    const q = (s) => document.querySelector(s);
    const rect = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
    const cs = (s, props) => { const e = q(s); if (!e) return null; const c = getComputedStyle(e); const o = {}; props.forEach(p => o[p] = c.getPropertyValue(p)); return o; };
    const c = q('#glcanvas');
    return {
      dpr: window.devicePixelRatio,
      viewport: rect('#viewport'), canvasRect: rect('#glcanvas'), panel: rect('#panel'), stage: rect('#stage'),
      canvasSize: c ? [c.width, c.height] : null,
      topbar: rect('#topbar'), glass: rect('#glassBar'),
      statsBox: rect('#topbarStats'), actions: rect('.topbar-actions'), brand: rect('.brand'),
      statOverflow: (() => { const s = q('#topbarStats'); return s ? { sw: s.scrollWidth, cw: s.clientWidth } : null; })(),
      panelInner: rect('.panel-inner'),
      stats: window.__lumenDebug?.stats || null,
      shaderError: window.__lumenDebug?.error || null,
      overlay: q('#overlay')?.dataset.state,
      fonts: cs('body', ['font-family', 'font-size']),
    };
  })()`;
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, `${TAG}.png`), Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ probe: r.result.value, errors: errors.slice(0, 8), logs: logs.slice(0, 10) }, null, 2));
  chrome.kill();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
