// Depth in the editor: one analysis run per clip with a Depth effect (started, polled and invalidated here), and per
// viewer a small cache of decoded depth frames looked up by the decoded picture's own source timestamp.
import type { Clip, Effect, GradeNode, MediaAsset } from '../state/models.ts';
import { api, ApiError, connection } from './api.ts';
import { setClipActivity } from './clipStatus.ts';
import { DEPTH_SEGMENT, depthDistance, depthFrameAt, depthKeyTable, depthSegmentFor, type DepthFocusTrack, type DepthRun } from './depth.ts';
import { effectEnabled } from './effects.ts';
import { isDepthKey, type DepthKeyBinding } from './smartMask.ts';
import type { SmartMaskPixels } from './smartMaskPreview.ts';
import { stabilizeRange } from './stabilize.ts';

/** `clip` and `asset` are the latest seen, so a run can be re-checked (or re-asked) without the store. */
export type DepthClipState = { clipId: string; projectId: string; status: 'starting' | DepthRun['status']; progress: number; error?: string; run?: DepthRun; signature: string; context: string; controller: AbortController; clip: Clip; asset: MediaAsset };
const runs = new Map<string, DepthClipState>(), listeners = new Set<() => void>();
let version = 0;
const POLL_MS = 400;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Worth asking again: the network or tunnel dropped, the server is restarting or busy, or a key is still stopping
 *  (409, which is also a viewer waiting for an editor to start the run). */
const transient = (error: unknown) => !(error instanceof ApiError) || [409, 429, 502, 503, 504].includes(error.status);

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
/** Fold a server view into what this clip knows. Polls leave `times` out once known (?times=0); a cursor behind ours
 *  means the server started this key over, so its segments replace ours. */
function merge(state: DepthClipState, next: DepthRun) {
  const known = state.run?.key === next.key ? state.run : undefined;
  const segments = known && next.next >= known.next ? [...known.segments, ...next.segments.filter(s => !known.segments.some(k => k.n === s.n))] : next.segments;
  state.run = { ...next, times: next.times.length ? next.times : known?.times ?? [], segments };
  Object.assign(state, { status: next.status, progress: next.status === 'ready' ? 100 : next.progress, error: next.error });
  publish(state);
}
/** Frees the GPU queue of a run nothing here reads any more; a split sibling still reading it keeps it, and the server
 *  keeps it for another project. */
