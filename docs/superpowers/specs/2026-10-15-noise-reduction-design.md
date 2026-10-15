# Noise Reduction — design (2026-10-15)

Konrad asked for "a REALLY good denoise effect, nice and very high end". Decisions made with him:

- Footage: all of it (low-light sports, interviews, log shadows), so defaults suit mixed material.
- Engine: Resolve-style, motion-compensated temporal + spatial NR with automatic noise profiling, on the GPU
  (torch in `.venv-mask`: CUDA on the Lenovo, MPS or CPU on the Mac). No model downloads.
- Preview: the real result. The server denoises source-time chunks; the viewer plays them in place of the proxy,
  with the grade applied live on top, as optical-flow preview chunks do.
- Controls: in the Inspector Effects tab and in a Noise Reduction panel on the Color page, both editing one effect.

## What the user gets

- **Noise Reduction** is picture only. Audio moves to a new **Audio Noise Reduction** effect (the old effect was
  kind `both`; FCP's "Noise Reduction" is a video effect, so the two FCP-imported clips in production stay picture NR
  and their audio is no longer touched by accident).
- It runs on the camera original **before the grade**, whatever its place in the effect stack, as Stabilize does.
  Re-grading never re-denoises. Stabilize, Smart Mask, Depth and optical-flow retiming all consume the clean frames.
- It measures each source's noise automatically (a noise-vs-brightness curve per channel), so a setting means
  "this much of *this camera's* noise", the same on C-Log 3, S-Log3 and an iPhone.
- Controls (effect parameters):

  | key | label | range | initial | meaning |
  |---|---|---|---|---|
  | `amount` | Strength | 0–100 % | 50 | How much of the measured noise to remove. 50 removes the measured noise; 100 is aggressive. 0 is a bypass. |
  | `chroma` | Chroma | 0–100 % | 60 | Colour-noise strength, separate because chroma blotches can go much harder without losing detail. |
  | `frames` | Frames | 0–3, step 1 | 2 | Temporal neighbours each side (window 1, 3, 5, 7). 0 is spatial only. |
  | `spatial` | Spatial | 0–100 % | 50 | Spatial cleanup of what temporal could not average (motion, occlusion, frame edges). |
  | `detail` | Detail | 0–100 % | 30 | Gives back real fine texture so faces and grass do not go plastic. |

- **Show removed noise**: a per-effect view toggle (UI state, not saved) that shows `original − denoised`, amplified
  around mid-grey, drawn ungraded, for tuning.
- Status in the Inspector/Color panel and the viewer: "Measuring noise", "Denoising · 40 %", "ready", or the error.
- Paste Grade carries the source clip's Noise Reduction effect (replacing the target's). Next/Previous edit work as usual.

## Engine (`scripts/denoise.py`)

All maths happens in the source's own Y′CbCr planes at native chroma subsampling, as float on the device. FFmpeg
decodes to `yuv4XXp16le` and encodes from it. Nothing here converts colour: the bake is the original, cleaner.

### Noise profile

Per source file and processing size (preview size or full size), measured once and cached as JSON.

- Sample 12 consecutive frame pairs spread over the whole source.
- Align frame t+1 to t (the flow below), take `d = I_t − warp(I_t+1)` per plane.
- Keep pixels whose forward-backward flow agrees (< 0.5 px), that are flat (gradient below the frame's 40th
  percentile) and unclipped (luma within [2 %, 98 %]).
- Bin by local mean luma (5×5) into 16 bins; per bin `σ = 1.4826 · MAD(d) / √2`, median across pairs.
- Bins with too few samples interpolate from neighbours; then 1-2-1 smoothing and a floor of ¼ of a 10-bit code.
- Fallback for stills, sub-3-frame sources or too few aligned samples: the finest Haar HH band's MAD over the
  flattest 10 % of 8×8 blocks, same bins.
- Also record `σ_box`, the std of the 5×5 box-averaged difference, per bin: the ratio `ρ = σ_box·5 / σ` says how
  spatially correlated the noise is (1 for white noise, larger after demosaicing and compression). It widens the
  patch-distance tolerance below, which keeps compressed footage from being under-denoised.

### Temporal stage (Frames ≥ 1)

