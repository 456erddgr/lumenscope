'use strict';
// LumenScope 本地服务：静态资源 + 虚拟摄像头桥 + 图片落盘。
// 浏览器（Chrome --app）与 Electron 共用同一个 127.0.0.1 入口；
// 127.0.0.1 属于安全上下文，getUserMedia 可用。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 构建指纹：拿几个关键文件的大小/时间算哈希。
// 用途：启动器先问端口上的服务"你是哪次构建"，旧进程占着端口时能识别出来并换端口，
// 避免用户看到"改了代码却没生效"的假象。
const BUILD_FILES = ['server.js', 'src/app.js', 'src/index.html', 'src/styles/app.css'];
const BUILD = (() => {
  let h = 0;
  for (const f of BUILD_FILES) {
    try {
      const st = fs.statSync(path.join(__dirname, f));
      h = (h * 31 + st.size + st.mtimeMs) % 2147483647;
    } catch (_) {}
  }
  return 'b' + Math.abs(h).toString(36);
})();
const STARTED_AT = new Date().toISOString();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// 图片目录：Windows 用「图片\LumenScope」，其它平台退回 HOME/Pictures
function mediaDir() {
  // 照片/录像直接落到系统「下载」文件夹，拍完就能在下载列表里看到
  const home = os.homedir();
  const cands = [
    process.env.LUMEN_MEDIA_DIR,
    path.join(home, 'Downloads'),
    path.join(home, '下载'),
  ].filter(Boolean);
  let base = cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || cands[1];
  fs.mkdirSync(base, { recursive: true });
  return base;
}

let bridge = null;
function getBridge() {
  if (!bridge) bridge = new (require('./native/vcam_bridge.js').VirtualCamBridge)();
  return bridge;
}

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/capabilities') {
    return sendJSON(res, 200, {
      app: 'LumenScope',
      build: BUILD,         // 用来识别"端口上跑的是不是当前这份代码"
      startedAt: STARTED_AT,
      vcam: true,           // 由本进程托管桥接，浏览器模式同样可用
      save: true,
      mediaDir: mediaDir(),
      platform: process.platform,
    });
  }

  if (route === '/api/vcam/start' && req.method === 'POST') {
    try {
      // 尺寸由前端按当前输出档位传（query 或 body 都支持），缺省 1920x1080
      let opts = {};
      try {
        const raw = await readBody(req, 8 * 1024);
        if (raw && raw.length) opts = JSON.parse(raw.toString('utf8')) || {};
      } catch (_) { /* 没有 body 就用 query */ }
      const q = url.searchParams;
      const pick = (k) => Number(opts[k] || q.get(k) || 0) || undefined;
      const st = await getBridge().start({
        width: pick('width') || pick('w'),
        height: pick('height') || pick('h'),
        fps: pick('fps'),
      });
      return sendJSON(res, 200, { ...st, ws: st.ready ? `ws://127.0.0.1:${st.port}` : null });
    } catch (e) {
      return sendJSON(res, 500, { status: 'error', error: String(e && e.message || e) });
    }
  }

  if (route === '/api/vcam/stop' && req.method === 'POST') {
    return sendJSON(res, 200, getBridge().stop());
  }

  if (route === '/api/vcam/state') {
    const st = bridge ? bridge.state() : { status: 'idle', ready: false, port: 0, frames: 0, dropped: 0, bytes: 0, error: null };
    return sendJSON(res, 200, { ...st, ws: st.ready ? `ws://127.0.0.1:${st.port}` : null });
  }

  // 保存媒体：body 是 { name, dataUrl }，dataUrl 形如 data:image/png;base64,...
  if (route === '/api/save' && req.method === 'POST') {
    try {
      const raw = await readBody(req, 256 * 1024 * 1024);
      const { name, dataUrl } = JSON.parse(raw.toString('utf8'));
      const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/i.exec(dataUrl || '');
      if (!m) return sendJSON(res, 400, { ok: false, error: 'dataUrl 格式不对' });
      const buf = Buffer.from(m[2], 'base64');
      const ext = m[1].includes('mp4') ? '.mp4' : m[1].includes('webm') ? '.webm' : m[1].includes('jpeg') ? '.jpg' : '.png';
      const safe = String(name || 'LumenScope').replace(/[\\/:*?"<>|]/g, '_').slice(0, 110);
      const file = path.join(mediaDir(), /\.[a-z0-9]{2,4}$/i.test(safe) ? safe : safe + ext);
      fs.writeFileSync(file, buf);
      return sendJSON(res, 200, { ok: true, path: file });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  if (route === '/api/reveal' && req.method === 'POST') {
    try {
      const dir = mediaDir();
      const { spawn } = require('child_process');
      if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      return sendJSON(res, 200, { ok: true, path: dir });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  return sendJSON(res, 404, { error: 'unknown api', route });
}

function createServer(root) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => {
        try { sendJSON(res, 500, { error: String(e && e.message || e) }); } catch (_) {}
      });
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/src/index.html';
    const full = path.join(root, rel);
    if (!full.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  });
  return srv;
}

function listen(root, port = 0) {
  return new Promise((resolve, reject) => {
    const srv = createServer(root);
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
  });
}

module.exports = { createServer, listen, mediaDir, buildId: () => BUILD };

if (require.main === module) {
  const root = __dirname;
  const port = Number(process.env.PORT || 4173);
  listen(root, port).then(({ port }) => {
    console.log(`LumenScope → http://127.0.0.1:${port}/`);
  });
  process.on('SIGINT', () => { if (bridge) bridge.stop(); process.exit(0); });
  process.on('exit', () => { if (bridge) bridge.stop(); });
}
