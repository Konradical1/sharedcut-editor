# FrameLine

The directory and the code say "FrameLine". **The product is called SharedCut**, after
sharedcut.com where it is hosted. Say SharedCut to Konrad and in anything user-facing; leave
the `FRAME_LINE_*` env vars, paths and LaunchAgent labels alone.

## Talking to Konrad
Short answers. Plain words. A few lines max.
No long explanations, no detail dumps, no lists of internals.
Say what happened or what to do, then stop. More detail only if asked.

## Deployment target — Lenovo, not cloud hosting

The Lenovo is the production deployment target. Do not plan cloud hosting or cloud
object-storage migration unless Konrad explicitly changes this decision. Keep
projects and media on the Lenovo; the Mac is the fallback. Prioritize the native Windows setup in docs/WINDOWS_NATIVE.md, including
portable captions, optical flow, Smart Mask setup, and NVIDIA acceleration.
The existing public-access tunnel does not change where the application or media
is hosted. See `docs/LENOVO_SETUP.md`.

## This server is moving to Windows — write nothing Mac-native

Today the backend runs on an Apple silicon Mac. It is moving to a Windows machine (a Lenovo
tower with an RTX 5060 Ti) and the Mac becomes a fallback. `docs/WINDOWS_MIGRATION.md` has the
full plan.

**Every feature added from now on must run on both.** This is not a later cleanup — a
Mac-only feature written today is a feature that breaks on the move. When you are about to
write something platform-specific, stop and pick a cross-platform route instead.

Rules, in order of how often they bite:

1. **No shelling out to macOS tools.** No `xcrun`, `sw_vers`, `mdls`, `afplay`, `caffeinate`,
   `osascript`, `sips`, `say`. No compiling against Apple frameworks (AVFoundation,
   VideoToolbox, CoreMedia, Metal). If a job needs a native helper, it needs one that builds
   on Windows too, or it does not ship.
2. **Build paths with `node:path`.** `join()` and `resolve()`, never string concatenation with
   `/`. Never hardcode `/Users/...`, `/opt/homebrew`, or `/tmp` — use `os.tmpdir()`.

