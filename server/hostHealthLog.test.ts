import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { GIB } from './hostGuard.ts';
import { cachedAsync, createHostHealthLog, parseGpuLine, parseWindowsStats, type HostHealthLine } from './hostHealthLog.ts';

const dir = mkdtempSync(join(tmpdir(), 'frameline-hosthealth-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const nextPath = () => join(dir, `case-${counter++}`, 'host-health.log');
const lines = (path: string): HostHealthLine[] => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as HostHealthLine);

const sample = () => ({ availableBytes: 10.4 * GIB, commitHeadroomBytes: 9.75 * GIB });
const readers = {
  readWindows: async () => ({ pagesPerSec: 163, onBattery: false }),
  readGpu: async () => ({ gpuMemUsedGB: 1.79, gpuTempC: 61 }),
};

test('windows stats parse to numbers, and anything unreadable becomes null', () => {
  assert.deepEqual(parseWindowsStats('163|2\r\n'), { pagesPerSec: 163, onBattery: false });
  assert.deepEqual(parseWindowsStats('5000|1'), { pagesPerSec: 5000, onBattery: true });
  assert.deepEqual(parseWindowsStats('7|4'), { pagesPerSec: 7, onBattery: true }, 'low battery is still discharging');
  assert.deepEqual(parseWindowsStats('|2'), { pagesPerSec: null, onBattery: false });
  assert.deepEqual(parseWindowsStats('12|'), { pagesPerSec: 12, onBattery: null }, 'a desktop has no battery');
  assert.deepEqual(parseWindowsStats('12'), { pagesPerSec: 12, onBattery: null });
  assert.deepEqual(parseWindowsStats('12|10'), { pagesPerSec: 12, onBattery: null }, 'undefined battery status');
  assert.deepEqual(parseWindowsStats('garbage|zzz'), { pagesPerSec: null, onBattery: null });
  assert.deepEqual(parseWindowsStats(''), { pagesPerSec: null, onBattery: null });
  assert.deepEqual(parseWindowsStats('-5|2'), { pagesPerSec: null, onBattery: false });
});

test('nvidia-smi output parses MiB to GiB and ignores extra cards', () => {
  assert.deepEqual(parseGpuLine('1835, 61\n'), { gpuMemUsedGB: 1.79, gpuTempC: 61 });
  assert.deepEqual(parseGpuLine('2048, 70\r\n8000, 50\r\n'), { gpuMemUsedGB: 2, gpuTempC: 70 });
  for (const bad of ['', 'N/A, N/A', '[N/A], 61', '12', 'no devices were found']) assert.equal(parseGpuLine(bad), null, bad);
});

test('cachedAsync reads at most once per interval, once at a time, and turns failures into null', async () => {
  let now = 0, calls = 0, mode: 'ok' | 'fail' | 'throw' = 'ok';
  const read = cachedAsync(async () => { calls++; if (mode === 'fail') throw new Error('boom'); return calls; }, 30_000, () => now);
  const [first, second] = await Promise.all([read(), read()]);
  assert.deepEqual([first, second, calls], [1, 1, 1]);
  now = 29_999; assert.equal(await read(), 1); assert.equal(calls, 1);
  now = 30_000; mode = 'fail'; assert.equal(await read(), null); assert.equal(calls, 2);
  now = 31_000; assert.equal(await read(), null, 'a failure is cached too, so a missing tool is not launched every tick');
  assert.equal(calls, 2);
  const throwing = cachedAsync((() => { throw new Error('sync'); }) as () => Promise<number>, 1000, () => now);
  assert.equal(await throwing(), null);
});

test('a line carries every field, with nulls where a reading is missing, and never throws', async () => {
  const log = createHostHealthLog({
    path: nextPath(), sample, ...readers, now: () => Date.UTC(2026, 9, 4, 21, 30, 0), lag: () => ({ p99Ms: 12.34, maxMs: 80.06 }),
    queues: () => ({ media: 3, heavy: 1 }), children: () => 4,
  });
  assert.deepEqual(await log.collect(), {
    time: '2026-10-04T21:30:00.000Z', availableGB: 10.4, commitHeadroomGB: 9.75, pagesPerSec: 163, onBattery: false,
    gpuMemUsedGB: 1.79, gpuTempC: 61, eventLoopLagMs: 12.3, eventLoopLagMaxMs: 80.1, queues: { media: 3, heavy: 1 }, children: 4,
  });
  const broken = createHostHealthLog({
    path: nextPath(), sample: () => { throw new Error('sampler down'); },
    readWindows: async () => { throw new Error('cim down'); }, readGpu: () => new Promise<never>((_, reject) => reject(new Error('no gpu'))),
    queues: () => { throw new Error('queues down'); }, children: () => { throw new Error('registry down'); }, lag: () => { throw new Error('histogram down'); },
  });
  const line = await broken.collect();
  assert.deepEqual(
    [line.availableGB, line.pagesPerSec, line.onBattery, line.gpuMemUsedGB, line.gpuTempC, line.eventLoopLagMs, line.eventLoopLagMaxMs, line.children, line.commitHeadroomGB, line.queues],
    [null, null, null, null, null, null, null, null, null, {}],
  );
});

test('flush appends one JSON line per call and remembers the latest', async () => {
  const path = nextPath(), errors: unknown[] = [];
  let at = 1_000_000;
  const log = createHostHealthLog({ path, sample, ...readers, now: () => (at += 30_000), onError: error => errors.push(error), lag: () => null });
  assert.equal(log.latest(), null);
  await log.flush(); await log.flush();
  const written = lines(path);
  assert.equal(written.length, 2);
  assert.equal(written[0]!.availableGB, 10.4);
  assert.notEqual(written[0]!.time, written[1]!.time);
  assert.deepEqual(log.latest(), written[1]);
  assert.deepEqual(errors, []);
});

test('overlapping flushes write one line', async () => {
  const path = nextPath();
  const log = createHostHealthLog({ path, sample, ...readers, lag: () => null });
  await Promise.all([log.flush(), log.flush(), log.flush()]);
  assert.equal(lines(path).length, 1);
});

test('the log rotates at the size limit and keeps exactly one old file', async () => {
  const path = nextPath();
  let at = 0;
  const log = createHostHealthLog({ path, sample, ...readers, lag: () => null, maxBytes: 700, now: () => (at += 30_000) });
  for (let index = 0; index < 12; index++) await log.flush();
  assert.ok(existsSync(`${path}.1`), 'rotated');
  assert.ok(!existsSync(`${path}.2`), 'only one old file');
  assert.ok(statSync(path).size <= 700, `${statSync(path).size} bytes`);
  const old = lines(`${path}.1`), current = lines(path);
  assert.ok(old.length > 0 && current.length > 0);
  const times = [...old, ...current].map(line => line.time);
  assert.deepEqual(times, [...times].sort(), 'the old file holds the older lines, in order');
  assert.equal(current.at(-1)!.time, log.latest()!.time, 'nothing recent is lost');
});

test('a rotation replaces an existing old file instead of failing', async () => {
  const path = nextPath();
  const log = createHostHealthLog({ path, sample, ...readers, lag: () => null, maxBytes: 300 });
  await log.flush();
  writeFileSync(`${path}.1`, 'stale\n');
  for (let index = 0; index < 4; index++) await log.flush();
  assert.ok(!readFileSync(`${path}.1`, 'utf8').includes('stale'));
});

test('a write failure is reported, never thrown', async () => {
  const blocker = join(dir, 'a-file');
  writeFileSync(blocker, 'x');
  const errors: unknown[] = [];
  const log = createHostHealthLog({ path: join(blocker, 'inside', 'host-health.log'), sample, ...readers, lag: () => null, onError: error => errors.push(error) });
  await assert.doesNotReject(log.flush());
  assert.equal(errors.length, 1);
});

test('start logs at once, takes the event-loop reading from perf_hooks, and stop is safe to repeat', async () => {
  const path = nextPath();
  const log = createHostHealthLog({ path, sample, ...readers, intervalMs: 60_000 });
  log.start(); log.start();
  await log.flush();
  const [line] = lines(path);
  assert.ok(line!.eventLoopLagMs === null || typeof line!.eventLoopLagMs === 'number');
  log.stop(); log.stop();
  assert.equal(lines(path).length, 1);
});

test('default readers are skipped off Windows and on macOS, giving nulls without spawning anything', async () => {
  const log = createHostHealthLog({ path: nextPath(), sample, platform: 'darwin', lag: () => null });
  const line = await log.collect();
  assert.deepEqual([line.pagesPerSec, line.onBattery, line.gpuMemUsedGB, line.gpuTempC], [null, null, null, null]);
});