- Flow: OpenCV DIS (preset FAST, variational refinement on) on luma pre-smoothed with a σ=1 Gaussian and downscaled
  to at most 960 px wide. Per consecutive pair compute forward and backward flow once (kept in a ring); distances
  2..R are composed: `f(t→t+k) = f(t→t+k−1) + warp(f(t+k−1→t+k), f(t→t+k−1))`. Run on CPU threads concurrently
  with the GPU work. Upscale vectors to each plane's size.
- Warp each neighbour to t with `grid_sample` (bicubic luma, bilinear chroma). Out-of-frame samples get weight 0.
- Occlusion: forward-backward residual `> 0.5 + 0.05·|f|` px gives weight 0.
- Luma patch distance `D = box5((Y_t − Ŷ_k)²) / (2σ_Y(Ȳ)²)` with `Ȳ` the local mean luma and σ read from the
  profile per pixel (linear interpolation between bins). Under pure noise `D ≈ 1`.
- Weight `w_k = exp(−max(0, D − 1 − τ) / λ_t)` where `τ` grows with ρ and `λ_t` grows with Strength.
- Chroma weights also require chroma agreement, so colour never ghosts:
  `w^C_k = w_k · exp(−max(0, D^C − 1 − τ) / λ_c)` with `λ_c` from Chroma.
- Result `Y_T = (Y_t + Σ w_k Ŷ_k) / (1 + Σ w_k)`, and the per-pixel residual noise
  `σ_res = σ · √(1 + Σ w_k²) / (1 + Σ w_k)` that drives the spatial stage.

### Spatial stage

- Luma: non-local means over a 9×9 search, 3×3 patches, weights computed on `Y_T` (cleaner patches), filtering
  `h = σ_res · k_s` from Spatial and Strength. Strong where temporal could not average (moving players, occlusions,
  frame edges), light where it already did.
- Chroma: luma-guided joint NLM (distance over Y, Cb, Cr) at the chroma plane's size, then again at half that size
  for low-frequency blotches; the low band is replaced, the high band is kept in proportion to (1 − Chroma).

### Detail and output

- Removed component `r = Y_in − Y_out`. Real detail is the part of `r` beyond the noise:
  `Y_out += detail · (sign(r) · max(0, |r| − 2σ) + 0.15 · r)`; the small second term keeps a natural texture.
- Strength `s`: thresholds scale with `s/50`; the final mix is `min(1, s/20)` so 0–20 fades in.
- TPDF dither at one output LSB before the 16-bit write, so the 10-bit encode never bands a smooth sky.
- View "Show removed noise": `0.5 + 4·(in − out)` in each plane.

The constants above are starting points. They are tuned on real footage (VB2 gym volleyball and BLINK Canon C-Log 3
4K60, Newspaper Sony S-Log3, an iPhone 1080p VFR clip) and on a synthetic moving test with known noise.

### Performance targets (Lenovo, RTX 5060 Ti 8 GB)

- Export bake 4K60 Canon 4:2:2 10-bit with Frames 2: at least 8 fps.
- Preview chunk at 1920 wide: at least 30 fps, so a chunk is ready in about two seconds.
- Peak VRAM at 4K under 3 GB, released after each job (`torch.cuda.empty_cache()`); every job runs under `gpuJob`.

## Worker protocol (`scripts/denoise.py`)

Modes: `--check` (one JSON line: `{available, engine:'denoise', device, reason?, workerIdentity:{torch, opencv, device,
source}}`), `--selftest` (synthetic checks, exit 0/1), `<job.json>` (one job, progress `{"progress":n}` lines on
**stdout** for `runWorkerProcess`; last stdout line is the result JSON), `--serve` (resident: emits `{ready:true,
device}`, then reads stdin lines `{id, job}` or `{id, cancel:true}`; answers `{id, progress}` …, then `{id, ok:true,
result}` or `{id, error}`; exits on stdin EOF). Errors go to stderr as `Noise Reduction: <message>`, exit 1.

Job (the same for preview chunks and export bakes):

