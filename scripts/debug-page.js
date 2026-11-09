'use strict';
// 快速检查页面摄像头是否就绪 + 点按钮后的 toast 文本
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 4173, CDP_PORT = 9412;
const Y4M = path.join(__dirname, '..', 'docs', 'test-720p-loop.y4m');

class CDP {
  constructor(u) { this.url = u; this.id = 0; this.p = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data); const q = this.p.get(m.id);
      if (q) { this.p.delete(m.id); m.error ? q.j(new Error(JSON.stringify(m.error))) : q.r(m.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, 20000); });
  }
  async evalX(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result.value; }
}

(async () => {
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=' + Y4M, '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
    '--user-data-dir=' + require('os').tmpdir() + '/lumen-dbg-' + Date.now(),
    '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let t = null;
    for (let i = 0; i < 40 && !t; i++) {
      await sleep(300);
      try {
        const l = await new Promise((res, rej) => http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
        t = l.find(x => x.type === 'page');
      } catch (_) {}
    }
    const cdp = new CDP(t.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    const logs = [];
    cdp.ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' ')); if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || '')); });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__errs = [];
      window.addEventListener('error', e => window.__errs.push('ERR ' + (e.message||'') + ' @' + (e.filename||'') + ':' + (e.lineno||0)));
      window.addEventListener('unhandledrejection', e => window.__errs.push('REJ ' + (e.reason && (e.reason.stack||e.reason.message||e.reason))));
    ` });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(4000);
    console.log('canvas:', await cdp.evalX(`(()=>{const c=document.getElementById('glcanvas');return {w:c.width,h:c.height,style:c.getAttribute('style')}})()`));
    console.log('globals:', await cdp.evalX(`JSON.stringify({LumenGL:typeof window.LumenGL,LumenPipeline:typeof window.LumenPipeline,ShaderFSR:typeof window.ShaderFSR,LumenStreamer:typeof window.LumenStreamer})`));
    console.log('errs:', await cdp.evalX(`JSON.stringify(window.__errs||[])`));
    console.log('dbg:', await cdp.evalX(`JSON.stringify(window.__lumenDebug||null)`));
    console.log('gl2:', await cdp.evalX(`!!document.getElementById('glcanvas').getContext('webgl2')`));
    console.log('devices:', await cdp.evalX(`navigator.mediaDevices.enumerateDevices().then(d=>d.filter(x=>x.kind==='videoinput').map(x=>x.label))`));
    console.log('bodyClass:', await cdp.evalX(`document.body.className`));
    console.log('enumerateNow:', await cdp.evalX(`navigator.mediaDevices.enumerateDevices().then(d=>d.map(x=>x.kind+':'+x.label))`));
    console.log('gumTest:', await cdp.evalX(`navigator.mediaDevices.getUserMedia({video:true}).then(s=>{const t=s.getVideoTracks()[0];const r={label:t.label,settings:t.getSettings()};t.stop();return r}).catch(e=>'ERR '+e.name+' '+e.message)`));
    console.log('shellAttrs:', await cdp.evalX(`(()=>{const s=document.getElementById('shell');return {cls:s.className,attrs:[...s.attributes].map(a=>a.name+'='+a.value)}})()`));
    console.log('overlay:', await cdp.evalX(`document.getElementById('overlay').dataset.state`));
    console.log('video:', await cdp.evalX(`(()=>{const v=document.querySelector('video');return v?{rs:v.readyState,w:v.videoWidth,h:v.videoHeight,paused:v.paused}:null})()`));
    console.log('caps:', await cdp.evalX(`fetch('/api/capabilities').then(r=>r.json())`));
    await cdp.evalX(`document.getElementById('btnVcam').click()`);
    await sleep(2500);
    console.log('btn:', await cdp.evalX(`(()=>{const b=document.getElementById('btnVcam');return b.dataset.state+' / '+b.innerText.replace(/\\n/g,' | ')})()`));
    console.log('toasts:', await cdp.evalX(`[...document.querySelectorAll('.toast')].map(t=>t.innerText)`));
    console.log('vcamState:', await cdp.evalX(`fetch('/api/vcam/state').then(r=>r.json())`));
    console.log('logs:', logs.slice(0, 10));
  } finally { chrome.kill(); }
})();
