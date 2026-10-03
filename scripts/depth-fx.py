#!/usr/bin/env python3
"""SharedCut's depth effects for export: Background light, Fog, Lens blur and Glow driven by a depth run.

    depth-fx.py <job.json>                                     bake one clip (written by server/media.ts)
    depth-fx.py --parity <params.json> <rgb.png> <depth.png> <out.png>
    depth-fx.py --selftest

The math is docs/superpowers/specs/2026-10-03-depth-fx-math.md, sections 0-6, the same formulas the WebGL2
preview (src/services/depthFx.ts) runs; a parity check feeds both the same picture. A bake reads the clip's
pre-depth frames (grade, the effects before Depth, Stabilize) from an FFmpeg decoder the server builds, the
run's depth masters frame by frame, and writes ProRes 4444 at source resolution through an FFmpeg encoder.
Runs in .venv-mask (FRAME_LINE_DEPTH_PYTHON); device cuda, then mps, then cpu, always float32.
"""
import json
import math
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading

import numpy as np
import torch
import torch.nn.functional as F

GOLDEN = 2.39996323
DEFAULTS = dict(amount=100, blur=0, focus=30, range=10, nearBlur=60, bokeh=40, fog=0, fogStart=35, fogDensity=50,
                fogHue=210, fogSaturation=10, fogBrightness=85, fogHorizon=30, glow=0, glowThreshold=70, glowRadius=30,
                glowStart=40, light=0, lightStart=40, lightSoftness=30, bgExposure=0, bgSaturation=100, bgWarmth=0,
                bgContrast=100)


def pick_device():
    if os.environ.get("FRAME_LINE_DEPTH_DEVICE"):
        return torch.device(os.environ["FRAME_LINE_DEPTH_DEVICE"])
    return torch.device("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")


# --- The math (spec sections 0-6). Pictures are (3,H,W) float32, scalars (H,W). ---

def lum(c):
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def lin(c):
    return c.clamp(min=0) ** 2.2


def enc(c):
    return c.clamp(min=0) ** (1 / 2.2)


def smoothstep(a, b, t):
    b = max(b, a + 1e-4)
    x = ((t - a) / (b - a)).clamp(0, 1)
    return x * x * (3 - 2 * x)


def hsv(h, s, v):
    """HSV (hue in degrees) to display RGB."""
    h = (h % 360) / 60
    c = v * s
    x = c * (1 - abs(h % 2 - 1))
    r, g, b = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][min(5, int(h))]
    return [r + v - c, g + v - c, b + v - c]


def distance(stored, near, far):
    """Section 0: stored depth 0..1 to distance, 0 nearest and 1 farthest."""
    return ((near - stored) / max(near - far, 1e-4)).clamp(0, 1)


def sample(image, x, y):
    """Bilinear samples of (C,h,w) at pixel-centre coordinates x, y (texel i has its centre at i), clamped to the
    edge: the WebGL2 LINEAR + CLAMP_TO_EDGE lookup."""
    h, w = image.shape[-2:]
    grid = torch.stack([(x + .5) / w * 2 - 1, (y + .5) / h * 2 - 1], -1)[None]
    return F.grid_sample(image[None], grid, mode="bilinear", padding_mode="border", align_corners=False)[0]


