import { runWorkerProcess } from './processTree.ts';
import { gpuJob, heavyJob } from './workQueue.ts';
import { venvPython } from './platform.ts';
import { atomicJson, commitFolder, inputMatrix, maskAnalysis, maskSourceFingerprint } from './smartMask.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DEPTH_MAX_FRAMES, DEPTH_SEGMENT, depthAnalysisSize, depthRange, type DepthCapabilities, type DepthRun, type DepthSegment } from '../src/services/depth.ts';
import type { Clip, MediaAsset } from '../src/state/models.ts';

const defaultWorker = fileURLToPath(new URL('../scripts/depth.py', import.meta.url));
const defaultPython = () => process.env.FRAME_LINE_DEPTH_PYTHON || venvPython('.venv-mask');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
export class DepthError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const fail = (status: number, message: string): never => { throw new DepthError(status, message); };
const remove = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const regularFile = (path: string) => { try { const file = lstatSync(path); return file.isFile() && file.size > 0; } catch { return false; } };
const gigabytes = (name: string, fallback: number) => { const value = Number(process.env[name]); return (Number.isFinite(value) && value > 0 ? value : fallback) * 1024 ** 3; };
/** Measured on the Dell: about 18 KB of master and 5 KB of preview per frame; busier pictures cost more. */
const BYTES_PER_FRAME = 40 * 1024;

type Capabilities = DepthCapabilities & { workerIdentity?: unknown };
export type DepthRequest = { clip: Clip; asset: MediaAsset; sourcePath: string; from: number; to: number; joinOnly?: boolean };
type Job = Omit<DepthRun, 'next'> & { base: string; projects: string[]; used: number; bytes?: number };

const capabilityChecks = new Map<string, { request: Promise<Capabilities>; expiry: number }>();
/** `--check` starts Python and imports torch (seconds): a success holds for ten minutes, a failure is retried after 30 seconds. */
export function depthCapabilities(python = defaultPython(), worker = defaultWorker): Promise<Capabilities> {
  const id = `${python}\n${worker}`, cached = capabilityChecks.get(id);
  if (cached && Date.now() < cached.expiry) return cached.request;
  const entry = { request: checkCapabilities(python, worker), expiry: Date.now() + 30_000 };
  capabilityChecks.set(id, entry);
  void entry.request.then(result => { if (result.available) entry.expiry = Date.now() + 600_000; });
  return entry.request;
}
async function checkCapabilities(python: string, worker: string): Promise<Capabilities> {
  if (!existsSync(python) || !existsSync(worker)) return { available: false, reason: 'Depth is not installed on this server. Run npm run setup:depth.' };
  try {
    const result = JSON.parse((await runWorkerProcess(python, [worker, '--check'], AbortSignal.timeout(120_000), undefined, 'Depth')).trim().split('\n').at(-1)!);
    return { available: result.available === true && result.workerIdentity !== undefined, reason: result.reason, engine: result.engine, device: result.device, workerIdentity: result.workerIdentity };
  } catch (error) { return { available: false, reason: (error as Error).message }; }
}

function folderBytes(path: string) {
  let total = 0;
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  return total;
}

/**
 * Depth runs, one per source range. A run is keyed by what its pixels depend on (source fingerprint, the snapped
 * frame range, the analysis LUT and the worker), never by clip, so split or duplicated clips of one take share it.
 * Segments are served while the run is still going; the finished run is committed under its key, manifest last.
 */
