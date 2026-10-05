// Browser side of the playback report: a pure collector over the player's own events, safe readers for device and
// network facts, and the small formatters the Health page uses. Numbers and short labels only: no clip, file or
// project names ever leave the browser. Nothing here may throw into playback, so every browser API is optional.
import type { HealthLight, HostHealth, PersonHealth, PlaybackReport } from './playbackReportTypes.ts';

export const WINDOW_MS = 10_000;
export const ACTIVE_REPORT_MS = 10_000;
export const IDLE_REPORT_MS = 60_000;
export const MIN_REPORT_GAP_MS = 3_000;
/** A play run is not judged on less than this much real playing: the first tick or two would read as a stall or a fake rate. */
export const MIN_PLAYING_MS = 3_000;
/** Time between two ticks above this is a hidden tab or a blocked page, not a measured wait. */
const MAX_TICK_GAP_MS = 1_000;
const DEFAULT_TARGET_FPS = 30;
const MAX_EVENTS = 4_000;
const MAX_LABEL = 40;
const MAX_GPU_LABEL = 60;
const HOST_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

export type WaitKind = 'color' | 'decode' | 'buffer' | 'seek' | 'other';
/** The `detail` of the player's `frameline:playback-health` event. */
export type HealthDetail = { playing: boolean; playhead: number; loading: boolean; engine?: string; reason?: string; error?: string; decodedAhead?: number };
/** What the caller knows and the collector does not: device facts, the build and the current picture source. */
export type ReportEnv = Pick<PlaybackReport, 'build' | 'quality' | 'source' | 'cachedPct' | 'harness' | 'onHost' | 'cores' | 'memoryGB' | 'gpu' | 'agent' | 'netType' | 'rttMs' | 'downlinkMbps' | 'saveData'> & {
  /** True when a long-task observer is running, so zero means "none" and not "unknown". */
  longTasks?: boolean;
};
export type ReportCollector = {
  /**
   * A picture was painted. `stamp` names the source picture (the frame event's `dataset.sourceTimestamp`), so a repeat of
   * the same one is not counted twice. Leave it out when unknown, e.g. a held still image, which would otherwise read as a freeze.
   */
  onFrame(stamp?: string): void;
  onHealth(detail: HealthDetail): void;
  /** One footage download finished: `bytes` in `ms`, `agoMs` milliseconds ago. */
  onTransfer(bytes: number, ms: number, agoMs?: number): void;
  onLongTask(ms: number): void;
  reset(): void;
  /** Is it time to send? Every 10 s while playing (once 3 s of it were seen), a final window soon after it stops, otherwise every 60 s. */
  isDue(): boolean;
  /** A report over the last 10 s, or null when nothing was observed or nothing is new since the last one. */
  build(env: ReportEnv): PlaybackReport | null;
};

type Sample = { at: number; playing: boolean; loading: boolean; reason: string; playhead: number; engine: string };
type Picture = { at: number; distinct: boolean };
type Transfer = { start: number; end: number; bytes: number };
type LongTask = { at: number; ms: number };
type Waits = Record<WaitKind, number>;

const attempt = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
const round = (value: number, decimals = 0): number => { const scale = 10 ** decimals; return Math.round(value * scale) / scale; };
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const finiteOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const emptyWaits = (): Waits => ({ color: 0, decode: 0, buffer: 0, seek: 0, other: 0 });

/** One waiting reason such as "Clip.MP4 · Preparing color frame" becomes a kind. The clip name before the dot is never read. */
export function bucketReason(text: string): WaitKind {
  const what = (text.split('·').pop() ?? '').trim().toLowerCase();
  if (what.includes('color')) return 'color';
  if (what.includes('buffer') || what.includes('metadata')) return 'buffer';
  if (what.includes('decod')) return 'decode';
  if (what.includes('seek')) return 'seek';
  return 'other';
}

/** The player joins the reason of every active layer with "; ", so one tick can wait on several kinds. */
function waitKinds(reason: string): WaitKind[] {
  const kinds = new Set(reason.split(';').map(part => part.trim()).filter(Boolean).map(bucketReason));
  return kinds.size ? [...kinds] : ['other'];
}

