// 量化降噪效果：按 pipeline.frame 同步抽帧，测相邻帧平均绝对差（时域噪声）
// 用法：node scripts/measure-denoise.js [CDP端口]
const http = require('http');

const PORT = Number(process.argv[2] || 9381);

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

const PROBE = (dn) => `(async () => {
  const p = window.__lumenDebug.pipeline;
  p.settings.denoise = ${dn};
  p.resetAll();
  await new Promise((r) => setTimeout(r, 1600));
  const W = 480, H = 270, vals = [];
  let prev = null, last = -1;
  for (let i = 0; i < 60 && vals.length < 12; i++) {
    await new Promise((r) => setTimeout(r, 16));
    if (p.frame === last) continue;
    last = p.frame;
    const f = p.readStream(W, H);
    const a = new Uint8ClampedArray(f.buf.slice(0));
    if (prev) {
      let s = 0;
      for (let k = 0; k < a.length; k += 4) s += Math.abs(a[k] - prev[k]);
      vals.push(s / (a.length / 4));
    }
    prev = a;
  }
  vals.sort((x, y) => x - y);
  return {
    median: +vals[(vals.length / 2) | 0].toFixed(2),
    min: +vals[0].toFixed(2),
    max: +vals[vals.length - 1].toFixed(2),
    n: vals.length
  };
})()`;

(async () => {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((x) => x.type === 'page');
  if (!page) throw new Error('没有找到页面 target');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  for (const dn of [0, 0.35, 0.55, 0.9]) {
    console.log(`denoise=${dn}`.padEnd(12), JSON.stringify(await cdp.eval(PROBE(dn))));
  }
  process.exit(0);
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
