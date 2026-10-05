// Motion trackers: see the exact source frame, place points, track on the server, clear, attach a layer or make the
// clip follow the point. Adding, renaming, boxes, settings and deleting are plain act (addMotionTracker /
// updateMotionTracker / deleteMotionTracker); the "tracking" topic has the recipes.
//
// Attach, follow, clear and link refresh run the editor's own client (src/services/motionTrackerClient.ts). Tracking
// itself is polled here, inside job calls, and installed the way its commitResults does: the client's runTracker
// would keep polling and saving in the background, between and during other tool calls.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { call, ApiFailure, edit, handle, need, clip as clipOf, store, done, image, bytes, sleep, type JobDef, type Poller, type Step } from './kit.ts';
import { flush, settle } from '../session.ts';
import { secs } from '../views.ts';
import type { Runner } from '../edit.ts';
import type { EditorStore } from '../../src/state/store.ts';
import type { Clip, MediaAsset } from '../../src/state/models.ts';
import type { ApiError } from '../../src/services/api.ts';
import { isComposition } from '../../src/services/compositions.ts';
import { isCaption } from '../../src/services/captions.ts';
import {
  clipFrames, defaultCameraOptions, defaultLayerOptions, frameAt, linkApplies, MAX_TRACKERS, pictureTimeAt, placeKey, playheadShowing, trackerKeyPrefix,
  trackerPath, validateCameraOptions, validateLayerOptions, type MotionTracker, type MotionTrackerCameraOptions, type MotionTrackerLayerOptions, type TrackPoint,
} from '../../src/services/motionTracker.ts';

// The client (and sourceFocus / smartMaskClient it pulls in) imports without extensions, as Vite allows; Node needs '.ts'.
let loaded: Promise<typeof import('../../src/services/motionTrackerClient.ts')> | undefined;
const app = () => loaded ??= import('../../src/services/motionTrackerClient.ts');

