/** Local byte coverage is separate from the decoder's ability to display a frame. */
import { useSyncExternalStore } from 'react';
import { byteRange, moovExtent, parseMp4Index, type Mp4Index } from './mp4Index.ts';
import { animatedSourceOffset } from './animation.ts';
import type { Clip, MediaAsset, Settings, Track } from '../state/models.ts';

const CHUNK = 1 << 20, HANDLE = 2, CACHE = 'footage-v3';
// ponytail: fixed 2 GiB ceiling; expose a budget if larger offline edits are needed.
const CAP_BYTES = 2 * 1024 ** 3;
type Wanted = { url: string; name: string; from: number; to: number; at: number; order: number };
type Failure = { attempts: number; next: number; error: string };
export type FootageStatus = { state: 'gray' | 'blue' | 'yellow' | 'green' | 'red'; detail: string; cached: number; total: number; progress: number };
const stored = new Map<string, Map<number, number>>(), indexes = new Map<string, Mp4Index>();
const wanted = new Map<string, Wanted>(), failures = new Map<string, Failure>();
const inFlight = new Map<string, AbortController>(), listeners = new Set<() => void>();
const decoding = new Map<string, { url: string; detail: string; failed: boolean }>();
let version = 0, registered = false, controlled = false, disabled = false, concurrency = 2;
let lastUpdate = -Infinity, lastEviction = 0, generation = 0, retryTimer: ReturnType<typeof setTimeout> | undefined;
let transferred = 0, transferStart = 0, transferLast = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };
const supported = () => typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'caches' in window;
const keyOf = (request: Request) => { const url = new URL(request.url); const marker = url.searchParams.get('fc'); url.searchParams.delete('fc'); return { url: url.pathname + url.search, marker }; };
const keyFor = (url: string, index: number) => `${url}${url.includes('?') ? '&' : '?'}fc=${index}`;
const chunksOf = (range: { start: number; end: number }) => Array.from({ length: Math.ceil(range.end / CHUNK) - Math.floor(range.start / CHUNK) }, (_, i) => Math.floor(range.start / CHUNK) + i);
function chunksFor(entry: Wanted) {
  const index = indexes.get(entry.url);
  const range = index && byteRange(index, entry.from - HANDLE, entry.to + HANDLE);
  return range && index ? [...new Set([...chunksOf({ start: 0, end: index.moovEnd }), ...chunksOf(range)])] : null;
}
function remember(url: string, index: number, size: number) {
  let chunks = stored.get(url); if (!chunks) { chunks = new Map(); stored.set(url, chunks); }
  chunks.set(index, size);
}
async function register() {
  if (registered || !supported()) return;
  registered = true;
  try {
    await navigator.serviceWorker.register('/footage-worker.js');
    controlled = !!navigator.serviceWorker.controller;
    const cache = await caches.open(CACHE);
    for (const request of await cache.keys()) {
      const { url, marker } = keyOf(request);
      if (marker && /^\d+$/.test(marker)) {
        const response = await cache.match(request);
        if (response) remember(url, Number(marker), Number(response.headers.get('Content-Length')) || CHUNK);
      }
    }
    notify(); pump();
  } catch { registered = false; }
}
if (supported()) {
  navigator.serviceWorker.addEventListener('controllerchange', () => { controlled = !!navigator.serviceWorker.controller; notify(); pump(); });
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data;
    if (data?.cache !== CACHE || disabled) return;
    if (data.type === 'footage-stored') { remember(data.url, data.index, data.size); notify(); }
    if (data.type === 'footage-transfer') {
      transferStart ||= performance.now(); transferLast = performance.now(); transferred += data.bytes; notify();
    }
    if (data.type === 'footage-storage-error') {
      failures.set(data.url, { attempts: 3, next: Infinity, error: 'Local storage unavailable. Playback can still stream; free space and retry.' }); notify();
    }
  });
}

/** Include reversal boundaries as well as both endpoints of animated source timing. */
export function sourceSpan(clip: Clip) {
  const times = [0, clip.duration, ...Object.values(clip.keyframes ?? {}).flatMap(keys => keys.map(key => key.time)).filter(t => t > 0 && t < clip.duration)];
  const offsets = times.flatMap(t => [animatedSourceOffset(clip, t), animatedSourceOffset(clip, Math.max(0, t - 1e-6))]);
  return { from: clip.sourceIn + Math.min(...offsets), to: clip.sourceIn + Math.max(...offsets) };
}

