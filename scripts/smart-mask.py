#!/usr/bin/env python3
"""FrameLine's offline mask worker. RGB/alpha stay in original source-frame order.

SAM 2.1 is a selection/tracking baseline, not a hair or motion-blur matte.
The optional MatAnyone2 adapter requires separately licensed weights. No downloads
or license acceptance happen inside an analysis job.
"""
import bisect
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SAM_REPO = Path(os.environ.get("FRAME_LINE_SAM2_REPO", ROOT / "artifacts/smart-mask/sam2"))
# Large is the default because it is the one that ships. `small` tracks at roughly twice the frame rate with
# softer edges on thin limbs; set FRAME_LINE_SAM2_MODEL=small and run npm run setup:masks to fetch it.
SAM_MODELS = {"large": ("sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml"),
              "base_plus": ("sam2.1_hiera_base_plus.pt", "configs/sam2.1/sam2.1_hiera_b+.yaml"),
              "small": ("sam2.1_hiera_small.pt", "configs/sam2.1/sam2.1_hiera_s.yaml"),
              "tiny": ("sam2.1_hiera_tiny.pt", "configs/sam2.1/sam2.1_hiera_t.yaml")}
SAM_MODEL = os.environ.get("FRAME_LINE_SAM2_MODEL", "large").lower()
if SAM_MODEL not in SAM_MODELS:
    SAM_MODEL = "large"
SAM_WEIGHT = Path(os.environ.get("FRAME_LINE_SAM2_WEIGHTS", SAM_REPO / "checkpoints" / SAM_MODELS[SAM_MODEL][0]))
SAM_CONFIG = SAM_MODELS[SAM_MODEL][1]
MAT_REPO = Path(os.environ.get("FRAME_LINE_MATANYONE2_REPO", ROOT / "artifacts/smart-mask/MatAnyone2"))
MAT_WEIGHT = Path(os.environ.get("FRAME_LINE_MATANYONE2_WEIGHTS", MAT_REPO / "pretrained_models/matanyone2.pth"))
FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf"


def emit(**message):
    print(json.dumps(message, allow_nan=False), flush=True)


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def capabilities():
    import torch
    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    if not SAM_WEIGHT.is_file() or not (SAM_REPO / "sam2").is_dir():
        return dict(available=False, preserveMotionBlur=False, finalQuality=False,
                    reason=f"Run npm run setup:masks to install the SAM 2.1 {SAM_MODEL} tracking baseline.")
    # Installation is opt-in. The flag records an operator's rights to these weights;
    # it never converts the S-Lab license into a commercial license.
    matting = os.environ.get("FRAME_LINE_MATANYONE2_LICENSED") == "1" and MAT_WEIGHT.is_file()
    revision = {"sam2": digest(SAM_WEIGHT), "config": SAM_CONFIG,
                "torch": torch.__version__, "device": device}
    revision["packages"] = {name: importlib.metadata.version(name) for name in ("numpy", "Pillow", "opencv-python-headless", "hydra-core")}
    for label, repository in (("samSource", SAM_REPO), ("matSource", MAT_REPO)):
        if label == "samSource" or matting:
            h = hashlib.sha256()
            for path in sorted(path for path in repository.rglob("*") if path.suffix in (".py", ".yaml", ".yml")):
                h.update(str(path.relative_to(repository)).encode()); h.update(path.read_bytes())
            revision[label] = h.hexdigest()
    if matting:
        revision["matanyone2"] = digest(MAT_WEIGHT)
    # The adapter below is an evaluation candidate. Existence of weights is not a
    # passing native-frame/temporal test, and must not unlock a finishing promise.
    return dict(available=True, engine=f"SAM 2.1 {SAM_MODEL.replace('_', ' ').title()} · tracking preview",
                device=device, preserveMotionBlur=False, finalQuality=False,
                mattingCandidateInstalled=bool(matting),
                workerIdentity=revision,
                reason="MatAnyone2 is installed for evaluation; final matting has not passed validation." if matting else
                "Tracking preview only. Fine hair and source motion blur require a separately installed matting engine.")


def accelerated(device):
    """Half precision for the tracker. Segmentation logits only ever get thresholded at zero, so the
    narrower mantissa costs nothing visible and the encoder runs in well under half the time.
    Set FRAME_LINE_MASK_PRECISION=full to force fp32 if a device ever produces NaNs."""
    import torch
    if device == "cpu" or os.environ.get("FRAME_LINE_MASK_PRECISION", "").lower() in ("full", "fp32", "float32"):
        return torch.autocast(device_type="cpu", enabled=False)
    return torch.autocast(device_type=device, dtype=torch.bfloat16 if device == "cuda" else torch.float16)


