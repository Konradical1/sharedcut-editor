import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostHealth, PlaybackReport } from '../src/services/playbackReportTypes.ts';
import { canSeeHealth, classify, createPlaybackReports, diagnose, validate } from './playbackReports.ts';

const MIN = 60_000, DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const alice = { userId: 'user-a', name: 'Sophie', clientId: 'tab-1', projectId: 'p1' };

const report = (over: Partial<PlaybackReport> = {}): PlaybackReport => ({
  v: 1, build: 'abc1234', at: 1_000, windowMs: 10_000, playing: true, targetFps: 30, fps: 30, loadingPct: 0, worstFreezeMs: 0,
  waitMs: { color: 0, decode: 0, buffer: 0, seek: 0, other: 0 }, linkMbps: 40, rttMs: 30, netType: '4g', downlinkMbps: 10, saveData: false,
  cores: 8, memoryGB: 8, gpu: 'RTX 3050', agent: 'Chrome 152 Windows', longTaskMs: 0, quality: 'full', engine: 'webcodecs', source: 'live',
  playheadMin: 0, cachedPct: 100, harness: false, onHost: false, ...over,
});
const host = (over: Partial<HostHealth> = {}): HostHealth => ({
  at: T0, freeGB: 12, commitHeadroomGB: 20, pagesPerSec: null, queued: 0, running: 0, previewsRunning: 0, guardMode: 'observe',
  eventLoopLagMs: 5, onBattery: false, gpuMemUsedGB: null, gpuTempC: null, ...over,
});
const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-reports-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};
const quiet = () => undefined;

// ---------------------------------------------------------------- validate

test('validate keeps a good report and drops every field it does not know', () => {
  const dirty = { ...report(), evil: 'x', waitMs: { ...report().waitMs, extra: 9 } };
  assert.deepEqual(validate(dirty), report());
});

test('validate refuses anything that is not a version 1 report and never throws', () => {
  for (const junk of [null, undefined, 7, 'text', [], [report()], {}, { ...report(), v: 2 }, { ...report(), v: '1' }]) assert.equal(validate(junk), null);
  const trap = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(validate(trap), null);
});

test('validate clamps every number into a sane range', () => {
  const got = validate({ ...report(), at: -5, windowMs: 1e12, targetFps: 0, fps: 9999, loadingPct: 400, worstFreezeMs: 1e12,
    waitMs: { color: -1, decode: 1e12, buffer: 1, seek: 2, other: 3 }, linkMbps: 1e9, rttMs: -3, downlinkMbps: -1, cores: 1e6, memoryGB: -2,
    longTaskMs: 1e12, playheadMin: 2.6, cachedPct: 180 });
  assert.ok(got);
  assert.deepEqual([got.at, got.windowMs, got.targetFps, got.fps, got.loadingPct, got.worstFreezeMs], [0, 3_600_000, 1, 240, 100, 3_600_000]);
  assert.deepEqual(got.waitMs, { color: 0, decode: 3_600_000, buffer: 1, seek: 2, other: 3 });
  assert.deepEqual([got.linkMbps, got.rttMs, got.downlinkMbps, got.cores, got.memoryGB], [100_000, 0, 0, 1024, 0]);
  assert.deepEqual([got.longTaskMs, got.playheadMin, got.cachedPct], [3_600_000, 3, 100]);
});

test('validate rejects non-finite or wrongly typed values instead of guessing', () => {
  const bad: Record<string, unknown>[] = [
    { fps: NaN }, { fps: Infinity }, { fps: '30' }, { loadingPct: -Infinity }, { playing: 1 }, { harness: 'no' }, { saveData: null },
    { source: 'weird' }, { gpu: 5 }, { linkMbps: NaN }, { linkMbps: '9' }, { netType: 4 }, { waitMs: null }, { waitMs: { color: 1 } },
    { waitMs: { ...report().waitMs, buffer: NaN } },
  ];
  for (const over of bad) assert.equal(validate({ ...report(), ...over }), null, JSON.stringify(over));
});

