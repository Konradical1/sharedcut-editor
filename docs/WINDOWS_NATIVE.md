# Native Windows setup

SharedCut runs directly on Windows. Docker, WSL, Xcode, Visual Studio build tools,
and administrator access are not required to run the installed application.
The Dell G16 with an RTX 4070 is the tested host; the Lenovo is the eventual target.

## Install or move to another Windows PC

Install Git, Node.js 22.18 or newer, Python 3.12 or 3.13, and a full FFmpeg build
including ffprobe. NVIDIA acceleration also needs a compatible installed NVIDIA
driver. This Dell uses driver 596.49. Installing system drivers can require an
administrator; SharedCut's setup does not install or change drivers.

From the checkout in PowerShell:

```powershell
git pull origin main
npm ci
npm run setup:windows
npm start
```

Open http://localhost:4310. The server reads `.env` if present, including the
existing signup code and data-directory configuration. It listens on loopback
unless HOST is explicitly configured. Keep the process running while editing.
For a later update, run `npm ci`, the setup commands for changed dependencies,
and `npm run build`, then restart the server.

Setup downloads several GB of local models and GPU libraries. Python environments
are machine-specific: recreate them on the Lenovo instead of copying them from
this PC or the Mac. Set FRAME_LINE_SETUP_PYTHON to an installed interpreter path
if the Python launcher cannot find it. FFmpeg and ffprobe can be selected with
FFMPEG_PATH and FFPROBE_PATH.

## Installed features

| Feature | Windows engine | Behavior |
| --- | --- | --- |
| Captions | faster-whisper large-v3 + WhisperX | NVIDIA transcription and word timing; CPU fallback when a GPU is unavailable |
| Optical flow | OpenCV bidirectional dense motion estimation | Exact requested timestamps, freezes, reverse, direction changes, 1% speed; native 16-bit processing and 10-bit export |
| Smart Mask | SAM 2.1 Large on NVIDIA | Interactive preview, forward/backward tracking, local repairs, clip and color-node masks, tracked-selection export |
| Depth | Video Depth Anything Small (Apache-2.0) on NVIDIA, in `.venv-mask` | Depth maps per source range, streamed in 64-frame segments while analysis runs; about 25 frames a second on the Dell's 4070 Laptop at 2.7 GB of VRAM |
| Stabilization | OpenCV + SciPy | Analysis, cached previews and original-media export |
| Motion tracking | OpenCV pattern tracker (feature box + search box) | Tracks points on the original frames, forward/backward/one frame at a time; attaches layers or makes the camera follow as keyframes |
| Color | OpenColorIO 2.5.2 | Existing reference color pipeline and masked export |
| Link imports | yt-dlp + spotDL | Installed locally; provider/network availability still applies |
| Export | FFmpeg; NVENC and NVDEC when present | Renders in parallel parts, then joins them losslessly; CPU encoders when no NVIDIA GPU is found |

Exports split the timeline into parts that each decode only the clips on screen in
their own range, render up to four at once, mix the sound over the whole range in
one pass, and join the parts without re-encoding. One graph holding every clip used
to open every 4K decoder at once (32 GB on this 32 GB PC) and overflowed Windows'
32,767-character command line (`spawn ENAMETOOLONG`). H.264 and H.265 encode on
NVENC when a probe encode succeeds; `FRAME_LINE_HWENC=off` keeps them on libx264
and libx265. `FRAME_LINE_EXPORT_JOBS` overrides how many parts run at once. The
RTX 4070 cannot decode 4:2:2 footage, so Sony 4:2:2 decodes on the CPU here; the
Lenovo's Blackwell GPU decodes it. Optical flow bakes at the project's canvas size
and is reused when the same export runs again before the server restarts.

Preview files stay on libx264 (NVENC spends about twice the bits for the same
quality, and previews are what fill the disk). Storage v3 keeps three per video:
`full-v3.mp4`, `stream-v2.mp4` and `stream-low-v2.mp4`. The first start of a v3
build migrates older imports one at a time in the background and deletes the
files they replace; the log shows `Media storage v3:` lines with the space freed.
An asset is skipped (and retried at the next start) while free space is under
its estimated output plus the 5 GB disk reserve (`FRAME_LINE_MIN_FREE_GB`). Rolling back to an older build after that makes
migrated clips 404, so roll forward instead.

