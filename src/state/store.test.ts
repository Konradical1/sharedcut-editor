import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { projectBins, useEditorStore as store } from './store.ts';
import { createDemoProject } from './demo.ts';
import { defaultShape, getShape } from '../services/shapes.ts';
import { evaluateClip } from '../services/animation.ts';
import type { Clip, Keyframe } from './models.ts';
import { neutralBalance, neutralLook, type LookOption } from '../services/colorAssistant.ts';
import type { NormalizeShot } from '../services/colorGroups.ts';
import { interpretation } from '../services/color.ts';
import { forwardRoom } from '../services/selection.ts';
import { depthUi, rememberDepth } from '../services/depthPreview.ts';
import { nodeMaskId } from '../services/smartMask.ts';
import { LOCK_TTL, mediaService, projectService, renderService, STORAGE_KEY } from '../services/index.ts';
import { ordered, PLAN_LIMITS } from '../services/plan.ts';

const baseline = store.getState();
const state = () => store.getState();
const clip = (id = 'c3') => state().clips.find(clip => clip.id === id)!;
beforeEach(() => store.setState({ ...baseline, locks: [], operations: [], notifications: [] }, true));

test('personal undo preserves another user’s newer edit to a different field', () => {
  state().updateProperty('c3', 'speed', 112);
  state().setCurrentUser('ashley');
  state().updateProperty('c3', 'x', 64);
  state().setCurrentUser('kyle');
  state().undo();
  assert.equal(clip().properties.speed, 100);
  assert.equal(clip().properties.x, 64);
  assert.equal(state().operations.find(op => op.userId === 'ashley')?.undone, undefined);
});

test('personal undo refuses to overwrite a collaborator’s newer overlapping edit', () => {
  state().updateProperty('c3', 'speed', 112);
  state().setCurrentUser('ashley');
  state().updateProperty('c3', 'speed', 85);
  state().setCurrentUser('kyle');
  state().undo();
  assert.equal(clip().properties.speed, 85);
  assert.equal(state().operations.length, 2);
  assert.match(state().notifications.at(-1)!.title, /newer change/);
});

test('undo does not remove a track that a collaborator has started using', () => {
  state().createTrack('video');
  const track = state().tracks.at(-1)!;
  state().setCurrentUser('ashley');
  state().moveClip('c3', 30, track.id);
  state().setCurrentUser('kyle');
  state().undo();
  assert.ok(state().tracks.some(item => item.id === track.id));
  assert.equal(clip().trackId, track.id);
});

test('selection does not lock; property ownership is scoped and expires', () => {
  state().selectClip('c3');
  assert.equal(state().locks.length, 0);
  store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: 'city-after-dark', targetId: 'c3', field: 'speed', expiresAt: Date.now() + LOCK_TTL }] });
  assert.equal(state().acquireLock('c3', 'speed'), false);
  assert.equal(state().acquireLock('c3', 'x'), true);
  state().updateProperty('c3', 'speed', 200);
  assert.equal(clip().properties.speed, 100);
  state().updateProperty('c3', 'x', 12);
  assert.equal(clip().properties.x, 12);
  state().tick(Date.now() + LOCK_TTL + 1);
  assert.equal(state().locks.length, 0);
  assert.equal(state().acquireLock('c3', 'speed'), true);
  state().releaseUserLocks('kyle');
  assert.equal(state().locks.length, 0);
});

test('a manipulation lock blocks both move and trim but permits inspection', () => {
  const original = structuredClone(clip());
  store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: 'city-after-dark', targetId: 'c3', field: 'manipulation', expiresAt: Date.now() + LOCK_TTL }] });
  state().moveClip('c3', 50);
  state().trimClip('c3', 32, 15);
  state().selectClip('c3');
  assert.deepEqual(clip(), original);
  assert.equal(state().selectedClipId, 'c3');
});

test('renewing locks extends only live ownership and never revives a stale lease', () => {
  assert.equal(state().acquireLock('c3', 'speed'), true);
  const original = state().locks[0];
  store.setState({ locks: [{ ...original, expiresAt: Date.now() + 500 }] });
  assert.equal(state().renewLock('c3', 'speed'), true);
  assert.equal(state().locks[0].id, original.id);
  assert.ok(state().locks[0].expiresAt >= Date.now() + LOCK_TTL - 20);
  store.setState({ locks: [{ ...original, expiresAt: Date.now() - 1 }] });
  assert.equal(state().renewLock('c3', 'speed'), false);
  assert.equal(state().acquireLock('c3', 'speed'), true);
  assert.notEqual(state().locks[0].id, original.id);
  store.setState({ locks: [{ ...original, expiresAt: Date.now() - 1 }, { ...original, id: 'new-owner', userId: 'ashley', expiresAt: Date.now() + LOCK_TTL }] });
  assert.equal(state().renewLock('c3', 'speed'), false);
  assert.equal(state().acquireLock('c3', 'speed'), false);
  assert.ok(state().locks.some(lock => lock.id === 'new-owner'));
  assert.equal(state().operations.length, 0);
});

test('acquireLocks takes many clips in one update, renews them in place, and takes none when one is held by someone else', () => {
  const ids = state().clips.filter(c => c.projectId === state().projectId).slice(0, 6).map(c => c.id);
  let updates = 0; const stop = store.subscribe(() => { updates++; });
  try {
    assert.equal(state().acquireLocks(ids, 'manipulation'), true);
    assert.equal(updates, 1, 'One store update for the whole drag, not one per clip.');
    assert.deepEqual(state().locks.map(l => l.targetId).sort(), [...ids].sort());
    assert.ok(state().locks.every(l => l.field === 'manipulation' && l.userId === state().currentUserId && l.projectId === state().projectId));
    const first = state().locks, original = new Map(first.map(l => [l.targetId, l.id]));
    store.setState({ locks: first.map(l => ({ ...l, expiresAt: Date.now() + 500 })) });
    assert.equal(state().acquireLocks(ids, 'manipulation'), true, 'The 2 s renewal is the same call.');
    assert.equal(state().locks.length, ids.length, 'Renewing replaces the leases instead of stacking them.');
    assert.ok(state().locks.every(l => l.id === original.get(l.targetId) && l.expiresAt >= Date.now() + LOCK_TTL - 50), 'Same lock ids, fresh expiry.');
    assert.equal(state().acquireLocks([], 'manipulation'), true, 'Nothing to lock is not a refusal.');

    // One clip of the batch is being moved by a collaborator: nothing is taken and the user is told.
    store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: state().projectId, targetId: ids[3], field: 'x', expiresAt: Date.now() + LOCK_TTL }] });
    assert.equal(state().acquireLocks(ids, 'manipulation'), true, 'A collaborator’s unrelated field does not conflict.');
    store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: state().projectId, targetId: ids[3], field: 'manipulation', expiresAt: Date.now() + LOCK_TTL }], notifications: [] });
    assert.equal(state().acquireLocks(ids, 'start'), false, 'Movement fields conflict with each other.');
    assert.deepEqual(state().locks.map(l => l.id), ['remote'], 'None of the other five were taken.');
    assert.match(state().notifications.at(-1)!.title, /is editing this control/);
  } finally { stop(); }
});

test('releaseLocks drops only the caller’s locks for those clips and field', () => {
  const ids = state().clips.filter(c => c.projectId === state().projectId).slice(0, 4).map(c => c.id), project = state().projectId;
  const remote = { id: 'remote', userId: 'ashley', projectId: project, targetId: ids[0], field: 'x', expiresAt: Date.now() + LOCK_TTL };
  state().acquireLocks(ids.slice(0, 3), 'manipulation'); state().acquireLocks([ids[3]], 'speed');
  store.setState({ locks: [...state().locks, remote] });
  let updates = 0; const stop = store.subscribe(() => { updates++; });
  try {
    state().releaseLocks(ids, 'manipulation');
    assert.equal(updates, 1);
    assert.deepEqual(state().locks.map(l => `${l.targetId}:${l.field}`).sort(), [`${ids[3]}:speed`, `${ids[0]}:x`].sort(), 'Another field and a collaborator’s lock stay.');
    state().releaseLocks(ids, 'manipulation');
    assert.equal(updates, 1, 'Releasing what is not held changes nothing.');
  } finally { stop(); }
});

test('with a server, locks go out as one targetIds request, and a refusal rolls them back and says so', async () => {
  const { connection } = await import('../services/api.ts');
  const originalFetch = globalThis.fetch, was = connection.enabled, refresh = connection.refresh;
  const calls: { method: string; body: { projectId: string; targetIds: string[]; field: string } }[] = [];
  let answer = 200, refreshed = 0;
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    assert.equal(url, '/api/locks');
    calls.push({ method: String(options.method), body: JSON.parse(String(options.body)) });
    return new Response(JSON.stringify(answer === 200 ? { locks: [] } : { error: 'This control is being edited by a collaborator.' }), { status: answer, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  connection.enabled = true; connection.refresh = async () => { refreshed++; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  const ids = state().clips.filter(c => c.projectId === state().projectId).slice(0, 5).map(c => c.id);
  try {
    assert.equal(state().acquireLocks(ids, 'manipulation'), true);
    await settle();
    assert.equal(calls.length, 1, 'Five clips, one request.');
    assert.deepEqual(calls[0], { method: 'POST', body: { projectId: state().projectId, targetIds: ids, field: 'manipulation' } });
    state().acquireLocks(ids, 'manipulation'); await settle();
    assert.equal(calls.length, 2, 'The renewal is one request too.');

    state().releaseLocks([ids[0], ids[1], 'not-held'], 'manipulation'); await settle();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], { method: 'DELETE', body: { projectId: state().projectId, targetIds: [ids[0], ids[1]], field: 'manipulation' } }, 'Only what is held is sent.');
    state().releaseLocks(['not-held'], 'manipulation'); await settle();
    assert.equal(calls.length, 3, 'Nothing held, no request.');
    state().releaseLocks(ids, 'manipulation'); await settle();

    // The server refuses (a collaborator grabbed one first): the optimistic locks are rolled back, the user is told, state is refreshed.
    answer = 409; calls.length = 0;
    assert.equal(state().acquireLocks(ids, 'manipulation'), true, 'Optimistic until the server answers.');
    await settle();
    assert.deepEqual(calls.map(c => c.method), ['POST', 'DELETE']);
    assert.equal(state().locks.length, 0);
    assert.equal(state().notifications.at(-1)!.title, 'This control is being edited by a collaborator.');
    assert.equal(refreshed, 1);

    // Past the server's 2000-id limit a drag goes out in slices instead of failing.
    answer = 200; calls.length = 0;
    const many = Array.from({ length: 2500 }, (_, i) => `clip-${i}`);
    state().acquireLocks(many, 'manipulation'); await settle();
    assert.deepEqual(calls.map(c => [c.method, c.body.targetIds.length]), [['POST', 2000], ['POST', 500]]);
  } finally { globalThis.fetch = originalFetch; connection.enabled = was; connection.refresh = refresh; }
});

test('In/Out range is finite, ordered, bounded, remembered per timeline, and defaults to the edit length', () => {
  const saved = new Map<string, string>(), original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  const contentEnd = (timelineId: string) => Math.max(...state().clips.filter(c => c.timelineId === timelineId).map(c => c.start + c.duration));
  try {
    const projectId = state().projectId, timelineId = state().timelineId;
    state().setRange(-20, 240);
    assert.deepEqual([state().rangeIn, state().rangeOut], [0, 180]);
    state().setRange(90, 25);
    assert.deepEqual([state().rangeIn, state().rangeOut], [25, 90]);
    state().setRange(Number.NaN, 20);
    assert.deepEqual([state().rangeIn, state().rangeOut], [25, 90]);
    assert.equal(state().operations.length, 0);
    state().setTimeline('review-timeline');
    assert.deepEqual([state().rangeIn, state().rangeOut], [0, contentEnd('review-timeline')], 'An unmarked timeline exports its edit, not its padded length.');
    state().setRange(10, 20);
    state().openProject('the-long-way-home');
    assert.deepEqual([state().rangeIn, state().rangeOut], [0, contentEnd(state().timelineId)]);
    state().openProject(projectId);
    assert.equal(state().timelineId, timelineId);
    assert.deepEqual([state().rangeIn, state().rangeOut], [25, 90], 'Reopening restores the marks a reload used to drop.');
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete (globalThis as { localStorage?: unknown }).localStorage; }
});

test('revealing media validates project ownership and resets on navigation', () => {
  state().setWorkspace('color');
  state().revealMedia('m2');
  assert.equal(state().workspace, 'edit');
  assert.equal(state().revealedMediaId, 'm2');
  state().revealMedia(null);
  assert.equal(state().revealedMediaId, null);
  state().revealMedia('unknown-media');
  assert.equal(state().revealedMediaId, null);
  state().revealMedia('m2');
  state().openProject('the-long-way-home');
  assert.equal(state().revealedMediaId, null);
  state().revealMedia('m2');
  assert.equal(state().revealedMediaId, null);
});

test('split preserves media identity and source offsets and undoes atomically', () => {
  const original = structuredClone(clip());
  const originalNodes = state().nodes.length;
  state().setPlayhead(42);
  state().splitClip('c3');
  const right = clip(state().selectedClipId!);
  assert.equal(clip().duration, 12);
  assert.equal(right.start, 42);
  assert.equal(right.duration, 13);
  assert.equal(right.sourceIn, original.sourceIn + 12);
  assert.equal(right.mediaId, original.mediaId);
  assert.equal(state().nodes.length, originalNodes + 6);
  state().undo();
  assert.deepEqual(clip(), original);
  assert.equal(state().clips.some(item => item.id === right.id), false);
  assert.equal(state().nodes.length, originalNodes);
});

test('split selects only the right half, and after undo the clip splits again', () => {
  state().selectClip('c3');state().setPlayhead(42);state().splitClip('c3');
  const right=state().selectedClipId!;
  assert.deepEqual(state().selectedClipIds,[right]);
  state().undo();
  assert.equal(state().selectedClipId,null);assert.deepEqual(state().selectedClipIds,[]);
  state().selectClip('c3');assert.equal(state().selectedClipId,'c3');
  state().splitClip(state().selectedClipId!);
  assert.equal(clip().duration,12);assert.deepEqual(state().selectedClipIds,[state().selectedClipId]);
  // Undo that removes the primary hands it to a clip still selected, so ⌘B keeps working on what is highlighted.
  state().selectClips(['c3',state().selectedClipId!]);state().undo();
  assert.deepEqual(state().selectedClipIds,['c3']);assert.equal(state().selectedClipId,'c3');
});

test('AI grade inserts editable nodes before the output and undoes as one action', () => {
  const before = structuredClone(state().nodes);
  state().applyGrade([{ name: 'Warm balance', parameters: { temperature: 350 } }, { name: 'Skin protection', parameters: { saturation: -4 } }]);
  const chain = state().nodes.filter(node => node.clipId === 'c3');
  assert.equal(chain.at(-1)!.name, 'Output Trim');
  assert.equal(chain.at(-3)!.name, 'Warm balance');
  state().undo();
  assert.deepEqual(state().nodes, before);
});

test('new audio effect controls survive serialization and undo removes absent properties', () => {
  state().updateProperty('c11', 'EQ_Low cut', 90);
  assert.equal(clip('c11').properties['EQ_Low cut'], 90);
  // Exercise the serialized operation, as it will be read after a browser restart.
  store.setState({ operations: JSON.parse(JSON.stringify(state().operations)) });
  state().undo();
  assert.equal('EQ_Low cut' in clip('c11').properties, false);
  state().updateProperty('c11', 'EQ_enabled', true);
  assert.equal(clip('c11').properties.EQ_enabled, true);
});

test('moving and trimming reject invalid input and preserve timeline and source bounds', () => {
  state().moveClip('c3', Number.NaN);
  assert.equal(clip().start, 30);
  state().moveClip('c3', 999);
  assert.equal(clip().start + clip().duration, 180);
  state().trimClip('c3', -30, 999);
  assert.ok(clip().sourceIn >= 0);
  assert.ok(clip().start >= 0);
  assert.ok(clip().start + clip().duration <= 180);
  assert.ok(clip().sourceIn + clip().duration <= state().media.find(asset => asset.id === clip().mediaId)!.duration);
  state().updateProperty('c3', 'opacity', 400);
  assert.equal(clip().properties.opacity, 100);
  state().updateProperty('c3', 'cropLeft', 320);
  assert.equal(clip().properties.cropLeft, 320);
  state().updateProperty('c3', 'disabled', true);
  assert.equal(clip().disabled, true);
});

test('restoring snapshots preserves current state first and isolates other projects', () => {
  state().saveSnapshot('Keep this cut', 'Review');
  const saved = state().snapshots[0];
  state().updateProperty('c3', 'zoom', 140);
  state().openProject('the-long-way-home');
  const otherClips = structuredClone(state().clips.filter(clip => clip.projectId === 'the-long-way-home'));
  state().openProject('city-after-dark');
  state().releaseUserLocks('ashley');
  state().restoreSnapshot(saved.id);
  assert.equal(clip().properties.zoom, 105);
  assert.equal(state().snapshots[0].state.clips.find(clip => clip.id === 'c3')!.properties.zoom, 140);
  assert.match(state().snapshots[0].name, /Before restoring/);
  assert.deepEqual(state().clips.filter(clip => clip.projectId === 'the-long-way-home'), otherClips);
});

test('media renaming preserves timeline references, removal cannot break snapshots', () => {
  const mediaId = clip().mediaId;
  state().renameMedia(mediaId, 'Renamed source.mov');
  assert.equal(clip().mediaId, mediaId);
  assert.equal(state().media.find(asset => asset.id === mediaId)!.name, 'Renamed source.mov');
  state().removeMedia(mediaId);
  assert.ok(state().media.some(asset => asset.id === mediaId));
});

test('presence ticks and playback never create project operations', () => {
  const count = state().operations.length;
  const before = state().presence[0].cursor;
  state().setPlaying(true);
  state().tick(Date.now() + 1000);
  assert.equal(state().operations.length, count);
  assert.notDeepEqual(state().presence[0].cursor, before);
  state().setLiveMode('following', 'ashley');
  state().tick(Date.now() + 1250);
  assert.equal(state().playhead, state().presence.find(person => person.userId === 'ashley')!.playhead);
  state().setPlayhead(10);
  assert.equal(state().liveMode, 'independent');
});

test('new projects have isolated IDs and an editable empty timeline', () => {
  const id = state().createProject({ name: 'New film', description: 'A new story', shared: false });
  state().openProject(id);
  assert.equal(state().projectId, id);
  assert.equal(state().clips.filter(clip => clip.projectId === id).length, 0);
  assert.equal(state().tracks.filter(track => track.timelineId === state().timelineId).length, 6);
  state().createTrack('audio');
  assert.equal(state().tracks.filter(track => track.timelineId === state().timelineId).length, 7);
  const seeded = createDemoProject('another-demo');
  assert.ok(seeded.clips.every(clip => clip.id.startsWith('another-demo-')));
});

test('project duration and modification date follow primary timeline edits and undo', () => {
  const id = state().createProject({ name: 'Duration check', description: '', shared: false });
  state().openProject(id);
  const source = { ...baseline.media[0], id: 'new-project-media', projectId: id };
  store.setState({ media: [...state().media, source] });
  state().addMediaToTimeline(source.id);
  assert.equal(state().projects.find(project => project.id === id)!.duration, source.duration);
  state().moveClip(state().selectedClipId!, 20);
  assert.equal(state().projects.find(project => project.id === id)!.duration, source.duration + 20);
  store.setState({ projects: state().projects.map(project => project.id === id ? { ...project, modifiedAt: 1 } : project) });
  state().undo();
  assert.equal(state().projects.find(project => project.id === id)!.duration, source.duration);
  assert.ok(state().projects.find(project => project.id === id)!.modifiedAt > 1);
});

test('commenters can review but cannot modify picture', () => {
  state().setCurrentUser('maya');
  state().updateProperty('c3', 'speed', 200);
  assert.equal(clip().properties.speed, 100);
  state().addComment('Hold this shot.', { clipId: 'c3', range: [40, 42] });
  assert.equal(state().comments.at(-1)!.text, 'Hold this shot.');
  assert.deepEqual(state().comments.at(-1)!.range, [40, 42]);
});

test('mock media progresses through every preparation state and handles unsupported files', () => {
  let asset = mediaService.importFiles([new File(['demo'], 'night.mov', { type: 'video/quicktime' })], 'city-after-dark')[0];
  const observed = new Set([asset.status]);
  for (let second = 0; second < 40; second++) { asset = mediaService.advance(asset, 1); observed.add(asset.status); }
  assert.deepEqual([...observed], ['uploading', 'processing', 'proxy', 'waveform', 'thumbnails', 'ready']);
  assert.equal(asset.progress, 100);
  assert.equal(mediaService.importFiles([new File(['x'], 'notes.exe')], 'city-after-dark')[0].status, 'failed');
  const job = renderService.enqueue('city-after-dark', 'Review', 'YouTube', {}, false);
  assert.equal(renderService.advance(job, 100).status, 'complete');
});

test('render queue completes its active job and starts the next waiting job', () => {
  store.setState({ renderJobs: [] });
  state().enqueueRender('First export', 'YouTube', {});
  state().enqueueRender('Second export', 'Quick Export', {});
  assert.equal(state().renderJobs[0].status, 'waiting');
  assert.equal(state().renderJobs[1].status, 'rendering');
  const now = Date.now() + 60_000;
  for (let second = 0; second < 100; second++) state().tick(now + second * 1000);
  assert.equal(state().renderJobs[1].status, 'complete');
  assert.equal(state().renderJobs[0].status, 'rendering');
});

test('local storage is versioned, excludes presence, and rejects corrupt caches', () => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } });
  state().addScript('Cached');
  const { projects, media, timelines, clips, tracks, nodes, comments, operations, snapshots, renderJobs, users, currentUserId, settings, scripts, scriptBlocks, shots, boardItems } = state();
  projectService.save({ projects, media, timelines, clips, tracks, nodes, comments, operations, snapshots, renderJobs, users, currentUserId, settings, scripts, scriptBlocks, shots, boardItems });
  const raw = JSON.parse(memory.get(STORAGE_KEY)!);
  assert.equal(raw.version, 1);
  assert.equal('presence' in raw.state, false);
  assert.equal('locks' in raw.state, false);
  assert.deepEqual(projectService.load()!.clips, clips);
  assert.equal(projectService.load()!.scriptBlocks.length, 1, 'Plan history passes the cache check');
  memory.set(STORAGE_KEY, '{');
  assert.throws(() => projectService.load());
  memory.set(STORAGE_KEY, JSON.stringify({ version: 1, state: { clips: [] } }));
  assert.throws(() => projectService.load());
  delete (globalThis as { localStorage?: unknown }).localStorage;
});