function cancelRun(projectId: string, key: string) {
  if ([...runs.values()].some(other => other.run?.key === key)) return;
  void api(`/depth/${key}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' }).catch(() => {});
}
const running = (status: DepthClipState['status']) => status === 'queued' || status === 'processing';

function start(clip: Clip, asset: MediaAsset, signature: string, context: string) {
  const previous = runs.get(clip.id);
  previous?.controller.abort();
  const state: DepthClipState = { clipId: clip.id, projectId: clip.projectId, status: 'starting', progress: 0, signature, context, controller: new AbortController(), clip, asset };
  runs.set(clip.id, state); publish(state);
  // The run this replaces (another colour interpretation, or a range it no longer covers) would hold the GPU queue.
  if (previous?.run && running(previous.status)) cancelRun(previous.projectId, previous.run.key);
  const { signal } = state.controller;
  void (async () => {
    let delay = 1000;
    for (;;) {
      try {
        if (state.status === 'starting') {
          // The server reads the clip from the saved workspace: an unsaved trim would analyse the old range.
          await connection.flush();
          // Not abortable: a superseded request still names the run it queued, and that run is cancelled.
          const run = await api<DepthRun>('/depth', { method: 'POST', body: JSON.stringify({ projectId: clip.projectId, clipId: clip.id }) });
          if (signal.aborted) { if (signal.reason !== 'keep' && running(run.status)) cancelRun(clip.projectId, run.key); return; }
          merge(state, run);
          // A trim made while the request was out is checked now there is a run to check it against.
          ensureDepthRun(state.clip, state.asset);
          if (signal.aborted) return;
        }
        while (running(state.status)) {
          await sleep(POLL_MS);
          if (signal.aborted) return;
          merge(state, await api<DepthRun>(`/depth/${state.run!.key}?projectId=${encodeURIComponent(clip.projectId)}&after=${state.run!.next}&times=0`, { signal }));
          delay = 1000;
        }
        return;
      } catch (error) {
        if (signal.aborted || runs.get(clip.id) !== state) return;
        const message = (error as Error).message || 'Depth analysis failed.', retry = transient(error);
        // A dropped poll keeps the run and its progress; only an answer that will not change fails it.
        Object.assign(state, retry ? { error: message.replace(/\.?$/, ' · retrying') } : { status: 'failed', error: message }); publish(state);
        if (!retry) return;
        await sleep(delay); delay = Math.min(delay * 2, 30_000);
        if (signal.aborted) return;
      }
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
    Object.assign(current, { clip, asset });
    // While the request is out there is no run to check: start() checks the latest clip once it arrives.
    if (current.signature === signature || current.status === 'starting') return current;
    current.signature = signature;
    if (current.status !== 'failed' && current.status !== 'cancelled' && covers(current.run, clip, asset)) return current;
  }
  return start(clip, asset, signature, context);
}
export function retryDepth(clip: Clip, asset: MediaAsset) { return start(clip, asset, signatureOf(clip), contextOf(clip, asset)); }
/** Stop watching a clip. `cancel` also frees the server run (the effect or the clip is gone); otherwise the run goes on
 *  and the next look joins it (another project opened). */
function release(clipId: string, cancel: boolean) {
  const state = runs.get(clipId);
  if (!state) return;
  state.controller.abort(cancel ? undefined : 'keep'); runs.delete(clipId); version++;
  for (const listener of listeners) listener();
  setClipActivity(clipId, 'Depth', undefined);
  if (cancel && state.run && running(state.status)) cancelRun(state.projectId, state.run.key);
}
/** A ready run whose segments the server no longer has (its cache evicted it, or it went missing in a restart). */
function rerun(key: string) {
  for (const state of [...runs.values()]) if (state.status === 'ready' && state.run?.key === key) start(state.clip, state.asset, state.signature, state.context);
}
/** Seconds into the clip that analysed depth reaches (forward clips; undefined before the first segment or when reversed). */
export function depthClipReady(clip: Clip, run: DepthRun) {
  const done = Math.min(run.times.length, run.segments.reduce((sum, s) => sum + s.count, 0));
  if (!done || clip.properties.reverse) return undefined;
  const last = run.times[done - 1] + (done > 1 ? run.times[done - 1] - run.times[done - 2] : 0);
  return Math.max(0, Math.min(clip.duration, (last - clip.sourceIn) / Math.max(.01, Number(clip.properties.speed ?? 100) / 100)));
}
export const depthEffect = (clip: Pick<Clip, 'effects' | 'properties'>) => clip.effects.find(e => e.name === 'Depth' && effectEnabled(clip as Clip, e));

type EditorLike = { getState: () => { projectId: string; clips: Clip[]; media: MediaAsset[]; nodes?: GradeNode[] }; subscribe: (listener: (state: ReturnType<EditorLike['getState']>) => void) => unknown };
let watching = false;
/** Called once from the timeline (browser only): every clip in the open project with a Depth effect or a grade node
 *  keyed by depth, on or off, keeps a run, whether or not it is under the playhead, so its progress shows on the clip
 *  and in the inspector. A run is cancelled only when its effect, key or clip is gone; another project opening just
 *  stops watching it. */
export function watchDepthClips(store: EditorLike) {
  if (watching || typeof window === 'undefined') return; watching = true;
  let clips: Clip[] | undefined, media: MediaAsset[] | undefined, nodes: GradeNode[] | undefined, project = '';
  const sync = (state: ReturnType<EditorLike['getState']>) => {
    if (state.clips === clips && state.media === media && state.nodes === nodes && state.projectId === project) return;
    clips = state.clips; media = state.media; nodes = state.nodes; project = state.projectId;
    const assets = new Map(state.media.map(asset => [asset.id, asset])), open = new Set<string>(), kept = new Set<string>();
    const keyed = new Set((state.nodes ?? []).filter(node => isDepthKey(node.mask)).map(node => node.clipId));
    for (const clip of state.clips) {
      if (!clip.effects.some(e => e.name === 'Depth') && !keyed.has(clip.id)) continue;
      kept.add(clip.id);
      const asset = assets.get(clip.mediaId);
      if (clip.projectId !== state.projectId || !asset || !['video', 'image'].includes(asset.kind)) continue;
      open.add(clip.id);
      if (asset.status === 'ready') ensureDepthRun(clip, asset);
    }
    for (const id of [...runs.keys()]) if (!open.has(id)) release(id, !kept.has(id));
  };
  sync(store.getState()); store.subscribe(sync);
}

export type DepthFocusState = { state: 'waiting' } | { state: 'ready'; track: DepthFocusTrack } | { state: 'failed'; error: string };
const focusTracks = new Map<string, { value: DepthFocusState; controller: AbortController }>();
const changed = () => { version++; for (const listener of listeners) listener(); };
/**
 * Focus follows subject: the server's focus track for the clip's ready run and its subject's current analysis
 * (`maskKey`). Asked once and polled while the server measures; `waiting` until then (or until the run is ready), and
 * a failure is asked again after ten seconds.
 */
export function depthFocusTrack(clip: Pick<Clip, 'id' | 'projectId'>, maskKey: string): DepthFocusState {
  const state = runs.get(clip.id), run = state?.run;
  if (!run || state.status !== 'ready' || typeof fetch === 'undefined') return { state: 'waiting' };
  const id = `${run.key}:${maskKey}:${clip.id}`, known = focusTracks.get(id);
  if (known) { focusTracks.delete(id); focusTracks.set(id, known); return known.value; }
  while (focusTracks.size >= 32) { const [oldest, entry] = focusTracks.entries().next().value!; entry.controller.abort(); focusTracks.delete(oldest); }
  const entry = { value: { state: 'waiting' } as DepthFocusState, controller: new AbortController() }, { signal } = entry.controller;
  focusTracks.set(id, entry);
  void (async () => {
    let delay = 1000;
    for (;;) {
      try {
        // The server reads the subject from the saved workspace: one picked a moment ago may not be there yet.
        await connection.flush();
        // Named by its analysis key: the server measures that mask, never whichever subject is saved when this poll lands.
        const value = await api<DepthFocusTrack | { status: 'processing' }>(`/depth/${run.key}/focus?projectId=${encodeURIComponent(clip.projectId)}&clipId=${encodeURIComponent(clip.id)}&maskKey=${encodeURIComponent(maskKey)}`, { signal });
        if (signal.aborted) return;
        if (value.status === 'ready') { entry.value = { state: 'ready', track: value }; changed(); return; }
      } catch (error) {
        if (signal.aborted) return;
        // Asked only for a ready run and a current subject, so a 409 here is an answer (timing mismatch, stale save), not a wait.
        if (!transient(error) || (error as ApiError).status === 409) {
          entry.value = { state: 'failed', error: (error as Error).message || 'Could not measure the subject.' }; changed();
          setTimeout(() => { if (focusTracks.get(id) === entry) { focusTracks.delete(id); changed(); } }, 10_000);
          return;
        }
        delay = Math.min(delay * 2, 30_000);
      }
      await sleep(delay);
      if (signal.aborted) return;
    }
  })();
  return entry.value;
}

/** Viewer-only settings: the depth-map view and the one-shot focus picker. Neither is saved nor exported. */
const ui = { showMap: new Map<string, boolean>(), showKey: new Set<string>(), picking: null as null | { clipId: string; effectId: string } };
export const depthUi = {
  get picking() { return ui.picking; },
  setPicking(value: typeof ui.picking) { ui.picking = value; version++; for (const listener of listeners) listener(); },
  /** Off unless this browser turned it on: adding Depth here does (you watch the map fill in), a preset or section
   *  turns it off. Never from the shared effect, so a collaborator's viewer shows the picture. */
  showMap(effect: Pick<Effect, 'id'>) { return ui.showMap.get(effect.id) ?? false; },
  setShowMap(effectId: string, value: boolean) { if (ui.showMap.get(effectId) === value) return; ui.showMap.set(effectId, value); version++; for (const listener of listeners) listener(); },
  /** A grade node's depth key drawn in the viewer instead of the picture. */
  showKey(nodeId: string) { return ui.showKey.has(nodeId); },
  setShowKey(nodeId: string, value: boolean) { if (ui.showKey.has(nodeId) === value) return; if (value) ui.showKey.add(nodeId); else ui.showKey.delete(nodeId); version++; for (const listener of listeners) listener(); },
};

/** No depth for this frame yet: a key of zero (the node grades nothing, or everything when inverted). */
export const noDepthKey: SmartMaskPixels = { width: 1, height: 1, data: new Uint8Array([0]), key: 'depth-key:none' };
const keys = new Map<string, SmartMaskPixels>();
/** A decoded depth frame through a node's key (depthKeyTable, as the export uses): gray bytes at the depth size on a
 *  canvas, so fitting it onto the layer is one bilinear GPU draw, as the export upsamples bilinearly. */
export function depthKeyMatte(pixels: DepthPixels, run: Pick<DepthRun, 'near' | 'far'>, key: Pick<DepthKeyBinding, 'near' | 'far' | 'softness'>): SmartMaskPixels {
  const name = `depth-key:${pixels.key}:${key.near}:${key.far}:${key.softness}`, cached = keys.get(name);
  if (cached) return cached;
  const table = depthKeyTable(run, key, 256), bytes = Uint8Array.from(table, v => Math.round(v * 255)), { width, height } = pixels;
  const data = new Uint8Array(width * height), canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!, image = context.createImageData(width, height);
  for (let i = 0; i < data.length; i++) { const v = data[i] = bytes[pixels.data[i]]; image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = v; image.data[i * 4 + 3] = 255; }
  context.putImageData(image, 0, 0);
  const matte = { width, height, data, key: name, canvas };
  keys.set(name, matte); while (keys.size > 8) keys.delete(keys.keys().next().value!);
  return matte;
}

export type DepthPixels = { data: Uint8Array; width: number; height: number; key: string };
/** The depth each viewer last drew per clip, with a map from canvas pixels to the source box (0..1): the focus picker. */
const picks = new Map<string, { pixels: DepthPixels; near: number; far: number; toSource?: (x: number, y: number) => [number, number] | undefined }>();
export function rememberDepth(clipId: string, pick: typeof picks extends Map<string, infer T> ? T : never) { picks.set(clipId, pick); }
/** Called as a viewer frame starts: only the depth drawn in the frame on screen may be picked. */
export function forgetDepth() { picks.clear(); }
/** Distance 0..100 at a point of the source box (u, v in 0..1), from the frame shown last. */
export function depthAtSource(clipId: string, u: number, v: number) {
  const pick = picks.get(clipId);
  if (!pick || !(u >= 0 && u < 1 && v >= 0 && v < 1)) return undefined;
  const { data, width, height } = pick.pixels;
  return depthDistance(pick, data[Math.floor(v * height) * width + Math.floor(u * width)] / 255);
}
export function depthAtCanvas(clipId: string, x: number, y: number) { const point = picks.get(clipId)?.toSource?.(x, y); return point && depthAtSource(clipId, point[0], point[1]); }

export type DepthFrame = { state: 'none' } | { state: 'analyzing' } | { state: 'failed'; error: string } | { state: 'loading' } | { state: 'ready'; pixels: DepthPixels; run: DepthRun };
const RING = 48, AHEAD = 8, WINDOW = 16, SEGMENT_BYTES = 6, RETRY_MS = 2000;

/** Decoded depth for one viewer: whole segment MP4s fetched (prefetching the next), decoded in a worker into Y planes,
 *  at most RING frames kept. `frame()` never waits: the exact frame, else the one shown before it, else nothing.
 *  Each clip on screen has at most one decode waiting, served in turn, so a dissolve between two Depth clips feeds both. */
export function createDepthPreview(onReady: () => void) {
  type Request = { id: number; owner: string; key: string; projectId: string; n: number; first: number; from: number; count: number };
  const ring = new Map<string, DepthPixels>(), segments = new Map<string, { bytes?: ArrayBuffer; controller: AbortController }>();
  const requests = new Map<number, Request>(), queue = new Map<string, Request>(), failed = new Map<string, number>();
  const wanted = new Map<string, string>(), seen = new Map<string, { index: number; dir: 1 | -1 }>();
  let worker: Worker | undefined, busy: Request | undefined, nextId = 0, disposed = false;
  const keep = (name: string, pixels: DepthPixels) => { ring.delete(name); ring.set(name, pixels); while (ring.size > RING) ring.delete(ring.keys().next().value!); };
  /** A failed download or decode waits two seconds, then the frame is drawn again so it is retried even when paused. */
  const fail = (name: string) => { failed.set(name, Date.now() + RETRY_MS); setTimeout(() => { if (!disposed) onReady(); }, RETRY_MS); };
  const blocked = (name: string) => (failed.get(name) ?? 0) > Date.now();
  const bytesOf = (key: string, projectId: string, n: number): ArrayBuffer | 'loading' | 'failed' => {
    const name = `${key}:${n}`;
    if (blocked(name)) return 'failed';
    const entry = segments.get(name);
    if (entry) { segments.delete(name); segments.set(name, entry); return entry.bytes ?? 'loading'; }
    while (segments.size >= SEGMENT_BYTES) { const [oldest, value] = segments.entries().next().value!; value.controller.abort(); segments.delete(oldest); }
    const created: { bytes?: ArrayBuffer; controller: AbortController } = { controller: new AbortController() };
    segments.set(name, created);
    void fetch(`/api/depth/${key}/preview/${n}.mp4?projectId=${encodeURIComponent(projectId)}`, { credentials: 'same-origin', signal: created.controller.signal })
      .then(response => { if (response.status === 404) rerun(key); if (!response.ok) throw new Error(`Depth segment download failed (${response.status}).`); return response.arrayBuffer(); })
      .then(bytes => { created.bytes = bytes; pump(); })
      .catch(() => { if (created.controller.signal.aborted || disposed) return; if (segments.get(name) === created) segments.delete(name); fail(name); pump(); });
    return 'loading';
  };
  const receive = ({ data }: MessageEvent) => {
    const owner = requests.get(data.id);
    if (data.type === 'frame') {
      if (!owner) return;
      const name = `${owner.key}:${owner.first + owner.n * DEPTH_SEGMENT + data.index}`;
      keep(name, { data: data.data, width: data.width, height: data.height, key: name });
      if (!disposed && [...wanted.values()].includes(name)) onReady();
      return;
    }
    if (data.type === 'error') { console.warn('Depth preview:', data.error); if (owner) fail(`${owner.key}:${owner.n}`); }
    requests.delete(data.id);
    if (busy?.id === data.id) { busy = undefined; pump(); }
  };
  /** The worker decodes one request at a time (a newer one stops the older): the first waiting one whose bytes are here. */
  const pump = () => {
    if (busy || disposed) return;
    for (const [owner, request] of queue) {
      const bytes = bytesOf(request.key, request.projectId, request.n);
      if (bytes === 'loading') continue;
      queue.delete(owner);
      if (bytes === 'failed') continue;
      busy = request; request.id = ++nextId; requests.set(request.id, request);
      if (requests.size > 8) requests.delete(requests.keys().next().value!);
      if (!worker) { worker = new Worker(new URL('./depthDecodeWorker.ts', import.meta.url), { type: 'module' }); worker.onmessage = receive; }
      const buffer = bytes.slice(0); // The worker keeps its last few segments open and ignores bytes it already has.
      worker.postMessage({ id: request.id, segment: `${request.key}:${request.n}`, from: request.from, count: request.count, buffer }, [buffer]);
      return;
    }
  };
  const holds = (request: Request | undefined, key: string, frame: number) => !!request && request.key === key && frame >= request.first + request.n * DEPTH_SEGMENT + request.from && frame < request.first + request.n * DEPTH_SEGMENT + request.from + request.count;
  /** Keep the next AHEAD frames in playing order decoded or on their way. A clip's newer request replaces its waiting
   *  one; its running one stops too when it holds nothing the clip still needs (a jump). */
  const want = (owner: string, run: DepthRun, projectId: string, frame: number, dir: 1 | -1) => {
    let useful = false;
    for (let k = 0; k < AHEAD; k++) {
      const f = frame + dir * k;
      if (f < run.first || f >= run.first + run.frames) return;
      if (ring.has(`${run.key}:${f}`)) continue;
      if (holds(busy, run.key, f)) { useful = true; continue; }
      if (holds(queue.get(owner), run.key, f)) return;
      const at = depthSegmentFor(run, f);
      if (!at || blocked(`${run.key}:${at.segment.n}`)) return;
      const from = dir > 0 ? at.offset : Math.max(0, at.offset - WINDOW + 1);
      if (busy?.owner === owner && !useful) busy = undefined;
      queue.set(owner, { id: 0, owner, key: run.key, projectId, n: at.segment.n, first: run.first, from, count: dir > 0 ? Math.min(WINDOW, at.segment.count - at.offset) : at.offset - from + 1 });
      pump();
      return;
    }
  };
  return {
    frame(clipId: string, time: number): DepthFrame {
      const state = runs.get(clipId);
      if (!state) return { state: 'none' };
      if (state.status === 'failed' || state.status === 'cancelled') return { state: 'failed', error: state.error || 'Depth analysis failed.' };
      const run = state.run, index = run ? depthFrameAt(run, time) : -1, at = run && index >= 0 ? depthSegmentFor(run, index) : undefined;
      if (!run || !at) return state.error ? { state: 'failed', error: state.error } : { state: 'analyzing' };
      // Playing order from the last frame asked for: reversed clips and backward scrubs decode backward.
      const last = seen.get(clipId), dir = last && index !== last.index ? (index < last.index ? -1 : 1) : last?.dir ?? 1, name = `${run.key}:${index}`;
      seen.set(clipId, { index, dir }); wanted.set(clipId, name);
      want(clipId, run, state.projectId, index, dir);
      // Three quarters through a segment in playing order, the next one downloads.
      const next = at.segment.n + dir;
      if ((dir > 0 ? at.offset >= DEPTH_SEGMENT * .75 : at.offset < DEPTH_SEGMENT * .25) && run.segments.some(s => s.n === next)) bytesOf(run.key, state.projectId, next);
      const exact = ring.get(name);
      if (exact) { keep(name, exact); return { state: 'ready', pixels: exact, run }; }
      // One frame old at most: older depth slides off moving edges.
      const previous = ring.get(`${run.key}:${index - dir}`);
      return previous ? { state: 'ready', pixels: previous, run } : { state: 'loading' };
    },
    dispose() { disposed = true; worker?.terminate(); for (const entry of segments.values()) entry.controller.abort(); segments.clear(); ring.clear(); queue.clear(); wanted.clear(); busy = undefined; },
  };
}
