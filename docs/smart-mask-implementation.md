# Smart Mask implementation contract

The shared TypeScript source of truth is `src/services/smartMask.ts`. A clip owns `smartMasks`; a Smart Mask effect references one with `maskId`, and a grade node references the same document with `mask: {id, enabled, invert, amount}`. Amount is 0–100. Each document holds one subject. This structure inherits existing clip persistence, snapshots, cloning and history transport; all mutations must still pass through the store's `commit` and permission/lock checks.

## Stored intent

`SmartMaskDocument` contains version, ID/name, source media ID/dimensions/nominal fps/duration, a source-time range `[start,end)`, include/exclude prompts, foreground/background/unknown local repairs, finishing settings, and an optional result binding. Points are normalized in the untransformed source image. Brush radius is relative to its shorter dimension. Prompt and repair times are source seconds. Whole-clip range is mapped into source time; moving a clip does not move its prompts.

`smartMaskSignature(document)` returns deterministic canonical JSON excluding document ID, name and generated result. Browser and server compare this exact intent string. The server computes the cache SHA-256 from it plus source fingerprint, worker/model/checkpoint revision, analysis conversion, direction and anchor. A result stores `{key,signature}` only after successful publication. Renderer must compare its signature with current intent; stale results are never silently accepted.

Prompt strokes ask AI to reconsider selection and can propagate. Repairs are frame-local, ordered and applied after alpha estimation. An unknown repair restores the underlying estimated alpha in its region; it must not paint alpha 0.5. If a worker supports unknown-region re-estimation, that happens explicitly before final paint composition. Foreground/background brush edges blend with the estimated alpha. Preserve source motion blur controls recovery from source pixels, not a Gaussian blur of the output silhouette.

`validateSmartMask` enforces finite normalized points, source/range limits, bounded stroke sizes and settings. `validateSmartMaskBindings` rejects missing/wrong-media references and an enabled mask on a node with enabled CST effects. Grade paste to different media must remove mask references; source-owned mattes cannot follow an unrelated clip. Removing an attachment does not delete its document while other attachments use it.

## HTTP contract

All routes require an authenticated project member; starting/cancelling analysis requires editor rights. File access must check the cache's stored project binding, not merely knowledge of a hash.

| Request | Result |
|---|---|
| `GET /api/smart-masks/capabilities` | `SmartMaskCapabilities`: available, engine/reason, preserveMotionBlur, finalQuality. Capability is factual; a research baseline must not advertise quality certification. |
| `GET /api/smart-masks/source?clipId=…&frame=…` | Source-image JPEG for picking, before analysis. Server resolves original-media paths; request cannot select an arbitrary path. |
| `POST /api/smart-masks` | Body `SmartMaskRequest`: clipId, maskId, signature, direction (`forward`, `backward`, `both`), anchorTime. Compare with saved document after UI flush; return 409 if stale. Return `SmartMaskJob`. |
| `GET /api/smart-masks/:key?projectId=…` | Current `SmartMaskJob`. |
| `DELETE /api/smart-masks/:key?projectId=…` | Cancel pending processing, retaining prompt intent and previously published revisions. |
| `GET /api/smart-masks/:key/manifest?projectId=…` | `SmartMaskManifest`, only after completed atomic publication. |
| `GET /api/smart-masks/:key/frames/:frame.png?projectId=…` | Lossless 16-bit single-channel alpha master. Browser may decode to 8-bit for display, never replace the master. |

Jobs contain key, signature, status (`queued`, `processing`, `ready`, `failed`, `cancelled`), progress, optional error/manifestUrl/previewUrl. Progress is transient server state and does not continuously mutate shared project history. Persist project/cache bindings so restarting the server does not orphan a valid revision.

## Python worker contract

`SmartMaskWorkerInput` JSON contains trusted `input`, `output`, `ffmpeg`, `ffprobe` paths, validated `document`, `direction`, and `anchorTime`. Backend writes it to a private temporary job directory, invokes worker with that path, bounds concurrency and handles abort signals. Worker writes lossless grayscale 16-bit PNGs indexed by decoded source-frame index plus a result manifest. Report newline-delimited JSON progress on stdout or stderr, consistently with the agreed launcher. Backend enriches the worker manifest with key/signature/project/source fingerprint/model revision and atomically renames the completed directory.

The manifest supplies `{index,time,file}` for every published alpha frame and preferably the complete original decoded `sourceTimes` PTS table. `smartMaskFrame` uses that table when available; its nominal-fps fallback makes no native VFR accuracy promise. Source images for picking and masks for viewing/export must use the same frame table. A decoded-table entry's ordinal index is authoritative; an arbitrary floating timeline second is not.

