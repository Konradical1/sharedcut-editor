# Color pipeline investigation and validation — September 13, 2026

The reported problems were reproduced from the original media and existing grades before modifying the pipeline. Screenshots alone cannot establish a camera transfer function, HDR format, or correct white balance.

## Findings

- **C0852.MP4 (mountain lake):** embedded Sony metadata identifies S-Log3 / S-Gamut3.Cine. The original is 10-bit 4:2:2 full-range H.264. The old 8-bit proxy produces the large pink/blue sky blocks seen in the report. The original, rendered at the same browser time with the same grade, does not have those blocks.
- **C0363.MP4 (runners):** original is 8-bit 4:2:0 full-range H.264. No reliable camera-log identifier was found. The user believes S-Log3 was enabled but is unsure. The existing input CST already selects S-Log3 / S-Gamut3.Cine; that choice is retained as **unverified**, not inferred from appearance. The clip's separate source label had said Rec.709 despite that CST; the status now shows the active input CST.
- **Decoded metadata:** Chromium reports `smpte170m` for C0852's original I422P10 planes. Direct sample comparisons with FFmpeg prove those planes are unchanged; the known Rec.709 YUV matrix must take precedence over that fallback. NV12 hardware decoding may actually convert range, so its decoded-range metadata is still respected.
- **Full-range precision proxy experiment:** the browser exposed full-range 10-bit proxy samples with a limited-range label. Final grading proxies explicitly use limited-range encoding, matching the browser's interpretation.
- **Display rendering:** the previous custom shoulder/saturation compression was not a reference ACES output transform. Combining it with low-precision log proxies exaggerated hue/contour errors. Gamma 2.4 output also needs an explicit conversion before writing into an sRGB canvas.
- **Chromatic adaptation:** direct source-to-ACES comparison exposed a mismatch between the old D65-only camera matrices and OCIO's camera transforms. ACES-enabled grades now use matrices generated from the pinned OCIO config for S-Gamut3/Cine, DWG, Rec.709 and Rec.2020. Existing legacy grades retain their old matrices until upgraded.

## Implemented path

Original camera media → YUV decoding with correct levels/matrix → log/working-space processing in floating point → native ACES 2 SDR tone/gamut rendering → explicit display encoding.

- **Preview:** generated OpenColorIO GLSL and its two float lookup tables. The ACES transform is not approximated by a general 3D LUT. Graded Gamma 2.4 Rec.709 is converted to sRGB, with half-code dither at the final 8-bit canvas boundary.
- **Grading proxy:** generated directly from the original at up to 1920 pixels wide; lossless H.264 10-bit 4:2:2, explicitly limited range. It retains camera encoding; it is not relabeled as a finished camera-to-709 conversion. An 8-bit source remains an 8-bit source even when processed through this 10-bit intermediate.
- **Quality selection:** Color defaults to this precision path, falling back to the original while preparation completes. Full also uses the precision proxy when available. Stream/half/quarter remain bandwidth-oriented previews and are unsuitable for judging difficult log gradients.
- **Optical flow:** precision input is selected for Color; cached preview encoding now retains 10-bit output. Cache identity is versioned. The native Apple flow algorithm itself uses 10-bit 4:2:0 buffers and ProRes 422 HQ, so optical flow is not claimed to preserve original samples exactly. The flow decoder must point at the retimed cache, not inherit the original's color-proxy URL.
- **Export:** the native OpenColorIO CPU processor renders ACES output from original source frames in float. A lossless 16-bit RGB intermediate carries the rendered result into the existing compositor/codec path. Original audio follows the existing timeline path. This avoids baking ACES into the old bounded 65³ LUT.
- **Existing grades:** “Use ACES 2 output” saves a snapshot, then updates the legacy output effect. Correction values, curves, node identities, source interpretation and edit timing remain intact. New wide-gamut log grades choose ACES output; a standard SDR input gets a technical conversion without an additional scene rendering.

## Reference and reproducibility

Pinned engine: `opencolorio==2.5.2`; NumPy `2.3.5` supports Python 3.11+ in the container and the local Python 3.14 environment.

Config: `studio-config-v4.0.0_aces-v2.0_ocio-v2.5`.
View: `ACES 2.0 - SDR 100 nits (Rec.709)`.
Display: `Rec.1886 Rec.709 - Display`.
Output processor input: `Linear Rec.709 (sRGB)` (scene-linear, not sRGB encoded).

Run `npm run setup:color` once on the server, or set `FRAME_LINE_COLOR_PYTHON` to a prepared interpreter. Docker installs the same requirements. Run `npm run generate:color` to regenerate the checked-in shader, tables and matrices. OCIO and config license notices are shipped in `public/licenses/`.

Run `npm test`, `npm run test:color`, and `npm run test:color-reference`. Browser checks use Playwright; `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE_PATH` can select the local installation. Real-media checks expect the named original assets in this installation and never overwrite their grades. UI mutation tests use a separate temporary database.

Evidence is under `artifacts/qa/color-reference/`:

