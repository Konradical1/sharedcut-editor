#!/usr/bin/env python3
"""SharedCut's depth worker: Video Depth Anything Small over a range of source frames.

    depth.py --check        JSON identity: engine, weights, source hash, torch, device
    depth.py --selftest     helper checks that need no model
    depth.py <job.json>     analyse one run (written by server/depth.ts)

Frames come straight from the original through an FFmpeg pipe, accurately seeked to the first frame's
presentation time, so output frame i is source frame first + i. Depth is VDA's own long-video scheme
(32-frame windows every 22 frames, keyframe scale/shift alignment), run one window at a time so frames
are written as soon as no later window can change them. Every 64 frames become one segment:
preview/<n>.mp4 for the browser and master/<n>.mkv for export.

FRAME_LINE_DEPTH_ENGINE=synthetic swaps the model for source luma (FFmpeg only, no torch or numpy) so
tests run anywhere. Model code is vendored from DepthAnything/Video-Depth-Anything at
4f5ae23172ba60fd7bc11ef671cca678842c7072 (Apache-2.0); the alignment below is ported from its
utils/util.py and video_depth.py.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
VENDOR = Path(__file__).resolve().parent / "vendor"
WEIGHTS = Path(os.environ.get("FRAME_LINE_DEPTH_WEIGHTS", ROOT / "artifacts/depth/video_depth_anything_vits.pth"))
WEIGHTS_SHA256 = "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609"
ENGINE = os.environ.get("FRAME_LINE_DEPTH_ENGINE", "vda").lower()
FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf"
IMAGE_FORMATS = "image2,png_pipe,jpeg_pipe,webp_pipe,gif,tiff_pipe,bmp_pipe,mov"
SEGMENT = 64
RATE = 30  # DEPTH_SEGMENT_RATE in src/services/depth.ts
# VDA's long-video settings (vendor video_depth.py); the model was trained for exactly these.
INFER_LEN, OVERLAP, INTERP_LEN = 32, 10, 8
KEYFRAMES = [0, 12, 24, 25, 26, 27, 28, 29, 30, 31]
ALIGN = KEYFRAMES[:OVERLAP - INTERP_LEN]
HEADROOM = .25
_out = threading.Lock()


def replace(source, target):
    """os.replace that waits out Defender or the indexer briefly holding a file FFmpeg just closed (Windows
    PermissionError); one failed rename would otherwise fail a run of up to 25 minutes."""
    for attempt in range(8):
        try:
            return os.replace(source, target)
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(.05 * 2 ** attempt)


def emit(**message):
    with _out:
        print(json.dumps(message, allow_nan=False), flush=True)


def digest(path):
    """SHA-256 of the weights, remembered by path, size and mtime so a capability check does not re-hash 116 MB.
    ponytail: size+mtime identity; delete digests.json if weights are ever swapped in place with both preserved."""
    stat, cache = Path(path).stat(), Path(path).with_name("digests.json")
    key = f"{Path(path).resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
    try:
        known = json.loads(cache.read_text())
    except (OSError, ValueError):
        known = {}
    if key not in known:
        with open(path, "rb") as stream:
            known[key] = hashlib.file_digest(stream, "sha256").hexdigest()
        try:
            temporary = cache.with_name(f"{cache.name}.{os.getpid()}.tmp")
            temporary.write_text(json.dumps(known))
            os.replace(temporary, cache)
        except OSError:
            pass
    return known[key]


def source_identity():
    h = hashlib.sha256(Path(__file__).read_bytes())
    for path in sorted((VENDOR / "video_depth_anything").rglob("*.py")):
        h.update(path.relative_to(VENDOR).as_posix().encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def precision(device):
    full = os.environ.get("FRAME_LINE_DEPTH_PRECISION", "").lower() in ("full", "fp32", "float32")
    return "fp32" if device == "cpu" or full else "fp16"


def model_class():
    """The vendored model. Its xFormers probes print and log on import; neither is news here (SDPA replaces it)."""
    import contextlib
    import io
    import logging
    logging.getLogger("dinov2").setLevel(logging.ERROR)
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))
    with contextlib.redirect_stdout(io.StringIO()):
        from video_depth_anything.video_depth import VideoDepthAnything
    return VideoDepthAnything


def capabilities():
    if ENGINE == "synthetic":
        return dict(available=True, engine="Synthetic (source luma)", device="cpu",
                    workerIdentity=dict(engine="synthetic", source=source_identity()))
    if not WEIGHTS.is_file():
        return dict(available=False, engine="Video Depth Anything Small", device="none",
                    reason="Depth is not installed on this server. Run npm run setup:depth.")
    import torch
    model_class()  # Proves einops, easydict and the vendored code import.
    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    weights = digest(WEIGHTS)
    if weights != WEIGHTS_SHA256:
        return dict(available=False, engine="Video Depth Anything Small", device=device,
                    reason="The installed depth weights differ from the pinned weights. Run npm run setup:depth.")
    return dict(available=True, engine="Video Depth Anything Small", device=device,
                workerIdentity=dict(engine="vda-small", weights=weights, source=source_identity(),
                                    torch=torch.__version__, device=device, precision=precision(device)))


def filter_path(path):
    return str(path).replace("\\", "\\\\").replace("'", "'\\''").replace(":", "\\:")


class Decoder:
    """Source frames at analysis size, decoded by FFmpeg in its own process and read on a thread."""

    def __init__(self, job, pix_fmt):
        width, height = job["width"], job["height"]
        self.size = width * height * (3 if pix_fmt == "rgb24" else 1)
        scale = [f"scale={width}:{height}:flags=bicubic"]
        if job.get("dataLevels") in ("full", "Full", "limited", "Video"):
            scale.append("in_range=" + ("pc" if job["dataLevels"] in ("full", "Full") else "tv"))
        matrix = {"bt709": "bt709", "bt601": "bt601", "bt2020nc": "bt2020", "bt2020": "bt2020"}.get(job.get("yuvMatrix"))
        if matrix:
            scale.append("in_color_matrix=" + matrix)
        # Scale first: the analysis LUT then runs on 0.5 MP instead of 8 MP of 4K, and the YUV->RGB
        # conversion happens once, in this scale, with the clip's range and matrix.
        filters = [":".join(scale)]
        if job.get("analysisLutPath"):
            filters.append(f"lut3d=file='{filter_path(job['analysisLutPath'])}'")
        filters.append(f"format={pix_fmt}")
        seek = [] if job.get("seek") is None else ["-ss", f"{job['seek']:.6f}"]
        command = [job["ffmpeg"], "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
                   "-format_whitelist", IMAGE_FORMATS if job.get("image") else FORMATS, *seek, "-i", job["input"],
                   "-map", "0:v:0", "-vf", ",".join(filters), "-frames:v", str(job["frames"]),
                   "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", pix_fmt, "pipe:1"]
        self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.frames = queue.Queue(maxsize=48)
        self.errors = b""
        self.stderr = threading.Thread(target=self._errors, daemon=True)
        self.stderr.start()
        threading.Thread(target=self._read, daemon=True).start()

    def _errors(self):
        self.errors = self.process.stderr.read()[-4000:]

    def _read(self):
        try:
            while True:
                frame = self.process.stdout.read(self.size)
                if len(frame) < self.size:
                    break
                self.frames.put(frame)
        finally:
            self.frames.put(None)

    def next(self):
        frame = self.frames.get()
        if frame is None:
            self.frames.put(None)
            if self.process.wait() != 0:
                self.stderr.join(5)  # The reason may still be on its way from FFmpeg's stderr.
                raise ValueError("Could not decode the original: " + self.errors.decode(errors="replace").strip()[-600:])
        return frame

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait()


# --- Alignment, ported from Video Depth Anything (Apache-2.0): utils/util.py and video_depth.py ---

def scale_and_shift(predictions, targets):
    """Least-squares scale and shift taking the prediction frames onto the target frames (VDA
    compute_scale_and_shift_full with an all-ones mask). Frames are numpy arrays or torch tensors; the normal
    equations are summed per frame and solved in double precision, where VDA's float32 lost digits."""
    a_00 = sum(float((p * p).sum()) for p in predictions)
    a_01 = sum(float(p.sum()) for p in predictions)
    a_11 = float(sum(p.shape[0] * p.shape[1] for p in predictions))
    b_0 = sum(float((p * t).sum()) for p, t in zip(predictions, targets))
    b_1 = sum(float(t.sum()) for t in targets)
    det = a_00 * a_11 - a_01 * a_01
    if det == 0:
        return 1.0, 0.0
    return (a_11 * b_0 - a_01 * b_1) / det, (-a_01 * b_0 + a_00 * b_1) / det


