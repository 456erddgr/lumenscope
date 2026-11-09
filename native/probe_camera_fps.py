# -*- coding: utf-8 -*-
"""
用 OpenCV 直接测 USB 摄像头的真实帧率，并检查曝光设置。
如果真实帧率远低于 30，说明摄像头在长曝光（光线不足），
这时候任何软件都拉不出 30fps —— 除非让它降低分辨率或提高增益。
"""
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

import cv2

CAP = {
    'W': cv2.CAP_PROP_FRAME_WIDTH,
    'H': cv2.CAP_PROP_FRAME_HEIGHT,
    'FPS': cv2.CAP_PROP_FPS,
    'EXPOSURE': cv2.CAP_PROP_EXPOSURE,
    'AUTO_EXP': cv2.CAP_PROP_AUTO_EXPOSURE,
    'GAIN': cv2.CAP_PROP_GAIN,
    'BRIGHTNESS': cv2.CAP_PROP_BRIGHTNESS,
    'BUFFERSIZE': cv2.CAP_PROP_BUFFERSIZE,
}


def probe(idx, w=None, h=None, mjpg=False):
    """打开设备，返回 (cap, 实际宽, 实际高, 声明帧率)。"""
    cap = cv2.VideoCapture(idx, cv2.CAP_MSMF)
    if not cap.isOpened():
        cap.release()
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap.release()
        return None
    if w and h:
        cap.set(CAP['W'], w)
        cap.set(CAP['H'], h)
    cap.set(CAP['BUFFERSIZE'], 1)
    aw = int(cap.get(CAP['W']))
    ah = int(cap.get(CAP['H']))
    fps = cap.get(CAP['FPS'])
    return cap, aw, ah, fps


def measure_fps(idx, seconds=4.0):
    cap, aw, ah, declared = probe(idx, 1280, 720)
    if cap is None:
        print(f"  index {idx}: 打不开")
        return
    # 读掉前几帧（自动曝光在开头会调整）
    for _ in range(10):
        cap.read()

    exp = cap.get(CAP['EXPOSURE'])
    gain = cap.get(CAP['GAIN'])
    auto_exp = cap.get(CAP['AUTO_EXP'])

    n = 0
    t0 = time.time()
    prev = None
    changed = 0
    while time.time() - t0 < seconds:
        ok, f = cap.read()
        if not ok:
            continue
        n += 1
        if prev is not None:
            import numpy as np
            if float(np.abs(f.astype('int16') - prev.astype('int16')).mean()) > 0.5:
                changed += 1
        prev = f
    dt = time.time() - t0
    cap.release()

    real = n / dt
    print(f"  index {idx}: 声明 {aw}x{ah}@{declared:.0f}fps")
    print(f"    读帧速率   : {real:.1f} fps  ({n} 帧 / {dt:.1f}s)")
    print(f"    画面变化率 : {changed / dt:.1f} fps  ← 这个才是肉眼看到的流畅度")
    print(f"    曝光       : {exp:.1f}   增益 {gain:.1f}   自动曝光模式 {auto_exp:.1f}")


print("=== 逐个设备测真实帧率 ===")
for i in range(4):
    try:
        measure_fps(i)
    except Exception as e:
        print(f"  index {i}: {type(e).__name__} {e}")
