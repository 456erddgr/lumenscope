'use strict';
// 自动探查摄像头的真实能力并给出最优采集格式。
// 原理：逐个候选格式临时开一次采集，实测 1 秒真实帧率 + 拿到实际尺寸，
// 然后按「先保帧率（≥25），再取最高分辨率」排序，挑最好的那个。
//
// 用法（独立跑，不要和 LumenScope 同时开着抢摄像头）：
//   node scripts/probe-camera-caps.js
// 输出 JSON：{ device, results:[{w,h,fps,actual,picked}] , best:{...} }
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9631);
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

// 试一个格式：返回真实帧率与实际尺寸
const TRY = `async (cons, ms) => {
  const withTimeout = (p, t, tag) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(tag), { name: 'Timeout' })), t)),
  ]);
  let s = null;
  try { s = await withTimeout(navigator.mediaDevices.getUserMedia(cons), 6000, 'open'); }
  catch (e) { return { err: e.name || e.message }; }

  const cleanup = () => { try { s.getTracks().forEach(t => t.stop()); } catch (_) {} };
  const v = document.createElement('video');
  v.srcObject = s; v.muted = true; v.playsInline = true;
  try { await withTimeout(v.play(), 3000, 'play'); } catch (_) {}

  // 等第一帧出来
  const gotFirst = await new Promise((resolve) => {
    if (v.videoWidth) return resolve(true);
    const t = setInterval(() => { if (v.videoWidth) { clearInterval(t); resolve(true); } }, 40);
    setTimeout(() => { clearInterval(t); resolve(!!v.videoWidth); }, 2000);
  });
  if (!gotFirst) { cleanup(); return { err: 'no-first-frame' }; }

  const size = [v.videoWidth, v.videoHeight];
  await new Promise(r => setTimeout(r, 500));   // 自动曝光稳定

  // 真的数帧
  let n = 0, cb = 0;
  const onF = () => { n++; try { cb = v.requestVideoFrameCallback(onF); } catch (_) {} };
  if (typeof v.requestVideoFrameCallback === 'function') {
    try { cb = v.requestVideoFrameCallback(onF); } catch (_) {}
  }
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, ms));
  const dt = (performance.now() - t0) / 1000;
  try { if (cb) v.cancelVideoFrameCallback(cb); } catch (_) {}

  const st = s.getVideoTracks()[0].getSettings ? s.getVideoTracks()[0].getSettings() : {};
  cleanup();
  try { v.srcObject = null; } catch (_) {}

  const fps = +(n / dt).toFixed(1);
  // 一帧都没有 = 这个格式打不开画面，判失败（不是"帧率 0"）
  if (n === 0) return { err: 'no-frames', actual: size };
  return { fps, actual: size, declared: st.frameRate ? Math.round(st.frameRate) : null };
}`;

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lumen-caps-' + PORT + '-' + Date.now()),
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(400);
      try { target = (await get(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (_) {}
    }
    // 需要一个安全上下文才能 getUserMedia：用本地服务打开
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: BASE + '/src/index.html' });
    await sleep(2500);

    const info = await cdp.eval(`(async () => {
      const d = await navigator.mediaDevices.enumerateDevices();
      const cams = d.filter(x => x.kind === 'videoinput');
      const usb = cams.find(x => /USB CAMERA/i.test(x.label)) || cams[0];
      return { cams: cams.map(c => c.label), pick: usb ? { label: usb.label, id: usb.deviceId } : null };
    })()`);
    if (!info.pick) throw new Error('没有摄像头');
    console.log('=== 摄像头 ===');
    console.log('  选中:', info.pick.label);
    console.log('  全部:', JSON.stringify(info.cams));

    const dev = { deviceId: { exact: info.pick.id } };

    // 候选：常见 UVC 分辨率 × 帧率，外加"不定尺寸"的几档
    const candidates = [];
    for (const [w, h] of [[1920, 1080], [1600, 900], [1280, 720], [1280, 960], [960, 540], [800, 600], [640, 480]]) {
      for (const fr of [60, 30]) candidates.push({ w, h, fr });
    }

    console.log('\n=== 逐个试探（每档 1.2 秒）===');
    const results = [];
    const seen = new Set();
    for (const c of candidates) {
      // 用 ideal 而不是 exact：这颗摄像头（VID_1224）对 exact 约束会掉进 0fps 的坏路径，
      // 而 ideal 能正常协商（真机实测 720p ideal → 1280x720@30 可用）。
      const cons = { audio: false, video: { ...dev, width: { ideal: c.w }, height: { ideal: c.h }, frameRate: { ideal: c.fr } } };
      const r = await cdp.eval(`(${TRY})(${JSON.stringify(cons)}, 1200)`);
      if (r.err) {
        // OverconstrainedError 表示浏览器直接拒绝，太吵不打印
        if (r.err !== 'OverconstrainedError') {
          console.log(`  ✗ ${String(c.w + 'x' + c.h).padEnd(10)} @${String(c.fr).padEnd(3)} → ${r.err}${r.actual ? ' (实际 ' + r.actual.join('x') + ')' : ''}`);
        }
        continue;
      }
      const key = r.actual.join('x') + '@' + c.fr;
      if (seen.has(key)) continue;
      seen.add(key);
      const ok = r.fps >= 25;
      console.log(`  ${ok ? '✓' : '·'} ${String(c.w + 'x' + c.h).padEnd(10)} @${String(c.fr).padEnd(3)} → 实际 ${String(r.actual.join('x')).padEnd(10)} ${String(r.fps).padStart(5)} fps`);
      results.push({ want: `${c.w}x${c.h}@${c.fr}`, actual: r.actual, fps: r.fps, picked: ok });
      await sleep(600);
    }

    // 也要试"只给 deviceId"（驱动自选）
    const plain = await cdp.eval(`(${TRY})(${JSON.stringify({ audio: false, video: dev })}, 1500)`);
    if (!plain.err) {
      console.log(`  ★ 只给 deviceId（驱动自选）           → 实际 ${plain.actual.join('x')}  ${plain.fps} fps`);
      results.push({ want: 'auto', actual: plain.actual, fps: plain.fps, picked: plain.fps >= 25 });
    }

    // 排序：先保帧率，再取分辨率
    const good = results.filter((r) => r.fps >= 25);
    good.sort((a, b) => (b.actual[0] * b.actual[1]) - (a.actual[0] * a.actual[1]));
    const best = good[0] || null;

    console.log('\n=== 结论 ===');
    if (best) {
      console.log(`  最佳采集格式: ${best.actual.join('x')} @ ${best.fps}fps  （申请参数 ${best.want}）`);
    } else {
      console.log('  没有能达到 25fps 的格式');
      const top = results.slice().sort((a, b) => b.fps - a.fps)[0];
      if (top) console.log(`  帧率最高的是 ${top.actual.join('x')} @ ${top.fps}fps`);
    }

    // 给程序读的
    const out = { device: info.pick.label, best, results };
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'camera-caps.json'), JSON.stringify(out, null, 2) + '\n');
    console.log('\n  已写入 docs/camera-caps.json');
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
