// 连拍两帧截图并比较，判断画面是否真的在动
const fs = require('fs');
const http = require('http');

const PORT = Number(process.argv[2] || 9381);
const OUT = process.argv[3] || 'docs/shots/frame-a.png';

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
  async shot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.data, 'base64');
  }
}

(async () => {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((x) => x.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  const a = await cdp.shot();
  await new Promise((r) => setTimeout(r, 600));
  const b = await cdp.shot();
  fs.writeFileSync(OUT.replace('-a', '-a'), a);
  fs.writeFileSync(OUT.replace('-a', '-b'), b);
  console.log(JSON.stringify({ a: a.length, b: b.length, identical: a.equals(b) }));
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