def upsample_depth(I, depth, near, far, warp=None):
    """Section 1: joint-bilateral upsample of the w x h depth onto the H x W picture, as distance. `warp` is a
    row-major 2x3 source -> output pixel matrix (Stabilize); output pixels map back through its inverse."""
    _, H, W = I.shape
    h, w = depth.shape
    device, f32 = I.device, torch.float32
    guide, dist = lum(I), distance(depth, near, far)
    range_weight = -1 / (2 * .1 ** 2)
    if warp is None:
        # Unwarped, a tap's position and spatial weight depend on the column or the row alone: index whole rows and
        # columns of the tap tables instead of gathering every pixel (a quarter of the GPU passes at 4K).
        qx = (torch.arange(W, device=device, dtype=f32) + .5) * (w / W) - .5
        qy = (torch.arange(H, device=device, dtype=f32) + .5) * (h / H) - .5
        cx = (torch.arange(-2, w + 2, device=device, dtype=f32) + .5) * (W / w) - .5
        cy = (torch.arange(-2, h + 2, device=device, dtype=f32) + .5) * (H / h) - .5
        # Guide luminance at every tap centre once, on the depth grid widened by two texels each side.
        taps = sample(guide[None], cx[None].expand(h + 4, w + 4), cy[:, None].expand(h + 4, w + 4))[0]
        bx, by = qx.floor(), qy.floor()
        num, den = torch.zeros_like(guide), torch.zeros_like(guide)
        # A tap is clamped to the depth texture first; its weight and guide sample use the clamped texel, as the preview does.
        for j in (-1, 0, 1, 2):
            ty = (by + j).clamp(0, h - 1)
            wy = torch.exp(-(qy - ty) ** 2 / 2)[:, None]
            guide_rows, dist_rows = taps.index_select(0, (ty + 2).long()), dist.index_select(0, ty.long())
            for i in (-1, 0, 1, 2):
                tx = (bx + i).clamp(0, w - 1)
                weight = torch.exp((guide - guide_rows.index_select(1, (tx + 2).long())).square_().mul_(range_weight))
                weight.mul_(wy).mul_(torch.exp(-(qx - tx) ** 2 / 2)[None])
                num.addcmul_(weight, dist_rows.index_select(1, tx.long()))
                den.add_(weight)
        D = num / den.clamp(min=1e-30)
        weak = den < 1e-6
        if weak.any():
            D = torch.where(weak, distance(sample(depth[None], qx[None].expand(H, W), qy[:, None].expand(H, W))[0], near, far), D)
        return D
    y, x = torch.meshgrid(torch.arange(H, device=device, dtype=f32), torch.arange(W, device=device, dtype=f32), indexing="ij")
    a, b, c, d, e, f = [float(v) for v in warp]
    det = a * e - b * d
    ia, ib, id_, ie = e / det, -b / det, -d / det, a / det
    x, y = ia * (x - c) + ib * (y - f), id_ * (x - c) + ie * (y - f)
    inside = (x >= -.5) & (x <= W - .5) & (y >= -.5) & (y <= H - .5)
    qx, qy = (x + .5) * (w / W) - .5, (y + .5) * (h / H) - .5
    ty, tx = torch.meshgrid(torch.arange(-2, h + 2, device=device, dtype=f32), torch.arange(-2, w + 2, device=device, dtype=f32), indexing="ij")
    cx, cy = (tx + .5) * (W / w) - .5, (ty + .5) * (H / h) - .5
    taps = sample(guide[None], a * cx + b * cy + c, d * cx + e * cy + f)[0].flatten()  # Tap centres moved with the picture.
    dist = dist.flatten()
    bx, by = qx.floor().clamp(-1, w - 1), qy.floor().clamp(-1, h - 1)
    num, den = torch.zeros_like(guide), torch.zeros_like(guide)
    for j in (-1, 0, 1, 2):
        sy = (by + j).clamp(0, h - 1)
        for i in (-1, 0, 1, 2):
            sx = (bx + i).clamp(0, w - 1)
            weight = torch.exp(-((qx - sx) ** 2 + (qy - sy) ** 2) / 2)
            weight = weight * torch.exp((guide - taps[((sy + 2) * (w + 4) + sx + 2).long()]) ** 2 * range_weight)
            num += weight * dist[(sy * w + sx).long()]
            den += weight
    D = num / den.clamp(min=1e-30)
    weak = den < 1e-6
    if weak.any():
        D = torch.where(weak, distance(sample(depth[None], qx, qy)[0], near, far), D)
    return torch.where(inside, D, torch.zeros_like(D))


def area(image, height, width):
    return image if image.shape[-2:] == (height, width) else F.interpolate(image[None], size=(height, width), mode="area")[0]


def bilinear(image, height, width):
    return image if image.shape[-2:] == (height, width) else F.interpolate(image[None], size=(height, width), mode="bilinear", align_corners=False)[0]