test('speed, split and trim keep source offsets and comment attachments undo safely', () => {
  const original = structuredClone(clip());
  state().updateProperty(original.id, 'speed', 200);
  assert.equal(clip().duration, original.duration / 2);
  state().setPlayhead(clip().start + 1);
  state().splitClip(original.id);
  const right = clip(state().selectedClipId!);
  assert.equal(right.sourceIn, original.sourceIn + 2);
  state().trimClip(right.id, right.start + 1, right.duration - 1);
  assert.equal(clip(right.id).sourceIn, original.sourceIn + 4);
  state().addComment('Attached note', { clipId: right.id });
  const comment = state().comments.find(c=>c.text==='Attached note')!;
  state().deleteClip(right.id);
  assert.equal(state().comments.find(c=>c.id===comment.id)!.clipId, undefined);
  state().undo();
  assert.equal(state().comments.find(c=>c.id===comment.id)!.clipId, right.id);
  assert.ok(clip(right.id));
});

test('media drops honor track and frame position; effect edits and property drags undo', () => {
  const source = state().media.find(m => m.id === clip().mediaId)!;
  const videoTrack = state().tracks.find(t => t.id === clip().trackId)!;
  const audioTrack = state().tracks.find(t => t.timelineId === state().timelineId && t.kind === 'audio')!;
  const count = state().clips.length;
  state().addMediaToTimeline(source.id, 12.34, audioTrack.id);
  assert.equal(state().clips.length, count, 'Video drops cannot silently land on an audio track.');
  state().addMediaToTimeline(source.id, NaN, videoTrack.id);
  assert.equal(state().clips.length, count);
  state().addMediaToTimeline(source.id, 12.34, videoTrack.id);
  const added = clip(state().selectedClipId!);
  assert.equal(added.trackId, videoTrack.id);
  const fps = state().projects.find(p => p.id === state().projectId)!.fps;
  assert.equal(added.start, Math.round(12.34 * fps) / fps);
  state().undo(); assert.equal(state().clips.length, count);

  state().addEffect('c3', 'Vignette');
  const effect = clip().effects.at(-1)!;
  state().updateEffect('c3', effect.id, { amount: 200, enabled: false });
  assert.deepEqual(clip().effects.at(-1), { ...effect, amount: 100, enabled: false });
  state().updateEffect('c3', effect.id, { amount: NaN });
  assert.equal(clip().effects.at(-1)!.amount, 100);
  state().updateEffect('c3', effect.id, null);
  assert.ok(!clip().effects.some(e => e.id === effect.id));
  state().undo(); assert.equal(clip().effects.at(-1)!.enabled, false);
  state().undo(); assert.deepEqual(clip().effects.at(-1), effect);

  const x = clip().properties.x;
  state().updateProperty('c3', 'x', 10, 'one-pointer-gesture');
  state().updateProperty('c3', 'x', 20, 'one-pointer-gesture');
  state().updateProperty('c3', 'x', 30, 'one-pointer-gesture');
  state().undo(); assert.equal(clip().properties.x, x, 'One undo reverses the entire label drag.');
  store.setState({ locks: [{ id: 'remote-effect', userId: 'ashley', projectId: state().projectId, targetId: 'c3', field: 'effects', expiresAt: Date.now() + LOCK_TTL }] });
  state().updateEffect('c3', effect.id, null);
  assert.ok(clip().effects.some(e => e.id === effect.id), 'Effect removal respects collaborator ownership.');
});

test('overwrite splits source timing, preserves grading and undoes the entire placement', () => {
  const source = structuredClone(clip());
  const moving = { ...structuredClone(source), id: 'overwrite', start: 100, duration: 5, sourceIn: 0 };
  store.setState({ clips: [source, moving], comments: [], nodes: state().nodes.filter(node => node.clipId === source.id) });
  const original = structuredClone({ clips: state().clips, nodes: state().nodes });
  state().moveClip(moving.id, 40);
  assert.equal(clip().duration, 10);
  const right = state().clips.find(c => c.id !== source.id && c.id !== moving.id)!;
  assert.deepEqual([right.start, right.duration, right.sourceIn], [45, 10, source.sourceIn + 15]);
  assert.equal(state().nodes.filter(node => node.clipId === right.id).length, original.nodes.length);
  state().moveClip(moving.id, 100);
  assert.equal(clip().duration, 10, 'Moving back does not resurrect overwritten material.');
  state().undo(); state().undo();
  assert.deepEqual(state().clips, original.clips); assert.deepEqual(state().nodes, original.nodes);
  store.setState({ locks: [{ id: 'protected', userId: 'ashley', projectId: source.projectId, targetId: source.id, field: 'effects', expiresAt: Date.now()+LOCK_TTL }] });
  state().moveClip(moving.id, 40);
  assert.deepEqual(state().clips, original.clips, 'A locked target rejects the whole overwrite.');
});

test('published history is never coalesced and effect instances stay independent', async () => {
  const { sealHistory } = await import('./store.ts');
  state().updateProperty('c3', 'x', 10, 'long-drag');
  const published = structuredClone(state().operations[0]);
  sealHistory(state().operations);
  state().updateProperty('c3', 'x', 20, 'long-drag');
  assert.deepEqual(state().operations.find(op => op.id === published.id), published);
  assert.equal(state().operations.length, 2);
  state().addEffect('c3', 'Gaussian blur');state().addEffect('c3', 'Gaussian blur');
  const [first, second] = clip().effects.slice(-2);
  state().updateEffect('c3', first.id, { parameters: { radius: 25 } });
  assert.equal(clip().effects.find(e=>e.id===first.id)!.parameters!.radius,25);
  assert.equal(clip().effects.find(e=>e.id===second.id)!.parameters,undefined);
  state().updateEffect('c3', first.id, { parameters: { radius: NaN } });
  assert.equal(clip().effects.find(e=>e.id===first.id)!.parameters!.radius,25);
  state().reorderEffect('c3',second.id,-1);
  assert.equal(clip().effects.at(-1)!.id,first.id);
  state().undo();assert.equal(clip().effects.at(-1)!.id,second.id);
});

test('Depth starts at full Mix, a clip takes one, and a preset-sized change is one undo', () => {
  const before = clip().effects.length;
  state().addEffect('c3', 'Depth'); state().addEffect('c3', 'Depth');
  const depth = clip().effects.filter(e => e.name === 'Depth');
  assert.equal(depth.length, 1); assert.equal(depth[0].amount, 100); assert.equal(clip().effects.length, before + 1);
  state().updateEffect('c3', depth[0].id, { amount: 100, parameters: { blur: 55, range: 12, fog: 0 } });
  assert.equal(clip().effects.find(e => e.id === depth[0].id)!.parameters!.blur, 55);
  state().undo();
  assert.equal(clip().effects.find(e => e.id === depth[0].id)!.parameters, undefined);
  state().updateEffect('c3', depth[0].id, null);
});

test('Depth: the map shows only where it was added, and first Lens blur takes Focus from the frame centre in the same undo step', () => {
  state().addEffect('c3', 'Depth');
  const effect = () => clip().effects.find(e => e.name === 'Depth')!, id = effect().id;
  assert.equal(depthUi.showMap(effect()), true, 'on in the browser that added it');
  assert.equal(depthUi.showMap({ id: 'a collaborator added this one' }), false, 'off for an effect added elsewhere');
  // The frame on screen: near (white) at the centre.
  rememberDepth('c3', { pixels: { data: new Uint8Array([25, 230, 25, 25, 230, 25]), width: 3, height: 2, key: 'x' }, near: .9, far: .1 });
  state().updateEffect('c3', id, { parameters: { blur: 40 } });
  assert.equal(effect().parameters!.focus, 0, 'Focus from the centre depth');
  state().undo();
  assert.equal(effect().parameters?.focus, undefined, 'one undo removes both');
  state().redo();
  assert.equal(effect().parameters!.focus, 0);
  state().updateEffect('c3', id, { parameters: { blur: 0 } }); state().updateEffect('c3', id, { parameters: { blur: 60 } });
  assert.equal(effect().parameters!.focus, 0, 'a Focus already set is kept');
  state().updateEffect('c3', id, null);
});

test('addEffect with reveal false adds the effect and leaves the panels alone (the Color page adds Noise Reduction in place)', () => {
  store.setState({ sidePanel: 'history', inspectorTab: 'Video' });
  state().addEffect('c3', 'Noise Reduction', false);
  const noise = clip().effects.find(e => e.name === 'Noise Reduction')!;
  assert.ok(noise); assert.equal(state().sidePanel, 'history'); assert.equal(state().inspectorTab, 'Video');
  state().updateEffect('c3', noise.id, null);
  store.setState({ sidePanel: 'inspector' });
});

test('picture effects stay off the audio half of a linked pair; its sound effects are still added', () => {
  const picture = clip('c3'), audio = state().tracks.find(t => t.kind === 'audio' && t.timelineId === picture.timelineId)!;
  store.setState({ clips: [...state().clips, { ...picture, id: 'c3-sound', trackId: audio.id, effects: [] }] });
  for (const name of ['Noise Reduction', 'Stabilize', 'Sharpen', 'Audio Noise Reduction']) state().addEffect('c3-sound', name, false);
  assert.deepEqual(clip('c3-sound').effects.map(e => e.name), ['Audio Noise Reduction']);
});

test('Depth subject: picks one of the clip\'s Smart Masks or none, undoably, and only a mask of this clip', () => {
  state().addEffect('c3', 'Smart Mask'); state().addEffect('c3', 'Depth');
  const mask = clip().smartMasks![0], depth = () => clip().effects.find(e => e.name === 'Depth')!;
  state().attachSmartMask('c3', mask.id, depth().id);
  assert.equal(depth().maskId, mask.id);
  state().updateEffect('c3', depth().id, { parameters: { followSubject: 1 } });
  assert.equal(depth().parameters!.followSubject, 1);
  state().attachSmartMask('c3', 'not-a-mask', depth().id);
  assert.equal(depth().maskId, mask.id, 'a mask the clip does not have is refused');
  state().attachSmartMask('c3', '', depth().id);
  assert.equal('maskId' in depth(), false, 'None clears the subject');
  state().undo();
  assert.equal(depth().maskId, mask.id, 'and one undo brings it back');
  const smart = clip().effects.find(e => e.name === 'Smart Mask')!;
  state().attachSmartMask('c3', '', smart.id);
  assert.equal(clip().effects.find(e => e.id === smart.id)!.maskId, mask.id, 'a Smart Mask effect always keeps a mask');
  for (const e of clip().effects.filter(e => e.name === 'Depth' || e.name === 'Smart Mask')) state().updateEffect('c3', e.id, null);
});

// A5: a Smart Mask picked as the Depth subject used to need a Smart Mask effect, which cut the clip out.
test('Depth: New subject adds a mask the Depth effect names, with no cutout, in one undo', () => {
  state().addEffect('c3', 'Depth');
  const depth = () => clip().effects.find(e => e.name === 'Depth')!, masks = clip().smartMasks?.length ?? 0, cutouts = () => clip().effects.filter(e => e.name === 'Smart Mask').length;
  const id = state().addSmartMask('c3', depth().id);
  assert.ok(id);
  assert.equal(clip().smartMasks!.length, masks + 1);
  assert.equal(depth().maskId, id);
  assert.equal(cutouts(), 0, 'the clip is not cut out');
  state().undo();
  assert.equal(clip().smartMasks?.length ?? 0, masks);
  assert.equal('maskId' in depth(), false, 'one undo removes the mask and the subject');
  assert.equal(state().addSmartMask('c3', 'not-a-target'), undefined, 'an unknown target adds nothing');
  assert.equal(clip().smartMasks?.length ?? 0, masks);
  state().updateEffect('c3', depth().id, null);
});

test('a color-wheel gesture undoes together without replacing another parameter',()=>{
  state().selectClip('c3');state().addNode('Wheel',{liftR:0,liftG:0,contrast:1});const id=state().selectedNodeId!;
  state().updateNode(id,{parameters:{liftR:.05,liftG:.02}},'wheel-drag');
  state().updateNode(id,{parameters:{liftR:.1,liftG:.03}},'wheel-drag');
  assert.equal(state().nodes.find(n=>n.id===id)!.parameters.contrast,1);
  state().undo();assert.equal(state().nodes.find(n=>n.id===id)!.parameters.liftR,0);assert.equal(state().nodes.find(n=>n.id===id)!.parameters.liftG,0);
});

test('one undo restores a whole color gesture across published saves and remote fields',async()=>{
  const {sealHistory}=await import('./store.ts');
  state().selectClip('c3');state().addNode('Wheel',{liftR:0,liftG:0,contrast:1});const id=state().selectedNodeId!;
  state().updateNode(id,{parameters:{liftR:.05,liftG:.02}},'published-wheel');sealHistory(state().operations);
  state().setCurrentUser('ashley');state().updateNode(id,{parameters:{contrast:1.2}});state().setCurrentUser('kyle');
  state().updateNode(id,{parameters:{liftR:.1,liftG:.06}},'published-wheel');sealHistory(state().operations);
  state().updateNode(id,{parameters:{liftR:.2,liftG:.1}},'published-wheel');
  state().undo();const node=state().nodes.find(n=>n.id===id)!;
  assert.equal(node.parameters.liftR,0);assert.equal(node.parameters.liftG,0);assert.equal(node.parameters.contrast,1.2);
  assert.ok(state().operations.filter(o=>o.gestureId==='published-wheel').every(o=>o.undone));
});

test('video inserts linked audio, edits atomically, and unlinks without reviving embedded audio',()=>{
  const asset={...state().media[0],hasAudio:true,duration:20,status:'ready' as const};
  store.setState({media:[asset],clips:[],nodes:[],comments:[],settings:{...state().settings,linkSelection:true}});
  state().addMediaToTimeline(asset.id,10);const video=state().clips.find(c=>state().tracks.find(t=>t.id===c.trackId)?.kind==='video')!,audio=state().clips.find(c=>c.id!==video.id)!;
  assert.equal(state().clips.length,2);assert.ok(video.properties.linkGroup);assert.equal(video.properties.linkGroup,audio.properties.linkGroup);assert.equal(video.properties.audioDetached,true);
  state().moveClip(audio.id,12);assert.equal(clip(video.id).start,12);assert.equal(clip(audio.id).start,12);
  state().trimClip(video.id,13,18);assert.equal(clip(audio.id).sourceIn,1);assert.equal(clip(audio.id).duration,18);
  state().updateProperty(video.id,'speed',200);assert.equal(clip(audio.id).properties.speed,200);assert.equal(clip(audio.id).duration,9);state().undo();
  state().setPlayhead(16);state().splitClip(video.id);assert.equal(state().clips.length,4);const right=clip(state().selectedClipId!);assert.notEqual(right.properties.linkGroup,video.properties.linkGroup);assert.equal(state().clips.filter(c=>c.properties.linkGroup===right.properties.linkGroup).length,2);
  state().deleteClip(right.id);assert.equal(state().clips.length,2);state().undo();assert.equal(state().clips.length,4);state().undo();assert.equal(state().clips.length,2);
  state().unlinkClip(video.id);assert.equal(clip(video.id).properties.linkGroup,undefined);assert.equal(clip(audio.id).properties.linkGroup,undefined);assert.equal(clip(video.id).properties.audioDetached,true);
  state().moveClip(audio.id,30);assert.equal(clip(video.id).start,13);state().undo();state().linkClip(video.id);assert.ok(clip(video.id).properties.linkGroup);
  state().duplicateClip(video.id);assert.equal(state().clips.length,4);const copies=state().clips.filter(c=>c.id!==video.id&&c.id!==audio.id);assert.equal(copies[0].properties.linkGroup,copies[1].properties.linkGroup);assert.notEqual(copies[0].properties.linkGroup,clip(video.id).properties.linkGroup);
  state().undo();store.setState({locks:[{id:'peer-lock',userId:'ashley',projectId:video.projectId,targetId:audio.id,field:'manipulation',expiresAt:Date.now()+10000}]});state().moveClip(video.id,50);assert.equal(clip(video.id).start,13);
});

test('splitting a video past the end of its linked audio cuts the video; the audio stays linked to the piece it sits under',()=>{
  const asset={...state().media[0],hasAudio:true,duration:20,status:'ready' as const};
  for(const [audioStart,audioSide] of [[10,'left'],[25,'right']] as const){
    store.setState({media:[asset],clips:[],nodes:[],comments:[],settings:{...state().settings,linkSelection:true}});
    state().addMediaToTimeline(asset.id,10);const video=state().clips.find(c=>state().tracks.find(t=>t.id===c.trackId)?.kind==='video')!,audio=state().clips.find(c=>c.id!==video.id)!;
    store.setState({clips:state().clips.map(c=>c.id===audio.id?{...c,start:audioStart,duration:2}:c)});
    state().setPlayhead(20);state().splitClip(video.id);
    assert.equal(state().clips.length,3);const right=clip(state().selectedClipId!),left=clip(video.id);
    assert.equal(left.duration,10);assert.equal(right.start,20);assert.equal(clip(audio.id).duration,2);
    const [withAudio,alone]=audioSide==='left'?[left,right]:[right,left];
    assert.ok(withAudio.properties.linkGroup);assert.equal(clip(audio.id).properties.linkGroup,withAudio.properties.linkGroup);assert.equal(alone.properties.linkGroup,undefined);
  }
});

