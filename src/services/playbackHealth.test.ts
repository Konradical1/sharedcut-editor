import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PlaybackReport } from './playbackReportTypes.ts';
import type { DeviceFacts } from './playbackReport.ts';
import {
  MIN_SEND_GAP_MS, SERVER_REPORT_GAP_MS, buildIdFromScripts, cachedPercent, constantSpeed, createHealthReporter, frameStamp, healthSharingEnabled,
  installHealthReporter, isFrozenClip, pictureClips, pictureSource, qualityLabel, reportTargetFps, takeHealthReport,
  type HealthReporter, type ReporterDeps,
} from './playbackHealth.ts';

// ---- Pure helpers ------------------------------------------------------------------------------------------------

test('sharing is on unless the setting is exactly false', () => {
  assert.equal(healthSharingEnabled({}), true, 'an account that never touched the setting shares');
  assert.equal(healthSharingEnabled({ sharePlaybackHealth: true }), true);
  assert.equal(healthSharingEnabled({ sharePlaybackHealth: false }), false);
  assert.equal(healthSharingEnabled({ sharePlaybackHealth: 'false' }), true, 'only a real boolean false opts out');
});

test('a frame is named by clip and source time only for pictures that come from video', () => {
  assert.equal(frameStamp({ sourceClip: 'c1', sourceTimestamp: '1.5', playbackEngine: 'webcodecs' }), 'c1@1.5');
  assert.equal(frameStamp({ sourceClip: 'c1', sourceTimestamp: '1.5', playbackEngine: 'native' }), 'c1@1.5');
  assert.equal(frameStamp({ sourceClip: 'preview:k', sourceTimestamp: '9', playbackEngine: 'render-cache' }), 'preview:k@9');
  assert.equal(frameStamp({ sourceClip: 'c1', sourceTimestamp: '0', playbackEngine: '' }), undefined, 'a held still image repeats one stamp and must not read as a freeze');
  assert.equal(frameStamp({ sourceClip: '', sourceTimestamp: '', playbackEngine: 'webcodecs' }), undefined);
  assert.equal(frameStamp({}), undefined);
});

test('the picture stamp names every footage layer, and wins over the stamp of the layer drawn last', () => {
  const footage = { sourceClip: 'logo', sourceTimestamp: '0', playbackEngine: 'webcodecs', pictureStamp: 'v1@2.5|v2@7' };
  assert.equal(frameStamp(footage), 'v1@2.5|v2@7', 'a logo drawn last must not pin the stamp');
  assert.equal(frameStamp({ ...footage, pictureStamp: 'v1@2.55|v2@7' }) !== frameStamp(footage), true, 'any footage layer moving is a new picture');
  assert.equal(frameStamp({ ...footage, pictureStamp: '' }), 'logo@0', 'no stamp: the old one');
  assert.equal(frameStamp({ ...footage, pictureStamp: undefined }), 'logo@0');
  assert.equal(frameStamp({ ...footage, playbackEngine: '' }), undefined, 'a still-only picture is still unknown');
});

test('the clips in a picture are the ones its stamp names, else the layer drawn last', () => {
  assert.deepEqual(pictureClips({ sourceClip: 'logo', pictureStamp: 'v1@2.5|v2@7' }), ['v1', 'v2']);
  assert.deepEqual(pictureClips({ sourceClip: 'logo', pictureStamp: '' }), ['logo']);
  assert.deepEqual(pictureClips({ sourceClip: 'logo' }), ['logo']);
  assert.deepEqual(pictureClips({}), []);
});

test('the viewer quality setting becomes the short label the report carries', () => {
  assert.equal(qualityLabel('Streaming'), 'Stream');
  assert.equal(qualityLabel('Half resolution'), '1/2');
  assert.equal(qualityLabel('Quarter resolution'), '1/4');
  assert.equal(qualityLabel('Full resolution'), 'Full');
  assert.equal(qualityLabel(undefined), 'Stream', 'the default is streaming');
});

