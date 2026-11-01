# SharedCut user and operator guide

This is the detailed feature and setup reference. The project overview is the [README](../README.md).

SharedCut v0.2 is a self-hosted collaborative video editor for a local studio or classroom. The browser provides the editing interface; a Node server stores accounts and projects, prepares uploaded media, and renders downloadable videos from the originals. The app stays inside its window, with scrolling confined to individual panels.

## Run

Install **Node.js 22.18 or newer**, npm, and **FFmpeg with ffprobe**. Both media executables must be on `PATH`, or configured with `FFMPEG_PATH` and `FFPROBE_PATH`. The FFmpeg build needs the encoders used by your chosen export, including libx264 for proxies.

```sh
npm install
npm run build
npm start
```

Open [localhost:4310](http://localhost:4310). Create an account, create a project, upload footage, and add it to the timeline. New accounts have no sample projects or fake collaborators. No AI service or API key is needed.

### Native Windows

Run `npm run setup:windows` after `npm ci`, then `npm start`. This installs local
GPU captions, SAM Smart Mask, portable optical flow, stabilization, color and
link imports. `npm run doctor` verifies the workers. See [Windows setup](WINDOWS_NATIVE.md). No Docker or WSL is required.

### Host memory guard and health trail

The server watches its own memory: heavy jobs (render passes, media encodes, Python workers) pass a guard that starts in `observe` mode, which only logs what `enforce` would have done and changes nothing. `enforce` holds heavy starts until memory is free, refuses timeline previews instead of queueing them, and under sustained memory pressure stops previews, filmstrips and waveforms first; read `data/host-health.log` before switching to it. `off` does nothing. `data/host-health.log` (one line every 30 s, rotated at 5 MB) and `data/playback-reports/` (one row per browser and minute, 14 days) leave a trail after a crash, and the Health page turns the reports into a plain diagnosis per browser. Switch the guard with the word `off`, `observe` or `enforce` in `data/host-guard.mode` (UTF-8 or PowerShell 5 UTF-16 both work), no restart needed. The video decoder thread cap (`FRAME_LINE_DECODE_THREADS`, 8) is always on and needs a restart to change. Details and the full variable list: `docs/WINDOWS_NATIVE.md`.

### Import YouTube and Spotify links

Install Python 3.12, then run `npm run setup:imports` once on the server. Docker images include the importer. In a project, choose **Media → Import link**, paste a single YouTube video or Spotify track URL, and choose **Import**. YouTube supports video with audio at up to 720p, 1080p, or 4K, or audio only. Quality is capped at the selection and the available source; files enter the existing proxy, thumbnail, and waveform pipeline.

Spotify links use spotDL to find a matching YouTube recording, then download its audio as M4A. This is not audio extracted from Spotify. The dialog and media card identify this, and **Metadata** retains both the Spotify link and actual YouTube source/title. Check the recording: versions can differ. A large duration mismatch fails rather than silently importing a different-length recording.

YouTube posters appear as soon as a video link is accepted. Local video/image uploads send a small source still first when the browser can decode it; otherwise the server generates one before encoding proxies. Progress, thumbnail changes, and completion update in place without a page reload.

Downloads continue if you close the dialog. Use **Cancel** on a pending import or **Retry** after a failure. Only single public videos/tracks are supported; playlists, albums, private/login-required media, live streams, and videos over six hours are excluded. Import only media you own or have permission to use. These unofficial downloaders depend on platform availability and can need updates when sites change.

`FRAME_LINE_IMPORT_PYTHON` can select an absolute Python executable with the packages in `scripts/import-requirements.txt` installed; otherwise the server uses the platform-specific `.venv-import` interpreter. On a network that re-signs TLS (a school Securly filter), set `FRAME_LINE_IMPORT_CA` to that filter's root certificate (PEM); imports trust it on top of the usual roots. FFmpeg uses the existing `FFMPEG_PATH` setting. Imports share the bounded media queue and upload size limit, time out after 30 minutes, and remove temporary files on completion, failure, or cancellation. During merging/conversion, temporary storage may reach twice the configured per-file limit. Run `node --experimental-strip-types --test server/linkImport.test.ts` for the offline integration checks (requires FFmpeg).

For development, run `npm run dev`. It starts the Node API on port 4310 and Vite on [localhost:5173](http://localhost:5173), with `/api` proxied to Node. Vite prints another port if 5173 is occupied. `npm run preview` serves only the built UI; use `npm start` for the complete application.

### Smart Mask selection preview

Run `npm run setup:masks` with Python 3.12 to install the pinned SAM 2.1 Large tracker. It uses the Apple GPU, CUDA, or CPU detected on the server. No external AI service receives footage. Drag **Smart Mask** onto a video clip or grade node, open **Select & refine subject**, and add Include/Exclude points or interior strokes. The editor opens in the viewer itself: the viewer shows the clip's own source frames and plays, scrubs and steps them at playback speed, with the matte drawn live over the picture as Overlay, Matte, Black or White. It has Fit/100%/200%/400% zoom, **Analyze** in its bar, and local Restore/Remove/Reset paint. The motion tracker opens the same way, so a track can be played back and corrected on the moving picture. Clip effects and grade nodes can share the same subject document.

The installed engine produces an **exportable tracked selection**. Choose **Use selection preview** to analyze with it. It has not qualified for final hair or source motion-blur matting; those controls do not silently fall back to a feathered silhouette. Tracked selections can be exported after reviewing their edges. The MatAnyone2 research adapter remains disabled pending permitted use and validation. See [research and model licenses](smart-mask-research.md) and [implementation and measured checks](smart-mask-implementation.md).

Analysis uses the original source's decoded frame timestamps, retains immutable native gray16 masks, and supports whole-clip or source ranges with forward/backward propagation. Editing paint alone reuses unpainted alpha; changing AI guidance requires retracking. Source/model/color-interpretation changes invalidate reuse. Jobs are private to a project and cancellable; originals and previous revisions remain intact. `FRAME_LINE_MASK_PYTHON` can select the worker Python. Run `npm run test:masks` for worker/domain/backend checks and `npm test` for renderer integration checks. Keep `data/smart-masks` with project backups; analysis temporarily needs substantial disk space for native source frames.

## Accounts and deployment

Private projects are visible only to their owner. Every account on this installation belongs to **Class**: shared projects are initially editable by all accounts. Owners can change a classmate's role to Editor, Commenter, or Viewer. Roles are enforced by the server, including media and export access.

The default server listens only on `127.0.0.1`. Before allowing access from other computers, configure `FRAME_LINE_SIGNUP_CODE` and distribute that access code to your class. Registration is open when this variable is unset. This is a studio deployment, not a claim of readiness for unrestricted public hosting.

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1`; server listening address |
| `PORT` | `4310`; API and built application port |
| `FRAME_LINE_DATA` | `./data`; accounts, database, originals, proxies, and exports |
| `FRAME_LINE_SIGNUP_CODE` | Unset; when configured, required to create an account |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe`; executable paths |
| `FRAME_LINE_MAX_UPLOAD_BYTES` | `10737418240`; maximum bytes per upload, 10 GiB |
| `FRAME_LINE_TRUST_PROXY` | Unset; set to `1` only behind a trusted HTTPS reverse proxy |
| `FRAME_LINE_HOST_GUARD` | `observe`; memory guard for heavy jobs (`off`, `observe`, `enforce`), also switchable without a restart through `data/host-guard.mode` |
| `FRAME_LINE_HEALTH_USERS` | Unset; comma-separated account ids that may open the playback Health page (`/api/health/report`) |

For a temporary test on the same local network, run `HOST=0.0.0.0 npm start` and open the server’s LAN address on the other machine. Public (Class) projects are available to registered accounts on that installation. Use HTTPS for Internet hosting and verified Resolve bundle uploads.

For a shared installation, put an HTTPS reverse proxy in front of the loopback server. Serve the app and `/api` from the **same origin**, preserve the original `Host`, and set `X-Forwarded-Proto: https`. Set `FRAME_LINE_TRUST_PROXY=1` so session cookies receive the `Secure` flag. Configure the proxy's upload limit and request timeout for your footage. Never expose the data directory as a static website.

Passwords are salted and hashed with scrypt. Sessions use an HttpOnly, SameSite=Strict cookie; credentials are checked by the server. Cross-origin API writes are rejected. HTTPS is required to protect credentials and footage over an untrusted network.

## Working features

- Upload and retain real video, audio, and raster images. FFprobe reads metadata; FFmpeg creates playable proxies, thumbnails, and sampled waveforms. Failed preparation can be retried from a saved original.
- Decode moving video and audio in the browser; move, trim, split, duplicate, and delete clips; adjust transforms, crop, opacity, speed, freeze/reverse, and track controls.
- Apply editable SDR grade nodes, inspect scopes sampled from the current preview, adjust audio gain/pan and supported effects, and read live audio meters.
- Collaborate through server-backed saves, presence, presenter following, and expiring control locks. Independent field edits merge; competing edits require an explicit choice. Unsaved edits have a browser recovery draft.
- Add review comments and replies, use personal undo, and save or restore snapshots. Restore first preserves the current edit. Referenced media cannot be deleted while a timeline, snapshot, or pending export needs it.
- Render selected timeline ranges from the originals with H.264, H.265/HEVC, or ProRes presets and download the resulting MP4 or MOV. Jobs keep running when the browser closes, provided the server stays running.

## Stabilize

Run `npm run setup:stabilize` once on the server (any Python 3.10+; it creates `.venv-stabilize` with OpenCV and NumPy, no GPU needed). Drag **Stabilize** from the Effects tab onto a video clip. **Crop** is the budget per side (default 5 %, so 1.11× zoom): the camera path is solved as an L1-optimal path (Grundmann et al., the method behind YouTube's stabilizer and Resolve's Cropping Ratio) that follows pans and never leaves the budget, so the zoom is exactly what you set. **Strength** blends toward the original, **Smoothness** trades following motion against a gimbal feel, **Lock** holds the first frame like a tripod. Analysis runs once on the camera original (proxies lose tracking on fast pans), in parallel segments with hardware decode when ffmpeg offers it, and is cached; changing a slider re-renders only the cheap warp stage. The zoom holds the budget and only glides up around whip pans; the timeline shows a progress bar on the clip while sections prepare. Preview arrives in four-second sections; export bakes the stabilized picture to ProRes and composites it like any other clip, so speed, reverse and freeze keep working. `FRAME_LINE_STABILIZE_PYTHON` overrides the interpreter. Stabilize shares a clip with optical flow: export stabilizes first and then interpolates the stabilized frames, and the preview warps the interpolated picture with the matrices around its source time. Stabilize cannot share a clip with Smart Mask. `npm run test:stabilize` covers the identity/cache logic; `.venv-stabilize/bin/python scripts/stabilize.py --selftest` checks the tracker on synthetic shake.

## Depth

Run `npm run setup:depth` once on the server. It installs Video Depth Anything Small (Apache-2.0) into `.venv-mask`, beside Smart Mask, and downloads and verifies its weights under `artifacts/depth/`. Drag **Depth** onto a video or image clip: the server analyses depth from the original and streams it in 64-frame segments, so the map fills in while you work. **Lens blur**, **Fog**, **Glow** and **Background light** react to distance, with presets, a focus picker and keyframes. **Subject** names a Smart Mask that Lens blur keeps sharp (**New subject** draws one without cutting the clip out), and **Follow subject** keeps Focus on it. In Color, a grade node's mask can be a **depth key** (near, far, softness) to grade only the background or foreground.

The editor draws Depth and depth keys live in WebGL2; timeline previews skip ranges with either. Export bakes it at source resolution with `scripts/depth-fx.py` (the same maths, checked by `npm run test:depth:parity`) and grades depth keys through `color-render.py`. Every reader uses one run per clip, its whole span with handles (`depthSpan` in `server/media.ts`), so an In/Out export matches the preview; the server alone picks it (the editor asks again after every trim or transition change) and keeps the clip's run while it covers. An export waits for that analysis, and for a full depth queue, before it joins the render queue. Runs are cached under `data/depth` (`FRAME_LINE_DEPTH_CACHE_GB`, 3 GB) and never take the disk below `FRAME_LINE_DEPTH_MIN_FREE_GB` (2 GB) or the server's 5 GB reserve. Other variables: `FRAME_LINE_DEPTH_PYTHON` (worker), `FRAME_LINE_DEPTH_WEIGHTS` (checkpoint path), `FRAME_LINE_DEPTH_PRECISION=full` (fp32), `FRAME_LINE_DEPTH_DEVICE` (bake device), `FRAME_LINE_DEPTH_TAPS` (export blur taps, 96), `FRAME_LINE_DEPTH_ENGINE=synthetic` (luma instead of the model, for tests).

Routes: `GET /api/depth/capabilities`, `POST /api/depth` (start or join a clip's run), `GET`/`DELETE /api/depth/:key` (status, cancel), `GET /api/depth/:key/preview/:n.mp4` (8-bit segments) and `GET /api/depth/:key/focus` (Follow subject). Limits: one Depth per clip; not on compositions, titles or with optical flow; export needs constant-frame-rate sources with even sizes up to 4096, and no keyframed grades or effects above Depth; a depth key refuses Stabilize and optical flow in export. The subject protects edges; it is not hair or motion-blur matting. Depth-assisted Smart Mask cleanup (cut SAM leaks at depth jumps, fill holes at the subject's depth) was tried on the soccer and hurdles clips and rejected: at every threshold it cut off hands, feet and arms, while leaks onto players at the same distance stayed and hole filling made them solid. Checks: `npm run test:depth`, `test:depth:browser`, `test:depth:parity`, `test:depth:inference`.

## Noise Reduction

Run `npm run setup:denoise` once on the server; it installs into `.venv-mask`, beside Smart Mask and Depth. **Noise Reduction** (Color page panel, or the Effects tab on a video clip) measures each source's own noise, aligns neighbouring frames with motion and cleans what they could not, on the camera original before the grade. The editor plays 2-second denoised chunks from a resident GPU worker; export bakes each clip's range to ProRes before Stabilize, Smart Mask, Depth and optical flow. Variables: `FRAME_LINE_DENOISE_PYTHON` (interpreter), `FRAME_LINE_DENOISE_WORKER` (script, for tests), `FRAME_LINE_DENOISE_DEVICE` (cuda, mps or cpu) and `FRAME_LINE_DENOISE_TRITON=0` (no Triton kernels). Export bakes are cached under `data/denoise/exports` up to `FRAME_LINE_DENOISE_BAKES_GB` (60 GB) and preview chunks under `data/denoise/chunks` up to `FRAME_LINE_DENOISE_PREVIEW_GB` (4 GB); a bake short of disk frees old bakes first, and the server's 5 GB reserve still applies. Audio Noise Reduction is a separate audio effect. Checks: `npm run test:denoise`, `test:denoise:browser`.

## Blackmagic RAW

Download **Blackmagic RAW** (the free Developer SDK) from blackmagicdesign.com/support, install it on the server, and run `npm run setup:braw` (or `npm run setup:braw -- <the SDK folder>`). It builds `.braw/braw` against the SDK with the platform's compiler (clang++, g++, or MSVC from a Visual Studio prompt) and copies the SDK's libraries beside it; `FRAME_LINE_BRAW` and `FRAME_LINE_BRAW_LIB` override both. `.braw` clips then import like any footage: the server reads them through Blackmagic's own RAW SDK, the decoder DaVinci Resolve uses, and develops each one into a full-resolution ProRes 422 HQ master (`media/<id>/developed-*.mov`, about 1.5× the `.braw`) plus the usual previews. Everything downstream (export, Smart Mask, Depth, Noise Reduction, Stabilize) reads the master.

On the Color page a Blackmagic RAW clip gets a **Camera Raw** tool, laid out like Resolve's: Decode using camera metadata or clip settings, Color Science (Gen 4/5/6), Gamut, Gamma, 3D LUT (the clip's embedded one), ISO, Color Temp, Tint, Exposure, Highlight Recovery, Gamut Compression, and the custom gamma curve (Saturation, Contrast, Midpoint, Highlight and Shadow Rolloff, White and Black Level, Video Black Level). Settings belong to the media, as in Resolve. A change develops the clip again behind the look it plays; meanwhile the paused viewer shows the SDK's frame with the new settings (`GET /api/media/:id/raw-frame`), and exports wait for the develop. Blackmagic Design Film Gen 5 and Blackmagic Wide Gamut are colour-managed input spaces, so **Start wide-gamut grade** builds its CSTs from them. API: `POST /api/media/:id/raw {settings}` (store `setCameraRaw`, MCP `act setCameraRaw`). Check: `node --experimental-strip-types --test server/braw.test.ts src/services/braw.test.ts`.

## Current limits

Preview processing is SDR, uses browser decoders and 8-bit canvas samples, and is capped at **1920 pixels wide**. Final exports use originals at the selected resolution. Browser and FFmpeg effects are separate implementations, so preview is not a calibrated, pixel-identical mastering monitor. Reverse video can be previewed, but reversed audio is heard in the export; extreme playback speeds may also mute browser audio. Preview noise reduction uses a gate; exports use spectral denoising.

Preview quality selects both the stream and the compositing resolution. Each video keeps three preview files: **`full-v3.mp4`** (up to 1920 wide, 10-bit 4:2:2, half-second GOP) for **Full** and **Color**, **`stream-v2.mp4`** (960 wide, 2-second GOP) for **Auto · streaming** and **1/2**, and **`stream-low-v2.mp4`** (480 wide, half-second GOP, capped at 900 kbit/s) for constrained connections and **1/4**, which also feeds paused scrubbing, hover previews and the timeline filmstrip. Audio tracks use an audio-only stream. Camera originals and export quality are retained.

Forward MP4 playback decodes pictures in WebCodecs workers and retains bounded queues for the current and upcoming clips. Browser storage automatically caches required byte ranges with a rolling budget. Green indicates verified locally saved bytes; frame preparation is shown separately. Auto mode also prepares server-rendered sections when sustained effects processing exceeds the frame budget. See [playback architecture and reproducible checks](remote-media-loading.md).

**Full and Color read `full-v3.mp4`**: H.264 High 4:2:2 10-bit at CRF 17, about 7 Mbit/s for 1080p and 12 Mbit/s for 4K60 log. Chrome decodes it in software through WebCodecs as `I422P10`, so grading reads 10-bit planes; treat it as a local-network grading reference rather than a viewing format.

Prepared media takes roughly **15–20% of the source size** (measured on the production library: about 96 GB of older previews became about 17–20 GB). **Older imports are migrated at startup** (`server/mediaMigration.ts`): one asset at a time on the media queue, each output verified with ffprobe before the row moves to it and the old `proxy.mp4`, `proxy-v2.mp4`, `color-v1.mp4`, `proxy-half-v1.mp4`, `proxy-quarter-v1.mp4` and `stream-low-v1.mp4` are deleted. It skips an asset when free space is under its estimated output plus the server's disk reserve (`FRAME_LINE_MIN_FREE_GB`, 5 GB), and a hard restart only leaves a temp folder, swept within the hour. Builds before storage v3 cannot play migrated assets (their old file names are gone).

Prepared media, overlays and hashed bundles are served immutable with a strong ETag, so a viewer re-uses its cached copy instead of re-fetching the footage on every page load. Preview compositing is capped at the timeline frame rate, and clips are warmed at most a few seconds ahead — and not at all while the picture on screen is still loading.

Sony S-Log3 and Canon Log/Log 2/Log 3 support, a managed SDR viewing transform, serial RGB grading, and Resolve bundle imports with resumable source uploads are implemented. See [Resolve and camera color](resolve-color.md) for the workflow and fidelity limits. HDR delivery, AI-generated grading or skin isolation, and separate subtitle-file export are not implemented. The grade assistant offers local rule-based SDR suggestions. Unsupported controls are unavailable or produce a clear error; they do not silently become an exported effect.

Project save requests are capped at **20 MiB**. Exports run on a dedicated serial worker and take priority over queued media preparation. Media preparation runs one job per four CPU cores (capped at eight, override with `FRAME_LINE_MEDIA_JOBS`), each given an equal share of the threads; already-running media jobs may overlap an export, and new background work waits for exports.

**Upload over the LAN, not the tunnel.** The client posts to whatever origin the page was opened from, so browsing `sharedcut.com` on the machine that *hosts* SharedCut sends every byte out to Cloudflare and back down the tunnel, capped by the household's upload link. Measured on the same 200 MB file: **about 60 s through the tunnel against 3.1 s to `http://127.0.0.1:4310`**. For a large ingest, open the server directly on its host or LAN address; uploads are resumable, so an in-flight transfer survives the switch. Export progress and elapsed time update live. An export range supports up to 128 clips, six hours, and dimensions up to 4096 × 4096; reverse segments are limited to 60 seconds. Queued and interrupted exports with saved snapshots resume after a server restart. Interrupted media preparation is marked failed and can be retried. Watch disk space and keep backups; there is no automatic retention or backup service.

## Back up and restore

Stop the server, then copy the **entire configured data directory** to private backup storage. Keep the SQLite database and any WAL/SHM files together with `media/` and `renders/`. Copying only a live SQLite file is not a complete or reliable backup.

To restore, stop the service, restore that complete directory, point `FRAME_LINE_DATA` to it, and restart. The directory contains credentials, active sessions, project history, and original footage; restrict access to it and its backups. Browser recovery drafts are only a fallback for unsaved edits, not the authoritative project archive.

## Checks

```sh
npm test
npm run build
npm run test:browser
```

The Node tests cover editing, merging, permissions, authentication, snapshots, locks, media preparation, and actual exported media. FFmpeg integration tests report a skip if the media executables are unavailable; run them with FFmpeg installed before accepting a deployment.

Browser QA requires an existing **Playwright installation with Chromium** and a current production build. If Playwright is installed outside this repository, point `PLAYWRIGHT_MODULE` at its module entry file:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:browser
```

The browser check uses a temporary server and data directory. It exercises signup, uploads, decoded playback, edits, snapshots, concurrent users, conflict recovery, workspace fit at several window sizes, and a real export. Screenshots are written to `artifacts/qa/`.

`npm run test:transitions` uses the same Playwright setup to check the transition system end to
end against a real cut: that playback through a window never seeks a decoder backwards, that a
zoom-out's mirrored surround leaves no black edge, that a shutter measurably smears the fastest
moment without banding, that a cut with handles on one side only still takes a transition, that
selecting a transition highlights the transition alone, that the chip passes behind the track-name
column, and that all 25 non-overlay transitions paint a real frame inside their window.

`npm run test:presence` uses the same Playwright setup to check cursor and panel stability with background tabs, shared edits, clock differences, delayed packets, and a stalled request. Presence is scoped to each tab and login session; when one account is active on several devices, the first active source stays visible until it becomes inactive, leaves, or expires.

The imported-footage benchmark, its measured results, and constrained-network commands are documented in [Newspaper playback measurements](playback-performance.md).

## Keyboard controls

| Shortcut | Action |
| --- | --- |
| Space | Play / pause |
| Left / Right | Previous / next frame |
| Cmd/Ctrl + Z | Undo your latest eligible action |
| Cmd/Ctrl + S | Save snapshot |
| Cmd/Ctrl + B | Split selected clip |
| Cmd/Ctrl + C / V | Copy / paste a clip |
| Cmd/Ctrl + D | Duplicate selected clip |
| I / O | Mark export In / Out |
| V / B | Selection / blade tool |
| T | Draw a text box in the viewer |
| N | Toggle snapping |
| Cmd/Ctrl + T | Add the default transition at the nearest cut |
| Delete / Backspace | Delete selected clip |
| Escape | Close a dialog or menu |

Shortcuts do not intercept typing in forms or dialogs. Desktop editing is the primary target.

See [the architecture](architecture.md) for implementation details. The [product design](product-design.txt) and [original prompt](original-prompt.txt) are preserved as design archives; they describe aspirations beyond the current release. Bundled demonstration photography is credited in [media credits](media-credits.md).

## Titles and shared fonts

The Titles library includes 12 editable presets. Click a preset to add a five-second title at the playhead, or press **T** and drag in the viewer to create a text box. Drag the box to move it and its handles to resize it. Double-click a box (or press Enter while it is focused) to open the text editor. The inspector also has a text editor.

Highlight characters to change only their font, size, weight, tracking, color, italic, or underline. With no highlight, formatting applies to the whole selected layer. Shift-click text boxes or timeline clips to select multiple titles. Mixed values display a dash or crossed-out label; entering a value overrides all selected text. Line height, alignment, position, dimensions, and opacity apply to whole boxes. Drag numeric values horizontally; hold Shift for fine adjustments. Title edits use existing autosave, collaboration conflict handling, snapshots, and personal undo.

The font picker detects common installed system fonts. **Browse this computer** requests the browser's Local Font Access permission to list the full collection (Chrome/Edge on localhost or HTTPS). Other browsers retain the detected font list and file uploads. **Add shared font** accepts TTF, OTF, TTC, WOFF, and WOFF2 files up to 15 MB. Every signed-in account can contribute fonts they have permission to share. Font files and names live in the SQLite `fonts` table, deduplicated by content hash; open editors fetch new fonts within 15 seconds. This shares fonts with everyone on this server, across projects. Installed-only fonts are not automatically uploaded.

Exports rasterize text through `@napi-rs/canvas` using the same layout code as the preview, then composite it into the FFmpeg timeline. System fonts must exist on the server, or be uploaded and selected from Shared fonts. A missing export font produces a clear error rather than a silent substitution. Text boxes support up to 10,000 characters and 1,000 formatting runs; excess text clips to the box.

Run `npm run test:titles` with the same `PLAYWRIGHT_MODULE` setting as browser QA. Optionally set `PLAYWRIGHT_CHROME_PATH` to an installed Chrome executable and `TEST_FONT_PATH` to a font fixture (defaults to macOS Arial). This isolated check covers selected-character formatting, mixed values, numeric scrubbing, drawing/resizing, multi-selection, font upload and live loading in a second session, export, and reload.

## Transitions

The **Transitions** library has 26 built-in transitions plus a shared pack of light leaks and film
burns. Move the pointer across a card to scrub it over two sample stills; the card draws through
the same code the timeline uses, so the preview is the real implementation. Drag a card onto the
timeline and the nearest cut highlights and snaps, or press **⌘T** to place your default transition
at the cut nearest the playhead.

A transition is valid on a cut between two clips, at the head of a clip with nothing before it, or
at the tail of a clip with nothing after it — the last two fade to and from nothing.

**Nothing on the timeline moves.** A transition borrows frames from the trim handles the edit
already left unused: the outgoing clip plays a little past its out point and the incoming clip
starts a little early. No clip start, duration or track changes, so a transition never ripples an
edit out from under a collaborator.

Which side pays depends on where the window sits. The part **after** the cut comes out of the
outgoing clip's tail handle; the part **before** it comes out of the incoming clip's head. Handles
are routinely one-sided — a clip trimmed to the last frame of its media has no tail to lend — so a
dropped transition takes the alignment the cut can actually carry: centred whenever centred still
gives a usable window, otherwise sitting wholly before or after the cut on the side that has the
frames. Only a cut where neither clip has a spare frame is refused, and the message names the clip
to trim. The Inspector reports the room at the current alignment, and shortens rather than refuses
when the handles run a little short.

Transitions are grouped as Dissolves (cross, dip to black/white/colour, additive, grain), Optical
(blur, glow bleed, camera flash), Motion (push in four directions, slide over, whip pan, zoom in,
zoom out, whip zoom, spin, impact shake), Wipes (linear, iris, barn door), Stylized (RGB split,
luma wipe) and Overlays.

Motion transitions carry **baked motion blur** driven by a shutter-angle parameter. Blur is what a
shutter actually does — the frame averaged over many instants — so both the preview and the export
composite the move at sub-shutter positions and average those.

Sizing that shutter is the whole game. The sample count follows how far the picture travels **in
the frame being drawn**, not how far it travels end to end: a window on an eased curve moves far
faster through its middle than its average suggests, and the middle is exactly where an
under-sampled stack stops reading as a smear and starts reading as steps. Whatever spacing is left
between samples is closed with a blur of half that gap, which is what merges them into one
continuous streak. The smear follows the real motion, so it is radial on a zoom and tangential on a
spin rather than locked to one axis.

Zoom, spin and shake mirror-pad the frame, so pulling back reveals reflected surroundings rather
than black. The reflection repeats every two frames, so the surround is drawn as one repeating
pattern and stays filled at any depth.

The preview samples fewer positions than the export to stay interactive, so the rendered blur is
finer than the preview's; both read the same shutter and curve.

Select a transition to edit it in the Inspector's **Transition** tab: duration, alignment, an
editable Bézier timing curve, and the transition's own parameters. Drag the bowtie's edges on the
timeline to change its length, or its body to change alignment.

### Light leaks and overlays

Overlay transitions screen-blend a real film burn over the cut and carry its own sound. The pack is
shared across every project on the installation, like shared fonts, and lives in
`FRAME_LINE_DATA/transitions/` rather than in any project's media.

Build the pack by cutting compilation reels at their black frames:

```sh
node scripts/extract-transitions.mjs --out data/transitions "reel.mp4"
```

Each leak in these reels starts and ends on black, so black runs mark the boundaries. Reels that
flicker to black *inside* a burn would over-segment, so black shorter than `--min-gap` does not
split a leak and segments shorter than `--min-duration` are discarded; `--crop-bottom` with
`--crop-source` removes a burned-in watermark strip from one reel without leaving a hard edge.
Segments that never get brighter than deep grey are dropped as detection artefacts. The script
writes each clip, a poster frame, a nine-frame contact sheet under `sheets/`, and a manifest.
**Review the contact sheets and delete any bad cut before accepting the pack.** Use **Add overlay**
in the library to add further leaks or black-background clips later.

Each leak is cut, named in sequence (Leak 01, Leak 02 …) and measured: the script records where
the burn is brightest, and the transition places the cut there instead of at a blind halfway
point. That moment ranges from about a fifth to four fifths of the way through depending on the
leak, which is why a fixed midpoint felt out of sync with the picture.

A leak's sound plays with the transition by default. Right-click the transition and choose **Expand
audio to track** to lift it onto the nearest free audio track as an ordinary clip you can trim,
fade and mix; the embedded copy mutes so it cannot play twice. Delete that clip and the embedded
sound returns.

Transitions are ordinary clip fields, so they ride the existing autosave, three-way merge, personal
undo, snapshots and collaboration locks with no separate history. A transition on a cut whose own
clips are keyframed cannot be exported and says so by name; keyframe animation elsewhere on the
timeline is fine, because each window is pre-rendered before the animated bake runs.

Run `npm test` for the window geometry, handle arithmetic, validation and real FFmpeg output,
including a light leak's picture and sound.

### Fades, keyframes, and close timeline work

Hover over a clip to drag its top fade handles. Video handles control opacity; audio handles control volume. Fade duration is frame-snapped and does not trim the clip. The Inspector also exposes duration in seconds. Audio and video envelopes multiply the clip's animated gain/opacity. Dragging is previewed locally and committed as one undoable edit; Escape cancels a focused handle.

The arrow in each track's controls opens animation lanes. Choose a clip and **Animate property…**, or click a diamond beside an Inspector number. Once a property has a keyframe, edits at another playhead time add a keyframe. Transform, effect instances, color-node parameters, text box settings, individual text-run styles, content, and additional scalar clip properties use the same channel model. Numeric values have linear, hold, or cubic Bézier interpolation; colors interpolate RGB, and other text/switches hold their values. Expand a property to drag graph points and tangent handles, enter exact frames/values, select interpolation, or remove keys. Arrow keys move focused diamonds by one frame; Delete removes them.

**30f / 60f** show that many frames across the usable timeline width. Zoom supports a 15-frame view, Command-scroll, Ctrl-scroll, and trackpad pinch (including Safari gesture events). Normal two-finger horizontal scrolling pans. Zoom centers the playhead where timeline boundaries permit. Holding a dragged playhead near either edge continuously scrolls, accelerating toward the edge. Only visible ruler ticks and graph pixels are drawn at high zoom.

Animation uses clip-relative seconds at the project frame rate. Split, trim, overwrite, copy, undo, snapshots, server save and collaboration retain the channels. A shared evaluator drives preview and final export. Animated exports currently bake one frame at a time through the existing renderer to cover all properties; they are slower than static exports, and temporal effects restart per baked frame. Audio automation in these exports is sampled at the output frame rate.

**Resolve OTIO** downloads the timeline with native Resolve video fade lengths and original Resolve metadata. This is file exchange, not a live two-way connection. Import the OTIO as a new timeline in Resolve. Audio fades and arbitrary SharedCut property curves are retained as SharedCut metadata but are not translated into native Resolve controls; export video/audio to reproduce them there. The original DRP remains the grade source. Native Resolve video fade lengths are covered by a fractional-frame-rate round-trip check; native audio and arbitrary proprietary animation interchange remain unsupported.

Run `npm test` for animation evaluation, edit history, timing, interchange and real FFmpeg output checks. `node --experimental-strip-types scripts/animation-check.mjs` checks the UI using the same Playwright environment variables as `scripts/browser-check.mjs`.

## Captions

Open **Captions** in the left library. Choose one of 16 Cinema/Social presets; move across a thumbnail (or use arrow keys while focused) to scrub the same animated sentence. Click a preset to open the compact generation panel; drag the timeline selection or its edges to choose a range. Green clip segments show the selected audio. **Generate captions** accepts the whole edit or marked/custom range, an audible mix or source track, and 1–15 maximum words per line (default five). English speech is processed locally on the server with MLX Whisper large-v3, Silero speech detection, and WhisperX word alignment.

On an Apple Silicon Mac with Python 3.12 and FFmpeg, install the separate speech environment and download models once:

```sh
npm run setup:captions
```

`FRAME_LINE_CAPTION_PYTHON` can point to another prepared Python executable; `FRAME_LINE_WHISPER_MODEL` can override the MLX checkpoint. The default is `mlx-community/whisper-large-v3-mlx`. The current implementation targets English; it does not translate or label speakers. Jobs share the existing serial media queue, continue when the browser closes, and expose progress, cancellation, and retry. A server restart marks unfinished jobs interrupted. Completed transcripts remain available through the Captions library.

Generated lines live on the top Captions track. Deleting the last line removes its set registration; undo restores both. Overlapping generation offers Keep both or Replace overlapping sets. Replacement waits for a successful transcript and removes whole chosen sets, including any lines outside the new range. Select a line to edit its text, word timing, preset, size, position, color, or shadow in the Inspector. Entrance and exit durations accept 0–5 seconds (zero is instant); Apply timing to this set copies those durations to its other lines without changing their words or styles. Short lines clamp animation durations to their length. **Regroup lines** changes the maximum word count using existing timings and corrected words; it resets manual line breaks and per-line styles. Changing the number of words in an edited line creates approximate timings marked for review; the word timing controls can correct them. Regeneration replaces only the selected caption set, is undoable, and preserves other sets.

Source timing/audio edits mark affected sets out of date. Regeneration uses a new timeline snapshot; captions do not automatically follow arbitrary source rearrangements. Visual-only transform changes do not invalidate captions. Detection is conservative for nested compositions and track mix changes.

Caption preview and export share text layout and animation code. Motion presets sample a short shutter interval into a transparent layer, and word highlighting uses saved word timestamps. Export combines captions into one alpha movie rather than one FFmpeg input per line; the existing 128-source-clip limit still applies to footage. Speech preparation reuses the audio export rules with a tiny black video intermediate, in minute-sized sections; audio keyframe baking can take longer. No extra frontend or queue dependency is needed.

Bundled TikTok Sans, Montserrat and Barlow Condensed font files and their SIL Open Font License notices are in `public/fonts/`. These are served locally and registered with the export renderer.

```sh
node --experimental-strip-types --test src/services/captions.test.ts server/captions.test.ts
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:captions
```

The browser check uses a temporary project, actual local transcription of macOS-generated speech, nonzero range offsets, preset scrubbing, text edits, regrouping, stale warnings, responsive layout, persistence, and an actual export. It needs the local models installed. The render check covers all presets and more than 128 caption lines.

Brand assets in `public/brand/` are the supplied SharedCut logos and close-up timeline photograph. Historical `frameline` storage keys, database names, environment variables, and Resolve bridge filenames remain compatible with existing installations and projects.

The thumbnail/progress browser regression check is `node --experimental-strip-types scripts/media-import-progress-check.mjs` (requires Playwright and Chrome; set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHROME_PATH` if needed). Set `FRAME_LINE_LIVE_LINK_CHECK=1` to include a real YouTube download.

