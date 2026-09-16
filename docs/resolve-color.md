# Resolve and camera color

SharedCut reads a versioned export produced by Resolve itself. It never claims that a renamed JSON file is a native DRP. Open a DRP in Resolve, create an empty folder, and run this in the **Lua** console (Workspace → Console):

```lua
dofile("/absolute/path/to/resolve-export.lua")("/absolute/path/to/export-folder")
```

The script exports every timeline as OTIO, the source media manifest, 65³ grade LUTs, settled reference PNGs, and the original project with its stills/LUTs. It restores the previous timeline and playhead. Exporting references takes time; leave Resolve open. Pick a new folder for each revision. Imported project data does not contain the original footage.

On SharedCut's Projects screen, choose **Import Resolve**. Select the export folder to detect `project.frameline.json` automatically, then add the camera source folders and any separate audio files. Choose **Import as a new project for a clean slate** to retain the previous edit and start over from Resolve. Leave it unchecked to resume the prior import. Then import. Source names must be unique among the selected files; ambiguous names need deliberate relinking. Local source paths are retained as hints, never executed or read by the server. Originals upload in checksum-verified 8 MiB chunks and can resume after a browser or server restart by selecting the same bundle and files. Base looks and references are immutable; import another revision to replace them. The local staging script is a maintenance tool for preparing a migration without changing the live database.

Or import the same folder from a terminal on the machine holding the footage, which skips the browser upload entirely:

```sh
npm run import:resolve -- /absolute/path/to/export-folder
```

It asks for your SharedCut email and password, creates the project, stores the LUTs, reference stills, OTIO and DRP, and uploads every original named in the manifest in the same checksum-verified 8 MiB chunks. The project ID is derived from the bundle contents, so re-running the same folder resumes that import rather than creating a second project; use the browser’s clean-slate option for a new independent project from the same export, or export a new folder from Resolve for a new revision. Add `--server https://host` for a remote installation.

Projects start private. Once media is ready, use the existing project sharing and roles. Source interpretation, camera exposure/warmth, node order, RGB wheel channels, curves, bypass, and corrections are persisted in the same revisioned project document as the edit. They use existing permissions, locks, conflict detection, and personal undo. One pointer gesture stays one undo action across published server saves; newer conflicting edits from other users remain protected. A DRP is a snapshot, not a live connection to an open Resolve project.

## Color processing

- Inputs: Sony S-Log and S-Log2 with nominal D65 S-Gamut; Sony S-Log3 with S-Gamut3.Cine or S-Gamut3; Canon Log, Log 2 and Log 3 with independently selectable Cinema Gamut, Rec.709 or Rec.2020; ordinary SDR Rec.709.
- Detection: an exact embedded Sony camera profile string is reported as evidence. Untagged footage is not guessed to be log. Canon inputs currently require manual profile/gamut selection and verification against the camera recording settings.
- In the compatibility pipeline, camera exposure and warmth run before the viewing transform (or the imported Resolve look), allowing scene exposure changes before the SDR shoulder. Primary wheels and curves are subsequent display corrections.
- Imported Resolve LUTs already contain their color transforms. SharedCut does not apply a second input/output conversion. Original node names remain visible for reference; they are not editable replicas of proprietary Resolve controls.
- The **Start wide-gamut grade** action saves a recoverable snapshot and creates editable Input CST → Balance → Look → Output CST nodes. Corrections operate in DaVinci Wide Gamut / Intermediate; the output CST applies Gamma 2.4 / Rec.709 with optional SDR shoulder and saturation compression. Existing grades retain their compatibility pipeline. New grades use D65 gamut matrices. They are not an emulation of Resolve's proprietary tone mapper. The Sony and Canon equations use normalized full-range RGB after decoding; check recording/data-level conventions when comparing camera files.
- Browser preview uses a WebGL 2 shader for camera transforms and ordered corrections. Resolve base LUTs are parsed in a worker, cached on the GPU, and sampled with trilinear interpolation; upcoming shots prewarm before cuts. Drags update a small parameter texture instead of rebuilding a 65³ LUT. On HTTPS/localhost, supported VideoFrame YUV planes enter the shader directly, avoiding early RGB rounding. Browsers without VideoFrame use their RGB decoder path. Original-media exports sample the same CPU color equations into LUTs through FFmpeg, with floating-point color processing and 10-bit compositing before delivery encoding. LUT sampling and proxy precision still impose numerical approximation.
- Camera proxies retain their source full/limited range with an explicit YUV matrix; Sony metadata supplies BT.709 when the stream omits it. The proxy transfer tag is a browser transport convention, not a baked log-to-SDR conversion. Proxies remain 8-bit camera-encoded video; the displayed result and scopes are 8-bit SDR. Supported 10/12-bit VideoFrame YUV planes are graded before display quantization; the color footer reports the actual decoded precision, including the 8-bit RGB fallback. This is not a calibrated mastering monitor or an HDR delivery implementation. Browser/OS display management can affect perceived appearance. ProRes exports retain 10-bit output; H.264 uses 8-bit output.
- A 3D LUT cannot preserve spatial masks, tracking, temporal noise reduction, grain, arbitrary OFX, or all HDR tool behavior. Compare exported reference frames. Original DRP and OTIO retain the source project information.

