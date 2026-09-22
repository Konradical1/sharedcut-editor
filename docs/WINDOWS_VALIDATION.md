# Windows validation — September 22, 2026

Host: Dell G16, RTX 4070 Laptop (8 GB), driver 596.49, Node 24.14.0,
Python 3.13.12, native FFmpeg. GitHub main through `9303ace` was merged with
the four existing Windows commits. Work used the existing local Newspaper
project read-only and isolated temporary installations for editing tests.

## Results

| Check | Result |
| --- | --- |
| `npm run setup:windows` | Completed from beginning to end, including all worker setup, build and doctor |
| `npm run doctor` | Media, captions, optical flow, Smart Mask, stabilization, color and imports available |
| `npm test` | 228 passed, 0 failed, 0 skipped; `artifacts/windows-tests-verified.log` |
| `npm run build` | TypeScript and production build pass; existing bundle-size advisory remains |
| `npm run test:browser` | Signup, upload, editing, scrubbing, collaboration, offline recovery, roles, five viewport sizes, export/download and sign-in pass |
| `npm run test:captions` with CUDA required | Real large-v3 transcription, word timing, caption editing/regrouping, regeneration, overlap replacement and rendered export pass |
| Forced CPU captions | Tiny-model test correctly transcribed the test sentence with ordered word timestamps |
| `npm run test:optical-flow` | 48 frames; mean movement 4.00 px per frame; no stalled intermediate steps |
| Optical-flow integration tests | Freeze, 1% speed, reverse, direction changes, end holds, cache reuse, extensionless sources, audio export and cancellation pass |
| Optical-flow browser test | Authenticated decode, byte ranges, speed curves and playback across cache chunks pass; 0 dropped frames in the measured segment |
| `npm run test:masks` | Worker/domain/backend tests pass, including process-tree cancellation |
| `npm run test:masks:inference` | Real SAM model preview, GPU tracking, subject/background pixels, repairs, backward tracking and actual masked export pass |
| `npm run test:masks:browser` | Include/exclude strokes, frame-local paint, zoom coordinates, saved edits and actual analysis pass |
| `npm run test:stabilize` | All 12 checks pass; separate original-media stabilization export also passes |
| `npm run test:color` | GPU/reference agreement, real-footage color workspace and Sony original-media exports pass |
| Independent color reference | 5,120 camera samples; maximum float reference error 0.0000529; GPU/reference comparisons pass |
| Native ACES camera export | C0965/C0963 normal and frozen exports, audio, dimensions, duration and encoded-pixel comparisons pass |
| Dependency consistency | Captions, SAM, optical flow and stabilization Python environments pass `pip check`; npm reports zero audit vulnerabilities |

Caption logs explicitly report both transcription and alignment on CUDA. Tests
that require CUDA fail rather than silently taking the CPU fallback.

## Original camera footage

- Optical flow: C0965.MP4 at 3840 × 2160, 50% speed; produced 0.5 seconds at
  24 fps in 19.6 seconds. This is offline preparation, not real-time playback.
- Smart Mask: tracked six original 3840 × 2160 frames, isolated the selected
  person, and exported the cutout. Tracking plus the export/checks took 80.3
  seconds. The test did not modify the saved project.
- Chrome reported the actual RTX 4070 through Direct3D 11. Color interaction
  checks recorded roughly 79–91 updates/second with no scope/frame mismatch;
  original-source decoding reported 10-bit YUV. These are short test results,
  not a whole-project performance guarantee.

Bundled headless Chromium was too slow for the sustained color-scope stress
test on this Windows host. The test now prefers installed Chrome/Edge on
Windows; the hardware-browser test passed. Browser automation is included as
a development dependency so these checks can be repeated locally.

## Remaining product boundaries

These are not Windows-only exclusions:

- SAM produces tracked selections, not qualified fine-hair/source-motion-blur
  alpha. Selection export is enabled and clearly labeled; the unsupported
  fine-edge engine remains disabled.
- Masked export still requires constant-frame-rate footage. Optical-flow
  retiming combined with Smart Mask requires baking first; jointly warped
  RGB/alpha is not implemented.
- Browser optical-flow previews are 8-bit H.264 for reliable decoding. Final
  flow intermediates are 10-bit ProRes from losslessly staged 16-bit RGB.
- Existing mask artifacts bind to their source file's machine-local identity.
  Reanalyze after moving hosts; retain guidance/repairs and full data backups.
- Docker/WSL deployment and performance on the Lenovo were not tested here.
  The completed installation is native Windows on this Dell.
- Import tools are installed and their offline integration tests pass; live
  YouTube/Spotify availability still depends on those services.

Detailed logs and screenshots are retained under `artifacts/windows*`,
`artifacts/qa`, `artifacts/captions-qa`, and `artifacts/optical-flow`.
The local server is at http://localhost:4310. It was started as a hidden Node
process; use `npm start` after a reboot. No login startup task or public tunnel
was installed, and no Mac data was overwritten or fetched.
