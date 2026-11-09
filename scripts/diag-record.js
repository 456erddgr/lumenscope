// 录制专项诊断：开始→等 3 秒→停止→读 toast 与状态，看是哪一步断了
const http = require('http');

const PORT = Number(process.argv[2] || 9444);
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  static async connect(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { const ex = r.exceptionDetails.exception; return { __err: (ex && (ex.description || ex.value)) || r.exceptionDetails.text }; }
    return r.result && r.result.value;
  }
}

(async () => {
  const page = (await get(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 重新加载，确保跑的是最新代码
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await wait(4000);

  console.log('reload 后', JSON.stringify(await cdp.eval(`(() => {
    const p = (window.__lumenDebug || {}).pipeline;
    return { frame: p ? p.frame : null, snap: document.getElementById('btnSnapshot').disabled };
  })()`)));

  if ((await cdp.eval(`document.getElementById('btnSnapshot').disabled`))) {
    await cdp.eval(`(() => { const r=[...document.querySelectorAll('button')].filter(b=>/USB CAMERA/i.test(b.textContent)); r[0] && r[0].click(); return r.length; })()`);
    await wait(4000);
  }

  console.log('点录制前', JSON.stringify(await cdp.eval(`(() => ({
    ready: (window.__lumenDebug||{}).pipeline ? (window.__lumenDebug.pipeline.frame) : null,
    supported: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
  }))()`)));

  await cdp.eval(`document.getElementById('btnRecord').click(), 1`);
  await wait(1200);
  console.log('录制中', JSON.stringify(await cdp.eval(`(() => ({
    isRec: document.body.classList.contains('is-recording'),
    badge: document.getElementById('recBadge') ? !document.getElementById('recBadge').hidden : null,
    toast: [...document.querySelectorAll('.toast')].map(t=>t.textContent.trim()).slice(-2)
  }))()`)));

  await wait(2500);
  await cdp.eval(`document.getElementById('btnRecord').click(), 1`);
  for (let i = 0; i < 8; i++) {
    await wait(700);
    const t = await cdp.eval(`[...document.querySelectorAll('.toast')].map(t=>t.textContent.trim()).slice(-3)`);
    console.log('  toast', i, JSON.stringify(t));
  }
  process.exit(0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
