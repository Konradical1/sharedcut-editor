#!/usr/bin/env python3
"""SharedCut motion tracker worker: feature-box / search-box point tracking with OpenCV.

Usage:
  tracker.py --check            print {"available": true, "opencv": "..."}
  tracker.py --selftest         synthetic round trip with known motion, exit 0 on success
  tracker.py job.json           track one run of frames and stream the samples

The pattern inside the feature box is matched inside the search box with normalized cross-correlation against two
templates: the pattern at the frame the run started from (keeps the track from drifting) and the pattern one frame
back (follows gradual changes in appearance). The search box is centred on where the point's own velocity says it
will be, so a fast subject such as a kicked ball stays inside it. The peak is refined to subpixel precision with ECC
(enhanced correlation coefficient) alignment, which also measures scale and rotation when that model is chosen. A
frame whose best match falls under the confidence floor is "lost": the tracker coasts on its velocity with a wider
search and fills the gap by interpolation once the pattern reappears, or stops so the editor can place it by hand.

Output is newline JSON on stdout: {"progress": n}, {"samples": [[tracker, frame, time, x, y, confidence, scale,
rotation, flag], ...]}, {"stopped": {"tracker": id, "frame": n, "reason": "..."}} and finally {"done": true}.
Coordinates are normalized to the source picture (0 = left/top edge, 1 = right/bottom edge); rotation is in degrees,
clockwise on screen; scale is relative to the pattern at the start of the first run. Flags: 0 tracked, 2 filled
across an occlusion. Cross-platform: ffmpeg is the only external tool, reached through the path the job names.
"""
import json
import math
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np

FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf"
ANALYSIS_LONG_SIDE = 1920      # larger pictures are analysed downscaled, unless the pattern would get too small
MIN_PATTERN = 32               # analysis pixels across the feature box's short side, when the source has them
CHUNK_BYTES = 256 * 1024 ** 2  # backward runs decode forward in chunks of about this much picture
FLAG_TRACKED, FLAG_MANUAL, FLAG_FILLED = 0, 1, 2
MOTION_PRIOR = 0.12            # correlation given up at the search box edge, so equal matches resolve toward the prediction
REACQUIRE = 0.72               # correlation a lost pattern must reach again before the track resumes
ECC_ACCEPT = 0.8
# Measured on the Girls Soccer footage (ball, eye, cheek and nose tracks at 4K 59.94p) and the self-test below.
COARSE_DIVISOR = 12            # coarse matching blur: feature box short side / this, so shape outweighs spinning texture
FINE_DIVISOR = 40              # fine matching blur, just enough to take the edge off noise
FINE_KEY = 0.7                 # the sharp pattern must still correlate this well with the key to refine the coarse answer
KEY_WEIGHT = 0.7               # share of the key (drift-free) against the previous frame (adaptive) in every match
SCALE_STEP = 1.03              # size tried either side of the current one each frame
SCALE_PENALTY = 0.01           # correlation a new size must gain to be taken: edges and changing texture fake small gains
MAX_KEY_SCALE = 1.6            # size change allowed against the key before the key itself has to adapt
DETAIL_RATIO = 0.35            # a match holding less than this share of the key's detail has slipped onto background


