import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { GIB, measureBytes, powershellCommand, readCommand, type Sample } from './hostGuard.ts';
import { renameWithRetry } from './platform.ts';

// The host's black box: one JSON line every 30 s with memory, commit headroom, paging, power, GPU, event-loop lag,
// queue sizes and the live child-process count, so the next hard reset leaves a trail. Everything is read
// asynchronously with a timeout and cached, and nothing in here ever throws into the server. GB means GiB.

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 ** 2;
/** nvidia-smi is never run more often than the log line, and a timer that fires a hair early must not skip a reading. */
const GPU_MIN_INTERVAL_MS = 30_000;
const TIMER_SLOP_MS = 1_000;
const GPU_TIMEOUT_MS = 2_000;
// The formatted CIM perf class samples twice, about 4 s on the Dell when idle; under memory pressure, when the line
// matters most, it is slower still.
const WINDOWS_STATS_TIMEOUT_MS = 15_000;
const LAG_RESOLUTION_MS = 20;
const NS_PER_MS = 1e6;
const ERROR_REPORT_GAP_MS = 10 * 60_000;
// Win32_Battery.BatteryStatus: 1 discharging, 4 low, 5 critical are all running on the battery; 10 is "undefined".
const ON_BATTERY_STATUSES: ReadonlySet<number> = new Set([1, 4, 5]);
const UNDEFINED_BATTERY_STATUS = 10;
// CIM (not Get-Counter) because performance counter names are translated per Windows language. No double quotes in the
// script: they would have to survive Windows argument quoting on the way into powershell.exe.
const WINDOWS_STATS_SCRIPT = "$m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; $b = @(Get-CimInstance Win32_Battery)[0]; ($m.PagesPersec, $b.BatteryStatus) -join '|'";
const NVIDIA_SMI_ARGS = ['--query-gpu=memory.used,temperature.gpu', '--format=csv,noheader,nounits'];

export type WindowsStats = { pagesPerSec: number | null; onBattery: boolean | null };
export type GpuStats = { gpuMemUsedGB: number; gpuTempC: number };
export type LagReading = { p99Ms: number; maxMs: number };

export type HostHealthLine = {
  /** ISO 8601, UTC. */
  time: string;
  availableGB: number | null;
  commitHeadroomGB: number | null;
  pagesPerSec: number | null;
  onBattery: boolean | null;
  gpuMemUsedGB: number | null;
  gpuTempC: number | null;
  /** 99th percentile and maximum event-loop delay since the previous line. */
  eventLoopLagMs: number | null;
  eventLoopLagMaxMs: number | null;
  queues: Record<string, number>;
  /** Live ffmpeg and Python children of the server. */
  children: number | null;
};

export type HostHealthLogOptions = {
  /** e.g. join(dataDir, 'host-health.log'). One rotated copy is kept beside it as `<path>.1`. */
  path: string;
  /** Memory reading, e.g. `() => guard.sample()`. */
  sample?: () => Sample;
  /** Queue sizes by name, e.g. `{ media: 2, heavy: 1, previews: 0 }`. */
  queues?: () => Record<string, number>;
  /** Live ffmpeg and Python child count. */
  children?: () => number;
  readWindows?: () => Promise<WindowsStats>;
  readGpu?: () => Promise<GpuStats>;
  lag?: () => LagReading | null;
  /** Epoch milliseconds. */
  now?: () => number;
  platform?: NodeJS.Platform;
  intervalMs?: number;
  maxBytes?: number;
  onError?: (error: unknown) => void;
};

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const numberOrNull = (text: string | undefined) => (text !== undefined && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null);

export function parseWindowsStats(text: string): WindowsStats {
  const [pages, battery] = text.trim().split('|');
  const rate = numberOrNull(pages);
  const status = numberOrNull(battery);
  return {
    pagesPerSec: rate !== null && rate >= 0 ? rate : null,
    onBattery: status === null || status === UNDEFINED_BATTERY_STATUS ? null : ON_BATTERY_STATUSES.has(status),
  };
}

/** The first card's memory (MiB, read as GiB) and temperature; null when nvidia-smi printed anything else. */
export function parseGpuLine(text: string): GpuStats | null {
  const [memory, temperature] = (text.trim().split(/\r?\n/)[0] ?? '').split(',').map(part => numberOrNull(part));
  if (memory === null || memory === undefined || temperature === null || temperature === undefined) return null;
  return { gpuMemUsedGB: round2(memory / 1024), gpuTempC: temperature };
}

const readWindowsStats = async (): Promise<WindowsStats> =>
  parseWindowsStats(await readCommand(powershellCommand(), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_STATS_SCRIPT], WINDOWS_STATS_TIMEOUT_MS));

async function readNvidiaSmi(): Promise<GpuStats> {
  const stats = parseGpuLine(await readCommand(process.env.FRAME_LINE_NVIDIA_SMI || 'nvidia-smi', NVIDIA_SMI_ARGS, GPU_TIMEOUT_MS));
  if (!stats) throw new Error('nvidia-smi gave no usable reading');
  return stats;
}

