# Stabilize effect

Date: 2026-09-16. Product: SharedCut. Status: approved design, pre-implementation.

## Goal

A `Stabilize` video effect that removes camera shake from a clip. It drags onto a clip from the
Effects tab, edits in the Inspector, previews in the player, and exports. It must run on the Mac
today and on the Windows server unchanged (see `CLAUDE.md` cross-platform rules and
`docs/WINDOWS_MIGRATION.md`).

## Engine decision

OpenCV in Python. Rejected alternatives:

- ffmpeg `vidstab`: the Homebrew ffmpeg on the Mac is built without `libvidstab` and Homebrew no
  longer offers the option. Depending on a custom ffmpeg on two machines is out of the repo's control.
- Gyro (Gyroflow) and deep (DUT) methods: need gyro logs or heavy GPU models. Not general.

## 1. The effect (client)

One new entry in `effectDefinitions` (`src/services/effects.ts`), kind `video`:

| key | label | initial | range | meaning |
|---|---|---|---|---|
| `amount` | Strength | 100 | 0–100 % | Blend between the original path (0) and the smoothed path (100). |
| `smoothness` | Smoothness | 50 | 0–100 | Gaussian window over the camera path. 0 is a light touch, 100 is roughly a 5 s window. |
| `cropMode` | Crop | 0 | 0–2, step 1 | 0 Auto zoom, 1 Fixed zoom, 2 Borders (no zoom, black edges). |
| `zoom` | Zoom | 10 | 0–40 % | Fixed zoom amount; also the cap for Auto zoom. |
| `tripod` | Tripod | 0 | 0–1, step 1 | Lock to the first frame instead of smoothing. |
| `maxShift` | Max shift | 15 | 0–50 % | Clamp on per-frame translation correction, as % of frame width. |
| `maxAngle` | Max rotation | 5 | 0–30 ° | Clamp on per-frame rotation correction. |

`Inspector.tsx` renders the parameters generically. `cropMode` and `tripod` use the existing
integer-step slider; a small label map shows the mode name next to the value. The disabled
"Stabilization" section, the `properties.stabilization` boolean and the `stabilization` export
guard in `server/media.ts` are removed.

Eligibility (`acceptsEffect`): video clips only, not titles, shapes, captions or compositions.

Interactions rejected with a clear message (same pattern as optical flow rejecting Smart Mask):

- Stabilize + Smart Mask on one clip: the matte is in source coordinates and would be wrong after
  the warp.
- Stabilize + optical flow on one clip.

Speed, reverse and freeze are fine: the stabilized media keeps source timing.

Stabilize runs before every other stack effect regardless of its position in the stack, because it
replaces the clip's media. `videoFilters` and `detailPixels` skip it.

## 2. The engine (Python)

`scripts/stabilize.py`, run by `process.env.FRAME_LINE_STABILIZE_PYTHON || <repo>/.venv-stabilize/<bin>/python`.
Dependencies: `opencv-python-headless`, `numpy` only (`scripts/stabilize-requirements.txt`).
`scripts/setup-stabilize.py` builds the venv on macOS, Linux and Windows. `npm run setup:stabilize`
calls it.

Contract, same as the mask worker: `python stabilize.py job.json`, newline JSON `{"progress": n}`
on stdout, non-zero exit with a message on stderr on failure. `python stabilize.py --check` prints
`{"available": true, "opencv": "5.0.0"}`.

`job.json` fields: `{"stage": "analyze"|"render", "ffmpeg": path, "input": path, "from": seconds,
"to": seconds, "fps": number, "path": path.json, "output": path, "preview": bool,
"settings": {"amount","smoothness","cropMode","zoom","tripod","maxShift","maxAngle"}}`.

Two stages, each cached:

### Analysis (settings-independent)

Input: source path, source-time range `[from, to]`, fps.
Decode via ffmpeg (`FFMPEG_PATH`) rawvideo pipe, gray, long side scaled to at most 960 px.
Per frame pair:

1. `goodFeaturesToTrack` on a grid so features cover the frame, not just one textured corner.
2. Pyramidal Lucas–Kanade tracking with a forward–backward check.
3. `estimateAffinePartial2D` with RANSAC for a similarity (tx, ty, angle, log scale).
4. Too few inliers → identity for that frame and a `dropped` flag.

Output: `path.json` `{"version": 1, "width", "height", "fps", "frames": [[tx, ty, angle, logScale], …],
"dropped": [indices]}` with transforms in full-resolution pixels.

### Render (settings-dependent)

Input: `path.json`, settings from the table above, output sub-range, output kind (preview or export).

1. Accumulate the relative transforms into an absolute camera path.
2. Target path: Gaussian-smoothed path with sigma from Smoothness, or the first frame if Tripod.
3. Correction = target − actual, scaled by Strength, then clamped by Max shift and Max rotation.
4. Crop: Auto zoom finds the smallest uniform zoom (capped by Zoom) so every corrected frame covers
   the output. Fixed zoom uses Zoom directly. Borders uses no zoom and black edges.
5. Decode the sub-range in 16-bit RGB (`rgb48le`) via ffmpeg pipe, `cv2.warpAffine` each frame with
   bicubic interpolation, pipe back into ffmpeg.
6. Preview: libx264 at the same settings the optical-flow preview uses (`yuv422p10le`, half-second
   GOP). Export: ProRes 422 HQ `.mov`.

Smoothing always runs over the whole analysed range, so preview chunks and export line up.

## 3. Server

`server/stabilize.ts`, mirroring `server/opticalFlow.ts`:

- `stabilizeAnalysisIdentity(input, from, to, fps)`: sha256 over worker script hash, input path,
  size, mtime, range, fps. Cache at `data/stabilize/<key>.path.json`.
