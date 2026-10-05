import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  DEFAULT_POLICY, GIB, createHostGuard, createMemorySampler, decide, measureBytes, parseCommitHeadroom, parseMode,
  passesFor, rampBytes, resolveMode, waitingStatus, watchdogStep,
  type JobClass, type Running, type Sample, type Ticket, type VictimKind, type WatchdogState,
} from './hostGuard.ts';

const P = DEFAULT_POLICY;
const dir = mkdtempSync(join(tmpdir(), 'frameline-hostguard-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const ticket = (id: number, kind: JobClass, costGiB: number, queuedAt = 0): Ticket => ({ id, kind, costBytes: costGiB * GIB, queuedAt });
const slot = (id: number, kind: JobClass, costGiB: number, startedAt: number): Running => ({ id, kind, costBytes: costGiB * GIB, startedAt });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/** A promise whose settlement can be read without waiting on it. */
function track(promise: Promise<unknown>) {
  const result: { state: 'pending' | 'resolved' | 'rejected'; error?: unknown } = { state: 'pending' };
  promise.then(() => { result.state = 'resolved'; }, error => { result.state = 'rejected'; result.error = error; });
  return result;
}

// ---- measurement ----

test('the measurement is the smaller of available memory and commit headroom, and falls back to available', () => {
  assert.equal(measureBytes({ availableBytes: 10 * GIB, commitHeadroomBytes: 6 * GIB }), 6 * GIB);
  assert.equal(measureBytes({ availableBytes: 4 * GIB, commitHeadroomBytes: 9 * GIB }), 4 * GIB);
  assert.equal(measureBytes({ availableBytes: 7 * GIB, commitHeadroomBytes: null }), 7 * GIB);
});

test('parseCommitHeadroom reads kilobytes and rejects anything that is not two sane numbers', () => {
  assert.equal(parseCommitHeadroom('54000000 10522000\r\n'), 10522000 * 1024);
  for (const bad of ['', 'abc', '5', '100 200', '0 0', '100 -1', 'x y']) assert.equal(parseCommitHeadroom(bad), null, bad);
});

test('memory sampler caches the commit read, reads once at a time, and drops stale or failed reads', async () => {
  let now = 0, reads = 0, fail = false, release!: (value: number | null) => void;
  const sampler = createMemorySampler({
    freemem: () => 8 * GIB, now: () => now, refreshMs: 5000, maxAgeMs: 30_000,
    readCommit: () => { reads++; return fail ? Promise.reject(new Error('cim failed')) : new Promise<number | null>(resolve => { release = resolve; }); },
  });
  assert.deepEqual(sampler.sample(), { availableBytes: 8 * GIB, commitHeadroomBytes: null });
  sampler.sample(); assert.equal(reads, 1, 'a read already in flight is not started twice');
  release(5 * GIB); await sampler.whenIdle();
  assert.equal(sampler.sample().commitHeadroomBytes, 5 * GIB);
  now = 4000; sampler.sample(); assert.equal(reads, 1, 'cached for 5 s');
  now = 6000; fail = true; sampler.sample(); await sampler.whenIdle(); assert.equal(reads, 2);
  assert.equal(sampler.sample().commitHeadroomBytes, null, 'a failed read means unknown, not the old number');
  assert.equal(createMemorySampler({ freemem: () => GIB, now: () => now, platform: 'linux' }).sample().commitHeadroomBytes, null, 'no reader (macOS, Linux): available only');
});

test('a failed or timed-out commit read backs off 30 s, then longer up to a cap, and one good read resets it', async () => {
  let now = 0, reads = 0, fail = true;
  const sampler = createMemorySampler({
    freemem: () => 8 * GIB, now: () => now, refreshMs: 5000, maxAgeMs: 30_000,
    readCommit: () => { reads++; return fail ? Promise.reject(new Error('timed out')) : Promise.resolve(6 * GIB); },
  });
  const askAt = async (at: number) => { now = at; sampler.sample(); await sampler.whenIdle(); return reads; };
  assert.equal(await askAt(0), 1);
  assert.equal(await askAt(29_999), 1, 'no new PowerShell 5 s after a failure');
  assert.equal(await askAt(30_000), 2);
  assert.equal(await askAt(89_999), 2, 'the second failure waits longer');
  assert.equal(await askAt(90_000), 3);
  assert.equal(await askAt(90_000 + 119_999), 3);
  assert.equal(await askAt(90_000 + 120_000), 4, 'a capped gap of 120 s');
  fail = false;
  assert.equal(await askAt(90_000 + 120_000 + 119_999), 4);
  assert.equal(await askAt(90_000 + 240_000), 5);
  assert.equal(sampler.sample().commitHeadroomBytes, 6 * GIB);
  assert.equal(await askAt(90_000 + 245_000), 6, 'after a good read the normal 5 s gap is back');
});

test('the memory sampler starts no commit read while it is switched off', () => {
  let on = false, reads = 0;
  const sampler = createMemorySampler({ freemem: () => 8 * GIB, now: () => 0, readCommit: () => { reads++; return Promise.resolve(5 * GIB); }, enabled: () => on });
  sampler.sample(); assert.equal(reads, 0);
  on = true; sampler.sample(); assert.equal(reads, 1);
});

test('mode off starts no commit read at all, even when the health log asks for a sample', () => {
  let reads = 0;
  const readCommit = () => { reads++; return Promise.resolve(9 * GIB); };
  const make = (envMode: string) => createHostGuard({ readCommit, modePath: join(dir, `mode-reads-${envMode}`), envMode, log: () => undefined });
  const off = make('off'); off.sample(); off.sample();
  assert.equal(reads, 0);
  make('observe').sample();
  assert.equal(reads, 1);
});

// ---- modes ----

test('mode words are parsed forgivingly and the file beats the environment', () => {
  assert.equal(parseMode(' Enforce\r\n'), 'enforce');
  assert.equal(parseMode('﻿observe'), 'observe', 'PowerShell 5 writes a byte order mark');
  assert.equal(parseMode('on'), 'enforce');
  assert.equal(parseMode('banana'), null);
  assert.equal(resolveMode('off', 'enforce'), 'off');
  assert.equal(resolveMode(null, 'enforce'), 'enforce');
  assert.equal(resolveMode('garbage', undefined), 'observe', 'default is observe');
  assert.equal(resolveMode(null, 'garbage'), 'observe');
});

// ---- pure admission decisions ----

test('passesFor gives an export 3 passes at 10.4 GiB available and never fewer than 1', () => {
  assert.equal(passesFor(P, 10.4 * GIB, 4, 1.9 * GIB), 3);
  assert.equal(passesFor(P, 6 * GIB, 4, 1.9 * GIB), 1);
  assert.equal(passesFor(P, 1 * GIB, 4, 1.9 * GIB), 1, 'a pass still needs its own admission, never zero passes');
  assert.equal(passesFor(P, 40 * GIB, 3, 1.9 * GIB), 3, 'capped at the ceiling');
  assert.equal(passesFor(P, 40 * GIB, 2, 1.9 * GIB), 2);
  assert.equal(passesFor(P, 10 * GIB, 3, 0), 3, 'a nonsense cost keeps the ceiling');
});

test('the hard floor holds for every class, with or without running work', () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const kinds: JobClass[] = ['export', 'prepare', 'ai', 'preview', 'other'];
  const pick = () => kinds[Math.floor(random() * kinds.length)]!;
  const now = 100_000;
  for (let round = 0; round < 3000; round++) {
    const measuredBytes = random() * 16 * GIB;
    const running = Array.from({ length: Math.floor(random() * 3) }, (_, index): Running => ({ id: 100 + index, kind: pick(), costBytes: random() * 3 * GIB, startedAt: now - random() * 40_000 }));
    const waiting = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, index): Ticket => ({ id: index, kind: pick(), costBytes: random() * 5 * GIB, queuedAt: now - random() * 60_000 }));
    const start = decide(P, { measuredBytes, now, running, waiting });
    if (!start.length) continue;
    const promised = rampBytes(P, running, now) + waiting.filter(job => start.includes(job.id)).reduce((sum, job) => sum + job.costBytes, 0);
    assert.ok(measuredBytes - promised >= P.floorBytes - 1, `round ${round}: ${measuredBytes / GIB} measured, ${promised / GIB} promised`);
  }
});

