// Joins the player's own events to the playback report collector and decides when a report may leave: only while
// sharing is on, only when due, never closer together than the server accepts. The presence heartbeat reads the
// installed reporter through takeHealthReport. Nothing here may throw into playback or into the heartbeat.
import { createReportCollector, observeLongTasks } from './playbackReport.ts';
import type { DeviceFacts, HealthDetail, ReportEnv } from './playbackReport.ts';
import type { PlaybackReport } from './playbackReportTypes.ts';

/** The server keeps one report per browser every 5 s (REPORT_GAP_MS in server/index.ts) and drops one that comes sooner. */
export const SERVER_REPORT_GAP_MS = 5_000;
/** Two reports leave at least this far apart: the server's gap plus a second, because the network can bunch two posts closer than they were sent. */
export const MIN_SEND_GAP_MS = SERVER_REPORT_GAP_MS + 1_000;
/** The player's own fallback preview rate. */
const DEFAULT_FPS = 24;
/** Engines whose pictures have a real source timestamp (the rest are stills and graphics, which repeat one). */
const VIDEO_ENGINES = ['webcodecs', 'native', 'render-cache'];
const QUALITY_LABELS = new Map([['Quarter resolution', '1/4'], ['Half resolution', '1/2'], ['Full resolution', 'Full']]);
/** The hashed entry script Vite writes, e.g. /assets/index-DiwrgTda.js. */
const BUILD_FILE = /\/assets\/.*-([\w-]{8})\.js(?:$|\?)/;
const DEV_BUILD = 'dev';

type Dataset = Record<string, string | undefined>;
/** What the last painted picture came from. */
export type PictureFacts = { clipId: string; engine: string; automaticLow: boolean };
export type ReporterDeps = {
  /** Milliseconds on a monotonic clock. */
  now: () => number;
  /** The window: 'frameline:frame' and 'frameline:playback-health' events. */
  target: EventTarget;
  /** navigator.serviceWorker: the footage worker's 'footage-transfer' messages. */
  worker?: EventTarget;
  /** The document, for 'visibilitychange'. */
  doc?: EventTarget & { hidden: boolean };
  build: string;
  /** The "Share playback health" setting, read fresh each time. */
  sharing: () => boolean;
  device: () => DeviceFacts;
  context: (picture: PictureFacts) => Pick<ReportEnv, 'quality' | 'source' | 'cachedPct'>;
  targetFps: (picture: PictureFacts) => number;
  /** True for a clip that shows one source picture on purpose (a freeze frame): its repeats are then not counted as a stall. */
  isHeld?: (clipId: string) => boolean;
  observe?: (onTask: (ms: number) => void) => (() => void) | null;
  /** Calls the listener when the project or timeline changes; returns how to stop. */
  onContextChange?: (listener: () => void) => () => void;
};
export type HealthReporter = { take(): PlaybackReport | null; reset(): void; stop(): void };

// ---- Pure helpers ------------------------------------------------------------------------------------------------

/** On unless the account turned it off with a real boolean false. */
export const healthSharingEnabled = (settings: Readonly<Record<string, unknown>>): boolean => settings.sharePlaybackHealth !== false;

export const isVideoEngine = (engine: string): boolean => VIDEO_ENGINES.includes(engine);

/** Names one source picture so a repeat is not counted twice. Undefined for stills and graphics, which would read as a freeze. */
export function frameStamp(data: Dataset): string | undefined {
  const { sourceClip, sourceTimestamp, playbackEngine } = data;
  return sourceClip && sourceTimestamp !== undefined && isVideoEngine(playbackEngine ?? '') ? `${sourceClip}@${sourceTimestamp}` : undefined;
}

/** The Viewer's quality names, as short labels. */
export const qualityLabel = (preference: unknown): string => QUALITY_LABELS.get(String(preference)) ?? 'Stream';

export function pictureSource(picture: PictureFacts, quality: string): PlaybackReport['source'] {
  if (picture.engine === 'render-cache') return 'rendered';
  if (picture.automaticLow || quality === '1/4') return 'low';
  return quality === 'Stream' ? 'stream' : 'live';
}

/** Share of the wanted footage already saved on this computer, null when nothing is wanted or the cache is off. */
export function cachedPercent(entries: readonly { cached: number; total: number }[], cacheOn: boolean): number | null {
  const total = entries.reduce((sum, entry) => sum + entry.total, 0);
  if (!cacheOn || total <= 0) return null;
  return Math.min(100, Math.round(100 * entries.reduce((sum, entry) => sum + entry.cached, 0) / total));
}

/**
 * The most distinct pictures a second this playback can show: the preview rate (as the player computes it), or the
 * source's if lower. A clip played slower than `speed` 100 (percent) walks through its source that much slower, so it has
 * that much fewer source pictures to show; an unknown source rate is taken to match the preview.
 */