- `stabilizeIdentity(analysisKey, settings, from, duration, preview)`: sha256 over the analysis key,
  the settings and the requested chunk. Cache at `data/stabilize/<key>.mp4|.mov`.
- Existence check is the cache hit. Work is written into a temp directory and renamed in atomically.
- `trimStabilizeCache` evicts finished previews above ~2 GiB, oldest first, never analysis files.
- Child processes launched detached and killed via process group on POSIX, `child.kill` on Windows,
  copied from `runMaskProcess`.
- Capability probe `--check` cached 30 s, exposed at `GET /api/stabilize/capabilities`.

Routes, copied from the optical-flow block in `server/index.ts`:

- `POST /api/stabilize` `{clipId, chunk, quality, fps, settings}` → `{status, key, url, progress, from, duration, fps}`.
  409 if the clip's saved settings no longer match the request.
- `GET /api/stabilize/:key/video?projectId=…`, `DELETE /api/stabilize/:key`.
- Serial job chain with the same 8-job cap and generation abort as flow.

Export (`server/media.ts`): a guard in `renderTimeline` dispatch and a `renderStabilizedTimeline`
copied from `renderFlowTimeline`. For each clip with an enabled `Stabilize` effect: bake the used
source range to ProRes, push a synthetic asset `stabilize-<clipId>`, rewrite the clip to point at it
with `sourceIn` shifted and the `Stabilize` effect removed, keep audio from the original clip, recurse
into `renderTimeline`. Progress 0–45 % bake, 45–100 % composite.

## 4. Preview (client)

`src/services/stabilizePreview.ts`, copied from `flowPreview.ts`: 4 s chunks in source time, 300 ms
debounce, 750 ms poll, abort and DELETE on settings change, 32-entry cap.

`playback.ts`: when a clip has an enabled `Stabilize` effect and is not an audio-only render, request
the chunk for the current source time, swap the decoder to the proxy the same way `flowDecoder` does,
and pre-warm the next chunk. Status text: `Stabilize · Preparing n%`, `Stabilize · Ready`,
`Stabilize unavailable · <error>`. Until the proxy is ready, play the original.

## 5. Cross-platform checklist

- No Apple frameworks, no `xcrun`, no symlinks (ffmpeg reads the original path directly; the worker
  is Python, not a compiled binary).
- Paths via `node:path` and `os.tmpdir()`.
- ffmpeg via `FFMPEG_PATH`; Python via `FRAME_LINE_STABILIZE_PYTHON`; venv path differs per OS and the
  env var absorbs it. `docs/WINDOWS_MIGRATION.md` gets the new env var.
- Analysis and render are CPU. Upgrade path: an OpenCV CUDA build on the Lenovo speeds up
  `warpAffine` and LK; not needed to ship.

## 6. Testing

- `scripts/stabilize.py` self-check (`--selftest`): synthesize a shaky sequence by jittering a still
  image with known transforms, run analysis, assert the recovered path is within tolerance, run
  render with Strength 100 and assert residual jitter drops by an order of magnitude.
- `server/stabilize.test.ts`: identity keys change with settings and input, cache hit skips the
  worker, trim never touches analysis files.
- `src/services/effects.test.ts` additions: `acceptsEffect` rejects titles, shapes, captions,
  compositions; settings extraction reads the registry defaults.
- `server/media.test.ts`: clip with Stabilize dispatches to the stabilized renderer; Smart Mask and
  optical-flow conflicts throw.
- Live pass on the Mac with a real handheld clip, then the same on the Windows machine after the
  move.

## Out of scope

Rolling-shutter correction, per-frame mesh warps (MeshFlow), gyro data, GPU analysis, keyframing
the stabilize parameters (they are registry parameters and will show as keyframable; the renderer
uses the value at the clip start and this is noted in the Inspector).

## Revision 2026-09-16 (evening): crop-budget L1 path

Testing on the Girls Soccer clip 4B4A7032 (4K 59.94, pans up to 480 % of the frame width per second) showed
the Gaussian smoother lagging the pan by up to 59 % of the frame and zooming 2.07×. Replaced:

- **Path**: Grundmann et al. L1-optimal camera path (CVPR 2011), one linear program per axis (x, y, angle) solved with
  SciPy HiGHS. The user sets **Crop** (budget per side, default 5 % → 1.11× zoom); the path follows pans with
  constant, linear and parabolic segments and never leaves the budget. Zoom is `1/(1-2·crop)`, creeping up at most 6 %
  where rotation and translation combine past it. **Smoothness** scales the second/third-derivative weights.
  **Lock** keeps the first frame with auto zoom (tripod). Scale drift is never corrected.
- **Parameters** are now `amount` (Strength), `crop`, `smoothness`, `lock`. `cropMode`, `zoom`, `tripod`, `maxShift`
  and `maxAngle` are gone.
- **Analysis always runs on the camera original**, cached once per source range. The half-resolution proxy lost tracking
  on 8 % of frames and invented a 42°/s rotation; the original lost none. Previews render from the proxy of the
  requested quality with the matrices rescaled; the render cache key includes the render input.
- **Tracking**: per-frame fits with more than 1.5° rotation or 4 % scale are rejected as foreground/whip-pan artefacts and,
  like lost frames, interpolated from their neighbours instead of being treated as no motion.
- Measured on the clip: perceived shake (rms frame-to-frame acceleration) down 62 % at 5 % crop, 72 % at 8 %.
  Analysis 12.5 s for 25 s of 4K; export 62 s; L1 solve 1.5 s.
- Still open (phase two): rolling-shutter shear correction on whip pans, content-preserving mesh warp for parallax.
