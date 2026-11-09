'use strict';
// 测光：把画面降采样到极小尺寸并输出加权亮度/色彩统计，供自动曝光与自动白平衡使用
// 单次 pass 输出 1x1 结果：r=平均亮度 g=平均R b=平均B a=高光溢出比例
(function (g) {
  g.ShaderMeter = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uSize;     // 源尺寸
uniform vec2 uOutSize;  // 统计纹理尺寸（如 32x18）
uniform int  uMode;     // 0 = 加权平均测光，1 = 直方图累加降采样
uniform float uGain;    // 当前曝光增益：用于判断"送给屏幕的画面"是否已经过曝

void main() {
  // 每个输出像素覆盖源图的一块区域，用 3x3 采样近似区域积分（够快且稳定）
  vec2 cell = uSize / uOutSize;
  vec2 base = (gl_FragCoord.xy - 0.5) * cell;
  float r = 0.0, gg = 0.0, b = 0.0, hi = 0.0, wsum = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      vec2 uv = (base + vec2(float(x) + 0.5, float(y) + 0.5) * cell / 8.0) / uSize;
      // 中心加权：病理/标本主体通常在画面中部
      vec2 d = uv - 0.5;
      float w = exp(-dot(d, d) * 4.2);
      vec3 c = texture(uSrc, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
      r += c.r * w; gg += c.g * w; b += c.b * w;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722)) * uGain;
      // 软饱和计数：按"曝光后"亮度计权，0.80 以上开始计权、1.0 处为 1
      hi += smoothstep(0.80, 1.0, l) * w;
      wsum += w;
    }
  }
  fragColor = vec4(r / wsum, gg / wsum, b / wsum, hi / wsum);
}`;

  // 1x1 归约：把统计纹理求平均
  g.ShaderMeterReduce = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
void main() {
  vec3 sum = vec3(0.0);
  float hi = 0.0;
  // 上限 32x32 个样本，用步长覆盖全部
  vec2 stepUV = 1.0 / uSrcSize;
  for (int y = 0; y < 32; y++) {
    for (int x = 0; x < 32; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) * stepUV;
      if (uv.x > 1.0 || uv.y > 1.0) continue;
      vec4 s = texture(uSrc, uv);
      sum += s.rgb; hi += s.a;
    }
  }
  float n = uSrcSize.x * uSrcSize.y;
  n = clamp(n, 1.0, 1024.0);
  fragColor = vec4(sum / n, hi / n);
}`;
})(window);