export function update(state: { clips: Clip[]; tracks: Track[]; media: MediaAsset[]; timelineId: string; projectId: string; playhead: number; playing?: boolean; settings: Settings }, options: { original: boolean }, urlFor: (asset: MediaAsset, visual: boolean) => string | undefined) {
  const now = performance.now();
  if (now - lastUpdate < 400) return;
  lastUpdate = now;
  disabled = state.settings.footageCache === false;
  concurrency = state.playing ? 1 : 2;
  wanted.clear();
  if (!disabled && !options.original) for (const clip of state.clips) {
    if (clip.timelineId !== state.timelineId || clip.projectId !== state.projectId || clip.disabled) continue;
    const track = state.tracks.find(t => t.id === clip.trackId), asset = state.media.find(m => m.id === clip.mediaId);
    if (!track || !asset || asset.status !== 'ready' || asset.kind === 'image' || (track.kind === 'video' ? track.hidden : track.muted)) continue;
    const url = urlFor(asset, track.kind === 'video' && asset.kind !== 'audio');
    if (!url || !/^\/api\/.+\.(mp4|m4a|mov|webm)(\?|$)/i.test(url)) continue;
    const end = clip.start + clip.duration, span = sourceSpan(clip);
    wanted.set(clip.id, { url, name: asset.name, ...span, at: clip.sourceIn + animatedSourceOffset(clip, Math.max(0, Math.min(clip.duration, state.playhead - clip.start))), order: end > state.playhead && clip.start <= state.playhead ? 0 : clip.start > state.playhead ? clip.start - state.playhead : 1e6 + state.playhead - end });
  }
  const urls = new Set([...wanted.values()].map(entry => entry.url));
  for (const [url, controller] of inFlight) if (!urls.has(url)) controller.abort();
  if (!disabled && supported()) { void register(); pump(); }
  notify();
  if (now - lastEviction > 30000) { lastEviction = now; void evict(); }
}

export function setDecoderStatus(clipId: string, url: string, detail?: string, failed = false) {
  const previous = decoding.get(clipId);
  if (!detail) { if (decoding.delete(clipId)) notify(); return; }
  if (previous?.url === url && previous.detail === detail && previous.failed === failed) return;
  decoding.set(clipId, { url, detail, failed }); notify();
}
export function clipFootageStatus(clipId: string): FootageStatus {
  const entry = wanted.get(clipId), decoder = decoding.get(clipId);
  const chunks = entry && chunksFor(entry), saved = entry && stored.get(entry.url);
  const cached = chunks?.reduce((sum, i) => sum + (saved?.get(i) ?? 0), 0) ?? 0;
  const total = chunks?.reduce((sum, i) => sum + (saved?.get(i) ?? CHUNK), 0) ?? 0;
  const values = { cached, total, progress: total ? Math.floor(cached / total * 100) : 0 };
  if (decoder?.failed) return { ...values, state: 'red', detail: decoder.detail };
  const failure = entry && failures.get(entry.url);
  if (failure) return { ...values, state: failure.attempts >= 3 ? 'red' : 'yellow', detail: `${failure.error}${failure.attempts < 3 ? ' · retrying shortly' : ''}` };
  if (decoder) return { ...values, state: 'yellow', detail: decoder.detail };
  if (!entry || disabled || !controlled) return { ...values, state: 'gray', detail: disabled ? 'Cache off · streaming' : 'Not cached on this computer' };
  if (chunks && chunks.every(i => saved?.has(i))) return { ...values, state: 'green', detail: 'Cached on this computer · decoder readiness is separate' };
  return { ...values, state: inFlight.has(entry.url) ? 'blue' : 'gray', detail: indexes.has(entry.url) ? `${values.progress}% cached on this computer` : inFlight.has(entry.url) ? 'Reading media index' : 'Queued' };
}
export const clipCached = (clipId: string) => clipFootageStatus(clipId).state === 'green';
export function footageSummary() {
  const entries = [...wanted].map(([id, entry]) => ({ id, name: entry.name, ...clipFootageStatus(id) }));
  return { entries, transferred, speed: transferStart && transferLast > transferStart ? transferred / ((transferLast - transferStart) / 1000) : 0, active: inFlight.size };
}
export function useFootageVersion() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => 0);
}
export function retryFootage() { failures.clear(); lastUpdate = -Infinity; notify(); pump(); }