test('validate turns missing optional measurements into null', () => {
  const { linkMbps: _a, rttMs: _b, netType: _c, downlinkMbps: _d, cores: _e, memoryGB: _f, longTaskMs: _g, cachedPct: _h, ...rest } = report();
  const got = validate(rest);
  assert.ok(got);
  assert.deepEqual([got.linkMbps, got.rttMs, got.netType, got.downlinkMbps, got.cores, got.memoryGB, got.longTaskMs, got.cachedPct], Array(8).fill(null));
});

test('validate trims strings and cuts them to their limits', () => {
  const got = validate({ ...report(), gpu: `  ${'g'.repeat(100)}  `, agent: 'a'.repeat(99), build: ` ${'b'.repeat(40)}`, quality: 'q'.repeat(30), engine: ' eng\n\u0000x ', netType: 'n'.repeat(30) });
  assert.ok(got);
  assert.equal(got.gpu.length, 60);
  assert.equal(got.agent.length, 40);
  assert.equal(got.build.length, 16);
  assert.equal(got.quality.length, 12);
  assert.equal(got.netType?.length, 12);
  assert.equal(got.engine, 'eng  x');
});

// ---------------------------------------------------------------- classify

test('classify draws the green, amber and red lines exactly where the plan says', () => {
  const at = (over: Partial<PlaybackReport>) => classify(report({ targetFps: 100, fps: 100, ...over }));
  assert.equal(at({ fps: 93 }), 'green');
  assert.equal(at({ fps: 92.9 }), 'amber');
  assert.equal(at({ loadingPct: 4.9 }), 'green');
  assert.equal(at({ loadingPct: 5 }), 'amber');
  assert.equal(at({ worstFreezeMs: 400 }), 'green');
  assert.equal(at({ worstFreezeMs: 401 }), 'amber');
  assert.equal(at({ fps: 60 }), 'amber');
  assert.equal(at({ fps: 59.9 }), 'red');
  assert.equal(at({ loadingPct: 25 }), 'amber');
  assert.equal(at({ loadingPct: 25.1 }), 'red');
  assert.equal(at({ worstFreezeMs: 2500 }), 'amber');
  assert.equal(at({ worstFreezeMs: 2501 }), 'red');
});

test('classify is grey while nothing is playing', () => {
  assert.equal(classify(report({ playing: false, fps: 0 })), 'grey');
});

// ---------------------------------------------------------------- diagnose

test('diagnose says the computer is too slow when colour and decode work dominate with a decent link', () => {
  const slow = report({ fps: 4, loadingPct: 51, waitMs: { color: 5000, decode: 500, buffer: 100, seek: 0, other: 0 }, linkMbps: 40 });
  assert.equal(diagnose(slow, host()), 'Computer too slow: 4 of 30 pictures/s, 51% waiting on colour processing');
  const busyThread = report({ fps: 10, loadingPct: 10, longTaskMs: 4000, waitMs: { color: 0, decode: 0, buffer: 0, seek: 0, other: 500 } });
  assert.match(diagnose(busyThread, host()), /^Computer too slow: 10 of 30 pictures\/s/);
});

test('diagnose blames the connection when downloads dominate and the link is slow', () => {
  const waiting = { color: 200, decode: 0, buffer: 4000, seek: 0, other: 0 };
  const base = report({ fps: 12, loadingPct: 40, waitMs: waiting });
  assert.equal(diagnose({ ...base, linkMbps: 9.6 }, host()), 'Connection too slow: 12 of 30 pictures/s, 40% waiting on the download, link 9.6 Mbps');
  assert.match(diagnose({ ...base, linkMbps: null, netType: '3g' }, host()), /^Connection too slow: .*3g/);
  assert.match(diagnose({ ...base, linkMbps: 50, rttMs: 900 }, host()), /^Connection too slow: .*900 ms/);
});