- `camera-reference.json`: 5,120 independent S-Log3/S-Gamut3.Cine samples compared with OCIO's direct camera-to-display processor. Mean error ≈ 0.00000038, maximum ≈ 0.0001463 in normalized Gamma 2.4 output.
- `native-gpu.json`: 20 complete pipeline cases across ten input curves, including corrections/custom curves. GPU and native output differ by at most one final 8-bit display code in these cases.
- `final/`: original, old proxy and precision proxy, at three times in each of the two reported clips, plus two early track/sky frames; direct YUV and RGB-fallback images are both retained.
- `proxy-sky-error.json`: a fixed sky-region comparison against the original with the same ACES grade. Precision-proxy error is about 0.4 code on average, versus about 2.2 for the old proxy; spatial resampling also contributes to this comparison.
- `ui/`: real editor screenshots at 1280, 1600 and 1920 pixels, saved upgrade, reload, playback and optical-flow checks.
- `export/`: native ACES ProRes renders of both originals, normal/frozen frames, with dimensions, duration, audio and encoded-pixel checks. After matching frame-rate sampling, mean pixel errors are 1.34 codes for C0852 and 0.47 for C0363 (99th percentile: 8 and 2). Downsampling before versus after the nonlinear grade contributes to these differences; these are bounded image comparisons, not claims of identical pixels.
- `visual-summary.png`: side-by-side visual comparison, including an enlarged mountain-sky region.

## Live application verification

The running server was updated after validation. Both reported shots in TestOpticalFlow were upgraded through the authenticated editor UI, with a separate “Before ACES output” snapshot for each. A read-only comparison with those snapshots confirms that only the Output CST effects changed; clip timing/properties and all other node data remain identical. The live browser showed 10-bit YUV decoding, saved state, and ready optical flow. The mountain viewing position was restored to 00:00:16:02. See `live-verification.json`.

The build, 146 automated tests, existing color regression checks, independent reference checks, original-media exports and isolated editor/optical-flow checks passed. This is validation of the tested footage and paths, not certification of every camera or monitor.

## Limits and decisions

These are SDR renders. Log footage is a scene encoding, not automatically PQ/HLG HDR video. Native HDR browser output and HDR export were not added. A screenshot is not a calibrated measurement of the user's display; no universal claim is made for every browser/OS/display combination.

Lossless grading proxies require substantial bandwidth and disk space (the tested all-intra files are roughly 368 MB for the 7-second mountain clip and 1.1 GB for the 11.5-second runners clip). Color precision is prioritized for grading; Stream remains available for remote editing. Native float export is slower than a baked LUT, especially for animated grades or 4K footage.

Chromium on this Mac exposes the high-precision proxy planes successfully. Browsers that expose only an 8-bit RGB surface are labeled as a fallback; they cannot recover lost log precision. ACES preview requires WebGL2; the software path reports an unavailable reference renderer rather than silently substituting a different tone mapper.

Camera-specific calibration is still required for unknown footage. Existing Canon Cinema Gamut and original S-Gamut choices retain their documented nominal-D65 interpretation; they are not silently replaced with OCIO's Canon D55 or Venice-specific camera definitions. The independent camera-accuracy result above applies specifically to S-Log3/S-Gamut3.Cine. No correction can restore original clipping or missing 8-bit source detail.

## Research sources and tool choices

- [OpenColorIO ACES Studio configurations](https://opencolorio.readthedocs.io/en/main/configurations/aces_studio.html) and [OCIO 2.5](https://opencolorio.readthedocs.io/en/v2.5.1/releases/ocio_2_5.html): reproducible camera/working/display transforms and ACES 2 support. Selected as the reference foundation.
- [ACES 2 background](https://docs.acescentral.com/background/about-aces-2/) and [output transforms](https://docs.acescentral.com/system-components/output-transforms/): integrated scene-to-display tone and gamut rendering.
- [Sony S-Log3/S-Gamut3 technical summary](https://download.pro.sony/FNGP/protein/1237494271390/1237494271406.pdf): source transfer/gamut interpretation.
- [FFmpeg libplacebo filter](https://www.ffmpeg.org/ffmpeg-filters.html#libplacebo): strong existing HDR/video tone-mapping option. It does not by itself identify arbitrary camera-log footage. The installed FFmpeg has neither libplacebo nor zscale, so this implementation does not pretend those filters are available.
- [zimg](https://github.com/sekrit-twc/zimg): established high-quality pixel-format/color conversion machinery; useful for future FFmpeg builds, not a substitute for camera identification or an ACES rendering transform.
- [Colour Science](https://www.colour-science.org/): useful scientific reference/testing tools. A general scientific package is not itself a browser video pipeline.
- [WebCodecs](https://www.w3.org/TR/webcodecs/) and [HTML canvas](https://html.spec.whatwg.org/multipage/canvas.html): explicit color/plane handling and browser display boundaries.
- [Chrome WebGPU HDR canvas support](https://developer.chrome.com/blog/new-in-webgpu-129): an optional HDR display path when browser, OS and display support it. It is not necessary to correct this SDR pipeline.

A professional color-managed grading application can provide an additional camera-matched visual reference, but its project input/output settings must agree with this pipeline. A “looks better” comparison without matching those settings is insufficient.
