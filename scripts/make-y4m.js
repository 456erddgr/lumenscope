'use strict';
// 生成 720p 测试片源（y4m / I420）：模拟显微镜视野 —— 细胞纹理 + 缓慢漂移 + 抖动 + 传感器噪声
const fs = require('fs');
const W = 1280, H = 720, N = Number(process.argv[3] || 60), FPS = 30;
const out = process.argv[2] || 'test-720p.y4m';
// 循环模式：所有运动分量为整数周期，最后一帧可无缝接回第一帧
const LOOP = process.env.LOOP === '1' || process.argv.includes('--loop');
const LOOPS = 3;                    // 片源内含 3 个完整抖动周期，循环播放时不可察觉

const Y = Buffer.alloc(W * H), U = Buffer.alloc((W / 2) * (H / 2)), V = Buffer.alloc((W / 2) * (H / 2));
const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`, 'ascii')];

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// 固定"标本"：若干圆（细胞）
const cells = [];
for (let i = 0; i < 26; i++) {
  cells.push({ x: rnd() * W, y: rnd() * H, r: 12 + rnd() * 46, shade: 90 + rnd() * 90 });
}

for (let f = 0; f < N; f++) {
  const t = f / FPS;
  // 抖动：高频手持/单反镜的微小移动 + 低频漂移
  let dx, dy, phase;
  if (LOOP) {
    const u = (f / N) * LOOPS;      // 0..LOOPS，循环回绕
    dx = Math.sin(u * 2 * Math.PI) * 6 + Math.sin(u * 2 * Math.PI * 2) * 2.4;
    dy = Math.cos(u * 2 * Math.PI) * 5 + Math.cos(u * 2 * Math.PI * 2) * 2.0;
    phase = u * 2 * Math.PI;
  } else {
    dx = Math.sin(t * 2 * Math.PI * 3.1) * 3.4 + Math.sin(t * 2 * Math.PI * 0.37) * 7;
    dy = Math.cos(t * 2 * Math.PI * 2.4) * 2.6 + Math.sin(t * 2 * Math.PI * 0.21) * 5;
    phase = t * 0.7;
  }

  for (let y = 0; y < H; y++) {
    const sy = y + dy;
    for (let x = 0; x < W; x++) {
      const sx = x + dx;
      // 背景：柔和的照明梯度
      let v = 34 + 26 * Math.sin((sx * 0.004) + phase) + 18 * Math.cos(sy * 0.006);
      // 细胞
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const ddx = sx - c.x, ddy = sy - c.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < c.r * c.r) {
          const d = Math.sqrt(d2) / c.r;
          v += (c.shade - v) * (1 - d * d) * 0.9;
          // 细胞核
          if (d < 0.28) v -= 38;
        }
      }
      // 传感器噪声（时域，降噪的目标）
      v += (rnd() - 0.5) * 13;
      const idx = y * W + x;
      Y[idx] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
  }
  // 色度：轻微偏色，供白平衡演示
  for (let i = 0; i < U.length; i++) {
    const ux = i % (W / 2), uy = (i / (W / 2)) | 0;
    U[i] = 118 + Math.sin(ux * 0.004 + uy * 0.003) * 5 + (rnd() - 0.5) * 3;
    V[i] = 135 + Math.cos(ux * 0.003 - uy * 0.004) * 5 + (rnd() - 0.5) * 3;
  }
  chunks.push(Buffer.from('FRAME\n', 'ascii'), Buffer.from(Y), Buffer.from(U), Buffer.from(V));
}

fs.writeFileSync(out, Buffer.concat(chunks));
console.log(out, (fs.statSync(out).size / 1048576).toFixed(1) + ' MB', `${W}x${H} ${N} frames`);