Keep publication distinct from certification: `quality:final` requests the final-resolution path, but Resolve equivalence requires the sports review described in `smart-mask-research.md`. Never label an unavailable/unproven engine as achieving those gates.

## Renderer semantics

* Clip mask multiplies existing source alpha at its position in the clip effect stack. `effectiveAlpha = 1 - amount/100 + amount/100 × (invert ? 1-alpha : alpha)`; outside the document range the sampled matte is zero (before inversion).
* Node mask mixes the node's complete correction and LUT result with its node input. Mix once around the whole node, not once per stage. Outside range the sampled matte is zero (before inversion). Unmasked CST nodes continue applying globally.
* Use the same saved revision in preview and export. Missing/stale coverage stalls preview with an explicit state and blocks export. A bypassed attachment has no such dependency.
* Source-coordinate alpha receives the same fit/crop/rotation/transform as its RGB. Source optical-flow retiming requires the corresponding warped alpha or analysis of the retimed RGB; until implemented, reject this combination explicitly rather than interpolate mattes independently.
* RGBA synthetic motion blur samples alpha and color together. Existing playback transforms happen after effect application, which is the correct hook for a source cutout.
* Spatial node masks cannot be collapsed into a global RGB LUT. Use the staged float exporter for masked nodes and extend its complete-node blending; keep the unmasked optimized path.

## Ordered vertical slices

1. Domain check: document validation, deterministic signatures, source timing, same-media references and local repair alpha. **Implemented; test first was observed failing, then passing.**
2. Offline engine feasibility: real source-frame selection, include/exclude prompts, lossless output, re-identification and hair/blur composites. Preserve actual evidence and limitations.
3. Worker lifecycle and private cache: request saved intent, cancellation, atomic publish, reload, source previews, exact manifests.
4. Store/UI: shared attachments, undoable strokes/repairs/settings, range and direction controls, source-aligned pen, frame stepping, overlay/alpha/checkerboard previews, truthful unavailable/progress states.
5. Preview renderer: full-node influence and clip alpha, source-coordinate mapping, stale coverage guards, bypass. Verify nonidentity colored regions with fractional alpha.
6. Export renderer: same revision/frame mapping, full precision alpha, fail on missing coverage, round-trip and retime checks. Source interpolation remains blocked until alpha follows it correctly.
7. Sports comparison: agreed native-resolution shots and Resolve references; no quality claims until evaluated. Optimize only after the accepted visual result is preserved.

## Renderer validation and present limits

Implemented browser caching, source-aspect fitting, source-PTS lookup, whole-node GPU/software influence, alpha effect ordering, and staged float export. The existing color GPU check now includes a fractional mask wrapping correction plus LUT on GPU, software and native YUV input, with letterbox assertions. `server/smartMaskRender.test.ts` uses deliberately authored alpha, independently of model quality: it checks exact 16-bit lossless worker round-trip, fractional clip composite, selective node grade, source trim/reverse/freeze and stale-result rejection.

Final alpha travels as native-resolution gray16 PNG and lossless gray16 FFV1. FFmpeg alphamerge negotiated 8-bit formats in a direct test, so mask insertion uses extractplanes, a 16-bit blend and mergeplanes. Existing unmasked export paths remain optimized; a spatial mask selects the staged float worker. Unmanaged clips use the existing source-view LUT before per-node operations.

The source PTS table drives mask selection. Masked export presently rejects irregular VFR timing because the existing rawvideo float encoder is CFR; it does not quietly shift native frame identity. Convert such source footage to CFR and reanalyze for this path. Optical-flow synthetic retiming also requires RGB and alpha to be warped together and is explicitly rejected until that shared path exists. Ordinary constant-speed, reversal, freeze and per-frame animation use the corresponding source alpha.

Precision limits that remain visible: browser previews decode gray16 PNGs to 8-bit samples and cap alpha previews at 1920×1080; masters are retained. Existing ordinary timeline composition is 10-bit YUV, and nested transparent composition uses an existing 8-bit RGB path to avoid the original YUV translucent-edge defect. High-precision linear RGB composition across nested timelines is not implemented by this slice and remains a finishing-quality requirement. The authored renderer tests establish synchronization and arithmetic, not sports segmentation/matting quality or Resolve equivalence.

## Current model qualification and local evidence

The production capability report currently enables only **SAM 2.1 Large tracked selections**. A SAM confidence/logit is never labelled as alpha: its thresholded silhouette is a binary selection, saved in the same gray16 transport as future fractional mattes. Tracked-selection export is available; source-motion-blur analysis and fine-hair matting remain unavailable. The optional MatAnyone2 adapter in the Python worker is an evaluation candidate, not an enabled or validated final engine. Its S-Lab noncommercial terms still require resolving the intended use; no restricted weights were installed or enabled in this build.

