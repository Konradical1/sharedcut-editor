# SharedCut

A self-hosted video editor that several people can edit in at the same time, in the browser.

The code still calls the project FrameLine in places (`FRAME_LINE_*` variables, database names). The product is SharedCut.

## What it does

- **Editing together.** Several people can work on one timeline at once. Each person sees the others' cursors, selections and playheads, and can follow a presenter. Short-lived locks protect a clip while someone drags it. Edits to different things merge on their own. When two people change the same field, the second person picks which version to keep. Each person's undo only reverses their own edits.
- **Timeline editing.** Trim, split, move, ripple and speed changes (including freeze and reverse), keyframes with Bézier curves, 26 built-in transitions, titles with per-character styling, shapes, compositions and markers.
- **Color.** Node-based grading with wheels, curves, qualifiers and windows. Managed color for Sony and Canon log footage through OpenColorIO/ACES. Imports grades from DaVinci Resolve, decodes Blackmagic RAW through Blackmagic's SDK, and shows video scopes.
- **Effects that run local models on the server.** Stabilize (OpenCV), optical-flow slow motion, Smart Mask subject tracking (SAM 2.1), depth effects such as lens blur and fog (Video Depth Anything), noise reduction and a motion tracker. Footage never goes to an outside AI service for these.
- **Audio.** Track mixer, clip effects, waveforms, and a shared sound-effects library with on-server text-embedding search.
- **Captions.** Local speech-to-text (Whisper with word-level alignment) turns speech into editable, animated captions.
- **Export.** Renders from the camera originals, not the preview files, to H.264, H.265 or ProRes. The timeline is split into parts that render in parallel and are joined without re-encoding. NVENC is used when an NVIDIA GPU is present.
- **Plan workspace.** A screenplay editor, shot list and mood board in the same project as the footage.
- **AI agents can edit projects.** An MCP server (`mcp/`) lets Claude Code, Codex or any MCP client cut, grade, caption and export real projects. Its edits appear live in open editors and can be undone like anyone else's. The standalone build is published as [sharedcut-mcp](https://github.com/Konradical1/sharedcut-mcp). There is also an optional color assistant. It sends shot measurements and a few small stills to a model (through the Codex CLI or the Claude API) and turns the answer into editable grade nodes.
- **Desktop app.** An Electron app for macOS (`desktop/`) runs the same server on the user's own computer, so editing works offline. Projects sync back to the shared server when the computer is online again.
- **Importing.** Final Cut Pro XML projects with their footage, DaVinci Resolve bundles, and resumable uploads of large camera files.

The detailed feature reference, settings and limits are in [docs/user-guide.md](docs/user-guide.md).

## How it works

```text
Browser (React + TypeScript)          Node server (no framework)
  Zustand store = the edit   <──/api──>  node:http, node:sqlite, scrypt sessions
  WebCodecs decode in workers            SQLite: accounts, projects, one row per entity
  Canvas + WebGL2 compositing            FFmpeg: preview files, waveforms, exports
  Service Worker footage cache           Python workers: OpenCV, PyTorch, OpenColorIO
            ▲                                         ▲
            └──── MCP server runs the same store ─────┘
```

- **Client.** `src/state/store.ts` holds the whole edit and every editing action. Playback decodes the preview files in the browser and composites them on a canvas. Color, depth and motion preview run in WebGL2 on the editor's own GPU.
- **Server.** `server/index.ts` is a plain Node HTTP server. It uses Node's built-in SQLite, crypto and TypeScript type stripping, so there is no build step on the server. FFmpeg prepares three preview files per video and renders the exports. The Python model workers run as child processes, and cancelling a job ends the whole process tree on both Windows and POSIX.
- **Sync.** Every save carries the revision it was based on and only the items that changed. If someone else saved first, the server answers 409 with the current state, and the client does a three-way merge by entity and field. A Server-Sent Events stream tells open tabs when a new revision exists. Presence and locks live in memory and expire on their own, so they never fill up the saved history.
- **Same code path for people and agents.** The MCP server runs the editor's store headless and saves through the same API as the browser. That keeps agent edits validated, mergeable and undoable in the same way.

[HOW-IT-WORKS.md](HOW-IT-WORKS.md) explains the main design decisions in plain language. [docs/architecture.md](docs/architecture.md) has the full detail.

