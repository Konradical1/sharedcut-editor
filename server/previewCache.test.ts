import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPreviewCache, previewRenderRequest, previewSlice, PreviewBusyError, PREVIEW_NICE, PREVIEW_SLOTS, PREVIEW_THREADS, type PreviewAdmission } from './previewCache.ts';
import type { RenderRequest } from './media.ts';
import type { Clip, GradeNode, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';

type Snapshot = Omit<RenderRequest, 'outputPath' | 'signal' | 'onProgress'>;
type Work = (signal: AbortSignal) => Promise<void>;

const MISSING = path.join(tmpdir(), 'frameline-preview-missing.mp4');
const asset = (id = 'm'): MediaAsset => ({ id, projectId: 'p', name: `${id}.mp4`, kind: 'video', binId: 'all', duration: 20, fps: 24, resolution: '320 × 180', size: '', status: 'ready', progress: 100, thumbnail: '' });
const track: Track = { id: 'v1', timelineId: 't', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
const clip = (id: string, start: number, effects: Clip['effects'] = [], extra: Partial<Clip> = {}): Clip => ({ id, projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'm', name: id, start, duration: 4, sourceIn: 0, color: '', disabled: false, properties: { ...defaultProperties }, effects, ...extra });
const snapshot = (rangeIn: number, clips: Clip[], extra: Partial<Snapshot> = {}): Snapshot => ({
  project: { id: 'p', resolution: '320 × 180', fps: 24 } as Project, timeline: { id: 't', projectId: 'p', name: 't', duration: 60 }, tracks: [track], nodes: [],
  clips, assets: [{ asset: asset(), path: MISSING }], settings: { resolution: '320 × 180', fps: '24', codec: 'H.264', audio: 'Disabled', rangeIn: String(rangeIn), rangeOut: String(rangeIn + 4) }, ...extra,
});
const withDirectory = async (body: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'frameline-preview-cache-'));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
/** A scheduler that only records the work: each test decides when (and whether) a job starts. */
const manual = () => { const works: Work[] = []; return { works, schedule: (_id: string, work: Work) => { works.push(work); } }; };
/** A render that never ends until it is aborted, the way a long ffmpeg run does. */
const hanging = (seen: RenderRequest[]) => (request: RenderRequest) => { seen.push(request); return new Promise<void>((_done, fail) => request.signal!.addEventListener('abort', () => fail(new Error('Canceled by you')), { once: true })); };
const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition(), 'the condition was never met'); };
/** What a request of this shape would be called, without keeping the job. */
const statusOf = (clips: Clip[], from: number, extra?: Partial<Snapshot>) => createPreviewCache(MISSING, () => {}, async () => {}).request(snapshot(from, clips, extra)).status;
const keyOf = (value: Snapshot) => createPreviewCache(MISSING, () => {}, async () => {}).request(value).key;

