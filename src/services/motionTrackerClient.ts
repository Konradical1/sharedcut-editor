import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api, connection } from './api';
import { useEditorStore } from '../state/store';
import type { Clip } from '../state/models';
import { evaluateClip } from './animation';
import { projectSize } from './playback';
import { stabilizeEffect, stabilizeMatrixAt, stabilizeSettings, type StabilizePreview } from './stabilize';
import {
  anchorFrame, attachFrame, cameraKeyframes, clipSourceTime, layerKeyframes, linkApplies, pictureTimeAt, sharedFrames, sourceSize, trackerKeyPrefix, trackerPath,
  type ApplyContext, type MotionTracker, type MotionTrackerCameraOptions, type MotionTrackerLayerOptions, type MotionTrackerLink, type MotionTrackerSamples, type TrackPoint,
} from './motionTracker';
import { showFocusFrame } from './sourceFocus';

export type TrackerRow = [string, number, number, number, number, number, number, number, number];
type JobView = { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; rows: TrackerRow[]; next: number; results?: Record<string, string>; bases: Record<string, string | null>; stops: Record<string, { frame: number; time: number; reason: string }>; warnings: { tracker: string; message: string }[]; error?: string };
export type TrackerJob = Omit<JobView, 'next' | 'status'> & { status: JobView['status'] | 'starting'; clipId: string; projectId: string; trackerIds: string[]; direction: 1 | -1; frames?: number };
export type TrackerCapabilities = { available: boolean; reason?: string; opencv?: string };

/** The frame editor: which tracker on which clip, the source time of the frame on screen, and the run in progress. */
export const useTrackerEditor = create<{ clipId: string | null; trackerId: string | null; time: number; job: TrackerJob | null }>(() => ({ clipId: null, trackerId: null, time: 0, job: null }));

const samplesCache = new Map<string, Promise<MotionTrackerSamples>>();
/** Samples by content key; a key's samples never change, so a loaded one is kept. */
export function loadSamples(projectId: string, key: string) {
  const known = samplesCache.get(key);
  if (known) { samplesCache.delete(key); samplesCache.set(key, known); return known; }
  const request = api<MotionTrackerSamples>(`/motion-trackers/samples/${key}?projectId=${encodeURIComponent(projectId)}`);
  samplesCache.set(key, request);
  request.catch(() => { if (samplesCache.get(key) === request) samplesCache.delete(key); });
  while (samplesCache.size > 48) samplesCache.delete(samplesCache.keys().next().value!);
  return request;
}
export function useTrackerSamples(projectId: string | undefined, key: string | undefined) {
  const [loaded, setLoaded] = useState<{ key: string; samples: MotionTrackerSamples } | null>(null);
  useEffect(() => {
    if (!projectId || !key) return;
    let live = true;
    void loadSamples(projectId, key).then(samples => { if (live) setLoaded({ key, samples }); }).catch(() => {});
    return () => { live = false; };
  }, [projectId, key]);
  return key && loaded?.key === key ? loaded.samples : undefined;
}
const timesCache = new Map<string, Promise<number[]>>();
/** The clip source's frame table (presentation times from the original), shared with the Smart Mask editor's. */
export function loadSourceTimes(clip: Pick<Clip, 'id' | 'mediaId'>) {
  const key = `${clip.id}:${clip.mediaId}`, known = timesCache.get(key);
  if (known) return known;
  const request = api<{ sourceTimes: number[] }>(`/motion-trackers/source-times?clipId=${encodeURIComponent(clip.id)}`).then(value => value.sourceTimes);
  timesCache.set(key, request);
  request.catch(() => timesCache.delete(key));
  return request;
}

let capabilitiesRequest: Promise<TrackerCapabilities> | undefined;
export function trackerCapabilities() {
  capabilitiesRequest ??= api<TrackerCapabilities>('/motion-trackers/capabilities').catch(error => { capabilitiesRequest = undefined; return { available: false, reason: (error as Error).message }; });
  return capabilitiesRequest;
}

const lookup = (clipId: string) => {
  const state = useEditorStore.getState(), clip = state.clips.find(c => c.id === clipId), asset = state.media.find(m => m.id === clip?.mediaId), project = state.projects.find(p => p.id === clip?.projectId);
  return { state, clip, asset, project };
};