def lens_blur(L2, D, p, taps):
    """Section 4: circle of confusion, then Gustafsson's single-pass gather at <= 960 px wide."""
    _, H, W = L2.shape
    R, focus, band = p["blur"] / 100 * .025 * W, p["focus"] / 100, p["range"] / 100 * .5
    delta = D - focus
    coc = R * ((delta.abs() - band) / .35).clamp(0, 1) * torch.where(delta < 0, p["nearBlur"] / 100, 1.0)
    Wb = min(W, 960)
    s = Wb / W
    Hb = round(H * s)
    small = area(torch.cat([L2, D[None], coc[None]]), Hb, Wb)
    Ls, Ds, cc, Rb = small[:3], small[3], small[4] * s, R * s
    B = Ls if Rb < 1 else gather(Ls, Ds, cc, Rb, p["bokeh"] / 100 * 8, taps)
    blend = (coc * s).clamp(0, 1)
    return L2 + (bilinear(B, H, W) - L2) * blend


def gather_taps(Rb, taps):
    """Radius and angle of every gather sample, in order: golden-angle steps with r += RS / r."""
    RS, angle, out = max(.5, Rb * Rb / (2 * taps)), 0.0, []
    r = RS
    while r < Rb:
        out.append((r, angle))
        angle += GOLDEN
        r += RS / r
    return out


def gather(Ls, Ds, cc, Rb, bokeh, taps, chunk=24):
    """Section 4's gather loop. Each step is acc = alpha * acc + beta with alpha = 1 + (1 - m) w / wsum and
    beta = m w L(sp), so a chunk of steps sampled at once folds into acc_end = P (acc + sum(beta / P_n)), P the running
    product of alpha: the same sum as one step at a time (see the selftest), in a few dozen GPU passes, not thousands."""
    _, Hb, Wb = Ls.shape
    stack = torch.cat([Ls, Ds[None], cc[None]])[None]
    xs = torch.arange(Wb, device=Ls.device, dtype=torch.float32)
    ys = torch.arange(Hb, device=Ls.device, dtype=torch.float32)
    weigh = lambda col: 1 + bokeh * (lum(col) - .7).clamp(min=0)
    wsum = weigh(Ls)
    acc = Ls * wsum
    steps = gather_taps(Rb, taps)
    for start in range(0, len(steps), chunk):
        part = steps[start:start + chunk]
        n = len(part)
        r, dx, dy = (torch.tensor(values, device=Ls.device, dtype=torch.float32)[:, None, None] for values in zip(*[(r, r * math.cos(a), r * math.sin(a)) for r, a in part]))
        # Every pixel samples at the same offset per step: one bilinear, edge-clamped read per step, all steps at once.
        grid = torch.stack(torch.broadcast_tensors((xs[None, None, :] + dx + .5) / Wb * 2 - 1, (ys[None, :, None] + dy + .5) / Hb * 2 - 1), -1)
        at = F.grid_sample(stack.expand(n, -1, -1, -1), grid, mode="bilinear", padding_mode="border", align_corners=False)
        Lsp, Dsp, csp = at[:, :3], at[:, 3], at[:, 4]
        reach = torch.where(Dsp > Ds, torch.minimum(csp, 2 * cc), csp)  # A farther sample can't spill onto a nearer one.
        x = (reach - (r - .5)).clamp(0, 1)  # smoothstep(r - .5, r + .5, reach)
        m = x * x * (3 - 2 * x)
        weight = weigh(Lsp.transpose(0, 1))
        before = wsum + torch.cumsum(weight, 0) - weight
        alpha = 1 + (1 - m) * weight / before
        P = torch.cumprod(alpha, 0)
        acc = P[-1] * (acc + (Lsp * (m * weight / P)[:, None]).sum(0))
        wsum = wsum + weight.sum(0)
    return acc / wsum


def glow(L3, D, p):
    """Section 5: bright pass weighted to the far side, separable Gaussian at <= 480 px wide, added."""
    _, H, W = L3.shape
    th, start = p["glowThreshold"] / 100, p["glowStart"] / 100
    G = L3 * ((lum(enc(L3)) - th) / max(1 - th, .01)).clamp(0, 1) * smoothstep(start, start + .15, D)
    Wq = min(W, 480)
    Hq = round(H * Wq / W)
    sigma = p["glowRadius"] / 100 * .04 * W * (Wq / W)
    radius = min(63, math.floor(3 * sigma))  # Taps |k| <= 3 sigma, at most 63 a side: the preview's limit.
    kernel = torch.exp(-torch.arange(-radius, radius + 1, device=L3.device, dtype=torch.float32) ** 2 / (2 * sigma * sigma))
    kernel = (kernel / kernel.sum()).repeat(3, 1, 1)
    g = area(G, Hq, Wq)[None]
    g = F.conv2d(F.pad(g, (radius, radius, 0, 0), mode="replicate"), kernel[:, :, None, :], groups=3)
    g = F.conv2d(F.pad(g, (0, 0, radius, radius), mode="replicate"), kernel[:, :, :, None], groups=3)[0]
    return L3 + p["glow"] / 100 * 1.5 * bilinear(g, H, W)


