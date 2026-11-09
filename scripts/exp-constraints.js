'use strict';
// 对照实验：不同的 getUserMedia 约束下，摄像头真实能给多少帧。
// 目的：找出"我们请求的约束"是不是让摄像头掉帧的原因。
// 用法：node scripts/exp-constraints.js [CDP端口]
const http = require('http');

const PORT = Number(process.argv[2] || 9591);
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

// 在一个全新的 video 元素上测：给定约束 → 真实帧回调频率
const TEST = `async (constraints) => {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    return { err: e.name + ': ' + e.message };
  }
  const v = document.createElement('video');
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  await v.play().catch(() => {});
  await new Promise(r => { if (v.videoWidth) return r(); const t = setInterval(() => { if (v.videoWidth) { clearInterval(t); r(); } }, 30); setTimeout(() => { clearInterval(t); r(); }, 2000); });

  const track = stream.getVideoTracks()[0];
  const st = track.getSettings ? track.getSettings() : {};

  // 等自动曝光稳定
  await new Promise(r => setTimeout(r, 1200));

  let n = 0;
  let cb = null;
  const useRVFC = typeof v.requestVideoFrameCallback === 'function';
  if (useRVFC) {
    const onF = () => { n++; cb = v.requestVideoFrameCallback(onF); };
    cb = v.requestVideoFrameCallback(onF);
  }
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, 3000));
  const dt = (performance.now() - t0) / 1000;
  if (cb) try { v.cancelVideoFrameCallback(cb); } catch (_) {}

  stream.getTracks().forEach(t => t.stop());

  return {
    actualFps: useRVFC ? +(n / dt).toFixed(1) : null,
    videoSize: [v.videoWidth, v.videoHeight],
    reported: { w: st.width, h: st.height, fps: st.frameRate },
    label: track.label,
  };
}`;

// 我们真实的摄像头 deviceId 需要先拿到
const GET_DEVID = `(async () => {
  const d = await navigator.mediaDevices.enumerateDevices();
  const usb = d.find(x => x.kind === 'videoinput' && /USB CAMERA/i.test(x.label));
  return usb ? usb.deviceId : null;
})()`;

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const devId = await cdp.eval(GET_DEVID);
  console.log('设备 deviceId:', devId ? devId.slice(0, 20) + '…' : '未找到');

  const dev = devId ? { deviceId: { exact: devId } } : {};

  const cases = [
    ['① 只给 deviceId（当前做法）', { video: { ...dev }, audio: false }],
    ['② 640x480 exact + 30fps（保帧率）', { video: { ...dev, width: { exact: 640 }, height: { exact: 480 }, frameRate: { exact: 30 } }, audio: false }],
    ['③ 1280x720 exact（不指定 fps）', { video: { ...dev, width: { exact: 1280 }, height: { exact: 720 } }, audio: false }],
    ['④ 1280x720 ideal + 30fps ideal', { video: { ...dev, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false }],
    ['⑤ 1280x720 ideal + 30fps exact', { video: { ...dev, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { exact: 30 } }, audio: false }],
    ['⑥ 1920x1080 ideal + 30fps exact', { video: { ...dev, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { exact: 30 } }, audio: false }],
    ['⑦ resizeMode none + 720p ideal', { video: { ...dev, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, resizeMode: 'none' }, audio: false }],
    ['⑧ 720p ideal + fps ideal + resizeMode crop-and-scale', { video: { ...dev, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, resizeMode: 'crop-and-scale' }, audio: false }],
  ];

  console.log('\n=== 不同约束下的真实帧率（每个测 3 秒）===');
  const results = [];
  for (const [name, cons] of cases) {
    const r = await cdp.eval(`(${TEST})(${JSON.stringify(cons)})`);
    results.push({ name, ...r });
    if (r.err) {
      console.log(`${name}\n   失败: ${r.err}`);
    } else {
      console.log(`${name}\n   真实 ${r.actualFps} fps · 画面 ${r.videoSize[0]}x${r.videoSize[1]} · 声明 ${r.reported.w}x${r.reported.h}@${r.reported.fps}`);
    }
    await sleep(600);
  }

  console.log('\n=== 最优约束 ===');
  // 最优 = 帧率 ≥25 且 分辨率尽量高
  const good = results.filter((r) => !r.err && r.actualFps >= 25);
  if (good.length) {
    good.sort((a, b) => (b.videoSize[0] * b.videoSize[1]) - (a.videoSize[0] * a.videoSize[1]));
    const best = good[0];
    console.log(`  帧率达标的有 ${good.length} 种，分辨率最高的是：`);
    console.log(`    ${best.name}`);
    console.log(`    ${best.actualFps} fps @ ${best.videoSize[0]}x${best.videoSize[1]}`);
  } else {
    console.log('  没有一种约束能到 25fps 以上');
  }
  process.exit(0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