test('cut and paste retain the linked soundtrack and correction nodes',()=>{
  const asset={...state().media[0],hasAudio:true,duration:10,status:'ready' as const};store.setState({media:[asset],clips:[],nodes:[],comments:[],settings:{...state().settings,linkSelection:true}});
  state().addMediaToTimeline(asset.id,0);const id=state().selectedClipId!;state().addNode('Grade',{exposure:.2});state().copyClip(id);state().deleteClip(id);assert.equal(state().clips.length,0);
  state().setPlayhead(20);state().pasteClip();assert.equal(state().clips.length,2);assert.equal(state().clips[0].start,20);assert.equal(state().clips[0].properties.linkGroup,state().clips[1].properties.linkGroup);assert.equal(state().nodes[0].parameters.exposure,.2);
});

test('title drops honor the chosen track and frame, and reject locked or invalid destinations',()=>{
  const track=state().tracks.find(t=>t.timelineId===state().timelineId&&t.kind==='video')!;
  store.setState({clips:[],nodes:[],comments:[]});
  state().addTitle(0,{}, {trackId:track.id,start:12.01});
  assert.equal(state().clips.length,1);assert.equal(state().clips[0].trackId,track.id);assert.equal(state().clips[0].start,12);
  state().addTitle(0,{}, {trackId:'missing',start:20});
  state().addTitle(0,{}, {trackId:track.id,start:NaN});
  state().updateTrack(track.id,{locked:true});
  state().addTitle(0,{}, {trackId:track.id,start:20});
  assert.equal(state().clips.length,1);
});


test('deleting an animated pen point remaps its neighbors; corner removes handle animation and both undo atomically',()=>{
  const doc={...defaultShape('pen'),points:[{x:0,y:0},{x:.3,y:.1},{x:.7,y:.8,inX:.5,inY:.7,outX:.9,outY:.8},{x:1,y:1}]};
  state().addShape('pen',doc);const id=state().selectedClipId!;
  const channel=(path:string,a:number,b:number):[string,Keyframe[]]=>[path,[{id:path+'-a',time:0,value:a,interpolation:'linear'},{id:path+'-b',time:2,value:b,interpolation:'linear'}]];
  const keyframes=Object.fromEntries([channel('shape.points.0.x',0,.1),channel('shape.points.1.x',.3,.4),channel('shape.points.2.x',.7,.8),channel('shape.points.2.inX',.5,.6),channel('shape.points.2.inY',.7,.6),channel('shape.points.2.outX',.9,.8),channel('shape.points.2.outY',.8,.9),channel('shape.points.3.y',1,.9),channel('shape.opacity',100,50)]);
  store.setState({clips:state().clips.map(c=>c.id===id?{...c,keyframes}:c),playhead:clip(id).start+1});
  const original=structuredClone(clip(id)),evaluated=getShape(evaluateClip(original,state().playhead));
  state().editShapePoint(id,1,'delete');
  assert.deepEqual(getShape(clip(id)).points,doc.points.filter((_,i)=>i!==1));
  assert.deepEqual(getShape(evaluateClip(clip(id),state().playhead)).points,evaluated.points.filter((_,i)=>i!==1));
  assert.deepEqual(clip(id).keyframes?.['shape.points.1.x'],keyframes['shape.points.2.x']);
  assert.deepEqual(clip(id).keyframes?.['shape.points.2.y'],keyframes['shape.points.3.y']);
  assert.deepEqual(clip(id).keyframes?.['shape.opacity'],keyframes['shape.opacity']);
  assert.ok(!Object.values(clip(id).keyframes!).flat().some(k=>k.id.startsWith('shape.points.1.x-')));
  assert.ok(!Object.keys(clip(id).keyframes!).some(p=>p.startsWith('shape.points.3.')));
  state().undo();assert.deepEqual(clip(id),original);
  state().editShapePoint(id,2,'corner');
  assert.deepEqual(getShape(clip(id)).points[2],{x:.7,y:.8});
  for(const time of [0,1,2]){const point=getShape(evaluateClip(clip(id),clip(id).start+time)).points[2];assert.equal(point.inX,undefined);assert.equal(point.outY,undefined);}
  assert.deepEqual(clip(id).keyframes?.['shape.points.2.x'],keyframes['shape.points.2.x']);
  assert.ok(!Object.keys(clip(id).keyframes!).some(p=>/^shape\.points\.2\.(in|out)[XY]$/.test(p)));
  state().undo();assert.deepEqual(clip(id),original);
});

/** The demo timeline has no touching clips, so a cut is arranged before each transition check. */
function adjacentPair() {
  const timelineId = state().timelineId;
  const left = state().clips.find(item => item.id === 'c7')!;
  const right = state().clips.find(item => item.id === 'c8')!;
  store.setState({
    clips: state().clips.map(item => item.id === right.id
      ? { ...item, trackId: left.trackId, timelineId, start: left.start + left.duration, transition: undefined, properties: { ...item.properties } }
      : item),
  });
  return { left: state().clips.find(item => item.id === left.id)!, right: state().clips.find(item => item.id === right.id)! };
}

test('applying a transition never moves a clip, and undo removes it cleanly', () => {
  const { right: pair } = adjacentPair();
  const before = state().clips.map(item => ({ id: item.id, start: item.start, duration: item.duration, trackId: item.trackId }));

  state().addTransition(pair.id, 'in', 'Cross dissolve');
  const applied = state().clips.find(item => item.id === pair.id)!;
  assert.equal(applied.transition, 'Cross dissolve');
  assert.equal(applied.properties.transitionAlign, 'center');
  assert.ok(Number(applied.properties.transitionDuration) > 0);
  assert.deepEqual(state().clips.map(item => ({ id: item.id, start: item.start, duration: item.duration, trackId: item.trackId })), before,
    'A transition borrows handles; no clip start, duration or track may change.');
  assert.equal(state().inspectorTab, 'Transition');
  assert.deepEqual(state().selectedTransition, { clipId: pair.id, side: 'in' });

  state().updateTransition(pair.id, 'in', { duration: .5, align: 'out' });
  assert.equal(state().clips.find(item => item.id === pair.id)!.properties.transitionDuration, .5);
  assert.equal(state().clips.find(item => item.id === pair.id)!.properties.transitionAlign, 'out');

  state().removeTransition(pair.id, 'in');
  const cleared = state().clips.find(item => item.id === pair.id)!;
  assert.ok(!cleared.transition);
  for (const key of ['transitionDuration', 'transitionAlign', 'transitionCurve', 'transitionParams']) assert.equal(cleared.properties[key], undefined, `${key} must be cleared with the transition.`);
  assert.equal(state().selectedTransition, null);
  assert.deepEqual(state().clips.map(item => ({ id: item.id, start: item.start, duration: item.duration, trackId: item.trackId })), before);
});

test('a transition is refused where it cannot be rendered, with a reason', () => {
  const { right: pair } = adjacentPair();
  store.setState({ notifications: [] });
  state().addTransition(pair.id, 'in', 'Not a transition');
  assert.ok(!state().clips.find(item => item.id === pair.id)!.transition, 'An unknown name is never stored.');

  const audio = state().clips.find(item => state().tracks.find(track => track.id === item.trackId)?.kind === 'audio')!;
  state().addTransition(audio.id, 'in', 'Cross dissolve');
  assert.ok(!state().clips.find(item => item.id === audio.id)!.transition, 'Picture transitions do not apply to audio clips.');
  assert.ok(state().notifications.some(item => /video clips/i.test(item.title)));

  // A tail transition needs an empty tail; the cut here already has a following clip.
  const { left } = adjacentPair();
  store.setState({ notifications: [] });
  state().addTransition(left.id, 'out', 'Dip to black');
  assert.ok(!state().clips.find(item => item.id === left.id)!.properties.transitionOut);
  assert.ok(state().notifications.some(item => /already has a following clip/i.test(item.title)));
});

test('expanding a light leak\u2019s sound creates one editable audio clip and mutes the embedded copy', () => {
  const { right: pair } = adjacentPair();
  store.setState({ leaks: [{ id: 'leak-1', name: 'Leak 1', url: '/api/transitions/leak-1.mp4', duration: 1, fps: 24, hasAudio: true }] });
  state().addTransition(pair.id, 'in', 'Light leak', { params: { leak: 'leak-1', leakGain: -6 } });
  assert.equal(state().clips.find(item => item.id === pair.id)!.transition, 'Light leak');
  const audioBefore = state().clips.filter(item => state().tracks.find(track => track.id === item.trackId)?.kind === 'audio').length;

  state().expandTransitionAudio(pair.id, 'in');
  const owner = state().clips.find(item => item.id === pair.id)!;
  const audioId = String(owner.properties.transitionAudioId ?? '');
  assert.ok(audioId, 'The transition records which clip now carries its sound.');
  const created = state().clips.find(item => item.id === audioId)!;
  assert.ok(created, 'Expanding must create a real, editable clip.');
  assert.equal(created.mediaId, 'frameline-leak:leak-1', 'The clip points at the shared pack through a reserved media id, the way titles and shapes do.');
  assert.equal(created.properties.gain, -6, 'The clip starts at the level the transition was playing it.');
  assert.equal(state().tracks.find(track => track.id === created.trackId)?.kind, 'audio');
  assert.equal(state().clips.filter(item => state().tracks.find(track => track.id === item.trackId)?.kind === 'audio').length, audioBefore + 1);

  // A second call must not stack duplicate copies of the same sound.
  state().expandTransitionAudio(pair.id, 'in');
  assert.equal(state().clips.filter(item => item.mediaId === 'frameline-leak:leak-1').length, 1);
});

test('a deleted transition sound can be expanded again', () => {
  const { right: pair } = adjacentPair();
  store.setState({ leaks: [{ id: 'leak-1', name: 'Leak 1', url: '/api/transitions/leak-1.mp4', duration: 1, fps: 24, hasAudio: true }] });
  state().addTransition(pair.id, 'in', 'Light leak', { params: { leak: 'leak-1' } });
  state().expandTransitionAudio(pair.id, 'in');
  const first = String(state().clips.find(item => item.id === pair.id)!.properties.transitionAudioId);
  state().deleteClip(first);
  store.setState({ notifications: [] });

  // The stale pointer must not block a second expansion, or the sound is lost for good.
  state().expandTransitionAudio(pair.id, 'in');
  const second = String(state().clips.find(item => item.id === pair.id)!.properties.transitionAudioId ?? '');
  assert.ok(second && second !== first, 'A new sound clip is created after the old one was deleted.');
  assert.ok(state().clips.some(item => item.id === second));
});

test('undo names the action it reversed', () => {
  state().updateProperty('c3', 'speed', 112);
  const description = state().operations[0].description;
  state().undo();
  assert.equal(state().notifications.at(-1)!.title, `Undone: ${description}`);
});

test('moving a track swaps its number with the on-screen neighbour, per kind', () => {
  const lane = (kind: 'video' | 'audio', number: number) => state().tracks.find(t => t.timelineId === state().timelineId && t.kind === kind && t.number === number)!;
  const video = lane('video', 1), audio = lane('audio', 1);
  // Video lanes stack highest number first, so "up" means a higher number; audio is the reverse.
  state().moveTrack(video.id, 'up');
  assert.equal(state().tracks.find(t => t.id === video.id)!.number, 2);
  assert.equal(state().tracks.find(t => t.id === lane('video', 1).id)!.kind, 'video');
  state().moveTrack(audio.id, 'up');
  assert.equal(state().tracks.find(t => t.id === audio.id)!.number, 1, 'top audio lane cannot move up');
  state().moveTrack(audio.id, 'down');
  assert.equal(state().tracks.find(t => t.id === audio.id)!.number, 2);
  // Clips stay attached to their track through the renumbering.
  assert.ok(state().clips.every(c => state().tracks.some(t => t.id === c.trackId)));
  state().undo();
  assert.equal(state().tracks.find(t => t.id === audio.id)!.number, 1);
});

test('track height is clamped and coalesces a drag into one undo step', () => {
  const track = state().tracks.find(t => t.timelineId === state().timelineId)!;
  state().updateTrack(track.id, { height: 4 }, 'drag-1');
  assert.equal(state().tracks.find(t => t.id === track.id)!.height, 24);
  state().updateTrack(track.id, { height: 900 }, 'drag-1');
  assert.equal(state().tracks.find(t => t.id === track.id)!.height, 200);
  assert.equal(state().operations.length, 1, 'one gesture is one undo entry');
  state().undo();
  assert.equal(state().tracks.find(t => t.id === track.id)!.height, undefined);
});

test('deleting a track removes its clips, closes the numbering gap, and keeps the last lane', () => {
  const video = () => state().tracks.filter(t => t.timelineId === state().timelineId && t.kind === 'video').sort((a, b) => a.number - b.number);
  const target = video().find(t => state().clips.some(c => c.trackId === t.id))!;
  const above = video().filter(t => t.number > target.number).map(t => t.id);
  const doomed = state().clips.filter(c => c.trackId === target.id).map(c => c.id);
  assert.ok(doomed.length, 'pick a track that actually holds clips');
  state().deleteTrack(target.id);
  assert.ok(!state().tracks.some(t => t.id === target.id));
  assert.ok(!state().clips.some(c => doomed.includes(c.id)));
  assert.deepEqual(video().map(t => t.number), video().map((_, i) => i + 1), 'numbering has no gap');
  assert.ok(above.every(id => state().tracks.find(t => t.id === id)!.number >= 1));
  state().undo();
  assert.ok(state().tracks.some(t => t.id === target.id));
  assert.equal(state().clips.filter(c => doomed.includes(c.id)).length, doomed.length, 'clips come back with undo');
  // The last lane of a kind is refused rather than leaving a timeline with nowhere to drop media.
  for (const t of video().slice(1)) state().deleteTrack(t.id);
  const last = video();
  assert.equal(last.length, 1);
  state().deleteTrack(last[0].id);
  assert.equal(state().tracks.filter(t => t.timelineId === state().timelineId && t.kind === 'video').length, 1);
});


test('replacing an overlay uses its own peak and expanded sound follows the shifted window', () => {
  const { right } = adjacentPair();
  store.setState({ leaks: [17, 75].map(peak => ({ id: `leak-${peak}`, name: `Leak ${peak}`, url: `/leak-${peak}.mp4`, duration: 1, fps: 24, hasAudio: true, peakAt: peak / 100 })) });
  state().addTransition(right.id, 'in', 'Light leak', { duration: 1, params: { leak: 'leak-17' } });
  let owner = state().clips.find(item => item.id === right.id)!;
  assert.equal(JSON.parse(String(owner.properties.transitionParams)).blendPoint, 17);
  state().updateTransition(right.id, 'in', { params: { leak: 'leak-75' } });
  owner = state().clips.find(item => item.id === right.id)!;
  assert.equal(JSON.parse(String(owner.properties.transitionParams)).blendPoint, 75);
  assert.equal(owner.start, right.start);
  state().expandTransitionAudio(right.id, 'in');
  owner = state().clips.find(item => item.id === right.id)!;
  const sound = state().clips.find(item => item.id === owner.properties.transitionAudioId)!;
  assert.equal(sound.start, right.start - .75);
  assert.equal(sound.duration, 1);
});


test('source trims belong to one transition and carry into expanded audio', () => {
  const { right } = adjacentPair();
  store.setState({ leaks: [{ id: 'trim-leak', name: 'Trim leak', url: '/trim.mp4', duration: 3, fps: 24, hasAudio: true, peakAt: .5 }] });
  state().addTransition(right.id, 'in', 'Light leak', { duration: 1, params: { leak: 'trim-leak' } });
  state().updateTransition(right.id, 'in', { params: { leakIn: 1, leakOut: 2 } });
  let owner = state().clips.find(item => item.id === right.id)!;
  const params = JSON.parse(String(owner.properties.transitionParams));
  assert.equal(params.leakIn, 1); assert.equal(params.leakOut, 2); assert.equal(params.blendPoint, 50);
  assert.equal(state().leaks[0].duration, 3, 'The shared library source remains unchanged.');
  state().expandTransitionAudio(right.id, 'in'); owner = state().clips.find(item => item.id === right.id)!;
  const sound = state().clips.find(item => item.id === owner.properties.transitionAudioId)!;
  assert.equal(sound.sourceIn, 1); assert.ok(Math.abs(sound.duration - 1 / 3) < 1e-9); assert.ok(Math.abs(Number(sound.properties.speed) - 300) < 1e-9);
});


test('future overlay uses inherit the shared preset without changing existing transitions', () => {
  const { right } = adjacentPair();
  const params = { leak: 'preset-leak', leakIn: .2, leakOut: .8, blendPoint: 25, leakZoom: 110, blend: 'Screen' };
  store.setState({ transitionPresets: [{ id: 'overlay:preset-leak', name: 'Light leak', duration: .6, align: 'center', curve: [.2, 0, .8, 1], params }] });
  const before = structuredClone(state().clips);
  state().addTransition(right.id, 'in', 'Light leak', { params: { leak: 'preset-leak' } });
  const added = state().clips.find(clip => clip.id === right.id)!;
  assert.equal(added.properties.transitionDuration, .6);
  assert.deepEqual(JSON.parse(String(added.properties.transitionParams)), params);
  assert.equal(added.properties.transitionCurve, '0.2,0,0.8,1');
  assert.deepEqual(state().clips.filter(clip => clip.id !== right.id), before.filter(clip => clip.id !== right.id));
});

test('wide-gamut grade, node layout, effect stack and point edits survive undo without changing clip timing',()=>{
  const original=structuredClone(clip()),old=state().nodes.filter(n=>n.clipId==='c3');
  state().initializeColorGrade('c3');
  let nodes=state().nodes.filter(n=>n.clipId==='c3').sort((a,b)=>a.order!-b.order!);
  assert.equal(nodes.length,4);assert.equal(clip().properties.colorPipeline,'nodes-v2');assert.equal(clip().start,original.start);
  assert.equal(nodes[0].effects![0].type,'cst');assert.equal(state().snapshots[0].state.nodes.filter(n=>n.clipId==='c3').length,old.length);
  const id=nodes[1].id;state().updateNode(id,{position:{x:320,y:160}},'move');state().updateNode(id,{position:{x:410,y:200}},'move');state().undo();assert.deepEqual(state().nodes.find(n=>n.id===id)!.position,{x:230,y:80});
  state().selectNode(id);state().addNode('Extra',{exposure:1});nodes=state().nodes.filter(n=>n.clipId==='c3').sort((a,b)=>a.order!-b.order!);assert.equal(nodes[2].name,'Extra');
  state().moveColorNode(nodes[2].id,nodes[1].id);nodes=state().nodes.filter(n=>n.clipId==='c3').sort((a,b)=>a.order!-b.order!);assert.equal(nodes[1].name,'Extra');
  const params=nodes.map(n=>n.parameters);state().arrangeColorNodes('c3');assert.deepEqual(state().nodes.filter(n=>n.clipId==='c3').sort((a,b)=>a.order!-b.order!).map(n=>n.parameters),params);
  state().updateNode(id,{curves:{RGB:{mode:'smooth',points:[{id:'a',x:0,y:0},{id:'b',x:.3,y:.2},{id:'c',x:1,y:1}]}}},'curve');assert.equal(state().nodes.find(n=>n.id===id)!.curves!.RGB!.points.length,3);state().undo();assert.equal(state().nodes.find(n=>n.id===id)!.curves,undefined);
  state().removeNode(id);assert.ok(!state().nodes.some(n=>n.id===id));assert.equal(clip().duration,original.duration);state().undo();assert.ok(state().nodes.some(n=>n.id===id));
});