The bridge imports cuts, source offsets, video/audio tracks, gaps, basic framing, video fades, and Resolve OTIO link-group identities. New video inserts create a separate linked soundtrack when the source has audio. Linked selection moves, trims, splits, copies, pastes, retimes and deletes the group atomically; the context menu can unlink or relink matching clips. Detached video never silently regains its embedded soundtrack after an audio edit or deletion. OTIO supplies exact rational source timing because some scripting API source-frame values round differently. Unsupported effects and ambiguous structures are reported or rejected. Audio bus processing, animated effects, arbitrary transitions and nested/multicam structures need additional conform work or a Resolve render. The original archive is preserved for finishing in Resolve.

## Validation

The [September 13 overhaul report](color-overhaul-validation.md) records the current workspace, scope, GPU and original-media export checks.

```sh
npm test
node scripts/verify-resolve.mjs /absolute/path/to/bridge-folder
```

The second command renders a frame from each shot through SharedCut's original-media renderer and compares it to Resolve's reference, writing `verification/comparison.json`. The numerical comparison uses downscaled RGB samples; it does not prove every frame or a whole node graph is identical. Camera equations also have deterministic middle-gray checks. Test an actual Canon recording before committing a Canon production workflow.

Sources: [Sony S-Log3 specification](https://download.pro.sony/FNGP/protein/1237494271390/1237494271406.pdf), [Canon Log white paper](https://downloads.canon.com/nw/learn/white-papers/cinema-eos/white-paper-canon-log-gamma-curves.pdf), [Colour's Canon transfer definitions](https://github.com/colour-science/colour/blob/develop/colour/models/rgb/transfer_functions/canon.py), and the scripting SDK bundled with Resolve 21.

## Deployment

The supplied Dockerfile packages the app, server, FFmpeg and a persistent data volume. `compose.yaml` binds only to localhost so an HTTPS reverse proxy can be configured at the chosen host. Set `FRAME_LINE_SIGNUP_CODE` before running `docker compose up --build -d`. Keep the whole `/data` directory together: the SQLite database alone is not a media backup. Back up SQLite consistently and retain originals, prepared proxies, fonts and Resolve assets. Do not expose the application without HTTPS and a registration access code on an Internet host.

Cloud deployment still needs the user's chosen server/domain and storage capacity. A LAN forward or a local browser URL is not a cloud deployment. Runtime behavior is tested locally; the container must be tested on the selected deployment host.

## Newspaper validation — September 11, 2026

The installed Newspaper project is public to registered accounts on this server. It contains 16 source assets, 25 video edits, their 25 linked camera-audio items, one music item, and five tracks. All 15 camera originals contain the exact Sony S-Log3/S-Gamut3.Cine marker. Existing timeline and grade edits were preserved when replacing the 15 proxies and restoring the 25 link groups.

The old proxy path changed full-range YUV to limited range without an explicit source matrix. A measured C0973 frame lost red/blue and gained green before grading. Rebuilt proxies retain the range and explicit matrix. Browser YUV conversion and camera transforms now run before the final RGB display quantization. No compensating green/magenta grade was added.

Hardware Chrome testing on the Apple M5 Pro compared all 25 full-resolution browser frames against Resolve's exported PNGs, using identical 160×90 area resampling. The worst mean absolute RGB error was 1.263 levels out of 255. This is a sampled numerical comparison, not a claim of identical display calibration or every-frame equivalence. The portable RGB fallback also passed its representative frame check. Sony and all three Canon profiles matched the CPU equations on the GPU test swatches, including camera exposure/warmth and multiple ordered wheel/curve nodes; real Canon camera footage has not yet been supplied.

A 120-frame pointer benchmark measured about 60 fps, 1.5 ms at the 95th percentile for pointer handling, and 21.1 ms to a painted update. Five consecutive edit crossings showed no loading overlays. Wheel, curve, slider and numeric-field undo passed across server saves; two accounts preserved concurrent edits. The full 2250-frame, 93.84375-second H.264/AAC export completed at 1920×1080 and 24000/1001 fps with BT.709 tags. General editing, linking/unlinking, roles, offline recovery and export browser tests also passed. Headless audio checks use a silent output sink to exercise the audio graph independently of CoreAudio devices.

Runnable checks:

```sh
npm test
npm run test:browser
node scripts/color-gpu-check.mjs
node scripts/color-browser-check.mjs /path/to/staged/import.json /path/to/data
```

The browser checks need Playwright installed or `PLAYWRIGHT_MODULE` pointing to its module; `PLAYWRIGHT_EXECUTABLE_PATH` can select hardware Chrome. Measurements are saved under `artifacts/qa/`. Project reference archives, originals and test captures are private workspace files excluded from container builds. Internet hosting remains pending a deployment destination.

## Imported look and copying grades

The Color node panel shows **DaVinci grade · LUT** above the correction nodes, with an Enable/Disable button. The LUT is applied before those nodes. If a wide-gamut grade replaced it, **Use imported look** saves a snapshot and restores the LUT without the conflicting CST nodes; Undo restores the previous grade.

In Color, select a shot and press **Command/Ctrl+C**, select the destination shot, then **Command/Ctrl+V**. This replaces its grade, including the imported LUT, bypass state, source interpretation, nodes, curves, effects, and grade animation. Timing, footage and non-color properties stay in place. Right-clicking a shot offers the same actions. Paste is one undoable edit and observes project permissions and locks. Copy grades within the same project. Editing workspace shortcuts still copy and paste clips.
