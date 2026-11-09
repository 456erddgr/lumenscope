'use strict';
// 测量"摄像头每秒真的送来几帧" vs "我们每秒渲染几次"
// 这是判断画面卡顿的关键：如果源只有 4fps，我们渲染 30 次也只是同一帧重复 30 遍。
// 用法：node scripts/diag-source-fps.js [CDP端口]
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

// 用 requestVideoFrameCallback 精确统计"源帧"到达次数
const MEASURE = `(async () => {
  const v = (window.__lumenDebug && window.__lumenDebug.video) || document.querySelector('video');
  if (!v) return { err: 'no video element' };

  const track = v.srcObject && v.srcObject.getVideoTracks ? v.srcObject.getVideoTracks()[0] : null;
  const settings = track && track.getSettings ? track.getSettings() : {};

  let srcFrames = 0;
  let t0 = performance.now();
  let lastMediaTime = v.currentTime;
  let currentTimeChanges = 0;
  let lastT = v.currentTime;

  // requestVideoFrameCallback：Chrome 支持，能拿到真实解码帧回调
  const hasRVFC = typeof v.requestVideoFrameCallback === 'function';
  let rvfcCount = 0;
  let rvfcCb = null;
  if (hasRVFC) {
    const onFrame = () => { rvfcCount++; rvfcCb = v.requestVideoFrameCallback(onFrame); };
    rvfcCb = v.requestVideoFrameCallback(onFrame);
  }

  // 同时轮询 currentTime / readyState
  const timer = setInterval(() => {
    if (v.currentTime !== lastT) { currentTimeChanges++; lastT = v.currentTime; }
  }, 4);

  const pipe = window.__lumenDebug.pipeline;
  const frameStart = pipe ? pipe.frame : 0;
  const t1 = performance.now();

  await new Promise(r => setTimeout(r, 4000));

  clearInterval(timer);
  if (rvfcCb) try { v.cancelVideoFrameCallback(rvfcCb); } catch (_) {}

  const dt = (performance.now() - t1) / 1000;
  const rendered = (window.__lumenDebug.pipeline.frame - frameStart);

  return {
    seconds: +dt.toFixed(2),
    // 源侧
    srcFpsByRVFC: hasRVFC ? +(rvfcCount / dt).toFixed(1) : null,
    srcFpsByCurrentTime: +(currentTimeChanges / dt).toFixed(1),
    hasRVFC,
    videoReadyState: v.readyState,
    videoPaused: v.paused,
    // 轨道协商参数
    trackSettings: {
      width: settings.width, height: settings.height,
      frameRate: settings.frameRate, aspectRatio: settings.aspectRatio,
      exposureTime: settings.exposureTime, exposureMode: settings.exposureMode,
    },
    trackLabel: track ? track.label : null,
    // 我们渲染了多少次
    renderedFrames: rendered,
    renderFps: +(rendered / dt).toFixed(1),
    // 界面显示
    uiFps: document.getElementById('statFps').textContent,
  };
})()`;

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  let st = null;
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    st = await cdp.eval(`(()=>{const p=window.__lumenDebug&&window.__lumenDebug.pipeline;return p?{frame:p.frame,live:document.getElementById('overlay').dataset.state}:null})()`);
    if (st && st.live === 'live' && st.frame > 5) break;
  }
  if (!st || st.live !== 'live') { console.error('画面未就绪:', JSON.stringify(st)); process.exit(1); }

  console.log('=== 源帧率 vs 渲染帧率（1080p 默认设置）===');
  const a = await cdp.eval(MEASURE);
  console.log(JSON.stringify(a, null, 1));

  // 切到 720p 再看（排除超分开销）
  await cdp.eval(`document.querySelector('[data-res="720"]').click()`);
  await sleep(1500);
  console.log('\n=== 720p 输出 ===');
  const b = await cdp.eval(MEASURE);
  console.log(JSON.stringify({ srcFpsByRVFC: b.srcFpsByRVFC, srcFpsByCurrentTime: b.srcFpsByCurrentTime, renderFps: b.renderFps, uiFps: b.uiFps }, null, 1));

  // 关掉所有算法再看（最纯粹地测源）
  await cdp.eval(`(()=>{const p=window.__lumenDebug.pipeline;p.settings.stabilise=false;p.settings.rollingShutter=false;p.settings.denoise=0;p.settings.superRes=false;p.resetAll();return 1})()`);
  await sleep(1500);
  console.log('\n=== 720p + 全部算法关闭（最纯粹的源帧率）===');
  const c = await cdp.eval(MEASURE);
  console.log(JSON.stringify({ srcFpsByRVFC: c.srcFpsByRVFC, srcFpsByCurrentTime: c.srcFpsByCurrentTime, renderFps: c.renderFps, uiFps: c.uiFps }, null, 1));

  console.log('\n=== 判定 ===');
  const src = c.srcFpsByRVFC || c.srcFpsByCurrentTime;
  if (src < 15) {
    console.log(`  摄像头本身只送 ${src} fps —— 这就是"看着才三四帧"的原因`);
    console.log('  我们渲染的次数是对的，但同一帧被重复渲染，画面自然不流畅');
  } else if (src >= 25) {
    console.log(`  摄像头送 ${src} fps，源没问题；卡顿出在处理或显示侧`);
  } else {
    console.log(`  摄像头送 ${src} fps，偏低但不至于三四帧`);
  }
  process.exit(0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