test('timeline previews skip a range with an active Depth clip or depth key and render the rest', async () => {
  await withDirectory(async directory => {
    const rendered: string[] = [], scheduled: Promise<void>[] = [];
    const cache = createPreviewCache(directory, (_id, work) => { scheduled.push(work(new AbortController().signal)); }, async request => { rendered.push(String(request.settings.rangeIn)); throw new Error('not rendered in this test'); });
    const depth = { id: 'd', name: 'Depth', enabled: true, amount: 100, parameters: { blur: 50 } };
    const clips = [clip('plain', 0), clip('deep', 4, [depth])];
    const skipped = cache.request(snapshot(4, clips));
    assert.equal(skipped.status, 'skipped', 'the chunk holding the Depth clip is not rendered');
    assert.equal(cache.request(snapshot(4, clips)).status, 'skipped', 'and asking again does not queue it either');
    // Depth with every section off draws nothing, so it does not count; neither does one switched off.
    assert.equal(cache.request(snapshot(4, [clip('plain', 0), clip('deep', 4, [{ ...depth, parameters: { blur: 0 } }])])).status, 'preparing');
    assert.equal(cache.request(snapshot(0, clips)).status, 'preparing', 'the chunk before it renders as usual');
    // A composition renders its whole inner timeline, so a Depth clip two levels down skips the chunk too, wherever it sits.
    const nested = { ...snapshot(0, [clip('parent', 0), clip('middle', 0), { ...clip('inner', 8, [depth]), timelineId: 'inner' }]), timelines: [{ id: 't', projectId: 'p', name: 't', duration: 12 }, { id: 'middle', projectId: 'p', name: 'middle', duration: 4, composition: true }, { id: 'inner', projectId: 'p', name: 'inner', duration: 12, composition: true }] };
    nested.clips[0] = { ...nested.clips[0], mediaId: 'frameline-composition', properties: { ...defaultProperties, compositionId: 'middle' } };
    nested.clips[1] = { ...nested.clips[1], timelineId: 'middle', mediaId: 'frameline-composition', properties: { ...defaultProperties, compositionId: 'inner' } };
    nested.tracks = [track, { ...track, id: 'mv', timelineId: 'middle' }, { ...track, id: 'iv', timelineId: 'inner' }];
    nested.clips[1].trackId = 'mv'; nested.clips[2].trackId = 'iv';
    assert.equal(cache.request(nested).status, 'skipped', 'a Depth inside a nested composition is never baked for a preview');
    await Promise.all(scheduled);
    // A depth key grades from the clip's depth run, which a viewer's preview must never start or wait for in a media slot.
    const key = { id: 'n', clipId: 'deep', projectId: 'p', name: 'Key', enabled: true, order: 1, parameters: {}, mask: { source: 'depth', enabled: true, invert: false, amount: 100, near: 0, far: 40, softness: 10 } } as unknown as GradeNode;
    assert.equal(cache.request({ ...snapshot(4, [clip('plain', 0), clip('deep', 4)]), nodes: [key] }).status, 'skipped', 'a depth-keyed range is not rendered either');
    assert.equal(cache.request({ ...snapshot(4, [clip('plain', 0), clip('deep', 4)]), nodes: [{ ...key, mask: { ...key.mask!, enabled: false } } as GradeNode] }).status, 'preparing', 'a key switched off reads no depth');
    await Promise.all(scheduled);
    assert.deepEqual(rendered.sort(), ['0', '4', '4'], 'only the chunks without active depth reached the renderer');
  });
});

test('a range that needs a whole-clip bake plays live, while the rest of the project still previews', () => {
  // Girls Soccer's shape: a 2.23 s composition clip at 9.57 s, which made EVERY chunk bake its 135 s timeline.
  const composition = clip('comp', 9.57, [], { mediaId: 'frameline-composition', duration: 2.23, properties: { ...defaultProperties, compositionId: 'inner' } });
  const clips = [clip('a', 0), clip('b', 4), composition, clip('c', 20)];
  assert.equal(statusOf(clips, 8), 'skipped', 'the chunk the composition touches');
  assert.equal(statusOf(clips, 12), 'preparing', 'it ends at 11.8 s, so the next chunk is clear');
  assert.equal(statusOf(clips, 0), 'preparing', 'a composition elsewhere does not disable previews everywhere');
  assert.equal(statusOf(clips, 20), 'preparing');
  assert.equal(statusOf([{ ...composition, disabled: true }], 8), 'preparing', 'a disabled composition is not baked');
  const stabilize = { id: 's', name: 'Stabilize', enabled: true, amount: 100 };
  const keyed = { 'properties.zoom': [{ id: 'k1', time: 0, value: 100, interpolation: 'linear' as const }, { id: 'k2', time: 2, value: 120, interpolation: 'linear' as const }] };
  const baked: [string, Partial<Clip>][] = [['Stabilize', { effects: [stabilize] }], ['optical flow', { properties: { ...defaultProperties, opticalFlow: true } }], ['keyframes', { keyframes: keyed }]];
  for (const [name, extra] of baked) {
    assert.equal(statusOf([clip('x', 4, [], extra)], 4), 'skipped', `${name} bakes the clip`);
    assert.equal(statusOf([clip('x', 4, [], extra)], 8), 'preparing', `${name} outside the range is not touched`);
    assert.equal(statusOf([clip('x', 4, [], { ...extra, disabled: true })], 4), 'preparing', `a disabled ${name} clip is not baked`);
  }
  assert.equal(statusOf([clip('x', 4, [{ ...stabilize, enabled: false }])], 4), 'preparing', 'a Stabilize switched off does nothing');
  assert.equal(statusOf([clip('x', 4, [{ ...stabilize, amount: 0 }])], 4), 'preparing', 'and neither does one at amount 0');
  // The renderer streams an animated title through the canvas, and never bakes keyframes nobody can hear.
  assert.equal(statusOf([clip('title', 4, [], { mediaId: 'frameline-title', keyframes: { 'properties.opacity': keyed['properties.zoom'] } })], 4), 'preparing', 'an animated title is drawn, not baked');
  const audio = { ...track, id: 'a1', kind: 'audio' as const, number: 2 };
  assert.equal(statusOf([clip('sound', 4, [], { trackId: 'a1', keyframes: keyed })], 4, { tracks: [track, audio] }), 'preparing', 'keys on a muted audio copy draw nothing');
});

