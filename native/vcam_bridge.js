'use strict';
// 虚拟摄像头桥：在本地开一个 WebSocket 服务，浏览器把"处理后的画面"推过来，
// 这里转成二进制流喂给 pyvirtualcam（子进程），由 OBS Virtual Camera 驱动对系统输出。
// 这样输出的就是超分 + 降噪 + 防抖 + 防卷帘之后的画面。
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PY_CANDIDATES = [
  process.env.LUMEN_PYTHON,
  'py -3.11',
  'py',
  'python',
].filter(Boolean);

function findPython() {
  const { execFileSync } = require('child_process');
  const os = require('os');

  // 安装程序会把可用的解释器写在这里，优先用（省去每次探测的几百毫秒，
  // 也让"装的时候用哪个 Python"和"跑的时候用哪个"保持一致）
  const hints = [];
  try {
    const p = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LumenScope', 'python.txt');
    if (fs.existsSync(p)) {
      const line = fs.readFileSync(p, 'utf8').trim();
      if (line) hints.push(line);
    }
  } catch (_) {}
  // 便携版（安装程序自动下载的那个）
  hints.push(path.join(process.env.LOCALAPPDATA || '', 'LumenScope', 'python', 'python.exe'));

  for (const cand of [...hints, ...PY_CANDIDATES]) {
    if (!cand) continue;
    const parts = cand.split(/\s+/);
    try {
      execFileSync(parts[0], [...parts.slice(1), '-c', 'import pyvirtualcam, numpy'], { stdio: 'ignore', timeout: 8000 });
      return parts;
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

class VirtualCamBridge {
  constructor() {
    this.server = null;
    this.wss = null;
    this.child = null;
    this.port = 0;
    this.ready = false;
    this.device = null;
    this.frames = 0;
    this.bytes = 0;
    this.dropped = 0;
    this.lastError = null;
    this.clients = new Set();
    this.status = 'idle';        // idle | starting | live | error
    this.curW = 0; this.curH = 0; this.curFps = 0;   // 当前驱动实际打开的分辨率/帧率
  }

  // options: { width, height, fps } —— 必须由调用方按当前输出档位传进来，
  // 否则驱动会用宿主里写死的默认值（1280x720），用户在界面切 1080p/2K 也不生效。
  async start(options = {}) {
    const wantW = Math.max(320, Math.min(3840, Math.round(options.width || 1920)));
    const wantH = Math.max(240, Math.min(2160, Math.round(options.height || 1080)));
    const wantFps = Math.max(1, Math.min(120, Math.round(options.fps || 30)));

    // 尺寸/帧率变了就必须重启宿主进程：OBS 虚拟摄像头的格式在打开时就定死了
    if (this.status === 'live' || this.status === 'starting') {
      const same = this.curW === wantW && this.curH === wantH && this.curFps === wantFps;
      if (same) return this.state();
      // 换尺寸：必须等旧宿主彻底退出、驱动释放，否则新宿主打不开（会立刻退出）
      await this.stopAsync();
    }
    this.status = 'starting';
    this.lastError = null;
    this.curW = wantW; this.curH = wantH; this.curFps = wantFps;

    const py = findPython();
    if (!py) {
      this.status = 'error';
      this.lastError = '找不到可用的 Python（需要 pyvirtualcam + numpy）。请执行：py -3.11 -m pip install pyvirtualcam numpy';
      return this.state();
    }

    const hostPath = path.join(__dirname, 'vcam_host.py')
      // 打包进 asar 后 Python 读不了虚拟路径，asarUnpack 会把真实文件放在 app.asar.unpacked 下
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    if (!fs.existsSync(hostPath)) {
      this.status = 'error';
      this.lastError = '缺少 vcam_host.py：' + hostPath;
      return this.state();
    }
    // 把目标尺寸交给宿主：宿主启动时就按这个分辨率打开驱动，
    // 之后如果来的帧尺寸不同，宿主会自己重开（代价是一次黑屏，所以尽量一开始就给对）。
    const env = Object.assign({}, process.env, {
      LUMEN_VCAM_W: String(wantW),
      LUMEN_VCAM_H: String(wantH),
      LUMEN_VCAM_FPS: String(wantFps),
    });
    this.child = spawn(py[0], [...py.slice(1), hostPath], { stdio: ['pipe', 'pipe', 'pipe'], env });

    // 子进程退出/管道破裂时写入会抛 EOF，必须吞掉，否则整个进程崩溃
    this.child.stdin.on('error', (e) => {
      this.lastError = 'stdin: ' + (e && e.code || e);
      this.ready = false;
    });
    this.child.on('error', (e) => { this.lastError = 'spawn: ' + (e && e.message || e); });

    let readyResolve;
    const readyPromise = new Promise(r => { readyResolve = r; });
    let stdoutBuf = '';

    this.child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.startsWith('READY')) {
          this.ready = true;
          this.status = 'live';
          this.device = line.slice(5).trim() || 'OBS Virtual Camera';
          readyResolve(true);
        }
      }
    });
    this.child.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (process.env.WS_DEBUG) console.error('[host]', msg);
      if (msg.startsWith('ERROR')) { this.lastError = msg.slice(5).trim(); this.status = 'error'; readyResolve(false); }
    });
    this.child.on('exit', (code) => {
      this.ready = false;
      this.child = null;
      if (this.status !== 'error') this.status = 'idle';
    });

    // 开 WebSocket 服务接收帧
    await this._startServer();
    const ok = await Promise.race([readyPromise, new Promise(r => setTimeout(() => r(this.ready), 12000))]);
    if (!this.ready) {
      this.status = 'error';
      if (!this.lastError) this.lastError = '虚拟摄像头启动超时（OBS Virtual Camera 驱动未就绪）';
      await this.stopAsync();
    }
    return this.state();
  }

  _startServer() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('WebSocket only');
      });
      const wsServer = require('./ws_server.js');
      this.wss = wsServer.attach(this.server, (ws) => {
        this.clients.add(ws);
        ws.onClose = () => this.clients.delete(ws);
        ws.onBinary = (buf) => this._onFrame(buf);
      });
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  _onFrame(buf) {
    if (!this.child || !this.child.stdin.writable || this.child.stdin.destroyed) return;
    // 背压：只有当管道里已经积压了"好几帧"才丢，阈值必须大于单帧大小，
    // 否则每帧写入后都会超阈值，除第一帧外全部被丢，宿主读不满一帧就 EOF。
    const frameBytes = buf.length;
    const backlogLimit = Math.max(frameBytes * 2, 8 * 1024 * 1024);
    if (this.child.stdin.writableLength > backlogLimit) { this.dropped++; return; }
    this.frames++;
    this.bytes += frameBytes;
    try {
      // 显式拷贝：Node 对大于 highWaterMark 的 Buffer 是引用传递，
      // 而 WebSocket 分片重组的 Buffer 会被复用，导致管道里出现错乱的字节。
      const copy = Buffer.from(buf);
      this.child.stdin.write(copy, (err) => { if (err) this.lastError = 'write: ' + err.code; });
    } catch (e) {
      this.lastError = 'write threw: ' + (e && e.message || e);
    }
  }

  // 停止并**等到子进程真正退出**再返回。
  // 关键：OBS 虚拟摄像头是独占的，旧进程还占着驱动时新进程一定打不开
  // （表现就是切 2K 后宿主立刻退出、frames 一直是 0）。
  async stopAsync() {
    for (const ws of this.clients) { try { ws.close(); } catch (_) {} }
    this.clients.clear();
    if (this.wss) { try { this.wss.close(); } catch (_) {} this.wss = null; }
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; this.port = 0; }

    const child = this.child;
    this.child = null;
    this.ready = false;
    this.status = 'idle';
    this.frames = 0; this.bytes = 0; this.dropped = 0;

    if (!child) return this.state();

    const exited = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      child.once('close', finish);
      setTimeout(finish, 3000);
    });

    // 1) 先礼貌地关 stdin，让 Python 自己 close 摄像头并退出
    try { child.stdin.end(); } catch (_) {}
    const graceful = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 900))]);
    if (graceful === 'timeout') {
      // 2) 没退就强杀。Windows 上 Electron 的 kill() 有时只发 CTRL_CLOSE，
      //    这里补一发 taskkill /F 兜底，确保不留下占着驱动的孤儿进程。
      try { child.kill('SIGKILL'); } catch (_) {}
      try {
        const { execFileSync } = require('child_process');
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 4000 });
      } catch (_) {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    }
    // 3) 再给驱动一点时间彻底释放（实测 250ms 足够，取 400ms 保险）
    await new Promise((r) => setTimeout(r, 400));
    return this.state();
  }

  stop() {
    // 同步版：只用于程序退出等不关心后续的场景
    void this.stopAsync();
    return this.state();
  }

  state() {
    return {
      status: this.status,
      port: this.port,
      ready: this.ready,
      device: this.device,
      width: this.curW || 0,
      height: this.curH || 0,
      fps: this.curFps || 0,
      frames: this.frames,
      dropped: this.dropped,
      bytes: this.bytes,
      error: this.lastError,
    };
  }
}

module.exports = { VirtualCamBridge, findPython };