def interpolate(pre, post):
    """VDA get_interpolate_frames: cross-fade the overlap from the old window to the new one."""
    step = 1 / (len(pre) - 1)
    return [pre[i] * (1 - i * step) + post[i] * (i * step) for i in range(len(pre))]


class Aligner:
    """VDA's batch alignment loop, fed one 32-frame window at a time. A frame is final once it is out of
    reach of the next window's overlap cross-fade, so `push` returns frames in order as soon as they settle;
    the output equals the batch loop's exactly (see selftest). Works on numpy arrays and on torch tensors,
    which keeps the real engine's frames on the GPU."""

    def __init__(self, total):
        self.total, self.done, self.tail, self.ref = total, 0, [], None

    def _release(self, frames):
        keep = frames[:max(0, self.total - self.done)]
        self.done += len(keep)
        return keep

    def push(self, depth):
        if self.ref is None:
            self.ref = [depth[k] for k in ALIGN]
            aligned = list(depth)
        else:
            scale, shift = scale_and_shift([depth[i] for i in range(len(ALIGN))], self.ref)
            fit = lambda frame: (frame * scale + shift).clip(0)
            self.tail = interpolate(self.tail, [fit(depth[i]) for i in range(len(ALIGN), OVERLAP)])
            aligned = self.tail + [fit(depth[i]) for i in range(OVERLAP, INFER_LEN)]
            self.ref = self.ref[:1] + [fit(depth[k]) for k in ALIGN[1:]]
        self.tail = aligned[-INTERP_LEN:]
        return self._release(aligned[:-INTERP_LEN])

    def finish(self):
        return self._release(self.tail)