def depth_fx(I, depth, p, near, far, taps=96, warp=None):
    """The whole effect on one frame: I display RGB 0..1 (3,H,W), depth the stored values 0..1 (h,w)."""
    p = {**DEFAULTS, **p}
    if not any(p[key] > 0 for key in ("light", "fog", "blur", "glow")) or p["amount"] <= 0:
        return I
    _, H, _ = I.shape
    D = upsample_depth(I, depth, near, far, warp)
    L = lin(I)
    if p["light"] > 0:
        start = p["lightStart"] / 100
        a = p["light"] / 100 * smoothstep(start, start + max(p["lightSoftness"] / 100, .01), D)
        k = p["bgWarmth"] / 100
        graded = L * 2 ** p["bgExposure"] * torch.tensor([1 + .12 * k, 1 + .02 * k, 1 - .12 * k], device=I.device).view(3, 1, 1)
        graded = .18 * (graded.clamp(min=0) / .18) ** (p["bgContrast"] / 100)
        Y = lum(graded)
        graded = Y + (graded - Y) * p["bgSaturation"] / 100
        L = L + (graded.clamp(min=0) - L) * a
    if p["fog"] > 0:
        start, kd = p["fogStart"] / 100, 1 + 9 * p["fogDensity"] / 100
        base = 1 - torch.exp(-kd * (D - start).clamp(min=0) / max(1 - start, .05))
        v = (torch.arange(H, device=I.device, dtype=torch.float32) + .5) / H
        horizon = (1 + 2 * p["fogHorizon"] / 100 * (1 - v) ** 2)[:, None]
        f = (p["fog"] / 100 * base * horizon).clamp(0, 1)
        colour = lin(torch.tensor(hsv(p["fogHue"], p["fogSaturation"] / 100, p["fogBrightness"] / 100), device=I.device).view(3, 1, 1))
        L = L + (colour - L) * f
    if p["blur"] > 0:
        L = lens_blur(L, D, p, taps)
    if p["glow"] > 0:
        L = glow(L, D, p)
    return (I + (enc(L) - I) * p["amount"] / 100).clamp(0, 1)


# --- Bake ---

PIPE_CHUNK = 1 << 20  # Windows pipes move a 66 MB 4K frame five times faster in 1 MB reads and writes than in one.


def read_exact(stream, size):
    data = bytearray(size)
    view, got = memoryview(data), 0
    while got < size:
        n = stream.readinto(view[got:got + PIPE_CHUNK])
        if not n:
            break
        got += n
    if got and got != size:
        raise ValueError("Truncated frame from the decoder.")
    return data if got else None


def pump(source, size, frames, sink, errors):
    """Read `frames` frames of `size` bytes from a process's stdout onto a queue (None ends it)."""
    try:
        for _ in range(frames):
            data = read_exact(source, size)
            if data is None:
                break
            sink.put(data)
    except Exception as error:  # Surfaced by the main loop.
        errors.append(error)
    finally:
        sink.put(None)


