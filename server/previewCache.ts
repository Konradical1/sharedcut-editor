import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { clipSpan, projectSize } from '../src/services/playback.ts';
import { stabilizeEffect } from '../src/services/stabilize.ts';
import { timelineTransitions, type TransitionRecord } from '../src/services/transitions.ts';
import type { MediaAsset, Project } from '../src/state/models.ts';
import { bakesWholeClips, readsDepth, run, type RenderRequest } from './media.ts';
import { trimFlowCache } from './opticalFlow.ts';
import { renameWithRetry } from './platform.ts';

type Snapshot = Omit<RenderRequest, 'outputPath' | 'signal' | 'onProgress'>;
export type TimelinePreview = { key: string; status: 'preparing' | 'ready' | 'failed' | 'skipped'; progress: number; from: number; duration: number; fps: number; url?: string; error?: string };
/** What the host guard answers before a preview is scheduled; `release` gives its slot back and may be called more than once. */
export type PreviewAdmission = { ok: true; release: () => void } | { ok: false; reason: string };
export type PreviewCacheOptions = { admit?: (kind: 'preview') => PreviewAdmission; log?: (line: string) => void; now?: () => number };
export type PreviewAsker = { userId: string; chunk: number };

/** A browser asks again every second while it waits, so a job nobody has asked about for this long is abandoned. */
export const PREVIEW_LEASE_MS = 6_000;
/** A job still waiting for a media slot this long after it was created is dropped; its viewer asks again and gets a fresh place. */
export const PREVIEW_START_MS = 30_000;
/** A failed preview answers "failed" this long, then the next request tries again. */
export const PREVIEW_RETRY_MS = 60_000;
/** A preview is one FFmpeg pass on four threads at Idle priority, however many cores the host has. */
export const PREVIEW_THREADS = 4;
export const PREVIEW_NICE = 19;
const MAX_PREPARING = 2, BUSY_RETRY_SECONDS = 3, RECORDS_KEPT = 64, CACHE_BYTES = 512 * 1024 ** 2, MAX_PREVIEW_SECONDS = 4.1;
/** The renderer's own tolerance for "this clip is inside the range" (media.ts inRange). */
const EDGE = 1e-6;
const PREVIEW_FAILED = 'Preview failed; it plays live in the editor.';
const LIVE = { bake: 'Compositions, Stabilize, optical flow and keyframes play live in the editor.', depth: 'Depth plays live in the editor.', cut: 'This cut plays live in the editor.' };
/** Media fields that change while a file is prepared or shown but never reach a rendered picture. */
const VOLATILE_ASSET = ['status', 'progress', 'preparationStage', 'error', 'proxyUrl', 'colorProxyUrl', 'proxyVariants', 'audioProxyUrl', 'waveformVersion', 'filmstripFrames', 'filmstripVersion', 'importLink', 'matchedSourceUrl', 'matchedSourceTitle'];

/** A refusal to start another preview. The message is what the browser looks for before it backs off. */
export class PreviewBusyError extends Error {
  reason: string; retryAfterSeconds = BUSY_RETRY_SECONDS;
  constructor(reason: string) { super('Preview queue busy'); this.reason = reason; }
}

const omit = (value: object, names: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([name]) => !names.includes(name)));
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A media row as the renderer needs it: a poll used to copy 6 MB of waveforms (and thumbnails) per request. */
const slimAsset = (asset: MediaAsset): MediaAsset => ({ ...asset, waveform: undefined, filmstrip: undefined, thumbnail: '' });

/**
 * The part of the project one preview can show: this timeline's enabled clips that reach the range (transition handles
 * included, with the renderer's own tolerance), their grade nodes and media, and the timeline's tracks. Undefined when the
 * transitions in the range would come out differently without the clips left out (a stale dissolve beside a cut): rendering
 * that would show something other than the editor does, so such a range plays live.
 */