test('the ramp ledger stops simultaneous launches that all saw the same free number', () => {
  const waiting = [ticket(1, 'export', 1.9), ticket(2, 'export', 1.9), ticket(3, 'export', 1.9)];
  assert.deepEqual(decide(P, { measuredBytes: 8 * GIB, now: 5000, running: [], waiting }), [1, 2], 'two fit; the third would leave 2.3 GiB');
  // Twenty seconds later the first jobs' memory is in the measurement, so the ledger no longer counts it again.
  const old = [slot(10, 'export', 1.9, 0), slot(11, 'export', 1.9, 0)];
  assert.deepEqual(decide(P, { measuredBytes: 8 * GIB, now: 25_000, running: old, waiting: [ticket(3, 'export', 1.9, 20_000)] }), [3]);
  assert.equal(rampBytes(P, old, 19_999), 3.8 * GIB);
  assert.equal(rampBytes(P, old, 20_000), 0);
});

test('strict priority: a smaller lower-class job does not take the room an export needs', () => {
  const waiting = [ticket(1, 'prepare', 1.5, 0), ticket(2, 'export', 1.9, 10)];
  assert.deepEqual(decide(P, { measuredBytes: 6.5 * GIB, now: 20, running: [], waiting }), [2]);
  assert.deepEqual(decide(P, { measuredBytes: 9 * GIB, now: 20, running: [], waiting }), [2, 1], 'both fit, export first');
});

