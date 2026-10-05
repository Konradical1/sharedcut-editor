# SharedCut v0.2 architecture

SharedCut has a React/TypeScript browser client and a self-hosted Node server. Zustand holds the active edit; SQLite is authoritative for accounts and saved projects. FFmpeg runs real preparation and export work on the server. The original phase-one design and prompt remain in this directory as archives, not a checklist of implemented capabilities.

## Runtime and data flow

```text
Browser editor ── same-origin /api ── Node HTTP server
       │                                  │
       │                          SQLite + media files
       │                                  │
       └── authenticated proxies      serial FFmpeg worker
                                          │
                                  original-media exports
```

`npm run dev` starts Node and Vite, which proxies `/api` to port 4310. After `npm run build`, `npm start` serves both `dist/` and the API on loopback port 4310. Node 22.18+ supplies HTTP, crypto, SQLite, streams, and TypeScript stripping without a backend framework. See the [README](../README.md) for configuration and HTTPS deployment.

`FRAME_LINE_DATA` defaults to `./data`. It contains `frameline.sqlite`, `media/<id>/original`, prepared proxy/thumbnail files, and `renders/`. Upload names are editable labels; clips use stable internal media IDs. User-supplied paths never select filesystem locations. Uploaded originals, prepared files, and export downloads all require authenticated project access; media responses support byte ranges.

## Identity and authorization

`server/index.ts` stores scrypt password hashes and session-token hashes in SQLite. The browser receives an HttpOnly, SameSite=Strict session cookie. A trusted HTTPS proxy enables Secure cookies through `FRAME_LINE_TRUST_PROXY=1`. Write requests reject cross-site origins. An optional `FRAME_LINE_SIGNUP_CODE` gates registration; use it before admitting remote clients.

Every registered account joins the installation's Class. Shared projects initially grant Editor access to Class; private projects are owner-only. The owner can assign Editor, Commenter, or Viewer to another account through the dedicated member endpoint. Owners retain ownership. Ordinary project saves cannot change identities or grant roles. Media and render metadata also use dedicated endpoints rather than trusting client-submitted status fields.

Permissions are checked on every API request and on changed project collections. Editors can edit; Commenters can review; Viewers can inspect. A demotion releases that user's write locks. State responses omit inaccessible projects and their related entities. The service is intended for a trusted studio installation with controlled account admission, not open anonymous access.

## Saves and collaboration

`src/state/store.ts` defines editing actions. `src/services/sync.ts` connects those actions to revisioned `GET /api/state` and `PUT /api/state` requests. The server validates shapes, finite values, IDs, relationships, ownership, authorship, and active locks before saving. State and account preferences commit in one SQLite transaction.

The server compares the submitted revision with the current revision. A stale save receives HTTP 409 and the current authorized state. `src/services/merge.ts` merges independent changes by entity and field. Competing changes remain visible for the user to resolve. The browser caches an unsaved recovery draft and warns before leaving with pending changes; a draft never replaces the server as the saved source of truth.

The client polls once per second and posts transient presence: cursor, selection, playhead, timeline, activity, and presenter state. The API also offers an SSE revision notification endpoint. Presence expires after 15 seconds; locks expire after eight seconds unless renewed. Property locks permit unrelated controls to change concurrently; manipulation locks cover position, duration, track, and source offset. Server validation rejects conflicting writes with HTTP 423. Presence and locks are in memory and do not enlarge durable history.

This is revision checking with a three-way merge, not CRDT/OT or frame-accurate remote playback. Save requests are limited to 20 MiB, and persistence uses one workspace document. Larger productions would need project partitioning and incremental operations before those limits become appropriate.

## History and snapshots

Editing operations record the authenticated author, target, description, timestamp, and before/after field changes. Personal undo checks newer overlapping edits and current entity values before applying an inverse, then records that inverse as another operation. It does not undo another user's unrelated work. Saved history cannot be rewritten or removed; an author may mark their own eligible operation undone.

Snapshots contain a project's clips, tracks, grade nodes, and comments. Restore preserves the current state in a new snapshot first. Snapshots are immutable, and restored comments retain their original authors. The server rejects forged authors and missing or cross-project references. Media referenced by current timelines, saved snapshots, or pending exports is retained.

## Media and export

`server/media.ts` probes the original, generates a thumbnail, previews and filmstrip, and computes waveform peaks. A video gets the storage v3 set: `full-v3.mp4` (≤1920, H.264 10-bit 4:2:2, half-second GOP; Full, Color and the optical-flow input) first, so the clip plays as soon as it lands, then `stream-v2.mp4` and `stream-low-v2.mp4` scaled from it, plus `audio-v1.m4a`. A graphic with alpha gets VP9 WebM instead. Audio proxies use AAC; image previews use raster files. `server/mediaMigration.ts` moves imports made by older builds onto this set at startup, one asset at a time, and deletes the files it replaces only after the asset's row points at verified new ones. FFmpeg input protocols and demuxers are restricted so an uploaded playlist cannot fetch remote URLs or read arbitrary local files. Uploads stream to a temporary file under a size limit and are renamed only after receipt.

