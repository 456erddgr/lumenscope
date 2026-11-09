'use strict';
// 无头 Chrome 冒烟测试：真实渲染 + 捕获控制台/异常 + 截图（Node 24 自带 WebSocket）
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4183';
const PAGE = process.env.PAGE || '/src/index.html';
const OUTDIR = path.join(__dirname, '..', 'docs', 'shots');
const PORT = Number(process.env.CDP_PORT || 9331);
const WIDTH = Number(process.env.W || 1440);
const HEIGHT = Number(process.env.H || 900);
const TAG = process.env.TAG || 'desktop';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJSON(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, timeoutMs);
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const userDir = path.join(require('os').tmpdir(), 'lumen-chrome-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(process.env.Y4M ? ['--use-file-for-fake-video-capture=' + process.env.Y4M] : []),
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await getJSON(`http://127.0.0.1:${PORT}/json/version`); } catch (_) { await sleep(250); }
  }
  if (!version) { console.error('Chrome 未启动'); chrome.kill(); process.exit(1); }

  const target = await getJSON(`http://127.0.0.1:${PORT}/json/new?about:blank`).catch(async () => {
    // 新版 Chrome 需要 PUT
    return await new Promise((res, rej) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
      });
      req.on('error', rej); req.end();
    });
  });

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const logs = [];
  const errors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
      logs.push(`[${m.params.type}] ${text}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(m.params.entry.text);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + PAGE });
  await sleep(Number(process.env.WAIT || 2600));

  // 探针：WebGL2、着色器编译、管线状态、设备列表
  const probe = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = { ok: true };
      const c = document.getElementById('glcanvas');
      const gl = c && c.getContext('webgl2');
      out.webgl2 = !!gl;
      out.renderer = gl ? (gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL || gl.RENDERER)) : null;
      out.vendor = gl ? gl.getParameter(gl.VENDOR) : null;
      out.canvas = c ? [c.width, c.height] : null;
      out.overlayState = document.getElementById('overlay')?.dataset.state;
      out.deviceRows = document.querySelectorAll('.device-row').length;
      out.hasPipeline = !!(window.__lumenDebug && window.__lumenDebug.pipeline);
      out.shaderError = window.__lumenDebug && window.__lumenDebug.error || null;
      out.stats = window.__lumenDebug && window.__lumenDebug.stats || null;
      out.live = !!document.querySelector('#glassBar:not([hidden])');
      return out;
    })()`,
    returnByValue: true,
  });

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUTDIR, `${TAG}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

  console.log(JSON.stringify({
    page: BASE + PAGE,
    probe: probe.result.value,
    errors: errors.slice(0, 12),
    logs: logs.slice(0, 20),
    screenshot: file,
  }, null, 2));

  cdp.close();
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
}

main().catch(e => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
