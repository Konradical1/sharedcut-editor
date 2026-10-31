// Noise Reduction (docs/superpowers/specs/2026-10-15-noise-reduction-design.md): the server half. scripts/denoise.py does
// the maths; this file picks what it reads and writes. Preview chunks come from one resident `--serve` worker, export bakes
// from one-shot jobs; both decode the camera original and never convert its colour.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statfsSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitStart, killProcessTree, runWorkerProcess, trackChild } from './processTree.ts';
import { JOB_COST_BYTES } from './hostGuard.ts';
import { gpuJob, heavyJob } from './workQueue.ts';
import { renameWithRetry, venvPython } from './platform.ts';
import { depthDiskFloor } from './depth.ts';
import { trimFlowCache } from './opticalFlow.ts';
import { decodeAccel, previewEncode } from './media.ts';
import { denoiseChunkFrames, denoiseKeys, type DenoiseAllStatus, type DenoisePreview, type DenoiseSettings, type DenoiseView } from '../src/services/denoise.ts';
import { effectDefinitions } from '../src/services/effects.ts';
import { isHdrTransfer } from '../src/services/color.ts';
import type { MediaAsset } from '../src/state/models.ts';

export const denoisePython = () => process.env.FRAME_LINE_DENOISE_PYTHON || venvPython('.venv-mask');
// Overridable so the server tests can run a stand-in worker without torch.
export const denoiseWorker = () => process.env.FRAME_LINE_DENOISE_WORKER || fileURLToPath(new URL('../scripts/denoise.py', import.meta.url));
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = () => process.env.FFPROBE_PATH || 'ffprobe';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gigabytes = (name: string, fallback: number) => { const value = Number(process.env[name]); return (Number.isFinite(value) && value > 0 ? value : fallback) * 1024 ** 3; };
const threads = () => Math.max(2, Math.floor(cpus().length * 3 / 4));
const regularFile = (path: string) => { try { const file = lstatSync(path); return file.isFile() && file.size > 0; } catch { return false; } };
/** Read again: the preview trim keeps what was used last. */
const touch = (file: string) => { try { const now = new Date(); utimesSync(file, now, now); } catch { /* Gone already: the next ask prepares it again. */ } };
/** A Windows lock from a killed encoder must not replace the real error; sweep() clears the folder later. */
const removeTemp = (temp: string) => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
const NOT_INSTALLED = 'Noise Reduction needs the denoise worker on this server. Run npm run setup:denoise.';
/** No message from a working worker for this long means it hung (a profile measures 12 frame pairs and reports each). */
const STALL_MS = 120_000, IDLE_MS = 600_000, CANCEL_MS = 10_000;

export class DenoiseError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const fail = (status: number, message: string): never => { throw new DenoiseError(status, message); };

type Capabilities = { available: boolean; reason?: string; engine?: string; device?: string; workerIdentity?: unknown };
let checked: { id: string; request: Promise<Capabilities>; expiry: number } | undefined;
/** `--check` starts Python and imports torch (seconds): a success holds for ten minutes, a failure is retried after 30 seconds. */
export function denoiseCapabilities(): Promise<Capabilities> {
  const python = denoisePython(), worker = denoiseWorker(), id = `${python}\n${worker}`;
  if (checked?.id === id && Date.now() < checked.expiry) return checked.request;
  const entry = checked = { id, request: checkCapabilities(python, worker), expiry: Date.now() + 30_000 };
  void entry.request.then(result => { if (result.available) entry.expiry = Date.now() + 600_000; });
  return entry.request;
}
async function checkCapabilities(python: string, worker: string): Promise<Capabilities> {
  if (!existsSync(python) || !existsSync(worker)) return { available: false, reason: NOT_INSTALLED };
  try {
    const result = JSON.parse((await runWorkerProcess(python, [worker, '--check'], AbortSignal.timeout(120_000), undefined, 'Noise Reduction')).trim().split('\n').at(-1)!);
    return { available: result.available === true && result.workerIdentity !== undefined, reason: result.reason, engine: result.engine, device: result.device, workerIdentity: result.workerIdentity };
  } catch (error) { return { available: false, reason: (error as Error).message }; }
}

