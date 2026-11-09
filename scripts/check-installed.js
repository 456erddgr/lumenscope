// 验证「安装版」的实际画面：连真实摄像头、出图、点开虚拟摄像头
const http = require('http');
const PORT = Number(process.argv[2] || 9572);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej); });

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result && r.result.value;
  }
}

const STATE = `(() => {
  const p = window.__lumenDebug && window.__lumenDebug.pipeline;
  return {
    live: document.getElementById('overlay').dataset.state,
    frame: p ? p.frame : 0,
    out: p ? [p.outW, p.outH] : null,
    cpuMs: p && p.lastStats ? +p.lastStats.cpuMs.toFixed(1) : null,
    title: document.title,
    author: document.querySelector('.author-line') ? document.querySelector('.author-line').textContent.trim() : null,
    license: document.querySelector('.license-line') ? document.querySelector('.license-line').textContent.trim() : null,
    brandBy: document.querySelector('.brand-by') ? document.querySelector('.brand-by').textContent.trim() : null,
    isElectron: document.body.classList.contains('is-electron'),
    vcamState: document.getElementById('btnVcam') ? document.getElementById('btnVcam').dataset.state : null,
  };
})()`;

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  await sleep(800);
  // 点 USB CAMERA
  const picked = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('button')].filter(b => /点击开始/.test(b.textContent || ''));
    const usb = rows.find(b => /USB CAMERA/i.test(b.textContent || ''));
    const t = usb || rows[0];
    if (!t) return 'none';
    t.click();
    return (t.textContent || '').trim().split('\\n')[0];
  })()`);
  console.log('点开设备：', picked);

  let st = null;
  for (let i = 0; i < 30; i++) {
    await sleep(600);
    st = await cdp.eval(STATE);
    if (st.live === 'live' && st.frame > 20) break;
  }
  console.log('状态：', JSON.stringify(st));

  // 打开虚拟摄像头
  await cdp.eval("document.getElementById('btnVcam').click()");
  await sleep(2500);
  const v = await cdp.eval(STATE);
  console.log('虚拟摄像头：', v.vcamState);

  const checks = [
    ['安装版能出画面', st.live === 'live' && st.frame > 20],
    ['标题带作者', /只因君/.test(st.title)],
    ['顶栏署名', /只因君/.test(st.brandBy || '')],
    ['面板署名', /只因君/.test(st.author || '')],
    ['授权提示', /禁止商用/.test(st.license || '')],
    ['Electron 壳', st.isElectron === true],
    ['虚拟摄像头可开', v.vcamState === 'live'],
    ['默认 1080p', st.out && st.out[1] === 1080],
  ];
  let pass = 0;
  for (const [n, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (ok) pass++; }
  console.log(`\n  ${pass}/${checks.length} 通过`);
  if (pass !== checks.length) process.exitCode = 1;
  process.exit();
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
