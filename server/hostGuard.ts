import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { promisify } from 'node:util';
import type { HostHealth } from '../src/services/playbackReportTypes.ts';

// Host guard: an admission gate for the few heavy starts (render passes, media preparation, Python workers) plus a
// pressure response, so one laptop that is also somebody's workstation is never starved of memory by its own jobs.
// Decisions are pure functions of (measurement, clock, running, waiting); the runtime at the bottom only wires them to
// real timers and promises. Nothing here spawns ffmpeg or Python, and everything that reads the machine is async,
// cached and failure tolerant, because a guard that stalls the server is worse than no guard.

export const GIB = 1024 ** 3;

/** Strict priority, highest first. `other` is housekeeping: filmstrips, waveforms, thumbnails. */
export const JOB_CLASSES = ['export', 'ai', 'prepare', 'other', 'preview'] as const;
export type JobClass = typeof JOB_CLASSES[number];
export type GuardMode = HostHealth['guardMode'];

export type Policy = {
  /** Never start anything that would leave less than this, whatever the class and however long it has waited. */
  readonly floorBytes: number;
  /** Memory that must stay free after a job of that class starts (never below the floor). */
  readonly reserveBytes: Readonly<Record<JobClass, number>>;
  /** A started job's promised memory counts against newcomers this long, until its real use shows in the measurement. */
  readonly rampMs: number;
  /** A waiting job that cannot fit earns a reservation after this long: smaller jobs behind it stop jumping past. */
  readonly reservationAfterMs: number;
  /** After this, a waiting job other than an export fails with a retryable error. */
  readonly maxWaitMs: number;
  /** Jobs this cheap (ffprobe, version checks, stream copies) are never held. */
  readonly instantCostBytes: number;
  /** Pressure response: measurement under this for `pressureMs` aborts the cheapest work. */
  readonly pressureBytes: number;
  readonly pressureMs: number;
  readonly cooldownMs: number;
};

export const DEFAULT_POLICY: Policy = {
  floorBytes: 3 * GIB,
  reserveBytes: { export: 4 * GIB, prepare: 4 * GIB, ai: 4 * GIB, preview: 6 * GIB, other: 4 * GIB },
  rampMs: 20_000,
  reservationAfterMs: 30_000,
  maxWaitMs: 10 * 60_000,
  instantCostBytes: 0.25 * GIB,
  pressureBytes: 2 * GIB,
  pressureMs: 5_000,
  cooldownMs: 20_000,
};

/**
 * What a job is expected to take. Only `renderPass` is measured; the rest are estimates from the investigation notes
 * and are what observe mode exists to calibrate (it logs the real drop 20 s after each start).
 */
export const JOB_COST_BYTES = {
  /** Measured: six ffmpeg render passes each held 1,913 MB working set / 1,918 MB commit on the Dell (4K ProRes 4444). */
  renderPass: 1.9 * GIB,
  /** A timeline preview runs the export pipeline for 4 s, so one pass costs the same. */
  previewPass: 1.9 * GIB,
  /** Estimate: one decode feeding three x264 outputs. */
  prepare: 1.5 * GIB,
  /** Estimate: filmstrip, waveform and thumbnail jobs are one decoder at low thread counts. */
  housekeeping: 0.4 * GIB,
  /** Estimate: the sound-stem ffmpeg step of an export. */
  soundStem: 0.5 * GIB,
  /** Estimate: a stream-copy join. Under the instant limit, so it is never held. */
  joinCopy: 0.2 * GIB,
  /** Estimates for the Python workers: their ffmpeg children were seen at 0.4-2.1 GiB, plus the interpreter and libraries. */
  flow: 3 * GIB,
  stabilize: 3 * GIB,
  tracker: 2 * GIB,
  /** RAM only: depth needs 2.7 GiB of VRAM as well (measured 2.68 peak), which this guard does not manage. */
  depth: 4 * GIB,
  /** Estimate: the resident SAM2 worker takes 3-5 GiB. */
  smartMask: 5 * GIB,
  /** Estimate: Whisper transcription. */
  captions: 4 * GIB,
} as const;

// ---- measurement ----

export type Sample = { availableBytes: number; commitHeadroomBytes: number | null };

/** The real wall is the smaller of free physical memory and what Windows can still promise (commit headroom). */
export const measureBytes = (sample: Sample): number =>
  sample.commitHeadroomBytes === null ? sample.availableBytes : Math.min(sample.availableBytes, sample.commitHeadroomBytes);

