import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as forward } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { starterGrade } from '../src/services/color.ts';
import type { PersistedState } from '../src/services/index.ts';
import type { Clip, GradeNode, MediaAsset } from '../src/state/models.ts';
import { useEditorStore } from '../src/state/store.ts';
import type { ColorAssistantError } from './colorAssistant.ts';
import { colorNormalizeService, type NormalizeJob, type NormalizeLink } from './colorNormalize.ts';
import { createFrameLineServer } from './index.ts';
import { FILMSTRIP_VERSION, type run } from './media.ts';

// SharedCut Desktop has no colour worker: Normalize (Auto balance) runs on sharedcut.com through the sync link.
const NO_WORKER = { FRAME_LINE_COLOR_PYTHON: join(tmpdir(), 'no-such-color-python') };
const withEnv = async (values: Record<string, string | undefined>, work: () => Promise<void>) => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const set = (entries: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(entries)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  set(values);
  try { await work(); } finally { set(previous); }
};
const clip = (id: string, mediaId: string, start: number, extra: Clip['properties'] = {}): Clip => ({ id, projectId: 'trip', timelineId: 'tl', trackId: 'v1', mediaId, name: `Shot ${id}`, start, duration: 2, sourceIn: .5, color: '#888888', disabled: false, properties: { speed: 100, colorPipeline: 'nodes-v2', ...extra }, effects: [] });
const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({ id, projectId: 'trip', name: `${id}.mp4`, kind: 'video', binId: '', thumbnail: '', duration: 3, resolution: '640 × 360', fps: 24, size: '1 MB', status: 'ready', progress: 100, hasAudio: false, colorMatrix: 'bt709', filmstripVersion: FILMSTRIP_VERSION, camera: 'Test Camera', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine', cameraMetadataVersion: 2, ...extra });
const grade = (c: Clip, a: MediaAsset) => { let n = 0; return starterGrade(c, a, () => `${c.id}-${++n}`); };
const SLOG = { profile: 'S-Log3', gamut: 'S-Gamut3.Cine' };
/** sharedcut.com's answer for these shots, as its own run reports it (with the interpretation it measured through). */
const answer = (clipIds: string[], exposure = .25) => ({ shots: clipIds.map(clipId => ({ clipId, balance: { exposure, temperature: -400, tint: 1, lift: -.01 }, confidence: .8, warnings: [], input: SLOG })), level: { group: -1, target: -.5 } });
const remoteId = (n = 1) => `feed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const settled = async (read: () => NormalizeJob, until = (job: NormalizeJob) => !['waiting', 'running'].includes(job.status)) => { for (const end = Date.now() + 15_000; !until(read()); await sleep(5)) assert.ok(Date.now() < end, `timed out at ${read().stage}`); return read(); };
const offline = () => Object.assign(new Error("sharedcut.com can't be reached (fetch failed)."), { offline: true });
const http = (status: number, message: string) => Object.assign(new Error(message), { status });

type Copy = { clips: Clip[]; nodes: GradeNode[]; media: MediaAsset[] };
/** Shots a and b of one camera, `up` still uploading there, `prep` still downloading here, `edit` changed here only, a still, context `ctx`; `gone` and `solo` are only here. */
function project(): Copy {
  const media = [asset('cam'), asset('late'), asset('fresh', { status: 'downloading', inputProfile: undefined, inputGamut: undefined }), asset('still', { kind: 'image' })];
  const clips = [clip('a', 'cam', 0), clip('b', 'cam', 2), clip('up', 'late', 4), clip('prep', 'fresh', 6), clip('edit', 'cam', 8), clip('photo', 'still', 10), clip('ctx', 'cam', 12), clip('gone', 'cam', 14), clip('solo', 'cam', 16)];
  return { clips, media, nodes: clips.filter(c => c.mediaId === 'cam').flatMap(c => grade(c, media[0])) };
}
/** A fake sharedcut.com: `state.there` is its copy of the project, `reply` answers its normalize route. */
function fakeLink(here: Copy, reply: (method: string, jobId?: string, body?: any) => unknown) {
  const calls: { method: string; jobId?: string; body?: any }[] = [], state = { why: undefined as string | undefined, syncs: 0, syncError: '', there: structuredClone(here) };
  const link: NormalizeLink = {
    blocked: () => state.why,
    async synced() { state.syncs++; if (state.syncError) throw new Error(state.syncError); return { here, there: state.there }; },
    async call(_projectId, method, jobId, body) { calls.push({ method, jobId, body }); return reply(method, jobId, body); },
  };
  return { link, calls, state };
}
const timing = { everyMs: 5, graceMs: 200, busyMs: 5 };

test('without the colour worker it runs on sharedcut.com: only shots that are there as they are here go, and the answer comes back as a run here gives it', () => withEnv(NO_WORKER, async () => {
  const here = project(), seen: [string, number][] = [];
  let service: ReturnType<typeof colorNormalizeService>, jobId = '', polls = 0;
  const current = () => service.get('trip', jobId), remoteSkips = [{ clipId: 'photo', code: 'not-video', text: 'Only video shots can be normalized.' }, { clipId: 'b', code: 'missing-media', text: 'The original video is not on this server.' }];
  const fake = fakeLink(here, method => {
    if (method === 'POST') return { jobId: remoteId() };
    seen.push([current().stage, current().progress]);
    return ++polls < 2 ? { status: 'running', stage: 'Measuring shots', progress: 40, skipped: remoteSkips.slice(0, 1) } : { status: 'done', stage: 'Done', progress: 100, skipped: remoteSkips, result: answer(['a', 'ctx'], 9) };
  });
  const { there } = fake.state;
  there.media.find(m => m.id === 'late')!.status = 'uploading';
  Object.assign(there.media.find(m => m.id === 'fresh')!, { status: 'ready', inputProfile: SLOG.profile, inputGamut: SLOG.gamut });
  there.clips.find(c => c.id === 'edit')!.properties.speed = 50;
  there.clips = there.clips.filter(c => c.id !== 'gone' && c.id !== 'solo');
  service = colorNormalizeService(await mkdtemp(join(tmpdir(), 'sharedcut-normalize-remote-')), undefined, () => fake.link, timing);
  assert.deepEqual(service.capabilities('trip'), { available: true, remote: true });
  ({ jobId } = service.start({ projectId: 'trip', ...here, source: () => join(tmpdir(), 'no-original'), body: { clipIds: ['a', 'b', 'up', 'prep', 'edit', 'photo', 'gone'], contextIds: ['ctx', 'solo'], clean: true } }));
  assert.deepEqual([current().status, current().stage, current().remote], ['running', 'Sending the edit to sharedcut.com', true]);
  const job = await settled(current);
  assert.equal(job.status, 'done', job.error); assert.equal(job.progress, 100);
  assert.equal(fake.state.syncs, 2, 'an edit that has not arrived gets one more sync');
  assert.deepEqual(fake.calls.map(c => [c.method, c.jobId, c.body]), [['POST', undefined, { clipIds: ['a', 'b', 'photo'], contextIds: ['ctx'], clean: true }], ['GET', remoteId(), undefined], ['GET', remoteId(), undefined]], 'the local job follows the remote one; a still goes, sharedcut.com says what it is');
  assert.deepEqual(seen, [['Sending the edit to sharedcut.com', 1], ['Measuring shots on sharedcut.com', 40]]);
  assert.deepEqual(job.skipped.map(s => [s.clipId, s.code, s.text]), [
    ['up', 'not-synced', 'Still uploading to sharedcut.com.'], ['prep', 'not-synced', 'Still being prepared on this computer.'], ['edit', 'not-synced', 'Its latest edit has not reached sharedcut.com yet. Try again in a moment.'],
    ['gone', 'not-synced', 'Not on sharedcut.com yet.'], ['photo', 'not-video', 'Only video shots can be normalized.'], ['b', 'missing-media', 'The original video is not on sharedcut.com.']]);
  assert.deepEqual(job.result, { shots: [{ clipId: 'a', balance: { exposure: 4, temperature: -400, tint: 1, lift: -.01 }, confidence: .8, warnings: [], input: SLOG }], level: { group: -1, target: -.5 } }, 'kept to the targets and the Balance limits, with the interpretation it was measured through');
  await service.close();
}));

test('not linked, not synced or offline: it fails at once with what to do; with the worker installed it stays here', () => withEnv(NO_WORKER, async () => {
  const here = project(), dir = await mkdtemp(join(tmpdir(), 'sharedcut-normalize-remote-')), input = { projectId: 'trip', ...here, source: () => process.execPath };
  const fake = fakeLink(here, () => ({ jobId: remoteId() })), service = colorNormalizeService(dir, undefined, () => fake.link, timing), start = () => service.start({ ...input, body: { clipIds: ['a'] } });
  const finished = (on: typeof service) => { const { jobId } = on.start({ ...input, body: { clipIds: ['a'] } }); return settled(() => on.get('trip', jobId)); };
  const refused = (pattern: RegExp) => (error: ColorAssistantError) => error.status === 503 && pattern.test(error.message);
  const plain = colorNormalizeService(dir, undefined, () => undefined);
  assert.throws(() => plain.start({ ...input, body: { clipIds: ['a'] } }), refused(/npm run setup:color/), 'a server with no link says what it always said');
  assert.match(plain.capabilities('trip').reason!, /OpenColorIO is not installed/);
  fake.state.why = 'Auto balance runs on sharedcut.com: sign in to sharedcut.com on the Projects page.';
  assert.throws(start, refused(/sign in to sharedcut\.com on the Projects page/));
  assert.deepEqual(service.capabilities('trip'), { available: false, reason: fake.state.why });
  fake.state.why = undefined; fake.state.syncError = "You're offline: Auto balance needs sharedcut.com.";
  const lost = await finished(service);
  assert.deepEqual([lost.status, lost.error], ['failed', "You're offline: Auto balance needs sharedcut.com."]);
  fake.state.syncError = ''; fake.state.there.media.find(m => m.id === 'cam')!.status = 'uploading';
  const early = await finished(service);
  assert.deepEqual([early.status, early.error], ['failed', 'None of the chosen shots can be normalized. Still uploading to sharedcut.com.']);
  assert.deepEqual(fake.calls, [], 'nothing was started there');
  await withEnv({ FRAME_LINE_COLOR_PYTHON: process.execPath }, async () => {
    let worked = 0;
    const fakeRun: typeof run = async () => { worked++; return Buffer.from(`${JSON.stringify(answer(['a']))}\n`); };
    const local = colorNormalizeService(dir, fakeRun, () => fake.link, timing);
    assert.deepEqual(local.capabilities('trip'), { available: true });
    const job = await finished(local);
    assert.deepEqual([job.status, job.remote, worked, fake.state.syncs, fake.calls.length], ['done', undefined, 1, 2, 0], 'the worker here, no network');
    await local.close();
  });
  await service.close(); await plain.close();
}));

test('busy, signed out, restarted or unreachable sharedcut.com ends the job with what to do; cancel and close stop it there too', () => withEnv(NO_WORKER, async () => {
  const here = project(), input = { projectId: 'trip', ...here, source: () => process.execPath };
  let mode = '', posts = 0, gets = 0, waiting = '';
  const fake = fakeLink(here, (method, _jobId, body) => {
    if (method === 'DELETE') return { ok: true };
    if (method === 'POST') {
      if (++posts > 1) waiting = service.latest('trip')!.stage;
      if (mode === 'full' || (mode === 'busy' && posts < 3)) throw http(429, 'Normalize is busy. Try again when the current run finishes.');
      if (mode === 'signed-out') throw http(401, 'Sign in first.');
      return { jobId: remoteId(), body };
    }
    gets++;
    if (mode === 'gone') throw http(404, 'Normalize result not found.');
    if (mode === 'lost' || (mode === 'blip' && gets === 1)) throw offline();
    if (mode === 'unreadable') return { status: 'failed', error: 'None of the chosen shots could be read.', skipped: [] };
    if (mode === 'slow') return { status: 'running', stage: 'Measuring shots', progress: 10, skipped: [] };
    return { status: 'done', progress: 100, skipped: [], result: answer(['a']) };
  });
  const service = colorNormalizeService(await mkdtemp(join(tmpdir(), 'sharedcut-normalize-remote-')), undefined, () => fake.link, timing);
  const go = (m: string) => { mode = m; posts = gets = 0; return service.start({ ...input, body: { clipIds: ['a'] } }).jobId; };
  const outcome = async (m: string) => { const id = go(m), job = await settled(() => service.get('trip', id)); return job.error ?? job.status; };
  assert.equal(await outcome('busy'), 'done'); assert.equal(posts, 3); assert.equal(waiting, 'Waiting for sharedcut.com', 'busy there: it waits for a place');
  assert.equal(await outcome('full'), 'sharedcut.com is busy with other Auto balance runs. Try again in a few minutes.'); assert.equal(posts, 12, 'a minute at most');
  assert.equal(await outcome('signed-out'), 'sharedcut.com signed you out: sign in to sharedcut.com again on the Projects page.');
  assert.equal(await outcome('gone'), 'sharedcut.com restarted during Auto balance. Run it again.');
  assert.equal(await outcome('blip'), 'done', 'a moment offline is waited out');
  assert.equal(await outcome('lost'), 'Lost the connection to sharedcut.com during Auto balance. Run it again once you are back online.');
  assert.equal(await outcome('unreadable'), 'sharedcut.com: None of the chosen shots could be read.');
  assert.deepEqual(fake.calls.filter(c => c.method === 'DELETE'), [], 'a run that ended there is not cancelled');
  const deletes = () => fake.calls.filter(c => c.method === 'DELETE' && c.jobId === remoteId()).length, onRemote = (job: NormalizeJob) => job.stage === 'Measuring shots on sharedcut.com';
  const cancelled = go('slow'); await settled(() => service.get('trip', cancelled), onRemote);
  service.cancel('trip', cancelled);
  assert.equal((await settled(() => service.get('trip', cancelled))).status, 'cancelled'); assert.equal(deletes(), 1, 'cancel here cancels there');
  const closing = go('slow'); await settled(() => service.get('trip', closing), onRemote);
  await service.close();
  assert.deepEqual([service.get('trip', closing).status, service.get('trip', closing).error], ['failed', 'Interrupted by a server restart. Run it again.']); assert.equal(deletes(), 2, 'a stopping server stops its run there');
}));

test('SharedCut Desktop: Auto balance goes through its sync link to sharedcut.com and is applied here; signed out, offline and restarts say what to do', { timeout: 180_000 }, () => withEnv(NO_WORKER, async () => {
  const liveDir = await mkdtemp(join(tmpdir(), 'sharedcut-live-')), deskDir = await mkdtemp(join(tmpdir(), 'sharedcut-desk-'));
  type App = ReturnType<typeof createFrameLineServer>;
  const listen = async (app: App, port = 0) => { await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
  const request = async (base: string, path: string, method = 'GET', body?: unknown, cookie = '') => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const PASSWORD = 'a long secure password', signup = async (base: string, name: string) => { const r = await request(base, '/auth/signup', 'POST', { name, email: `${name}@example.com`, password: PASSWORD, inviteCode: process.env.FRAME_LINE_SIGNUP_CODE }); return { id: r.data.user.id as string, cookie: r.cookie }; };
  // sharedcut.com with the project on it: the account through the API, the edit straight into its workspace row. c1 is tagged
  // S-Log3 on the clip; c2 only by its footage, which this computer has not prepared yet; c3's original is still uploading.
  let live = createFrameLineServer({ dataDir: liveDir }); const alice = await signup(await listen(live), 'alice'); await live.close();
  const db = new DatabaseSync(join(liveDir, 'frameline.sqlite')), state = JSON.parse((db.prepare('SELECT state FROM workspace WHERE id=1').get() as { state: string }).state);
  const clips = [clip('c1', 'cam', 0, { inputProfile: SLOG.profile, inputGamut: SLOG.gamut }), clip('c2', 'cam', 2), clip('c3', 'late', 4)];
  state.projects.push({ id: 'trip', name: 'Trip', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 9, resolution: '640 × 360', fps: 24, status: 'In progress', members: [{ userId: alice.id, role: 'Owner' }] });
  state.timelines.push({ id: 'tl', projectId: 'trip', name: 'Trip', duration: 9 });
  state.tracks.push({ id: 'v1', timelineId: 'tl', name: 'V1', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 });
  state.media.push(asset('cam'), asset('late', { status: 'uploading', progress: 0 })); state.clips.push(...clips); state.nodes.push(...grade(clips[0], asset('cam')));
  db.prepare('UPDATE workspace SET state=?, revision=revision+1 WHERE id=1').run(JSON.stringify(state)); db.close();
  mkdirSync(join(liveDir, 'media', 'late'), { recursive: true });
  live = createFrameLineServer({ dataDir: liveDir }); const livePort = Number(new URL(await listen(live)).port);

  // In front of it, sharedcut.com's Normalize route faked (this machine may have no colour worker); everything else is the real server.
  const posted: { clipIds: string[] }[] = [], deleted: string[] = [], cookies: string[] = [];
  let mode: 'ok' | 'slow' | 'signed-out' | 'down' = 'ok', polls = 0;
  const proxy = createServer((req, res) => {
    if (mode === 'down') { req.socket.destroy(); return; }
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (mode === 'signed-out') return reply(401, { error: 'Sign in first.' });
    const route = /^\/api\/projects\/trip\/color-normalize(?:\/([a-f0-9-]{36}))?$/.exec(req.url!);
    if (!route) { const up = forward({ host: '127.0.0.1', port: livePort, path: req.url, method: req.method, headers: req.headers }, back => { res.writeHead(back.statusCode!, back.headers); back.pipe(res); }); up.on('error', () => res.destroy()); req.pipe(up); return; }
    cookies.push(String(req.headers.cookie));
    let text = ''; req.on('data', chunk => { text += chunk; }).on('end', () => {
      if (req.method === 'POST') { posted.push(JSON.parse(text)); return reply(202, { jobId: remoteId(posted.length) }); }
      if (req.method === 'DELETE') { deleted.push(route[1]); return reply(200, { ok: true }); }
      const running = mode === 'slow' || ++polls < 2;
      reply(200, { id: route[1], projectId: 'trip', createdAt: 1, skipped: [], ...(running ? { status: 'running', stage: 'Measuring shots', progress: 30 } : { status: 'done', stage: 'Done', progress: 100, result: answer(posted.at(-1)!.clipIds) }) });
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const remoteUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

  let desk = createFrameLineServer({ dataDir: deskDir, remote: remoteUrl, remoteEveryMs: 3_600_000 }); let deskUrl = await listen(desk);
  const konrad = await signup(deskUrl, 'konrad'), as = (path: string, method = 'GET', body?: unknown) => request(deskUrl, path, method, body, konrad.cookie);
  const where = async (projectId: string) => (await as(`/projects/${projectId}/color-normalize/capabilities`)).data;
  const start = async (clipIds: string[]) => { const r = await as('/projects/trip/color-normalize', 'POST', { clipIds }); assert.equal(r.status, 202, JSON.stringify(r.data)); return r.data.jobId as string; };
  const job = async (id: string) => (await as(`/projects/trip/color-normalize/${id}`)).data as NormalizeJob;
  const until = async (id: string, done: (j: NormalizeJob) => boolean) => { for (const end = Date.now() + 30_000; ; await sleep(100)) { const j = await job(id); if (done(j)) return j; assert.ok(Date.now() < end, `timed out at ${j.stage}`); } };
  const settle = (id: string) => until(id, j => !['waiting', 'running'].includes(j.status));
  try {
    const view = (await as('/state')).data as { revision: number; state: PersistedState };
    view.state.projects.push({ id: 'solo', name: 'Solo', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: konrad.id, role: 'Owner' }] });
    assert.equal((await as('/state', 'PUT', view)).status, 200);
    assert.match((await where('solo')).reason, /^Auto balance runs on sharedcut\.com: sign in to sharedcut\.com on the Projects page\.$/);

    // This computer already holds cam's original (as when the app's laptop has the card), so the sync has nothing to download.
    mkdirSync(join(deskDir, 'media', 'cam'), { recursive: true }); writeFileSync(join(deskDir, 'media', 'cam', 'original'), 'footage');
    assert.equal((await as('/remote/login', 'POST', { email: 'alice@example.com', password: PASSWORD })).status, 200);
    assert.equal((await as('/remote/projects/trip', 'PUT')).status, 200); await desk.remote!.tick();
    assert.match((await where('solo')).reason, /sync this project with sharedcut\.com on the Projects page/);
    assert.deepEqual(await where('trip'), { available: true, remote: true });

    // Forwarded: only c1 can be measured there as it is here; its balance comes back and applies as a local one would.
    const done = await settle(await start(['c1', 'c2', 'c3']));
    assert.equal(done.status, 'done', done.error); assert.equal(done.remote, true);
    assert.deepEqual(posted, [{ clipIds: ['c1'] }]); assert.ok(cookies.every(c => /^frameline_session=/.test(c)), 'through the link\'s own session');
    assert.deepEqual(done.skipped.map(s => [s.clipId, s.text]), [['c2', 'Still being prepared on this computer.'], ['c3', 'Still uploading to sharedcut.com.']]);
    assert.deepEqual(done.result!.shots.map(s => [s.clipId, s.balance.exposure, s.input]), [['c1', .25, SLOG]]);
    const here = (await as('/state')).data.state as PersistedState;
    useEditorStore.setState({ ...here, projectId: 'trip', currentUserId: konrad.id, locks: [], operations: [], notifications: [] });
    assert.equal(useEditorStore.getState().normalizeColorGroup(done.result!), 1);
    assert.equal(useEditorStore.getState().nodes.find(n => n.clipId === 'c1' && n.name === 'Balance')?.parameters.exposure, .25);
    useEditorStore.setState(s => ({ clips: s.clips.map(c => c.id === 'c1' ? { ...c, properties: { ...c.properties, inputProfile: 'Rec.709', inputGamut: 'Rec.709' } } : c) }));
    assert.equal(useEditorStore.getState().normalizeColorGroup(done.result!), 0, 'a shot re-tagged since sharedcut.com measured it is skipped');

    // Cancel here cancels there.
    mode = 'slow'; const cancelled = await start(['c1']);
    await until(cancelled, j => j.stage === 'Measuring shots on sharedcut.com');
    assert.equal((await as(`/projects/trip/color-normalize/${cancelled}`, 'DELETE')).status, 200);
    assert.equal((await settle(cancelled)).status, 'cancelled');
    for (const end = Date.now() + 5000; !deleted.includes(remoteId(2)); await sleep(50)) assert.ok(Date.now() < end, 'the run there is cancelled');

    // The session ran out: sign in again.
    mode = 'signed-out';
    assert.match((await settle(await start(['c1']))).error!, /sign in to sharedcut\.com again on the Projects page/);
    assert.equal((await as('/remote')).data.user, null); assert.match((await where('trip')).reason, /sign in to sharedcut\.com again/);
    mode = 'ok'; assert.equal((await as('/remote/login', 'POST', { email: 'alice@example.com', password: PASSWORD })).status, 200);

    // Offline: the job says so, and the next try is refused at once until the connection is back.
    mode = 'down';
    assert.equal((await settle(await start(['c1']))).error, "You're offline: Auto balance needs sharedcut.com.");
    const refused = await as('/projects/trip/color-normalize', 'POST', { clipIds: ['c1'] });
    assert.deepEqual([refused.status, refused.data.error], [503, "You're offline: Auto balance needs sharedcut.com."]);
    mode = 'ok'; await desk.remote!.tick(); assert.deepEqual(await where('trip'), { available: true, remote: true });

    // This computer's server restarts mid-run: the run there is stopped and the job is gone, not stuck.
    mode = 'slow'; const interrupted = await start(['c1']);
    await until(interrupted, j => j.stage === 'Measuring shots on sharedcut.com');
    await desk.close(); assert.ok(deleted.includes(remoteId(posted.length)), 'the run there is cancelled');
    desk = createFrameLineServer({ dataDir: deskDir, remote: remoteUrl, remoteEveryMs: 3_600_000 }); deskUrl = await listen(desk);
    const gone = await as(`/projects/trip/color-normalize/${interrupted}`);
    assert.deepEqual([gone.status, gone.data.error], [404, 'Normalize result not found.']);
  } finally {
    await desk.close(); await live.close(); await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    await rm(liveDir, { recursive: true, force: true, maxRetries: 5 }); await rm(deskDir, { recursive: true, force: true, maxRetries: 5 });
  }
}));
