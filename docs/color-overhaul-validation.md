# Color overhaul validation — September 13, 2026

The first grading workflow is implemented: editable camera → DWG/Intermediate → Rec.709/Gamma 2.4 transforms, ordered CST/LUT effects, movable serial nodes, custom channel curves, primary wheels, a resizable inspector/tool/scopes layout, and scopes driven by each presented grade. Starting a new grade saves a snapshot; it does not silently migrate existing grades or imported Resolve looks.

The completion pass fixed inherited slider/port sizing, Fit Nodes terminal clipping, connection hit testing under dragged cards, single-action insertion undo, keyboard curve editing, and GPU texture precision. The footer reports source decode precision separately from the 8-bit display. Tests use a temporary copy of Newspaper; the live database and camera originals are not edited.

## Reproduce

```sh
npm run build
npm test
npm run test:color
```

`test:color` requires Playwright (or `PLAYWRIGHT_MODULE` pointing to its module), Chrome/Chromium (`PLAYWRIGHT_EXECUTABLE_PATH` can select installed Chrome), FFmpeg, and the local Newspaper originals C0965.MP4 and C0973.MP4. Build first because the workspace test serves `dist`. GPU tests explicitly reject a software fallback in their GPU cases.

## Evidence

- Build and 145 Node tests pass, including reference values, transform round trips, negative/highlight inputs, node state validation and undo.
- GPU/CPU swatches cover all supported transfer functions, managed chains with custom curves and LUTs, legacy corrections, decoder failures, and synthetic 10-bit YUV planes. Error gate: mean below 1.5 and maximum below 6 code values out of 255.
- The workspace test exercises node drag, Alt-insertion, one-step undo restoring position and order, bypass/delete without clip actions, effect settings/removal, curve creation/keyboard movement/deletion, numeric persistence, reload and layouts at 1600, 1280 and 390 pixels.
- On Apple M5 Pro, macOS ARM64, installed Chrome in headless mode, a 1600×1000 workspace with streaming proxy preview and efficient mode enabled measured approximately 60 presented updates/sec for all four scopes during 90 distinct paused adjustments. No viewer/scope revision mismatches occurred during those adjustments, final release, or the sampled playback interval. The previous sinusoidal benchmark repeated rounded slider values and undercounted effective updates; the current check uses distinct values.
- Original 10-bit Sony footage was rendered through the actual FFmpeg export path to ProRes 4444 using exposure, warmth and a smooth curve. At 160×90 comparison resolution, mean RGB error was 0.905/255 for C0965 and 0.624/255 for C0973; the 99th percentile was 3/255 for both. The reference uses CPU preview equations on floating-point source samples. Different ordering of spatial resizing and grading contributes to these errors; this is a sampled frame check, not a whole-film guarantee.
- The same samples separately measured 65³ LUT interpolation: mean error 0.256/255 and 0.170/255, 99th percentile 2.781/255 and 2.836/255, maximum 8.791/255 and 7.283/255. Acceptance gates are mean <1 and 99th percentile <4; isolated larger errors remain near steep color boundaries. Export agreement gate is mean <3 and 99th percentile <12. Sharp, closely spaced curves can exceed a fixed LUT's precision and require separate comparison.

The real C0965 browser check reported **8-bit YUV** for the proxy and **10-bit YUV** for the camera original, with a presented picture and no playback error on this Chrome/M5 Pro setup.

Screenshots, scope revisions/timing, source-decoder observations and export metrics are under `artifacts/qa/color-overhaul/`. Synthetic 10-bit GPU tests do not prove that a particular browser exposes original camera planes at that depth; check `source-precision.json` and the footer.

## Remaining external reference checks

- Resolve technical-CST frame matching with tone/gamut mapping disabled has not been performed for the new chain. Matching the published [DWG/Intermediate specification](https://documents.blackmagicdesign.com/InformationNotes/DaVinci_Resolve_17_Wide_Gamut_Intermediate.pdf) is not proof of matching Resolve's proprietary display rendering or controls.
- Real Canon R6/R6 Mark II footage has not been supplied/identified. Canon coverage is numerical and GPU coverage, not footage validation. Canon Log 2 remains available as a transfer function, not an R6 recording preset.
- Legacy S-Gamut uses nominal D65 primaries. Camera-specific temperature matrices are not implemented; the CST shows this limitation and can accept a matching camera LUT through the effects stack. Sony explicitly exposes temperature-specific S-Gamut modes in its [camera documentation](https://helpguide.sony.net/cam/1710/v1/en/contents/TP0001492378.html). The [Sony S-Log white paper](https://www.sony.jp/products/Professional/c_c/hdcam_sr/whats/pdf/SonyLogWhitepaperJpn1110.pdf) pins the original logarithmic curve; obtaining and archiving the original S-Log2 technical paper remains a reference-audit item.
- Masks, tracking, parallel mixers and the broader effects catalog remain outside this pass, as agreed. Browser display/scopes remain SDR, and color-managed HDR delivery is not implemented.
