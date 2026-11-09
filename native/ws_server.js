'use strict';
// 极简 WebSocket 服务端（只支持二进制帧 + 关闭），免依赖。
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function attach(server, onClient) {
  const clients = new Set();

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const ws = {
      socket,
      closed: false,
      onBinary: null,
      onClose: null,
      close() {
        if (this.closed) return;
        this.closed = true;
        try { socket.end(Buffer.from([0x88, 0x00])); } catch (_) {}
        try { socket.destroy(); } catch (_) {}
      },
    };
    clients.add(ws);

    let buf = Buffer.alloc(0);
    // 分片重组：浏览器会把大帧（>16KB）拆成 opcode=2 首片 + 若干 opcode=0 续片
    let frag = [];
    let fragOpcode = 0;

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const hi = buf.readUInt32BE(2), lo = buf.readUInt32BE(6);
          len = hi * 0x100000000 + lo; offset = 10;
        }
        let maskKey = null;
        if (masked) {
          if (buf.length < offset + 4) return;
          maskKey = buf.slice(offset, offset + 4); offset += 4;
        }
        if (buf.length < offset + len) return;
        let payload = buf.slice(offset, offset + len);
        buf = buf.slice(offset + len);

        if (masked && maskKey) {
          const out = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
          payload = out;
        }

        if (opcode === 0x8) {  // CLOSE
          if (process.env.WS_DEBUG) console.error('[ws] client CLOSE');
          ws.close(); return;
        }
        if (opcode === 0x9) continue;   // PING

        // 分片处理
        if (opcode === 0x0) {
          // 续片：并入当前分片缓冲
          frag.push(payload);
          if (!fin) continue;
          const whole = Buffer.concat(frag);
          frag = [];
          if (fragOpcode === 0x2 && ws.onBinary) {
            ws.__n = (ws.__n || 0) + 1;
            try { ws.onBinary(whole); } catch (e) { ws.close(); return; }
          }
          fragOpcode = 0;
          continue;
        }

        // 新的数据帧
        if (!fin) {
          fragOpcode = opcode;
          frag = [payload];
          continue;
        }
        if (opcode === 0x2 && ws.onBinary) {
          if (process.env.WS_DEBUG) console.error('[ws] whole len', payload.length, 'magic', payload.slice(0,4).toString('hex'));
          try { ws.onBinary(payload); } catch (e) { ws.close(); return; }
        }
      }
    });

    const finish = (why) => {
      if (process.env.WS_DEBUG) console.error('[ws] finish', why, 'closed=', ws.closed);
      if (ws.closed) { clients.delete(ws); return; }
      ws.closed = true;
      clients.delete(ws);
      if (ws.onClose) try { ws.onClose(); } catch (_) {}
    };
    socket.on('close', () => finish('close'));
    socket.on('error', (e) => finish('error:' + (e && e.code)));
    socket.on('end', () => finish('end'));

    if (onClient) onClient(ws);
  });

  return {
    clients,
    close() { for (const c of clients) c.close(); clients.clear(); },
  };
}

module.exports = { attach };