test('a small job starts past a big one that cannot fit, until the big one has waited 30 s', () => {
  const big = ticket(1, 'ai', 4), small = ticket(2, 'other', 0.4);
  assert.deepEqual(decide(P, { measuredBytes: 7.5 * GIB, now: 10_000, running: [], waiting: [big, small] }), [2], 'backfill');
  const old = [slot(9, 'export', 1, -60_000)];
  assert.deepEqual(decide(P, { measuredBytes: 7.5 * GIB, now: 31_000, running: old, waiting: [big, small] }), [], 'the big job now holds a reservation');
  assert.deepEqual(decide(P, { measuredBytes: 7.5 * GIB, now: 31_000, running: [], waiting: [big, small] }), [1], 'and with nothing running it is the one that gets the progress guarantee');
});

test('with nothing running the job with the least requirement runs, but never under the floor', () => {
  assert.deepEqual(decide(P, { measuredBytes: 7.5 * GIB, now: 0, running: [], waiting: [ticket(1, 'ai', 4)] }), [1]);
  assert.deepEqual(decide(P, { measuredBytes: 6.9 * GIB, now: 0, running: [], waiting: [ticket(1, 'ai', 4)] }), [], 'would leave 2.9 GiB');
  assert.deepEqual(decide(P, { measuredBytes: 7.4 * GIB, now: 0, running: [], waiting: [ticket(1, 'ai', 4.2), ticket(2, 'ai', 4)] }), [2]);
  assert.deepEqual(decide(P, { measuredBytes: 4.5 * GIB, now: 0, running: [slot(1, 'ai', 1, -60_000)], waiting: [ticket(2, 'ai', 1)] }), [], 'the waiver is only for an idle host');
});

// ---- pressure watchdog ----

const victims = (...kinds: VictimKind[]) => kinds.map((kind, index) => ({ id: index + 1, kind, startedAt: index }));
const calm: WatchdogState = { lowSince: null, lastActionAt: null };

