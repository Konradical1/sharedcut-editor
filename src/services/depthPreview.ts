// Depth in the editor: one analysis run per clip with an enabled Depth effect (started, polled and invalidated here),
// and per viewer a small cache of decoded depth frames looked up by the decoded picture's own source timestamp.
import type { Clip, Effect, MediaAsset } from '../state/models.ts';
import { api, connection } from './api.ts';
import { setClipActivity } from './clipStatus.ts';
import { DEPTH_SEGMENT, depthDistance, depthFrameAt, depthSegmentFor, type DepthRun } from './depth.ts';
import { effectEnabled } from './effects.ts';
import { stabilizeRange } from './stabilize.ts';

export type DepthClipState = { clipId: string; projectId: string; status: 'starting' | DepthRun['status']; progress: number; error?: string; run?: DepthRun; signature: string; context: string; controller: AbortController };
const runs = new Map<string, DepthClipState>(), listeners = new Set<() => void>();
let version = 0;
const POLL_MS = 400;

function publish(state: DepthClipState) {
  version++;
  for (const listener of listeners) listener();
  const status = state.status === 'ready' ? 'ready' : state.status === 'failed' || state.status === 'cancelled' ? 'failed' : 'preparing';
  setClipActivity(state.clipId, 'Depth', { kind: 'Depth', status, progress: Math.round(state.progress), error: state.error });
}
export function subscribeDepth(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const depthVersion = () => version;
export const depthState = (clipId: string) => runs.get(clipId);

/** What the clip's frames depend on beyond geometry: the colour interpretation the analysis LUT is built from. */
const contextOf = (clip: Clip, asset: MediaAsset) => { const p = clip.properties; return JSON.stringify([asset.id, p.inputProfile ?? null, p.inputGamut ?? null, p.dataLevels ?? null, p.yuvMatrix ?? null, asset.inputProfile ?? null, asset.inputGamut ?? null, asset.colorMatrix ?? null]); };
const signatureOf = (clip: Clip) => { const p = clip.properties; return JSON.stringify([clip.sourceIn, clip.duration, p.speed ?? 100, !!p.reverse, !!p.freeze, clip.keyframes?.['properties.speed'] ?? null]); };
/** Whether the run still holds every source frame the clip reads (it has one-second handles, so most trims fit). */
function covers(run: DepthRun | undefined, clip: Clip, asset: MediaAsset) {
  if (!run?.times.length) return false;
  if (asset.kind === 'image') return true;
  try { const range = stabilizeRange(clip, asset.fps, asset.duration); return depthFrameAt(run, range.from) >= 0 && depthFrameAt(run, Math.max(range.from, range.to - 1e-6)) >= 0; }
  catch { return true; }
}
/** Fold a poll into what this clip already knows. A full view (it carries `times`) replaces; `?after` views append. */
function merge(state: DepthClipState, next: DepthRun) {
  const known = state.run;
  state.run = !known || next.times.length || next.key !== known.key ? next : { ...next, times: known.times, segments: [...known.segments, ...next.segments.filter(s => !known.segments.some(k => k.n === s.n))] };
  Object.assign(state, { status: next.status, progress: next.status === 'ready' ? 100 : next.progress, error: next.error });
  publish(state);
}

function start(clip: Clip, asset: MediaAsset, signature: string, context: string) {
  runs.get(clip.id)?.controller.abort();
  const state: DepthClipState = { clipId: clip.id, projectId: clip.projectId, status: 'starting', progress: 0, signature, context, controller: new AbortController() };
  runs.set(clip.id, state); publish(state);
  const { signal } = state.controller;
  void (async () => {
    try {
      // The server reads the clip from the saved workspace: an unsaved trim would analyse the old range.
      await connection.flush();
      merge(state, await api<DepthRun>('/depth', { method: 'POST', body: JSON.stringify({ projectId: clip.projectId, clipId: clip.id }), signal }));
      while (!signal.aborted && (state.status === 'queued' || state.status === 'processing')) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        if (signal.aborted) return;
        merge(state, await api<DepthRun>(`/depth/${state.run!.key}?projectId=${encodeURIComponent(clip.projectId)}&after=${state.run!.next}`, { signal }));
      }
    } catch (error) {
      if (signal.aborted || runs.get(clip.id) !== state) return;
      Object.assign(state, { status: 'failed', error: (error as Error).message || 'Depth analysis failed.' }); publish(state);
    }
  })();
  return state;
}