test('a cut whose transition would change without a neighbour is not previewed from a trimmed edit', () => {
  const out = { ...defaultProperties, transitionOut: 'Cross dissolve' };
  const clips = [clip('a', 8, [], { duration: 8, properties: out }), clip('b', 16, [], { duration: 8 })];
  assert.equal(previewSlice(snapshot(12, clips)), undefined, 'b is not in the range, yet its presence cancels a phantom dissolve at the cut');
  assert.equal(statusOf(clips, 12), 'skipped');
  assert.deepEqual(previewSlice(snapshot(14, clips))?.clips.map(item => item.id), ['a', 'b'], 'with the cut inside the range both sides are kept');
  assert.deepEqual(previewSlice(snapshot(0, clips))?.clips.map(item => item.id), [], 'an empty stretch keeps nothing');
});

test('the renderer is handed only what can reach the range, without waveforms', async () => {
  await withDirectory(async directory => {
    const seen: RenderRequest[] = [], { works, schedule } = manual();
    const cache = createPreviewCache(directory, schedule, async request => { seen.push(request); });
    const node = (id: string, clipId: string) => ({ id, clipId, projectId: 'p', name: id, kind: 'primary', enabled: true, parameters: {} }) as GradeNode;
    const clips = [clip('early', 0), clip('inside', 4, [], { mediaId: 'n' }), clip('late', 8), clip('off', 4, [], { disabled: true, mediaId: 'o' }), clip('elsewhere', 4, [], { timelineId: 'x', trackId: 'vx', mediaId: 'o' })];
    const heavy = (id: string): MediaAsset => ({ ...asset(id), waveform: Array.from({ length: 1000 }, () => 0.5), filmstrip: '/filmstrip.jpg', thumbnail: '/thumb.jpg' });
    cache.request(snapshot(4, clips, {
      nodes: [node('n-early', 'early'), node('n-inside', 'inside')], tracks: [track, { ...track, id: 'vx', timelineId: 'x' }],
      timeline: { id: 't', projectId: 'p', name: 't', duration: 60, markers: [{ time: 1, name: 'm', color: '' }] },
      timelines: [{ id: 't', projectId: 'p', name: 't', duration: 60 }], assets: ['m', 'n', 'o'].map(id => ({ asset: heavy(id), path: MISSING })),
    }));
    await works[0](new AbortController().signal);
    const [request] = seen;
    assert.deepEqual(request.clips.map(item => item.id), ['inside']);
    assert.deepEqual(request.nodes.map(item => item.id), ['n-inside']);
    assert.deepEqual(request.tracks.map(item => item.id), ['v1'], 'the tracks of this timeline only');
    assert.deepEqual(request.assets.map(entry => entry.asset.id), ['n'], 'only the media a kept clip plays');
    assert.equal(request.assets[0].asset.waveform, undefined);
    assert.equal(request.assets[0].asset.filmstrip, undefined);
    assert.equal(request.timeline.markers, undefined);
    assert.ok(JSON.stringify(request).length < 4000, 'a poll no longer copies the whole project');
  });
});