Optical flow runs on the CPU and uses bounded motion-estimation resolution; it
does not require NVIDIA hardware. It is an offline preparation step, not a
promise of real-time 4K rendering. Its H.264 previews use the browser-supported
8-bit 4:2:0 format; export intermediates retain 10-bit precision. Source frames
are staged losslessly and temporary disk capacity is checked before decoding.

Smart Mask's tracked selection is exportable, but SAM segmentation does not
recover fine hair or original motion-blur transparency. Those controls stay
unavailable. This is the same model-quality boundary on every OS. Irregular
frame-rate masked exports and combining masks with optical-flow retiming still
have the existing explicit restrictions; convert to constant frame rate or
bake the mask first. No restricted matting model was enabled.

Motion tracking reads the original footage (decoded at up to 1920 wide for speed,
full resolution when the feature box is small) and needs no GPU: pattern matching is
cheap and decoding is the cost, so NVDEC is used when it can decode the file. On this
Dell a 4K 10-bit 4:2:2 HEVC shot tracks at about 20–40 frames a second. Tracks are
content-addressed sample files in `data/motion-trackers/` and travel with project bundles.

`npm run doctor` checks each local worker. Individual installers are
`setup:captions`, `setup:flow`, `setup:masks`, `setup:depth`, `setup:denoise`, `setup:stabilize`, `setup:tracker`,
`setup:color`, and `setup:imports`. Blackmagic RAW is `npm run setup:braw` from a Visual Studio developer prompt, after installing Blackmagic RAW (README, Blackmagic RAW). Each has a FRAME_LINE_*_PYTHON override; optical flow uses
FRAME_LINE_FLOW_PYTHON. FRAME_LINE_CAPTION_DEVICE accepts auto (default), cpu,
or cuda (GPU required, useful for tests). The default caption model is large-v3;
FRAME_LINE_WHISPER_MODEL can select another faster-whisper model.

## Depth