/** Settings from a request, checked against the effect's own ranges and rounded so equal settings share a cache key. */
export function denoiseSettingsOf(raw: unknown): DenoiseSettings {
  if (!raw || typeof raw !== 'object') fail(400, 'Noise Reduction settings are missing.');
  const parameters = effectDefinitions['Noise Reduction'].parameters;
  return Object.fromEntries(denoiseKeys.map(key => {
    const value = (raw as Record<string, unknown>)[key], parameter = parameters.find(p => p.key === key)!;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < parameter.min || value > parameter.max || key === 'frames' && !Number.isInteger(value)) fail(400, `Noise Reduction ${parameter.label} must be between ${parameter.min} and ${parameter.max}.`);
    return [key, Math.round((value as number) * 1e6) / 1e6];
  })) as DenoiseSettings;
}

/** The planes the worker reads: native chroma layout at 16 bits, so it never resamples colour. RGB sources become 4:4:4. */
export const denoisePixfmt = (pixFmt = '') => /444|440|p41\d|^(gbr|rgb|bgr|argb|abgr|rgba|bgra|x2rgb|x2bgr)/.test(pixFmt) ? 'yuv444p16le' : /422|p21\d|nv16|nv20|v210|y21\d|uyvy|yuyv|yvyu/.test(pixFmt) ? 'yuv422p16le' : 'yuv420p16le';
const tag = (value: unknown) => typeof value === 'string' && /^[a-z0-9-]+$/.test(value) ? value : 'unknown';
type Source = { identity: unknown[]; width: number; height: number; pixfmt: string; colors: { range: string; matrix: string; primaries: string; transfer: string } };
const sources = new Map<string, Promise<Source>>();
/** probeMedia leaves out the pixel format and primaries; the worker needs both, and the size it decodes upright. */
export async function denoiseSource(input: string): Promise<Source> {
  const file = await stat(input), identity = [resolve(input), file.size, file.mtimeMs], id = JSON.stringify(identity);
  let entry = sources.get(id);
  if (!entry) {
    sources.set(id, entry = (async () => {
      const data = JSON.parse(await runWorkerProcess(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_streams', '-of', 'json', input], AbortSignal.timeout(60_000), undefined, 'Noise Reduction'));
      const video = data.streams?.[0];
      if (!video?.width || !video?.height) throw new Error('Noise Reduction found no picture in this source.');
      const rotation = Number(video.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? 0), upright = Math.abs(rotation) % 180 === 90;
      const pixfmt = denoisePixfmt(video.pix_fmt), rgb = /^(gbr|rgb|bgr|argb|abgr|rgba|bgra|x2rgb|x2bgr)/.test(video.pix_fmt ?? '');
      // FFmpeg turns RGB into Y′CbCr with BT.601 at video range; tag the planes as what they then are.
      const colors = { range: rgb ? 'tv' : tag(video.color_range), matrix: rgb ? 'smpte170m' : tag(video.color_space), primaries: tag(video.color_primaries), transfer: tag(video.color_transfer) };
      return { identity, width: upright ? video.height : video.width, height: upright ? video.width : video.height, pixfmt, colors };
    })());
    entry.catch(() => sources.delete(id));
    if (sources.size > 64) sources.delete(sources.keys().next().value!);
  }
  return entry;
}
const profilePath = (profiles: string, workerIdentity: unknown, source: Source, width: number, height: number) => join(profiles, `${hash(['denoise-profile-v1', workerIdentity, source.identity, [width, height]])}.json`);
/** Bakes this process is writing: a sweep never takes one, however long it runs. */
const baking = new Set<string>();
/** Leftovers of a job the server died in (dot-named temp files and folders); nothing writes one for longer than an hour. */
async function sweep(directory: string, now = Date.now()) {
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.startsWith('.') || baking.has(join(directory, name))) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info && info.mtimeMs < now - 3600_000) await rm(join(directory, name), { recursive: true, force: true }).catch(() => {});
  }
}
/** Export bakes beyond FRAME_LINE_DENOISE_BAKES_GB (default 60, about 4 minutes of 4K ProRes 422 HQ), oldest first, never one in `keep`. */
export async function trimDenoiseBakes(directory: string, keep: Set<string>) {
  await sweep(directory);
  await trimFlowCache(directory, keep, gigabytes('FRAME_LINE_DENOISE_BAKES_GB', 60), 'mov');
}