/** Start or keep the clip's analysis. Re-asks the server only when the colour interpretation changed, or the clip
 *  now reads source frames its run does not hold. Idempotent: call it as often as the clip changes. */
export function ensureDepthRun(clip: Clip, asset: MediaAsset) {
  if (typeof fetch === 'undefined') return undefined;
  const signature = signatureOf(clip), context = contextOf(clip, asset), current = runs.get(clip.id);
  if (current && current.context === context) {
    if (current.signature === signature) return current;
    current.signature = signature;
    const alive = current.status !== 'failed' && current.status !== 'cancelled';
    if (alive && (current.status === 'starting' || covers(current.run, clip, asset))) return current;
  }
  return start(clip, asset, signature, context);
}
export function retryDepth(clip: Clip, asset: MediaAsset) { return start(clip, asset, signatureOf(clip), contextOf(clip, asset)); }
function release(clipId: string) {
  const state = runs.get(clipId);
  if (!state) return;
  state.controller.abort(); runs.delete(clipId); version++;
  for (const listener of listeners) listener();
  setClipActivity(clipId, 'Depth', undefined);
  // Nothing else here waits on it: free the GPU. A split sibling still reading the run keeps it going.
  const key = state.run?.key;
  if (key && (state.status === 'queued' || state.status === 'processing') && ![...runs.values()].some(other => other.run?.key === key))
    void api(`/depth/${key}?projectId=${encodeURIComponent(state.projectId)}`, { method: 'DELETE' }).catch(() => {});
}
/** Seconds into the clip that analysed depth reaches (forward clips; undefined before the first segment or when reversed). */
export function depthClipReady(clip: Clip, run: DepthRun) {
  const done = Math.min(run.times.length, run.segments.reduce((sum, s) => sum + s.count, 0));
  if (!done || clip.properties.reverse) return undefined;
  const last = run.times[done - 1] + (done > 1 ? run.times[done - 1] - run.times[done - 2] : 0);
  return Math.max(0, Math.min(clip.duration, (last - clip.sourceIn) / Math.max(.01, Number(clip.properties.speed ?? 100) / 100)));
}
export const depthEffect = (clip: Pick<Clip, 'effects' | 'properties'>) => clip.effects.find(e => e.name === 'Depth' && effectEnabled(clip as Clip, e));

type EditorLike = { getState: () => { projectId: string; clips: Clip[]; media: MediaAsset[] }; subscribe: (listener: (state: ReturnType<EditorLike['getState']>) => void) => unknown };
let watching = false;
/** Called once from the timeline (browser only): every clip in the open project with an enabled Depth effect keeps
 *  a run, whether or not it is under the playhead, so its progress shows on the clip and in the inspector. */
export function watchDepthClips(store: EditorLike) {
  if (watching || typeof window === 'undefined') return; watching = true;
  let clips: Clip[] | undefined, media: MediaAsset[] | undefined, project = '';
  const sync = (state: ReturnType<EditorLike['getState']>) => {
    if (state.clips === clips && state.media === media && state.projectId === project) return;
    clips = state.clips; media = state.media; project = state.projectId;
    const assets = new Map(state.media.map(asset => [asset.id, asset])), active = new Set<string>();
    for (const clip of state.clips) {
      const asset = assets.get(clip.mediaId);
      if (clip.projectId !== state.projectId || !depthEffect(clip) || !asset || !['video', 'image'].includes(asset.kind) || asset.status !== 'ready') continue;
      active.add(clip.id); ensureDepthRun(clip, asset);
    }
    for (const id of [...runs.keys()]) if (!active.has(id)) release(id);
  };
  sync(store.getState()); store.subscribe(sync);
}

