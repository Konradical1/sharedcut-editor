#!/usr/bin/env python3
"""FrameLine's offline mask worker. RGB/alpha stay in original source-frame order.

SAM 2.1 is a selection/tracking baseline, not a hair or motion-blur matte.
The optional MatAnyone2 adapter requires separately licensed weights. No downloads
or license acceptance happen inside an analysis job.
"""
import bisect
import functools
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
SAM_WEIGHT = Path(os.environ.get("FRAME_LINE_SAM2_WEIGHTS", SAM_REPO / "checkpoints/sam2.1_hiera_large.pt"))
SAM_CONFIG = "configs/sam2.1/sam2.1_hiera_l.yaml"
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
                    reason="Run npm run setup:masks to install the SAM 2.1 tracking baseline.")
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
    return dict(available=True, engine="SAM 2.1 Large · tracking preview",
                device=device, preserveMotionBlur=False, finalQuality=False,
                mattingCandidateInstalled=bool(matting),
                workerIdentity=revision,
                reason="MatAnyone2 is installed for evaluation; final matting has not passed validation." if matting else
                "Tracking preview only. Fine hair and source motion blur require a separately installed matting engine.")


def frame_at(times, time):
    return max(0, min(len(times) - 1, bisect.bisect_right(times, time + 1e-7) - 1))


def selected_frames(times, document, direction, anchor):
    start, end = document["range"]["start"], document["range"]["end"]
    anchor_index = frame_at(times, anchor)
    indices = [i for i, t in enumerate(times) if start - 1e-6 <= t < end - 1e-6
               and (direction != "forward" or i >= anchor_index)
               and (direction != "backward" or i <= anchor_index)]
    if not indices:
        raise ValueError("The range contains no decoded source frames.")
    return indices, {"start": max(start, times[indices[0]]),
                     "end": min(end, times[indices[-1] + 1] if indices[-1] + 1 < len(times) else end)}


def source_times(job):
    result = subprocess.run([job["ffprobe"], "-v", "error", "-protocol_whitelist", "file,pipe",
                             "-format_whitelist", FORMATS,
                             "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time",
                             "-of", "csv=p=0", job["input"]], capture_output=True, text=True, check=True)
    values = []
    for line in result.stdout.splitlines():
        try:
            value = float(line.split(",")[0])
            if math.isfinite(value):
                values.append(value)
        except ValueError:
            pass
    if not values or any(b <= a for a, b in zip(values, values[1:])):
        raise ValueError("Original video must have ordered decoded frame timestamps.")
    return [time - values[0] for time in values]


def filter_path(path):
    return str(path).replace("\\", "\\\\").replace("'", "'\\''").replace(":", "\\:")


def decode(job, indices, directory):
    # Decode by original ordinal, never approximate with -ss or duplicate via -r.
    filters = [f"select=between(n\\,{indices[0]}\\,{indices[-1]})"]
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
                    "-format_whitelist", FORMATS,
                    "-i", job["input"], "-vf", ",".join(filters), "-frames:v", str(len(indices)),
                    "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-threads", "1",
                    "-start_number", str(indices[0]), str(directory / "%d.ppm")], check=True)
    if any(not (directory / f"{i}.ppm").is_file() for i in indices):
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