export function reportTargetFps(settings: Readonly<Record<string, unknown>>, projectFps: number | undefined, sourceFps: number | undefined, speed = 100): number {
  const preview = parseFloat(String(settings.playbackFrameRate)) || projectFps || DEFAULT_FPS;
  const known = sourceFps !== undefined && Number.isFinite(sourceFps) && sourceFps > 0;
  const rate = speed > 0 && speed < 100 ? speed / 100 : 1;
  return Math.min(preview, (known ? sourceFps : preview) * rate);
}

/** The few clip fields that say how a clip is retimed; a store Clip fits. */
export type TimingFacts = { properties: Readonly<Record<string, unknown>>; keyframes?: Readonly<Record<string, readonly { value: unknown }[] | undefined>> };

/** The clip's one speed in percent, or 100 when it is unset, unreadable or keyframed (a ramp has no single rate to scale by). */
export function constantSpeed(clip: TimingFacts): number {
  const speed = Number(clip.properties.speed ?? 100);
  return Number.isFinite(speed) && clip.keyframes?.['properties.speed'] === undefined ? speed : 100;
}

/** A freeze frame shows one source picture on purpose, wholly or part of the way, so its repeats are not a stall. */
export const isFrozenClip = (clip: TimingFacts): boolean => !!clip.properties.freeze || !!clip.keyframes?.['properties.freeze']?.some(key => key.value);

/** The short hash in the entry script's file name, or "dev" when the page is not a production build. */
export const buildIdFromScripts = (sources: readonly string[]): string => sources.map(src => BUILD_FILE.exec(src)?.[1]).find(Boolean) ?? DEV_BUILD;

// ---- The reporter ------------------------------------------------------------------------------------------------

const attempt = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
const quietly = <A extends unknown[]>(action: (...args: A) => void) => (...args: A): void => { try { action(...args); } catch { /* reporting must never break playback */ } };

export function createHealthReporter(deps: ReporterDeps): HealthReporter {
  let picture: PictureFacts = { clipId: '', engine: '', automaticLow: false };
  let lastSentAt: number | undefined;
  const collector = createReportCollector({ now: deps.now, targetFps: () => deps.targetFps(picture) });
  const listen = (target: EventTarget | undefined, type: string, handler: (event: Event) => void): (() => void) => {
    if (!target) return () => {};
    const safe = quietly(handler);
    target.addEventListener(type, safe);
    return () => target.removeEventListener(type, safe);
  };
  const stops = [
    listen(deps.target, 'frameline:frame', event => {
      const { dataset } = (event as CustomEvent<{ dataset: Dataset }>).detail;
      picture = { clipId: dataset.sourceClip ?? '', engine: dataset.playbackEngine ?? '', automaticLow: dataset.automaticLow === 'true' };
      collector.onFrame(attempt(() => deps.isHeld?.(picture.clipId) === true, false) ? undefined : frameStamp(dataset));
    }),
    listen(deps.target, 'frameline:playback-health', event => collector.onHealth((event as CustomEvent<HealthDetail>).detail)),
    listen(deps.worker, 'message', event => {
      const data = (event as MessageEvent<{ type?: unknown; bytes?: unknown; milliseconds?: unknown; ago?: unknown } | null>).data;
      if (data?.type === 'footage-transfer') collector.onTransfer(Number(data.bytes), Number(data.milliseconds), Number(data.ago) || 0);
    }),
    // A hidden tab stops ticking and would otherwise show as one long freeze.
    listen(deps.doc, 'visibilitychange', () => { if (deps.doc?.hidden) collector.reset(); }),
  ];
  const stopObserving = attempt(() => (deps.observe ?? observeLongTasks)(quietly((ms: number) => collector.onLongTask(ms))), null);
  const stopContext = attempt(() => deps.onContextChange?.(() => collector.reset()), undefined);
  const env = (): ReportEnv => ({ ...deps.device(), ...deps.context(picture), build: deps.build, longTasks: stopObserving !== null });
  return {
    take() {
      try {
        if (!deps.sharing()) return null;
        const at = deps.now();
        if (lastSentAt !== undefined && at - lastSentAt < MIN_SEND_GAP_MS) return null;
        if (!collector.isDue()) return null;
        const report = collector.build(env());
        if (report) lastSentAt = at;
        return report;
      } catch {
        return null;
      }
    },
    reset: () => collector.reset(),
    stop() { for (const stop of stops) stop(); stopObserving?.(); stopContext?.(); },
  };
}

// ---- The slot the presence heartbeat reads -----------------------------------------------------------------------

let installed: HealthReporter | null = null;

/** Makes `reporter` the one the heartbeat asks. Returns how to remove it; an older remover never removes a newer reporter. */
export function installHealthReporter(reporter: HealthReporter): () => void {
  installed = reporter;
  return () => { if (installed === reporter) installed = null; };
}

/** The report due now, or undefined. Called on each presence post; never throws. */
export function takeHealthReport(): PlaybackReport | undefined {
  try { return installed?.take() ?? undefined; } catch { return undefined; }
}
