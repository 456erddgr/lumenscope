'use strict';
// 2K 输出路径验证：点 2K → 读 outW/outH/fps/cpuMs → 截图
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { listen } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const Y4M = path.join(ROOT, 'docs', 'test-720p-loop.y4m');
const PORT_CDP = Number(process.env.CDP_PORT || 9361);

const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); }
  static async connect(u) { const ws = new WebSocket(u); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.value; }
}

(async () => {
  const { server, port } = await listen(ROOT, 0);
  const args = ['--headless=new', `--remote-debugging-port=${PORT_CDP}`,
    '--use-fake-ui-for-media-stream',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
    '--disable-gpu-sandbox', '--no-first-run', `--user-data-dir=${path.join(require('os').tmpdir(), 'lumen-2k-' + Date.now())}`];
  args.push(`http://127.0.0.1:${port}/`);
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(300);
      try { const list = await get(`http://127.0.0.1:${PORT_CDP}/json/list`); target = list.find((t) => t.type === 'page'); } catch (_) {}
    }
    if (!target) throw new Error('找不到页面');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await sleep(3500);
    const clicked = await cdp.eval(`(() => { const b = document.querySelector('#camSelect') || document.querySelector('select'); return b ? 'has-select' : 'none'; })()`);
    console.log('select:', clicked);
    await cdp.eval(`(() => { const s = document.querySelector('select'); if (!s) return; const o=[...s.options].find(o=>/USB CAMERA/i.test(o.textContent)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); } })()`);
    await sleep(4000);
    const st = await cdp.eval(`(() => { try { const d = window.__lumenDebug; if (!d || !d.pipeline) return {err:'no pipeline'};
      const p = d.pipeline; const s = p.lastStats || {};
      return { outW: p.outW, outH: p.outH, natW: p.srcW, natH: p.srcH, cpuMs: Math.round((s.cpuMs||0)*10)/10, motionConf: s.motionConf, fps: Math.round(1000/(s.dt||16)) }; } catch (e) { return {thrown:String(e)}; } })()`);
    const opts = await cdp.eval(`[...document.querySelectorAll('select option')].map(o=>o.textContent).slice(0,10)`);
    console.log('设备列表:', JSON.stringify(opts));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'docs', 'shots', 'check-2k.png'), Buffer.from(shot.data, 'base64'));
    console.log('2K 状态:', JSON.stringify(st));
    cdp.ws.close();
  } finally { chrome.kill(); server.close(); process.exit(0); }
})();