`npm run setup:depth` installs the depth model into `.venv-mask` (CUDA torch from `setup:masks`) and verifies its
weights under `artifacts\depth`. Analysis and export bakes run on the GPU; a CUDA run or bake first frees an idle Smart
Mask preview worker, and a bake retries once on out-of-memory. Variables: `FRAME_LINE_DEPTH_PYTHON`,
`FRAME_LINE_DEPTH_WEIGHTS`, `FRAME_LINE_DEPTH_DEVICE`, `FRAME_LINE_DEPTH_PRECISION`, `FRAME_LINE_DEPTH_CACHE_GB` (3),
`FRAME_LINE_DEPTH_MIN_FREE_GB` (2, never under the 5 GB reserve), `FRAME_LINE_DEPTH_TAPS` and
`FRAME_LINE_DEPTH_ENGINE=synthetic` for tests. Routes are under `/api/depth` (see the README). Export needs
constant-frame-rate sources up to 4096 wide and refuses optical flow; a depth key also refuses Stabilize.
A build without Depth refuses every save once a Depth subject or depth key exists (backups included), so roll forward,
never back past Depth.
Depth-assisted Smart Mask cleanup (cut SAM leaks at depth jumps, fill holes at the subject's depth) was tried on the soccer and hurdles clips and rejected: at every threshold it cut off hands, feet and arms, while leaks onto players at the same distance stayed and hole filling made them solid.

## Noise Reduction

`npm run setup:denoise` installs the denoise worker into `.venv-mask` (CUDA torch from `setup:masks`). Preview chunks come
from one resident GPU worker and export bakes from one-shot runs; a CUDA bake first frees idle Smart Mask and Noise
Reduction preview workers. Variables: `FRAME_LINE_DENOISE_PYTHON`, `FRAME_LINE_DENOISE_WORKER`,
`FRAME_LINE_DENOISE_DEVICE`, `FRAME_LINE_DENOISE_TRITON=0` (no Triton kernels), `FRAME_LINE_DENOISE_BAKES_GB` (60, export
bakes under `data\denoise\exports`) and `FRAME_LINE_DENOISE_PREVIEW_GB` (4, preview chunks). A bake short of disk frees old
bakes first and never takes the disk below the 5 GB reserve. A build without Audio Noise Reduction refuses any export that
has one, so roll forward, never back past it.

## Host guard and playback health

One laptop can be the server and somebody's workstation. The host guard (`server/hostGuard.ts`) keeps SharedCut's own jobs
from using up its memory, and two plain-text trails say what happened. Nothing here needs a database, so a damaged file
cannot stop the server from booting.

**Mode switch, no restart.** `data\host-guard.mode` holds one word, `off`, `observe` or `enforce`, and is re-read about once a
second. Either file encoding works: plain UTF-8 (with or without a byte-order mark) and the UTF-16 that Windows PowerShell 5
writes for `echo enforce > data\host-guard.mode`. A file that holds some other word is ignored (one line in the server log
says so) and the mode stays what `FRAME_LINE_HOST_GUARD` says. Without the file, `FRAME_LINE_HOST_GUARD` decides, and the
default is `observe`. Switch with `Set-Content -NoNewline data\host-guard.mode enforce`, back with `observe`.

- `observe` (default) changes nothing. It admits every job at once and logs what `enforce` would have done: jobs that
  would have waited or been refused, export passes that would have been fewer, and under memory pressure `observe: would
  have stopped N preview job(s) at X GiB usable`. Nothing is stopped and no export shows "Low memory".
- `enforce` holds heavy starts while memory is short and runs the pressure response (below).
- `off` does nothing and reads no memory figures; in particular it never starts PowerShell for the commit-headroom reading.

**Switch to `enforce` only after reading `data\host-health.log`.** The thresholds are not calibrated for blocking yet. On
this Dell the commit-headroom reading (`commitHeadroomGB`) swings between about 1 and 10 GiB while 10 to 12 GiB of RAM is free
(`freeGB`), and the guard uses the smaller of the two, so at those readings `enforce` would hold exports and refuse previews
on a healthy machine. On macOS the free-memory reading is too low (cached pages are not counted), so stay in `observe`
there. Enforce is worth turning on once `commitHeadroomGB` stays comfortably above the 6 GiB preview reserve at class load.

**What `enforce` does.**
- Heavy starts ask first: each render pass encode, each media-preparation encode, and the Python workers (Depth, optical
  flow, Stabilize, motion tracker, Smart Mask). A job starts only if the smaller of available memory and Windows commit
  headroom, minus memory promised to jobs started in the last 20 s, minus its own cost, stays above its reserve (4 GiB; 6 for a
  preview) and never below a hard 3 GiB floor. Small jobs may start past a waiting big one, until the big one has waited 30 s.
- A waiting render shows "Waiting for memory" as its stage. A job that is not an export fails with a retry message after
  10 minutes; an export keeps waiting.
- ffprobe, `-version`, `--check` probes and stream copies are never held, so `/api/health` and the tunnel watchdog never wait.
- A split export uses fewer parallel passes when memory is short (never more than before, and never more threads per pass).
- A timeline preview is never queued for memory: it is refused with HTTP 429 and the browser backs off.
- Pressure response, `enforce` only: if memory stays under 2 GiB for 5 s, running previews are stopped first, then
  filmstrip and waveform jobs (20 s apart). Exports, AI jobs and uploads are never stopped; they only show "Low memory".

Only the 1.9 GiB of a 4K render pass is measured; the other costs are estimates in `JOB_COST_BYTES`. In `observe` mode the
server log shows `Host guard: ... would have waited` lines and, 20 s after each start, `cost check` lines with the real drop,
so the table can be corrected before `enforce`.

**The decoder thread cap is not part of the guard.** A video decoder gets at most `FRAME_LINE_DECODE_THREADS` threads (8) in
every render and every mode, `off` included. It is read when the server starts, so changing it needs a restart. Its effect on
export time has not been measured.

**Trails.** `data\host-health.log` gets one JSON line every 30 s (available memory, commit headroom, pages per second,
battery, GPU memory and temperature, event-loop lag, queue sizes, live ffmpeg and Python children) and rotates at 5 MB to
`host-health.log.1`, so a hard reset leaves its last minutes. `data\playback-reports\YYYY-MM-DD.jsonl` holds one row per
browser and minute of the numbers browsers send inside their presence posts (pictures per second, loading share, longest
freeze, link speed; no clip or project names), kept 14 days. A browser is taken at most once every 5 s.

**Health page.** `GET /api/health/report` returns the browsers and the host, but only for the account ids listed in
`FRAME_LINE_HEALTH_USERS` (comma separated, in `.env`; it is read when the server starts). Anyone else gets the same
"API endpoint not found." as a route that does not exist. The page diagnoses each browser in a plain sentence (smooth, or
whose side is slow: the computer, the connection or the server) and shows the guard's mode ("Watching only", "Enforcing" or "Off"). `/api/health` itself now spawns
nothing per call: the ffmpeg and ffprobe version check is cached for 60 s.

| Variable | Default / purpose |
| --- | --- |
| `FRAME_LINE_HOST_GUARD` | `observe`; `off`, `observe` or `enforce` when `data\host-guard.mode` is absent |
| `FRAME_LINE_HEALTH_USERS` | Unset (nobody); account ids that may open the Health page |
| `FRAME_LINE_DECODE_THREADS` | `8`; most threads one video decoder may take in a render |
| `FRAME_LINE_POWERSHELL` / `FRAME_LINE_NVIDIA_SMI` | `powershell.exe` / `nvidia-smi`; used only for the commit-headroom, paging, battery and GPU readings |

Lock counters now start at the server's start time and every state answer carries `serverStartedAt`, so open tabs keep seeing
collaborators' locks after a restart. Rolling back is a revert and a restart: the new files are plain text that older builds
ignore, and no workspace table was added. One catch: an older build counts locks from 0 again, so after a rollback ask everyone
with an open tab to reload it; until they do, those tabs ignore every lock update.

## Verification

```powershell
npm run doctor
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:captions
npm run test:optical-flow
npm run test:depth
npm run test:depth:browser
npm run test:depth:parity
npm run test:depth:inference
npm run test:optical-flow:browser
npm run test:masks
npm run test:masks:inference
npm run test:masks:browser
npm run test:stabilize
npm run test:tracker
npm run test:tracker:browser
```

The inference check uses the real installed SAM model and checks subject pixels,
background removal, backward propagation, repair revisions, and a real export.
On Windows, color-performance checks prefer installed Chrome/Edge so they use
the actual GPU; set PLAYWRIGHT_EXECUTABLE_PATH to override this.
Browser checks use isolated temporary accounts/projects and do not edit the
working database. Their logs/screenshots are under `artifacts/` on this Dell.

## Move projects

Git does not contain footage, accounts, projects, masks, or models. Stop the
source and destination servers before transferring project bundles:

```powershell
node scripts/project-bundle.mjs export "Project name" "D:\Transfer\project-bundle"
node scripts/project-bundle.mjs import "D:\Transfer\project-bundle"
```

Start a fresh destination server, create the destination account, and stop it
before import. Keep a separate backup of the complete source data directory.
For a full-installation migration, copy the entire stopped data directory,
including SQLite, media, renders and smart-masks, then point FRAME_LINE_DATA at
it. Do not overwrite a destination that already contains other work. Generated
flow/model caches can be rebuilt. Mask revisions currently bind to the original
file location and filesystem identity: reanalyze them after moving hosts.
Project bundles carry mask guidance/repairs in the edit, but do not copy the
analyzed mask artifacts; a full data-directory backup preserves those files. This task prepares the Windows host; it
does not transfer projects from a Mac that is not connected here.