test('watchdog waits 5 s under 2 GiB, aborts previews first, then filmstrips, then waveforms, 20 s apart', () => {
  const all = victims('waveform', 'preview', 'filmstrip', 'preview');
  let step = watchdogStep(P, calm, 1.5 * GIB, 0, all);
  assert.deepEqual(step.abort, []);
  step = watchdogStep(P, step.state, 1.5 * GIB, 4999, all);
  assert.deepEqual(step.abort, [], 'not yet 5 s');
  step = watchdogStep(P, step.state, 1.5 * GIB, 5000, all);
  assert.deepEqual([...step.abort].sort(), [2, 4], 'both previews, nothing else');
  assert.equal(step.tier, 'preview');
  const left = all.filter(victim => !step.abort.includes(victim.id));
  step = watchdogStep(P, step.state, 1.5 * GIB, 24_999, left);
  assert.deepEqual(step.abort, [], 'cooldown');
  assert.equal(step.sustained, true);
  step = watchdogStep(P, step.state, 1.5 * GIB, 25_000, left);
  assert.deepEqual(step.abort, [3]); assert.equal(step.tier, 'filmstrip');
  step = watchdogStep(P, step.state, 1.5 * GIB, 45_000, left.filter(victim => victim.id !== 3));
  assert.deepEqual(step.abort, [1]); assert.equal(step.tier, 'waveform');
});

test('watchdog with nothing abortable only reports, and recovery resets the timer without touching the cooldown', () => {
  let step = watchdogStep(P, calm, 0.5 * GIB, 0, []);
  step = watchdogStep(P, step.state, 0.5 * GIB, 6000, []);
  assert.deepEqual(step.abort, []); assert.equal(step.tier, null); assert.equal(step.acted, true, 'a report-only action still starts the cooldown');
  const recovered = watchdogStep(P, step.state, 4 * GIB, 7000, victims('preview'));
  assert.equal(recovered.state.lowSince, null); assert.equal(recovered.sustained, false);
  const again = watchdogStep(P, recovered.state, 1 * GIB, 8000, victims('preview'));
  assert.deepEqual(again.abort, [], 'the 5 s start over after a recovery');
});

test('waiting status text names the wait', () => {
  assert.equal(waitingStatus(0), 'Waiting for memory');
  assert.equal(waitingStatus(59_999), 'Waiting for memory');
  assert.equal(waitingStatus(4 * 60_000 + 5), 'Waiting for memory, 4 min');
});

// ---- the runtime ----

let counter = 0;
function harness(options: { envMode?: string; commit?: number | null; available?: number; modeFile?: boolean } = {}) {
  const env = { t: 0, available: (options.available ?? 20) * GIB, commit: options.commit == null ? null : options.commit * GIB };
  const logs: string[] = [];
  const modePath = join(dir, `mode-${counter++}`);
  const guard = createHostGuard({
    sample: (): Sample => ({ availableBytes: env.available, commitHeadroomBytes: env.commit }),
    now: () => env.t, modePath, envMode: options.envMode ?? 'enforce', log: message => logs.push(message),
  });
  return { guard, env, logs, modePath };
}

test('observe mode admits at once and logs what enforce would have done', { timeout: 5000 }, async () => {
  const { guard, env, logs } = harness({ envMode: 'observe', available: 1 });
  const release = await guard.admit({ kind: 'export', costBytes: 1.9 * GIB, label: 'render pass' });
  assert.equal(guard.snapshot().guardMode, 'observe');
  assert.equal(guard.snapshot().running, 1);
  assert.ok(logs.some(line => /would have waited/.test(line) && /render pass/.test(line)), logs.join('\n'));
  release();
  assert.equal(guard.snapshot().running, 0);
  env.available = 20 * GIB; logs.length = 0;
  (await guard.admit({ kind: 'export', costBytes: 1.9 * GIB }))();
  assert.deepEqual(logs, [], 'nothing to report when enforce would also have admitted it');
});

