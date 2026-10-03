# Depth: depth maps and depth effects

Date: 2026-10-03. Product: SharedCut. Status: draft plan for Konrad's review. Nothing is built yet.

## Goal

What Konrad asked for:

- A depth map like DaVinci's: a black-and-white view (near is white, far is black) that fills in
  live while the clip is analyzed.
- Really good, but fast enough on the Dell (production) that analysis feels real time.
- Effects driven by depth: fake depth of field (lens blur), atmospheric fog and haze, glow, and
  lighting changes that hit only the background without washing out the subject. Ready-made
  looks that come with it.
- Smooth playback, full-quality export, robust, and a base for more effects later.
- Work with Smart Mask wherever that helps.

## What this plan is based on

### Hardware (checked 2026-10-03 over `ssh gpu-host`)

- **GPU:** the Dell G16 has an RTX 4070 Laptop GPU with 8,188 MiB of VRAM.
  - About 3.2 GB is already in use at idle by the desktop (Chrome, Wallpaper Engine, overlays).
  - So each job gets at most about 3.5 GB.
  - Driver 596.49. CPU is an i9-13900HX.
- **Disk: C: has 11 GB free.** Every cache in this plan is capped, and every job checks free space.
- **4:2:2 decode:** NVIDIA's Ada generation (the 4070) cannot hardware-decode 4:2:2, so the Sony
  4:2:2 HEVC footage decodes on the CPU. The tracker measures 20–40 fps at 4K. The Lenovo's
  Blackwell GPU can decode it.
- **Python environment:** `.venv-mask` already contains torch 2.14.0+cu130, torchvision, opencv,
  numpy and Pillow. A second torch environment would cost about 5 GB that the Dell doesn't have.
  So the depth worker runs in `.venv-mask`.

### Code

These findings come from a survey of HEAD 405a842. During the survey the folder was mid-rebase
onto f717ea1, so line numbers are approximate; function names are reliable.

- **Effects:** an effect is a metadata entry in `effectDefinitions` (`src/services/effects.ts`).
  - Preview is a hard-coded branch in the `finishLayer` effects loop (`src/services/playback.ts`).
  - Export is a hard-coded branch in `videoFilters` (`server/media.ts`).
  - The order of `clip.effects` is the render order.
  - Every numeric parameter can be keyframed with no extra work (`animation.ts`).
  - `Effect.maskId` already exists.
- **Preview order for each layer:** decode, colour pass (WebGL2), Stabilize warp, effects loop
  (Canvas 2D), flip, then opacity, blend and transform.
  - Only colour and motion blur use WebGL2.
  - `motionPreview.ts` is a self-contained WebGL2 pass. It is the template here.
- **Smart Mask pieces this plan reuses:**
  - the source PTS table (`masks.sourceTimes()`, probed from packet timestamps);
  - the `smartMaskFrame()` lookup;
  - the analysis LUT (`maskAnalysis` and `logView`), which makes log footage look display-referred;
  - the job-service pattern and `commitFolder`;
  - `runWorkerProcess` with `onMessage`, `killProcessTree` and `filterPath`.
- **GPU sharing:** `heavyJob` is limiter(2) and doesn't know about the GPU. SAM tracking, the
  resident SAM preview worker and CUDA captions can all hold VRAM at the same time.
- **Partial results:** only the motion tracker streams them (`onMessage` rows, `?after=n`, a
  120 ms poll). Smart Mask serves nothing until it commits.
- **Export:** runs in parallel parts.
  - Masked clips take the staged float path: `color-render.py` runs FFmpeg decode into numpy and
    writes FFV1 16-bit.
  - `color-render.py` works per pixel, on the CPU, at about 1 s per frame at 4K.
  - That makes it fine for depth-weighted grades but the wrong place for a variable blur.
- **FFmpeg `varblur`:** applies a box blur with a per-pixel radius. It leaves halos at depth edges
  and can't make bokeh, so it won't be the shipped look. It stays as a fallback idea.
- **Timeline previews:** the server pre-render for heavy timelines at Stream quality goes through
  `renderTimeline`. Anything the exporter supports also plays there.
- **Progress display:** the ruler bar doesn't show server work. Analysis progress appears on the
  clip itself (`clipStatus.ts`, `ClipActivityBar`).
- **Likely existing bug:** a Stabilize + Smart Mask export probably looks mattes up `range.from`
  seconds too early on trimmed clips.
  - The Stabilize bake shifts `sourceIn`, but the reused manifest isn't shifted.
  - No test covers this.
  - Depth would reuse the same mapping, so this gets verified with a failing test and fixed first.

### Models (October 2026)

Licenses are from the official repos and model cards.

