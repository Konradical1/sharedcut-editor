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
import os
import subprocess
import sys

import cv2
import numpy as np

FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf"
ANALYSIS_LONG_SIDE = 960
GRID = 4
FEATURES_PER_CELL = 40
MIN_INLIERS = 12
SETTING_DEFAULTS = {"amount": 100, "smoothness": 50, "crop": 5, "lock": 0}
MAX_LOCK_ZOOM = 3.0
MAX_FRAME_ROTATION = math.radians(1.5)  # a real camera does not rotate faster than this between frames at sports frame rates
MAX_FRAME_SCALE = 0.04


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


_hwaccel_cache = {}


def hardware_decode_args(job):
    """Detected, never assumed: try the platform decoder on this very file and fall back to software if it cannot."""
    if os.environ.get("FRAME_LINE_HWACCEL", "").lower() in ("off", "0", "false"):
        return []
    key = (job["ffmpeg"], job["input"])
    if key in _hwaccel_cache:
        return _hwaccel_cache[key]
    args = []
    try:
        listed = subprocess.run([job["ffmpeg"], "-hide_banner", "-hwaccels"], capture_output=True, text=True, timeout=20).stdout
        candidates = [name for name in ("videotoolbox", "cuda", "d3d11va", "vaapi") if name in listed.split()]
        for name in candidates:
            trial = [job["ffmpeg"], "-v", "error", "-nostdin", "-hwaccel", name, "-i", job["input"], "-frames:v", "2", "-f", "null", "-"]
            if subprocess.run(trial, capture_output=True, timeout=60).returncode == 0:
                args = ["-hwaccel", name]
                break
    except (OSError, subprocess.SubprocessError):
        args = []
    _hwaccel_cache[key] = args
    return args