/** One-shot export bake of [range.from, range.to) of the original at full size, ProRes with the source's own colour tags. */
export async function denoiseBake(o: { name: string; input: string; directory: string; profiles: string; range: { from: number; to: number }; fps: number; frameRate?: string; duration: number; settings: DenoiseSettings; signal?: AbortSignal; onProgress?: (percent: number) => void; freeGpu?: () => void;
  /** The clip's Data levels override (Auto when unset): what the planes hold, whatever the file is tagged. */ dataLevels?: unknown; /** Bakes a running export reads: never evicted to make room. */ keep?: Set<string> }) {
  const capabilities = await denoiseCapabilities();
  if (!capabilities.available) throw new Error(`${o.name}: ${capabilities.reason || NOT_INSTALLED}`);
  const source = await denoiseSource(o.input), { width, height } = source;
  const total = Math.max(1, Math.round(o.duration * o.fps));
  // At or before range.from, so the clip's remapped sourceIn (media.ts: sourceIn - first / fps) never goes negative.
  const first = Math.min(total - 1, Math.max(0, Math.floor(o.range.from * o.fps + 1e-6)));
  const frames = Math.max(1, Math.min(total - first, Math.ceil((o.range.to - first / o.fps) * o.fps - 1e-6)));
  // ProRes 4444 keeps a 4:4:4 source's chroma; everything else fits 422 HQ. The tags are the source's own, never forced, except the
  // range: a MOV reads back as video range whatever the planes hold, so a full-range source is converted explicitly (left to FFmpeg,
  // whether it converts differs by version and command) and media.ts reads the bake's range. A Data levels override says what
  // the planes hold; the worker's raw input is tagged with that, so FFmpeg never converts on its own.
  const range = o.dataLevels === 'Full' ? 'pc' : o.dataLevels === 'Video' ? 'tv' : source.colors.range, colors = { ...source.colors, range };
  const full = source.pixfmt === 'yuv444p16le', levels = range === 'pc' ? ['-vf', 'scale=in_range=pc:out_range=tv', '-color_range', 'tv'] : range !== source.colors.range ? ['-color_range', 'tv'] : [];
  const codec = [...levels, '-c:v', 'prores_ks', '-profile:v', full ? '4' : '3', '-vendor', 'apl0', '-pix_fmt', full ? 'yuv444p10le' : 'yuv422p10le'];
  const key = hash(['denoise-bake-v1', capabilities.workerIdentity, source.identity, [width, height], o.settings, 'denoised', first, frames, codec]), output = join(o.directory, `${key}.mov`);
  if (existsSync(output)) { o.onProgress?.(100); return { key, output, first, frames }; }
  await mkdir(o.directory, { recursive: true, mode: 0o700 }); await mkdir(o.profiles, { recursive: true, mode: 0o700 });
  // ProRes 422 HQ is about half a byte a pixel a frame (4444 three quarters); measured 3.7 MB a 4K frame at 29.97.
  const need = frames * width * height * (full ? .75 : .5) + 512 * 1024 ** 2, floor = depthDiskFloor();
  const freeBytes = () => { const disk = statfsSync(o.directory); return disk.bavail * disk.bsize; };
  if (freeBytes() - need < floor) {
    // Old bakes are a cache: they give way, oldest first, never one a running export reads (as depth.ts makeRoom does), and so
    // do a killed server's leftovers from before this process started.
    await sweep(o.directory, Math.max(Date.now(), performance.timeOrigin + 3600_000));
    const bakes = await Promise.all((await readdir(o.directory)).filter(name => /^[a-f0-9]{64}\.mov$/.test(name) && !o.keep?.has(name.slice(0, -4))).map(async name => ({ name, ...await stat(join(o.directory, name)) })));
    for (const bake of bakes.sort((a, b) => a.mtimeMs - b.mtimeMs)) { if (freeBytes() - need >= floor) break; await rm(join(o.directory, bake.name), { force: true }); }
  }
  const free = freeBytes();
  if (free - need < floor) throw new Error(`${o.name}: not enough disk space to bake Noise Reduction: about ${(need / 1024 ** 3).toFixed(1)} GB needed, ${(free / 1024 ** 3).toFixed(1)} GB free, and ${(floor / 1024 ** 3).toFixed(1)} GB is kept free.`);
  const temp = await mkdtemp(join(o.directory, '.denoise-'));
  baking.add(temp);
  try {
    const out = join(temp, 'video.mov'), file = join(temp, 'job.json');
    await writeFile(file, JSON.stringify({ ffmpeg: ffmpeg(), input: o.input, inputArgs: await decodeAccel(), fps: o.frameRate || String(o.fps), first, frames, duration: o.duration, width, height, pixfmt: source.pixfmt, colors,
      settings: o.settings, view: 'denoised', profile: profilePath(o.profiles, capabilities.workerIdentity, source, width, height), encode: [...codec, '-y', out], threads: threads() }));
    await gpuJob(() => heavyJob(() => { if (capabilities.device === 'cuda') o.freeGpu?.(); return runWorkerProcess(denoisePython(), [denoiseWorker(), file], o.signal, o.onProgress, 'Noise Reduction'); }, o.signal), o.signal);
    if (!regularFile(out)) throw new Error('the denoise worker wrote no picture.');
    await renameWithRetry(out, output);
    o.onProgress?.(100);
    return { key, output, first, frames };
  } catch (error) { throw o.signal?.aborted ? new Error('Canceled by you') : new Error(`${o.name}: ${(error as Error).message}`); }
  finally { baking.delete(temp); await removeTemp(temp); }
}