/** Viewer-only settings: the depth-map view and the one-shot focus picker. Neither is saved nor exported. */
const ui = { showMap: new Map<string, boolean>(), picking: null as null | { clipId: string; effectId: string } };
export const depthUi = {
  get picking() { return ui.picking; },
  setPicking(value: typeof ui.picking) { ui.picking = value; version++; for (const listener of listeners) listener(); },
  /** On by default while the effect is untouched (you watch the map fill in); off once a preset or section is used. */
  showMap(effect: Effect) { return ui.showMap.get(effect.id) ?? !Object.keys(effect.parameters ?? {}).length; },
  setShowMap(effectId: string, value: boolean) { if (ui.showMap.get(effectId) === value) return; ui.showMap.set(effectId, value); version++; for (const listener of listeners) listener(); },
};

export type DepthPixels = { data: Uint8Array; width: number; height: number; key: string };
/** The depth each viewer last drew per clip, with a map from canvas pixels to the source box (0..1): the focus picker. */
const picks = new Map<string, { pixels: DepthPixels; near: number; far: number; toSource?: (x: number, y: number) => [number, number] | undefined }>();
export function rememberDepth(clipId: string, pick: typeof picks extends Map<string, infer T> ? T : never) { picks.set(clipId, pick); }
/** Distance 0..100 at a point of the source box (u, v in 0..1), from the frame shown last. */
export function depthAtSource(clipId: string, u: number, v: number) {
  const pick = picks.get(clipId);
  if (!pick || !(u >= 0 && u < 1 && v >= 0 && v < 1)) return undefined;
  const { data, width, height } = pick.pixels;
  return depthDistance(pick, data[Math.floor(v * height) * width + Math.floor(u * width)] / 255);
}
export function depthAtCanvas(clipId: string, x: number, y: number) { const point = picks.get(clipId)?.toSource?.(x, y); return point && depthAtSource(clipId, point[0], point[1]); }

export type DepthFrame = { state: 'none' } | { state: 'analyzing' } | { state: 'failed'; error: string } | { state: 'loading' } | { state: 'ready'; pixels: DepthPixels; run: DepthRun };
const RING = 32, AHEAD = 8, WINDOW = 16, SEGMENT_BYTES = 6;

/** Decoded depth for one viewer: whole segment MP4s fetched (prefetching the next), decoded in a worker into Y planes,
 *  at most RING frames kept. `frame()` never waits: the exact frame, else the one before it, else nothing. */
