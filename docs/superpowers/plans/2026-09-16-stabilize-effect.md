# Stabilize Effect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `Stabilize` clip effect described in `docs/superpowers/specs/2026-09-16-stabilize-effect-design.md`: drag onto a clip, tune Smoothness and friends, preview in the player, export.

**Architecture:** A Python/OpenCV worker (`scripts/stabilize.py`) analyses a clip's used source range once (camera path JSON, cached) and renders stabilized proxies or a ProRes bake per settings (cached). `server/stabilize.ts` wraps it like `server/opticalFlow.ts`; `server/index.ts` exposes `/api/stabilize*` like the optical-flow routes; `server/media.ts` swaps the bake in as a synthetic asset like `renderFlowTimeline`; `src/services/stabilizePreview.ts` and `playback.ts` swap the proxy into the player like `flowPreview`. The stabilized media stays in **source time**, so speed, reverse and freeze keep working and do not invalidate the cache.

**Tech Stack:** Python 3 + `opencv-python-headless` + `numpy` in `.venv-stabilize`; Node 22 server; React/zustand client. ffmpeg via `FFMPEG_PATH`, Python via `FRAME_LINE_STABILIZE_PYTHON`.

## Global Constraints

- Cross-platform: no macOS tools or frameworks, no symlinks, paths via `node:path`, temp via `os.tmpdir()`, process-group kill only when `process.platform !== 'win32'` (copy `runMaskProcess` in `server/smartMask.ts`).
- Default interpreter: `.venv-stabilize/bin/python` on POSIX, `.venv-stabilize\Scripts\python.exe` on Windows, overridable by `FRAME_LINE_STABILIZE_PYTHON`.
- Effect name is exactly `Stabilize`. Parameters: `amount` (Strength, 100), `smoothness` (50), `cropMode` (0), `zoom` (10), `tripod` (0), `maxShift` (15), `maxAngle` (5).
- Stabilize + Smart Mask and Stabilize + optical flow on one clip are rejected with a message.
- Tests: `node --experimental-strip-types --test <file>`. Build check: `npm run build`.

---

### Task 1: Python worker

**Files:** Create `scripts/stabilize.py`, `scripts/stabilize-requirements.txt`, `scripts/setup-stabilize.py`. Modify `package.json` scripts (`setup:stabilize`, `test:stabilize`).

**Interfaces (produces):**
- `python scripts/stabilize.py --check` → last stdout line `{"available": true, "opencv": "<ver>"}`.
- `python scripts/stabilize.py --selftest` → exit 0 when the synthetic shake test passes.
- `python scripts/stabilize.py job.json` where job is
  `{"stage":"analyze","ffmpeg":str,"ffprobe":str,"input":str,"from":float,"to":float,"output":str}` or
  `{"stage":"render","ffmpeg":str,"ffprobe":str,"input":str,"path":str,"from":float,"to":float,"output":str,"preview":bool,"settings":{amount,smoothness,cropMode,zoom,tripod,maxShift,maxAngle}}`.
  Progress: stdout lines `{"progress": 0..100}`.
- `path.json`: `{"version":1,"width":int,"height":int,"fps":float,"from":float,"to":float,"frames":[[tx,ty,angle,logScale],...],"dropped":[int]}`; `frames[i]` maps frame i-1 → frame i in full-resolution pixels, frame 0 is identity.

- [ ] Write `scripts/stabilize.py`: `probe()`; `decode()` generator over an ffmpeg rawvideo pipe; `analyze(job)`; `corrections(path, settings)` returning per-frame 2×3 matrices; `render(job)` piping `rgb24`/`rgb48le` frames through `cv2.warpAffine` into an ffmpeg encoder (`libx264 -preset veryfast -qp 0 -pix_fmt yuv422p10le` preview, `prores_ks -profile:v 3` export); `selftest()`.
- [ ] Write requirements and `setup-stabilize.py` (venv.create, pip install, `--check`), `Scripts/python.exe` on win32.
- [ ] Add `setup:stabilize` and `test:stabilize` to `package.json`.
- [ ] Run `npm run setup:stabilize` then `--selftest`. Expected: exit 0.
- [ ] Commit: `feat: add OpenCV stabilization worker`.

### Task 2: Client registry and helpers

**Files:** Create `src/services/stabilize.ts`, `src/services/stabilize.test.ts`. Modify `src/services/effects.ts`, `src/components/Inspector.tsx:155`, `src/state/demo.ts:24`, `src/services/effects.test.ts`.

