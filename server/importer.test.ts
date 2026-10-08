// The importer's server side (sharedcut.com/importer): guest sign-in and what a guest can reach, the dry run, the
// upload plan, the import card the server keeps, and how long unfinished imports wait.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFrameLineServer } from './index.ts';
import { stateDelta } from '../src/services/stateDelta.ts';

const CODE = 'class-2026', PASSWORD = 'importer-test-password', DAY = 86400_000;
// No disk reserve, so a nearly full test disk still takes uploads; DEFER_PREP keeps a finished upload at 'processing' with no FFmpeg run.
const ENV = { FRAME_LINE_SIGNUP_CODE: CODE, FRAME_LINE_MIN_FREE_GB: '0', FRAME_LINE_DEFER_PREP: '1' };
const restoreEnv = (saved: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
const savedEnv = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
Object.assign(process.env, ENV); after(() => restoreEnv(savedEnv));

// A Final Cut export: a clip in a library, one on an SD card, a song, and a title in a font SharedCut lacks.
const source = (id: string, path: string, attrs = 'hasVideo="1" hasAudio="1" format="r1"') => `<asset id="${id}" start="0s" duration="10s" ${attrs}><media-rep kind="original-media" src="file://${path}"/></asset>`;
const xml = (name = 'My Film', uid = 'P-1') => `<fcpxml version="1.11"><resources><format id="r1" frameDuration="100/2500s" width="1920" height="1080"/>
${source('a', '/Users/maya/Movies/School%20Library.fcpbundle/E/Original%20Media/A001.mov')}${source('b', '/Volumes/SD%20CARD/DCIM/100CANON/C0001.MP4')}${source('c', '/Users/maya/Music/song.wav', 'hasAudio="1"')}<effect id="t" name="Basic Title"/></resources>
<library><event name="E"><project name="${name}" uid="${uid}"><sequence format="r1" duration="10s" tcStart="0s"><spine>
<asset-clip ref="a" offset="0s" start="0s" duration="4s"><title ref="t" lane="1" offset="1s" start="0s" duration="2s"><text><text-style ref="s">Hi</text-style></text><text-style-def id="s"><text-style font="Barlow Condensed" fontSize="80"/></text-style-def></title></asset-clip>
<asset-clip ref="b" offset="4s" start="0s" duration="4s"/><asset-clip ref="c" offset="8s" start="0s" duration="2s"/></spine></sequence></project></event></library></fcpxml>`;

type Reply = { status: number; data: any; cookie: string };
async function fixture(options: { env?: Record<string, string>; maxUploadBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-importer-')), env = options.env ?? {};
  // `env` holds for this server only: the server reads it as it starts.
  const start = () => {
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try { return createFrameLineServer({ dataDir: dir, maxUploadBytes: options.maxUploadBytes }); } finally { restoreEnv(saved); }
  };
  let app = start(), base = '';
  const listen = async () => { await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`; };
  await listen();
  const call = async (cookie: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const raw = typeof body === 'string' || body instanceof Uint8Array;
    const response = await fetch(base + path, { method, headers: { ...(cookie && { cookie }), ...(body !== undefined && !raw && { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : raw ? body as BodyInit : JSON.stringify(body) });
    const text = await response.text(); let data: any = text; try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const guest = (name = 'Maya Chen') => call('', '/auth/guest', 'POST', { name, inviteCode: CODE, color: '#3D9BE9' });
  const member = async (email: string) => { const r = await call('', '/auth/signup', 'POST', { name: email.split('@')[0], email, password: PASSWORD, inviteCode: CODE }); assert.equal(r.status, 201, r.data.error); return { cookie: r.cookie, id: r.data.user.id as string }; };
  const importXml = (cookie: string, query = '', body = xml()) => call(cookie, `/fcp/import${query && `?${query}`}`, 'POST', body);
  const plan = (cookie: string, id: string, files: { id: string; size: number; fingerprint?: string }[]) => call(cookie, `/fcp/import/${id}`, 'PUT', { files: files.map(f => ({ fingerprint: `${f.id}:${f.size}`, ...f })) });
  const card = async (cookie: string, id: string) => (await call(cookie, `/fcp/import/${id}`)).data.fcpImport;
  const init = (cookie: string, id: string, size: number, fingerprint = `${id}:${size}`) => call(cookie, `/media/${id}/upload`, 'POST', { size, fingerprint });
  const chunk = (cookie: string, id: string, offset: number, bytes: Buffer) => call(cookie, `/media/${id}/upload`, 'PUT', bytes, { 'upload-offset': String(offset), 'upload-checksum': createHash('sha256').update(bytes).digest('hex') });
  // Stops the server, lets `edit` change its database (to back-date something), and starts it again: startup settles imports and sweeps uploads.
  const restart = async (edit?: (db: DatabaseSync) => void) => {
    await app.close();
    if (edit) { const db = new DatabaseSync(join(dir, 'frameline.sqlite')); try { edit(db); } finally { db.close(); } }
    app = start(); await listen();
  };
  const backdate = (projectId: string, ms: number) => (db: DatabaseSync) => db.prepare("UPDATE workspace_items SET data=json_set(data,'$.fcpImport.updatedAt',?) WHERE collection='projects' AND json_extract(data,'$.id')=?").run(Date.now() - ms, projectId);
  const age = (mediaId: string, ms: number) => { const when = new Date(Date.now() - ms); for (const name of ['upload.part', 'upload.json', '']) utimesSync(join(dir, 'media', mediaId, name), when, when); };
  return { dir, call, guest, member, importXml, plan, card, init, chunk, restart, backdate, age, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}
const until = async (check: () => Promise<boolean>, message: string) => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(done => setTimeout(done, 50)); } assert.fail(message); };

test('guests: the class code, the cookie, one network\'s hourly limit, and no password to sign in with', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('', '/auth/guest', 'POST', { name: 'Maya Chen' })).status, 403, 'no code');
    assert.equal((await f.call('', '/auth/guest', 'POST', { name: 'Maya Chen', inviteCode: 'class-2025' })).status, 403, 'a wrong code');
    assert.equal((await f.call('', '/auth/guest', 'POST', { name: '  ', inviteCode: CODE })).data.error, 'Enter your name.');
    const maya = await f.guest();
    assert.equal(maya.status, 201); assert.match(maya.cookie, /^frameline_session=/);
    const me = (await f.call(maya.cookie, '/auth/me')).data.user;
    assert.equal(me.guest, true); assert.equal(me.name, 'Maya Chen'); assert.equal(me.color, '#3D9BE9'); assert.equal(me.email, `${me.id}@guest.invalid`);
    assert.equal((await f.call('', '/auth/login', 'POST', { email: me.email, password: 'anything at all' })).status, 401, 'a guest has no password');
    assert.equal((await f.call(maya.cookie, '/auth/guest', 'POST', { name: 'Someone Else', inviteCode: CODE })).data.user.id, me.id, 'the cookie is the guest');
    // Five tries so far. A class behind one school address fits in 60 an hour; the 61st is refused.
    const class30 = await Promise.all(Array.from({ length: 55 }, (_, i) => f.guest(`Student ${i}`)));
    assert.ok(class30.every(r => r.status === 201));
    assert.equal((await f.guest('One Too Many')).status, 429);
  } finally { await f.close(); }
});

test('a guest reaches the importer and nothing else', async () => {
  const f = await fixture();
  try {
    const maya = (await f.guest()).cookie, owner = await f.member('teacher@school.test');
    const project = (await f.importXml(owner.cookie, 'class=1')).data.projectId;
    for (const [method, path, body] of [['GET', '/state'], ['GET', '/events'], ['GET', '/library'], ['GET', '/fonts'], ['GET', '/sfx'], ['POST', '/media?projectId=x&name=a.mov', 'bytes'],
      ['PATCH', `/projects/${project}`, { name: 'Mine now' }], ['PATCH', '/state', { revision: 1, delta: {} }], ['PUT', '/state', { revision: 1, state: {} }], ['POST', '/library', { action: 'create' }],
      ['PATCH', '/auth/profile', { name: 'Maya', email: 'maya@school.test' }], ['POST', '/presence', { projectId: project }], ['POST', '/renders', {}], ['POST', '/resolve/import', {}]] as const)
      assert.equal((await f.call(maya, path, method, body)).status, 403, `${method} ${path}`);
    for (const path of ['/uploads/info', '/fcp/import', '/auth/me']) assert.equal((await f.call(maya, path)).status, 200, path);
  } finally { await f.close(); }
});

test('a guest holds direct roles only: class-shared projects and folders stay out of reach', async () => {
  const f = await fixture();
  try {
    const owner = await f.member('teacher@school.test'), classmate = await f.member('sam@school.test'), maya = (await f.guest()).cookie;
    const shared = await f.importXml(owner.cookie, 'class=1');
    assert.equal(shared.status, 201);
    const id = shared.data.projectId, media = shared.data.media[0].id;
    assert.equal((await f.call(classmate.cookie, `/fcp/import/${id}`)).status, 200, 'a classmate with an account can open it');
    assert.equal((await f.plan(classmate.cookie, id, [{ id: media, size: 10 }])).status, 200, 'and, as class Editor, plan it');
    assert.equal((await f.call(maya, `/fcp/import/${id}`)).status, 404);
    assert.equal((await f.plan(maya, id, [{ id: media, size: 10 }])).status, 404);
    assert.equal((await f.init(maya, media, 10)).status, 404);
    assert.equal((await f.call(maya, `/media/${media}/upload`)).status, 404);
    assert.equal((await f.call(maya, `/media/${media}/files/thumbnail.jpg`)).status, 404);
    assert.ok([403, 404].includes((await f.importXml(maya, `projectId=${id}&rebuild=1`)).status));
    assert.ok([403, 404].includes((await f.importXml(maya, `projectId=${id}&dry=1`)).status));
    // A private project in a folder shared with the class.
    const hidden = await f.importXml(owner.cookie, '', xml('Folder Film', 'P-2')), library = async () => (await f.call(owner.cookie, '/library')).data.revision;
    const folder = await f.call(owner.cookie, '/library', 'POST', { action: 'create', name: 'Class', parentId: null, shared: true, classRole: 'Editor', members: [], revision: await library() });
    assert.equal((await f.call(owner.cookie, '/library', 'POST', { action: 'move', kind: 'project', id: hidden.data.projectId, parentId: folder.data.id, revision: await library() })).status, 200);
    assert.equal((await f.call(classmate.cookie, `/fcp/import/${hidden.data.projectId}`)).status, 200, 'the folder shares it with the class');
    assert.equal((await f.call(maya, `/fcp/import/${hidden.data.projectId}`)).status, 404);
    assert.equal((await f.init(maya, hidden.data.media[0].id, 10)).status, 404);
  } finally { await f.close(); }
});

test('a guest import: shared with the class as Editor, at most 5, email never shown', async () => {
  const f = await fixture();
  try {
    const maya = await f.guest(), owner = await f.member('teacher@school.test');
    const first = await f.importXml(maya.cookie);
    assert.equal(first.status, 201, first.data.error); assert.deepEqual(first.data.missingFonts, ['Barlow Condensed']);
    const view = (await f.call(owner.cookie, '/state')).data.state, project = view.projects.find((p: any) => p.id === first.data.projectId);
    assert.equal(project.shared, true); assert.equal(project.classRole, 'Editor');
    assert.equal(view.users.find((u: any) => u.id === maya.data.user.id).email, '', 'a member never sees a guest\'s made-up email');
    for (let i = 0; i < 4; i++) assert.equal((await f.importXml(maya.cookie, 'fresh=1')).status, 201);
    assert.equal((await f.importXml(maya.cookie, 'fresh=1')).status, 403, 'the sixth');
    const dry = await f.importXml(maya.cookie, 'dry=1', xml('Next Film', 'P-9'));
    assert.equal(dry.status, 200); assert.equal(dry.data.state, 'new'); assert.equal(dry.data.limit, true);
    assert.equal((await f.importXml(maya.cookie)).status, 200, 'resuming one of the five is not a new one');
    assert.equal((await f.importXml(maya.cookie, 'rebuild=1', xml('My Film v2'))).status, 200, 'nor is rebuilding it');
    assert.equal((await f.importXml(maya.cookie, 'dry=1')).data.limit, false);
  } finally { await f.close(); }
});

test('the dry run writes nothing and names what the import will do', async () => {
  const f = await fixture();
  try {
    const owner = await f.member('maya@school.test'), revision = async () => (await f.call(owner.cookie, '/state')).data.revision;
    const before = await revision(), dry = await f.importXml(owner.cookie, 'dry=1&name=My%20Film');
    assert.equal(dry.status, 200, dry.data.error);
    assert.equal(dry.data.state, 'new'); assert.equal(dry.data.name, 'My Film'); assert.equal(dry.data.duration, 10); assert.equal(dry.data.limit, false);
    assert.deepEqual(dry.data.missingFonts, ['Barlow Condensed']); assert.ok(dry.data.warnings.length);
    assert.deepEqual(dry.data.media.map((m: any) => [m.name, m.sourcePath, m.kind, m.uploaded, m.received]), [
      ['A001.mov', '/Users/maya/Movies/School Library.fcpbundle/E/Original Media/A001.mov', 'video', false, 0],
      ['C0001.MP4', '/Volumes/SD CARD/DCIM/100CANON/C0001.MP4', 'video', false, 0], ['song.wav', '/Users/maya/Music/song.wav', 'audio', false, 0]]);
    assert.equal(await revision(), before, 'no save');
    assert.ok(!existsSync(join(f.dir, 'fcp', dry.data.projectId)), 'no files');
    assert.ok(!(await f.call(owner.cookie, '/state')).data.state.projects.length, 'no project');
    assert.equal((await f.importXml(owner.cookie, 'dry=1', '<fcpxml version="1.11"><resources/></fcpxml>')).status, 400, 'the real import\'s errors');
    const real = await f.importXml(owner.cookie);
    assert.equal(real.status, 201); assert.equal(real.data.projectId, dry.data.projectId);
    assert.deepEqual(real.data.media.map((m: any) => m.id), dry.data.media.map((m: any) => m.id), 'the same media ids');
    const song = real.data.media[2].id;
    await f.init(owner.cookie, song, 10); await f.chunk(owner.cookie, song, 0, Buffer.from('abcd'));
    const resume = await f.importXml(owner.cookie, 'dry=1');
    assert.equal(resume.data.state, 'resume'); assert.deepEqual(resume.data.media.map((m: any) => m.received), [0, 0, 4]);
    assert.equal((await f.importXml(owner.cookie, 'dry=1', xml('My Film', 'P-1').replace('duration="2s"/></spine>', 'duration="1s"/></spine>'))).data.state, 'changed');
    assert.equal((await f.call(owner.cookie, `/projects/${real.data.projectId}`, 'DELETE')).status, 200);
    const deleted = await f.importXml(owner.cookie, 'dry=1');
    assert.equal(deleted.data.state, 'deleted'); assert.ok(deleted.data.media.every((m: any) => !m.uploaded && m.received === 0), 'the deleted copy\'s files are not this import\'s');
  } finally { await f.close(); }
});

test('the plan: checked before a byte moves, room for other imports, a guest byte cap, a fresh start for a different copy', async () => {
  // Files up to 1 PiB, so the plan reaches past the disk; a guest may plan 2 KiB.
  const f = await fixture({ maxUploadBytes: 2 ** 50, env: { FRAME_LINE_GUEST_MAX_GB: String(2048 / 1024 ** 3) } });
  try {
    const owner = await f.member('teacher@school.test'), maya = (await f.guest()).cookie;
    const one = await f.importXml(owner.cookie), two = await f.importXml(owner.cookie, '', xml('Second', 'P-2'));
    const [a, b] = one.data.media.map((m: any) => m.id), id = one.data.projectId;
    assert.equal((await f.plan(owner.cookie, id, [{ id: two.data.media[0].id, size: 10 }])).status, 400, 'media of another project');
    assert.equal((await f.plan(owner.cookie, id, [{ id: a, size: 10 }, { id: a, size: 10 }])).status, 400, 'the same file twice');
    assert.equal((await f.plan(owner.cookie, id, [{ id: a, size: 0 }])).status, 400);
    assert.equal((await f.plan(owner.cookie, id, [{ id: a, size: 2 ** 50 + 1 }])).status, 413);
    const huge = await f.plan(owner.cookie, id, [{ id: a, size: 2 ** 49 }]);
    assert.equal(huge.status, 507); assert.ok(huge.data.needed > huge.data.room); assert.match(huge.data.error, /GB free/);
    // Another import's unsent bytes are not this one's room.
    const room = (await f.call(owner.cookie, '/uploads/probe', 'POST', Buffer.alloc(1024))).data.room, size = Math.floor(room * .6 / 1.25);
    const first = await f.plan(owner.cookie, id, [{ id: a, size }, { id: b, size: 10 }]);
    assert.equal(first.status, 200, first.data.error);
    assert.deepEqual({ phase: first.data.fcpImport.phase, total: first.data.fcpImport.total, files: first.data.fcpImport.files, by: first.data.fcpImport.by }, { phase: 'uploading', total: size + 10, files: 2, by: owner.id });
    assert.deepEqual(first.data.files, [{ id: a, received: 0, complete: false }, { id: b, received: 0, complete: false }]);
    assert.equal((await f.plan(owner.cookie, two.data.projectId, [{ id: two.data.media[0].id, size }])).status, 507);
    const probe = async (query = '') => (await f.call(owner.cookie, `/uploads/probe${query}`, 'POST', Buffer.alloc(1024))).data.room;
    assert.ok(Math.abs(await probe(`?project=${id}`) - await probe() - (size + 10) * 1.25) < 2 ** 30, 'the probe leaves the named import out');
    assert.equal((await f.call(owner.cookie, '/state')).data.state.projects.find((p: any) => p.id === id).fcpImport.phase, 'uploading', 'every Projects screen reads the card');
    // A different copy of a planned file drops the unfinished one; the same copy keeps it.
    assert.equal((await f.init(owner.cookie, b, 10, 'C0001.MP4:10:1')).status, 200); await f.chunk(owner.cookie, b, 0, Buffer.from('12345'));
    assert.deepEqual((await f.plan(owner.cookie, id, [{ id: b, size: 10, fingerprint: 'C0001.MP4:10:1' }])).data.files, [{ id: b, received: 5, complete: false }]);
    assert.deepEqual((await f.plan(owner.cookie, id, [{ id: b, size: 10, fingerprint: 'C0001.MP4:10:2' }])).data.files, [{ id: b, received: 0, complete: false }]);
    assert.equal((await f.call(owner.cookie, `/media/${b}/upload`)).data.offset, 0);
    assert.equal((await f.init(owner.cookie, b, 10, 'C0001.MP4:10:2')).status, 200, 'the new copy starts without a conflict');
    // A guest plans at most FRAME_LINE_GUEST_MAX_GB across its imports, and a new plan never frees what arrived.
    const mine = await f.importXml(maya, '', xml('Maya Film', 'P-3')), [x, y] = mine.data.media.map((m: any) => m.id);
    const over = await f.plan(maya, mine.data.projectId, [{ id: x, size: 2049 }]);
    assert.equal(over.status, 403); assert.match(over.data.error, /^Guests can upload up to/);
    assert.equal((await f.plan(maya, mine.data.projectId, [{ id: x, size: 1500 }])).status, 200);
    await f.init(maya, x, 1500); await f.chunk(maya, x, 0, Buffer.alloc(1500));
    assert.equal((await f.plan(maya, mine.data.projectId, [{ id: y, size: 1000 }])).status, 403, '1500 held + 1000 planned');
    assert.equal((await f.plan(maya, mine.data.projectId, [{ id: y, size: 500 }])).status, 200);
  } finally { await f.close(); }
});

test('the import card: chunks, pause, processing, ready; a client copy never overrides it or trips a role check', async () => {
  const f = await fixture();
  try {
    const owner = await f.member('maya@school.test'), viewer = await f.member('sam@school.test');
    const imported = await f.importXml(owner.cookie, 'class=1'), id = imported.data.projectId, [a, b] = imported.data.media.map((m: any) => m.id);
    assert.equal((await f.plan(owner.cookie, id, [{ id: a, size: 10 }, { id: b, size: 10 }])).status, 200);
    await f.init(owner.cookie, a, 10);
    assert.equal((await f.chunk(owner.cookie, a, 0, Buffer.from('1234'))).status, 200);
    assert.deepEqual(await f.card(owner.cookie, id).then(c => [c.phase, c.received, c.total, c.uploaded]), ['uploading', 4, 20, 0]);
    // No bytes for 90 s: paused, until the next chunk.
    await f.restart(f.backdate(id, 120_000));
    assert.equal((await f.card(owner.cookie, id)).phase, 'paused');
    assert.equal((await f.call(owner.cookie, '/fcp/import')).data.imports[0].fcpImport.phase, 'paused');
    await f.chunk(owner.cookie, a, 4, Buffer.from('567'));
    assert.deepEqual(await f.card(owner.cookie, id).then(c => [c.phase, c.received]), ['uploading', 7]);
    assert.equal((await f.chunk(owner.cookie, a, 7, Buffer.from('890'))).status, 202);
    await f.init(owner.cookie, b, 10); assert.equal((await f.chunk(owner.cookie, b, 0, Buffer.from('0123456789'))).status, 202);
    const processing = await f.card(owner.cookie, id);
    assert.deepEqual([processing.phase, processing.received, processing.uploaded, processing.ready], ['processing', 20, 2, 0]);
    assert.deepEqual((await f.call(owner.cookie, '/fcp/import')).data.imports, [], 'nothing left to send');
    // Preparing them fails (they are not video): a failed clip still lets the import reach ready.
    for (const media of [a, b]) assert.equal((await f.call(owner.cookie, `/media/${media}/retry`, 'POST')).status, 202);
    await until(async () => (await f.card(owner.cookie, id)).phase === 'ready', 'the import never reached ready');
    const ready = await f.card(owner.cookie, id);
    assert.deepEqual([ready.ready, ready.failed], [2, 2]); assert.ok(ready.doneAt >= ready.startedAt);
    const sources = (await f.call(owner.cookie, `/fcp/import/${id}`)).data.media;
    assert.deepEqual(sources.map((m: any) => [m.uploaded, m.received, m.status]), [[true, 10, 'failed'], [true, 10, 'failed'], [false, 0, 'failed']]);
    // A class Viewer's settings save that carries a forged card: the card is ignored, the save goes through.
    assert.equal((await f.call(owner.cookie, `/projects/${id}`, 'PATCH', { access: 'class', classRole: 'Viewer' })).status, 200);
    const envelope = (await f.call(viewer.cookie, '/state')).data, before = envelope.state;
    const after = { ...before, settings: { ...before.settings, snapping: !before.settings.snapping }, projects: before.projects.map((p: any) => p.id === id ? { ...p, fcpImport: { ...p.fcpImport, phase: 'uploading', received: 1 } } : p) };
    const saved = await f.call(viewer.cookie, '/state', 'PATCH', { revision: envelope.revision, delta: stateDelta(before, after) });
    assert.equal(saved.status, 200, saved.data.error);
    assert.deepEqual(await f.card(owner.cookie, id), ready);
  } finally { await f.close(); }
});

test('a guest uploads only what its import planned', async () => {
  const f = await fixture();
  try {
    const maya = (await f.guest()).cookie, imported = await f.importXml(maya), [a] = imported.data.media.map((m: any) => m.id);
    assert.equal((await f.init(maya, a, 10)).status, 403, 'no plan');
    assert.equal((await f.plan(maya, imported.data.projectId, [{ id: a, size: 10 }])).status, 200);
    assert.equal((await f.init(maya, a, 11)).status, 403, 'not the planned size');
    assert.equal((await f.init(maya, a, 10)).status, 200);
    assert.equal((await f.chunk(maya, a, 0, Buffer.alloc(10))).status, 202);
    assert.equal((await f.card(maya, imported.data.projectId)).phase, 'processing');
  } finally { await f.close(); }
});

test('unfinished imports wait a week for their Mac; other uploads still go after a day', async () => {
  const f = await fixture();
  try {
    const owner = await f.member('maya@school.test');
    const imported = await f.importXml(owner.cookie), id = imported.data.projectId, a = imported.data.media[0].id;
    const plain = (await f.importXml(owner.cookie, '', xml('No Plan', 'P-2'))).data.media[0].id;
    await f.plan(owner.cookie, id, [{ id: a, size: 10 }]);
    for (const media of [a, plain]) { await f.init(owner.cookie, media, 10); await f.chunk(owner.cookie, media, 0, Buffer.from('1234')); }
    f.age(a, 2 * DAY); f.age(plain, 2 * DAY);
    await f.restart(f.backdate(id, 2 * DAY));
    assert.ok(existsSync(join(f.dir, 'media', a, 'upload.part')), 'two days: the import\'s file waits');
    assert.equal((await f.card(owner.cookie, id)).phase, 'paused');
    assert.ok(!existsSync(join(f.dir, 'media', plain, 'upload.part')), 'a plain upload goes after a day');
    assert.equal((await f.call(owner.cookie, '/state')).data.state.media.find((m: any) => m.id === plain).status, 'failed');
    f.age(a, 8 * DAY);
    await f.restart(f.backdate(id, 8 * DAY));
    assert.ok(!existsSync(join(f.dir, 'media', a, 'upload.part')), 'eight days: gone');
    const stopped = await f.card(owner.cookie, id);
    assert.deepEqual([stopped.phase, stopped.received], ['stopped', 0]);
    assert.equal((await f.call(owner.cookie, '/fcp/import')).data.imports[0].fcpImport.phase, 'stopped', 'still offered to continue');
    assert.equal((await f.plan(owner.cookie, id, [{ id: a, size: 10 }])).data.fcpImport.phase, 'uploading', 'a new plan restarts it');
  } finally { await f.close(); }
});

test('"Save my account" keeps the guest\'s id and projects; other signups stay separate', async () => {
  const f = await fixture();
  try {
    const maya = await f.guest(), imported = await f.importXml(maya.cookie), member = await f.member('sam@school.test');
    assert.equal((await f.call(maya.cookie, '/auth/signup', 'POST', { name: 'Maya Chen', email: 'sam@school.test', password: PASSWORD, upgradeGuest: true })).status, 409, 'a used email');
    assert.equal((await f.call(member.cookie, '/auth/signup', 'POST', { name: 'Sam', email: 'sam2@school.test', password: PASSWORD, upgradeGuest: true })).status, 409, 'a member is not a guest');
    const other = await f.call(maya.cookie, '/auth/signup', 'POST', { name: 'Classmate', email: 'kim@school.test', password: PASSWORD, inviteCode: CODE });
    assert.equal(other.status, 201); assert.notEqual(other.data.user.id, maya.data.user.id, 'a signup on a Mac holding a guest is a new account');
    // No class code: the guest already gave it.
    const saved = await f.call(maya.cookie, '/auth/signup', 'POST', { name: 'Maya Chen', email: 'Maya@School.test', password: PASSWORD, upgradeGuest: true });
    assert.equal(saved.status, 201, saved.data.error); assert.equal(saved.data.user.id, maya.data.user.id); assert.equal(saved.data.user.guest, undefined);
    assert.equal(saved.data.user.color, '#3D9BE9');
    assert.equal((await f.call(maya.cookie, '/library')).status, 200, 'the old cookie is a full account now');
    const view = (await f.call(saved.cookie, '/state')).data.state;
    assert.deepEqual(view.projects.find((p: any) => p.id === imported.data.projectId).members.find((m: any) => m.role === 'Owner'), { userId: maya.data.user.id, role: 'Owner' });
    assert.equal((await f.call('', '/auth/login', 'POST', { email: 'maya@school.test', password: PASSWORD })).data.user.id, maya.data.user.id);
  } finally { await f.close(); }
});

test('the Wi-Fi probe and the list of unfinished imports', async () => {
  const f = await fixture();
  try {
    const maya = (await f.guest()).cookie, owner = await f.member('teacher@school.test');
    const probe = await f.call(maya, '/uploads/probe', 'POST', Buffer.alloc(2 * 1024 * 1024));
    assert.equal(probe.status, 200); assert.equal(probe.data.bytes, 2097152); assert.equal(typeof probe.data.room, 'number');
    assert.equal((await f.call(maya, '/uploads/probe', 'POST', Buffer.alloc(9 * 1024 * 1024))).status, 413);
    assert.equal((await f.call('', '/uploads/probe', 'POST', Buffer.alloc(16))).status, 401);
    const mine = await f.importXml(maya), theirs = await f.importXml(owner.cookie, 'class=1');
    await f.importXml(owner.cookie, '', xml('Not Planned', 'P-2'));
    assert.equal((await f.plan(maya, mine.data.projectId, [{ id: mine.data.media[0].id, size: 10 }])).status, 200);
    assert.equal((await f.plan(owner.cookie, theirs.data.projectId, [{ id: theirs.data.media[0].id, size: 10 }])).status, 200);
    const list = (await f.call(maya, '/fcp/import')).data.imports;
    assert.deepEqual(list.map((i: any) => [i.projectId, i.name, i.fcpImport.phase]), [[mine.data.projectId, 'My Film', 'uploading']], 'only the caller\'s own');
    assert.deepEqual((await f.call(owner.cookie, '/fcp/import')).data.imports.map((i: any) => i.projectId), [theirs.data.projectId], 'a guest\'s class-shared import is not the teacher\'s to continue');
  } finally { await f.close(); }
});
