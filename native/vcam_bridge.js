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
  for (const cand of PY_CANDIDATES) {
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
  }

  async start() {
    if (this.status === 'live' || this.status === 'starting') return this.state();
    this.status = 'starting';
    this.lastError = null;

    const py = findPython();
    if (!py) {
      this.status = 'error';
      this.lastError = '找不到可用的 Python（需要 pyvirtualcam + numpy）。请执行：py -3.11 -m pip install pyvirtualcam numpy';
      return this.state();
    }

    const hostPath = path.join(__dirname, 'vcam_host.py');
    this.child = spawn(py[0], [...py.slice(1), hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });

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
      this.stop();
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

  stop() {
    for (const ws of this.clients) { try { ws.close(); } catch (_) {} }
    this.clients.clear();
    if (this.wss) { try { this.wss.close(); } catch (_) {} this.wss = null; }
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; this.port = 0; }
    if (this.child) {
      try { this.child.stdin.end(); } catch (_) {}
      setTimeout(() => { try { this.child && this.child.kill(); } catch (_) {} }, 400);
      this.child = null;
    }
    this.ready = false;
    this.status = 'idle';
    this.frames = 0; this.bytes = 0; this.dropped = 0;
    return this.state();
  }

  state() {
    return {
      status: this.status,
      port: this.port,
      ready: this.ready,
      device: this.device,
      frames: this.frames,
      dropped: this.dropped,
      bytes: this.bytes,
      error: this.lastError,
    };
  }
}

module.exports = { VirtualCamBridge, findPython };