test('the preview key follows what the range shows, not edits elsewhere', async () => {
  await withDirectory(async directory => {
    const base = snapshot(4, [clip('a', 4), clip('far', 30)]);
    const key = keyOf(base);
    assert.equal(keyOf(snapshot(4, [clip('a', 4), clip('far', 31, [], { name: 'renamed' }), clip('new', 40)])), key, 'clips outside the range');
    assert.equal(keyOf({ ...base, project: { ...base.project, modifiedAt: 99, name: 'Renamed', duration: 500 } }), key, 'project bookkeeping');
    assert.equal(keyOf({ ...base, timeline: { ...base.timeline, duration: 90, markers: [{ time: 1, name: 'm', color: '' }] } }), key, 'timeline length and markers');
    assert.equal(keyOf({ ...base, tracks: [{ ...track, height: 80, name: 'Renamed', locked: true }] }), key, 'track height, name and lock');
    assert.equal(keyOf({ ...base, assets: [{ asset: { ...asset(), waveform: [9, 9], thumbnail: '/x.jpg', filmstrip: '/y.jpg', progress: 50, preparationStage: 'busy' }, path: MISSING }] }), key, 'waveforms, thumbnails and progress');
    assert.notEqual(keyOf(snapshot(4, [clip('a', 4, [], { properties: { ...defaultProperties, opacity: 90 } })])), key, 'a clip in the range');
    assert.notEqual(keyOf({ ...base, nodes: [{ id: 'n', clipId: 'a', projectId: 'p', name: 'n', kind: 'primary', enabled: true, parameters: {} } as GradeNode] }), key, 'a grade node of a kept clip');
    assert.notEqual(keyOf({ ...base, tracks: [{ ...track, muted: true }] }), key, 'a track flag');
    assert.notEqual(keyOf({ ...base, assets: [{ asset: { ...asset(), inputProfile: 'S-Log3' }, path: MISSING }] }), key, 'colour metadata of the media');
    assert.notEqual(keyOf({ ...base, settings: { ...base.settings, resolution: '640 × 360' } }), key, 'the picture size');
    const file = path.join(directory, 'source.mp4'), withFile = () => keyOf({ ...base, assets: [{ asset: asset(), path: file }] });
    await writeFile(file, 'one'); const first = withFile();
    await writeFile(file, 'a longer file'); assert.notEqual(withFile(), first, 'a replaced source file');
  });
});

test('a finished preview is served from its file and never rendered twice', async () => {
  await withDirectory(async directory => {
    const { works, schedule } = manual(), outputs: string[] = [];
    const cache = createPreviewCache(directory, schedule, async request => { outputs.push(request.outputPath); await writeFile(request.outputPath, 'video'); });
    const first = cache.request(snapshot(4, [clip('a', 4)]));
    assert.equal(first.status, 'preparing');
    await works[0](new AbortController().signal);
    const done = cache.request(snapshot(4, [clip('a', 4)]));
    assert.equal(done.status, 'ready'); assert.equal(done.progress, 100); assert.match(done.url!, /^\/api\/timeline-previews\/[a-f0-9]{64}\/video\.mp4\?projectId=p$/);
    assert.equal(cache.file(done.key, 'p'), path.join(directory, `${done.key}.mp4`));
    assert.equal(cache.file(done.key, 'other'), undefined, 'a hash alone never authorizes a file');
    assert.equal((await stat(path.join(directory, `${done.key}.mp4`))).size, 5);
    assert.equal(existsSync(outputs[0]), false, 'the pending file was renamed away');
    assert.equal(works.length, 1, 'no second job');
    const restarted = createPreviewCache(directory, schedule, async () => { throw new Error('must not render'); });
    assert.equal(restarted.request(snapshot(4, [clip('a', 4)])).status, 'ready', 'a file from an earlier run is reused');
    assert.equal(works.length, 1);
  });
});

