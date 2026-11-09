'use strict';
// 逐个试探：在保证 25fps 以上的前提下，这台摄像头在 Chrome 里能拿到多高的分辨率。
// 每个组合测 2.5 秒真实帧率 + 确认画面尺寸。
// 用法：node scripts/exp-best-format.js [CDP端口]
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

const TEST_ONE = `async (cons, ms) => {
  let s = null;
  try { s = await navigator.mediaDevices.getUserMedia(cons); }
  catch (e) { return { err: e.name }; }
  const v = document.createElement('video');
  v.srcObject = s; v.muted = true; v.playsInline = true;
  await v.play().catch(() => {});
  await new Promise(r => { if (v.videoWidth) return r();
    const t = setInterval(() => { if (v.videoWidth) { clearInterval(t); r(); } }, 30);
    setTimeout(() => { clearInterval(t); r(); }, 1500); });
  await new Promise(r => setTimeout(r, 900));   // 等曝光稳定

  let n = 0, cb = null;
  const onF = () => { n++; cb = v.requestVideoFrameCallback(onF); };
  cb = v.requestVideoFrameCallback(onF);
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, ms));
  const dt = (performance.now() - t0) / 1000;
  try { v.cancelVideoFrameCallback(cb); } catch (_) {}
  const size = [v.videoWidth, v.videoHeight];
  s.getTracks().forEach(t => t.stop());
  return { fps: +(n / dt).toFixed(1), size };
}`;

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const devId = await cdp.eval(`(async () => {
    const d = await navigator.mediaDevices.enumerateDevices();
    const u = d.find(x => x.kind === 'videoinput' && /USB CAMERA/i.test(x.label));
    return u ? u.deviceId : null;
  })()`);
  if (!devId) { console.error('找不到 USB CAMERA'); process.exit(1); }
  const dev = { deviceId: { exact: devId } };

  // 覆盖常见 UVC 分辨率 + 常用帧率
  const sizes = [[320, 240], [640, 480], [800, 600], [960, 540], [1024, 768], [1280, 720], [1280, 960], [1600, 900], [1920, 1080]];
  const rates = [30, 25, 15];

  console.log('=== 试探：分辨率 × 帧率（每项 2.2 秒）===');
  const rows = [];
  for (const [w, h] of sizes) {
    for (const fr of rates) {
      const cons = { video: { ...dev, width: { exact: w }, height: { exact: h }, frameRate: { exact: fr } }, audio: false };
      const r = await cdp.eval(`(${TEST_ONE})(${JSON.stringify(cons)}, 2200)`);
      if (r.err) {
        console.log(`  ${String(w + 'x' + h).padEnd(10)} @${String(fr).padEnd(3)}  ✗ ${r.err}`);
      } else {
        const ok = r.fps >= 22 ? '  ' : '! ';
        console.log(`  ${ok}${String(w + 'x' + h).padEnd(10)} @${String(fr).padEnd(3)}  ${String(r.fps).padStart(5)} fps   实际 ${r.size[0]}x${r.size[1]}`);
        rows.push({ w, h, fr, fps: r.fps, actual: r.size });
      }
      await sleep(250);
    }
  }

  console.log('\n=== 结论：帧率 ≥25 的组合，按分辨率从高到低 ===');
  const good = rows.filter((r) => r.fps >= 25).sort((a, b) => (b.actual[0] * b.actual[1]) - (a.actual[0] * a.actual[1]));
  if (good.length) {
    for (const g of good.slice(0, 8)) {
      console.log(`  ${g.actual[0]}x${g.actual[1]} @${g.fr}  →  ${g.fps} fps`);
    }
    const best = good[0];
    console.log(`\n  最佳：申请 ${best.w}x${best.h}@${best.fr} → 实际 ${best.actual[0]}x${best.actual[1]}，${best.fps} fps`);
  } else {
    console.log('  没有组合能到 25fps');
  }
  process.exit(0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
