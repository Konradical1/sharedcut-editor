/** Local byte coverage is separate from the decoder's ability to display a frame. */
import { useSyncExternalStore } from 'react';
import { byteRange, moovExtent, parseMp4Index, type Mp4Index } from './mp4Index.ts';
import { animatedSourceOffset } from './animation.ts';
import { timelineTransitions, type TransitionRecord } from './transitions.ts';
import type { Clip, MediaAsset, Settings, Track } from '../state/models.ts';

// PRE: slack before a range; byteRange already steps back to the sync sample a decoder starts from.
// POST: B-frame reorder plus the WebCodecs decoder's half second of read-ahead past a clip's last frame.
const CHUNK = 1 << 20, PRE = .5, POST = 1, CACHE = 'footage-v3';
// ponytail: fixed 2 GiB ceiling; expose a budget if larger offline edits are needed.
const CAP_BYTES = 2 * 1024 ** 3;
const CACHEABLE = /^\/api\/.+\.(mp4|m4a|mov|webm)(\?|$)/i, WEBM = /\.webm(\?|$)/i;
// Alpha WebM graphics have no MP4 sample table to plan with. They are small (median 0.6 MB), so the whole file is the range.
type Layout = Mp4Index | { size: number };
// background: a Stream file kept filling while its clip plays the low stream, for later decoders and visits.
type Wanted = { url: string; name: string; from: number; to: number; at: number; order: number; chunks?: number[]; background?: boolean };
type Failure = { attempts: number; next: number; error: string };
type TimelineState = { clips: Clip[]; tracks: Track[]; media: MediaAsset[]; timelineId: string; projectId: string; playhead: number; playing?: boolean; settings: Settings };
export type FootageStatus = { state: 'gray' | 'blue' | 'yellow' | 'green' | 'red'; detail: string; cached: number; total: number; progress: number; playback?: { detail: string; failed: boolean } };
const stored = new Map<string, Map<number, number>>(), indexes = new Map<string, Layout>();
// Per clip, every file playback opens for it: the picture and, beside a WebCodecs picture, the sound.
const wanted = new Map<string, Wanted[]>(), failures = new Map<string, Failure>();
const inFlight = new Map<string, AbortController>(), listeners = new Set<() => void>();
// Every planned use of each Stream file playback may trade for its low stream, and those it trades now.
const streamUses = new Map<string, Wanted[]>(), lowNow = new Set<string>(), background: Wanted[] = [];
const decoding = new Map<string, { url: string; detail: string; failed: boolean }>();
let clearing = false, registrationError = '', listed = false;
let version = 0, registered = false, controlled = false, disabled = false, concurrency = 6;
let lastUpdate = -Infinity, lastEviction = 0, generation = 0, retryTimer: ReturnType<typeof setTimeout> | undefined;
let transferred = 0, transferStart = 0, transferLast = 0, networkRate = 0, seededRate = 0, measuredBytes = 0;
// [start, end, bytes] of each network chunk the worker saved in the last 20 s.
const transfers: [number, number, number][] = [], lowered = new Set<string>();
// ponytail: one bitrate for a Stream file whose index is not loaded yet (960-wide CRF 16 runs ~8-16 Mbit/s).
const STREAM_GUESS = 1.5e6;
let shown = '', notified = -Infinity, notifyTimer: ReturnType<typeof setTimeout> | undefined;
/** Subscribers re-render at most four times a second, and only when something they show changed. */
function notify() {
  if (notifyTimer !== undefined || !listeners.size) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined; notified = performance.now();
    const next = visible(); if (next === shown) return;
    shown = next; version++; for (const listener of listeners) listener();
  }, Math.max(0, notified + 250 - performance.now()));
}
const files = () => [...wanted.values(), background].flat();
const supported = () => typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'caches' in window;
const keyOf = (request: Request) => { const url = new URL(request.url); const marker = url.searchParams.get('fc'); url.searchParams.delete('fc'); return { url: url.pathname + url.search, marker }; };
const keyFor = (url: string, marker: number | string) => `${url}${url.includes('?') ? '&' : '?'}fc=${marker}`;
const chunksOf = (range: { start: number; end: number }) => Array.from({ length: Math.ceil(range.end / CHUNK) - Math.floor(range.start / CHUNK) }, (_, i) => Math.floor(range.start / CHUNK) + i);
/** Chunks this clip plays from this file, plus the MP4 header. Null until the file's layout is known. */
function chunksFor(entry: Wanted) {
  const index = indexes.get(entry.url);
  if (!index) return null;
  if (entry.chunks) return entry.chunks;
  if ('size' in index) return entry.chunks = chunksOf({ start: 0, end: index.size });
  const range = byteRange(index, entry.from - PRE, entry.to + POST);
  return range ? entry.chunks = [...new Set([...chunksOf({ start: 0, end: index.moovEnd }), ...chunksOf(range)])] : null;
}
/** The next seconds from the playhead: downloaded first, never evicted. */
const windowOf = (entry: Wanted, index: Layout) => 'size' in index ? { start: 0, end: index.size } : byteRange(index, entry.at - PRE, Math.min(entry.to + POST, entry.at + 10));
/** From the playhead (or an upcoming clip's first frame) to the clip's end: what a decoder opened now reads. */
const tailOf = (entry: Wanted, index: Layout) => 'size' in index ? { start: 0, end: index.size } : byteRange(index, entry.at - PRE, entry.to + POST);
/** Header and tail chunks of this use are saved: a decoder opened on it never waits for the line. */
function tailSaved(entry: Wanted) {
  const index = indexes.get(entry.url), saved = stored.get(entry.url), range = index && tailOf(entry, index);
  return !!range && [...('size' in index! ? [] : chunksOf({ start: 0, end: index!.moovEnd })), ...chunksOf(range)].every(i => saved?.has(i));
}
/** What the link carries, not one request: bytes over the time any download was running. Parallel downloads share the line. */
function throughput(spans: [number, number, number][]) {
  let busy = 0, reach = -Infinity, bytes = 0;
  for (const [from, to, size] of [...spans].sort((a, b) => a[0] - b[0])) { bytes += size; busy += Math.max(0, to - Math.max(from, reach)); reach = Math.max(reach, to); }
  return busy > 0 ? bytes / (busy / 1000) : 0;
}
/**
 * Footage chunks. A lightly used line runs one at a time and one stalled chunk would stretch the busy time; a line
 * shared with the page's thumbnails slows every chunk. No chunk arrives faster than the line, so the faster quarter
 * of them speaks for it then.
 */
