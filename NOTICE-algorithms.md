MIT License — 仅供算法出处署名参考

LumenScope 本体**不使用** MIT 授权，见同目录 LICENSE（禁止商用、禁止二改，作者：只因君）。
本文件只用于说明本项目独立重写了下列公开算法，并按其原始许可致谢。
本项目的实现不链接、不复制这些项目的任何源代码。

---

1) FidelityFX Super Resolution 1 (EASU + RCAS)
   Copyright (c) 2021 Advanced Micro Devices, Inc.
   Licensed under the MIT License.
   src/core/shader/fsr.glsl.js 是按 ffx_fsr1.h 公开描述独立重写的 GLSL ES 3.0 版本。

2) vid.stab — video stabilization library
   Copyright (c) 2007-2013 Georg Martius
   LGPL-2.1-or-later
   src/core/motion.js 中的运动估计思路（Michelson 对比度选场、由粗到细 SAD 块匹配、
   变换的滑动平均低通）参考该库公开的技术做法，未使用其代码。

3) Spatiotemporal Variance-Guided Filtering (SVGF)
   Schied et al., "Spatiotemporal Variance-Guided Filtering: Real-Time
   Reconstruction for Path-Traced Images", HPG 2017.
   src/core/shader/temporal.glsl.js 的时域滤波设计参考该论文。

4) One-Euro filter
   Casiez, Roussel, Vogel, CHI 2012.
   src/core/motion.js 的平滑类基于该滤波器。
