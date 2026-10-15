// Noise Reduction in the editor: the server denoises 2 s chunks of source frames, the viewer plays them in place of the
// proxy (playback.ts), and the panels read each clip's status here, whichever viewer asked for it.
import type { Clip, MediaAsset } from '../state/models.ts';
import { api, ApiError, connection } from './api.ts';
import { denoiseChunkOf, denoiseEffect, denoiseSettings, type DenoisePreview, type DenoiseView } from './denoise.ts';

/** `flow`: optical flow retimes the same clip, and its chunks win in preview (export chains both). */
export type DenoiseClipStatus = { status: 'preparing' | 'ready' | 'failed' | 'unavailable' | 'flow'; stage?: 'queued' | 'profile' | 'denoise'; progress: number; error?: string };
export type DenoiseCapabilities = { available: boolean; reason?: string; engine?: string; device?: string };
const statuses = new Map<string, DenoiseClipStatus>(), listeners = new Set<() => void>(), retries = new Set<(clipId: string) => void>();
let version = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };
export function subscribeDenoise(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** The chunk under the playhead of the clip, as a viewer last showed it; it stays while the viewer is elsewhere. */
export const denoiseStatus = (clipId: string) => statuses.get(clipId);
/** Also the timeline badge: clipStatus.ts listens for `frameline:denoise` (no status clears it). */
function setDenoiseStatus(clipId: string, status: DenoiseClipStatus | undefined) {
  if (JSON.stringify(statuses.get(clipId)) === JSON.stringify(status)) return;
  if (status) statuses.set(clipId, status); else statuses.delete(clipId);
  notify();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('frameline:denoise', { detail: { clipId, ...status } }));
}
export function denoiseStatusText(status: DenoiseClipStatus | undefined) {
  if (!status) return '';
  if (status.status === 'flow') return 'Optical flow shows in preview; Noise Reduction shows in export';
  if (status.status === 'ready') return 'Ready';
  if (status.status === 'preparing') return status.stage === 'profile' ? 'Measuring noise' : `Denoising · ${status.progress}%`;
  return status.error || 'Noise Reduction failed.';
}
/** Ask again for the clip's failed chunks (and a missing worker): every viewer forgets them and draws again. */
export function retryDenoise(clipId: string) {
  if (capability?.available === false) capability = undefined;
  for (const retry of retries) retry(clipId);
  setDenoiseStatus(clipId, undefined);
}

let capability: { at: number; available?: boolean; value: Promise<DenoiseCapabilities> } | undefined;
/** The server's denoise worker, asked once; an unavailable answer (or no answer) is asked again after 30 s. */
export function denoiseCapabilities() {
  if (!capability || capability.available === false && Date.now() - capability.at > 30_000) {
    const next: NonNullable<typeof capability> = { at: Date.now(), value: api<DenoiseCapabilities>('/denoise/capabilities').catch(error => ({ available: false, reason: (error as Error).message })) };
    void next.value.then(value => { next.available = value.available; });
    capability = next;
  }
  return capability.value;
}

/** Viewer-only: "Show removed noise" per effect. Neither saved nor exported. */
const removed = new Set<string>();
export const noiseUi = {
  showRemoved(effectId: string) { return removed.has(effectId); },
  setShowRemoved(effectId: string, on: boolean) { if (removed.has(effectId) === on) return; if (on) removed.add(effectId); else removed.delete(effectId); notify(); },
  subscribe: subscribeDenoise,
  version: () => version,
};

type Chunk = DenoisePreview & { unavailable?: boolean };
/** Asked again quietly, backing off: the preview queue is full (429), or the network or tunnel dropped. */
const transient = (error: unknown) => !(error instanceof ApiError) || [429, 502, 504].includes(error.status);

/** One viewer's chunks, cloned from createFlowPreview: asked 300 ms after first wanted, polled every 750 ms while preparing,
 *  32 kept. A changed setting, view, quality or rate cancels the clip's chunks; once the chunk under the playhead is ready
 *  the next one in playing order is asked for. `next(clipId)` is that one, for the viewer to warm its decoder. */
