// 点一次拍照按钮，收集 console 报错与 toast 文案，定位"没生成文件"的原因
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
    this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        this.events.push(m);
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

(async () => {
  const page = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  console.log('button', JSON.stringify(await cdp.eval(`(() => {
    const b = document.getElementById('btnSnapshot');
    return b ? { disabled: b.disabled, hasClick: !!b.onclick } : 'missing';
  })()`)));

  console.log('host', JSON.stringify(await cdp.eval(`(() => ({
    hasLumen: typeof window.lumen,
    keys: window.lumen ? Object.keys(window.lumen) : null
  }))()`)));

  await cdp.eval(`document.getElementById('btnSnapshot').click(), 1`);
  await wait(2500);

  console.log('toasts', JSON.stringify(await cdp.eval(`[...document.querySelectorAll('.toast')].map(t => t.textContent.trim())`)));
  const errs = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
    .map((e) => JSON.stringify(e.params).slice(0, 300));
  console.log('console', JSON.stringify(errs.slice(-6), null, 1));
  process.exit(0);
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