export function previewSlice(snapshot: Snapshot): Snapshot | undefined {
  const { project, timeline, settings } = snapshot, rangeIn = Number(settings.rangeIn), rangeOut = Number(settings.rangeOut);
  const own = snapshot.clips.filter(clip => clip.projectId === project.id && clip.timelineId === timeline.id && !clip.disabled);
  const records = timelineTransitions(own, timeline.id, snapshot.assets.map(entry => entry.asset));
  const clips = own.filter(clip => { const span = clipSpan(clip, records); return span.start < rangeOut - EDGE && span.end > rangeIn + EDGE; });
  const ids = new Set(clips.map(clip => clip.id)), mediaIds = new Set(clips.map(clip => clip.mediaId));
  const assets = snapshot.assets.filter(({ asset }) => mediaIds.has(asset.id)).map(({ asset, path }) => ({ asset: slimAsset(asset), path }));
  const windows = (list: TransitionRecord[]) => JSON.stringify(list.filter(record => record.start < rangeOut && record.end > rangeIn));
  if (windows(timelineTransitions(clips, timeline.id, assets.map(entry => entry.asset))) !== windows(records)) return undefined;
  return {
    ...snapshot, timeline: { ...timeline, markers: undefined }, timelines: undefined, clips, assets,
    tracks: snapshot.tracks.filter(track => track.timelineId === timeline.id).map(track => ({ ...track, captionSets: undefined })),
    nodes: snapshot.nodes.filter(node => ids.has(node.clipId)),
  };
}

/** Only what draws the range: an edit anywhere else, a waveform, a renamed track or a project's modified time leaves it alone. */
// v2: held-frame and one-frame transition windows render like Export (server/media.ts, 2026-10-05).
const STILL_VERSION = 'still-v2';
function previewKey(slice: Snapshot) {
  const files = slice.assets.map(({ asset, path }) => { try { const file = statSync(path); return [asset.id, file.size, file.mtimeMs]; } catch { return [asset.id, null]; } });
  const tracks = slice.tracks.map(({ id, number, kind, muted, solo, hidden, gain, pan }) => [id, number, kind, muted, solo, hidden, gain, pan]);
  return sha(['timeline-preview-v2', [slice.project.id, slice.project.resolution, slice.project.fps], slice.timeline.id, slice.settings, slice.clips, slice.nodes, tracks, slice.assets.map(({ asset }) => omit(asset, VOLATILE_ASSET)), files]);
}

/** Why the browser plays this range live instead of waiting for a render, if it must. */
function liveReason(slice: Snapshot | undefined) {
  if (!slice) return LIVE.cut;
  if (bakesWholeClips(slice)) return LIVE.bake;
  return readsDepth(slice) ? LIVE.depth : undefined;
}

/** The render request of one preview: one pass on a few threads at the lowest priority, whatever the snapshot carries. */
export function previewRenderRequest(slice: Snapshot, outputPath: string, signal: AbortSignal, onProgress: (percent: number) => void): RenderRequest {
  return { ...slice, outputPath, signal, onProgress, threads: PREVIEW_THREADS, singlePass: true, nice: PREVIEW_NICE };
}

type Job = { projectId: string; value: TimelinePreview; controller: AbortController; createdAt: number; lastAsked: number; started: boolean; failedAt: number; release: () => void };
type Work = (signal: AbortSignal) => Promise<void>;