test('timeline format updates the active project without retiming clips and rejects invalid or read-only edits', () => {
  const before = state().clips;
  assert.equal(state().setTimelineFormat(1080, 1920, 29.97), true);
  assert.equal(state().projects.find(p => p.id === state().projectId)!.resolution, '1080 × 1920');
  assert.equal(state().projects.find(p => p.id === state().projectId)!.fps, 29.97);
  assert.equal(state().clips, before);
  const projects = state().projects;
  for (const values of [[0, 1080, 24], [1920.5, 1080, 24], [1920, 9000, 24], [1920, 1080, NaN], [1920, 1080, 241]]) {
    assert.equal(state().setTimelineFormat(values[0], values[1], values[2]), false);
    assert.equal(state().projects, projects);
  }
  store.setState({ currentUserId: 'non-editor' });
  assert.equal(state().setTimelineFormat(1920, 1080, 24), false);
  assert.equal(state().projects, projects);
});

test('grade paste replaces the look, nodes and grade animation without inserting or retiming clips; undo restores it',()=>{
  const source=clip('c3'),target=state().clips.find(c=>c.projectId===source.projectId&&c.id!==source.id&&state().tracks.find(t=>t.id===c.trackId)?.kind==='video')!;
  state().updateProperty(source.id,'resolveLookUrl',`/api/projects/${source.projectId}/resolve/source.cube`);
  state().updateProperty(source.id,'bypassResolveLook',true);
  state().selectClip(source.id);state().addNode('Copied look',{exposure:1});
  const node=state().nodes.find(n=>n.id===state().selectedNodeId)!;
  state().setKeyframes(source.id,`nodes.${node.id}.parameters.exposure`,[{id:'grade-key',time:0,value:.5,interpolation:'linear'}]);
  state().initializeColorGrade(target.id);
  const before=structuredClone({clips:state().clips,nodes:state().nodes});
  state().copyGrade(source.id);state().pasteGrade(target.id);
  const pasted=clip(target.id),nodes=state().nodes.filter(n=>n.clipId===target.id);
  assert.equal(state().clips.length,before.clips.length);
  assert.deepEqual([pasted.start,pasted.duration,pasted.sourceIn,pasted.mediaId],[target.start,target.duration,target.sourceIn,target.mediaId]);
  assert.equal(pasted.properties.resolveLookUrl,clip(source.id).properties.resolveLookUrl);
  assert.equal(pasted.properties.bypassResolveLook,true);assert.equal(pasted.properties.colorPipeline,undefined);
  assert.deepEqual(nodes.map(n=>n.name),state().nodes.filter(n=>n.clipId===source.id).map(n=>n.name));
  const copied=nodes.find(n=>n.name==='Copied look')!;assert.notEqual(copied.id,node.id);
  assert.ok(pasted.keyframes?.[`nodes.${copied.id}.parameters.exposure`]);
  state().undo();assert.deepEqual(state().clips,before.clips);assert.deepEqual([...state().nodes].sort((a,b)=>a.id.localeCompare(b.id)),before.nodes.sort((a,b)=>a.id.localeCompare(b.id)));
  store.setState({currentUserId:'non-editor'});state().pasteGrade(target.id);assert.deepEqual(state().clips,before.clips);
});

test('grade paste carries Noise Reduction: the source\'s replaces the target\'s, with a new id and without the old keyframes',()=>{
  const source=clip('c3'),target=state().clips.find(c=>c.projectId===source.projectId&&c.id!==source.id&&state().tracks.find(t=>t.id===c.trackId)?.kind==='video'&&state().media.find(m=>m.id===c.mediaId)?.kind==='video')!;
  state().addEffect(source.id,'Noise Reduction');const noise=clip(source.id).effects.find(e=>e.name==='Noise Reduction')!;
  state().updateEffect(source.id,noise.id,{amount:70,parameters:{frames:3}});
  state().addEffect(target.id,'Noise Reduction');const old=clip(target.id).effects.find(e=>e.name==='Noise Reduction')!;
  state().setKeyframes(target.id,`effects.${old.id}.amount`,[{id:'nr-key',time:0,value:20,interpolation:'linear'}]);
  const before=structuredClone(state().clips);
  state().copyGrade(source.id);state().pasteGrade(target.id);
  const pasted=clip(target.id).effects.filter(e=>e.name==='Noise Reduction');
  assert.equal(pasted.length,1);assert.notEqual(pasted[0].id,noise.id);assert.notEqual(pasted[0].id,old.id);
  assert.deepEqual([pasted[0].amount,pasted[0].parameters],[70,{frames:3}]);
  assert.ok(!Object.keys(clip(target.id).keyframes??{}).some(k=>k.startsWith(`effects.${old.id}.`)));
  state().undo();assert.deepEqual(state().clips,before);
});

test('grade paste onto a clip with two legacy Noise Reductions keeps one, in the first one\'s place, with an id of its own',()=>{
  const source=clip('c3'),target=state().clips.find(c=>c.projectId===source.projectId&&c.id!==source.id&&state().tracks.find(t=>t.id===c.trackId)?.kind==='video'&&state().media.find(m=>m.id===c.mediaId)?.kind==='video')!;
  state().addEffect(source.id,'Noise Reduction');
  const legacy=(id:string)=>({id,name:'Noise Reduction',enabled:true,amount:40});
  store.setState({clips:state().clips.map(c=>c.id===target.id?{...c,effects:[{id:'sharp',name:'Sharpen',enabled:true,amount:20},legacy('legacyA'),{id:'grain',name:'Film grain',enabled:true,amount:10},legacy('legacyB')]}:c)});
  state().copyGrade(source.id);state().pasteGrade(target.id);
  const effects=clip(target.id).effects;
  assert.deepEqual(effects.map(e=>e.name),['Sharpen','Noise Reduction','Film grain']);
  assert.equal(new Set(effects.map(e=>e.id)).size,effects.length);assert.ok(!['legacyA','legacyB'].includes(effects[1].id));
});

test('restoring a DaVinci LUT removes conflicting CSTs and is undoable',()=>{
  state().updateProperty('c3','resolveLookUrl','/api/projects/p1/resolve/source.cube');state().initializeColorGrade('c3');
  const before=structuredClone({clip:clip(),nodes:state().nodes});
  state().restoreResolveGrade('c3');assert.equal(clip().properties.colorPipeline,'legacy');assert.equal(clip().properties.bypassResolveLook,false);assert.equal(state().nodes.filter(n=>n.clipId==='c3').length,0);
  state().undo();assert.deepEqual(clip(),before.clip);assert.equal(state().nodes.length,before.nodes.length);
});

test('Smart Mask creation, corrections and node sharing are undoable', () => {
  state().addEffect('c3', 'Smart Mask');
  const effect = clip().effects.at(-1)!;
  const mask = clip().smartMasks![0];
  assert.equal(effect.maskId, mask.id);
  assert.equal(effect.amount, 100);
  const prompt = { id: 'prompt-test', time: mask.range.start, kind: 'include' as const, radius: .01, points: [{ x: .5, y: .5 }] };
  state().updateSmartMask('c3', mask.id, { prompts: [prompt] });
  assert.equal(clip().smartMasks![0].prompts.length, 1);
  state().undo();
  assert.equal(clip().smartMasks![0].prompts.length, 0);
  const node = state().nodes.find(n => n.clipId === 'c3')!;
  state().attachSmartMask('c3', mask.id, node.id);
  assert.equal(nodeMaskId(state().nodes.find(n => n.id === node.id)!), mask.id);
  state().updateNode(node.id,{mask:undefined});
  assert.equal(state().nodes.find(n=>n.id===node.id)!.mask,undefined);
  assert.equal(clip().smartMasks![0].id,mask.id);
  state().undo();
  assert.equal(nodeMaskId(state().nodes.find(n=>n.id===node.id)!),mask.id);
});

test('Smart Mask rejects invalid prompts and obeys clip locks', () => {
  state().addEffect('c3', 'Smart Mask');
  const mask = clip().smartMasks![0];
  state().updateSmartMask('c3', mask.id, { prompts: [{ id: 'bad', time: 0, kind: 'include', radius: .01, points: [{ x: 2, y: 0 }] }] });
  assert.equal(clip().smartMasks![0].prompts.length, 0);
  store.setState({locks:[{id:'mask-lock',userId:'ashley',projectId:clip().projectId,targetId:'c3',field:'smartMasks',expiresAt:Date.now()+LOCK_TTL}]});
  state().updateSmartMask('c3',mask.id,{name:'Blocked'});
  assert.equal(clip().smartMasks![0].name,mask.name);
});

test('copied grade does not carry subject masks onto unrelated footage', () => {
  state().addSmartMask('c3',state().nodes.find(n=>n.clipId==='c3')!.id);
  state().copyGrade('c3');
  const target=state().clips.find(c=>c.mediaId!==clip().mediaId&&c.timelineId===clip().timelineId)!;
  state().pasteGrade(target.id);
  assert.ok(state().nodes.filter(n=>n.clipId===target.id).every(n=>!n.mask));
});

test('a depth key on a node is one undoable edit, is validated, and travels with a pasted grade', () => {
  const node = state().nodes.find(n => n.clipId === 'c3')!, key = { source: 'depth' as const, enabled: true, invert: false, amount: 100, near: 50, far: 100, softness: 10 };
  state().updateNode(node.id, { mask: key });
  assert.deepEqual(state().nodes.find(n => n.id === node.id)!.mask, key);
  state().updateNode(node.id, { mask: { ...key, far: 20 } });
  assert.deepEqual(state().nodes.find(n => n.id === node.id)!.mask, key, 'far before near is refused');
  state().updateNode(node.id, { mask: { ...key, near: 60 } });
  state().undo();
  assert.deepEqual(state().nodes.find(n => n.id === node.id)!.mask, key);
  // Unlike a subject, the key reads the target's own depth, so it survives a paste onto other footage.
  state().copyGrade('c3');
  const target = state().clips.find(c => c.mediaId !== clip().mediaId && c.timelineId === clip().timelineId)!;
  state().pasteGrade(target.id);
  assert.ok(state().nodes.some(n => n.clipId === target.id && n.mask?.source === 'depth' && n.mask.near === 50));
});

test('duplicated Smart Mask intent is independent and same-source grade paste remaps its binding', () => {
  state().addEffect('c3','Smart Mask');
  const original=clip().smartMasks![0];
  state().duplicateClip('c3');
  const duplicate=state().clips.find(c=>c.id===state().selectedClipId)!;
  state().updateSmartMask(duplicate.id,original.id,{name:'Independent'});
  assert.equal(clip().smartMasks![0].name,'Subject');
  assert.equal(state().clips.find(c=>c.id===duplicate.id)!.smartMasks![0].name,'Independent');
  state().attachSmartMask('c3',original.id,state().nodes.find(n=>n.clipId==='c3')!.id);
  state().copyGrade('c3');state().pasteGrade(duplicate.id);
  const copiedMask=nodeMaskId(state().nodes.find(n=>n.clipId===duplicate.id&&n.mask)!);
  assert.ok(copiedMask);assert.notEqual(copiedMask,original.id);
  assert.ok(state().clips.find(c=>c.id===duplicate.id)!.smartMasks!.some(m=>m.id===copiedMask));
});

test('undoing a grade paste never takes a mask a collaborator has since made the Depth subject', () => {
  state().addEffect('c3','Smart Mask');
  state().duplicateClip('c3');
  const duplicate=state().clips.find(c=>c.id===state().selectedClipId)!;
  state().copyGrade('c3');state().pasteGrade(duplicate.id);
  const pasted=clip(duplicate.id).smartMasks!.at(-1)!;
  state().setCurrentUser('ashley');
  state().addEffect(duplicate.id,'Depth');
  const depth=clip(duplicate.id).effects.find(e=>e.name==='Depth')!;
  state().attachSmartMask(duplicate.id,pasted.id,depth.id);
  assert.equal(clip(duplicate.id).effects.find(e=>e.id===depth.id)!.maskId,pasted.id);
  state().setCurrentUser('kyle');
  state().undo();
  assert.ok(clip(duplicate.id).smartMasks!.some(m=>m.id===pasted.id),'the paste stays: the subject keeps its mask, so saves keep working');
});

test('a trim stops at the neighbour, and the drag preview clamps exactly where the commit does', () => {
  const neighbour = structuredClone(clip('c4'));
  assert.deepEqual(state().fitTrim('c3', 30, 40), { start: 30, duration: 35 });
  state().trimClip('c3', 30, 40);
  assert.equal(clip().duration, 35, 'the right edge stops at the neighbour instead of overwriting it');
  assert.deepEqual([clip('c4').start, clip('c4').duration], [neighbour.start, neighbour.duration]);
  assert.deepEqual(state().fitTrim('c3', 10, 55), { start: 23, duration: 42 });
  state().trimClip('c3', 10, 55);
  assert.deepEqual([clip().start, clip().duration], [23, 42], 'the left edge stops where the source handle runs out');
});

test('closing a gap carries the linked audio with the picture', () => {
  const source = clip('c7');
  const head = { ...structuredClone(source), id: 'head', start: 0, duration: 10 };
  const video = { ...structuredClone(source), id: 'picture', start: 40, duration: 10, properties: { ...source.properties, linkGroup: 'pair' } };
  const audio = { ...structuredClone(video), id: 'sound', trackId: 'a1' };
  store.setState({ clips: [head, video, audio], nodes: [], comments: [], settings: { ...state().settings, linkSelection: true } });
  state().deleteGap(source.trackId, 10, 40);
  assert.equal(clip('picture').start, 10);
  assert.equal(clip('sound').start, 10, 'linked audio follows the picture instead of losing sync');
  state().undo();
  assert.deepEqual([clip('picture').start, clip('sound').start], [40, 40]);
});

test('delete gaps closes common gaps between the selection, keeps sync, leaves a music bed, and undoes once', () => {
  const source = clip('c7'), at = (id: string, trackId: string, start: number, duration: number, linkGroup?: string) => ({ ...structuredClone(source), id, trackId, start, duration, properties: { ...source.properties, ...(linkGroup ? { linkGroup } : {}) } });
  const timelineId = state().timelineId;
  store.setState({ clips: [at('x1', 'v1', 0, 10, 'p1'), at('y1', 'a1', 0, 10, 'p1'), at('x2', 'v1', 15, 5), at('x3', 'v1', 30, 10, 'p3'), at('y3', 'a1', 30, 10, 'p3'), at('title', 'v3', 32, 2), at('music', 'a2', 0, 40)],
    nodes: [], comments: [], settings: { ...state().settings, linkSelection: true },
    timelines: state().timelines.map(t => t.id === timelineId ? { ...t, markers: [{ time: 12, name: 'In gap', color: 'Blue' }, { time: 35, name: 'On x3', color: 'Red' }] } : t) });
  state().deleteGaps(['x1', 'x2', 'x3']);
  assert.deepEqual(['x1', 'x2', 'x3', 'y1', 'y3'].map(id => clip(id).start), [0, 10, 15, 0, 15], 'picture and its linked audio close together');
  assert.equal(clip('title').start, 17, 'a title over the moved picture rides along');
  assert.equal(clip('music').start, 0, 'a music bed under the gaps stays put');
  assert.match(state().notifications.at(-1)!.detail ?? '', /Music/);
  const markers = state().timelines.find(t => t.id === timelineId)!.markers!;
  assert.deepEqual(markers.map(m => m.time), [10, 20], 'markers follow the content they sit on');
  assert.equal(state().operations.length, 1);
  state().undo();
  assert.deepEqual(['x2', 'x3', 'y3', 'title'].map(id => clip(id).start), [15, 30, 30, 32]);
  assert.deepEqual(state().timelines.find(t => t.id === timelineId)!.markers!.map(m => m.time), [12, 35]);
  state().deleteGaps(['x2']);
  assert.match(state().notifications.at(-1)!.title, /two or more/);
  state().deleteGaps(['x1']);
  assert.match(state().notifications.at(-1)!.title, /No gaps/, 'a linked pair has nothing between it');
});

test('markers add, move, copy, paste and delete as undoable edits that never undo a clip edit instead', () => {
  const timelineId = state().timelineId, markers = () => state().timelines.find(t => t.id === timelineId)!.markers ?? [];
  store.setState({ timelines: state().timelines.map(t => t.id === timelineId ? { ...t, markers: [] } : t) });
  state().moveClip('c3', clip().start + 1);
  const moved = clip().start;
  state().setPlayhead(5);
  const id = state().addMarker({ note: 'check focus' })!;
  assert.deepEqual(markers().map(m => [m.id, m.time, m.note]), [[id, 5, 'check focus']]);
  assert.deepEqual(state().selectedMarkerIds, [id]);
  state().undo();
  assert.equal(markers().length, 0, 'undo removes the marker');
  assert.equal(clip().start, moved, 'and leaves the earlier clip move alone');
  state().addMarker({ time: 2, name: 'A' }); state().addMarker({ time: 4, name: 'B' });
  const [a, b] = markers();
  state().setMarkers(markers().map(m => m.id === a.id ? { ...m, time: 8 } : m), 'moved marker A');
  assert.deepEqual(markers().map(m => [m.name, m.time]), [['B', 4], ['A', 8]], 'markers stay in time order');
  state().copyMarkers([a.id!, b.id!]);
  state().setPlayhead(20);
  state().pasteMarkers();
  assert.deepEqual(markers().map(m => m.time), [4, 8, 20, 24], 'pasted from the playhead, spacing kept');
  assert.equal(new Set(markers().map(m => m.id)).size, 4, 'pasted markers get new ids');
  state().deleteMarkers(state().selectedMarkerIds);
  assert.deepEqual(markers().map(m => m.time), [4, 8]);
  state().undo();
  assert.equal(markers().length, 4);
  state().selectClip('c3');
  assert.deepEqual(state().selectedMarkerIds, [], 'selecting a clip hands Delete back to clips');
});

test('timed comments remember their timeline; commenters cannot add markers', () => {
  state().addComment('Too dark here');
  assert.equal(state().comments.at(-1)!.timelineId, state().timelineId);
  store.setState({ projects: state().projects.map(p => p.id === state().projectId ? { ...p, members: p.members.map(m => m.userId === 'kyle' ? { ...m, role: 'Commenter' as const } : m) } : p) });
  assert.equal(state().addMarker(), undefined);
});

test('cut then paste puts the earliest cut clip on the playhead and keeps the group spacing', () => {
  const [a, b] = ['c3', 'c4'].map(id => structuredClone(clip(id)));
  state().selectClips([a.id, b.id]);
  state().copyClip(b.id); state().deleteClip(b.id);
  assert.ok(!state().clips.some(c => c.id === a.id || c.id === b.id), 'cut removes the whole selection');
  state().setPlayhead(100);
  state().pasteClip();
  const pasted = state().clips.filter(c => state().selectedClipIds.includes(c.id)).sort((x, y) => x.start - y.start);
  assert.equal(pasted.length, 2);
  assert.equal(pasted[0].start, 100, 'the earliest clip starts at the playhead, not the one that was clicked');
  assert.equal(pasted[1].start - pasted[0].start, b.start - a.start);
});

test('a bin multi-drop lays clips end to end and undoes as one action',()=>{
  const base={...state().media[0],hasAudio:false,duration:4,kind:'video' as const,status:'ready' as const};
  const assets=Array.from({length:40},(_,i)=>({...base,id:`bulk-${i}`,name:`bulk ${i}`}));
  store.setState({media:assets,clips:[],nodes:[],comments:[]});
  const videoTrack=state().tracks.find(t=>t.timelineId===state().timelineId&&t.kind==='video'&&!t.locked)!;
  state().addMediaToTimeline(assets.map(a=>a.id),6,videoTrack.id);
  const placed=state().clips.filter(c=>c.trackId===videoTrack.id).sort((a,b)=>a.start-b.start);
  assert.equal(placed.length,assets.length);
  placed.forEach((c,i)=>{assert.equal(c.start,6+i*4);assert.equal(c.duration,4);});
  assert.equal(new Set(placed.map(c=>c.mediaId)).size,assets.length,'Every dropped asset lands once.');
  state().undo();
  assert.equal(state().clips.length,0,'One undo takes the whole drop back.');
});