def emit(**message):
    print(json.dumps(message, allow_nan=False, separators=(",", ":")), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------- geometry

def rectifier(center, scale, rotation, width, height):
    """dst -> src affine for warpAffine(WARP_INVERSE_MAP): the output's middle pixel lands on `center`, rotated and
    scaled like the pattern currently is. Pixel centres sit on integers, so the middle of n pixels is (n - 1) / 2."""
    c, s = math.cos(rotation) * scale, math.sin(rotation) * scale
    ox, oy = (width - 1) / 2, (height - 1) / 2
    return np.array([[c, -s, center[0] - (c * ox - s * oy)], [s, c, center[1] - (s * ox + c * oy)]], dtype=np.float64)


def sample(frame, matrix, width, height):
    return cv2.warpAffine(frame, matrix, (int(width), int(height)), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)


def apply(matrix, x, y):
    return np.array([matrix[0, 0] * x + matrix[0, 1] * y + matrix[0, 2], matrix[1, 0] * x + matrix[1, 1] * y + matrix[1, 2]])


def parabola(left, middle, right):
    """Vertex offset of the parabola through three samples; zero when the peak is flat or not a maximum."""
    denominator = left - 2 * middle + right
    return 0.0 if denominator >= -1e-9 else max(-0.5, min(0.5, 0.5 * (left - right) / denominator))


def odd(value):
    value = max(5, int(round(value)))
    return value if value % 2 else value + 1


# ---------------------------------------------------------------- tracking

class PointTrack:
    """One point: an odd-sized feature box matched inside a larger search box, in analysis pixels.

    Every frame is matched twice. The coarse pass blurs picture and pattern to the scale of the feature box and finds
    the subject by its shape anywhere in the search box, at three sizes around the predicted one; that is what follows
    a spinning ball or a face coming closer. The fine pass looks again, sharp, a few pixels around that answer, and is
    only kept while the sharp pattern still matches the one the run started from, so fine texture adds precision but
    can never pull the point off its subject. ECC alignment then refines the sharp answer to subpixel precision and,
    with the similarity model, measures rotation."""

    def __init__(self, spec, frame):
        self.id = spec["id"]
        self.center = np.array([float(spec["x"]), float(spec["y"])])
        self.scale = float(spec.get("scale", 1.0))
        self.rotation = math.radians(float(spec.get("rotation", 0.0)))
        self.similarity = spec.get("model") == "similarity"
        self.floor = float(spec.get("minConfidence", 0.6))
        self.coast = spec.get("whenLost", "search") == "search"
        self.max_lost = max(1, int(spec.get("maxLost", 24)))
        self.until = spec.get("until")  # last frame this tracker may settle, e.g. the one before a hand-placed point
        self.fw, self.fh = odd(spec["featureWidth"]), odd(spec["featureHeight"])
        self.sw, self.sh = max(self.fw + 4, int(round(spec["searchWidth"]))), max(self.fh + 4, int(round(spec["searchHeight"])))
        self.coarse_sigma = max(1.0, min(self.fw, self.fh) / COARSE_DIVISOR)
        self.fine_sigma = max(0.7, min(self.fw, self.fh) / FINE_DIVISOR)
        self.set_key(frame, self.center, self.scale, self.rotation)
        self.previous = self.key
        self.detail = float(self.key[2].std())
        self.similar_nearby = self.ambiguity(frame)
        self.velocity = np.zeros(2)
        self.spin = 0.0          # per-frame rotation in radians, for the similarity model
        self.lost = []           # frames coasted through since the last confident match, awaiting a gap fill
        self.anchor = None       # last confident sample before a loss: (frame, center, scale, rotation)
        self.settled = spec.get("frame")  # last frame this tracker settled, in whichever direction the run goes
        self.key_misses = 0
        self.active = True
        self.reason = ""

    # -- pictures

    def region(self, frame, center, scale, rotation, width, height, sigma):
        """The rectified region, blurred with the real pixels around it rather than a replicated border."""
        margin = int(math.ceil(3 * sigma))
        full_width, full_height = width + 2 * margin, height + 2 * margin
        picture = sample(frame, rectifier(center, scale, rotation, full_width, full_height), full_width, full_height)
        return cv2.GaussianBlur(picture, (0, 0), sigma)[margin:margin + height, margin:margin + width]

    def patterns(self, frame, center, scale, rotation):
        """(coarse, fine, sharp) versions of the feature box at this pose."""
        return (self.region(frame, center, scale, rotation, self.fw, self.fh, self.coarse_sigma),
                self.region(frame, center, scale, rotation, self.fw, self.fh, self.fine_sigma),
                sample(frame, rectifier(center, scale, rotation, self.fw, self.fh), self.fw, self.fh))

    def set_key(self, frame, center, scale, rotation):
        self.key, self.key_scale = self.patterns(frame, center, scale, rotation), scale

    def ambiguity(self, frame):
        """How well the pattern matches somewhere else in its own search box, away from itself, on the first frame.
        Near 1 means the spot looks the same nearby (plain skin, sky, a straight edge) and the track can slide."""
        width, height = max(self.sw | 1, self.fw + 2), max(self.sh | 1, self.fh + 2)
        score = self.correlate(self.region(frame, self.center, self.scale, self.rotation, width, height, self.coarse_sigma), self.key[0])
        rows, cols = score.shape
        yy, xx = np.mgrid[0:rows, 0:cols]
        away = np.hypot(xx - (cols - 1) / 2, yy - (rows - 1) / 2) > max(3.0, min(self.fw, self.fh) / 4)
        return float(score[away].max()) if away.any() else 0.0

    @staticmethod
    def correlate(window, template):
        result = cv2.matchTemplate(window, template, cv2.TM_CCOEFF_NORMED)
        return np.nan_to_num(result, nan=0.0, posinf=0.0, neginf=0.0)

    @staticmethod
    def peak(score):
        y, x = np.unravel_index(int(np.argmax(score)), score.shape)
        dx = parabola(score[y, x - 1], score[y, x], score[y, x + 1]) if 0 < x < score.shape[1] - 1 else 0.0
        dy = parabola(score[y - 1, x], score[y, x], score[y + 1, x]) if 0 < y < score.shape[0] - 1 else 0.0
        return x, y, x + dx, y + dy

    # -- matching

    def coarse(self, frame, predicted, scale, rotation, grow):
        """Where the subject's shape is, and its size: (center, scale, key correlation, previous correlation)."""
        width, height = max(int(self.sw * grow) | 1, self.fw + 2), max(int(self.sh * grow) | 1, self.fh + 2)
        prior = 0.0
        if not self.lost:
            rows, cols = height - self.fh + 1, width - self.fw + 1
            yy, xx = np.mgrid[0:rows, 0:cols]
            prior = MOTION_PRIOR * ((xx - (cols - 1) / 2) ** 2 + (yy - (rows - 1) / 2) ** 2) / max(1.0, (max(rows, cols) / 2) ** 2)
        # Correlation cannot see size on an edge or a smooth patch, and a textured subject that changes (a spinning
        # ball) scores a little better when drawn smaller. So a new size has to win by a clear margin, never while
        # the subject is lost, and never beyond a bounded change from the key it is compared with.
        ratios = [1.0] if self.lost else [1.0, *(r for r in (1 / SCALE_STEP, SCALE_STEP) if 1 / MAX_KEY_SCALE <= scale * r / self.key_scale <= MAX_KEY_SCALE)]
        best = None
        for ratio in ratios:
            window = self.region(frame, predicted, scale * ratio, rotation, width, height, self.coarse_sigma)
            key, previous = self.correlate(window, self.key[0]), self.correlate(window, self.previous[0])
            # A lost subject has nothing recent to trust, so either pattern may bring it back from anywhere in the box.
            score = np.maximum(key, previous) if self.lost else KEY_WEIGHT * key + (1 - KEY_WEIGHT) * previous - prior
            x, y, fx, fy = self.peak(score)
            value = float(score[y, x]) - (SCALE_PENALTY if ratio != 1.0 else 0.0)
            if best is None or value > best[0]:
                best = (value, ratio, fx, fy, float(key[y, x]), float(previous[y, x]))
        _, ratio, fx, fy, key, previous = best
        center = apply(rectifier(predicted, scale * ratio, rotation, width, height), fx + (self.fw - 1) / 2, fy + (self.fh - 1) / 2)
        return center, scale * ratio, key, previous

    def fine(self, frame, center, scale, rotation):
        """The sharp pattern a few pixels around the coarse answer, or None once it no longer matches the key."""
        reach = max(2, int(math.ceil(self.coarse_sigma)))
        width, height = self.fw + 2 * reach, self.fh + 2 * reach
        window = self.region(frame, center, scale, rotation, width, height, self.fine_sigma)
        key, previous = self.correlate(window, self.key[1]), self.correlate(window, self.previous[1])
        x, y, fx, fy = self.peak(KEY_WEIGHT * key + (1 - KEY_WEIGHT) * previous)
        if key[y, x] < FINE_KEY:
            return None
        return apply(rectifier(center, scale, rotation, width, height), fx + (self.fw - 1) / 2, fy + (self.fh - 1) / 2)

    def refine(self, frame, center, scale, rotation, limit):
        """Subpixel alignment of the sharp key with ECC; with the similarity model also its scale and rotation.
        None when the alignment does not converge or wanders, so the correlation answer stands. `limit` is how far
        scale and rotation may move from the pose given, as (ratio, radians)."""
        margin = max(3, min(self.fw, self.fh) // 4)
        width, height = self.fw + 2 * margin, self.fh + 2 * margin
        patch_map = rectifier(center, scale, rotation, width, height)
        # ECC's own Gaussian reflects the patch border and biases scale (OpenCV issue 29774), so blur here instead.
        patch = cv2.GaussianBlur(sample(frame, patch_map, width, height).astype(np.float32), (0, 0), 0.8)
        template = cv2.GaussianBlur(self.key[2].astype(np.float32), (0, 0), 0.8)
        motion = cv2.MOTION_AFFINE if self.similarity else cv2.MOTION_TRANSLATION
        warp = np.array([[1, 0, margin], [0, 1, margin]], dtype=np.float32)
        try:
            correlation, warp = cv2.findTransformECC(template, patch, warp, motion, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-4), None, 1)
        except cv2.error:
            return None
        if not np.all(np.isfinite(warp)) or correlation < ECC_ACCEPT:
            return None
        ox, oy = (self.fw - 1) / 2, (self.fh - 1) / 2
        inside = warp[:, :2].astype(np.float64) @ np.array([ox, oy]) + warp[:, 2]
        refined = apply(patch_map, inside[0], inside[1])
        if np.hypot(*(refined - center)) > max(1.5, 0.2 * min(self.fw, self.fh)):
            return None
        if self.similarity:
            linear = patch_map[:, :2] @ warp[:, :2].astype(np.float64)
            new_scale = math.sqrt(abs(np.linalg.det(linear)))
            turn = (math.atan2(linear[1, 0] - linear[0, 1], linear[0, 0] + linear[1, 1]) - rotation + math.pi) % (2 * math.pi) - math.pi
            # A real subject cannot grow 8 % or turn 6° in one frame; beyond that the alignment is slipping.
            if abs(new_scale / scale - 1) > limit[0] or abs(turn) > limit[1] or not 1 / MAX_KEY_SCALE <= new_scale / self.key_scale <= MAX_KEY_SCALE:
                return None
            scale, rotation = new_scale, rotation + turn
        return refined, scale, rotation, float(correlation)

    # -- one frame

    def step(self, frame, index, bounds):
        """Track into `frame`. Returns the samples it settles: [] while coasting, several when a gap is filled."""
        if not self.active:
            return []
        predicted = self.center + self.velocity
        # Size is not extrapolated: a size estimate carried forward compounds its own error within a few frames.
        predicted_scale, predicted_rotation = self.scale, self.rotation + self.spin
        width, height = bounds
        if not (-self.fw / 2 <= predicted[0] <= width - 1 + self.fw / 2 and -self.fh / 2 <= predicted[1] <= height - 1 + self.fh / 2):
            return self.stop("left-frame")
        grow = min(3.0, 1.5 ** len(self.lost)) if self.lost else 1.0
        center, scale, key, previous = self.coarse(frame, predicted, predicted_scale, predicted_rotation, grow)
        rotation = predicted_rotation
        confidence = max(key, previous)
        refined = None
        if confidence >= self.floor - (0.15 if self.lost else 0):
            sharp = self.fine(frame, center, scale, rotation)
            if sharp is not None:
                center = sharp
                # Across a gap the pose keeps changing unseen, so the alignment may move further than in one frame.
                frames = len(self.lost) + 1
                refined = self.refine(frame, center, scale, rotation, (min(0.3, 0.08 * frames), min(math.radians(45), math.radians(6) * frames)))
        # A lost subject needs a stronger match to come back than a followed one needs to continue.
        found = ((refined is not None and refined[3] >= REACQUIRE) or confidence >= max(self.floor + 0.1, REACQUIRE)) if self.lost else confidence >= self.floor
        if not found:
            return self.miss(index, predicted, predicted_scale, predicted_rotation)
        if refined is not None:
            center, scale, rotation, ecc = refined
            confidence = max(confidence, min(ecc, 1.0))
        current = self.patterns(frame, center, scale, rotation)
        # A textured subject does not turn into flat sky between two frames. When the match lands on far less detail
        # than the key holds, the pattern has slipped off onto background that correlates with anything.
        if current[2].std() < DETAIL_RATIO * self.key[2].std():
            return self.miss(index, predicted, predicted_scale, predicted_rotation)
        settled = []
        if self.lost:
            # The subject is back: the frames in between move in a straight line from where it was lost to here.
            start_frame, start_center, start_scale, start_rotation = self.anchor
            span = index - start_frame  # negative on a backward run; the interpolation below holds either way
            for frame_index in self.lost:
                t = (frame_index - start_frame) / span
                settled.append((frame_index, start_center + (center - start_center) * t, start_scale + (scale - start_scale) * t,
                                start_rotation + (rotation - start_rotation) * t, 0.0, FLAG_FILLED))
            self.velocity = (center - start_center) / abs(span)
            self.spin = (rotation - start_rotation) / abs(span)
            self.lost = []
        else:
            self.velocity = 0.8 * (center - self.center) + 0.2 * self.velocity
            self.spin = 0.8 * (rotation - self.rotation) + 0.2 * self.spin
        # Follow the subject's own motion, but never faster than the search box can hold from one frame to the next.
        limit = max(self.sw, self.sh) / 2
        speed = float(np.hypot(*self.velocity))
        if speed > limit:
            self.velocity *= limit / speed
        self.previous = current
        # Adapt the key once the subject has clearly changed but is still followed frame to frame, as a face
        # turning away does; a single bad frame never replaces it, and neither does a patch with little detail.
        self.key_misses = self.key_misses + 1 if key < 0.7 and previous >= 0.85 and current[2].std() >= 0.6 * self.key[2].std() else 0
        if self.key_misses >= 3:
            self.key, self.key_scale, self.key_misses = self.previous, scale, 0
        self.center, self.scale, self.rotation = center, scale, rotation
        self.settled = index
        settled.append((index, center, scale, rotation, min(1.0, max(0.0, confidence)), FLAG_TRACKED))
        return settled

    def miss(self, index, predicted, scale, rotation):
        """No trustworthy match on this frame: coast on the motion so far, or stop."""
        if not self.coast or len(self.lost) >= self.max_lost:
            return self.stop("lost")
        if not self.lost:
            self.anchor = (self.settled, self.center.copy(), self.scale, self.rotation)
        self.lost.append(index)
        self.center, self.scale, self.rotation = predicted, scale, rotation
        self.velocity *= 0.95
        self.spin *= 0.9
        return []

    def stop(self, reason):
        self.active, self.reason, self.lost = False, reason, []
        return []


def track_frames(specs, frames, on_samples=None):
    """Core loop over (index, frame) pairs in processing order. The first pair seeds every tracker.
    `specs` coordinates are analysis pixels. Returns ({tracker id: (last settled index, stop reason)}, trackers)."""
    iterator = iter(frames)
    first = next(iterator, None)
    if first is None:
        raise RuntimeError("The source returned no frames for this range.")
    first_index, first_frame = first
    height, width = first_frame.shape[:2]
    trackers = [PointTrack({**spec, "frame": first_index}, first_frame) for spec in specs]
    last = {tracker.id: first_index for tracker in trackers}
    for index, frame in iterator:
        settled = []
        for number, tracker in enumerate(trackers):
            if tracker.active and tracker.until is not None and (index - tracker.until) * (index - first_index) > 0:
                tracker.stop("lost" if tracker.lost else "key")  # a pending coast has nothing to land on and is dropped
            for row in tracker.step(frame, index, (width, height)):
                settled.append((number, *row))
                last[tracker.id] = max(last[tracker.id], row[0]) if index > first_index else min(last[tracker.id], row[0])
        if on_samples and settled:
            on_samples(settled, trackers)
        if not any(tracker.active for tracker in trackers):
            break
    return {tracker.id: (last[tracker.id], tracker.reason or ("lost" if tracker.lost else "end")) for tracker in trackers}, trackers


# ---------------------------------------------------------------- source access

_hwaccel_cache = {}
# FFmpeg falls back to software and still exits 0 when the GPU cannot decode a format (4:2:2 HEVC on Ada NVDEC).
HWACCEL_REFUSED = ("Failed setup for format", "hwaccel initialisation returned error", "Hardware is lacking required capabilities")


def hardware_decode_args(job):
    """Detected, never assumed: try each platform decoder on this very file and fall back to software if it cannot.
    The answer is kept in the job's cache file per file version, so each step does not pay seconds of probing."""
    if os.environ.get("FRAME_LINE_HWACCEL", "").lower() in ("off", "0", "false"):
        return []
    try:
        stat = os.stat(job["input"])
    except OSError:
        return []
    key = f'{job["ffmpeg"]}|{os.path.abspath(job["input"])}|{stat.st_size}|{stat.st_mtime_ns}'
    if key in _hwaccel_cache:
        return _hwaccel_cache[key]
    store, remembered = job.get("hwaccelCache"), {}
    if store:
        try:
            with open(store, encoding="utf-8") as file:
                remembered = json.load(file)
        except (OSError, ValueError):
            remembered = {}
    if isinstance(remembered, dict) and isinstance(remembered.get(key), list):
        _hwaccel_cache[key] = remembered[key]
        return remembered[key]
    args = []
    try:
        listed = subprocess.run([job["ffmpeg"], "-hide_banner", "-hwaccels"], capture_output=True, text=True, timeout=20).stdout
        for name in [name for name in ("cuda", "videotoolbox", "d3d11va", "vaapi") if name in listed.split()]:
            trial = subprocess.run([job["ffmpeg"], "-hide_banner", "-v", "warning", "-nostdin", "-hwaccel", name, "-i", job["input"], "-frames:v", "2", "-f", "null", "-"],
                                   capture_output=True, text=True, errors="replace", timeout=60)
            if trial.returncode == 0 and not any(sign in trial.stderr for sign in HWACCEL_REFUSED):
                args = ["-hwaccel", name]
                break
    except (OSError, subprocess.SubprocessError):
        return []  # a probe that could not run is not an answer worth remembering
    _hwaccel_cache[key] = args
    if store:
        try:
            remembered = {**(remembered if isinstance(remembered, dict) else {}), key: args}
            temporary = f"{store}.{os.getpid()}.tmp"
            with open(temporary, "w", encoding="utf-8") as file:
                json.dump(remembered, file)
            os.replace(temporary, store)
        except OSError:
            pass
    return args


def decode(job, seek, count, size):
    """`count` consecutive frames starting with the first one presented after `seek`, as gray analysis pictures.
    Callers seek between a frame and the one before it, so rounding can neither skip it nor return its neighbour;
    frames pass through untouched so the n-th picture read is the n-th frame of the source table."""
    width, height = size
    command = [job["ffmpeg"], "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS,
               *hardware_decode_args(job), "-ss", f"{max(0.0, seek):.6f}", "-i", job["input"],
               "-frames:v", str(count), "-an", "-sn", "-dn", "-vf", f"scale={width}:{height}:flags=area,format=gray",
               "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    log = tempfile.TemporaryFile()
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log)
    frame_bytes = width * height
    finished = False
    try:
        for _ in range(count):
            data = process.stdout.read(frame_bytes)
            if len(data) < frame_bytes:
                break
            yield np.frombuffer(data, dtype=np.uint8).reshape(height, width)
        finished = True
    finally:
        if not finished:
            process.kill()  # the consumer stopped early; the decoder has nothing left to say
        process.stdout.close()
        code = process.wait()
        log.seek(0)
        errors = log.read().decode(errors="replace")
        log.close()
        if finished and code != 0:
            raise RuntimeError(f"Source decode failed: {errors.strip()[-2000:] or code}")


def analysis_scale(job):
    """Downscale big pictures for speed, but never so far that the smallest feature box loses its detail."""
    source = job["source"]
    long_side = max(source["width"], source["height"])
    smallest = min(min(t["featureWidth"] * source["width"], t["featureHeight"] * source["height"]) for t in job["trackers"])
    return min(1.0, max(ANALYSIS_LONG_SIDE / long_side, MIN_PATTERN / max(1.0, smallest)))


def run(job):
    source, times, first = job["source"], job["times"], int(job["first"])
    start, stop = int(job["start"]), int(job["stop"])
    direction = 1 if stop >= start else -1
    fps = float(source["fps"])
    scale = analysis_scale(job)
    width, height = max(16, int(round(source["width"] * scale))) // 2 * 2, max(16, int(round(source["height"] * scale))) // 2 * 2
    specs = [{**t, "x": t["x"] * width - 0.5, "y": t["y"] * height - 0.5,
              "featureWidth": t["featureWidth"] * width, "featureHeight": t["featureHeight"] * height,
              "searchWidth": t["searchWidth"] * width, "searchHeight": t["searchHeight"] * height} for t in job["trackers"]]
    total = abs(stop - start)
    local = lambda index: index - first  # absolute frame number -> position in `times`
    # Halfway to the frame before, which the job includes when there is one; the first frame of the file seeks to 0.
    seek = lambda index: (times[local(index) - 1] + times[local(index)]) / 2 if local(index) > 0 else times[local(index)] - 0.5 / fps

    def frames():
        if direction > 0:
            for offset, picture in enumerate(decode(job, seek(start), total + 1, (width, height))):
                yield start + offset, picture
            return
        # Backward: decode forward in chunks that end where the previous chunk began, then walk each in reverse.
        per_chunk = max(8, min(240, CHUNK_BYTES // (width * height)))
        high = start
        while high >= stop:
            low = max(stop, high - per_chunk + 1)
            chunk = [picture.copy() for picture in decode(job, seek(low), high - low + 1, (width, height))]
            if len(chunk) < high - low + 1:
                raise RuntimeError("The source ended before the requested frame.")
            for offset in range(len(chunk) - 1, -1, -1):
                yield low + offset, chunk[offset]
            high = low - 1

    reached = [0]

    def on_samples(settled, trackers):
        # The position model still sizes its search internally, but that estimate is not good enough to animate with.
        pose = lambda number, value, rotation: (round(value, 5), round(math.degrees(rotation), 4)) if trackers[number].similarity else (1, 0)
        rows = [[number, index, round(times[local(index)], 6), round((center[0] + 0.5) / width, 7), round((center[1] + 0.5) / height, 7),
                 round(confidence, 4), *pose(number, sample_scale, rotation), flag]
                for number, index, center, sample_scale, rotation, confidence, flag in settled]
        emit(samples=rows)
        reached[0] = max(reached[0], max(abs(row[1] - start) for row in rows))
        emit(progress=round(reached[0] / max(1, total) * 100, 1))

    results, trackers = track_frames(specs, frames(), on_samples)
    for tracker in trackers:
        index, reason = results[tracker.id]
        if tracker.detail < 4:
            emit(warning={"tracker": tracker.id, "message": "The feature box has almost no detail. Pick a spot with corners or texture."})
        elif tracker.similar_nearby > 0.97:
            emit(warning={"tracker": tracker.id, "message": "This spot looks almost the same right next to it, so the track can slide. Pick a corner, an eye or a logo."})
        emit(stopped={"tracker": tracker.id, "frame": index, "reason": reason})
    emit(done=True, analysisWidth=width, analysisHeight=height)


# ---------------------------------------------------------------- self-test

def synthetic(count=90, width=640, height=360, seed=3, similarity=False):
    """A textured card moving fast across a panning textured background, hidden behind a bar for 6 frames."""
    rng = np.random.default_rng(seed)
    background = cv2.GaussianBlur(rng.integers(0, 255, (height * 2, width * 2), dtype=np.uint8), (0, 0), 2.2)
    card = cv2.GaussianBlur(rng.integers(0, 255, (61, 61), dtype=np.uint8), (0, 0), 1.2)
    frames, truth = [], []
    for n in range(count):
        pan = (n * 1.7, n * 0.6)
        picture = background[int(pan[1]):int(pan[1]) + height, int(pan[0]):int(pan[0]) + width].copy()
        cx, cy = 120 + n * 5.3, 180 + 70 * math.sin(n / 11)
        scale = 1 + (0.004 * n if similarity else 0)
        angle = (0.8 * n if similarity else 0)
        matrix = cv2.getRotationMatrix2D((30, 30), -angle, scale)
        matrix[:, 2] += (cx - 30, cy - 30)
        warped = cv2.warpAffine(card, matrix, (width, height), flags=cv2.INTER_LINEAR)
        mask = cv2.warpAffine(np.full((61, 61), 255, np.uint8), matrix, (width, height), flags=cv2.INTER_NEAREST)
        picture[mask > 0] = warped[mask > 0]
        if 40 <= n < 46:
            picture[:, int(cx) - 45:int(cx) + 45] = 90
        noise = rng.normal(0, 3, picture.shape)
        frames.append(np.clip(picture + noise, 0, 255).astype(np.uint8))
        truth.append((cx, cy, scale, angle))
    return frames, truth


def selftest():
    report = {}
    for similarity in (False, True):
        frames, truth = synthetic(similarity=similarity)
        spec = {"id": "t", "x": truth[0][0], "y": truth[0][1], "featureWidth": 41, "featureHeight": 41, "searchWidth": 121, "searchHeight": 121,
                "model": "similarity" if similarity else "position", "minConfidence": 0.6}
        got = {}
        track_frames([spec], enumerate(frames), lambda settled, _: got.update({s[1]: s for s in settled}))
        tracked = [n for n in got if got[n][6] == FLAG_TRACKED]
        filled = [n for n in got if got[n][6] == FLAG_FILLED]
        errors = [float(np.hypot(got[n][2][0] - truth[n][0], got[n][2][1] - truth[n][1])) for n in tracked]
        name = "similarity" if similarity else "position"
        report[name] = {"frames": len(got), "meanErrorPx": round(float(np.mean(errors)), 3), "maxErrorPx": round(float(np.max(errors)), 3),
                        "filled": len(filled)}
        assert len(got) == len(frames) - 1, (name, "track stopped early", len(got))
        assert np.mean(errors) < 0.35 and np.max(errors) < 1.5, (name, errors)
        assert 5 <= len(filled) <= 7, (name, "occlusion not bridged", filled)
        if similarity:
            last = max(tracked)
            scale_error = abs(got[last][3] - truth[last][2])
            angle_error = abs(math.degrees(got[last][4]) - truth[last][3])
            report[name].update(scaleError=round(scale_error, 4), angleErrorDeg=round(angle_error, 3))
            assert scale_error < 0.02 and angle_error < 1.5, (name, scale_error, angle_error)
    # Backward over the same shot lands on the first frame.
    frames, truth = synthetic()
    spec = {"id": "b", "x": truth[-1][0], "y": truth[-1][1], "featureWidth": 41, "featureHeight": 41, "searchWidth": 121, "searchHeight": 121}
    got = {}
    track_frames([spec], ((n, frames[n]) for n in range(len(frames) - 1, -1, -1)), lambda settled, _: got.update({s[1]: s for s in settled}))
    error = float(np.hypot(got[0][2][0] - truth[0][0], got[0][2][1] - truth[0][1]))
    gap = [n for n in got if got[n][6] == FLAG_FILLED]
    gap_error = max(float(np.hypot(got[n][2][0] - truth[n][0], got[n][2][1] - truth[n][1])) for n in gap)
    report["backward"] = {"frames": len(got), "firstFrameErrorPx": round(error, 3), "filled": len(gap), "gapErrorPx": round(gap_error, 2)}
    assert 0 in got and error < 0.6, ("backward", error)
    # The card moves 5.3 px a frame on a curve; a straight fill across six hidden frames stays within a few pixels.
    assert 5 <= len(gap) <= 7 and gap_error < 8, ("backward gap", gap, gap_error)
    # Lost for a single frame and found on the next, in both directions: nothing to divide by zero.
    blink = [f.copy() for f in frames]
    blink[50][:, :] = 90
    for order in (list(range(0, 90)), list(range(89, -1, -1))):
        start = order[0]
        spec = {"id": "blink", "x": truth[start][0], "y": truth[start][1], "featureWidth": 41, "featureHeight": 41, "searchWidth": 121, "searchHeight": 121}
        results, _ = track_frames([spec], ((n, blink[n]) for n in order))
        assert results["blink"][1] == "end", ("blink", order[0], results)
    # 'stop' mode ends at the occlusion instead of coasting.
    frames, truth = synthetic()
    spec = {"id": "s", "x": truth[0][0], "y": truth[0][1], "featureWidth": 41, "featureHeight": 41, "searchWidth": 121, "searchHeight": 121, "whenLost": "stop"}
    results, _ = track_frames([spec], enumerate(frames))
    report["stopMode"] = {"lastFrame": results["s"][0], "reason": results["s"][1]}
    assert results["s"][1] == "lost" and 38 <= results["s"][0] <= 40, results
    # Two points in one pass: each stops at its own fence, forward and backward.
    fenced = [{**spec, "id": "a", "whenLost": "search", "until": 20}, {**spec, "id": "b", "whenLost": "search", "until": 30}]
    results, _ = track_frames(fenced, enumerate(frames))
    assert results["a"] == (20, "key") and results["b"] == (30, "key"), results
    spec_back = {**spec, "id": "c", "x": truth[60][0], "y": truth[60][1], "whenLost": "search", "until": 50}
    results, _ = track_frames([spec_back], ((n, frames[n]) for n in range(60, -1, -1)))
    assert results["c"] == (50, "key"), results
    report["fences"] = "ok"
    print(json.dumps({"ok": True, **report}))


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
    try:
        run(job)
    except RuntimeError as error:
        fail(str(error))


if __name__ == "__main__":
    main(sys.argv)
