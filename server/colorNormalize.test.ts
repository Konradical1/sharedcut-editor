import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { primaryDefaults, starterGrade } from '../src/services/color.ts';
import { normalizedGrade, normalizeStages } from '../src/services/colorGroups.ts';
import type { Clip, GradeNode, MediaAsset } from '../src/state/models.ts';
import { ColorAssistantError, colorPython, shotSource } from './colorAssistant.ts';
import { cleanResult, colorNormalizeService, type NormalizeJob } from './colorNormalize.ts';
import { createFrameLineServer } from './index.ts';
import { FILMSTRIP_VERSION, type run } from './media.ts';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const withEnv = async (values: Record<string, string | undefined>, work: () => Promise<void>) => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const set = (entries: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(entries)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  set(values);
  try { await work(); } finally { set(previous); }
};
const clip = (id: string, mediaId: string, start: number, extra: Clip['properties'] = {}): Clip => ({ id, projectId: 'film', timelineId: 'timeline', trackId: 'track', mediaId, name: `Shot ${id}`, start, duration: 2, sourceIn: .5, color: '#888888', disabled: false, properties: { speed: 100, colorPipeline: 'nodes-v2', ...extra }, effects: [] });
const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({ id, projectId: 'film', name: `${id}.mp4`, kind: 'video', binId: '', thumbnail: '', duration: 3, resolution: '640 × 360', fps: 24, size: '1 MB', status: 'ready', progress: 100, hasAudio: false, colorMatrix: 'bt709', filmstripVersion: FILMSTRIP_VERSION, camera: 'Test Camera', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine', cameraMetadataVersion: 2, ...extra });
const grade = (c: Clip, a: MediaAsset) => { let n = 0; return starterGrade(c, a, () => `${c.id}-${++n}`); };
const waitFor = async (read: () => NormalizeJob, done = (job: NormalizeJob) => !['waiting', 'running'].includes(job.status)) => { for (const t = Date.now(); !done(read()) && Date.now() - t < 120_000;) await new Promise(r => setTimeout(r, 50)); return read(); };
type Run = typeof run;

/** Shots: two of one camera, one of another, a still, an adjustment clip, one with a missing original and one with an unreadable source setting. */
function project() {
  const media = [asset('cam'), asset('other', { camera: 'Second Camera', colorEvidence: 'Canon maker notes (Canon EOS R6m2): Canon Log 3 / Cinema Gamut', inputProfile: 'Canon Log 3', inputGamut: 'Cinema Gamut' }), asset('still', { kind: 'image' }), asset('gone')];
  const clips = [clip('a', 'cam', 0), clip('b', 'cam', 2), clip('c', 'other', 4), clip('photo', 'still', 6), clip('adjust', 'frameline-adjustment', 8), clip('lost', 'gone', 10), clip('odd', 'cam', 12, { inputProfile: 'Bogus' }), clip('fresh', 'cam', 14, { colorPipeline: 'legacy' })];
  const nodes = clips.filter(c => c.id !== 'fresh' && c.id !== 'odd').flatMap(c => grade(c, media.find(a => a.id === c.mediaId) ?? media[0]));
  return { projectId: 'film', clips, media, nodes, source: (id: string) => id === 'gone' ? join(tmpdir(), 'no-such-original') : process.execPath };
}

test('requests are checked: shots of this project, each once, at most 200 targets and 300 in all', () => withEnv({ FRAME_LINE_COLOR_PYTHON: process.execPath }, async () => {
  const service = colorNormalizeService(await mkdtemp(join(tmpdir(), 'sharedcut-normalize-'))), input = project();
  const start = (body: Record<string, unknown>) => service.start({ ...input, body });
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const big = { ...input, clips: [...input.clips, ...many(300, 'x').map((id, i) => clip(id, 'cam', 20 + i))] };
  for (const [body, pattern] of [[{}, /1 to 200/], [{ clipIds: [] }, /1 to 200/], [{ clipIds: 'a' }, /1 to 200/], [{ clipIds: ['nope'] }, /not in this project/], [{ clipIds: ['a'], contextIds: ['nope'] }, /not in this project/],
    [{ clipIds: ['a', 'a'] }, /twice/], [{ clipIds: ['a'], contextIds: ['a'] }, /twice/], [{ clipIds: ['a'], contextIds: 'b' }, /300/], [{ clipIds: ['a'], clean: 'yes' }, /clean/]] as const)
    assert.throws(() => start(body), (error: ColorAssistantError) => error.status === 400 && pattern.test(error.message), JSON.stringify(body));
  assert.throws(() => service.start({ ...big, body: { clipIds: many(201, 'x') } }), /1 to 200/);
  assert.throws(() => service.start({ ...big, body: { clipIds: many(200, 'x'), contextIds: [...many(100, 'x').map((_, i) => `x${200 + i}`), 'a'] } }), /300/);
  assert.throws(() => service.start({ ...input, projectId: 'elsewhere', body: { clipIds: ['a'] } }), /not in this project/, 'a clip id never crosses projects');
  await withEnv({ FRAME_LINE_COLOR_PYTHON: join(tmpdir(), 'no-such-color-python') }, async () => assert.throws(() => start({ clipIds: ['a'] }), (error: ColorAssistantError) => error.status === 503 && /npm run setup:color/.test(error.message)));
  await service.close();
}));

test('shots that cannot be measured are skipped with a reason; nothing usable fails the job at once', () => withEnv({ FRAME_LINE_COLOR_PYTHON: process.execPath }, async () => {
  const service = colorNormalizeService(await mkdtemp(join(tmpdir(), 'sharedcut-normalize-'))), input = project();
  const { jobId } = service.start({ ...input, body: { clipIds: ['photo', 'adjust', 'lost', 'odd'] } }), job = service.get('film', jobId);
  assert.equal(job.status, 'failed'); assert.match(job.error!, /None of the chosen shots can be normalized/);
  assert.deepEqual(job.skipped.map(s => [s.clipId, s.code]), [['photo', 'not-video'], ['adjust', 'not-video'], ['lost', 'missing-media'], ['odd', 'invalid-grade']]);
  assert.equal(service.latest('film')?.id, jobId); assert.equal(service.latest('elsewhere'), null);
  assert.throws(() => service.get('elsewhere', jobId), (error: ColorAssistantError) => error.status === 404, 'a job id never crosses projects');
  await service.close();
}));

test('the worker gets every shot (context included, one setup per camera); its answer is kept to the targets and the Balance limits, and progress follows it', () => withEnv({ FRAME_LINE_COLOR_PYTHON: process.execPath }, async () => {
  let spec: { width: number; targets: string[]; hdrCubes?: Record<string, unknown>; shots: { clipId: string; setup: string; preStages: unknown[]; postStages: unknown[]; key: string; sdr: boolean; hdrCube?: unknown }[] } | undefined;
  const seen: number[] = [];
  let service: ReturnType<typeof colorNormalizeService>, jobId = '';
  const fake: Run = async (_command, args, options) => {
    spec = JSON.parse(readFileSync(args[2], 'utf8'));
    for (const p of [12, 59, 75]) { options!.onProgress!(p); seen.push(service.get('film', jobId).progress); }
    assert.equal(service.get('film', jobId).stage, 'Balancing shots');
    return Buffer.from(`${JSON.stringify({ shots: [
      { clipId: 'a', balance: { exposure: 9, temperature: -900, tint: 4, lift: -.01 }, confidence: 2, key: -1.2, cast: [.1, -.1], warnings: [{ code: 'clipping', text: 'Clipped.' }, { code: 'made-up', text: 'x' }] },
      { clipId: 'b', balance: { exposure: 'NaN', temperature: 0, tint: 0, lift: 0 }, confidence: .5, warnings: [] },
      { clipId: 'c', balance: { exposure: .2, temperature: 0, tint: 0, lift: 0 }, confidence: .9, warnings: [] }], level: { group: -1, target: -.25 }, failed: [] })}\n`);
  };
  service = colorNormalizeService(await mkdtemp(join(tmpdir(), 'sharedcut-normalize-')), fake);
  const input = project(), hlg = { ...input, media: input.media.map(a => a.id === 'other' ? { ...a, colorTransfer: 'arib-std-b67' } : a) };
  ({ jobId } = service.start({ ...hlg, body: { clipIds: ['a', 'b', 'photo', 'fresh'], contextIds: ['c', 'lost'] } }));
  const job = await waitFor(() => service.get('film', jobId));
  assert.equal(job.status, 'done', job.error); assert.equal(job.progress, 100); assert.deepEqual(seen, [12, 59, 75]);
  assert.equal(spec!.width, 640); assert.deepEqual(spec!.targets, ['a', 'b', 'fresh']); assert.deepEqual(spec!.shots.map(s => s.clipId), ['a', 'b', 'fresh', 'c'], 'context shots are measured, never answered for');
  const shot = (id: string) => spec!.shots.find(s => s.clipId === id)!;
  assert.equal(shot('a').setup, shot('b').setup); assert.notEqual(shot('a').setup, shot('c').setup); assert.match(shot('c').setup, /Canon EOS R6m2/);
  assert.ok(spec!.shots.every(s => s.preStages.length && s.postStages.length && !s.sdr), 'a fresh grade is measured through its Input CST and shown through its output');
  assert.equal(shot('fresh').key.length, 64); assert.ok(!shot('a').hdrCube); assert.equal((spec!.hdrCubes as Record<string, { data: number[] }>)[shot('c').hdrCube as string].data.length, 33 ** 3 * 3, 'HLG is tone-mapped like the export, one table per transfer');
  assert.deepEqual(job.result!.shots, [{ clipId: 'a', balance: { exposure: 4, temperature: -900, tint: 4, lift: -.01 }, confidence: 1, key: -1.2, warnings: [{ code: 'clipping', text: 'Clipped.' }], input: { profile: 'S-Log3', gamut: 'S-Gamut3.Cine' } }], 'clamped, the context shot and a broken balance left out; the interpretation measured rides along');
  assert.deepEqual(job.result!.level, { group: -1, target: -.25 });
  assert.deepEqual(job.skipped.map(s => [s.clipId, s.code]), [['photo', 'not-video'], ['b', 'decode-failed'], ['fresh', 'decode-failed']], 'a target without a usable answer is reported');
  await service.close();
}));

/** A plain correction between the Input CST and Balance, as New Node leaves one with the Input CST selected. */
const fixNode = (nodes: GradeNode[], clipId: string): GradeNode => { const [input, balance] = nodes.filter(n => n.clipId === clipId); return { ...structuredClone(balance), id: `fix-${clipId}`, name: 'Fix', order: ((input.order ?? 0) + (balance.order ?? 0)) / 2, parameters: { ...primaryDefaults, exposure: 1 } }; };
const nodeIds = (stages: { node: { id: string } }[]) => [...new Set(stages.map(s => s.node.id))];

test('every node before Balance is measured (a masked one turns the shot away); the frame key ignores ids, names and order', () => {
  const c = clip('a', 'cam', 0), a = asset('cam'), nodes = grade(c, a), fix = fixNode(nodes, 'a');
  const { pre, post } = normalizeStages(c, a, [...nodes, fix]);
  assert.deepEqual([nodeIds(pre), nodeIds(post)], [[nodes[0].id, 'fix-a'], [nodes[3].id]], 'the app applies Fix before Balance, so it is measured');
  assert.deepEqual(nodeIds(normalizeStages(c, a, [...nodes, fix], { clean: true }).pre).length, 1, 'clean: measured as rebuilt, the Input CST only');
  assert.throws(() => normalizeStages(c, a, [...nodes, { ...fix, mask: { source: 'depth', enabled: true, invert: false, amount: 100, near: 50, far: 100, softness: 10 } as GradeNode['mask'] }]), /mask/);
  // A fresh grade is measured with stand-in ids, then applied with real ones: the second run must reuse the first run's frames.
  const fresh = clip('fresh', 'cam', 0, { colorPipeline: 'legacy' }), key = (shot: Clip, own: GradeNode[]) => shotSource(shot, a, normalizeStages(shot, a, own).pre).key;
  let n = 0; const applied = normalizedGrade(fresh, a, [], { balance: { exposure: .4, temperature: 0, tint: 0, lift: 0 } }, () => `real-${++n}`), after = { ...fresh, properties: { ...fresh.properties, ...applied.properties } };
  assert.equal(key(after, applied.next), key(fresh, []));
  assert.notEqual(key(after, [...applied.next, fixNode(applied.next, 'fresh')]), key(after, applied.next), 'a node that changes the picture changes the key');
});

test('clean targets are measured as rebuilt, context shots through their own grade; the HDR table is in the key; shots carry the interpretation measured', () => withEnv({ FRAME_LINE_COLOR_PYTHON: process.execPath }, async () => {
  const specs: { shots: { clipId: string; key: string; preStages: { node: { id: string } }[] }[] }[] = [];
  const fake: Run = async (_command, args) => { const spec = JSON.parse(readFileSync(args[2], 'utf8')); specs.push(spec); return Buffer.from(`${JSON.stringify({ shots: spec.targets.map((clipId: string) => ({ clipId, balance: { exposure: 0, temperature: 0, tint: 0, lift: 0 }, confidence: 1, warnings: [] })), level: null })}\n`); };
  const service = colorNormalizeService(await mkdtemp(join(tmpdir(), 'sharedcut-normalize-')), fake), input = project();
  const hlg = { ...input, nodes: [...input.nodes, fixNode(input.nodes, 'a'), fixNode(input.nodes, 'b')], media: input.media.map(m => m.id === 'other' ? { ...m, colorTransfer: 'arib-std-b67' } : m) };
  const measure = async (body: Record<string, unknown>) => {
    const { jobId } = service.start({ ...hlg, body }), job = await waitFor(() => service.get('film', jobId)), spec = specs.at(-1)!, shot = (id: string) => spec.shots.find(s => s.clipId === id)!;
    assert.equal(job.status, 'done', job.error); return { job, nodes: (id: string) => nodeIds(shot(id).preStages), key: (id: string) => shot(id).key };
  };
  const plain = await measure({ clipIds: ['a', 'c'], contextIds: ['b'] }), clean = await measure({ clipIds: ['a', 'c'], contextIds: ['b'], clean: true });
  assert.deepEqual(plain.nodes('a'), [input.nodes.find(n => n.clipId === 'a')!.id, 'fix-a']);
  assert.equal(clean.nodes('a').length, 1, 'a clean target: the rebuilt Input CST only');
  assert.deepEqual(clean.nodes('b'), plain.nodes('b'), 'a context shot is never rebuilt, so it is measured through its own grade');
  assert.deepEqual(clean.job.result!.shots.map(s => [s.clipId, s.input]), [['a', { profile: 'S-Log3', gamut: 'S-Gamut3.Cine' }], ['c', { profile: 'Canon Log 3', gamut: 'Cinema Gamut' }]]);
  await withEnv({ FRAME_LINE_HDR_NPL: '203' }, async () => { const other = await measure({ clipIds: ['a', 'c'] }); assert.notEqual(other.key('c'), plain.key('c'), 'another HDR table, other frames'); assert.equal(other.key('a'), plain.key('a')); });
  await service.close();
}));

test('a phone shot keeps its mid-tone gamma and gain; out-of-range values are clamped, a camera shot carries none', () => {
  const r = cleanResult({ shots: [
    { clipId: 'phone', balance: { exposure: 0, temperature: 0, tint: 0, lift: 0, gamma: 2, gain: .77 }, confidence: .5, warnings: [] },
    { clipId: 'cam', balance: { exposure: 9, temperature: 0, tint: 0, lift: -.05 }, confidence: 1, warnings: [] },
  ], level: { group: 0, target: .5 } }, ['phone', 'cam']);
  assert.deepEqual(r.shots.map(s => s.balance), [{ exposure: 0, temperature: 0, tint: 0, lift: 0, gamma: 1, gain: .77 }, { exposure: 4, temperature: 0, tint: 0, lift: -.05 }]);
});

test('cancel stops a waiting or running job, a fifth job is refused as busy, and close() lets go of the worker', () => withEnv({ FRAME_LINE_COLOR_PYTHON: process.execPath }, async () => {
  let running = 0;
  const fake: Run = (_command, _args, options) => new Promise((_, reject) => { running++; options!.signal!.addEventListener('abort', () => { running--; reject(Error('Canceled by you')); }); });
  const service = colorNormalizeService(await mkdtemp(join(tmpdir(), 'sharedcut-normalize-')), fake), input = project();
  const ids = Array.from({ length: 4 }, () => service.start({ ...input, body: { clipIds: ['a'] } }).jobId);
  assert.throws(() => service.start({ ...input, body: { clipIds: ['a'] } }), (error: ColorAssistantError) => error.status === 429);
  await waitFor(() => service.get('film', ids[0]), job => job.status === 'running');
  assert.equal(service.get('film', ids[1]).status, 'waiting', 'one job at a time');
  service.cancel('film', ids[1]); assert.equal(service.get('film', ids[1]).status, 'cancelled');
  service.cancel('film', ids[0]); assert.equal((await waitFor(() => service.get('film', ids[0]))).status, 'cancelled');
  await waitFor(() => service.get('film', ids[2]), job => job.status === 'running');
  await service.close();
  assert.equal(running, 0); assert.deepEqual(ids.map(id => service.get('film', id).status), ['cancelled', 'cancelled', 'failed', 'failed']);
  assert.match(service.get('film', ids[3]).error!, /server restart/);
  service.purge('film'); assert.throws(() => service.get('film', ids[0]), /not found/);
}));

/** Accounts through the API; project, media, clips and grades written straight into the workspace row, as the server keeps them. */
async function fixture(video: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-color-normalize-'));
  let app = createFrameLineServer({ dataDir: dir }), base = '';
  const listen = async () => { await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
  const request = async (path: string, cookie: string, body?: unknown, method = body ? 'POST' : 'GET') => { const res = await fetch(`${base}/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' }; };
  await listen();
  const signup = (name: string) => request('/auth/signup', '', { name, email: `${name.toLowerCase()}@test.example`, password: 'color normalize password', inviteCode: process.env.FRAME_LINE_SIGNUP_CODE });
  const konrad = await signup('Konrad'), viewer = await signup('Viewer');
  await app.close();
  const db = new DatabaseSync(join(dir, 'frameline.sqlite')), state = JSON.parse((db.prepare('SELECT state FROM workspace WHERE id=1').get() as { state: string }).state);
  const project = (id: string) => ({ id, name: id, description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 9, resolution: '640 × 360', fps: 24, status: 'In progress', members: [{ userId: konrad.data.user.id, role: 'Owner' }, { userId: viewer.data.user.id, role: 'Viewer' }] });
  const cam = asset('cam'), still = asset('still', { kind: 'image' }), clips = [clip('good', 'cam', 0), clip('photo', 'still', 2)];
  state.projects.push(project('film'), project('elsewhere'));
  state.timelines.push({ id: 'timeline', projectId: 'film', name: 'Main', duration: 9 });
  state.tracks.push({ id: 'track', timelineId: 'timeline', name: 'V1', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 });
  state.media.push(cam, still); state.clips.push(...clips); state.nodes.push(...grade(clips[0], cam));
  db.prepare('UPDATE workspace SET state=?, revision=revision+1 WHERE id=1').run(JSON.stringify(state)); db.close();
  if (video) {
    // An S-Log3-like picture: the colour bars squeezed into the log code range.
    mkdirSync(join(dir, 'media', 'cam'), { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-vf', 'lutrgb=r=val*0.55+50:g=val*0.55+50:b=val*0.55+50',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-f', 'mp4', join(dir, 'media', 'cam', 'original')]);
  }
  app = createFrameLineServer({ dataDir: dir }); await listen();
  return { request, konrad: konrad.cookie, viewer: viewer.cookie, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); } };
}

test('the routes: editors start and cancel, viewers only read, jobs never cross projects', () => withEnv({ FRAME_LINE_COLOR_PYTHON: process.execPath, FRAME_LINE_AI_USERS: undefined }, async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.request('/projects/film/color-normalize', f.konrad)).data, null, 'no job yet');
    assert.equal((await f.request('/projects/film/color-normalize', f.viewer, { clipIds: ['good'] })).status, 403, 'a viewer cannot start one');
    assert.equal((await f.request('/projects/film/color-normalize', f.konrad, { clipIds: ['nope'] })).status, 400);
    await withEnv({ FRAME_LINE_COLOR_PYTHON: join(tmpdir(), 'no-such-color-python') }, async () => { const res = await f.request('/projects/film/color-normalize', f.konrad, { clipIds: ['good'] }); assert.equal(res.status, 503); assert.match(res.data.error, /OpenColorIO/); });
    const started = await f.request('/projects/film/color-normalize', f.konrad, { clipIds: ['photo', 'good'] }); assert.equal(started.status, 202, 'not gated by FRAME_LINE_AI_USERS');
    const job = (await f.request(`/projects/film/color-normalize/${started.data.jobId}`, f.viewer)).data;
    assert.equal(job.id, started.data.jobId); assert.deepEqual(job.skipped.map((s: { clipId: string; code: string }) => [s.clipId, s.code]), [['photo', 'not-video'], ['good', 'missing-media']]);
    assert.equal((await f.request('/projects/film/color-normalize', f.viewer)).data.id, started.data.jobId, 'latest job, for a reload');
    assert.equal((await f.request(`/projects/elsewhere/color-normalize/${started.data.jobId}`, f.konrad)).status, 404);
    assert.equal((await f.request(`/projects/film/color-normalize/${started.data.jobId}`, f.viewer, undefined, 'DELETE')).status, 403);
    assert.equal((await f.request(`/projects/film/color-normalize/${started.data.jobId}`, f.konrad, undefined, 'DELETE')).status, 200);
    assert.equal((await f.request('/projects/film/color-normalize', f.konrad, { clipIds: ['good'] }, 'PUT')).status, 405);
  } finally { await f.close(); }
}));

const ready = existsSync(colorPython()) && (() => { try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('a real Normalize run measures a log shot and answers with a finite Balance', { timeout: 240_000, skip: !ready && 'needs npm run setup:color and FFmpeg' }, () => withEnv({ FRAME_LINE_COLOR_PYTHON: undefined }, async () => {
  const f = await fixture(true);
  try {
    const started = await f.request('/projects/film/color-normalize', f.konrad, { clipIds: ['good'] }); assert.equal(started.status, 202, JSON.stringify(started.data));
    let job: NormalizeJob | undefined;
    for (const t = Date.now(); Date.now() - t < 200_000; await new Promise(r => setTimeout(r, 150))) { job = (await f.request(`/projects/film/color-normalize/${started.data.jobId}`, f.konrad)).data; if (!['waiting', 'running'].includes(job!.status)) break; }
    assert.equal(job!.status, 'done', job!.error); assert.equal(job!.progress, 100); assert.deepEqual(job!.skipped, []);
    assert.equal(job!.result!.shots.length, 1); const [shot] = job!.result!.shots;
    assert.equal(shot.clipId, 'good'); assert.ok(Object.values(shot.balance).every(Number.isFinite), JSON.stringify(shot)); assert.ok(shot.confidence >= 0 && shot.confidence <= 1);
  } finally { await f.close(); }
}));
