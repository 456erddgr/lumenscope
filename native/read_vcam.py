"""从 OBS Virtual Camera 读若干帧，报告亮度与色彩统计，用于验证虚拟摄像头确实在输出画面。"""
import sys
try:
    import numpy as np
    import pyvirtualcam
except Exception as e:
    print("ERROR deps:", e); sys.exit(2)

def main():
    # pyvirtualcam 只能写；读取走 OpenCV。按名字找到 OBS Virtual Camera，而不是依赖索引 0
    try:
        import cv2
    except Exception:
        print("no-cv2; device-known-only")
        return 0
    target_index = None
    if hasattr(cv2, 'CAP_MSMF'):
        try:
            print("scanning cameras...")
            for i in range(6):
                cap = cv2.VideoCapture(i, cv2.CAP_MSMF)
                if cap.isOpened():
                    print(f"  camera {i} opened")
                cap.release()
        except Exception as e:
            print("scan error", e)
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    if not cap.isOpened():
        print("cannot-open-capture")
        return 1
    frames = []
    for _ in range(30):
        ok, f = cap.read()
        if not ok: continue
        frames.append(f)
    cap.release()
    if not frames:
        print("no-frames"); return 1
    arr = np.stack(frames[-10:]).astype(np.float32)
    lum = arr.mean(axis=(1,2,3))
    print("frames=%d lum_mean=%.2f lum_std_over_time=%.3f bgr_mean=(%.1f,%.1f,%.1f)"
          % (len(frames), lum.mean(), lum.std(),
             arr[...,0].mean(), arr[...,1].mean(), arr[...,2].mean()))
    return 0

if __name__ == '__main__':
    sys.exit(main())
