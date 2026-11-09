'use strict';
// 时域降噪 + 边缘保持空间降噪。
// 时域部分采用 SVGF（Spatiotemporal Variance-Guided Filtering, Schied et al. 2017）的核心：
//   ① 方差引导的自适应混合（方差大 → 更信当前帧，方差小 → 多累积历史）
//   ② 方差钳制（variance clipping）防拖影
//   ③ 历史长度累积，噪声按 1/sqrt(n) 收敛
// 关键改进：历史帧**按运动重投影**后再采样（相似变换：平移 + 旋转 + 缩放），
// 否则相机/防抖残余一动，历史就对不上，方差判据误判为"变化"→ alpha 抬高 → 几乎不降噪。
// 方差估计在**双边预滤波之后**的邻域上计算，并扣除噪声基线，避免"噪声本身把自己判成细节"。
(function (g) {
  g.ShaderTemporal = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;

uniform sampler2D uSource;     // 当前帧（防抖/卷帘校正后）
uniform sampler2D uHistory;    // 上一帧降噪结果
uniform vec2  uSize;
uniform vec2  uTexel;
uniform float uAlpha;          // 基础混合系数（帧率自适应）
uniform float uPhiColor;       // 值域核强度
uniform float uPhiNormal;      // 空间核强度
uniform float uDenoise;        // 0..1 总强度
uniform float uHistoryLen;     // 历史累积帧数
uniform int   uReset;
// —— 重投影参数（历史帧 → 当前帧的相似变换）——
uniform vec2  uHistShift;      // 采样历史时的平移（归一化）
uniform float uHistRot;        // 旋转（弧度）
uniform float uHistZoom;       // 采样缩放（>1 表示历史画面更大）
uniform float uNoiseFloor;     // 噪声方差基线（低于它的方差视为噪声，不计入"细节"判据）
uniform float uNoiseSigma;     // 噪声标准差（灰度单位，决定双边值域核尺度）

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec2 reproject(vec2 uv) {
  vec2 d = uv - 0.5;
  float c = cos(-uHistRot), s = sin(-uHistRot);
  vec2 r = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  return 0.5 + r * uHistZoom - uHistShift;
}

// 历史帧：只按重投影位置取一个样本。历史本身已经降过噪，
// 再在它上面做空间平均等于每帧多糊一次，累积下来细节就没了。
vec3 sampleHistory(vec2 uv) {
  return texture(uHistory, uv).rgb;
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;

  // —— 3x3 原始矩（用于确定值域核尺度与方差钳制盒）——
  vec3 m = vec3(0.0), m2 = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = texture(uSource, uv + vec2(float(x), float(y)) * uTexel).rgb;
      m += c; m2 += c * c;
    }
  }
  m /= 9.0; m2 /= 9.0;
  float varRaw = max(0.0, m2.g - m.g * m.g);

  if (uReset == 1) { fragColor = vec4(m, 1.0); return; }

  vec3 c0 = texture(uSource, uv).rgb;
  // —— 3x3 双边预滤波 ——
  // 值域核以**中心像素**为参考（SVGF 的做法）。若拿邻域均值当参考，
  // 细线/细纹理的中心像素会因为"和均值差得远"被判成异常值而被抹掉。
  // 核尺度只看噪声水平：噪声量级的差异平均掉，超过噪声的差异原样保留。
  float sigma = max(uNoiseSigma, 0.004) * (0.9 + 0.7 * uDenoise);
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);
  vec3 spa = vec3(0.0), spa2 = vec3(0.0);
  float wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float ws = (x == 0 && y == 0) ? 2.0 : exp(-float(x * x + y * y) * 0.7);
      vec3 c = texture(uSource, uv + vec2(float(x), float(y)) * uTexel).rgb;
      float d = dot(c - c0, c - c0);
      float w = ws * exp(-d * inv2s2);
      spa += c * w; spa2 += c * c * w; wsum += w;
    }
  }
  spa /= max(wsum, 1e-5); spa2 /= max(wsum, 1e-5);
  // 预滤波后的方差：噪声已被平均掉大半，剩下的才是真细节
  float varSp = max(0.0, spa2.g - spa.g * spa.g);
  // —— 时域累积 ——
  vec3 hist = sampleHistory(clamp(reproject(uv), vec2(0.0006), vec2(0.9994)));
  // 方差钳制盒用原始方差（含噪声）——过窄会切断真实细节，过宽会拖影
  float sd = sqrt(varRaw);
  hist = clamp(hist, m - sd * 2.2, m + sd * 2.2);

  // 细节判据：扣除噪声基线之后仍有方差 ⇒ 真的是纹理 ⇒ 少累积历史（保护纹理）
  float varEff = max(0.0, varSp - uNoiseFloor);
  float varFactor = clamp(varEff * 260.0, 0.0, 1.0);
  // 上限 0.85：即使是细节区也留一点历史，否则纹理里的噪声会原样留下
  float alpha = clamp(uAlpha * (1.0 + varFactor * 4.0), 0.008, 0.85);
  // 历史越长越保守（缓慢漂移的时间常数）
  float conv = 1.0 / (1.0 + uHistoryLen * 0.15);
  alpha = clamp(alpha * (0.8 + 0.2 * conv), 0.006, 0.9);

  vec3 outc = mix(hist, spa, alpha);
  // 场景切换 / 曝光突变：直接切当前帧
  if (length(hist - spa) > 0.30) outc = spa;
  fragColor = vec4(outc, 1.0);
}`;

  // —— 逐行卷帘（果冻）校正 ——
  // 卷帘快门逐行曝光：第 y 行的读取时刻 = 帧起点 + y × 读出时间。
  // 一帧内相机在动，每行记录到的位置就不同 —— 直边变斜（skew）、快速晃动呈果冻（wobble）。
  // 这里用**实测帧间运动累积出的相机位置历史**，对每一行求出
  //   行时刻的位置 − 参考时刻（帧中心）的位置
  // 再按行把这个位移反向补偿掉，等价于把整帧"对齐到同一时刻"。
  // 行偏移由 CPU 每帧算好（16 个控制行）经 uniform 数组传入，着色器只做插值采样。
  g.ShaderRollingShutter = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2  uSize;
uniform vec2  uRow[16];    // 每行采样偏移（归一化），行从上到下
uniform float uRolling;    // 0..1 强度
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  if (uRolling <= 0.001) { fragColor = vec4(texture(uSrc, uv).rgb, 1.0); return; }
  float t = clamp(uv.y, 0.0, 1.0) * 15.0;
  int i0 = int(floor(t));
  int i1 = min(i0 + 1, 15);
  vec2 off = mix(uRow[i0], uRow[i1], t - float(i0)) * uRolling;
  vec2 p = clamp(uv + off, vec2(0.0006), vec2(0.9994));
  fragColor = vec4(texture(uSrc, p).rgb, 1.0);
}`;
})(window);