const COMMIT_REFRESH_MS = 5_000;
const COMMIT_MAX_AGE_MS = 30_000;
const COMMIT_TIMEOUT_MS = 4_000;
// A read that failed or timed out (a thrashing host is exactly when PowerShell starts slowly) waits this long before the
// next one, doubling for each failure in a row up to the cap, so a struggling machine is not handed a new powershell.exe
// every few seconds.
const COMMIT_RETRY_AFTER_FAILURE_MS = 30_000;
const COMMIT_RETRY_MAX_MS = 120_000;
// Win32_OperatingSystem: TotalVirtualMemorySize is the commit limit (RAM plus pagefile), FreeVirtualMemory what is
// left of it; both in kilobytes. CIM is used rather than typeperf because counter names are translated per language.
// No double quotes in the script: they would have to survive Windows argument quoting on the way into powershell.exe.
const COMMIT_SCRIPT = "$o = Get-CimInstance Win32_OperatingSystem; ($o.TotalVirtualMemorySize, $o.FreeVirtualMemory) -join ' '";

export const powershellCommand = () => process.env.FRAME_LINE_POWERSHELL || 'powershell.exe';

const execFileAsync = promisify(execFile);
/** Runs a small read-only program and returns its stdout. Rejects on timeout or failure; callers read that as "unknown". */
export async function readCommand(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' });
  return stdout;
}

export function parseCommitHeadroom(text: string): number | null {
  const [total, free] = text.trim().split(/\s+/).map(Number);
  if (total === undefined || free === undefined || !Number.isFinite(total) || !Number.isFinite(free)) return null;
  return total > 0 && free >= 0 && free <= total ? free * 1024 : null;
}

export const readWindowsCommitHeadroom = async (): Promise<number | null> =>
  parseCommitHeadroom(await readCommand(powershellCommand(), ['-NoProfile', '-NonInteractive', '-Command', COMMIT_SCRIPT], COMMIT_TIMEOUT_MS));

export type MemorySamplerOptions = {
  freemem?: () => number;
  /** Async commit-headroom read, in bytes. Defaults to the PowerShell/CIM read on Windows and nothing elsewhere. */
  readCommit?: () => Promise<number | null>;
  platform?: NodeJS.Platform;
  now?: () => number;
  refreshMs?: number;
  maxAgeMs?: number;
  /** False while nobody wants commit readings (guard mode off): no read is started. Defaults to always on. */
  enabled?: () => boolean;
};

/**
 * `sample()` is synchronous and cheap: os.freemem() plus the last finished commit read. A read is started in the
 * background at most every `refreshMs`, only when somebody asks and `enabled()` says so, so an idle server never launches
 * PowerShell (the 30 s health log asks, so "idle" means mode off). A read older than `maxAgeMs`, or one that failed,
 * counts as unknown and the guard falls back to available memory; failures back off (see COMMIT_RETRY_AFTER_FAILURE_MS).
 */
export function createMemorySampler(options: MemorySamplerOptions = {}) {
  const now = options.now ?? (() => performance.now());
  const available = options.freemem ?? freemem;
  const readCommit = options.readCommit ?? ((options.platform ?? process.platform) === 'win32' ? readWindowsCommitHeadroom : null);
  const refreshMs = options.refreshMs ?? COMMIT_REFRESH_MS, maxAgeMs = options.maxAgeMs ?? COMMIT_MAX_AGE_MS;
  const enabled = options.enabled ?? (() => true);
  let cached: { value: number | null; at: number } = { value: null, at: -Infinity };
  let lastTry = -Infinity, gapMs = refreshMs, failures = 0, reading = false, flight: Promise<void> = Promise.resolve();
  const finish = (value: number | null) => {
    failures = value === null ? failures + 1 : 0;
    gapMs = failures === 0 ? refreshMs : Math.min(COMMIT_RETRY_AFTER_FAILURE_MS * 2 ** (failures - 1), COMMIT_RETRY_MAX_MS);
    if (failures > 0) lastTry = now();
    cached = { value, at: now() }; reading = false;
  };
  const refresh = (read: () => Promise<number | null>) => {
    reading = true; lastTry = now();
    // The executor runs `read` at once (a synchronous throw becomes a rejection), so "a read is in flight" is true immediately.
    flight = new Promise<number | null>(resolve => resolve(read())).then(finish, () => finish(null));
  };
  return {
    sample(): Sample {
      const at = now();
      if (readCommit && enabled() && !reading && at - lastTry >= gapMs) refresh(readCommit);
      const fresh = cached.value !== null && at - cached.at <= maxAgeMs;
      return { availableBytes: available(), commitHeadroomBytes: fresh ? cached.value : null };
    },
    /** Resolves when the read in flight (if any) has finished. For tests. */
    whenIdle: () => flight,
  };
}

