import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { HealthLight, HealthSummary, HostHealth, PersonHealth, PlaybackReport } from '../src/services/playbackReportTypes.ts';

/** Per-browser playback reports: validation, traffic lights, plain-language diagnosis, a 30-minute memory store and daily JSONL files.
 *  No timers live here: the server's housekeeping tick calls flushMinute() and prune(). Day files are named by UTC date. */

type WaitMs = PlaybackReport['waitMs'];
type ErrorSink = (message: string, error: unknown) => void;
/** The host numbers the diagnosis looks at. A full HostHealth fits; null means unknown. */
export type HostInfo = Partial<Pick<HostHealth, 'freeGB' | 'commitHeadroomGB' | 'queued' | 'eventLoopLagMs'>> | null;
export type Identity = { userId: string; name: string; clientId: string; projectId: string | null };
export type HistoryRow = PersonHealth['recent'][number] & { clientId: string; projectId: string | null; harness: boolean; playheadMin: number };
type Bucket = { minute: number; windowMs: number; playingMs: number; fpsMs: number; loadMs: number; worstFreezeMs: number; anyPlaying: boolean; waitMs: WaitMs; last: PlaybackReport };
type MinuteRow = { t: number; userId: string; clientId: string; projectId: string | null; report: PlaybackReport };
type Entry = Identity & { lastSeenAt: number; latest: PlaybackReport; bucket: Bucket | null; rows: MinuteRow[] };

// Store limits.
const MINUTE_MS = 60_000, DAY_MS = 86_400_000;
const RECENT_MINUTES = 30, RECENT_MS = RECENT_MINUTES * MINUTE_MS;
const FRESH_MS = 30_000, MIN_REPORT_GAP_MS = 2_000, MAX_BROWSERS = 64, MAX_BROWSERS_PER_USER = 8, MAX_PENDING_ROWS = 5_000, RETENTION_DAYS = 14;
const MAX_ID_CHARS = 80, MAX_NAME_CHARS = 80, MAX_PROJECT_CHARS = 160;
// Validation ranges.
const MAX_MS = 3_600_000, MAX_FPS = 240, MAX_RTT_MS = 60_000, MAX_MBPS = 100_000, MAX_CORES = 1024, MAX_MEMORY_GB = 4096, MAX_PLAYHEAD_MIN = 100_000;
// Traffic-light starting rules (retune against stored history; lights are computed on read).
const GREEN_FPS_PCT = 93, RED_FPS_PCT = 60, GREEN_LOADING_PCT = 5, RED_LOADING_PCT = 25, GREEN_FREEZE_MS = 400, RED_FREEZE_MS = 2500;
// Diagnosis thresholds.
const DOMINANT_SHARE = 0.5, LONG_TASK_SHARE = 0.2, LOW_LINK_MBPS = 15, HIGH_RTT_MS = 400;
const SLOW_NET_TYPES: readonly string[] = ['slow-2g', '2g', '3g'];
const HOST_LOW_FREE_GB = 3, HOST_LOW_COMMIT_GB = 3, HOST_BUSY_QUEUED = 6, HOST_BUSY_LAG_MS = 200;

const WAIT_LABELS: Record<keyof WaitMs, string> = { color: 'colour processing', decode: 'video decoding', buffer: 'the download', seek: 'frame seeking', other: 'other work' };
const WAIT_KEYS = Object.keys(WAIT_LABELS) as (keyof WaitMs)[];
const SOURCES: readonly PlaybackReport['source'][] = ['live', 'stream', 'low', 'rendered'];
const LIGHT_ORDER: Record<HealthLight, number> = { red: 0, amber: 1, green: 2, grey: 3 };
const NO_REPORT = 'No playback report yet: the page may need a reload';
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// ---------------------------------------------------------------- validation

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown, min: number, max: number): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
const whole = (value: unknown, min: number, max: number): number | undefined => { const n = num(value, min, max); return n === undefined ? undefined : Math.round(n); };
const nullable = <T>(value: unknown, read: (value: unknown) => T | undefined): T | null | undefined => value === null || value === undefined ? null : read(value);
const flag = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ').trim().slice(0, max).trimEnd() : undefined;