def decoder(job, info, start, duration, pix_fmt, scale=None):
    """Constant-frame-rate rawvideo pipe over [start, start+duration) of the source."""
    filters = [f"scale=in_color_matrix={matrix_name(info['matrix'])}:in_range={info['range']}" + (f":w={scale[0]}:h={scale[1]}:flags=area" if scale else "")]
    command = [job["ffmpeg"], "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS, *hardware_decode_args(job),
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
    """Raises instead of exiting so an analysis worker process reports the ffmpeg error to the parent."""
    process.stdout.close()
    errors = process.stderr.read().decode(errors="replace")
    if process.wait() != 0:
        raise RuntimeError(f"{label} failed: {errors.strip()[-2000:] or process.returncode}")


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
    angle, log_scale = math.atan2(matrix[1, 0], matrix[0, 0]), math.log(max(1e-6, math.hypot(matrix[0, 0], matrix[1, 0])))
    if abs(angle) > MAX_FRAME_ROTATION or abs(log_scale) > MAX_FRAME_SCALE:
        return None  # foreground players or a whip pan fooled the fit; interpolate through it instead
    # Express the translation at the frame centre so it sums cleanly and matches the centre-anchored correction.
    height, width = previous.shape
    centre = np.array([width / 2.0, height / 2.0])
    moved = matrix[:, :2] @ centre + matrix[:, 2] - centre
    return float(moved[0]), float(moved[1]), angle, log_scale


def analyze_frames(frames, full_width, tick=None):
    """Consume an iterator of gray frames (already downscaled) and return (motions, dropped). `tick(n)` reports n frames done."""
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
        if tick and index % 4 == 3:
            tick(4)
    return motions, dropped


def fill_dropped(motions, dropped):
    """Replace lost frames with the average of their nearest tracked neighbours so the path keeps moving."""
    if not dropped:
        return motions
    filled = [list(m) for m in motions]
    lost = set(dropped)
    for index in dropped:
        low, high = index - 1, index + 1
        while low in lost:
            low -= 1
        while high in lost:
            high += 1
        neighbours = [motions[i] for i in (low, high) if 0 <= i < len(motions)]
        if neighbours:
            filled[index] = [float(v) for v in np.mean(neighbours, axis=0)]
    return filled


def analysis_size(info):
    ratio = min(1.0, ANALYSIS_LONG_SIDE / max(info["width"], info["height"]))
    return max(32, int(round(info["width"] * ratio)) // 2 * 2), max(32, int(round(info["height"] * ratio)) // 2 * 2)


_progress_counter = None


def _init_progress(counter):
    """Pool initializer: every worker process bumps the same counter so the parent can report frames, not segments."""
    global _progress_counter
    _progress_counter = counter


def _tick(frames):
    if _progress_counter is not None:
        with _progress_counter.get_lock():
            _progress_counter.value += frames


def analyze_segment(task):
    """One decode + track pass over [start, end); starts one frame early so the first motion is real, not identity."""
    job, info, start, end, lead = task
    width, height = analysis_size(info)
    process = decoder(job, info, max(0.0, start - lead), end - max(0.0, start - lead), "gray", (width, height))
    motions, dropped = analyze_frames(frames_from(process, width, height, 1, np.uint8), info["width"], _tick)
    finish(process, "Source decode")
    if lead > 0 and start - lead >= 0 and motions:
        motions, dropped = motions[1:], [d - 1 for d in dropped if d >= 1]
    return motions, dropped


def analyze(job):
    info = probe(job)
    start, end = float(job["from"]), float(job["to"])
    if not end > start:
        fail("Analysis range is empty.")
    fps = info["fps"]
    total = max(1, int(round((end - start) * fps)))
    # Decode and tracking both run near real time on 4K; segments in parallel processes share the load.
    # ponytail: fixed 2 s segments and up to 8 workers; tune from the machine's core count if it shows up.
    segment_frames = max(1, int(round(2.0 * fps)))
    starts = list(range(0, total, segment_frames))
    tasks = [(job, info, start + first / fps, start + min(total, first + segment_frames) / fps, 1.0 / fps) for first in starts]
    workers = max(1, min(8, len(tasks), (os.cpu_count() or 2) // 2))
    import multiprocessing
    counter = multiprocessing.Value("i", 0)
    report = lambda: emit(progress=round(min(98.0, counter.value / total * 98), 1))
    if workers == 1:
        _init_progress(counter)
        results = []
        for task in tasks:
            results.append(analyze_segment(task))
            report()
    else:
        import concurrent.futures
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers, initializer=_init_progress, initargs=(counter,)) as pool:
            futures = [pool.submit(analyze_segment, task) for task in tasks]
            pending = set(futures)
            while pending:
                _, pending = concurrent.futures.wait(pending, timeout=0.25)
                report()
            results = [future.result() for future in futures]
    motions, dropped = [], []
    for segment_motions, segment_dropped in results:
        offset = len(motions)
        motions.extend(segment_motions)
        dropped.extend(d + offset for d in segment_dropped)
    if len(motions) < 2:
        fail("The clip is too short to stabilize.")
    motions = fill_dropped(motions, dropped)
    path = {"version": 1, "width": info["width"], "height": info["height"], "fps": fps, "from": start, "to": end,
            "matrix": info["matrix"], "range": info["range"], "primaries": info["primaries"], "transfer": info["transfer"],
            "frames": [[round(v, 5) for v in m] for m in motions], "dropped": dropped}
    with open(job["output"], "w", encoding="utf-8") as stream:
        json.dump(path, stream)
    emit(progress=100)


# ---------------------------------------------------------------- camera path -> corrections

def settings_of(raw):
    settings = dict(SETTING_DEFAULTS)
    for key, default in SETTING_DEFAULTS.items():
        try:
            value = float(raw.get(key, default))
            settings[key] = value if math.isfinite(value) else float(default)
        except (TypeError, ValueError, AttributeError):
            settings[key] = float(default)
    return settings


SLACK_WEIGHT = 30.0  # cost per pixel of leaving the crop budget; a hard wall would pass the camera's own jerk straight through


def l1_path(trajectory, budget, smoothness):
    """Grundmann et al. (CVPR 2011): the path of constant, linear and parabolic segments that stays within
    `budget` of the measured trajectory while minimising the L1 norm of its first three derivatives.
    The budget is soft: a slack variable per frame lets the path overshoot where staying inside would mean
    following a whip pan frame for frame; the render then zooms smoothly to cover it.
    Solved as one linear program with HiGHS. ponytail: one LP over the whole clip; window it if minutes-long clips get slow."""
    n = len(trajectory)
    if n < 4 or budget <= 0:
        return trajectory.copy()
    import scipy.sparse as sparse  # lazy: renders that load a cached solve never pay for SciPy
    from scipy.optimize import linprog
    weights = (10.0, 1.0 + 4.0 * smoothness, 100.0 + 400.0 * smoothness)
    counts = (n - 1, n - 2, n - 3)
    offsets = (n, n + counts[0], n + counts[0] + counts[1])
    slack = n + sum(counts)
    total = slack + n
    cost = np.zeros(total)
    for weight, count, offset in zip(weights, counts, offsets):
        cost[offset:offset + count] = weight
    cost[slack:] = SLACK_WEIGHT
    rows, cols, values, rhs = [], [], [], []
    row = 0
    stencils = ((-1, 1), (1, -2, 1), (-1, 3, -3, 1))
    for stencil, count, offset in zip(stencils, counts, offsets):
        for i in range(count):
            for sign in (1, -1):
                for k, coefficient in enumerate(stencil):
                    rows.append(row); cols.append(i + k); values.append(sign * coefficient)
                rows.append(row); cols.append(offset + i); values.append(-1.0)
                rhs.append(0.0)
                row += 1
    for i in range(n):  # |p_i - t_i| <= budget + s_i
        for sign in (1, -1):
            rows.append(row); cols.append(i); values.append(sign)
            rows.append(row); cols.append(slack + i); values.append(-1.0)
            rhs.append(sign * float(trajectory[i]) + budget)
            row += 1
    matrix = sparse.csr_matrix((values, (rows, cols)), shape=(row, total))
    bounds = [(None, None)] * n + [(0, None)] * (total - n)
    result = linprog(cost, A_ub=matrix, b_ub=np.array(rhs), bounds=bounds, method="highs")
    if not result.success:
        return trajectory.copy()
    return result.x[:n]


def corrections(path, raw_settings):
    """Per-frame correction (dx, dy, dAngle, dLogScale) about the frame centre, plus the crop fraction per side."""
    settings = settings_of(raw_settings)
    width, height = path["width"], path["height"]
    motions = np.array(path["frames"], dtype=np.float64)
    trajectory = np.cumsum(motions, axis=0)
    crop = min(0.45, max(0.0, settings["crop"] / 100.0))
    smoothness = min(1.0, max(0.0, settings["smoothness"] / 100.0))
    if settings["lock"] >= 0.5:
        target = np.repeat(trajectory[:1], len(trajectory), axis=0)
    else:
        # Rotation spends crop too: a tilt of a radians moves the far corner by about a * half-diagonal pixels,
        # so it gets a small slice of the budget and translation solves on the rest.
        angle_budget = 0.3 * crop * height / max(1.0, math.hypot(width, height) / 2.0)
        target = np.stack([l1_path(trajectory[:, 0], crop * width * 0.85, smoothness),
                           l1_path(trajectory[:, 1], crop * height * 0.85, smoothness),
                           l1_path(trajectory[:, 2], angle_budget, smoothness),
                           trajectory[:, 3]], axis=1)
    delta = (target - trajectory) * (settings["amount"] / 100.0)
    delta[:, 3] = 0.0  # zoom drift is intentional camera work on a long lens; never fight it
    return delta, settings, crop


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


def required_zoom(matrix, width, height, floor, cap):
    """Smallest zoom in [floor, cap] that hides this frame's edges."""
    if fits(matrix, floor, width, height):
        return floor
    low, high = floor, cap
    if not fits(matrix, high, width, height):
        return high
    for _ in range(20):
        middle = (low + high) / 2
        if fits(matrix, middle, width, height):
            high = middle
        else:
            low = middle
    return high


def smooth_zoom_curve(required, fps, floor):
    """A zoom that never shows an edge yet only ever glides. Each frame's need is held for 2.5 s either side, the
    plateau is blurred over 1 s, and the two steps repeat until no frame is short. Holding wider than the blur keeps
    the blur from eating the peak, so the final safety max() has almost nothing left to add and no step to make.
    The eye reads a slow push-in as camera work, not a jump."""
    values = np.maximum(np.asarray(required, dtype=np.float64), floor)
    if len(values) < 3:
        return values
    sigma = max(1.0, fps * 1.0)
    hold = max(1, int(round(2.5 * sigma)))
    curve = values.copy()
    for _ in range(4):
        padded = np.pad(np.maximum(curve, values), hold, mode="edge")
        held = np.max(np.lib.stride_tricks.sliding_window_view(padded, 2 * hold + 1), axis=1)
        curve = gaussian_smooth(held[:, None], sigma)[:, 0]
        if (values - curve).max() <= 1e-4:
            break
    return np.maximum(curve, values)


def gaussian_smooth(values, sigma):
    if sigma <= 0.01:
        return values.copy()
    radius = int(math.ceil(sigma * 3))
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(values, ((radius, radius), (0, 0)), mode="edge")
    return np.stack([np.convolve(padded[:, column], kernel, mode="valid") for column in range(values.shape[1])], axis=1)


def output_matrices(path, raw_settings):
    """Per-frame output matrices (correction then zoom about the centre) and the per-frame zoom curve."""
    delta, settings, crop = corrections(path, raw_settings)
    matrices = frame_matrices(path, delta)
    width, height = path["width"], path["height"]
    locked = settings["lock"] >= 0.5
    floor = 1.0 if locked else 1.0 / (1.0 - 2.0 * crop)
    cap = MAX_LOCK_ZOOM if locked else floor * 1.35
    required = [required_zoom(m, width, height, floor, cap) for m in matrices]
    zooms = smooth_zoom_curve(required, path["fps"], floor)
    cx, cy = width / 2.0, height / 2.0
    combined = []
    for matrix, zoom in zip(matrices, zooms):
        zoom_matrix = np.array([[zoom, 0.0, cx - zoom * cx], [0.0, zoom, cy - zoom * cy], [0.0, 0.0, 1.0]])
        combined.append((zoom_matrix @ np.vstack([matrix, [0.0, 0.0, 1.0]]))[:2])
    return combined, zooms


def solved_matrices(path, raw_settings, cache=None):
    """`output_matrices`, cached on disk per (analysis, settings): every preview chunk of a clip shares one solve."""
    if cache and os.path.exists(cache):
        with np.load(cache) as data:
            return list(data["matrices"]), data["zooms"]
    matrices, zooms = output_matrices(path, raw_settings)
    if cache:
        temporary = f"{cache}.{os.getpid()}.tmp.npz"
        np.savez(temporary, matrices=np.array(matrices), zooms=np.asarray(zooms, dtype=np.float64))
        os.replace(temporary, cache)
    return matrices, zooms


def scaled_matrices(matrices, path, width, height):
    """Re-express full-resolution matrices for a proxy of a different size (same aspect)."""
    sx, sy = width / path["width"], height / path["height"]
    if abs(sx - 1) < 1e-9 and abs(sy - 1) < 1e-9:
        return matrices
    scale = np.array([[sx, 0.0, 0.0], [0.0, sy, 0.0], [0.0, 0.0, 1.0]])
    inverse = np.linalg.inv(scale)
    return [(scale @ np.vstack([m, [0.0, 0.0, 1.0]]) @ inverse)[:2] for m in matrices]


def matrix_index(path, time):
    """Position of `time` in the analysed frame list; the render indexes matrices the same way."""
    return int(round((float(time) - path["from"]) * path["fps"]))


# ---------------------------------------------------------------- solve (preview)

def solve(job):
    """Per-frame output matrices as JSON. The browser warps the picture it already decodes, so a
    preview needs no decode, no warp and no re-encode here: one small file serves the whole clip."""
    with open(job["path"], "r", encoding="utf-8") as stream:
        path = json.load(stream)
    matrices, zooms = solved_matrices(path, job.get("settings") or {}, job.get("solve"))
    payload = {"version": 1, "width": path["width"], "height": path["height"], "fps": path["fps"],
               "from": path["from"], "to": path["to"],
               "zoom": round(float(np.max(zooms)), 4), "zoomMin": round(float(np.min(zooms)), 4),
               # Row-major 2x3 per frame, in source pixels, mapping source -> stabilized output.
               "matrices": [[round(float(v), 5) for v in np.asarray(m).reshape(-1)] for m in matrices]}
    with open(job["output"], "w", encoding="utf-8") as stream:
        json.dump(payload, stream, allow_nan=False)
    emit(progress=100)


# ---------------------------------------------------------------- warp an alpha sequence

def warp(job):
    """Move a Smart Mask matte onto the stabilized picture with that picture's own per-frame matrix.
    Export bakes the stabilized frames; without this the matte would still sit on the original framing."""
    with open(job["path"], "r", encoding="utf-8") as stream:
        path = json.load(stream)
    matrices, _ = solved_matrices(path, job.get("settings") or {}, job.get("solve"))
    frames, scaled, size = job["frames"], None, None
    for n, frame in enumerate(frames):
        image = cv2.imread(frame["input"], cv2.IMREAD_UNCHANGED)
        if image is None:
            fail(f"Smart Mask matte {frame['input']} could not be read.")
        height, width = image.shape[:2]
        if size != (width, height):
            size, scaled = (width, height), scaled_matrices(matrices, path, width, height)
        matrix = scaled[min(len(scaled) - 1, max(0, matrix_index(path, frame["time"])))]
        # Outside the warped frame there is no subject: the matte ends at the same black border the picture gets.
        warped = cv2.warpAffine(image, matrix, (width, height), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        if not cv2.imwrite(frame["output"], warped):
            fail(f"Smart Mask matte {frame['output']} could not be written.")
        if n % 8 == 0:
            emit(progress=round(n / max(1, len(frames)) * 98, 1))
    emit(progress=100)


# ---------------------------------------------------------------- render

def render(job):
    with open(job["path"], "r", encoding="utf-8") as stream:
        path = json.load(stream)
    info = probe(job)
    info["fps"] = path["fps"]  # frame indices in the path follow the analysed cadence; proxies share it
    start, end, preview = float(job["from"]), float(job["to"]), bool(job.get("preview"))
    if not end > start:
        fail("Render range is empty.")
    matrices, zooms = solved_matrices(path, job.get("settings") or {}, job.get("solve"))
    emit(zoom=round(float(np.max(zooms)), 4), zoomMin=round(float(np.min(zooms)), 4))
    matrices = scaled_matrices(matrices, path, info["width"], info["height"])
    first = int(round((start - path["from"]) * info["fps"]))
    count = max(1, int(round((end - start) * info["fps"])))
    width, height = info["width"], info["height"]
    pix_fmt, dtype = ("rgb24", np.uint8) if preview else ("rgb48le", np.uint16)
    matrix = matrix_name(info["matrix"])
    encode = [job["ffmpeg"], "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{width}x{height}", "-r", f"{info['fps']:.6f}", "-i", "-", "-an",
              "-vf", f"scale=out_color_matrix={matrix}:out_range=tv", "-colorspace", "smpte170m" if matrix == "bt601" else matrix,
              "-color_primaries", info["primaries"], "-color_trc", info["transfer"], "-color_range", "tv"]
    if preview:
        encode += ["-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "12", "-g", str(max(1, round(info["fps"] / 2))), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
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
    matrices, zooms = output_matrices(path, {"amount": 100, "smoothness": 50, "crop": 6, "lock": 0})
    zoom = float(np.max(zooms))
    assert abs(float(np.min(zooms)) - 1 / (1 - 0.12)) < 0.006 and zoom < 1 / (1 - 0.12) * 1.1, f"crop 6% must sit at ~1.136x zoom, got {np.min(zooms)}..{zoom}"
    assert np.abs(np.diff(zooms)).max() < 0.004, f"zoom must glide, max step {np.abs(np.diff(zooms)).max():.4f}"
    plain = frame_matrices(path, corrections(path, {"amount": 100, "smoothness": 50, "crop": 6, "lock": 0})[0])
    assert all(fits(m, z, width, height) for m, z in zip(plain, zooms)), "zoom curve leaves a visible border"
    matrices2, zooms2 = output_matrices(path, {"amount": 100, "smoothness": 50, "crop": 2, "lock": 0})
    assert float(np.max(zooms2)) < zoom, "a smaller budget must zoom less"
    raw, dropped_marks = analyze_frames(iter(frames[:10] + [np.zeros_like(frames[0])] + frames[11:14]), width)
    interpolated = fill_dropped(raw, dropped_marks)
    assert dropped_marks and any(abs(v) > 0 for v in interpolated[dropped_marks[0]][:2]), "dropped frames are interpolated, not zeroed"
    stabilized = [cv2.warpAffine(frame, matrix, (width, height), flags=cv2.INTER_LINEAR) for frame, matrix in zip(frames, matrices)]
    after, _ = analyze_frames(iter(stabilized), width)
    before_jitter, after_jitter = jitter(recovered), jitter(np.cumsum(np.array(after), axis=0))
    assert after_jitter < before_jitter / 3, f"jitter {before_jitter:.2f} -> {after_jitter:.2f}"
    tripod, _ = output_matrices(path, {"lock": 1, "amount": 100, "crop": 5})
    locked = [cv2.warpAffine(frame, matrix, (width, height), flags=cv2.INTER_LINEAR) for frame, matrix in zip(frames[:24], tripod[:24])]
    locked_motion, _ = analyze_frames(iter(locked), width)
    locked_jitter = jitter(np.cumsum(np.array(locked_motion), axis=0))
    assert locked_jitter < 0.6, f"tripod mode still moves {locked_jitter:.2f}"
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        cache = os.path.join(folder, "solve.npz")
        first = solved_matrices(path, {"amount": 100, "smoothness": 50, "crop": 6, "lock": 0}, cache)
        second = solved_matrices(path, {"amount": 100, "smoothness": 50, "crop": 6, "lock": 0}, cache)
        assert os.path.exists(cache) and np.allclose(np.array(first[0]), np.array(second[0])) and np.allclose(first[1], second[1]), "solve cache round trip"
        assert np.allclose(np.array(first[0]), np.array(matrices)), "cached solve matches the direct solve"
        # The browser warps with exactly the matrices the export render bakes in.
        path_file, solve_file = os.path.join(folder, "path.json"), os.path.join(folder, "solve.json")
        with open(path_file, "w", encoding="utf-8") as stream:
            json.dump(path, stream)
        settings = {"amount": 100, "smoothness": 50, "crop": 6, "lock": 0}
        solve({"path": path_file, "settings": settings, "solve": cache, "output": solve_file})
        with open(solve_file, "r", encoding="utf-8") as stream:
            payload = json.load(stream)
        assert len(payload["matrices"]) == len(matrices), "solve emits one matrix per analysed frame"
        assert np.allclose(np.array(payload["matrices"]).reshape(-1, 2, 3), np.array(matrices), atol=2e-5), "solved matrices match the render's"
        assert payload["fps"] == path["fps"] and payload["from"] == path["from"], "solve carries the analysed cadence"
        # A matte warps with the picture: the subject lands where the stabilized frame puts it.
        matte = np.zeros((height, width), dtype=np.uint16)
        matte[height//2 - 20:height//2 + 20, width//2 - 20:width//2 + 20] = 65535
        source_png, warped_png = os.path.join(folder, "matte.png"), os.path.join(folder, "warped.png")
        cv2.imwrite(source_png, matte)
        moved = int(np.argmax(np.abs(np.array(matrices)[:, :, 2]).sum(axis=1)))
        warp({"path": path_file, "settings": settings, "solve": cache,
              "frames": [{"input": source_png, "output": warped_png, "time": path["from"] + moved / path["fps"]}]})
        expected = cv2.warpAffine(matte, matrices[moved], (width, height), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        got = cv2.imread(warped_png, cv2.IMREAD_UNCHANGED)
        assert got is not None and got.dtype == np.uint16 and got.shape == matte.shape, "warped matte stays a native 16-bit gray PNG"
        assert np.abs(got.astype(np.int32) - expected.astype(np.int32)).max() <= 1, "warped matte matches the picture's own warp"
        assert np.abs(got.astype(np.int32) - matte.astype(np.int32)).max() > 1000, "the test frame actually moves"
    print(json.dumps({"ok": True, "pathErrorPx": round(error, 3), "jitterBefore": round(before_jitter, 3), "jitterAfter": round(after_jitter, 3), "lockJitter": round(locked_jitter, 3), "zoomAt6pct": [round(float(np.min(zooms)), 4), round(zoom, 4)]}))


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
    try:
        if stage == "analyze":
            analyze(job)
        elif stage == "solve":
            solve(job)
        elif stage == "warp":
            warp(job)
        elif stage == "render":
            render(job)
        else:
            fail(f"Unknown stage {stage!r}.")
    except RuntimeError as error:
        fail(str(error))


if __name__ == "__main__":
    main(sys.argv)