test('observe mode keeps its log volume bounded during a bulk import', { timeout: 5000 }, async () => {
  const { guard, logs } = harness({ envMode: 'observe', available: 1 });
  for (let index = 0; index < 100; index++) (await guard.admit({ kind: 'other', costBytes: 0.4 * GIB }))();
  const would = logs.filter(line => /would have waited/.test(line)).length;
  assert.ok(would >= 1 && would <= 30, `${would} lines`);
});

test('enforce mode holds a job until memory allows, shows the wait, and starts it on the next tick', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ available: 4.5 });
  const statuses: (string | null)[] = [];
  const job = track(guard.admit({ kind: 'export', costBytes: 1.9 * GIB, onStatus: text => statuses.push(text) }));
  await tick();
  assert.equal(job.state, 'pending'); assert.equal(guard.snapshot().queued, 1);
  assert.deepEqual(statuses, ['Waiting for memory']);
  env.available = 12 * GIB; guard.tick(); await tick();
  assert.equal(job.state, 'resolved'); assert.equal(guard.snapshot().queued, 0); assert.equal(guard.snapshot().running, 1);
  assert.deepEqual(statuses, ['Waiting for memory', null]);
});

test('admissions in the same tick see each other, so three launches cannot all pass', { timeout: 5000 }, async () => {
  const { guard } = harness({ available: 8 });
  const jobs = [1, 2, 3].map(() => track(guard.admit({ kind: 'export', costBytes: 1.9 * GIB })));
  await tick();
  assert.deepEqual(jobs.map(job => job.state), ['resolved', 'resolved', 'pending']);
});

test('the floor holds even when nothing of ours is running', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ available: 6.9 });
  const job = track(guard.admit({ kind: 'ai', costBytes: 4 * GIB, label: 'depth' }));
  await tick(); assert.equal(job.state, 'pending');
  env.available = 7.1 * GIB; guard.tick(); await tick();
  assert.equal(job.state, 'resolved', 'progress guarantee once the floor is safe');
});

test('commit headroom limits admission even when physical memory is plentiful, and a failed commit read falls back to available', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ available: 20, commit: 4.5 });
  assert.equal(guard.snapshot().commitHeadroomGB, 4.5);
  assert.equal(guard.snapshot().freeGB, 20);
  const job = track(guard.admit({ kind: 'export', costBytes: 1.9 * GIB }));
  await tick(); assert.equal(job.state, 'pending');
  env.commit = null; guard.tick(); await tick();
  assert.equal(job.state, 'resolved');
});

test('cheap probes are never held, even at 0.5 GiB free in enforce mode', { timeout: 5000 }, async () => {
  const { guard } = harness({ available: 0.5 });
  const release = await guard.admit({ kind: 'other', costBytes: 0.1 * GIB, label: 'ffprobe -version' });
  assert.equal(guard.snapshot().running, 0); assert.equal(guard.snapshot().queued, 0);
  release();
});

test('previews are never queued: they are refused with a reason and a retry time', () => {
  const { guard, env } = harness({ available: 7 });
  const refused = guard.tryAdmit({ kind: 'preview', costBytes: 1.9 * GIB });
  assert.equal(refused.ok, false);
  if (!refused.ok) { assert.match(refused.reason, /memory/i); assert.ok(refused.retryAfterMs > 0); }
  assert.equal(guard.snapshot().queued, 0);
  env.available = 9 * GIB;
  const first = guard.tryAdmit({ kind: 'preview', costBytes: 1.9 * GIB });
  assert.equal(first.ok, true); assert.equal(guard.snapshot().previewsRunning, 1);
  assert.equal(guard.tryAdmit({ kind: 'preview', costBytes: 1.9 * GIB }).ok, false, 'the ramp ledger counts the first preview');
  env.t = 21_000;
  assert.equal(guard.tryAdmit({ kind: 'preview', costBytes: 1.9 * GIB }).ok, true, 'twenty seconds on, the ledger has let go');
  if (first.ok) first.release();
  assert.equal(guard.snapshot().previewsRunning, 1);
});

