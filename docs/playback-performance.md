# Newspaper playback measurements

September 11, 2026 · Chrome 152 · Apple M5 Pro / ANGLE Metal · 1512 × 982 viewport.

The original C0961 recording is 3840 × 2160, 10-bit H.264 4:2:2, 24000/1001 fps, approximately 96.7 Mb/s. Its existing 1920-pixel proxy is approximately 47.9 Mb/s; the new 480 × 270 proxy is approximately 2.4 Mb/s. Originals and original-media exports are retained.

## What caused the stalls

- A new seek could begin before its first color snapshot was available. Repeated scrubbing kept the viewer from presenting completed pictures. Completed snapshots now remain usable while the next asynchronous copy finishes; the first snapshot is also prepared before a cut.
- The layer canvas requested CPU storage even though normal compositing and grading use the GPU. It now uses the default accelerated path, reading pixels only for effects that require them. Decoded video frame callbacks wake the renderer independently of the timeline clock.
- Quarter quality reduced the canvas size but decoded the same 1920-pixel stream. Full, half, and quarter now select separate all-intra streams. Audio-only tracks use an audio stream, and muted audio is excluded from preloading.
- Playhead motion rebuilt static timeline rows; unchanged lock expiry and server snapshots also invalidated UI subscriptions. Moving indicators now update separately, and unchanged data retains its identity.
- A typical 65³ Resolve LUT was 4.75 MB of text. Lossless gzip reduces that example to 1.72 MB, with authenticated cache revalidation. Sixteen resident GPU LUTs use at most 34 MiB, preventing repeated eviction while moving among nearby shots.

The initial development benchmark displayed only 1.3–1.7 new pictures/second during rapid scrubbing, with stalls over two seconds. A matched development rerun after the seek/color fix delivered about 51 pictures/second from the same full-size proxy, before adding the smaller streams.

## Final production build

These runs use the real transport/timeline handlers, ten seconds of playback across edits, a six-second forward/backward scrub through the first ten timeline seconds, and ten exact-frame seeks. Timeline zoom is increased so integer pointer coordinates do not limit the number of requested positions.

| Preview | Playback | Decoder drops | New scrub pictures/s | Seek p95 |
| --- | ---: | ---: | ---: | ---: |
| Full · 1920 px | ~24 fps | 0 | 57.8 | 66.8 ms |
| Half · 960 px | ~24 fps | 0 | 58.0 | 53.9 ms |
| Quarter · 480 px | ~24 fps | 0 | 58.8 | 53.3 ms |
| Quarter · 4× CPU slowdown, 20 Mb/s, 20 ms latency | ~24 fps | 0 | 57.2 | 50.4 ms |
| Full · Resolve look bypassed | ~24 fps | 0 | 57.7 | 65.1 ms |

Raw reports: [production](../artifacts/qa/playback-production-final.json), [constrained production](../artifacts/qa/playback-production-throttled.json), [initial baseline](../artifacts/qa/playback-before.json). Distinct picture counts include frames presented when crossing edits; they are not a claim that the 23.976 fps source contains extra frames. These are local hardware and simulated-constraint measurements, not a test on a second physical machine or every browser.

The separate [Color workspace run](../artifacts/qa/playback-color-final.json) and [bypassed-look run](../artifacts/qa/playback-no-lut.json) also pass the playback, continuous-scrub, and exact-frame seek checks.

All 25 original Resolve reference-frame comparisons passed, with worst mean absolute RGB error **1.263/255**, unchanged from the earlier color validation. The reference fixture is reconstructed from the original Resolve bundle because the live edit has moved shots and changed grades. Live edits are preserved. Sony/Canon GPU math, the browser fallback without VideoFrame, audio output, bidirectional scrubbing, collaboration, undo, offline recovery, and original-media export checks passed.

## Reproduce

Use an existing Playwright installation, set `PLAYWRIGHT_MODULE` to its `index.mjs` if needed, and set `PLAYWRIGHT_EXECUTABLE_PATH` to hardware Chrome. The benchmark reads the local Newspaper project into an isolated test database and snapshots the UI so concurrent builds cannot invalidate a run.

