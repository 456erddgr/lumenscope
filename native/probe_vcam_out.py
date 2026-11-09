# -*- coding: utf-8 -*-
"""
读虚拟摄像头，报告：分辨率、帧率、亮度、画面是否随时间和变化、清晰度。
用来验证 LumenScope 的虚拟摄像头输出是否真的按目标分辨率、输出处理后的实时画面。

用法：
  set WANT_W=2560 & set WANT_H=1440 & py -3.11 native/probe_vcam_out.py out.png
"""
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

try:
    import cv2
    import numpy as np
except Exception as e:
    print("缺少依赖:", e)
    sys.exit(2)

WANT_W = int(os.environ.get('WANT_W', '0') or 0)
WANT_H = int(os.environ.get('WANT_H', '0') or 0)
out_path = sys.argv[1] if len(sys.argv) > 1 else None

BACKENDS = [(cv2.CAP_MSMF, 'MSMF'), (cv2.CAP_DSHOW, 'DSHOW'), (cv2.CAP_ANY, 'ANY')]


def open_cam(idx):
    """依次尝试各后端，返回 (cap, backend_name)。"""
    for backend, name in BACKENDS:
        cap = cv2.VideoCapture(idx, backend)
        if cap.isOpened():
            return cap, name
        cap.release()
    return None, None


def scan():
    """列出所有能打开的视频设备及其分辨率。"""
    found = []
    for idx in range(8):
        cap, name = open_cam(idx)
        if cap is None:
            continue
        if WANT_W:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, WANT_W)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, WANT_H)
        ok, f = cap.read()
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()
        if ok and f is not None and w > 0:
            found.append((idx, w, h, name))
    return found


print("=== 扫描摄像头 ===")
cands = scan()
for idx, w, h, name in cands:
    print(f"  index {idx}: {w}x{h}  ({name})")

if not cands:
    print("没有可用摄像头")
    sys.exit(1)

# 优先选尺寸匹配 WANT 的；否则选最大的
target = None
if WANT_W and WANT_H:
    exact = [c for c in cands if (c[1], c[2]) == (WANT_W, WANT_H)]
    if exact:
        target = exact[0]
if target is None:
    target = max(cands, key=lambda x: x[1] * x[2])

idx, w0, h0, bname = target
print(f"\n=== 读取 index {idx} ({w0}x{h0}, {bname}) ===")

cap, bname = open_cam(idx)
if cap is None:
    print("  打开失败")
    sys.exit(1)
print(f"  使用后端: {bname}")
if WANT_W:
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, WANT_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, WANT_H)

w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = cap.get(cv2.CAP_PROP_FPS)
print(f"  协商尺寸: {w}x{h} @ {fps:.0f}fps")

frames = []
t0 = time.time()
while len(frames) < 60 and time.time() - t0 < 4:
    ok, f = cap.read()
    if ok and f is not None:
        frames.append(f)
cap.release()

if not frames:
    print("  读不到帧")
    sys.exit(1)

got_h, got_w = frames[0].shape[:2]
elapsed = time.time() - t0
meas_fps = len(frames) / max(1e-6, elapsed)
arr = np.stack(frames).astype(np.float32)
lum = arr.mean(axis=(1, 2, 3))
diff = float(np.abs(np.diff(arr, axis=0)).mean())

print(f"  实际帧数: {len(frames)}  (≈{meas_fps:.1f} fps)")
print(f"  实际分辨率: {got_w}x{got_h}")
print(f"  平均亮度: {lum.mean():.1f}  (min {lum.min():.1f} / max {lum.max():.1f})")
verdict = "在变化 = 实时" if diff > 0.5 else "几乎不动 = 静态"
print(f"  相邻帧平均差异: {diff:.3f}  ({verdict})")

gray = cv2.cvtColor(frames[-1], cv2.COLOR_BGR2GRAY).astype(np.float32)
print(f"  清晰度(拉普拉斯方差): {cv2.Laplacian(gray, cv2.CV_32F).var():.0f}")

if out_path:
    cv2.imwrite(out_path, frames[-1])
    print(f"  已保存: {out_path}")