| Model | License | Consistent across frames | Fits the Dell? | Note |
|---|---|---|---|---|
| Video Depth Anything Small (28.4M) | Apache-2.0 | yes: 32-frame windows with keyframe alignment | likely, if the head runs in mini-batches | A100: 7.5 ms/frame fp16 at 32×518², 6.8 GB at that size |
| VDA streaming mode | same | partly (ScanNet δ1 drops from 0.926 to 0.836) | yes, low VRAM | fallback if the windows don't fit |
| Depth Anything 3 Small / Base | Apache-2.0 | yes, multi-view chunks (DA3-Streaming) | unknown | benchmark in Phase 0 |
| DA3Mono-Large (0.35B) | Apache-2.0 | no (one frame at a time) | yes, but slow | candidate for a later detail pass |
| VDA Base/Large, DAv2 B/L/G, DA3 Large/Giant | CC-BY-NC-4.0 | — | Large needs 23.6 GB VRAM: no | non-commercial; not used |
| FlashDepth | labeled Apache, but L and Full are built on DAv2-Large; needs mamba-ssm CUDA kernels | streaming | — | doesn't work well on Windows or MPS; not used |
| oVDA | NC-SA-UHDV1.0 | streaming | — | non-commercial; not used |

By default the plan uses only weights that are safe for commercial use. This is the same rule as
the MatAnyone2 decision in `smart-mask-implementation.md`. The big non-commercial models wouldn't
fit the Dell's 8 GB anyway.

## Approach

**Analyze on the server, preview on the editor's GPU, export on the server's GPU.** This is the
same shape as Stabilize (CLAUDE.md rule 8).

1. The Dell analyzes depth once per source range with Video Depth Anything Small (VDA-Small) and
   caches it as tiny video segments.
2. The browser decodes the segments and renders every depth effect in real time in a WebGL2 pass.
3. Export runs the same math in PyTorch on the Dell's GPU at full resolution, then splices the
   result back into the normal export.

Rejected:

- **In-browser inference** (transformers.js / WebGPU):
  - one-frame-at-a-time models flicker;
  - every editor would recompute the depth, and weak laptops would crawl;
  - export would still need the server, which means two inference paths.
- **FFmpeg-only effects** (`varblur`, `maskedmerge`): quick to build, but box-blur halos appear
  around the subject and there's no bokeh. That falls short of "really good".

## 1. Analysis (server)

### Worker: `scripts/depth.py` (runs in `.venv-mask`)

- **Interpreter:** `FRAME_LINE_DEPTH_PYTHON`, defaulting to `venvPython('.venv-mask')`.
- **Modes** (same as `smart-mask.py`):
  - `--check` reports identity: the weight SHA-256, a hash of the worker source, the torch version
    and the device.
  - `--selftest`.
  - a normal run reads a `job.json`.
- **Device and precision:**
  - Device order: cuda, then mps, then cpu.
  - fp16 autocast on CUDA and MPS, fp32 on CPU.
  - `FRAME_LINE_DEPTH_PRECISION=full` forces fp32.
- **Model code:** VDA-Small's inference code, vendored at a pinned commit.
  - That covers DINOv2, `DPTHeadTemporal`, and the windowing and alignment from `video_depth.py`.
  - The xformers attention is replaced with `torch.nn.functional.scaled_dot_product_attention`.
  - The only new package is `einops`, added to `mask-requirements.txt`.
  - The Apache-2.0 notice goes in `public/licenses/`.
- **Windowing:** this is VDA's own long-video algorithm, unchanged.
  - Windows are 32 frames, starting every 22 frames.
  - Keyframes are `[0,12,24..31]`, with scale/shift alignment between windows.
  - There is no per-window normalization. That is what keeps the result flicker-free.