def finish_frames(job, indices, times, output, load_alpha, load_source):
    """Save the original estimate separately so paint/reset never re-runs AI."""
    import numpy as np
    from PIL import Image
    repairs = {}
    for repair in job["document"]["repairs"]:
        repairs.setdefault(frame_at(times, repair["time"]), []).append(repair)
    for kind in ("base-frames", "frames", "source"):
        (output / kind).mkdir(exist_ok=True)
    for n, index in enumerate(indices):
        alpha = load_alpha(index)
        source = job["document"]["source"]
        if alpha.shape != (source["height"], source["width"]) or not np.isfinite(alpha).all():
            raise ValueError("Matting engine returned invalid alpha.")
        base = output / "base-frames" / f"{index}.png"
        Image.fromarray(np.rint(np.clip(alpha, 0, 1)*65535).astype(np.uint16)).save(base)
        if repairs.get(index):
            final = repair_alpha(np.clip(alpha, 0, 1), repairs[index])
            Image.fromarray(np.rint(final*65535).astype(np.uint16)).save(output / "frames" / f"{index}.png")
        else:
            os.link(base, output / "frames" / f"{index}.png")
        load_source(index, output / "source" / f"{index}.jpg")
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
    for kind in ("base-frames", "frames", "source"):
        (output / kind).mkdir(exist_ok=True)
    for n, frame in enumerate(manifest["frames"]):
        index = frame["index"]
        original = base / "base-frames" / f"{index}.png"
        os.link(original, output / "base-frames" / f"{index}.png")
        if repairs.get(index):
            with Image.open(original) as image:
                alpha = np.asarray(image).astype(np.float32)/65535
            alpha = repair_alpha(alpha, repairs[index])
            Image.fromarray(np.rint(alpha*65535).astype(np.uint16)).save(output / "frames" / f"{index}.png")
        else:
            os.link(original, output / "frames" / f"{index}.png")
        os.link(base / "source" / f"{index}.jpg", output / "source" / f"{index}.jpg")
        emit(progress=90 + 9*(n+1)/len(manifest["frames"]), stage="Saving corrections", frame=index)
    manifest.update({key: job[key] for key in ("version", "key", "signature", "projectId", "mediaId", "sourceFingerprint")})
    (output / "manifest.json").write_text(json.dumps(manifest, allow_nan=False))