function readWait(value: unknown): WaitMs | undefined {
  if (!isRecord(value)) return undefined;
  const parts = WAIT_KEYS.map(key => num(value[key], 0, MAX_MS));
  if (parts.some(part => part === undefined)) return undefined;
  const [color, decode, buffer, seek, other] = parts as number[];
  return { color, decode, buffer, seek, other };
}

/** Builds a clean report from untrusted input, or null. Unknown fields are dropped, numbers clamped, strings trimmed; never throws. */
export function validate(block: unknown): PlaybackReport | null {
  try {
    if (!isRecord(block) || block.v !== 1) return null;
    const fields = {
      v: 1 as const, build: text(block.build, 16), at: num(block.at, 0, Number.MAX_SAFE_INTEGER), windowMs: num(block.windowMs, 0, MAX_MS),
      playing: flag(block.playing), targetFps: num(block.targetFps, 1, MAX_FPS), fps: num(block.fps, 0, MAX_FPS),
      loadingPct: num(block.loadingPct, 0, 100), worstFreezeMs: num(block.worstFreezeMs, 0, MAX_MS), waitMs: readWait(block.waitMs),
      linkMbps: nullable(block.linkMbps, v => num(v, 0, MAX_MBPS)), rttMs: nullable(block.rttMs, v => num(v, 0, MAX_RTT_MS)),
      netType: nullable(block.netType, v => text(v, 12)), downlinkMbps: nullable(block.downlinkMbps, v => num(v, 0, MAX_MBPS)),
      saveData: flag(block.saveData), cores: nullable(block.cores, v => whole(v, 0, MAX_CORES)), memoryGB: nullable(block.memoryGB, v => num(v, 0, MAX_MEMORY_GB)),
      gpu: text(block.gpu, 60), agent: text(block.agent, 40), longTaskMs: nullable(block.longTaskMs, v => num(v, 0, MAX_MS)),
      quality: text(block.quality, 12), engine: text(block.engine, 12), source: SOURCES.find(source => source === block.source),
      playheadMin: whole(block.playheadMin, 0, MAX_PLAYHEAD_MIN), cachedPct: nullable(block.cachedPct, v => num(v, 0, 100)),
      harness: flag(block.harness), onHost: flag(block.onHost),
    };
    return Object.values(fields).includes(undefined) ? null : (fields as PlaybackReport);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- light and diagnosis

/** Green, amber or red from the plan's starting rules; grey when nothing is playing. */
export function classify(report: PlaybackReport): HealthLight {
  if (!report.playing) return 'grey';
  const rate = report.fps * 100; // compared as percent of target without dividing, so the 93% and 60% lines stay exact
  if (rate < report.targetFps * RED_FPS_PCT || report.loadingPct > RED_LOADING_PCT || report.worstFreezeMs > RED_FREEZE_MS) return 'red';
  if (rate >= report.targetFps * GREEN_FPS_PCT && report.loadingPct < GREEN_LOADING_PCT && report.worstFreezeMs <= GREEN_FREEZE_MS) return 'green';
  return 'amber';
}

const shown = (n: number) => String(Math.round(n * 10) / 10);
const waitTotal = (wait: WaitMs) => WAIT_KEYS.reduce((sum, key) => sum + wait[key], 0);
const sumWait = (a: WaitMs, b: WaitMs): WaitMs => ({ color: a.color + b.color, decode: a.decode + b.decode, buffer: a.buffer + b.buffer, seek: a.seek + b.seek, other: a.other + b.other });

/** What the host is short of, in words, or null when it looks fine. */
function hostStrain(host: HostInfo): string | null {
  if (!host) return null;
  const { freeGB, commitHeadroomGB, queued, eventLoopLagMs } = host;
  if (freeGB != null && freeGB < HOST_LOW_FREE_GB) return `server has ${shown(freeGB)} GB memory free`;
  if (commitHeadroomGB != null && commitHeadroomGB < HOST_LOW_COMMIT_GB) return `server has ${shown(commitHeadroomGB)} GB memory headroom`;
  if (queued != null && queued >= HOST_BUSY_QUEUED) return `${queued} jobs queued on the server`;
  if (eventLoopLagMs != null && eventLoopLagMs > HOST_BUSY_LAG_MS) return 'server responding slowly';
  return null;
}

/** The browser's own evidence of a slow connection, in words, or null. */
function linkEvidence(report: PlaybackReport): string | null {
  if (report.linkMbps != null && report.linkMbps < LOW_LINK_MBPS) return `link ${shown(report.linkMbps)} Mbps`;
  if (report.netType && SLOW_NET_TYPES.includes(report.netType)) return `${report.netType} connection`;
  if (report.rttMs != null && report.rttMs > HIGH_RTT_MS) return `${shown(report.rttMs)} ms round trip`;
  return null;
}

function causeOf(report: PlaybackReport, host: HostInfo): { label: string; note: string | null } {
  const wait = report.waitMs, total = waitTotal(wait);
  const share = (ms: number) => total > 0 ? ms / total : 0;
  const busyThread = report.longTaskMs != null && report.windowMs > 0 && report.longTaskMs / report.windowMs >= LONG_TASK_SHARE;
  const computerBound = share(wait.color + wait.decode) >= DOMINANT_SHARE || busyThread;
  const downloadBound = share(wait.buffer + wait.seek) >= DOMINANT_SHARE;
  const slowLink = linkEvidence(report), strain = hostStrain(host);
  const mixed = { label: 'Mixed causes', note: null };
  if (downloadBound || (!computerBound && slowLink)) {
    if (strain) return { label: 'Server busy', note: strain };
    return slowLink ? { label: 'Connection too slow', note: slowLink } : mixed;
  }
  if (computerBound) return { label: 'Computer too slow', note: null };
  return strain ? { label: 'Server busy', note: strain } : mixed;
}

function waitingPart(report: PlaybackReport): string {
  const pct = Math.round(report.loadingPct);
  if (pct < 1) return '';
  if (waitTotal(report.waitMs) <= 0) return `, ${pct}% waiting`;
  const [biggest] = [...WAIT_KEYS].sort((a, b) => report.waitMs[b] - report.waitMs[a]);
  return `, ${pct}% waiting on ${WAIT_LABELS[biggest]}`;
}

/** One plain sentence about how playback went and, if badly, whose side the trouble is on. */
export function diagnose(report: PlaybackReport, host: HostInfo): string {
  if (!report.playing) return 'Not playing';
  const rate = `${Math.round(report.fps)} of ${Math.round(report.targetFps)} pictures/s`;
  if (classify(report) === 'green') return `Smooth: ${rate}`;
  const { label, note } = causeOf(report, host);
  return [`${label}: ${rate}${waitingPart(report)}`, note].filter(Boolean).join(', ');
}

/** FRAME_LINE_HEALTH_USERS: comma-separated account ids. Unset or empty means nobody. */
export function canSeeHealth(userId: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const allowed = (env.FRAME_LINE_HEALTH_USERS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  return userId !== undefined && allowed.includes(userId);
}

// ---------------------------------------------------------------- minute rollup

const minuteOf = (t: number) => Math.floor(t / MINUTE_MS);
const dayName = (t: number) => `${new Date(t).toISOString().slice(0, 10)}.jsonl`;
const keyOf = (who: Identity, harness: boolean) => [who.userId, who.clientId, harness ? 'test' : 'person'].join('\u0000');
const pairOf = (who: Identity) => `${who.userId}\u0000${who.clientId}`;

function addToBucket(previous: Bucket | null, report: PlaybackReport, minute: number): Bucket {
  // A stopped report still counts when it carries play time: the page sends its last partial window after playback ends.
  const weight = Math.max(report.windowMs, report.playing ? 1 : 0);
  const before = previous ?? { minute, windowMs: 0, playingMs: 0, fpsMs: 0, loadMs: 0, worstFreezeMs: 0, anyPlaying: false, waitMs: { color: 0, decode: 0, buffer: 0, seek: 0, other: 0 }, last: report };
  return {
    minute, last: report, windowMs: before.windowMs + report.windowMs, playingMs: before.playingMs + weight,
    fpsMs: before.fpsMs + report.fps * weight, loadMs: before.loadMs + report.loadingPct * weight,
    worstFreezeMs: Math.max(before.worstFreezeMs, report.worstFreezeMs), anyPlaying: before.anyPlaying || report.playing || report.windowMs > 0,
    waitMs: sumWait(before.waitMs, report.waitMs),
  };
}

/** One merged report for the minute: pictures/s and loading are averaged over play time, the worst freeze is the maximum, waits are summed. */
function rowOf(entry: Identity, bucket: Bucket): MinuteRow {
  const average = (sum: number) => bucket.playingMs > 0 ? Math.round((sum / bucket.playingMs) * 10) / 10 : 0;
  const report: PlaybackReport = {
    ...bucket.last, playing: bucket.anyPlaying, windowMs: Math.min(bucket.windowMs, MAX_MS), fps: average(bucket.fpsMs),
    loadingPct: average(bucket.loadMs), worstFreezeMs: bucket.worstFreezeMs, waitMs: bucket.waitMs,
  };
  return { t: bucket.minute * MINUTE_MS, userId: entry.userId, clientId: entry.clientId, projectId: entry.projectId, report };
}

const keepRecent = (rows: readonly MinuteRow[], minute: number) => rows.filter(row => row.t > (minute - RECENT_MINUTES) * MINUTE_MS);

/** Moves the open minute into the finished rows when the clock has moved on from it. */
function settle(entry: Entry, minute: number): { entry: Entry; closed: MinuteRow | null } {
  if (!entry.bucket || entry.bucket.minute === minute) return { entry, closed: null };
  const closed = rowOf(entry, entry.bucket);
  return { entry: { ...entry, bucket: null, rows: keepRecent([...entry.rows, closed], minute) }, closed };
}

function historyRow(row: MinuteRow): HistoryRow {
  const { fps, loadingPct, worstFreezeMs, playheadMin, harness } = row.report;
  return { at: row.t, fps, loadingPct, worstFreezeMs, light: classify(row.report), clientId: row.clientId, projectId: row.projectId, harness, playheadMin };
}

function recentOf(entry: Entry, now: number): PersonHealth['recent'] {
  const open = entry.bucket ? [rowOf(entry, entry.bucket)] : [];
  return keepRecent([...entry.rows, ...open], minuteOf(now)).slice(-RECENT_MINUTES).map(row => {
    const { at, fps, loadingPct, worstFreezeMs, light } = historyRow(row);
    return { at, fps, loadingPct, worstFreezeMs, light };
  });
}

// ---------------------------------------------------------------- daily files

function parseRow(line: string): MinuteRow[] {
  if (!line.trim()) return [];
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.t !== 'number' || !Number.isFinite(value.t) || typeof value.userId !== 'string' || typeof value.clientId !== 'string') return [];
    const report = validate(value.report);
    if (!report) return [];
    return [{ t: value.t, userId: value.userId, clientId: value.clientId, projectId: typeof value.projectId === 'string' ? value.projectId : null, report }];
  } catch {
    return []; // a line cut short by a hard kill is skipped on purpose; the rest of the day still reads
  }
}

function groupByDay(rows: readonly MinuteRow[]): Map<string, MinuteRow[]> {
  const days = new Map<string, MinuteRow[]>();
  for (const row of rows) days.set(dayName(row.t), [...(days.get(dayName(row.t)) ?? []), row]);
  return days;
}

const isMissing = (error: unknown) => (error as { code?: string } | null)?.code === 'ENOENT';

function createDayFiles(dir: string, onError: ErrorSink) {
  const list = async (): Promise<string[]> => {
    try { return (await readdir(dir)).filter(name => DAY_FILE.test(name)).sort(); }
    catch (error) { if (!isMissing(error)) onError('Playback reports: could not list the report folder.', error); return []; }
  };
  const readDay = async (name: string): Promise<MinuteRow[]> => {
    try { return (await readFile(join(dir, name), 'utf8')).split('\n').flatMap(parseRow); }
    catch (error) { if (!isMissing(error)) onError(`Playback reports: could not read ${name}.`, error); return []; }
  };
  return {
    /** Appends rows to their day's file and returns the rows that could not be written. */
    async append(rows: readonly MinuteRow[]): Promise<MinuteRow[]> {
      const failed: MinuteRow[] = [];
      for (const [name, group] of groupByDay(rows)) {
        try {
          await mkdir(dir, { recursive: true });
          // The leading newline ends any half-written last line a hard kill left, so new rows never glue onto it.
          await appendFile(join(dir, name), `\n${group.map(row => JSON.stringify(row)).join('\n')}`);
        } catch (error) { onError(`Playback reports: could not write ${name}.`, error); failed.push(...group); }
      }
      return failed;
    },
    async read(userId: string, sinceMs: number): Promise<MinuteRow[]> {
      const since = Number.isFinite(sinceMs) ? Math.min(Math.max(sinceMs, 0), 8.64e15) : 0;
      const names = (await list()).filter(name => name >= dayName(since));
      const days = await Promise.all(names.map(readDay));
      return days.flat().filter(row => row.userId === userId && row.t >= since).sort((a, b) => a.t - b.t);
    },
    async prune(now: number): Promise<void> {
      const oldest = dayName(now - RETENTION_DAYS * DAY_MS);
      for (const name of (await list()).filter(file => file < oldest)) {
        try { await rm(join(dir, name), { force: true }); }
        catch (error) { onError(`Playback reports: could not delete ${name}.`, error); }
      }
    },
  };
}

// ---------------------------------------------------------------- the store

function cleanIdentity(who: Identity): Identity | null {
  const userId = text(who.userId, MAX_ID_CHARS) ?? '', clientId = text(who.clientId, MAX_ID_CHARS) ?? '';
  if (!userId || !clientId) return null;
  return { userId, clientId, name: text(who.name, MAX_NAME_CHARS) ?? '', projectId: text(who.projectId, MAX_PROJECT_CHARS) || null };
}

function stateOf(entry: Entry, age: number, online: boolean, host: HostInfo): { light: HealthLight; sentence: string } {
  if (!online) return { light: 'grey', sentence: `Offline, last report ${age < 120_000 ? `${Math.round(age / 1000)} s` : `${Math.round(age / MINUTE_MS)} min`} ago` };
  if (!entry.latest.playing) return { light: 'grey', sentence: 'Not playing' };
  if (age > FRESH_MS) return { light: 'grey', sentence: 'Playback report has stopped arriving' };
  return { light: classify(entry.latest), sentence: diagnose(entry.latest, host) };
}

function personOf(entry: Entry, now: number, host: HostInfo, present: boolean): PersonHealth {
  const age = Math.max(0, now - entry.lastSeenAt), online = age <= FRESH_MS || present;
  const { light, sentence } = stateOf(entry, age, online, host);
  const harness = entry.latest.harness;
  return {
    userId: entry.userId, name: entry.name, clientId: entry.clientId, projectId: entry.projectId, online, lastSeenAt: entry.lastSeenAt,
    light, sentence: harness ? `[Test run] ${sentence}` : sentence, latest: entry.latest, recent: recentOf(entry, now), harness,
  };
}

const byUrgency = (a: PersonHealth, b: PersonHealth) =>
  Number(a.harness) - Number(b.harness) || LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light] || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name);

