import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_REPORT_MS, IDLE_REPORT_MS, MIN_PLAYING_MS, MIN_REPORT_GAP_MS, WINDOW_MS,
  agentLabel, bucketReason, createReportCollector, formatAgo, hostFacts, isHarness, isOnHost, keyNumbers, lightLabel,
  observeLongTasks, readDevice, readGpu, sparklineSegments, splitPeople,
} from './playbackReport.ts';
import type { ReportEnv } from './playbackReport.ts';
import type { HostHealth, PersonHealth, PlaybackReport } from './playbackReportTypes.ts';

const ENV: ReportEnv = { build: 'abc123', quality: 'Stream', source: 'live', cachedPct: 40, harness: false, onHost: false, cores: 8, memoryGB: 8, gpu: 'RTX 4070', agent: 'Chrome 152 Windows', netType: '4g', rttMs: 50, downlinkMbps: 10, saveData: false, longTasks: true };

type Rig = ReturnType<typeof rig>;
function rig(targetFps = 30) {
  const clock = { t: 100_000 };
  const collector = createReportCollector({ now: () => clock.t, targetFps });
  return { clock, collector };
}
type Tick = { loading?: boolean; reason?: string; stamp?: string | undefined; playing?: boolean };
/** Real order inside the player: the frame event comes first, then the health event of the same tick. */
function tick(r: Rig, i: number, shape: Tick = {}) {
  const { loading = false, reason = '', playing = true } = shape, stamp = 'stamp' in shape ? shape.stamp : String(i);
  if (!loading) r.collector.onFrame(stamp);
  r.collector.onHealth({ playing, playhead: 61 + i / 100, loading, engine: 'webcodecs', reason, decodedAhead: 1 });
}
/** Advance the clock in `stepMs` steps for `seconds` and tick once per step, `shape(i)` varying each tick. */
function run(r: Rig, seconds: number, shape: (i: number, ms: number) => Tick = () => ({}), stepMs = 50) {
  const steps = Math.round(seconds * 1000 / stepMs), start = r.clock.t;
  for (let i = 0; i <= steps; i++) { r.clock.t = start + i * stepMs; tick(r, i, shape(i, i * stepMs)); }
}
function must(report: PlaybackReport | null): PlaybackReport { assert.ok(report, 'a report was expected'); return report; }

test('pictures per second counts distinct pictures over the time spent playing', () => {
  const r = rig();
  run(r, 2);
  const report = must(r.collector.build(ENV));
  assert.equal(report.fps, 20);
  assert.equal(report.windowMs, 2000);
  assert.equal(report.playing, true);
  assert.equal(report.targetFps, 30);
  assert.equal(report.loadingPct, 0);
  assert.equal(report.worstFreezeMs, 50);
});

test('a repeated source picture is one picture, an unknown stamp always counts', () => {
  const r = rig();
  run(r, 1, i => ({ stamp: String(Math.floor(i / 2)) }));
  assert.equal(must(r.collector.build(ENV)).fps, 10);
  const r2 = rig();
  run(r2, 1, () => ({ stamp: undefined }));
  assert.equal(must(r2.collector.build(ENV)).fps, 20);
});

test('loading share is the time between ticks that were loading, as a share of playing time', () => {
  const r = rig();
  run(r, 2, (_i, ms) => ({ loading: ms >= 500 && ms < 1500, reason: 'Clip.MP4 · Preparing color frame' }));
  const report = must(r.collector.build(ENV));
  assert.equal(report.loadingPct, 50);
  assert.equal(report.waitMs.color, 1000);
  assert.equal(report.worstFreezeMs, 1050);
});

test('the worst freeze is the longest wait between two distinct pictures, including a stall at the end', () => {
  const r = rig();
  run(r, 3, (_i, ms) => ({ loading: ms > 300 && ms < 1500 }));
  assert.equal(must(r.collector.build(ENV)).worstFreezeMs, 1200);
  const stalled = rig();
  run(stalled, 3, (_i, ms) => ({ loading: ms >= 1000 }));
  assert.equal(must(stalled.collector.build(ENV)).worstFreezeMs, 2050);
});