export function depthService(directory: string, options: { sourceTimes: (clip: Clip, asset: MediaAsset, sourcePath: string) => Promise<number[]>; python?: string; worker?: string; freeBytes?: () => number }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const python = options.python ?? defaultPython(), worker = options.worker ?? defaultWorker;
  const freeBytes = options.freeBytes ?? (() => { const disk = statfsSync(directory); return disk.bavail * disk.bsize; });
  const jobs = new Map<string, Job>(), controllers = new Map<string, AbortController>(), partials = new Map<string, string>(), holds = new Map<string, number>();
  let queue = Promise.resolve(), closed = false;
  const save = (job: Job) => { jobs.set(job.key, job); atomicJson(join(directory, `${job.key}.job.json`), job); };
  const manifestPath = (key: string) => join(directory, key, 'manifest.json');
  /** A cancelled queued run gives its key up at once, so a stale queue entry must not drop a newer run's controller. */
  const release = (key: string, controller: AbortController) => { if (controllers.get(key) === controller) controllers.delete(key); };

  // Nothing runs before the service starts: every partial folder is an interrupted run, and every queued or
  // processing record is one that died with the last server.
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (name.startsWith('.partial-') || name.endsWith('.tmp')) { try { remove(path); } catch { /* Retried next start. */ } continue; }
    if (!/^[a-f0-9]{64}\.job\.json$/.test(name)) continue;
    try {
      const job = JSON.parse(readFileSync(path, 'utf8')) as Job;
      // A failure already shown before this start has been seen; its record (with up to 36,000 times) goes.
      if (['failed', 'cancelled'].includes(job.status)) { rmSync(path, { force: true }); continue; }
      if (['queued', 'processing'].includes(job.status)) Object.assign(job, { status: 'failed', error: 'The server restarted. Analyze depth again.', segments: [] });
      else if (job.status === 'ready' && !regularFile(manifestPath(job.key))) Object.assign(job, { status: 'failed', error: 'This depth analysis is missing. Analyze depth again.', segments: [] });
      if (job.status === 'ready') job.bytes ??= folderBytes(join(directory, job.key));
      save(job);
    } catch { /* A corrupt record is ignored; its folder goes below. */ }
  }
  for (const name of readdirSync(directory)) if (validKey(name) && jobs.get(name)?.status !== 'ready') { try { remove(join(directory, name)); } catch { /* Retried next start. */ } }

  /** Record first, then files: a folder a Windows handle keeps has no ready record, so it is never served and the
   *  next start removes it. Never throws, so a locked old run cannot fail the request or run that evicts it. */
  const evict = (job: Job) => {
    jobs.delete(job.key);
    try { rmSync(join(directory, `${job.key}.job.json`), { force: true }); rmSync(join(directory, job.key), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
    catch (error) { console.error('Depth cache eviction left files behind until the next start:', (error as Error).message); }
  };
  const evictable = () => [...jobs.values()].filter(job => job.status === 'ready' && !holds.get(job.key)).sort((a, b) => a.used - b.used);
  /** Least recently used runs go first until `need` more bytes fit under the cap; a held run, and the run just
   *  finished (`keep`), are never evicted. */
  const trim = (need = 0, keep?: string) => {
    const cap = gigabytes('FRAME_LINE_DEPTH_CACHE_GB', 3);
    let total = [...jobs.values()].reduce((sum, job) => sum + (job.status === 'ready' ? job.bytes ?? 0 : 0), 0);
    for (const job of evictable()) { if (total + need <= cap) break; if (job.key === keep) continue; total -= job.bytes ?? 0; evict(job); }
  };
  const makeRoom = (need: number) => {
    const floor = gigabytes('FRAME_LINE_DEPTH_MIN_FREE_GB', 2);
    const check = (free: number) => { if (free - need < floor) fail(507, `The server is low on disk space: ${(free / 1024 ** 3).toFixed(1)} GB free, and depth analysis keeps ${(floor / 1024 ** 3).toFixed(1)} GB free. Free some space and try again.`); };
    // The disk can be low for reasons depth cannot fix: then refuse without throwing the cache away for nothing.
    const reclaimable = evictable().reduce((sum, job) => sum + (job.bytes ?? 0), 0);
    if (freeBytes() + reclaimable - need < floor) check(freeBytes());
    trim(need);
    for (const job of evictable()) { if (freeBytes() - need >= floor) break; evict(job); }
    check(freeBytes());
  };
  const get = (projectId: string, key: string) => {
    const job = validKey(key) ? jobs.get(key) : undefined;
    if (!job || !job.projects.includes(projectId)) fail(404, 'Depth analysis not found.');
    job!.used = Date.now(); return job!;
  };
  /** `withTimes` false leaves out `times` (up to 36,000 numbers) for a poller that already has them. */
  const view = (job: Job, after = 0, withTimes = true): DepthRun => {
    // ponytail: a cursor past the end is from an earlier run of this key (it failed and was re-asked), so start over;
    // add a per-run id to DepthRun if the new run can overtake a poller's cursor between two polls.
    const from = after > job.segments.length ? 0 : Math.max(0, Math.floor(after) || 0);
    const { base, projects, used, bytes, ...run } = job;
    return { ...run, times: from || !withTimes ? [] : job.times, segments: job.segments.slice(from), next: job.segments.length };
  };

  async function analyse(job: Job, controller: AbortController, input: { sourcePath: string; sourceFingerprint: string; lut: string; dataLevels: string; yuvMatrix: string; seek: number | null; image: boolean; workerIdentity: unknown }) {
    if (closed || controller.signal.aborted) { release(job.key, controller); return; }
    const temporary = join(directory, `.partial-${job.key}-${randomUUID()}`);
    try {
      makeRoom(job.frames * BYTES_PER_FRAME); // It may have queued behind other work for a while.
      mkdirSync(temporary, { mode: 0o700 });
      partials.set(job.key, temporary);
      job.status = 'processing'; save(job);
      writeFileSync(join(temporary, 'analysis.cube'), input.lut, { mode: 0o600 });
      atomicJson(join(temporary, 'job.json'), { version: 1, key: job.key, input: input.sourcePath, output: temporary, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', first: job.first, frames: job.frames, seek: input.seek, image: input.image, width: job.width, height: job.height, analysisLutPath: join(temporary, 'analysis.cube'), dataLevels: input.dataLevels, yuvMatrix: input.yuvMatrix, workerIdentity: input.workerIdentity });
      await runWorkerProcess(python, [worker, join(temporary, 'job.json')], controller.signal, value => { job.progress = Math.round(value); }, 'Depth', message => {
        const mapping = message.mapping as Record<string, unknown> | undefined;
        if (mapping) {
          const { lo, hi, near, far } = mapping;
          if (![lo, hi, near, far].every(Number.isFinite) || !((hi as number) > (lo as number))) throw new Error('The depth worker returned an invalid value mapping.');
          Object.assign(job, { lo, hi, near, far });
        }
        if (message.segment !== undefined) {
          const n = job.segments.length, first = job.first + n * DEPTH_SEGMENT, count = Math.min(DEPTH_SEGMENT, job.frames - n * DEPTH_SEGMENT);
          if (message.segment !== n || message.first !== first || message.count !== count || !regularFile(join(temporary, 'preview', `${n}.mp4`)) || !regularFile(join(temporary, 'master', `${n}.mkv`))) throw new Error('The depth worker returned segments out of order.');
          job.segments.push({ n, first, count });
        }
      });
      if (controller.signal.aborted || closed) throw new Error('Depth analysis cancelled.');
      const manifest = JSON.parse(readFileSync(join(temporary, 'manifest.json'), 'utf8'));
      if (manifest.version !== 1 || manifest.first !== job.first || manifest.frames !== job.frames || manifest.width !== job.width || manifest.height !== job.height || !isDeepStrictEqual(manifest.segments, job.segments) || !isDeepStrictEqual(manifest.workerIdentity, input.workerIdentity) || manifest.lo !== job.lo || manifest.hi !== job.hi) throw new Error('The depth worker returned an invalid manifest.');
      if (maskSourceFingerprint(input.sourcePath) !== input.sourceFingerprint) throw new Error('The original media changed during analysis.');
      remove(join(temporary, 'job.json')); remove(join(temporary, 'analysis.cube'));
      const final = join(directory, job.key);
      if (existsSync(final)) remove(final); // Leftover of an interrupted commit; never served.
      await commitFolder(temporary, final, 'manifest.json');
      partials.delete(job.key);
      Object.assign(job, { status: 'ready', progress: 100, segments: manifest.segments, bytes: folderBytes(final), used: Date.now() }); delete job.error; save(job);
      trim(0, job.key);
    } catch (error) {
      if (job.status !== 'cancelled') Object.assign(job, { status: controller.signal.aborted || closed ? 'cancelled' : 'failed', error: (error as Error).message });
      job.segments = [];
      try { save(job); } catch { /* Keep the failure visible in memory if the disk is full. */ }
    } finally {
      partials.delete(job.key); release(job.key, controller);
      try { remove(temporary); } catch { /* A locked leftover is never served and goes at the next start. */ }
    }
  }

  const service = {
    get(projectId: string, key: string, after = 0, withTimes = true) { return view(get(projectId, key), after, withTimes); },
    /** Start (or join) the analysis covering `from`..`to` source seconds of the clip's original, plus handles.
     *  `joinOnly` (a viewer or reviewer) joins a covering run but never starts one. */
    async enqueue(request: DepthRequest): Promise<DepthRun> {
      const { clip, asset, sourcePath } = request;
      if (closed) fail(503, 'The server is stopping.');
      if (asset.id !== clip.mediaId || !['video', 'image'].includes(asset.kind)) fail(400, 'Depth works on video and image clips.');
      const dimensions = asset.resolution.match(/(\d+)\s*[×x]\s*(\d+)/) ?? fail(409, 'The media has no known size yet.');
      const image = asset.kind === 'image';
      const times = image ? [0] : await options.sourceTimes(clip, asset, sourcePath);
      let range = { first: 0, frames: 1 };
      if (!image) { try { range = depthRange(times, request.from, request.to); } catch (error) { fail(400, (error as Error).message); } }
      if (range.frames > DEPTH_MAX_FRAMES) fail(400, `Depth analyzes at most ${DEPTH_MAX_FRAMES.toLocaleString('en-US')} frames at once. Split the clip.`);
      const capabilities = await depthCapabilities(python, worker);
      if (closed) fail(503, 'The server is stopping.');
      if (!capabilities.available) fail(503, capabilities.reason || 'Depth analysis is unavailable.');
      const size = depthAnalysisSize(Number(dimensions![1]), Number(dimensions![2]));
      const analysis = maskAnalysis(clip, asset), sourceFingerprint = maskSourceFingerprint(sourcePath);
      const base = hash([sourceFingerprint, analysis.identity, capabilities.workerIdentity, size, image]);
      const key = hash([base, range.first, range.frames]);
      // No awaits from here on: a second request for the same source sees this one's job.
      const covering = [...jobs.values()].filter(job => job.base === base && ['ready', 'queued', 'processing'].includes(job.status) && job.first <= range.first && job.first + job.frames >= range.first + range.frames && (job.status !== 'ready' || regularFile(manifestPath(job.key))))
        .sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready') || a.frames - b.frames)[0];
      if (covering) {
        if (!covering.projects.includes(clip.projectId)) { covering.projects.push(clip.projectId); save(covering); }
        covering.used = Date.now(); return view(covering);
      }
      if (request.joinOnly) fail(409, 'Depth for this clip is not analyzed yet. It starts when an editor opens the project.');
      if (controllers.has(key)) fail(409, 'The previous depth analysis is still stopping. Retry shortly.');
      if ([...jobs.values()].filter(job => ['queued', 'processing'].includes(job.status)).length >= 8) fail(429, 'The depth queue is full. Retry shortly.');
      makeRoom(range.frames * BYTES_PER_FRAME);
      const job: Job = { key, base, status: 'queued', progress: 0, mediaId: asset.id, first: range.first, frames: range.frames, times: times.slice(range.first, range.first + range.frames), width: size.width, height: size.height, lo: 0, hi: 1, near: 1, far: 0, segments: [], projects: [clip.projectId], used: Date.now() };
      save(job);
      const controller = new AbortController(); controllers.set(key, controller);
      const input = { sourcePath, sourceFingerprint, lut: analysis.text, dataLevels: String(clip.properties.dataLevels || 'auto'), yuvMatrix: inputMatrix(clip, asset), seek: range.first > 0 ? (times[range.first - 1] + times[range.first]) / 2 : null, image, workerIdentity: capabilities.workerIdentity };
      // ponytail: one depth process per server, behind any running GPU job; a device-aware pool only for multi-GPU hosts.
      queue = queue.then(() => gpuJob(() => heavyJob(() => analyse(job, controller, input), controller.signal), controller.signal)).catch(error => {
        release(key, controller);
        if (jobs.get(key) !== job || job.status === 'cancelled') return; // Cancelled while waiting, or asked again since.
        Object.assign(job, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: (error as Error).message, segments: [] });
        try { save(job); } catch { /* Disk full: the in-memory failure still shows. */ }
      });
      return view(job);
    },
    /** Another project still waiting on a shared run keeps it; this project just leaves it. */
    cancel(projectId: string, key: string) {
      const job = get(projectId, key);
      if (!['queued', 'processing'].includes(job.status)) return;
      if (job.projects.length > 1) { job.projects = job.projects.filter(project => project !== projectId); save(job); return; }
      const controller = controllers.get(key);
      controller?.abort();
      // A queued run has no worker to wait for: free the key now rather than when the queue reaches it.
      if (controller && job.status === 'queued') release(key, controller);
      Object.assign(job, { status: 'cancelled', error: 'Cancelled by you.', segments: [] }); save(job);
    },
    /** One preview segment, only once the worker has recorded it and only for a project bound to the run. */
    preview(projectId: string, key: string, n: number) {
      const job = get(projectId, key);
      if (!Number.isSafeInteger(n) || !job.segments.some(segment => segment.n === n)) fail(404, 'Depth segment not found.');
      const folder = job.status === 'ready' ? join(directory, key) : partials.get(key);
      const path = folder && join(folder, 'preview', `${n}.mp4`);
      if (!path || !regularFile(path)) fail(404, 'Depth segment not found.');
      return path!;
    },
    /**
     * For export: start or join the run covering the range, wait until it is ready, and hold it. `masters` is its
     * folder of master segments. Leaving (signal) does not cancel the run: the editor still wants it.
     */
    async ready(request: DepthRequest, signal?: AbortSignal, onProgress?: (percent: number) => void) {
      const { key } = await service.enqueue(request);
      for (;;) {
        if (signal?.aborted) throw new Error('Canceled by you');
        const job = jobs.get(key);
        if (!job) fail(410, 'The depth analysis was removed. Export again.');
        if (job!.status === 'ready') {
          job!.used = Date.now();
          return { run: view(job!), masters: join(directory, key, 'master'), release: service.hold(key) };
        }
        if (job!.status === 'failed' || job!.status === 'cancelled') fail(409, `Depth analysis ${job!.status === 'failed' ? 'failed' : 'was cancelled'}: ${job!.error ?? 'analyze depth again.'}`);
        onProgress?.(job!.progress);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },
    /** Keeps a ready run from eviction while an export reads its masters; call the returned function when done. */
    hold(key: string) {
      holds.set(key, (holds.get(key) ?? 0) + 1);
      let released = false;
      return () => { if (released) return; released = true; const count = (holds.get(key) ?? 1) - 1; if (count > 0) holds.set(key, count); else holds.delete(key); };
    },
    async close() {
      closed = true;
      for (const [key, controller] of controllers) { controller.abort(); const job = jobs.get(key); if (job && ['queued', 'processing'].includes(job.status)) { Object.assign(job, { status: 'cancelled', error: 'Server stopped.', segments: [] }); save(job); } }
      await queue;
    },
  };
  return service;
}
