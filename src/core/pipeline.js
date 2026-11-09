'use strict';
// 渲染管线：采集 → 运动估计 → 防抖/卷帘采样 → 时域降噪 → EASU 超分 → RCAS 锐化 → 呈现
// 顺序遵循 FSR1 官方建议：EASU 在后处理末端上采样，RCAS 紧随其后锐化。
(function (g) {
  const GW = window.LumenGL;
  const FS = window.ShaderFSR;
  const ST = window.ShaderTemporal;

  const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] };

  class Pipeline {
    constructor(canvas) {
      this.canvas = canvas;
      this.r = GW.createRenderer(canvas);
      this.gl = this.r.gl;
      this.motion = new window.LumenMotion.MotionAnalyzer();

      this.pWarp = this.r.makePass('warp', FS.warp);
      this.pTemporal = this.r.makePass('temporal', ST);
      this.pRolling = this.r.makePass('rolling', window.ShaderRollingShutter);
      this.pLanczos = this.r.makePass('lanczos', window.ShaderLanczos);
      this.pEasu = this.r.makePass('easu', FS.easu);
      this.pRcas = this.r.makePass('rcas', FS.rcas);
      this.pPresent = this.r.makePass('present', FS.present);
      this.pMeter = this.r.makePass('meter', window.ShaderMeter);
      this.pReduce = this.r.makePass('meterReduce', window.ShaderMeterReduce);
      this.meterTex = null;
      this.meterU8 = new Uint8Array(4);
      this.ae = { gain: 1.0, target: 1.0, clipped: 0, mean: 0.5, converged: false };
      this._aeTick = 0;

      this.outH = 1080;
      this.outW = 1920;
      this.nativeW = 0; this.nativeH = 0;
      this.nat = [];      // 原生分辨率 ping-pong（防抖采样 / 时域降噪）
      this.hist = [];     // 时域历史
      this.up = [];       // 超分后 ping-pong（EASU / RCAS）
      this.frame = 0;
      this.resetHistory = true;
      this._tPrev = 0;
      this._awbTick = 0;
      this.wb = { r: 1, g: 1, b: 1 };
      this.wbTarget = { r: 1, g: 1, b: 1 };
      this.lastStats = { gpuMs: 0, cpuMs: 0, motionConf: 0, dt: 16.7, fps: 0, nativeW: 0, nativeH: 0 };

      this.settings = {
        outputHeight: 1080,
        stabilise: true,
        stabiliseStrength: 0.8,
        cropRatio: 0.07,
        denoise: 0.55,
        sharpen: 0.35,
        superRes: true,
        upsample: 'easu',
        upscaler: 'lanczos',   // 'lanczos' = 精细（Lanczos-3 + 抗振铃）| 'easu' = 极速（FSR1）
        rollingShutter: true,
        rollingStrength: 0.85,  // 果冻校正强度（行读出时间模型的补偿比例）
        rsTopFirst: true,       // 传感器读出方向：true = 从上往下先读出
        autoWhiteBalance: true,
        exposure: 1.0,
        contrast: 1.0,
        saturation: 1.0,
        userZoom: 1.0,
        userPanX: 0,
        userPanY: 0,
        noiseFloor: 0.0008,     // 噪声方差基线：低于它的方差算噪声、不算细节
        dither: 0.3,
        autoExposure: true,
        aeTarget: 0.46,        // 目标中灰（显微镜：稍亮更利于观察）
        targetFps: 30,         // 30 / 60
        virtualCam: false,
      };
      this.outFps = 30;
      this._lastEmit = 0;
      // —— 卷帘（果冻）校正用的相机位置历史 ——
      // 每一帧把实测帧间位移累积成"相机位置"，按时间存档；
      // 校正时对任意行时刻插值取出该时刻的位置，与帧中心时刻相减得到该行的位移。
      this.camX = 0;
      this.camY = 0;
      this.camHist = [];
      this.rsRows = new Float32Array(32);   // 16 行 × (x,y)
      this.rsOn = false;
      // —— 时域降噪的历史重投影：记录上一帧实际施加的防抖变换 ——
      this._appliedPrev = null;
      this._histShift = [0, 0];
      this._histRot = 0;
      this._histZoom = 1;
    }

    // —— 资源分配 ——
    _free(arr) { for (const f of arr) { if (!f) continue; this.gl.deleteFramebuffer(f.fbo); this.gl.deleteTexture(f.tex); } arr.length = 0; }

    _allocNative(w, h) {
      if (this.nativeW === w && this.nativeH === h) return;
      this._free(this.nat); this._free(this.hist);
      const gl = this.gl;
      this.nat = [GW.framebuffer(gl, w, h), GW.framebuffer(gl, w, h)];
      this.hist = [GW.framebuffer(gl, w, h), GW.framebuffer(gl, w, h)];
      this.nativeW = w; this.nativeH = h;
      this.histIndex = 0;
      this.resetHistory = true;
      this.historyLen = 0;
    }

    _allocUp(w, h) {
      if (this.upW === w && this.upH === h) return;
      this._free(this.up);
      const gl = this.gl;
      this.up = [GW.framebuffer(gl, w, h), GW.framebuffer(gl, w, h)];
      this.upW = w; this.upH = h;
      this.outW = w; this.outH = h;
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(2, Math.round(rect.width * dpr));
      const h = Math.max(2, Math.round(rect.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    }

    // —— 各阶段 ——
    _stageWarp(srcTex, vw, vh, target, mv, nowMs) {
      const gl = this.gl, p = this.pWarp, s = this.settings;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(p.uniforms.uSrc, 0);

      // mv 已由 MotionAnalyzer 给出"应施加的补偿量"（滑动平均低通后的高频抖动）
      let cx = 0, cy = 0, crot = 0, autoZoom = 0;
      if (s.stabilise && mv.conf > 0.05) {
        const k = s.stabiliseStrength * Math.min(1, mv.conf * 2.0);
        cx = (mv.dz || 0) * k;
        cy = (mv.dy || 0) * k;
        crot = (mv.drot || 0) * k;
        autoZoom = Math.max(0, (mv.zoom - 1)) * k;
      }

      // 补偿越界保护：位移不超过可用裁剪余量；防抖关闭时不做任何裁切缩放
      const crop = s.stabilise ? Math.max(0, s.cropRatio) : 0;
      const zoomTotal = 1 + crop + autoZoom;
      const limX = (zoomTotal - 1) / zoomTotal;   // 归一化可用余量
      const limY = (zoomTotal - 1) / zoomTotal;
      let nx = -(cx / Math.max(vw, 1));
      let ny = -(cy / Math.max(vh, 1));
      nx = Math.max(-limX, Math.min(limX, nx));
      ny = Math.max(-limY, Math.min(limY, ny));

      const c = Math.cos(-crot), sn = Math.sin(-crot);
      gl.uniformMatrix2fv(p.uniforms.uRot, false, new Float32Array([c, sn, -sn, c]));
      gl.uniform2f(p.uniforms.uShift, nx, ny);
      gl.uniform1f(p.uniforms.uZoom, zoomTotal);
      gl.uniform2f(p.uniforms.uSize, target.w, target.h);
      // 卷帘的行偏斜改由 _stageRollingShutter 用读出时间模型统一处理，这里不再重复施加
      gl.uniform1f(p.uniforms.uSkew, 0);
      gl.uniform1f(p.uniforms.uTime, this.frame % 97);
      gl.uniform1f(p.uniforms.uDither, s.denoise > 0.15 ? s.dither : 0);
      gl.uniform1f(p.uniforms.uUserZoom, s.userZoom);
      gl.uniform2f(p.uniforms.uUserPan, s.userPanX || 0, s.userPanY || 0);
      this._applied = { sx: nx, sy: ny, rot: crot, zoom: zoomTotal };
      this.r.drawTo(target);
    }

    // —— 逐行卷帘（果冻）校正 ——
    // 传感器逐行读出：第 y 行的读取时刻 = 帧起点 + y·T_readout。
    // 一帧内相机动了多少，各行就偏多少 —— 直线弯成弧、快晃呈"果冻"。
    // 用实测帧间位移累积的相机位置历史，求"该行时刻的位置 − 帧中心时刻的位置"，
    // 反向补掉这个位移，等价于把整帧对齐到同一时刻。
    _updateRolling(nowMs, mv, vw, vh, dtMs) {
      const s = this.settings;
      if (!s.rollingShutter || !mv) { this.rsOn = false; return; }
      // 累积相机位置（用实测帧间位移，而不是防抖后的补偿量：
      // 果冻来自传感器在读出期间的**真实**运动，跟防抖开不开无关）
      this.camX += (mv.tx || 0);
      this.camY += (mv.ty || 0);
      this.camHist.push({ t: nowMs, x: this.camX, y: this.camY });
      if (this.camHist.length > 32) this.camHist.shift();

      // 整帧读出时间：跟随**实测**帧周期（传感器时序跟着帧率走），
      // 而不是写死的 1/30s —— 实际帧率偏离标称值时，写死会让补偿量系统性偏小。
      const period = Math.max(4, Math.min(80, dtMs || 1000 / (s.targetFps >= 60 ? 60 : 30)));
      const readoutMs = Math.max(4, Math.min(40, period * 0.92));
      // 一帧的曝光/读出窗口是 [now-readout, now]，参考时刻取窗口中心。
      // （早期版本拿"最新样本"当参考，会导致一半的行落在未来被钳位，补偿只剩一半）
      const refT = nowMs - readoutMs * 0.5;
      const ref = this._camAt(refT);
      let maxPx = 0;
      for (let i = 0; i < 16; i++) {
        const y = (i + 0.5) / 16;                    // 0 = 顶行
        // 顶部先读出 ⇒ 顶行的时刻更早（rsTopFirst 控制方向）
        const dt = (s.rsTopFirst ? y - 0.5 : 0.5 - y) * readoutMs;
        const p = this._camAt(refT + dt);
        const dx = p.x - ref.x, dy = p.y - ref.y;
        // 目标：把这一行的内容搬回参考时刻的位置，内容位移 = -(该行位置 − 参考位置)。
        // 采样偏移与内容位移反号 ⇒ 采样偏移 = +(该行位置 − 参考位置)。
        this.rsRows[i * 2] = dx / Math.max(vw, 1);
        this.rsRows[i * 2 + 1] = dy / Math.max(vh, 1);
        maxPx = Math.max(maxPx, Math.abs(dx), Math.abs(dy));
      }
      this.rsOn = maxPx > 0.03;
    }

    // 按时刻插值相机位置
    _camAt(t) {
      const h = this.camHist;
      if (!h.length) return { x: 0, y: 0 };
      if (t <= h[0].t) return h[0];
      const last = h[h.length - 1];
      if (t >= last.t) return last;
      for (let i = h.length - 1; i > 0; i--) {
        if (t >= h[i - 1].t) {
          const a = h[i - 1], b = h[i];
          const k = (t - a.t) / Math.max(1e-3, b.t - a.t);
          return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
        }
      }
      return last;
    }

    _stageRollingShutter(src, target) {
      const gl = this.gl, p = this.pRolling, s = this.settings;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      gl.uniform2f(p.uniforms.uSize, target.w, target.h);
      const strength = s.rollingShutter ? clamp(s.rollingStrength != null ? s.rollingStrength : 0.85, 0, 1.2) : 0;
      gl.uniform2fv(p.uniforms.uRow, this.rsRows);
      gl.uniform1f(p.uniforms.uRolling, this.rsOn ? strength : 0);
      this.r.drawTo(target);
    }

    _stageTemporal(src, write, read, dtMs, mv) {
      const gl = this.gl, p = this.pTemporal;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, read.tex);
      gl.uniform1i(p.uniforms.uSource, 0);
      gl.uniform1i(p.uniforms.uHistory, 1);
      gl.uniform2f(p.uniforms.uSize, write.w, write.h);
      gl.uniform2f(p.uniforms.uTexel, 1 / write.w, 1 / write.h);

      // 30fps 时可用更强累积；60fps 时每帧噪声更少，降低累积避免拖影
      const fpsFactor = clamp(30 / Math.max(1000 / Math.max(dtMs, 8), 20), 0.6, 1.4);
      const strength = clamp(this.settings.denoise, 0, 1);
      // 基础 alpha = 当前帧权重。强度→权重用幂映射：
      //   0.35 → ≈0.27（约 4 帧窗口）  0.55 → ≈0.16（约 6 帧）  0.9 → ≈0.035（约 28 帧）
      // 细节区由着色器按局部方差把权重抬回去，所以这里可以放心压得很低。
      const alpha = clamp(0.5 * Math.pow(1 - strength, 1.6) + 0.02, 0.015, 0.95) * fpsFactor;
      gl.uniform1f(p.uniforms.uAlpha, clamp(alpha, 0.012, 0.95));
      gl.uniform1f(p.uniforms.uPhiColor, 1.0 + strength * 5.0);
      gl.uniform1f(p.uniforms.uPhiNormal, 0.42);
      gl.uniform1f(p.uniforms.uDenoise, strength);
      gl.uniform1f(p.uniforms.uHistoryLen, this.historyLen || 0);
      gl.uniform1i(p.uniforms.uReset, this.resetHistory ? 1 : 0);
      const nf = this.settings.noiseFloor != null ? this.settings.noiseFloor : 0.0008;
      gl.uniform1f(p.uniforms.uNoiseFloor, nf);
      gl.uniform1f(p.uniforms.uNoiseSigma, Math.sqrt(Math.max(nf, 1e-6)));

      // —— 历史帧重投影 ——
      // 输出流里"内容"的位移 = 本帧实测内容位移 + 本帧防抖施加的位移增量：
      //   · 防抖全补偿时两者抵消 → 位移≈0（画面静止），历史原地采样即可
      //   · 防抖关闭时 → 位移=实测相机位移，历史必须按它搬回来
      // 少了这一步，相机一动历史就错位，方差判据误判成"有细节"，降噪等于没开。
      const a = this._applied, b = this._appliedPrev;
      const conf = mv && mv.conf > 0.03 ? 1 : 0;
      const mtx = conf ? (mv.tx || 0) : 0;
      const mty = conf ? (mv.ty || 0) : 0;
      const mrot = conf ? (mv.rot || 0) : 0;
      let dx = mtx, dy = mty, dr = mrot, zr = 1;
      if (a && b) {
        dx = mtx - ((a.sx || 0) - (b.sx || 0)) * write.w;
        dy = mty - ((a.sy || 0) - (b.sy || 0)) * write.h;
        dr = mrot + ((a.rot || 0) - (b.rot || 0));
        zr = (b.zoom || 1) / (a.zoom || 1);
      }
      gl.uniform2f(p.uniforms.uHistShift, dx / write.w, dy / write.h);
      gl.uniform1f(p.uniforms.uHistRot, dr);
      gl.uniform1f(p.uniforms.uHistZoom, zr);
      this._appliedPrev = a ? { sx: a.sx, sy: a.sy, rot: a.rot, zoom: a.zoom } : null;

      this.r.drawTo(write);
      // 历史长度累加（场景重置时归零）
      this.historyLen = this.resetHistory ? 1 : Math.min((this.historyLen || 0) + 1, 24);
    }

    // Lanczos-3 上采样（含抗振铃与自适应细节增强）
    _stageLanczos(src, target) {
      const gl = this.gl, p = this.pLanczos;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      gl.uniform2f(p.uniforms.uSrcSize, src.w, src.h);
      gl.uniform2f(p.uniforms.uDstSize, target.w, target.h);
      gl.uniform1f(p.uniforms.uSharpen, Math.min(1, this.settings.sharpen * 1.1));
      gl.uniform1f(p.uniforms.uAntiRing, 0.9);
      this.r.drawTo(target);
    }

    _stageEasu(src, target) {
      const gl = this.gl, p = this.pEasu;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      gl.uniform2f(p.uniforms.uInSize, src.w, src.h);
      gl.uniform2f(p.uniforms.uOutSize, target.w, target.h);
      this.r.drawTo(target);
    }

    _stageRcas(src, target) {
      const gl = this.gl, p = this.pRcas;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      gl.uniform2f(p.uniforms.uSize, target.w, target.h);
      gl.uniform1f(p.uniforms.uSharpness, this.settings.sharpen);
      gl.uniform1i(p.uniforms.uDenoise, this.settings.denoise > 0.3 ? 1 : 0);
      this.r.drawTo(target);
    }

    _stagePresent(src) {
      const gl = this.gl, p = this.pPresent;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      const cw = this.canvas.width, ch = this.canvas.height;
      const a = src.w / src.h;
      let iw = cw, ih = ch;
      if (cw / ch > a) { ih = ch; iw = ch * a; } else { iw = cw; ih = cw / a; }
      gl.uniform2f(p.uniforms.uCanvas, cw, ch);
      gl.uniform2f(p.uniforms.uImage, iw, ih);
      gl.uniform3f(p.uniforms.uWbGain, this.wb.r, this.wb.g, this.wb.b);
      gl.uniform1f(p.uniforms.uContrast, this.settings.contrast);
      gl.uniform1f(p.uniforms.uExposure, this.settings.exposure);
      gl.uniform1f(p.uniforms.uSaturation, this.settings.saturation);
      this.r.drawTo(null);
    }

    // —— 测光（GPU 降采样 + 1x1 归约，读回 4 个浮点）——
    _stageMeter(src) {
      const gl = this.gl;
      if (!this.meterTex || this.meterTex.w !== 32) {
        if (this.meterTex) { this._free([this.meterTex]); this._free([this.meterSmall]); }
        this.meterSmall = GW.framebuffer(gl, 32, 18);
        this.meterTex = GW.framebuffer(gl, 1, 1);
        this.meterAlloc = true;
      }
      const p = this.pMeter;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      gl.uniform2f(p.uniforms.uSize, src.w, src.h);
      gl.uniform2f(p.uniforms.uOutSize, 32, 18);
      gl.uniform1f(p.uniforms.uGain, this.ae && this.ae.gain ? this.ae.gain : 1);
      this.r.drawTo(this.meterSmall);

      const q = this.pReduce;
      this.r.use(q);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.meterSmall.tex);
      gl.uniform1i(q.uniforms.uSrc, 0);
      gl.uniform2f(q.uniforms.uSrcSize, 32, 18);
      this.r.drawTo(this.meterTex);

      // 读回 1 个像素。为控制 CPU 开销，每 3 帧读一次。
      if ((this._aeTick++ % 3) !== 0) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterTex.fbo);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.meterU8);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const r = this.meterU8[0] / 255, g = this.meterU8[1] / 255, b = this.meterU8[2] / 255, hi = this.meterU8[3] / 255;
      this._applyAE(r, g, b, hi);
      this._applyAWB(r, g, b);
    }

    // 自动曝光：以加权亮度趋近目标值，带高光保护与限速
    _applyAE(r, g, b, hi) {
      const s = this.settings;
      // r/g/b 是"增益之前"的线性亮度，乘以当前增益才是观众看到的亮度
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      this.ae.raw = lum;
      if (!s.autoExposure) { this.ae.mean = lum; this.ae.gain = 1; this.ae.converged = true; return; }

      // 用"当前曝光下实际亮度"参与控制；增益为未知时先按 1 计
      const effLum = lum * this.ae.gain;
      this.ae.mean = effLum;
      this.ae.clipped = hi;

      const target = s.aeTarget;
      // 目标增益：按"目标/当前"求比例控制量
      const ideal = target / Math.max(effLum, 0.01);
      let next = this.ae.gain * Math.max(0.80, Math.min(1.26, ideal));
      // 高光约束：软饱和比例超过 1.5% 就强制回收增益（最多每拍降 25%），
      // 避免"暗背景 + 亮标本"把细胞推成白块
      if (hi > 0.015) {
        const k = Math.min(1, 0.015 / hi);
        const cap = this.ae.gain * (1 - (1 - k) * 0.25);
        if (cap < next) next = cap;
      }
      const gainAfter = Math.max(0.35, Math.min(6.5, next));
      const effAfter = lum * gainAfter;
      const dead = Math.abs(target - effAfter) / Math.max(target, 1e-4) < 0.035 && hi < 0.02;
      this.ae.gain = gainAfter;
      this.ae.converged = dead;
      this.ae.target = target;
      this.ae.ideal = ideal;
      s.exposure = this.ae.gain;
    }

    // 自动白平衡：gray-world + 高光/暗部剔除 + 增益平滑
    _applyAWB(r, g, b) {
      const s = this.settings;
      if (!s.autoWhiteBalance) { this.wb.r = this.wb.g = this.wb.b = 1; return; }
      if (r < 0.004 || g < 0.004 || b < 0.004) return;
      const mean = (r + g + b) / 3;
      let tr = mean / r, tg = mean / g, tb = mean / b;
      // 限制极端增益：显微镜染色标本本身带强烈色调，过度校正会把它洗成灰蓝
      tr = clamp(tr, 0.86, 1.16); tg = clamp(tg, 0.86, 1.16); tb = clamp(tb, 0.86, 1.16);
      // 保持整体亮度不变：归一化到绿通道
      const norm = 1 / Math.max(tg, 1e-3);
      tr *= norm; tb *= norm; tg = 1;
      const k = 0.10;   // 平滑系数，约 15 帧收敛
      this.wb.r += (tr - this.wb.r) * k;
      this.wb.g += (tg - this.wb.g) * k;
      this.wb.b += (tb - this.wb.b) * k;
    }

    setOutput(height) {
      const v = RES[height] || RES[1080];
      this.outH = v[1];
      this.outW = v[0];
      this.settings.outputHeight = height;
    }

    render(video) {
      const gl = this.gl;
      const t0 = performance.now();
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      this.resize();
      this._allocNative(vw, vh);
      const out = RES[this.settings.outputHeight] || RES[1080];
      const doUpscale = this.settings.superRes && out[1] > vh;
      if (doUpscale) this._allocUp(out[0], out[1]);
      else if (out[1] <= vh) this._allocUp(vw, vh);

      // 1) 上传最新视频帧
      this.r.uploadSource(video, vw, vh);

      // 2) 运动估计（CPU）
      const dtMs = this._tPrev ? (t0 - this._tPrev) : 16.7;
      this._tPrev = t0;
      this.dtSmooth = this.dtSmooth ? this.dtSmooth * 0.85 + dtMs * 0.15 : dtMs;
      let mv = { tx: 0, ty: 0, rot: 0, scale: 1, conf: 0 };
      if (this.settings.stabilise || this.settings.rollingShutter) {
        mv = this.motion.analyze(video, vw, vh, t0);
      }

      // 3) 防抖采样（原生分辨率）
      const natA = this.nat[0], natB = this.nat[1];
      this._stageWarp(this.r.videoTex, vw, vh, natA, mv, t0);

      // 3b) 逐行卷帘（果冻）校正：先按读出时间模型算好每行位移，再一次性采样
      let warped = natA;
      this._updateRolling(t0, mv, vw, vh, this.dtSmooth);
      if (this.settings.rollingShutter && this.rsOn) {
        this._stageRollingShutter(natA, natB);
        warped = natB;
      }

      // 4) 时域降噪（ping-pong，历史沿用到下一帧）
      let current = warped;
      if (this.settings.denoise > 0.001) {
        const write = this.hist[this.histIndex];
        const read = this.hist[1 - this.histIndex];
        this._stageTemporal(warped, write, read, dtMs, mv);
        this.histIndex = 1 - this.histIndex;
        current = write;
      }

      // 5) 超分 + 锐化
      let finalTex = current;
      if (doUpscale && this.settings.upscaler === 'lanczos') {
        this._stageLanczos(current, this.up[1]);
        finalTex = this.up[1];
      } else if (doUpscale) {
        this._stageEasu(current, this.up[0]);
        this._stageRcas(this.up[0], this.up[1]);
        finalTex = this.up[1];
      } else if (this.settings.superRes) {
        // 目标不高于原生：只做 RCAS 锐化，避免无谓放大
        this._stageRcas(current, this.up[0]);
        finalTex = this.up[0];
      }

      // 6) 测光：必须在"应用曝光增益之前"采样，否则增益会污染测量值导致正反馈失控。
      //    这里测的是降噪/超分之后、present 之前的线性画面。
      this._stageMeter(finalTex);

      // 7) 呈现
      this.finalTex = finalTex;
      this._stagePresent(finalTex);

      // 帧率节流：低于目标帧率时，跳过重复渲染（画面保持不变）
      const dt = performance.now() - t0;
      this.lastStats.cpuMs = dt;
      this.lastStats.motionConf = mv.conf;
      this.lastStats.dt = dtMs;
      this.lastStats.nativeW = vw;
      this.lastStats.nativeH = vh;
      this.frame++;
      this.resetHistory = false;
      this._tPrev = t0;
      return this.lastStats;
    }

    // 供虚拟摄像头推流：缩放到指定尺寸并翻转成"从上到下"的行序（WebGL 读回是自下而上）
    readStream(w, h) {
      const gl = this.gl;
      if (!this.finalTex) return null;
      if (!this.streamPass) {
        this.streamPass = this.r.makePass('streamCopy', `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSize;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  fragColor = vec4(texture(uSrc, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0);
}`);
      }
      if (!this._stFbo || this._stFbo.w !== w || this._stFbo.h !== h) {
        this._free(this._stFbo ? [this._stFbo] : []);
        this._stFbo = GW.framebuffer(gl, w, h);
        this._stBuf = new Uint8Array(w * h * 4);
      }
      const p = this.streamPass;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.finalTex.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      gl.uniform2f(p.uniforms.uSize, w, h);
      this.r.drawTo(this._stFbo);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._stFbo.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._stBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // 必须拷贝：复用缓冲会在下一帧被覆盖，而发送是异步的
      return { buf: this._stBuf.slice(), w, h };
    }

    // 读出最终画面的原始尺寸像素
    readFull() {
      const gl = this.gl;
      if (!this.finalTex) return null;
      const w = this.finalTex.w, h = this.finalTex.h;
      if (!this._fbBuf || this._fbBuf.length !== w * h * 4) this._fbBuf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.finalTex.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._fbBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { buf: this._fbBuf, w, h };
    }

    // 把最终画面缩到任意尺寸读回 CPU（仅用于质量评估/测量，不参与主循环）
    readSmall(w, h) {
      const gl = this.gl;
      if (!this.finalTex) return null;
      if (!this.copyPass) {
        this.copyPass = this.r.makePass('copy', `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uSize;
void main() { fragColor = texture(uSrc, gl_FragCoord.xy / uSize); }`);
      }
      if (!this._rb || this._rb.w !== w || this._rb.h !== h) {
        this._free(this._rb ? [this._rb] : []);
        this._rb = GW.framebuffer(gl, w, h);
        this._rbBuf = new Uint8Array(w * h * 4);
      }
      const p = this.copyPass;
      this.r.use(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.finalTex.tex);
      gl.uniform1i(p.uniforms.uSrc, 0);
      gl.uniform2f(p.uniforms.uSize, w, h);
      this.r.drawTo(this._rb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._rb.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._rbBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { buf: this._rbBuf.slice(), w, h };
    }

    // 把当前最终画面推给虚拟摄像头推流器
    vcamPush(streamer) {
      if (!this.finalTex) return;
      streamer.push(this);
    }

    resetAll() {
      this.resetHistory = true;
      this.historyLen = 0;
      this.motion.reset();
      this.camHist.length = 0;
      this.camX = 0; this.camY = 0;
      this._appliedPrev = null;
    }

    // 输出帧率节流：返回 true 表示这一帧应当真正渲染并输出
    shouldEmit(nowMs) {
      const target = this.settings.targetFps || 30;
      if (target >= 60) return true;              // 60fps：不丢帧
      const minGap = 1000 / target - 3;           // 3ms 容忍抖动
      if (!this._lastEmit) { this._lastEmit = nowMs; return true; }
      if (nowMs - this._lastEmit >= minGap) { this._lastEmit = nowMs; return true; }
      return false;
    }
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  g.LumenPipeline = { Pipeline, RES };
})(window);