test('time spent paused inside the window is neither playing time nor a freeze', () => {
  const r = rig();
  run(r, 1);
  for (let k = 1; k <= 60; k++) { r.clock.t += 50; tick(r, 100 + k, { playing: false }); }
  r.clock.t += 50;
  run(r, 1, i => ({ stamp: 'again' + i }));
  const report = must(r.collector.build(ENV));
  assert.equal(report.worstFreezeMs, 50, 'the three paused seconds are not a freeze');
  assert.equal(report.fps, 20, 'pictures painted while paused are not counted');
  assert.equal(report.windowMs, 2050);
});

test('a first picture that arrives late counts as a freeze from the moment playing began', () => {
  const r = rig();
  run(r, 1, (_i, ms) => ({ loading: ms < 800 }));
  const report = must(r.collector.build(ENV));
  assert.equal(report.worstFreezeMs, 800);
  assert.equal(report.loadingPct, 80);
});

test('a gap between ticks over one second is counted as one second of waiting at most', () => {
  const r = rig();
  r.collector.onHealth({ playing: true, playhead: 1, loading: true, reason: 'Buffering video', engine: 'native' });
  r.clock.t += 30_000;
  r.collector.onHealth({ playing: true, playhead: 2, loading: false, reason: '', engine: 'native' });
  const report = must(r.collector.build(ENV));
  assert.equal(report.windowMs, 1000);
  assert.equal(report.waitMs.buffer, 1000);
});

test('waits are grouped by kind and never carry clip or file names', () => {
  assert.equal(bucketReason('4B4A7040.MP4 · Preparing color frame'), 'color');
  assert.equal(bucketReason('Girls Soccer · Buffering video'), 'buffer');
  assert.equal(bucketReason('x · Buffering / decoding frame'), 'buffer');
  assert.equal(bucketReason('Loading media metadata'), 'buffer');
  assert.equal(bucketReason('x · Decoding requested frame'), 'decode');
  assert.equal(bucketReason('x · Seeking frame'), 'seek');
  assert.equal(bucketReason('something new'), 'other');
  assert.equal(bucketReason(''), 'other');
  const r = rig();
  run(r, 1, (_i, ms) => ({ loading: true, reason: ms < 500 ? 'Secret Clip.MP4 · Seeking frame; Other Secret.MOV · Preparing color frame' : 'Secret Clip.MP4 · Loading media metadata' }));
  const report = must(r.collector.build(ENV));
  assert.equal(report.waitMs.seek, 250);
  assert.equal(report.waitMs.color, 250);
  assert.equal(report.waitMs.buffer, 500);
  assert.equal(report.waitMs.decode + report.waitMs.other, 0);
  assert.doesNotMatch(JSON.stringify(report), /Secret|MP4|MOV/);
});

test('footage link speed is bytes over the time any download was running', () => {
  const r = rig();
  run(r, 1);
  assert.equal(must(r.collector.build(ENV)).linkMbps, null);
  r.collector.onTransfer(1_000_000, 1000);
  assert.equal(must(r.collector.build(ENV)).linkMbps, 8);
  r.collector.onTransfer(1_000_000, 1000);
  assert.equal(must(r.collector.build(ENV)).linkMbps, 16, 'two overlapping downloads share the same busy second');
  const odd = rig();
  odd.collector.onTransfer(0, 0);
  odd.collector.onTransfer(Number.NaN, 5);
  odd.collector.onTransfer(1, -5);
  run(odd, 1);
  assert.equal(must(odd.collector.build(ENV)).linkMbps, null, 'nonsense transfers are ignored');
});

test('long tasks are summed over the window, and unknown when the browser cannot observe them', () => {
  const r = rig();
  run(r, 1);
  r.collector.onLongTask(120);
  r.collector.onLongTask(80);
  r.collector.onLongTask(Number.NaN);
  assert.equal(must(r.collector.build(ENV)).longTaskMs, 200);
  r.collector.onLongTask(10);
  assert.equal(must(r.collector.build({ ...ENV, longTasks: false })).longTaskMs, null);
});

test('the window slides: pictures from before it are forgotten', () => {
  const r = rig();
  run(r, 5);
  must(r.collector.build(ENV));
  r.clock.t += WINDOW_MS + 5000;
  r.collector.onHealth({ playing: false, playhead: 70, loading: false, reason: '', engine: 'webcodecs' });
  const report = must(r.collector.build(ENV));
  assert.equal(report.playing, false);
  assert.equal(report.fps, 0);
  assert.equal(report.worstFreezeMs, 0);
  assert.equal(report.playheadMin, 1);
});