/**
 * Wraps an async read so it runs at most once per `minMs`, never twice at once, and never rejects: a failure is cached
 * as null too, so a missing tool is not launched again on every tick.
 */
export function cachedAsync<T>(read: () => Promise<T>, minMs: number, now: () => number): () => Promise<T | null> {
  let at = -Infinity, value: T | null = null, flight: Promise<T | null> | null = null;
  return () => {
    if (flight) return flight;
    if (now() - at < minMs) return Promise.resolve(value);
    at = now();
    flight = new Promise<T>(resolve => resolve(read())).then(next => next, () => null).then(next => { value = next; flight = null; return next; });
    return flight;
  };
}

/** Runs a reading that may throw and returns the fallback instead. */
function attempt<T>(read: (() => T) | undefined, fallback: T): T {
  try { return read ? read() : fallback; } catch { return fallback; }
}

export class HostHealthLog {
  readonly #options: HostHealthLogOptions;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #maxBytes: number;
  readonly #windows: () => Promise<WindowsStats | null>;
  readonly #gpu: () => Promise<GpuStats | null>;
  #histogram: IntervalHistogram | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #flight: Promise<void> | null = null;
  #latest: HostHealthLine | null = null;
  #lastErrorAt = -Infinity;

  constructor(options: HostHealthLogOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const platform = options.platform ?? process.platform;
    const windows = options.readWindows ?? (platform === 'win32' ? readWindowsStats : undefined);
    const gpu = options.readGpu ?? (platform === 'darwin' ? undefined : readNvidiaSmi);
    this.#windows = windows ? cachedAsync(windows, this.#intervalMs - TIMER_SLOP_MS, this.#now) : () => Promise.resolve(null);
    this.#gpu = gpu ? cachedAsync(gpu, GPU_MIN_INTERVAL_MS - TIMER_SLOP_MS, this.#now) : () => Promise.resolve(null);
  }

  /** The most recent line written (or collected by flush), for the Health page. */
  latest(): HostHealthLine | null { return this.#latest; }

  /** Gathers one line. Every reading is optional: a failed one is null. */
  async collect(): Promise<HostHealthLine> {
    const [windows, gpu] = await Promise.all([this.#windows(), this.#gpu()]);
    const sample = attempt<Sample | null>(this.#options.sample, null);
    const lag = this.#readLag();
    return {
      time: new Date(this.#now()).toISOString(),
      availableGB: sample ? round2(sample.availableBytes / GIB) : null,
      commitHeadroomGB: sample && sample.commitHeadroomBytes !== null ? round2(sample.commitHeadroomBytes / GIB) : null,
      pagesPerSec: windows?.pagesPerSec ?? null,
      onBattery: windows?.onBattery ?? null,
      gpuMemUsedGB: gpu?.gpuMemUsedGB ?? null,
      gpuTempC: gpu?.gpuTempC ?? null,
      eventLoopLagMs: lag ? round1(lag.p99Ms) : null,
      eventLoopLagMaxMs: lag ? round1(lag.maxMs) : null,
      queues: attempt<Record<string, number>>(this.#options.queues, {}),
      children: attempt<number | null>(this.#options.children, null),
    };
  }

  /** Collects and appends one line. One at a time; overlapping calls share the one in flight. Never rejects. */
  flush(): Promise<void> {
    this.#flight ??= this.#write().catch(error => this.#report(error)).finally(() => { this.#flight = null; });
    return this.#flight;
  }

  /** Logs once straight away, then every `intervalMs`. The timer never keeps the process alive. */
  start(): void {
    if (this.#timer) return;
    if (!this.#options.lag) { this.#histogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS }); this.#histogram.enable(); }
    void this.flush();
    this.#timer = setInterval(() => void this.flush(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#histogram?.disable();
    this.#histogram = null;
  }

  #readLag(): LagReading | null {
    if (this.#options.lag) return attempt<LagReading | null>(this.#options.lag, null);
    const histogram = this.#histogram;
    if (!histogram || histogram.count === 0) return null;
    const reading = { p99Ms: histogram.percentile(99) / NS_PER_MS, maxMs: histogram.max / NS_PER_MS };
    histogram.reset();
    return reading;
  }

  async #write(): Promise<void> {
    const line = await this.collect();
    this.#latest = line;
    const text = `${JSON.stringify(line)}\n`, path = this.#options.path;
    await mkdir(dirname(path), { recursive: true });
    const size = await stat(path).then(info => info.size, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; });
    // An empty file takes any line, so a line larger than the limit cannot rotate forever.
    if (size > 0 && size + Buffer.byteLength(text) > this.#maxBytes) await renameWithRetry(path, `${path}.1`);
    await appendFile(path, text, 'utf8');
  }

  /** A full disk would fail every 30 s; say so once in a while, not every time. */
  #report(error: unknown): void {
    const now = this.#now();
    if (now - this.#lastErrorAt < ERROR_REPORT_GAP_MS) return;
    this.#lastErrorAt = now;
    try { (this.#options.onError ?? (failure => console.warn('Host health log failed:', failure)))(error); } catch { /* Nothing more to do. */ }
  }
}

export const createHostHealthLog = (options: HostHealthLogOptions): HostHealthLog => new HostHealthLog(options);