/** Viewer quality → the preview file it plays, whose size and encode a chunk copies (playback.ts playbackUrl). */
const RECIPE: Record<string, 'full' | 'stream' | 'low'> = { Full: 'full', Color: 'full', Original: 'full', Stream: 'stream', '1/2': 'stream', '1/4': 'low' };
export const denoiseQualities = Object.keys(RECIPE);
/** FFmpeg's `w='min(n,iw)':h=-2`: never wider than `max`, the height rounded to an even number. */
const fit = ([width, height]: number[], max: number) => width <= max ? [width, Math.round(height / 2) * 2] : [max, Math.round(height * max / width / 2) * 2];
type Job = DenoisePreview & { projectId: string; clipId: string; generation: string; controller: AbortController; failedAt?: number; settled?: Promise<unknown> };
/** A Denoise all run: `keys` are its finished chunks, which the preview trim keeps. */
type Batch = DenoiseAllStatus & { controller: AbortController; keys: Set<string>; current?: string };
type Pending = { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; message: (message: Record<string, unknown>) => void };
type Resident = { child: ChildProcess; ready: Promise<string>; pending: Map<string, Pending>; idle?: ReturnType<typeof setTimeout> };

/** Preview chunks: one resident worker, chunk files in `directory/chunks`, profiles in `directory/profiles`. `freeGpu` lets an
 *  idle Smart Mask preview worker give its VRAM back before a CUDA chunk, as Depth does. */