export type SummaryArgs = { now: number; host: HostHealth; onlineIdentities?: readonly Identity[] };
export type PlaybackReportsOptions = { dir: string; onError?: ErrorSink };
/** The in-memory state: one entry per browser, and finished minutes waiting for the next flush. */
type Store = { entries: Map<string, Entry>; pending: MinuteRow[] };

/** Finished minutes wait here for the next flush; a flood that outruns it loses the oldest rows, not the disk. */
function queueRow(store: Store, row: MinuteRow): void {
  store.pending = [...store.pending, row].slice(-MAX_PENDING_ROWS);
}

/** Drops a browser, keeping its open minute for the next flush. */
function evict(store: Store, key: string, entry: Entry): void {
  const { closed } = settle(entry, -1);
  if (closed) queueRow(store, closed);
  store.entries.delete(key);
}

function dropOverflow(store: Store): void {
  while (store.entries.size > MAX_BROWSERS) {
    const [oldest] = [...store.entries].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    evict(store, oldest[0], oldest[1]);
  }
}

function ingestReport(store: Store, identity: Identity, block: unknown, now: number): boolean {
  const report = validate(block), who = cleanIdentity(identity);
  if (!report || !who || !Number.isFinite(now)) return false;
  const key = keyOf(who, report.harness), previous = store.entries.get(key);
  const gap = previous ? now - previous.lastSeenAt : Infinity;
  if (gap >= 0 && gap < MIN_REPORT_GAP_MS) return false;
  // The browser id is the browser's own choice: without this cap one account could crowd everyone else out of the 64 places.
  if (!previous && [...store.entries.values()].filter(entry => entry.userId === who.userId).length >= MAX_BROWSERS_PER_USER) return false;
  const minute = minuteOf(now);
  const settled = previous ? settle(previous, minute) : null;
  if (settled?.closed) queueRow(store, settled.closed);
  const base = settled?.entry;
  store.entries.set(key, { ...who, lastSeenAt: now, latest: report, bucket: addToBucket(base?.bucket ?? null, report, minute), rows: base?.rows ?? [] });
  if (!previous) dropOverflow(store);
  return true;
}