test('a multi-drop skips media that is not ready and sends audio to its own lane',()=>{
  const video={...state().media[0],id:'mixed-video',hasAudio:false,kind:'video' as const,duration:3,status:'ready' as const};
  const pending={...video,id:'mixed-pending',status:'processing' as const};
  const sound={...video,id:'mixed-audio',kind:'audio' as const,duration:2};
  store.setState({media:[video,pending,sound],clips:[],nodes:[],comments:[]});
  const videoTrack=state().tracks.find(t=>t.timelineId===state().timelineId&&t.kind==='video'&&!t.locked)!;
  state().addMediaToTimeline([video.id,pending.id,sound.id],0,videoTrack.id);
  assert.equal(state().clips.length,2,'The unready clip is skipped, the rest still land.');
  const audio=state().clips.find(c=>c.mediaId===sound.id)!;
  assert.equal(state().tracks.find(t=>t.id===audio.trackId)!.kind,'audio');
  assert.equal(state().clips.find(c=>c.mediaId===video.id)!.start,0);
  assert.equal(audio.start,3,'Audio still follows the video in time.');
});


test('local buffering holds the playhead and resumes without jumping over elapsed loading time', () => {
  store.setState({ playing: true, playhead: 10, liveMode: 'independent', playbackBuffering: true });
  const now = Date.now(); state().tick(now); state().tick(now + 1000);
  assert.equal(state().playhead, 10);
  assert.equal(state().playing, true, 'play intent survives buffering');
  store.setState({ playbackBuffering: false }); state().tick(now + 1100);
  assert.ok(Math.abs(state().playhead - 10.1) < .001);
});

test('a speed keyframe ramp resizes the clip, stopping at the next clip on the track', () => {
  const c = clip();
  const lone = { ...c, id: 'lone', trackId: 'lone-track', start: 0, duration: 4, sourceIn: 0, keyframes: undefined, properties: { ...Object.fromEntries(Object.entries(c.properties).filter(([key]) => key !== 'linkGroup')), speed: 100, reverse: false, freeze: false } };
  const next = { ...lone, id: 'next', start: 5, duration: 2 };
  store.setState({ clips: [...state().clips, lone, next] });
  const ramp = (to: number): Keyframe[] => [{ id: 'k0', time: 0, value: 100, interpolation: 'linear' }, { id: 'k1', time: 4, value: to, interpolation: 'linear' }];
  state().setKeyframes('lone', 'properties.speed', ramp(200));
  // The same 4 s of footage under a 100→200% ramp: t + t²/8 = 4 → t ≈ 2.93 s.
  assert.ok(Math.abs(clip('lone').duration - 2.928) < .01, `sped-up clip shortens (${clip('lone').duration})`);
  state().setKeyframes('lone', 'properties.speed', ramp(50));
  assert.ok(Math.abs(clip('lone').duration - 5) < 1e-6, `slowed clip grows only up to the next clip (${clip('lone').duration})`);
  store.setState({ clips: state().clips.filter(c => c.id !== 'next') });
  state().updateProperty('lone', 'speed', 100);
});

test('Color Assistant apply is one snapshot and one undo across shots; extras are replaced and restored; CSTs and other clips stay untouched', () => {
  const video = state().clips.filter(c => c.projectId === clip().projectId && c.id !== 'c3' && state().tracks.find(t => t.id === c.trackId)?.kind === 'video');
  const [a, b, legacy] = [clip('c3'), video[0], video[1]], graded = [a.id, b.id];
  store.setState({ media: state().media.map(m => [a.mediaId, b.mediaId].includes(m.id) ? { ...m, cameraMetadataVersion: 2, inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } : m) });
  for (const id of graded) { state().updateProperty(id, 'inputProfile', 'S-Log3'); state().updateProperty(id, 'inputGamut', 'S-Gamut3.Cine'); state().initializeColorGrade(id); }
  const sorted = <T extends { id: string }>(items: T[]) => [...items].sort((x, y) => x.id.localeCompare(y.id));
  const option = (name: string, contrast: number, extras: number): LookOption => ({ name, intensity: 'bold', description: '', shots: [],
    look: { ...neutralLook(), contrast, curves: { ...neutralLook().curves, rgb: [{ x: 0, y: 0 }, { x: .5, y: .6 }, { x: 1, y: 1 }] } }, extraNodes: Array.from({ length: extras }, () => ({ ...neutralLook(), saturation: 140 })) });
  const result = { mode: 'looks' as const, looks: [option('Clean', 1.2, 2), option('Neon', 1.5, 1), option('Bleach', 2, 0)] }, ids = [...graded, legacy.id];
  const before = structuredClone({ clips: state().clips, nodes: state().nodes }), transforms = () => sorted(state().nodes.filter(n => n.effects?.length));
  store.setState({ currentUserId: 'non-editor' }); assert.equal(state().applyColorAssistant(result, 0, ids), 0); store.setState({ currentUserId: baseline.currentUserId });
  assert.equal(state().applyColorAssistant(result, 0, ids), 2, 'the legacy-pipeline shot is skipped');
  const first = structuredClone({ clips: state().clips, nodes: state().nodes }), snapshots = state().snapshots.length, operations = state().operations.length;
  assert.equal(state().applyColorAssistant(result, 1, ids), 2);
  assert.equal(state().snapshots.length, snapshots + 1); assert.equal(state().snapshots[0].name, 'Before Color Assistant: Neon');
  assert.equal(state().operations.length, operations + 1, 'every shot and node change is one undo entry');
  for (const id of graded) {
    const nodes = state().nodes.filter(n => n.clipId === id).sort((x, y) => x.order! - y.order!);
    assert.deepEqual(nodes.map(n => n.name), ['Input CST', 'Balance', 'Look', 'Look 2', 'Output CST']);
    assert.equal(nodes[2].parameters.contrast, 1.5); assert.equal(nodes[2].curves!.RGB!.points.length, 3); assert.equal(nodes[3].parameters.saturation, 140); assert.ok(nodes[3].id.startsWith('ai-look-'));
  }
  assert.deepEqual(transforms(), sorted(before.nodes.filter(n => n.effects?.length)), 'CST nodes are never written');
  assert.deepEqual(state().clips, first.clips); assert.deepEqual(sorted(state().nodes.filter(n => !graded.includes(n.clipId))), sorted(before.nodes.filter(n => !graded.includes(n.clipId))));
  state().undo();
  assert.deepEqual(sorted(state().nodes), sorted(first.nodes), 'one undo restores the removed extras and removes the new one');
  state().undo();
  assert.deepEqual(sorted(state().nodes), sorted(before.nodes)); assert.deepEqual(state().clips, before.clips);
  const balance = { ...neutralBalance(), exposure: .5, temperature: -300 };
  assert.equal(state().applyColorAssistant({ mode: 'balance', shots: [{ clipId: a.id, confidence: 1, warnings: [], rationale: '', balance }] }), 1);
  const node = state().nodes.find(n => n.clipId === a.id && n.name === 'Balance')!;
  assert.equal(node.parameters.exposure, .5); assert.equal(node.parameters.temperature, -300); assert.equal(state().snapshots[0].name, 'Before Color Assistant: Balance shots');
  assert.deepEqual(state().nodes.filter(n => n.clipId === b.id), before.nodes.filter(n => n.clipId === b.id));
  // Three looks: a look sets each shot's own Balance from the result too; a shot without one keeps its Balance.
  state().undo();
  const graded2 = { ...result, shots: [{ clipId: b.id, confidence: 1, warnings: [], rationale: '', balance: { ...neutralBalance(), exposure: -.4, temperature: 900, tint: 5 } }] };
  assert.equal(state().applyColorAssistant(graded2, 2, graded), 2);
  const balanceOf = (id: string) => state().nodes.find(n => n.clipId === id && n.name === 'Balance')!.parameters;
  assert.deepEqual([balanceOf(b.id).exposure, balanceOf(b.id).temperature, balanceOf(b.id).tint], [-.4, 900, 5]);
  assert.deepEqual(balanceOf(a.id), before.nodes.find(n => n.clipId === a.id && n.name === 'Balance')!.parameters, 'no balance in the result: the shot keeps its own');
  assert.equal(state().nodes.find(n => n.clipId === b.id && n.name === 'Look')!.parameters.contrast, 2);
});

test('Use ACES 2 output snapshots the grade and switches only the clipping display transform', () => {
  state().updateProperty('c3', 'inputProfile', 'S-Log3'); state().initializeColorGrade('c3');
  const output = state().nodes.find(n => n.clipId === 'c3' && n.name === 'Output CST')!;
  state().updateNode(output.id, { effects: output.effects!.map(e => e.type === 'cst' ? { ...e, toneMapping: 'shoulder' as const, gamutMapping: 'compress' as const } : e) });
  const snapshots = state().snapshots.length;
  state().useAcesOutput('c3');
  const effect = state().nodes.find(n => n.id === output.id)!.effects![0];
  assert.equal(effect.type === 'cst' && effect.toneMapping, 'aces2'); assert.equal(effect.type === 'cst' && effect.gamutMapping, 'none');
  assert.equal(state().snapshots.length, snapshots + 1); assert.equal(state().snapshots[0].name, `Before ACES output: ${clip().name}`);
  state().useAcesOutput('c3'); assert.equal(state().snapshots.length, snapshots + 1, 'nothing left to upgrade');
});

test('horizontal flip is an undoable clip property', () => {
  state().updateProperty('c3', 'flipH', true);
  assert.equal(clip().properties.flipH, true);
  state().undo();
  assert.ok(!clip().properties.flipH);
});

test('panels read the playhead exactly while paused and in quarter-second steps while playing', async () => {
  const { panelPlayhead, PANEL_PLAYHEAD_STEP } = await import('./store.ts');
  assert.equal(panelPlayhead({ playing: false, playhead: 3.37 }), 3.37);
  assert.equal(panelPlayhead({ playing: true, playhead: 3.37 }), 3.25);
  // Every frame inside one step selects the same value, so a subscribed panel skips those frames.
  const steps = new Set(Array.from({ length: 30 }, (_, frame) => panelPlayhead({ playing: true, playhead: 10 + frame / 30 })));
  assert.equal(steps.size, Math.round(1 / PANEL_PLAYHEAD_STEP));
});

test('the clock tells subscribers only of real changes: nothing while paused, the playhead once per picture while playing', async () => {
  const { connection } = await import('../services/api.ts');
  const was = connection.enabled; connection.enabled = true;
  let notified = 0;
  const stop = store.subscribe(() => notified++);
  try {
    const fps = state().projects.find(p => p.id === state().projectId)!.fps, end = Math.max(...state().clips.filter(c => c.timelineId === state().timelineId).map(c => c.start + c.duration));
    let now = Date.now() + 3_600_000;
    const run = (seconds: number, hz = 120) => { for (let i = 0; i < Math.round(seconds * hz); i++) state().tick(now += 1000 / hz); };
    state().setPlayhead(1); run(.1);
    notified = 0; run(1, 30);
    assert.equal(notified, 0, 'paused, a tick that changes nothing notifies nobody');

    const pictures: number[] = [], watch = store.subscribe((next, previous) => { if (next.playhead !== previous.playhead) pictures.push(Math.floor(next.playhead * fps + 1e-6)); });
    state().setPlaying(true); notified = 0; pictures.length = 0;
    run(1); watch();
    assert.ok(Math.abs(notified - fps) <= 1, `${notified} notifications in a second of ${fps} fps playback on a 120 Hz display`);
    assert.ok(pictures.every((frame, i) => !i || frame === pictures[i - 1] + 1), `the store playhead steps one picture at a time: ${pictures}`);
    assert.ok(state().playhead > 2 - 1 / fps - 1e-9 && state().playhead <= 2, `${state().playhead} after a second from 1`);

    // A seek while playing (the ruler, a marker, the arrow keys) restarts the clock from there.
    state().setPlayhead(5); run(.5);
    assert.ok(state().playhead > 5.5 - 1 / fps - 1e-9 && state().playhead <= 5.5, `${state().playhead} half a second after seeking to 5`);
    // Pausing keeps the picture on screen.
    const held = state().playhead; state().setPlaying(false); run(.2);
    assert.equal(state().playhead, held);
    // Playing again continues from it, not from where the clock had run on to.
    state().setPlaying(true); run(.5);
    assert.ok(state().playhead > held + .5 - 1 / fps - .02 && state().playhead <= held + .5 + 1e-9, `${state().playhead} half a second after resuming at ${held}`);

    // The end of the timeline stops playback exactly there.
    state().setPlayhead(end - .3); run(1);
    assert.equal(state().playing, false); assert.equal(state().playhead, end);
  } finally { stop(); connection.enabled = was; state().setPlaying(false); }
});

test('a buffering stall holds the exact clock: playback resumes where it stopped, not at the picture shown', async () => {
  const { connection } = await import('../services/api.ts');
  const was = connection.enabled; connection.enabled = true;
  try {
    // Whole milliseconds a tick, so the clock adds up exactly and the stall lands where it is meant to.
    let now = Date.now() + 7_200_000;
    const run = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 100); i++) state().tick(now += 10); };
    // A second of playback from 1 s at 24 fps, with or without a fifth of a second of buffering at 1.57 s: the picture
    // shown (from 1.5417 s) went up on the 1.55 s tick, so the store's playhead is 0.02 s behind the clock.
    const play = (stall: boolean) => {
      state().setPlaying(false); state().setPlayhead(1); run(.1);
      state().setPlaying(true); run(.57);
      if (stall) { store.setState({ playbackBuffering: true }); run(.2); store.setState({ playbackBuffering: false }); }
      run(.43);
      return state().playhead;
    };
    const straight = play(false), stalled = play(true);
    assert.ok(Math.abs(stalled - straight) < 1e-6, `${stalled} after a stall, ${straight} without`);
  } finally { connection.enabled = was; state().setPlaying(false); store.setState({ playbackBuffering: false }); }
});

// A timeline built for the Select Forward tests: long enough that moveClip's non-server clamp never bites.
const proto = baseline.clips.find(c => c.id === 'c7')!;
const piece = (id: string, trackId: string, start: number, duration: number, extra: Partial<ReturnType<typeof clip>> = {}) => ({ ...structuredClone(proto), id, trackId, start, duration, sourceIn: 0, ...extra });
const scene = (clips: ReturnType<typeof clip>[], extra: object = {}) => store.setState({ clips, nodes: [], comments: [], operations: [], timelines: state().timelines.map(t => ({ ...t, duration: 2000 })), selectedClipId: null, selectedClipIds: [], settings: { ...state().settings, linkSelection: true }, ...extra });

test('a move that lands on a neighbour\u2019s end through float arithmetic never trims, splits or deletes it', () => {
  const frame = 1 / 29.97;
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  // Near the start of the timeline the subtraction in a move's delta is inexact, so the clip lands a hair inside the neighbour.
  const cases: [number, number][] = [[7.166666, 2.5], [105.07 - 3.1, 3.1], [4 * frame, 20 * frame], [0.1 + 0.2, 1.7]];
  while (cases.length < 300) cases.push([Math.round(next() * 400) * frame, Math.round(1 + next() * 60) * frame]);
  for (const [s, d] of cases) {
    const neighbour = piece('neighbour', 'v2', s, d), mover = piece('mover', 'v2', s + d + 5 + next() * 200, 3.3), buddy = piece('buddy', 'v1', s + d + 5 + next() * 200, 2.7);
    scene([neighbour, mover, buddy]);
    state().selectClips([buddy.id, mover.id]);
    state().moveClip(mover.id, s + d);
    assert.deepEqual(clip('neighbour'), neighbour, `neighbour untouched at ${s} + ${d}`);
    assert.equal(state().clips.length, 3);
  }
});

test('moving a group without changing the primary\u2019s track keeps every clip on its own track, even when two tracks share a kind and number', () => {
  const twin = { ...state().tracks.find(t => t.id === 'v1')!, id: 'v1-twin', name: 'Twin' };
  scene([piece('p', 'v1', 10, 5), piece('q', 'v1-twin', 10, 5), piece('r', 'a1', 10, 5)], { tracks: [twin, ...state().tracks] });
  state().selectClips(['q', 'r', 'p']);
  state().moveClip('p', 12);
  assert.deepEqual(['p', 'q', 'r'].map(id => [clip(id).trackId, clip(id).start]), [['v1', 12], ['v1-twin', 12], ['a1', 12]]);
  state().moveClip('p', 20, 'v2');
  assert.deepEqual(['p', 'r'].map(id => clip(id).trackId), ['v2', 'a1'], 'a cross-track move still maps by kind and number');
  assert.equal(clip('p').start, 20);
});

// Select Forward. The line is at 20 s (the anchor clip C). E and I run across it; H is on a locked track; R is on another timeline.
const forwardClips = () => [
  piece('A', 'v1', 0, 10), piece('B', 'v1', 10, 10), piece('C', 'v1', 20, 10), piece('D', 'v1', 32, 8),
  piece('E', 'v2', 5, 20), piece('F', 'v2', 25, 10), piece('G', 'a1', 22, 8), piece('H', 'a3', 40, 10), piece('I', 'a2', 0, 60),
  piece('R', 'v1-review', 100, 10, { timelineId: 'review-timeline' }),
];
const forwardScene = (clips = forwardClips(), extra: object = {}) => scene(clips, { tracks: state().tracks.map(t => t.id === 'a3' ? { ...t, locked: true } : t), ...extra });
const picked = () => [...state().selectedClipIds].sort();

test('Select Forward from a clip takes it and every later clip on unlocked tracks of this timeline, and re-anchors on each click', () => {
  forwardScene();
  state().selectForward({ clipId: 'C' });
  assert.deepEqual(picked(), ['C', 'D', 'F', 'G'], 'E and I cross the line, H is locked, R is on another timeline, A and B are before it');
  assert.equal(state().selectedClipId, 'C', 'the clicked clip is the primary');
  state().selectForward({ clipId: 'F' });
  assert.deepEqual(picked(), ['D', 'F']);
  assert.equal(state().selectedClipId, 'F');
  state().selectForward({ clipId: 'R' });
  state().selectForward({ clipId: 'nope' });
  assert.deepEqual(picked(), ['D', 'F'], 'a clip of another timeline or an unknown clip changes nothing');
  assert.equal(state().operations.length, 0, 'selecting is not an edit');
});

test('Select Forward from a point in time absorbs float drift, ignores bad times, and clears the selection when nothing is ahead', () => {
  forwardScene();
  state().selectForward({ time: 21 });
  assert.deepEqual(picked(), ['D', 'F', 'G']);
  assert.equal(state().selectedClipId, state().selectedClipIds.at(-1));
  state().selectForward({ time: 19.99 });
  assert.deepEqual(picked(), ['C', 'D', 'F', 'G'], 'a clip starting a hair after the pointer still counts');
  state().selectForward({ time: Number.NaN });
  state().selectForward({ time: Infinity });
  assert.deepEqual(picked(), ['C', 'D', 'F', 'G'], 'a time that is not finite changes nothing');
  state().selectForward({ time: -5 });
  assert.deepEqual(picked(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'I'], 'before zero means from zero; locked and other-timeline clips never join');
  state().selectForward({ time: 999 });
  assert.deepEqual(state().selectedClipIds, []);
  assert.equal(state().selectedClipId, null);
});

test('a forward selection moves as one group, time only, leaves crossing clips alone, and one undo restores it', () => {
  forwardScene();
  state().selectForward({ clipId: 'C' });
  const before = structuredClone(state().clips), moving = new Set(['C', 'D', 'F', 'G']);
  state().moveClip('C', 22);
  for (const was of before) {
    const now = clip(was.id);
    assert.deepEqual(now, moving.has(was.id) ? { ...was, start: was.start + 2 } : was, `${was.id}: ${moving.has(was.id) ? 'moved by +2 on its own track' : 'untouched'}`);
  }
  assert.equal(state().operations.length, 1);
  state().undo();
  assert.deepEqual(state().clips, before);
});