```sh
npm test
npm run build
npm run test:browser
QA_PRODUCTION=1 QA_QUALITIES=Full,1/2,1/4 node scripts/playback-browser-check.mjs data
QA_PRODUCTION=1 QA_QUALITIES=1/4 QA_CPU_RATE=4 QA_DOWNLOAD_MBPS=20 node scripts/playback-browser-check.mjs data artifacts/qa/playback-production-throttled.json
```

The renderer retains the validated raw YUV color path; it does not substitute an approximate LUT or discard color precision to obtain these results. The asynchronous snapshot behavior follows the [WebCodecs VideoFrame API](https://www.w3.org/TR/webcodecs/#videoframe-interface).

## Chromebook compatibility and efficient playback

The color renderer previously rejected hardware frames exposing RGB or opaque (`null`) formats, and treated raw-plane copy failures as fatal. It now keeps the validated YUV path when available and uses the existing browser-decoded canvas path for those devices. This is capability based, so it also covers Windows/ARM hardware and unavailable WebCodecs APIs. The [WebCodecs specification](https://www.w3.org/TR/webcodecs/#videoframe-interface) permits opaque formats and unsupported raw-plane copies. Frames are closed on failure, and unavailable readback is remembered per decoder rather than retried every frame.

Devices without WebGL 2 use the existing CPU color transform, including camera interpretation, Resolve LUTs and correction nodes. This emergency fallback preserves color processing but can be slow at full resolution. Browser-managed RGB conversion can differ from direct raw-YUV conversion; the fallback does not bypass grading or change exports.

**Settings → Playback → Efficient playback** offers Auto (default), On and Off. Auto activates with a reported 1–4 CPU threads or 1–4 GB of memory; missing hints do not trigger it. It coalesces timeline-clock redraws within each frame interval while allowing newly decoded pictures to render immediately, keeps four decoders instead of twelve (or however many active layers require), preloads one upcoming video/audio clip instead of three/two, and refreshes scopes at 4 fps instead of 10. Paused scrubbing remains unrestricted. Preview resolution, color, effects, audio processing and export settings are unchanged.

Validation: 82 automated tests; 35 browser color comparisons covering native GPU, opaque/RGB frames, constructor/allocation/copy failures and unavailable WebGL 2; full browser workflow including real video/audio, scrubbing, collaboration and original-media export. Color comparisons use a synthetic RGB fixture and do not prove identical hardware YUV-to-RGB conversion on every device. Physical Chromebook verification remains required.

```sh
node scripts/color-gpu-check.mjs
QA_PRODUCTION=1 QA_LOW_END=1 QA_CPU_RATE=4 QA_QUALITIES=Full node scripts/playback-browser-check.mjs data artifacts/qa/playback-chromebook-simulation.json
QA_PRODUCTION=1 QA_LOW_END=1 QA_NATIVE_FRAMES=1 QA_QUALITIES=Full node scripts/playback-browser-check.mjs data artifacts/qa/playback-native-frame-fallback.json
```

Final runs on the current Newspaper edit, both at Full preview with Auto activated by simulated 4-thread/4-GB hardware hints:

| Run | Playback | Decoder drops | New scrub pictures/s | Exact seek maximum |
| --- | ---: | ---: | ---: | ---: |
| 4× CPU slowdown, raw YUV | 23.6 fps | 0 | 40.8 | 102.6 ms |
| Opaque hardware frames, native fallback | 23.7 fps | 0 | 56.8 | 67.2 ms |

Reports: [CPU-throttled](../artifacts/qa/playback-chromebook-simulation.json), [native fallback](../artifacts/qa/playback-native-frame-fallback.json). Worst playback gaps were 90.6 ms and 83.7 ms respectively. An upcoming shape no longer consumes the limited media preload slot; that previously left the next cut cold. The benchmark now uses the current pointer-based ruler controls, releases each seek gesture, and expects frame-snapped times at the project's fractional frame rate. These are Mac Chrome simulations, not physical ChromeOS measurements or a matched before/after speedup claim.