def mapping(lo_percentile, hi_percentile):
    """The run's fixed value mapping from the first window: p1..p99 plus 25 % headroom each side."""
    span = max(hi_percentile - lo_percentile, 1e-6 * max(1.0, abs(hi_percentile)))
    lo, hi = lo_percentile - HEADROOM * span, hi_percentile + HEADROOM * span
    return dict(lo=float(lo), hi=float(hi), near=float((hi_percentile - lo) / (hi - lo)), far=float((lo_percentile - lo) / (hi - lo)))


# --- Segments ---

# Measured on real VDA-Small output from the Dell (1080p clip, 924x518, bytes per frame / max error):
#   FFV1 10-bit lossless 60 KB / 0;  H.264 High 10 at QP 14, deblock, AQ and psy off 17.6 KB / 11 of 1023
#   (mean 0.3);  x265 near-lossless 11-15 KB but up to 150 of 1023 of ringing at depth edges.
# The disk on the Dell is the constraint, so the master is the bounded-error H.264 at a third of the size.
# Psy and AQ tuning target what eyes notice in pictures; depth is data, so both are off in both encodes.
MASTER = dict(codec="h264", pix_fmt="yuv420p10le", range="pc", bits=10)


def segment_commands(ffmpeg, width, height, preview, master):
    raw = ["-f", "rawvideo", "-s", f"{width}x{height}", "-r", str(RATE)]
    common = ["-c:v", "libx264", "-preset", "medium", "-g", "16", "-keyint_min", "16", "-sc_threshold", "0", "-color_range", "pc"]
    return ([ffmpeg, "-v", "error", "-y", "-nostdin", *raw, "-pix_fmt", "yuvj420p", "-color_range", "pc", "-i", "pipe:0",
             *common, "-crf", "16", "-bf", "0", "-x264-params", "psy=0:aq-mode=0", "-movflags", "+faststart", "-f", "mp4", str(preview)],
            [ffmpeg, "-v", "error", "-y", "-nostdin", *raw, "-pix_fmt", "yuv420p10le", "-color_range", "pc", "-i", "pipe:0",
             *common, "-qp", "14", "-x264-params", "no-deblock=1:psy=0:aq-mode=0", "-f", "matroska", str(master)])