// ---- modes ----

// Observe is the default everywhere. macOS in particular must stay there until calibrated, because os.freemem()
// under-reports free memory on darwin (cached pages are not counted), so enforcing would be far too strict.
const DEFAULT_MODE: GuardMode = 'observe';
const MODES: readonly GuardMode[] = ['off', 'observe', 'enforce'];

export function parseMode(text: unknown): GuardMode | null {
  if (typeof text !== 'string') return null;
  const word = text.replace(/^﻿/, '').trim().toLowerCase();
  if (word === 'on') return 'enforce';
  return MODES.find(mode => mode === word) ?? null;
}

/**
 * What a switch file says. Editors write UTF-8, with or without a byte order mark; Windows PowerShell 5 (`echo`, `>`,
 * Out-File) writes UTF-16LE with one. The decoder swallows a leading byte order mark; NULs are dropped so a UTF-16 file
 * with no mark still reads as its plain letters.
 */
export function decodeModeFile(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes).replace(/\0/g, '');
}

/** The switch file wins; the environment is the default when the file is absent or unreadable. */
export const resolveMode = (fileText: string | null, envText: string | undefined): GuardMode =>
  parseMode(fileText) ?? parseMode(envText) ?? DEFAULT_MODE;

// ---- pure admission decisions ----

export type Ticket = { id: number; kind: JobClass; costBytes: number; queuedAt: number };
export type Running = { id: number; kind: JobClass; costBytes: number; startedAt: number };
export type DecideState = { measuredBytes: number; now: number; running: readonly Running[]; waiting: readonly Ticket[] };

const rank = (kind: JobClass) => JOB_CLASSES.indexOf(kind);
const byPriority = (a: Ticket, b: Ticket) => rank(a.kind) - rank(b.kind) || a.queuedAt - b.queuedAt || a.id - b.id;
const requiredHeadroom = (policy: Policy, kind: JobClass) => Math.max(policy.reserveBytes[kind], policy.floorBytes);

/** Memory promised to jobs that started recently; their real use has not reached the measurement yet. */
export const rampBytes = (policy: Policy, running: readonly Running[], now: number): number =>
  running.reduce((sum, job) => (now - job.startedAt < policy.rampMs ? sum + job.costBytes : sum), 0);

/** True when the job would leave at least its class reserve (and so the floor) after memory already promised. */
export const fitsNow = (policy: Policy, measuredBytes: number, promisedBytes: number, job: Pick<Ticket, 'kind' | 'costBytes'>): boolean =>
  measuredBytes - promisedBytes - job.costBytes >= requiredHeadroom(policy, job.kind);

function leastRequirement(waiting: readonly Ticket[]): Ticket | undefined {
  return [...waiting].sort(byPriority).reduce<Ticket | undefined>((best, job) => (best === undefined || job.costBytes < best.costBytes ? job : best), undefined);
}

/**
 * Which waiting jobs start now, as ids in start order. Walks the queue in strict priority order and starts every job
 * that fits, so a small job behind a big one that cannot fit still runs (backfill). Once the biggest blocked job has
 * waited `reservationAfterMs` it earns a reservation: later jobs must leave room for it as well. When nothing of ours
 * is running, the held job (or else the one with the least requirement) runs even without its full reserve, but never
 * under the hard floor.
 */
export function decide(policy: Policy, state: DecideState): number[] {
  const { measuredBytes, now, running, waiting } = state;
  let ledger = rampBytes(policy, running, now);
  let held: Ticket | null = null;
  const start: Ticket[] = [];
  for (const job of [...waiting].sort(byPriority)) {
    if (fitsNow(policy, measuredBytes, ledger + (held?.costBytes ?? 0), job)) { start.push(job); ledger += job.costBytes; }
    else if (held === null && now - job.queuedAt >= policy.reservationAfterMs) held = job;
  }
  if (!start.length && !running.length) {
    const pick = held ?? leastRequirement(waiting);
    if (pick && measuredBytes - pick.costBytes >= policy.floorBytes) start.push(pick);
  }
  return start.map(job => job.id);
}

