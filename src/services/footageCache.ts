/**
 * Decides what footage the Service Worker (public/footage-worker.js) should already hold before the
 * playhead gets there. Each clip on the active timeline wants the byte range covering its source
 * span plus handles; those bytes are fetched as ordinary ranges, which the worker stores as 1 MiB
 * chunks. The timeline's render bar reads `clipCached` to paint green or yellow.
 */
import { useSyncExternalStore } from 'react';
import { byteRange, moovExtent, parseMp4Index, type Mp4Index } from './mp4Index.ts';
import type { Clip, MediaAsset, Settings, Track } from '../state/models.ts';

const CHUNK = 1 << 20, HANDLE = 2, UPDATE_MS = 400;
// One prefetch at a time while playing, so it never competes with the clip on screen for the link.
let concurrency = 2;
// ponytail: fixed 2 GiB ceiling, make it a setting if someone fills a disk.
const CAP_BYTES = 2 * 1024 ** 3;
const CACHE = 'footage-v2';

type Wanted = { url: string; chunks: number[]; order: number };
type UrlFor = (asset: MediaAsset, visual: boolean) => string | undefined;

const stored = new Map<string, Set<number>>();
const indexes = new Map<string, Promise<Mp4Index | null>>();
const indexResolved = new Map<string, Mp4Index | null>();
const wanted = new Map<string, Wanted>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0, lastUpdate = 0, registered = false, controlled = false, disabled = false, active = 0, lastEviction = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'caches' in window;
/** Splits a cache key back into the footage URL and its `fc` marker (a chunk index or 'meta'). */
const keyOf = (request: Request) => { const url = new URL(request.url); const marker = url.searchParams.get('fc'); url.searchParams.delete('fc'); return { url: decodeURIComponent(url.pathname + url.search), marker }; };

async function register() {
  if (registered || !supported()) return;
  registered = true;
  try {
    const registration = await navigator.serviceWorker.register('/footage-worker.js');
    controlled = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { controlled = !!navigator.serviceWorker.controller; notify(); pump(); });
    navigator.serviceWorker.addEventListener('message', event => {
      const data = event.data as { type?: string; url?: string; index?: number };
      if (data?.type === 'footage-stored' && data.url) remember(data.url, data.index!);
      else if (data?.type === 'footage-cleared') { stored.clear(); notify(); }
    });
    void registration.update().catch(() => {});
    void navigator.storage?.persist?.().catch(() => {});
    const cache = await caches.open(CACHE);
    for (const request of await cache.keys()) { const { url, marker } = keyOf(request); if (marker && marker !== 'meta') remember(url, Number(marker), false); }
    notify(); pump();
  } catch { /* No worker: playback streams as before and the bar stays yellow. */ }
}

function remember(url: string, index: number, announce = true) {
  let set = stored.get(url);
  if (!set) { set = new Set(); stored.set(url, set); }
  if (set.has(index)) return;
  set.add(index);
  if (announce) notify();
}

/** The parsed moov for a proxy, fetched through the worker so chunk 0 lands in the cache too. */
function indexFor(url: string) {
  let pending = indexes.get(url);
  if (!pending) {
    pending = (async () => {
      let head = await (await fetch(url, { headers: { Range: `bytes=0-${CHUNK - 1}` } })).arrayBuffer();
      const extent = moovExtent(head);
      if (extent === null) return null;
      if (extent > head.byteLength) {
        const rest = await (await fetch(url, { headers: { Range: `bytes=${head.byteLength}-${extent - 1}` } })).arrayBuffer();
        const joined = new Uint8Array(head.byteLength + rest.byteLength); joined.set(new Uint8Array(head)); joined.set(new Uint8Array(rest), head.byteLength); head = joined.buffer;
      }
      return parseMp4Index(head);
    })().catch(() => null);
    indexes.set(url, pending);
    void pending.then(value => { indexResolved.set(url, value); lastUpdate = 0; notify(); pump(); });
  }
  return pending;
}

const chunksOf = (range: { start: number; end: number }) => { const list: number[] = []; for (let i = Math.floor(range.start / CHUNK); i <= Math.floor((range.end - 1) / CHUNK); i++) list.push(i); return list; };

/** Source seconds a clip reads, before handles. Speed ramps are approximated by the flat speed. */
export function sourceSpan(clip: Clip) {
  const speed = Math.max(.01, Number(clip.properties.speed ?? 100) / 100);
  return { from: clip.sourceIn, to: clip.sourceIn + clip.duration * speed };
}

/**
 * Rebuilds the wanted set from the active timeline. Called from the playback tick; cheap enough to
 * throttle rather than diff. `urlFor` is the player's own URL choice so cache and decoder agree.
 */