/** Drops entries older than `cutoff`, keeping `anchors` of them so the interval that ends inside the window still has a start. */
function dropOld<T>(list: T[], timeOf: (item: T) => number, cutoff: number, anchors = 0): T[] {
  let stale = 0;
  while (stale < list.length - anchors && timeOf(list[stale + anchors]) < cutoff) stale++;
  stale = Math.max(stale, list.length - MAX_EVENTS);
  return stale > 0 ? list.slice(stale) : list;
}

/** Time spent playing and, within it, waiting, by kind. Each interval is charged to the state the earlier tick reported. */
function playTime(samples: readonly Sample[]): { playMs: number; waits: Waits } {
  const waits = emptyWaits();
  let playMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1], ms = Math.min(samples[i].at - before.at, MAX_TICK_GAP_MS);
    if (!before.playing || ms <= 0) continue;
    playMs += ms;
    if (!before.loading) continue;
    const kinds = waitKinds(before.reason);
    for (const kind of kinds) waits[kind] += ms / kinds.length;
  }
  return { playMs, waits };
}

/** Pictures painted while playing. The health event follows the frame event in the same tick, so a picture counts when the next tick plays. */
function playingPictures(samples: readonly Sample[], pictures: readonly Picture[]): Picture[] {
  let next = 0;
  return pictures.filter(picture => {
    while (next < samples.length && samples[next].at < picture.at) next++;
    return samples[next]?.playing === true;
  });
}

/** Distinct pictures shown while playing and the longest stretch without a new one, never counting time spent paused. */
function pictureStats(samples: readonly Sample[], pictures: readonly Picture[]): { count: number; worstFreezeMs: number } {
  const starts = samples.filter((sample, i) => sample.playing && !samples[i - 1]?.playing).map(sample => sample.at);
  const last = samples[samples.length - 1];
  if (!starts.length || !last) return { count: 0, worstFreezeMs: 0 };
  const shown = playingPictures(samples, pictures).filter(picture => picture.distinct);
  let worst = 0, previous = -Infinity, run = 0;
  const closeGap = (until: number) => {
    while (run + 1 < starts.length && starts[run + 1] <= until) run++;
    worst = Math.max(worst, until - Math.max(previous, starts[run]));
  };
  for (const picture of shown) { closeGap(picture.at); previous = picture.at; }
  if (last.playing) closeGap(last.at);
  return { count: shown.length, worstFreezeMs: Math.round(worst) };
}

/** Footage worker throughput: bytes over the time any download was running, so parallel downloads are not double counted. */
function linkMbps(transfers: readonly Transfer[]): number | null {
  let busy = 0, end = -Infinity, bytes = 0;
  for (const transfer of [...transfers].sort((a, b) => a.start - b.start)) {
    bytes += transfer.bytes;
    busy += Math.max(0, transfer.end - Math.max(transfer.start, end));
    end = Math.max(end, transfer.end);
  }
  return busy > 0 ? round(bytes * 8 / (busy * 1000), 2) : null;
}

