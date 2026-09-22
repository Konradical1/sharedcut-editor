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
| Stabilization | OpenCV + SciPy | Analysis, cached previews and original-media export |
| Color | OpenColorIO 2.5.2 | Existing reference color pipeline and masked export |
| Link imports | yt-dlp + spotDL | Installed locally; provider/network availability still applies |

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

`npm run doctor` checks each local worker. Individual installers are
`setup:captions`, `setup:flow`, `setup:masks`, `setup:stabilize`, `setup:color`, and
`setup:imports`. Each has a FRAME_LINE_*_PYTHON override; optical flow uses
FRAME_LINE_FLOW_PYTHON. FRAME_LINE_CAPTION_DEVICE accepts auto (default), cpu,
or cuda (GPU required, useful for tests). The default caption model is large-v3;
FRAME_LINE_WHISPER_MODEL can select another faster-whisper model.

## Verification

```powershell
npm run doctor
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:captions
npm run test:optical-flow
npm run test:optical-flow:browser
npm run test:masks
npm run test:masks:inference
npm run test:masks:browser
npm run test:stabilize
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
