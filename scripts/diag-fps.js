'use strict';
// 帧率与耗时诊断：分清「rAF 频率 / 真正渲染的帧 / 各阶段耗时 / 界面显示的数字」
// 用法：node scripts/diag-fps.js [CDP端口]
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

// 在页面里装探针：统计 rAF、render、运动估计的真实频率
const INSTRUMENT = `(() => {
  const p = window.__lumenDebug && window.__lumenDebug.pipeline;
  if (!p) return 'no pipeline';

  // 1) rAF 真实频率
  window.__probe = { raf: 0, render: 0, motion: 0, t0: performance.now(), renderMs: [], motionMs: [], stageMs: {} };

  const loopProbe = () => { window.__probe.raf++; requestAnimationFrame(loopProbe); };
  requestAnimationFrame(loopProbe);

  // 2) 包一层 render
  if (!p.__wrapped) {
    const origRender = p.render.bind(p);
    p.render = function (v) {
      const t = performance.now();
      const r = origRender(v);
      window.__probe.render++;
      window.__probe.renderMs.push(performance.now() - t);
      return r;
    };
    const origAnalyze = p.motion.analyze.bind(p.motion);
    p.motion.analyze = function (...a) {
      const t = performance.now();
      const r = origAnalyze(...a);
      window.__probe.motion++;
      window.__probe.motionMs.push(performance.now() - t);
      return r;
    };
    p.__wrapped = true;
  }
  return 'ok';
})()`;

const SAMPLE = `(() => {
  const pr = window.__probe;
  const p = window.__lumenDebug.pipeline;
  const el = performance.now();
  const dt = (el - pr.t0) / 1000;
  const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0;
  const pct = (arr, q) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1);
  };
  const out = {
    seconds: +dt.toFixed(2),
    rafFps: +(pr.raf / dt).toFixed(1),
    renderFps: +(pr.render / dt).toFixed(1),
    motionFps: +(pr.motion / dt).toFixed(1),
    renderMsAvg: avg(pr.renderMs), renderMsP50: pct(pr.renderMs, 0.5), renderMsP95: pct(pr.renderMs, 0.95),
    motionMsAvg: avg(pr.motionMs), motionMsP95: pct(pr.motionMs, 0.95),
    // 界面显示的数字
    uiFps: document.getElementById('statFps').textContent,
    uiMs: document.getElementById('statMs').textContent,
    uiWarn: document.getElementById('statFps').parentElement.dataset.warn,
    // 内部计数
    pipelineFrame: p.frame,
    targetFps: p.settings.targetFps,
    outSize: [p.outW, p.outH],
    denoise: p.settings.denoise, superRes: p.settings.superRes, stabilise: p.settings.stabilise,
  };
  pr.raf = 0; pr.render = 0; pr.motion = 0; pr.renderMs = []; pr.motionMs = []; pr.t0 = el;
  return out;
})()`;

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到页面');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 确认有画面
  let st = null;
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    st = await cdp.eval(`(()=>{const p=window.__lumenDebug&&window.__lumenDebug.pipeline;return p?{frame:p.frame,live:document.getElementById('overlay').dataset.state}:null})()`);
    if (st && st.live === 'live' && st.frame > 5) break;
  }
  console.log('画面:', JSON.stringify(st));
  if (!st || st.live !== 'live') { console.error('画面未就绪'); process.exit(1); }

  console.log('探针:', await cdp.eval(INSTRUMENT));
  await sleep(1500);   // 丢掉起步的不稳定期

  const scenarios = [
    ['默认（1080p 全开）', null],
  ];

  for (const [name, fn] of scenarios) {
    console.log(`\n===== ${name} =====`);
    await cdp.eval(`window.__probe && (window.__probe.t0 = performance.now(), window.__probe.raf=0, window.__probe.render=0, window.__probe.motion=0, window.__probe.renderMs=[], window.__probe.motionMs=[])`);
    await sleep(3500);
    const s = await cdp.eval(SAMPLE);
    console.log(JSON.stringify(s, null, 1));
  }

  // 关掉各项算法逐个看
  for (const [name, cfg] of [
    ['关运动估计（防抖+防果冻）', `(()=>{const p=window.__lumenDebug.pipeline;p.settings.stabilise=false;p.settings.rollingShutter=false;p.resetAll();return 1})()`],
    ['再关降噪', `(()=>{const p=window.__lumenDebug.pipeline;p.settings.denoise=0;return 1})()`],
    ['降到 720p', `(()=>{document.querySelector('[data-res="720"]').click();return 1})()`],
  ]) {
    await cdp.eval(cfg);
    await sleep(1200);
    await cdp.eval(`window.__probe && (window.__probe.t0 = performance.now(), window.__probe.raf=0, window.__probe.render=0, window.__probe.motion=0, window.__probe.renderMs=[], window.__probe.motionMs=[])`);
    await sleep(3000);
    const s = await cdp.eval(SAMPLE);
    console.log(`\n===== ${name} =====`);
    console.log(`  rAF ${s.rafFps}  |  render ${s.renderFps}  |  motion ${s.motionFps}  |  render ${s.renderMsAvg}ms (p95 ${s.renderMsP95})  |  motion ${s.motionMsAvg}ms (p95 ${s.motionMsP95})  |  界面显示 ${s.uiFps} FPS / ${s.uiMs} ms`);
  }

  process.exit(0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