Preparation and rendering share a serial queue, with admission limits. Render submission captures the timeline, clips, tracks, grade nodes, settings, and original file references. FFmpeg composes the selected range, applies supported transforms/SDR grades/audio processing, and writes the requested MP4 or MOV. Download becomes available only after completion. Cancel signals the worker and removes incomplete output; file deletion waits for relevant worker cleanup.

Jobs continue when the browser closes. Process restarts mark interrupted work failed rather than claiming it completed: preparation can retry from its original, and an export can be resubmitted. Resolve bundle imports use checksum-verified resumable chunks. There is no distributed worker, automatic processing retry after restart, or automatic disk retention. Each export is limited to 128 clips, six hours, dimensions up to 4096 × 4096, and reverse segments no longer than 60 seconds.

## Playback and creative limits

`src/services/playback.ts` synchronizes native browser decoders to the local playhead, composites layers on a canvas, and routes audio through Web Audio. It implements transforms, crop, opacity, SDR adjustments, track/clip gain and pan, supported preview effects, and measured audio levels. Scopes sample the current canvas. `src/services/color.ts` builds the shared camera/grade LUT. WebGL 2 and FFmpeg both sample it with trilinear interpolation; exports process original pixels in floating point before 10-bit compositing.

Footage reaches remote viewers through a Service Worker cache. `public/footage-worker.js` answers byte-range requests for `/api/**/*.mp4|m4a` out of Cache Storage in 1 MiB chunks and fills misses from the server, so anything played once stops crossing the tunnel; originals are never cached. `src/services/footageCache.ts` parses each proxy's `moov` (`mp4Index.ts`) and pulls the byte range every timeline clip uses, plus two-second handles, in playhead order under a 2 GiB cap. The ruler bar (`renderBar.ts`) shows green where that footage is cached, yellow where it still streams, and red where the server is preparing media, Stabilize, Optical flow or a Smart Mask. Settings → Playback holds the toggle and a Clear cache button. The design note is `docs/superpowers/specs/2026-09-16-footage-cache-design.md`.

The preview is an 8-bit SDR implementation capped at 1920 pixels wide, with browser-dependent decoding. Transition motion blur is sampled at a few sub-frames in the browser and at a multiple of the frame rate in FFmpeg, so the rendered blur is finer than the preview's. FFmpeg renders from originals at the export resolution. These separate processing paths are not a calibrated or mathematically identical mastering pipeline. Reverse preview seeks video frames without reversed audio; export reverses both. Browser noise reduction uses a gate, while FFmpeg uses spectral denoising. Effect-response drawings are illustrations; scopes and meters use actual preview samples.

Sony/Canon log inputs, an SDR view transform and Resolve imports are documented in [Resolve and camera color](resolve-color.md). HDR mastering, AI grading or skin isolation, and subtitles remain unavailable. Stabilize is a clip effect: `scripts/stabilize.py` (OpenCV) analyses the clip's source range once and renders source-time replacement media, cached under `data/stabilize`; `server/stabilize.ts`, the `/api/stabilize` routes, `renderStabilizedTimeline` and `src/services/stabilizePreview.ts` mirror the optical-flow pipeline. The local grade assistant suggests editable SDR settings through rules. Unsupported controls are disabled or explicitly rejected. Prototype adapters and fictional seed data remain for regression tests; authenticated production sessions start with empty projects and real accounts.

### Depth