export function update(state: { clips: Clip[]; tracks: Track[]; media: MediaAsset[]; timelineId: string; projectId: string; playhead: number; playing?: boolean; settings: Settings }, options: { original: boolean }, urlFor: UrlFor) {
  disabled = state.settings.footageCache === false;
  if (disabled) { if (registered) void disable(); wanted.clear(); return; }
  if (!supported()) return;
  void register();
  const now = performance.now();
  concurrency = state.playing ? 1 : 2;
  if (now - lastUpdate < UPDATE_MS) return;
  lastUpdate = now;
  const next = new Map<string, Wanted>();
  if (!options.original) for (const clip of state.clips) {
    if (clip.timelineId !== state.timelineId || clip.projectId !== state.projectId || clip.disabled) continue;
    const track = state.tracks.find(t => t.id === clip.trackId), asset = state.media.find(m => m.id === clip.mediaId);
    if (!track || !asset || asset.status !== 'ready' || asset.kind === 'image') continue;
    const url = urlFor(asset, track.kind === 'video' && asset.kind !== 'audio');
    if (!url || /\/original(\?|$)/.test(url)) continue;
    const end = clip.start + clip.duration;
    const order = clip.start > state.playhead ? clip.start - state.playhead : end > state.playhead ? 0 : 1e6 + state.playhead - end;
    const span = sourceSpan(clip), entry: Wanted = { url, chunks: [0], order };
    const index = indexResolved.get(url);
    if (index === undefined) void indexFor(url);
    else if (index) { const range = byteRange(index, span.from - HANDLE, span.to + HANDLE); if (range) entry.chunks = [...new Set([0, ...chunksOf(range)])]; }
    next.set(clip.id, entry);
  }
  wanted.clear(); for (const [id, entry] of next) wanted.set(id, entry);
  notify(); pump();
  if (now - lastEviction > 30000) { lastEviction = now; void evict(); }
}

/** Green when the clip's wanted bytes are all on disk; a clip with nothing to cache is green too. */
export function clipCached(clipId: string) {
  const entry = wanted.get(clipId);
  if (!entry) return true;
  if (!controlled) return false;
  if (indexResolved.get(entry.url) === undefined) return false;
  const set = stored.get(entry.url);
  return !!set && entry.chunks.every(index => set.has(index));
}

export function useFootageVersion() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => 0);
}

function pump() {
  if (disabled || !controlled) return;
  while (active < concurrency) {
    let best: { url: string; index: number; order: number } | null = null;
    for (const entry of wanted.values()) {
      const set = stored.get(entry.url);
      for (const index of entry.chunks) {
        if (set?.has(index) || inFlight.has(`${entry.url}#${index}`)) continue;
        if (!best || entry.order < best.order) best = { url: entry.url, index, order: entry.order };
        break;
      }
    }
    if (!best) return;
    const key = `${best.url}#${best.index}`;
    inFlight.add(key); active++;
    const { url, index } = best;
    fetch(url, { headers: { Range: `bytes=${index * CHUNK}-${(index + 1) * CHUNK - 1}` } })
      .then(response => response.status === 206 ? response.arrayBuffer().then(() => remember(url, index)) : undefined)
      .catch(() => {})
      .finally(() => { inFlight.delete(key); active--; pump(); });
  }
}

/** Oldest files go first once Cache Storage passes the cap; nothing currently wanted is touched. */
async function evict() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.usage || estimate.usage < CAP_BYTES) return;
    const cache = await caches.open(CACHE), keys = await cache.keys();
    const metas: { url: string; used: number }[] = [];
    for (const request of keys) { const { url, marker } = keyOf(request); if (marker === 'meta') { const meta = await (await cache.match(request))?.json().catch(() => null); metas.push({ url, used: meta?.used ?? 0 }); } }
    const keep = new Set([...wanted.values()].map(entry => entry.url));
    let excess = estimate.usage - CAP_BYTES * .8;
    for (const { url } of metas.sort((a, b) => a.used - b.used)) {
      if (excess <= 0) break;
      if (keep.has(url)) continue;
      for (const request of keys) if (keyOf(request).url === url) { await cache.delete(request); excess -= CHUNK; }
      stored.delete(url);
    }
    notify();
  } catch { /* Quota reporting is best effort. */ }
}

export async function footageUsage() {
  if (!supported()) return 0;
  try { const cache = await caches.open(CACHE); return (await cache.keys()).filter(request => /^\d+$/.test(keyOf(request).marker ?? '')).length * CHUNK; } catch { return 0; }
}

export async function clearFootageCache() {
  if (!supported()) return;
  try { await caches.delete(CACHE); } catch { /* Nothing stored. */ }
  stored.clear(); indexes.clear(); indexResolved.clear(); lastUpdate = 0; notify();
}

async function disable() {
  registered = false; controlled = false;
  await clearFootageCache();
  try { for (const registration of await navigator.serviceWorker.getRegistrations()) if (registration.active?.scriptURL.endsWith('/footage-worker.js')) await registration.unregister(); } catch { /* Already gone. */ }
  notify();
}