export function createReportCollector(options: { now: () => number; targetFps: number | (() => number) }): ReportCollector {
  const { now } = options;
  // Private buffers on the hot path (one entry per painted frame): appended in place, trimmed to the window on every event.
  let samples: Sample[] = [], pictures: Picture[] = [], transfers: Transfer[] = [], longTasks: LongTask[] = [];
  let lastStamp: string | undefined, activity = 0, reportedActivity = 0, lastReportAt = now(), playedSinceReport = false;
  const targetFps = (): number => {
    const value = typeof options.targetFps === 'function' ? attempt(options.targetFps, Number.NaN) : options.targetFps;
    return Number.isFinite(value) && value > 0 ? round(value, 2) : DEFAULT_TARGET_FPS;
  };
  const trim = () => {
    const cutoff = now() - WINDOW_MS;
    samples = dropOld(samples, sample => sample.at, cutoff, 1);
    pictures = dropOld(pictures, picture => picture.at, cutoff);
    transfers = dropOld(transfers, transfer => transfer.end, cutoff);
    longTasks = dropOld(longTasks, task => task.at, cutoff);
  };
  return {
    onFrame(stamp) {
      pictures.push({ at: now(), distinct: stamp === undefined || stamp !== lastStamp });
      lastStamp = stamp; activity++; trim();
    },
    onHealth(detail) {
      const playing = detail.playing === true;
      samples.push({ at: now(), playing, loading: detail.loading === true, reason: typeof detail.reason === 'string' ? detail.reason.slice(0, 400) : '', playhead: detail.playhead, engine: typeof detail.engine === 'string' ? detail.engine.slice(0, 24) : '' });
      if (playing) playedSinceReport = true;
      activity++; trim();
    },
    onTransfer(bytes, ms, agoMs = 0) {
      if (!(bytes > 0 && ms > 0 && Number.isFinite(bytes) && Number.isFinite(ms))) return;
      const end = now() - (Number.isFinite(agoMs) && agoMs > 0 ? agoMs : 0);
      transfers.push({ start: end - ms, end, bytes }); activity++; trim();
    },
    onLongTask(ms) {
      if (!(ms > 0 && Number.isFinite(ms))) return;
      longTasks.push({ at: now(), ms }); activity++; trim();
    },
    reset() {
      samples = []; pictures = []; transfers = []; longTasks = [];
      lastStamp = undefined; activity = 0; reportedActivity = 0; lastReportAt = now(); playedSinceReport = false;
    },
    isDue() {
      const last = samples[samples.length - 1];
      const since = now() - lastReportAt;
      if (!last || since < MIN_REPORT_GAP_MS) return false;
      if (!last.playing) return playedSinceReport || since >= IDLE_REPORT_MS;
      return since >= ACTIVE_REPORT_MS && playTime(samples).playMs >= MIN_PLAYING_MS;
    },
    build(env) {
      const last = samples[samples.length - 1];
      if (!last || activity === reportedActivity) return null;
      trim();
      const { playMs, waits } = playTime(samples), shown = pictureStats(samples, pictures);
      const waitMs = { color: round(waits.color), decode: round(waits.decode), buffer: round(waits.buffer), seek: round(waits.seek), other: round(waits.other) };
      const loadingMs = waits.color + waits.decode + waits.buffer + waits.seek + waits.other;
      reportedActivity = activity; lastReportAt = now(); playedSinceReport = false;
      return {
        v: 1, build: env.build, at: Date.now(), windowMs: round(playMs), playing: last.playing, targetFps: targetFps(),
        fps: playMs > 0 ? round(Math.max(0, shown.count - 1) / (playMs / 1000), 1) : 0,
        loadingPct: playMs > 0 ? round(100 * loadingMs / playMs, 1) : 0,
        worstFreezeMs: shown.worstFreezeMs, waitMs, linkMbps: linkMbps(transfers),
        rttMs: env.rttMs, netType: env.netType, downlinkMbps: env.downlinkMbps, saveData: env.saveData,
        cores: env.cores, memoryGB: env.memoryGB, gpu: env.gpu, agent: env.agent,
        longTaskMs: env.longTasks ? round(longTasks.reduce((sum, task) => sum + task.ms, 0)) : null,
        quality: env.quality, engine: last.engine, source: env.source,
        playheadMin: Number.isFinite(last.playhead) && last.playhead > 0 ? Math.floor(last.playhead / 60) : 0,
        cachedPct: env.cachedPct, harness: env.harness, onHost: env.onHost,
      };
    },
  };
}

// ---- Device and network readers: every API optional, every read guarded ------------------------------------------

type Globals = { navigator?: unknown; location?: unknown; document?: unknown; window?: unknown };
type Connection = { effectiveType?: unknown; rtt?: unknown; downlink?: unknown; saveData?: unknown };
type NavigatorLike = { hardwareConcurrency?: unknown; deviceMemory?: unknown; connection?: Connection; userAgent?: unknown; webdriver?: unknown; userAgentData?: { brands?: { brand?: unknown; version?: unknown }[]; platform?: unknown } };
type GlLike = { getExtension(name: string): unknown; getParameter(parameter: number): unknown };
type ObserverCtor = { new (callback: (list: { getEntries(): { duration: number }[] }) => void): { observe(options: { type: string }): void; disconnect(): void }; supportedEntryTypes?: readonly string[] };
export type DeviceFacts = Pick<PlaybackReport, 'cores' | 'memoryGB' | 'gpu' | 'agent' | 'netType' | 'rttMs' | 'downlinkMbps' | 'saveData' | 'harness' | 'onHost'>;
export type GpuCache = { value: string | undefined };
const defaultGpuCache: GpuCache = { value: undefined };