test('every browser poll renews the lease, and a preview nobody asks about is aborted and forgotten', { timeout: 5000 }, async () => {
  await withDirectory(async directory => {
    let time = 1_000; const seen: RenderRequest[] = [], { works, schedule } = manual();
    const cache = createPreviewCache(directory, schedule, hanging(seen), { now: () => time });
    const ask = () => cache.request(snapshot(4, [clip('a', 4)]));
    assert.equal(ask().status, 'preparing');
    const running = works[0](new AbortController().signal);
    await until(() => seen.length === 1);
    time += 4_000; ask();
    time += 4_000; cache.sweep(time);
    assert.equal(seen[0].signal!.aborted, false, 'asked 4 s ago, inside the 6 s lease');
    time += 3_000; cache.sweep(time);
    assert.equal(seen[0].signal!.aborted, true, 'asked 7 s ago: abandoned');
    await running;
    assert.equal(ask().status, 'preparing', 'the cancelled record is gone, so asking again starts fresh at once');
    assert.equal(works.length, 2);
  });
});

test('a request sweeps abandoned previews first, so stuck jobs never mean minutes of busy', () => {
  let time = 1_000; const { works, schedule } = manual();
  const cache = createPreviewCache(MISSING, schedule, async () => {}, { now: () => time });
  for (let i = 0; i < PREVIEW_SLOTS; i++) cache.request(snapshot(i * 4, [clip(`c${i}`, i * 4)]));
  const extra = PREVIEW_SLOTS * 4;
  assert.throws(() => cache.request(snapshot(extra, [clip('x', extra)])), (error: unknown) => error instanceof PreviewBusyError && error.message === 'Preview queue busy' && error.retryAfterSeconds > 0, 'one more than the slots is refused');
  time += 7_000;
  assert.equal(cache.request(snapshot(extra, [clip('x', extra)])).status, 'preparing', 'seven seconds on, the others are abandoned and a slot is free');
  assert.equal(works.length, PREVIEW_SLOTS + 1);
});

test('a preview still waiting for a media slot after 30 s is dropped even while its viewer keeps asking', { timeout: 5000 }, async () => {
  let time = 1_000; const seen: RenderRequest[] = [], { works, schedule } = manual();
  const cache = createPreviewCache(MISSING, schedule, hanging(seen), { now: () => time });
  const ask = () => cache.request(snapshot(4, [clip('a', 4)]));
  ask(); time += 15_000; ask(); time += 14_000; ask();
  cache.sweep(time + 1_000);
  assert.equal(works.length, 1, 'still queued at 30 s after its creation');
  assert.equal(ask().status, 'preparing'); assert.equal(works.length, 1, 'the poll found the same record');
  time += 2_000; cache.sweep(time);
  assert.equal(ask().status, 'preparing'); assert.equal(works.length, 2, 'dropped and re-created: the viewer gets a fresh place in line');
  await works[0](new AbortController().signal);
  assert.equal(seen.length, 0, 'the dropped job does nothing when the queue finally reaches it');
});

test('a failed preview is retried after 60 s, not kept forever', async () => {
  await withDirectory(async directory => {
    let time = 1_000; const { works, schedule } = manual();
    const cache = createPreviewCache(directory, schedule, async () => { throw new Error('ffmpeg exploded'); }, { now: () => time });
    const ask = () => cache.request(snapshot(4, [clip('a', 4)]));
    ask(); await works[0](new AbortController().signal);
    const failed = ask();
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Preview failed; it plays live in the editor.'); assert.equal(works.length, 1);
    time += 59_000; assert.equal(ask().status, 'failed', '59 s after the failure the answer stays');
    time += 2_000; assert.equal(ask().status, 'preparing', 'after 60 s it is tried again'); assert.equal(works.length, 2);
  });
});