function chunkRate(spans: [number, number, number][]) {
  const each = spans.map(([from, to, size]) => size / ((to - from) / 1000)).sort((a, b) => a - b);
  return Math.max(throughput(spans), each[Math.floor(each.length * .75)] ?? 0);
}
/** How fast the page's own large downloads (app, project state) arrived: the line speed before any footage has crossed it. */
function pageRate() {
  if (typeof performance.getEntriesByType !== 'function') return 0;
  // As with chunks, a body that arrived in under 50 ms is no evidence of Internet throughput.
  const own = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(entry => entry.transferSize > 0 && entry.encodedBodySize >= 256 * 1024 && entry.responseEnd - entry.responseStart >= 50 && entry.name.startsWith(location.origin));
  // A small sample is slow-start and latency, not bandwidth: it could only ever argue for the low stream wrongly.
  return own.reduce((sum, entry) => sum + entry.encodedBodySize, 0) >= 2 * CHUNK ? throughput(own.map(entry => [entry.responseStart, entry.responseEnd, entry.encodedBodySize])) : 0;
}
/** Measured footage throughput; until 16 MiB of it ever, no lower than the page rate, since the first chunks share the line with the rest of the page loading. */
const linkRate = () => measuredBytes < 16 * CHUNK ? Math.max(networkRate, seededRate) : networkRate;
const bitrates = new WeakMap<Mp4Index, number>();
function bitrateOf(index: Mp4Index) {
  let rate = bitrates.get(index);
  if (rate === undefined) {
    const duration = Math.max(0, ...index.tracks.map(track => track.times.at(-1) ?? 0));
    rate = duration > 0 ? index.tracks.reduce((sum, track) => sum + track.sizes.reduce((n, size) => n + size, 0), 0) / duration : STREAM_GUESS;
    bitrates.set(index, rate);
  }
  return rate;
}
/**
 * The link cannot carry this file at 1.3x real time; once judged so, it takes 1.5x to win it back. False before any
 * measurement. Leans optimistic: playback keeps a decoder's low stream for the session, while a Stream file that
 * does stall moves to the low stream after 1.2 s anyway.
 */