export function createDenoisePreview(changed: () => void) {
  type Entry = { value?: Chunk; timer?: ReturnType<typeof setTimeout>; controller: AbortController; projectId: string; delay: number };
  const seen = new Set<string>(), entries = new Map<string, Entry>(), signatures = new Map<string, string>(), shown = new Map<string, string>(), following = new Map<string, string>();
  let disposed = false;
  const clipOf = (id: string) => id.slice(0, id.lastIndexOf(':'));
  const drop = (key: string, projectId: string) => { void api(`/denoise/${key}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' }).catch(() => {}); };
  /** `remote` false: only this viewer stops asking (a closed viewer; the next one may want the same chunk). */
  const cancel = (id: string, entry: Entry, remote = true) => {
    clearTimeout(entry.timer); entry.controller.abort(); entries.delete(id);
    // A failed chunk is forgotten too: the server repeats a failure for ten seconds, so Retry would get the same answer.
    if (remote && entry.value?.key && entry.value.status !== 'ready') drop(entry.value.key, entry.projectId);
  };
  const publish = (clipId: string) => {
    const value = entries.get(shown.get(clipId) ?? '')?.value;
    setDenoiseStatus(clipId, value ? { status: value.unavailable ? 'unavailable' : value.status, progress: value.progress, ...value.stage ? { stage: value.stage } : {}, ...value.error ? { error: value.error } : {} } : { status: 'preparing', progress: 0 });
  };
  const ensure = (clip: Clip, chunk: number, body: object) => {
    const id = `${clip.id}:${chunk}`, known = entries.get(id);
    if (known) { entries.delete(id); entries.set(id, known); return known; }
    const current: Entry = { controller: new AbortController(), projectId: clip.projectId, delay: 750 };
    entries.set(id, current);
    const request = async () => {
      if (disposed || current.controller.signal.aborted) return;
      let again = 750;
      try {
        // The server checks the saved clip for the effect: one added a moment ago may not be saved yet.
        await connection.flush();
        if (current.controller.signal.aborted) return;
        // Not aborted: the server queues the job before it answers, and only the key it returns can cancel it.
        const value = await api<Chunk>('/denoise', { method: 'POST', body: JSON.stringify({ clipId: clip.id, chunk, ...body }) });
        // A closed viewer leaves it for the next one (dispose).
        if (current.controller.signal.aborted) { if (!disposed && value.key && value.status !== 'ready') drop(value.key, current.projectId); return; }
        current.value = value;
        current.delay = 750;
      } catch (error) {
        if (current.controller.signal.aborted) return;
        if (transient(error)) again = current.delay = Math.min(current.delay * 2, 30_000);
        else current.value = { status: 'failed', key: '', progress: 0, from: 0, duration: 0, fps: 0, error: (error as Error).message || 'Noise Reduction failed.', ...(error as ApiError).status === 503 ? { unavailable: true } : {} };
      }
      if (shown.get(clip.id) === id) publish(clip.id);
      changed();
      if (current.value?.status !== 'ready' && current.value?.status !== 'failed') current.timer = setTimeout(request, again);
    };
    current.timer = setTimeout(request, 300);
    while (entries.size > 32) { const oldest = entries.entries().next().value!; cancel(...oldest); }
    return current;
  };
  const retry = (clipId: string) => { for (const [id, entry] of entries) if (clipOf(id) === clipId && entry.value?.status === 'failed') cancel(id, entry); changed(); };
  retries.add(retry);
  return {
    /** The chunk holding the frame shown at `sourceTime`, as far as it is known (undefined until the server answers).
     *  `endTime`: the source time of the clip's last shown frame in playing order; nothing is asked for past it. */
    get(clip: Clip, asset: Pick<MediaAsset, 'fps' | 'duration'>, sourceTime: number, quality: string, view: DenoiseView, endTime?: number): DenoisePreview | undefined {
      const effect = denoiseEffect(clip);
      if (disposed || !connection.enabled || !effect || !(asset.fps > 0)) return undefined;
      seen.add(clip.id);
      if (clip.properties.opticalFlow) { shown.set(clip.id, 'flow'); setDenoiseStatus(clip.id, { status: 'flow', progress: 0 }); return undefined; }
      const settings = denoiseSettings(clip, effect), fps = asset.fps, signature = JSON.stringify([settings, view, quality, fps]);
      if (signatures.get(clip.id) !== signature) { for (const [id, entry] of entries) if (clipOf(id) === clip.id) cancel(id, entry); signatures.set(clip.id, signature); }
      const last = denoiseChunkOf((Math.max(1, Math.round((asset.duration || Infinity) * fps)) - 1) / fps, fps), chunk = Math.min(last, denoiseChunkOf(sourceTime, fps));
      const step = clip.properties.freeze ? 0 : clip.properties.reverse ? -1 : 1, next = chunk + step;
      const end = endTime === undefined ? (step > 0 ? last : 0) : Math.min(last, denoiseChunkOf(endTime, fps)), wanted = new Set([`${clip.id}:${chunk}`, `${clip.id}:${next}`]);
      // Only the chunk under the playhead and the next are worth the GPU: a scrub leaves no queue behind it.
      for (const [id, entry] of entries) if (clipOf(id) === clip.id && entry.value?.status !== 'ready' && !wanted.has(id)) cancel(id, entry);
      const body = { quality, view, settings }, entry = ensure(clip, chunk, body);
      shown.set(clip.id, `${clip.id}:${chunk}`); following.delete(clip.id);
      if (entry.value?.status === 'ready' && (end - chunk) * step > 0) { ensure(clip, next, body); following.set(clip.id, `${clip.id}:${next}`); }
      publish(clip.id);
      return entry.value;
    },
    /** Once per drawn frame: chunks still preparing for clips not drawn stop, so the clip on screen never queues behind them. */
    sweep() {
      for (const [id, entry] of entries) if (!seen.has(clipOf(id)) && entry.value?.status !== 'ready') cancel(id, entry);
      for (const clipId of shown.keys()) if (!seen.has(clipId) && statuses.get(clipId)?.status === 'preparing') setDenoiseStatus(clipId, undefined);
      seen.clear();
    },
    /** Forget a ready chunk whose file stopped loading (the server restarted or trimmed it), so it is asked for again. */
    forget(key: string) { for (const [id, entry] of entries) if (entry.value?.key === key) cancel(id, entry); },
    /** The chunk after the one `get` returned last, once that one is ready. */
    next(clipId: string): DenoisePreview | undefined { return entries.get(following.get(clipId) ?? '')?.value; },
    retain(ids: Set<string>) {
      for (const [id, entry] of entries) if (!ids.has(clipOf(id))) cancel(id, entry);
      for (const clipId of [...shown.keys()]) if (!ids.has(clipId)) { shown.delete(clipId); following.delete(clipId); signatures.delete(clipId); setDenoiseStatus(clipId, undefined); }
    },
    dispose() { disposed = true; retries.delete(retry); for (const [id, entry] of entries) cancel(id, entry, false); for (const clipId of shown.keys()) setDenoiseStatus(clipId, undefined); shown.clear(); following.clear(); signatures.clear(); },
  };
}