```json
{
  "ffmpeg": "/abs/ffmpeg",
  "input": "/abs/original",
  "inputArgs": ["-hwaccel", "cuda"],
  "fps": "60000/1001",
  "first": 120, "frames": 120,
  "duration": 18.35,
  "width": 1920, "height": 1080,
  "pixfmt": "yuv422p16le",
  "colors": { "range": "pc", "matrix": "bt709", "primaries": "bt709", "transfer": "unknown" },
  "settings": { "amount": 50, "chroma": 60, "frames": 2, "spatial": 50, "detail": 30 },
  "view": "denoised",
  "profile": "/abs/data/denoise/profiles/<sha>.json",
  "encode": ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "...tags", "-y", "/abs/out.tmp.mov"],
  "threads": 8
}
```

- Output frame `k` (0 ≤ k < frames) is source frame `first + k` on the constant-rate grid at `fps`: the source frame
  nearest `(first + k) / fps`, a tie to the earlier one (decode as `scripts/stabilize.py` does: seek, `-r fps
  -fps_mode cfr`, VFR iPhone footage included). Up to `settings.frames` frames before and after are decoded as
  temporal context when the source has them.
- Decode: `ffmpeg -v error -nostdin <inputArgs> -ss … -i input -an -sn -dn -vf scale=W:H(only when smaller),format=<pixfmt>
  -r fps -fps_mode cfr -f rawvideo -`. No colour conversion: native Y′CbCr is resized, nothing else.
  If the hardware decoder fails on a file, retry in software (as `stabilize.py` `hardware_decode_args` does).
- Encode: `ffmpeg -v error -nostdin -f rawvideo -pix_fmt <pixfmt> -s WxH -r fps -color_range … -colorspace …
  -color_primaries … -color_trc … -i - <encode>`. The server owns codec choice; the worker only feeds frames.
- `profile`: read when the file exists; otherwise measured at this job's size from the whole source and written
  atomically. Progress reports stage `{"progress":n,"stage":"profile"|"denoise"}`.
- Result: `{frames, fps, profile:{sigmaY: number (σ at mid grey in 10-bit codes), device, seconds, peakVram?}}`.
- Fewer frames than asked at the end of the source is not an error: the result says how many were written.

## Shared module (`src/services/denoise.ts`)

Pinned before the build; server and client both import it. `denoiseEffect(clip)`, `denoiseSettings(clip, effect)`,
`denoiseKeys`, `DenoiseSettings`, `DenoiseView`, `DenoisePreview`, `denoiseChunkSeconds` (2 s of **source**),
`denoiseFrameAt(sourceTime, fps)`, `denoiseChunkOf(sourceTime, fps)`, `denoiseChunkFrames(chunk, fps, duration)`.
Chunks are source-time, so moving, trimming or retiming a clip keeps every chunk it already has.

## Server (`server/denoise.ts`, routes, export)

- `denoisePython() = FRAME_LINE_DENOISE_PYTHON || venvPython('.venv-mask')`. `denoiseCapabilities()` copies
  `depthCapabilities` (30 s / 600 s cache). `npm run setup:denoise` = `setup-venv.mjs .venv-mask
  scripts/mask-requirements.txt scripts/denoise.py --check`; `npm run test:denoise` runs `--selftest` and the node
  tests. Add it to `scripts/setup-windows.mjs` and `scripts/doctor.mjs`. Host guard: `JOB_COST_BYTES.denoise` (3 GiB)
  and `WORKER_COST_BYTES['Noise Reduction']`.
- Data: `join(dataDir, 'denoise')` with `profiles/`, `chunks/` (preview, `<sha>.mp4`, trimmed LRU to
  `FRAME_LINE_DENOISE_PREVIEW_GB`, default 4) and `exports/` (bakes, `<sha>.mov`, LRU to `FRAME_LINE_DENOISE_BAKES_GB`,
  default 60, with in-use claims like `stabilizeBakesInUse`). Leftover temp files older than an hour are removed.
- Identities: sha of `['denoise-…-v1', workerIdentity, inputIdentity(original) (path, size, mtime), size, settings,
  view, first, frames, recipe]`. The profile key leaves out settings, view and range.