/** Reuses the export renderer in short, versioned windows. Never changes source media or the edit. */
export function createPreviewCache(directory: string, schedule: (id: string, work: Work) => void, render: (request: RenderRequest) => Promise<void>, options: PreviewCacheOptions = {}) {
  const { admit, log, now = Date.now } = options;
  const jobs = new Map<string, Job>();
  let temporaries = 0;
  /** Aborts the job (the signal reaches the FFmpeg tree through run()), hands back its guard slot and forgets it. */
  const drop = (key: string, job: Job) => { job.controller.abort(); job.release(); jobs.delete(key); };
  const reusable = (job: Job, file: string, at: number) => job.value.status === 'preparing' || (job.value.status === 'ready' ? existsSync(file) : at - job.failedAt < PREVIEW_RETRY_MS);
  /** Abandoned jobs are aborted, and ones stuck waiting for a media slot dropped: neither may pin one of the two preview places. */
  const sweep = (at = now(), leaseMs = PREVIEW_LEASE_MS) => {
    for (const [key, job] of jobs) if (job.value.status === 'preparing' && (at - job.lastAsked > leaseMs || !job.started && at - job.createdAt > PREVIEW_START_MS)) drop(key, job);
  };
  const jobWork = (key: string, job: Job, slice: Snapshot, file: string, url: string): Work => async scheduler => {
    job.started = true;
    const temporary = join(directory, `${key}.${++temporaries}.pending.mp4`), { value } = job;
    try {
      if (job.controller.signal.aborted) return;
      const signal = AbortSignal.any([scheduler, job.controller.signal]);
      await mkdir(directory, { recursive: true });
      await render(previewRenderRequest(slice, temporary, signal, progress => { value.progress = Math.round(progress); }));
      if (signal.aborted) throw new Error('Preview cancelled');
      await renameWithRetry(temporary, file); value.status = 'ready'; value.url = url; value.progress = 100;
      // ponytail: 64 recent job records and a 512 MiB disk cache; grow only if long timelines churn.
      try { await trimFlowCache(directory, new Set([key]), CACHE_BYTES); } catch (error) { log?.(`Preview cache trim failed: ${error instanceof Error ? error.message : String(error)}`); }
    } catch (error) {
      // The record goes to every project member, and an ffmpeg failure names the host's paths: members get a fixed sentence, the log the detail.
      value.status = 'failed'; value.error = PREVIEW_FAILED; job.failedAt = now();
      if (!job.controller.signal.aborted) log?.(`Preview failed for project ${job.projectId}, key ${key.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally { job.release(); await rm(temporary, { force: true }); }
  };
  return {
    /** `asker` only names the viewer in the log line of a newly created job. Throws PreviewBusyError when no place is free. */
    request(snapshot: Snapshot, asker?: PreviewAsker): TimelinePreview {
      const at = now(), from = Number(snapshot.settings.rangeIn), duration = Number(snapshot.settings.rangeOut) - from, fps = Number(snapshot.settings.fps);
      if (!Number.isFinite(from) || from < 0 || !Number.isFinite(duration) || duration <= 0 || duration > MAX_PREVIEW_SECONDS || !Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('Invalid preview range.');
      const slice = previewSlice(snapshot), reason = liveReason(slice), projectId = snapshot.project.id;
      const key = slice && !reason ? previewKey(slice) : sha(['timeline-preview-v2', 'live', projectId, snapshot.timeline.id, snapshot.settings]);
      const asked = jobs.get(key); if (asked) asked.lastAsked = at;
      sweep(at);
      // A depth key bakes at source resolution and waits on analysis any viewer would start from here, and a composition
      // renders its whole timeline whatever the range; the editor draws all of these live, so they are never rendered here.
      if (!slice || reason) return { key, from, duration, fps, progress: 0, status: 'skipped', error: reason };
      const file = join(directory, `${key}.mp4`), url = `/api/timeline-previews/${key}/video.mp4?projectId=${encodeURIComponent(projectId)}`;
      const previous = jobs.get(key);
      if (previous && reusable(previous, file, at)) return previous.value;
      const value: TimelinePreview = { key, from, duration, fps, progress: 0, status: 'preparing' };
      const record = (release: () => void): Job => ({ projectId, value, controller: new AbortController(), createdAt: at, lastAsked: at, started: false, failedAt: 0, release });
      if (existsSync(file)) { value.status = 'ready'; value.url = url; value.progress = 100; jobs.set(key, record(() => {})); return value; }
      if ([...jobs.values()].filter(job => job.value.status === 'preparing').length >= MAX_PREPARING) throw new PreviewBusyError('Two previews are already rendering.');
      const admission = admit?.('preview') ?? { ok: true as const, release: () => {} };
      if (!admission.ok) throw new PreviewBusyError(admission.reason);
      let released = false;
      const job = record(() => { if (!released) { released = true; admission.release(); } });
      jobs.set(key, job);
      for (const [id, other] of jobs) if (jobs.size > RECORDS_KEPT && other.value.status !== 'preparing' && id !== key) jobs.delete(id);
      log?.(`Timeline preview started for user ${asker?.userId ?? 'unknown'}: project ${projectId}, chunk ${asker?.chunk ?? 'unknown'}.`);
      // The state may change before a queued job starts, so it renders from its own copy of the small slice.
      try { schedule(`preview-${key}`, jobWork(key, job, structuredClone(slice), file, url)); }
      catch (error) { jobs.delete(key); job.release(); throw error; }
      return value;
    },
    file(key: string, projectId: string) {
      return jobs.get(key)?.projectId === projectId && jobs.get(key)?.value.status === 'ready' ? join(directory, `${key}.mp4`) : undefined;
    },
    sweep,
    /** A deleted project's previews stop at once, and nothing of it is served from the record any more. */
    cancelProject(projectId: string) { for (const [key, job] of jobs) if (job.projectId === projectId) drop(key, job); },
  };
}

/** Why one still (GET /api/frames) is not rendered on its own. `composition`: the caller looks inside it instead. */
export const STILL_LIVE = { composition: 'A composition renders its whole timeline for one frame; look inside it.', bake: 'Stabilize and optical flow bake whole clips; this frame shows live in the editor.', depth: LIVE.depth, cut: LIVE.cut };
export type StillLive = keyof typeof STILL_LIVE;
export class StillSkipped extends Error { live: StillLive; constructor(live: StillLive) { super(STILL_LIVE[live]); this.live = live; } }
/** A still the renderer refused or failed: the message is the export's own (safe to show) or a fixed sentence. */
export class StillFailed extends Error { status = 422; }
const STILL_FAILED = 'This frame could not be rendered.', STILL_CACHE_BYTES = 64 * 1024 ** 2, STILL_TIMEOUT_MS = 60_000;
/** An absolute host path (/Users/x/…, C:\…, \\server): such a message stays in the log. */
const HOST_PATH = /(?:^|[\s'"(=:])(?:\/[^\s/]+\/|[A-Za-z]:[\\/])|\\\\/;

/** Even output sides on the project's shape, the long edge near `longEdge`: renderTimeline refuses a ratio more than .01 off. */
export function stillSize(resolution: string, longEdge: number): [number, number] {
  const [pw, ph] = projectSize(resolution), aspect = Math.max(pw, ph) / Math.min(pw, ph);
  let best = [0, 0, Infinity];
  for (let long = Math.round(longEdge / 2) * 2; long <= longEdge + 128 && best[2] > .002; long += 2) {
    const short = Math.max(16, Math.round(long / aspect / 2) * 2), error = Math.abs(long / short - aspect);
    if (error < best[2]) best = [long, short, error];
  }
  return pw >= ph ? [best[0], best[1]] : [best[1], best[0]];
}

/** One frame of a timeline as an export settings block: frame index snapped to the project grid, clamped to the last whole frame. */
export function stillSettings(project: Pick<Project, 'fps' | 'resolution'>, duration: number, seconds: number, longEdge: number) {
  const fps = project.fps, last = Math.max(0, Math.floor(duration * fps + 1e-6) - 1);
  const frame = Math.max(0, Math.min(last, Math.floor(seconds * fps + 1e-6))), [width, height] = stillSize(project.resolution, longEdge);
  const settings = { resolution: `${width} × ${height}`, fps: String(fps), codec: 'Apple ProRes 422 HQ', quality: 'Automatic', audio: 'Disabled', rangeIn: String(frame / fps), rangeOut: String(Math.min(duration, (frame + 1) / fps)) };
  return { frame, time: frame / fps, width, height, settings };
}

/** A media file alone on a timeline of its own, untouched (no grade, transform or effect): its source as the editor shows it ungraded. */
export function mediaStill(project: Project, asset: MediaAsset, path: string): Omit<Snapshot, 'settings'> {
  const timelineId = `still-${asset.id}`, duration = asset.kind === 'image' ? 5 : asset.duration;
  return { project, timeline: { id: timelineId, projectId: project.id, name: asset.name, duration }, timelines: [], nodes: [], assets: [{ asset, path }],
    tracks: [{ id: `${timelineId}-v1`, timelineId, number: 1, kind: 'video', name: 'V1', muted: true, solo: false, hidden: false, locked: false, gain: 0, pan: 0 }],
    clips: [{ id: `${timelineId}-clip`, projectId: project.id, timelineId, trackId: `${timelineId}-v1`, mediaId: asset.id, name: asset.name, start: 0, duration, sourceIn: 0, color: '', disabled: false, properties: {}, effects: [] }] };
}

const stillLive = (slice: Snapshot | undefined): StillLive | undefined => {
  if (!slice) return 'cut';
  const own = slice.clips.filter(clip => clip.timelineId === slice.timeline.id && !clip.disabled);
  if (own.some(clip => clip.mediaId === 'frameline-composition')) return 'composition';
  // Keyframes are fine: a one-frame range is exactly one per-frame render.
  if (own.some(clip => stabilizeEffect(clip) || clip.properties.opticalFlow)) return 'bake';
  return readsDepth(slice) ? 'depth' : undefined;
};

/**
 * Single composited frames through the export renderer, as small JPEGs: grades, titles, transitions, keyframes and
 * masks exactly as Export draws them. Cached by what draws the frame; at most two render at once, past the host guard,
 * and never behind the export queue. No depth service is passed, so a viewer's still never starts a depth run.
 */
export function createStillCache(directory: string, render: (request: RenderRequest) => Promise<void>, options: Pick<PreviewCacheOptions, 'admit' | 'log'> = {}) {
  const { admit, log } = options, rendering = new Map<string, Promise<string>>();
  let temporaries = 0;
  // A hard-killed server leaves half-written frames that the trim never counts. Only one server opens a data folder,
  // so nothing writes them now; one still held (Windows) waits for the next start.
  try { for (const name of readdirSync(directory)) if (name.includes('.pending.')) rmSync(join(directory, name), { force: true }); } catch { /* No frames yet. */ }
  return {
    /** The JPEG (or a lossless PNG, for Grab still) of the one frame `snapshot.settings` names. Throws StillSkipped, PreviewBusyError or StillFailed. */
    async still(snapshot: Snapshot, signal?: AbortSignal, format: 'jpg' | 'png' = 'jpg'): Promise<string> {
      const slice = previewSlice(snapshot), live = stillLive(slice);
      if (live) throw new StillSkipped(live);
      // Bump STILL_VERSION whenever the renderer's output changes, or a cached still keeps showing the old picture.
      const key = sha([STILL_VERSION, previewKey(slice!)]), file = join(directory, `${key}.${format}`);
      if (existsSync(file)) { const at = new Date(); await utimes(file, at, at).catch(() => {}); return file; }
      const running = rendering.get(file); if (running) return running;
      if (rendering.size >= MAX_PREPARING) throw new PreviewBusyError('Two frames are already rendering.');
      const admission = admit?.('preview') ?? { ok: true as const, release: () => {} };
      if (!admission.ok) throw new PreviewBusyError(admission.reason);
      const n = ++temporaries, movie = join(directory, `${key}.${n}.pending.mov`), picture = join(directory, `${key}.${n}.pending.${format}`);
      const work = (async () => {
        // ponytail: a shared render follows its first asker's disconnect; the others then retry.
        const timeout = AbortSignal.timeout(STILL_TIMEOUT_MS), stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
          await mkdir(directory, { recursive: true });
          await render(previewRenderRequest(structuredClone(slice!), movie, stop, () => {}));
          await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-i', movie, '-frames:v', '1', ...(format === 'jpg' ? ['-q:v', '4'] : []), picture], { signal: stop });
          // Defender and the indexer hold a fresh file for a moment on Windows.
          await renameWithRetry(picture, file);
          try { await trimFlowCache(directory, new Set([key]), STILL_CACHE_BYTES, format); } catch (error) { log?.(`Frame cache trim failed: ${error instanceof Error ? error.message : String(error)}`); }
          return file;
        } catch (error) {
          // Its first asker left: no failure, and nothing to log. Anyone who joined is told to ask again (429), not "Canceled by you".
          if (signal?.aborted) throw new PreviewBusyError('The viewer this frame rendered for left.');
          if (timeout.aborted) {
            log?.(`Frame timed out after ${STILL_TIMEOUT_MS / 1000} s for project ${snapshot.project.id}, key ${key.slice(0, 12)}.`);
            throw new StillFailed(`This frame took longer than ${STILL_TIMEOUT_MS / 1000} s to render.`);
          }
          // The export's refusals ("a transition cannot sit on a keyframed clip") help; an FFmpeg failure names host paths.
          const message = error instanceof Error ? error.message : String(error);
          if (!HOST_PATH.test(message) && message.length < 400) throw new StillFailed(message);
          log?.(`Frame failed for project ${snapshot.project.id}, key ${key.slice(0, 12)}: ${message}`);
          throw new StillFailed(STILL_FAILED);
        } finally { admission.release(); rendering.delete(file); await rm(movie, { force: true }); await rm(picture, { force: true }); }
      })();
      rendering.set(file, work);
      return work;
    },
  };
}
