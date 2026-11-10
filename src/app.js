'use strict';
// LumenScope 应用层：设备发现、渲染循环、交互、拍照/录制
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    shell: $('shell'), topbar: $('topbar'), stage: $('stage'),
    canvas: $('glcanvas'), viewport: $('viewport'),
    overlay: $('overlay'), ovIdle: $('ovIdle'), ovBusy: $('ovBusy'), ovError: $('ovError'),
    deviceList: $('deviceList'), busyName: $('busyName'),
    errTitle: $('errTitle'), errBody: $('errBody'),
    btnRetry: $('btnRetry'), btnChooseOther: $('btnChooseOther'), btnRediscover: $('btnRediscover'),
    deviceTitle: $('deviceTitle'),
    statFps: $('statFps'), statMs: $('statMs'), statNative: $('statNative'), statOut: $('statOut'),
    btnSnapshot: $('btnSnapshot'), btnRecord: $('btnRecord'), btnFullscreen: $('btnFullscreen'), btnPanel: $('btnPanel'),
    glassBar: $('glassBar'), panel: $('panel'), toasts: $('toasts'),
    recBadge: $('recBadge'), recTime: $('recTime'),
    resCards: $('resCards'), resMeta: $('resMeta'), motionMeta: $('motionMeta'),
    cameraSelect: $('cameraSelect'), ckAwb: $('ckAwb'), btnReveal: $('btnReveal'), saveLabel: $('saveLabel'),
    ckAutoExposure: $('ckAutoExposure'), fpsGroup: $('fpsGroup'), engineGroup: $('engineGroup'),
    captureResGroup: $('captureResGroup'), captureFpsGroup: $('captureFpsGroup'),
    captureHint: $('captureHint'), camStatus: $('camStatus'),
    btnProbe: $('btnProbe'), probeLabel: $('probeLabel'),
    btnVcam: $('btnVcam'), vcamLabel: $('vcamLabel'), vcamHint: $('vcamHint'), vcamMeta: $('vcamMeta'),
    zoomCtl: $('zoomCtl'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomVal: $('zoomVal'), zoomPct: $('zoomPct'),
  };

  const state = {
    stream: null,
    deviceId: null,
    video: null,
    pipeline: null,
    running: false,
    recorder: null,
    recChunks: [],
    recStart: 0,
    recTimer: 0,
    available: [],
    streamer: null,
    vcamOn: false,
    srcFps: null,      // 摄像头真实帧率探针
    srcRaf: 0,
    probing: false,    // 是否正在探查摄像头能力
    lastCaps: null,
    probeResult: null, // 探查结论 { w, h, fps }
  };

  // ---------- 宿主适配层 ----------
  // 桌面版走 preload 暴露的 IPC；纯浏览器（Chrome --app 窗口）走本机 server.js 的 /api/*。
  // 两条路能力一致，界面代码不需要知道自己在哪个壳里。
  const host = (function () {
    const hasLumen = typeof window.lumen === 'object' && window.lumen && typeof window.lumen.saveMedia === 'function';
    if (hasLumen) {
      return {
        kind: 'desktop',
        canVcam: true,
        saveMedia: (name, buf) => window.lumen.saveMedia(name, buf),
        saveBlob: async (name, blob) => window.lumen.saveMedia(name, await blob.arrayBuffer()),
        revealMedia: () => window.lumen.revealMedia(),
        vcamStart: (opts) => window.lumen.vcamStart(opts),
        vcamStop: () => window.lumen.vcamStop(),
      };
    }
    const api = (p, opt) => fetch(p, opt).then(async (r) => {
      const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
      if (!r.ok && !j.error) j.error = 'HTTP ' + r.status;
      return j;
    });
    const toDataUrl = (blob) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
    return {
      kind: 'browser',
      canVcam: true,
      async saveBlob(name, blob) {
        try {
          const dataUrl = await toDataUrl(blob);
          const r = await api('/api/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, dataUrl }),
          });
          if (r && r.ok) return { ok: true, path: r.path };
          // 服务不可用时退回浏览器原生下载（同样是系统「下载」文件夹）
          downloadBlob(name, blob);
          return { ok: true, path: name, viaDownload: true };
        } catch (e) {
          try { downloadBlob(name, blob); return { ok: true, path: name, viaDownload: true }; }
          catch (_) { return { ok: false, error: String(e && e.message || e) }; }
        }
      },
      saveMedia: async (name, buf) => {
        const blob = new Blob([buf]);
        return hostRef.saveBlob(name, blob);
      },
      revealMedia: () => api('/api/reveal', { method: 'POST' }),
      vcamStart: (opts) => api('/api/vcam/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts || {}),
      }),
      vcamStop: () => api('/api/vcam/stop', { method: 'POST' }),
    };
  })();
  const hostRef = host;

  // ---------- 工具 ----------
  function toast(msg, kind = 'info', ms = 2600) {
    const icons = {
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
      ok: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.4l2.4 2.4 4.6-4.9"/>',
      error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>',
    };
    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.kind = kind;
    node.innerHTML = `<svg class="t-ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[kind] || icons.info}</svg><span></span>`;
    node.querySelector('span').textContent = msg;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 260);
    }, ms);
  }

  function setOverlay(stateName, opts = {}) {
    el.overlay.dataset.state = stateName;
    el.ovIdle.hidden = stateName !== 'idle';
    el.ovBusy.hidden = stateName !== 'busy';
    el.ovError.hidden = stateName !== 'error';
    el.glassBar.hidden = stateName !== 'live';
    if (el.zoomCtl) el.zoomCtl.hidden = stateName !== 'live';
    if (stateName === 'busy' && opts.name) el.busyName.textContent = opts.name;
    if (stateName === 'error') {
      el.errTitle.textContent = opts.title || '无法打开摄像头';
      el.errBody.textContent = opts.body || '设备可能正被其他程序占用。';
    }
  }

  function fmtRes(w, h) {
    if (!w || !h) return '—';
    return `${w}×${h}`;
  }

  // ---------- 设备发现 ----------
  const GENERIC_LABELS = new Set(['video input', 'usb video device', 'usb camera', 'camera', 'webcam', 'integrated camera', '']);

  function prettify(label, index) {
    const name = (label || '').trim();
    if (!name) return `摄像头 ${index + 1}`;
    return name;
  }

  async function enumerateDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter(d => d.kind === 'videoinput');
    // 未授权时 label 为空，先请求一次权限换取可读名字
    if (cams.length && cams.every(c => !c.label)) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach(t => t.stop());
        return enumerateDevices();
      } catch (_) { /* 用户拒绝时保持匿名列表 */ }
    }
    return cams;
  }

  function pickPreferred(cams) {
    const score = (c) => {
      const l = (c.label || '').toLowerCase();
      let s = 0;
      if (l.includes('usb camera')) s += 100;
      else if (l.includes('usb')) s += 60;
      if (l.includes('uvc')) s += 40;
      if (l.includes('fhd')) s += 30;
      if (GENERIC_LABELS.has(l)) s += 5;
      return s;
    };
    return [...cams].sort((a, b) => score(b) - score(a))[0] || null;
  }

  function renderDeviceList(cams) {
    el.deviceList.innerHTML = '';
    if (!cams.length) {
      const empty = document.createElement('div');
      empty.className = 'device-empty';
      empty.textContent = '没有检测到视频设备。请确认 USB 线已插好，并在系统设置里允许访问摄像头。';
      el.deviceList.appendChild(empty);
      return;
    }
    cams.forEach((cam, i) => {
      const row = document.createElement('button');
      row.className = 'device-row';
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      const isUsb = /usb|uvc/i.test(cam.label || '');
      row.innerHTML = `
        <span class="dev-ico">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="6.5" width="12.5" height="11" rx="2.2"/><path d="M15.5 11.2l4.2-2.3v6.2l-4.2-2.3"/><path d="M6.5 3.5v3" opacity=".5"/>
          </svg>
        </span>
        <span class="dev-txt">
          <span class="dev-name"></span>
          <span class="dev-meta">${isUsb ? 'USB 视频设备' : '视频设备'} · 点击开始</span>
        </span>
        <svg class="dev-go" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      `;
      row.querySelector('.dev-name').textContent = prettify(cam.label, i);
      row.addEventListener('click', () => openCamera(cam));
      el.deviceList.appendChild(row);
    });
  }

  function renderSelect(cams, activeId) {
    el.cameraSelect.innerHTML = '';
    if (!cams.length) {
      const o = document.createElement('option');
      o.textContent = '无可用设备';
      el.cameraSelect.appendChild(o);
      el.cameraSelect.disabled = true;
      return;
    }
    el.cameraSelect.disabled = false;
    cams.forEach((cam, i) => {
      const o = document.createElement('option');
      o.value = cam.deviceId;
      o.textContent = prettify(cam.label, i);
      if (cam.deviceId === activeId) o.selected = true;
      el.cameraSelect.appendChild(o);
    });
  }

  // ---------- 摄像头 ----------
  // 采集设置：分辨率 / 帧率，用户可在面板里选，也会被记住
  const capture = {
    height: 'auto',    // 'auto' | 540 | 720 | 1080
    fps: 'auto',       // 'auto' | 30 | 60
  };

  function captureConstraints(deviceId) {
    const c = { audio: false, video: {} };
    if (deviceId) c.video.deviceId = { exact: deviceId };
    if (capture.height !== 'auto') {
      // 只给 ideal：用 exact 的话，摄像头不支持这个尺寸会直接 OverconstrainedError，
      // ideal 会让浏览器挑最接近的，更稳。
      c.video.height = { ideal: Number(capture.height) };
      c.video.width = { ideal: Math.round(Number(capture.height) * 16 / 9) };
    }
    if (capture.fps !== 'auto') c.video.frameRate = { ideal: Number(capture.fps) };
    return c;
  }

  async function openCamera(cam) {
    closeStream();
    setOverlay('busy', { name: prettify(cam?.label, 0) });
    el.deviceTitle.textContent = prettify(cam?.label, 0);

    // 采集约束策略（实测见 scripts/exp-constraints.js / exp-best-format.js）：
    // 有些杂牌 UVC（比如这台 VID_1224）对 width/height/frameRate 很挑，
    // 带错约束会让真实帧率从 30 掉到个位数，而 track.getSettings() 仍然谎报 30。
    // 所以策略是：
    //   1) 用户在面板里选的格式 → 先按它试
    //   2) 试完立刻实测 1.2 秒真实帧率，低于 20fps 就自动降级到"只给 deviceId"
    //   3) 面板上如实显示实际拿到的分辨率和帧率，不对就提示
    const devId = cam?.deviceId || null;

    async function tryGet(constraints) {
      try {
        return await Promise.race([
          navigator.mediaDevices.getUserMedia(constraints),
          new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('打开摄像头超时'), { name: 'TimeoutError' })), 8000)),
        ]);
      } catch (e) { return { __err: e }; }
    }

    let stream = null, lastErr = null;
    let usedFallback = false;

    const wanted = captureConstraints(devId);
    if (capture.height !== 'auto' || capture.fps !== 'auto') {
      const r = await tryGet(wanted);
      if (r && !r.__err) {
        // 实测这个格式的真实帧率，不行就换
        const fps = await measureStreamFps(r, 1200);
        if (fps >= 20) {
          stream = r;
        } else {
          r.getTracks().forEach(t => t.stop());
          usedFallback = true;
        }
      } else {
        lastErr = r && r.__err;
        usedFallback = true;
      }
    }

    if (!stream) {
      const plain = { audio: false, video: devId ? { deviceId: { exact: devId } } : true };
      const r = await tryGet(plain);
      if (r && !r.__err) {
        stream = r;
        if (capture.height !== 'auto' || capture.fps !== 'auto') usedFallback = true;
      } else {
        lastErr = r && r.__err;
      }
    }

    if (!stream) {
      const name = lastErr?.name || '';
      const msg = name === 'NotAllowedError'
        ? '摄像头权限被拒绝。请在浏览器地址栏的权限设置里允许访问摄像头。'
        : name === 'NotReadableError'
          ? '设备被其他程序占用（如相机 App、微信、钉钉视频）。请关闭后重试。'
          : name === 'TimeoutError'
            ? '长时间没有拿到画面。多半是设备被别的程序占着（相机 App / 会议软件 / 另一个 LumenScope 窗口）。关掉它们再点「重试」。'
            : name === 'NotFoundError'
              ? '没有找到这个设备。请重新插拔 USB 线。'
              : (lastErr?.message || '未知错误。');
      setOverlay('error', { title: '无法打开摄像头', body: msg });
      return;
    }
    if (usedFallback) {
      state.captureFallback = true;
      toast('这个分辨率摄像头跑不动，已自动换成它最稳的格式', 'info', 4000);
    } else {
      state.captureFallback = false;
    }

    state.stream = stream;
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    state.deviceId = settings.deviceId || cam?.deviceId || null;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    await video.play().catch(() => {});

    await new Promise((resolve) => {
      if (video.videoWidth) return resolve();
      const t = setInterval(() => { if (video.videoWidth) { clearInterval(t); resolve(); } }, 40);
      setTimeout(() => { clearInterval(t); resolve(); }, 2500);
    });

    state.video = video;
    // 诊断用：把 video 和当前流挂到调试对象上，
    // 方便用 requestVideoFrameCallback 测"源帧率 vs 渲染帧率"。
    if (window.__lumenDebug) {
      window.__lumenDebug.video = video;
      window.__lumenDebug.stream = stream;
    }
    resizePipelineForNative();
    startLoop();
    setOverlay('live');
    el.btnSnapshot.disabled = false;
    el.btnRecord.disabled = false;

    const native = fmtRes(video.videoWidth, video.videoHeight);
    el.statNative.textContent = native;
    if (/Microscope|Boshida|UVC|USB/i.test(track.label || '')) { /* label 可能被浏览器简化 */ }
    updateResMeta();
    updateCaptureInfo(track);
    toast(`已连接 ${prettify(track.label || cam?.label, 0)} · ${native}`, 'ok');

    // 挂上真实帧率探针：track.getSettings().frameRate 是不可信的（驱动会谎报 30），
    // 只有 requestVideoFrameCallback 数出来的才是"摄像头真的送来几帧"。
    startSourceFpsMeter(video);

    track.addEventListener('ended', () => {
      toast('设备已断开', 'error');
      setOverlay('idle');
      refreshDevices();
    });
  }

  // 用 requestVideoFrameCallback 实测一段时间内"摄像头真的送来几帧"
  function measureStreamFps(stream, ms) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      let n = 0, cb = 0, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { if (cb) v.cancelVideoFrameCallback(cb); } catch (_) {}
        try { v.pause(); } catch (_) {}
        // 只停 video 元素，不 stop track（调用方可能还要用这个 stream）
        resolve(n);
      };
      const start = () => {
        if (typeof v.requestVideoFrameCallback === 'function') {
          const onF = () => { n++; cb = v.requestVideoFrameCallback(onF); };
          cb = v.requestVideoFrameCallback(onF);
        } else {
          // 退路：按 currentTime 变化粗算
          let lastT = v.currentTime;
          const t = setInterval(() => {
            if (v.currentTime !== lastT) { n++; lastT = v.currentTime; }
          }, 4);
          setTimeout(() => clearInterval(t), ms);
        }
        setTimeout(finish, ms);
      };
      v.play().then(start).catch(() => { setTimeout(finish, ms); });
    }).then((frames) => frames / (ms / 1000));
  }

  // 把实际拿到的采集格式如实写到面板上（不采信 track.getSettings 的帧率）
  function updateCaptureInfo(track) {
    const s = track && track.getSettings ? track.getSettings() : {};
    const v = state.video;
    const w = v ? v.videoWidth : (s.width || 0);
    const h = v ? v.videoHeight : (s.height || 0);
    const declared = s.frameRate ? Math.round(s.frameRate) : 0;
    const wantRes = capture.height === 'auto' ? null : Number(capture.height);
    const wantFps = capture.fps === 'auto' ? null : Number(capture.fps);
    if (el.camStatus) {
      el.camStatus.textContent = w ? `${w}×${h}` : '未连接';
    }
    if (!el.captureHint) return;
    if (!w) {
      el.captureHint.textContent = '切到「自动」由摄像头自己协商最稳的格式';
      el.captureHint.dataset.tone = 'ok';
      return;
    }
    // 刚探查过：优先显示探查结论，别覆盖成"给不了 xxx"
    if (state.probeResult && state.probeResult.w === w && state.probeResult.h === h) {
      el.captureHint.textContent = `已探明最佳：${w}×${h} @${Math.round(state.probeResult.fps)}fps`;
      el.captureHint.dataset.tone = 'ok';
      return;
    }
    // 你选的 vs 实际拿到的，不一致就说清楚
    const gotLower = wantRes && h < wantRes * 0.9;
    const fpsLower = wantFps && declared && declared < wantFps * 0.9;
    if (state.captureFallback || gotLower) {
      el.captureHint.textContent = `这台摄像头给不了 ${wantRes}p，实际是 ${w}×${h}。换其它档位会自动回退，不会卡死。`;
      el.captureHint.dataset.tone = 'warn';
    } else if (fpsLower) {
      el.captureHint.textContent = `当前采集 ${w}×${h} · 实际 ${declared}fps（你要的是 ${wantFps}fps，这台给不到）`;
      el.captureHint.dataset.tone = 'warn';
    } else {
      el.captureHint.textContent = `当前采集 ${w}×${h}${declared ? ' · ' + declared + 'fps' : ''}`;
      el.captureHint.dataset.tone = 'ok';
    }
  }

  // 切换采集分辨率/帧率 → 用原设备重开一次
  async function applyCaptureSetting() {
    state.probeResult = null;
    if (!state.available.length) {
      toast('还没有连接摄像头', 'info');
      return;
    }
    const cam = state.available.find((c) => c.deviceId === state.deviceId) || pickPreferred(state.available);
    if (!cam) return;
    await openCamera(cam);
  }

  // ---------- 自动探查摄像头能力 ----------
  // 逐个候选格式试开采集、实测真实帧率，按「先保帧率(≥25)，再取最高分辨率」挑最优。
  // 关键经验（实测得出）：
  //   · 有些 UVC（这台 VID_1224）一带 ideal/exact 约束就进坏路径（0 帧或无首帧）
  //   · deviceId 每个浏览器会话独立，必须现取现用
  //   · 同一页面连续开关摄像头会互相干扰 —— 所以探查要"试一档 → 停干净 → 再试下一档"
  const CAP_CANDIDATES = [
    { h: 1080, label: '1920×1080' },
    { h: 900, label: '1600×900' },
    { h: 720, label: '1280×720' },
    { h: 960, label: '1280×960' },
    { h: 540, label: '960×540' },
    { h: 480, label: '640×480' },
  ];

  // 试一个约束：返回 { fps, width, height } 或 null
  async function tryCapture(deviceId, want, ms) {
    let stream = null;
    try {
      const c = { audio: false, video: {} };
      if (deviceId) c.video.deviceId = { exact: deviceId };
      if (want) {
        c.video.height = { ideal: want };
        c.video.width = { ideal: Math.round(want * 16 / 9) };
      }
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia(c),
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'Timeout' })), 6000)),
      ]);
    } catch (_) {
      return null;
    }
    try {
      const v = document.createElement('video');
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      await v.play().catch(() => {});
      // 等首帧
      const got = await new Promise((resolve) => {
        if (v.videoWidth) return resolve(true);
        const t = setInterval(() => { if (v.videoWidth) { clearInterval(t); resolve(true); } }, 40);
        setTimeout(() => { clearInterval(t); resolve(!!v.videoWidth); }, 2200);
      });
      if (!got) { try { v.pause(); } catch (_) {} return null; }
      const size = [v.videoWidth, v.videoHeight];

      // 数帧
      let n = 0, cb = 0;
      const onF = () => { n++; try { cb = v.requestVideoFrameCallback(onF); } catch (_) {} };
      if (typeof v.requestVideoFrameCallback === 'function') {
        try { cb = v.requestVideoFrameCallback(onF); } catch (_) {}
      }
      await new Promise((r) => setTimeout(r, ms));
      try { if (cb) v.cancelVideoFrameCallback(cb); } catch (_) {}
      try { v.pause(); } catch (_) {}
      v.srcObject = null;
      if (n === 0) return null;
      return { fps: n * 1000 / ms, width: size[0], height: size[1] };
    } catch (_) {
      return null;
    } finally {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      // 留点时间让设备释放，下一个候选才测得准
      await new Promise((r) => setTimeout(r, 260));
    }
  }

  // 完整探查：返回 { best: {h,label,fps,w,h}, log: [...] }
  async function probeCameraCaps(deviceId, onProgress) {
    // 先关掉当前采集，避免跟自己抢设备
    closeStream();
    await new Promise((r) => setTimeout(r, 500));

    const log = [];
    const good = [];

    // ① 先测"只给 deviceId"（最保险的兜底）
    const plain = await tryCapture(deviceId, null, 900);
    log.push({ name: '自动（驱动自选）', got: plain });
    if (plain && plain.fps >= 25) good.push({ name: '自动', want: null, ...plain });

    // ② 再逐档试分辨率
    for (const c of CAP_CANDIDATES) {
      if (onProgress) onProgress(c.label);
      const r = await tryCapture(deviceId, c.h, 900);
      log.push({ name: c.label, got: r });
      if (r && r.fps >= 25) good.push({ name: c.label, want: c.h, ...r });
    }

    // 排序：先保帧率，再取分辨率
    good.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return { best: good[0] || null, log, good };
  }

  async function runCapabilityProbe() {
    if (state.probing) return;
    const cam = state.available.find((c) => c.deviceId === state.deviceId) || pickPreferred(state.available);
    if (!cam) { toast('没有检测到摄像头', 'error'); return; }

    state.probing = true;
    if (el.btnProbe) el.btnProbe.disabled = true;
    const useId = cam.deviceId;
    toast('正在逐个试摄像头支持的格式，大约 10 秒…', 'info', 5000);
    if (el.captureHint) {
      el.captureHint.textContent = '正在探查…';
      el.captureHint.dataset.tone = 'ok';
    }

    let result = null;
    try {
      result = await probeCameraCaps(useId, (label) => {
        if (el.captureHint) el.captureHint.textContent = '正在试 ' + label + '…';
      });
    } catch (e) {
      toast('探查失败：' + (e.message || e), 'error');
    }

    state.probing = false;
    if (el.btnProbe) el.btnProbe.disabled = false;
    state.lastCaps = result;

    if (!result || !result.best) {
      toast('没找到能稳定跑 25fps 的格式，已回到自动', 'error', 5000);
      capture.height = 'auto';
      saveCapturePrefs();
      restoreCapturePrefs();
      await openCamera(cam);
      return;
    }

    const b = result.best;
    // 应用到设置
    capture.height = b.want === null ? 'auto' : (b.want <= 540 ? 540 : b.want <= 720 ? 720 : 1080);
    saveCapturePrefs();
    restoreCapturePrefs();

    // 把探查结论写到面板
    const lines = result.log.map((l) => `${l.name}: ${l.got ? `${l.got.width}×${l.got.height} @${l.got.fps.toFixed(0)}fps` : '不可用'}`);
    console.log('[camera-caps]', lines.join(' | '));

    await openCamera(cam);
    toast(`探查完成：${b.width}×${b.height} @${b.fps.toFixed(0)}fps 最稳`, 'ok', 5000);
    // openCamera 里的 updateCaptureInfo 会覆盖提示，这里把探查结论再写回去，
    // 而且只写一次结论（不要再叠一句"给不了 1080p"，两句放一起会让人以为出错）
    state.probeResult = { w: b.width, h: b.height, fps: b.fps };
    if (el.captureHint) {
      const tried = result.log.filter((l) => !l.got).map((l) => l.name);
      el.captureHint.textContent =
        `已探明最佳：${b.width}×${b.height} @${b.fps.toFixed(0)}fps` +
        (tried.length ? `（${tried.join('、')} 用不了）` : '');
      el.captureHint.dataset.tone = 'ok';
    }
  }

  // 记住用户的采集设置
  function saveCapturePrefs() {
    try {
      localStorage.setItem('lumen.capture', JSON.stringify(capture));
    } catch (_) {}
  }

  function restoreCapturePrefs() {
    try {
      const raw = localStorage.getItem('lumen.capture');
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && (o.height === 'auto' || [540, 720, 1080].includes(Number(o.height)))) capture.height = o.height === 'auto' ? 'auto' : Number(o.height);
      if (o && (o.fps === 'auto' || [30, 60].includes(Number(o.fps)))) capture.fps = o.fps === 'auto' ? 'auto' : Number(o.fps);
    } catch (_) {}
    const mark = (group, attr, val) => {
      if (!group) return;
      [...group.children].forEach((n) => {
        n.classList.toggle('is-active', String(n.dataset[attr]) === String(val));
      });
    };
    mark(el.captureResGroup, 'cap', capture.height);
    mark(el.captureFpsGroup, 'capfps', capture.fps);
  }

  // 统计摄像头每秒真的送来几帧，并和"我们渲染了几帧"对比
  function startSourceFpsMeter(video) {
    stopSourceFpsMeter();
    if (typeof video.requestVideoFrameCallback !== 'function') return;

    state.srcFps = { frames: 0, since: performance.now(), value: 0, reported: 0 };
    const onFrame = () => {
      if (state.video !== video) return;
      const m = state.srcFps;
      m.frames++;
      const now = performance.now();
      if (now - m.since >= 1000) {
        m.reported = m.frames * 1000 / (now - m.since);   // 摄像头真实帧率
        m.value = Math.round(m.reported * 10) / 10;
        m.frames = 0;
        m.since = now;
      }
      state.srcRaf = video.requestVideoFrameCallback(onFrame);
    };
    state.srcRaf = video.requestVideoFrameCallback(onFrame);
  }

  function stopSourceFpsMeter() {
    const v = state.video;
    if (v && state.srcRaf && typeof v.cancelVideoFrameCallback === 'function') {
      try { v.cancelVideoFrameCallback(state.srcRaf); } catch (_) {}
    }
    state.srcRaf = 0;
    state.srcFps = null;
  }

  function closeStream() {
    stopSourceFpsMeter();
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }
    if (state.video) { state.video.srcObject = null; state.video = null; }
    state.running = false;
    stopRecording(true);
    el.btnSnapshot.disabled = true;
    el.btnRecord.disabled = true;
  }

  // ---------- 渲染循环 ----------
  function initPipeline() {
    if (state.pipeline) return state.pipeline;
    try {
      state.pipeline = new window.LumenPipeline.Pipeline(el.canvas);
    } catch (err) {
      window.__lumenDebug = { pipeline: null, error: String(err && err.message || err) };
      setOverlay('error', {
        title: '图形初始化失败',
        body: String(err && err.message || err).slice(0, 240),
      });
      throw err;
    }
    document.body.classList.add('is-electron', !!window.lumen);
    if (window.lumen) el.saveLabel.textContent = '打开下载目录';
    setupWindowControls();
    bindPipelineControls();
    setupZoom();
    state.pipeline.setOutput(1080);
    window.__lumenDebug = { pipeline: state.pipeline, error: null, stats: null };
    // 让诊断探针能读到渲染统计
    const originalRender = state.pipeline.render.bind(state.pipeline);
    state.pipeline.render = (v) => {
      try { return originalRender(v); }
      catch (err) {
        window.__lumenDebug.error = 'render: ' + (err && err.message || err);
        stopLoop();
        toast('渲染中断：' + (err && err.message || err), 'error', 6000);
        throw err;
      }
    };
    return state.pipeline;
  }

  function resizePipelineForNative() {
    // 原生分辨率变化时重置历史，避免拖影
    if (state.pipeline) state.pipeline.resetAll();
  }

  let rafId = 0;
  let lastFpsT = 0, frames = 0;

  function startLoop() {
    if (state.running) return;
    state.running = true;
    const loop = () => {
      if (!state.running) return;
      rafId = requestAnimationFrame(loop);
      if (!state.video || state.video.readyState < 2) return;
      const p = initPipeline();
      const emit = p.shouldEmit(performance.now());
      if (!emit) return;                       // 目标 30fps 时，源 60fps 的多余帧直接跳过
      const stats = p.render(state.video);
      if (window.__lumenDebug) window.__lumenDebug.stats = stats;
      // 虚拟摄像头：推送"处理之后"的最终画面
      if (state.streamer && state.streamer.on && emit) {
        p.vcamPush && p.vcamPush(state.streamer);
      }
      frames++;
      const now = performance.now();
      if (now - lastFpsT > 480) {
        const renderFps = frames * 1000 / (now - lastFpsT);
        const srcFps = state.srcFps ? state.srcFps.reported : 0;
        // 显示"真实喂进来的帧率"，不是我们循环了多少次。
        // 只有源帧率正常时才显示渲染帧率（此时两者一致）；
        // 源跟不上就如实显示源的真实值，并用强调色标出来 —— 不再谎报 30。
        const shown = srcFps > 0 ? Math.min(srcFps, renderFps) : renderFps;
        const starving = srcFps > 0 && srcFps < renderFps * 0.8;
        el.statFps.textContent = shown.toFixed(shown < 10 ? 1 : 0);
        el.statMs.textContent = stats.cpuMs.toFixed(1);
        el.statFps.parentElement.dataset.warn = (shown < 24) ? 'true' : 'false';
        el.statFps.parentElement.title = starving
          ? `摄像头只送来 ${srcFps.toFixed(1)} fps（渲染循环 ${renderFps.toFixed(0)} fps，在重复渲染同一帧）`
          : '渲染帧率';
        el.statOut.textContent = fmtRes(p.outW, p.outH);
        const conf = stats.motionConf;
        el.motionMeta.textContent = conf > 0.55 ? '运动中 · 强补偿' : conf > 0.2 ? '轻微移动' : '静止';
        frames = 0; lastFpsT = now;
      }
    };
    lastFpsT = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    state.running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ---------- 交互绑定 ----------
  function fillRange(inputId, outId, formatter) {
    const input = $(inputId), out = $(outId);
    const sync = () => {
      const v = Number(input.value);
      const pct = ((v - input.min) / (input.max - input.min)) * 100;
      input.style.setProperty('--fill', pct + '%');
      out.textContent = formatter(v);
    };
    input.addEventListener('input', sync);
    sync();
    return { input, out, sync };
  }

  let controls = null;

  function bindPipelineControls() {
    const p = state.pipeline;
    const s = p.settings;

    controls = {
      strength: fillRange('slStrength', 'outStrength', v => String(v)),
      crop: fillRange('slCrop', 'outCrop', v => v + '%'),
      denoise: fillRange('slDenoise', 'outDenoise', v => String(v)),
      sharpen: fillRange('slSharpen', 'outSharpen', v => (v / 100).toFixed(2)),
      exposure: fillRange('slExposure', 'outExposure', v => (v / 100).toFixed(2) + '×'),
      contrast: fillRange('slContrast', 'outContrast', v => String(v)),
    };

    controls.strength.input.addEventListener('input', () => { s.stabiliseStrength = Number(controls.strength.input.value) / 100; });
    controls.crop.input.addEventListener('input', () => { s.cropRatio = Number(controls.crop.input.value) / 100; });
    controls.denoise.input.addEventListener('input', () => { s.denoise = Number(controls.denoise.input.value) / 100; });
    controls.sharpen.input.addEventListener('input', () => { s.sharpen = Number(controls.sharpen.input.value) / 100; });
    controls.exposure.input.addEventListener('input', () => { s.exposure = Number(controls.exposure.input.value) / 100; });
    controls.contrast.input.addEventListener('input', () => { s.contrast = Number(controls.contrast.input.value) / 100; });

    el.ckAwb.addEventListener('change', () => { s.autoWhiteBalance = el.ckAwb.checked; });
    el.ckAutoExposure.addEventListener('change', () => {
      s.autoExposure = el.ckAutoExposure.checked;
      if (!s.autoExposure) { p.ae.gain = Number(controls.exposure.input.value) / 100; }
      controls.exposure.input.disabled = s.autoExposure;
      el.btnVcam.parentElement && null;
      toast(s.autoExposure ? '自动亮度已开启' : '自动亮度已关闭（手动曝光）');
    });
    // 自动曝光开启时滑杆禁用，避免互相打架
    controls.exposure.input.disabled = s.autoExposure;
    if (s.autoExposure) el.ckAutoExposure.checked = true;

    // 帧率
    const setFps = (fps) => {
      s.targetFps = fps;
      p.outFps = fps;
      document.querySelectorAll('[data-fps]').forEach(b => {
        b.classList.toggle('is-active', Number(b.dataset.fps) === fps);
      });
      // 帧率变了也要让驱动重开，否则输出仍是旧帧率
      if (state.vcamOn) restartVcamForSize();
    };
    el.fpsGroup.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fps]');
      if (b) setFps(Number(b.dataset.fps));
    });

    // —— 采集分辨率 / 帧率 ——
    el.captureResGroup.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cap]');
      if (!b) return;
      const v = b.dataset.cap;
      capture.height = v === 'auto' ? 'auto' : Number(v);
      [...el.captureResGroup.children].forEach((n) => n.classList.toggle('is-active', n === b));
      saveCapturePrefs();
      applyCaptureSetting();
    });
    el.captureFpsGroup.addEventListener('click', (e) => {
      const b = e.target.closest('[data-capfps]');
      if (!b) return;
      const v = b.dataset.capfps;
      capture.fps = v === 'auto' ? 'auto' : Number(v);
      [...el.captureFpsGroup.children].forEach((n) => n.classList.toggle('is-active', n === b));
      saveCapturePrefs();
      applyCaptureSetting();
    });
    restoreCapturePrefs();

    if (el.btnProbe) {
      el.btnProbe.addEventListener('click', () => runCapabilityProbe());
    }

    el.engineGroup.addEventListener('click', (e) => {
      const b = e.target.closest('[data-engine]');
      if (!b || !state.pipeline) return;
      const eng = b.dataset.engine;
      state.pipeline.settings.upscaler = eng;
      [...el.engineGroup.children].forEach((n) => n.classList.toggle('is-active', n === b));
      toast(eng === 'lanczos' ? '超分引擎：Lanczos-3 精细模式' : '超分引擎：FSR 极速模式');
    });
    el.glassBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fps]');
      if (b) setFps(Number(b.dataset.fps));
    });
    setFps(s.targetFps);

    el.btnVcam.addEventListener('click', () => toggleVcam());

    el.resCards.addEventListener('click', (e) => {
      const card = e.target.closest('.res-card');
      if (card) setResolution(Number(card.dataset.res));
    });
    el.glassBar.addEventListener('click', (e) => {
      const seg = e.target.closest('.seg');
      if (seg) { setResolution(Number(seg.dataset.res)); return; }
      const chip = e.target.closest('.toggle-chip');
      if (chip) toggleChip(chip);
    });
  }

  function setResolution(h) {
    const p = state.pipeline;
    if (!p) return;
    const prevDims = [p.outW, p.outH];
    p.setOutput(h);
    p.resetAll();
    document.querySelectorAll('.res-card').forEach(c => c.classList.toggle('is-active', Number(c.dataset.res) === h));
    document.querySelectorAll('.seg').forEach(c => c.classList.toggle('is-active', Number(c.dataset.res) === h));
    updateResMeta();
    el.statOut.textContent = fmtRes(p.outW, p.outH);
    // 虚拟摄像头开着的时候，档位一变就得让驱动按新分辨率重开
    // （OBS 虚拟摄像头的输出格式在打开时固定，不重开是不会变的）
    if (state.vcamOn && (prevDims[0] !== p.outW || prevDims[1] !== p.outH)) {
      restartVcamForSize();
    }
  }

  // 分辨率/帧率变了：重启虚拟摄像头，把新尺寸交给驱动
  let _vcamResizeTimer = 0;
  function restartVcamForSize() {
    if (!state.vcamOn) return;
    clearTimeout(_vcamResizeTimer);
    // 连续点几档时只重启最后一次，避免反复抢驱动
    _vcamResizeTimer = setTimeout(async () => {
      toast('正在按新分辨率重启虚拟摄像头…', 'info', 2200);
      await stopVcam({ silent: true });
      await startVcam();
    }, 260);
  }

  function updateResMeta() {
    const p = state.pipeline;
    if (!p) return;
    const nat = state.video ? state.video.videoHeight : 0;
    const natLabel = nat ? `${nat}p` : '原生';
    const outLabel = `${p.settings.outputHeight === 1440 ? '2K' : p.settings.outputHeight + 'p'}`;
    el.resMeta.textContent = p.settings.superRes && p.outH > nat
      ? `${natLabel} → ${outLabel}`
      : `${outLabel}（无放大）`;
  }

  function toggleChip(chip) {
    const p = state.pipeline;
    if (!p) return;
    const on = chip.dataset.on !== 'true';
    chip.dataset.on = String(on);
    const s = p.settings;
    switch (chip.id) {
      case 'chipSuper':
        s.superRes = on;
        if (!on && s.outputHeight > 720) setResolution(720);
        updateResMeta();
        toast(on ? '超分辨率已开启（EASU）' : '超分辨率已关闭');
        break;
      case 'chipAntiShake':
        s.stabilise = on;
        if (!on) p.resetAll();
        toast(on ? '电子防抖已开启' : '电子防抖已关闭');
        break;
      case 'chipJelly':
        s.rollingShutter = on;
        toast(on ? '卷帘快门校正已开启' : '卷帘快门校正已关闭');
        break;
      case 'chipDenoise':
        s.denoise = on ? 0.55 : 0;
        if (controls) { controls.denoise.input.value = on ? 55 : 0; controls.denoise.sync(); }
        toast(on ? '时域降噪已开启' : '时域降噪已关闭');
        break;
    }
  }

  // ---------- 拍照 ----------
  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // ---------- 无边框窗口的交通灯 ----------
  function setupWindowControls() {
    const box = document.getElementById('winControls');
    if (!box) return;
    const api = window.lumen;
    if (!api || typeof api.winClose !== 'function') { box.hidden = true; return; }
    box.hidden = false;
    document.getElementById('wcClose').addEventListener('click', () => api.winClose());
    document.getElementById('wcMin').addEventListener('click', () => api.winMinimize());
    document.getElementById('wcMax').addEventListener('click', async () => {
      const max = await api.winToggleMax();
      document.body.classList.toggle('is-max', !!max);
    });
    if (typeof api.onMaxChanged === 'function') {
      api.onMaxChanged((v) => document.body.classList.toggle('is-max', !!v));
    }
    api.winIsMax().then((v) => document.body.classList.toggle('is-max', !!v)).catch(() => {});
  }

  function canvasBlob(canvas, type = 'image/png', quality) {
    return new Promise((res) => canvas.toBlob(res, type, quality));
  }

  // 浏览器原生下载：直接落到系统「下载」文件夹，不弹任何对话框
  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  async function snapshot() {
    if (!state.video || !state.pipeline) return;
    const p = state.pipeline;
    // 抓"处理之后"的画面（含超分/降噪/防抖/防果冻），而不是原始帧
    const frame = p.readStream(p.outW, p.outH);
    if (!frame) { toast('还没有可用画面', 'error'); return; }
    const c = document.createElement('canvas');
    c.width = frame.w; c.height = frame.h;
    const ctx = c.getContext('2d');
    const img = new ImageData(new Uint8ClampedArray(frame.buf.buffer, frame.buf.byteOffset, frame.buf.length), frame.w, frame.h);
    ctx.putImageData(img, 0, 0);
    const blob = await canvasBlob(c, 'image/png');
    if (!blob) return;
    const name = `LumenScope-${timestamp()}.png`;
    const r = await host.saveBlob(name, blob);
    if (r && r.ok) {
      const shown = String(r.path || '').split(/[\\/]/).slice(-2).join('/');
      toast(`已保存 · ${shown || name}`, 'ok');
    } else {
      toast('保存失败：' + (r && r.error ? r.error : '未知错误'), 'error');
    }
  }

  // ---------- 录制 ----------
  function toggleRecording() {
    if (state.recorder) stopRecording();
    else startRecording();
  }

  function startRecording() {
    if (!state.stream) return;
    const mimes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const mimeType = mimes.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mimeType) { toast('当前环境不支持录制', 'error'); return; }
    try {
      // 录"处理之后"的画面（超分/防抖/降噪都在里面），而不是原始摄像头流；
      // 抓不到画布流时才退回原始流。
      let source = null;
      try {
        const fps = state.pipeline?.settings.targetFps || 30;
        source = el.canvas.captureStream(fps);
      } catch (_) { source = null; }
      state.recChunks = [];
      state.recorder = new MediaRecorder(source || state.stream, { mimeType, videoBitsPerSecond: 12_000_000 });
      state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
      state.recorder.onstop = async () => {
        const type = state.recorder?.mimeType || mimeType;
        const blob = new Blob(state.recChunks, { type });
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const name = `LumenScope-${timestamp()}.${ext}`;
        if (!blob.size) { toast('录制为空，未保存', 'error'); return; }
        const r = await host.saveBlob(name, blob);
        toast(r && r.ok ? `录制已保存 · ${name}` : '录制保存失败：' + (r && r.error || ''), r && r.ok ? 'ok' : 'error');
      };
      state.recorder.start(1000);
      state.recStart = Date.now();
      document.body.classList.add('is-recording');
      el.recBadge.hidden = false;
      el.btnRecord.title = '停止录制';
      state.recTimer = setInterval(() => {
        const s = Math.floor((Date.now() - state.recStart) / 1000);
        el.recTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }, 500);
      toast('开始录制');
    } catch (e) {
      state.recorder = null;
      toast('无法开始录制：' + e.message, 'error');
    }
  }

  function stopRecording(silent) {
    if (state.recTimer) { clearInterval(state.recTimer); state.recTimer = 0; }
    document.body.classList.remove('is-recording');
    el.recBadge.hidden = true;
    el.btnRecord.title = '录制  ⌘R';
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
      if (!silent) toast('录制已停止');
    }
    state.recorder = null;
  }

  // ---------- 虚拟摄像头 ----------
  function setVcamUI(stateName, hint) {
    el.btnVcam.dataset.state = stateName;
    const labels = {
      off: ['作为虚拟摄像头输出', '把处理后的画面给会议/直播软件'],
      starting: ['正在启动…', '正在唤起虚拟摄像头驱动'],
      live: ['正在作为虚拟摄像头输出', hint || 'OBS Virtual Camera'],
      error: ['启动失败', hint || '点击重试'],
    };
    const [b, i] = labels[stateName] || labels.off;
    el.vcamLabel.textContent = b;
    el.vcamHint.textContent = i;
    el.vcamMeta.textContent = stateName === 'live' ? '已输出' : stateName === 'starting' ? '启动中' : stateName === 'error' ? '失败' : '未启动';
  }

  async function toggleVcam() {
    if (!host.canVcam) {
      toast('当前环境不支持虚拟摄像头输出', 'error', 4000);
      return;
    }
    if (state.vcamOn) { await stopVcam(); return; }
    await startVcam();
  }

  async function startVcam() {
    if (!state.pipeline || !state.video) { toast('请先连接摄像头', 'error'); return; }
    setVcamUI('starting');
    try {
      // 关键：把当前输出档位告诉驱动。
      // OBS 虚拟摄像头的格式在打开时就定死，不传就会退回默认 720p。
      const p = state.pipeline;
      const want = { width: p.outW, height: p.outH, fps: p.settings.targetFps || 30 };
      const st = await host.vcamStart(want);
      const wsUrl = st && (st.wsUrl || st.ws);
      if (!wsUrl) {
        setVcamUI('error', st && st.error ? String(st.error).slice(0, 60) : '驱动未就绪');
        toast('虚拟摄像头启动失败：' + (st && st.error ? st.error : '未知原因'), 'error', 6000);
        return;
      }
      const streamer = new window.LumenStreamer.Streamer();
      const conn = await streamer.connect(wsUrl);
      if (!conn.ok) {
        setVcamUI('error', conn.error);
        toast('推送连接失败：' + conn.error, 'error', 5000);
        await host.vcamStop();
        return;
      }
      state.streamer = streamer;
      state.vcamOn = true;
      const dims = (st.width && st.height) ? `${st.width}×${st.height}@${st.fps || want.fps}` : `${want.width}×${want.height}@${want.fps}`;
      setVcamUI('live', dims);
      toast(`虚拟摄像头已开启 · ${dims}`, 'ok', 4200);
    } catch (e) {
      setVcamUI('error', String(e.message || e).slice(0, 60));
      toast('虚拟摄像头异常：' + (e.message || e), 'error', 5000);
    }
  }

  async function stopVcam(opts = {}) {
    if (state.streamer) { state.streamer.disconnect(); state.streamer = null; }
    state.vcamOn = false;
    try { await host.vcamStop(); } catch (_) {}
    setVcamUI('off');
    if (!opts.silent) toast('虚拟摄像头已关闭');
  }

  async function restartVcam() {
    if (!state.vcamOn) return;
    await stopVcam();
    await startVcam();
  }

  // ---------- 电子变焦（数字放大 + 平移） ----------
  // 只改流水线的取样区域（warp 阶段的 uUserZoom/uUserPan），
  // 不放大像素 => 变焦后看到的仍是原生分辨率细节，不会像"放大截图"那样糊。
  const ZOOM_MAX = 8;
  const zoom = { level: 1, panX: 0, panY: 0 };

  function zoomClampPan() {
    const lim = Math.max(0, 0.5 * (1 - 1 / zoom.level));
    zoom.panX = Math.max(-lim, Math.min(lim, zoom.panX));
    zoom.panY = Math.max(-lim, Math.min(lim, zoom.panY));
    if (zoom.level <= 1.0001) { zoom.panX = 0; zoom.panY = 0; }
  }

  function zoomPaint() {
    const p = state.pipeline;
    if (p) {
      p.settings.userZoom = zoom.level;
      p.settings.userPanX = zoom.panX;
      p.settings.userPanY = zoom.panY;
    }
    const pct = el.zoomPct;
    if (pct) pct.textContent = zoom.level < 1.05 ? '1.0×' : zoom.level.toFixed(1) + '×';
    if (el.canvas) {
      el.canvas.classList.toggle('is-zoomed', zoom.level > 1.0001);
      // 视图原点变了 -> 历史帧对不上，重建累积，避免切换瞬间拖影
      if (p) p.resetAll();
    }
    if (el.zoomIn) el.zoomIn.disabled = zoom.level >= ZOOM_MAX - 1e-3;
    if (el.zoomOut) el.zoomOut.disabled = zoom.level <= 1.0001;
  }

  // anchor：视口内归一化坐标（0..1），给定时以该点为中心缩放
  function setZoom(level, anchor) {
    const next = Math.max(1, Math.min(ZOOM_MAX, level));
    const prev = zoom.level;
    if (Math.abs(next - prev) < 1e-4) return;
    if (anchor && prev > 0) {
      // 让锚点下的画面内容保持不动：pan 按 (1/z0 - 1/z1) 补偿
      const k = (1 / prev) - (1 / next);
      zoom.panX += (anchor.x - 0.5) * k;
      zoom.panY += (anchor.y - 0.5) * k;
    }
    zoom.level = next;
    zoomClampPan();
    zoomPaint();
  }

  function zoomReset() {
    if (zoom.level === 1 && !zoom.panX && !zoom.panY) return;
    zoom.level = 1; zoom.panX = 0; zoom.panY = 0;
    zoomPaint();
  }

  // 鼠标在画面上的位置 -> 图像归一化坐标（扣掉 present 的等比 letterbox）
  function pointerToImage(clientX, clientY) {
    const canvas = el.canvas;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const p = state.pipeline;
    const outAspect = p && p.outW && p.outH ? p.outW / p.outH : 16 / 9;
    const cw = r.width, ch = r.height;
    let iw = cw, ih = ch;
    if (cw / ch > outAspect) iw = ch * outAspect; else ih = cw / outAspect;
    const x0 = r.left + (cw - iw) / 2, y0 = r.top + (ch - ih) / 2;
    const u = (clientX - x0) / iw, v = (clientY - y0) / ih;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { x: u, y: v };
  }

  function setupZoom() {
    const vp = el.viewport, canvas = el.canvas;
    if (!vp || !canvas) return;

    vp.addEventListener('wheel', (e) => {
      if (el.overlay.dataset.state !== 'live') return;
      e.preventDefault();
      const anchor = pointerToImage(e.clientX, e.clientY);
      const step = Math.exp(-e.deltaY * 0.0022);
      setZoom(zoom.level * step, anchor);
    }, { passive: false });

    // 拖拽平移（放大后才生效，1× 时保持"拖不动"的直觉）
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (el.overlay.dataset.state !== 'live' || zoom.level <= 1.0001 || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, panX: zoom.panX, panY: zoom.panY, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('is-panning');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const r = canvas.getBoundingClientRect();
      const p = state.pipeline;
      const outAspect = p && p.outW && p.outH ? p.outW / p.outH : 16 / 9;
      let iw = r.width, ih = r.height;
      if (r.width / r.height > outAspect) iw = r.height * outAspect; else ih = r.width / outAspect;
      // 屏幕像素位移 -> 图像 UV 位移（除以显示尺寸再除以变焦倍率）
      zoom.panX = drag.panX - (e.clientX - drag.x) / (iw * zoom.level);
      zoom.panY = drag.panY - (e.clientY - drag.y) / (ih * zoom.level);
      zoomClampPan();
      if (state.pipeline) {
        state.pipeline.settings.userPanX = zoom.panX;
        state.pipeline.settings.userPanY = zoom.panY;
      }
    });
    const endDrag = (e) => {
      if (!drag) return;
      if (e && e.pointerId !== drag.id) return;
      drag = null;
      canvas.classList.remove('is-panning');
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('dblclick', () => { if (el.overlay.dataset.state === 'live') zoomReset(); });

    if (el.zoomIn) el.zoomIn.addEventListener('click', () => setZoom(zoom.level * 1.35, { x: 0.5, y: 0.5 }));
    if (el.zoomOut) el.zoomOut.addEventListener('click', () => setZoom(zoom.level / 1.35, { x: 0.5, y: 0.5 }));
    if (el.zoomVal) el.zoomVal.addEventListener('click', zoomReset);

    zoomPaint();
  }

  // ---------- 全屏 / 面板 ----------
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const target = el.viewport;
      (target.requestFullscreen ? target.requestFullscreen() : Promise.reject()).catch(() => {
        if (window.lumen) toast('全屏操作请使用 F11', 'info');
      });
    } else {
      document.exitFullscreen();
    }
  }

  function togglePanel(force) {
    const open = force !== undefined ? force : el.stage.classList.contains('panel-closed');
    el.stage.classList.toggle('panel-closed', !open);
    el.panel.dataset.open = String(open);
    el.btnPanel.setAttribute('aria-expanded', String(open));
  }

  // ---------- 启动 ----------
  async function refreshDevices() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setOverlay('error', {
        title: '此环境不支持摄像头采集',
        body: '请用 Electron 版打开，或在 Chrome / Edge 中访问本页面（需要安全上下文）。',
      });
      return [];
    }
    try {
      const cams = await enumerateDevices();
      state.available = cams;
      renderDeviceList(cams);
      renderSelect(cams, state.deviceId);
      return cams;
    } catch (e) {
      renderDeviceList([]);
      return [];
    }
  }

  function bindShell() {
    el.btnSnapshot.addEventListener('click', snapshot);
    el.btnRecord.addEventListener('click', toggleRecording);
    el.btnFullscreen.addEventListener('click', toggleFullscreen);
    el.btnPanel.addEventListener('click', () => togglePanel());
    el.btnRetry.addEventListener('click', async () => {
      const cams = await refreshDevices();
      const cam = cams.find(c => c.deviceId === state.deviceId) || pickPreferred(cams);
      if (cam) openCamera(cam); else setOverlay('idle');
    });
    el.btnChooseOther.addEventListener('click', async () => {
      const cams = await refreshDevices();
      const cam = pickPreferred(cams);
      if (cam) openCamera(cam); else setOverlay('idle');
    });
    el.btnRediscover.addEventListener('click', async () => {
      el.btnRediscover.textContent = '正在搜索…';
      const cams = await refreshDevices();
      el.btnRediscover.textContent = '重新搜索设备';
      if (!cams.length) toast('没有找到视频设备', 'error');
    });
    el.cameraSelect.addEventListener('change', () => {
      const cam = state.available.find(c => c.deviceId === el.cameraSelect.value);
      if (cam) openCamera(cam);
    });
    el.btnReveal.addEventListener('click', async () => {
      const r = await host.revealMedia();
      if (r && r.ok === false) toast('打开目录失败：' + (r.error || ''), 'error');
    });

    window.addEventListener('resize', () => {
      const p = state.pipeline;
      if (p) p.resize();
    });

    window.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === 'F11') { e.preventDefault(); if (!window.lumen) toggleFullscreen(); return; }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); snapshot(); }
      if (meta && e.key.toLowerCase() === 'r') { e.preventDefault(); toggleRecording(); }
      // 数字变焦：+ / - 逐级缩放，0 复位（不抢输入框里的按键）
      const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA');
      if (!meta && !typing && el.overlay.dataset.state === 'live') {
        if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom.level * 1.35, { x: 0.5, y: 0.5 }); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom.level / 1.35, { x: 0.5, y: 0.5 }); }
        else if (e.key === '0') { e.preventDefault(); zoomReset(); }
      }
      if (e.key === 'Escape' && el.stage.classList.contains('panel-closed')) togglePanel(true);
      if (!meta && !e.altKey) {
        if (e.key === '1') setResolution(720);
        if (e.key === '2') setResolution(1080);
        if (e.key === '3') setResolution(1440);
      }
    });

    el.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      toast('图形上下文丢失，正在恢复…', 'error');
      state.pipeline = null;
    });

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        const cams = await refreshDevices();
        if (!state.stream && cams.length) toast('检测到新设备', 'info');
      });
    }
  }

  async function boot() {
    document.body.classList.toggle('is-electron', !!window.lumen);
    initPipeline();
    bindShell();

    // 首帧先给一个静态渐变，避免黑闪
    const p = state.pipeline;
    p.setOutput(1080);
    p.gl.clearColor(0, 0, 0, 1);
    p.gl.clear(p.gl.COLOR_BUFFER_BIT);

    const cams = await refreshDevices();
    if (cams.length) {
      const cam = pickPreferred(cams);
      if (!state.pipeline.settings.stabilise) { /* noop */ }
      openCamera(cam);
    } else {
      setOverlay('idle');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