test('a report is only due every ten seconds while playing and every minute while idle', () => {
  const r = rig();
  assert.equal(r.collector.isDue(), false, 'nothing to say yet');
  run(r, 4);
  assert.equal(r.collector.isDue(), false);
  run(r, ACTIVE_REPORT_MS / 1000);
  assert.equal(r.collector.isDue(), true);
  must(r.collector.build(ENV));
  assert.equal(r.collector.isDue(), false);
  run(r, ACTIVE_REPORT_MS / 1000 - 1);
  assert.equal(r.collector.isDue(), false);
  run(r, 2);
  assert.equal(r.collector.isDue(), true);
});

test('a play run is not judged until it has three seconds of real playing', () => {
  const r = rig();
  tick(r, 0, { playing: false });
  r.clock.t += 30_000;
  tick(r, 1);
  assert.equal(r.collector.isDue(), false, 'one playing tick is a window of zero, not a stall');
  r.clock.t += 33; tick(r, 2);
  assert.equal(r.collector.isDue(), false, 'two ticks are 33 ms of playing');
  run(r, MIN_PLAYING_MS / 1000);
  assert.equal(r.collector.isDue(), true);
  assert.ok(must(r.collector.build(ENV)).windowMs >= MIN_PLAYING_MS);
});

test('stopping playback sends the last window soon, then the idle heartbeat falls back to a minute', () => {
  const early = rig();
  run(early, 1);
  early.clock.t += 500;
  tick(early, 0, { playing: false });
  assert.equal(early.collector.isDue(), false, 'not before the minimum gap');
  early.clock.t += MIN_REPORT_GAP_MS;
  tick(early, 1, { playing: false });
  assert.equal(early.collector.isDue(), true, 'the final window of a play run');
  const r = rig();
  run(r, 12);
  must(r.collector.build(ENV));
  run(r, 5);
  assert.equal(r.collector.isDue(), false, 'still playing, ten seconds not yet up');
  r.clock.t += 100;
  tick(r, 0, { playing: false });
  assert.equal(r.collector.isDue(), true, 'playback just stopped');
  assert.equal(must(r.collector.build(ENV)).playing, false);
  r.clock.t += IDLE_REPORT_MS - 1000;
  tick(r, 2, { playing: false });
  assert.equal(r.collector.isDue(), false);
  r.clock.t += 2000;
  tick(r, 3, { playing: false });
  assert.equal(r.collector.isDue(), true);
});

test('nothing is reported while paused and nothing new happened', () => {
  const r = rig();
  assert.equal(r.collector.build(ENV), null, 'a cold collector has nothing to say');
  r.collector.onHealth({ playing: false, playhead: 3, loading: false, reason: '', engine: 'webcodecs' });
  const idle = must(r.collector.build(ENV));
  assert.equal(idle.playing, false);
  assert.equal(idle.fps, 0);
  assert.equal(idle.loadingPct, 0);
  assert.equal(r.collector.build(ENV), null, 'same state, no new events');
  r.collector.onHealth({ playing: false, playhead: 3, loading: false, reason: '', engine: 'webcodecs' });
  assert.ok(r.collector.build(ENV), 'a new event is something new');
});

test('reset forgets everything', () => {
  const r = rig();
  run(r, 2);
  r.collector.reset();
  assert.equal(r.collector.build(ENV), null);
  assert.equal(r.collector.isDue(), false);
});

test('the report holds exactly the shared fields, only numbers and short labels', () => {
  const r = rig();
  run(r, 1);
  const report = must(r.collector.build({ ...ENV, harness: true, onHost: true }));
  assert.deepEqual(Object.keys(report).sort(), ['agent', 'at', 'build', 'cachedPct', 'cores', 'downlinkMbps', 'engine', 'fps', 'gpu', 'harness', 'linkMbps', 'loadingPct', 'longTaskMs', 'memoryGB', 'netType', 'onHost', 'playheadMin', 'playing', 'quality', 'rttMs', 'saveData', 'source', 'targetFps', 'v', 'waitMs', 'windowMs', 'worstFreezeMs']);
  assert.equal(report.v, 1);
  assert.equal(report.harness, true);
  assert.equal(report.onHost, true);
  assert.equal(report.engine, 'webcodecs');
  assert.equal(report.playheadMin, 1);
  assert.equal(report.build, 'abc123');
  assert.ok(JSON.stringify(report).length < 800);
});

