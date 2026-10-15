#!/usr/bin/env python3
"""SharedCut Noise Reduction worker: motion-compensated temporal + spatial denoise of the camera original.

  denoise.py --check            one JSON line {available, engine, device, reason?, workerIdentity}
  denoise.py --selftest         synthetic checks, exit 0 on success
  denoise.py <job.json>         one job: {"progress":n,"stage":..} lines on stdout, the result JSON last
  denoise.py --serve            resident: {"ready":true,"device":..}, then stdin lines {id, job} or {id, cancel:true}

docs/superpowers/specs/2026-10-15-noise-reduction-design.md, "Engine" and "Worker protocol". All maths runs in the
source's own Y'CbCr planes at native chroma subsampling, as float on the device (cuda, mps, cpu; FRAME_LINE_DENOISE_DEVICE).
FFmpeg decodes to and encodes from yuv4XXp16le; nothing here converts colour. Flow is OpenCV DIS on CPU threads, which
release the GIL, so it runs while the GPU denoises the previous frame.
"""
import hashlib
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

# Set before torch starts CUDA: less fragmentation on a GPU shared with the desktop, Smart Mask and Depth.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
try:
    import cv2
    import numpy as np
    import torch
    import torch.nn.functional as F
    MISSING = None
except ImportError as error:  # --check reports it; nothing else can run
    MISSING = str(error)

FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf"
PREROLL = 3.0  # s decoded before a seek target: MPEG-TS seeks land up to a GOP late, open-GOP leading frames need the previous GOP
LAYOUTS = {"yuv420p16le": (2, 2), "yuv422p16le": (2, 1), "yuv444p16le": (1, 1)}
PIPE_CHUNK = 1 << 20  # Windows pipes move a 4K frame several times faster in 1 MB reads and writes than in one.
BINS = 16
PAIRS = 12
FLOW_WIDTH = 960
FLOOR = .25 / 1023  # a quarter of a 10-bit code
DEFAULTS = {"amount": 50, "chroma": 60, "frames": 2, "spatial": 50, "detail": 30}
# Tuning (spec "Engine"; the constants were tuned on the four sample clips and the synthetic test).
TAU = 1.5          # patch-distance tolerance in standard deviations of D under pure noise
LAMBDA_T = .6      # temporal falloff at Strength 50
LAMBDA_C = .6      # chroma agreement falloff at Chroma 50
LAMBDA_S = .4      # luma NLM falloff at Spatial 50, Strength 50
LAMBDA_CS = 1.0    # chroma NLM falloff at Chroma 50
TAU_S = 0          # luma NLM: no plateau, a plateau posterises texture under heavy noise
GRAIN = .4         # share of the removed noise Detail gives back, so dark, heavily denoised areas keep a fine grain
GUIDE_BOX = 5      # luma NLM weights from the 5×5-smoothed temporal result: noise stops choosing the neighbours
_emit_lock = threading.Lock()


class Cancelled(InterruptedError):
    pass


def emit(**message):
    with _emit_lock:
        print(json.dumps(message, allow_nan=False), flush=True)


def pick_device():
    if os.environ.get("FRAME_LINE_DENOISE_DEVICE"):
        return torch.device(os.environ["FRAME_LINE_DENOISE_DEVICE"])
    return torch.device("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")


def capabilities():
    if MISSING:
        return dict(available=False, engine="denoise", device="none",
                    reason=f"Noise Reduction needs the denoise worker on this server ({MISSING}). Run npm run setup:denoise.")
    device = pick_device().type
    return dict(available=True, engine="denoise", device=device,
                workerIdentity=dict(torch=torch.__version__, opencv=cv2.__version__, device=device,
                                    source=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()))


# ---------------------------------------------------------------- frames in and out

