import { runWorkerProcess } from './processTree.ts';
import { gpuJob, heavyJob } from './workQueue.ts';
import { venvPython } from './platform.ts';
import { atomicJson, commitFolder, inputMatrix, maskAnalysis, maskSourceFingerprint } from './smartMask.ts';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DEPTH_FOCUS_VERSION, DEPTH_MAX_FRAMES, DEPTH_SEGMENT, depthAnalysisSize, depthDistance, depthRange, matteMedian, smoothFocus, type DepthCapabilities, type DepthFocusTrack, type DepthRun, type DepthSegment } from '../src/services/depth.ts';
import type { SmartMaskManifest } from '../src/services/smartMask.ts';
import type { Clip, MediaAsset } from '../src/state/models.ts';

const defaultWorker = fileURLToPath(new URL('../scripts/depth.py', import.meta.url));
const defaultPython = () => process.env.FRAME_LINE_DEPTH_PYTHON || venvPython('.venv-mask');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
/** `retry`: the refusal clears by itself (a full queue, a key still stopping), so an export waits it out. */
export class DepthError extends Error { status: number; retry: boolean; constructor(status: number, message: string, retry = false) { super(message); this.status = status; this.retry = retry; } }
const fail = (status: number, message: string, retry = false): never => { throw new DepthError(status, message, retry); };
const remove = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const regularFile = (path: string) => { try { const file = lstatSync(path); return file.isFile() && file.size > 0; } catch { return false; } };
const gigabytes = (name: string, fallback: number) => { const value = Number(process.env[name]); return (Number.isFinite(value) && value > 0 ? value : fallback) * 1024 ** 3; };
/** Free space depth (runs and export bakes) never takes the disk below: its own floor, and never under the server's reserve
 *  (FRAME_LINE_MIN_FREE_GB, default 5), below which uploads fail and /api/health reports the disk low. */
export function depthDiskFloor() {
  const reserve = Number(process.env.FRAME_LINE_MIN_FREE_GB ?? 5);
  return Math.max(gigabytes('FRAME_LINE_DEPTH_MIN_FREE_GB', 2), (Number.isFinite(reserve) && reserve >= 0 ? reserve : 5) * 1024 ** 3);
}
/** Measured on the Dell: about 18 KB of master and 5 KB of preview per frame; busier pictures cost more. */
const BYTES_PER_FRAME = 40 * 1024;

type Capabilities = DepthCapabilities & { workerIdentity?: unknown };
/** `bind`: an editor asking for its clip's run (POST /api/depth), which every later reader of that clip then prefers. */
export type DepthRequest = { clip: Clip; asset: MediaAsset; sourcePath: string; from: number; to: number; joinOnly?: boolean; bind?: boolean };
/** `clips`: the clips whose editor run this is (bind). */
type Job = Omit<DepthRun, 'next'> & { base: string; projects: string[]; used: number; bytes?: number; clips?: string[] };

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

/** FFmpeg's raw output as bytes, at most `limit` of them. Kept here (not media.ts's `run`) so the depth service and its
 *  inference check load without the media pipeline's native modules. */
function rawFrames(args: string[], limit: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0, errors = '';
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) child.kill(); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => code === 0 && size <= limit ? resolve(Buffer.concat(chunks)) : reject(new Error(`Could not decode for focus: ${errors.trim() || `exit ${code}`}`)));
  });
}

/** The subject's resolved mask analysis (resolveSmartMaskArtifact): its folder and verified manifest. */
export type DepthSubject = { directory: string; manifest: SmartMaskManifest };
/**
 * Focus follows subject, measured once: per analysed frame the median distance under the matte (alpha over one half),
 * smoothed (smoothFocus). Depth comes from the masters, the matte from the analysis's playback-size frames (the native
 * ones when it has none), both scaled onto the depth grid, one 64-frame segment at a time.
 */