/**
 * How many parallel passes an export may use: as many as fit above the export reserve, between 1 and `maxPasses`.
 * Each pass still asks for admission, so one pass is never refused outright here.
 */
export function passesFor(policy: Policy, availableBytes: number, maxPasses: number, passCost: number): number {
  const ceiling = Math.max(1, Math.floor(maxPasses));
  if (!Number.isFinite(passCost) || passCost <= 0) return ceiling;
  const fit = Math.floor((availableBytes - policy.reserveBytes.export) / passCost);
  return Math.min(ceiling, Math.max(1, Number.isFinite(fit) ? fit : 1));
}

/** The text a waiting job shows. */
export function waitingStatus(waitedMs: number): string {
  const minutes = Math.floor(waitedMs / 60_000);
  return minutes >= 1 ? `Waiting for memory, ${minutes} min` : 'Waiting for memory';
}

// ---- pressure watchdog ----

/** The only work the watchdog may stop, cheapest first. Exports, AI jobs and uploads are never victims. */
export const VICTIM_ORDER = ['preview', 'filmstrip', 'waveform'] as const;
export type VictimKind = typeof VICTIM_ORDER[number];
export type VictimRef = { id: number; kind: VictimKind; startedAt: number };
export type WatchdogState = { readonly lowSince: number | null; readonly lastActionAt: number | null };
export type WatchdogResult = {
  state: WatchdogState;
  /** Ids to abort now: every victim of the first tier that has any. */
  abort: readonly number[];
  tier: VictimKind | null;
  /** Memory has been under the line for at least `pressureMs`. */
  sustained: boolean;
  /** An action (possibly report-only) was taken this step, so the cooldown started. */
  acted: boolean;
};

export function watchdogStep(policy: Policy, state: WatchdogState, measuredBytes: number, now: number, victims: readonly VictimRef[]): WatchdogResult {
  const idle = (next: WatchdogState, sustained: boolean): WatchdogResult => ({ state: next, abort: [], tier: null, sustained, acted: false });
  if (measuredBytes >= policy.pressureBytes) return idle({ ...state, lowSince: null }, false);
  const lowSince = state.lowSince ?? now;
  const next = { ...state, lowSince };
  if (now - lowSince < policy.pressureMs) return idle(next, false);
  if (state.lastActionAt !== null && now - state.lastActionAt < policy.cooldownMs) return idle(next, true);
  const tier = VICTIM_ORDER.find(kind => victims.some(victim => victim.kind === kind)) ?? null;
  const abort = tier === null ? [] : victims.filter(victim => victim.kind === tier).map(victim => victim.id);
  return { state: { lowSince, lastActionAt: now }, abort, tier, sustained: true, acted: true };
}

// ---- runtime ----

export type Release = () => void;
type StatusCallback = (text: string | null) => void;
export type AdmitRequest = {
  kind: JobClass;
  costBytes: number;
  /** Shown in logs. */
  label?: string;
  /** Aborting a wait removes the job from the queue and rejects with "Cancelled." */
  signal?: AbortSignal;
  /** Called with 'Waiting for memory' (and minutes) while held, 'Low memory' while pressure is critical, null when clear. */
  onStatus?: StatusCallback;
};
export type TryAdmit = { ok: true; release: Release } | { ok: false; reason: string; retryAfterMs: number };
export type HostGuardOptions = {
  sample?: () => Sample;
  now?: () => number;
  /** Switch file holding off, observe or enforce; read about once a second so the mode changes without a restart. */
  modePath?: string;
  /** Mode when the file is absent. Defaults to FRAME_LINE_HOST_GUARD. */
  envMode?: string;
  log?: (message: string) => void;
  policy?: Policy;
  /** Commit-headroom reader for the default sampler (ignored when `sample` is given). A test hook; defaults to PowerShell on Windows. */
  readCommit?: MemorySamplerOptions['readCommit'];
};

type Slot = Running & { label: string; startedMeasured: number | null; costChecked: boolean; onStatus?: StatusCallback };
type Waiter = Ticket & { label: string; onStatus?: StatusCallback; shown: string | null; resolve: (release: Release) => void; reject: (error: Error) => void; detach: () => void };
type Victim = VictimRef & { abort: () => void };
type LogBudget = { windowStart: number; used: number; skipped: number };