test('the picture source follows the engine, the automatic low stream and the chosen quality', () => {
  const picture = (engine: string, automaticLow = false) => ({ clipId: 'c', engine, automaticLow });
  assert.equal(pictureSource(picture('render-cache'), 'Stream'), 'rendered');
  assert.equal(pictureSource(picture('webcodecs', true), 'Stream'), 'low');
  assert.equal(pictureSource(picture('webcodecs'), '1/4'), 'low');
  assert.equal(pictureSource(picture('webcodecs'), 'Stream'), 'stream');
  assert.equal(pictureSource(picture('webcodecs'), 'Full'), 'live');
  assert.equal(pictureSource(picture('native'), '1/2'), 'live');
});

test('the saved share is the saved bytes over the wanted bytes, null when nothing is wanted or the cache is off', () => {
  assert.equal(cachedPercent([{ cached: 50, total: 100 }, { cached: 100, total: 100 }], true), 75);
  assert.equal(cachedPercent([{ cached: 1, total: 3 }], true), 33);
  assert.equal(cachedPercent([], true), null);
  assert.equal(cachedPercent([{ cached: 0, total: 0 }], true), null);
  assert.equal(cachedPercent([{ cached: 50, total: 100 }], false), null);
  assert.equal(cachedPercent([{ cached: 500, total: 100 }], true), 100, 'never above 100');
});

test('the target rate is what the picture can reach: the preview rate, or the source rate when that is lower', () => {
  assert.equal(reportTargetFps({ playbackFrameRate: 'Match timeline' }, 30, undefined), 30, '"Match timeline" is the project rate');
  assert.equal(reportTargetFps({ playbackFrameRate: '24 fps' }, 30, undefined), 24);
  assert.equal(reportTargetFps({ playbackFrameRate: 'Match timeline' }, 30, 24), 24, 'a 24 fps clip on a 30 fps timeline must not read as 80% of target');
  assert.equal(reportTargetFps({ playbackFrameRate: '60 fps' }, 30, 60), 60);
  assert.equal(reportTargetFps({}, undefined, undefined), 24, 'nothing known falls back to 24 like the player');
  assert.equal(reportTargetFps({}, 30, 0), 30, 'a source rate of 0 is unknown');
});

test('a clip played slower than normal makes fewer distinct pictures, so the target shrinks with its speed', () => {
  assert.equal(reportTargetFps({}, 24, 24, 50), 12, 'a 24 fps clip at half speed shows 12 source pictures a second');
  assert.equal(reportTargetFps({ playbackFrameRate: '30 fps' }, 30, 60, 50), 30, 'a 60 fps clip at half speed still has a new picture for every one painted');
  assert.equal(reportTargetFps({}, 24, undefined, 25), 6, 'with the source rate unknown it is taken to match the preview');
  assert.equal(reportTargetFps({}, 24, 24, 200), 24, 'faster than normal is not scaled');
  assert.equal(reportTargetFps({}, 24, 24, 0), 24, 'a speed of 0 is no speed at all');
  assert.equal(reportTargetFps({}, 24, 24), 24, 'no speed given is normal speed');
});

test('a constant slow speed and a freeze frame are read from the clip, a speed ramp is neither', () => {
  assert.equal(constantSpeed({ properties: { speed: 50 } }), 50);
  assert.equal(constantSpeed({ properties: {} }), 100);
  assert.equal(constantSpeed({ properties: { speed: 'fast' } }), 100);
  assert.equal(constantSpeed({ properties: { speed: 50 }, keyframes: { 'properties.speed': [{ value: 50 }, { value: 200 }] } }), 100, 'a ramp has no one speed to scale by');
  assert.equal(isFrozenClip({ properties: { freeze: true } }), true);
  assert.equal(isFrozenClip({ properties: {}, keyframes: { 'properties.freeze': [{ value: false }, { value: true }] } }), true, 'frozen part of the way');
  assert.equal(isFrozenClip({ properties: {}, keyframes: { 'properties.freeze': [{ value: false }] } }), false);
  assert.equal(isFrozenClip({ properties: {} }), false);
});