`server/depth.ts` runs `scripts/depth.py` (Video Depth Anything Small, `.venv-mask`) over a clip's source range and keeps 10-bit masters plus 8-bit preview segments under `data/depth`, shared by content key and evicted past `FRAME_LINE_DEPTH_CACHE_GB`. A clip has one run, its whole span with handles (`depthSpan`/`depthRun` in `server/media.ts`): `POST /api/depth` for the editor, the export's wait before the render queue (`depthRuns`), the Depth bake, depth-keyed grades and timeline previews all ask for it, so near/far match everywhere. The editor draws the effect in WebGL2 (`src/services/depthFx.ts`, `depthPreview.ts`); export bakes it into source-time ProRes with `scripts/depth-fx.py` before compositing, like Stabilize, and depth keys travel as one more mask plane through `color-render.py`. The maths is in `docs/superpowers/specs/2026-10-03-depth-fx-math.md`; refusals are listed in the README. Depth-assisted Smart Mask cleanup (cut SAM leaks at depth jumps, fill holes at the subject's depth) was tried on the soccer and hurdles clips and rejected: at every threshold it cut off hands, feet and arms, while leaks onto players at the same distance stayed and hole filling made them solid.

## Validation and operations

`npm test` uses Node's built-in runner for editor rules, merge/conflict behavior, HTTP authentication/authorization, history, snapshots, locks, upload preparation, rendering, and decoded export checks. Media integration tests need FFmpeg/ffprobe and explicitly skip when unavailable. `npm run build` checks TypeScript and creates the production UI.

`npm run test:browser` uses Playwright/Chromium against an isolated temporary data directory and the built UI. It covers a real uploaded video, moving frames/audio, saves and undo, two-user edits, offline conflict recovery, viewport containment across all workspaces, and downloaded export bytes. An external Playwright installation can be selected with `PLAYWRIGHT_MODULE`; screenshots go to `artifacts/qa/`.

For backups, stop the service and copy the entire data directory, including database/WAL/SHM, originals, prepared media, and exports. Restore that directory while the service is stopped. Copying only an active SQLite file can lose committed work and does not preserve footage. Treat the directory and backups as private: they contain credential hashes, live session records, project history, and source media.

### Transitions

A transition is stored on the incoming clip — `clip.transition` plus `transitionDuration`,
`transitionAlign`, `transitionCurve`, `transitionParams` and `transitionAudioId` in
`clip.properties`, with a `transitionOut` mirror set for a trailing one. There is no transition
collection: clips already pass through save validation, three-way merge, personal undo and
snapshots, so a transition stored there inherits all of it. `server/index.ts` validates the name
against the registry and the duration, alignment, curve and parameter payload alongside
`validateText` and `validateShape`.

`src/services/transitions.ts` is the single registry. Each entry carries a canvas `draw` for the
preview and an FFmpeg recipe for the export, the same split the effects already use, and the
library cards draw through the same `draw`. Window geometry lives there too: a transition borrows
unused trim handles rather than moving clips, so `timelineTransitions` resolves each one to
absolute bounds and clamps it to the handles both sides can lend and to the start of the timeline.
Which handle pays follows directly from `clipSpan`: the outgoing clip is the one extended past the
cut, so the share of the window *after* the cut comes out of its tail, and the share *before* the
cut comes out of the incoming clip's head. `bestAlign` reads that to place a dropped transition,
keeping it centred while centred still carries a usable window and otherwise sliding it wholly onto
whichever side has the frames; only a cut with nothing spare anywhere is refused.

The preview renders each side of the cut to its own offscreen canvas and hands both to the
transition, which composites into an alpha-capable buffer before that lands in the frame, in the
z-position the plain cut would have occupied. The buffer matters: the main composite is
`alpha:false`, so a wipe's `destination-in` mask would resolve to opaque black there, and a
transition into nothing could not leave the frame empty. Side canvases are kept per transition and
are only cleared immediately before they are drawn, so a decoder mid-seek reuses its last frame
instead of dropping the composite to empty — and a side that already holds a frame no longer
stalls the whole output, which is what made an incoming shot appear to stutter through a window.
`extendClip` widens a clip over its window by shifting `sourceIn` and re-anchoring its animation
channels; nothing in the stored edit changes. The decoders follow `syncClip`, which re-applies that
same extension to the *stored* clip: the geometry has to be the extended one because `sourceTime`
clamps elapsed time to the clip's own span — following the stored clip pinned the seek target for
the whole window while the element played on, so the sync yanked it back every few frames and both
shots jittered — while the keyframes have to be the stored ones because `evaluateClip` has already
flattened a speed ramp to its value at the playhead.

Preview motion blur averages the composite over sub-shutter instants with a running `1/(i+1)`
alpha, which makes each step an exact mean. The sample count is sized from `shutterStep`, the eased
progress actually crossed while the shutter is open at the frame being drawn, rather than from the
window's average speed: on a `[.8,0,.2,1]` whip the middle moves nearly three times the average, and
sizing from the average left samples pixels apart with a blur far too narrow to merge them. The
residual gap is closed by blurring the accumulated average once at half that spacing — averaging
blurred samples and blurring the average are the same thing, and one filtered pass instead of one
per sample is the difference between holding frame rate and not. `drawMirrored` builds the 2×2
period of the reflection once and fills through a repeating pattern, so the surround a zoom-out,
spin or shake reveals stays filled at any depth for a fixed cost.

The export splits each participating clip's filter chain into a body and one branch per window, so
the clip outside its transitions stays bit-identical and only the window pays. Branches are
trimmed to the window, run at a multiple of the frame rate, apply the transition's per-side
filters, and meet in `xfade`. Baked motion blur is averaged with `tmix` *after* the blend, not
before: a push or slide is positioned by `xfade` itself, so averaging the sides first would
average frames that never moved. Sample count and the residual `gblur` that closes the gap between
sub-frames both come from `motionSamples`/`motionGap`, sized from each transition's declared
`travel`. A missing side is transparent black, which is what a
transition to nothing means. Overlay transitions add the leak as a further input, blend it over the
result and mix its sound. When a timeline also uses keyframe animation, each window is pre-rendered
to ProRes 4444 and spliced back with `uncoveredParts` before the per-frame bake runs; a transition
whose own clips are keyframed is refused by name rather than exported as a hard cut.

### Export speed (2026-10-05)

A 115 s 4K-sourced Girls Soccer export at 1080p took 78 minutes; the stage log (`Export … finished after N s: …` in
the server log) now says where any export spends its time. What changed, and why:

- **Optical flow** (`scripts/optical-flow.py`) seeks to the source window a clip reads instead of decoding the whole
  file twice, has FFmpeg write the kept frames as raw RGB (a Windows pipe moved 4K 16-bit frames at ~150 MB/s), runs
  the inverse-warp iteration at motion resolution and warps frames in parallel: 610 s to 12 s for a 1.7 s clip.
  Export bakes fit the output frame times the clip's largest zoom (`pictureBox`), not the project canvas.
- **Work outside the range is skipped**: Stabilize, optical flow and compositions ignore clips whose span misses the
  In/Out range (`outsideRange`). A composition renders only the stretch its parent reads, at the size it covers.
- **Clips are graded on the canvas they end up on**: fit, grade, crop and pad happen at the clip's output size
  (never above the project canvas), so a 4K project exported at 1080p no longer grades 4K frames to shrink them.
- **Keyframed position, zoom, rotation and anchor stream** (`server/streamedTransform.ts`): one `perspective` filter
  with per-frame corner expressions in the normal pass, instead of a whole-timeline render per frame. It is 8-bit
  RGB, so only H.264/H.265 exports stream; ProRes and any other keyed property keep the per-frame path.
- **Stabilize export bakes are kept** in `FRAME_LINE_DATA/stabilize/exports` by content identity (16 GB, oldest out),
  so a re-export reuses them and the optical-flow cache keyed on them.
- **Final compositing avoids full-frame float blends for small stationary layers.** Normal placement stays the same;
  both blend inputs are cropped to the layer's visible bounds before float conversion. Add, transparent compositions,
  rotating and moving layers retain the full-frame path. Tests compare all other blend modes across fades and clipped edges.
- **Automatic/High H.264/H.265 ACES tables use 97³ tetrahedral sampling.** Parsing a separate 129³ text table for every
  short graded clip was a large fixed cost. On three real Canon Log 3 shots the change averaged 0.04–0.06 of an 8-bit
  code value, with p99 below half a value; this is a numerical approximation, not pixel identity. Maximum, Visually
  lossless, ProRes and internal frame/alpha bakes retain 129³ trilinear sampling. Encoder quality settings are unchanged.

Validation on the same 82.3–103 s section with two parallel passes: 62.5 s before, 41.7 s after; the slowest
picture pass fell from 32.7 s to 25.2 s. The live 0–115 s export using the server's usual three passes finished
in 551 s: composition 47 s, reused stabilization 1 s, optical flow 68 s, animation 60 s, final rendering 368 s,
join 8 s. Compare the matched two-pass section for the code's gain; the full-run total also benefits from reuse.

`server/transitions.ts` holds the shared overlay pack in `FRAME_LINE_DATA/transitions/`, listed and
served through authenticated `/api/transitions` endpoints modelled on shared fonts. Ids are pattern
checked and resolved against the manifest, so no caller-supplied text reaches a filesystem join.
A leak expanded onto an audio track uses the reserved `frameline-leak:` media id, the way titles
and shapes use theirs, and the preview and exporter both resolve it back to the pack.

### Text titles and font storage

Titles are clips with the reserved `frameline-title` media ID and a validated JSON `textDocument` property. The document holds styled text runs and normalized box coordinates; no source media is required. The shared `src/services/text.ts` layout draws to browser Canvas 2D and the server's native canvas. FFmpeg receives a transparent title image as an input at the clip's timeline interval. Title content, formatting and multi-layer changes use the existing operation/undo and state synchronization path; a `textDocument` lease protects concurrent text editing.

The authenticated `/api/fonts` GET/POST endpoints list and add globally shared fonts. Binary file signatures, byte limits and native decoding are validated before storage in SQLite. Content hashes deduplicate uploads and supply immutable font family aliases. `/api/fonts/:id` serves bytes only to signed-in users. Open viewers poll the shared catalog every 15 seconds and register new FontFace instances; the server registers the same font bytes for export, including after restart. Existing project state saves cannot overwrite the font table.