test('diagnose blames the server when downloads dominate and the host is short of memory, queued up or lagging', () => {
  const base = report({ fps: 12, loadingPct: 40, waitMs: { color: 0, decode: 0, buffer: 4000, seek: 0, other: 0 }, linkMbps: 50 });
  assert.equal(diagnose(base, host({ freeGB: 1.2 })), 'Server busy: 12 of 30 pictures/s, 40% waiting on the download, server has 1.2 GB memory free');
  assert.match(diagnose(base, host({ queued: 8 })), /^Server busy: .*8 jobs queued/);
  assert.match(diagnose(base, host({ eventLoopLagMs: 450 })), /^Server busy: .*slowly/);
  assert.match(diagnose(base, host({ commitHeadroomGB: 1 })), /^Server busy: /);
});

test('diagnose does not blame the connection or the server for a browser that is hardly waiting', () => {
  // 25 of 30 pictures/s with 0.6% loading on a network that merely looks slow: the machine's own drawing speed is the limit.
  const hardlyWaiting = report({ fps: 25.3, loadingPct: 0.6, waitMs: { color: 0, decode: 0, buffer: 0, seek: 0, other: 60 }, linkMbps: null, netType: '3g', rttMs: 900 });
  assert.equal(diagnose(hardlyWaiting, host()), 'Computer too slow: 25 of 30 pictures/s, not waiting on downloads');
  assert.match(diagnose(hardlyWaiting, host({ freeGB: 0.5 })), /^Computer too slow/);
  // At exactly the line, real waiting is back in play and the old rules apply.
  assert.match(diagnose({ ...hardlyWaiting, loadingPct: 5, waitMs: { color: 0, decode: 0, buffer: 400, seek: 0, other: 0 } }, host()), /^Connection too slow/);
});

test('diagnose admits mixed causes when nothing points at one side', () => {
  const base = report({ fps: 12, loadingPct: 40, waitMs: { color: 0, decode: 0, buffer: 4000, seek: 0, other: 0 }, linkMbps: 50 });
  assert.equal(diagnose(base, host()), 'Mixed causes: 12 of 30 pictures/s, 40% waiting on the download');
  assert.match(diagnose(base, null), /^Mixed causes/);
});

test('diagnose reports smooth playback and paused playback plainly', () => {
  assert.equal(diagnose(report({ fps: 29.4 }), host()), 'Smooth: 29 of 30 pictures/s');
  assert.equal(diagnose(report({ playing: false, fps: 0 }), host()), 'Not playing');
});

// ---------------------------------------------------------------- the store in memory

test('the server clock decides when a report arrived, not the browser clock', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  assert.equal(store.ingest(alice, report({ at: 5 }), T0), true);
  const [person] = store.summary({ now: T0 + 1_000, host: host(), onlineIdentities: [] }).people;
  assert.equal(person.lastSeenAt, T0);
  assert.equal(person.latest?.at, 5);
});

test('ingest refuses a bad block, a bad identity and a report that comes too fast', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  assert.equal(store.ingest(alice, { nonsense: true }, T0), false);
  assert.equal(store.ingest({ ...alice, userId: '' }, report(), T0), false);
  assert.equal(store.ingest({ ...alice, clientId: '   ' }, report(), T0), false);
  assert.equal(store.ingest(alice, report(), T0 + 5_000), true);
  assert.equal(store.ingest(alice, report(), T0 + 5_500), false);
  assert.equal(store.ingest(alice, report(), T0 + 8_000), true);
  assert.equal(store.summary({ now: T0 + 9_000, host: host(), onlineIdentities: [] }).people.length, 1);
});

test('ingest refuses a time that is not a real number, so no row can get a broken file name', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  assert.equal(store.ingest(alice, report(), NaN), false);
  assert.equal(store.ingest(alice, report(), Infinity), false);
  assert.equal(store.summary({ now: T0, host: host(), onlineIdentities: [] }).people.length, 0);
});

test('identity text is trimmed so a browser cannot send a huge name or id', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  store.ingest({ userId: 'u', name: `  ${'n'.repeat(500)}`, clientId: 'c'.repeat(500), projectId: 'p'.repeat(500) }, report(), T0);
  const [person] = store.summary({ now: T0, host: host(), onlineIdentities: [] }).people;
  assert.ok(person.name.length <= 80 && person.clientId.length <= 80 && (person.projectId?.length ?? 0) <= 160);
});