test('the build id is the hash in the entry script name, or "dev" without one', () => {
  assert.equal(buildIdFromScripts(['https://sharedcut.com/assets/index-DiwrgTda.js']), 'DiwrgTda');
  assert.equal(buildIdFromScripts(['/assets/index-Ab-dEfGh.js?v=1']), 'Ab-dEfGh');
  assert.equal(buildIdFromScripts(['', 'https://x/other.js', '/assets/vendor-12345678.js']), '12345678');
  assert.equal(buildIdFromScripts(['http://localhost:5173/src/main.tsx']), 'dev');
  assert.equal(buildIdFromScripts([]), 'dev');
});

// ---- The reporter ------------------------------------------------------------------------------------------------

const DEVICE: DeviceFacts = { cores: 8, memoryGB: 16, gpu: 'NVIDIA RTX', agent: 'Chrome 152 Windows', netType: '4g', rttMs: 40, downlinkMbps: 50, saveData: false, harness: false, onHost: false };
const TICK_MS = 33;

type Rig = { clock: { t: number }; win: EventTarget; worker: EventTarget; doc: EventTarget & { hidden: boolean }; reporter: HealthReporter; deps: ReporterDeps; state: { sharing: boolean; stopped: number; resets: number; long: ((ms: number) => void) | null; contextListener: (() => void) | null; device: DeviceFacts } };

function rig(overrides: Partial<ReporterDeps> = {}, observerAvailable = true): Rig {
  const clock = { t: 1_000 };
  const state = { sharing: true, stopped: 0, resets: 0, long: null as ((ms: number) => void) | null, contextListener: null as (() => void) | null, device: DEVICE };
  const win = new EventTarget(), worker = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: false });
  const deps: ReporterDeps = {
    now: () => clock.t, target: win, worker, doc, build: 'abc12345',
    sharing: () => state.sharing, device: () => state.device,
    context: () => ({ quality: 'Stream', source: 'stream', cachedPct: 80 }),
    targetFps: () => 30,
    observe: observerAvailable ? onTask => { state.long = onTask; return () => { state.stopped++; }; } : () => null,
    onContextChange: listener => { state.contextListener = listener; return () => { state.contextListener = null; }; },
    ...overrides,
  };
  return { clock, win, worker, doc, reporter: createHealthReporter(deps), deps, state };
}

const canvas = (stamp: number) => ({ dataset: { sourceClip: 'c1', sourceTimestamp: String(stamp), playbackEngine: 'webcodecs', automaticLow: 'false' } });
const send = (target: EventTarget, type: string, detail: unknown) => target.dispatchEvent(new CustomEvent(type, { detail }));
/** Plays for `ms` of fake time at the tick rate: one health tick each, and a new picture unless the tick is waiting. */
function play(r: Rig, ms: number, extra: { loading?: boolean; reason?: string } = {}) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    r.clock.t += TICK_MS;
    if (!extra.loading) send(r.win, 'frameline:frame', canvas(r.clock.t / 1000));
    send(r.win, 'frameline:playback-health', { playing: true, playhead: 65, loading: extra.loading ?? false, engine: 'webcodecs', reason: extra.reason ?? '' });
  }
}
/** Paused for `ms` of fake time: health ticks that say nothing is playing. */
function pause(r: Rig, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    r.clock.t += TICK_MS;
    send(r.win, 'frameline:playback-health', { playing: false, playhead: 70, loading: false, engine: 'webcodecs', reason: '' });
  }
}