## Engineering notes

- **Tests.** 163 test files (`*.test.ts` / `*.test.mjs`) run on Node's built-in test runner. 22 of them drive a real browser through Playwright. Another 40 `scripts/*-check.mjs` scripts run whole features end to end. For example, `browser-check.mjs` signs up, uploads real video, edits with two users, recovers from an offline conflict and downloads an export. About 68,000 lines of TypeScript in total, tests included.
- **Agent coverage is enforced by a test.** `mcp/coverage.test.ts` makes `npm test` fail if a new store action or server route can't be reached from the MCP server, so the agent interface can't fall behind the UI.
- **Playback.** Rapid scrubbing on 4K 10-bit footage first showed only 1.3–1.7 new pictures per second, with stalls over two seconds. After fixing seek and color-snapshot handling and adding smaller preview streams, it measured about 57–59 pictures per second, with p95 seek times of 50–67 ms (September 2026, [docs/playback-performance.md](docs/playback-performance.md)).
- **Export speed.** A 115-second, 4K-sourced export once took 78 minutes, and the server log now records where each export spends its time. Several changes followed. Optical flow was reworked to seek only the window it needs and to warp in parallel, which took one 1.7-second clip from 610 s to 12 s. Work outside the export range is skipped, clips are graded at their output size, and keyframed transforms stream through a single filter. Afterwards the same export finished in 551 s, partly thanks to reused caches. On a matched section, which is the fair comparison, time went from 62.5 s to 41.7 s ([docs/architecture.md](docs/architecture.md#export-speed-2026-10-05)).
- **Storage.** Preview storage v3 shrank the production library's previews from about 96 GB to about 17–20 GB. It migrates old media one asset at a time and deletes old files only after ffprobe has verified the new ones.
- **Uploads.** Uploading a 200 MB file through the public tunnel took about 60 s, against 3.1 s directly on the host. Uploads are resumable, so a large transfer can switch to the direct address partway through ([docs/upload-performance.md](docs/upload-performance.md)).
- **Preview matches export.** Titles and captions use the same layout code for preview and export. Color and depth keep the browser math and the export math in step with pinned test vectors and a parity check (`npm run test:depth:parity`). Each transition keeps its canvas preview and its FFmpeg recipe in one registry entry.

## Used for real

SharedCut runs on a self-hosted machine, and my school film crew uses it to edit our projects. Many of the fixes in the history came from problems we hit in real editing sessions, for example school Wi-Fi that re-signs TLS, slow tunnel uploads, and a server that needed to restart itself after a power blip.

## How I built this

I set the direction and requirements, made the design calls, and tested every feature in real editing sessions with my crew. AI coding agents (Claude Code and OpenAI Codex) wrote most of the code, which is why most commits carry a Co-Authored-By trailer. The specs and plans the agents worked from are in [docs/](docs/), especially [docs/superpowers/specs/](docs/superpowers/specs/). The standing rules the agents follow are in [CLAUDE.md](CLAUDE.md), for example that every feature must run on both macOS and Windows and must ship with its MCP surface.

## Running it locally

You need Node.js 22.18 or newer, plus FFmpeg and ffprobe on `PATH` (or set `FFMPEG_PATH` and `FFPROBE_PATH`).

```sh
npm install
npm run build
npm start          # http://localhost:4310
```

Create an account, create a project and upload footage. The server listens only on `127.0.0.1` by default. Before letting other computers connect, set `FRAME_LINE_SIGNUP_CODE`, because registration is open while it is unset.

For development, `npm run dev` starts the API on port 4310 and Vite on port 5173.

The model-based features each have a one-time setup script that creates a Python environment: `npm run setup:masks`, `setup:depth`, `setup:denoise`, `setup:stabilize`, `setup:flow`, `setup:tracker`, `setup:captions` and `setup:color`. On Windows, `npm run setup:windows` installs all of them, and `npm run doctor` checks them.

Checks:

```sh
npm test
npm run build
npx playwright install chromium && npm run test:browser
```

The MCP server is set up with `npm run mcp:setup` (see [mcp/README.md](mcp/README.md)).

## License

No license has been chosen, so the code is not licensed for reuse.