test('the target rate can follow the timeline and bad values never reach the report', () => {
  let target = 24;
  const clock = { t: 0 };
  const collector = createReportCollector({ now: () => clock.t, targetFps: () => target });
  collector.onHealth({ playing: true, playhead: Number.NaN, loading: false, reason: '', engine: '' });
  const first = must(collector.build(ENV));
  assert.equal(first.targetFps, 24);
  assert.equal(first.playheadMin, 0);
  target = Number.NaN;
  collector.onHealth({ playing: true, playhead: -5, loading: false, reason: '', engine: '' });
  const report = must(collector.build(ENV));
  assert.equal(report.targetFps, 30, 'a broken timeline rate falls back to 30');
  assert.equal(report.playheadMin, 0);
});

test('harness and host detection', () => {
  assert.equal(isHarness({ webdriver: true }, {}), true);
  assert.equal(isHarness({}, { __sharedcutHarness: true }), true);
  assert.equal(isHarness({ webdriver: false }, {}), false);
  assert.equal(isHarness(undefined, undefined), false);
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', '::1']) assert.equal(isOnHost({ hostname }), true, hostname);
  for (const hostname of ['sharedcut.com', 'localhost.evil.com', '192.168.1.5', '']) assert.equal(isOnHost({ hostname }), false, hostname);
  assert.equal(isOnHost(undefined), false);
});

