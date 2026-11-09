'use strict';
// 无真机时的验证：用 Chrome 自带假摄像头，检查
//   ① 面板里"采集分辨率/帧率"能切换、能记住
//   ② 切换后确实重新打开采集，并如实回显格式
//   ③ 实时帧率显示不再谎报
// 用法：node scripts/verify-capture-settings.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9601);
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4173';
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result && r.result.value;
  }
}

const READ = `(() => {
  const v = window.__lumenDebug && window.__lumenDebug.video;
  const p = window.__lumenDebug && window.__lumenDebug.pipeline;
  const act = (sel) => { const e = document.querySelector(sel + ' .is-active'); return e ? (e.dataset.cap || e.dataset.capfps) : null; };
  return {
    live: document.getElementById('overlay').dataset.state,
    videoSize: v ? [v.videoWidth, v.videoHeight] : null,
    shownFps: document.getElementById('statFps').textContent,
    fpsWarn: document.getElementById('statFps').parentElement.dataset.warn,
    fpsTitle: document.getElementById('statFps').parentElement.title,
    camStatus: document.getElementById('camStatus').textContent,
    hint: document.getElementById('captureHint').textContent,
    hintTone: document.getElementById('captureHint').dataset.tone,
    activeRes: act('#captureResGroup'),
    activeFps: act('#captureFpsGroup'),
    outSize: p ? [p.outW, p.outH] : null,
    savedPref: (() => { try { return localStorage.getItem('lumen.capture'); } catch (_) { return null; } })(),
  };
})()`;

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lumen-cap-' + PORT),
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

    // 等画面
    let st = null;
    for (let i = 0; i < 30; i++) {
      await sleep(600);
      st = await cdp.eval(READ);
      if (st.live === 'live') break;
    }
    console.log('=== 初始状态 ===');
    console.log(JSON.stringify(st, null, 1));

    const results = [];
    results.push(['进入 live', st.live === 'live']);
    results.push(['面板有采集分辨率控件', st.activeRes !== null]);
    results.push(['面板有采集帧率控件', st.activeFps !== null]);
    results.push(['相机状态栏显示尺寸', /\d+×\d+/.test(st.camStatus || '')]);

    // 逐个切分辨率，看是否重开成功且回显
    console.log('\n=== 切换采集分辨率 ===');
    for (const cap of ['720', '540', '1080', 'auto']) {
      await cdp.eval(`document.querySelector('#captureResGroup [data-cap="${cap}"]').click()`);
      await sleep(2600);
      const s = await cdp.eval(READ);
      console.log(`  切 ${cap}: 采集 ${s.videoSize ? s.videoSize.join('x') : '?'}  显示 ${s.shownFps}fps  提示「${s.hint}」`);
      if (cap === '720') results.push(['切 720 后仍出画面', s.live === 'live']);
      if (cap === '1080') results.push(['切 1080 后仍出画面', s.live === 'live']);
      if (cap === 'auto') results.push(['切回自动后仍出画面', s.live === 'live']);
    }

    // 切帧率
    console.log('\n=== 切换采集帧率 ===');
    for (const f of ['60', '30', 'auto']) {
      await cdp.eval(`document.querySelector('#captureFpsGroup [data-capfps="${f}"]').click()`);
      await sleep(2600);
      const s = await cdp.eval(READ);
      console.log(`  切 ${f}: 采集 ${s.videoSize ? s.videoSize.join('x') : '?'}  显示 ${s.shownFps}fps`);
      if (f === '60') results.push(['切 60 后仍出画面', s.live === 'live']);
    }

    const final = await cdp.eval(READ);
    results.push(['设置被记住', !!final.savedPref]);
    results.push(['帧率显示有数值', parseFloat(final.shownFps) > 0]);

    // 帧率诚实性：把源压到很低，看界面是否跟着降
    console.log('\n=== 帧率诚实性（强制限制源帧率）===');
    const before = await cdp.eval(READ);
    await cdp.eval(`(async () => {
      const s = window.__lumenDebug.stream;
      if (!s) return;
      const t = s.getVideoTracks()[0];
      try { await t.applyConstraints({ frameRate: { max: 5 } }); } catch (e) {}
    })()`);
    await sleep(3000);
    const after = await cdp.eval(READ);
    console.log(`  限制前 ${before.shownFps}fps → 限制后 ${after.shownFps}fps（提示: ${after.fpsTitle}）`);
    results.push(['源掉帧时显示值跟着降', parseFloat(after.shownFps) < parseFloat(before.shownFps) * 0.85]);

    console.log('\n=== 判定 ===');
    let pass = 0;
    for (const [n, ok] of results) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (ok) pass++; }
    console.log(`\n  ${pass}/${results.length} 通过`);
    process.exitCode = pass === results.length ? 0 : 1;
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