test('a report is built from the player events once ten seconds of playing have passed', () => {
  const r = rig();
  play(r, 2_000);
  assert.equal(r.reporter.take(), null, 'two seconds in, nothing is due');
  play(r, 9_000);
  const report = r.reporter.take() as PlaybackReport;
  assert.ok(report, 'due after ten seconds of playing');
  assert.equal(report.v, 1);
  assert.equal(report.build, 'abc12345');
  assert.equal(report.playing, true);
  assert.equal(report.targetFps, 30);
  assert.ok(report.fps > 29 && report.fps < 31, `about 30 pictures a second (${report.fps})`);
  assert.equal(report.loadingPct, 0);
  assert.equal(report.quality, 'Stream');
  assert.equal(report.source, 'stream');
  assert.equal(report.cachedPct, 80);
  assert.equal(report.cores, 8);
  assert.equal(report.harness, false);
  assert.equal(report.playheadMin, 1, 'the playhead at 65 s is in minute 1');
  assert.equal(r.reporter.take(), null, 'the same minute is not sent twice');
});

/** A frozen clip: every tick paints the same source picture. */
function playFrozen(r: Rig, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    r.clock.t += TICK_MS;
    send(r.win, 'frameline:frame', canvas(0));
    send(r.win, 'frameline:playback-health', { playing: true, playhead: 65, loading: false, engine: 'webcodecs', reason: '' });
  }
}

test('a frozen clip repeats one picture on purpose and is not reported as a stall', () => {
  const unaware = rig(); playFrozen(unaware, 11_000);
  assert.ok((unaware.reporter.take() as PlaybackReport).worstFreezeMs > 5_000, 'without the hint a repeat reads as a freeze');
  const held = rig({ isHeld: clipId => clipId === 'c1' }); playFrozen(held, 11_000);
  const report = held.reporter.take() as PlaybackReport;
  assert.ok(report.worstFreezeMs < 100, `no stall (${report.worstFreezeMs} ms)`);
  assert.ok(report.fps > 29, `every painted picture counts (${report.fps})`);
  const broken = rig({ isHeld: () => { throw new Error('store gone'); } }); playFrozen(broken, 11_000);
  assert.ok(broken.reporter.take(), 'a hint that throws costs the hint, not the report');
});

/** Footage that moves every tick under a logo that never does: sourceClip and sourceTimestamp name only the logo. */
function playUnderLogo(r: Rig, ms: number, held = false) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    r.clock.t += TICK_MS;
    const dataset = { sourceClip: 'logo', sourceTimestamp: '0', playbackEngine: 'webcodecs', automaticLow: 'false', pictureStamp: held ? 'v1@4' : `v1@${r.clock.t / 1000}` };
    send(r.win, 'frameline:frame', { dataset });
    send(r.win, 'frameline:playback-health', { playing: true, playhead: 65, loading: false, engine: 'webcodecs', reason: '' });
  }
}

test('footage playing under a logo counts every picture, and a freeze frame under it is still held on purpose', () => {
  const live = rig(); playUnderLogo(live, 11_000);
  const report = live.reporter.take() as PlaybackReport;
  assert.ok(report.fps > 29, `every footage picture counts (${report.fps})`);
  assert.ok(report.worstFreezeMs < 100, `no false freeze (${report.worstFreezeMs} ms)`);
  const frozen = rig({ isHeld: clipId => clipId === 'v1' }); playUnderLogo(frozen, 11_000, true);
  assert.ok((frozen.reporter.take() as PlaybackReport).worstFreezeMs < 100, 'a held footage clip is not a stall even with a logo drawn last');
  const unaware = rig(); playUnderLogo(unaware, 11_000, true);
  assert.ok((unaware.reporter.take() as PlaybackReport).worstFreezeMs > 5_000, 'without the hint a repeated footage picture reads as a freeze');
});

test('a logo drawn on top of footage does not set the target rate: the footage clip does', () => {
  // 24p footage (v1) under a logo in a 30 fps project: the logo's still image has no rate of its own.
  const r = rig({ targetFps: picture => picture.clipId === 'v1' ? 24 : 30 }); playUnderLogo(r, 11_000);
  assert.equal((r.reporter.take() as PlaybackReport).targetFps, 24);
});

test('nothing is built or sent while sharing is off, and sharing back on resumes at once', () => {
  const r = rig();
  r.state.sharing = false;
  play(r, 12_000);
  assert.equal(r.reporter.take(), null, 'off: no report leaves, even though one is due');
  r.state.sharing = true;
  assert.ok(r.reporter.take(), 'on again: the report that was due goes out');
});