const MODE_REFRESH_MS = 1_000;
const TICK_MS = 2_000;
const REFUSED_RETRY_MS = 5_000;
const COST_CHECK_AFTER_MS = 20_000;
const LOG_WINDOW_MS = 60_000;
const OBSERVE_LOG_LIMIT = 30;
const CANCELLED = 'Cancelled.';
const WAIT_CAP_MESSAGE = 'The computer stayed short of memory for too long. Try again when it is less busy.';
const LOW_MEMORY_TEXT = 'Low memory';
const NOOP: Release = () => undefined;

const gib = (bytes: number) => (bytes / GIB).toFixed(1);
const round2 = (value: number) => Math.round(value * 100) / 100;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function checkRequest(request: AdmitRequest): void {
  if (!JOB_CLASSES.includes(request.kind)) throw new TypeError(`Unknown job kind: ${String(request.kind)}`);
  if (!Number.isFinite(request.costBytes) || request.costBytes < 0) throw new TypeError(`Invalid job cost: ${String(request.costBytes)}`);
}

export class HostGuard {
  readonly #sample: () => Sample;
  readonly #now: () => number;
  readonly #policy: Policy;
  readonly #modePath: string | undefined;
  readonly #envMode: string | undefined;
  readonly #sink: (message: string) => void;
  #mode: GuardMode;
  #modeReadAt: number;
  #modeErrorShown = false;
  #unrecognisedMode: string | null = null;
  #nextId = 1;
  #running: readonly Slot[] = [];
  #waiting: readonly Waiter[] = [];
  #victims: readonly Victim[] = [];
  #watchdog: WatchdogState = { lowSince: null, lastActionAt: null };
  #lowShown = false;
  #budgets = new Map<string, LogBudget>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HostGuardOptions) {
    // Mode off reads no commit headroom (the sampler asks `#mode`, which tick() keeps fresh), so off launches no PowerShell.
    this.#sample = options.sample ?? createMemorySampler({ readCommit: options.readCommit, enabled: () => this.#mode !== 'off' }).sample;
    this.#now = options.now ?? (() => performance.now());
    this.#policy = options.policy ?? DEFAULT_POLICY;
    this.#modePath = options.modePath;
    this.#envMode = options.envMode ?? process.env.FRAME_LINE_HOST_GUARD;
    this.#sink = options.log ?? (message => console.warn(message));
    this.#modeReadAt = this.#now();
    this.#mode = this.#readMode();
    this.#say(`starting in ${this.#mode} mode`);
  }

  /** Resolves with a release function once the job may start. Cheap jobs and every job outside enforce mode start at once. */
  admit(request: AdmitRequest): Promise<Release> {
    try { checkRequest(request); } catch (error) { return Promise.reject(error); }
    if (request.signal?.aborted) return Promise.reject(new Error(CANCELLED));
    if (request.costBytes <= this.#policy.instantCostBytes) return Promise.resolve(NOOP);
    const mode = this.#currentMode();
    if (mode === 'enforce') return this.#enqueue(request);
    const measured = this.#measure();
    if (mode === 'observe' && measured !== null) this.#reportIfWouldWait(request, measured);
    return Promise.resolve(this.#begin(request, this.#nextId++, measured));
  }

  /** For previews: start now or be refused with a reason. Never queues. */
  tryAdmit(request: AdmitRequest): TryAdmit {
    checkRequest(request);
    if (request.costBytes <= this.#policy.instantCostBytes) return { ok: true, release: NOOP };
    const mode = this.#currentMode(), measured = this.#measure();
    const refusal = mode === 'off' || measured === null ? null : this.#refusal(request, measured);
    if (refusal !== null && mode === 'enforce') return { ok: false, reason: refusal, retryAfterMs: REFUSED_RETRY_MS };
    if (refusal !== null) this.#logLimited('observe-refuse', `observe: ${request.label ?? request.kind} would have been refused. ${refusal}`, OBSERVE_LOG_LIMIT);
    return { ok: true, release: this.#begin(request, this.#nextId++, measured) };
  }

  /** How many parallel passes an export may use right now. Observe and off return the ceiling and only report. */
  passes(maxPasses: number, passCost: number): number {
    const mode = this.#currentMode(), measured = this.#measure();
    if (mode === 'off' || measured === null) return maxPasses;
    const wanted = passesFor(this.#policy, measured, maxPasses, passCost);
    if (mode === 'enforce') return wanted;
    if (wanted < maxPasses) this.#logLimited('observe-passes', `observe: an export would have used ${wanted} of ${maxPasses} passes (${gib(measured)} GiB usable).`, OBSERVE_LOG_LIMIT);
    return maxPasses;
  }

  /** Call every second or two while anything runs (start() does). Admits waiters, enforces the wait cap, runs the watchdog. */
  tick(): void {
    try {
      const mode = this.#currentMode(true);
      if (!this.#running.length && !this.#waiting.length && !this.#victims.length) { this.#watchdog = { ...this.#watchdog, lowSince: null }; return; }
      const now = this.#now(), measured = this.#measure();
      this.#expire(now);
      this.#pump();
      // The pressure response runs in observe too, but only as a log: it blocks (aborts, "Low memory") in enforce alone.
      // The thresholds are not calibrated for blocking yet. On the Dell the commit-headroom reading swings between about 1 and
      // 10 GiB while 10-12 GiB of RAM is free, and on macOS os.freemem() under-reports (cached pages are not counted), so
      // acting on either would stop work on a healthy machine. Read data/host-health.log, then write `enforce` into
      // data/host-guard.mode.
      if (measured !== null && mode !== 'off') { this.#watch(measured, now, mode === 'enforce'); this.#checkCosts(measured, now); }
      this.#refreshStatuses(now);
    } catch (error) { this.#say(`tick failed: ${errorText(error)}`); }
  }

  /** Register work the watchdog may abort under memory pressure. Returns the function that unregisters it. */
  registerVictim(kind: VictimKind, abort: () => void): () => void {
    if (!VICTIM_ORDER.includes(kind)) throw new TypeError(`Unknown victim kind: ${String(kind)}`);
    const id = this.#nextId++;
    this.#victims = [...this.#victims, { id, kind, startedAt: this.#now(), abort }];
    return () => { this.#victims = this.#victims.filter(victim => victim.id !== id); };
  }

  /** The HostHealth fields the guard can supply; the integrator fills the rest from the health log. GB here means GiB. */
  snapshot(): HostHealth {
    const sample = this.sample();
    return {
      at: this.#now(), freeGB: round2(sample.availableBytes / GIB),
      commitHeadroomGB: sample.commitHeadroomBytes === null ? null : round2(sample.commitHeadroomBytes / GIB),
      pagesPerSec: null, queued: this.#waiting.length, running: this.#running.length,
      previewsRunning: this.#running.filter(slot => slot.kind === 'preview').length,
      guardMode: this.#currentMode(), eventLoopLagMs: null, onBattery: null, gpuMemUsedGB: null, gpuTempC: null,
    };
  }

  /** The current reading; also what the health log records. Never throws. */
  sample(): Sample {
    try { return this.#sample(); } catch (error) {
      this.#logLimited('sampler', `memory sampler failed: ${errorText(error)}`);
      return { availableBytes: freemem(), commitHeadroomBytes: null };
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---- internals ----

  #say(message: string): void { try { this.#sink(`Host guard: ${message}`); } catch { /* A broken log sink must not break admission. */ } }

  /** At most `max` lines per key per minute; a later line says how many were dropped. */
  #logLimited(key: string, message: string, max = 1): void {
    const now = this.#now(), entry = this.#budgets.get(key);
    if (!entry || now - entry.windowStart >= LOG_WINDOW_MS) {
      if (entry?.skipped) this.#say(`${entry.skipped} more '${key}' message(s) were left out in the last minute`);
      this.#budgets.set(key, { windowStart: now, used: 1, skipped: 0 });
      this.#say(message);
    } else if (entry.used < max) {
      this.#budgets.set(key, { ...entry, used: entry.used + 1 });
      this.#say(message);
    } else this.#budgets.set(key, { ...entry, skipped: entry.skipped + 1 });
  }

  #readModeFile(): string | null {
    if (!this.#modePath) return null;
    try { const text = decodeModeFile(readFileSync(this.#modePath)); this.#modeErrorShown = false; return text; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !this.#modeErrorShown) { this.#modeErrorShown = true; this.#say(`cannot read ${this.#modePath}: ${errorText(error)}`); }
      return null;
    }
  }

  /** A file that exists but says something other than a mode is ignored; this says so once per distinct text. An empty file (caught mid-write) is not news. */
  #noteUnrecognised(fileText: string | null): void {
    const word = fileText?.trim() ?? '';
    const bad = word !== '' && parseMode(word) === null ? word.slice(0, 40) : null;
    if (bad !== null && bad !== this.#unrecognisedMode) this.#say(`${this.#modePath} holds ${JSON.stringify(bad)}, which is not off, observe or enforce; ignoring it`);
    this.#unrecognisedMode = bad;
  }

  #readMode(): GuardMode {
    const fileText = this.#readModeFile();
    this.#noteUnrecognised(fileText);
    return resolveMode(fileText, this.#envMode);
  }

  #currentMode(force = false): GuardMode {
    const now = this.#now();
    if (!force && now - this.#modeReadAt < MODE_REFRESH_MS) return this.#mode;
    this.#modeReadAt = now;
    const next = this.#readMode();
    if (next !== this.#mode) { this.#say(`mode changed from ${this.#mode} to ${next}`); this.#mode = next; }
    return next;
  }

  /** Min of available and commit headroom, or null when it cannot be read (then the guard lets work through). */
  #measure(): number | null {
    const value = measureBytes(this.sample());
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  #describe(measured: number, request: AdmitRequest): string {
    const promised = rampBytes(this.#policy, this.#running, this.#now());
    return `${gib(measured)} GiB usable, ${gib(promised)} GiB promised to jobs just started, the job needs ${gib(request.costBytes)} GiB and ${gib(requiredHeadroom(this.#policy, request.kind))} GiB must stay free afterwards.`;
  }

  #refusal(request: AdmitRequest, measured: number): string | null {
    if (this.#waiting.length) return 'Other jobs are already waiting for memory.';
    const promised = rampBytes(this.#policy, this.#running, this.#now());
    return fitsNow(this.#policy, measured, promised, request) ? null : `Not enough free memory for this job: ${this.#describe(measured, request)}`;
  }

  #reportIfWouldWait(request: AdmitRequest, measured: number): void {
    const now = this.#now();
    const probe: Ticket = { id: 0, kind: request.kind, costBytes: request.costBytes, queuedAt: now };
    if (decide(this.#policy, { measuredBytes: measured, now, running: this.#running, waiting: [probe] }).length) return;
    this.#logLimited('observe-wait', `observe: ${request.label ?? request.kind} (${request.kind}, ${gib(request.costBytes)} GiB) would have waited: ${this.#describe(measured, request)}`, OBSERVE_LOG_LIMIT);
  }

  #begin(job: { kind: JobClass; costBytes: number; label?: string; onStatus?: StatusCallback }, id: number, measured: number | null): Release {
    const slot: Slot = { id, kind: job.kind, costBytes: job.costBytes, startedAt: this.#now(), label: job.label ?? job.kind, startedMeasured: measured, costChecked: false, onStatus: job.onStatus };
    this.#running = [...this.#running, slot];
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running = this.#running.filter(candidate => candidate.id !== id);
      this.#pump();
    };
  }

  #enqueue(request: AdmitRequest): Promise<Release> {
    return new Promise<Release>((resolve, reject) => {
      const id = this.#nextId++;
      const abort = () => { this.#waiting = this.#waiting.filter(waiter => waiter.id !== id); reject(new Error(CANCELLED)); this.#pump(); };
      request.signal?.addEventListener('abort', abort, { once: true });
      const detach = () => request.signal?.removeEventListener('abort', abort);
      const waiter: Waiter = { id, kind: request.kind, costBytes: request.costBytes, queuedAt: this.#now(), label: request.label ?? request.kind, onStatus: request.onStatus, shown: null, resolve, reject, detach };
      this.#waiting = [...this.#waiting, waiter];
      this.#pump();
      this.#refreshStatuses(this.#now());
    });
  }

  #pump(): void {
    if (!this.#waiting.length) return;
    const now = this.#now(), measured = this.#measure();
    // Outside enforce mode, or with no reading, nobody waits: the guard is an optimisation, never a reason to hang.
    const ids = this.#mode === 'enforce' && measured !== null
      ? decide(this.#policy, { measuredBytes: measured, now, running: this.#running, waiting: this.#waiting })
      : this.#waiting.map(waiter => waiter.id);
    for (const id of ids) this.#admitWaiter(id, measured);
  }

  #admitWaiter(id: number, measured: number | null): void {
    const waiter = this.#waiting.find(candidate => candidate.id === id);
    if (!waiter) return;
    this.#waiting = this.#waiting.filter(candidate => candidate.id !== id);
    waiter.detach();
    const release = this.#begin(waiter, id, measured);
    if (waiter.shown !== null) this.#callStatus(waiter.onStatus, null);
    waiter.resolve(release);
  }

  #callStatus(callback: StatusCallback | undefined, text: string | null): void {
    try { callback?.(text); } catch (error) { this.#logLimited('status', `a status callback failed: ${errorText(error)}`); }
  }

  #refreshStatuses(now: number): void {
    this.#waiting = this.#waiting.map(waiter => {
      const text = waitingStatus(now - waiter.queuedAt);
      if (text === waiter.shown) return waiter;
      this.#callStatus(waiter.onStatus, text);
      return { ...waiter, shown: text };
    });
  }

  #expire(now: number): void {
    const late = this.#waiting.filter(waiter => waiter.kind !== 'export' && now - waiter.queuedAt >= this.#policy.maxWaitMs);
    if (!late.length) return;
    this.#waiting = this.#waiting.filter(waiter => !late.includes(waiter));
    for (const waiter of late) {
      waiter.detach();
      this.#say(`${waiter.label} gave up waiting for memory after ${Math.round((now - waiter.queuedAt) / 60_000)} min`);
      waiter.reject(Object.assign(new Error(WAIT_CAP_MESSAGE), { code: 'HOST_MEMORY_WAIT' }));
    }
  }

  /** The timers always run; outside enforce the result is only logged, and "Low memory" is never shown (or is taken off). */
  #watch(measured: number, now: number, enforcing: boolean): void {
    const refs: VictimRef[] = this.#victims.map(({ id, kind, startedAt }) => ({ id, kind, startedAt }));
    const result = watchdogStep(this.#policy, this.#watchdog, measured, now, refs);
    this.#watchdog = result.state;
    if (result.acted) this.#respond(result, measured, enforcing);
    this.#setLowMemory(enforcing && result.sustained);
  }

  #respond(result: WatchdogResult, measured: number, enforcing: boolean): void {
    const usable = `${gib(measured)} GiB usable`;
    if (result.tier === null) {
      const kinds = [...new Set(this.#running.map(slot => slot.kind))].join(', ') || 'nothing';
      const message = `low memory: ${usable} and nothing safe to stop (running: ${kinds})`;
      if (enforcing) this.#say(message); else this.#logLimited('observe-pressure', `observe: ${message}`, OBSERVE_LOG_LIMIT);
      return;
    }
    const jobs = `${result.abort.length} ${result.tier} job(s)`;
    if (!enforcing) { this.#logLimited('observe-pressure', `observe: would have stopped ${jobs} at ${usable}`, OBSERVE_LOG_LIMIT); return; }
    this.#say(`low memory: ${usable}; stopping ${jobs}`);
    for (const id of result.abort) this.#abortVictim(id);
  }

  #abortVictim(id: number): void {
    const victim = this.#victims.find(candidate => candidate.id === id);
    if (!victim) return;
    this.#victims = this.#victims.filter(candidate => candidate.id !== id);
    try { victim.abort(); } catch (error) { this.#say(`abort of a ${victim.kind} job failed: ${errorText(error)}`); }
  }

  /** Exports and AI jobs are never killed; while pressure lasts they only show 'Low memory'. */
  #setLowMemory(on: boolean): void {
    if (on === this.#lowShown) return;
    this.#lowShown = on;
    for (const slot of this.#running) if (slot.kind === 'export' || slot.kind === 'ai') this.#callStatus(slot.onStatus, on ? LOW_MEMORY_TEXT : null);
  }

  /** Observe mode only: compare each job's estimate with how far the measurement really fell 20 s after it started. */
  #checkCosts(measured: number, now: number): void {
    if (this.#mode !== 'observe') return;
    this.#running = this.#running.map(slot => {
      if (slot.costChecked || slot.startedMeasured === null || now - slot.startedAt < COST_CHECK_AFTER_MS) return slot;
      this.#say(`cost check: ${slot.label} (${slot.kind}) estimated ${gib(slot.costBytes)} GiB; usable memory fell ${gib(slot.startedMeasured - measured)} GiB in ${Math.round((now - slot.startedAt) / 1000)} s (other jobs move this number too)`);
      return { ...slot, costChecked: true };
    });
  }
}

export const createHostGuard = (options: HostGuardOptions = {}): HostGuard => new HostGuard(options);