function slowFor(url: string) {
  const rate = linkRate(), layout = indexes.get(url), need = layout && 'tracks' in layout ? bitrateOf(layout) : STREAM_GUESS;
  if (rate && rate < need * 1.3) lowered.add(url); else if (!rate || rate > need * 1.5) lowered.delete(url);
  return lowered.has(url);
}
function remember(url: string, index: number, size: number) {
  let chunks = stored.get(url); if (!chunks) { chunks = new Map(); stored.set(url, chunks); }
  chunks.set(index, size);
}
/** One listing, no read per chunk: a file's short last chunk counts as whole until it is downloaded again. */
async function list() {
  for (const request of await (await caches.open(CACHE)).keys()) {
    const { url, marker } = keyOf(request);
    if (marker && /^\d+$/.test(marker) && !stored.get(url)?.has(Number(marker))) remember(url, Number(marker), CHUNK);
  }
  listed = true; lastUpdate = -Infinity;
}
// Listed as the app loads, before the first decoder asks which file to open.
const listing = supported() ? list().catch(() => {}) : undefined;
async function register() {
  if (registered || !supported()) return;
  registered = true;
  try {
    await navigator.serviceWorker.register('/footage-worker.js');
    controlled = !!navigator.serviceWorker.controller;
    await listing; if (!listed) await list();
    notify(); pump();
  } catch (error) { controlled = false; registrationError = `Local cache unavailable: ${error instanceof Error ? error.message : String(error)}`; notify(); }
}
if (supported()) {
  // A reload starts controlled: the first decoder must already count bytes an earlier visit saved.
  controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { controlled = !!navigator.serviceWorker.controller; notify(); pump(); });
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data;
    if (data?.cache !== CACHE || disabled || clearing) return;
    if (data.type === 'footage-cleared') { stored.clear(); indexes.clear(); lastUpdate = -Infinity; notify(); }
    if (data.type === 'footage-stored') { remember(data.url, data.index, data.size); notify(); }
    if (data.type === 'footage-transfer') {
      const now = performance.now();
      transferStart ||= now; transferLast = now; transferred += data.bytes;
      // An almost instantaneous response, or a small one (latency more than bandwidth), is not evidence of Internet throughput.
      if (data.milliseconds >= 50 && data.bytes >= 256 * 1024) {
        // The worker reports when the body finished arriving (`ago`): saving it is not network time.
        const end = now - (Number(data.ago) || 0);
        transfers.push([end - data.milliseconds, end, data.bytes]); measuredBytes += data.bytes;
        while (transfers.length && transfers[0][1] < now - 20000) transfers.shift();
        networkRate = chunkRate(transfers);
      }
      notify();
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

type Options = { original: boolean; quality?: string };
export function update(state: TimelineState, options: Options, urlFor: (asset: MediaAsset, visual: boolean) => string | undefined) {
  const now = performance.now();
  if (now - lastUpdate < 400) return;
  lastUpdate = now;
  const nextDisabled = state.settings.footageCache === false;
  if (nextDisabled !== disabled && supported()) navigator.serviceWorker.controller?.postMessage?.({ type: 'footage-enabled', enabled: !nextDisabled });
  disabled = nextDisabled;
  seededRate ||= pageRate();
  wanted.clear(); streamUses.clear(); lowNow.clear(); background.length = 0;
  if (!disabled) plan(state, options, urlFor);
  const rate = linkRate();
  // On a line too slow for a typical Stream file, enough downloads to keep it busy through each request's half-second
  // round trip and no more: every extra one only delays the chunk playback needs next. One heavy file traded on a
  // good line is no reason to starve the rest.
  concurrency = Math.min(state.playing ? 4 : 6, rate && rate < STREAM_GUESS * 1.3 ? Math.max(2, 1 + Math.ceil(rate * .5 / CHUNK)) : 6);
  const urls = new Set(files().map(entry => entry.url));
  for (const [url, controller] of inFlight) if (!urls.has(url)) controller.abort();
  if (!disabled && supported()) { void register(); pump(); }
  notify();
  if (now - lastEviction > 30000) { lastEviction = now; void evict(); }
}

/** Mirrors playbackLayers and the decoders playback opens, so green means every file a clip plays from is local. */
function plan(state: TimelineState, options: Options, urlFor: (asset: MediaAsset, visual: boolean) => string | undefined) {
  const clips = state.clips.filter(clip => clip.timelineId === state.timelineId && clip.projectId === state.projectId && !clip.disabled);
  const tracks = new Map(state.tracks.map(track => [track.id, track])), media = new Map(state.media.map(asset => [asset.id, asset]));
  const solo = state.tracks.some(track => track.timelineId === state.timelineId && track.solo && !track.muted);
  const twin = (clip: Clip) => `${clip.mediaId}|${clip.start}|${clip.sourceIn}|${clip.duration}`;
  const separated = new Set(clips.filter(clip => tracks.get(clip.trackId)?.kind === 'audio').map(twin));
  const records = new Map<string, TransitionRecord[]>();
  for (const record of timelineTransitions(state.clips, state.timelineId, state.media)) for (const id of [record.incomingId, record.outgoingId]) if (id) records.set(id, [...records.get(id) ?? [], record]);
  const planned: { id: string; name: string; span: { from: number; to: number }; at: number; order: number; picture?: string; sound?: string; stream?: string; low?: string }[] = [];
  for (const clip of clips) {
    const track = tracks.get(clip.trackId), asset = media.get(clip.mediaId);
    if (!track || !asset || asset.status !== 'ready' || asset.kind === 'image') continue;
    const p = clip.properties, visual = track.kind === 'video' && !track.hidden && asset.kind !== 'audio';
    const audible = (asset.kind === 'audio' || !!asset.hasAudio) && !p.freeze && !track.muted && (!solo || track.solo) && !(track.kind === 'video' && (p.audioDetached || separated.has(twin(clip))));
    const span = sourceSpan(clip), own = records.get(clip.id) ?? [], end = clip.start + clip.duration;
    // Transition handles come out of the unused source at the clip's speed; playback caps that at 8x.
    const rate = Math.min(8, Math.max(.01, Number(p.speed ?? 100) / 100, ...(clip.keyframes?.['properties.speed'] ?? []).map(key => Number(key.value) / 100))) || 1;
    const lead = Math.max(0, ...own.map(t => clip.start - t.start)), tail = Math.max(0, ...own.map(t => t.end - end));
    // A reversed clip reads both handles past its source end; conservative when reverse is keyframed.
    const reversed = !!p.reverse || !!clip.keyframes?.['properties.reverse']?.length;
    span.from = Math.max(0, span.from - (reversed ? lead + tail : lead) * rate); span.to += (reversed ? lead + tail : tail) * rate;
    const first = clip.start - lead, last = end + tail, playhead = state.playhead;
    // Before its cut, a clip with an incoming transition already plays from the handle, that much source earlier.
    const early = reversed ? 0 : Math.max(0, clip.start - Math.max(playhead, first)) * rate;
    const at = Math.max(0, clip.sourceIn + animatedSourceOffset(clip, Math.max(0, Math.min(clip.duration, playhead - clip.start))) - early);
    const order = last > playhead && first <= playhead ? 0 : first > playhead ? first - playhead : 1e6 + playhead - last;
    const picture = visual ? urlFor(asset, true) : undefined, { Stream: stream, StreamLow: low } = asset.proxyVariants ?? {};
    // A WebCodecs picture is silent and its sound plays from a second element; a native <video> carries its own.
    const decoded = !!picture && /\.mp4(\?|$)/i.test(picture) && !p.reverse && !p.freeze && Number(p.speed ?? 100) <= 200;
    // Playback trades this Stream file for the low stream on a slow line (preferLowStream), or already has (picture is low).
    const tradable = !!picture && !!stream && !!low && stream !== low && (picture === stream || picture === low) && options.quality === 'Stream' && !options.original;
    if (tradable) streamUses.set(stream, [...streamUses.get(stream) ?? [], { url: stream, name: asset.name, ...span, at, order }]);
    planned.push({ id: clip.id, name: asset.name, span, at, order, picture, sound: audible && (!visual || decoded) ? urlFor(asset, false) : undefined, ...(tradable ? { stream, low } : {}) });
  }
  for (const [url, uses] of streamUses) if (goesLow(url, uses)) lowNow.add(url);
  // Plan the file a new decoder will open: prefetching the Stream file a decoder trades away spends a slow line on bytes
  // nothing plays now. It still fills behind everything urgent, so later decoders and visits get full quality.
  for (const { id, name, span, at, order, picture, sound, stream, low } of planned) {
    const traded = !!stream && (picture === low || lowNow.has(stream)), shown = traded ? low : picture;
    const urls = [...new Set([shown, sound])].filter((url): url is string => !!url && CACHEABLE.test(url));
    if (!urls.length) continue;
    wanted.set(id, urls.map(url => ({ url, name, ...span, at, order })));
    if (traded) background.push({ url: stream!, name, ...span, at, order, background: true });
  }
}
/**
 * Every use of this Stream file plays its low stream instead: the line cannot carry the file and some use near the
 * playhead has bytes ahead of it that are not saved. Per file, as playback picks per asset: the prefetcher and a new
 * decoder ask the same question, so a decoder opens the file being prefetched and a stalled one may move.
 */
function goesLow(url: string, uses: Wanted[]) {
  const near = uses.filter(entry => entry.order < 15);
  if (!disabled && controlled && near.length) {
    // What is saved is unknown until the cache is listed, and where the playhead falls in it until the file's index is read.
    if (!listed || !indexes.has(url) && (stored.get(url)?.size ?? 0) > 1) return false;
    if (near.every(tailSaved)) return false;
  }
  return slowFor(url);
}

export function setDecoderStatus(clipId: string, url: string, detail?: string, failed = false) {
  const previous = decoding.get(clipId);
  if (!detail) { if (decoding.delete(clipId)) notify(); return; }
  if (previous?.url === url && previous.detail === detail && previous.failed === failed) return;
  decoding.set(clipId, { url, detail, failed }); notify();
}
export function clipFootageStatus(clipId: string): FootageStatus {
  const entries = wanted.get(clipId) ?? [], decoder = decoding.get(clipId);
  let cached = 0, total = 0, complete = entries.length > 0;
  for (const entry of entries) {
    const chunks = chunksFor(entry), saved = stored.get(entry.url);
    if (!chunks) { complete = false; continue; }
    for (const i of chunks) { const size = saved?.get(i); cached += size ?? 0; total += size ?? CHUNK; if (size === undefined) complete = false; }
  }
  const values = { cached, total, progress: total ? Math.floor(cached / total * 100) : 0, playback: decoder };
  if (!disabled && controlled && complete) return { ...values, state: 'green', detail: 'Saved on this computer' };
  const failure = entries.reduce<Failure | undefined>((worst, entry) => { const next = failures.get(entry.url); return next && (!worst || next.attempts > worst.attempts) ? next : worst; }, undefined);
  if (failure) return { ...values, state: failure.attempts >= 3 ? 'red' : 'yellow', detail: `${failure.error}${failure.attempts < 3 ? ' · retrying shortly' : ''}` };
  if (!entries.length || disabled || !controlled) return { ...values, state: registrationError ? 'red' : 'gray', detail: disabled ? 'Cache off · streaming' : registrationError || (!supported() ? 'Local cache requires HTTPS or localhost' : !controlled ? 'Starting local cache…' : 'Not cached on this computer') };
  const busy = entries.some(entry => inFlight.has(entry.url));
  return { ...values, state: busy ? 'blue' : 'gray', detail: entries.every(entry => indexes.has(entry.url)) ? `${values.progress}% cached on this computer` : busy ? 'Reading media index' : 'Queued' };
}
/** Select a smaller prepared stream before opening a decoder on a constrained connection. */
export function preferLowStream(url: string) {
  // Saved bytes play at disk speed whatever the connection does: a Stream file stays while what the clips at and just
  // after the playhead read from it is saved.
  return goesLow(url, streamUses.get(url) ?? []);
}

export const clipCached = (clipId: string) => clipFootageStatus(clipId).state === 'green';
export function footageSummary() {
  const entries = [...wanted].map(([id, uses]) => ({ id, name: uses[0].name, ...clipFootageStatus(id) }));
  return { entries, transferred, speed: transferStart && transferLast > transferStart ? transferred / ((transferLast - transferStart) / 1000) : 0, active: inFlight.size };
}
/** What the timeline and the footage panel draw, at the precision they draw it. */
function visible() {
  const { entries, transferred, speed, active } = footageSummary();
  return JSON.stringify([registrationError, disabled, controlled, Math.round(transferred / 1e5), Math.round(speed / 1e5), active > 0, entries.map(entry => [entry.id, entry.state, entry.detail, entry.progress, Math.round(entry.cached / 1e5), Math.round(entry.total / 1e5), entry.playback?.detail, entry.playback?.failed])]);
}
export function useFootageVersion() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => 0);
}
export function retryFootage() { if (registrationError) { registrationError = ''; registered = false; void register(); } failures.clear(); lowered.clear(); lastUpdate = -Infinity; notify(); pump(); }

