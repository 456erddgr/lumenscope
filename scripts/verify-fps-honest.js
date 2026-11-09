'use strict';
// 验证帧率显示是否如实：故意把源降到低帧率，看界面会不会如实显示而不是谎报 30。
// 用法：node scripts/verify-fps-honest.js [CDP端口]
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

const READ = `(() => {
  const el = document.getElementById('statFps');
  const p = window.__lumenDebug && window.__lumenDebug.pipeline;
  return {
    shown: el.textContent,
    title: el.parentElement.title,
    warn: el.parentElement.dataset.warn,
    srcFps: window.__lumenDebug && window.__lumenDebug.__srcFps ? window.__lumenDebug.__srcFps : null,
    renderFrame: p ? p.frame : 0,
    uiMs: document.getElementById('statMs').textContent,
  };
})()`;

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 等画面就绪
  let st = null;
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    st = await cdp.eval(`(()=>{const p=window.__lumenDebug&&window.__lumenDebug.pipeline;return p?{frame:p.frame,live:document.getElementById('overlay').dataset.state}:null})()`);
    if (st && st.live === 'live' && st.frame > 10) break;
  }
  if (!st || st.live !== 'live') { console.error('画面未就绪'); process.exit(1); }

  await sleep(2000);
  console.log('=== 正常情况（源 30fps）===');
  const a = await cdp.eval(READ);
  console.log(JSON.stringify(a));

  // 故意把 track 限制到 5fps，模拟"源跟不上"
  console.log('\n=== 强制把源降到 5fps ===');
  const r = await cdp.eval(`(async () => {
    const s = window.__lumenDebug && window.__lumenDebug.stream;
    if (!s) return 'no stream';
    const t = s.getVideoTracks()[0];
    try {
      await t.applyConstraints({ frameRate: 5 });
      return 'applied: ' + JSON.stringify(t.getSettings().frameRate);
    } catch (e) { return 'failed: ' + e.name; }
  })()`);
  console.log('applyConstraints:', r);

  await sleep(2500);
  const b = await cdp.eval(READ);
  console.log(JSON.stringify(b));

  // 恢复
  await cdp.eval(`(async () => {
    const s = window.__lumenDebug && window.__lumenDebug.stream;
    if (!s) return;
    const t = s.getVideoTracks()[0];
    try { await t.applyConstraints({ frameRate: 30 }); } catch (e) {}
  })()`);
  await sleep(2000);
  const c = await cdp.eval(READ);

  console.log('\n=== 判定 ===');
  const checks = [
    ['正常时显示 30 fps 左右', Math.abs(parseFloat(a.shown) - 30) <= 4],
    ['源降到 5fps 后显示值也降下来（不再谎报 30）', parseFloat(b.shown) < 20],
    ['低帧率时标红告警', b.warn === 'true'],
    ['低帧率时有解释性提示', /摄像头只送来|帧率/.test(b.title || '')],
    ['恢复后回到 30 左右', Math.abs(parseFloat(c.shown) - 30) <= 6],
  ];
  let pass = 0;
  for (const [n, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (ok) pass++; }
  console.log(`\n  ${pass}/${checks.length} 通过`);
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
