'use strict';
// 可靠版摄像头能力探查（第二版）
//
// 两个必须遵守的前提（都是实测踩出来的）：
//   ① deviceId 是**每个浏览器会话独立**的，跨进程传过去的 id 会失效 → 必须在同一进程里现取现用
//   ② 同一页面连续开关摄像头会互相干扰（后面的请求大概率拿不到帧）
//      → 每一档都开一个全新的浏览器进程，进程内只测一档
//
// 用法：node scripts/probe-camera-caps2.js
// 输出：docs/camera-caps.json  { device, best, results }
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const BASE = process.env.URL_BASE || 'http://127.0.0.1:4173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result && r.result.value;
  }
}

// 在页面里：现取 deviceId → 按给定策略开一次 → 数帧 → 报告
const PROBE = `async (want, ms) => {
  const T = (p, t) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(Object.assign(new Error('timeout'), { name: 'Timeout' })), t))]);

  // ① 现取 deviceId
  const list = await navigator.mediaDevices.enumerateDevices();
  const cams = list.filter(x => x.kind === 'videoinput');
  const usb = cams.find(x => /USB CAMERA/i.test(x.label)) || cams[0];
  if (!usb) return { err: 'no-camera' };

  const dev = { deviceId: { exact: usb.deviceId } };
  let cons;
  if (!want) cons = { audio: false, video: dev };
  else cons = { audio: false, video: { ...dev, width: { ideal: want[0] }, height: { ideal: want[1] }, frameRate: { ideal: 30 } } };

  let s = null;
  try { s = await T(navigator.mediaDevices.getUserMedia(cons), 7000); }
  catch (e) { return { err: e.name || e.message, device: usb.label }; }
  const stop = () => { try { s.getTracks().forEach(t => t.stop()); } catch (_) {} };

  const v = document.createElement('video');
  v.srcObject = s; v.muted = true; v.playsInline = true;
  try { await T(v.play(), 3000); } catch (_) {}

  const first = await new Promise((resolve) => {
    if (v.videoWidth) return resolve(true);
    const t = setInterval(() => { if (v.videoWidth) { clearInterval(t); resolve(true); } }, 40);
    setTimeout(() => { clearInterval(t); resolve(!!v.videoWidth); }, 2500);
  });
  if (!first) { stop(); return { err: 'no-first-frame', device: usb.label }; }

  const size = [v.videoWidth, v.videoHeight];
  await new Promise(r => setTimeout(r, 600));

  let n = 0, cb = 0;
  const onF = () => { n++; try { cb = v.requestVideoFrameCallback(onF); } catch (_) {} };
  try { cb = v.requestVideoFrameCallback(onF); } catch (_) {}
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, ms));
  const dt = (performance.now() - t0) / 1000;
  try { if (cb) v.cancelVideoFrameCallback(cb); } catch (_) {}
  const st = s.getVideoTracks()[0].getSettings ? s.getVideoTracks()[0].getSettings() : {};
  stop();
  v.srcObject = null;
  if (n === 0) return { err: 'no-frames', actual: size, device: usb.label };
  return { fps: +(n / dt).toFixed(1), actual: size, device: usb.label,
           declared: st.frameRate ? Math.round(st.frameRate) : null };
}`;

async function probeOnce(port, want, ms) {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`,
    '--user-data-dir=' + path.join(os.tmpdir(), `lumen-p-${port}-${Date.now()}`),
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(300);
      try { target = (await get(port, '/json/list')).find((t) => t.type === 'page'); } catch (_) {}
    }
    if (!target) return { err: 'no-chrome' };
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: BASE + '/src/index.html' });
    await sleep(2000);
    return await cdp.eval(`(${PROBE})(${JSON.stringify(want)}, ${ms})`);
  } finally {
    try { chrome.kill(); } catch (_) {}
    await sleep(1100);
  }
}

(async () => {
  const cases = [
    { name: 'auto（驱动自选）', want: null },
    { name: '1920x1080', want: [1920, 1080] },
    { name: '1600x900', want: [1600, 900] },
    { name: '1280x720', want: [1280, 720] },
    { name: '1280x960', want: [1280, 960] },
    { name: '960x540', want: [960, 540] },
    { name: '800x600', want: [800, 600] },
    { name: '640x480', want: [640, 480] },
  ];

  console.log('=== 逐档实测（每档独立浏览器进程，2 秒）===');
  const results = [];
  let port = 9660;
  let deviceName = '';
  for (const c of cases) {
    const r = await probeOnce(port++, c.want, 2000);
    if (r.device) deviceName = r.device;
    if (r.err) {
      console.log(`  ✗ ${c.name.padEnd(14)} → ${r.err}${r.actual ? '  (实际 ' + r.actual.join('x') + ')' : ''}`);
      results.push({ name: c.name, want: c.want, err: r.err, actual: r.actual || null });
    } else {
      const ok = r.fps >= 25;
      console.log(`  ${ok ? '✓' : '·'} ${c.name.padEnd(14)} → 实际 ${String(r.actual.join('x')).padEnd(10)} ${String(r.fps).padStart(5)} fps`);
      results.push({ name: c.name, want: c.want, actual: r.actual, fps: r.fps, ok });
    }
  }

  const good = results.filter((r) => r.ok);
  good.sort((a, b) => (b.actual[0] * b.actual[1]) - (a.actual[0] * a.actual[1]));
  const best = good[0] || null;

  console.log('\n=== 结论 ===');
  console.log('  设备:', deviceName || '(未知)');
  if (best) {
    console.log(`  最佳采集: ${best.name} → ${best.actual.join('x')} @ ${best.fps}fps`);
  } else {
    console.log('  没有稳定 25fps 以上的档');
  }

  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'camera-caps.json'),
    JSON.stringify({ device: deviceName, best, results }, null, 2) + '\n');
  console.log('\n  已写入 docs/camera-caps.json');
  process.exit(0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
