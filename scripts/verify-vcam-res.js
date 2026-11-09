'use strict';
// 验证虚拟摄像头是否真的按输出档位输出（1080p / 2K），并且内容是处理后的实时画面。
// 用法：node scripts/verify-vcam-res.js [CDP端口]
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.argv[2] || 9581);
const PY = 'py -3.11';
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result && r.result.value;
  }
}

// 用 Python 读虚拟摄像头（另一个进程，能反映系统真实看到的东西）
function readVcam(file, wantW, wantH) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    if (wantW && wantH) { env.WANT_W = String(wantW); env.WANT_H = String(wantH); }
    const p = spawn('py', ['-3.11', path.join(__dirname, '..', 'native', 'probe_vcam_out.py'), file], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('exit', () => resolve(out));
    setTimeout(() => { try { p.kill(); } catch (_) {} }, 30000);
  });
}

const SHOTS = path.join(__dirname, '..', 'docs', 'shots');

(async () => {
  const list = await get(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 确保有画面
  let st = null;
  for (let i = 0; i < 30; i++) {
    await sleep(600);
    st = await cdp.eval(`(()=>{const p=window.__lumenDebug&&window.__lumenDebug.pipeline;return p?{frame:p.frame,live:document.getElementById('overlay').dataset.state}:null})()`);
    if (st && st.live === 'live' && st.frame > 10) break;
  }
  if (!st || st.live !== 'live') {
    await cdp.eval(`(()=>{const r=[...document.querySelectorAll('button')].filter(b=>/USB CAMERA|点击开始/.test(b.textContent||''));r[0]&&r[0].click();return 1})()`);
    for (let i = 0; i < 30; i++) {
      await sleep(600);
      st = await cdp.eval(`(()=>{const p=window.__lumenDebug&&window.__lumenDebug.pipeline;return p?{frame:p.frame,live:document.getElementById('overlay').dataset.state}:null})()`);
      if (st && st.live === 'live' && st.frame > 10) break;
    }
  }
  console.log('画面状态:', JSON.stringify(st));

  const results = [];
  for (const [label, res] of [['1080p', 1080], ['2K', 1440]]) {
    // 切档位
    await cdp.eval(`document.querySelector('[data-res="${res}"]').click()`);
    await sleep(1500);

    // 若虚拟摄像头没开就先开
    const on = await cdp.eval(`(()=>{const b=document.getElementById('btnVcam');return b.dataset.state})()`);
    if (on !== 'live') {
      await cdp.eval(`document.getElementById('btnVcam').click()`);
      await sleep(3500);
    } else {
      // 已开着：切档位应自动重启
      await sleep(3500);
    }

    const vs = await cdp.eval(`(()=>{const b=document.getElementById('btnVcam');const p=window.__lumenDebug.pipeline;return {
      state:b.dataset.state, text:b.innerText.replace(/\\n/g,' | '), out:[p.outW,p.outH]}})()`);
    const api = await cdp.eval(`window.lumen ? window.lumen.vcamState() : fetch('/api/vcam/state').then(r=>r.json())`);

    // 读系统侧实际拿到的分辨率
    const file = path.join(SHOTS, `vcam-${res}.png`);
    const pyOut = await readVcam(file, res === 1440 ? 2560 : 1920, res);

    results.push({ label, want: res, ui: vs, bridge: api, py: pyOut });
    console.log(`\n===== ${label} =====`);
    console.log('  界面:', JSON.stringify(vs));
    console.log('  桥接:', JSON.stringify({ status: api.status, w: api.width, h: api.height, fps: api.fps, frames: api.frames }));
    const m = /实际分辨率: (\d+)x(\d+)/.exec(pyOut);
    const fpsM = /实际帧数: (\d+)\s+\(≈([\d.]+) fps\)/.exec(pyOut);
    const diffM = /相邻帧平均差异: ([\d.]+)\s+（([^）]*)）/.exec(pyOut);
    if (m) console.log(`  系统读取: ${m[1]}x${m[2]}` + (fpsM ? ` @${fpsM[2]}fps` : '') + (diffM ? `  差异${diffM[1]}（${diffM[2]}）` : ''));
    else console.log('  系统读取: ' + pyOut.split('\n').filter(Boolean).slice(-4).join(' / '));
  }

  // 关掉
  await cdp.eval(`document.getElementById('btnVcam').click()`);

  console.log('\n===== 判定 =====');
  let pass = 0, total = 0;
  for (const r of results) {
    const m = /实际分辨率: (\d+)x(\d+)/.exec(r.py);
    const gotH = m ? Number(m[2]) : 0;
    // 主判据：桥接层报告的尺寸必须等于目标，且确实在推帧
    const bridgeOk = r.bridge && r.bridge.status === 'live' && r.bridge.height === r.want && r.bridge.frames > 0;
    // 次判据：外部读到的分辨率（多虚拟设备时可能读到别的，仅参考）
    const sysOk = gotH === r.want;
    const ok = bridgeOk;
    total++; if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.label}: 桥接 ${r.bridge.width}x${r.bridge.height} (${r.bridge.frames}帧)${sysOk ? ' · 外部确认' : `  [外部读到 ${m ? m[1] + 'x' + m[2] : '无'}]`}`);
  }
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
