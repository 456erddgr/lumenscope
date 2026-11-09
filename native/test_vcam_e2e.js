'use strict';
// 端到端验证：桥接启动 → 浏览器推送处理后的画面 → 用第二个进程读虚拟摄像头确认画面非黑
const { VirtualCamBridge } = require('./vcam_bridge.js');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

(async () => {
  const bridge = new VirtualCamBridge();
  const st = await bridge.start();
  console.log('bridge:', JSON.stringify(st));
  if (!st.ready) { console.error('桥接未就绪，退出'); process.exit(1); }
  const wsUrl = `ws://127.0.0.1:${st.port}/`;

  const dir = path.join(os.tmpdir(), 'e2e-' + Date.now());
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=9441', `--user-data-dir=${dir}`,
    '--window-size=1440,900', '--no-first-run',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-video-capture=E:/我的项目/LumenScope/docs/test-720p-loop.y4m',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank',
  ], { stdio: 'ignore' });

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { await getJSON('http://127.0.0.1:9441/json/version'); ok = true; } catch (_) { await sleep(250); } }
  const target = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: 9441, path: '/json/new?about:blank', method: 'PUT' }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }); req.on('error', rej); req.end();
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('to ' + m)); } }, 25000); }) };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:4183/src/index.html' });
  await sleep(3200);

  // 直接把桥接地址注入，绕过 Electron IPC（浏览器里没有 window.lumen）
  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      const p = window.__lumenDebug.pipeline;
      const s = new window.LumenStreamer.Streamer();
      const conn = await s.connect(${JSON.stringify(wsUrl)});
      if (!conn.ok) return { ok:false, err: conn.error };
      window.__e2eStreamer = s;
      // 让渲染循环持续推送
      window.__e2ePush = setInterval(() => { if (window.__lumenDebug.pipeline) s.push(window.__lumenDebug.pipeline); }, 16);
      return { ok:true, out:[p.outW,p.outH] };
    })()`, awaitPromise: true, returnByValue: true,
  });
  console.log('streamer:', JSON.stringify(r.result.value));
  await sleep(4000);

  // 用 pyvirtualcam 之外的方式读摄像头：再用一个 Chrome 打开虚拟摄像头并截图
  // 先记录桥接接收情况
  const mid = bridge.state();
  console.log('bridge mid:', JSON.stringify(mid));

  // Chrome 已占用虚拟摄像头？不会——Chrome 是用 OBS 之外的假设备。
  // 这里单独读虚拟摄像头，确认它在输出我们的画面。
  const probe = spawn('py', ['-3.11', path.join(__dirname, 'read_vcam.py')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  probe.stdout.on('data', d => out += d.toString());
  probe.stderr.on('data', d => err += d.toString());
  await sleep(Number(process.env.READ_MS || 7000));
  probe.kill();

  const bst = bridge.state();
  console.log('bridge after:', JSON.stringify(bst));
  console.log('reader stdout:', out.trim());
  if (err.trim()) console.log('reader stderr:', err.trim().slice(0, 400));

  chrome.kill();
  bridge.stop();
  process.exit(0);
})().catch(e => { console.error('E2E FAIL', e.message); process.exit(1); });
