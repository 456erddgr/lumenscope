'use strict';
// LumenScope 一键启动器
//   · 有 Electron 时：直接用 Electron（原生无边框窗口，自带本地服务）
//   · 没有 Electron 时：这里起本地服务，再用 Chrome/Edge 的 --app 打开无地址栏的应用窗口
//   · 窗口关闭 → 关闭虚拟摄像头与本地服务，进程退出
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const ROOT = __dirname;
const PORT_PREF = Number(process.env.PORT || 4173);
const WINDOW = process.env.LUMEN_SIZE || '1440x900';

function log(...a) { if (process.env.LUMEN_DEBUG) console.log('[launch]', ...a); }

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/capabilities', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function findElectron() {
  try {
    const p = require.resolve('electron');
    const rel = fs.readFileSync(path.join(path.dirname(p), 'path.txt'), 'utf8').trim();
    const exe = path.join(path.dirname(p), 'dist', rel);
    return fs.existsSync(exe) ? exe : null;
  } catch (_) { return null; }
}

function findBrowser() {
  const cands = [
    process.env.LUMEN_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

async function main() {
  // 1) 桌面版优先
  const electronBin = findElectron();
  if (electronBin && process.env.LUMEN_SHELL !== 'browser') {
    log('electron', electronBin);
    // 某些环境会设置 ELECTRON_RUN_AS_NODE=1，那会让 Electron 退化成纯 Node，必须剔除
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [path.join(ROOT, 'electron', 'main.js')], { stdio: 'ignore', env });
    child.on('exit', (code) => process.exit(code || 0));
    child.on('error', (e) => { console.error('Electron 启动失败：', e.message); process.exit(1); });
    return;
  }

  // 2) 浏览器模式：先确保本机服务在跑
  //    注意：端口上可能躺着一个"旧代码"的服务进程（改了代码却没重启的常见坑）。
  //    只有 capabilities.build 与当前代码算出的 build 一致才复用它，否则换端口另起一个。
  const { listen, buildId } = require('./server.js');
  let port = PORT_PREF;
  let srv = null;
  const probe = await ping(port);
  const stale = probe && probe.build !== buildId();
  if (stale) log('port', port, '上是旧构建', probe.build, '≠', buildId(), '→ 另起端口');
  if (!probe || stale) {
    let lastErr = null;
    for (const p of stale ? [0] : [PORT_PREF, 0]) {
      try { const r = await listen(ROOT, p); srv = r.server; port = r.port; lastErr = null; break; }
      catch (e) { lastErr = e; }
    }
    if (!srv) { console.error('无法启动本地服务：', lastErr && lastErr.message); process.exit(1); }
  }

  const url = `http://127.0.0.1:${port}/`;
  log('server', url);

  const browser = findBrowser();
  if (!browser) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const [w, h] = WINDOW.split('x').map(Number);
  const profileDir = path.join(os.homedir(), 'AppData', 'Local', 'LumenScope', 'window');
  fs.mkdirSync(profileDir, { recursive: true });

  const child = spawn(browser, [
    `--app=${url}`,
    `--window-size=${w || 1440},${h || 900}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
  ], { stdio: 'ignore' });
  log('browser', browser, child.pid);

  const shutdown = (code = 0) => {
    if (srv) { try { srv.close(); } catch (_) {} }
    setTimeout(() => process.exit(code), 120);
  };

  child.on('exit', () => shutdown(0));
  child.on('error', (e) => { console.error('打开窗口失败：', e.message); shutdown(1); });
  process.on('SIGINT', () => { try { child.kill(); } catch (_) {} shutdown(0); });
  if (srv) srv.on('close', () => setTimeout(() => process.exit(0), 100));
}

main().catch((e) => { console.error(e); process.exit(1); });