## Sound effects

Timeline and library waveforms use channel-safe peak windows (up to 200 per second, capped at 32,768 per file), with bars sized to the displayed width. Visual normalization makes quiet audio legible without changing playback gain; silence stays flat. Existing audio is upgraded in the background on server startup. SFX drops display their pending placement immediately and insert from the import response without waiting for a project poll.

The **SFX** tab in the editor's left panel contains the shared sound library. Click a row to play/pause (click again to resume); previews stop timeline playback, and starting the timeline pauses the preview. Drag a sound to an unlocked audio track or use **+** to insert at the playhead on a free audio track (creating one when necessary, without overwriting existing audio). Added sounds are ordinary project audio, with independent retained originals and normal undo, editing, playback, and export.

Right-click an audio-track clip and choose **Save as Sound Effect**. Name it, enter comma-separated tags, and choose a category or type a new category. Saving bakes the current trim and clip-level audio properties, effects, and keyframes using the existing export renderer into a 24-bit WAV. Track/master gain, pan, mute and solo are excluded. Audio automation has the same frame sampling and limits as existing exports. Saves run in the bounded media queue and continue after closing the panel; interrupted saves show an error after restart. The library accepts effects up to ten minutes long and holds up to 1,000 entries.

The catalog is shared with all authenticated accounts on this server. Adding or saving a sound requires editor access to the destination/source project. Originals, previews, provenance, and the catalog live in `FRAME_LINE_DATA/sfx`; include that directory in backups and cloud deployments. User-supplied sounds were confirmed by the operator for internal shared use. The 40 supplementary sounds come from Kenney's [Interface Sounds](https://kenney.nl/assets/interface-sounds) and [Impact Sounds](https://kenney.nl/assets/impact-sounds), both CC0; downloaded license files are retained in `data/sfx-sources/`. The original Downloads folder is unchanged.

