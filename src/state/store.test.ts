import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useEditorStore as store } from './store.ts';
import { createDemoProject } from './demo.ts';
import { defaultShape, getShape } from '../services/shapes.ts';
import { evaluateClip } from '../services/animation.ts';
import type { Keyframe } from './models.ts';
import { LOCK_TTL, mediaService, projectService, renderService, STORAGE_KEY } from '../services/index.ts';

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

test('In/Out range is finite, ordered, bounded, temporary, and resets with the timeline', () => {
  state().setRange(-20, 240);
  assert.deepEqual([state().rangeIn, state().rangeOut], [0, 180]);
  state().setRange(90, 25);
  assert.deepEqual([state().rangeIn, state().rangeOut], [25, 90]);
  state().setRange(Number.NaN, 20);
  assert.deepEqual([state().rangeIn, state().rangeOut], [25, 90]);
  assert.equal(state().operations.length, 0);
  state().setTimeline('review-timeline');
  assert.deepEqual([state().rangeIn, state().rangeOut], [0, 180]);
  state().setRange(10, 20);
  state().openProject('the-long-way-home');
  assert.deepEqual([state().rangeIn, state().rangeOut], [0, 180]);
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
  const { projects, media, timelines, clips, tracks, nodes, comments, operations, snapshots, renderJobs, users, currentUserId, settings } = state();
  projectService.save({ projects, media, timelines, clips, tracks, nodes, comments, operations, snapshots, renderJobs, users, currentUserId, settings });
  const raw = JSON.parse(memory.get(STORAGE_KEY)!);
  assert.equal(raw.version, 1);
  assert.equal('presence' in raw.state, false);
  assert.equal('locks' in raw.state, false);
  assert.deepEqual(projectService.load()!.clips, clips);
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
  assert.equal(state().nodes.find(n => n.id === node.id)!.mask!.id, mask.id);
  state().updateNode(node.id,{mask:undefined});
  assert.equal(state().nodes.find(n=>n.id===node.id)!.mask,undefined);
  assert.equal(clip().smartMasks![0].id,mask.id);
  state().undo();
  assert.equal(state().nodes.find(n=>n.id===node.id)!.mask!.id,mask.id);
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
  const copiedMask=state().nodes.find(n=>n.clipId===duplicate.id&&n.mask)?.mask;
  assert.ok(copiedMask);assert.notEqual(copiedMask.id,original.id);
  assert.ok(state().clips.find(c=>c.id===duplicate.id)!.smartMasks!.some(m=>m.id===copiedMask.id));
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