type JobView = { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; rows: [string, ...number[]][]; next: number; results?: Record<string, string>; bases: Record<string, string | null>; stops: Record<string, { frame: number; time: number; reason: string }>; warnings: { tracker: string; message: string }[]; error?: string };
type Frame = { clip: Clip; asset: MediaAsset; fps: number; times: number[]; bounds: { first: number; last: number }; frame: number; time: number; at: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const optional = (params: Record<string, any>, key: string) => params[key] === undefined ? undefined : need<number>(params, key, 'number');

/** The source frame trackers use at timeline second `t` (default playhead): the frame the program shows there, inside
 *  the frames the clip reads. Also opens the clip's project and timeline, which edits and the playhead need. */
async function frameOf(id: unknown, t?: number): Promise<Frame> {
  let s = store.getState();
  const clip = clipOf(id), asset = s.media.find(m => m.id === clip.mediaId);
  if (!asset || asset.kind !== 'video' || isComposition(clip)) throw new Error(`Trackers go on video clips; ${handle(clip.id)} is not one.`);
  if (s.projectId !== clip.projectId) s.openProject(clip.projectId);
  if (store.getState().timelineId !== clip.timelineId) store.getState().setTimeline(clip.timelineId);
  s = store.getState();
  const fps = s.projects.find(p => p.id === clip.projectId)?.fps || 24, { loadSourceTimes } = await app();
  let times: number[];
  for (let attempt = 0; ; attempt++) {
    try { times = await loadSourceTimes(clip); break; }
    catch (error) { if ((error as ApiError).status !== 429 || attempt >= 10) throw error; await sleep(1000); }
  }
  const bounds = clipFrames(clip, asset, times), at = clamp(t ?? s.playhead, clip.start, clip.start + clip.duration - 1e-6);
  const frame = clamp(frameAt(times, pictureTimeAt(clip, asset, at, fps)), bounds.first, bounds.last);
  return { clip, asset, fps, times, bounds, frame, time: times[frame], at };
}

function trackerOf(clip: Clip, want?: unknown): MotionTracker {
  const list = clip.motionTrackers ?? [], name = String(want ?? '').toLowerCase();
  const found = want === undefined ? (list.length === 1 ? list[0] : undefined) : list.find(t => t.id === want || t.name.toLowerCase() === name);
  if (found) return found;
  throw new Error(!list.length ? `No trackers on ${handle(clip.id)}. Place one: job track-point{clip,t,x,y}.` : want === undefined ? `${handle(clip.id)} has ${list.length} trackers; pass params.tracker.` : `No tracker ${want} on ${handle(clip.id)}. job trackers{clip} lists them.`);
}
const fresh = (clipId: string, trackerId: string) => trackerOf(clipOf(clipId), trackerId);

async function pathOf(clip: Clip, tracker: MotionTracker) {
  const samples = tracker.result ? await (await app()).loadSamples(clip.projectId, tracker.result.key).catch(() => undefined) : undefined;
  return { path: trackerPath(tracker, samples), missing: !!tracker.result && !samples };
}

/** One line per tracker, the Inspector card's counts (MotionTrackerInspector.tsx) plus the tracked stretches in timeline seconds. */
async function summary(clip: Clip, asset: MediaAsset, fps: number, tracker: MotionTracker) {
  const { path, missing } = await pathOf(clip, tracker), gap = 1.5 / tracker.source.fps;
  const tracked = path.filter(p => p.flag !== 1).length, bridged = path.filter(p => p.flag === 2).length;
  const doubtful = path.filter(p => p.flag !== 1 && p.confidence < tracker.minConfidence).length;
  const spans: string[] = [];
  const span = (a: TrackPoint, b: TrackPoint) => {
    const x = playheadShowing(clip, asset, a.time, fps), y = playheadShowing(clip, asset, b.time, fps);
    spans.push(x === undefined || y === undefined ? `src ${secs(a.time)}–${secs(b.time)}` : x === y ? secs(x) : `${secs(Math.min(x, y))}–${secs(Math.max(x, y))}`);
  };
  for (let i = 0, start = 0; i < path.length; i++) if (i === path.length - 1 || path[i + 1].time - path[i].time >= gap) { span(path[start], path[i]); start = i + 1; }
  const links = (tracker.links ?? []).filter(l => linkApplies(clip, l, store.getState().clips)).map(l => l.target === 'camera' ? 'camera' : handle(l.clipId));
  return `${handle(tracker.id)} ${JSON.stringify(tracker.name)} ${tracker.model} · ${tracked} tracked · ${tracker.keys.length} placed${bridged ? ` · ${bridged} bridged` : ''}${doubtful ? ` · ${doubtful} doubtful` : ''}`
    + `${spans.length ? ` · ${spans.slice(0, 6).join(', ')}${spans.length > 6 ? ` +${spans.length - 6}` : ''}s` : ''}${missing ? ' · result missing on server, track again' : ''}${links.length ? ` · moves ${links.join(', ')}` : ''}`;
}

/** Clips that can follow the track: on a video track of the same timeline while it plays, text and shapes first
 *  (MotionTrackerInspector.tsx useTargets). */
function targets(clip: Clip) {
  const s = store.getState(), graphic = (c: Clip) => Number(c.mediaId === 'frameline-title' || c.mediaId === 'frameline-shape');
  return s.clips.filter(c => c.id !== clip.id && c.timelineId === clip.timelineId && !isCaption(c) && s.tracks.find(t => t.id === c.trackId)?.kind === 'video' && c.start < clip.start + clip.duration && c.start + c.duration > clip.start)
    .sort((a, b) => graphic(b) - graphic(a) || a.start - b.start);
}

/** One saved batch around the tracker client, which reports problems as toasts: an error toast fails the batch
 *  (whatever it had not saved yet is dropped), other toasts come back as notes. */
async function batch<T>(body: (run: Runner) => Promise<T>) {
  const notes: string[] = [];
  const { value } = await edit(async run => {
    const notify = store.getState().notify;
    let error = '';
    store.setState({ notify: ((title, kind = 'info', detail) => { const line = detail ? `${title} — ${detail}` : title; if (kind === 'error') error ||= line; else notes.push(line); notify(title, kind, detail); }) as EditorStore['notify'] });
    try { const value = await body(run); await settle(); if (error) throw new Error(error); return value; }
    finally { store.setState({ notify }); }
  });
  return { value, notes: notes.length ? `\nnotes: ${[...new Set(notes)].join(' | ')}` : '' };
}

/** Keys the tracker wrote on `target`: span in timeline seconds and count per channel. */
function keysOn(target: Clip, trackerId: string) {
  const prefix = trackerKeyPrefix(trackerId), counts: string[] = [];
  let lo = Infinity, hi = -Infinity, zoom: number[] = [];
  for (const [path, keys] of Object.entries(target.keyframes ?? {})) {
    const mine = keys.filter(k => k.id.startsWith(prefix));
    if (!mine.length) continue;
    counts.push(`${path.replace(/^properties\./, '')} ${mine.length}`);
    lo = Math.min(lo, mine[0].time); hi = Math.max(hi, mine.at(-1)!.time);
    if (path === 'properties.zoom') zoom = mine.map(k => Number(k.value));
  }
  if (!counts.length) return 'no keys';
  return `${secs(target.start + lo)}–${secs(target.start + hi)}s · keys ${counts.join(' ')}${zoom.length ? ` · zoom ${Math.round(Math.min(...zoom))}–${Math.round(Math.max(...zoom))}%` : ''}`;
}

/** The options given in params, over the link's current ones (or the defaults), as the Inspector forms hold them. */
function options<T extends object>(params: Record<string, any>, base: T): T {
  const picked = Object.fromEntries(Object.keys(base).filter(k => params[k] !== undefined).map(k => [k, params[k]]));
  return { ...base, ...picked };
}

/** This process's runs that nobody has polled to the end yet, by tracker: one run at a time each, as in the editor. */
const active = new Map<string, () => Promise<Step>>();

const REASONS: Record<string, string> = { lost: 'lost the subject (place the point again there, then track on)', 'left-frame': 'the point left the picture', key: 'reached a placed point', end: 'reached the clip end' };

/** Installs a run's results like motionTrackerClient's commitResults: only where the tracker still points at the
 *  result the run started from, saved, then the layers it drives are applied again. */
async function install(view: JobView, clipId: string) {
  const notes: string[] = [], changed: string[] = [];
  // Decided inside the batch, on the copy it has just caught up with: someone may have re-tracked meanwhile.
  await edit(async run => {
    for (const [id, key] of Object.entries(view.results ?? {})) {
      const t = clipOf(clipId).motionTrackers?.find(x => x.id === id);
      if (!t || (t.result?.key ?? null) === key) continue;
      if ((t.result?.key ?? null) !== (view.bases[id] ?? null)) { notes.push(`${t.name} changed while it was tracking; track it again to include this run`); continue; }
      await run('updateMotionTracker', clipId, id, { result: { key } }); changed.push(id);
    }
  });
  for (const id of changed) {
    const c = clipOf(clipId), links = (fresh(clipId, id).links ?? []).filter(l => linkApplies(c, l, store.getState().clips)).length;
    if (!links) continue;
    try { notes.push(`re-applied ${links} link${links === 1 ? '' : 's'}${(await batch(async () => (await app()).refreshLinks(clipId, id))).notes.replace('\nnotes:', ';')}`); }
    catch (error) { notes.push(`links not re-applied: ${(error as Error).message}`); }
  }
  return notes;
}

/** The source frame (cropped to `zoom`, scaled to `width`) with a grid in source fractions, labelled along the top and
 *  left, and each tracker's pattern box and point in its colour: coordinates the model reads off the picture itself,
 *  whatever size it is shown at. The grid is mask-view's (mcp/jobs/masks.ts). */
async function picture(f: Frame, [x0, y0, x1, y1]: number[], width: number, marks: { t: MotionTracker; p?: TrackPoint }[]) {
  const zoomed = x1 - x0 < 1 || y1 - y0 < 1;
  const source = await loadImage(await bytes(`/smart-masks/source?clipId=${encodeURIComponent(f.clip.id)}&frame=${f.frame}${zoomed ? '' : '&size=display'}`));
  const sw = (x1 - x0) * source.width, sh = (y1 - y0) * source.height, scale = width / Math.max(sw, sh);
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale)), canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  ctx.drawImage(source, x0 * source.width, y0 * source.height, sw, sh, 0, 0, w, h);
  const px = (v: number) => (v - x0) / (x1 - x0) * w, py = (v: number) => (v - y0) / (y1 - y0) * h;
  const label = (text: string, lx: number, ly: number, color = '#fff') => { ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3; ctx.strokeText(text, lx, ly); ctx.fillStyle = color; ctx.fillText(text, lx, ly); ctx.lineWidth = 1; };
  const step = [.1, .05, .02, .01].find(s => Math.max(x1 - x0, y1 - y0) / s >= 5) ?? .01, digits = step < .1 ? 2 : 1;
  ctx.font = '11px sans-serif';
  for (let k = Math.ceil(x0 / step + 1e-9); k * step < x1 - 1e-9; k++) { const gx = Math.round(px(k * step)) + .5; ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); label((k * step).toFixed(digits).replace(/^0/, ''), gx + 2, 11); }
  for (let k = Math.ceil(y0 / step + 1e-9); k * step < y1 - 1e-9; k++) { const gy = Math.round(py(k * step)) + .5; ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); label((k * step).toFixed(digits).replace(/^0/, ''), 2, gy - 2); }
  for (const { t, p } of marks) {
    if (!p) continue;
    const grow = t.model === 'similarity' ? p.scale : 1, bw = t.feature.width * grow / (x1 - x0) * w, bh = t.feature.height * grow / (y1 - y0) * h, cx = px(p.x), cy = py(p.y);
    ctx.strokeStyle = t.color; ctx.lineWidth = 1.5; ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.beginPath(); ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5); ctx.stroke();
    label(t.name, cx + bw / 2 + 3, cy - bh / 2 + 9, t.color);
  }
  return image(await canvas.encode('jpeg', 80));
}