def frame_at(times, time):
    return max(0, min(len(times) - 1, bisect.bisect_right(times, time + 1e-7) - 1))


def selected_frames(times, document, direction, anchor):
    start, end = document["range"]["start"], document["range"]["end"]
    # The range starts inside the frame that is showing at `start`, exactly as the editor maps
    # times to frames; otherwise a guide drawn on the first visible frame falls outside the range.
    first = frame_at(times, start)
    anchor_index = max(first, frame_at(times, anchor))
    indices = [i for i, t in enumerate(times) if i >= first and t < end - 1e-6
               and (direction != "forward" or i >= anchor_index)
               and (direction != "backward" or i <= anchor_index)]
    if not indices:
        raise ValueError("The range contains no decoded source frames.")
    return indices, {"start": max(start, times[indices[0]]),
                     "end": min(end, times[indices[-1] + 1] if indices[-1] + 1 < len(times) else end)}


def source_times(job):
    result = subprocess.run([job["ffprobe"], "-v", "error", "-protocol_whitelist", "file,pipe",
                             "-format_whitelist", FORMATS,
                             "-select_streams", "v:0", "-show_entries", "packet=pts_time",
                             "-of", "csv=p=0", job["input"]], capture_output=True, text=True, check=True)
    # Packet timestamps skip decoding entirely; sort decode order into presentation order.
    values = []
    for line in result.stdout.splitlines():
        try:
            value = float(line.split(",")[0])
            if math.isfinite(value):
                values.append(value)
        except ValueError:
            pass
    values.sort()
    if not values or any(b <= a for a, b in zip(values, values[1:])):
        raise ValueError("Original video must have ordered decoded frame timestamps.")
    return [time - values[0] for time in values]


def filter_path(path):
    return str(path).replace("\\", "\\\\").replace("'", "'\\''").replace(":", "\\:")


def decode(job, indices, times, directory):
    # Accurate seek to the first frame's own presentation time, then take exactly len(indices)
    # consecutive frames. Never duplicate via -r; -fps_mode passthrough keeps original ordinals.
    # Frames land straight in the artifact's own 4:4:4 JPEG sidecar and the tracker reads those, so a
    # 4K range costs about 1.5 MB a frame instead of a 25 MB RGB dump written, read and re-encoded.
    filters = []
    scale = []
    if job.get("dataLevels") in ("full", "Full", "limited", "Video"):
        scale.append("in_range=" + ("pc" if job["dataLevels"] in ("full", "Full") else "tv"))
    matrix = {"bt709": "bt709", "bt601": "bt601", "bt2020nc": "bt2020", "bt2020": "bt2020"}.get(job.get("yuvMatrix"))
    if matrix:
        scale.append("in_color_matrix=" + matrix)
    if scale:
        filters.append("scale=" + ":".join(scale))
    if job.get("analysisLutPath"):
        filters.append(f"lut3d=file='{filter_path(job['analysisLutPath'])}'")
    subprocess.run([job["ffmpeg"], "-v", "error", "-y", "-protocol_whitelist", "file,pipe",
                    "-format_whitelist", FORMATS, "-ss", f"{times[indices[0]]:.6f}",
                    "-i", job["input"], *(["-vf", ",".join(filters)] if filters else []),
                    "-frames:v", str(len(indices)), "-fps_mode", "passthrough",
                    "-pix_fmt", "yuvj444p", "-q:v", "2",
                    "-start_number", str(indices[0]), str(directory / "%d.jpg")], check=True)
    if any(not (directory / f"{i}.jpg").is_file() for i in indices):
        raise ValueError("Source decoder dropped a frame.")


def stroke_points(stroke, width, height):
    """Resample interior strokes uniformly; a scribble is positive/negative clicks."""
    import numpy as np
    points = [(p["x"] * (width-1), p["y"] * (height-1)) for p in stroke["points"]]
    spacing = max(2, stroke["radius"] * min(width, height))
    result = [points[0]]
    for a, b in zip(points, points[1:]):
        count = max(1, math.ceil(math.dist(a, b) / spacing))
        result.extend((a[0] + (b[0]-a[0])*t/count, a[1] + (b[1]-a[1])*t/count) for t in range(1, count+1))
    # SAM's prompt decoder is quadratic in clicks. Preserve the stroke shape within
    # this explicit per-stroke bound; users can add separate corrective strokes.
    if len(result) > 256:
        result = [result[round(i * (len(result)-1) / 255)] for i in range(256)]
    return np.asarray(result, dtype=np.float32)