export function openTrackerEditor(clipId: string, trackerId: string) {
  const { state, clip, asset } = lookup(clipId);
  if (!clip || !asset) return;
  state.setPlaying(false);
  // The frame the program shows at the playhead, so opening the editor never changes the picture.
  const time = pictureTimeAt(clip, asset, Math.max(clip.start, Math.min(clip.start + clip.duration - 1e-6, state.playhead)), state.projects.find(p => p.id === clip.projectId)?.fps || 24);
  useTrackerEditor.setState({ clipId, trackerId, time });
}

/**
 * Track `trackerIds` from the editor's frame in `direction`, `frames` at most (one for a single step). Samples show in
 * the editor as they settle; when the run ends, each tracker points at its merged result, unless someone else changed
 * that tracker meanwhile. Layers linked to a tracker follow the improved track.
 */
export async function runTracker(trackerIds: string[], direction: 1 | -1, frames?: number) {
  const editor = useTrackerEditor.getState(), { state, clip } = lookup(editor.clipId ?? '');
  if (!clip) return;
  if (editor.job && ['starting', 'queued', 'running'].includes(editor.job.status)) { state.notify('Another track is still running. Stop it or wait for it to finish.', 'info'); return; }
  // The run walks the editor along the frames it tracks; playback would fight it for the frame on screen.
  state.setPlaying(false);
  const job: TrackerJob = { id: '', status: 'starting', progress: 0, rows: [], bases: {}, stops: {}, warnings: [], clipId: clip.id, projectId: clip.projectId, trackerIds, direction, frames };
  const publish = (patch: Partial<TrackerJob>) => { Object.assign(job, patch); useTrackerEditor.setState({ job: { ...job } }); };
  publish({});
  try {
    await connection.flush();
    let view = await api<JobView>('/motion-trackers/track', { method: 'POST', body: JSON.stringify({ clipId: clip.id, trackerIds, time: editor.time, direction: direction > 0 ? 'forward' : 'backward', frames }) });
    publish({ id: view.id, status: view.status, progress: view.progress, rows: view.rows, bases: view.bases, stops: view.stops, warnings: view.warnings, results: view.results, error: view.error });
    let next = view.next;
    while (view.status === 'queued' || view.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 120));
      for (let attempt = 0; ; attempt++) {
        try { view = await api<JobView>(`/motion-trackers/jobs/${view.id}?projectId=${encodeURIComponent(clip.projectId)}&after=${next}`); break; }
        catch (error) { if (attempt >= 30 || (error as { status?: number }).status === 404) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
      }
      next = view.next;
      const rows = view.rows.length ? [...job.rows, ...view.rows] : job.rows;
      publish({ status: view.status, progress: view.progress, rows, stops: view.stops, warnings: view.warnings, results: view.results, error: view.error });
      // Follow the run on screen, the way a tracker in any editor walks the playhead along.
      const latest = rows.at(-1);
      if (latest && frames !== 1 && useTrackerEditor.getState().clipId === clip.id) showFocusFrame(latest[2]);
    }
    await commitResults(job);
    if (view.status === 'failed') state.notify(view.error || 'Tracking failed.', 'error');
    for (const warning of view.warnings) state.notify(warning.message, 'info');
    const settled = job.rows.at(-1);
    if (settled && useTrackerEditor.getState().clipId === clip.id) showFocusFrame(settled[2]);
  } catch (error) {
    publish({ status: 'failed', error: (error as Error).message });
    state.notify((error as Error).message, 'error');
  }
}

async function commitResults(job: TrackerJob) {
  const store = useEditorStore.getState(), changed: string[] = [];
  for (const [id, key] of Object.entries(job.results ?? {})) {
    const tracker = store.clips.find(c => c.id === job.clipId)?.motionTrackers?.find(t => t.id === id);
    if (!tracker || (tracker.result?.key ?? null) === key) continue;
    if ((tracker.result?.key ?? null) !== (job.bases[id] ?? null)) { store.notify(`${tracker.name} changed while it was tracking. Track it again to include this run.`, 'info'); continue; }
    useEditorStore.getState().updateMotionTracker(job.clipId, id, { result: { key } });
    const saved = useEditorStore.getState().clips.find(c => c.id === job.clipId)?.motionTrackers?.find(t => t.id === id);
    if (saved?.result?.key === key) changed.push(id);
    else store.notify(`${tracker.name}'s new track could not be saved here (the clip may be locked). Track it again.`, 'error');
  }
  if (!changed.length) return;
  await connection.flush();
  for (const id of changed) await refreshLinks(job.clipId, id);
}

