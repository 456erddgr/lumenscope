#!/usr/bin/env python3
"""LumenScope 虚拟摄像头宿主。

从 stdin 读取定长二进制帧（BNF 协议），通过 pyvirtualcam 推给 OBS Virtual Camera 驱动。
协议：
  帧头 16 字节：magic(4) = b'LSC1' | w(u32 LE) | h(u32 LE) | fps(u16 LE) | fmt(u16 LE)
  fmt: 0 = RGBA8, 1 = RGB24
  随后是定长像素数据。EOF 或 stdin 关闭时退出。
启动成功后向 stdout 打印一行 `READY <device>`；出错打印 `ERROR <msg>` 到 stderr 并退出。
"""
import sys, struct, os

MAGIC = b'LSC1'

def main():
    try:
        import numpy as np
        import pyvirtualcam
    except Exception as e:
        print(f"ERROR 缺少依赖: {e}", file=sys.stderr, flush=True)
        return 2

    inp = sys.stdin.buffer
    cam = None
    cur_w = cur_h = cur_fps = 0
    cur_fmt = -1
    frame_count = 0

    # 启动即按默认规格打开虚拟摄像头，先打印 READY，让前端知道可以开始推流。
    # （此前只在收到首帧后才打开，导致 READY 永远发不出去，前端一直等到超时。）
    DEFAULT_W = int(os.environ.get('LUMEN_VCAM_W', '1280'))
    DEFAULT_H = int(os.environ.get('LUMEN_VCAM_H', '720'))
    DEFAULT_FPS = int(os.environ.get('LUMEN_VCAM_FPS', '30'))
    DEFAULT_FMT = 0   # 0 = RGBA8（浏览器 WebGL readPixels 直出，宿主去 alpha 后送驱动）

    def open_cam(w, h, fps, fmt):
        nonlocal cam, cur_w, cur_h, cur_fps, cur_fmt
        old = cam
        cam = None
        cur_w = cur_h = cur_fps = 0
        cur_fmt = -1
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        cam = pyvirtualcam.Camera(width=w, height=h, fps=fps,
                                 fmt=pyvirtualcam.PixelFormat.RGB, backend='obs')
        cur_w, cur_h, cur_fps, cur_fmt = w, h, fps, fmt
        print(f"READY {cam.device} {w}x{h}@{fps} fmt={fmt}", flush=True)

    # 收到终止信号时先关摄像头再退出，避免驱动被"半开"状态占住
    import signal

    def _bye(signum, frame):
        raise SystemExit(0)
    for sig in ('SIGTERM', 'SIGBREAK', 'SIGINT'):
        try:
            signal.signal(getattr(signal, sig), _bye)
        except Exception:
            pass

    try:
        open_cam(DEFAULT_W, DEFAULT_H, DEFAULT_FPS, DEFAULT_FMT)
    except Exception as e:
        print(f"ERROR 无法打开虚拟摄像头: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return 3

    def read_exact(n):
        """管道 read(n) 不保证读满 n 字节，必须循环累积，否则帧会错位。"""
        chunks = []
        got = 0
        while got < n:
            b = inp.read(n - got)
            if not b:
                return b'' if not chunks else b''.join(chunks)
            chunks.append(b)
            got += len(b)
        return b''.join(chunks)

    try:
        while True:
            head = read_exact(16)
            if not head or len(head) < 16:
                break
            if head[:4] != MAGIC:
                print("ERROR 帧同步丢失", file=sys.stderr, flush=True)
                break
            w, h, fps, fmt = struct.unpack('<IIHH', head[4:16])
            bpp = 4 if fmt == 0 else 3
            need = w * h * bpp
            data = read_exact(need)
            if len(data) < need:
                break
            if cam is None or (w, h, fps, fmt) != (cur_w, cur_h, cur_fps, cur_fmt):
                open_cam(w, h, fps, fmt)

            arr = np.frombuffer(data, dtype=np.uint8).reshape(h, w, bpp)
            if fmt == 0:
                # RGBA → RGB。驱动只吃 RGB，多出来的 alpha 通道只能丢掉。
                # 用切片 + ascontiguousarray 是一次内存拷贝，2K 下约 14 MB/帧。
                rgb = np.ascontiguousarray(arr[:, :, :3])
                cam.send(rgb)
            elif fmt == 1:
                cam.send(arr)              # RGB 直送
            else:
                cam.send(np.ascontiguousarray(arr[:, :, ::-1]))  # BGR 输入时翻转
            frame_count += 1
            # sleep_until_next_frame 会等到"下一帧该发的时刻"才返回。
            # 配合前端 30fps 的节流，这里其实没有等待余量；真要卡顿就由背压丢帧。
            cam.sleep_until_next_frame()
    except BrokenPipeError:
        pass
    except Exception as e:
        print(f"ERROR {type(e).__name__}: {e}", file=sys.stderr, flush=True)
    finally:
        if cam is not None:
            try:
                cam.close()
                cam = None
            except Exception:
                pass
        print(f"BYE frames={frame_count}", file=sys.stderr, flush=True)
    return 0

if __name__ == '__main__':
    sys.exit(main())