test('device facts survive a browser with no optional APIs and a browser whose getters throw', () => {
  assert.doesNotThrow(() => readDevice({}));
  const bare = readDevice({});
  assert.deepEqual({ ...bare, gpu: '', agent: '' }, { cores: null, memoryGB: null, gpu: '', agent: '', netType: null, rttMs: null, downlinkMbps: null, saveData: false, harness: false, onHost: false });
  const hostile = {} as Record<string, unknown>;
  for (const key of ['hardwareConcurrency', 'deviceMemory', 'connection', 'userAgent', 'userAgentData', 'webdriver']) Object.defineProperty(hostile, key, { get() { throw new Error(key); } });
  assert.doesNotThrow(() => readDevice({ navigator: hostile, location: { get hostname(): string { throw new Error('x'); } } as never }));
  const real = readDevice({ navigator: { hardwareConcurrency: 16, deviceMemory: 8, connection: { effectiveType: '4g', rtt: 75, downlink: 12.5, saveData: true }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' }, location: { hostname: 'localhost' } });
  assert.deepEqual({ cores: real.cores, memoryGB: real.memoryGB, netType: real.netType, rttMs: real.rttMs, downlinkMbps: real.downlinkMbps, saveData: real.saveData, onHost: real.onHost, agent: real.agent }, { cores: 16, memoryGB: 8, netType: '4g', rttMs: 75, downlinkMbps: 12.5, saveData: true, onHost: true, agent: 'Chrome 152 Windows' });
});

test('numbers from the browser are checked before they are trusted', () => {
  const odd = readDevice({ navigator: { hardwareConcurrency: -3, deviceMemory: Number.NaN, connection: { effectiveType: 7 as never, rtt: Infinity, downlink: 'fast' as never, saveData: 'yes' as never } } });
  assert.deepEqual({ cores: odd.cores, memoryGB: odd.memoryGB, netType: odd.netType, rttMs: odd.rttMs, downlinkMbps: odd.downlinkMbps, saveData: odd.saveData }, { cores: null, memoryGB: null, netType: null, rttMs: null, downlinkMbps: null, saveData: false });
});

test('the browser label is short and built from the brand and system only', () => {
  assert.equal(agentLabel({ userAgentData: { brands: [{ brand: 'Not.A/Brand', version: '99' }, { brand: 'Chromium', version: '152' }, { brand: 'Google Chrome', version: '152' }], platform: 'Windows' } }), 'Google Chrome 152 Windows');
  assert.equal(agentLabel({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' }), 'Chrome 152 ChromeOS');
  assert.equal(agentLabel({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' }), 'Safari 18 macOS');
  assert.equal(agentLabel({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0' }), 'Firefox 140 Windows');
  assert.equal(agentLabel({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0' }), 'Edge 152 Windows');
  assert.equal(agentLabel({ userAgent: 'x'.repeat(500) }).length <= 40, true);
  assert.equal(agentLabel({ userAgentData: { brands: [{ brand: 'A very long brand name that goes past the limit', version: '1' }], platform: 'Some very long platform name' } }).length <= 40, true);
  assert.equal(agentLabel({}), '');
});

test('the graphics card name is read once, trimmed, and the probe context is released', () => {
  let contexts = 0, lost = 0;
  const fake = { createElement: () => ({ width: 0, height: 0, getContext: () => { contexts++; return { getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : { loseContext: () => { lost++; } }, getParameter: () => 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)' }; } }) };
  const cache = { value: undefined as string | undefined };
  const first = readGpu(fake as never, cache);
  assert.equal(readGpu(fake as never, cache), first);
  assert.equal(contexts, 1, 'read once');
  assert.equal(lost, 1);
  assert.ok(first.startsWith('NVIDIA, NVIDIA GeForce RTX 4070'), first);
  assert.ok(first.length <= 60);
  const none = { value: undefined as string | undefined };
  assert.equal(readGpu(undefined, none), '');
  assert.equal(readGpu({ createElement: () => { throw new Error('no canvas'); } } as never, { value: undefined }), '');
  assert.equal(readGpu({ createElement: () => ({ getContext: () => null }) } as never, { value: undefined }), '');
  assert.equal(readGpu({ createElement: () => ({ getContext: () => ({ getExtension: () => null }) }) } as never, { value: undefined }), '');
});

test('long tasks are watched where the browser supports it and quietly skipped where it does not', () => {
  assert.equal(observeLongTasks(() => {}, undefined), null);
  assert.equal(observeLongTasks(() => {}, class { static supportedEntryTypes = ['paint']; observe() {} disconnect() {} } as never), null);
  assert.equal(observeLongTasks(() => {}, class { static supportedEntryTypes = ['longtask']; constructor() { throw new Error('nope'); } } as never), null);
  const seen: number[] = [];
  let disconnected = false, deliver: (list: { getEntries: () => { duration: number }[] }) => void = () => {};
  class Fake { static supportedEntryTypes = ['longtask']; constructor(cb: typeof deliver) { deliver = cb; } observe() {} disconnect() { disconnected = true; } }
  const stop = observeLongTasks(ms => seen.push(ms), Fake as never);
  assert.ok(stop);
  deliver({ getEntries: () => [{ duration: 90 }, { duration: 60 }] });
  assert.deepEqual(seen, [90, 60]);
  stop();
  assert.equal(disconnected, true);
});

// ---- Health page helpers -------------------------------------------------------------------------------------------

const person = (over: Partial<PersonHealth> = {}): PersonHealth => ({ userId: 'u', name: 'Sophie', clientId: 'c', projectId: 'p', online: true, lastSeenAt: 0, light: 'green', sentence: 'Playing well', latest: null, recent: [], harness: false, ...over });
const latest = (over: Partial<PlaybackReport> = {}): PlaybackReport => ({ v: 1, build: 'b', at: 0, windowMs: 10_000, playing: true, targetFps: 30, fps: 3.7, loadingPct: 51.4, worstFreezeMs: 1200, waitMs: { color: 0, decode: 0, buffer: 0, seek: 0, other: 0 }, linkMbps: 9.58, rttMs: 80, netType: '4g', downlinkMbps: 10, saveData: false, cores: 4, memoryGB: 4, gpu: '', agent: 'Chrome 152 Windows', longTaskMs: null, quality: 'Stream', engine: 'webcodecs', source: 'live', playheadMin: 0, cachedPct: null, harness: false, onHost: false, ...over });

test('time since a person was last seen reads in plain words', () => {
  assert.equal(formatAgo(0), 'just now');
  assert.equal(formatAgo(4_000), 'just now');
  assert.equal(formatAgo(-9_000), 'just now');
  assert.equal(formatAgo(12_400), '12 s ago');
  assert.equal(formatAgo(5 * 60_000 + 20_000), '5 min ago');
  assert.equal(formatAgo(3 * 3_600_000), '3 h ago');
  assert.equal(formatAgo(2 * 86_400_000), '2 d ago');
  assert.equal(formatAgo(Number.NaN), 'unknown');
});

test('every traffic light has words, so the colour is never the only signal', () => {
  assert.deepEqual((['green', 'amber', 'red', 'grey'] as const).map(lightLabel), ['Good', 'Fair', 'Poor', 'No data']);
});

test('key numbers show pictures per second against the target and dash for unknowns', () => {
  assert.deepEqual(keyNumbers(null), []);
  const numbers = Object.fromEntries(keyNumbers(latest()).map(({ label, value }) => [label, value]));
  assert.deepEqual(numbers, { 'Pictures/s': '3.7 of 30', Loading: '51%', Link: '9.6 Mbps', 'Round trip': '80 ms', Device: '4 cores, 4 GB', Browser: 'Chrome 152 Windows' });
  const unknown = Object.fromEntries(keyNumbers(latest({ linkMbps: null, rttMs: null, cores: null, memoryGB: null, agent: '' })).map(({ label, value }) => [label, value]));
  assert.deepEqual(unknown, { 'Pictures/s': '3.7 of 30', Loading: '51%', Link: '—', 'Round trip': '—', Device: '—', Browser: '—' });
});

test('the host card names every figure and says what the guard is doing', () => {
  const host: HostHealth = { at: 0, freeGB: 10.44, commitHeadroomGB: 9.96, pagesPerSec: null, queued: 2, running: 1, previewsRunning: 0, guardMode: 'observe', eventLoopLagMs: null, onBattery: false, gpuMemUsedGB: null, gpuTempC: 61.4 };
  const facts = Object.fromEntries(hostFacts(host).map(({ label, value }) => [label, value]));
  assert.deepEqual(facts, { 'Free memory': '10.4 GB', 'Commit headroom': '10.0 GB', Jobs: '1 running, 2 queued', 'Previews running': '0', 'Memory guard': 'Watching only', Power: 'Plugged in', 'GPU temperature': '61 °C' });
  const unknown = Object.fromEntries(hostFacts({ ...host, commitHeadroomGB: null, guardMode: 'enforce', onBattery: true, gpuTempC: null }).map(({ label, value }) => [label, value]));
  assert.deepEqual([unknown['Commit headroom'], unknown['Memory guard'], unknown.Power, unknown['GPU temperature']], ['—', 'Enforcing', 'On battery', '—']);
  assert.equal(Object.fromEntries(hostFacts({ ...host, onBattery: null, guardMode: 'off' }).map(({ label, value }) => [label, value])).Power, 'Unknown');
});

test('the sparkline scales pictures per second to the target and needs two points to draw', () => {
  assert.deepEqual(sparklineSegments([], 100, 20, 30), []);
  assert.deepEqual(sparklineSegments([30], 100, 20, 30), []);
  assert.deepEqual(sparklineSegments([0, 30], 100, 20, 30), ['0,19 100,1']);
  assert.deepEqual(sparklineSegments([15, 15, 15], 100, 20, 30), ['0,10 50,10 100,10']);
  assert.deepEqual(sparklineSegments([60, Number.NaN, -4], 100, 20, 30), ['0,1 50,19 100,19'], 'values are clamped to the chart');
  assert.deepEqual(sparklineSegments([1, 2], 100, 20, 0), ['0,10 100,1'], 'a zero scale falls back to the largest value');
});

test('an idle minute leaves a gap in the sparkline instead of being drawn as zero pictures per second', () => {
  assert.deepEqual(sparklineSegments([30, 30, null, null, 15, 15], 100, 20, 30), ['0,1 20,1', '80,10 100,10'], 'the line breaks across the idle minutes');
  assert.deepEqual(sparklineSegments([null, 30, null], 100, 20, 30), ['50,1 50,1'], 'one playing minute is a dot');
  assert.deepEqual(sparklineSegments([null, null, null], 100, 20, 30), [], 'nothing played, nothing drawn');
  assert.deepEqual(sparklineSegments([null, 1, 2], 100, 20, 0), ['50,10 100,1'], 'the zero-scale fallback ignores gaps');
});

test('people on the test harness are listed apart from real people', () => {
  const people = [person({ userId: 'a' }), person({ userId: 'b', harness: true }), person({ userId: 'c' })];
  const { real, harness } = splitPeople(people);
  assert.deepEqual(real.map(p => p.userId), ['a', 'c']);
  assert.deepEqual(harness.map(p => p.userId), ['b']);
  assert.equal(people.length, 3, 'the input is not changed');
});

test('sanity: the cadence constants are the planned ones', () => {
  assert.equal(ACTIVE_REPORT_MS, 10_000);
  assert.equal(IDLE_REPORT_MS, 60_000);
  assert.equal(MIN_REPORT_GAP_MS, 3_000);
  assert.equal(MIN_PLAYING_MS, 3_000);
  assert.equal(WINDOW_MS, 10_000);
});