export async function stopTracker() {
  const job = useTrackerEditor.getState().job;
  if (!job?.id || !['queued', 'running'].includes(job.status)) return;
  try { await api(`/motion-trackers/jobs/${job.id}?projectId=${encodeURIComponent(job.projectId)}`, { method: 'DELETE' }); }
  catch (error) { useEditorStore.getState().notify((error as Error).message, 'error'); }
}

/** Remove the analysis between two source times; placed points stay. */
export async function clearTrack(clipId: string, trackerId: string, from: number, to: number) {
  const { state, clip } = lookup(clipId), tracker = clip?.motionTrackers?.find(t => t.id === trackerId);
  if (!clip || !tracker?.result) return;
  try {
    await connection.flush();
    const { key } = await api<{ key: string | null }>('/motion-trackers/clear', { method: 'POST', body: JSON.stringify({ clipId, trackerId, from, to }) });
    useEditorStore.getState().updateMotionTracker(clipId, trackerId, { result: key ? { key } : undefined });
    await connection.flush();
    await refreshLinks(clipId, trackerId);
  } catch (error) { state.notify((error as Error).message, 'error'); }
}

/** Everything the apply arithmetic reads about the tracked clip: its track, source and project geometry, and
 *  Stabilize's warp when the picture is stabilized (the track is measured on the original). */
async function applyContext(clip: Clip, tracker: MotionTracker): Promise<ApplyContext> {
  const { asset, project } = lookup(clip.id);
  if (!asset || !project) throw Error('The tracked clip or its project is unavailable.');
  const samples = tracker.result ? await loadSamples(clip.projectId, tracker.result.key) : undefined;
  const path: TrackPoint[] = trackerPath(tracker, samples);
  if (!path.length) throw Error(`Place ${tracker.name} and track it before applying it.`);
  const effect = stabilizeEffect(clip);
  let warp: ApplyContext['warp'];
  if (effect) {
    const solved = await api<StabilizePreview>('/stabilize', { method: 'POST', body: JSON.stringify({ clipId: clip.id, fps: asset.fps || 24, settings: stabilizeSettings(clip, effect) }) });
    if (solved.status !== 'ready' || !solved.solve) throw Error('Stabilize is still analyzing this clip. Apply the track once it is ready.');
    const solve = solved.solve;
    warp = time => stabilizeMatrixAt(solve, time);
  }
  return { tracked: clip, asset, source: sourceSize(asset), project: projectSize(project.resolution), fps: project.fps || 24, path, warp };
}

/** Attach `targetId` to the track, keeping it where it is now at the playhead (or where it was first attached). */
export async function attachLayer(clipId: string, trackerId: string, targetId: string, options: MotionTrackerLayerOptions) {
  const { state, clip } = lookup(clipId), target = state.clips.find(c => c.id === targetId), tracker = clip?.motionTrackers?.find(t => t.id === trackerId);
  if (!clip || !target || !tracker) return false;
  try {
    const context = await applyContext(clip, tracker), frames = sharedFrames(clip, target, context.fps);
    if (!frames.length) throw Error(`${target.name} is not on screen while ${clip.name} plays.`);
    const previous = tracker.links?.find(link => link.clipId === targetId && link.target === 'layer');
    const time = previous ? anchorFrame(context, frames, previous.time) : attachFrame(context, frames, state.playhead);
    if (time === undefined) throw Error(`${tracker.name} has no track while ${target.name} is on screen. Track that part of the shot first.`);
    const pose = evaluateClip(target, time, context.fps).properties, source = clipSourceTime(clip, time, context.asset);
    // The frame first attached on may have lost its track (cleared, or trimmed away): attach again on the nearest
    // tracked one, where the layer is now, so it stays put rather than jumping by the track's motion in between.
    const kept = previous && Math.abs(source - previous.time) <= .5 / (context.asset.fps || 24);
    const base = kept ? previous.base : { x: Number(pose.x ?? 0) - (previous?.layer?.offsetX ?? 0), y: Number(pose.y ?? 0) - (previous?.layer?.offsetY ?? 0), zoom: Number(pose.zoom ?? 100), rotation: Number(pose.rotation ?? 0) };
    const channels = layerKeyframes(context, target, time, base, options, trackerKeyPrefix(trackerId));
    if (!channels) throw Error(`${tracker.name} has no track while ${target.name} is on screen. Track that part of the shot first.`);
    const link: MotionTrackerLink = { clipId: targetId, target: 'layer', time: source, base, layer: options };
    const applied = useEditorStore.getState().applyMotionTracker(clipId, trackerId, targetId, channels, link);
    if (applied) await connection.flush();
    return applied;
  } catch (error) { state.notify((error as Error).message, 'error'); return false; }
}