/** Closes finished minutes and forgets browsers silent for 30 minutes. */
function settleStore(store: Store, now: number): void {
  const minute = minuteOf(now);
  for (const [key, entry] of [...store.entries]) {
    if (now - entry.lastSeenAt > RECENT_MS) { evict(store, key, entry); continue; }
    const { entry: settled, closed } = settle(entry, minute);
    if (closed) queueRow(store, closed);
    store.entries.set(key, settled);
  }
}

function summarize(entries: Iterable<Entry>, { now, host, onlineIdentities = [] }: SummaryArgs): HealthSummary {
  const present = onlineIdentities.map(cleanIdentity).filter((who): who is Identity => who !== null);
  const presentPairs = new Set(present.map(pairOf));
  const live = [...entries].filter(entry => now - entry.lastSeenAt <= RECENT_MS);
  const reported = new Set(live.map(pairOf));
  const people = live.map(entry => personOf(entry, now, host, presentPairs.has(pairOf(entry))));
  const silent = present.filter(who => !reported.has(pairOf(who))).map((who): PersonHealth => (
    { ...who, online: true, lastSeenAt: now, light: 'grey', sentence: NO_REPORT, latest: null, recent: [], harness: false }));
  return { generatedAt: now, host, people: [...people, ...silent].sort(byUrgency) };
}