test('a harness run is flagged through the device facts', () => {
  const r = rig();
  r.state.device = { ...DEVICE, harness: true };
  play(r, 11_000);
  assert.equal((r.reporter.take() as PlaybackReport).harness, true);
});

test('two reports are never closer than the server will accept', () => {
  const r = rig();
  play(r, 11_000);
  assert.ok(r.reporter.take());
  assert.ok(MIN_SEND_GAP_MS > SERVER_REPORT_GAP_MS, 'the client spacing has a margin over the server\'s 5 s');
  // Playing stops a second later. The collector wants one last window 3 s after a report; the server takes one per 5 s.
  play(r, 1_000);
  pause(r, 3_000);
  assert.equal(r.reporter.take(), null, 'about 4 s after the last report: held back, not lost');
  pause(r, 1_500);
  assert.equal(r.reporter.take(), null, 'over the server\'s 5 s but inside the margin that covers network jitter');
  pause(r, 1_000);
  assert.ok(r.reporter.take(), 'once the gap has passed the held window goes out');
});

test('the footage worker transfers and long tasks reach the report', () => {
  const r = rig();
  play(r, 5_000);
  // 5 MB in 2 s = 20 Mbps, finished just now.
  r.worker.dispatchEvent(new Event('message'));   // a message with no data is ignored
  r.worker.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'footage-transfer', bytes: 5_000_000, milliseconds: 2_000, ago: 0 } }));
  r.state.long!(120);
  play(r, 6_000);
  const report = r.reporter.take() as PlaybackReport;
  assert.ok(report.linkMbps !== null && Math.abs(report.linkMbps - 20) < 0.5, `link about 20 Mbps (${report.linkMbps})`);
  assert.equal(report.longTaskMs, 120);
});

test('long tasks read null when the browser cannot observe them', () => {
  const r = rig({}, false);
  play(r, 11_000);
  assert.equal((r.reporter.take() as PlaybackReport).longTaskMs, null);
});

test('waiting on color work shows up as loading time', () => {
  const r = rig();
  play(r, 5_000);
  play(r, 6_000, { loading: true, reason: 'Clip.MP4 · Preparing color frame' });
  const report = r.reporter.take() as PlaybackReport;
  assert.ok(report.loadingPct > 40, `about half the window is waiting (${report.loadingPct})`);
  assert.ok(report.waitMs.color > 0);
});

test('a hidden tab or a project change clears what was measured so the pause is not read as a freeze', () => {
  const r = rig();
  play(r, 11_000);
  r.doc.hidden = true;
  r.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(r.reporter.take(), null, 'hidden: the window was cleared');
  r.doc.hidden = false;
  play(r, 11_000);
  r.state.contextListener!();
  assert.equal(r.reporter.take(), null, 'a project or timeline change cleared it as well');
});

test('after stop the events no longer reach the collector and the observer is released', () => {
  const r = rig();
  r.reporter.stop();
  assert.equal(r.state.stopped, 1, 'the long-task observer is stopped');
  assert.equal(r.state.contextListener, null, 'the store subscription is dropped');
  play(r, 12_000);
  assert.equal(r.reporter.take(), null);
});

test('reporting can never throw into the heartbeat', () => {
  const r = rig({ device: () => { throw new Error('no navigator'); } });
  play(r, 11_000);
  assert.equal(r.reporter.take(), null);
  const noisy = rig({ context: () => { throw new Error('store gone'); } });
  assert.doesNotThrow(() => { play(noisy, 11_000); noisy.reporter.take(); });
});

test('a frame event with a broken detail is ignored', () => {
  const r = rig();
  assert.doesNotThrow(() => { send(r.win, 'frameline:frame', null); send(r.win, 'frameline:frame', 5); send(r.win, 'frameline:playback-health', null); });
});