test('a failed preview tells project members nothing about the host: the ffmpeg text and paths go to the log only', async () => {
  await withDirectory(async directory => {
    const { works, schedule } = manual(), logs: string[] = [];
    const secret = path.join(directory, 'original.mov');
    const cache = createPreviewCache(directory, schedule, async () => { throw new Error(`Media processing failed: ffmpeg exploded on ${secret}: Invalid data found`); }, { log: line => logs.push(line) });
    cache.request(snapshot(4, [clip('a', 4)])); await works[0](new AbortController().signal);
    const failed = cache.request(snapshot(4, [clip('a', 4)]));
    assert.equal(failed.status, 'failed');
    assert.ok(!JSON.stringify(failed).includes(secret) && !/exploded|ffmpeg/.test(JSON.stringify(failed)), JSON.stringify(failed));
    assert.ok(logs.some(line => /Preview failed/.test(line) && line.includes('exploded') && line.includes(secret)), logs.join('\n'));
  });
});

test('a preview dropped on purpose (project deleted) is not logged as a failure', { timeout: 5000 }, async () => {
  await withDirectory(async directory => {
    const seen: RenderRequest[] = [], { works, schedule } = manual(), logs: string[] = [];
    const cache = createPreviewCache(directory, schedule, hanging(seen), { log: line => logs.push(line) });
    cache.request(snapshot(0, [clip('a', 0)]));
    const running = works[0](new AbortController().signal);
    await until(() => seen.length === 1);
    cache.cancelProject('p'); await running;
    assert.ok(!logs.some(line => /Preview failed/.test(line)), logs.join('\n'));
  });
});

test('deleting a project cancels its previews and no one else\'s', { timeout: 5000 }, async () => {
  await withDirectory(async directory => {
    const seen: RenderRequest[] = [], { works, schedule } = manual();
    const cache = createPreviewCache(directory, schedule, hanging(seen));
    const other = (from: number) => snapshot(from, [clip('b', from, [], { projectId: 'q' })], { project: { id: 'q', resolution: '320 × 180', fps: 24 } as Project });
    cache.request(snapshot(0, [clip('a', 0)])); cache.request(other(4));
    const running = works.map(work => work(new AbortController().signal));
    await until(() => seen.length === 2);
    cache.cancelProject('p');
    const [mine, theirs] = seen.sort((a, b) => Number(a.settings.rangeIn) - Number(b.settings.rangeIn));
    assert.equal(mine.signal!.aborted, true); assert.equal(theirs.signal!.aborted, false);
    assert.equal(cache.request(snapshot(0, [clip('a', 0)])).status, 'preparing', 'its record is gone');
    assert.equal(works.length, 3);
    cache.cancelProject('q'); await Promise.all(running);
    assert.equal(theirs.signal!.aborted, true);
  });
});

test('aborting reaches the renderer from the queue, from the lease and from one job to the next without sharing files', { timeout: 5000 }, async () => {
  await withDirectory(async directory => {
    let time = 1_000; const seen: RenderRequest[] = [], { works, schedule } = manual();
    const cache = createPreviewCache(directory, schedule, hanging(seen), { now: () => time });
    // The queue's own signal (project delete, shutdown) is joined with the job's.
    const scheduler = new AbortController();
    cache.request(snapshot(0, [clip('a', 0)]));
    const first = works[0](scheduler.signal);
    await until(() => seen.length === 1);
    scheduler.abort(); await first;
    assert.equal(seen[0].signal!.aborted, true);
    // The lease abort of an older job and a fresh job for the same key never write the same temporary file.
    const ask = () => cache.request(snapshot(4, [clip('b', 4)]));
    ask(); const old = works[1](new AbortController().signal);
    await until(() => seen.length === 2);
    time += 7_000; cache.sweep(time);
    ask(); const fresh = works[2](new AbortController().signal);
    await until(() => seen.length === 3);
    await old;
    assert.notEqual(seen[1].outputPath, seen[2].outputPath);
    assert.equal(seen[1].signal!.aborted, true); assert.equal(seen[2].signal!.aborted, false);
    cache.cancelProject('p'); await fresh;
  });
});

