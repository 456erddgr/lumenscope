'use strict';
// 真机诊断：摄像头真的送来几帧、渲染几帧、各阶段耗时、当前采集格式
// 用法：node scripts/diag-real.js [CDP端口]
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = Number(process.argv[2] || 9621);
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4173';
const TAG = process.env.TAG || '';
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

// 一段完整测量：源帧率 + 渲染帧率 + 渲染耗时分布
const MEASURE = `(async (ms) => {
  const d = window.__lumenDebug || {};
  const v = d.video, p = d.pipeline;
  if (!v || !p) return { err: 'no video/pipeline' };

  // 渲染耗时探针
  if (!p.__probed) {
    const orig = p.render.bind(p);
    p.__times = [];
    p.render = function (x) {
      const t = performance.now();
      const r = orig(x);
      p.__times.push(performance.now() - t);
      if (p.__times.length > 400) p.__times.shift();
      return r;
    };
    p.__probed = true;
  }
  p.__times = [];

  // 源帧计数
  let src = 0, cb = 0;
  const onF = () => { src++; cb = v.requestVideoFrameCallback(onF); };
  cb = v.requestVideoFrameCallback(onF);

  const f0 = p.frame;
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, ms));
  const dt = (performance.now() - t0) / 1000;
  try { v.cancelVideoFrameCallback(cb); } catch (_) {}

  const times = p.__times.slice().sort((a, b) => a - b);
  const pct = (q) => times.length ? +times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1) : 0;

  const s = (d.stream && d.stream.getVideoTracks) ? d.stream.getVideoTracks()[0].getSettings() : {};
  return {
    seconds: +dt.toFixed(2),
    srcFps: +(src / dt).toFixed(1),
    renderFps: +((p.frame - f0) / dt).toFixed(1),
    renderMsP50: pct(0.5), renderMsP95: pct(0.95), renderMsMax: times.length ? +times[times.length - 1].toFixed(1) : 0,
    capture: [v.videoWidth, v.videoHeight],
    declared: { w: s.width, h: s.height, fps: s.frameRate ? Math.round(s.frameRate) : null },
    out: [p.outW, p.outH],
    uiFps: document.getElementById('statFps').textContent,
    hint: document.getElementById('captureHint').textContent,
    settings: { denoise: p.settings.denoise, superRes: p.settings.superRes, stabilise: p.settings.stabilise, targetFps: p.settings.targetFps },
  };
})`;

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lumen-real-' + PORT + '-' + Date.now()),
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars', '--window-size=1440,900',
    '--use-fake-ui-for-media-stream',   // 只自动允许权限，不注入假画面
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
    await cdp.send('Page.navigate', { url: BASE + '/src/index.html' });
    await sleep(2500);

    // 选 USB CAMERA
    const picked = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('button')].filter(b => /点击开始/.test(b.textContent || ''));
      const usb = rows.find(b => /USB CAMERA/i.test(b.textContent || ''));
      const t = usb || rows[0];
      if (!t) return 'none';
      t.click();
      return (t.textContent || '').trim().split('\\n')[0];
    })()`);
    console.log('设备:', picked);

    let st = null;
    for (let i = 0; i < 30; i++) {
      await sleep(700);
      st = await cdp.eval(`(()=>{const p=window.__lumenDebug&&window.__lumenDebug.pipeline;return p?{frame:p.frame,live:document.getElementById('overlay').dataset.state}:null})()`);
      if (st && st.live === 'live' && st.frame > 20) break;
    }
    if (!st || st.live !== 'live') { console.error('画面未就绪:', JSON.stringify(st)); process.exit(1); }

    await sleep(1500);
    console.log('\n=== 当前状态（默认设置）===');
    const base = await cdp.eval(`(${MEASURE})(4000)`);
    console.log(JSON.stringify(base, null, 1));

    // 逐个排除算法，定位卡顿来源
    console.log('\n=== 关掉算法后 ===');
    for (const [name, js] of [
      ['关防抖+防果冻', `(()=>{const p=window.__lumenDebug.pipeline;p.settings.stabilise=false;p.settings.rollingShutter=false;p.resetAll();return 1})()`],
      ['再关降噪', `(()=>{const p=window.__lumenDebug.pipeline;p.settings.denoise=0;return 1})()`],
      ['再关超分（输出=采集）', `(()=>{document.querySelector('[data-res="720"]').click();return 1})()`],
    ]) {
      await cdp.eval(js);
      await sleep(1500);
      const m = await cdp.eval(`(${MEASURE})(3000)`);
      console.log(`  ${name}: 源 ${m.srcFps}fps | 渲染 ${m.renderFps}fps | 渲染耗时 p50 ${m.renderMsP50}ms p95 ${m.renderMsP95}ms | 采集 ${m.capture.join('x')} | 界面 ${m.uiFps}`);
    }

    // 采集分辨率档位实测（真机能给多少）
    console.log('\n=== 采集分辨率实测（真机）===');
    await cdp.eval(`(()=>{const p=window.__lumenDebug.pipeline;p.settings.stabilise=true;p.settings.rollingShutter=true;p.settings.denoise=0.55;document.querySelector('[data-res="1080"]').click();return 1})()`);
    await sleep(1200);
    for (const cap of ['540', '720', '1080', 'auto']) {
      await cdp.eval(`document.querySelector('#captureResGroup [data-cap="${cap}"]').click()`);
      await sleep(2600);
      const m = await cdp.eval(`(${MEASURE})(2600)`);
      console.log(`  ${String(cap).padEnd(5)} → 采集 ${String(m.capture.join('x')).padEnd(10)} 源 ${String(m.srcFps).padStart(5)}fps  渲染 ${String(m.renderFps).padStart(5)}fps  耗时 p95 ${m.renderMsP95}ms  界面 ${m.uiFps}`);
    }

    console.log('\n=== 结论 ===');
    const src = base.srcFps;
    if (src >= 25) console.log('  源帧率正常，卡顿来自处理或显示');
    else console.log(`  ⚠ 源只有 ${src} fps —— 摄像头在 Chrome 里就没送够帧`);
    console.log(`  渲染耗时 p95 ${base.renderMsP95}ms（30fps 预算是 33ms）`);
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
