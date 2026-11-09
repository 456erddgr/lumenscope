'use strict';
// 数字变焦交互验证：滚轮放大 → 拖拽平移 → 按钮复位，并落一张截图
// 用法：node scripts/test-zoom.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9431);
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4173';
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result && r.result.value;
  }
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'lumen-zoom-' + PORT),
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars', '--window-size=1440,900',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    BASE + '/src/index.html',
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
    await cdp.send('Page.enable');

    // 等画面进入 live
    let live = false;
    for (let i = 0; i < 40 && !live; i++) {
      await sleep(400);
      live = await cdp.eval("(() => { const p = window.__lumenDebug && window.__lumenDebug.pipeline; return !!p && p.frame > 5 && document.getElementById('overlay').dataset.state === 'live'; })()");
    }
    if (!live) throw new Error('画面未进入 live 状态');

    const rect = await cdp.eval("(() => { const r = document.getElementById('glcanvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    const cx = Math.round(rect.x + rect.w / 2), cy = Math.round(rect.y + rect.h / 2);

    const read = () => cdp.eval(`(() => { const p = window.__lumenDebug.pipeline; return {
      zoom: +(p.settings.userZoom).toFixed(3), panX: +(p.settings.userPanX || 0).toFixed(4),
      panY: +(p.settings.userPanY || 0).toFixed(4), label: document.getElementById('zoomPct').textContent,
      hidden: document.getElementById('zoomCtl').hidden, zoomedClass: document.getElementById('glcanvas').classList.contains('is-zoomed'),
      frame: p.frame, cpuMs: +(p.lastStats && p.lastStats.cpuMs || 0).toFixed(2) }; })()`);
    const before = await read();

    // ① 滚轮放大 3 档
    for (let i = 0; i < 3; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -160, modifiers: 0 });
      await sleep(120);
    }
    await sleep(300);
    const afterWheel = await read();

    // ② 拖拽平移
    const steps = 6, dx = -120, dy = 40;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + Math.round(dx * i / steps), y: cy + Math.round(dy * i / steps), button: 'left', buttons: 1 });
      await sleep(60);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + dx, y: cy + dy, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(400);
    const afterPan = await read();

    // 截图（放大 + 平移后的画面）
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'shots', 'zoom.png'), Buffer.from(shot.data, 'base64'));

    // ③ 点数值按钮复位
    await cdp.eval("document.getElementById('zoomVal').click()");
    await sleep(400);
    const afterReset = await read();

    // ④ 键盘 + 放大、0 复位
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '+', code: 'Equal', windowsVirtualKeyCode: 187, text: '+' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '+', code: 'Equal', windowsVirtualKeyCode: 187 });
    await sleep(300);
    const afterKey = await read();

    console.log('\n=== 数字变焦 ===');
    console.log('  初始      ', JSON.stringify(before));
    console.log('  滚轮放大后', JSON.stringify(afterWheel));
    console.log('  拖拽平移后', JSON.stringify(afterPan));
    console.log('  按钮复位后', JSON.stringify(afterReset));
    console.log('  键盘 + 后 ', JSON.stringify(afterKey));

    const ok = [
      ['控制条可见', before.hidden === false],
      ['滚轮放大生效', afterWheel.zoom > before.zoom * 1.5],
      ['标签跟随', /×/.test(afterWheel.label) && afterWheel.label !== before.label],
      ['拖拽平移生效', Math.abs(afterPan.panX - afterWheel.panX) > 0.01 || Math.abs(afterPan.panY - afterWheel.panY) > 0.01],
      ['平移有界', Math.abs(afterPan.panX) <= 0.5 && Math.abs(afterPan.panY) <= 0.5],
      ['按钮复位', afterReset.zoom === 1 && afterReset.panX === 0],
      ['键盘放大', afterKey.zoom > 1.2],
      ['一直在出帧', afterKey.frame > before.frame],
    ];
    let pass = 0;
    for (const [name, v] of ok) { console.log(`  ${v ? 'PASS' : 'FAIL'}  ${name}`); if (v) pass++; }
    console.log(`\n  ${pass}/${ok.length} 通过；截图 docs/shots/zoom.png`);
    if (pass !== ok.length) process.exitCode = 1;
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('变焦验证失败：', e.message); process.exit(1); });