test('a preview is refused while a higher class waits for memory', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ available: 4.5 });
  void guard.admit({ kind: 'export', costBytes: 1.9 * GIB }); await tick();
  env.available = 30 * GIB;
  const refused = guard.tryAdmit({ kind: 'preview', costBytes: 1.9 * GIB });
  assert.equal(refused.ok, false);
});

test('observe mode admits a preview and logs that enforce would have refused it', () => {
  const { guard, logs } = harness({ envMode: 'observe', available: 2 });
  assert.equal(guard.tryAdmit({ kind: 'preview', costBytes: 1.9 * GIB }).ok, true);
  assert.ok(logs.some(line => /preview/.test(line) && /would have been refused/.test(line)), logs.join('\n'));
});

test('the mode file switches modes without a restart, and falls back to the environment when removed', { timeout: 5000 }, async () => {
  const { guard, env, modePath } = harness({ envMode: 'observe', available: 1 });
  (await guard.admit({ kind: 'export', costBytes: 1.9 * GIB }))();
  writeFileSync(modePath, 'enforce\n'); env.t += 1500;
  const held = track(guard.admit({ kind: 'export', costBytes: 1.9 * GIB }));
  await tick(); assert.equal(held.state, 'pending'); assert.equal(guard.snapshot().guardMode, 'enforce');
  writeFileSync(modePath, '﻿off'); guard.tick(); await tick();
  assert.equal(held.state, 'resolved', 'leaving enforce lets every waiter go');
  assert.equal(guard.snapshot().guardMode, 'off');
  rmSync(modePath); env.t += 1500;
  assert.equal(guard.snapshot().guardMode, 'observe');
});

const utf8Bom = (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

test('the mode file is read in every encoding a Windows tool writes, including PowerShell 5 echo (UTF-16LE with a BOM)', () => {
  const cases: [string, Buffer][] = [
    ['UTF-8', Buffer.from('enforce\r\n')],
    ['UTF-8 with a byte order mark', utf8Bom('Enforce\n')],
    ['UTF-16LE with a byte order mark', utf16le('enforce\r\n')],
    ['UTF-16BE with a byte order mark', utf16be('enforce\r\n')],
    ['UTF-16LE without a byte order mark', Buffer.from('enforce', 'utf16le')],
  ];
  for (const [label, bytes] of cases) {
    const { guard, env, modePath } = harness({ envMode: 'observe' });
    writeFileSync(modePath, bytes); env.t += 1500;
    assert.equal(guard.snapshot().guardMode, 'enforce', label);
  }
});

test('an unrecognised word in the mode file keeps the environment mode and is logged once, not every second', () => {
  const { guard, env, logs, modePath } = harness({ envMode: 'enforce' });
  writeFileSync(modePath, utf16le('banana\r\n'));
  for (let second = 0; second < 5; second++) { env.t += 1500; assert.equal(guard.snapshot().guardMode, 'enforce'); }
  assert.equal(logs.filter(line => /banana/.test(line)).length, 1, logs.join('\n'));
  writeFileSync(modePath, ''); env.t += 1500; guard.snapshot();
  assert.equal(logs.filter(line => /not off, observe or enforce/.test(line)).length, 1, 'an empty file (caught mid-write) is not an unrecognised word');
  writeFileSync(modePath, 'off'); env.t += 1500;
  assert.equal(guard.snapshot().guardMode, 'off');
});

test('an aborted wait leaves the queue, rejects, and holds no slot', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ available: 4.5 });
  const controller = new AbortController();
  const job = track(guard.admit({ kind: 'export', costBytes: 1.9 * GIB, signal: controller.signal }));
  await tick(); assert.equal(guard.snapshot().queued, 1);
  controller.abort(); await tick();
  assert.equal(job.state, 'rejected'); assert.match(String((job.error as Error).message), /Cancelled/);
  assert.equal(guard.snapshot().queued, 0);
  env.available = 20 * GIB; guard.tick();
  assert.equal(guard.snapshot().running, 0);
  await assert.rejects(guard.admit({ kind: 'export', costBytes: GIB, signal: controller.signal }), /Cancelled/);
});

