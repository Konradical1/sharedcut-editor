import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clipFrames, emptySamples, frameAt, MAX_SAMPLES, mergeSamples, trackerPath, validateMotionTrackerSamples,
  type MotionTracker, type MotionTrackerSamples, type SampleRow,
} from '../src/services/motionTracker.ts';
import type { Clip, MediaAsset } from '../src/state/models.ts';
import { renameWithRetry, venvPython } from './platform.ts';
import { runWorkerProcess } from './processTree.ts';

/** Motion tracker worker (scripts/tracker.py): one run of frames per job, samples streamed back as they settle. */
const worker = fileURLToPath(new URL('../scripts/tracker.py', import.meta.url));
export const trackerPython = () => process.env.FRAME_LINE_TRACKER_PYTHON || venvPython('.venv-tracker');
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';

export class MotionTrackerError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const fail = (status: number, message: string): never => { throw new MotionTrackerError(status, message); };

let capabilitiesRequest: Promise<{ available: boolean; reason?: string; opencv?: string }> | undefined, capabilitiesExpiry = 0;
export function motionTrackerCapabilities() {
  if (!capabilitiesRequest || Date.now() >= capabilitiesExpiry) { capabilitiesExpiry = Date.now() + 30_000; capabilitiesRequest = checkCapabilities(); }
  return capabilitiesRequest;
}
async function checkCapabilities() {
  if (!existsSync(trackerPython()) || !existsSync(worker)) return { available: false, reason: 'The motion tracker is not installed on this server. Run npm run setup:tracker.' };
  try {
    const lines = (await runWorkerProcess(trackerPython(), [worker, '--check'], AbortSignal.timeout(60_000), undefined, 'Motion tracker')).trim().split('\n');
    const result = JSON.parse(lines.at(-1)!);
    return { available: result.available === true, opencv: String(result.opencv ?? ''), reason: result.reason };
  } catch (error) { return { available: false, reason: (error as Error).message }; }
}

export { clipFrames, frameAt };

export type TrackRun = { tracker: MotionTracker; start: number; stop: number; fenced: boolean; seed: { x: number; y: number; scale: number; rotation: number } };

/**
 * What one run tracks: from the frame showing at `time` in `direction`, up to the frame before the next hand-placed
 * point, the end of the clip, or `frames` frames. The seed is the point on the start frame, placed or tracked; a
 * tracker with no point there cannot start.
 */