async function readRange(url: string, start: number, end: number, signal: AbortSignal) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}`, 'X-Footage-Prefetch': '1' }, signal });
  if (response.status !== 206) throw new Error(`Media request failed (${response.status})`);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
  if (!range || Number(range[1]) !== start || Number(range[2]) !== Math.min(end, Number(range[3]) - 1)) throw new Error('Invalid media range');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== Number(range[2]) - start + 1) throw new Error('Incomplete media download');
  return { bytes, size: Number(range[3]) };
}
async function loadLayout(url: string, signal: AbortSignal): Promise<Layout> {
  const first = await readRange(url, 0, CHUNK - 1, signal);
  if (WEBM.test(url)) return { size: first.size };
  let head = first.bytes;
  const extent = moovExtent(head);
  if (!extent || extent > 32 * CHUNK) throw new Error('Media index unavailable');
  if (extent > head.byteLength) {
    const rest = (await readRange(url, head.byteLength, extent - 1, signal)).bytes;
    const joined = new Uint8Array(head.byteLength + rest.byteLength); joined.set(new Uint8Array(head)); joined.set(new Uint8Array(rest), head.byteLength); head = joined.buffer;
  }
  const index = parseMp4Index(head); if (!index) throw new Error('Media index unavailable');
  return index;
}
const storedBytes=()=>[...stored.values()].reduce((sum,chunks)=>sum+[...chunks.values()].reduce((n,size)=>n+size,0),0);
function pump() {
  clearTimeout(retryTimer);
  if (disabled || clearing || !controlled) return;
  const entries = files().sort((a, b) => a.order - b.order);
  // Fill the playhead and next cuts before downloading entire long clips (especially music).
  // Recompute after each chunk so a seek or an approaching cut can change the priority.
  // A Stream file kept for later comes after every urgent window: its index (one chunk, and the real bitrate the
  // low-or-Stream choice needs), then the tail a decoder would read, which is what lets one open it, then the rest.
  // Nearest first either way: what just played is what an editor plays again.
  const tasks = entries.flatMap<{ entry: Wanted; index: Layout | undefined; chunk: number | undefined; priority: number }>(entry => {
    const index = indexes.get(entry.url), saved = stored.get(entry.url), later = entry.background, away = later ? entry.order % 1e6 : entry.order;
    if (!index) return [{ entry, index, chunk: undefined, priority: (later ? 5e4 : 0) + (away < 15 ? away : 1e5 + away) }];
    const urgent = later ? tailOf(entry, index) : entry.order < 15 && windowOf(entry, index);
    const chunk = urgent ? chunksOf(urgent).find(i => !saved?.has(i)) : undefined;
    if (chunk !== undefined) return [{ entry, index, chunk, priority: (later ? 1e5 : 0) + away }];
    const rest = chunksFor(entry)?.find(i => !saved?.has(i));
    return rest === undefined ? [] : [{ entry, index, chunk: rest, priority: (later ? 3e5 : 1e5) + away }];
  }).sort((a, b) => a.priority - b.priority);
  const nearBudget=storedBytes()>=CAP_BYTES*.9;
  // Several files at once, one request each: a dense multi-layer edit reaches every next cut in parallel.
  for (const { entry, index, chunk, priority } of tasks) {
    if(nearBudget&&priority>=1e5)continue;
    if (inFlight.size >= concurrency) break;
    if (inFlight.has(entry.url)) continue;
    const failure = failures.get(entry.url);
    if (failure && failure.next > Date.now()) continue;
    const controller = new AbortController(), epoch = generation;
    inFlight.set(entry.url, controller);
    transferStart ||= performance.now();
    const timeout = setTimeout(() => controller.abort(new Error('Media download timed out')), 30000);
    const run = async () => {
      if (!index) {
        const parsed = await loadLayout(entry.url, controller.signal);
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
    void run().then(() => { if (epoch === generation && !controller.signal.aborted) failures.delete(entry.url); }).catch(error => {
      if (epoch !== generation || controller.signal.aborted && controller.signal.reason?.name === 'AbortError') return;
      const attempts = (failures.get(entry.url)?.attempts ?? 0) + 1;
      failures.set(entry.url, { attempts, next: attempts >= 3 ? Infinity : Date.now() + 1000 * 2 ** attempts, error: error instanceof Error ? error.message : 'Media download failed' });
    }).finally(() => { clearTimeout(timeout); inFlight.delete(entry.url); notify(); pump(); });
  }
  const next = Math.min(...entries.map(e => failures.get(e.url)?.next ?? Infinity).filter(t => t > Date.now()));
  if (Number.isFinite(next)) retryTimer = setTimeout(pump, Math.max(1, next - Date.now()));
}
/** When the worker last served a file; it stamps `used` on the file's meta entry at most once a minute. */
async function lastUsed(cache: Cache, url: string) {
  try { return Number((await (await cache.match(keyFor(url, 'meta')))?.json())?.used) || 0; } catch { return 0; }
}
async function evict() {
  if (!supported()) return;
  try {
    const usage=storedBytes();
    if(usage<CAP_BYTES*.9)return;
    const cache=await caches.open(CACHE),keep=new Map<string,Set<number>>(),used=new Map<string,number>();
    for(const entry of files()){
      const index=indexes.get(entry.url);if(!index)continue;
      const pinned=keep.get(entry.url)??new Set<number>();keep.set(entry.url,pinned);
      if(!('size' in index))for(const chunk of chunksOf({start:0,end:index.moovEnd}))pinned.add(chunk);
      const range=entry.order<15&&windowOf(entry,index);if(range)for(const chunk of chunksOf(range))pinned.add(chunk);
    }
    for(const url of stored.keys())used.set(url,await lastUsed(cache,url));
    // Longest unused file first; the current and next playable windows are never candidates.
    const victims=[...stored].flatMap(([url,chunks])=>[...chunks.keys()].filter(i=>!keep.get(url)?.has(i)).map(i=>({url,i}))).sort((a,b)=>used.get(a.url)!-used.get(b.url)!||a.i-b.i);
    let excess=usage-CAP_BYTES*.8;
    for(const {url,i} of victims){
      if(excess<=0)break;
      await cache.delete(keyFor(url,i));const chunks=stored.get(url);excess-=chunks?.get(i)??CHUNK;chunks?.delete(i);
      if(!chunks?.size)stored.delete(url);
    }
    notify();
  } catch { /* Storage estimates are optional. */ }
}
export async function footageUsage() {
  if (!supported()) return 0;
  try { return (await (await caches.open(CACHE)).keys()).filter(request => /^\d+$/.test(keyOf(request).marker ?? '')).length * CHUNK; } catch { return 0; }
}
export async function clearFootageCache() {
  clearing = true; generation++; clearTimeout(retryTimer);
  for (const controller of inFlight.values()) controller.abort();
  stored.clear(); indexes.clear(); failures.clear(); lastUpdate = -Infinity; notify();
  try {
    if (supported()) {
      const controller = navigator.serviceWorker.controller;
      if (controller?.postMessage) await new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Cache is still busy. Retry clearing shortly.')); }, 35000);
        channel.port1.onmessage = () => { clearTimeout(timeout); channel.port1.close(); resolve(); };
        controller.postMessage({ type: 'footage-clear' }, [channel.port2]);
      });
      else await caches.delete(CACHE);
    }
  } finally { clearing = false; stored.clear(); indexes.clear(); notify(); }
}