export const jobs: Record<string, JobDef> = {
  trackers: {
    doc: '{clip} trackers on a video clip: tracked frames, stretches (timeline s), links, attach targets. help tracking',
    async start(params) {
      const c = clipOf(need(params, 'clip')), asset = store.getState().media.find(m => m.id === c.mediaId);
      const fps = store.getState().projects.find(p => p.id === c.projectId)?.fps || 24, list = c.motionTrackers ?? [];
      const lines = asset ? await Promise.all(list.map(t => summary(c, asset, fps, t))) : [];
      const near = targets(c).slice(0, 10).map(t => `${handle(t.id)} ${JSON.stringify(t.name)} ${secs(t.start)}–${secs(t.start + t.duration)}`);
      return done([lines.length ? lines.join('\n') : `No trackers on ${handle(c.id)}. Place one: job track-point{clip,t,x,y} (look first: job track-frame).`, `attach targets: ${near.join(', ') || 'none (put a title or shape above this clip)'}`].join('\n'));
    },
  },
  'track-frame': {
    doc: '{clip, t?, zoom?:[x0,y0,x1,y1], width?:768} the source frame trackers use at t: JPEG with an x,y grid (0–1 of source) and each tracker\'s point+box',
    async start(params) {
      const f = await frameOf(need(params, 'clip'), optional(params, 't'));
      const zoom = params.zoom === undefined ? [0, 0, 1, 1] : params.zoom;
      if (!Array.isArray(zoom) || zoom.length !== 4 || !zoom.every(v => typeof v === 'number' && v >= 0 && v <= 1) || zoom[2] <= zoom[0] || zoom[3] <= zoom[1]) throw new Error('zoom is [x0,y0,x1,y1] in 0–1 of the source frame, x0<x1, y0<y1.');
      const marks = await Promise.all((f.clip.motionTrackers ?? []).map(async t => ({ t, p: (await pathOf(f.clip, t)).path.find(q => Math.abs(q.time - f.time) < .5 / t.source.fps) })));
      const lines = marks.map(({ t, p }) => `${handle(t.id)} ${JSON.stringify(t.name)} ${p ? `(${p.x.toFixed(3)},${p.y.toFixed(3)}) ${p.flag === 1 ? 'placed' : `${Math.round(p.confidence * 100)}%${p.flag === 2 ? ' bridged' : ''}`}` : 'none'} · box ${t.feature.width.toFixed(3)}×${t.feature.height.toFixed(3)}`);
      const head = `t ${secs(f.at)}s · frame ${f.frame} (clip frames ${f.bounds.first}–${f.bounds.last}) · src ${secs(f.time)}s · grid = x,y 0–1 of source`;
      return done([head, ...lines].join('\n'), [await picture(f, zoom as number[], Math.min(1280, Math.max(256, Number(params.width) || 768)), marks)]);
    },
  },
  'track-point': {
    doc: '{clip, t?, x, y, tracker?, box?:{w,h}, remove?} place/move a point (0–1 of source) on the frame at t; no tracker = new one',
    async start(params) {
      const f = await frameOf(need(params, 'clip'), optional(params, 't')), id = f.clip.id;
      const where = `t ${secs(f.at)}s (frame ${f.frame})`;
      if (params.remove === true) {
        const t = trackerOf(f.clip, params.tracker), keys = t.keys.filter(k => Math.abs(k.time - f.time) >= .5 / t.source.fps);
        if (keys.length === t.keys.length) throw new Error(`${t.name} has no placed point at ${where}.`);
        await edit(run => run('updateMotionTracker', id, t.id, { keys }));
        return done(`${handle(t.id)} point removed at ${where} · ${keys.length} placed`);
      }
      const x = need<number>(params, 'x', 'number'), y = need<number>(params, 'y', 'number');
      if (x < 0 || x > 1 || y < 0 || y > 1) throw new Error('x,y are 0–1 of the source picture (read them off the track-frame grid), not pixels.');
      const box = params.box === undefined ? undefined : need<{ w: number; h: number }>(params, 'box', 'object');
      if (box && ![box.w, box.h].every(v => typeof v === 'number' && v >= .002 && v <= 1)) throw new Error('box {w,h} are fractions of the source picture, .002–1.');
      let trackerId = params.tracker === undefined ? '' : trackerOf(f.clip, params.tracker).id;
      await edit(async run => {
        if (!trackerId) {
          if ((f.clip.motionTrackers?.length ?? 0) >= MAX_TRACKERS) throw new Error(`A clip holds at most ${MAX_TRACKERS} trackers.`);
          trackerId = String(await run('addMotionTracker', id, { x, y, time: f.time }) ?? '');
          if (!trackerId) throw new Error(`No tracker could be added to ${handle(id)}.`);
        }
        const t = fresh(id, trackerId), reach = { x: t.search.width / t.feature.width, y: t.search.height / t.feature.height };
        // A drawn box keeps the search area's ratio to it, as MotionTrackerEditor's box drag does.
        const boxes = box ? { feature: { width: box.w, height: box.h }, search: { width: Math.min(1, Math.max(box.w * 1.2, box.w * reach.x)), height: Math.min(1, Math.max(box.h * 1.2, box.h * reach.y)) } } : {};
        const keys = params.tracker === undefined ? t.keys : placeKey(t, f.time, x, y);
        if (params.tracker !== undefined || box) await run('updateMotionTracker', id, trackerId, { keys, ...boxes });
      });
      const t = fresh(id, trackerId);
      return done(`${params.tracker === undefined ? `+ tracker ${handle(trackerId)} ${JSON.stringify(t.name)}` : handle(trackerId)} point at ${where} · ${t.keys.length} placed${box ? ` · box ${box.w}×${box.h}` : ''}`);
    },
  },
  track: {
    doc: '{clip, tracker?|"all"|[ids], t?, dir?:"back", frames?} track on the server from the frame at t and install the result → frames, stop reason',
    async start(params) {
      const caps = await call<{ available: boolean; reason?: string }>('/motion-trackers/capabilities');
      if (!caps.available) throw new Error(caps.reason ?? 'The motion tracker is not available on this server.');
      const f = await frameOf(need(params, 'clip'), optional(params, 't')), clipId = f.clip.id, projectId = f.clip.projectId;
      const wanted = params.tracker === 'all' ? (f.clip.motionTrackers ?? []).map(t => t.id) : Array.isArray(params.tracker) ? params.tracker : [params.tracker];
      const ids = [...new Set(wanted.map((w: unknown) => trackerOf(f.clip, w).id))] as string[];
      if (!ids.length) throw new Error(`No trackers on ${handle(clipId)}.`);
      for (const id of ids) {
        // An earlier run left to the background: look at it once (installing it if it ended) before starting another.
        const step = await active.get(id)?.().catch(() => undefined);
        if (step && !step.done) throw new Error(`${handle(id)} is still tracking (${step.text}). Poll that job to the end or cancel it first.`);
      }
      const back = ['back', 'backward', 'backwards'].includes(params.dir), frames = optional(params, 'frames');
      // The server reads trackers from its saved copy.
      await flush();
      let view = await call<JobView>('/motion-trackers/track', { method: 'POST', json: { clipId, trackerIds: ids, time: f.time, direction: back ? 'backward' : 'forward', ...(frames !== undefined ? { frames } : {}) } });
      const counts: Record<string, number> = {}, count = (v: JobView) => { for (const row of v.rows) counts[row[0]] = (counts[row[0]] ?? 0) + 1; };
      count(view);
      let next = view.next, errors = 0, finished: Promise<Step> | undefined;
      const tally = () => ids.map(id => `${handle(id)} +${counts[id] ?? 0}f`).join(' ');
      const settled = () => !['queued', 'running'].includes(view.status);
      const finish = () => finished ??= (async () => {
        const notes = await install(view, clipId), c = clipOf(clipId);
        const per = ids.map(id => {
          const stop = view.stops[id], at = stop && playheadShowing(c, f.asset, stop.time, f.fps);
          // The worker calls running out of `frames` the end too.
          const reason = stop && (stop.reason === 'end' && frames && Math.abs(stop.frame - f.frame) === frames ? `did the ${frames} frame${frames === 1 ? '' : 's'} asked` : stop.reason === 'end' && back ? 'reached the clip start' : REASONS[stop.reason] ?? stop.reason);
          return `${handle(id)} +${counts[id] ?? 0}f${stop ? `, ${reason}${at !== undefined ? ` at ${secs(at)}s` : ''}` : ''}`;
        });
        const lines = await Promise.all(ids.filter(id => c.motionTrackers?.some(t => t.id === id)).map(id => summary(c, f.asset, f.fps, fresh(clipId, id))));
        return done([`${view.status === 'done' ? 'tracked' : `track ${view.status}`}${view.error ? `: ${view.error}` : ''} · ${back ? 'back' : 'forward'} from ${secs(f.at)}s · ${per.join(' · ')}`,
          ...view.warnings.map(w => `warning: ${w.message}`), ...lines, ...(notes.length ? [`notes: ${notes.join(' | ')}`] : [])].join('\n'));
      })();
      const step = async (): Promise<Step> => {
        if (settled()) return finish();
        try { view = await call<JobView>(`/motion-trackers/jobs/${view.id}?projectId=${encodeURIComponent(projectId)}&after=${next}`); errors = 0; }
        catch (error) {
          // Jobs live in server memory: gone after a restart or 10 minutes after finishing.
          if ((error instanceof ApiFailure && error.status === 404) || ++errors > 30) throw error;
          return { done: false, text: `tracking: server unreachable, retrying (${errors})` };
        }
        count(view); next = view.next;
        return settled() ? finish() : { done: false, text: `${view.status === 'queued' ? 'queued behind other server work' : `tracking ${view.progress}%`} · ${tally()}` };
      };
      const drop = () => { for (const id of ids) if (active.get(id) === poll) active.delete(id); };
      const poll = () => step().then(result => { if (result.done) drop(); return result; }, error => { drop(); throw error; });
      if (settled()) return finish();
      for (const id of ids) active.set(id, poll);
      const poller: Poller = {
        label: `track ${ids.map(handle).join(',')}`,
        poll,
        async cancel() {
          if (settled()) return;
          await call(`/motion-trackers/jobs/${view.id}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
          // A stopped run still commits what it settled; keep it, as the editor does.
          for (let i = 0; i < 40 && !settled(); i++) { await sleep(250); await step().catch(() => {}); }
          if (settled()) await finish();
        },
      };
      return poller;
    },
  },
  'track-clear': {
    doc: '{clip, tracker, t, side:"before"|"after"} or {clip, tracker, from, to} drop tracked frames (timeline s); placed points stay',
    async start(params) {
      const id = need(params, 'clip');
      let from: number, to: number, f: Frame, span: string;
      if (params.side !== undefined) {
        f = await frameOf(id, optional(params, 't'));
        if (params.side === 'before') { if (f.frame <= f.bounds.first) throw new Error('Nothing before that frame.'); [from, to] = [f.times[f.bounds.first], f.times[f.frame - 1]]; }
        else if (params.side === 'after') { if (f.frame >= f.bounds.last) throw new Error('Nothing after that frame.'); [from, to] = [f.times[f.frame + 1], f.times[f.bounds.last]]; }
        else throw new Error('side is "before" or "after".');
        span = `${params.side} ${secs(f.at)}s`;
      } else {
        const a = await frameOf(id, need<number>(params, 'from', 'number'));
        f = await frameOf(id, need<number>(params, 'to', 'number'));
        [from, to] = [a.time, f.time];
        span = `${secs(a.at)}–${secs(f.at)}s`;
      }
      const t = trackerOf(f.clip, params.tracker);
      if (!t.result) return done(`${t.name} has no tracked frames to clear.`);
      const { notes } = await batch(async () => (await app()).clearTrack(f.clip.id, t.id, from, to));
      const after = fresh(f.clip.id, t.id);
      return done(`${after.result ? `cleared ${span}\n${await summary(f.clip, f.asset, f.fps, after)}` : `${handle(t.id)} track removed (${after.keys.length} placed points stay)`}${notes}`);
    },
  },
  'track-attach': {
    doc: `{clip, tracker, target, t?, ${Object.keys(defaultLayerOptions).map(k => `${k}?`).join(', ')}, unlink?} target clip follows the track; again = update`,
    async start(params) {
      const f = await frameOf(need(params, 'clip')), t = trackerOf(f.clip, params.tracker), targetId = need(params, 'target'), target = clipOf(targetId);
      if (params.unlink === true) {
        // The Inspector's Unlink: the link goes, the keyframes stay. target = the tracked clip ends its camera follow.
        if (!t.links?.some(l => l.clipId === targetId)) throw new Error(`${handle(targetId)} does not follow ${t.name}.`);
        const { notes } = await batch(async () => (await app()).unlink(f.clip.id, t.id, targetId));
        if (fresh(f.clip.id, t.id).links?.some(l => l.clipId === targetId)) throw new Error(`${handle(targetId)} could not be unlinked.${notes}`);
        return done(`${handle(targetId)} no longer follows ${handle(t.id)} (its keyframes stay)`);
      }
      if (targetId === f.clip.id) throw new Error('To move the tracked clip itself use job track-follow.');
      if (!targets(f.clip).some(c => c.id === targetId)) throw new Error(`${handle(targetId)} cannot follow ${handle(f.clip.id)}: a target is on a video track of the same timeline while it plays (job trackers lists them).`);
      const previous = t.links?.find(l => l.clipId === targetId && l.target === 'layer');
      const opts = options<MotionTrackerLayerOptions>(params, previous?.layer ?? defaultLayerOptions);
      const forced = t.model !== 'similarity' && (opts.scale || opts.rotation);
      // As the Inspector's LayerForm: scale and rotation come from a similarity track only.
      if (t.model !== 'similarity') Object.assign(opts, { scale: false, rotation: false });
      try { validateLayerOptions(opts); } catch { throw new Error('Layer options: scale/rotation true|false, smoothing 0–60, offsetX/offsetY ±100000 px.'); }
      const { value, notes } = await batch(async () => {
        if (params.t !== undefined) store.getState().setPlayhead(need<number>(params, 't', 'number'));
        return (await app()).attachLayer(f.clip.id, t.id, targetId, opts);
      });
      if (!value) throw new Error(`${handle(targetId)} could not be attached.${notes}`);
      return done(`${handle(targetId)} ${JSON.stringify(target.name)} follows ${handle(t.id)} · ${keysOn(clipOf(targetId), t.id)}${forced ? '\nnote: scale/rotation need model "similarity" (act updateMotionTracker, then track again)' : ''}${notes}`);
    },
  },
  'track-follow': {
    doc: `{clip, tracker, t?, ${Object.keys(defaultCameraOptions).map(k => `${k}?`).join(', ')}, layers?} keyframe the clip's own x/y/zoom so the point stays put`,
    async start(params) {
      const f = await frameOf(need(params, 'clip')), t = trackerOf(f.clip, params.tracker);
      const previous = t.links?.find(l => l.clipId === f.clip.id && l.target === 'camera');
      const opts = options<MotionTrackerCameraOptions>(params, previous?.camera ?? defaultCameraOptions);
      // As the Inspector's CameraForm: raising one zoom bound carries the other along.
      if (params.minZoom !== undefined && params.maxZoom === undefined) opts.maxZoom = Math.max(opts.maxZoom, opts.minZoom);
      if (params.maxZoom !== undefined && params.minZoom === undefined) opts.minZoom = Math.min(opts.minZoom, opts.maxZoom);
      if (t.model !== 'similarity') opts.rotation = false;
      try { validateCameraOptions(opts); } catch { throw new Error('Follow options: framing "keep"|"center", smoothing 0–60, zoom "dynamic"|"steady"|"off", minZoom ≤ maxZoom 1–800, rotation true|false, offsetX/offsetY ±100000 px.'); }
      const { value, notes } = await batch(async () => {
        if (params.t !== undefined) store.getState().setPlayhead(need<number>(params, 't', 'number'));
        return (await app()).followCamera(f.clip.id, t.id, opts, params.layers !== false);
      });
      if (!value) throw new Error(`${handle(f.clip.id)} could not follow ${t.name}.${notes}`);
      return done(`${handle(f.clip.id)} follows ${handle(t.id)} · ${keysOn(clipOf(f.clip.id), t.id)}${notes}`);
    },
  },
};

const LAYER = defaultLayerOptions, CAMERA = defaultCameraOptions;
export const topics: Record<string, string> = {
  tracking: [
    'tracking: motion trackers on a video clip. x,y = 0–1 of the SOURCE picture (0,0 top-left); t = timeline seconds (default playhead); frames snap to the source frame shown at t.',
    'recipe: job track-frame{clip,t} (see it; zoom:[x0,y0,x1,y1] to aim) → track-point{clip,t,x,y,box?} (new tracker) → track{clip,tracker,t} (dir:"back" for backward) → trackers{clip} → track-attach{clip,tracker,target} or track-follow{clip,tracker}.',
    'pick a point with detail and contrast (an eye, a logo, a corner), visible through the shot. box {w,h} (0–1 of source) is the pattern; default 5% of the short side, square. The search area keeps its ratio to the box (default 3×).',
    `act: addMotionTracker(clip) adds one with no point (≤${MAX_TRACKERS} per clip; a point needs track-point) · deleteMotionTracker(clip,tracker) (layers keep their keyframes) · updateMotionTracker(clip,tracker,patch).`,
    'patch fields: name (≤80); model "position"|"similarity" (similarity also measures scale+rotation: needed for attach scale/rotation and follow rotation; track again after switching); minConfidence .2–.98 (default .6, below = doubtful); whenLost "search"|"stop"; feature/search {width,height} .002/.004–1. Never write keys or result by hand.',
    'correct drift: track-point on the bad frame (a placed point wins there and fences later runs), then track again from it. track-point{remove:true} deletes the point on that frame. track-clear{clip,tracker,t,side:"before"|"after"} or {from,to} drops analysis; placed points stay.',
    'track runs on the server until the frame before the next placed point, the clip edge, frames:N, or a lost subject. Long runs return a job id: poll it until done, or the result is not installed (server forgets jobs 10 min after they end). cancel keeps the frames done so far.',
    `attach: target = a clip on a video track over the tracked frames (trackers lists them). The layer keeps where it is at t on first attach and moves with the point. options (defaults): ${JSON.stringify(LAYER)}; smoothing 0–60 frames, offsets in project px. Run again to change options.`,
    `follow: keyframes the tracked clip's x/y/zoom so the point stays on its mark without showing edges. options (defaults): ${JSON.stringify(CAMERA)}; framing keep|center, zoom dynamic|steady|off, min/maxZoom 1–800 %. layers:false skips re-applying attached layers.`,
    'unlink (keyframes stay): job track-attach{clip,tracker,target,unlink:true}; target = the tracked clip ends its camera follow.',
    'gotcha: re-tracking, clearing or re-attaching replaces keys "mt.<tracker>.*" and ANY keyframe inside the tracked span on x/y/zoom/rotation of the moved clip; hand keys there are lost. Stabilize on the tracked clip: attach/follow fail until its analysis is ready (job stabilize).',
  ].join('\n'),
};