test('reports in one minute roll up into one row, weighted by window length', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  store.ingest(alice, report({ fps: 30, loadingPct: 0 }), T0 + 5_000);
  store.ingest(alice, report({ fps: 10, loadingPct: 40, worstFreezeMs: 1200 }), T0 + 15_000);
  const [person] = store.summary({ now: T0 + 20_000, host: host(), onlineIdentities: [] }).people;
  assert.deepEqual(person.recent, [{ at: T0, fps: 20, loadingPct: 20, worstFreezeMs: 1200, light: 'amber' }]);
});

test('the final window a browser sends after it stops (playing false, real play time) is averaged into its minute, not thrown away', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  // The page sends one report the moment playback starts (no play time yet) and one for the last partial window when it stops.
  store.ingest(alice, report({ playing: true, windowMs: 0, fps: 0, loadingPct: 0 }), T0 + 5_000);
  store.ingest(alice, report({ playing: false, windowMs: 8_000, fps: 10, loadingPct: 20 }), T0 + 13_000);
  const [person] = store.summary({ now: T0 + 14_000, host: host(), onlineIdentities: [] }).people;
  assert.deepEqual(person.recent, [{ at: T0, fps: 10, loadingPct: 20, worstFreezeMs: 0, light: 'red' }]);
  assert.deepEqual([person.light, person.sentence], ['grey', 'Not playing'], 'a stopped browser still reads as not playing');
  // The same window alone in its minute (a burst that straddled the minute) is not grey either.
  const alone = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  alone.ingest(alice, report({ playing: false, windowMs: 8_000, fps: 10 }), T0 + 5_000);
  assert.deepEqual(alone.summary({ now: T0 + 6_000, host: host(), onlineIdentities: [] }).people[0].recent.map(row => [row.fps, row.light]), [[10, 'red']]);
  // An idle report (no play time) still weighs nothing.
  const idle = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  idle.ingest(alice, report({ playing: false, windowMs: 0, fps: 0 }), T0 + 5_000);
  assert.deepEqual(idle.summary({ now: T0 + 6_000, host: host(), onlineIdentities: [] }).people[0].recent.map(row => row.light), ['grey']);
});

test('only the last 30 minutes of rows stay in memory', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  for (let i = 0; i < 35; i += 1) store.ingest(alice, report(), T0 + i * MIN + 5_000);
  const [person] = store.summary({ now: T0 + 34 * MIN + 6_000, host: host(), onlineIdentities: [] }).people;
  assert.equal(person.recent.length, 30);
  assert.equal(person.recent[0].at, T0 + 5 * MIN);
  assert.equal(person.recent[29].at, T0 + 34 * MIN);
});

test('a minute older than 30 minutes drops out of the list even when fewer than 30 rows exist', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  store.ingest(alice, report(), T0 + 5_000);
  store.ingest(alice, report(), T0 + 10 * MIN + 5_000);
  const at = (minutes: number) => store.summary({ now: T0 + minutes * MIN + 6_000, host: host(), onlineIdentities: [] }).people[0].recent.map(row => row.at);
  assert.deepEqual(at(10), [T0, T0 + 10 * MIN]);
  assert.deepEqual(at(30), [T0 + 10 * MIN]);
});

test('a browser that has been silent for 30 minutes disappears, and at most 64 browsers are kept', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  store.ingest(alice, report(), T0);
  assert.equal(store.summary({ now: T0 + 31 * MIN, host: host(), onlineIdentities: [] }).people.length, 0);
  for (let i = 0; i < 70; i += 1) store.ingest({ ...alice, userId: `user-${i}`, clientId: `tab-${i}` }, report(), T0 + i * 3_000);
  const people = store.summary({ now: T0 + 70 * 3_000, host: host(), onlineIdentities: [] }).people;
  assert.equal(people.length, 64);
  assert.ok(!people.some(person => person.clientId === 'tab-0'));
});