const printable = (text: string, max: number): string => text.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const BROWSERS: [RegExp, string][] = [[/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/Firefox\/(\d+)/, 'Firefox'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+).*Safari/, 'Safari']];
const SYSTEMS: [RegExp, string][] = [[/CrOS/, 'ChromeOS'], [/Android/, 'Android'], [/iPhone|iPad/, 'iOS'], [/Windows/, 'Windows'], [/Macintosh|Mac OS X/, 'macOS'], [/Linux/, 'Linux']];

function parseUserAgent(userAgent: string): string {
  const text = userAgent.slice(0, 300);
  const browser = BROWSERS.map(([pattern, name]) => { const found = pattern.exec(text); return found ? `${name} ${found[1]}` : ''; }).find(Boolean) ?? '';
  const system = SYSTEMS.find(([pattern]) => pattern.test(text))?.[1] ?? '';
  return `${browser} ${system}`;
}

function brandLabel(data: NavigatorLike['userAgentData']): string {
  const brands = (Array.isArray(data?.brands) ? data.brands : []).filter(entry => typeof entry?.brand === 'string' && !/not.?a.?brand/i.test(entry.brand));
  const chosen = brands.find(entry => entry.brand !== 'Chromium') ?? brands[0];
  if (!chosen) return '';
  return `${String(chosen.brand)} ${typeof chosen.version === 'string' ? chosen.version : ''} ${typeof data?.platform === 'string' ? data.platform : ''}`;
}

/** A short "Chrome 152 ChromeOS" style label, never the full user agent. */
export function agentLabel(nav: NavigatorLike): string {
  return printable(brandLabel(nav.userAgentData) || parseUserAgent(typeof nav.userAgent === 'string' ? nav.userAgent : ''), MAX_LABEL);
}

export const isHarness = (nav: unknown, win: unknown): boolean =>
  attempt(() => (nav as NavigatorLike | undefined)?.webdriver === true || (win as { __sharedcutHarness?: unknown } | undefined)?.__sharedcutHarness === true, false);

/** True when the browser runs on the server's own computer, so the host is not asked to render for itself. */
export const isOnHost = (location: unknown): boolean =>
  HOST_NAMES.includes(attempt(() => String((location as { hostname?: unknown } | undefined)?.hostname ?? ''), '').toLowerCase());

function probeGpu(doc: { createElement(tag: string): { width: number; height: number; getContext(kind: string): unknown } }): string {
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as GlLike | null;
  if (!gl) return '';
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    return info ? printable(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)).replace(/^ANGLE \(/, '').replace(/\)$/, ''), MAX_GPU_LABEL) : '';
  } finally {
    (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  }
}

/** The graphics card name, read once through a throwaway 1x1 context. With no document yet it tries again later. */
export function readGpu(doc: unknown, cache: GpuCache = defaultGpuCache): string {
  if (cache.value !== undefined) return cache.value;
  if (!doc) return '';
  cache.value = attempt(() => probeGpu(doc as Parameters<typeof probeGpu>[0]), '');
  return cache.value;
}

export function readDevice(globals: Globals = globalThis as Globals, gpuCache: GpuCache = defaultGpuCache): DeviceFacts {
  const nav = attempt(() => globals.navigator as NavigatorLike | undefined, undefined);
  const connection = attempt(() => nav?.connection, undefined);
  return {
    cores: attempt(() => positive(nav?.hardwareConcurrency), null),
    memoryGB: attempt(() => positive(nav?.deviceMemory), null),
    gpu: attempt(() => readGpu(globals.document, gpuCache), ''),
    agent: attempt(() => agentLabel(nav ?? {}), ''),
    netType: attempt(() => typeof connection?.effectiveType === 'string' ? printable(connection.effectiveType, 10) : null, null),
    rttMs: attempt(() => finiteOrNull(connection?.rtt), null),
    downlinkMbps: attempt(() => finiteOrNull(connection?.downlink), null),
    saveData: attempt(() => connection?.saveData === true, false),
    harness: isHarness(nav, attempt(() => globals.window, undefined)),
    onHost: isOnHost(attempt(() => globals.location, undefined)),
  };
}