Search combines exact names, original filenames, tags, and descriptions with text embeddings from `Xenova/all-MiniLM-L6-v2` (quantized, approximately 23 MB). The model runs on the server; audio and search text are not sent to a hosted inference service. Model files download from Hugging Face on first uncached search and remain in `sfx/models`; copy that directory for offline deployment. Embeddings are cached in `sfx/embeddings.json`. If model loading fails, the UI explicitly falls back to name and tag search. `scripts/sfx-catalog.json` records the supplied-name mapping, selected additions, categories, search descriptions, and sources. Conservative names are used where the original filename does not identify a specific sound.

To seed another installation, copy the full `sfx` directory, or download the two Kenney packs into `FRAME_LINE_DATA/sfx-sources/interface` and `impact` and run the importer while the server is stopped:

```sh
node --experimental-strip-types scripts/import-sfx.mjs '/path/to/supplied/sounds'
```

The importer skips already-ready entries with the same source and original filename and warms semantic search. Run `node --experimental-strip-types --test server/sfx.test.ts` for metadata, ranking, audio fidelity, storage and access checks. `node --experimental-strip-types scripts/sfx-check.mjs` exercises the seeded catalog in an isolated browser installation (requires Playwright; supports `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE_PATH`).

## Reference color rendering

See [Color pipeline research and validation](color-reference.md) for the source/proxy diagnosis, OpenColorIO/ACES 2 setup, precision previews, preserved-grade upgrade, validation evidence and limitations. Native ACES exports require `npm run setup:color` (included in Docker). `npm run test:color-reference` checks the independent reference renderer and real-media paths.
