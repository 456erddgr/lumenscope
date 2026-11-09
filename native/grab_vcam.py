"""读虚拟摄像头并保存一帧 PNG，用于肉眼确认输出内容。"""
import sys, numpy as np
try:
    import cv2
except Exception as e:
    print("no cv2", e); sys.exit(2)

out = sys.argv[1] if len(sys.argv) > 1 else 'vcam_out.png'
# 枚举所有摄像头，找到能出图的（虚拟摄像头通常是较高索引）
best = None; best_idx = -1
for idx in range(6):
    cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap.release(); continue
    ok, f = cap.read()
    if ok and f is not None:
        m = float(f.mean())
        print(f"index {idx}: shape={f.shape} mean={m:.2f}")
        if best is None or (m > best.mean()):
            best = f; best_idx = idx
    cap.release()
if best is None:
    print("no readable camera"); sys.exit(1)
# 不用 cv2.imwrite（对含中文的路径会静默失败），改用 PIL 或裸写 PPM
try:
    from PIL import Image
    Image.fromarray(best[:, :, ::-1]).save(out)
    print(f"saved {out} via PIL, index {best_idx}, mean={best.mean():.2f}, std={best.std():.2f}")
except Exception as e1:
    ppm = out.rsplit('.', 1)[0] + '.ppm'
    with open(ppm, 'wb') as f:
        f.write(b'P6\n%d %d\n255\n' % (best.shape[1], best.shape[0]))
        f.write(best[:, :, ::-1].tobytes())
    print(f"saved {ppm} via PPM (PIL failed: {e1}), index {best_idx}")
# 同时输出直方图摘要，判断是否有真实内容而非纯黑
h = cv2.calcHist([best],[1],None,[16],[0,256]).flatten()
print("G histogram:", [int(x) for x in h])