def repair_alpha(base, repairs):
    import cv2
    import numpy as np
    h, w = base.shape
    alpha = base.copy()
    for repair in repairs:
        # Rasterize an antialiased source-coordinate brush at native dimensions.
        coverage = np.zeros((h, w), dtype=np.uint8)
        points = np.rint([[p["x"] * (w-1), p["y"] * (h-1)] for p in repair["points"]]).astype(np.int32)
        radius = max(1, round(repair["radius"] * min(w, h)))
        if len(points) > 1:
            cv2.polylines(coverage, [points], False, 255, radius*2, cv2.LINE_AA)
        for point in (points[0], points[-1]):
            cv2.circle(coverage, tuple(point), radius, 255, -1, cv2.LINE_AA)
        weight = coverage.astype(np.float32)/255
        target = base if repair["kind"] == "unknown" else 1.0 if repair["kind"] == "foreground" else 0.0
        alpha = alpha*(1-weight) + target*weight
    return alpha


PREVIEW_MAX = 1920  # Playback samples the matte at up to 1920 wide; the 16-bit native PNG stays for export.


FAST_PNG = 1  # A native 4K matte is tens of MB of near-constant pixels; level 1 writes it in a fraction of the time.


def save_preview(alpha16, path):
    """8-bit matte no wider than the player needs: a fraction of the bytes and decode time per frame."""
    from PIL import Image
    image = Image.fromarray((alpha16 >> 8).astype("uint8"))
    scale = min(1, PREVIEW_MAX/image.width, PREVIEW_MAX/image.height)
    if scale < 1:
        image = image.resize((max(1, round(image.width*scale)), max(1, round(image.height*scale))), Image.BILINEAR)
    # A matte is flat runs and one soft contour: the slow filter search finds almost nothing extra to squeeze.
    image.save(path, compress_level=FAST_PNG)


def finish_frames(job, indices, times, output, load_alpha):
    """Save the original estimate separately so paint/reset never re-runs AI. `source/` is already the decode."""
    import numpy as np
    from PIL import Image
    repairs = {}
    for repair in job["document"]["repairs"]:
        repairs.setdefault(frame_at(times, repair["time"]), []).append(repair)
    for kind in ("base-frames", "frames", "preview", "source"):
        (output / kind).mkdir(exist_ok=True)
    for n, index in enumerate(indices):
        alpha = load_alpha(index)
        source = job["document"]["source"]
        if alpha.shape != (source["height"], source["width"]) or not np.isfinite(alpha).all():
            raise ValueError("Matting engine returned invalid alpha.")
        base = output / "base-frames" / f"{index}.png"
        alpha16 = np.rint(np.clip(alpha, 0, 1)*65535).astype(np.uint16)
        Image.fromarray(alpha16).save(base, compress_level=FAST_PNG)
        if repairs.get(index):
            alpha16 = np.rint(repair_alpha(np.clip(alpha, 0, 1), repairs[index])*65535).astype(np.uint16)
            Image.fromarray(alpha16).save(output / "frames" / f"{index}.png", compress_level=FAST_PNG)
        else:
            os.link(base, output / "frames" / f"{index}.png")
        save_preview(alpha16, output / "preview" / f"{index}.png")
        emit(progress=90 + 9*(n+1)/len(indices), stage="Saving matte", frame=index)