test('one account keeps at most 8 browsers: a flood of fresh browser ids cannot push other people out', async () => {
  await withDir(async dir => {
    const store = createPlaybackReports({ dir, onError: quiet });
    const bob = { userId: 'user-b', name: 'Bob', clientId: 'tab-b', projectId: null };
    store.ingest(bob, report(), T0);
    const accepted = Array.from({ length: 200 }, (_, i) => store.ingest({ ...alice, clientId: `flood-${i}` }, report(), T0 + 3_000 + i)).filter(Boolean).length;
    assert.equal(accepted, 8);
    const { people } = store.summary({ now: T0 + 5_000, host: host(), onlineIdentities: [] });
    assert.equal(people.filter(person => person.userId === alice.userId).length, 8);
    assert.ok(people.some(person => person.userId === 'user-b'), 'Bob is still listed');
    assert.equal(store.ingest({ ...alice, clientId: 'flood-0' }, report(), T0 + 20_000), true, 'a browser she already has keeps reporting');
    assert.equal(store.ingest({ ...alice, clientId: 'one-more' }, report(), T0 + 21_000), false);
    await store.flushMinute(T0 + 40 * MIN);
    assert.equal(store.ingest({ ...alice, clientId: 'one-more' }, report(), T0 + 40 * MIN + 1_000), true, 'once the old ones have been forgotten there is room again');
  });
});

test('finished minutes waiting for the next flush are capped, so a flood cannot grow memory or the day file without limit', async () => {
  await withDir(async dir => {
    const store = createPlaybackReports({ dir, onError: quiet });
    for (let i = 0; i < 5_100; i += 1) store.ingest({ ...alice, userId: `user-${i}`, clientId: `tab-${i}` }, report(), T0);
    await store.flushMinute(T0 + 1_000);
    const [file] = await readdir(dir);
    const rows = (await readFile(join(dir, file), 'utf8')).split('\n').filter(Boolean);
    assert.equal(rows.length, 5_000);
    assert.equal(JSON.parse(rows[rows.length - 1]).userId, 'user-5035', 'the oldest rows are the ones dropped');
  });
});

test('online means seen in the last 30 s or present in the live presence list; stale reports go grey', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  store.ingest(alice, report({ fps: 10 }), T0);
  const at = (now: number, online = false) => store.summary({ now, host: host(), onlineIdentities: online ? [alice] : [] }).people[0];
  assert.deepEqual([at(T0 + 10_000).online, at(T0 + 10_000).light], [true, 'red']);
  const gone = at(T0 + 40_000);
  assert.deepEqual([gone.online, gone.light], [false, 'grey']);
  assert.match(gone.sentence, /^Offline, last report/);
  const quietTab = at(T0 + 40_000, true);
  assert.deepEqual([quietTab.online, quietTab.light], [true, 'grey']);
  assert.match(quietTab.sentence, /stopped arriving/);
});

test('a paused browser shows grey with "Not playing"', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  store.ingest(alice, report({ playing: false, fps: 0 }), T0);
  const [person] = store.summary({ now: T0 + 5_000, host: host(), onlineIdentities: [] }).people;
  assert.deepEqual([person.light, person.sentence], ['grey', 'Not playing']);
});

test('a browser that is present but has sent no report still gets a row', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  const bob = { userId: 'user-b', name: 'Bob', clientId: 'tab-9', projectId: null };
  const { people } = store.summary({ now: T0, host: host(), onlineIdentities: [bob] });
  assert.equal(people.length, 1);
  assert.deepEqual([people[0].name, people[0].online, people[0].latest, people[0].light], ['Bob', true, null, 'grey']);
  assert.match(people[0].sentence, /No playback report/);
});

test('people sort red first then amber, and harness runs stay apart after everyone', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  const add = (clientId: string, over: Partial<PlaybackReport>) => store.ingest({ ...alice, clientId }, report(over), T0);
  add('green', { fps: 30 });
  add('amber', { fps: 25 });
  add('red', { fps: 5 });
  add('test', { fps: 2, harness: true });
  const { people } = store.summary({ now: T0 + 1_000, host: host(), onlineIdentities: [] });
  assert.deepEqual(people.map(p => p.clientId), ['red', 'amber', 'green', 'test']);
  assert.deepEqual(people.map(p => p.harness), [false, false, false, true]);
  assert.match(people[3].sentence, /^\[Test run\] /);
});