test('release is idempotent and the slot count stays right', { timeout: 5000 }, async () => {
  const { guard } = harness();
  const first = await guard.admit({ kind: 'prepare', costBytes: 1.5 * GIB });
  await guard.admit({ kind: 'prepare', costBytes: 1.5 * GIB });
  first(); first(); first();
  assert.equal(guard.snapshot().running, 1);
});

test('two hundred one-second jobs in a row are not throttled by the ledger', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ available: 10 });
  for (let index = 0; index < 200; index++) {
    const release = await guard.admit({ kind: 'other', costBytes: 0.4 * GIB });
    assert.equal(guard.snapshot().queued, 0);
    env.t += 1000; release();
  }
  assert.equal(env.t, 200_000);
});

test('a wait cap rejects a non-export job after ten minutes; an export keeps waiting', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ available: 4.5 });
  const depth = track(guard.admit({ kind: 'ai', costBytes: 4 * GIB, label: 'depth' }));
  const render = track(guard.admit({ kind: 'export', costBytes: 1.9 * GIB }));
  await tick();
  env.t = 10 * 60_000; guard.tick(); await tick();
  assert.equal(depth.state, 'rejected');
  assert.equal((depth.error as { code?: string }).code, 'HOST_MEMORY_WAIT');
  assert.equal(render.state, 'pending');
  assert.match(waitingStatus(env.t), /10 min/);
});

test('enforce mode under pressure aborts previews, then filmstrips, then waveforms, 20 s apart, spares exports and shows Low memory on them', { timeout: 5000 }, async () => {
  const { guard, env, logs } = harness({ envMode: 'enforce', available: 20 });
  const aborted: string[] = [];
  const statuses: (string | null)[] = [];
  const release = await guard.admit({ kind: 'export', costBytes: 1.9 * GIB, onStatus: text => statuses.push(text) });
  guard.registerVictim('filmstrip', () => aborted.push('filmstrip'));
  const forget = guard.registerVictim('preview', () => aborted.push('preview'));
  const skipped = guard.registerVictim('preview', () => aborted.push('never'));
  guard.registerVictim('waveform', () => { aborted.push('waveform'); throw new Error('abort failed'); });
  skipped();
  env.available = 1.5 * GIB;
  guard.tick(); env.t = 4000; guard.tick();
  assert.deepEqual(aborted, []);
  env.t = 5000; guard.tick();
  assert.deepEqual(aborted, ['preview']);
  assert.deepEqual(statuses, ['Low memory']);
  env.t = 10_000; guard.tick(); assert.deepEqual(aborted, ['preview'], 'cooldown');
  env.t = 25_000; guard.tick(); assert.deepEqual(aborted, ['preview', 'filmstrip']);
  env.t = 44_999; guard.tick(); assert.deepEqual(aborted, ['preview', 'filmstrip'], 'cooldown again');
  env.t = 45_000; assert.doesNotThrow(() => guard.tick());
  assert.deepEqual(aborted, ['preview', 'filmstrip', 'waveform']);
  assert.ok(logs.some(line => /abort failed/.test(line)), 'a failing abort callback is logged, never thrown');
  forget();
  env.available = 20 * GIB; env.t = 50_000; guard.tick();
  assert.deepEqual(statuses, ['Low memory', null]);
  release();
});

