'use strict';
// AMD FidelityFX Super Resolution 1 (EASU + RCAS) 的 GLSL ES 3.0 移植
// 算法来源：GPUOpen-Effects/FidelityFX-FSR, ffx_fsr1.h (MIT License, © 2021 Advanced Micro Devices, Inc.)
// 本文件为独立重写，保留原算法的权核、方向自适应与去振铃钳制逻辑。
(function (g) {
  g.ShaderFSR = {
    // —— 电子防抖 + 裁剪缩放 采样阶段：输出与输入同分辨率 ——
    warp: `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform mat2  uRot;       // 反向旋转
uniform float uZoom;      // 裁剪放大（≥1，用于留出补偿余量）
uniform vec2  uShift;     // 补偿平移（归一化，y 向上）
uniform vec2  uSize;
uniform float uSkew;      // 卷帘：每行位移（归一化，随 y-0.5 线性变化）
uniform float uTime;      // 帧序号，用于打散静态摩尔纹的亚像素抖动
uniform float uDither;    // 子像素抖动幅度（像素）
uniform float uUserZoom;  // 用户数字变焦（≥1）
uniform vec2  uUserPan;   // 用户平移（归一化）
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uSize;
  // 卷帘快门：同一帧内不同行被不同时刻采样，行位移 = 速度 × (y - 0.5) × skew
  vec2 rolled = uv + vec2(uSkew, 0.0) * (uv.y - 0.5);
  vec2 p = (rolled - 0.5) / uZoom;
  p = uRot * p + 0.5 - uShift;
  // 用户取景：数字变焦 + 平移
  p = (p - 0.5) / uUserZoom + 0.5 + uUserPan;
  // 亚像素抖动：把镜头/传感器固定图案产生的摩尔纹转换为时域噪声，由降噪吸收
  if (uDither > 0.0) {
    p += vec2(
      fract(sin(dot(frag + uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5,
      fract(sin(dot(frag + uTime, vec2(39.3468, 11.135))) * 24634.6345) - 0.5
    ) * uDither / uSize;
  }
  fragColor = vec4(texture(uSrc, clamp(p, vec2(0.0005), vec2(0.9995))).rgb, 1.0);
}`,

    // —— EASU：边缘自适应空间上采样（1x–4x）——
    easu: `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uInSize;    // 输入纹理像素尺寸
uniform vec2 uOutSize;   // 输出尺寸

vec3 tap(vec2 t) { return texture(uSrc, (t + 0.5) / uInSize).rgb; }
float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void setDir(inout vec2 dir, inout float len, vec2 pp, float w,
            float lA, float lB, float lC, float lD, float lE) {
  if (w <= 0.0) return;
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1e-6);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1e-6);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

void tapAcc(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2,
            float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x);
  v *= len2;
  float d2 = dot(v, v);
  d2 = min(d2, clp);
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main() {
  vec2 ip = gl_FragCoord.xy;
  vec2 pp = (ip + 0.5) * (uInSize / uOutSize) - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;

  // 12 抽头核（相对 f 的整数偏移）
  //      b c
  //   e f g h
  //   i j k l
  //      n o
  vec3 b = tap(fp + vec2(0.0, -1.0));
  vec3 c = tap(fp + vec2(1.0, -1.0));
  vec3 e = tap(fp + vec2(-1.0, 0.0));
  vec3 f = tap(fp + vec2( 0.0,  0.0));
  vec3 g = tap(fp + vec2( 1.0,  0.0));
  vec3 h = tap(fp + vec2( 2.0,  0.0));
  vec3 i = tap(fp + vec2(-1.0,  1.0));
  vec3 j = tap(fp + vec2( 0.0,  1.0));
  vec3 k = tap(fp + vec2( 1.0,  1.0));
  vec3 l = tap(fp + vec2( 2.0,  1.0));
  vec3 n = tap(fp + vec2( 0.0,  2.0));
  vec3 o = tap(fp + vec2( 1.0,  2.0));

  float bL = luma(b), cL = luma(c), eL = luma(e), fL = luma(f), gL = luma(g);
  float hL = luma(h), iL = luma(i), jL = luma(j), kL = luma(k), lL = luma(l);
  float nL = luma(n), oL = luma(o);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  // 四个双线性象限，各自用 5 个亮度样本判定方向与长度
  setDir(dir, len, pp, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  setDir(dir, len, pp,        pp.x  * (1.0 - pp.y), cL, fL, gL, hL, kL);
  setDir(dir, len, pp, (1.0 - pp.x) *        pp.y , fL, iL, jL, kL, nL);
  setDir(dir, len, pp,        pp.x  *        pp.y , gL, jL, kL, lL, oL);

  float dirR = dot(dir, dir);
  if (dirR < 1.0 / 32768.0) { dir = vec2(1.0, 0.0); }
  else { dir *= inversesqrt(max(dirR, 1e-9)); }

  len = clamp(len * 0.5, 0.0, 1.0);
  len *= len;

  float stretch = dot(dir, dir) * (1.0 / max(max(abs(dir.x), abs(dir.y)), 1e-6));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 min4 = min(min(f, g), min(j, k));
  vec3 max4 = max(max(f, g), max(j, k));

  vec3 aC = vec3(0.0);
  float aW = 0.0;
  tapAcc(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);
  tapAcc(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);
  tapAcc(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);
  tapAcc(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);
  tapAcc(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);
  tapAcc(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);
  tapAcc(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);
  tapAcc(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);
  tapAcc(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);
  tapAcc(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);
  tapAcc(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);
  tapAcc(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);

  vec3 pix = clamp(aC / max(aW, 1e-6), min4, max4);   // 归一化 + 去振铃
  fragColor = vec4(pix, 1.0);
}`,

    // —— RCAS：稳健对比度自适应锐化（含噪声检测）——
    rcas: `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uSize;
uniform float uSharpness;   // 0 = 最锐, 2 = 最柔（stops）
uniform int uDenoise;

const float RCAS_LIMIT = 0.25 - 1.0 / 16.0;

vec3 fetch(vec2 t) { return texture(uSrc, t / uSize).rgb; }
float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void main() {
  vec2 ip = gl_FragCoord.xy;
  vec3 b = fetch(ip + vec2( 0.0, -1.0));
  vec3 d = fetch(ip + vec2(-1.0,  0.0));
  vec3 e = fetch(ip);
  vec3 f = fetch(ip + vec2( 1.0,  0.0));
  vec3 h = fetch(ip + vec2( 0.0,  1.0));

  float bL = luma(b), dL = luma(d), eL = luma(e), fL = luma(f), hL = luma(h);

  float nz = 0.25 * bL + 0.25 * dL + 0.25 * fL + 0.25 * hL - eL;
  float range = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  nz = clamp(abs(nz) / max(range, 1e-5), 0.0, 1.0);
  nz = -0.5 * nz + 1.0;

  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));

  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1e-5));
  vec3 hitMax = (vec3(1.0) - max(mx4, e)) / max(4.0 * mn4 - 4.0, vec3(1e-5));
  vec3 lobeV = max(-hitMin, hitMax);
  float lobe = max(-RCAS_LIMIT, min(max(max(lobeV.r, lobeV.g), lobeV.b), 0.0));
  lobe *= exp2(-uSharpness);
  if (uDenoise == 1) lobe *= nz;
  float rcpL = 1.0 / (4.0 * lobe + 1.0);
  vec3 pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;
  fragColor = vec4(pix, 1.0);
}`,

    // —— 呈现：等比适配 + 自动白平衡 + 可选轻度局部对比度 ——
    present: `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uCanvas;
uniform vec2 uImage;      // 图像等比显示区域（像素）
uniform vec3 uWbGain;
uniform float uContrast;  // 1.0 = 原样
uniform float uExposure;  // 线性增益
uniform float uSaturation;
void main() {
  vec2 origin = (uCanvas - uImage) * 0.5;
  vec2 uv = (gl_FragCoord.xy - origin) / uImage;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 c = texture(uSrc, uv).rgb;
  c *= uWbGain * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  fragColor = vec4(c, 1.0);
}`
  };
})(window);