async function measureFocus(job: Pick<DepthRun, 'key' | 'first' | 'frames' | 'times' | 'width' | 'height' | 'near' | 'far' | 'segments'>, masters: string, subject: DepthSubject): Promise<DepthFocusTrack> {
  const { manifest } = subject, size = job.width * job.height;
  const times = manifest.sourceTimes ?? [];
  // Both index the same decoded source timestamps; a mismatch means one of them was made from another decode.
  if (job.times.some((time, i) => i % 16 === 0 && Math.abs((times[job.first + i] ?? Infinity) - time) > 1e-4)) fail(409, 'The subject mask and the depth analysis disagree on frame timing. Analyze the mask again.');
  const analysed = new Set(manifest.frames.map(frame => frame.index)), pattern = join(subject.directory.replaceAll('%', '%%'), manifest.preview ? 'preview' : 'frames', '%d.png');
  const raw: (number | null)[] = new Array(job.frames).fill(null);
  for (const segment of job.segments) {
    const wanted = Array.from({ length: segment.count }, (_, i) => segment.first + i).filter(index => analysed.has(index));
    if (!wanted.length) continue;
    // Mask frames have no gaps (validateMaskManifest), so the wanted ones are one run of indices.
    const depth = await rawFrames(['-i', join(masters, `${segment.n}.mkv`), '-f', 'rawvideo', '-pix_fmt', 'gray10le', '-'], segment.count * size * 2);
    const matte = await rawFrames(['-framerate', '30', '-start_number', String(wanted[0]), '-i', pattern, '-frames:v', String(wanted.length), '-vf', `scale=${job.width}:${job.height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], wanted.length * size);
    if (depth.length !== segment.count * size * 2 || matte.length !== wanted.length * size) fail(500, 'Could not read the depth or the subject mask to measure focus.');
    const all = new Uint16Array(depth.buffer.slice(depth.byteOffset, depth.byteOffset + depth.length)); // Aligned for 16-bit reads.
    wanted.forEach((index, k) => {
      const median = matteMedian(all.subarray((index - segment.first) * size, (index - segment.first + 1) * size), matte.subarray(k * size, (k + 1) * size));
      raw[index - job.first] = median === null ? null : depthDistance(job, median);
    });
  }
  const span = job.times.length > 1 ? job.times[job.times.length - 1] - job.times[0] : 0;
  const values = smoothFocus(raw, span > 0 ? (job.times.length - 1) / span : 30);
  return { status: 'ready', key: hash([job.key, manifest.key, DEPTH_FOCUS_VERSION]), first: job.first, frames: job.frames, measured: raw.filter(value => value !== null).length, values };
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
export function depthService(directory: string, options: { sourceTimes: (clip: Clip, asset: MediaAsset, sourcePath: string) => Promise<number[]>; python?: string; worker?: string; freeBytes?: () => number; freeGpu?: () => void }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const python = options.python ?? defaultPython(), worker = options.worker ?? defaultWorker;
  const freeBytes = options.freeBytes ?? (() => { const disk = statfsSync(directory); return disk.bavail * disk.bsize; });
  const jobs = new Map<string, Job>(), controllers = new Map<string, AbortController>(), partials = new Map<string, string>(), holds = new Map<string, number>();
  const focusTasks = new Map<string, { promise: Promise<DepthFocusTrack>; retryAt?: number }>();
  let queue = Promise.resolve(), closed = false, device: string | undefined;
  const save = (job: Job) => { jobs.set(job.key, job); atomicJson(join(directory, `${job.key}.job.json`), job); };
  const manifestPath = (key: string) => join(directory, key, 'manifest.json');
  /** A cancelled queued run gives its key up at once, so a stale queue entry must not drop a newer run's controller. */
  const release = (key: string, controller: AbortController) => { if (controllers.get(key) === controller) controllers.delete(key); };
  /** The editor's run for a clip, which every reader of the clip (an export, a depth key, the focus track) then prefers
   *  while it covers: two covering runs set their own near/far, so the export must read the one the editor shows. */
  const bind = (job: Job, clipId: string) => {
    for (const other of jobs.values()) if (other !== job && other.clips?.includes(clipId)) { other.clips = other.clips.filter(id => id !== clipId); save(other); }
    if (!job.clips?.includes(clipId)) { job.clips = [...job.clips ?? [], clipId]; save(job); }
  };

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
      if (['queued', 'processing'].includes(job.status)) Object.assign(job, { status: 'failed', error: 'The server restarted. Click Retry.', segments: [] });
      else if (job.status === 'ready' && !regularFile(manifestPath(job.key))) Object.assign(job, { status: 'failed', error: 'This depth analysis is missing. Click Retry.', segments: [] });
      if (job.status === 'ready') job.bytes ??= folderBytes(join(directory, job.key));
      save(job);
    } catch { /* A corrupt record is ignored; its folder goes below. */ }
  }
  for (const name of readdirSync(directory)) if (validKey(name) && jobs.get(name)?.status !== 'ready') { try { remove(join(directory, name)); } catch { /* Retried next start. */ } }
  // Focus tracks are named `<run key>-<id>.json` and go with their run.
  const focusDirectory = join(directory, 'focus');
  mkdirSync(focusDirectory, { recursive: true, mode: 0o700 });
  // A file Defender or the indexer holds open stays until the next start rather than stopping this one.
  const dropFocus = (keep: (name: string) => boolean) => { for (const name of readdirSync(focusDirectory)) if (!keep(name)) { try { rmSync(join(focusDirectory, name), { force: true }); } catch { /* Retried next start. */ } } };
  dropFocus(name => !name.endsWith('.tmp') && jobs.get(name.slice(0, 64))?.status === 'ready');

  /** Record first, then files: a folder a Windows handle keeps has no ready record, so it is never served and the
   *  next start removes it. Never throws, so a locked old run cannot fail the request or run that evicts it. */
  const evict = (job: Job) => {
    jobs.delete(job.key);
    try { rmSync(join(directory, `${job.key}.job.json`), { force: true }); dropFocus(name => !name.startsWith(job.key)); rmSync(join(directory, job.key), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
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
    const floor = depthDiskFloor();
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
    const { base, projects, used, bytes, clips, ...run } = job;
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
      service.freeGpu();
      writeFileSync(join(temporary, 'analysis.cube'), input.lut, { mode: 0o600 });
      atomicJson(join(temporary, 'job.json'), { version: 1, key: job.key, input: input.sourcePath, output: temporary, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', first: job.first, frames: job.frames, seek: input.seek, image: input.image, width: job.width, height: job.height, analysisLutPath: join(temporary, 'analysis.cube'), dataLevels: input.dataLevels, yuvMatrix: input.yuvMatrix, workerIdentity: input.workerIdentity });
      await runWorkerProcess(python, [worker, join(temporary, 'job.json')], controller.signal, value => { job.progress = Math.round(value); }, 'Depth', message => {
        const mapping = message.mapping as Record<string, unknown> | undefined;
        if (mapping) {
          const { lo, hi, near, far } = mapping;
          if (![lo, hi, near, far].every(Number.isFinite) || !((hi as number) > (lo as number))) throw new Error('The depth worker returned an invalid value mapping.');
          Object.assign(job, { lo, hi, near, far });
        }
        if (message.telemetry && typeof message.telemetry === 'object') job.telemetry = message.telemetry as DepthRun['telemetry'];
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
      device = capabilities.device;
      const size = depthAnalysisSize(Number(dimensions![1]), Number(dimensions![2]));
      const analysis = maskAnalysis(clip, asset), sourceFingerprint = maskSourceFingerprint(sourcePath);
      const base = hash([sourceFingerprint, analysis.identity, capabilities.workerIdentity, size, image]);
      const key = hash([base, range.first, range.frames]);
      // No awaits from here on: a second request for the same source sees this one's job. Ready first (a trim back
      // inside a ready run plays at once), then the clip's editor run, then the smallest.
      const bound = (job: Job) => Number(!!job.clips?.includes(clip.id));
      const covering = [...jobs.values()].filter(job => job.base === base && ['ready', 'queued', 'processing'].includes(job.status) && job.first <= range.first && job.first + job.frames >= range.first + range.frames && (job.status !== 'ready' || regularFile(manifestPath(job.key))))
        .sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready') || bound(b) - bound(a) || a.frames - b.frames)[0];
      if (covering) {
        if (!covering.projects.includes(clip.projectId)) { covering.projects.push(clip.projectId); save(covering); }
        if (request.bind) bind(covering, clip.id);
        covering.used = Date.now(); return view(covering);
      }
      if (request.joinOnly) fail(409, 'Depth for this clip is not analyzed yet. It starts when an editor opens the project.');
      if (controllers.has(key)) fail(409, 'The previous depth analysis is still stopping.', true);
      if ([...jobs.values()].filter(job => ['queued', 'processing'].includes(job.status)).length >= 8) fail(429, 'The depth queue is full.', true);
      makeRoom(range.frames * BYTES_PER_FRAME);
      const job: Job = { key, base, status: 'queued', progress: 0, mediaId: asset.id, first: range.first, frames: range.frames, times: times.slice(range.first, range.first + range.frames), width: size.width, height: size.height, lo: 0, hi: 1, near: 1, far: 0, segments: [], projects: [clip.projectId], used: Date.now() };
      save(job);
      if (request.bind) bind(job, clip.id);
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
    /** Another project still waiting on a shared run keeps it; this project just leaves it. An export waiting for the run
     *  (a hold) keeps it too: an editor trimming the clip meanwhile must not fail that export. */
    cancel(projectId: string, key: string) {
      const job = get(projectId, key);
      if (!['queued', 'processing'].includes(job.status) || holds.get(key)) return;
      if (job.projects.length > 1) { job.projects = job.projects.filter(project => project !== projectId); save(job); return; }
      const controller = controllers.get(key);
      controller?.abort();
      // A queued run has no worker to wait for: free the key now rather than when the queue reaches it.
      if (controller && job.status === 'queued') release(key, controller);
      // Neutral: it may be another editor's trim, and a viewer still needing the run asks for it again.
      Object.assign(job, { status: 'cancelled', error: 'Cancelled.', segments: [] }); save(job);
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
      // A full queue or a key still stopping clears by itself: wait here, outside the render queue when awaitDepth asks.
      let started: DepthRun | undefined;
      while (!started) {
        try { started = await service.enqueue(request); }
        catch (error) {
          if (!(error instanceof DepthError && error.retry)) throw error;
          if (signal?.aborted) throw new Error('Canceled by you');
          onProgress?.(0);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      const { key } = started;
      // Held from the start, not once ready: an editor's cancel (a trim, the effect removed) and eviction both leave it alone.
      const release = service.hold(key);
      try {
        for (;;) {
          if (signal?.aborted) throw new Error('Canceled by you');
          const job = jobs.get(key);
          if (!job) fail(410, 'The depth analysis was removed. Export again.');
          if (job!.status === 'ready') {
            job!.used = Date.now();
            return { run: view(job!), masters: join(directory, key, 'master'), release };
          }
          if (job!.status === 'failed' || job!.status === 'cancelled') fail(409, `Depth analysis ${job!.status === 'failed' ? 'failed' : 'was cancelled'}: ${job!.error ?? 'click Retry in the Depth panel.'}`);
          onProgress?.(job!.progress);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      } catch (error) { release(); throw error; }
    },
    /** Spec section 3: before a CUDA run or bake, an idle Smart Mask preview worker gives its VRAM back (it starts again on
     *  the next click). `device` is the one the last capability check reported. */
    freeGpu() { if (device === 'cuda') options.freeGpu?.(); },
    /**
     * The focus track for a ready run and a subject (focus follows subject), measured once and kept beside the run until
     * it is evicted. Concurrent asks share one measurement; a failed one is answered as such for 30 seconds.
     */
    focus(projectId: string, key: string, subject: DepthSubject): Promise<DepthFocusTrack> {
      const job = get(projectId, key);
      if (job.status !== 'ready') fail(409, 'Depth analysis is not finished yet.');
      const id = hash([key, subject.manifest.key, DEPTH_FOCUS_VERSION]).slice(0, 32), file = join(focusDirectory, `${key}-${id}.json`);
      const known = focusTasks.get(id);
      if (known && !(known.retryAt && Date.now() > known.retryAt)) return known.promise;
      const release = service.hold(key);
      const entry: { promise: Promise<DepthFocusTrack>; retryAt?: number } = { promise: (async () => {
        try { return JSON.parse(readFileSync(file, 'utf8')) as DepthFocusTrack; } catch { /* Not measured yet. */ }
        const track = await heavyJob(() => measureFocus(job, join(directory, key, 'master'), subject));
        if (jobs.get(key) === job && job.status === 'ready') atomicJson(file, track);
        return track;
      })().finally(release) };
      focusTasks.set(id, entry);
      // Measured: the file answers from now on. Failed: the error stands for a while, then a new ask measures again.
      entry.promise.then(() => { if (focusTasks.get(id) === entry) focusTasks.delete(id); }, () => { entry.retryAt = Date.now() + 30_000; });
      return entry.promise;
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