test('observe mode under pressure stops nothing and shows nothing: it only logs what enforce would have stopped', { timeout: 5000 }, async () => {
  const { guard, env, logs } = harness({ envMode: 'observe', available: 20 });
  const aborted: string[] = [];
  const statuses: (string | null)[] = [];
  const release = await guard.admit({ kind: 'export', costBytes: 1.9 * GIB, onStatus: text => statuses.push(text) });
  guard.registerVictim('preview', () => aborted.push('preview'));
  guard.registerVictim('filmstrip', () => aborted.push('filmstrip'));
  env.available = 1.5 * GIB;
  for (const at of [0, 4000, 5000, 25_000, 45_000]) { env.t = at; guard.tick(); }
  assert.deepEqual(aborted, [], 'the same reading that makes enforce abort a preview changes nothing in observe');
  assert.deepEqual(statuses, [], 'and no export is told "Low memory"');
  assert.ok(logs.some(line => /observe: would have stopped 1 preview job\(s\) at 1\.5 GiB usable/.test(line)), logs.join('\n'));
  assert.ok(logs.filter(line => /would have stopped/.test(line)).length <= 30, 'rate limited');
  release();
});

test('switching from enforce to observe takes "Low memory" off a running export', { timeout: 5000 }, async () => {
  const { guard, env, modePath } = harness({ envMode: 'enforce', available: 20 });
  const statuses: (string | null)[] = [];
  const release = await guard.admit({ kind: 'export', costBytes: 1.9 * GIB, onStatus: text => statuses.push(text) });
  env.available = 1.5 * GIB;
  guard.tick(); env.t = 5000; guard.tick();
  assert.deepEqual(statuses, ['Low memory']);
  writeFileSync(modePath, 'observe'); env.t = 7000; guard.tick();
  assert.deepEqual(statuses, ['Low memory', null]);
  release();
});

test('mode off does nothing: no queueing, no refusal, no pressure aborts', { timeout: 5000 }, async () => {
  const { guard, env } = harness({ envMode: 'off', available: 0.2 });
  (await guard.admit({ kind: 'export', costBytes: 1.9 * GIB }))();
  assert.equal(guard.tryAdmit({ kind: 'preview', costBytes: 1.9 * GIB }).ok, true);
  let aborted = false; guard.registerVictim('preview', () => { aborted = true; });
  guard.tick(); env.t = 60_000; guard.tick();
  assert.equal(aborted, false);
});

test('a sampler that throws never breaks admission: the job is let through and the failure is logged', { timeout: 5000 }, async () => {
  const logs: string[] = [];
  const guard = createHostGuard({ sample: () => { throw new Error('no counter'); }, now: () => 0, modePath: join(dir, 'mode-throw'), envMode: 'enforce', log: line => logs.push(line) });
  (await guard.admit({ kind: 'export', costBytes: 1.9 * GIB }))();
  assert.ok(logs.some(line => /no counter/.test(line)));
  assert.equal(guard.snapshot().guardMode, 'enforce');
});

test('passes() shrinks export passes in enforce, and only reports in observe', () => {
  const enforce = harness({ available: 10.4 });
  assert.equal(enforce.guard.passes(4, 1.9 * GIB), 3);
  const observe = harness({ envMode: 'observe', available: 6 });
  assert.equal(observe.guard.passes(3, 1.9 * GIB), 3);
  assert.ok(observe.logs.some(line => /would have used 1 of 3 passes/.test(line)), observe.logs.join('\n'));
});

test('invalid requests are rejected at the boundary', async () => {
  const { guard } = harness();
  await assert.rejects(guard.admit({ kind: 'banana' as JobClass, costBytes: GIB }), /kind/);
  await assert.rejects(guard.admit({ kind: 'export', costBytes: Number.NaN }), /cost/);
  await assert.rejects(guard.admit({ kind: 'export', costBytes: -1 }), /cost/);
  assert.throws(() => guard.registerVictim('export' as VictimKind, () => undefined), /victim/i);
});

test('start and stop manage one unref-ed timer that ticks the guard', () => {
  const { guard } = harness();
  guard.start(); guard.start(); guard.stop(); guard.stop();
});
