#!/usr/bin/env python3
"""SharedCut Stabilize worker: OpenCV camera-path analysis and warp rendering.

Usage:
  stabilize.py --check            print {"available": true, "opencv": "..."}
  stabilize.py --selftest         synthetic shake round trip, exit 0 on success
  stabilize.py job.json           run an "analyze" or "render" stage (see docs/superpowers/specs)

Progress is reported as newline JSON {"progress": n} on stdout. Cross-platform: ffmpeg is the only
external tool, reached through the path the server passes in the job.
"""
import json
import math
import subprocess
import sys

import cv2
import numpy as np

FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf"
ANALYSIS_LONG_SIDE = 960
GRID = 4
FEATURES_PER_CELL = 40
MIN_INLIERS = 12
SETTING_DEFAULTS = {"amount": 100, "smoothness": 50, "cropMode": 0, "zoom": 10, "tripod": 0, "maxShift": 15, "maxAngle": 5}


def emit(**message):
    print(json.dumps(message, allow_nan=False), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------- source access

def probe(job):
    result = subprocess.run([job["ffprobe"], "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
                             "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,color_space,color_range,color_primaries,color_transfer",
                             "-of", "json", job["input"]], check=True, capture_output=True, text=True)
    streams = json.loads(result.stdout).get("streams") or []
    if not streams:
        fail("The source has no video stream to stabilize.")
    stream = streams[0]
    rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "24/1"
    numerator, _, denominator = rate.partition("/")
    fps = float(numerator) / float(denominator or 1) if float(denominator or 1) else 24.0
    if not (1 <= fps <= 240):
        fps = 24.0
    return {"width": int(stream["width"]), "height": int(stream["height"]), "fps": fps,
            "matrix": stream.get("color_space") or ("bt709" if stream["height"] >= 720 else "bt601"),
            "range": "pc" if stream.get("color_range") == "pc" else "tv",
            "primaries": stream.get("color_primaries") or "bt709", "transfer": stream.get("color_transfer") or "bt709"}


def matrix_name(value):
    return {"bt709": "bt709", "bt470bg": "bt601", "smpte170m": "bt601", "bt601": "bt601", "bt2020nc": "bt2020", "bt2020": "bt2020", "bt2020c": "bt2020"}.get(value, "bt709")


def decoder(job, info, start, duration, pix_fmt, scale=None):
    """Constant-frame-rate rawvideo pipe over [start, start+duration) of the source."""
    filters = [f"scale=in_color_matrix={matrix_name(info['matrix'])}:in_range={info['range']}" + (f":w={scale[0]}:h={scale[1]}:flags=area" if scale else "")]
    command = [job["ffmpeg"], "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS,
               "-ss", f"{start:.6f}", "-i", job["input"], "-t", f"{duration:.6f}", "-an", "-sn",
               "-vf", ",".join(filters), "-r", f"{info['fps']:.6f}", "-fps_mode", "cfr",
               "-f", "rawvideo", "-pix_fmt", pix_fmt, "-"]
    return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def frames_from(process, width, height, channels, dtype):
    size = width * height * channels * np.dtype(dtype).itemsize
    while True:
        data = process.stdout.read(size)
        if len(data) < size:
            break
        array = np.frombuffer(data, dtype=dtype)
        yield array.reshape(height, width, channels) if channels > 1 else array.reshape(height, width)


def finish(process, label):
    process.stdout.close()
    errors = process.stderr.read().decode(errors="replace")
    if process.wait() != 0:
        fail(f"{label} failed: {errors.strip()[-2000:] or process.returncode}")


# ---------------------------------------------------------------- analysis

def grid_features(gray):
    height, width = gray.shape
    points = []
    for row in range(GRID):
        for column in range(GRID):
            y0, y1 = row * height // GRID, (row + 1) * height // GRID
            x0, x1 = column * width // GRID, (column + 1) * width // GRID
            found = cv2.goodFeaturesToTrack(gray[y0:y1, x0:x1], maxCorners=FEATURES_PER_CELL, qualityLevel=0.01,
                                            minDistance=max(6, width // 120), blockSize=7)
            if found is not None:
                points.append(found.reshape(-1, 2) + np.array([x0, y0], dtype=np.float32))
    return np.concatenate(points).astype(np.float32).reshape(-1, 1, 2) if points else None


def pair_motion(previous, current):
    """Similarity mapping `previous` to `current` as (tx, ty, angle, logScale) in analysis pixels, or None."""
    points = grid_features(previous)
    if points is None or len(points) < MIN_INLIERS:
        return None
    window = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    forward, status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None, **window)
    backward, back_status, _ = cv2.calcOpticalFlowPyrLK(current, previous, forward, None, **window)
    keep = (status.reshape(-1) == 1) & (back_status.reshape(-1) == 1) & (np.linalg.norm((backward - points).reshape(-1, 2), axis=1) < 1.0)
    if keep.sum() < MIN_INLIERS:
        return None
    matrix, inliers = cv2.estimateAffinePartial2D(points[keep], forward[keep], method=cv2.RANSAC, ransacReprojThreshold=2.0, confidence=0.99, refineIters=10)
    if matrix is None or inliers is None or inliers.sum() < MIN_INLIERS:
        return None
    # Express the translation at the frame centre so it sums cleanly and matches the centre-anchored correction.
    height, width = previous.shape
    centre = np.array([width / 2.0, height / 2.0])
    moved = matrix[:, :2] @ centre + matrix[:, 2] - centre
    return float(moved[0]), float(moved[1]), math.atan2(matrix[1, 0], matrix[0, 0]), math.log(max(1e-6, math.hypot(matrix[0, 0], matrix[1, 0])))


def analyze_frames(frames, full_width, progress=None, total=None):
    """Consume an iterator of gray frames (already downscaled) and return (motions, dropped)."""
    motions, dropped, previous = [], [], None
    for index, frame in enumerate(frames):
        if previous is None:
            motions.append([0.0, 0.0, 0.0, 0.0])
        else:
            motion = pair_motion(previous, frame)
            if motion is None:
                dropped.append(index)
                motions.append([0.0, 0.0, 0.0, 0.0])
            else:
                ratio = full_width / frame.shape[1]
                motions.append([motion[0] * ratio, motion[1] * ratio, motion[2], motion[3]])
        previous = frame
        if progress and total and index % 4 == 0:
            progress(index / total)
    return motions, dropped


def analyze(job):
    info = probe(job)
    start, end = float(job["from"]), float(job["to"])
    if not end > start:
        fail("Analysis range is empty.")
    ratio = min(1.0, ANALYSIS_LONG_SIDE / max(info["width"], info["height"]))
    width, height = max(32, int(round(info["width"] * ratio)) // 2 * 2), max(32, int(round(info["height"] * ratio)) // 2 * 2)
    total = max(1, int(round((end - start) * info["fps"])))
    process = decoder(job, info, start, end - start, "gray", (width, height))
    motions, dropped = analyze_frames(frames_from(process, width, height, 1, np.uint8), info["width"], lambda p: emit(progress=round(p * 98, 1)), total)
    finish(process, "Source decode")
    if len(motions) < 2:
        fail("The clip is too short to stabilize.")
    path = {"version": 1, "width": info["width"], "height": info["height"], "fps": info["fps"], "from": start, "to": end,
            "matrix": info["matrix"], "range": info["range"], "primaries": info["primaries"], "transfer": info["transfer"],
            "frames": [[round(v, 5) for v in m] for m in motions], "dropped": dropped}
    with open(job["output"], "w", encoding="utf-8") as stream:
        json.dump(path, stream)
    emit(progress=100)


# ---------------------------------------------------------------- camera path -> corrections

def gaussian_smooth(values, sigma):
    if sigma <= 0.01:
        return values.copy()
    radius = int(math.ceil(sigma * 3))
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(values, ((radius, radius), (0, 0)), mode="edge")
    return np.stack([np.convolve(padded[:, column], kernel, mode="valid") for column in range(values.shape[1])], axis=1)


def settings_of(raw):
    settings = dict(SETTING_DEFAULTS)
    for key, default in SETTING_DEFAULTS.items():
        try:
            value = float(raw.get(key, default))
            settings[key] = value if math.isfinite(value) else float(default)
        except (TypeError, ValueError, AttributeError):
            settings[key] = float(default)
    return settings


def corrections(path, raw_settings):
    """Per-frame correction (dx, dy, dAngle, dLogScale) applied about the frame center."""
    settings = settings_of(raw_settings)
    motions = np.array(path["frames"], dtype=np.float64)
    trajectory = np.cumsum(motions, axis=0)
    if settings["tripod"] >= 0.5:
        target = np.repeat(trajectory[:1], len(trajectory), axis=0)
    else:
        sigma = (max(0.0, settings["smoothness"]) / 100.0) ** 1.5 * path["fps"] * 2.5 + 0.5  # 100 -> about 5 s window
        target = gaussian_smooth(trajectory, sigma)
    delta = (target - trajectory) * (settings["amount"] / 100.0)
    max_shift = settings["maxShift"] / 100.0 * path["width"]
    shift = np.hypot(delta[:, 0], delta[:, 1])
    over = shift > max_shift
    if max_shift <= 0:
        delta[:, :2] = 0
    elif over.any():
        delta[over, :2] *= (max_shift / shift[over])[:, None]
    max_angle = math.radians(settings["maxAngle"])
    delta[:, 2] = np.clip(delta[:, 2], -max_angle, max_angle)
    delta[:, 3] = np.clip(delta[:, 3], math.log(0.8), math.log(1.25))
    return delta, settings


def similarity(dx, dy, angle, scale, cx, cy):
    cos, sin = math.cos(angle) * scale, math.sin(angle) * scale
    matrix = np.array([[cos, -sin, 0.0], [sin, cos, 0.0]])
    matrix[:, 2] = [cx - cos * cx + sin * cy + dx, cy - sin * cx - cos * cy + dy]
    return matrix


def frame_matrices(path, delta):
    cx, cy = path["width"] / 2.0, path["height"] / 2.0
    return [similarity(d[0], d[1], d[2], math.exp(d[3]), cx, cy) for d in delta]


def fits(matrix, zoom, width, height):
    """Does the centered output window at `zoom` stay inside the warped source for this frame?"""
    inverse = cv2.invertAffineTransform(matrix)
    half_w, half_h = width / (2.0 * zoom), height / (2.0 * zoom)
    corners = np.array([[width / 2 - half_w, height / 2 - half_h], [width / 2 + half_w, height / 2 - half_h],
                        [width / 2 + half_w, height / 2 + half_h], [width / 2 - half_w, height / 2 + half_h]])
    source = corners @ inverse[:, :2].T + inverse[:, 2]
    return bool((source[:, 0] >= -0.5).all() and (source[:, 0] <= width + 0.5).all() and (source[:, 1] >= -0.5).all() and (source[:, 1] <= height + 0.5).all())


def auto_zoom(matrices, width, height, cap):
    low, high = 1.0, max(1.0, cap)
    if all(fits(m, low, width, height) for m in matrices):
        return low
    if not all(fits(m, high, width, height) for m in matrices):
        return high
    for _ in range(24):
        middle = (low + high) / 2
        if all(fits(m, middle, width, height) for m in matrices):
            high = middle
        else:
            low = middle
    return high


def output_matrices(path, raw_settings):
    delta, settings = corrections(path, raw_settings)
    matrices = frame_matrices(path, delta)
    width, height = path["width"], path["height"]
    mode = int(round(settings["cropMode"]))
    if mode == 2:
        zoom = 1.0
    elif mode == 1:
        zoom = 1.0 + max(0.0, settings["zoom"]) / 100.0
    else:
        zoom = auto_zoom(matrices, width, height, 1.0 + max(0.0, settings["zoom"]) / 100.0)
    cx, cy = width / 2.0, height / 2.0
    zoom_matrix = np.array([[zoom, 0.0, cx - zoom * cx], [0.0, zoom, cy - zoom * cy], [0.0, 0.0, 1.0]])
    return [(zoom_matrix @ np.vstack([matrix, [0.0, 0.0, 1.0]]))[:2] for matrix in matrices], zoom


# ---------------------------------------------------------------- render

def render(job):
    with open(job["path"], "r", encoding="utf-8") as stream:
        path = json.load(stream)
    info = {"width": path["width"], "height": path["height"], "fps": path["fps"], "matrix": path.get("matrix", "bt709"),
            "range": path.get("range", "tv"), "primaries": path.get("primaries", "bt709"), "transfer": path.get("transfer", "bt709")}
    start, end, preview = float(job["from"]), float(job["to"]), bool(job.get("preview"))
    if not end > start:
        fail("Render range is empty.")
    matrices, _zoom = output_matrices(path, job.get("settings") or {})
    first = int(round((start - path["from"]) * info["fps"]))
    count = max(1, int(round((end - start) * info["fps"])))
    width, height = info["width"], info["height"]
    pix_fmt, dtype = ("rgb24", np.uint8) if preview else ("rgb48le", np.uint16)
    matrix = matrix_name(info["matrix"])
    encode = [job["ffmpeg"], "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{width}x{height}", "-r", f"{info['fps']:.6f}", "-i", "-", "-an",
              "-vf", f"scale=out_color_matrix={matrix}:out_range=tv", "-colorspace", "smpte170m" if matrix == "bt601" else matrix,
              "-color_primaries", info["primaries"], "-color_trc", info["transfer"], "-color_range", "tv"]
    if preview:
        encode += ["-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-qp", "0", "-g", str(max(1, round(info["fps"] / 2))), "-pix_fmt", "yuv422p10le", "-movflags", "+faststart"]
    else:
        encode += ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]
    encode += ["-y", job["output"]]
    source = decoder(job, info, start, end - start, pix_fmt)
    sink = subprocess.Popen(encode, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    written = 0
    try:
        for index, frame in enumerate(frames_from(source, width, height, 3, dtype)):
            if index >= count:
                break
            matrix_index = min(len(matrices) - 1, max(0, first + index))
            warped = cv2.warpAffine(frame, matrices[matrix_index], (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
            sink.stdin.write(np.ascontiguousarray(warped).tobytes())
            written += 1
            if index % 6 == 0:
                emit(progress=round(index / count * 98, 1))
    except BrokenPipeError:
        pass
    finish(source, "Source decode")
    sink.stdin.close()
    errors = sink.stderr.read().decode(errors="replace")
    if sink.wait() != 0:
        fail(f"Encoder failed: {errors.strip()[-2000:]}")
    if written == 0:
        fail("The source produced no frames for this range.")
    emit(progress=100)


# ---------------------------------------------------------------- self-check

def synthetic_shake(count=72, width=640, height=360, seed=7):
    rng = np.random.default_rng(seed)
    canvas = np.full((height * 2, width * 2), 96, dtype=np.uint8)
    for _ in range(80):
        a, b = rng.integers(0, (width * 2, height * 2)), rng.integers(0, (width * 2, height * 2))
        cv2.rectangle(canvas, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), int(rng.integers(0, 255)), -1)
    for _ in range(80):
        c = rng.integers(0, (width * 2, height * 2))
        cv2.circle(canvas, (int(c[0]), int(c[1])), int(rng.integers(4, 40)), int(rng.integers(0, 255)), -1)
    texture = cv2.GaussianBlur(rng.normal(0, 40, canvas.shape), (0, 0), 1.0)
    canvas = np.clip(canvas.astype(np.float64) + texture, 0, 255).astype(np.uint8)
    pose = np.zeros((count, 3))
    for i in range(1, count):
        pose[i] = pose[i - 1] + [rng.normal(0.4, 3.0), rng.normal(0.0, 3.0), rng.normal(0.0, math.radians(0.6))]
    frames, matrices = [], []
    for tx, ty, angle in pose:
        # Camera pose (tx, ty, angle): the visible window is the canvas centre moved by the pose.
        matrix = similarity(-tx, -ty, -angle, 1.0, width, height)
        matrix[:, 2] -= [width / 2, height / 2]
        frames.append(cv2.warpAffine(canvas, matrix, (width, height), flags=cv2.INTER_LINEAR))
        matrices.append(np.vstack([matrix, [0.0, 0.0, 1.0]]))
    # True frame-to-frame similarity in frame coordinates: previous frame -> current frame.
    truth = [[0.0, 0.0, 0.0, 0.0]]
    for previous, current in zip(matrices, matrices[1:]):
        step = current @ np.linalg.inv(previous)
        centre = np.array([width / 2.0, height / 2.0, 1.0])
        moved = (step @ centre)[:2] - centre[:2]
        truth.append([moved[0], moved[1], math.atan2(step[1, 0], step[0, 0]), 0.0])
    return frames, np.array(truth)


def jitter(trajectory):
    return float(np.std(np.diff(trajectory[:, :2], axis=0)))


def selftest():
    frames, truth = synthetic_shake()
    width, height = frames[0].shape[1], frames[0].shape[0]
    motions, dropped = analyze_frames(iter(frames), width)
    assert not dropped, f"dropped frames {dropped}"
    recovered = np.cumsum(np.array(motions), axis=0)
    error = float(np.sqrt(np.mean((np.array(motions)[:, :2] - truth[:, :2]) ** 2)))
    assert error < 0.5, f"motion error {error:.2f} px per frame"
    path = {"version": 1, "width": width, "height": height, "fps": 24.0, "from": 0.0, "to": len(frames) / 24.0, "frames": motions, "dropped": []}
    matrices, zoom = output_matrices(path, {"amount": 100, "smoothness": 70, "cropMode": 0, "zoom": 40, "tripod": 0, "maxShift": 50, "maxAngle": 30})
    stabilized = [cv2.warpAffine(frame, matrix, (width, height), flags=cv2.INTER_LINEAR) for frame, matrix in zip(frames, matrices)]
    after, _ = analyze_frames(iter(stabilized), width)
    before_jitter, after_jitter = jitter(recovered), jitter(np.cumsum(np.array(after), axis=0))
    assert after_jitter < before_jitter / 4, f"jitter {before_jitter:.2f} -> {after_jitter:.2f}"
    tripod, _ = output_matrices(path, {"tripod": 1, "amount": 100, "cropMode": 2, "maxShift": 50, "maxAngle": 30})
    locked = [cv2.warpAffine(frame, matrix, (width, height), flags=cv2.INTER_LINEAR) for frame, matrix in zip(frames[:24], tripod[:24])]
    locked_motion, _ = analyze_frames(iter(locked), width)
    locked_jitter = jitter(np.cumsum(np.array(locked_motion), axis=0))
    assert locked_jitter < 0.6, f"tripod mode still moves {locked_jitter:.2f}"
    print(json.dumps({"ok": True, "pathErrorPx": round(error, 3), "jitterBefore": round(before_jitter, 3), "jitterAfter": round(after_jitter, 3), "tripodJitter": round(locked_jitter, 3), "autoZoom": round(zoom, 4)}))


def main(argv):
    if argv[1:] == ["--check"]:
        emit(available=True, opencv=cv2.__version__)
        return
    if argv[1:] == ["--selftest"]:
        selftest()
        return
    if len(argv) != 2:
        fail(__doc__)
    with open(argv[1], "r", encoding="utf-8") as stream:
        job = json.load(stream)
    stage = job.get("stage")
    if stage == "analyze":
        analyze(job)
    elif stage == "render":
        render(job)
    else:
        fail(f"Unknown stage {stage!r}.")


if __name__ == "__main__":
    main(sys.argv)