test('dragging a forward selection left by exactly the room it has closes the gap without touching what stays behind', () => {
  const f = 1 / 29.97;
  forwardScene([
    piece('A', 'v1', 0, 301 * f), piece('C', 'v1', 457 * f, 300 * f), piece('D', 'v1', 900 * f, 200 * f),
    piece('E', 'v2', 0, 12.07), piece('F', 'v2', 20.1 + 0.2, 10.3), piece('G', 'a1', 16.7, 4.1),
  ]);
  state().selectForward({ clipId: 'C' });
  const before = structuredClone(state().clips), staying = before.filter(c => !state().selectedClipIds.includes(c.id)), room = forwardRoom(state().clips, state().selectedClipIds);
  assert.ok(room > 0);
  state().moveClip('C', clip('C').start - room);
  assert.equal(state().clips.length, before.length);
  assert.ok(Math.abs(clip('C').start - (clip('A').start + clip('A').duration)) < 1e-9, 'C now butts against A');
  for (const c of staying) assert.deepEqual(clip(c.id), c, `${c.id} was neither trimmed, split nor deleted`);
  for (const c of before.filter(c => !staying.includes(c))) assert.ok(Math.abs(clip(c.id).start - (c.start - room)) < 1e-9);
});

// Crossing clips for the cut tests: each one runs 10 to 30 s and the line is at 20.
const crossers = () => [
  piece('speed', 'v2', 10, 20, { sourceIn: 4, properties: { ...proto.properties, speed: 200 } }),
  piece('reverse', 'v3', 10, 20, { sourceIn: 50, properties: { ...proto.properties, reverse: true } }),
  piece('freeze', 'a1', 10, 20, { sourceIn: 7, properties: { ...proto.properties, freeze: true } }),
  piece('keys', 'a2', 10, 20, { keyframes: { 'properties.opacity': [{ id: 'k1', time: 12, value: 100, interpolation: 'linear' }, { id: 'k2', time: 15, value: 50, interpolation: 'linear' }] } }),
  piece('graded', 'v1', 10, 20, { sourceIn: 3 }),
];
const gradeNodes = () => ['Primary', 'Output Trim'].map((name, i) => ({ id: `n${i}`, projectId: 'city-after-dark', clipId: 'graded', name, kind: 'primary', enabled: true, parameters: { exposure: .2 * i } }));
const halves = (id: string) => ({ left: clip(id), right: state().clips.find(c => c.id !== id && c.trackId === clip(id).trackId && c.start >= 20 && c.name === clip(id).name)! });

test('cutThrough splits every crossing clip at the line with the same source maths as the playhead split, in one undo step', () => {
  forwardScene(crossers(), { nodes: gradeNodes() });
  const before = structuredClone({ clips: state().clips, nodes: state().nodes });
  assert.equal(state().cutThrough(20), 5);
  assert.equal(state().clips.length, 10);
  assert.equal(state().operations.length, 1);
  assert.equal(state().operations[0].type, 'ClipTrimmed');
  assert.match(state().operations[0].description, /^cut 5 clips at 0:20$/);
  for (const id of ['speed', 'reverse', 'freeze', 'keys', 'graded']) { const { left, right } = halves(id); assert.deepEqual([left.start, left.duration, right.start, right.duration], [10, 10, 20, 10], id); }
  assert.equal(halves('speed').right.sourceIn, 4 + 10 * 2, 'speed 200 consumes twice the source');
  assert.deepEqual([halves('reverse').left.sourceIn, halves('reverse').right.sourceIn], [60, 50], 'reverse plays the later source first');
  assert.deepEqual([halves('freeze').left.sourceIn, halves('freeze').right.sourceIn], [7, 7], 'a freeze never advances');
  assert.deepEqual(halves('keys').left.keyframes!['properties.opacity'].map(k => k.time), [12, 15]);
  assert.deepEqual(halves('keys').right.keyframes!['properties.opacity'].map(k => k.time), [2, 5], 'keyframes follow the right half');
  const copies = state().nodes.filter(n => n.clipId === halves('graded').right.id);
  assert.deepEqual(copies.map(n => [n.name, n.parameters.exposure]), [['Primary', 0], ['Output Trim', .2]]);
  assert.ok(copies.every(n => !['n0', 'n1'].includes(n.id)), 'the right half gets its own nodes');
  state().undo();
  assert.deepEqual(state().clips, before.clips);
  assert.deepEqual(state().nodes, before.nodes);
});

test('cutThrough then a forward move, then two undos, restores the edit exactly; the right halves ride with the selection', () => {
  forwardScene([piece('P', 'v1', 0, 10), piece('Q', 'v1', 20, 10), piece('X', 'v2', 10, 20), piece('Z', 'a1', 25, 15)]);
  const before = structuredClone(state().clips);
  state().selectForward({ clipId: 'Q' });
  assert.equal(state().cutThrough(20), 1);
  const right = state().clips.find(c => c.id !== 'X' && c.trackId === 'v2')!;
  assert.deepEqual(picked(), ['Q', 'Z', right.id].sort(), 'the right half joins; the left half stays out');
  assert.equal(state().selectedClipId, 'Q', 'the primary stays the primary');
  state().moveClip('Q', 23);
  assert.deepEqual([clip('Q').start, clip('Z').start, clip(right.id).start, clip('X').start, clip('X').duration], [23, 28, 23, 10, 10]);
  state().undo(); state().undo();
  assert.deepEqual(state().clips, before);
});

test('cutThrough keeps linked clips linked on both sides of the line', () => {
  const linked = (id: string, trackId: string, start: number, duration: number, group = 'L') => piece(id, trackId, start, duration, { properties: { ...proto.properties, linkGroup: group } });
  const make = () => forwardScene([linked('V', 'v1', 10, 20), linked('A', 'a1', 10, 20), linked('W', 'a2', 25, 10), linked('U', 'v2', 0, 8)]);
  make();
  const before = structuredClone(state().clips);
  state().selectForward({ time: 20 });
  assert.equal(state().cutThrough(20), 2);
  const [vr, ar] = ['V', 'A'].map(id => state().clips.find(c => c.id !== id && c.start === 20 && c.trackId === clip(id).trackId)!);
  const fresh = vr.properties.linkGroup;
  assert.ok(fresh && fresh !== 'L');
  assert.equal(ar.properties.linkGroup, fresh, 'the right halves share one new group');
  assert.equal(clip('W').properties.linkGroup, fresh, 'a peer that moves with them joins it');
  assert.deepEqual(['V', 'A', 'U'].map(id => clip(id).properties.linkGroup), ['L', 'L', 'L'], 'the left halves and the peer before the line keep the old group');
  state().moveClip(vr.id, 22);
  assert.deepEqual([vr.id, ar.id, 'W'].map(id => clip(id).start), [22, 22, 27], 'moving one right half moves its linked partner');
  assert.deepEqual([clip('V').start, clip('A').start, clip('U').start], [10, 10, 0]);
  state().undo(); state().undo();
  assert.deepEqual(state().clips, before);
  make();
  store.setState({ settings: { ...state().settings, linkSelection: false } });
  state().cutThrough(20);
  assert.equal(state().clips.filter(c => c.id !== 'V' && c.start === 20 && c.properties.linkGroup).length, 0, 'with linked selection off the right halves are free');
  assert.equal(clip('W').properties.linkGroup, 'L');
});

test('a cut clip whose only partner stays behind gives its right half no one-clip link group', () => {
  const linked = (id: string, trackId: string, start: number, duration: number) => piece(id, trackId, start, duration, { properties: { ...proto.properties, linkGroup: 'L' } });
  forwardScene([linked('V', 'v1', 10, 20), linked('A', 'a1', 0, 8)]);
  assert.equal(state().cutThrough(20), 1);
  assert.equal(state().clips.find(c => c.id !== 'V' && c.trackId === 'v1')!.properties.linkGroup, undefined);
  assert.equal(clip('V').properties.linkGroup, 'L');
});

test('with linked selection Select Forward and cutThrough leave alone a clip whose link partner is on a locked track', () => {
  const linked = (id: string, trackId: string, start: number, duration: number, group: string) => piece(id, trackId, start, duration, { properties: { ...proto.properties, linkGroup: group } });
  const make = () => forwardScene([linked('P', 'v1', 25, 5, 'L'), linked('Q', 'a3', 25, 5, 'L'), linked('X', 'v1', 10, 30, 'M'), linked('Y', 'a3', 10, 30, 'M'), piece('Z', 'v2', 26, 2)]);
  make();
  state().selectForward({ time: 20 });
  assert.deepEqual(picked(), ['Z'], 'P is held by Q on the locked a3, so a drag of the selection can move');
  const before = structuredClone(state().clips);
  assert.equal(state().cutThrough(20), 0, 'X is held by Y the same way');
  assert.deepEqual(state().clips, before);
  make();
  store.setState({ settings: { ...state().settings, linkSelection: false } });
  state().selectForward({ time: 20 });
  assert.deepEqual(picked(), ['P', 'Z'], 'with linked selection off a partner is not the clip\u2019s business');
  assert.equal(state().cutThrough(20), 1);
});

test('cutThrough works on caption tracks, ignores a caption that ends a hair past the line, and leaves locked tracks and composition contents alone', () => {
  const caps = { ...state().tracks.find(t => t.id === 'v3')!, id: 'caps', name: 'Captions', number: 7, captionSets: [] };
  const caption = (i: number, start: number, duration: number) => piece(`cap${i}`, 'caps', start, duration, { properties: { ...proto.properties, captionSet: 's1' } });
  const nested = { id: 'inner', projectId: 'city-after-dark', name: 'Inner', duration: 20, composition: true };
  const innerTrack = { ...state().tracks.find(t => t.id === 'v1')!, id: 'inner-v1', timelineId: 'inner' };
  const innerClip = piece('inner-clip', 'inner-v1', 0, 20, { timelineId: 'inner' });
  const compClip = piece('comp', 'v2', 10, 20, { mediaId: 'frameline-composition', name: 'Nested', sourceIn: 2, properties: { ...proto.properties, compositionId: 'inner' } });
  const lockedCross = piece('locked-cross', 'a3', 10, 20);
  forwardScene([...Array.from({ length: 60 }, (_, i) => caption(i, i, 1)), compClip, lockedCross, innerClip], { tracks: [...state().tracks.map(t => t.id === 'a3' ? { ...t, locked: true } : t), caps, innerTrack], timelines: [...state().timelines.map(t => ({ ...t, duration: 2000 })), nested] });
  const before = structuredClone(state().clips);
  assert.equal(state().cutThrough(105.07), 0, 'nothing runs across 105.07');
  assert.equal(state().cutThrough(30.5), 1, 'caption 30 crosses 30.5');
  state().undo();
  assert.equal(state().cutThrough(20), 1, 'the nested clip crosses, the locked-track one does not');
  assert.deepEqual(clip('locked-cross'), before.find(c => c.id === 'locked-cross'));
  assert.deepEqual(clip('inner-clip'), before.find(c => c.id === 'inner-clip'));
  const right = state().clips.find(c => c.id !== 'comp' && c.mediaId === 'frameline-composition')!;
  assert.deepEqual([right.properties.compositionId, right.start, right.duration, right.sourceIn], ['inner', 20, 10, 12]);
  assert.equal(state().timelines.filter(t => t.composition).length, 1);
  state().undo();
  assert.deepEqual(state().clips, before);
  state().cutThrough(30.5);
  const cap = state().clips.find(c => c.id !== 'cap30' && c.start === 30.5)!;
  assert.deepEqual([cap.trackId, cap.duration, cap.properties.captionSet], ['caps', .5, 's1']);
  state().selectForward({ time: 30.5 });
  assert.equal(state().selectedClipIds.length, 30, 'the right half and the 29 captions after it');
  state().moveClip(state().selectedClipId!, state().selectedClipId === 'cap59' ? 61 : 40);
  assert.ok(state().selectedClipIds.every(id => clip(id).trackId === 'caps'), 'captions stay on the captions track');
});

test('a drifting caption end does not count as crossing and a crossing clip within a frame of the line is left whole with a notice', () => {
  forwardScene([piece('drift', 'v2', 100, 5.0700001), piece('sliver', 'v3', 10, 10.03), piece('real', 'a1', 10, 20)]);
  assert.equal(state().cutThrough(105.07), 0);
  assert.equal(state().operations.length, 0);
  const before = structuredClone(state().clips);
  assert.equal(state().cutThrough(20), 1, 'only the clip with a real half on each side is cut');
  assert.deepEqual(clip('sliver'), before.find(c => c.id === 'sliver'));
  assert.match(state().notifications.at(-1)!.title, /1 clip within a frame of the line left whole/);
  state().undo();
  forwardScene([piece('sliver', 'v3', 10, 10.03)]);
  assert.equal(state().cutThrough(20), 0);
  assert.equal(state().operations.length, 0);
});

test('cutThrough refuses the whole cut for a commenter, a locked clip or node held by a collaborator, and bad times', () => {
  forwardScene(crossers(), { nodes: gradeNodes() });
  const before = structuredClone({ clips: state().clips, nodes: state().nodes, comments: state().comments });
  const refused = () => { assert.deepEqual({ clips: state().clips, nodes: state().nodes, comments: state().comments }, before); assert.equal(state().operations.length, 0); };
  assert.equal(state().cutThrough(Number.NaN), 0); refused();
  state().setCurrentUser('maya');
  assert.equal(state().cutThrough(20), 0); refused();
  state().setCurrentUser('kyle');
  store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: 'city-after-dark', targetId: 'reverse', field: 'manipulation', expiresAt: Date.now() + LOCK_TTL }] });
  assert.equal(state().cutThrough(20), 0, 'one clip held by a collaborator stops the cut of all five'); refused();
  store.setState({ locks: [{ id: 'remote-node', userId: 'ashley', projectId: 'city-after-dark', targetId: 'n1', field: 'exposure', expiresAt: Date.now() + LOCK_TTL }] });
  assert.equal(state().cutThrough(20), 0, 'so does a grade node of a cut clip'); refused();
  store.setState({ locks: [] });
  assert.equal(state().cutThrough(20), 5);
});

test('splitting and cutting move the comments from the cut on to the right half, and undo puts them back', () => {
  const split = state().comments.find(m => m.id === 'comment-1')!;
  state().addComment('early', { clipId: 'c3' });
  const early = state().comments.at(-1)!;
  store.setState({ comments: state().comments.map(m => m.id === early.id ? { ...m, time: 35 } : m) });
  const before = structuredClone(state().comments);
  state().setPlayhead(split.time);
  state().splitClip('c3');
  const right = state().selectedClipId!;
  assert.equal(state().comments.find(m => m.id === split.id)!.clipId, right, 'the comment at the cut goes with the right half');
  assert.equal(state().comments.find(m => m.id === early.id)!.clipId, 'c3', 'the one before it stays');
  state().undo();
  assert.deepEqual(state().comments, before);
  state().cutThrough(split.time);
  assert.equal(state().comments.find(m => m.id === split.id)!.clipId, state().clips.find(c => c.id !== 'c3' && c.trackId === 'v2' && c.start === split.time)!.id);
  assert.equal(state().comments.find(m => m.id === early.id)!.clipId, 'c3');
  state().undo();
  assert.deepEqual(state().comments, before);
});

// ---- Redo, ripple delete, trim tools, insert ----
const at = (id: string) => [clip(id).start, clip(id).duration, clip(id).sourceIn];
// Three picture clips end to end on V1 (sourceIn 5, 20, 40 of a 94 s source), each linked to its sound on A1.
const make = (id: string, start: number, sourceIn: number, trackId = 'v1'): Clip => ({ id, projectId: 'city-after-dark', timelineId: baseline.timelineId, trackId, mediaId: 'm1', name: id, start, duration: 10, sourceIn, color: '#467879', disabled: false, properties: { speed: 100, linkGroup: `link-${id.replace('-audio', '')}` }, effects: [] });
const editFixture = () => store.setState({ nodes: [], comments: [], selectedClipId: null, selectedClipIds: [],
  tracks: baseline.tracks.map(t => ({ ...t, locked: false })), settings: { ...baseline.settings, linkSelection: true },
  clips: [make('A', 0, 5), make('B', 10, 20), make('C', 20, 40), make('A-audio', 0, 5, 'a1'), make('B-audio', 10, 20, 'a1'), make('C-audio', 20, 40, 'a1')] });
// A repeated toast refreshes in place instead of stacking, so look for it rather than at the end.
const told = (title: RegExp) => state().notifications.some(n => title.test(n.title));

test('redo re-applies an undone edit as a new edit; a new edit of mine clears it; a collaborator’s newer change blocks it', () => {
  editFixture();
  state().moveClip('C', 30);
  state().undo();
  assert.equal(clip('C').start, 20);
  state().redo();
  assert.equal(clip('C').start, 30);
  assert.equal(clip('C-audio').start, 30, 'the linked sound comes back with it');
  assert.equal(state().operations[0].description, 'redid: moved C');
  state().redo();
  assert.ok(told(/^Nothing to redo$/));
  state().undo(); state().undo();
  assert.equal(clip('C').start, 20, 'undo reverses the redo like any edit');
  state().redo();
  assert.equal(clip('C').start, 30);
  assert.equal(state().operations[0].description, 'redid: moved C', 'a second redo is named for the edit, not the redo');
  state().undo();
  state().updateProperty('A', 'x', 12);
  store.setState({ notifications: [] });
  state().redo();
  assert.equal(clip('C').start, 20, 'any new edit of mine clears what can be redone');
  assert.ok(told(/^Nothing to redo$/));

  state().moveClip('C', 30); state().undo();
  state().setCurrentUser('ashley'); state().moveClip('C', 40); state().setCurrentUser('kyle');
  store.setState({ notifications: [] });
  state().redo();
  assert.equal(clip('C').start, 40, 'redo never overwrites a collaborator’s newer change');
  assert.ok(told(/newer change/));
});

test('ripple delete closes the gap on each track the clips held, keeps sync, respects locks and undoes once', () => {
  editFixture();
  state().selectClip('B');
  state().deleteClip('B', true);
  assert.equal(state().clips.some(c => c.id === 'B' || c.id === 'B-audio'), false);
  assert.deepEqual(at('C'), [10, 10, 40]);
  assert.deepEqual(at('C-audio'), [10, 10, 40]);
  assert.deepEqual(at('A'), [0, 10, 5]);
  state().undo();
  assert.deepEqual([clip('B').start, clip('C').start, clip('C-audio').start], [10, 20, 20]);
  state().redo();
  assert.equal(clip('C').start, 10);
  state().undo();
  store.setState({ tracks: state().tracks.map(t => t.id === 'a1' ? { ...t, locked: true } : t) });
  state().selectClip('B');
  state().deleteClip('B', true);
  assert.equal(clip('C').start, 20, 'a linked clip on a locked track stops the whole edit');
  assert.ok(state().clips.some(c => c.id === 'B'));
});

test('ripple trim moves an edge through the source and pushes or pulls everything after it', () => {
  editFixture();
  state().trimEdit('A', 'ripple', 'right', 2);
  assert.deepEqual(at('A'), [0, 12, 5]);
  assert.deepEqual([clip('B').start, clip('C').start, clip('B-audio').start, clip('C-audio').start], [12, 22, 12, 22]);
  state().undo();
  state().trimEdit('B', 'ripple', 'left', 3);
  assert.deepEqual(at('B'), [10, 7, 23], 'the in point trims, the clip stays put, the rest closes up');
  assert.deepEqual([clip('C').start, clip('C-audio').start], [17, 17]);
  state().undo();
  assert.deepEqual(state().planTrimEdit('A', 'ripple', 'left', -10)?.delta, -5, 'only 5 s of source before the in point');
  state().trimEdit('A', 'ripple', 'left', -10);
  assert.deepEqual(at('A'), [0, 15, 0]);
  assert.equal(clip('B').start, 15);
  assert.equal(state().planTrimEdit('A', 'ripple', 'right', -20)?.delta, 1 / 24 - 15, 'a clip keeps at least a frame');
});

