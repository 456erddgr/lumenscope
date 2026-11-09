// 端到端：像用户一样先点设备开启画面，再点拍照/录像，确认文件落到「下载」文件夹
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.argv[2] || 9444);
const DL = path.join(os.homedir(), 'Downloads');

const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const files = () => new Set(fs.existsSync(DL) ? fs.readdirSync(DL).filter((f) => /lumen/i.test(f)) : []);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') this.errs.push(JSON.stringify(m.params).slice(0, 200));
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

const STATE = `(() => {
  const p = (window.__lumenDebug || {}).pipeline;
  const b = document.getElementById('btnSnapshot');
  return { frame: p ? p.frame : null, out: p ? [p.outW, p.outH] : null, snapDisabled: b.disabled };
})()`;

(async () => {
  const page = (await get(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  console.log('初始', JSON.stringify(await cdp.eval(STATE)));

  if ((await cdp.eval(STATE)).snapDisabled) {
    // 点第一个设备卡片（USB CAMERA）
    const clicked = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('[data-device], .dev-item, .device-item, button')]
        .filter(el => /USB CAMERA/i.test(el.textContent || ''));
      if (!rows.length) return 'no-row';
      rows[0].click();
      return 'clicked:' + rows[0].className;
    })()`);
    console.log('点设备', clicked);
    for (let i = 0; i < 20; i++) {
      await wait(700);
      const s = await cdp.eval(STATE);
      if (!s.snapDisabled) { console.log('已开启', JSON.stringify(s)); break; }
      if (i === 19) console.log('仍未开启', JSON.stringify(s));
    }
  }

  const before = files();
  await cdp.eval(`document.getElementById('btnSnapshot').click(), 1`);
  await wait(3000);
  const added = [...files()].filter((f) => !before.has(f));
  console.log('拍照产出', JSON.stringify(added));

  const before2 = files();
  await cdp.eval(`document.getElementById('btnRecord').click(), 1`);
  await wait(2500);
  await cdp.eval(`document.getElementById('btnRecord').click(), 1`);
  await wait(3500);
  const added2 = [...files()].filter((f) => !before2.has(f));
  console.log('录像产出', JSON.stringify(added2));

  for (const f of [...added, ...added2]) {
    const full = path.join(DL, f);
    console.log('  ', f, fs.statSync(full).size, 'bytes');
    if (/\.png$/i.test(f)) {
      const buf = fs.readFileSync(full);
      console.log('   PNG', buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20));
    }
  }
  if (cdp.errs.length) console.log('页面异常', cdp.errs.slice(-3));
  process.exit(0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