**Interfaces (produces):**
```ts
export const stabilizeChunkSeconds = 4;
export type StabilizeSettings = { amount:number; smoothness:number; cropMode:number; zoom:number; tripod:number; maxShift:number; maxAngle:number };
export function stabilizeEffect(clip: Clip): Effect | undefined;
export function stabilizeSettings(clip: Clip, effect: Effect): StabilizeSettings;
export function stabilizeRange(clip: Clip, sourceFps: number, sourceDuration: number): { from:number; to:number };
export function stabilizeChunk(sourceTimeValue: number, range: {from:number;to:number}): number;
export type StabilizePreview = { status:'preparing'|'ready'|'failed'; key:string; url?:string; error?:string; progress:number; from:number; duration:number; fps:number };
```
- [ ] Tests: `acceptsEffect` rejects `Stabilize` on titles, shapes, captions, compositions, audio; defaults; range for speed 200 over 2 s spans 4 s; chunk indexing.
- [ ] Implement; remove old checkbox and `stabilization` default.
- [ ] Run tests. Commit: `feat: register Stabilize effect`.

### Task 3: Server worker wrapper

**Files:** Create `server/stabilize.ts`, `server/stabilize.test.ts`.

```ts
export function stabilizePython(): string;
export function stabilizeCapabilities(): Promise<{available:boolean; reason?:string; opencv?:string}>;
export function runStabilizeProcess(command:string,args:string[],signal?:AbortSignal,progress?:(v:number)=>void): Promise<string>;
export function stabilizeAnalysis(opts:{input:string;directory:string;from:number;to:number;signal?:AbortSignal;onProgress?:(v:number)=>void}): Promise<{key:string;output:string}>;
export function renderStabilized(opts:{input:string;directory:string;from:number;to:number;settings:StabilizeSettings;preview:boolean;signal?:AbortSignal;onProgress?:(v:number)=>void}): Promise<{key:string;output:string}>;
export function trimStabilizeCache(directory:string, keep:Set<string>, limit?:number): Promise<void>;
```
- [ ] Tests: identity differs by settings/range; cache hit skips spawn; trim removes old `.mp4` only; env var respected.
- [ ] Implement with one serial promise chain. Run tests. Commit: `feat: stabilize server wrapper and cache`.

### Task 4: Routes

**Files:** Modify `server/index.ts` next to the optical-flow block (~line 965).

- [ ] `GET /api/stabilize/capabilities`; `POST /api/stabilize` (`{clipId,chunk,quality,fps,settings}`; 409 on settings mismatch; input by quality like flow; analysis over `stabilizeRange(geometry)`; render chunk `[from+4k, min(to, from+4k+4))`); `GET /api/stabilize/:key/video`; `DELETE /api/stabilize/:key`. Job map, 8-cap, generation abort copied from flow.
- [ ] Curl capabilities on an isolated `FRAME_LINE_DATA` server. Commit: `feat: stabilize preview routes`.

### Task 5: Export

**Files:** Modify `server/media.ts` (`videoFilters` skip; delete `p.stabilization` guard; dispatch guard; `renderStabilizedTimeline`), `server/media.test.ts`.

- [ ] Tests: Stabilize + Smart Mask rejects; Stabilize + opticalFlow rejects; with a fake worker via `FRAME_LINE_STABILIZE_PYTHON` the render produces a playable file.
- [ ] Implement bake → synthetic asset `stabilize-<clipId>` (`duration: to-from`, `hasAudio:false`), clip rewrite (`mediaId`, `sourceIn: geo.sourceIn-from`, effects minus Stabilize), flow-style audio companion, recurse; progress 0–45/45–100.
- [ ] Run tests. Commit: `feat: export stabilized clips`.

### Task 6: Player preview and Inspector

**Files:** Create `src/services/stabilizePreview.ts`. Modify `src/services/playback.ts`, `src/components/Inspector.tsx`.

- [ ] `createStabilizePreview(changed)` with `get(clip, sourceTimeValue, range, settings, fps, quality)`, `retain`, `dispose`.
- [ ] `playback.ts`: request chunk for `sourceTime(original,time)`, swap decoder like `flowDecoder`, seek to `sourceTime - record.from`, rate `|rate|*speed`, pause on reverse/freeze; warm next chunk; emit `frameline:stabilize`.
- [ ] Inspector: status line, mode labels for `cropMode` and `tripod`.
- [ ] `npm run build` clean. Commit: `feat: stabilize preview in the player`.

### Task 7: Docs and final check

- [ ] `docs/WINDOWS_MIGRATION.md` env var, `docs/architecture.md:59`, README setup line. `npm test`, `npm run build`. Commit: `docs: stabilize setup and migration notes`.
