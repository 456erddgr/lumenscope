// 诊断：画面是不是"冻住"了（video 是否还在推进、按钮为什么 disabled）
const http = require('http');

const PORT = Number(process.argv[2] || 9444);

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      return { __err: (ex && (ex.description || ex.value)) || r.exceptionDetails.text };
    }
    return r.result && r.result.value;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAP = `(() => {
  const o = document.querySelector('.overlay');
  const dbg = window.__lumenDebug || {};
  return {
    overlay: o ? o.dataset.state : 'n/a',
    frame: dbg.pipeline ? dbg.pipeline.frame : null,
    toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).slice(-3),
    snapDisabled: document.getElementById('btnSnapshot').disabled,
    camSel: document.getElementById('cameraSelect').value.slice(0, 28)
  };
})()`;

(async () => {
  const page = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  console.log('t0', JSON.stringify(await cdp.eval(SNAP)));
  await wait(1500);
  console.log('t1', JSON.stringify(await cdp.eval(SNAP)));
  process.exit(0);
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