def finish_repair_job(job):
    import numpy as np
    from PIL import Image
    base = Path(job["baseInput"])
    output = Path(job["output"])
    manifest = json.loads((base / "manifest.json").read_text())
    repairs = {}
    for repair in job["document"]["repairs"]:
        repairs.setdefault(frame_at(manifest["sourceTimes"], repair["time"]), []).append(repair)
    for kind in ("base-frames", "frames", "preview", "source"):
        (output / kind).mkdir(exist_ok=True)
    for n, frame in enumerate(manifest["frames"]):
        index = frame["index"]
        original = base / "base-frames" / f"{index}.png"
        os.link(original, output / "base-frames" / f"{index}.png")
        if repairs.get(index):
            with Image.open(original) as image:
                alpha = np.asarray(image).astype(np.float32)/65535
            alpha16 = np.rint(repair_alpha(alpha, repairs[index])*65535).astype(np.uint16)
            Image.fromarray(alpha16).save(output / "frames" / f"{index}.png", compress_level=FAST_PNG)
            save_preview(alpha16, output / "preview" / f"{index}.png")
        else:
            os.link(original, output / "frames" / f"{index}.png")
            if (base / "preview" / f"{index}.png").is_file():
                os.link(base / "preview" / f"{index}.png", output / "preview" / f"{index}.png")
            else:
                with Image.open(original) as image:
                    save_preview(np.asarray(image).astype(np.uint16), output / "preview" / f"{index}.png")
        os.link(base / "source" / f"{index}.jpg", output / "source" / f"{index}.jpg")
        emit(progress=90 + 9*(n+1)/len(manifest["frames"]), stage="Saving corrections", frame=index)
    manifest.update({key: job[key] for key in ("version", "key", "signature", "projectId", "mediaId", "sourceFingerprint")}, preview="gray8")
    (output / "manifest.json").write_text(json.dumps(manifest, allow_nan=False))


MIN_CROP = 768        # Smallest follow window in source pixels; SAM2 upsamples anything smaller anyway.
PROMPT_CROP = 1024    # Window around the user's first guides before the subject's size is known.


def region_for(center, side, width, height):
    """Square crop of `side` source pixels around `center`, clamped inside the frame; the whole frame once it no longer fits."""
    if side >= min(width, height):
        return (0, 0, width, height)
    side = int(round(side))
    x0 = int(round(min(max(center[0] - side/2, 0), width - side)))
    y0 = int(round(min(max(center[1] - side/2, 0), height - side)))
    return (x0, y0, side, side)


def mask_bounds(binary, region):
    """Source-pixel bounding box (x0, y0, x1, y1) of a crop-resolution mask, or None when empty."""
    import numpy as np
    ys, xs = np.nonzero(binary)
    if not len(xs):
        return None
    return (xs.min() + region[0], ys.min() + region[1], xs.max() + region[0], ys.max() + region[1])


def follow(bounds, region, width, height, include=None):
    """Next crop: three times the subject, eased frame to frame, widening when the subject is lost.
    `include` are source points the next frame's guides need inside the crop."""
    x0, y0, w, h = region
    if bounds is None:
        return region_for((x0 + w/2, y0 + h/2), max(w, h)*1.5, width, height)
    bx0, by0, bx1, by1 = bounds
    target = max(bx1 - bx0, by1 - by0)*3
    if include is not None and len(include):
        bx0, by0 = min(bx0, include[:, 0].min()), min(by0, include[:, 1].min())
        bx1, by1 = max(bx1, include[:, 0].max()), max(by1, include[:, 1].max())
        target = max(target, max(bx1 - bx0, by1 - by0)*1.3)
    side = max(target, MIN_CROP)
    if w < width:  # Ease zoom changes; a jump straight from the whole frame is fine.
        side = .7*max(w, h) + .3*side
    return region_for(((bx0 + bx1)/2, (by0 + by1)/2), side, width, height)


def cleanup(binary, previous=None):
    """Keep the main body and any piece that continues last frame's subject; drop confetti the model
    scatters over look-alike neighbours. A detached limb still overlaps where it was a frame ago."""
    import cv2
    import numpy as np
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), connectivity=8)
    if count <= 2:
        return binary
    areas = stats[1:, cv2.CC_STAT_AREA]
    main = 1 + int(areas.argmax())
    keep = np.zeros(count, dtype=bool)
    keep[main] = True
    if previous is not None and previous.any():
        radius = max(3, int(.02*min(binary.shape)))
        near = cv2.dilate(previous.astype(np.uint8), np.ones((radius, radius), np.uint8)).astype(bool)
        touched = np.unique(labels[near])
        keep[touched] = True
    else:
        x, y, w, h = stats[main, cv2.CC_STAT_LEFT], stats[main, cv2.CC_STAT_TOP], stats[main, cv2.CC_STAT_WIDTH], stats[main, cv2.CC_STAT_HEIGHT]
        inside = (stats[:, cv2.CC_STAT_LEFT] >= x - w*.5) & (stats[:, cv2.CC_STAT_TOP] >= y - h*.5) & (stats[:, cv2.CC_STAT_LEFT] + stats[:, cv2.CC_STAT_WIDTH] <= x + w*1.5) & (stats[:, cv2.CC_STAT_TOP] + stats[:, cv2.CC_STAT_HEIGHT] <= y + h*1.5)
        keep |= inside
    keep[1:] &= areas >= .02*areas.max()
    keep[0] = False
    return keep[labels]


