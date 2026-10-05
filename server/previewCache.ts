import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { clipSpan } from '../src/services/playback.ts';
import { timelineTransitions, type TransitionRecord } from '../src/services/transitions.ts';
import type { MediaAsset } from '../src/state/models.ts';
import { bakesWholeClips, readsDepth, type RenderRequest } from './media.ts';
import { trimFlowCache } from './opticalFlow.ts';

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
      await rename(temporary, file); value.status = 'ready'; value.url = url; value.progress = 100;
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