/** Make the tracked clip itself follow the track: repositioned, and zoomed so no edge ever shows. Layers attached to
 *  this clip's tracks ride the picture it moves, so they are applied again afterwards unless `layers` is false. */
export async function followCamera(clipId: string, trackerId: string, options: MotionTrackerCameraOptions, layers = true) {
  const { state, clip } = lookup(clipId), tracker = clip?.motionTrackers?.find(t => t.id === trackerId);
  if (!clip || !tracker) return false;
  try {
    const context = await applyContext(clip, tracker), frames = sharedFrames(clip, clip, context.fps);
    const previous = tracker.links?.find(link => link.clipId === clipId && link.target === 'camera');
    const time = previous ? anchorFrame(context, frames, previous.time) : attachFrame(context, frames, state.playhead);
    if (time === undefined) throw Error(`${tracker.name} has no track on this clip yet.`);
    const pose = evaluateClip(clip, time, context.fps).properties;
    const base = previous?.base ?? { x: Number(pose.x ?? 0), y: Number(pose.y ?? 0), zoom: Number(pose.zoom ?? 100), rotation: Number(pose.rotation ?? 0) };
    const channels = cameraKeyframes(context, time, base, options, trackerKeyPrefix(trackerId));
    if (!channels) throw Error(`${tracker.name} has no track on this clip yet.`);
    const link: MotionTrackerLink = { clipId, target: 'camera', time: clipSourceTime(clip, time, context.asset), base, camera: options };
    const applied = useEditorStore.getState().applyMotionTracker(clipId, trackerId, clipId, channels, link);
    if (applied) await connection.flush();
    if (applied && layers) await refreshLayers(clipId);
    return applied;
  } catch (error) { state.notify((error as Error).message, 'error'); return false; }
}

/** Apply a changed track again to every layer it drives, with the options and placement each was attached with.
 *  A camera follow goes first: the layers are placed on the picture it moves, including other trackers' layers. */
export async function refreshLinks(clipId: string, trackerId: string) {
  const { state, clip } = lookup(clipId), tracker = clip?.motionTrackers?.find(t => t.id === trackerId);
  const camera = clip && tracker?.links?.find(link => link.target === 'camera' && link.camera && linkApplies(clip, link, state.clips));
  if (camera) await followCamera(clipId, trackerId, camera.camera!);
  else await refreshLayers(clipId, trackerId);
}

/** Apply again every layer link of the clip's trackers (or of `trackerId` alone). */
async function refreshLayers(clipId: string, trackerId?: string) {
  const { state, clip } = lookup(clipId);
  for (const tracker of clip?.motionTrackers ?? []) {
    if (trackerId && tracker.id !== trackerId) continue;
    for (const link of tracker.links ?? []) if (link.target === 'layer' && link.layer && linkApplies(clip!, link, state.clips)) await attachLayer(clipId, tracker.id, link.clipId, link.layer);
  }
}

/** Stop a layer following the track. Its keyframes stay, so nothing jumps; a later track change no longer moves it. */
export function unlink(clipId: string, trackerId: string, targetId: string) {
  const { clip } = lookup(clipId), tracker = clip?.motionTrackers?.find(t => t.id === trackerId);
  if (!tracker) return;
  const links = (tracker.links ?? []).filter(link => link.clipId !== targetId);
  useEditorStore.getState().updateMotionTracker(clipId, trackerId, { links: links.length ? links : undefined });
}