export function denoiseService(directory: string, options: { freeGpu?: () => void } = {}) {
  const chunks = join(directory, 'chunks'), profiles = join(directory, 'profiles');
  for (const folder of [chunks, profiles, join(directory, 'exports')]) { mkdirSync(folder, { recursive: true, mode: 0o700 }); void sweep(folder); }
  const jobs = new Map<string, Job>(), batches = new Map<string, Batch>();
  // Denoise all runs not yet finished or stopped, so a server restart (a deploy) picks them up again instead of dropping them.
  const runsFile = join(directory, 'runs.json');
  const runs = (): Record<string, { timelineId: string; quality: string }> => { try { return JSON.parse(readFileSync(runsFile, 'utf8')); } catch { return {}; } };
  const keepRun = (projectId: string, run?: { timelineId: string; quality: string }) => { const all = runs(); if (run) all[projectId] = run; else delete all[projectId]; writeFileSync(runsFile, JSON.stringify(all), { mode: 0o600 }); };
  let resident: Resident | undefined, closed = false;
  const stop = (reason: string) => {
    const current = resident; if (!current) return; resident = undefined;
    clearTimeout(current.idle);
    for (const request of current.pending.values()) request.reject(new DenoiseError(503, reason));
    current.pending.clear();
    // Once the worker is gone a taskkill /T could hit whatever reused its PID (see runWorkerProcess).
    if (current.child.exitCode === null && current.child.signalCode === null) killProcessTree(current.child, 'SIGTERM');
  };
  const start = async (signal: AbortSignal) => {
    // Held for the worker's whole life: its interpreter, torch and decoders stay resident between chunks.
    const release = await admitStart({ kind: 'ai', costBytes: JOB_COST_BYTES.denoise, label: 'Noise Reduction', signal });
    if (closed) { release(); fail(503, 'The server is stopping.'); }
    const child = spawn(denoisePython(), [denoiseWorker(), '--serve'], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    trackChild(child);
    let released = false; const free = () => { if (!released) { released = true; release(); } };
    const current: Resident = { child, pending: new Map(), ready: new Promise<string>((ready, refuse) => {
      // Rejects even when the worker cannot be killed (stuck in the driver, so 'close' never comes).
      const startup = setTimeout(() => { refuse(new DenoiseError(504, 'The Noise Reduction worker did not start.')); if (resident === current) stop('The Noise Reduction worker did not start.'); }, STALL_MS); startup.unref();
      let buffered = '', errors = '';
      child.stdout!.on('data', data => {
        buffered += data; const lines = buffered.split('\n'); buffered = lines.pop() || '';
        for (const line of lines) {
          let message: Record<string, unknown>; try { message = JSON.parse(line); } catch { continue; /* Worker diagnostics. */ }
          if (!message || typeof message !== 'object') continue;
          if (message.ready) { clearTimeout(startup); ready(String(message.device ?? '')); }
          const request = typeof message.id === 'string' ? current.pending.get(message.id) : undefined; if (!request) continue;
          if (!('ok' in message) && !('error' in message)) { request.message(message); continue; }
          current.pending.delete(message.id as string);
          if (message.ok) request.resolve((message.result ?? {}) as Record<string, unknown>); else request.reject(new DenoiseError(422, String(message.error || 'Noise Reduction failed.')));
        }
      });
      child.stderr!.on('data', data => { errors = (errors + data).slice(-2000); });
      // A worker that died mid-write must not take the server with it.
      child.stdin!.on('error', () => {});
      child.on('error', error => { free(); clearTimeout(startup); refuse(error); if (resident === current) stop(error.message); });
      child.on('close', code => { free(); clearTimeout(startup); const reason = errors.trim().split('\n').at(-1) || `The Noise Reduction worker exited ${code}.`; refuse(new DenoiseError(503, reason)); if (resident === current) stop(reason); });
    }) };
    current.ready.catch(() => {});
    return resident = current;
  };
  /** One job on the resident worker. Cancelling asks the worker to stop and waits for it to say so, so the GPU stays its own until then. */
  const send = async (job: Record<string, unknown>, signal: AbortSignal, onMessage: (message: Record<string, unknown>) => void) => {
    if (signal.aborted) throw new Error('Cancelled.');
    const current = resident ?? await start(signal);
    const id = randomUUID();
    try {
      // A cancel stops waiting for a worker still starting (the next chunk can use it), so the GPU queue moves on.
      await new Promise<void>((resolveReady, rejectReady) => { const give = () => rejectReady(new Error('Cancelled.')); signal.addEventListener('abort', give, { once: true }); current.ready.then(() => resolveReady(), rejectReady).finally(() => signal.removeEventListener('abort', give)); });
      if (signal.aborted) throw new Error('Cancelled.');
      clearTimeout(current.idle);
      return await new Promise<Record<string, unknown>>((resolveJob, rejectJob) => {
        let stall: ReturnType<typeof setTimeout> | undefined, stopping: ReturnType<typeof setTimeout> | undefined;
        const settle = () => { clearTimeout(stall); clearTimeout(stopping); signal.removeEventListener('abort', cancel); };
        const arm = () => { clearTimeout(stall); stall = setTimeout(() => { current.pending.delete(id); stop('The Noise Reduction worker stalled.'); settle(); rejectJob(new DenoiseError(504, 'Noise Reduction stalled. Try again.')); }, STALL_MS); stall.unref(); };
        const cancel = () => { current.child.stdin!.write(JSON.stringify({ id, cancel: true }) + '\n'); stopping = setTimeout(() => { if (current.pending.has(id)) stop('Cancelled.'); }, CANCEL_MS); stopping.unref(); };
        current.pending.set(id, { resolve: result => { settle(); resolveJob(result); }, reject: error => { settle(); rejectJob(error); }, message: message => { arm(); onMessage(message); } });
        arm(); signal.addEventListener('abort', cancel, { once: true });
        current.child.stdin!.write(JSON.stringify({ id, job }) + '\n');
      });
    } finally {
      if (resident === current && !current.pending.size) { clearTimeout(current.idle); current.idle = setTimeout(() => { if (!current.pending.size) stop('Idle.'); }, IDLE_MS); current.idle.unref(); }
    }
  };
  const view = ({ controller, projectId, clipId, generation, failedAt, settled, ...preview }: Job): DenoisePreview => preview;
  const owned = (projectId: string, key: string) => { const job = jobs.get(key); if (!job || job.projectId !== projectId) fail(404, 'Noise Reduction preview not found. Prepare it again.'); return job!; };
  const service = {
    /** The chunk of source frames holding `chunk`, denoised at the size and encode of the file `quality` plays. A cache hit is
     *  ready at once; otherwise it is queued for the GPU and reported as preparing until it is. */
    async preview(o: { projectId: string; clipId: string; input: string; asset: MediaAsset; chunk: number; quality: string; view: DenoiseView; settings: DenoiseSettings }): Promise<DenoisePreview> {
      if (closed) fail(503, 'The server is stopping.');
      const output = RECIPE[o.quality] ?? fail(400, 'Invalid preview quality.'), fps = o.asset.fps;
      if (!(fps > 0)) fail(400, 'Noise Reduction needs a video source.');
      const { first, frames } = denoiseChunkFrames(o.chunk, fps, o.asset.duration);
      if (!Number.isInteger(o.chunk) || o.chunk < 0 || frames < 1) fail(400, 'Invalid preview chunk.');
      const capabilities = await denoiseCapabilities();
      if (!capabilities.available) fail(503, capabilities.reason || NOT_INSTALLED);
      const source = await denoiseSource(o.input), full = fit([source.width, source.height], 1920);
      const [width, height] = output === 'full' ? full : fit(full, output === 'stream' ? 960 : 480);
      // Original plays the camera original, which the viewer never tone-maps: an HDR chunk keeps its planes and tags as recorded.
      const asRecorded = o.quality === 'Original' && isHdrTransfer(o.asset.colorTransfer);
      const colour = { fps, colorMatrix: o.asset.colorMatrix, colorRange: o.asset.colorRange, colorTransfer: asRecorded ? undefined : o.asset.colorTransfer };
      const key = hash(['denoise-chunk-v1', capabilities.workerIdentity, source.identity, [width, height], o.settings, o.view, first, frames, output, colour, ...asRecorded ? ['as recorded'] : []]);
      const file = join(chunks, `${key}.mp4`), url = `/api/denoise/${key}/files/video.mp4?projectId=${encodeURIComponent(o.projectId)}`;
      const base = { key, from: first / fps, duration: frames / fps, fps, projectId: o.projectId, clipId: o.clipId, generation: JSON.stringify(o.settings) };
      let job = jobs.get(key);
      if (existsSync(file)) {
        if (job?.status !== 'ready') jobs.set(key, job = { ...base, status: 'ready', progress: 100, url, controller: new AbortController() });
        touch(file);
        return view(job!);
      }
      // A failure answers for ten seconds (the viewer shows it), then the next ask tries again. A ready one whose file the
      // trim took is prepared again.
      if (!job || job.status === 'ready' || job.controller.signal.aborted || job.status === 'failed' && Date.now() - (job.failedAt ?? 0) > 10_000) {
        // Moving a slider makes every chunk the clip was preparing stale; the next chunk of the same settings is not, nor one of
        // another quality or view (two viewers of one clip would otherwise cancel each other forever).
        for (const old of jobs.values()) if (old.clipId === o.clipId && old.status === 'preparing' && old.key !== key && old.generation !== base.generation) old.controller.abort();
        if ([...jobs.values()].filter(j => j.status === 'preparing' && !j.controller.signal.aborted).length >= 8) fail(429, 'The Noise Reduction preview queue is full.');
        const current: Job = job = { ...base, status: 'preparing', progress: 0, stage: 'queued', controller: new AbortController() }, signal = current.controller.signal;
        jobs.set(key, current);
        for (const [old, record] of jobs) { if (jobs.size <= 256) break; if (record.status !== 'preparing') jobs.delete(old); }
        current.settled = gpuJob(() => heavyJob(async () => {
          if (capabilities.device === 'cuda') options.freeGpu?.();
          const temp = await mkdtemp(join(chunks, '.denoise-'));
          try {
            const out = join(temp, 'video.mp4'), { filter, codec } = await previewEncode(output, colour, temp);
            const tags = asRecorded ? `,setparams=color_primaries=${source.colors.primaries}:color_trc=${source.colors.transfer}` : '';
            await send({ ffmpeg: ffmpeg(), input: o.input, inputArgs: await decodeAccel(), fps: o.asset.frameRate || String(fps), first, frames, duration: o.asset.duration, width, height, pixfmt: source.pixfmt, colors: source.colors,
              settings: o.settings, view: o.view, profile: profilePath(profiles, capabilities.workerIdentity, source, width, height), encode: ['-vf', filter + tags, ...codec, '-movflags', '+faststart', '-y', out], threads: threads() }, signal, message => {
              if (typeof message.progress === 'number' && Number.isFinite(message.progress)) current.progress = Math.max(0, Math.min(99, Math.round(message.progress)));
              if (message.stage === 'profile' || message.stage === 'denoise') current.stage = message.stage;
            });
            if (signal.aborted) throw new Error('Cancelled.');
            if (!regularFile(out)) throw new Error('The denoise worker wrote no picture.');
            await renameWithRetry(out, file);
          } finally { await removeTemp(temp); }
          Object.assign(current, { status: 'ready', progress: 100, stage: undefined, url });
          // ponytail: a Denoise all keeps its whole timeline's chunks past the 4 GB cap; check disk first if timelines get long.
          const keep = new Set([...jobs.values()].filter(j => j.status === 'preparing').map(j => j.key).concat(key, ...[...batches.values()].flatMap(b => [...b.keys])));
          await trimFlowCache(chunks, keep, gigabytes('FRAME_LINE_DENOISE_PREVIEW_GB', 4)).catch(error => console.error('Noise Reduction cache trim failed:', error));
        }, signal), signal).catch(error => Object.assign(current, { status: 'failed', failedAt: Date.now(), error: signal.aborted ? 'Cancelled.' : (error as Error).message }));
      }
      return view(job);
    },
    /** The finished chunk file, for its own project only: a cache hash alone never authorizes a download. */
    chunk(projectId: string, key: string) { owned(projectId, key); const file = join(chunks, `${key}.mp4`); if (!regularFile(file)) fail(404, 'Noise Reduction preview not found. Prepare it again.'); touch(file); return file; },
    /** A finished chunk stays: another viewer may be playing it. A failed one goes, so Retry asks again. */
    cancel(projectId: string, key: string) { const job = owned(projectId, key); if (job.status === 'ready') return; job.controller.abort(); jobs.delete(key); },
    /** Depth, Smart Mask or an export bake is about to take the GPU: an idle preview worker gives its memory back. */
    stopIdle() { if (resident && !resident.pending.size) stop('Stopped to free the GPU.'); },
    /** Denoise all: every chunk of `clips` at one quality, one chunk at a time so viewers' own chunks queue beside it. One run per
     *  project; a new one replaces it. A chunk a viewer cancelled (a scrub) is asked again; a failed clip stops at its error. */
    all(o: { projectId: string; timelineId: string; quality: string; clips: { clipId: string; input: string; asset: MediaAsset; settings: DenoiseSettings; chunks: number[] }[] }): DenoiseAllStatus {
      if (closed) fail(503, 'The server is stopping.');
      if (!RECIPE[o.quality]) fail(400, 'Invalid preview quality.');
      service.stopAll(o.projectId);
      const batch: Batch = { status: 'running', timelineId: o.timelineId, quality: o.quality, controller: new AbortController(), keys: new Set(), clips: Object.fromEntries(o.clips.map(c => [c.clipId, { done: 0, total: c.chunks.length }])) };
      batches.set(o.projectId, batch);
      keepRun(o.projectId, { timelineId: o.timelineId, quality: o.quality });
      const signal = batch.controller.signal;
      const one = async (item: typeof o.clips[number], chunk: number) => {
        for (let cancelled = 0; ;) {
          if (signal.aborted) return 'Stopped.';
          let answer: DenoisePreview;
          try { answer = await service.preview({ projectId: o.projectId, clipId: item.clipId, input: item.input, asset: item.asset, chunk, quality: o.quality, view: 'denoised', settings: item.settings }); }
          catch (error) { if ((error as DenoiseError).status !== 429) return (error as Error).message; await new Promise(r => setTimeout(r, 1000)); continue; }
          batch.current = answer.key;
          if (answer.status === 'preparing') await jobs.get(answer.key)?.settled;
          if (regularFile(join(chunks, `${answer.key}.mp4`))) { batch.keys.add(answer.key); return; }
          const job = jobs.get(answer.key);
          if (job?.status === 'failed' && job.error !== 'Cancelled.') return job.error ?? 'Noise Reduction failed.';
          if (++cancelled > 3) return 'Cancelled: the clip changed while it was denoising.';
        }
      };
      void (async () => {
        for (const item of o.clips) for (const chunk of item.chunks) {
          const error = await one(item, chunk);
          if (signal.aborted) return;
          if (error) { batch.clips[item.clipId].error = error; break; }
          batch.clips[item.clipId].done++;
        }
        batch.status = 'done';
        if (batches.get(o.projectId) === batch) keepRun(o.projectId);
      })();
      return service.allStatus(o.projectId);
    },
    allStatus(projectId: string): DenoiseAllStatus { const b = batches.get(projectId); return b ? { status: b.status, timelineId: b.timelineId, quality: b.quality, clips: b.clips } : { status: 'none', clips: {} }; },
    /** The Denoise all runs a stopped server left unfinished; the server starts each again with `all` (cached chunks are skipped). */
    resumable() { return Object.entries(runs()).map(([projectId, run]) => ({ projectId, ...run })); },
    /** Stops the run and the chunk it was waiting for; finished chunks stay. */
    stopAll(projectId: string) {
      keepRun(projectId);
      const b = batches.get(projectId); if (b?.status !== 'running') return;
      b.status = 'stopped'; b.controller.abort();
      const job = jobs.get(b.current ?? ''); if (job?.status === 'preparing') job.controller.abort();
    },
    async close() { closed = true; for (const b of batches.values()) b.controller.abort(); for (const job of jobs.values()) job.controller.abort(); stop('The server is stopping.'); },
  };
  return service;
}