Local baseline: SAM2 commit `2b90b9f5ceec907a1c18123530e92e794ad901a4`, official `sam2.1_hiera_large.pt` SHA-256 `2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318`, PyTorch 2.14.0 on MPS. Installation is reproducible with `npm run setup:masks`. Worker identity includes source/checkpoint hashes, configuration, runtime and device. PNGs carry native decoded source dimensions; intermediate RGB is lossless PPM to avoid spending analysis time compressing temporary 4K PNGs. The streaming frame adapter retains four resized input tensors and a bounded non-conditioning memory horizon; correction anchors are retained.

Real source `C0363.MP4` is 3840×2160 at 59.94 fps. Results are under `artifacts/smart-mask/`:

* The first one-point test selected the jersey, not the whole athlete. An overly broad interior stroke leaked background on the initial frame. Neither result passed visual review.
* Three targeted points on the head, torso and thigh selected the body substantially better. The native 13-frame service run verified exact source indices 180–192 and PTS 3.003–3.2032s. Its original implementation took 64.95s including source decode, tracking, publication and independent timing verification; this is not a sustained inference speed claim. A later three-frame run took 29.32s while another tracking job was running.
* A repair-only service job then changed the targeted pixel from alpha 65535 to 0 in 3.16s, without re-running SAM. Filesystem inode and pixel checks verified shared unpainted/unchanged frames and an unchanged previous published matte. All current repairs apply afresh to `base-frames`, so removing paint or using Reset restores the inferred alpha rather than compounding prior paint.
* Whole-clip bidirectional analysis completed: all 690 decoded source frames, indices 0–689, PTS 0–11.494817s, native 3840×2160 gray16. The complete service run took 732.88s on this Mac with other checks running. Reviewed samples retain the selected red-jersey runner through the hurdle sequence, show only visible parts during overlap, and return empty alpha after he leaves the image instead of switching athletes. This is one-shot baseline tracking evidence, not a validated re-entry or fine-edge result. `sports-tracking-review.mp4` is a reduced-resolution side-by-side viewing copy; the masters remain native resolution.
* The isolated MIT PyMatting evaluation tested three native source frames with 4/12/24 px automatic unknown bands. Larger bands erased anatomy and admitted background structures; estimated foreground colors did not repair the alpha. This tested pipeline was rejected for final use. Its report, nine native gray16 outputs, exact environment and reproduction script are in `artifacts/smart-mask/pymatting-eval/`.
* The isolated author-published MIT BiRefNet HR-matting checkpoint produced soft edges in five 2048×2048 crop inference calls (3.10–4.70s each on MPS), but included other athletes in overlap frames 300 and 420. SAM provided the crop only; this model was not instance-conditioned. That pipeline was rejected for final use. The screening used native-dimension JPEG viewing frames, not lossless original RGB, and establishes an identity failure rather than an edge-quality score. Pinned source, checkpoint hash, exact environment, native gray16 outputs and comparisons are in `artifacts/smart-mask/birefnet-eval/`.
* Matting Anything ViT-B was evaluated with SAM2 mask guidance on five lossless decoded frames, including one- and two-sided learned boundary refinement. One-sided refinement preserved coarse foreground but left broad fringes; two-sided refinement erased parts of the shin/foot. A frame-180 CPU check reproduced the raw model result within one gray16 unit of MPS. Seventeen outputs across the variants passed native gray16 verification. The author's Google Drive checkpoint download succeeded after the Hugging Face route failed; actual source/weight identities and reproducible evidence are in `artifacts/smart-mask/mam-eval/`. This candidate remains outside the final engine.

UI checks exercised source upload, timestamp acquisition, Include/Exclude drawing, frame-local repair persistence, native zoom and scroll-coordinate accuracy in isolated Chrome. Complete-node gradient masking matches the RGB and native-YUV GPU reference exactly in the test, with at most one display-byte software difference. A delayed native-frame test ensures alpha lookup uses the selected decoded frame timestamp, rather than a newer HTML video playhead.

These are engineering and baseline-selection results. There is no Resolve reference comparison, fractional-alpha sports ground truth, or accepted hair/blur/occlusion suite yet. The user quality goal remains open until a suitable final engine passes those cases.

Final checks for this slice: 172 Node tests passed without skips, worker source-time/brush/gray16/repair-reset checks passed, TypeScript and production build passed, and the saved `scripts/smart-mask-browser-check.mjs` passed in isolated Chrome with accurate 200% zoom/pan coordinates. Run the latter with `npm run test:masks:browser` and the same Playwright environment described in the main README. No production project, account or timeline data was changed by these tests.

The browser fixture logs an existing provisional-thumbnail HTTP400 (`Preview must be an image up to1024×1024`); server media preparation supplies the thumbnail and the source-frame/mask interactions pass. That separate upload-preview behavior was not changed by this work.
