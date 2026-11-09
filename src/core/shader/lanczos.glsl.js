'use strict';
// Lanczos-3 分离式 2D 上采样 + 抗振铃钳制（Anti-Ringing Clamp）
// 相比 FSR1 的 EASU：重建核更长（6 抽头/轴），高频保留更好，边缘更锐；
// 用 6x6 采样窗口自身的 min/max 做钳制，避免锐化带来的白边/黑边。
(function (g) {
  g.ShaderLanczos = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2  uSrcSize;    // 源分辨率
uniform vec2  uDstSize;    // 目标分辨率
uniform float uSharpen;    // 0 = 纯 Lanczos；>0 额外锐化（边缘自适应）
uniform float uAntiRing;   // 0..1，抗振铃强度

const float PI = 3.14159265359;

float sinc(float x) {
  if (abs(x) < 1e-6) return 1.0;
  float px = PI * x;
  return sin(px) / px;
}

float lanczos3(float x) {
  float ax = abs(x);
  if (ax >= 3.0) return 0.0;
  return sinc(x) * sinc(x / 3.0);
}

void main() {
  // 目标像素中心 → 源坐标（像素中心对齐）
  vec2 scale = uSrcSize / uDstSize;
  vec2 srcPos = (gl_FragCoord.xy - 0.5) * scale + 0.5;
  vec2 base = floor(srcPos);
  vec2 frac = srcPos - base;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  vec3 cmin = vec3(1e9);
  vec3 cmax = vec3(-1e9);

  // 6x6 抽头：i = -2..3 相对 base，覆盖 Lanczos-3 的支撑区间
  for (int j = -2; j <= 3; j++) {
    float wy = lanczos3(float(j) - frac.y);
    for (int i = -2; i <= 3; i++) {
      float wx = lanczos3(float(i) - frac.x);
      float w = wx * wy;
      vec2 sp = base + vec2(float(i), float(j));
      vec2 uv = (sp + 0.5) / uSrcSize;
      vec3 c = texture(uSrc, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
      acc += c * w;
      wsum += w;
      cmin = min(cmin, c);
      cmax = max(cmax, c);
    }
  }

  vec3 outc = acc / max(wsum, 1e-5);

  // 抗振铃：把结果钳在采样窗口的局部值域内
  vec3 clamped = clamp(outc, cmin, cmax);
  outc = mix(outc, clamped, clamp(uAntiRing, 0.0, 1.0));

  // 细节增强：用"重建结果 - 双线性"的差作为高频，按局部对比度加权
  if (uSharpen > 0.001) {
    vec2 uv0 = (gl_FragCoord.xy - 0.5) / uDstSize;
    vec3 lin = texture(uSrc, uv0).rgb;
    float detail = length(outc - lin);
    float local = length(cmax - cmin);
    float w = smoothstep(0.02, 0.22, local) * (1.0 - smoothstep(0.35, 0.9, detail));
    outc += (outc - lin) * (uSharpen * w);
    outc = clamp(outc, cmin, cmax);
  }

  fragColor = vec4(outc, 1.0);
}`;
})(window);