- **Preview**: one resident `--serve` worker. Each chunk is sent inside `gpuJob(() => heavyJob(send, signal), signal)`.
  The worker exits after 10 minutes idle and is killed by `stopIdle()` (wired into `depth.freeGpu` alongside
  `masks.stopIdlePreview()`). Spawn it with `trackChild`, and stop it in the shutdown list.
  - Size and encode per viewer quality equal the proxy that quality would play: Full/Color/Original → the
    `full-v3` recipe and size; Stream/½ → `stream-v2`; ¼ → `stream-low-v2`. Export the recipe and conversion
    builders from `encodePreviews` (media.ts ~400) instead of copying them. The worker denoises native Y′CbCr at that
    size, and the encode applies that recipe's conversion, so the browser grade sees exactly what it sees on the proxy.
  - Routes, next to the optical-flow routes:
    - `GET /api/denoise/capabilities`
    - `POST /api/denoise`, body `{clipId, chunk, quality, view, settings}`, returns `DenoisePreview`. The response is
      a cache hit (`ready`), or `preparing` with `stage` and `progress`.
    - `/^\/api\/denoise\/([a-f0-9]{64})(?:\/files\/video\.mp4)?$/`: GET/HEAD streams the chunk with
      `streamFile(..., true)`; DELETE aborts. The URL has `/files/` and ends `.mp4`, so playback's WebCodecs path and
      its bt709 rule apply.
  - A newer `generation` per clip aborts that clip's stale jobs. A cap of 8 preparing jobs returns 429. The chunk
    under the playhead is asked for first, and the client asks one chunk ahead.
- **Export** `renderDenoisedTimeline(request)`. It is dispatched in `renderTimeline` right after compositions and
  before Stabilize, gated `!request.sampledFrame`. It mirrors `renderStabilizedTimeline`:
  - Clips outside the range lose the effect.
  - `span → geo → range = stabilizeRange(geo, sourceFps, duration)`.
  - One-shot worker job via `runWorkerProcess(…, 'Noise Reduction')` inside `gpuJob(() => heavyJob(…))`, after
    `request.depth?.freeGpu?.()`. Full source size, `first = denoiseFrameAt(range.from)`.
  - ProRes 422 HQ `yuv422p10le` (or ProRes 4444 `yuv444p10le` for a 4:4:4 source), the source's own
    range/matrix/primaries/transfer tags. Never force tv range.
  - The replacement asset is `{...source.asset, id:'denoise-'+clip.id, duration, fps, hasAudio:false}`: same colour
    metadata, so grade, LUT, Smart Mask, Stabilize, Depth and flow treat it as the original. The clip gets
    `sourceIn - first/fps`, loses the effect, and gets `audioDetached:true`. Its sound plays from the original
    through a `denoise-audio-<id>` carrier with `audioEffectNames` filtering.
  - Smart Mask documents are resolved against the original before the swap and handed down in `maskArtifacts` with
    the bake's offset, as Stabilize does. Stabilize's own resolve must prefer `request.maskArtifacts`.
  - `request.denoised: Map<clipId, {clip, source, offset}>` lets Stabilize analyse the original (its cache stays
    valid and preview equals export) and lets Depth find the original analysis.
  - Refuse with a clear message:
    - the worker is not installed ("Noise Reduction needs the denoise worker on this server. Run npm run setup:denoise.");
    - an alpha source;
    - keyframed Noise Reduction parameters;
    - not enough disk space (`depthDiskFloor` check).
  - Progress: bakes 0–45, then the recursive render at 45 + 0.55p.
- Timeline preview cache and stills: a Noise Reduction clip counts as a live bake (`bakesWholeClips`, `stillLive`)
  with its own reason text, because the editor plays the denoised chunks itself. Update `mcp/frame.ts`.
- The old `hqdn3d` line in `videoFilters` becomes a no-op comment, like Stabilize and Depth.

## Audio split

- `'Audio Noise Reduction'`: `kind:'audio'` with parameters Reduction/Sensitivity/Smoothing. Its behaviour is
  unchanged: an `afftdn` export and the preview noise gate.
- Export `audioEffectNames` (the names of every `kind:'audio'` effect) from `effects.ts` and use it at every site that
  hard-codes `['EQ','Compressor','Limiter','Noise Reduction']`: media.ts (5 places), server/captions.ts,
  src/services/captions.ts, AudioWorkspace.tsx.
