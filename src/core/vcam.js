'use strict';
// 浏览器侧虚拟摄像头推流器：按输出帧率从管线取"最终画面"，编码成 BNF 帧推给本地桥。
// 关键点：推送的是 finalTex（超分 + 锐化 + 降噪 + 防抖 + 防卷帘之后的画面），不是原始摄像头流。
(function (g) {
  // 注意字节序：按小端写入内存后要得到 'L','S','C','1'（4c 53 43 31），
  // 所以这个整数的低位必须是 0x4c。写成 0x3143534c 才是对的。
  const MAGIC = 0x3143534c;

  class Streamer {
    constructor() {
      this.ws = null;
      this.on = false;
      this.frames = 0;
      this.dropped = 0;
      this.error = null;
      this.outW = 0;
      this.outH = 0;
      this.busy = false;
      this._head = new Uint8Array(16);
      this._headView = new DataView(this._head.buffer);
    }

    connect(wsUrl) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (ok, err) => { if (!settled) { settled = true; resolve({ ok, error: err }); } };
        try {
          this.ws = new WebSocket(wsUrl);
          this.ws.binaryType = 'arraybuffer';
          this.ws.onopen = () => { this.on = true; done(true); };
          this.ws.onerror = () => { this.error = 'WebSocket 连接失败'; done(false, this.error); };
          this.ws.onclose = () => { this.on = false; };
          setTimeout(() => { if (!this.on) done(false, 'WebSocket 连接超时'); }, 5000);
        } catch (e) {
          this.error = String(e && e.message || e);
          done(false, this.error);
        }
      });
    }

    // 由渲染循环每帧调用（内部按目标帧率节流）
    // 注意：readStream 会做一次 gl.readPixels（1080p 约 8 MB，2K 约 14 MB），
    // 是同步阻塞操作。这里用"上一帧读到的数据发、本帧先不读"的双缓冲做法，
    // 把读和发错开，避免每帧都卡主线程。
    push(pipeline, force) {
      if (!this.on || !this.ws || this.ws.readyState !== 1) return;
      if (this.busy) { this.dropped++; return; }
      const fps = pipeline.settings.targetFps || 30;
      const now = performance.now();
      const minGap = 1000 / fps - 4;
      if (!force && this._last && now - this._last < minGap) return;

      // 先把上一次已经读好的帧发出去（非阻塞）
      if (this._pending) {
        const pending = this._pending;
        this._pending = null;
        try {
          this.ws.send(pending.payload);
          this.frames++;
          this._last = now;
          this.outW = pending.w; this.outH = pending.h;
        } catch (e) {
          this.error = String(e && e.message || e);
          this.dropped++;
        }
      }

      // 再读当前帧，留到下一次发送（本帧主线程只承担一次 readPixels）
      const w = pipeline.outW, h = pipeline.outH;
      const frame = pipeline.readStream(w, h);
      if (!frame) return;

      // 每帧独立分配：ws.send 是异步的，复用缓冲区会被下一帧覆盖导致流错位
      const payload = new Uint8Array(16 + frame.buf.length);
      const head = new DataView(payload.buffer, 0, 16);
      head.setUint32(0, MAGIC, true);
      head.setUint32(4, w, true);
      head.setUint32(8, h, true);
      head.setUint16(12, fps, true);
      head.setUint16(14, 0, true);   // fmt = RGBA8（WebGL readPixels 直出，宿主去 alpha）
      payload.set(frame.buf, 16);
      this._pending = { payload, w, h };
    }

    disconnect() {
      this.on = false;
      this._pending = null;
      this._last = 0;
      this.busy = false;
      if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    }
  }

  g.LumenStreamer = { Streamer };
})(window);