2b. **Never interpolate a raw path into an FFmpeg filtergraph.** Argv paths are fine; a filter
   argument is not. The filtergraph parser reads `\` as an escape and `:` as an option separator,
   so `lut3d=file='C:\Users\...'` silently becomes garbage and fails the render. Use
   `filterPath`/`quotedFilterPath` from `server/platform.ts`. This broke every graded export on
   Windows and is the single easiest way to reintroduce the bug.
3. **Reach external binaries through an env var with a sane default**, the way the Python hooks
   already do: `FRAME_LINE_COLOR_PYTHON`, `FRAME_LINE_IMPORT_PYTHON`,
   `FRAME_LINE_CAPTION_PYTHON`, `FRAME_LINE_MASK_PYTHON`, `FFMPEG_PATH`. A venv interpreter is
   `.venv-x/bin/python` on macOS and `.venv-x\Scripts\python.exe` on Windows — the env var is
   what makes that somebody else's problem.
4. **Use `server/processTree.ts` for worker cancellation.** It terminates the
   complete decoder/encoder tree using taskkill on Windows and process groups
   on POSIX. Killing only Python leaves its media processes behind.
5. **No symlinks.** They need elevated privileges on Windows. Copy or hard-link instead.
6. **FFmpeg hardware acceleration must be detected, never assumed.** `server/media.ts` probes
   `ffmpeg -hwaccels` and degrades to software. Any new accel path does the same — VideoToolbox
   on the Mac, CUDA/NVDEC on Windows, software everywhere else.
7. **File modes (`0o700`, `0o600`) are no-ops on Windows.** Fine to keep, never rely on them
   for correctness.
8. **GPU work belongs in the browser where it can.** Color and motion preview are WebGL2 and
   run on the editor's machine, not the server. That code is already portable — keep new visual
   work there rather than adding server-side GPU dependencies.

**`server/opticalFlow.ts` is cross-platform.** Windows/Linux use the OpenCV worker
installed by `npm run setup:flow`; Mac retains VideoToolbox. Exact timestamp
schedules support freezes, deep slow motion and direction changes. Worker
process trees use `server/processTree.ts` for Windows-safe cancellation.
Tracked Smart Mask selections can be exported; do not advertise SAM as hair
or source-motion-blur matting.

If a feature genuinely cannot be done cross-platform, say so and ask before writing it
Mac-only.

## Every feature ships with its MCP surface

`mcp/` is the SharedCut MCP server (Claude/Codex control the editor through it; `mcp/README.md`). It runs
the editor store headless, so it can only do what the store and the API can do. **Any feature or change
you make must be reachable from it in the same commit.** That is not optional and not a follow-up.

- New or changed store action (a method on `EditorStore`): classify it in `ACTIONS` in `mcp/catalog.ts`.
  Give it a doc comment in the interface; `help actions` shows that comment to the model.
- New server route or job flow: a job in `mcp/jobs/<feature>.ts` (one-line `doc`) or an entry in `ROUTES`
  in `mcp/coverage.test.ts` saying why it needs none. New catalogs (effects, presets, kinds) are read from
  code; if a feature has non-obvious recipes, add them to that module's help `topics`.
- Keep it token-lean: one-line docs, compact results, ids as `@handles`. `mcp/server.test.ts` caps the tool list.
- `npm test` fails (`mcp/coverage.test.ts`) when a store action or route is missing from the MCP.

## Branches

- `main` — the Windows line. Merge target, and where the port lands.
- `mac` — the Apple silicon host in production today.

Work happens on `mac` while the Mac is still the live server. Merge `mac` into `main` often;
the two share ~95% of their code and long gaps make painful merges.

## Moving a project between machines

`data/` is ~240 GB (October 2026) and gitignored — projects do not travel through git.

```
node scripts/project-bundle.mjs export "Newspaper" ~/Desktop/newspaper-bundle
node scripts/project-bundle.mjs import ~/Desktop/newspaper-bundle
```

When the other machine already has the footage (the desktop app on a laptop holding the card), `export … --no-media`
sends only the edit, and `import … --originals <folder>` hard-links each clip found there by name and exact size. The
server prepares those clips on its next start.

Stop the server on both ends first. The import refuses to run while a server holds `data/`
(`data/frameline.lock`); the next server start picks the imported workspace row up.

## Workspace storage and restarts

Since 2026-09-30 the workspace lives one row per entity in `workspace_items` (`server/workspaceStore.ts`),
so a save writes only what changed. The old single JSON row `workspace.state` is still kept as a
copy for older builds and tools; scripts read through `scripts/workspace-db.mjs`, never that row.
Only one server may open a data folder: a second `npm start` beside the live one exits on purpose.

- Restart the live server with no UAC prompt: `schtasks /run /tn "SharedCut Restart"` (log in
  `logs\restart.log`). `.\scripts\windows-host.ps1 setup` re-creates that task (one prompt).
- Rolling back to a build older than the item tables (61b8d6b or earlier): stop the server, run
  `node scripts/sync-legacy-row.mjs`, then start the old build. Restarts are hard kills, so skipping
  this can start the old build from a copy missing the last edits.
- Media storage v3 (`server/mediaMigration.ts`) deletes `proxy.mp4`, `color-v1.mp4`, the all-intra
  half/quarter files and `stream-low-v1.mp4` once an asset is migrated. Any build older than storage v3
  then 404s on those clips: do not roll back past it, fix forward.
- Depth saves Depth subjects (`maskId` on a Depth effect) and depth keys (`mask.source: 'depth'`), which the save check of
  any build without Depth rejects. Once either exists, even in a restore backup, such a build refuses every save on the
  server: do not roll back past Depth, fix forward.
- Plan saves scripts, scriptBlocks, shots and boardItems. A build without Plan loads those rows and serves every account's
  Plan rows to everyone, unfiltered (private projects included). Once any exist, even in a restore backup, do not roll back
  past Plan: fix forward.
- Picture Noise Reduction renamed the audio effect to 'Audio Noise Reduction'. A build without it saves such clips but
  refuses any export that has one: do not roll back past it, fix forward.
- Color page v3 (`docs/color-grading-v3.md`) stores qualifier, window, log wheel, mixer and film keys in node parameters
  and HSL curves (`HueHue`…`SatLum`) in node curves. A build without v3 refuses to render those nodes and its save check
  rejects the curves: do not roll back past it, fix forward. Dehaze and Clarity add the `dehaze`/`clarity` node keys: a
  build without them refuses to render such nodes, so the same applies, fix forward. Preview, export and `grading.ts` must
  stay identical: change all three (and the pinned vectors in `src/services/grading.test.ts` and `detail.test.ts`) together.
- `node scripts/remote-playback-check.mjs` plays a timeline on sharedcut.com as a signed-in user and
  reports pictures/s, freezes and loading time; run it before and after any playback change.

## Desktop app (`desktop/`)

SharedCut Desktop runs this same server and `dist/` on the user's own computer, with bundled Node and FFmpeg and data
in the app's userData folder, so it works with no connection. A server or editor change ships in the next app build
too, and it must still run that way: no hard dependency on the Lenovo, the network or a Python venv for core editing.
The app starts `server/index.ts` on 127.0.0.1:41237 with `FRAME_LINE_STOP_WITH_STDIN`, so the server stops when the
app's pipe closes. Projects kept from sharedcut.com sync both ways through `server/remoteSync.ts` (`FRAME_LINE_REMOTE`):
live while online, a three-way merge after offline edits, with this computer winning a conflict. Projects made in the app go up
by themselves once it is signed in (`config.made`); one deleted on sharedcut.com is never made again (`config.linked`). Installers and update feeds are served from `<data>/downloads` at `/download/<file>`. The page is
sharedcut.com/download. Build, sign, check and publish: `desktop/README.md`.