/** Reports main-thread long tasks to `onTask`. Returns a stop function, or null where the browser cannot observe them. */
export function observeLongTasks(onTask: (ms: number) => void, Observer: ObserverCtor | undefined = (globalThis as { PerformanceObserver?: ObserverCtor }).PerformanceObserver): (() => void) | null {
  try {
    if (!Observer?.supportedEntryTypes?.includes('longtask')) return null;
    const observer = new Observer(list => { for (const entry of list.getEntries()) onTask(entry.duration); });
    observer.observe({ type: 'longtask' });
    return () => observer.disconnect();
  } catch {
    return null;
  }
}

// ---- Health page formatters ---------------------------------------------------------------------------------------

const LIGHT_WORDS: Record<HealthLight, string> = { green: 'Good', amber: 'Fair', red: 'Poor', grey: 'No data' };
const GUARD_WORDS: Record<HostHealth['guardMode'], string> = { off: 'Off', observe: 'Watching only', enforce: 'Enforcing' };
const NONE = '—';
export type Fact = { label: string; value: string };

export const lightLabel = (light: HealthLight): string => LIGHT_WORDS[light];

/** How long ago, from a difference in server clock milliseconds. */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

export function keyNumbers(report: PlaybackReport | null): Fact[] {
  if (!report) return [];
  const known = report.cores !== null || report.memoryGB !== null;
  return [
    { label: 'Pictures/s', value: `${round(report.fps, 1)} of ${round(report.targetFps, 1)}` },
    { label: 'Loading', value: `${Math.round(report.loadingPct)}%` },
    { label: 'Link', value: report.linkMbps === null ? NONE : `${report.linkMbps.toFixed(1)} Mbps` },
    { label: 'Round trip', value: report.rttMs === null ? NONE : `${Math.round(report.rttMs)} ms` },
    { label: 'Device', value: known ? `${report.cores ?? '?'} cores, ${report.memoryGB ?? '?'} GB` : NONE },
    { label: 'Browser', value: report.agent || NONE },
  ];
}

export function hostFacts(host: HostHealth): Fact[] {
  const power = host.onBattery === null ? 'Unknown' : host.onBattery ? 'On battery' : 'Plugged in';
  return [
    { label: 'Free memory', value: `${host.freeGB.toFixed(1)} GB` },
    { label: 'Commit headroom', value: host.commitHeadroomGB === null ? NONE : `${host.commitHeadroomGB.toFixed(1)} GB` },
    { label: 'Jobs', value: `${host.running} running, ${host.queued} queued` },
    { label: 'Previews running', value: String(host.previewsRunning) },
    { label: 'Memory guard', value: GUARD_WORDS[host.guardMode] },
    { label: 'Power', value: power },
    { label: 'GPU temperature', value: host.gpuTempC === null ? NONE : `${Math.round(host.gpuTempC)} °C` },
  ];
}

/**
 * SVG polyline point lists for pictures per second, scaled so `max` fills the height. A `null` value (an idle minute) is a
 * gap, not a zero: the line breaks there, and a lone point between gaps is drawn as a dot. Fewer than two values draw nothing.
 */
export function sparklineSegments(values: readonly (number | null)[], width: number, height: number, max: number): string[] {
  if (values.length < 2) return [];
  const clean = values.map(value => value === null ? null : Number.isFinite(value) && value > 0 ? value : 0);
  const scale = max > 0 ? max : Math.max(1, ...clean.filter((value): value is number => value !== null));
  const runs: string[][] = [[]];
  clean.forEach((value, i) => {
    if (value === null) { if (runs[runs.length - 1].length) runs.push([]); return; }
    runs[runs.length - 1].push(`${round(i / (clean.length - 1) * width, 1)},${round(height - 1 - Math.min(1, value / scale) * (height - 2), 1)}`);
  });
  return runs.filter(run => run.length).map(run => (run.length === 1 ? [run[0], run[0]] : run).join(' '));
}

/** People first, test-harness runs apart. Never changes its input. */
export function splitPeople(people: readonly PersonHealth[]): { real: PersonHealth[]; harness: PersonHealth[] } {
  return { real: people.filter(person => !person.harness), harness: people.filter(person => person.harness) };
}
