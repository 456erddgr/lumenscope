'use strict';
// 整体回归：画面状态、分辨率切换、功能开关、控制台错误、帧率
// 用法：node scripts/check-live.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9451);
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej); });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.console = []; this.errors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
        this.console.push({ type: m.params.type, text: txt });
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push(d.exception && d.exception.description || d.text);
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

const READ = `(() => {
  const p = window.__lumenDebug && window.__lumenDebug.pipeline;
  const s = p ? p.settings : {};
  const chip = (id) => { const n = document.getElementById(id); return n ? { on: n.dataset.on === 'true', color: getComputedStyle(n).color } : null; };
  return {
    live: document.getElementById('overlay').dataset.state,
    frame: p ? p.frame : 0,
    nat: p ? [p.nativeW, p.nativeH] : null,
    out: p ? [p.outW, p.outH] : null,
    cpuMs: p && p.lastStats ? +p.lastStats.cpuMs.toFixed(2) : null,
    fps: +(document.getElementById('statFps').textContent || 0),
    statsText: (document.getElementById('statNative').textContent || '') + ' | ' + (document.getElementById('statOut').textContent || ''),
    superRes: s.superRes, stabilise: s.stabilise, rollingShutter: s.rollingShutter, denoise: s.denoise,
    zoomHidden: document.getElementById('zoomCtl').hidden,
    chips: { sup: chip('chipSuper'), anti: chip('chipAntiShake'), jelly: chip('chipJelly'), dn: chip('chipDenoise') },
  };
})()`;

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lumen-live-' + PORT),
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

    let s0 = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      s0 = await cdp.eval(READ);
      if (s0.live === 'live' && s0.frame > 30) break;
    }
    await sleep(600);
    s0 = await cdp.eval(READ);

    // 切 2K
    await cdp.eval("document.querySelector('[data-res=\"1440\"]').click()");
    await sleep(1200);
    const s2k = await cdp.eval(READ);

    // 切回 1080p
    await cdp.eval("document.querySelector('[data-res=\"1080\"]').click()");
    await sleep(1200);
    const s1k = await cdp.eval(READ);

    // 60fps
    await cdp.eval("document.querySelector('[data-fps=\"60\"]').click()");
    await sleep(1500);
    const s60 = await cdp.eval(READ);
    await cdp.eval("document.querySelector('[data-fps=\"30\"]').click()");

    // 逐个关掉再打开功能芯片
    const toggles = {};
    for (const id of ['chipSuper', 'chipAntiShake', 'chipJelly', 'chipDenoise']) {
      await cdp.eval(`document.getElementById('${id}').click()`);
      await sleep(500);
      toggles[id + ':off'] = await cdp.eval(READ);
      await cdp.eval(`document.getElementById('${id}').click()`);
      await sleep(500);
      toggles[id + ':on'] = await cdp.eval(READ);
    }
    await sleep(500);
    const sEnd = await cdp.eval(READ);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'shots', 'live-final.png'), Buffer.from(shot.data, 'base64'));

    console.log('\n=== 首帧状态 ===');
    console.log('  ' + JSON.stringify({ live: s0.live, frame: s0.frame, nat: s0.nat, out: s0.out, cpuMs: s0.cpuMs, fps: s0.fps }));
    console.log('  芯片: ' + JSON.stringify(s0.chips));
    console.log('=== 分辨率切换 ===');
    console.log('  2K   -> ' + JSON.stringify({ out: s2k.out, cpuMs: s2k.cpuMs, fps: s2k.fps }));
    console.log('  1080p-> ' + JSON.stringify({ out: s1k.out, cpuMs: s1k.cpuMs, fps: s1k.fps }));
    console.log('=== 60fps 档 ===');
    console.log('  ' + JSON.stringify({ fps: s60.fps, cpuMs: s60.cpuMs }));
    console.log('=== 功能开关 ===');
    for (const [k, v] of Object.entries(toggles)) {
      console.log(`  ${k.padEnd(18)} super=${v.superRes} anti=${v.stabilise} jelly=${v.rollingShutter} dn=${v.denoise}`);
    }

    const errs = cdp.errors.concat(cdp.console.filter((c) => c.type === 'error').map((c) => c.text));
    const warnings = cdp.console.filter((c) => c.type === 'warning');

    const checks = [
      ['进入 live', s0.live === 'live'],
      ['持续出帧', s0.frame > 30],
      ['默认 1080p 输出', s0.out && s0.out[1] === 1080],
      ['2K 输出生效', s2k.out && s2k.out[0] === 2560 && s2k.out[1] === 1440],
      ['切回 1080p', s1k.out && s1k.out[1] === 1080],
      ['变焦控件可见', s0.zoomHidden === false],
      ['芯片默认全开', s0.chips.sup.on && s0.chips.anti.on && s0.chips.jelly.on && s0.chips.dn.on],
      ['芯片高亮用强调色', s0.chips.sup.color === 'rgb(41, 151, 255)'],
      ['超分关→主设置同步', toggles['chipSuper:off'].superRes === false],
      ['防抖关→主设置同步', toggles['chipAntiShake:off'].stabilise === false],
      ['防果冻关→主设置同步', toggles['chipJelly:off'].rollingShutter === false],
      ['降噪关→主设置同步', toggles['chipDenoise:off'].denoise === 0],
      ['无未捕获异常', errs.length === 0],
      ['结束时仍在出帧', sEnd.frame > s2k.frame],
    ];
    let pass = 0;
    console.log('\n=== 断言 ===');
    for (const [name, v] of checks) { console.log(`  ${v ? 'PASS' : 'FAIL'}  ${name}`); if (v) pass++; }
    if (errs.length) { console.log('\n错误：'); errs.slice(0, 8).forEach((e) => console.log('  - ' + String(e).slice(0, 300))); }
    if (warnings.length) { console.log('\n警告：'); warnings.slice(0, 6).forEach((w) => console.log('  - ' + w.text.slice(0, 200))); }
    console.log(`\n  ${pass}/${checks.length} 通过；截图 docs/shots/live-final.png`);
    if (pass !== checks.length) process.exitCode = 1;
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('回归失败：', e.message); process.exit(1); });