test('roll moves a cut, slip changes only the source, slide moves a clip between its neighbours', () => {
  editFixture();
  state().trimEdit('A', 'roll', 'right', 2);
  assert.deepEqual([at('A'), at('B')], [[0, 12, 5], [12, 8, 22]]);
  assert.deepEqual([at('A-audio'), at('B-audio'), at('C')], [[0, 12, 5], [12, 8, 22], [20, 10, 40]]);
  state().undo();
  state().trimEdit('B', 'slip', 'right', 3);
  assert.deepEqual([at('B'), at('B-audio')], [[10, 10, 23], [10, 10, 23]]);
  state().undo();
  assert.equal(state().planTrimEdit('B', 'slip', 'right', -100)?.delta, -20, 'slip stops at the start of the source');
  state().trimEdit('B', 'slide', 'right', 2);
  assert.deepEqual([at('A'), at('B'), at('C')], [[0, 12, 5], [12, 10, 20], [22, 8, 42]]);
  assert.deepEqual(at('C-audio'), [22, 8, 42]);
  state().undo();
  assert.deepEqual([at('A'), at('B'), at('C')], [[0, 10, 5], [10, 10, 20], [20, 10, 40]], 'each tool is one undo step');
  store.setState({ tracks: state().tracks.map(t => t.id === 'v1' ? { ...t, locked: true } : t) });
  state().trimEdit('B', 'slide', 'right', 2);
  assert.equal(clip('B').start, 10, 'locked tracks refuse trim tools');
});

test('insert pushes later clips right on the tracks it lands on, cutting the clip under the drop point', () => {
  editFixture();
  store.setState({ media: [...state().media, { ...state().media.find(m => m.id === 'm1')!, id: 'still', kind: 'image', hasAudio: false }], settings: { ...state().settings, stillDuration: 5 } });
  state().addMediaToTimeline('still', 15, 'v1', true);
  const placed = state().clips.find(c => c.mediaId === 'still')!;
  assert.deepEqual([placed.start, placed.duration], [15, 5]);
  assert.deepEqual(at('B'), [10, 5, 20]);
  const right = state().clips.find(c => c.trackId === 'v1' && c.start === 20)!;
  assert.deepEqual([right.duration, right.sourceIn], [5, 25], 'the right half keeps its source offset');
  assert.deepEqual([clip('C').start, clip('C-audio').start], [25, 25], 'later clips keep sync with their sound');
  state().undo();
  assert.deepEqual([at('B'), at('C')], [[10, 10, 20], [20, 10, 40]]);
  assert.equal(state().clips.some(c => c.mediaId === 'still'), false);
  state().addMediaToTimeline('still', 15, 'v1');
  assert.deepEqual([at('B'), clip('C').start], [[10, 5, 20], 20], 'without insert the drop overwrites');
});

test('bins: editors create, rename and delete them; a deleted bin’s media go to the upload bins, never away; old projects show the fixed set', () => {
  const project = () => state().projects.find(p => p.id === 'city-after-dark')!, shown = () => projectBins(project(), state().media), binOf = (id: string) => state().media.find(m => m.id === id)!.binId;
  assert.equal(project().bins, undefined, 'a project from before custom bins has none of its own');
  assert.deepEqual(shown().map(b => b.id), ['interviews', 'broll', 'drone', 'audio', 'graphics'], 'only fixed bins holding media are shown');
  const id = state().createBin('  Selects  ')!;
  assert.deepEqual(shown().at(-1), { id, name: 'Selects' });
  assert.equal(project().bins!.length, 6, 'the first change takes over the list the panel showed');
  state().moveMedia(['m3', 'm7'], id);
  assert.deepEqual([binOf('m3'), binOf('m7')], [id, id]);
  state().renameBin(id, 'Best takes');
  assert.equal(shown().find(b => b.id === id)!.name, 'Best takes');
  state().deleteBin(id);
  assert.equal(shown().some(b => b.id === id), false);
  assert.deepEqual([binOf('m3'), binOf('m7')], ['broll', 'audio'], 'picture goes to B-roll, sound to Audio');
  assert.equal(state().media.length, baseline.media.length, 'no media deleted');
  state().deleteBin('broll');
  assert.ok(shown().some(b => b.id === 'broll'), 'the bin uploads land in stays');
  const before = { bins: project().bins, media: state().media };
  store.setState({ locks: [{ id: 'project-lock', userId: 'ashley', projectId: 'city-after-dark', targetId: 'city-after-dark', field: '*', expiresAt: Date.now() + LOCK_TTL }] });
  state().createBin('Locked out');
  store.setState({ locks: [] });
  state().setCurrentUser('maya');
  state().createBin('Commenter bin'); state().renameBin('drone', 'Air'); state().deleteBin('drone'); state().moveMedia(['m4'], 'broll');
  state().setCurrentUser('kyle');
  assert.deepEqual([project().bins, state().media], [before.bins, before.media], 'a locked project and a non-editor change nothing');
});

test('opening a project lands on its edit even when a composition timeline loads first', () => {
  const main = state().timelines.find(t => t.projectId === 'city-after-dark')!;
  store.setState({ timelines: [{ id: 'title-comp', projectId: 'city-after-dark', name: 'Title', duration: 5, composition: true }, ...state().timelines] });
  state().openProject('the-long-way-home');
  state().openProject('city-after-dark');
  assert.equal(state().timelineId, main.id);
});

test('a property sent as text becomes a number, text that is not one is refused, and a no-op trim adds no history', () => {
  state().updateProperty('c3', 'speed', '50' as unknown as number);
  assert.equal(clip().properties.speed, 50);
  const before = clip().properties.x;
  state().updateProperty('c3', 'x', 'abc' as unknown as number);
  assert.equal(clip().properties.x, before);
  assert.match(state().notifications.at(-1)!.title, /x must be a number/);
  const history = state().operations.length;
  state().trimClip('c3', clip().start, clip().duration);
  assert.equal(state().operations.length, history, 'trimming to the same span is not an undo step');
});

test('Scale X and Scale Y take text numbers, clamp to 1–800 and key like zoom on clips stored before they existed', () => {
  const { scaleX, scaleY, ...old } = clip().properties;
  store.setState({ clips: state().clips.map(c => c.id === 'c3' ? { ...c, properties: old } : c), playhead: clip().start + .5 });
  state().updateProperty('c3', 'scaleX', '130' as unknown as number);
  state().updateProperty('c3', 'scaleY', 5000);
  assert.deepEqual([clip().properties.scaleX, clip().properties.scaleY], [130, 800]);
  state().updateProperty('c3', 'scaleY', 0);
  assert.equal(clip().properties.scaleY, 1);
  state().keyframeProperty('c3', 'properties.scaleX');
  assert.deepEqual(clip().keyframes?.['properties.scaleX']?.map(k => k.value), [130], 'the Inspector keyframe toggle keys it');
});

test('pen points given without a box are frame positions, fitted like the pen tool draws them', () => {
  state().addShape('pen', { closed: true, points: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .5, y: .9 }] });
  const doc = getShape(clip(state().selectedClipId!));
  assert.deepEqual([doc.x, doc.y, +doc.width.toFixed(3), +doc.height.toFixed(3)], [.1, .1, .8, .8]);
  assert.deepEqual(doc.points[2], { x: .5, y: 1 });
});

test('files dropped on a lane land there once ready, at the length the server probed; audio finds its own lane', async () => {
  const { connection } = await import('../services/api.ts');
  const { uploadQueue, fingerprintOf } = await import('../services/upload.ts');
  const was = connection.enabled; connection.enabled = true;
  const p = state().projectId, video = state().media.find(m => m.projectId === p && m.kind === 'video')!;
  const drop = (name: string, kind: 'video' | 'audio') => {
    const file = new File(['x'], name, { lastModified: 1 }), id = `media-${name}`;
    uploadQueue.setState(q => ({ jobs: [...q.jobs, { key: `${p}:${fingerprintOf(file)}`, projectId: p, name, assetId: id, status: 'uploading', candidates: [], progress: { bytes: 0, total: 1, speed: 0, elapsed: 0, message: '' } }] }));
    store.setState({ media: [{ ...video, id, name, kind, status: 'processing', duration: 12.5 }, ...state().media] });
    return { file, id };
  };
  const ready = (id: string) => store.setState({ media: state().media.map(m => m.id === id ? { ...m, status: 'ready' } : m) });
  try {
    const clipFile = drop('drop.mp4', 'video');
    state().uploadMedia([clipFile.file], { start: 30, trackId: 'v1', duration: 12 });
    assert.deepEqual(state().pendingDrops.map(d => [d.trackId, d.start, d.duration, d.name]), [['v1', 30, 12, 'drop.mp4']]);
    assert.ok(!state().clips.some(c => c.mediaId === clipFile.id), 'nothing lands while the server still prepares it');
    ready(clipFile.id);
    const placed = state().clips.find(c => c.mediaId === clipFile.id && c.trackId === 'v1');
    assert.deepEqual([placed?.start, placed?.duration], [30, 12.5]);
    assert.equal(state().pendingDrops.length, 0);

    const song = drop('song.wav', 'audio');
    state().uploadMedia([song.file], { start: 60, trackId: 'v1' });
    ready(song.id);
    assert.equal(state().clips.find(c => c.mediaId === song.id)?.trackId, 'a1');
  } finally { connection.enabled = was; uploadQueue.setState({ jobs: [] }); }
});

// Normalize and color groups. c3 has a legacy grade, c4–c6 none; c14 is an audio clip.
const measured = (clipId: string, balance: Partial<NormalizeShot['balance']> = {}, warnings: NormalizeShot['warnings'] = []): NormalizeShot => ({ clipId, balance: { exposure: .3, temperature: -500, tint: 2, lift: -.01, ...balance }, confidence: .9, warnings });
const gradeOf = (clipId: string) => state().nodes.filter(n => n.clipId === clipId).sort((a, b) => a.order! - b.order!);
const groupNode = (clipId: string) => state().nodes.find(n => n.clipId === clipId && n.group);
const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

test('Normalize makes a color group in one snapshot and one undo; joining copies its values; null and clean; undo restores all', () => {
  const before = structuredClone({ clips: state().clips, nodes: state().nodes }), snapshots = state().snapshots.length;
  assert.equal(state().normalizeColorGroup({ shots: [measured('c3', {}, [{ code: 'clipping', text: 'sky clips' }]), measured('c4', { exposure: -.2 }), measured('c14')] }, { group: { name: 'Night' } }), 2, 'the audio clip is skipped');
  assert.equal(state().snapshots.length, snapshots + 1); assert.equal(state().snapshots[0].name, 'Before Normalize: Night');
  assert.equal(state().operations.length, 1, 'every shot is one undo step');
  assert.equal(state().notifications.at(-1)!.title, 'Normalized 2 shots into Night');
  assert.match(state().notifications.at(-1)!.detail!, /Neon crossing: sky clips · Skipped: Midnight people/);
  const id = clip('c3').properties.colorGroup as string;
  assert.match(id, /^cg-/); assert.equal(clip('c4').properties.colorGroup, id);
  for (const c of ['c3', 'c4']) assert.deepEqual(gradeOf(c).map(n => n.name), ['Input CST', 'Balance', 'Night', 'Look', 'Output CST']);
  assert.deepEqual([gradeOf('c3')[1].parameters.exposure, gradeOf('c4')[1].parameters.exposure, gradeOf('c4')[1].parameters.lift], [.3, -.2, -.01]);
  state().updateColorGroup(id, { parameters: { saturation: 120 } });
  assert.equal(state().normalizeColorGroup({ shots: [measured('c5')] }, { group: { id, name: 'ignored' } }), 1);
  assert.deepEqual([groupNode('c5')!.name, groupNode('c5')!.parameters.saturation], ['Night', 120], 'a new member takes the group values');
  state().normalizeColorGroup({ shots: [measured('c4')] }, { group: null });
  assert.equal(clip('c4').properties.colorGroup, undefined); assert.equal(groupNode('c4'), undefined);
  const look = gradeOf('c3').find(n => n.name === 'Look')!, old = gradeOf('c3').map(n => n.id);
  state().updateNode(look.id, { parameters: { contrast: 1.4 } });
  assert.equal(state().normalizeColorGroup({ shots: [measured('c3', { exposure: .1 })] }, { clean: true }), 1);
  assert.ok(gradeOf('c3').every(n => !old.includes(n.id)), 'clean replaces every node');
  assert.deepEqual([gradeOf('c3').find(n => n.name === 'Look')!.parameters.contrast, gradeOf('c3')[1].parameters.exposure], [1, .1]);
  assert.deepEqual([clip('c3').properties.colorGroup, groupNode('c3')!.parameters.saturation], [id, 120], 'no group asked for: the shot stays in its group');
  for (let i = 0; i < 6; i++) state().undo();
  assert.deepEqual(state().clips, before.clips); assert.deepEqual(byId(state().nodes), byId(before.nodes));
  store.setState({ currentUserId: 'non-editor' }); assert.equal(state().normalizeColorGroup({ shots: [measured('c3')] }), 0);
});

test('a color group changes on every member at once: one undo per drag, through updateNode too; renames; locked shots are named', () => {
  state().normalizeColorGroup({ shots: ['c3', 'c4', 'c5'].map(c => measured(c)) }, { group: { name: 'Day' } });
  const id = clip('c3').properties.colorGroup as string, members = ['c3', 'c4', 'c5'], operations = state().operations.length;
  state().updateColorGroup(id, { parameters: { exposure: .2 } }, 'drag'); state().updateColorGroup(id, { parameters: { exposure: .5 } }, 'drag');
  assert.equal(state().operations.length, operations + 1, 'one drag, one undo step');
  for (const c of members) assert.equal(groupNode(c)!.parameters.exposure, .5);
  state().undo(); for (const c of members) assert.equal(groupNode(c)!.parameters.exposure, 0);
  const curves = { RGB: { mode: 'smooth' as const, points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: .5, y: .6 }, { id: 'c', x: 1, y: 1 }] } }, place = groupNode('c3')!.position;
  state().updateNode(groupNode('c4')!.id, { parameters: { saturation: 80 }, curves, position: { x: 900, y: 40 } });
  for (const c of members) assert.deepEqual([groupNode(c)!.parameters.saturation, groupNode(c)!.curves], [80, curves]);
  assert.deepEqual([groupNode('c4')!.position, groupNode('c3')!.position], [{ x: 900, y: 40 }, place], 'the place stays per node');
  state().updateNode(groupNode('c5')!.id, { name: 'Daylight' });
  state().renameColorGroup(id, '  Dusk ');
  for (const c of members) assert.equal(groupNode(c)!.name, 'Dusk');
  state().undo(); for (const c of members) assert.equal(groupNode(c)!.name, 'Daylight');
  store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: 'city-after-dark', targetId: 'c5', field: 'grade', expiresAt: Date.now() + LOCK_TTL }] });
  state().updateColorGroup(id, { enabled: false });
  assert.deepEqual(members.map(c => groupNode(c)!.enabled), [false, false, true]);
  assert.equal(state().notifications.at(-1)!.title, 'Daylight changed on 2 of 3 shots'); assert.match(state().notifications.at(-1)!.detail!, /Locked: The last train/);
});

test('setColorGroup puts shots after Balance with the group values, makes a new group, takes shots out and refuses a bad id', () => {
  state().normalizeColorGroup({ shots: [measured('c3')] }, { group: { name: 'Wide' } });
  const id = clip('c3').properties.colorGroup as string;
  state().updateColorGroup(id, { parameters: { contrast: 1.2 } });
  state().initializeColorGrade('c4');
  assert.equal(state().setColorGroup(['c4', 'c6'], { id }), id);
  assert.match(state().notifications.at(-1)!.detail!, /Balance node, or is locked: A city still awake/, 'a shot without a wide-gamut grade is named');
  assert.deepEqual(gradeOf('c4').map(n => n.name), ['Input CST', 'Balance', 'Wide', 'Look', 'Output CST']);
  assert.deepEqual([clip('c4').properties.colorGroup, groupNode('c4')!.parameters.contrast, clip('c6').properties.colorGroup], [id, 1.2, undefined]);
  const node = groupNode('c4')!.id, close = state().setColorGroup(['c4'], { name: 'Close' })!;
  assert.match(close, /^cg-/); assert.notEqual(close, id);
  assert.deepEqual([groupNode('c4')!.id, groupNode('c4')!.group, groupNode('c4')!.name, groupNode('c4')!.parameters.contrast], [node, close, 'Close', 1]);
  assert.equal(state().setColorGroup(['c4'], null), undefined);
  assert.deepEqual([clip('c4').properties.colorGroup, groupNode('c4')], [undefined, undefined]);
  assert.equal(state().setColorGroup(['c3'], { id: 'bad id' }), undefined); assert.equal(state().notifications.at(-1)!.title, 'Invalid color group');
});

test('grade paste never changes membership; a new grade keeps a grouped shot in its group', () => {
  state().normalizeColorGroup({ shots: [measured('c3'), measured('c4')] }, { group: { name: 'A' } });
  const a = clip('c3').properties.colorGroup as string;
  state().updateColorGroup(a, { parameters: { exposure: .7 } });
  state().normalizeColorGroup({ shots: [measured('c5')] }, { group: { name: 'B' } });
  const b = clip('c5').properties.colorGroup as string;
  state().copyGrade('c3'); state().pasteGrade('c5');
  assert.equal(clip('c5').properties.colorGroup, b);
  assert.deepEqual(gradeOf('c5').filter(n => n.group).map(n => [n.group, n.name, n.parameters.exposure]), [[b, 'B', 0]], 'the pasted group node becomes B\'s');
  state().pasteGrade('c6');
  const plain = gradeOf('c6').find(n => n.name === 'A')!;
  assert.deepEqual([plain.group, plain.kind, plain.parameters.exposure, clip('c6').properties.colorGroup], [undefined, 'serial', .7, undefined]);
  state().initializeColorGrade('c4');
  assert.deepEqual(gradeOf('c4').map(n => n.name), ['Input CST', 'Balance', 'A', 'Look', 'Output CST']);
  assert.deepEqual([groupNode('c4')!.group, groupNode('c4')!.parameters.exposure], [a, .7]);
});

test('deleting a group node takes the shot out of its group in one undo; a pasted grade with no Balance does too; restoring a DaVinci grade too', () => {
  state().normalizeColorGroup({ shots: ['c3', 'c4', 'c5'].map(c => measured(c)) }, { group: { name: 'Day' } });
  const id = clip('c3').properties.colorGroup as string, node = groupNode('c3')!.id;
  state().removeNode(node);
  assert.deepEqual([clip('c3').properties.colorGroup, groupNode('c3')], [undefined, undefined]);
  assert.deepEqual(state().clips.filter(c => c.properties.colorGroup === id).map(c => c.id).sort(), ['c4', 'c5'], 'no member left without its group node');
  state().undo();
  assert.deepEqual([clip('c3').properties.colorGroup, groupNode('c3')?.id], [id, node]);
  state().copyGrade('c6'); state().pasteGrade('c4');
  assert.deepEqual([clip('c4').properties.colorGroup, groupNode('c4')], [undefined, undefined]);
  assert.equal(state().notifications.at(-1)!.title, `${clip('c4').name} left Day`);
  store.setState({ clips: state().clips.map(c => c.id === 'c5' ? { ...c, properties: { ...c.properties, resolveLookUrl: '/look.cube' } } : c) });
  state().restoreResolveGrade('c5');
  assert.deepEqual([clip('c5').properties.colorGroup, groupNode('c5')], [undefined, undefined]);
});

test('a pasted grouped clip takes its group values now; Normalize skips a shot re-tagged while it was measured', () => {
  state().normalizeColorGroup({ shots: [measured('c3'), measured('c4')] }, { group: { name: 'Day' } });
  const id = clip('c3').properties.colorGroup as string;
  state().copyClip('c3'); state().updateColorGroup(id, { parameters: { exposure: 1 } });
  state().setPlayhead(clip('c3').start + clip('c3').duration + 30); state().pasteClip();
  const pasted = state().selectedClipId!;
  assert.notEqual(pasted, 'c3'); assert.deepEqual([clip(pasted).properties.colorGroup, groupNode(pasted)!.parameters.exposure], [id, 1]);
  const input = interpretation(clip('c5'), state().media.find(m => m.id === clip('c5').mediaId));
  assert.equal(state().normalizeColorGroup({ shots: [{ ...measured('c5'), input }] }), 1, 'unchanged since measured');
  state().updateProperty('c5', 'inputProfile', input.profile === 'S-Log3' ? 'Canon Log 3' : 'S-Log3');
  assert.equal(state().normalizeColorGroup({ shots: [{ ...measured('c5', { exposure: 2 }), input }] }), 0);
  assert.match(state().notifications.at(-1)!.detail!, /\(changed while it was measured: run Normalize again\)/);
  assert.equal(gradeOf('c5')[1].parameters.exposure, .3);
});