export function createPlaybackReports({ dir, onError = (message, error) => console.error(message, error) }: PlaybackReportsOptions) {
  const files = createDayFiles(dir, onError);
  const store: Store = { entries: new Map(), pending: [] };
  return {
    /** Stores one browser's report. The server's `now` is the only clock used. False means it was refused. */
    ingest: (identity: Identity, block: unknown, now: number): boolean => ingestReport(store, identity, block, now),

    /** Closes finished minutes, forgets silent browsers and appends the new rows to the day's file. Called about once a minute. */
    async flushMinute(now: number): Promise<void> {
      settleStore(store, now);
      const rows = store.pending;
      store.pending = [];
      if (rows.length === 0) return;
      const failed = await files.append(rows);
      store.pending = [...failed, ...store.pending].slice(-MAX_PENDING_ROWS);
    },

    /** Deletes daily files older than 14 days. Other files in the folder are never touched. */
    prune: files.prune,

    /** One row per browser (present ones with no report too), red first, then amber; harness runs last. */
    summary: (args: SummaryArgs): HealthSummary => summarize(store.entries.values(), args),

    /** Finished minutes for one user from `sinceMs` (an absolute time) on, read from the daily files, oldest first. */
    async history(userId: string, sinceMs: number): Promise<HistoryRow[]> {
      return (await files.read(userId, sinceMs)).map(historyRow);
    },
  };
}