class Writer:
    """Collects finished frames and encodes each 64-frame segment on its own thread while analysis continues.
    A frame is (gray8 bytes, little-endian 10-bit bytes)."""

    def __init__(self, job):
        self.job, self.width, self.height = job, job["width"], job["height"]
        self.output = Path(job["output"])
        for name in ("preview", "master"):
            (self.output / name).mkdir(parents=True, exist_ok=True)
        self.chroma = b"\x80" * (self.width * self.height // 2)  # 8-bit 4:2:0 neutral chroma
        self.chroma10 = b"\x00\x02" * (self.width * self.height // 2)  # 10-bit, 512
        self.pending, self.segments, self.failure = [], [], None
        self.work = queue.Queue(maxsize=2)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def add(self, preview, master):
        if self.failure:
            raise self.failure
        self.pending.append((preview, master))
        if len(self.pending) == SEGMENT:
            self._flush()

    def _flush(self):
        if self.pending:
            self.work.put((len(self.segments), self.pending))
            self.segments.append(dict(n=len(self.segments), first=self.job["first"] + len(self.segments) * SEGMENT, count=len(self.pending)))
            self.pending = []

    def _run(self):
        while (item := self.work.get()) is not None:
            if self.failure:
                continue
            n, frames = item
            try:
                preview, master = self.output / "preview" / f"{n}.mp4", self.output / "master" / f"{n}.mkv"
                temporary = [path.with_name(f".{path.name}.tmp") for path in (preview, master)]
                commands = segment_commands(self.job["ffmpeg"], self.width, self.height, *temporary)
                blobs = (b"".join(y + self.chroma for y, _ in frames), b"".join(m + self.chroma10 for _, m in frames))
                for command, blob in zip(commands, blobs):
                    result = subprocess.run(command, input=blob, capture_output=True)
                    if result.returncode:
                        raise ValueError("Could not encode depth: " + result.stderr.decode(errors="replace").strip()[-600:])
                for source, target in zip(temporary, (preview, master)):
                    replace(source, target)
                emit(segment=n, first=self.job["first"] + n * SEGMENT, count=len(frames))
            except Exception as error:  # Surfaced to the analysis loop on its next frame or at finish.
                self.failure = error

    def finish(self):
        self._flush()
        self.work.put(None)
        self.thread.join()
        if self.failure:
            raise self.failure
        return self.segments


# --- Engines ---

def run_synthetic(job, writer, progress):
    """Depth from source luma, FFmpeg and the standard library only: tests and browser checks need no model."""
    decoder, total = Decoder(job, "gray"), job["frames"]
    try:
        first = []
        while len(first) < min(INFER_LEN, total) and (frame := decoder.next()) is not None:
            first.append(frame)
        if len(first) < min(INFER_LEN, total):
            raise ValueError("Source decoder dropped a frame.")
        sample = b"".join(frame[::97] for frame in first)
        histogram, seen, low, high = [sample.count(bytes([v])) for v in range(256)], 0, None, 255
        for value, count in enumerate(histogram):
            seen += count
            if low is None and seen >= .01 * len(sample):
                low = value
            if seen >= .99 * len(sample):
                high = value
                break
        values = mapping(low, high)
        emit(mapping=values)
        level = [min(1.0, max(0.0, (v - values["lo"]) / (values["hi"] - values["lo"]))) for v in range(256)]
        eight = bytes(round(v * 255) for v in level)
        ten = [round(v * 1023) for v in level]
        low_byte, high_byte = bytes(v & 255 for v in ten), bytes(v >> 8 for v in ten)
        done = 0

        def write(frame):
            ten_bit = bytearray(len(frame) * 2)
            ten_bit[0::2], ten_bit[1::2] = frame.translate(low_byte), frame.translate(high_byte)
            writer.add(frame.translate(eight), bytes(ten_bit))

        for frame in first:
            write(frame)
            done += 1
        while done < total:
            frame = decoder.next()
            if frame is None:
                raise ValueError("Source decoder dropped a frame.")
            write(frame)
            done += 1
            if done % 22 == 0:
                progress(done)
        return values
    finally:
        decoder.close()


def run_vda(job, caps, writer, progress):
    import numpy as np
    import torch
    VideoDepthAnything = model_class()
    device, total = caps["device"], job["frames"]
    decoder = Decoder(job, "rgb24")  # FFmpeg starts decoding while the model loads.
    try:
        emit(progress=1, stage="Loading the depth model")
        model = VideoDepthAnything(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
        model.load_state_dict(torch.load(WEIGHTS, map_location="cpu", weights_only=True), strict=True)
        model = model.to(device).eval()
        fp16 = precision(device) == "fp16"
        mean = torch.tensor([.485, .456, .406], device=device).view(1, 1, 3, 1, 1)
        std = torch.tensor([.229, .224, .225], device=device).view(1, 1, 3, 1, 1)
        height, width = job["height"], job["width"]
        state = dict(micro=4, retried=False)
        if device == "cuda":
            torch.cuda.reset_peak_memory_stats()

        def infer(x):
            # The vendored forward, with the head's spatial mini-batch exposed for the out-of-memory retry.
            with torch.autocast(device_type=device, dtype=torch.float16, enabled=fp16):
                features = model.pretrained.get_intermediate_layers(x.flatten(0, 1), model.intermediate_layer_idx["vits"], return_class_token=True)
                depth = model.head(features, height // 14, width // 14, INFER_LEN, micro_batch_size=state["micro"])[0]
                depth = torch.nn.functional.interpolate(depth, size=(height, width), mode="bilinear", align_corners=True)
                return torch.relu(depth).squeeze(1).float()

        def window(x):
            try:
                return infer(x)
            except torch.OutOfMemoryError:
                if state["retried"]:
                    raise ValueError("The GPU is busy: not enough video memory for depth analysis. Try again in a moment.") from None
                state.update(micro=1, retried=True)
            # Retried outside the except block: its traceback holds the failed attempt's activations, which
            # empty_cache() cannot free while they are referenced.
            torch.cuda.empty_cache()
            return infer(x)

        aligner, values, previous, last, read, done = Aligner(total), None, None, None, 0, 0

        def write(frames):
            # Alignment, the value mapping and quantizing stay on the device; only finished bytes come back.
            nonlocal done
            if not frames:
                return
            v = ((torch.stack(frames) - values["lo"]) / (values["hi"] - values["lo"])).clamp_(0, 1)
            eight = (v * 255 + .5).to(torch.uint8).cpu().numpy()
            ten = (v * 1023 + .5).to(torch.int16).cpu().numpy().astype("<u2", copy=False)
            for preview, master in zip(eight, ten):
                writer.add(preview.tobytes(), master.tobytes())
            done += len(frames)
            progress(done)

        with torch.inference_mode():
            for start in range(0, total, INFER_LEN - OVERLAP):
                batch = []
                for _ in range(INFER_LEN if previous is None else INFER_LEN - OVERLAP):
                    if read < total:
                        frame = decoder.next()
                        if frame is None:
                            raise ValueError("Source decoder dropped a frame.")
                        read, last = read + 1, np.frombuffer(frame, np.uint8).reshape(height, width, 3)
                    batch.append(last)  # Past the end VDA repeats the last frame.
                x = torch.from_numpy(np.stack(batch)).to(device).permute(0, 3, 1, 2).float().div_(255).unsqueeze(0)
                x = (x - mean) / std
                if previous is not None:
                    x = torch.cat([previous, x], dim=1)
                depth = window(x)
                previous = x[:, KEYFRAMES]
                if values is None:
                    sample = depth[:min(INFER_LEN, total), ::2, ::2].flatten()
                    low, high = torch.quantile(sample.cpu(), torch.tensor([.01, .99])).tolist()
                    values = mapping(low, high)
                    emit(mapping=values)
                write(aligner.push(list(depth)))
            write(aligner.finish())
        if device == "cuda":
            emit(peakVram=round(torch.cuda.max_memory_allocated() / 2**30, 3), reservedVram=round(torch.cuda.max_memory_reserved() / 2**30, 3))
        return values
    finally:
        decoder.close()


def main(job):
    caps = capabilities()
    if not caps["available"]:
        raise ValueError(caps["reason"])
    if job.get("workerIdentity") is not None and job["workerIdentity"] != caps["workerIdentity"]:
        raise ValueError("The depth engine changed while this analysis was queued. Analyze again.")
    width, height, total = job["width"], job["height"], job["frames"]
    if width % 14 or height % 14 or not 0 < total <= 36000:
        raise ValueError("Invalid depth job.")
    output = Path(job["output"])
    writer = Writer(job)
    emit(progress=1, stage="Analyzing depth")
    report = lambda done: emit(progress=round(2 + 96 * done / total, 1), stage="Analyzing depth")
    values = (run_synthetic(job, writer, report) if ENGINE == "synthetic" else run_vda(job, caps, writer, report))
    segments = writer.finish()
    if sum(segment["count"] for segment in segments) != total:
        raise ValueError("Depth output is incomplete.")
    manifest = dict(version=1, key=job.get("key"), engine=caps["engine"], workerIdentity=caps["workerIdentity"],
                    width=width, height=height, first=job["first"], frames=total, segments=segments,
                    preview=dict(codec="h264", pix_fmt="yuvj420p", rate=RATE), master=dict(MASTER, rate=RATE), **values)
    temporary = output / ".manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, allow_nan=False))
    replace(temporary, output / "manifest.json")


# --- Self test ---

def batch_align(windows, total):
    """Video Depth Anything's original loop (video_depth.py infer_video_depth), the reference for Aligner."""
    import numpy as np
    depth_list = [frame for window in windows for frame in window]
    aligned, ref = [], []
    for frame_id in range(0, len(depth_list), INFER_LEN):
        if not aligned:
            aligned += depth_list[:INFER_LEN]
            ref = [depth_list[frame_id + k] for k in ALIGN]
            continue
        scale, shift = scale_and_shift([depth_list[frame_id + i] for i in range(len(ALIGN))], ref)
        post = [np.maximum(depth_list[frame_id + i] * scale + shift, 0) for i in range(len(ALIGN), OVERLAP)]
        aligned[-INTERP_LEN:] = interpolate(aligned[-INTERP_LEN:], post)
        aligned += [np.maximum(depth_list[frame_id + i] * scale + shift, 0) for i in range(OVERLAP, INFER_LEN)]
        ref = ref[:1] + [np.maximum(depth_list[frame_id + k] * scale + shift, 0) for k in ALIGN[1:]]
    return aligned[:total]


def selftest():
    checks = []
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is not None:
        rng = np.random.default_rng(7)
        for total in (1, 5, 22, 32, 33, 54, 100, 141):
            windows = [rng.random((INFER_LEN, 3, 4), dtype=np.float32) * 3 for _ in range(len(range(0, total, INFER_LEN - OVERLAP)))]
            aligner, streamed = Aligner(total), []
            for window in windows:
                streamed += aligner.push(window)
            streamed += aligner.finish()
            reference = batch_align(windows, total)
            assert len(streamed) == total and all(np.array_equal(a, b) for a, b in zip(streamed, reference)), f"streamed alignment differs at {total} frames"
        # A near plane (disparity 2) and a far plane (0.5), each window seen at its own unknown scale and shift,
        # keyframes repeated the way VDA feeds them: alignment brings every frame back onto the first window's scale.
        truth = np.zeros((6, 8), np.float32) + .5
        truth[:, :3] = 2
        total, windows = 141, []
        for w in range(len(range(0, total, INFER_LEN - OVERLAP))):
            s, t = (1.0, 0.0) if w == 0 else (rng.uniform(.3, 3), rng.uniform(-.2, .4))
            windows.append([truth * s + t] * INFER_LEN)
        aligner, frames = Aligner(total), []
        for window in windows:
            frames += aligner.push(window)
        frames += aligner.finish()
        assert all(np.allclose(frame, truth, atol=1e-4) for frame in frames), "alignment did not recover the first window's scale"
        values = mapping(*np.percentile(np.stack(frames[:32]), [1, 99]))
        near = (2 - values["lo"]) / (values["hi"] - values["lo"])
        far = (.5 - values["lo"]) / (values["hi"] - values["lo"])
        assert near > far and abs(near - values["near"]) < 1e-6 and abs(far - values["far"]) < 1e-6 and abs(values["near"] - 5 / 6) < 1e-6
        checks.append("alignment")
    ffmpeg, ffprobe = os.environ.get("FFMPEG_PATH", "ffmpeg"), os.environ.get("FFPROBE_PATH", "ffprobe")
    with tempfile.TemporaryDirectory() as directory:
        directory = Path(directory)
        # Long-GOP H.264 with B-frames, every frame a different level: the decoder must return exactly source
        # frames first..first+n in presentation order, however packets were ordered.
        clip = directory / "levels.mp4"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=112x56:r=25:d=6",
                        "-vf", "geq=lum='N*1.6':cb=128:cr=128", "-c:v", "libx264", "-g", "50", "-bf", "3",
                        "-pix_fmt", "yuv420p", str(clip)], check=True)
        packets = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
                                  "-of", "csv=p=0", str(clip)], capture_output=True, text=True, check=True).stdout.split()
        times = sorted(float(value.split(",")[0]) for value in packets if value.strip())
        times = [t - times[0] for t in times]
        assert len(times) == 150
        first, count = 70, 40
        job = dict(ffmpeg=ffmpeg, input=str(clip), width=112, height=56, first=first, frames=count,
                   seek=(times[first - 1] + times[first]) / 2, output=str(directory / "run"))
        decoder, levels = Decoder(job, "gray"), []
        while (frame := decoder.next()) is not None:
            levels.append(sum(frame[::7]) / len(frame[::7]))
        decoder.close()
        expected = [min(255, max(0, (int(n * 1.6) - 16) * 255 / 219)) for n in range(first, first + count)]  # limited -> full range
        assert len(levels) == count and all(abs(a - b) <= 2 for a, b in zip(levels, expected)), f"decoded frames are not source frames {first}..{first + count - 1}"
        checks.append("frame order")
        # Segment round trip on a busier pattern than real depth: about one step on average for both, bounded at worst.
        width, height, total = 112, 56, 70
        writer = Writer(dict(job, first=128, frames=total))
        sent = []
        for i in range(total):
            ten = [min(1023, max(0, round(512 + 400 * math.sin(x / 9 + i / 7) * math.cos(y / 11)))) for y in range(height) for x in range(width)]
            master = b"".join(v.to_bytes(2, "little") for v in ten)
            preview = bytes(round(v * 255 / 1023) for v in ten)
            writer.add(preview, master)
            sent.append((preview, master))
        segments = writer.finish()
        assert [(s["n"], s["first"], s["count"]) for s in segments] == [(0, 128, 64), (1, 192, 6)]
        out = Path(job["output"])
        got_preview = b"".join(subprocess.run([ffmpeg, "-v", "error", "-i", str(out / "preview" / f"{s['n']}.mp4"), "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout for s in segments)
        got_master = b"".join(subprocess.run([ffmpeg, "-v", "error", "-i", str(out / "master" / f"{s['n']}.mkv"), "-f", "rawvideo", "-pix_fmt", "gray10le", "-"], capture_output=True, check=True).stdout for s in segments)
        want_preview, want_master = b"".join(p for p, _ in sent), b"".join(m for _, m in sent)
        master_errors = [abs(int.from_bytes(got_master[i:i + 2], "little") - int.from_bytes(want_master[i:i + 2], "little")) for i in range(0, len(want_master), 10)]
        assert len(got_master) == len(want_master) and sum(master_errors) / len(master_errors) <= 1 and max(master_errors) <= 24, \
            f"master error mean {sum(master_errors) / len(master_errors):.2f} max {max(master_errors)} of 1023"
        assert len(got_preview) == len(want_preview)
        errors = [abs(a - b) for a, b in zip(got_preview[::5], want_preview[::5])]
        assert sum(errors) / len(errors) <= 1 and max(errors) <= 10, f"preview error mean {sum(errors) / len(errors):.2f} max {max(errors)}"
        probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_range,nb_frames",
                                "-of", "json", str(out / "preview" / "0.mp4")], capture_output=True, text=True, check=True)
        stream = json.loads(probe.stdout)["streams"][0]
        assert stream["color_range"] == "pc" and stream["nb_frames"] == "64", stream
        checks.append("segments")
        # A rename Windows refuses twice (a scanner holding the file) still lands; a failed decode says why.
        real, refusals = os.replace, [PermissionError(13, "locked")] * 2
        def flaky(source, target):
            if refusals:
                raise refusals.pop()
            real(source, target)
        os.replace = flaky
        try:
            (directory / "a").write_text("x")
            replace(directory / "a", directory / "b")
        finally:
            os.replace = real
        assert (directory / "b").read_text() == "x" and not refusals
        broken = Decoder(dict(job, input=str(directory / "missing.mp4")), "gray")
        try:
            broken.next()
            raise AssertionError("a missing original decoded")
        except ValueError as error:
            assert "missing.mp4" in str(error), error
        checks.append("windows locks and decode errors")
    emit(ok=True, checks=checks, skipped=[] if np is not None else ["alignment (numpy is not installed)"])


if __name__ == "__main__":
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    try:
        if sys.argv[1:] == ["--check"]:
            emit(**capabilities())
        elif sys.argv[1:] == ["--selftest"]:
            selftest()
        else:
            main(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as error:
        detail = error if isinstance(error, (ValueError, AssertionError, subprocess.CalledProcessError)) else f"{type(error).__name__}: {error}"
        print(f"Depth: {detail}", file=sys.stderr)
        sys.exit(1)