export function createDepthPreview(onReady: () => void) {
  type Request = { id: number; key: string; projectId: string; n: number; first: number; from: number; count: number };
  const ring = new Map<string, DepthPixels>(), segments = new Map<string, { bytes?: ArrayBuffer; retryAt?: number; controller: AbortController }>();
  const requests = new Map<number, Request>(), failed = new Map<string, number>();
  let worker: Worker | undefined, busy: Request | undefined, workerSegment = '', nextId = 0, wanted = '', disposed = false;
  const keep = (name: string, pixels: DepthPixels) => { ring.delete(name); ring.set(name, pixels); while (ring.size > RING) ring.delete(ring.keys().next().value!); };
  const bytesOf = (key: string, projectId: string, n: number) => {
    const name = `${key}:${n}`;
    let entry = segments.get(name);
    if (entry?.retryAt && Date.now() > entry.retryAt) { segments.delete(name); entry = undefined; }
    if (entry) { segments.delete(name); segments.set(name, entry); return entry.bytes; }
    while (segments.size >= SEGMENT_BYTES) { const [oldest, value] = segments.entries().next().value!; value.controller.abort(); segments.delete(oldest); }
    const created: { bytes?: ArrayBuffer; retryAt?: number; controller: AbortController } = { controller: new AbortController() };
    segments.set(name, created);
    void fetch(`/api/depth/${key}/preview/${n}.mp4?projectId=${encodeURIComponent(projectId)}`, { credentials: 'same-origin', signal: created.controller.signal })
      .then(response => { if (!response.ok) throw new Error(`Depth segment download failed (${response.status}).`); return response.arrayBuffer(); })
      .then(bytes => { created.bytes = bytes; if (busy && `${busy.key}:${busy.n}` === name && busy.id < 0) send(busy); })
      .catch(() => { created.retryAt = Date.now() + 2000; if (busy && `${busy.key}:${busy.n}` === name) busy = undefined; });
    return undefined;
  };
  const send = (request: Request) => {
    busy = request;
    const bytes = bytesOf(request.key, request.projectId, request.n);
    if (!bytes) { request.id = -1; return; } // Sent once the download lands.
    request.id = ++nextId; requests.set(request.id, request);
    if (requests.size > 4) requests.delete(requests.keys().next().value!);
    if (!worker) {
      worker = new Worker(new URL('./depthDecodeWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const owner = requests.get(data.id);
        if (data.type === 'frame' && owner) {
          const name = `${owner.key}:${owner.first + owner.n * DEPTH_SEGMENT + data.index}`;
          keep(name, { data: data.data, width: data.width, height: data.height, key: name });
          if (name === wanted && !disposed) onReady();
        } else if (data.type !== 'frame') {
          if (busy?.id === data.id) busy = undefined;
          // A segment this browser cannot decode is retried in two seconds, not on every frame.
          if (data.type === 'error') { workerSegment = ''; if (owner) failed.set(`${owner.key}:${owner.n}`, Date.now() + 2000); console.warn('Depth preview:', data.error); }
          requests.delete(data.id);
        }
      };
    }
    const segment = `${request.key}:${request.n}`;
    worker.postMessage({ id: request.id, segment, from: request.from, count: request.count, ...(workerSegment !== segment ? { buffer: bytes.slice(0) } : {}) });
    workerSegment = segment;
  };
  const inFlight = (key: string, frame: number) => !!busy && busy.key === key && frame >= busy.first + busy.n * DEPTH_SEGMENT + busy.from && frame < busy.first + busy.n * DEPTH_SEGMENT + busy.from + busy.count;
  /** Keep the next AHEAD frames decoded or decoding; a frame outside the running window replaces it. */
  const want = (run: DepthRun, projectId: string, frame: number) => {
    for (let f = frame; f < Math.min(frame + AHEAD, run.first + run.frames); f++) {
      if (ring.has(`${run.key}:${f}`) || inFlight(run.key, f)) continue;
      const at = depthSegmentFor(run, f);
      if (at && !((failed.get(`${run.key}:${at.segment.n}`) ?? 0) > Date.now())) send({ id: 0, key: run.key, projectId, n: at.segment.n, first: run.first, from: at.offset, count: Math.min(WINDOW, at.segment.count - at.offset) });
      return;
    }
  };
  return {
    frame(clipId: string, time: number): DepthFrame {
      const state = runs.get(clipId);
      if (!state) return { state: 'none' };
      if (state.status === 'failed' || state.status === 'cancelled') return { state: 'failed', error: state.error || 'Depth analysis failed.' };
      const run = state.run, index = run ? depthFrameAt(run, time) : -1, at = run && index >= 0 ? depthSegmentFor(run, index) : undefined;
      if (!run || !at) return { state: 'analyzing' };
      wanted = `${run.key}:${index}`;
      want(run, state.projectId, index);
      // Past three quarters of a segment, the next one downloads.
      if (at.offset >= DEPTH_SEGMENT * .75 && run.segments.some(s => s.n === at.segment.n + 1)) bytesOf(run.key, state.projectId, at.segment.n + 1);
      const exact = ring.get(wanted);
      if (exact) return { state: 'ready', pixels: exact, run };
      // One frame old at most: older depth slides off moving edges.
      const previous = ring.get(`${run.key}:${index - 1}`);
      return previous ? { state: 'ready', pixels: previous, run } : { state: 'loading' };
    },
    dispose() { disposed = true; worker?.terminate(); for (const entry of segments.values()) entry.controller.abort(); segments.clear(); ring.clear(); },
  };
}