test('the host guard hook can refuse a preview, and its slot is released however the job ends', async () => {
  await withDirectory(async directory => {
    let allow = false, released = 0; const kinds: string[] = [];
    const admit = (kind: 'preview'): PreviewAdmission => { kinds.push(kind); return allow ? { ok: true, release: () => { released++; } } : { ok: false, reason: 'low memory' }; };
    const { works, schedule } = manual(); let time = 1_000;
    const cache = createPreviewCache(directory, schedule, async () => { throw new Error('render failed'); }, { admit, now: () => time });
    assert.throws(() => cache.request(snapshot(4, [clip('a', 4)])), (error: unknown) => error instanceof PreviewBusyError && error.message === 'Preview queue busy' && error.reason === 'low memory');
    assert.equal(works.length, 0, 'nothing is scheduled when refused'); assert.deepEqual(kinds, ['preview']);
    allow = true;
    cache.request(snapshot(4, [clip('a', 4)])); await works[0](new AbortController().signal);
    assert.equal(released, 1, 'released when the job fails');
    // A job dropped before it ever starts gives its slot back at once, not when the queue finally reaches it.
    cache.request(snapshot(8, [clip('b', 8)]));
    time += 31_000; cache.sweep(time);
    assert.equal(released, 2); await works[1](new AbortController().signal);
    assert.equal(released, 2, 'and never twice');
  });
});

test('a preview is one pass of four threads at idle priority, whatever the snapshot asks', async () => {
  await withDirectory(async directory => {
    const controller = new AbortController(), progress = () => {};
    const request = previewRenderRequest({ ...snapshot(4, [clip('a', 4)]), threads: 24, singlePass: false, nice: 0 }, '/out/x.mp4', controller.signal, progress);
    assert.equal(request.threads, PREVIEW_THREADS); assert.equal(PREVIEW_THREADS, 4);
    assert.equal(request.singlePass, true);
    assert.equal(request.nice, PREVIEW_NICE); assert.equal(PREVIEW_NICE, 19);
    assert.equal(request.outputPath, '/out/x.mp4'); assert.equal(request.signal, controller.signal); assert.equal(request.onProgress, progress);
    const seen: RenderRequest[] = [], { works, schedule } = manual();
    createPreviewCache(directory, schedule, async value => { seen.push(value); }).request({ ...snapshot(4, [clip('a', 4)]), threads: 24 });
    await works[0](new AbortController().signal);
    assert.deepEqual([seen[0].threads, seen[0].singlePass, seen[0].nice], [4, true, 19]);
  });
});

test('one line names who asked for each newly created preview job', () => {
  const lines: string[] = [], { schedule } = manual();
  const cache = createPreviewCache(MISSING, schedule, async () => {}, { log: line => lines.push(line) });
  const ask = (from: number, clips: Clip[]) => cache.request(snapshot(from, clips), { userId: 'sophie', chunk: from / 4 });
  ask(4, [clip('a', 4)]); ask(4, [clip('a', 4)]);
  assert.equal(lines.length, 1, 'a poll of the same job logs nothing');
  assert.match(lines[0], /sophie/); assert.match(lines[0], /\bp\b/); assert.match(lines[0], /chunk 1\b/);
  ask(8, [clip('comp', 8, [], { mediaId: 'frameline-composition' })]);
  assert.equal(lines.length, 1, 'a skipped range creates no job and logs nothing');
  cache.request(snapshot(12, [clip('b', 12)]));
  assert.equal(lines.length, 2); assert.match(lines[1], /unknown/);
});