async function readRange(url: string, start: number, end: number, signal: AbortSignal) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}`, 'X-Footage-Prefetch': '1' }, signal });
  if (response.status !== 206) throw new Error(`Media request failed (${response.status})`);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
  if (!range || Number(range[1]) !== start || Number(range[2]) !== Math.min(end, Number(range[3]) - 1)) throw new Error('Invalid media range');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== Number(range[2]) - start + 1) throw new Error('Incomplete media download');
  return bytes;
}
async function loadIndex(url: string, signal: AbortSignal) {
  let head = await readRange(url, 0, CHUNK - 1, signal);
  const extent = moovExtent(head);
  if (!extent || extent > 32 * CHUNK) throw new Error('Media index unavailable');
  if (extent > head.byteLength) {
    const rest = await readRange(url, head.byteLength, extent - 1, signal);
    const joined = new Uint8Array(head.byteLength + rest.byteLength); joined.set(new Uint8Array(head)); joined.set(new Uint8Array(rest), head.byteLength); head = joined.buffer;
  }
  const index = parseMp4Index(head); if (!index) throw new Error('Media index unavailable');
  return index;
}
function pump() {
  clearTimeout(retryTimer);
  if (disabled || !controlled) return;
  const entries = [...wanted.values()].sort((a, b) => a.order - b.order);
  for (const entry of entries) {
    if (inFlight.size >= concurrency) break;
    if (inFlight.has(entry.url)) continue;
    const failure = failures.get(entry.url);
    if (failure && failure.next > Date.now()) continue;
    const chunks = chunksFor(entry), index = indexes.get(entry.url);
    const urgent = index && byteRange(index, entry.at - HANDLE, entry.at + 5);
    const ordered = [...new Set([...(urgent ? chunksOf(urgent) : []), ...chunks ?? []])];
    const chunk = ordered.find(i => !stored.get(entry.url)?.has(i));
    if (index && chunk === undefined) continue;
    const controller = new AbortController(), epoch = generation;
    inFlight.set(entry.url, controller);
    const timeout = setTimeout(() => controller.abort(new Error('Media download timed out')), 30000);
    const run = async () => {
      if (!index) {
        const parsed = await loadIndex(entry.url, controller.signal);
        if (epoch === generation && !controller.signal.aborted) indexes.set(entry.url, parsed);
      } else {
        await readRange(entry.url, chunk! * CHUNK, (chunk! + 1) * CHUNK - 1, controller.signal);
        // Only a completed Cache Storage write counts as cached, never a successful network read.
        const cache = await caches.open(CACHE);
        const saved = await cache.match(keyFor(entry.url, chunk!));
        if (!saved) throw new Error('Footage could not be saved locally');
        if (epoch === generation && !controller.signal.aborted) remember(entry.url, chunk!, Number(saved.headers.get('Content-Length')) || CHUNK);
      }
    };
    void run().catch(error => {
      if (epoch !== generation || controller.signal.aborted && controller.signal.reason?.name === 'AbortError') return;
      const attempts = (failures.get(entry.url)?.attempts ?? 0) + 1;
      failures.set(entry.url, { attempts, next: attempts >= 3 ? Infinity : Date.now() + 1000 * 2 ** attempts, error: error instanceof Error ? error.message : 'Media download failed' });
    }).finally(() => { clearTimeout(timeout); inFlight.delete(entry.url); notify(); pump(); });
  }
  const next = Math.min(...entries.map(e => failures.get(e.url)?.next ?? Infinity).filter(t => t > Date.now()));
  if (Number.isFinite(next)) retryTimer = setTimeout(pump, Math.max(1, next - Date.now()));
}
async function evict() {
  if (!supported()) return;
  try {
    const usage = (await navigator.storage?.estimate?.())?.usage ?? 0;
    if (usage < CAP_BYTES) return;
    const cache = await caches.open(CACHE), keys = await cache.keys();
    const keep = new Set([...wanted.values()].map(e => e.url));
    let excess = usage - CAP_BYTES * .8;
    for (const request of keys) {
      const { url, marker } = keyOf(request);
      if (excess <= 0) break;
      if (keep.has(url)) continue;
      await cache.delete(request); if (marker !== 'meta') excess -= CHUNK; stored.delete(url);
    }
    notify();
  } catch { /* Storage estimates are optional. */ }
}
export async function footageUsage() {
  if (!supported()) return 0;
  return (await (await caches.open(CACHE)).keys()).filter(request => /^\d+$/.test(keyOf(request).marker ?? '')).length * CHUNK;
}
export async function clearFootageCache() {
  generation++; clearTimeout(retryTimer);
  for (const controller of inFlight.values()) controller.abort();
  stored.clear(); indexes.clear(); failures.clear(); lastUpdate = -Infinity; notify();
  if (supported()) await caches.delete(CACHE);
}