def track(job, indices, times, decoded, destination, caps):
    import numpy as np
    import torch
    from PIL import Image
    sys.path.insert(0, str(SAM_REPO))
    import sam2.sam2_video_predictor as video_module
    from sam2.build_sam import build_sam2_video_predictor
    width, height = job["document"]["source"]["width"], job["document"]["source"]["height"]
    predictor = build_sam2_video_predictor(SAM_CONFIG, str(SAM_WEIGHT), device=caps["device"],
                                           apply_postprocessing=False,
                                           hydra_overrides_extra=["++model.add_all_frames_to_correct_as_cond=true"])
    class LazyFrames:
        # One worker process owns this adapter; no eager full-video tensor allocation.
        def __len__(self):
            return len(indices)

        @functools.lru_cache(maxsize=4)
        def __getitem__(self, index):
            with Image.open(decoded / f"{indices[index]}.ppm") as image:
                tensor = torch.from_numpy(np.array(image.resize((predictor.image_size, predictor.image_size))))
            tensor = tensor.permute(2, 0, 1).float()/255
            return (tensor - torch.tensor([.485, .456, .406])[:, None, None]) / torch.tensor([.229, .224, .225])[:, None, None]
    loader = video_module.load_video_frames
    video_module.load_video_frames = lambda **_: (LazyFrames(), height, width)
    try:
        state = predictor.init_state(str(decoded), offload_video_to_cpu=True, offload_state_to_cpu=True)
    finally:
        video_module.load_video_frames = loader
    grouped = {}
    for prompt in job["document"]["prompts"]:
        source_index = frame_at(times, prompt["time"])
        if source_index in indices:
            grouped.setdefault(source_index - indices[0], []).append(prompt)
    if not grouped or not any(p["kind"] == "include" for ps in grouped.values() for p in ps):
        raise ValueError("Add an Include point on a frame inside the selected direction and range.")
    def apply_prompts(index):
        prompts = grouped[index]
        clicks = [stroke_points(p, width, height) for p in prompts]
        labels = np.concatenate([np.full(len(points), 1 if p["kind"] == "include" else 0, dtype=np.int32)
                                 for p, points in zip(prompts, clicks)])
        if len(labels) > 4096:
            raise ValueError("Too many prompt samples on one frame. Use shorter strokes.")
        return predictor.add_new_points_or_box(state, index, 1, points=np.concatenate(clicks), labels=labels)
    first = min(index for index, prompts in grouped.items() if any(p["kind"] == "include" for p in prompts))
    apply_prompts(first)
    total = len(indices)
    done = 0
    with torch.inference_mode():
        for reverse, start in ((False, first), (True, first)):
            if reverse and first == 0:
                continue
            for index, _, logits in predictor.propagate_in_video(state, start_frame_idx=start, reverse=reverse):
                if reverse and index == first:
                    continue
                if index in grouped and index != first:
                    # A negative-only correction needs the tracked subject context.
                    # Add it after this frame's prediction, then consolidate memory.
                    _, _, logits = apply_prompts(index)
                    predictor.propagate_in_video_preflight(state)
                alpha = (logits[0, 0].float().cpu().numpy() > 0).astype(np.float32)
                np.save(destination / f"{indices[index]}.npy", alpha)
                done += 1
                emit(progress=10 + 45*done/total, stage="Tracking subject", frame=indices[index])
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
    with torch.inference_mode():
        for a, anchor in enumerate(anchors):
            left = indices[0] if a == 0 else (anchors[a-1] + anchor)//2 + 1
            right = indices[-1] if a+1 == len(anchors) else (anchor + anchors[a+1])//2
            for direction, stop in ((1, right), (-1, left)):
                if direction == -1 and left == anchor:
                    continue
                processor = InferenceCore(model, cfg=model.cfg, device=caps["device"])
                for index in range(anchor, stop + direction, direction):
                    with Image.open(decoded / f"{index}.ppm") as image:
                        rgb = torch.from_numpy(np.array(image)).permute(2, 0, 1).float().to(caps["device"])/255
                    if index == anchor:
                        mask = torch.from_numpy(np.load(tracked / f"{index}.npy")).to(caps["device"])
                        processor.step(rgb, mask, objects=[1])
                        for _ in range(11):
                            result = processor.step(rgb, first_frame_pred=True)
                    else:
                        result = processor.step(rgb)
                    if direction == -1 and index == anchor:
                        continue
                    alpha = processor.output_prob_to_mask(result).float().cpu().numpy()
                    np.save(destination / f"{index}.npy", alpha)
                    done += 1
                    emit(progress=55 + 35*done/len(indices), stage="Recovering fine edges", frame=index)
                del processor


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
    # Bound temporary disk demand before decoding, allowing all original pixels.
    need = len(indices)*width*height*12
    if need + 1024**3 > shutil.disk_usage(output).free:
        raise ValueError("Insufficient disk space for native-resolution analysis. Select a shorter range.")
    work = output / "work"
    for directory in (work / "rgb", work / "tracking", work / "alpha", output / "frames", output / "source"):
        directory.mkdir(parents=True, exist_ok=True)
    try:
        emit(progress=1, stage="Decoding original frames")
        decode(job, indices, work / "rgb")
        with Image.open(work / "rgb" / f"{indices[0]}.ppm") as image:
            if image.size != (width, height):
                raise ValueError("Decoded source dimensions differ from the saved mask.")
        anchors = track(job, indices, times, work / "rgb", work / "tracking", caps)
        alpha_directory = work / "tracking"
        if caps["preserveMotionBlur"]:
            matte(job, indices, anchors, work / "rgb", work / "tracking", work / "alpha", caps)
            alpha_directory = work / "alpha"
        def save_source(index, target):
            with Image.open(work / "rgb" / f"{index}.ppm") as image:
                image.save(target, quality=95, subsampling=0)
        finish_frames(job, indices, times, output, lambda i: np.load(alpha_directory / f"{i}.npy"), save_source)
        manifest = {key: job[key] for key in ("version", "key", "signature", "projectId", "mediaId", "sourceFingerprint")}
        manifest.update(engine=caps["engine"], modelRevision=json.dumps(caps["workerIdentity"], sort_keys=True),
                        quality=settings["quality"], width=width, height=height, sourceTimes=times,
                        frames=[dict(index=i, time=times[i], file=f"frames/{i}.png") for i in indices],
                        range=actual_range, alpha="gray16")
        (output / "manifest.json").write_text(json.dumps(manifest, allow_nan=False))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--check"]:
            emit(**capabilities())
        else:
            main(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as error:
        print(f"Smart Mask: {error}", file=sys.stderr)
        sys.exit(1)