def whole_candidate(areas, scores):
    """Index of the subject among SAM's candidates for a single click: the largest one that does not
    swallow the window (SAM scores a whole body from one shirt click as low as .1, so scores only break ties)."""
    import numpy as np
    areas, scores = np.asarray(areas, dtype=np.float32), np.asarray(scores, dtype=np.float32)
    plausible = areas <= .45
    if not plausible.any():
        return int(scores.argmax())
    return int(np.where(plausible, areas, -1).argmax())


def antialias(binary):
    """Two-pixel ramp across the mask contour so the upsampled model boundary lands on soft, not stair-stepped, edges."""
    import cv2
    import numpy as np
    mask = binary.astype(np.uint8)
    if not mask.any():
        return np.zeros(binary.shape, dtype=np.uint8)
    if mask.all():
        return np.full(binary.shape, 255, dtype=np.uint8)
    # Pixel centres sit half a pixel from the contour; measure to the contour, not to the neighbouring pixel.
    inside, outside = cv2.distanceTransform(mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE), cv2.distanceTransform(1 - mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    signed = np.where(mask > 0, inside - .5, .5 - outside)
    return np.rint(np.clip(signed/2 + .5, 0, 1)*255).astype(np.uint8)


def track(job, indices, times, decoded, destination, caps):
    import numpy as np
    import torch
    from PIL import Image
    sys.path.insert(0, str(SAM_REPO))
    import sam2.sam2_video_predictor as video_module
    from sam2.build_sam import build_sam2_video_predictor
    width, height = job["document"]["source"]["width"], job["document"]["source"]["height"]
    # Hole filling stays off because it needs SAM2's CUDA-only extension.
    predictor = build_sam2_video_predictor(SAM_CONFIG, str(SAM_WEIGHT), device=caps["device"],
                                           apply_postprocessing=False,
                                           hydra_overrides_extra=["++model.add_all_frames_to_correct_as_cond=true",
                                                                  # Single-mask path + dynamic selection routes one-click prompts through whole_subject below.
                                                                  "++model.multimask_output_in_sam=false",
                                                                  "++model.sam_mask_decoder_extra_args.dynamic_multimask_via_stability=true",
                                                                  "++model.binarize_mask_from_pts_for_mem_enc=true"])
    def whole_subject(all_mask_logits, all_iou_scores):
        # A single Include click means "this subject", not "this garment".
        logits, scores = all_mask_logits[:, 1:], all_iou_scores[:, 1:]
        areas = (logits > 0).flatten(2).float().mean(-1).cpu().numpy()
        pick = torch.tensor([whole_candidate(areas[row], scores[row].float().cpu().numpy()) for row in range(len(areas))], device=logits.device)
        rows = torch.arange(logits.size(0), device=logits.device)
        return logits[rows, pick].unsqueeze(1), scores[rows, pick].unsqueeze(1)
    predictor.sam_mask_decoder._dynamic_multimask_via_stability = whole_subject
    regions = {}  # frame position -> (x0, y0, w, h) source-pixel crop fed to the model
    mean = torch.tensor([.485, .456, .406])[:, None, None]
    std = torch.tensor([.229, .224, .225])[:, None, None]

    class LazyFrames:
        # The model sees a follow window around the subject, so a small player in a 4K wide shot keeps
        # its detail. Regions are fixed before a frame is fetched; the window moves like a panning camera.
        def __len__(self):
            return len(indices)

        def __getitem__(self, index):
            x0, y0, w, h = regions.get(index, (0, 0, width, height))  # init_state warms up on frame 0
            with Image.open(decoded / f"{indices[index]}.jpg") as image:
                patch = image.crop((x0, y0, x0 + w, y0 + h)).resize((predictor.image_size, predictor.image_size), Image.BILINEAR)
                tensor = torch.from_numpy(np.array(patch))
            return (tensor.permute(2, 0, 1).float()/255 - mean)/std
    loader = video_module.load_video_frames
    video_module.load_video_frames = lambda **_: (LazyFrames(), height, width)
    try:
        state = predictor.init_state(str(decoded), offload_video_to_cpu=True, offload_state_to_cpu=True)
    finally:
        video_module.load_video_frames = loader
    state["cached_features"] = {}  # The warm-up features were computed on the whole frame, not the follow window.

    def use_region(index, region):
        regions[index] = region
        state["video_height"], state["video_width"] = region[3], region[2]
    grouped = {}
    for prompt in job["document"]["prompts"]:
        source_index = frame_at(times, prompt["time"])
        if source_index in indices:
            grouped.setdefault(source_index - indices[0], []).append(prompt)
    if not grouped or not any(p["kind"] == "include" for ps in grouped.values() for p in ps):
        raise ValueError("Add an Include point on a frame inside the selected direction and range.")
    samples = {index: [stroke_points(p, width, height) for p in prompts] for index, prompts in grouped.items()}
    def apply_prompts(index):
        prompts, clicks = grouped[index], samples[index]
        labels = np.concatenate([np.full(len(points), 1 if p["kind"] == "include" else 0, dtype=np.int32)
                                 for p, points in zip(prompts, clicks)])
        if len(labels) > 4096:
            raise ValueError("Too many prompt samples on one frame. Use shorter strokes.")
        x0, y0 = regions[index][:2]
        points = np.concatenate(clicks) - np.array([x0, y0], dtype=np.float32)
        return predictor.add_new_points_or_box(state, index, 1, points=points, labels=labels)
    first = min(index for index, prompts in grouped.items() if any(p["kind"] == "include" for p in prompts))
    guides = np.concatenate(samples[first])
    extent = max(guides[:, 0].max() - guides[:, 0].min(), guides[:, 1].max() - guides[:, 1].min())
    region = region_for(((guides[:, 0].min() + guides[:, 0].max())/2, (guides[:, 1].min() + guides[:, 1].max())/2), max(extent*4, PROMPT_CROP), width, height)
    for _ in range(8):
        # Size the first window from the subject itself: widen until the mask stops touching the crop edge.
        use_region(first, region)
        _, _, logits = apply_prompts(first)
        binary = (logits[0, 0] > 0).cpu().numpy()
        x0, y0, w, h = region
        if w == width or not binary.any():
            break
        ys, xs = np.nonzero(binary)
        margin = .04*w
        if min(xs.min(), ys.min()) >= margin and xs.max() <= w - 1 - margin and ys.max() <= h - 1 - margin:
            break
        predictor.reset_state(state)
        state["cached_features"] = {}
        region = region_for((x0 + w/2, y0 + h/2), w*1.6, width, height)
    total = len(indices)
    done = 0
    previous = None  # last cleaned subject at source resolution, for continuity checks
    def save(index, binary, region):
        x0, y0, w, h = region
        alpha = np.zeros((height, width), dtype=np.uint8)
        alpha[y0:y0 + h, x0:x0 + w] = antialias(binary)
        np.save(destination / f"{indices[index]}.npy", alpha)
    with torch.inference_mode(), accelerated(caps["device"]):
        for reverse, start in ((False, first), (True, first)):
            if reverse and first == 0:
                continue
            use_region(start, regions[start])
            previous = None
            for index, _, logits in predictor.propagate_in_video(state, start_frame_idx=start, reverse=reverse):
                if index in grouped and index != first:
                    # A negative-only correction needs the tracked subject context.
                    # Add it after this frame's prediction, then consolidate memory.
                    _, _, logits = apply_prompts(index)
                    predictor.propagate_in_video_preflight(state)
                region = regions[index]
                x0, y0, w, h = region
                binary = cleanup((logits[0, 0] > 0).cpu().numpy(), None if previous is None else previous[y0:y0 + h, x0:x0 + w])
                previous = np.zeros((height, width), dtype=bool)
                previous[y0:y0 + h, x0:x0 + w] = binary
                if not (reverse and index == first):
                    save(index, binary, region)
                    done += 1
                    emit(progress=10 + 45*done/total, stage="Tracking subject", frame=indices[index])
                following = index + (-1 if reverse else 1)
                if 0 <= following < total:
                    guides = np.concatenate(samples[following]) if following in samples else None
                    use_region(following, follow(mask_bounds(binary, region), region, width, height, guides))
                # SAM2 reads only its configured mask/object-pointer memory horizon.
                # Keep conditioning frames permanently and twice that horizon here.
                horizon = 2*max(predictor.num_maskmem*predictor.memory_temporal_stride_for_eval, predictor.max_obj_ptrs_in_encoder)
                for outputs in state["output_dict_per_obj"].values():
                    for old in list(outputs["non_cond_frame_outputs"]):
                        if abs(old-index) > horizon:
                            del outputs["non_cond_frame_outputs"][old]
    anchors = sorted(indices[index] for index in grouped)
    del state, predictor
    if caps["device"] == "mps":
        torch.mps.empty_cache()
    return anchors


def matte(job, indices, anchors, decoded, tracked, destination, caps):
    import numpy as np
    import torch
    from PIL import Image
    sys.path.insert(0, str(MAT_REPO))
    from hydra.core.global_hydra import GlobalHydra
    GlobalHydra.instance().clear()
    from matanyone2.utils.get_default_model import get_matanyone2_model
    from matanyone2.inference.inference_core import InferenceCore
    model = get_matanyone2_model(str(MAT_WEIGHT), caps["device"])
    model.cfg.max_internal_size = -1  # Final edges see native source pixels.
    done = 0
    with torch.inference_mode(), accelerated(caps["device"]):
        for a, anchor in enumerate(anchors):
            left = indices[0] if a == 0 else (anchors[a-1] + anchor)//2 + 1
            right = indices[-1] if a+1 == len(anchors) else (anchor + anchors[a+1])//2
            for direction, stop in ((1, right), (-1, left)):
                if direction == -1 and left == anchor:
                    continue
                processor = InferenceCore(model, cfg=model.cfg, device=caps["device"])
                for index in range(anchor, stop + direction, direction):
                    with Image.open(decoded / f"{index}.jpg") as image:
                        rgb = torch.from_numpy(np.array(image)).permute(2, 0, 1).float().to(caps["device"])/255
                    if index == anchor:
                        mask = torch.from_numpy(np.load(tracked / f"{index}.npy") > 127).to(caps["device"])
                        processor.step(rgb, mask, objects=[1])
                        for _ in range(11):
                            result = processor.step(rgb, first_frame_pred=True)
                    else:
                        result = processor.step(rgb)
                    if direction == -1 and index == anchor:
                        continue
                    alpha = processor.output_prob_to_mask(result).float().cpu().numpy()
                    np.save(destination / f"{index}.npy", np.rint(np.clip(alpha, 0, 1)*255).astype(np.uint8))
                    done += 1
                    emit(progress=55 + 35*done/len(indices), stage="Recovering fine edges", frame=index)
                del processor


def preview_alpha(request, predictor):
    """One frame, the user's guides on it, no tracking: the same window, candidate choice and cleanup the
    full analysis applies on its anchor frame, so what the editor previews is what the range will track."""
    import numpy as np
    from PIL import Image
    width, height = request["width"], request["height"]
    prompts = request["prompts"]
    clicks = [stroke_points(p, width, height) for p in prompts]
    labels = np.concatenate([np.full(len(points), 1 if p["kind"] == "include" else 0, dtype=np.int32) for p, points in zip(prompts, clicks)])
    if not (labels == 1).any():
        raise ValueError("Add an Include guide on this frame first.")
    if len(labels) > 4096:
        raise ValueError("Too many prompt samples on one frame. Use shorter strokes.")
    points = np.concatenate(clicks)
    guides = points[labels == 1]
    extent = max(guides[:, 0].max() - guides[:, 0].min(), guides[:, 1].max() - guides[:, 1].min())
    region = region_for(((guides[:, 0].min() + guides[:, 0].max())/2, (guides[:, 1].min() + guides[:, 1].max())/2), max(extent*4, PROMPT_CROP), width, height)
    with Image.open(request["image"]) as image:
        frame = image.convert("RGB")
        if frame.size != (width, height):
            raise ValueError("Preview frame dimensions differ from the mask source.")
        for _ in range(8):
            x0, y0, w, h = region
            patch = frame.crop((x0, y0, x0 + w, y0 + h))
            predictor.set_image(np.asarray(patch))
            local = points - np.array([x0, y0], dtype=np.float32)
            masks, scores, _ = predictor.predict(point_coords=local, point_labels=labels, multimask_output=True)
            binary = masks[whole_candidate(masks.reshape(len(masks), -1).mean(1), scores)] > 0
            if w == width or not binary.any():
                break
            ys, xs = np.nonzero(binary)
            margin = .04*w
            if min(xs.min(), ys.min()) >= margin and xs.max() <= w - 1 - margin and ys.max() <= h - 1 - margin:
                break
            region = region_for((x0 + w/2, y0 + h/2), w*1.6, width, height)
    binary = cleanup(binary)
    alpha = np.zeros((height, width), dtype=np.uint8)
    alpha[y0:y0 + h, x0:x0 + w] = antialias(binary)
    Image.fromarray(alpha).save(request["output"])


def serve():
    """Long-lived preview worker: one JSON request per stdin line, one JSON reply per stdout line."""
    import torch
    caps = capabilities()
    if not caps["available"]:
        raise ValueError(caps["reason"])
    sys.path.insert(0, str(SAM_REPO))
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    predictor = SAM2ImagePredictor(build_sam2(SAM_CONFIG, str(SAM_WEIGHT), device=caps["device"]))
    emit(ready=True, engine=caps["engine"], device=caps["device"])
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            with torch.inference_mode(), accelerated(caps["device"]):
                preview_alpha(request, predictor)
            emit(id=request["id"], ok=True)
        except Exception as error:  # noqa: BLE001 - every failure must answer its request
            emit(id=request.get("id"), error=str(error) if isinstance(error, ValueError) else f"{type(error).__name__}: {error}")


def main(job):
    import numpy as np
    from PIL import Image
    caps = capabilities()
    if not caps["available"]:
        raise ValueError(caps["reason"])
    settings = job["document"]["settings"]
    if settings["preserveMotionBlur"] and not caps["preserveMotionBlur"] or settings["quality"] == "final" and not caps["finalQuality"]:
        raise ValueError(caps["reason"])
    output = Path(job["output"])
    output.mkdir(parents=True, exist_ok=True)
    if job.get("baseInput"):
        finish_repair_job(job)
        return
    times = source_times(job)
    indices, actual_range = selected_frames(times, job["document"], job["direction"], job["anchorTime"])
    width, height = job["document"]["source"]["width"], job["document"]["source"]["height"]
    # Bound disk demand before decoding: a 4:4:4 JPEG frame, 8-bit alpha, and the 16-bit matte it becomes.
    need = len(indices)*width*height*4
    if need + 1024**3 > shutil.disk_usage(output).free:
        raise ValueError("Insufficient disk space for native-resolution analysis. Select a shorter range.")
    work = output / "work"
    # The decoded frames are the artifact's own source sidecar; the tracker reads them where they already live.
    rgb = output / "source"
    for directory in (work / "tracking", work / "alpha", output / "frames", rgb):
        directory.mkdir(parents=True, exist_ok=True)
    try:
        emit(progress=1, stage="Decoding original frames")
        decode(job, indices, times, rgb)
        with Image.open(rgb / f"{indices[0]}.jpg") as image:
            if image.size != (width, height):
                raise ValueError("Decoded source dimensions differ from the saved mask.")
        anchors = track(job, indices, times, rgb, work / "tracking", caps)
        alpha_directory = work / "tracking"
        if caps["preserveMotionBlur"]:
            matte(job, indices, anchors, rgb, work / "tracking", work / "alpha", caps)
            alpha_directory = work / "alpha"
        finish_frames(job, indices, times, output, lambda i: np.load(alpha_directory / f"{i}.npy").astype(np.float32)/255)
        manifest = {key: job[key] for key in ("version", "key", "signature", "projectId", "mediaId", "sourceFingerprint")}
        manifest.update(engine=caps["engine"], modelRevision=json.dumps(caps["workerIdentity"], sort_keys=True),
                        quality=settings["quality"], width=width, height=height, sourceTimes=times,
                        frames=[dict(index=i, time=times[i], file=f"frames/{i}.png") for i in indices],
                        range=actual_range, alpha="gray16", preview="gray8")
        (output / "manifest.json").write_text(json.dumps(manifest, allow_nan=False))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--check"]:
            emit(**capabilities())
        elif sys.argv[1:] == ["--serve"]:
            serve()
        else:
            main(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as error:
        detail = error if isinstance(error, (ValueError, subprocess.CalledProcessError)) else f"{type(error).__name__}: {error}"
        print(f"Smart Mask: {detail}", file=sys.stderr)
        sys.exit(1)