- `audioFilters`' ignore list gains `'Noise Reduction'` and `'Stabilize'`. `videoFilters`' ignore list and
  `fitFirst` gain `'Audio Noise Reduction'`.
- `detailPixels` drops Noise Reduction. Drop the `'both'` kind. `mcp/jobs/assets.ts` `audioEffects` filters
  `kind === 'audio'`. The FCP mapping stays picture NR.
- `acceptsEffect('Noise Reduction')`: video clips only, not titles/shapes/adjustments/compositions/captions, and one
  per clip.

## Client

- `src/services/denoisePreview.ts`: `createDenoisePreview(changed)` is modelled on `createFlowPreview`, with
  `get(clip, sourceTime, fps, quality, view)`, `retain`, `dispose`, the same debounce/poll/cancel and a 32-entry cap.
  It also prefetches the next chunk. `noiseUi` (`showRemoved(effectId)`, `setShowRemoved`, `subscribe`, `version`),
  copied from `depthUi`. A small status store (`denoiseStatus(clipId)`, `subscribeDenoise`) feeds the panels even
  when the viewer is elsewhere.
- `playback.ts`: for a clip with `denoiseEffect` whose asset is video, ask for the chunk at its source time.
  - When the chunk is ready, decode through the normal `decoderFor`/`buffered` path with a synthetic asset (the
    `flowDecoder` trick: `colorProxyUrl/proxyUrl/sourceUrl = chunk url`, `proxyVariants:{}`, chunk duration/fps). The
    source time maps to `sourceTime - chunk.from`, so speed, reverse, freeze, WebCodecs, Stabilize warp, masks, Depth
    and the colour pipeline all keep working.
  - Until the chunk is ready, show the normal proxy and a status: "Noise Reduction · Measuring noise",
    "· Denoising 40%", "· Ready", or the error. Dispatch `frameline:denoise` and add it to `clipStatus.ts`.
  - Optical flow on the same clip: flow chunks win in preview (status says so), and export chains both.
  - "Show removed noise" requests `view:'noise'` and draws that layer with the grade bypassed.
  - Remove the old `detailPixels` picture NR path; rename the audio gate to `'Audio Noise Reduction'`.
- `src/components/NoiseReductionInspector.tsx` `({clip, effect})`:
  - the five parameters as `<Property clipId effectId animatable={false}/>`;
  - the "Show removed noise" checkbox ("viewer only");
  - the status line with capability reason and Retry.
  - It is used by `Inspector.tsx` (replacing the stale note) and by a Noise Reduction section on the Color page, next
    to "Source & workflow" (pre-grade). The Color page section offers "Add Noise Reduction" when the clip has none.
    That calls `addEffect` without jumping to the Inspector (an optional `reveal=false` argument).
- `pasteGrade` replaces the target's Noise Reduction with a copy (new id) of the source clip's, keyframes excluded.
  `mcp/jobs/color.ts` doc updated.

## MCP

- `mcp/jobs/denoise.ts` `{ denoise }`, registered in `mcp/jobs.ts`:
  - `{clip, off?, amount?, chroma?, frames?, spatial?, detail?}`;
  - checks `/denoise/capabilities`, then adds or updates the effect through `edit(run => run('addEffect'|'updateEffect'))`;
  - returns compact text plus the engine device.
- A `help denoise` topic. Test copied from `mcp/jobs/motion.test.ts`.
- `ROUTES` in `mcp/coverage.test.ts`:
  - `/api/denoise/capabilities` → `job:denoise`;
  - `/api/denoise` and the chunk regex → `no: preview chunks only feed browser playback; export bakes from the original`.

## Verification

- `--selftest`: a synthetic moving scene with known Gaussian + correlated noise. Temporal+spatial beats spatial
  alone and beats FFmpeg `hqdn3d` and `nlmeans` on PSNR. There is no ghosting on a moving edge, and the profile
  recovers the injected σ within 15 %.
- Real footage (the four sample clips) is judged by eye on graded 1:1 crops (a log→709-ish lift so the noise shows),
  before and after.
- Lenovo: fps and VRAM at 4K and 1080.
- `npm test`, `npm run build`, a browser test that the viewer swaps in a chunk, and an end-to-end export on a
  throwaway server.
