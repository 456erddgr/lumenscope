'use strict';
// 验证「浏览器模式」下虚拟摄像头全链路：页面 → /api/vcam/start → ws 推流 → 桥接计数增长
const { spawn } = require('child_process');
const http = require('http');

const PORT = Number(process.env.PORT || 4173);
const URL_ = `http://127.0.0.1:${PORT}/`;
const Y4M = process.env.Y4M || require('path').join(__dirname, '..', 'docs', 'test-720p-loop.y4m');
const CDP_PORT = Number(process.env.CDP_PORT || 9411);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 30000);
    });
  }
}

function getJSON(path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=' + Y4M,
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(300);
      try {
        const list = await new Promise((res, rej) => {
          http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (r) => {
            let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
          }).on('error', rej);
        });
        target = list.find(t => t.type === 'page');
      } catch (_) {}
    }
    if (!target) throw new Error('拿不到 CDP target');

    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

    const logs = [];
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    });

    await cdp.send('Page.navigate', { url: URL_ });
    await sleep(2500);

    const st0 = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const b=document.getElementById('btnVcam'); return { state: b && b.dataset.state, txt: b && b.innerText }; })()`,
      returnByValue: true,
    });
    console.log('vcam 按钮（点击前）:', JSON.stringify(st0.result.value));

    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btnVcam').click()`, returnByValue: true });
    await sleep(1200);

    let mid = null;
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      mid = await getJSON('/api/vcam/state');
      if (mid && mid.frames > 30) break;
    }
    const btn = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const b=document.getElementById('btnVcam'); return { state: b.dataset.state, txt: b.innerText.replace(/\\n/g,' | ') }; })()`,
      returnByValue: true,
    });
    console.log('vcam 按钮（点击后）:', JSON.stringify(btn.result.value));
    console.log('bridge:', JSON.stringify(mid));
    console.log('console:', logs.slice(0, 8));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(require('path').join(__dirname, '..', 'docs', 'shots', 'vcam-live.png'), Buffer.from(shot.data, 'base64'));

    const ok = mid && mid.status === 'live' && mid.frames > 30 && btn.result.value.state === 'live';
    console.log(ok ? '✅ 浏览器模式虚拟摄像头链路正常' : '❌ 链路异常');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    // 停掉虚拟摄像头，避免占用驱动
    await new Promise(r => { const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/vcam/stop', method: 'POST' }, res => { res.resume(); res.on('end', r); }); req.on('error', r); req.end(); });
    chrome.kill();
  }
})();