def depth_frames(job, sink, errors, children):
    """The run's masters, decoded segment by segment, as (h,w) uint16 0..1023 frames in source order."""
    spec = job["depth"]
    size = spec["width"] * spec["height"] * 2
    try:
        for path in spec["masters"]:
            process = subprocess.Popen([job["ffmpeg"], "-v", "error", "-nostdin", "-i", path, "-f", "rawvideo", "-pix_fmt", "gray10le", "-"],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            children.append(process)
            while (data := read_exact(process.stdout, size)) is not None:
                sink.put(data)
            stderr = process.stderr.read().decode(errors="replace")
            if process.wait() != 0:
                raise ValueError("Could not decode depth: " + stderr.strip()[-600:])
    except Exception as error:
        errors.append(error)
    finally:
        sink.put(None)


def render(job):
    ff, W, H, total = job["ffmpeg"], job["width"], job["height"], job["frames"]
    device, children, errors = pick_device(), [], []
    spec = job["depth"]
    alpha = bool(job.get("alpha"))

    def stop(*_):
        for process in children:
            if process.poll() is None:
                process.terminate()
        raise InterruptedError("Depth bake cancelled.")
    signal.signal(signal.SIGTERM, stop)
    threads = str(max(1, int(job.get("threads") or os.cpu_count() or 1)))
    if job.get("image"):
        codec = ["-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba64be" if alpha else "rgb48be"]
    else:
        # Fixed quantiser: prores_ks's rate control ran 4K 4444 at 6 fps on the Dell; qscale 4 runs 43 fps at the same size.
        codec = ["-c:v", "prores_ks", "-profile:v", "4", "-qscale:v", "4", "-vendor", "apl0", "-pix_fmt", "yuva444p10le" if alpha else "yuv444p10le", "-threads", threads,
                 "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
    out_range = "pc" if job.get("image") else "tv"
    try:
        decoder = subprocess.Popen(job["decoder"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        children.append(decoder)
        encoder = subprocess.Popen([ff, "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgba64le", "-s", f"{W}x{H}", "-r", str(job["fps"]), "-i", "-",
                                    "-vf", f"scale=out_color_matrix=bt709:out_range={out_range}", *codec, job["output"]], stdin=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        children.append(encoder)
        pictures, depths, written = queue.Queue(maxsize=3), queue.Queue(maxsize=16), queue.Queue(maxsize=3)
        threading.Thread(target=pump, args=(decoder.stdout, W * H * 8, total, pictures, errors), daemon=True).start()
        threading.Thread(target=depth_frames, args=(job, depths, errors, children), daemon=True).start()
        encoder_errors = []
        decoder_errors = []
        threading.Thread(target=lambda: decoder_errors.append(decoder.stderr.read()), daemon=True).start()
        threading.Thread(target=lambda: encoder_errors.append(encoder.stderr.read()), daemon=True).start()

        def write():
            try:
                while (data := written.get()) is not None:
                    view = memoryview(data)
                    for at in range(0, len(view), PIPE_CHUNK):
                        encoder.stdin.write(view[at:at + PIPE_CHUNK])
            except Exception as error:
                errors.append(error)
            finally:
                try:
                    encoder.stdin.close()
                except OSError:
                    pass
        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        static = {**DEFAULTS, **job["params"]}
        animated = job.get("animated") or {}
        warps = job.get("warps")
        indices, near, far, taps = spec["indices"], float(spec["near"]), float(spec["far"]), int(job.get("taps") or 96)
        if len(indices) != total or any(b < a for a, b in zip(indices, indices[1:])):
            raise ValueError("Invalid depth frame indices.")
        position, current = -1, None
        with torch.inference_mode():
            for k in range(total):
                data = pictures.get()
                if errors:
                    raise errors[0]
                if data is None:
                    decoder.wait()
                    detail = (decoder_errors[0] if decoder_errors else b"").decode(errors="replace").strip()[-600:]
                    raise ValueError(f"The clip decoded {k} of {total} frames before Depth. {detail}".strip())
                while position < indices[k]:
                    current = depths.get()
                    if current is None:
                        raise errors[0] if errors else ValueError("The depth analysis is shorter than the clip.")
                    position += 1
                rgba = torch.from_numpy(np.frombuffer(data, np.uint16).reshape(H, W, 4)).to(device).permute(2, 0, 1).float() / 65535
                depth = torch.from_numpy(np.frombuffer(current, np.uint16).reshape(spec["height"], spec["width"])).to(device).float() / 1023
                params = {**static, **{key: values[k] for key, values in animated.items()}}
                rgb = depth_fx(rgba[:3].contiguous(), depth, params, near, far, taps, warps[k] if warps else None)
                # Interleave on the GPU: a strided tensor crossed to the CPU element by element (240 ms a 4K frame).
                out = (torch.cat([rgb, rgba[3:]]) * 65535 + .5).clamp(0, 65535).to(torch.int32).to(torch.uint16).permute(1, 2, 0).contiguous()
                written.put(out.cpu().numpy().tobytes())
                if k % 4 == 3 or k == total - 1:
                    print(json.dumps({"progress": round((k + 1) / total * 100, 1)}), file=sys.stderr, flush=True)
        written.put(None)
        writer.join()
        if errors:
            raise errors[0]
        decoder.stdout.close()
        if decoder.poll() is None:
            decoder.terminate()  # It may hold frames past the last one asked for.
        if encoder.wait() != 0:
            raise ValueError("Could not encode the depth bake: " + (encoder_errors[0] if encoder_errors else b"").decode(errors="replace").strip()[-600:])
        if device.type == "cuda":
            print(json.dumps({"peakVram": round(torch.cuda.max_memory_allocated() / 2 ** 30, 3)}), file=sys.stderr, flush=True)
    finally:
        for process in children:
            if process.poll() is None:
                process.terminate()
        for process in children:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


# --- Parity: one picture through the same math, for the preview/export check ---

def read_png(path, channels):
    import cv2
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"Could not read {path}.")
    scale = 65535 if image.dtype == np.uint16 else 255
    image = image.astype(np.float32) / scale
    if channels == 1:
        return image if image.ndim == 2 else image[..., 0]
    return image[..., [2, 1, 0]] if image.ndim == 3 else np.repeat(image[..., None], 3, -1)


def parity(params_path, rgb_path, depth_path, out_path):
    import cv2
    spec = json.loads(Path(params_path).read_text())
    device = pick_device()
    rgb = torch.from_numpy(read_png(rgb_path, 3)[..., :3].copy()).to(device).permute(2, 0, 1)
    depth = torch.from_numpy(read_png(depth_path, 1).copy()).to(device)
    with torch.inference_mode():
        out = depth_fx(rgb, depth, spec.get("params", {}), float(spec["near"]), float(spec["far"]), int(spec.get("taps", 96)), spec.get("warp"))
    image = (out.permute(1, 2, 0).cpu().numpy()[..., [2, 1, 0]] * 65535 + .5).clip(0, 65535).astype(np.uint16)
    if not cv2.imwrite(str(out_path), image):
        raise ValueError(f"Could not write {out_path}.")


# --- Self test ---

def detail(image):
    """Mean absolute horizontal + vertical neighbour difference: high-frequency energy."""
    return float((image[..., 1:, :] - image[..., :-1, :]).abs().mean() + (image[..., :, 1:] - image[..., :, :-1]).abs().mean())


def gather_reference(Ls, Ds, cc, Rb, bokeh, taps):
    """The spec's gather loop exactly as written, one sample at a time: the reference for gather()."""
    _, Hb, Wb = Ls.shape
    stack = torch.cat([Ls, Ds[None], cc[None]])
    y, x = torch.meshgrid(torch.arange(Hb, device=Ls.device, dtype=torch.float32), torch.arange(Wb, device=Ls.device, dtype=torch.float32), indexing="ij")
    weigh = lambda col: 1 + bokeh * (lum(col) - .7).clamp(min=0)
    wsum = weigh(Ls)
    acc = Ls * wsum
    for r, angle in gather_taps(Rb, taps):
        at = sample(stack, x + math.cos(angle) * r, y + math.sin(angle) * r)
        reach = torch.where(at[3] > Ds, torch.minimum(at[4], 2 * cc), at[4])
        m, w = smoothstep(r - .5, r + .5, reach), weigh(at[:3])
        acc = acc + (acc / wsum * w) * (1 - m) + at[:3] * w * m
        wsum = wsum + w
    return acc / wsum


def selftest():
    device, checks = pick_device(), []
    generator = torch.Generator(device="cpu").manual_seed(7)
    Ls, Ds, cc = torch.rand(3, 40, 60, generator=generator), torch.rand(40, 60, generator=generator), torch.rand(40, 60, generator=generator) * 9
    for taps in (16, 48, 96):
        batched, reference = gather(Ls.to(device), Ds.to(device), cc.to(device), 9.5, 3.2, taps), gather_reference(Ls.to(device), Ds.to(device), cc.to(device), 9.5, 3.2, taps)
        assert torch.allclose(batched, reference, atol=2e-5, rtol=1e-4), f"batched gather differs from the loop by {float((batched - reference).abs().max())}"
    checks.append("gather equals the loop")
    H, W, h, w = 96, 160, 48, 80
    y, x = torch.meshgrid(torch.arange(H, device=device), torch.arange(W, device=device), indexing="ij")
    checker = ((x // 4 + y // 4) % 2).float()
    I = (.25 + .5 * checker).expand(3, H, W).contiguous()
    depth = torch.zeros(h, w, device=device)
    depth[:, : w // 2] = .8  # Left half near, right half far.
    near, far = .8, .2
    with torch.inference_mode():
        same = depth_fx(I, depth, {}, near, far)
        assert torch.equal(same, I), "every section off must leave the picture alone"
        quiet = depth_fx(I, depth, {"light": 0, "fog": 0, "blur": 0, "glow": 0, "amount": 100}, near, far)
        assert torch.equal(quiet, I)
        D = upsample_depth(I, depth, near, far)
        assert float(D[:, :70].max()) < 1e-3 and float(D[:, 90:].min()) > .999, "depth keeps its order and halves"
        assert torch.allclose(D, upsample_depth(I, depth, near, far, [1, 0, 0, 0, 1, 0]), atol=1e-5), "identity warp is no warp"
        shifted = upsample_depth(I, depth, near, far, [1, 0, 20, 0, 1, 0])  # Picture moved 20 px right: so is its depth.
        assert float(shifted[:, :15].max()) == 0 and float(shifted[:, 25:90].max()) < 1e-3 and float(shifted[:, 110:].min()) > .999
        checks.append("depth upsample")
        blurred = depth_fx(I, depth, {"blur": 100, "focus": 0, "range": 10}, near, far)
        near_detail, far_detail = detail(blurred[:, :, :70]), detail(blurred[:, :, 90:])
        assert abs(near_detail - detail(I[:, :, :70])) < 1e-3, f"the near half stays sharp ({near_detail})"
        assert far_detail < .25 * detail(I[:, :, 90:]), f"the far half loses its detail ({far_detail})"
        assert abs(float(blurred[:, :, 90:].mean()) - float(I[:, :, 90:].mean())) < .1, "blur keeps the brightness"
        refocused = depth_fx(I, depth, {"blur": 100, "focus": 100, "range": 10, "nearBlur": 100}, near, far)
        assert detail(refocused[:, :, 90:]) > .99 * detail(I[:, :, 90:]) and detail(refocused[:, :, :70]) < .25 * detail(I[:, :, :70]), "focus far blurs the near half"
        checks.append("lens blur")
        fogged = depth_fx(I, depth, {"fog": 100, "fogStart": 30, "fogHorizon": 0}, near, far)
        target = torch.tensor(hsv(210, .1, .85), device=device).view(3, 1)
        assert torch.allclose(fogged[:, :, :70], I[:, :, :70], atol=1e-5), "fog leaves the near half alone"
        assert float((fogged[:, :, 100:].reshape(3, -1) - target).abs().mean()) < .05, "thick fog turns the far half the fog colour"
        dim = I * .5
        lit = depth_fx(dim, depth, {"light": 100, "lightStart": 40, "lightSoftness": 10, "bgExposure": 1}, near, far)
        ratio = lin(lit[:, :, 100:]) / lin(dim[:, :, 100:])
        assert torch.allclose(ratio, torch.full_like(ratio, 2), atol=1e-3) and torch.allclose(lit[:, :, :70], dim[:, :, :70], atol=1e-5), "+1 EV doubles the far half only"
        spots = torch.full((3, H, W), .1, device=device)
        spots[:, 40:44, 30:34] = 1  # A light in the near half and one in the far half.
        spots[:, 40:44, 120:124] = 1
        glowed = depth_fx(spots, depth, {"glow": 100, "glowThreshold": 50, "glowRadius": 30}, near, far)
        assert float(glowed[0, 42, 118]) > .3 and abs(float(glowed[0, 42, 22]) - .1) < 1e-4, "only the far light glows"
        full, mixed = depth_fx(I, depth, {"fog": 100}, near, far), depth_fx(I, depth, {"fog": 100, "amount": 50}, near, far)
        assert torch.allclose(mixed, I + (full - I) * .5, atol=1e-5), "Mix blends with the untouched picture"
        checks.append("fog, light, glow, mix")
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    with tempfile.TemporaryDirectory() as directory:
        directory = Path(directory)
        # A two-frame bake end to end: decoder pipe, masters, encoder, alpha kept.
        source, master = directory / "source.mov", directory / "0.mkv"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"nullsrc=s={W}x{H}:r=10:d=0.3,geq=lum='255*mod(floor(X/4)+floor(Y/4)\\,2)':cb=128:cr=128", "-c:v", "ffv1", str(source)], check=True)
        levels = b"".join(bytes([200 if i % w < w // 2 else 50 for i in range(w * h)]) for _ in range(3))
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", "30", "-i", "-",
                        "-pix_fmt", "yuv420p10le", "-color_range", "pc", "-c:v", "libx264", "-qp", "0", str(master)], input=levels, check=True)
        job = dict(ffmpeg=ffmpeg, width=W, height=H, frames=3, fps=10, output=str(directory / "out.mov"), alpha=True, taps=48,
                   decoder=[ffmpeg, "-v", "error", "-i", str(source), "-f", "rawvideo", "-pix_fmt", "rgba64le", "-"],
                   depth=dict(masters=[str(master)], width=w, height=h, indices=[0, 1, 1], near=200 / 255, far=50 / 255),
                   params=dict(blur=100, focus=0), animated=dict(amount=[100, 50, 0]))
        render(job)
        decoded = subprocess.run([ffmpeg, "-v", "error", "-i", job["output"], "-f", "rawvideo", "-pix_fmt", "rgba64le", "-"], capture_output=True, check=True).stdout
        frames = np.frombuffer(decoded, np.uint16).reshape(-1, H, W, 4).astype(np.float32) / 65535
        original = np.frombuffer(subprocess.run(job["decoder"], capture_output=True, check=True).stdout, np.uint16).reshape(-1, H, W, 4).astype(np.float32) / 65535
        assert len(frames) == 3 and frames[..., 3].min() > .999, "three opaque frames"
        far_detail = [detail(torch.from_numpy(f[:, 100:, :3].copy()).permute(2, 0, 1)) for f in frames]
        assert far_detail[0] < .5 * far_detail[2] and abs(far_detail[2] - detail(torch.from_numpy(original[2, :, 100:, :3].copy()).permute(2, 0, 1))) < .01, f"Mix keyframes apply per frame: {far_detail}"
        assert np.abs(frames[0, :, :60, :3] - original[0, :, :60, :3]).mean() < .01, "the near half survives the round trip"
        checks.append("bake")
        # Parity mode reads PNGs and writes a 16-bit PNG.
        import cv2
        cv2.imwrite(str(directory / "rgb.png"), (I.permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8))
        cv2.imwrite(str(directory / "depth.png"), (depth.cpu().numpy() * 255).round().astype(np.uint8))
        (directory / "params.json").write_text(json.dumps(dict(params=dict(blur=100, focus=0), near=near, far=far, taps=48)))
        parity(directory / "params.json", directory / "rgb.png", directory / "depth.png", directory / "out.png")
        out = cv2.imread(str(directory / "out.png"), cv2.IMREAD_UNCHANGED)
        assert out.dtype == np.uint16 and out.shape == (H, W, 3)
        out = torch.from_numpy(out.astype(np.float32) / 65535).permute(2, 0, 1)
        assert detail(out[:, :, 90:]) < .25 * detail(out[:, :, :70]), "parity output is blurred on the far side"
        checks.append("parity")
    print(json.dumps(dict(ok=True, device=str(device), checks=checks)))


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--selftest"]:
            selftest()
        elif sys.argv[1:2] == ["--parity"] and len(sys.argv) == 6:
            parity(*sys.argv[2:6])
        elif len(sys.argv) == 2:
            render(json.loads(Path(sys.argv[1]).read_text()))
        else:
            raise ValueError("Usage: depth-fx.py <job.json> | --parity <params.json> <rgb.png> <depth.png> <out.png> | --selftest")
    except Exception as error:
        detail_ = error if isinstance(error, (ValueError, AssertionError, InterruptedError)) else f"{type(error).__name__}: {error}"
        print(f"Depth: {detail_}", file=sys.stderr)
        sys.exit(1)