class Layout:
    """Planar 16-bit Y'CbCr at native subsampling: byte sizes and plane shapes."""
    def __init__(self, pixfmt, width, height):
        if pixfmt not in LAYOUTS:
            raise ValueError(f"Unsupported pixel format {pixfmt}.")
        self.pixfmt, self.width, self.height = pixfmt, width, height
        self.sx, self.sy = LAYOUTS[pixfmt]
        self.cw, self.ch = -(-width // self.sx), -(-height // self.sy)
        self.luma, self.chroma = width * height, self.cw * self.ch
        self.bytes = 2 * (self.luma + 2 * self.chroma)


def read_exact(stream, size, pinned=False):
    """One frame as a uint8 tensor, read straight into page-locked memory on CUDA so its upload runs asynchronously."""
    data = torch.empty(size, dtype=torch.uint8, pin_memory=pinned)
    view, got = memoryview(data.numpy()), 0
    while got < size:
        n = stream.readinto(view[got:got + PIPE_CHUNK])
        if not n:
            break
        got += n
    if got and got != size:
        raise ValueError("Truncated frame from the decoder.")
    return data if got else None


def pump(source, size, frames, sink, errors, pinned=False, closed=None):
    """Read up to `frames` frames of `size` bytes onto a queue (None ends it). Once `closed` is set (a cancelled job) the
    thread ends instead of waiting on a queue nobody reads, so a resident worker does not keep its frames."""
    closed = closed or threading.Event()

    def put(item):
        while not closed.is_set():
            try:
                return sink.put(item, timeout=.25)
            except queue.Full:
                pass
    try:
        for _ in range(frames):
            data = read_exact(source, size, pinned)
            if data is None or closed.is_set():
                break
            put(data)
    except Exception as error:  # Surfaced by the consumer.
        errors.append(error)
    finally:
        put(None)


_hwaccel_ok = {}


def decode_args(job):
    """The server's hardware decode arguments when they work on this very file, else software (stabilize.py does the same)."""
    args = list(job.get("inputArgs") or [])
    if not args or os.environ.get("FRAME_LINE_HWACCEL", "").lower() in ("off", "0", "false"):
        return []
    key = (job["ffmpeg"], job["input"], tuple(args))
    if key not in _hwaccel_ok:
        trial = [job["ffmpeg"], "-v", "error", "-nostdin", *args, "-i", job["input"], "-frames:v", "2", "-f", "null", "-"]
        try:
            _hwaccel_ok[key] = subprocess.run(trial, capture_output=True, timeout=60).returncode == 0
        except (OSError, subprocess.SubprocessError):
            _hwaccel_ok[key] = False
    return args if _hwaccel_ok[key] else []


class Reader:
    """Source frames [start, start+count) on the constant-rate grid at the job's size, raw, through a bounded queue.
    Frame i is the last source frame whose time rounds to at most i/fps, on the file's own clock (start_at_zero), so every
    chunk, context window and bake agree. The seek lands PREROLL early and keeps every frame it decodes (no accurate seek):
    the fps filter trims at the start, having seen the frame before a timestamp gap and a reordered GOP's leading frames."""
    def __init__(self, job, layout, start, count, hw, children, depth=6, pinned=False):
        t0 = float(start / Fraction(str(job["fps"])))
        seek = ["-noaccurate_seek", "-ss", f"{t0 - PREROLL:.6f}"] if t0 > PREROLL else []
        # A full-range source stays full: FFmpeg before 7.1 converts it to video range for any non-'j' output format.
        full = ":in_range=pc:out_range=pc" if (job.get("colors") or {}).get("range") == "pc" else ""
        scale = (f"fps=fps={job['fps']}:start_time={t0:.6f}:round=near,"
                 f"scale=w={layout.width}:h={layout.height}:flags=lanczos+accurate_rnd+full_chroma_int{full},format={layout.pixfmt}")
        threads = ["-threads", str(int(job["threads"]))] if job.get("threads") else []
        self.command = [job["ffmpeg"], "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS,
                        *threads, *hw, *seek, "-copyts", "-start_at_zero", "-i", job["input"], "-an", "-sn", "-dn", "-vf", scale,
                        "-fps_mode", "passthrough", "-frames:v", str(count), "-f", "rawvideo", "-pix_fmt", layout.pixfmt, "-"]
        self.process = subprocess.Popen(self.command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        children.append(self.process)
        self.queue, self.errors, self.stderr, self.count, self.closed = queue.Queue(maxsize=depth), [], [], 0, threading.Event()
        threading.Thread(target=pump, args=(self.process.stdout, layout.bytes, count, self.queue, self.errors, pinned, self.closed), daemon=True).start()
        threading.Thread(target=lambda: self.stderr.append(self.process.stderr.read()), daemon=True).start()

    def next(self):
        data = self.queue.get()
        if data is not None:
            self.count += 1
            return data
        self.queue.put(None)  # stays ended
        if self.errors:
            raise self.errors[0]
        if self.process.wait() != 0:
            detail = (self.stderr[0] if self.stderr else b"").decode(errors="replace").strip()[-600:]
            raise ValueError(f"Could not decode the source: {detail or self.process.returncode}")
        return None


class Writer:
    """Raw frames into the server's encoder, written on a thread in 1 MB pieces."""
    def __init__(self, job, layout, children):
        colors = job.get("colors") or {}
        tags = [arg for option, key in (("-color_range", "range"), ("-colorspace", "matrix"), ("-color_primaries", "primaries"), ("-color_trc", "transfer"))
                if colors.get(key) for arg in (option, str(colors[key]))]
        self.process = subprocess.Popen([job["ffmpeg"], "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", layout.pixfmt, "-s", f"{layout.width}x{layout.height}",
                                         "-r", str(job["fps"]), *tags, "-i", "-", *job["encode"]], stdin=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        children.append(self.process)
        self.queue, self.errors, self.stderr, self.closed = queue.Queue(maxsize=3), [], [], threading.Event()
        threading.Thread(target=lambda: self.stderr.append(self.process.stderr.read()), daemon=True).start()
        self.thread = threading.Thread(target=self._write, daemon=True)
        self.thread.start()

    def _write(self):
        try:
            while (item := self.queue.get()) is not None:
                data, ready = item
                if ready is not None:
                    ready.synchronize()  # the frame's download from the GPU
                view = memoryview(data.numpy()).cast("B")
                for at in range(0, len(view), PIPE_CHUNK):
                    self.process.stdin.write(view[at:at + PIPE_CHUNK])
        except Exception as error:
            self.errors.append(error)
            while not self.closed.is_set():  # unblock the producer until it stops
                try:
                    if self.queue.get(timeout=.25) is None:
                        break
                except queue.Empty:
                    pass
        finally:
            try:
                self.process.stdin.close()
            except OSError:
                pass

    def put(self, data, ready=None):
        """data: a uint8/int16 CPU tensor; ready: a CUDA event to wait for before writing it."""
        if self.errors:
            raise self.failure()
        self.queue.put((data, ready))

    def failure(self):
        self.process.wait()
        detail = (self.stderr[0] if self.stderr else b"").decode(errors="replace").strip()[-600:]
        return ValueError(f"Could not encode the denoised frames: {detail or (self.errors[0] if self.errors else self.process.returncode)}")

    def finish(self):
        self.queue.put(None)
        self.thread.join()
        if self.process.wait() != 0 or self.errors:
            raise self.failure()


# ---------------------------------------------------------------- motion

class Flows:
    """DIS flow on downscaled, pre-smoothed luma, forward and backward for each consecutive decoded pair, on CPU threads.
    One 8-bit stretch per pair, shared by both frames, keeps brightness constancy: log footage is flat. Per pair, so the
    flows do not depend on the frame a job starts from (a dark first frame would clip every later one)."""
    def __init__(self, layout, threads, pinned=False):
        scale = min(1.0, FLOW_WIDTH / layout.width)
        self.pinned = pinned
        self.size = (max(16, round(layout.width * scale)), max(16, round(layout.height * scale)))
        self.layout, self.local = layout, threading.local()
        self.pool = ThreadPoolExecutor(max_workers=max(1, threads))
        self.preps, self.pairs = {}, {}

    def _small(self, luma):
        small = cv2.resize(luma, self.size, interpolation=cv2.INTER_AREA).astype(np.float32)
        return cv2.GaussianBlur(small, (0, 0), 1.0)

    @staticmethod
    def stretch(a, b):
        """Both small lumas to uint8 with one mapping from the pair's 0.5/99.5 percentiles."""
        lo, hi = np.percentile(np.stack((a, b)), (.5, 99.5))
        hi = max(hi, lo + 256)
        return [np.clip((x - lo) * (255 / (hi - lo)) + .5, 0, 255).astype(np.uint8) for x in (a, b)]

    def _dis(self):
        if not hasattr(self.local, "dis"):
            dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)
            dis.setVariationalRefinementIterations(5)
            self.local.dis = dis
        return self.local.dis

    def _pair(self, a, b):
        a, b = Flows.stretch(a.result(), b.result())
        dis = self._dis()
        # (2,h,w) tensors made here, off the main thread: the strided transpose costs milliseconds per field.
        fields = [torch.from_numpy(f).permute(2, 0, 1).contiguous() for f in (dis.calc(a, b, None), dis.calc(b, a, None))]
        return [f.pin_memory() for f in fields] if self.pinned else fields

    def add(self, n, data):
        """Frame n (raw bytes): prepare its luma and, with frame n-1, start the pair's flows."""
        luma = data.numpy()[:2 * self.layout.luma].view(np.uint16).reshape(self.layout.height, self.layout.width)
        self.preps[n] = self.pool.submit(self._small, luma)
        if n - 1 in self.preps:
            self.pairs[n - 1] = self.pool.submit(self._pair, self.preps[n - 1], self.preps[n])

    def pair(self, n):
        """(flow n -> n+1, flow n+1 -> n) in small-image pixels, (2, h, w) float32 CPU tensors."""
        return self.pairs[n].result()

    def forget(self, below):
        for store in (self.preps, self.pairs):
            for n in [n for n in store if n < below]:
                del store[n]

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)


def grid_for(flow, H, W):
    xs = torch.arange(W, device=flow.device, dtype=torch.float32)
    ys = torch.arange(H, device=flow.device, dtype=torch.float32)[:, None]
    gx, gy = flow[0] + xs, flow[1] + ys
    valid = (gx >= 0) & (gx <= W - 1) & (gy >= 0) & (gy <= H - 1)
    return torch.stack((gx * (2 / max(W - 1, 1)) - 1, gy * (2 / max(H - 1, 1)) - 1), -1)[None], valid


def follow(field, flow):
    """field (C,h,w) sampled at p + flow(p), bilinear, edges clamped."""
    grid, _ = grid_for(flow, *flow.shape[1:])
    return F.grid_sample(field[None], grid, mode="bilinear", padding_mode="border", align_corners=True)[0]


def warp(plane, flow, mode):
    """plane (H,W) sampled at p + flow(p); also whether that point is inside the frame."""
    grid, valid = grid_for(flow, *plane.shape)
    return F.grid_sample(plane[None, None], grid, mode=mode, padding_mode="border", align_corners=True)[0, 0], valid


def resize_flow(flow, H, W):
    """(2,h,w) vectors in h×w pixels to (2,H,W) in H×W pixels."""
    h, w = flow.shape[1:]
    up = F.interpolate(flow[None], size=(H, W), mode="bilinear", align_corners=False)[0]
    up[0] *= W / w  # python scalars: a small tensor upload would wait for the GPU
    up[1] *= H / h
    return up


def composed(pairs, t, n):
    """Flows t -> n and n -> t at flow size, composed from consecutive pairs: f(t->t+k) = f(t->t+k-1) + warp(f(t+k-1->t+k), f(t->t+k-1)).
    pairs(j) gives (j -> j+1, j+1 -> j) as (2,h,w) tensors."""
    step = 1 if n > t else -1
    there = back = None
    for j in range(t, n, step):
        hop, ret = pairs(j) if step > 0 else pairs(j - 1)[::-1]  # j -> j+step, j+step -> j
        there = hop if there is None else there + follow(hop, there)
    for j in range(n, t, -step):  # the same, walked from n
        hop = pairs(j - 1)[1] if step > 0 else pairs(j)[0]  # j -> j-step
        back = hop if back is None else back + follow(hop, back)
    return there, back


# ---------------------------------------------------------------- shared maths

def box(x, k):
    """Mean over a k×k window of (...,H,W); edge windows average the pixels inside the frame."""
    shape = x.shape
    return F.avg_pool2d(x.reshape(-1, 1, *shape[-2:]), k, 1, k // 2, count_include_pad=False).reshape(shape)


def to_size(x, h, w):
    """Area resample of (...,H,W) to (...,h,w)."""
    if tuple(x.shape[-2:]) == (h, w):
        return x
    flat = x.reshape(-1, 1, *x.shape[-2:])
    # MPS adaptive pooling needs each size to divide the other (135 → 68 fails); those few small planes run on the CPU.
    odd = flat.device.type == "mps" and any(max(a, b) % min(a, b) for a, b in zip(flat.shape[-2:], (h, w)))
    return F.interpolate(flat.cpu() if odd else flat, size=(h, w), mode="area").to(x.device).reshape(*x.shape[:-2], h, w)


def lookup(table, level):
    """Per-pixel value of a BINS-entry table over 0..1, linear between bin centres."""
    x = (level * BINS - .5).clamp(0, BINS - 1)
    i = x.floor().clamp(max=BINS - 2)
    f = x - i
    i = i.long()
    return table[i] * (1 - f) + table[i + 1] * f


def upload(data, layout, device):
    """Raw yuv4XXp16le bytes to three float32 planes 0..1 on the device."""
    t = data.view(torch.int16).to(device, non_blocking=True)
    f = (t.to(torch.int32) & 0xFFFF).to(torch.float32) * (1 / 65535)
    L, C = layout.luma, layout.chroma
    return f[:L].view(layout.height, layout.width), f[L:L + C].view(layout.ch, layout.cw), f[L + C:].view(layout.ch, layout.cw)


def cubic_gain(f):
    """Σ w² of grid_sample's bicubic (A = -0.75) weights at fraction f: how much a warp keeps of white noise's variance."""
    A, g = -.75, 1 - f
    w0 = ((A * (f + 1) - 5 * A) * (f + 1) + 8 * A) * (f + 1) - 4 * A
    w1 = ((A + 2) * f - (A + 3)) * f * f + 1
    w2 = ((A + 2) * g - (A + 3)) * g * g + 1
    return w0 * w0 + w1 * w1 + w2 * w2 + (1 - w0 - w1 - w2) ** 2


def linear_gain(f):
    return (1 - f) ** 2 + f * f


def fraction(x):
    return x - x.floor()


# ---------------------------------------------------------------- noise profile

def robust_sigma(x):
    """σ of the Gaussian core from the lower quartile of |x − median| (Q25 = 0.3186 σ): MAD's breakdown is 50 %, this
    one's 75 %, which moving fabric and leaves need. Long selections are thinned first."""
    if x.numel() > 400_000:
        x = x[::x.numel() // 400_000 + 1]
    deviation = (x - x.median()).abs()
    return float(deviation.kthvalue(max(1, deviation.numel() // 4)).values / .3186)


def binned(d, level, keep, minimum=400):
    """Per luma bin: σ of the noise in a frame difference d (already scaled so var(d) = 2σ²) and σ of its 5×5 mean."""
    d_box = box(d, 5)
    sel = keep.reshape(-1)
    dv, bv = d.reshape(-1)[sel], d_box.reshape(-1)[sel]
    bins = (level.reshape(-1)[sel] * BINS).long().clamp(0, BINS - 1)
    sigma, sigma_box, counts = [float("nan")] * BINS, [float("nan")] * BINS, [0] * BINS
    counted = torch.bincount(bins, minlength=BINS).tolist()
    for i in range(BINS):
        counts[i] = counted[i]
        if counted[i] >= minimum:
            m = bins == i
            sigma[i] = robust_sigma(dv[m]) / 2 ** .5
            sigma_box[i] = robust_sigma(bv[m]) / 2 ** .5
    return sigma, sigma_box, counts


def gradient(plane):
    """Gradient magnitude of a lightly smoothed plane: flat areas are where the noise is measured."""
    s = box(box(plane, 3), 3)
    gx = torch.zeros_like(s)
    gx[:, 1:-1] = s[:, 2:] - s[:, :-2]
    gy = torch.zeros_like(s)
    gy[1:-1] = s[2:] - s[:-2]
    return gx.abs() + gy.abs()


def below_quantile(x, q):
    sample = x.reshape(-1)[::max(1, x.numel() // 1_000_000)]
    return x <= sample.kthvalue(max(1, int(sample.numel() * q))).values


def pair_profile(a, b, flows, layout, device):
    """Noise per plane and luma bin from one aligned consecutive pair (spec "Noise profile")."""
    fwd, bwd = flows
    fs = torch.from_numpy(fwd).permute(2, 0, 1).contiguous().to(device)
    bs = torch.from_numpy(bwd).permute(2, 0, 1).contiguous().to(device)
    agree = ((fs + follow(bs, fs)).norm(dim=0) < .5).float()
    H, W, ch, cw = layout.height, layout.width, layout.ch, layout.cw
    Ya, Cba, Cra = a
    Yb, Cbb, Crb = b
    flow = resize_flow(fs, H, W)
    Yw, inside = warp(Yb, flow, "bicubic")
    dY = (Ya - Yw) * (2 / (1 + cubic_gain(fraction(flow[0])) * cubic_gain(fraction(flow[1])))).sqrt()
    level = box(Ya, 5)
    keep = (to_size(agree[None], H, W)[0] > .99) & inside & below_quantile(gradient(Ya), .4) & (level >= .02) & (level <= .98)
    out = {"Y": binned(dY, level, keep)}
    flow_c = resize_flow(fs, ch, cw)
    gain = (2 / (1 + linear_gain(fraction(flow_c[0])) * linear_gain(fraction(flow_c[1])))).sqrt()
    level_c, keep_c = to_size(level, ch, cw), to_size(keep.float(), ch, cw) > .99
    for name, pa, pb in (("Cb", Cba, Cbb), ("Cr", Cra, Crb)):
        warped, inside_c = warp(pb, flow_c, "bilinear")
        out[name] = binned((pa - warped) * gain, level_c, keep_c & inside_c)
    return out


def haar_profile(planes):
    """Fallback for stills and short or unalignable sources: the finest Haar HH band over the flattest 10 % of 8×8 blocks."""
    out = {}
    level_y = None
    for name, plane in zip(("Y", "Cb", "Cr"), planes):
        H2, W2 = plane.shape[0] // 8 * 8, plane.shape[1] // 8 * 8
        p = plane[:H2, :W2]
        a, b, c, d = p[0::2, 0::2], p[0::2, 1::2], p[1::2, 0::2], p[1::2, 1::2]
        hh, ll = (a - b - c + d) / 2, (a + b + c + d) / 4
        activity = F.avg_pool2d(gradient(ll)[None, None], 4)[0, 0]
        flat = below_quantile(activity, .1).repeat_interleave(4, 0).repeat_interleave(4, 1)
        if name == "Y":
            level_y = ll
        level = to_size(level_y, *ll.shape)
        # HH of white noise has the noise's own σ; binned() divides by √2 for a difference, so scale back.
        sigma, _, counts = binned(hh * 2 ** .5, level, flat & (level >= .02) & (level <= .98), minimum=200)
        out[name] = (sigma, [float("nan")] * BINS, counts)
    return out


def table(values):
    """Fill bins without data from their neighbours, smooth 1-2-1, floor at a quarter code."""
    values = np.asarray(values, dtype=np.float64)
    known = np.flatnonzero(np.isfinite(values))
    if not len(known):
        return None
    filled = np.interp(np.arange(BINS), known, values[known])
    padded = np.concatenate([filled[:1], filled, filled[-1:]])
    smooth = (padded[:-2] + 2 * padded[1:-1] + padded[2:]) / 4
    return [round(float(v), 8) for v in np.maximum(smooth, FLOOR)]


def grab(job, layout, start, count, hw, children):
    reader = Reader(job, layout, start, count, hw, children, depth=count + 1)
    frames = [f for f in (reader.next() for _ in range(count)) if f is not None]
    return frames


def measure_profile(job, layout, device, hw, report, cancelled, children):
    """Noise-vs-brightness per plane for this source at this size (spec "Noise profile")."""
    fps = Fraction(str(job["fps"]))
    total = max(1, round(float(job.get("duration") or 0) * fps))
    flows = Flows(layout, 1)
    results, frames_seen = [], []
    with ThreadPoolExecutor(max_workers=3) as pool:
        if total >= 3:
            starts = sorted({round(i * (total - 2) / (PAIRS - 1)) for i in range(PAIRS)})
            pending = [pool.submit(grab, job, layout, s, 2, hw, children) for s in starts]
            for n, future in enumerate(pending):
                if cancelled():
                    raise Cancelled("Cancelled.")
                frames = future.result()
                if len(frames) < 2:
                    continue
                pa, pb = Flows.stretch(*(flows._small(f.numpy()[:2 * layout.luma].view(np.uint16).reshape(layout.height, layout.width)) for f in frames))
                dis = flows._dis()
                a, b = upload(frames[0], layout, device), upload(frames[1], layout, device)
                results.append(pair_profile(a, b, (dis.calc(pa, pb, None), dis.calc(pb, pa, None)), layout, device))
                frames_seen.append(frames[0])  # raw: the fallback needs them only rarely, VRAM always
                report((n + 1) / len(pending))
        samples = sum(sum(r["Y"][2]) for r in results)
        measured_bins = sum(any(np.isfinite(r["Y"][0][i]) for r in results) for i in range(BINS))
        method = "temporal"
        if samples < 20_000 or measured_bins < 2:
            method = "spatial"
            if not frames_seen:
                starts = sorted({round(i * (total - 1) / (PAIRS - 1)) for i in range(min(PAIRS, total))})
                for frames in pool.map(lambda s: grab(job, layout, s, 1, hw, children), starts):
                    frames_seen += frames
            if not frames_seen:
                raise ValueError("The source produced no frames to measure its noise.")
            results = [haar_profile(upload(f, layout, device)) for f in frames_seen]
    flows.close()
    sigma, rho = {}, {}
    for name in ("Y", "Cb", "Cr"):
        with warnings.catch_warnings(), np.errstate(all="ignore"):  # bins without data stay NaN until table() fills them
            warnings.simplefilter("ignore", RuntimeWarning)
            per_bin = np.nanmedian(np.array([r[name][0] for r in results], dtype=np.float64), 0)
            boxed = np.nanmedian(np.array([r[name][1] for r in results], dtype=np.float64), 0)
            ratios = boxed * 5 / per_bin
        sigma[name] = table(per_bin) or table([FLOOR * 8] * BINS)
        ratios = ratios[np.isfinite(ratios)]
        rho[name] = round(float(np.clip(np.median(ratios), 1, 4)), 4) if len(ratios) else 1.5
    return {"version": 1, "method": method, "width": layout.width, "height": layout.height, "pixfmt": layout.pixfmt,
            "bins": BINS, "sigma": sigma, "rho": rho, "samples": int(samples)}


def load_profile(path):
    try:
        profile = json.loads(Path(path).read_text())
        if profile.get("version") == 1 and all(len(profile["sigma"][k]) == BINS for k in ("Y", "Cb", "Cr")):
            return profile
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def save_profile(path, profile):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_text(json.dumps(profile, allow_nan=False))
    os.replace(temporary, path)


# ---------------------------------------------------------------- denoise

def upsample(x, h, w):
    return F.interpolate(x.reshape(-1, 1, *x.shape[-2:]), size=(h, w), mode="bilinear", align_corners=False).reshape(*x.shape[:-2], h, w)


def nlm_torch(values, guide, b, c, radius, budget=1 << 28):
    """Non-local means over a (2r+1)² search: each pixel averages `values` with weights from 3×3 patches of `guide`,
    w = exp(min(0, b − c·Σ_patch Σ_channels Δguide²)). values (V,H,W) and guide (G,H,W) float32, b and c (H,W); edges
    repeat the border pixel. Horizontal strips keep memory near `budget`: every offset of a strip at once (unfold) is a
    handful of large passes, which MPS runs ten times faster than per-offset slices."""
    V, H, W = values.shape
    G, r, k = guide.shape[0], radius, 2 * radius + 1
    gp = F.pad(guide[None], (r + 1,) * 4, mode="replicate")[0]
    vp = F.pad(values[None], (r,) * 4, mode="replicate")[0]
    out = torch.empty_like(values)
    rows = int(min(H, max(8, budget // (4 * k * k * (W + 2 * r + 2) * (G + V + 3)))))
    for y0 in range(0, H, rows):
        h = min(rows, H - y0)
        S = F.unfold(gp[None, :, y0:y0 + h + 2 * r + 2], k).view(G, k * k, h + 2, W + 2)
        D = (S - S[:, k * k // 2:k * k // 2 + 1]).square_()
        D = D[0] if G == 1 else D.sum(0)  # MPS reduces over a size-1 dimension very slowly
        D = F.avg_pool2d(D[None], 3, 1)[0] * 9
        w = torch.addcmul(b[y0:y0 + h], c[y0:y0 + h], D, value=-1).clamp_(max=0).exp_()
        Vs = F.unfold(vp[None, :, y0:y0 + h + 2 * r], k).view(V, k * k, h, W)
        out[:, y0:y0 + h] = (w * Vs).sum(1) / w.sum(0)
        del S, D, w, Vs
    return out


try:  # CUDA: one fused kernel per NLM pass instead of ~10 full-size passes per offset (Triton ships with torch on Linux)
    import triton
    import triton.language as tl

    @triton.jit
    def _nlm_kernel(guide, values, bmap, cmap, out, H, W, R: tl.constexpr, G: tl.constexpr, V: tl.constexpr, BLOCK: tl.constexpr):
        row = tl.program_id(1)
        x = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        live = x < W
        x = tl.minimum(x, W - 1)
        HW = H * W
        b = tl.load(bmap + row * W + x)
        c = tl.load(cmap + row * W + x)
        den = tl.zeros([BLOCK], tl.float32)
        acc0 = tl.zeros([BLOCK], tl.float32)
        acc1 = tl.zeros([BLOCK], tl.float32)
        for o in range(0, (2 * R + 1) * (2 * R + 1)):  # the centre is offset 0 with weight exp(min(0, b)) = 1
            dy = o // (2 * R + 1) - R
            dx = o % (2 * R + 1) - R
            d = tl.zeros([BLOCK], tl.float32)
            for qy in tl.static_range(3):
                ra = tl.minimum(tl.maximum(row + qy - 1, 0), H - 1) * W
                rb = tl.minimum(tl.maximum(row + dy + qy - 1, 0), H - 1) * W
                for qx in tl.static_range(3):
                    xa = tl.minimum(tl.maximum(x + qx - 1, 0), W - 1)
                    xb = tl.minimum(tl.maximum(x + dx + qx - 1, 0), W - 1)
                    for g in tl.static_range(G):
                        e = tl.load(guide + g * HW + ra + xa) - tl.load(guide + g * HW + rb + xb)
                        d += e * e
            w = tl.exp(tl.minimum(b - c * d, 0.0))
            den += w
            at = tl.minimum(tl.maximum(row + dy, 0), H - 1) * W + tl.minimum(tl.maximum(x + dx, 0), W - 1)
            acc0 += w * tl.load(values + at)
            if V == 2:
                acc1 += w * tl.load(values + HW + at)
        tl.store(out + row * W + x, acc0 / den, mask=live)
        if V == 2:
            tl.store(out + HW + row * W + x, acc1 / den, mask=live)


    @triton.jit
    def _bilinear_small(ptr, row, x, H, W, h, w):
        """A (h,w) field at output pixel (row, x) of an (H,W) frame, as F.interpolate(bilinear, align_corners=False)."""
        sy = tl.maximum((row + .5) * h / H - .5, 0.0)
        sx = tl.maximum((x + .5) * w / W - .5, 0.0)
        y0 = sy.to(tl.int32)
        x0 = sx.to(tl.int32)
        ly, lx = sy - y0, sx - x0
        y1 = tl.minimum(y0 + 1, h - 1)
        x1 = tl.minimum(x0 + 1, w - 1)
        top = (1 - lx) * tl.load(ptr + y0 * w + x0) + lx * tl.load(ptr + y0 * w + x1)
        bottom = (1 - lx) * tl.load(ptr + y1 * w + x0) + lx * tl.load(ptr + y1 * w + x1)
        return (1 - ly) * top + ly * bottom

    @triton.jit
    def _cubic(t, k: tl.constexpr):
        A: tl.constexpr = -0.75
        if k == 0:
            u = t + 1
            return ((A * u - 5 * A) * u + 8 * A) * u - 4 * A
        elif k == 1:
            return ((A + 2) * t - (A + 3)) * t * t + 1
        elif k == 2:
            u = 1 - t
            return ((A + 2) * u - (A + 3)) * u * u + 1
        else:
            u = 2 - t
            return ((A * u - 5 * A) * u + 8 * A) * u - 4 * A

    @triton.jit
    def _warp_luma(src, flow, kept, out, mask, H, W, h, w, BLOCK: tl.constexpr):
        """Bicubic warp of a neighbour's luma along the upscaled flow, and its weight mask (in frame × not occluded)."""
        row = tl.program_id(1)
        x = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        live = x < W
        x = tl.minimum(x, W - 1)
        px = x + _bilinear_small(flow, row, x, H, W, h, w) * (W / w)
        py = row + _bilinear_small(flow + h * w, row, x, H, W, h, w) * (H / h)
        inside = (px >= 0) & (px <= W - 1) & (py >= 0) & (py <= H - 1)
        cx = tl.minimum(tl.maximum(px, 0.0), W - 1.0)
        cy = tl.minimum(tl.maximum(py, 0.0), H - 1.0)
        ix = cx.to(tl.int32)
        iy = cy.to(tl.int32)
        tx, ty = cx - ix, cy - iy
        acc = tl.zeros([BLOCK], tl.float32)
        for j in tl.static_range(4):
            yy = tl.minimum(tl.maximum(iy + j - 1, 0), H - 1) * W
            line = tl.zeros([BLOCK], tl.float32)
            for i in tl.static_range(4):
                line += _cubic(tx, i) * tl.load(src + yy + tl.minimum(tl.maximum(ix + i - 1, 0), W - 1))
            acc += _cubic(ty, j) * line
        tl.store(out + row * W + x, acc, mask=live)
        tl.store(mask + row * W + x, tl.where(inside, _bilinear_small(kept, row, x, H, W, h, w), 0.0), mask=live)

    @triton.jit
    def _weight_luma(Y, Yw, mask, inv, num, den, sq, wout, H, W, tau1, fall, BLOCK: tl.constexpr):
        """w = exp(−max(0, box5((Y − Ŷ)²)·inv − 1 − τ)·fall)·mask, accumulated into the temporal sums."""
        row = tl.program_id(1)
        x = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        live = x < W
        x = tl.minimum(x, W - 1)
        total = tl.zeros([BLOCK], tl.float32)
        count = tl.zeros([BLOCK], tl.float32)
        for qy in tl.static_range(5):
            r = row + qy - 2
            if (r >= 0) & (r < H):
                for qx in tl.static_range(5):
                    c = x + qx - 2
                    ok = (c >= 0) & (c < W)
                    at = r * W + tl.minimum(tl.maximum(c, 0), W - 1)
                    e = tl.load(Y + at) - tl.load(Yw + at)
                    total += tl.where(ok, e * e, 0.0)
                    count += ok.to(tl.float32)
        at = row * W + x
        D = total / count * tl.load(inv + at)
        wt = tl.exp(-tl.maximum(D - tau1, 0.0) * fall) * tl.load(mask + at)
        tl.store(num + at, tl.load(num + at) + wt * tl.load(Yw + at), mask=live)
        tl.store(den + at, tl.load(den + at) + wt, mask=live)
        tl.store(sq + at, tl.load(sq + at) + wt * wt, mask=live)
        tl.store(wout + at, wt, mask=live)

    @triton.jit
    def _warp_chroma(cb, cr, flow, cbw, crw, inside_out, H, W, h, w, BLOCK: tl.constexpr):
        """Bilinear warp of a neighbour's chroma planes (H,W here are the chroma plane's)."""
        row = tl.program_id(1)
        x = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        live = x < W
        x = tl.minimum(x, W - 1)
        px = x + _bilinear_small(flow, row, x, H, W, h, w) * (W / w)
        py = row + _bilinear_small(flow + h * w, row, x, H, W, h, w) * (H / h)
        inside = (px >= 0) & (px <= W - 1) & (py >= 0) & (py <= H - 1)
        cx = tl.minimum(tl.maximum(px, 0.0), W - 1.0)
        cy = tl.minimum(tl.maximum(py, 0.0), H - 1.0)
        x0 = cx.to(tl.int32)
        y0 = cy.to(tl.int32)
        lx, ly = cx - x0, cy - y0
        x1 = tl.minimum(x0 + 1, W - 1)
        y1 = tl.minimum(y0 + 1, H - 1)
        top = (1 - lx) * tl.load(cb + y0 * W + x0) + lx * tl.load(cb + y0 * W + x1)
        bottom = (1 - lx) * tl.load(cb + y1 * W + x0) + lx * tl.load(cb + y1 * W + x1)
        tl.store(cbw + row * W + x, (1 - ly) * top + ly * bottom, mask=live)
        top = (1 - lx) * tl.load(cr + y0 * W + x0) + lx * tl.load(cr + y0 * W + x1)
        bottom = (1 - lx) * tl.load(cr + y1 * W + x0) + lx * tl.load(cr + y1 * W + x1)
        tl.store(crw + row * W + x, (1 - ly) * top + ly * bottom, mask=live)
        tl.store(inside_out + row * W + x, inside.to(tl.float32), mask=live)

    @triton.jit
    def _weight_chroma(Cb, Cr, Cbw, Crw, inside, inv_cb, inv_cr, wl, num_cb, num_cr, den, sq, H, W, LW, LH,
                       tau1, fall, SX: tl.constexpr, SY: tl.constexpr, BLOCK: tl.constexpr):
        """Chroma weight: the luma weight (averaged over the luma pixels this chroma sample covers) × chroma agreement."""
        row = tl.program_id(1)
        x = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        live = x < W
        x = tl.minimum(x, W - 1)
        total = tl.zeros([BLOCK], tl.float32)
        count = tl.zeros([BLOCK], tl.float32)
        for qy in tl.static_range(5):
            r = row + qy - 2
            if (r >= 0) & (r < H):
                for qx in tl.static_range(5):
                    c = x + qx - 2
                    ok = (c >= 0) & (c < W)
                    at = r * W + tl.minimum(tl.maximum(c, 0), W - 1)
                    eb = tl.load(Cb + at) - tl.load(Cbw + at)
                    er = tl.load(Cr + at) - tl.load(Crw + at)
                    total += tl.where(ok, eb * eb * tl.load(inv_cb + at) + er * er * tl.load(inv_cr + at), 0.0)
                    count += ok.to(tl.float32)
        luma = tl.zeros([BLOCK], tl.float32)
        for a in tl.static_range(SY):
            for b in tl.static_range(SX):
                luma += tl.load(wl + tl.minimum(row * SY + a, LH - 1) * LW + tl.minimum(x * SX + b, LW - 1))
        at = row * W + x
        wt = tl.exp(-tl.maximum(total / count - tau1, 0.0) * fall) * tl.load(inside + at) * luma / (SX * SY)
        tl.store(num_cb + at, tl.load(num_cb + at) + wt * tl.load(Cbw + at), mask=live)
        tl.store(num_cr + at, tl.load(num_cr + at) + wt * tl.load(Crw + at), mask=live)
        tl.store(den + at, tl.load(den + at) + wt, mask=live)
        tl.store(sq + at, tl.load(sq + at) + wt * wt, mask=live)

    TRITON = True
except Exception:  # noqa: BLE001 - no Triton (macOS, most Windows installs): the torch path does the same maths
    TRITON = False


def nlm(values, guide, b, c, radius, budget=1 << 28):
    if TRITON and values.is_cuda and values.shape[0] <= 2 and os.environ.get("FRAME_LINE_DENOISE_TRITON") != "0":
        V, H, W = values.shape
        out = torch.empty_like(values)
        BLOCK = 128
        _nlm_kernel[(triton.cdiv(W, BLOCK), H)](guide.contiguous(), values.contiguous(), b.contiguous(), c.contiguous(), out, H, W,
                                                R=radius, G=guide.shape[0], V=V, BLOCK=BLOCK)
        return out
    return nlm_torch(values, guide, b, c, radius, budget)


class Engine:
    """One output frame from its neighbours (spec "Temporal stage", "Spatial stage", "Detail and output")."""
    def __init__(self, device, layout, profile, settings, view, bits):
        self.device, self.layout, self.view = device, layout, view
        clamp = lambda key, lo, hi: min(hi, max(lo, float(settings.get(key, DEFAULTS[key]))))
        amount, chroma = clamp("amount", 0, 100), clamp("chroma", 0, 100)
        self.bypass = amount <= 0
        self.s = amount / 50  # thresholds scale with Strength / 50
        self.mix = min(1.0, amount / 20)
        self.chroma = chroma / 100
        self.radius = int(round(clamp("frames", 0, 3)))
        self.spatial = clamp("spatial", 0, 100) / 50
        self.detail = clamp("detail", 0, 100) / 100
        self.tables = {k: torch.tensor(profile["sigma"][k], device=device, dtype=torch.float32) for k in ("Y", "Cb", "Cr")}
        rho = profile.get("rho") or {}
        self.rho_y, self.rho_c = float(rho.get("Y", 1.5)), (float(rho.get("Cb", 1.5)) + float(rho.get("Cr", 1.5))) / 2
        self.mid = {k: float(lookup(self.tables[k], torch.tensor(.5, device=device))) for k in self.tables}
        self.scales = torch.tensor([1 / self.mid["Y"], 1 / self.mid["Cb"], 1 / self.mid["Cr"]], device=device).view(3, 1, 1)
        self.lsb = 65535 / (2 ** bits - 1)
        self.budget = 1 << 28  # bytes of NLM working memory per strip (torch path); quartered after an out-of-memory

    def frame(self, t, window, planes, pairs):
        L = self.layout
        H, W, ch, cw = L.height, L.width, L.ch, L.cw
        Y, Cb, Cr = planes(t)
        level = box(Y, 5)
        level_c = to_size(level, ch, cw)
        sY, sCb, sCr = lookup(self.tables["Y"], level), lookup(self.tables["Cb"], level_c), lookup(self.tables["Cr"], level_c)
        YT, CbT, CrT, rY, rCb, rCr = Y, Cb, Cr, sY, sCb, sCr
        if window:
            tau = TAU * (2 / 25) ** .5 * self.rho_y * self.s
            tau_c = TAU * (2 / 50) ** .5 * self.rho_c * self.s
            fall, fall_c = 1 / (LAMBDA_T * self.s), 1 / (LAMBDA_C * max(self.chroma * 2, .05))
            inv, inv_cb, inv_cr = .5 / sY.square(), .25 / sCb.square(), .25 / sCr.square()
            num, den, sq = Y.clone(), torch.ones_like(Y), torch.ones_like(Y)
            num_cb, num_cr, den_c, sq_c = Cb.clone(), Cr.clone(), torch.ones_like(Cb), torch.ones_like(Cb)
            sums = (num, den, sq, num_cb, num_cr, den_c, sq_c)
            fused = TRITON and Y.is_cuda and os.environ.get("FRAME_LINE_DENOISE_TRITON") != "0"
            for n in window:
                there, back = composed(pairs, t, n)
                kept = ((there + follow(back, there)).norm(dim=0) <= .5 + .05 * there.norm(dim=0)).float()
                neighbour = self.neighbour_fused if fused else self.neighbour_torch
                neighbour((Y, Cb, Cr), planes(n), there.contiguous(), kept, (inv, inv_cb, inv_cr), sums, (1 + tau, fall, 1 + tau_c, fall_c))
            YT, CbT, CrT = num / den, num_cb / den_c, num_cr / den_c
            gain, gain_c = sq.sqrt_() / den, sq_c.sqrt_() / den_c
            rY, rCb, rCr = sY * gain, sCb * gain_c, sCr * gain_c
        # Luma: NLM guided by the temporal result, strong only where temporal could not average.
        YS = YT
        if self.spatial > 0:
            lam = LAMBDA_S * self.spatial * self.s
            tau = TAU_S * (2 / 9) ** .5 * self.rho_y * self.s
            guide, var = YT, rY.square()
            if GUIDE_BOX:  # its noise is the residual's, shrunk by the box as far as the noise's correlation allows
                guide, var = box(YT, GUIDE_BOX), var * min(1.0, max(1 / GUIDE_BOX ** 2, self.rho_y ** 2 / GUIDE_BOX ** 2))
            b = torch.full_like(rY, (1 + tau) / lam)
            YS = nlm(YT[None], guide[None], b, 1 / (18 * lam * var), 4, self.budget)[0]
        # Detail: what was removed beyond the noise is real texture; a little of the rest keeps it natural.
        r = Y - YS
        YO = YS + self.detail * (r.sign() * (r.abs() - 2 * sY * self.s).clamp_(min=0) + GRAIN * r)
        CbO, CrO = Cb, Cr
        if self.chroma > 0:
            CbO, CrO = self.chroma_nlm(YT, CbT, CrT, rY, rCb, rCr)
        out = [x + self.mix * (o - x) for x, o in ((Y, YO), (Cb, CbO), (Cr, CrO))]
        if self.view == "noise":
            return [.5 + 4 * (x - o) for x, o in zip((Y, Cb, Cr), out)]
        return out

    def neighbour_torch(self, current, neighbour, there, kept, inverse, sums, falloff):
        """Warp one neighbour onto the current frame and add it to the temporal sums with its weights."""
        L = self.layout
        (Y, Cb, Cr), (Yn, Cbn, Crn), (inv, inv_cb, inv_cr) = current, neighbour, inverse
        num, den, sq, num_cb, num_cr, den_c, sq_c = sums
        tau1, fall, tau1_c, fall_c = falloff
        Yw, inside = warp(Yn, resize_flow(there, L.height, L.width), "bicubic")
        D = box((Y - Yw).square_(), 5).mul_(inv)
        w = D.sub_(tau1).clamp_(min=0).mul_(-fall).exp_().mul_(inside).mul_(upsample(kept, L.height, L.width))
        num.addcmul_(w, Yw)
        den += w
        sq.addcmul_(w, w)
        flow_c = resize_flow(there, L.ch, L.cw)
        Cbw, inside_c = warp(Cbn, flow_c, "bilinear")
        Crw, _ = warp(Crn, flow_c, "bilinear")
        Dc = box((Cb - Cbw).square_().mul_(inv_cb).add_((Cr - Crw).square_().mul_(inv_cr)), 5)
        wc = Dc.sub_(tau1_c).clamp_(min=0).mul_(-fall_c).exp_().mul_(inside_c).mul_(to_size(w, L.ch, L.cw))
        num_cb.addcmul_(wc, Cbw)
        num_cr.addcmul_(wc, Crw)
        den_c += wc
        sq_c.addcmul_(wc, wc)

    def neighbour_fused(self, current, neighbour, there, kept, inverse, sums, falloff):
        """neighbour_torch as four Triton kernels (CUDA)."""
        L = self.layout
        (Y, Cb, Cr), (Yn, Cbn, Crn), (inv, inv_cb, inv_cr) = current, neighbour, inverse
        num, den, sq, num_cb, num_cr, den_c, sq_c = sums
        tau1, fall, tau1_c, fall_c = falloff
        h, w = there.shape[1:]
        B = 256
        Yw, mask, wl = torch.empty_like(Y), torch.empty_like(Y), torch.empty_like(Y)
        luma, chroma = (triton.cdiv(L.width, B), L.height), (triton.cdiv(L.cw, B), L.ch)
        _warp_luma[luma](Yn, there, kept.contiguous(), Yw, mask, L.height, L.width, h, w, BLOCK=B)
        _weight_luma[luma](Y, Yw, mask, inv, num, den, sq, wl, L.height, L.width, tau1, fall, BLOCK=B)
        Cbw, Crw, inside = torch.empty_like(Cb), torch.empty_like(Cb), torch.empty_like(Cb)
        _warp_chroma[chroma](Cbn, Crn, there, Cbw, Crw, inside, L.ch, L.cw, h, w, BLOCK=B)
        _weight_chroma[chroma](Cb, Cr, Cbw, Crw, inside, inv_cb, inv_cr, wl, num_cb, num_cr, den_c, sq_c, L.ch, L.cw, L.width, L.height,
                               tau1_c, fall_c, SX=L.sx, SY=L.sy, BLOCK=B)

    def chroma_nlm(self, YT, CbT, CrT, rY, rCb, rCr):
        """Luma-guided joint NLM at the chroma plane's size, then at half that size for low-frequency blotches: the low
        band is replaced; of the high band, the part within the noise is removed in proportion to Chroma."""
        L = self.layout
        ch, cw = L.ch, L.cw
        g = self.scales
        Yc = to_size(YT, ch, cw)
        rYc = to_size(rY, ch, cw) / (L.sx * L.sy) ** .5
        s2 = ((rYc * g[0]).square() + (rCb * g[1]).square() + (rCr * g[2]).square()) / 3
        lam = LAMBDA_CS * self.chroma * 2
        tau = TAU * (2 / 27) ** .5 * self.rho_c * self.s
        b = torch.full_like(s2, (1 + tau) / lam)
        values = torch.stack((CbT, CrT))
        C1 = nlm(values, torch.cat((Yc[None], values)) * g, b, 1 / (54 * lam * s2), 4, self.budget)
        h2, w2 = -(-ch // 2), -(-cw // 2)
        Ch, Yh = to_size(C1, h2, w2), to_size(Yc, h2, w2)
        s2h = to_size(s2, h2, w2) / 4
        C2 = nlm(Ch, torch.cat((Yh[None], Ch)) * g, to_size(b, h2, w2), 1 / (54 * lam * s2h), 4, self.budget)
        high = C1 - upsample(Ch, ch, cw)
        limit = 2 * torch.stack((rCb, rCr))
        out = upsample(C2, ch, cw) + high - self.chroma * torch.minimum(torch.maximum(high, -limit), limit)
        return out[0], out[1]

    def pack(self, planes):
        """16-bit frame for the encoder, and on CUDA the event its asynchronous download completes at."""
        flat = torch.cat([p.reshape(-1) for p in planes]) * 65535
        # TPDF dither at one output LSB, so the encode never bands a smooth sky.
        flat += (torch.rand_like(flat) - torch.rand_like(flat)) * self.lsb
        out = flat.round_().clamp_(0, 65535).to(torch.int32).to(torch.uint16).view(torch.int16)
        if not out.is_cuda:
            return out.cpu(), None
        host = torch.empty(out.shape, dtype=torch.int16, pin_memory=True)
        host.copy_(out, non_blocking=True)
        ready = torch.cuda.Event()
        ready.record()
        return host, ready


def output_bits(encode):
    """Bit depth of the encode's pixel format (the LSB the dither works at)."""
    for i, arg in enumerate(encode[:-1]):
        if arg == "-pix_fmt":
            fmt = encode[i + 1]
            for bits in (16, 14, 12, 10, 9):
                if f"p{bits}" in fmt or f"{bits}le" in fmt or f"{bits}be" in fmt:
                    return bits
            return 8
    return 10


def out_of_memory(error):
    return isinstance(error, torch.OutOfMemoryError) or "out of memory" in str(error).lower()


def from_triton(error):
    """Raised inside Triton (building or launching a kernel), not by the maths or the flows around it."""
    return any("triton" in Path(frame.filename).parts for frame in traceback.extract_tb(error.__traceback__))


# ---------------------------------------------------------------- jobs

def render(job, report=None, cancelled=lambda: False):
    """One job (spec "Worker protocol"): decode with context, denoise, feed the server's encoder. Returns the result."""
    global TRITON
    started = time.time()
    report = report or (lambda progress, stage: emit(progress=progress, stage=stage))
    layout = Layout(job["pixfmt"], int(job["width"]), int(job["height"]))
    view = job.get("view") or "denoised"
    if view not in ("denoised", "noise"):
        raise ValueError(f"Unknown view {view}.")
    device = pick_device()
    threads = max(1, int(job.get("threads") or os.cpu_count() or 4))
    cv2.setNumThreads(threads)
    if device.type == "cpu":
        torch.set_num_threads(threads)
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()
    first, count = int(job["first"]), int(job["frames"])
    if first < 0 or count < 1:
        raise ValueError("Invalid frame range.")
    fps = Fraction(str(job["fps"]))
    total = round(float(job["duration"]) * fps) if job.get("duration") else None
    children, closers, flows = [], [], None
    try:
        with torch.inference_mode():
            hw = decode_args(job)
            profile = load_profile(job["profile"]) if job.get("profile") else None
            base = 0
            if profile is None:
                report(0, "profile")
                profile = measure_profile(job, layout, device, hw, lambda p: report(round(p * 15, 1), "profile"), cancelled, children)
                if job.get("profile"):
                    save_profile(job["profile"], profile)
                base = 15
            engine = Engine(device, layout, profile, job.get("settings") or {}, view, output_bits(job["encode"]))
            radius = 0 if engine.bypass else engine.radius
            start = max(0, first - radius)
            end = first + count + radius
            if total:
                end = max(first + 1, min(end, total))
            reader = Reader(job, layout, start, end - start, hw, children, pinned=device.type == "cuda")
            closers.append(reader.closed)
            writer = Writer(job, layout, children)
            closers.append(writer.closed)
            flows = Flows(layout, min(4, max(1, threads // 4)), device.type == "cuda") if radius else None
            raw, gpu, gpu_pairs = {}, {}, {}
            decoded, ended, written = 0, False, 0

            def planes(n):
                if n not in gpu:
                    gpu[n] = upload(raw[n], layout, device)
                return gpu[n]

            def pairs(j):
                if j not in gpu_pairs:
                    gpu_pairs[j] = tuple(f.to(device, non_blocking=True) for f in flows.pair(j))
                return gpu_pairs[j]

            report(base, "denoise")
            retried = False
            for k in range(count):
                t = first - start + k
                while not ended and decoded <= t + radius + 2:  # two ahead keeps the flow threads busy
                    data = reader.next()
                    if data is None:
                        ended = True
                        break
                    raw[decoded] = data
                    if flows:
                        flows.add(decoded, data)
                    decoded += 1
                if t >= decoded:
                    break  # the source ended: fewer frames than asked is not an error
                if cancelled():
                    raise Cancelled("Cancelled.")
                if engine.bypass:
                    writer.put(raw[t])
                else:
                    window = [n for n in range(t - radius, t + radius + 1) if n != t and 0 <= n < decoded]
                    out = None
                    while out is None:  # a retry runs outside the except, once its traceback has let go of the frame's tensors
                        try:
                            out = engine.frame(t, window, planes, pairs)
                        except Exception as error:
                            if TRITON and not out_of_memory(error) and from_triton(error):
                                # Triton imports but cannot build kernels here (no C compiler, Python headers or arch support):
                                # the torch path does the same maths, for this frame and every later job of this process.
                                TRITON = False
                                print(f"Noise Reduction: fused kernels unavailable, using torch ({describe(error)[:300]})", file=sys.stderr, flush=True)
                            elif not out_of_memory(error):
                                raise
                            elif retried:
                                raise ValueError(f"Not enough graphics memory for Noise Reduction at {layout.width}x{layout.height}. "
                                                 "Close other GPU work or lower Frames; sources this large may not fit this GPU.")
                            else:  # one retry with smaller NLM strips: the GPU is shared
                                retried, engine.budget = True, engine.budget // 4
                        if out is None and device.type == "cuda":
                            torch.cuda.empty_cache()
                    writer.put(*engine.pack(out))
                    del out
                written += 1
                for n in [n for n in raw if n < t - radius + 1]:
                    raw.pop(n), gpu.pop(n, None), gpu_pairs.pop(n, None)
                if flows:
                    flows.forget(t - radius)
                if k % 4 == 3 or k == count - 1:
                    report(round(base + (100 - base) * (k + 1) / count, 1), "denoise")
            if not written:
                raise ValueError("The source has no frames in this range.")
            writer.finish()
            sigma_y = float(lookup(engine.tables["Y"], torch.tensor(.5, device=device))) * 1023
        result = {"frames": written, "fps": job["fps"],
                  "profile": {"sigmaY": round(sigma_y, 3), "device": device.type, "seconds": round(time.time() - started, 2)}}
        if device.type == "cuda":
            result["profile"]["peakVram"] = round(torch.cuda.max_memory_allocated() / 2 ** 30, 3)
        return result
    finally:
        if flows:
            flows.close()
        # Kill, not terminate: a decoder blocked writing into a full pipe would sit out a terminate, and its frames are
        # not wanted. A finished encoder has already exited.
        for process in children:
            if process.poll() is None:
                process.kill()
        for process in children:
            process.wait()
        for closed in closers:
            closed.set()
        if device.type == "cuda":
            torch.cuda.empty_cache()


def describe(error):
    return str(error) if isinstance(error, (ValueError, AssertionError, InterruptedError, subprocess.CalledProcessError)) else f"{type(error).__name__}: {error}"


def serve():
    """Resident preview worker: requests {id, job} or {id, cancel:true} on stdin; every answer carries the id."""
    caps = capabilities()
    if not caps["available"]:
        raise ValueError(caps["reason"])
    requests, lock = queue.Queue(), threading.Lock()
    state = {"current": None, "cancel": threading.Event(), "dropped": set()}

    def listen():
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except ValueError:
                emit(error="Invalid request.")
                continue
            if message.get("cancel"):
                with lock:
                    if state["current"] == message.get("id"):
                        state["cancel"].set()
                    else:
                        state["dropped"].add(message.get("id"))
            else:
                requests.put(message)
        with lock:  # stdin closed: stop the running job and exit
            state["cancel"].set()
        requests.put(None)

    threading.Thread(target=listen, daemon=True).start()
    emit(ready=True, engine=caps["engine"], device=caps["device"])
    while (request := requests.get()) is not None:
        rid = request.get("id")
        with lock:
            if rid in state["dropped"]:
                state["dropped"].discard(rid)
                emit(id=rid, error="Cancelled.")
                continue
            state["current"], state["cancel"] = rid, threading.Event()
            cancel = state["cancel"]
        try:
            result = render(request["job"], lambda progress, stage: emit(id=rid, progress=progress, stage=stage), cancel.is_set)
            emit(id=rid, ok=True, result=result)
        except Exception as error:  # noqa: BLE001 - every request gets an answer
            emit(id=rid, error=describe(error))
        finally:
            with lock:
                state["current"] = None


# ---------------------------------------------------------------- self-check

def synthetic_scene(count=12, W=320, H=192, seed=3):
    """Clean yuv422 frames 0..1: a textured background panning sub-pixel and a bright square moving 5 px a frame."""
    rng = np.random.default_rng(seed)
    big = np.zeros((H * 2, W * 2), np.float32)
    yy, xx = np.mgrid[0:H * 2, 0:W * 2]
    big += .35 + .15 * np.sin(xx / 23.0) * np.cos(yy / 31.0)
    for _ in range(40):
        x0, y0 = rng.integers(0, W * 2 - 40), rng.integers(0, H * 2 - 40)
        big[y0:y0 + rng.integers(8, 40), x0:x0 + rng.integers(8, 40)] += rng.uniform(-.12, .12)
    big += cv2.GaussianBlur(rng.normal(0, .03, big.shape).astype(np.float32), (0, 0), 1.5)  # fine texture to keep
    cb_big = .5 + .05 * np.sin(xx / 40.0)
    cr_big = .5 + .05 * np.cos(yy / 35.0)
    frames, objects = [], []
    for t in range(count):
        m = np.float32([[1, 0, -40 - .6 * t], [0, 1, -30 - .35 * t]])
        Y = cv2.warpAffine(big, m, (W, H), flags=cv2.INTER_CUBIC)
        Cb = cv2.warpAffine(cb_big.astype(np.float32), m, (W, H), flags=cv2.INTER_CUBIC)
        Cr = cv2.warpAffine(cr_big.astype(np.float32), m, (W, H), flags=cv2.INTER_CUBIC)
        obj = np.zeros((H, W), bool)
        obj[70:120, 40 + 5 * t:90 + 5 * t] = True
        Y[obj], Cb[obj], Cr[obj] = .8, .62, .42
        frames.append((Y, (Cb[:, 0::2] + Cb[:, 1::2]) / 2, (Cr[:, 0::2] + Cr[:, 1::2]) / 2))
        objects.append(obj)
    return frames, objects


def selftest():
    ff = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not ff:
        raise AssertionError("The self-test needs ffmpeg (FFMPEG_PATH or PATH).")
    rng = np.random.default_rng(11)
    W, H, count, code = 320, 192, 12, 1 / 1023
    sigma_y, sigma_c = (4 ** 2 + 3 ** 2) ** .5 * code, (3 ** 2 + 2 ** 2) ** .5 * code
    clean, objects = synthetic_scene(count, W, H)

    def noise(shape, white, correlated):
        blurred = cv2.GaussianBlur(rng.normal(0, 1, shape).astype(np.float32), (0, 0), 1.0)
        return rng.normal(0, white, shape) + blurred / blurred.std() * correlated

    noisy = [(Y + noise(Y.shape, 4 * code, 3 * code), Cb + noise(Cb.shape, 3 * code, 2 * code), Cr + noise(Cr.shape, 3 * code, 2 * code)) for Y, Cb, Cr in clean]
    checks = {}
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        raw = b"".join(np.concatenate([np.clip(p, 0, 1).reshape(-1) for p in f]).__mul__(65535).round().astype("<u2").tobytes() for f in noisy)
        subprocess.run([ff, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv422p16le", "-s", f"{W}x{H}", "-r", "30", "-color_range", "tv", "-i", "-",
                        "-c:v", "ffv1", "-pix_fmt", "yuv422p16le", str(folder / "noisy.mkv")], input=raw, check=True)

        def job(name, **settings):
            return {"ffmpeg": ff, "input": str(folder / "noisy.mkv"), "inputArgs": [], "fps": "30", "first": 0, "frames": count, "duration": count / 30,
                    "width": W, "height": H, "pixfmt": "yuv422p16le", "colors": {"range": "tv", "matrix": "bt709"},
                    "settings": {**DEFAULTS, **settings}, "view": "denoised", "profile": str(folder / "profiles" / "noisy.json"),
                    "encode": ["-c:v", "ffv1", "-pix_fmt", "yuv422p16le", "-color_range", "tv", "-y", str(folder / f"{name}.mkv")], "threads": 4}

        def luma(path, filters=None):
            command = [ff, "-v", "error", "-i", str(path), *(["-vf", filters] if filters else []), "-f", "rawvideo", "-pix_fmt", "yuv422p16le", "-"]
            data = np.frombuffer(subprocess.run(command, capture_output=True, check=True).stdout, "<u2").astype(np.float64) / 65535
            size = W * H * 2
            return [data[i * size:i * size + W * H].reshape(H, W) for i in range(len(data) // size)]

        def psnr(frames):
            inner = (slice(8, -8), slice(8, -8))
            mse = np.mean([((f - c[0])[inner] ** 2).mean() for f, c in zip(frames, clean)])
            return 10 * np.log10(1 / mse)

        result = render(job("full"), lambda *_: None)
        assert set(result) == {"frames", "fps", "profile"} and result["frames"] == count and {"sigmaY", "device", "seconds"} <= set(result["profile"]), result
        profile = load_profile(folder / "profiles" / "noisy.json")
        assert profile and not list((folder / "profiles").glob("*.tmp")), "the measured profile was not written atomically"
        for plane, target in (("Y", sigma_y), ("Cb", sigma_c), ("Cr", sigma_c)):
            measured = float(np.median(profile["sigma"][plane][5:12]))
            assert abs(measured / target - 1) < .15, f"profile {plane}: {measured / code:.2f} codes, injected {target / code:.2f}"
            checks[f"profile {plane}"] = round(measured / target, 3)
        render(job("spatial", frames=0), lambda *_: None)
        scores = {"temporal+spatial": psnr(luma(folder / "full.mkv")), "spatial only": psnr(luma(folder / "spatial.mkv")),
                  "input": psnr([f[0] for f in noisy])}
        scores["hqdn3d"] = max(psnr(luma(folder / "noisy.mkv", f"hqdn3d={a}")) for a in ("4:3:6:4.5", "8:6:12:9", "12:9:18:13"))
        scores["nlmeans"] = max(psnr(luma(folder / "noisy.mkv", f"format=yuv422p,nlmeans=s={s},format=yuv422p16le")) for s in (1, 2, 4))
        for other in ("spatial only", "hqdn3d", "nlmeans"):
            assert scores["temporal+spatial"] > scores[other], f"PSNR {scores}"
        checks["psnr"] = {k: round(v, 2) for k, v in scores.items()}
        # No ghosting: where the square was in the neighbouring frames but is not now, the result must not carry it.
        out = luma(folder / "full.mkv")
        trail = [(objects[t - 2] | objects[t - 1] | objects[t + 1] | objects[t + 2]) & ~cv2.dilate(objects[t].astype(np.uint8), np.ones((3, 3))).astype(bool)
                 for t in range(2, count - 2)]
        errors = np.concatenate([(out[t] - clean[t][0])[m] for t, m in zip(range(2, count - 2), trail)])
        assert abs(errors.mean()) < 1 * code and errors.std() < sigma_y, f"ghosting: bias {errors.mean() / code:.2f}, rms {errors.std() / code:.2f} codes"
        checks["moving edge"] = {"bias": round(errors.mean() / code, 3), "rms": round(errors.std() / code, 3)}
        # Strength 0 is a bypass; the noise view is centred on mid grey.
        render({**job("bypass", amount=0)}, lambda *_: None)
        assert all(np.array_equal(a, b) for a, b in zip(luma(folder / "bypass.mkv"), luma(folder / "noisy.mkv"))), "Strength 0 changed the picture"
        render({**job("noise"), "view": "noise"}, lambda *_: None)
        assert abs(np.mean(luma(folder / "noise.mkv")) - .5) < .01, "the noise view is not centred on mid grey"
        # The resident worker: a job answers with its id, a cancelled one says so, stdin EOF ends it.
        worker = subprocess.Popen([sys.executable, __file__, "--serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        assert json.loads(worker.stdout.readline()).get("ready")
        worker.stdin.write(json.dumps({"id": "a", "job": job("served")}) + "\n")
        worker.stdin.write(json.dumps({"id": "b", "job": job("cancelled")}) + "\n")
        worker.stdin.write(json.dumps({"id": "b", "cancel": True}) + "\n")
        worker.stdin.flush()
        answers = {}
        while len(answers) < 2:
            message = json.loads(worker.stdout.readline())
            assert "id" in message, message
            if "progress" not in message:
                answers[message["id"]] = message
        worker.stdin.close()
        assert worker.wait(timeout=60) == 0
        assert answers["a"].get("ok") and answers["a"]["result"]["frames"] == count, answers
        assert answers["b"].get("error") == "Cancelled.", answers
        checks["serve"] = "ok"
        # Slot i is the same source frame whatever frame a reader starts from: an MPEG-TS seek lands up to a GOP late, and
        # over a timestamp gap (frames 100-102 missing) every reader repeats frame 99. Frame n is flat luma 16 + n.
        small, children = Layout("yuv420p16le", 64, 32), []
        flat = b"".join(bytes([16 + n]) * 2048 + bytes([128]) * 1024 for n in range(150))
        for name, args in (("index.ts", ["-c:v", "mpeg2video", "-g", "15", "-bf", "2", "-q:v", "1"]),
                           ("gap.mkv", ["-vf", "select=not(between(n\\,100\\,102))", "-fps_mode", "passthrough", "-c:v", "ffv1"])):
            subprocess.run([ff, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "64x32", "-r", "30", "-i", "-", *args, str(folder / name)],
                           input=flat, check=True)
            present = [n for n in range(150) if name == "index.ts" or not 100 <= n <= 102]
            for s in (3, 95, 98, 101, 140):
                frames = grab({"ffmpeg": ff, "input": str(folder / name), "fps": "30"}, small, s, 4, [], children)
                got = [(round(float(f.numpy()[:2 * small.luma].view(np.uint16).mean())) >> 8) - 16 for f in frames]
                want = [max(n for n in present if n <= i) for i in range(s, s + 4)]
                assert got == want, f"{name} from frame {s}: source frames {got}, expected {want}"
        for process in children:
            process.wait()
        checks["frame grid"] = "ok"
    emit(ok=True, checks=checks)


def interrupted(*_):
    raise Cancelled("Cancelled.")


if __name__ == "__main__":
    try:
        arguments = sys.argv[1:]
        if arguments == ["--check"]:
            emit(**capabilities())
        elif MISSING:
            raise ValueError(capabilities()["reason"])
        elif arguments == ["--selftest"]:
            selftest()
        elif arguments == ["--serve"]:
            serve()
        elif len(arguments) == 1:
            signal.signal(signal.SIGTERM, interrupted)
            emit(**render(json.loads(Path(arguments[0]).read_text(encoding="utf-8"))))
        else:
            raise ValueError("Usage: denoise.py --check | --selftest | --serve | <job.json>")
    except Exception as error:
        print(f"Noise Reduction: {describe(error)}", file=sys.stderr, flush=True)
        sys.exit(1)