// Plan workspace: script, shot list and mood board.
const lines = (scriptId: string) => ordered(state().scriptBlocks.filter(b => b.scriptId === scriptId));
const shot = (id: string) => state().shots.find(s => s.id === id)!;
const card = (id: string) => state().boardItems.find(i => i.id === id)!;

test('addScript makes a script with one empty scene; lines go at the end, the start or after a line', () => {
  const id = state().addScript()!;
  assert.equal(state().scripts.find(s => s.id === id)!.name, 'City After Dark', 'the first script takes the project name');
  assert.deepEqual(lines(id).map(b => [b.kind, b.text]), [['scene', '']]);
  const second = state().addScript()!;
  assert.equal(state().scripts.find(s => s.id === second)!.name, 'Untitled script');
  const [scene] = lines(id);
  const [end] = state().addScriptBlocks(id, [{ kind: 'action', text: 'end' }]);
  const [start] = state().addScriptBlocks(id, [{ kind: 'note', text: 'start' }], null);
  const after = state().addScriptBlocks(id, [{ kind: 'character', text: 'ELENA' }, { kind: 'dialogue', text: 'Hi.' }], scene.id);
  assert.deepEqual(lines(id).map(b => b.id), [start, scene.id, ...after, end]);
  assert.deepEqual([state().addScriptBlocks(id, [{ kind: 'bogus' as never, text: '' }]), state().addScriptBlocks(id, [{ kind: 'action', text: '' }], 'gone'), state().addScriptBlocks('gone', [{ kind: 'action', text: '' }])], [[], [], []]);
  assert.equal(lines(id).length, 5);
});

test('split and merge are a round trip; typing in one gesture is one undo', () => {
  const id = state().addScript('Night')!, [scene] = lines(id);
  state().updateScriptBlock(scene.id, { text: 'INT. KITCHEN - NIGHT' });
  const before = state().operations.length;
  const right = state().splitScriptBlock(scene.id, 12, 'action')!;
  assert.deepEqual(lines(id).map(b => [b.kind, b.text]), [['scene', 'INT. KITCHEN'], ['action', ' - NIGHT']]);
  assert.equal(state().mergeScriptBlock(right), scene.id);
  assert.deepEqual(lines(id).map(b => [b.kind, b.text]), [['scene', 'INT. KITCHEN - NIGHT']]);
  assert.equal(state().mergeScriptBlock(scene.id), undefined, 'the first line has nothing above it');
  assert.equal(state().operations.length, before + 2);
  state().updateScriptBlock(scene.id, { text: 'INT. K' }, 'typing-1');
  state().updateScriptBlock(scene.id, { text: 'INT. KITCHEN - DAY' }, 'typing-1');
  state().updateScriptBlock(scene.id, { text: 'INT. KITCHEN - DAY' }, 'typing-1');
  assert.equal(state().operations.length, before + 3, 'one typing session is one history row');
  assert.equal(state().operations[0].description, 'edited scene 1');
  state().undo();
  assert.equal(lines(id)[0].text, 'INT. KITCHEN - NIGHT');
});

test('a Commenter cannot change the script, the shot list or the board', () => {
  const id = state().addScript()!, [scene] = lines(id), shotId = state().addShot()!, [cardId] = state().addBoardItems([{ kind: 'note', text: 'mood' }]);
  const before = structuredClone([state().scripts, state().scriptBlocks, state().shots, state().boardItems]);
  state().setCurrentUser('maya');
  state().updateScriptBlock(scene.id, { text: 'x' }); state().addScriptBlocks(id, [{ kind: 'action', text: 'x' }]); state().deleteScript(id);
  state().updateShot(shotId, { text: 'x' }); state().addShot(); state().deleteShots([shotId]);
  state().updateBoardItems([{ id: cardId, patch: { x: 500 } }]); state().addBoardItems([{ kind: 'note' }]); state().deleteBoardItems([cardId]);
  assert.equal(state().addScript(), undefined);
  assert.match(state().notifications.at(-1)!.title, /editor role/);
  assert.deepEqual([state().scripts, state().scriptBlocks, state().shots, state().boardItems], before);
});

test('deleting a script takes its lines and unlinks its shots in one undo; deleting a scene unlinks too', () => {
  const id = state().addScript()!, [scene] = lines(id), other = state().addScript('B')!;
  const shotId = state().addShot({ sceneId: scene.id })!;
  state().addScriptBlocks(id, [{ kind: 'action', text: 'a' }]);
  state().deleteScript(id);
  assert.deepEqual([state().scripts.map(s => s.id), lines(id), shot(shotId).sceneId], [[other], [], undefined]);
  state().undo();
  assert.deepEqual([lines(id).length, shot(shotId).sceneId], [2, scene.id]);
  state().deleteScriptBlocks([scene.id]);
  assert.deepEqual([lines(id).map(b => b.text), shot(shotId).sceneId], [['a'], undefined]);
});

test('shots number themselves: 1A, 1B under scene 1 and kept together, else 1, 2; fields clear and rows move', () => {
  const id = state().addScript()!, [one] = lines(id), [two] = state().addScriptBlocks(id, [{ kind: 'scene', text: 'EXT. ROOF' }]);
  const loose = state().addShot()!, a = state().addShot({ sceneId: one.id })!, twoA = state().addShot({ sceneId: two })!, b = state().addShot({ sceneId: one.id })!, loose2 = state().addShot()!;
  assert.deepEqual([loose, a, twoA, b, loose2].map(i => shot(i).number), ['1', '1A', '2A', '1B', '2']);
  assert.deepEqual(ordered(state().shots).map(s => s.id), [loose, a, b, twoA, loose2]);
  assert.equal(state().operations[0].description, 'added shot 2');
  const first = state().addShot({ number: '  9  ', size: 'Wide', cast: '  ' }, null)!;
  assert.deepEqual([shot(first).number, shot(first).size, 'cast' in shot(first), ordered(state().shots)[0].id], ['9', 'Wide', false, first]);
  state().updateShot(first, { size: '', sceneId: one.id, done: true });
  assert.deepEqual([shot(first).size, shot(first).sceneId, shot(first).done], [undefined, one.id, true]);
  state().updateShot(first, { number: ' ' });
  assert.equal(shot(first).number, '9');
  state().moveShot(first, loose2);
  assert.equal(ordered(state().shots).at(-1)!.id, first);
  state().deleteShots([first, loose]);
  assert.equal(state().shots.length, 4);
});

test('linkShotMedia adds a take once, refuses media of another project, and unlinks', () => {
  const id = state().addShot()!;
  state().linkShotMedia(id, 'm1'); state().linkShotMedia(id, 'm1'); state().linkShotMedia(id, 'm2'); state().linkShotMedia(id, 'nope');
  assert.deepEqual(shot(id).mediaIds, ['m1', 'm2']);
  state().linkShotMedia(id, 'm1', false); state().linkShotMedia(id, 'm2', false);
  assert.equal('mediaIds' in shot(id), false);
});

test('board cards: defaults and clamps, one undo for a multi-card drag, colors checked, delete', () => {
  const ids = state().addBoardItems([{ kind: 'note', text: 'warm' }, { kind: 'swatch', color: '#ABCDEF', x: 5e6, w: 1 }, { kind: 'image', mediaId: 'm10' }, { kind: 'image', mediaId: 'm7' }]);
  assert.equal(ids.length, 3, 'audio is not a picture');
  assert.deepEqual(ids.map(i => [card(i).w, card(i).h, card(i).color, card(i).z]), [[220, 160, '#f2c878', 1], [8, 150, '#abcdef', 2], [320, 220, undefined, 3]]);
  assert.equal(card(ids[1]).x, 1e6);
  const before = state().operations.length;
  for (const step of [10, 20, 30]) state().updateBoardItems(ids.slice(0, 2).map(id => ({ id, patch: { x: step, y: step } })), 'drag-1');
  assert.deepEqual([state().operations.length, state().operations[0].description, card(ids[1]).x], [before + 1, 'moved 2 board cards', 30]);
  state().undo();
  assert.deepEqual([card(ids[0]).x, card(ids[1]).x], [0, 1e6]);
  state().updateBoardItems([{ id: ids[0], patch: { color: 'red' } }]);
  state().updateBoardItems([{ id: ids[0], patch: { text: '' } }]);
  assert.deepEqual([card(ids[0]).color, 'text' in card(ids[0])], ['#f2c878', false]);
  state().deleteBoardItems(ids);
  assert.equal(state().boardItems.length, 0);
});

test('Plan edits never make a row the server refuses: whole-card locks, z and computed shot numbers are capped', () => {
  const [id] = state().addBoardItems([{ kind: 'note', text: 'warm' }]);
  store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: 'city-after-dark', targetId: id, field: 'manipulation', expiresAt: Date.now() + LOCK_TTL }] });
  state().updateBoardItems([{ id, patch: { text: 'cold' } }]);
  assert.equal(card(id).text, 'warm', 'the server locks the whole card (423), so the store does too');
  store.setState({ locks: [] });
  state().updateBoardItems([{ id, patch: { z: 1e20 } }]);
  assert.equal(card(id).z, PLAN_LIMITS.coord);
  state().addShot({ number: '9999999999999999' });
  assert.equal(shot(state().addShot()!).number.length, PLAN_LIMITS.shotNumber);
});

test('a line squeezed into a spent gap renumbers its script in the same commit', () => {
  const id = state().addScript()!, [a] = lines(id), [b] = state().addScriptBlocks(id, [{ kind: 'action', text: 'b' }]);
  store.setState({ scriptBlocks: state().scriptBlocks.map(x => x.id === b ? { ...x, order: 1 + 1e-12 } : x) });
  const before = state().operations.length;
  const [c] = state().addScriptBlocks(id, [{ kind: 'action', text: 'c' }], a.id);
  assert.deepEqual(lines(id).map(x => [x.id, x.order]), [[a.id, 1], [c, 2], [b, 3]]);
  assert.equal(state().operations.length, before + 1);
  state().undo();
  assert.deepEqual(lines(id).map(x => [x.id, x.order]), [[a.id, 1], [b, 1 + 1e-12]]);
});

test('a spent gap respreads only nearby lines nobody else holds; boxed in by held lines, nothing is placed', () => {
  const id = state().addScript()!, [one] = lines(id), [ada, two, bo] = state().addScriptBlocks(id, [{ kind: 'action', text: 'Ada' }, { kind: 'scene', text: 'INT. TWO' }, { kind: 'action', text: 'Bo' }]);
  const lock = (targetId: string) => ({ id: `remote-${targetId}`, userId: 'ashley', projectId: 'city-after-dark', targetId, field: 'text', expiresAt: Date.now() + LOCK_TTL });
  store.setState({ locks: [lock(bo)] });
  const held = structuredClone(lines(id).find(b => b.id === bo)!), typed: string[] = [];
  for (let i = 0; i < 80; i++) typed.push(...state().addScriptBlocks(id, [{ kind: 'action', text: `${i}` }], typed.at(-1) ?? ada));
  const all = lines(id);
  assert.deepEqual(all.map(b => b.id), [one.id, ada, ...typed, two, bo], 'every line stays in its scene');
  assert.deepEqual(all.find(b => b.id === bo), held, 'the held line is never rewritten (the server would refuse it)');
  assert.equal(new Set(all.map(b => b.order)).size, all.length);
  store.setState({ scriptBlocks: state().scriptBlocks.map(b => b.id === two ? { ...b, order: all.at(-3)!.order + 1e-13 } : b), locks: [lock(typed.at(-1)!), lock(two)], notifications: [] });
  assert.deepEqual(state().addScriptBlocks(id, [{ kind: 'action', text: 'x' }], typed.at(-1)), []);
  assert.equal(state().notifications.at(-1)!.title, 'A collaborator is editing nearby');
});

test('deleting a scene or its script leaves a shot a collaborator holds linked, so the delete still undoes', () => {
  const id = state().addScript()!, [scene] = lines(id), held = state().addShot({ sceneId: scene.id })!, free = state().addShot({ sceneId: scene.id })!;
  store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: 'city-after-dark', targetId: held, field: 'row', expiresAt: Date.now() + LOCK_TTL }] });
  const before = structuredClone(shot(held));
  for (const remove of [() => state().deleteScriptBlocks([scene.id]), () => state().deleteScript(id)]) {
    remove();
    assert.deepEqual([shot(held), shot(free).sceneId], [before, undefined]);
    state().undo();
    assert.deepEqual([lines(id).map(b => b.id), shot(free).sceneId, state().notifications.some(n => /newer change/.test(n.title))], [[scene.id], scene.id, false]);
  }
});

test('media on the mood board cannot be removed', () => {
  store.setState({ media: [...state().media, { ...state().media.find(m => m.id === 'm10')!, id: 'still-1' }] });
  const [id] = state().addBoardItems([{ kind: 'image', mediaId: 'still-1' }]);
  state().removeMedia('still-1');
  assert.ok(state().media.some(m => m.id === 'still-1'));
  assert.equal(state().notifications.at(-1)!.title, 'That image is on the mood board');
  state().deleteBoardItems([id]); state().removeMedia('still-1');
  assert.ok(!state().media.some(m => m.id === 'still-1'));
});

test('openPlan and setColorReference switch the workspace; openProject clears focus and reference', () => {
  state().openPlan('board', 'card-1');
  assert.deepEqual([state().workspace, state().planTab, state().planFocus], ['plan', 'board', 'card-1']);
  state().setColorReference('m7');
  assert.deepEqual([state().workspace, state().colorReference], ['plan', null], 'audio is no picture');
  state().setColorReference('m10');
  assert.deepEqual([state().workspace, state().colorReference], ['color', 'm10']);
  state().openProject('city-after-dark');
  assert.deepEqual([state().planFocus, state().colorReference], [null, null]);
});

test('a script line a collaborator holds or changed since cannot be edited or undone over', () => {
  const id = state().addScript()!, [scene] = lines(id);
  state().updateScriptBlock(scene.id, { text: 'INT. HALL' });
  state().setCurrentUser('ashley');
  state().updateScriptBlock(scene.id, { text: 'INT. HALL - LATER' });
  state().setCurrentUser('kyle');
  state().undo();
  assert.equal(lines(id)[0].text, 'INT. HALL - LATER');
  assert.match(state().notifications.at(-1)!.title, /newer change/);
  store.setState({ locks: [{ id: 'remote', userId: 'ashley', projectId: 'city-after-dark', targetId: scene.id, field: 'text', expiresAt: Date.now() + LOCK_TTL }] });
  state().updateScriptBlock(scene.id, { text: 'mine' });
  assert.equal(lines(id)[0].text, 'INT. HALL - LATER');
  assert.match(state().notifications.at(-1)!.title, /is editing/);
});

test('a library look replaces a node\'s look tools in one undo step; exposure, windows and the qualifier stay; New Node before the output makes room', () => {
  state().initializeColorGrade('c3');
  const nodes = () => state().nodes.filter(n => n.clipId === 'c3').sort((a, b) => a.order! - b.order!), look = nodes()[2];
  state().updateNode(look.id, { parameters: { ...look.parameters, exposure: .4, logShadowB: .05, mixRR: .8, circOn: 1, qualOn: 1, filmGrain: 40 }, curves: { SatSat: { mode: 'smooth', points: [{ id: 'a', x: 0, y: .3 }, { id: 'b', x: 1, y: .6 }] } } });
  state().applyColorLook(look.id, 'kodak-2383', .5);
  const p = state().nodes.find(n => n.id === look.id)!.parameters;
  assert.equal(p.contrast, 1.08); assert.equal(p.filmHalation, 9); assert.equal(p.filmHalationThreshold, 2, 'sizes and thresholds are set outright');
  assert.equal(p.exposure, .4); assert.equal(p.circOn, 1); assert.equal(p.qualOn, 1, 'balance, windows and the key stay');
  assert.equal(p.logShadowB, .003); assert.equal(p.mixRR, 1, 'look tools the look does not set go neutral');
  assert.equal(state().nodes.find(n => n.id === look.id)!.curves?.SatSat, undefined, 'curves are the look\'s');
  state().undo(); const back = state().nodes.find(n => n.id === look.id)!;
  assert.equal(back.parameters.mixRR, .8); assert.equal(back.parameters.filmGrain, 40); assert.ok(back.curves?.SatSat);
  state().applyColorLook(look.id, 'no-such-look'); assert.ok(state().notifications.some(n => /Unknown look/.test(n.title)));
  const output = nodes()[3], before = output.position!.x;
  state().selectNode(null); state().addNode('Film', { filmGrain: 20 });
  const added = nodes()[3]; assert.equal(added.name, 'Film'); assert.equal(nodes()[4].id, output.id);
  assert.ok(nodes()[4].position!.x - added.position!.x >= 150 && nodes()[4].position!.x === before + 170, 'the output CST moved over instead of sitting under the new node');
});

test('a film stock on a legacy (Gamma 2.4) node keeps the legacy pivot .5, even though the stock sets no pivot', () => {
  state().selectClip('c3'); state().addNode('Look', { exposure: 0, contrast: 1, pivot: .5, saturation: 100 });
  const id = state().selectedNodeId!; state().applyColorLook(id, 'kodak-2383');
  const p = state().nodes.find(n => n.id === id)!.parameters;
  assert.equal(p.pivot, .5); assert.equal(p.contrast, 1.16);
});

test('cross-project paste after navigation and reload links media and remaps every selected clip and grade', async()=>{
  const { connection }=await import('../services/api.ts');
  const oldStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),oldFetch=globalThis.fetch,oldConnection={...connection};const memory=new Map<string,string>();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>memory.set(k,v)}});
  try{
    store.setState({...createDemoProject(),locks:[]});
    const original=structuredClone(clip('c3'));
    store.setState(s=>({clips:[...s.clips,{...structuredClone(original),id:'clipboard-peer',trackId:'a1',start:original.start+1}],selectedClipIds:[original.id,'clipboard-peer']}));state().copyClip(original.id);
    const target=state().createProject({name:'Paste destination',description:'',shared:false});state().openProject(target);
    store.setState({clipboard:null,clipboardClips:[],clipboardNodes:[],playhead:5});
    connection.enabled=true;connection.flush=async()=>{};connection.receiveMedia=asset=>store.setState(s=>({media:[asset,...s.media]}));
    const sourceMedia=state().media.find(m=>m.id===original.mediaId)!;
    globalThis.fetch=async(_url,options)=>{assert.equal(_url,'/api/media/link');assert.equal(JSON.parse(options!.body as string).projectId,target);return new Response(JSON.stringify({mapping:{[original.mediaId]:'linked'},assets:[{...sourceMedia,id:'linked',projectId:target}],revision:1}),{status:200,headers:{'content-type':'application/json'}});};
    await state().pasteClip();const placed=state().clips.filter(c=>state().selectedClipIds.includes(c.id));assert.equal(placed.length,2);assert.equal(placed[1].start,6);assert.ok(placed.every(c=>c.projectId===target&&c.timelineId===state().timelineId));assert.equal(placed[0].mediaId,'linked');assert.equal(placed[0].start,5);assert.equal(placed[0].sourceIn,original.sourceIn);
    const count=placed.length;state().undo();assert.ok(placed.every(c=>!state().clips.some(x=>x.id===c.id)));state().redo();assert.equal(state().clips.filter(c=>placed.some(x=>x.id===c.id)).length,count);
  }finally{Object.assign(connection,oldConnection);globalThis.fetch=oldFetch;if(oldStorage)Object.defineProperty(globalThis,'localStorage',oldStorage);else Reflect.deleteProperty(globalThis,'localStorage');}
});