- **VRAM:**
  - The head's spatial upsampling layers run one frame at a time (mini-batches). The output is
    identical and the peak memory is much lower.
  - `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.
  - On a CUDA out-of-memory error, retry once with a smaller mini-batch. If that also fails, fail
    with "GPU busy, try again" (the job can be retried).
  - Before a CUDA run, if the resident SAM preview worker is idle and free VRAM is short, the server
    stops it. It re-warms in about 2 s when next needed.
- **Input frames:**
  - **Range:** the clip's source range plus 1 s handles, snapped to the segment grid.
  - **Decode route:** chosen per asset and recorded in the job identity.
    1. The 960 px `1/2` proxy (`stream-v2.mp4` since media storage v3), when its frame count and PTS match the source table. H.264 is cheap
       to decode, and the proxy is already at least as big as the analysis size. The stabilize notes
       say a proxy once lost 8% of frames, so this is checked per asset, never assumed.
    2. Otherwise the original, using NVDEC if a trial decode proves it works. Check stderr: on 4:2:2,
       Ada falls back to software and still exits 0 (see `tracker.py`).
    3. Otherwise the original on the CPU.
  - **Scaling:** to the analysis size, short side 518 and a multiple of 14 (924×518 for 16:9).
  - **Colour:** apply the Smart Mask analysis LUT through `lut3d` (with `filterPath`) so log footage
    is display-referred.
  - **Transport:** raw RGB over a pipe, with no temp frames on disk.
- **Output for each 64-frame segment** (written under a temp name, then renamed):
  - `preview/<n>.mp4` is for the browser. Depth goes in the Y plane with neutral chroma: H.264
    8-bit, CRF about 18, GOP 16, faststart, about 2–8 KB per frame.
  - `master/<n>.mkv` is for export. Depth goes in the Y plane, HEVC Main10, near-lossless, an
    expected 15–30 KB per frame. A 16-bit PNG per frame would take about 10× the disk, which the
    Dell can't spare.
  - Encode with NVENC when its probe passes, otherwise libx264 / libx265.
  - After the rename, print `{segment:n, first, count}` on stdout.
- **What the stored values mean:**
  - VDA outputs relative inverse depth: disparity, up to an unknown scale and offset, anchored to the
    first window's scale.
  - Each run's mapping is fixed by the first window: `lo` and `hi` are its 1st and 99th percentiles,
    plus 25% headroom on each side. They are stored once in the manifest.
  - The stored value is the normalized disparity, clamped.
  - It is never renormalized later, so a focus distance set during analysis doesn't move when
    analysis finishes.
- **Progress:** `{progress, stage}` lines for each stage (decode, infer, encode).
- **Disk check before starting:** estimate the number of segments × 40 KB, plus 1 GB.

### Service: `server/depth.ts`

Modelled on `smartMaskService`.

- **Cache key:** a hash of the source fingerprint, the snapped range, the analysis LUT identity, the
  decode route and the worker identity from `--check`.
  - **There is no clipId in the key**, so split or duplicated clips of the same take share it.
- **Reuse:** a finished run that covers the requested range is reused. Otherwise a new run is made
  for this clip's range. That's cheap; v1 doesn't merge runs.
- **Job handling:**
  - Jobs are kept in memory, with an atomic `<key>.job.json` written on each status change.
  - `.partial-*` folders are cleaned up at startup.
  - A server restart marks the job failed and offers a retry.
  - Each job runs on the service's own promise chain, then inside `heavyJob`.
- **GPU limiter:** a new `gpuJob = limiter(1)` in `workQueue.ts`.
  - Taken by depth analysis, depth export bakes, SAM tracking and CUDA captions.
  - The resident SAM preview worker stays outside it, because it's small and is stopped when VRAM
    is short.
- **Streaming partial results**, the way the motion tracker does:
  - `onMessage` records each finished segment.
  - `GET /api/depth/<key>?projectId&after=n` returns the status plus any new segments.
  - A segment file is served only after it's recorded, and only to members of a project bound to
    the run.
- **Publish:** with `commitFolder` when the run finishes, writing the manifest last. If the commit
  has to fall back to copying (because of a Windows folder watcher), served segment URLs stay
  valid. They are addressed by key and segment number.
- **Cache cap:**
  - `FRAME_LINE_DEPTH_CACHE_GB` defaults to 3, evicting the least recently used run.
  - A run in use by a running export or job is never evicted.
  - New runs are refused below `FRAME_LINE_DEPTH_MIN_FREE_GB` (default 2), with a clear message.
- **Project bundles:** depth isn't included, because it can be recomputed. Smart Mask artifacts
  are handled the same way.

### Routes (`server/index.ts`)

- `GET /api/depth/capabilities` returns available, reason, engine and device.
- `POST /api/depth` with `{clipId}` returns the job. Needs editor rights.
- `GET /api/depth/<key>?projectId&after=n` returns the status, progress, segments and manifest
  fields.
- `DELETE /api/depth/<key>?projectId` cancels.
- `GET /api/depth/<key>/preview/<n>.mp4?projectId` serves one preview segment.
  - Immutable, private, and supports byte ranges.
  - It matches the footage Service Worker's `/api/**/*.mp4` rule, so a segment that has played once
    stops crossing the tunnel.
- Masters are never served to browsers. Only the exporter reads them.

### Setup

- `scripts/setup-depth.py`: a pinned VDA commit and a pinned weight SHA-256. It downloads,
  verifies, renames, then runs `--check`, the same as `setup-masks.py`.
- `package.json`:
  - `setup:depth` runs `setup-venv.mjs .venv-mask scripts/mask-requirements.txt scripts/setup-depth.py`.
  - Also add `test:depth` and `test:depth:browser`.
- Add it to the list in `scripts/setup-windows.mjs`, add a `check('depth', …)` to
  `scripts/doctor.mjs`, and add a table row and verification step to `docs/WINDOWS_NATIVE.md`.

### Speed

These are estimates. Phase 0 measures them.

- **VDA-Small on the 4070 Laptop in fp16:** roughly 25–45 fps of analysis at 924×518, after
  accounting for window overlap. That is real time for 24p and 30p.
- **4K 60p 4:2:2 Sony footage on the Dell:** CPU decode caps it around 20–40 fps, about 0.5× real
  time. That changes if the `1/2` proxy turns out to be frame-exact. It's faster on the Lenovo.

## 2. The Depth effect (client)

- **Registration:** one registry entry, `Depth` (kind `video`).
- **One per clip:** the store refuses a second.
- **Fixed internal order:** **Light → Fog → Lens blur → Glow**. This follows the physics: scene
  light and air come before the lens, and bloom comes last.
- **Sections:** a section is off while its main slider is 0.
- **Keyframes:** every number can be keyframed. A rack focus is just keyframes on Focus.
- **Distance scale:** 0 is nearest and 100 is farthest, in the run's fixed mapping.
  - 0 sits at the first window's 99th disparity percentile, and 100 at its 1st.
  - Anything nearer or farther than that clamps to 0 or 100.

| key | label | initial | range | meaning |
|---|---|---|---|---|
| `amount` | Mix | 100 | 0–100 % | Whole effect vs. the untouched picture. |
| `blur` | Lens blur | 0 | 0–100 | Max blur radius; 100 = 2.5 % of frame width. |
| `focus` | Focus | 30 | 0–100 | Focus distance. Set by clicking the picture; set from the frame centre when Lens blur first turns on. |
| `range` | Depth of field | 10 | 0–100 | Width of the sharp band around Focus. |
| `nearBlur` | Foreground blur | 60 | 0–100 % | How much things in front of Focus blur. |
| `bokeh` | Bokeh | 40 | 0–100 | Highlight boost so lights become discs. |
| `fog` | Fog | 0 | 0–100 | Fog amount. |
| `fogStart` | Fog start | 35 | 0–100 | Distance where fog begins. |
| `fogDensity` | Fog density | 50 | 0–100 | How fast it thickens behind Fog start. |
| `fogHue` / `fogSaturation` / `fogBrightness` | Fog colour | 210 / 10 / 85 | 0–360, 0–100, 0–100 | Colour of the air (cool white). |
| `fogHorizon` | Horizon | 30 | 0–100 | Extra fog toward the top of frame. |
| `glow` | Glow | 0 | 0–100 | Background-only bloom. |
| `glowThreshold` | Glow threshold | 70 | 0–100 % | Brightness that starts glowing. |
| `glowRadius` | Glow radius | 30 | 1–100 | Size of the glow. |
| `light` | Background light | 0 | 0–100 | Strength of the background grade. |
| `lightStart` | Background starts | 40 | 0–100 | Distance where "background" begins. |
| `lightSoftness` | Softness | 30 | 0–100 | Width of the transition. |
| `bgExposure` | Exposure | 0 | −3 to 3 EV | Background exposure. |
| `bgSaturation` | Saturation | 100 | 0–200 % | Background saturation. |
| `bgWarmth` | Warmth | 0 | −100 to 100 | Background temperature. |
| `bgContrast` | Contrast | 100 | 0–200 % | Background contrast. |

- **Smart Mask subject:** the existing `Effect.maskId` field optionally names one. This is Phase 3:
  focus follows that subject and its edges are protected.
- **Presets:** client-side constants, each applied as one undoable commit. They are tuned on real
  footage in Phase 2.
  - Portrait
  - Cinematic haze
  - Morning mist
  - Dreamy glow
  - Subject pop: background darker and cooler, slight blur
  - Miniature: tilt-shift
- **Eligibility:** real video and image clips. An image is a one-frame run. Not titles, shapes,
  captions or compositions, because there's no source to analyze.

### Inspector: `src/components/DepthInspector.tsx`

A custom panel, like `SmartMaskInspector`.

- **Status line:** "Analyzing depth · 37 % · ready to 0:04", "Depth ready", the unavailable reason
  from capabilities, and Retry.
- **Show depth map** toggle, Resolve-style: near is white, far is black.
  - It's viewer-only: not saved and not exported.
  - It turns on when the effect is first added, so you watch the analysis happen. It stays on until
    you touch a preset or a section.
- **Presets row.**
- **Sections:** Lens blur, Fog, Glow, Background light. Their sliders are generated from the
  definition.
- **Focus picker:** "Click the picture to focus."

### Viewer and timeline

- **Depth map view:** frames appear as segments arrive, so you watch the map fill in while playing.
- **Frames not yet analyzed:** these play the plain picture with a small "Analyzing depth" badge.
  Playback doesn't stall.
- **Clip progress:** an activity bar reading `Depth · 37 %` via `setClipActivity`, plus a thin
  "depth ready" line on the clip like the footage cache line.

## 3. Preview renderer (browser)

### `src/services/depthPreview.ts`

Same shape as `createSmartMaskPreview`.

- **Polling:** poll the job every 400 ms while it's analyzing (with the `after` cursor), and stop
  once it's ready.
- **Decoding:**
  - Fetch whole segment MP4s, which are a few hundred KB.
  - Decode them in a worker with mediabunny / WebCodecs, the same pattern as `videoDecodeWorker.ts`.
  - Keep only the Y plane as R8 bytes, at 924×518 = 478 KB per frame, and close each frame.
  - Keep a ring buffer of at most 32 decoded frames, about 15 MB.
  - Seek to the segment keyframe at or before the target (GOP 16), then decode forward.
- **Exact frame:** `smartMaskFrame(queuedFrame.timestamp/1e6, source, sourceTimes)` gives the frame
  index, then segment n = ⌊(index − runFirst) / 64⌋.
  - Use the decoded frame's own timestamp, never the playhead. That was a lesson from Smart Mask.
- **Fallback:** use the previous frame only when the exact one isn't decoded yet, so the depth is at
  most one frame old. Older depth misaligns edges on fast motion. If even that isn't available,
  render the frame without depth effects.
- **Prefetch:** fetch the next segment once the playhead passes 75 % of the current one.

### `src/services/depthFx.ts`

A self-contained WebGL2 module modelled on `motionPreview.ts`: its own context, a fullscreen
triangle, recovery from context loss, and it returns a canvas.

- **Inputs:**
  - the layer canvas, after colour and Stabilize;
  - the depth R8 texture;
  - an optional matte texture;
  - the parameters;
  - the letterbox box, computed from the **original** source size;
  - the Stabilize warp matrix. Depth is sampled through the same warp as the picture, the same way
    the matte is.
- **Passes:**
  1. **Depth:** a joint-bilateral upsample (4×4 low-res taps, weighted by spatial distance and guide
     luminance) snaps depth edges to picture edges. Then map the result to distance.
  2. **Light and Fog**, per pixel:
     - Fog mixes toward the fog colour by `1 − exp(−density × max(0, d − start))`, plus the horizon
       term.
     - Light applies exposure, saturation, warmth and contrast, weighted by
       `smoothstep(start, start + softness, d)`.
  3. **Circle of confusion (CoC)**, plus a tile maximum at 1/8 resolution, dilated.
  4. **Gather bokeh** in a single pass:
     - Samples on a golden-angle disc, ordered by depth: background can't bleed onto sharper or
       nearer pixels, while foreground spreads over background.
     - Highlights get extra weight, so lights form bokeh discs.
     - Large CoC is rendered at half resolution, then composited with the full-resolution sharp
       image according to CoC.
  5. **Glow:** threshold × far weight, a separable blur at quarter resolution, then screen.
  - **Depth map view:** writes distance as grey, with near shown white.
- **Quality:** 16, 32 or 48 taps depending on preview quality (1/4, Stream or 1/2, Full), plus
  50 % more while paused.
- **Banding:** 8-bit depth is dithered (interleaved gradient noise), so fog doesn't band.
- **No WebGL2:** draw the frame unchanged and show one warning. Export isn't affected.

### `src/services/playback.ts`

- **Render hook:** a new `Depth` branch in the `finishLayer` effects loop. It runs after colour and
  Stabilize, before flip and transform, then draws `depthFx.render(...)` back into `layer` with
  `'copy'`.
- **Colour pass:** Depth doesn't force the colour pass. Smart Mask does.
- **Focus picker:** read the CPU Y plane at the clicked source point, then `updateEffect(focus)`.
  That sets a keyframe when animating.

## 4. Export renderer (server)

### `scripts/depth-fx.py` (runs in `.venv-mask`)

The structure copies `render()` in `color-render.py`.

- **Pipeline:** an FFmpeg decoder pipe feeds torch on the GPU, which feeds an FFmpeg encoder pipe
  that writes ProRes 4444 at the source resolution. Compositions and flow already use the same
  intermediate.
  - FFV1 16-bit at 4K is about 25 MB per frame, which this disk can't hold.
- **The decoder graph holds everything that comes before Depth in the clip's processing:**
  - the grade: either the `lut3d` path, or `color-render.py`'s output when exact colour is required;
  - any effects that come before Depth in the stack.
- **Depth masters:** FFmpeg decodes them (a concat of the segments), one frame per decoded source
  frame, using the same timing chain as mask streams.
  - Stabilize matrices are applied to depth on the fly with `grid_sample`, so no warped files are
    written.
- **The math is the same as `depthFx.ts`:** joint-bilateral upsample, light, fog, gather bokeh and
  glow. It's written once per path, and a parity test checks the two agree.
- **Disk:** check free space before baking (frames × about 1.6 MB × pixel count relative to 4K,
  plus margin). Temp files are removed on finish or cancel.
- **Known limit:** the bake always runs at source resolution.
  - A 4K clip in a 1080p export with no punch-in could bake at 1080p instead, for about 4× less time
    and disk.
  - But pixel-sized effects stacked after Depth (grain, Gaussian blur) would then change size.
  - That optimization waits until it's needed.

### `server/media.ts`

- **Staged path:** a clip with an active Depth effect takes a staged path, alongside `exactColor`.
  - Its output replaces the clip's media for that part.
  - The grade, Stabilize and effects up to Depth are stripped, since they're already baked in.
  - `sourceIn` is mapped the way the Stabilize bake maps it, after the offset bug is fixed.
- **Missing analysis:** export starts or waits for missing depth analysis instead of failing.
- **Audio:** add `Depth` to the audio skip list. `fitFirst` already turns off for pixel effects.
- **Rejected by name**, in the same style as masks:
  - Depth + optical flow: "needs warped depth".
  - Depth on VFR sources: the staged path is CFR.
- **Timeline previews** skip any 4-s chunk holding an active Depth clip (status `skipped`): a bake there took about 90 s for
  4K60 and held a media slot, often waiting on analysis, while the editor draws Depth live in WebGL anyway.

## 5. Smart Mask together with depth

Built (Phase 3 items 1 and 2): the Depth inspector's **Subject** picks one of the clip's Smart Masks and **Follow
subject** keeps Focus on it; the math is section 7 of the math doc. The export reads the mask's native 16-bit frames by
source index (`matte.files` in the depth-fx.py job) and the focus track as per-frame `animated.focus`.

Ranked by value:

1. **Focus follows the subject** (`maskId` on the Depth effect).
   - The server builds a per-frame focus track: the median distance inside the matte, smoothed with
     a zero-phase filter so focus doesn't hunt.
   - It's one small JSON file that both preview and export read.
   - Result: you can rack focus onto a moving player without keyframes.
2. **Clean subject edges.**
   - Inside the matte, CoC is 0, and those pixels are left out of background gathers, so there's no
     halo around the person.
   - SAM's edges are sharper than depth edges at 518 px.
3. **Depth key as a mask** for grade nodes, and for clip alpha.
   - `mask.source: 'depth'`, with near, far, softness and invert.
   - In Color this means "grade only the background", and it can be combined with a Smart Mask.
   - Preview goes through the colour shader's mask path.
   - Export goes through `color-render.py`, where depth is one more per-pixel alpha plane.
   - **Built for grade nodes (2026-10-03):** `mask: {source: 'depth', enabled, invert, amount, near, far, softness}`.
     One mask per node, so a node takes a Smart Mask or a depth key, not both; clip alpha is not built.
     - Key: `smoothstep(near - s, near, d) × (1 - smoothstep(far, far + s, d))` with `s = max(softness, 1e-4)` and `d`
       the 0..100 distance of section 0 of the effect maths (`depthKeyAlpha` / `depthKeyTable` in `src/services/depth.ts`).
       Near 0 and far 100 key everything.
     - The key is computed per depth texel and upsampled **bilinearly** to the picture, in preview (canvas fit into the
       R8 mask atlas, like a Smart Mask) and export (`color-render.py` reads the 10-bit masters). No guided upsample:
       a grading key's edges are as soft as the depth's. Preview keys the 8-bit preview segments, export the masters.
     - A node using one starts the clip's depth analysis. Before a frame is analyzed the node grades nothing.
     - Export asks for the clip's whole span (`depthSpan`/`depthRun` in `server/media.ts`, the same call as `POST /api/depth`,
       the export's wait and the Depth bake), so a pass, an In/Out range or a per-frame render joins the editor's run and
       its near/far, never a smaller one.
     - Export refuses a depth key with Stabilize or optical flow (it would need warped depth), and on VFR sources.
4. **Depth helping SAM.** This is an experiment.
   - Cut SAM leaks across depth jumps, such as a teammate standing behind the player, and fill holes
     that are consistent in depth.
   - Measure on the soccer clip against hand-labelled frames: leak pixels and IoU.
   - Ship it only if it measurably helps.
   - **Result (2026-10-03): rejected.** On the soccer and hurdles clips it cut off hands, feet and arms at every
     threshold, while leaks onto players at the same distance stayed and hole filling made them solid.

## 6. Robustness checklist

- **GPU:** the `gpuJob` limiter, a retry on out-of-memory, and a VRAM target of at most 3.5 GB on
  the Dell. Phase 0 measures that with the SAM preview worker loaded.
- **Disk:** caps, free-space checks, and temp files cleaned up on cancel, crash or restart.
- **Truthful states:** capabilities, analyzing / ready / failed, and an unavailable reason that
  names the setup command.
- **Collaboration:** depth is shared by content key. Effect parameters live in `clip.effects`, so
  merge, undo, snapshots and locks all work with no extra code.
- **Windows rules:**
  - `node:path` and `filterPath`;
  - hard links or copies, never symlinks;
  - `processTree`;
  - interpreters set through env vars;
  - NVDEC and NVENC detected, never assumed.
- **Restart:** interrupted runs are marked failed with a retry, and partial folders are deleted.

## 7. Tests

- **`scripts/depth.py --selftest`:**
  - a synthetic scene with a known order (a near plane and a far plane): the order is preserved;
  - segment encode/decode round trip within 1/1023 (master) and 1/255 (preview);
  - frame-index mapping, including B-frame PTS order.
- **`server/depth.test.ts`:**
  - the key and reuse across split clips;
  - partial serving: only recorded segments, and only for bound projects;
  - cancel kills the whole process tree;
  - restart cleanup;
  - cache cap and eviction;
  - refusal when free space is low.
- **`src/services/depth.test.ts`:** frame-to-segment lookup, value mapping, valid preset
  parameters, CoC math.
- **`scripts/depth-fx-check.mjs`:** the same synthetic RGB + depth + matte goes through both the
  WebGL pass (headless Chrome) and `depth-fx.py`, with per-pixel error thresholds, like `test:color`.
- **`src/components/depth.browser.test.ts`:**
  - add Depth; Show depth map fills in progressively;
  - Lens blur: the far region loses high-frequency detail while the near region keeps it (checked
    with pixel probes);
  - the focus picker sets Focus.
- **`scripts/depth-inference-check.mjs`** (real model, on the Dell): fps, peak VRAM, a flicker
  measure on a locked-off shot, and an export of a clip with Lens blur + Fog.
- **`node scripts/remote-playback-check.mjs`:** run before and after, per the rule for playback
  changes.
- **Stabilize + mask export offset:** write a failing test first, then the fix.

## 8. Phases

| Phase | Ships | Done when |
|---|---|---|
| 0. Benchmark (no product code) | Numbers and side-by-side depth videos for Konrad | VDA-Small reaches at least 24 fps at 924×518 on the Dell with 1080p 4:2:0 footage, peak VRAM stays at or under 3.5 GB, and a locked-off shot shows no visible flicker. DA3-Small/Base compared. Proxy frame-exactness checked on real assets. |
| 1. Depth analysis + live depth view | Worker, service, routes, setup and doctor, the Depth effect with status and Show depth map, timeline progress | Browser test and inference check pass on the Dell; the map fills in live while playing |
| 2. Depth effects + export | `depthFx.ts`, presets, focus picker, `depth-fx.py`, the media.ts staged path, images | Parity, export and playback checks pass |
| 3. Smart Mask tie-in | Focus follows subject, edge protection, depth-key masks, and the SAM-assist experiment | Soccer clip review and an experiment report |
| 4. Pick list | God rays, drifting volumetric fog, a 2.5D parallax move, a titles-behind-subject preset, depth pass export, a high-detail refine pass (DA3Mono-Large fused in), starting analysis at the playhead on long clips | — |

## 9. Risks and open questions

- **VRAM:** VRAM for 32-frame windows at 924×518 hasn't been measured. The official 6.8 GB figure
  is at 518² on an A100. Mitigations, in order: run the head in mini-batches, analyze at 392 px, use
  streaming mode.
- **Disk:** the Dell has 11 GB free. The plan caps everything, but exports with bakes need
  headroom. Freeing space before heavy use would help.
- **Relative depth only:** there are no metres. Effects use the fixed 0–100 distance, which is fine
  for looks but not for measurement. The license for the metric VDA-Small isn't stated, so it isn't
  used.
- **Thin detail:** thin structures and hair get soft depth. For hero subjects, the real answer is
  edge protection from Smart Mask.
- **Analysis speed:** 4K60 4:2:2 analyzes at about 0.5× real time on the Dell if the proxy isn't
  frame-exact.

## 10. Files

**New:**
- `scripts/depth.py`, `scripts/depth-fx.py`, `scripts/setup-depth.py`
- `server/depth.ts`, `server/depth.test.ts`
- `src/services/depthPreview.ts`, `src/services/depthFx.ts`
- `src/services/depth.ts` (shared types, mapping, presets), `src/services/depth.test.ts`
- `src/components/DepthInspector.tsx`, `src/components/depth.browser.test.ts`
- `scripts/depth-fx-check.mjs`, `scripts/depth-inference-check.mjs`
- `public/licenses/video-depth-anything.txt`

**Changed:**
- `src/services/effects.ts`: the entry and `acceptsEffect`.
- `src/state/store.ts`: one Depth per clip, preset commit, focus picker.
- `src/services/playback.ts`: the effects branch.
- `src/components/Inspector.tsx`: the custom panel.
- `src/components/Timeline.tsx` and `clipStatus.ts`: progress and the ready line.
- `server/index.ts`: routes and validation.
- `server/workQueue.ts`: `gpuJob`.
- `server/media.ts`: the staged path, the rejections and the audio skip list.
- `server/smartMask.ts` and the caption job: take `gpuJob`.
- `scripts/mask-requirements.txt`: add `einops`.
- `package.json`, `scripts/setup-windows.mjs`, `scripts/doctor.mjs`.
- `docs/WINDOWS_NATIVE.md`, `docs/architecture.md`.

## Addendum (2026-10-03, after Phase 0)

### Phase 0 results (Dell, RTX 4070 Laptop, torch 2.14.0+cu130, fp16, stock PyTorch, SDPA attention)

| Clip | Source | Analysis | Decode | Inference | Peak VRAM |
|---|---|---|---|---|---|
| 1080p H.264 4:2:0 29.97 | 1920×1080 | 924×518 | 85 fps (CPU) | 33 fps | 2.77 GB |
| Sony 4K HEVC 4:2:2 10-bit 59.94 (soccer) | 3840×2160 | 924×518 | 87 fps (CPU) | 33 fps | 2.77 GB |

Quality on both clips was excellent: clean subject silhouettes, correct ordering, even the goal net resolved.

What this changes in the plan:
- **Decode:** the original is decoded on the CPU (it runs at 85 fps, faster than inference), so there is no proxy route and no NVDEC.
- **VRAM:** no head mini-batching is needed, because 2.8 GB fits the budget. Keep the out-of-memory retry anyway.
- **Weights:** `depth-anything/Video-Depth-Anything-Small/video_depth_anything_vits.pth`.
  - 116,440,756 bytes.
  - SHA-256 `13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609`.
- **Vendored code:** upstream commit `4f5ae23172ba60fd7bc11ef671cca678842c7072`, in `scripts/vendor/video_depth_anything/` (Apache-2.0).
  - The DINOv2 `Attention.forward` uses `F.scaled_dot_product_attention`.
  - The extra Python packages are `einops` and `easydict`.

### API contract (shared by server and client)

`src/services/depth.ts` exports these types, which the server imports:

```ts
export const DEPTH_SEGMENT = 64;
export type DepthSegment = { n: number; first: number; count: number }; // first = source frame index of the segment's first frame
export type DepthRun = {
  key: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'; progress: number; error?: string;
  mediaId: string; first: number; frames: number;       // analysed source frames [first, first + frames)
  times: number[];                                      // presentation time (source seconds, zero-based like smartMask sourceTimes) of each analysed frame
  width: number; height: number;                        // analysis size (preview and master frames)
  lo: number; hi: number;                               // stored value v = clamp((disparity - lo) / (hi - lo), 0, 1)
  near: number; far: number;                            // stored values where distance 0 and 100 sit (first-window p99 and p1)
  segments: DepthSegment[];                             // with ?after=n only the new ones
  next: number;                                         // cursor for ?after
};
```

The routes and what they return:

| Route | Returns |
|---|---|
| `GET /api/depth/capabilities` | `{available, reason?, engine, device}` |
| `POST /api/depth` with `{projectId, clipId}` | the `DepthRun`; 200 when ready, 202 while running |
| `GET /api/depth/:key?projectId&after=n` | the `DepthRun` |
| `DELETE /api/depth/:key?projectId` | cancels the run |
| `GET /api/depth/:key/preview/:n.mp4?projectId` | one preview segment |

Preview segment encoding:
- Full-range gray in the Y plane: `yuvj420p` / `color_range pc`, with chroma at 128.
- Raw Y = round(v × 255).
- Frame i of segment n is source frame `first_of_segment + i`.

Synthetic engine for tests:
- `FRAME_LINE_DEPTH_ENGINE=synthetic` makes the worker produce depth from source luma using ffmpeg only.
- It needs no torch and no numpy, so browser tests run without the model.