test('the player writes the picture attributes the reporter reads from the frame event', () => {
  // The frame event carries the canvas; the reporter reads these four data attributes from it, so renaming one in the
  // player would silently turn every picture into "unknown" or "stream". Pinned the way the struggle counter is.
  const source = readFileSync(new URL('./playback.ts', import.meta.url), 'utf8');
  assert.match(source, /canvas\.dataset\.sourceClip = sourceClip; canvas\.dataset\.sourceTimestamp = sourceTimestamp;/);
  assert.match(source, /canvas\.dataset\.pictureStamp = pictureStamps\.join\('\|'\);/);
  assert.match(source, /canvas\.dataset\.playbackEngine=engine;/);
  assert.match(source, /canvas\.dataset\.automaticLow=String\(automaticLow\);/);
});

test('a graded video-element layer re-stamps its picture with the colour copy that was actually drawn', () => {
  // The stamp is first written from element.currentTime, before the colour draw. On the native element path the copy can lag
  // the element, so the entry pushed for this layer (by index, not "the last one") is rewritten after the draw, as sourceTimestamp is.
  // Without it a slow copy shows 30 pictures/s of element time while the screen changes 12 times a second. Pinned like the lines above:
  // no test builds the stamp inside the player.
  const source = readFileSync(new URL('./playback.ts', import.meta.url), 'utf8');
  assert.match(source, /const stampAt = [^;\r\n]*pictureStamps\.push\(`\$\{clip\.id\}@\$\{sourceTimestamp\}`\) - 1 : -1;/);
  assert.match(source, /finishLayer\(framed,asset,time,layerTarget,element instanceof HTMLVideoElement\?element:undefined,warp,queuedFrame,flip,stampAt,denoised\);/);
  // A Noise Reduction chunk's media time 0 is source second `offset`: the stamp stays in source time.
  assert.match(source, /if\(element\)\{const drawn=result\.dataset\.sourceTimestamp;sourceTimestamp=drawn\?String\(\+drawn\+offset\):'';if\(stampAt>=0\)pictureStamps\[stampAt\]=`\$\{clip\.id\}@\$\{sourceTimestamp\}`;\}/);
});

test('the Settings switch writes the key the reporter reads, and the harness marks its runs', () => {
  const dialog = readFileSync(new URL('../components/SettingsDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /toggle\('Share playback health with the owner', '[^']*', 'sharePlaybackHealth'\)/, 'on by default: toggle() falls back to true');
  const harness = readFileSync(new URL('../../scripts/remote-playback-check.mjs', import.meta.url), 'utf8');
  assert.match(harness, /window\.__sharedcutHarness = true;/);
  // Only a boolean false opts out: a stored default of nothing at all means sharing.
  assert.equal(healthSharingEnabled({}), true);
});

// ---- The slot the presence heartbeat reads -------------------------------------------------------------------------

test('the heartbeat gets no report until a reporter is installed, then whatever it has due', () => {
  assert.equal(takeHealthReport(), undefined);
  const report = { v: 1 } as PlaybackReport;
  let due: PlaybackReport | null = report;
  const reporter: HealthReporter = { take: () => { const next = due; due = null; return next; }, reset() {}, stop() {} };
  const uninstall = installHealthReporter(reporter);
  assert.equal(takeHealthReport(), report);
  assert.equal(takeHealthReport(), undefined, 'a report is handed out once');
  uninstall();
  due = report;
  assert.equal(takeHealthReport(), undefined, 'after uninstall the slot is empty again');
});

test('a reporter that throws does not break the heartbeat', () => {
  const uninstall = installHealthReporter({ take() { throw new Error('boom'); }, reset() {}, stop() {} });
  try { assert.equal(takeHealthReport(), undefined); } finally { uninstall(); }
});

test('an old uninstall does not remove a newer reporter', () => {
  const first = installHealthReporter({ take: () => null, reset() {}, stop() {} });
  const report = { v: 1 } as PlaybackReport;
  const second = installHealthReporter({ take: () => report, reset() {}, stop() {} });
  first();
  try { assert.equal(takeHealthReport(), report); } finally { second(); }
});
