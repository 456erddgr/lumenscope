'use strict';
// 某些开发环境 / 第三方工具会往环境里塞 ELECTRON_RUN_AS_NODE=1，
// 那会让 Electron 退化成纯 Node（表现为双击没任何反应、直接退出）。
// 这里在入口处清掉，保证安装版双击一定能起来。
if (process.env.ELECTRON_RUN_AS_NODE) delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { listen } = require('../server.js');
const { VirtualCamBridge } = require('../native/vcam_bridge.js');

let win = null;
let httpServer = null;
let vcam = null;

// 调试用：设 LUMEN_DEBUG_PORT 才会开放 DevTools 协议端口（平时不开，避免端口暴露）
if (process.env.LUMEN_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.LUMEN_DEBUG_PORT));
}

const MEDIA_DIR = () => app.getPath('downloads');

async function createWindow() {
  const root = path.join(__dirname, '..');
  const { server, port } = await listen(root, 0);
  httpServer = server;

  // 窗口尺寸跟屏幕可用区走，别让窗口超出屏幕（小屏本上 1360x860 会跑到屏幕外）
  const { screen } = require('electron');
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1360, Math.max(880, work.width - 120));
  const height = Math.min(860, Math.max(620, work.height - 120));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 880,
    minHeight: 620,
    center: true,
    backgroundColor: '#0a0a0c',
    show: false,
    frame: false,              // 真·无边框：标题栏与边框全部由页面自绘
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 记下真实几何，方便排查"窗口跑到屏幕外"这类问题
  try {
    const area = screen.getPrimaryDisplay().workArea;
    const d = screen.getPrimaryDisplay();
    require('fs').appendFileSync(
      path.join(root, 'electron-test.log'),
      `[win] work=${JSON.stringify(area)} scale=${d.scaleFactor} bounds=${JSON.stringify(win.getBounds())}\n`
    );
    // 双保险：显式居中并保证不出屏
    const x = Math.max(area.x, area.x + Math.round((area.width - width) / 2));
    const y = Math.max(area.y, area.y + Math.round((area.height - height) / 2));
    win.setBounds({ x, y, width: Math.min(width, area.width), height: Math.min(height, area.height) });
  } catch (_) {}

  // 无边框窗口的窗口控制：由页面的"交通灯"按钮调用
  ipcMain.handle('win:minimize', () => { win.minimize(); return true; });
  ipcMain.handle('win:toggle-max', () => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => { win.close(); return true; });
  ipcMain.handle('win:is-max', () => win.isMaximized());
  win.on('maximize', () => win.webContents.send('win:max-changed', true));
  win.on('unmaximize', () => win.webContents.send('win:max-changed', false));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  await win.loadURL(`http://127.0.0.1:${port}/src/index.html`);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  Menu.setApplicationMenu(null);
}

// 渲染进程把 ArrayBuffer 交过来，主进程落盘到 图片/LumenScope
ipcMain.handle('media:save', async (_e, { name, data }) => {
  try {
    const dir = MEDIA_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'capture').replace(/[\\/:*?"<>|]/g, '-');
    const file = path.join(dir, safe);
    fs.writeFileSync(file, Buffer.from(new Uint8Array(data)));
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('media:reveal', async () => {
  const dir = MEDIA_DIR();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true, path: dir };
});

// —— 虚拟摄像头（输出处理后的画面给系统）——
ipcMain.handle('vcam:start', async () => {
  if (!vcam) vcam = new VirtualCamBridge();
  const st = await vcam.start();
  return { ...st, wsUrl: st.port ? `ws://127.0.0.1:${st.port}/` : null };
});
ipcMain.handle('vcam:stop', () => {
  if (!vcam) return { status: 'idle' };
  return vcam.stop();
});
ipcMain.handle('vcam:state', () => (vcam ? vcam.state() : { status: 'idle' }));

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  platform: process.platform,
  mediaDir: MEDIA_DIR(),
}));

// —— 首次运行时补装虚拟摄像头依赖 ——
// 安装包本身只装主程序（Node/Electron/页面都是自带的），
// 虚拟摄像头要额外一个 Python 小依赖。这里在装好后的第一次启动里后台补上，
// 不阻塞界面、失败也不影响主功能。
function ensureRuntimeDeps() {
  const localAppData = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const stateDir = path.join(localAppData, 'LumenScope');
  const flag = path.join(stateDir, 'runtime-ready');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_) {}
  if (fs.existsSync(flag)) return;

  // 已经能导入就直接标记，免得白跑一遍
  try {
    const { findPython } = require('../native/vcam_bridge.js');
    if (findPython()) { fs.writeFileSync(flag, 'preinstalled\n'); return; }
  } catch (_) {}

  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'setup-runtime.ps1')
    : path.join(__dirname, '..', 'scripts', 'setup-runtime.ps1');
  if (!fs.existsSync(script)) return;

  try {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    // 脚本自己会写 python.txt；这里只记一笔，下次启动不再重复触发
    fs.writeFileSync(flag, new Date().toISOString() + '\n');
  } catch (e) {
    try { fs.appendFileSync(path.join(stateDir, 'setup.log'), 'spawn failed: ' + e.message + '\n'); } catch (_) {}
  }
}

app.whenReady().then(() => {
  ensureRuntimeDeps();
  return createWindow();
});
app.on('before-quit', () => { if (vcam) { try { vcam.stop(); } catch (_) {} } });
app.on('window-all-closed', () => {
  if (vcam) { try { vcam.stop(); } catch (_) {} }
  if (httpServer) httpServer.close();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