export function planRun(tracker: MotionTracker, samples: MotionTrackerSamples | undefined, times: number[], bounds: { first: number; last: number }, time: number, direction: 1 | -1, frames?: number): TrackRun {
  const start = frameAt(times, time);
  if (start < bounds.first || start > bounds.last) fail(400, 'Move the playhead onto this clip to track from here.');
  const path = trackerPath(tracker, samples), point = path.find(p => Math.abs(p.time - times[start]) < .5 / tracker.source.fps);
  if (!point) fail(409, `Place ${tracker.name} on this frame first, then track from it.`);
  const fence = tracker.keys.map(key => frameAt(times, key.time)).filter(frame => direction > 0 ? frame > start : frame < start);
  const edge = direction > 0 ? Math.min(bounds.last, ...fence.map(frame => frame - 1)) : Math.max(bounds.first, ...fence.map(frame => frame + 1));
  const limit = frames && frames > 0 ? start + direction * frames : edge;
  const stop = direction > 0 ? Math.min(edge, limit) : Math.max(edge, limit);
  return { tracker, start, stop, fenced: fence.length > 0 && stop === edge && edge !== (direction > 0 ? bounds.last : bounds.first), seed: { x: point!.x, y: point!.y, scale: point!.scale, rotation: point!.rotation } };
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type Stop = { frame: number; time: number; reason: string };
export type MotionTrackerJobView = {
  id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; direction: 1 | -1;
  /** Rows settled so far, from `after`: [tracker id, frame, time, x, y, confidence, scale, rotation, flag]. */
  rows: [string, number, number, number, number, number, number, number, number][]; next: number;
  /** Sample file each tracker should now point at, and the one it pointed at when the run began. */
  results?: Record<string, string>; bases: Record<string, string | null>; stops: Record<string, Stop>; warnings: { tracker: string; message: string }[]; error?: string;
};
type Job = Omit<MotionTrackerJobView, 'rows' | 'next'> & { projectId: string; clipId: string; runs: TrackRun[]; rows: MotionTrackerJobView['rows']; controller: AbortController; finished?: number; times: number[]; base: Map<string, MotionTrackerSamples> };

export function motionTrackerService(directory: string) {
  const jobs = new Map<string, Job>();
  let queue = Promise.resolve(), closed = false;
  const file = (key: string) => join(directory, `${key}.json`);
  const unchanged = (bases: Record<string, string | null>) => Object.fromEntries(Object.entries(bases).filter(([, key]) => key).map(([id, key]) => [id, key!]));

  async function read(key: string): Promise<MotionTrackerSamples> {
    if (!/^[a-f0-9]{64}$/.test(key)) fail(400, 'Invalid tracking result.');
    let value: unknown;
    try { value = JSON.parse(await readFile(file(key), 'utf8')); } catch { fail(404, 'This tracking result is not on the server. Track the shot again.'); }
    validateMotionTrackerSamples(value);
    return value as MotionTrackerSamples;
  }
  /** Content-addressed: the same samples always make the same key, and a key's file never changes. */
  async function store(samples: MotionTrackerSamples) {
    validateMotionTrackerSamples(samples);
    const text = JSON.stringify(samples), key = hash(text);
    if (existsSync(file(key))) return key;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
    await writeFile(temporary, text, { mode: 0o600 });
    await renameWithRetry(temporary, file(key)).catch(async error => { await rm(temporary, { force: true }); if (!existsSync(file(key))) throw error; });
    return key;
  }

  /** The samples each run settled, merged over what the tracker had: re-tracked frames replace old ones, the rest stay. */
  async function commit(job: Job) {
    const results: Record<string, string> = {};
    for (const run of job.runs) {
      const id = run.tracker.id, rows: SampleRow[] = job.rows.filter(row => row[0] === id).map(row => ({ frame: row[1], time: row[2], x: row[3], y: row[4], confidence: row[5], scale: row[6], rotation: row[7], flag: row[8] as 0 | 2 }));
      if (!rows.length) { if (job.bases[id]) results[id] = job.bases[id]!; continue; }
      const reached = job.direction > 0 ? Math.max(...rows.map(row => row.frame)) : Math.min(...rows.map(row => row.frame));
      results[id] = await store(mergeSamples(job.base.get(id) ?? emptySamples(run.tracker.source.mediaId), run.start + job.direction, reached, rows));
    }
    return results;
  }

  /** Ends a job: its results are in place before its status says so, because the editor stops polling on that status. */
  function finish(job: Job, status: Job['status'], results: Record<string, string>, error?: string) {
    Object.assign(job, { results, error, progress: status === 'done' ? 100 : job.progress, finished: Date.now() });
    job.status = status;
  }

  async function execute(job: Job, input: string, source: { width: number; height: number; fps: number }) {
    if (job.controller.signal.aborted) { if (!job.finished) finish(job, 'cancelled', unchanged(job.bases)); return; }
    job.status = 'running';
    const ends = job.runs.flatMap(run => [run.start, run.stop]), low = Math.min(...ends), high = Math.max(...ends);
    let temporary: string | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(join(directory, '.job-'));
      const spec = {
        // The frame before the run comes along so the worker can seek between it and the run's first frame.
        ffmpeg: ffmpeg(), input, source, times: job.times.slice(Math.max(0, low - 1), high + 1), first: Math.max(0, low - 1), start: job.runs[0].start, stop: job.direction > 0 ? high : low,
        hwaccelCache: join(directory, 'hwaccel.json'),
        trackers: job.runs.map(run => ({
          id: run.tracker.id, x: run.seed.x, y: run.seed.y, scale: run.seed.scale, rotation: run.seed.rotation, until: run.stop,
          featureWidth: run.tracker.feature.width, featureHeight: run.tracker.feature.height, searchWidth: run.tracker.search.width, searchHeight: run.tracker.search.height,
          // A subject may stay hidden for up to a second before the tracker gives up and asks for a hand.
          model: run.tracker.model, minConfidence: run.tracker.minConfidence, whenLost: run.tracker.whenLost, maxLost: Math.max(3, Math.round(source.fps)),
        })),
      };
      await writeFile(join(temporary, 'job.json'), JSON.stringify(spec));
      const ids = job.runs.map(run => run.tracker.id);
      await runWorkerProcess(trackerPython(), [worker, join(temporary, 'job.json')], job.controller.signal, value => { job.progress = Math.round(value); }, 'Motion tracker', message => {
        if (Array.isArray(message.samples)) for (const row of message.samples as number[][]) {
          if (!Array.isArray(row) || row.length !== 9 || !ids[row[0]] || row.some(value => !Number.isFinite(value))) continue;
          job.rows.push([ids[row[0]], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8]]);
        }
        const stopped = message.stopped as { tracker?: string; frame?: number; reason?: string } | undefined;
        if (stopped?.tracker && Number.isSafeInteger(stopped.frame)) {
          // Running out of frames right before a placed point is that point's doing, not the clip's end.
          const run = job.runs.find(item => item.tracker.id === stopped.tracker), reason = String(stopped.reason ?? 'end');
          job.stops[stopped.tracker] = { frame: stopped.frame!, time: job.times[stopped.frame!] ?? 0, reason: reason === 'end' && run?.fenced && stopped.frame === run.stop ? 'key' : reason };
        }
        const warning = message.warning as { tracker?: string; message?: string } | undefined;
        if (warning?.tracker && warning.message) job.warnings.push({ tracker: warning.tracker, message: String(warning.message).slice(0, 300) });
      });
      finish(job, 'done', await commit(job));
    } catch (error) {
      const message = job.controller.signal.aborted ? undefined : (error as Error).message.split('\n').filter(Boolean).at(-1)?.slice(0, 500) || 'Tracking failed.';
      // Whatever settled before a stop or a failure is still good tracking; keep it rather than throw it away.
      let results = unchanged(job.bases), saving: string | undefined;
      try { results = await commit(job); } catch (reason) { saving = (reason as Error).message; }
      finish(job, job.controller.signal.aborted ? 'cancelled' : 'failed', results, message ?? saving);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  function view(job: Job, after: number): MotionTrackerJobView {
    const from = Math.max(0, Math.min(job.rows.length, Math.floor(after) || 0));
    return { id: job.id, status: job.status, progress: job.progress, direction: job.direction, rows: job.rows.slice(from), next: job.rows.length, results: job.results, bases: job.bases, stops: job.stops, warnings: job.warnings, error: job.error };
  }

  // Leftovers of a job the server died in.
  void readdir(directory).then(names => Promise.all(names.filter(name => name.startsWith('.')).map(name => rm(join(directory, name), { recursive: true, force: true })))).catch(() => {});

  return {
    read,
    store,
    /** Start tracking `trackers` of `clip` from the frame showing at `time`. A new run on the same tracker cancels the old one. */
    async start(options: { projectId: string; clip: Clip; asset: MediaAsset; sourcePath: string; times: number[]; trackers: MotionTracker[]; time: number; direction: 1 | -1; frames?: number }) {
      if (closed) fail(503, 'The server is stopping.');
      // Finished jobs are only read back by the editor that ran them, a few seconds later.
      for (const [id, job] of jobs) if (job.finished && Date.now() - job.finished > 600_000) jobs.delete(id);
      const { clip, asset, times, trackers, direction } = options;
      const [width, height] = (asset.resolution.match(/(\d+)\s*[×x]\s*(\d+)/i) ?? []).slice(1).map(Number);
      if (!(width > 0 && height > 0)) fail(409, 'The source resolution is unknown.');
      if (!trackers.length || trackers.length > 16) fail(400, 'Choose which trackers to track.');
      const bounds = clipFrames(clip, asset, times), base = new Map<string, MotionTrackerSamples>(), bases: Record<string, string | null> = {};
      for (const tracker of trackers) {
        bases[tracker.id] = tracker.result?.key ?? null;
        // A sample file that is gone or unreadable must not lock the tracker out: its placed points still start a run.
        if (tracker.result) base.set(tracker.id, await read(tracker.result.key).catch(() => emptySamples(tracker.source.mediaId)));
      }
      // Tracking several at once takes the ones that have a point on this frame; one on its own must have it.
      const runs: TrackRun[] = [];
      for (const tracker of trackers) {
        try { runs.push(planRun(tracker, base.get(tracker.id), times, bounds, options.time, direction, options.frames)); }
        catch (error) { if (trackers.length === 1 || !(error instanceof MotionTrackerError) || error.status !== 409) throw error; }
      }
      if (!runs.length) fail(409, 'None of these trackers has a point on this frame. Place one first.');
      for (const run of runs) if ((base.get(run.tracker.id)?.frames.length ?? 0) + Math.abs(run.stop - run.start) > MAX_SAMPLES) fail(400, `${run.tracker.name} would hold more than ${MAX_SAMPLES} tracked frames. Clear part of it or track a shorter stretch.`);
      if (new Set(runs.map(run => run.start)).size > 1) fail(400, 'Trackers must start from the same frame.');
      // A newer run on the same tracker replaces an older one; a queued one ends at once so nobody waits on it.
      for (const job of jobs.values()) if (!job.finished && job.clipId === clip.id && job.runs.some(run => trackers.some(t => t.id === run.tracker.id))) {
        job.controller.abort();
        if (job.status === 'queued') finish(job, 'cancelled', unchanged(job.bases));
      }
      const job: Job = { id: randomUUID(), projectId: options.projectId, clipId: clip.id, status: 'queued', progress: 0, direction, runs, rows: [], bases: Object.fromEntries(runs.map(run => [run.tracker.id, bases[run.tracker.id]])), stops: {}, warnings: [], controller: new AbortController(), times, base };
      jobs.set(job.id, job);
      if (runs.every(run => run.stop === run.start)) {
        // Already at the edge of the clip or against a hand-placed point: nothing to track in that direction.
        for (const run of runs) job.stops[run.tracker.id] = { frame: run.start, time: times[run.start], reason: run.fenced ? 'key' : 'end' };
        finish(job, 'done', unchanged(job.bases));
        return view(job, 0);
      }
      const task = queue.then(() => execute(job, options.sourcePath, { width, height, fps: asset.fps || 24 }));
      queue = task.then(() => {}, () => {});
      return view(job, 0);
    },
    get(projectId: string, id: string, after = 0) {
      const job = jobs.get(id);
      if (!job || job.projectId !== projectId) fail(404, 'Tracking job not found.');
      return view(job!, after);
    },
    cancel(projectId: string, id: string) {
      const job = jobs.get(id);
      if (!job || job.projectId !== projectId) fail(404, 'Tracking job not found.');
      job!.controller.abort();
      if (job!.status === 'queued') finish(job!, 'cancelled', unchanged(job!.bases));
    },
    /** Drop the analysis between two source times (inclusive). Hand-placed points live on the clip and stay. */
    async clear(tracker: MotionTracker, times: number[], from: number, to: number) {
      if (!tracker.result) return null;
      const samples = await read(tracker.result.key).catch(() => undefined);
      if (!samples) return null;
      const kept = mergeSamples(samples, frameAt(times, Math.min(from, to)), frameAt(times, Math.max(from, to)), []);
      return kept.frames.length ? store(kept) : null;
    },
    /** Stops every run; resolves once the one in flight has let go of its worker and files. */
    close() { closed = true; for (const job of jobs.values()) job.controller.abort(); return queue; },
  };
}
