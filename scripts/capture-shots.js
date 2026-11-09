'use strict';
// 抓真实画面截图：不注入假设备，用系统里真实的摄像头（默认优先 USB CAMERA）
// 用法：node scripts/capture-shots.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9471);
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4173';
const W = Number(process.env.W || 1600), H = Number(process.env.H || 1000);
const OUT = path.join(__dirname, '..', 'docs', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej); });

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result && r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return fs.statSync(file).size;
  }
}

const STATE = `(() => {
  const p = window.__lumenDebug && window.__lumenDebug.pipeline;
  if (!p) return { ready: false };
  const v = document.querySelector('video');
  return {
    ready: true,
    live: document.getElementById('overlay').dataset.state,
    frame: p.frame,
    size: [p.outW, p.outH],
    native: [p.nativeW, p.nativeH],
    cpuMs: p.lastStats ? +p.lastStats.cpuMs.toFixed(1) : null,
    fps: +(document.getElementById('statFps').textContent || 0),
    dev: (document.getElementById('deviceTitle').textContent || '').trim(),
    video: v ? [v.videoWidth, v.videoHeight] : null
  };
})()`;

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lumen-shot-' + PORT),
    '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
    `--window-size=${W},${H}`, '--force-device-scale-factor=1',
    '--use-fake-ui-for-media-stream',       // 只是自动允许摄像头权限，不注入假画面
    '--autoplay-policy=no-user-gesture-required',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(400);
      try { target = (await get(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (_) {}
    }
    if (!target) throw new Error('无法连接 Chrome');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

    await cdp.send('Page.navigate', { url: BASE + '/src/index.html' });
    await sleep(2500);

    // 等设备列表出现，选 USB CAMERA（拿不到就选第一个非虚拟的）
    let devs = [];
    for (let i = 0; i < 30; i++) {
      devs = await cdp.eval(`navigator.mediaDevices.enumerateDevices().then(l => l.filter(d => d.kind === 'videoinput').map(d => d.label))`);
      if (devs && devs.length) break;
      await sleep(500);
    }
    console.log('设备：', JSON.stringify(devs));

    const picked = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('button')].filter(b => /USB CAMERA/i.test(b.textContent || ''));
      if (rows.length) { rows[0].click(); return 'USB CAMERA'; }
      const any = [...document.querySelectorAll('button')].filter(b => /点击开始/.test(b.textContent || ''));
      if (any.length) { any[0].click(); return 'first'; }
      return 'none';
    })()`);
    console.log('点了：', picked);

    let st = null;
    for (let i = 0; i < 40; i++) {
      await sleep(600);
      st = await cdp.eval(STATE);
      if (st.ready && st.live === 'live' && st.frame > 25) break;
    }
    console.log('状态：', JSON.stringify(st));

    if (!st || st.live !== 'live') {
      // 空状态也截一张（说明怎么选设备）
      await cdp.eval("document.getElementById('btnPanel').click()");
      await sleep(400);
      const a = await cdp.shot(path.join(OUT, 'shot-empty.png'));
      console.log('未出画面，已截空状态：', a, 'bytes');
      process.exitCode = 1;
      return;
    }

    // ① 主画面
    console.log('main :', await cdp.shot(path.join(OUT, 'main-camera.png')), 'bytes');

    // ② 滚轮放大到 ~2.9×
    const rect = await cdp.eval("(() => { const r = document.getElementById('glcanvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    for (let i = 0; i < 3; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(rect.x), y: Math.round(rect.y), deltaX: 0, deltaY: -160, modifiers: 0 });
      await sleep(150);
    }
    await sleep(900);
    console.log('zoom :', await cdp.shot(path.join(OUT, 'zoom.png')), 'bytes');
    const z = await cdp.eval("document.getElementById('zoomPct').textContent");
    console.log('当前倍率：', z);

    // ③ 复位后切 2K
    await cdp.eval("document.getElementById('zoomVal').click()");
    await sleep(400);
    await cdp.eval("document.querySelector('[data-res=\"1440\"]').click()");
    await sleep(1600);
    const st2k = await cdp.eval(STATE);
    console.log('2K   :', JSON.stringify({ size: st2k.size, cpuMs: st2k.cpuMs, fps: st2k.fps }));
    console.log('2k   :', await cdp.shot(path.join(OUT, 'shot-2k.png')), 'bytes');

    // ④ 打开虚拟摄像头后截一张（状态灯变绿）
    const vcam = await cdp.eval(`fetch('/api/vcam/start', { method: 'POST' }).then(r => r.json()).catch(e => ({ error: String(e) }))`);
    console.log('vcam :', JSON.stringify(vcam).slice(0, 200));
    if (vcam && (vcam.ws || vcam.wsUrl)) {
      await sleep(1200);
      await cdp.eval("document.getElementById('btnVcam').click()");
      await sleep(2200);
      console.log('vcam :', await cdp.shot(path.join(OUT, 'shot-vcam.png')), 'bytes');
      await cdp.eval("document.getElementById('btnVcam').click()");
    }
    await cdp.eval(`fetch('/api/vcam/stop', { method: 'POST' })`).catch(() => {});

    // ⑤ 恢复 1080p 主画面再截一张作为封面
    await cdp.eval("document.querySelector('[data-res=\"1080\"]').click()");
    await sleep(1500);
    console.log('cover:', await cdp.shot(path.join(OUT, 'main-camera.png')), 'bytes');
    console.log('最终：', JSON.stringify(await cdp.eval(STATE)));
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('截图失败：', e.message); process.exit(1); });