test('a harness report never merges into a person who shares the same browser id', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  store.ingest(alice, report({ fps: 30 }), T0);
  store.ingest(alice, report({ fps: 2, harness: true }), T0 + 3_000);
  const { people } = store.summary({ now: T0 + 4_000, host: host(), onlineIdentities: [] });
  assert.equal(people.length, 2);
  assert.equal(people.find(p => !p.harness)?.latest?.fps, 30);
});

test('summary carries the host numbers and the time it was made', () => {
  const store = createPlaybackReports({ dir: join(tmpdir(), 'unused-reports'), onError: quiet });
  const summary = store.summary({ now: T0, host: host({ freeGB: 3 }), onlineIdentities: [] });
  assert.equal(summary.generatedAt, T0);
  assert.equal(summary.host.freeGB, 3);
});

// ---------------------------------------------------------------- the daily files

test('flushMinute appends only finished minutes to the daily file, once, as plain JSON lines with no names', () => withDir(async dir => {
  const store = createPlaybackReports({ dir, onError: quiet });
  store.ingest(alice, report({ fps: 24, playheadMin: 3 }), T0 + 5_000);
  await store.flushMinute(T0 + 30_000);
  assert.deepEqual(await store.history('user-a', 0), []);
  await store.flushMinute(T0 + 61_000);
  await store.flushMinute(T0 + 62_000);
  assert.deepEqual(await readdir(dir), ['2026-10-20.jsonl']);
  const lines = (await readFile(join(dir, '2026-10-20.jsonl'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.deepEqual([row.t, row.userId, row.clientId, row.projectId, row.report.fps], [T0, 'user-a', 'tab-1', 'p1', 24]);
  assert.ok(!lines[0].includes('Sophie'));
}));

test('a new minute from the same browser closes the old one for the file', () => withDir(async dir => {
  const store = createPlaybackReports({ dir, onError: quiet });
  store.ingest(alice, report(), T0 + 5_000);
  store.ingest(alice, report(), T0 + 65_000);
  await store.flushMinute(T0 + 70_000);
  const rows = await store.history('user-a', 0);
  assert.deepEqual(rows.map(r => r.at), [T0]);
  await store.flushMinute(T0 + 130_000);
  assert.deepEqual((await store.history('user-a', 0)).map(r => r.at), [T0, T0 + MIN]);
}));

test('rows land in the file of their own day', () => withDir(async dir => {
  const late = Date.UTC(2026, 9, 20, 23, 59, 30), next = Date.UTC(2026, 9, 21, 0, 0, 30);
  const store = createPlaybackReports({ dir, onError: quiet });
  store.ingest(alice, report(), late);
  store.ingest(alice, report(), next);
  await store.flushMinute(next + 2 * MIN);
  assert.deepEqual((await readdir(dir)).sort(), ['2026-10-20.jsonl', '2026-10-21.jsonl']);
}));

test('history returns one user, since a time, oldest first, with lights computed on read', () => withDir(async dir => {
  const store = createPlaybackReports({ dir, onError: quiet });
  store.ingest(alice, report({ fps: 30, playheadMin: 1 }), T0 + 5_000);
  store.ingest(alice, report({ fps: 5, playheadMin: 2 }), T0 + MIN + 5_000);
  store.ingest({ ...alice, userId: 'user-b', name: 'Bob' }, report(), T0 + 5_000);
  await store.flushMinute(T0 + 3 * MIN);
  const all = await store.history('user-a', 0);
  assert.deepEqual(all.map(r => [r.at, r.light, r.playheadMin, r.harness]), [[T0, 'green', 1, false], [T0 + MIN, 'red', 2, false]]);
  assert.deepEqual((await store.history('user-a', T0 + MIN)).map(r => r.at), [T0 + MIN]);
  assert.equal((await store.history('user-b', 0)).length, 1);
}));

test('a damaged last line is skipped, and the next write does not glue onto it', () => withDir(async dir => {
  const first = createPlaybackReports({ dir, onError: quiet });
  first.ingest(alice, report(), T0 + 5_000);
  await first.flushMinute(T0 + 2 * MIN);
  await appendFile(join(dir, '2026-10-20.jsonl'), '\n{"t":17,"userId":"user-a","cli'); // a batch cut off by a hard kill
  assert.equal((await first.history('user-a', 0)).length, 1);
  const restarted = createPlaybackReports({ dir, onError: quiet });
  restarted.ingest(alice, report(), T0 + 5 * MIN);
  await restarted.flushMinute(T0 + 7 * MIN);
  assert.deepEqual((await restarted.history('user-a', 0)).map(r => r.at), [T0, T0 + 5 * MIN]);
}));

test('a line that parses but is not a real report is ignored on read', () => withDir(async dir => {
  await mkdir(dir, { recursive: true });
  const good = { t: T0, userId: 'user-a', clientId: 'tab-1', projectId: null, report: report() };
  const lines = [JSON.stringify({ ...good, report: { v: 1 } }), JSON.stringify({ t: 'x' }), '[]', 'null', '', JSON.stringify(good)];
  await writeFile(join(dir, '2026-10-20.jsonl'), lines.join('\n'));
  const store = createPlaybackReports({ dir, onError: quiet });
  assert.equal((await store.history('user-a', 0)).length, 1);
}));

test('a failed write is reported, never thrown, and the rows are tried again next time', () => withDir(async dir => {
  const target = join(dir, 'reports');
  await writeFile(target, 'a file where the folder should be');
  const errors: string[] = [];
  const store = createPlaybackReports({ dir: target, onError: message => errors.push(message) });
  store.ingest(alice, report(), T0 + 5_000);
  await store.flushMinute(T0 + 2 * MIN);
  assert.equal(errors.length, 1);
  await rm(target);
  await store.flushMinute(T0 + 3 * MIN);
  assert.equal(errors.length, 1);
  assert.equal((await store.history('user-a', 0)).length, 1);
}));

test('reading a folder that does not exist yet gives no rows and no error', () => withDir(async dir => {
  const errors: string[] = [];
  const store = createPlaybackReports({ dir: join(dir, 'never-made'), onError: message => errors.push(message) });
  assert.deepEqual(await store.history('user-a', 0), []);
  await store.prune(T0);
  assert.deepEqual(errors, []);
}));

test('prune keeps 14 days of daily files and touches nothing else', () => withDir(async dir => {
  const day = (offset: number) => `${new Date(T0 - offset * DAY).toISOString().slice(0, 10)}.jsonl`;
  for (const name of [day(0), day(13), day(14), day(15), day(40), 'notes.txt', '2026-10-05.jsonl.bak']) await writeFile(join(dir, name), '{}');
  const store = createPlaybackReports({ dir, onError: quiet });
  await store.prune(T0);
  assert.deepEqual((await readdir(dir)).sort(), ['2026-10-05.jsonl.bak', day(14), day(13), day(0), 'notes.txt'].sort());
}));

// ---------------------------------------------------------------- who may look

test('only account ids listed in FRAME_LINE_HEALTH_USERS can open the Health page', () => {
  const env = { FRAME_LINE_HEALTH_USERS: ' user-a , user-b,, ' };
  assert.equal(canSeeHealth('user-a', env), true);
  assert.equal(canSeeHealth('user-b', env), true);
  assert.equal(canSeeHealth('user-c', env), false);
  assert.equal(canSeeHealth('user-a', {}), false);
  assert.equal(canSeeHealth('user-a', { FRAME_LINE_HEALTH_USERS: '' }), false);
  assert.equal(canSeeHealth('', { FRAME_LINE_HEALTH_USERS: ',' }), false);
  assert.equal(canSeeHealth(undefined, env), false);
});
