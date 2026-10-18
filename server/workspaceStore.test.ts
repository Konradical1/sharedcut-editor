import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createFrameLineServer, mergeVisible } from './index.ts';
import { COLLECTIONS, sequence, workspaceStore } from './workspaceStore.ts';
import { stateDelta, applyStateDelta } from '../src/services/stateDelta.ts';
import type { PersistedState } from '../src/services/index.ts';

type App = ReturnType<typeof createFrameLineServer>;
type Envelope = { revision: number; state: PersistedState };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const listen = async (app: App) => { await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`; };
const client = (base: () => string) => {
  const call = async (path: string, cookie: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${base()}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`); return data;
  };
  const signup = async (name: string) => {
    const response = await fetch(`${base()}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email: `${name}@store.test`, password: 'workspace store password', inviteCode: process.env.FRAME_LINE_SIGNUP_CODE }) });
    assert.equal(response.status, 201); return { cookie: response.headers.get('set-cookie')!.split(';')[0], id: (await response.json()).user.id as string };
  };
  // What the editor does: change its copy, send the difference against the revision it holds.
  const edit = async (cookie: string, change: (state: PersistedState) => PersistedState) => {
    const current = await call('/state', cookie) as Envelope, next = change(structuredClone(current.state));
    return call('/state', cookie, { revision: current.revision, delta: stateDelta(current.state, next) }, 'PATCH');
  };
  return { call, signup, edit };
};
const project = (id: string, owner: string, shared = false) => ({ id, name: id, description: '', shared, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress' as const, members: [{ userId: owner, role: 'Owner' as const }] });
const track = (id: string, kind: 'video' | 'audio', number: number) => ({ id, timelineId: 'main', name: id, kind, number, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 });
const clip = (id: string, mediaId: string, start: number) => ({ id, projectId: 'film', timelineId: 'main', trackId: 'v1', mediaId, name: id, start, duration: 2, sourceIn: 0, color: '#ffffff', disabled: false, properties: {}, effects: [] });
const operation = (id: string, userId: string, targetId: string) => ({ id, projectId: 'film', userId, timestamp: Date.now(), targetId, type: 'ClipMoved', description: id, oldState: [], newState: [] });
const storedState = (file: string) => { const db = new DatabaseSync(file), store = workspaceStore(db, file, { legacyEveryMs: 1e9 }); try { return plain(store.load().state); } finally { db.close(); } };
const legacyState = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return JSON.parse(String((db.prepare('SELECT state FROM workspace WHERE id=1').get() as { state: string }).state)); } finally { db.close(); } };
// A server in its own process, so it can be killed the way production stops it (Stop-Process -Force).
const startChild = async (dataDir: string) => {
  const script = `import { createFrameLineServer } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'index.ts')).href)}; const app = createFrameLineServer({ dataDir: process.env.WORKSPACE_TEST_DATA }); app.server.listen(0, '127.0.0.1', () => console.log(app.server.address().port));`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { env: { ...process.env, WORKSPACE_TEST_DATA: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => { child.stdout.once('data', data => resolve(Number(String(data).trim()))); child.once('exit', code => reject(new Error(`server exited with ${code}`))); });
  return { base: `http://127.0.0.1:${port}/api`, kill: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } } };
};
const script = (name: string, data: string, ...args: string[]) => new Promise<{ code: number | null; output: string }>(resolve => {
  const child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, '..', 'scripts', name), ...args], { env: { ...process.env, FRAME_LINE_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.once('exit', code => resolve({ code, output }));
});
// What a build from before the item tables (61b8d6b) does on start: read the JSON row, take its revision
// from workspace_revision, and save the row back at once.
const olderBuild = (file: string, change: (state: PersistedState) => void) => {
  const db = new DatabaseSync(file);
  try {
    const saved = db.prepare('SELECT revision,state FROM workspace WHERE id=1').get() as { revision: number; state: string };
    const tick = (db.prepare('SELECT revision FROM workspace_revision WHERE id=1').get() as { revision: number } | undefined)?.revision ?? 0;
    const state = JSON.parse(saved.state) as PersistedState, revision = Math.max(saved.revision, tick + 1) + 1; change(state);
    db.prepare('INSERT INTO workspace(id,revision,state) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state').run(revision, JSON.stringify(state));
    return { revision, state };
  } finally { db.close(); }
};
const recoveryFiles = (dataDir: string) => readdirSync(dataDir).filter(name => name.startsWith('workspace-replaced-'));

test('sequence keeps stored positions, slots new entries between neighbours and gives up when a gap is exhausted', () => {
  const [a, b, c, x, y] = [{}, {}, {}, {}, {}];
  const rows = new Map([[a, { rowid: 1, seq: 0 }], [b, { rowid: 2, seq: 1 }], [c, { rowid: 3, seq: 2 }]]);
  assert.deepEqual(sequence([x, a, b, c], rows), [-1, 0, 1, 2], 'new history goes first without moving the rest');
  assert.deepEqual(sequence([a, b, c, x, y], rows), [0, 1, 2, 3, 4]);
  assert.deepEqual(sequence([a, x, y, b, c], rows), [0, 1 / 3, 2 / 3, 1, 2]);
  const moved = sequence([c, a, b], rows)!;
  assert.deepEqual(moved.slice(1), [0, 1], 'only the moved entry gets a new place'); assert.ok(moved[0] < 0);
  assert.deepEqual(sequence([x], new Map(), 0, 1), [0.5]);
  assert.equal(sequence([x], new Map(), 1, 1 + Number.EPSILON), undefined, 'no double fits between these, so the caller renumbers');
});

test('a merged save keeps hidden entries in their slots and the caller\'s entries in the order sent', () => {
  const entry = (id: string, hidden = false) => ({ id, hidden });
  const [h1, a, h2, b, c, h3] = [entry('h1', true), entry('a'), entry('h2', true), entry('b'), entry('c'), entry('h3', true)];
  const merge = (sent: { id: string; hidden: boolean }[]) => mergeVisible([h1, a, h2, b, c, h3], item => item.hidden, sent).map(item => item.id);
  assert.deepEqual(merge([entry('n'), a, b, c]), ['n', 'h1', 'a', 'h2', 'b', 'c', 'h3'], 'new at the head of the caller\'s list goes to the head of the whole list');
  assert.deepEqual(merge([a, b, c, entry('n')]), ['h1', 'a', 'h2', 'b', 'c', 'h3', 'n'], 'and new at its tail to the tail');
  assert.deepEqual(merge([a, entry('n'), b]), ['h1', 'a', 'h2', 'n', 'b', 'h3'], 'between kept entries it goes before the later one; c was deleted');
  assert.deepEqual(merge([c, a, b]), ['h1', 'c', 'a', 'h2', 'b', 'h3'], 'a reorder moves only the caller\'s entries');
});

test('entries added into one gap again and again renumber a few neighbours, never the whole list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-gap-')), file = join(dir, 'frameline.sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,state TEXT NOT NULL)');
  const store = workspaceStore(db, file, { legacyEveryMs: 1e9 });
  try {
    const entry = (id: string) => ({ id, projectId: 'p' });
    let list = Array.from({ length: 2000 }, (_, i) => entry(`e${i}`));
    store.replace({ operations: list }, 1);
    const changes = () => Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
    let most = 0;
    // Doubles run out of room after ~50 inserts into one gap; that used to renumber all 2,000 rows.
    for (let i = 0; i < 200; i++) {
      list = [...list.slice(0, 1000), entry(`new${i}`), ...list.slice(1000)];
      const before = changes(); store.save({ operations: list }, i + 2); most = Math.max(most, changes() - before);
    }
    assert.ok(most < 50, `one save wrote ${most} rows`);
    assert.deepEqual(storedState(file).operations.map((item: { id: string }) => item.id), list.map(item => item.id));
  } finally { await store.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the store writes only what changed, freezes what it wrote, and forgets a save its transaction rolled back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-store-')), file = join(dir, 'frameline.sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,state TEXT NOT NULL)');
  const store = workspaceStore(db, file, { legacyEveryMs: 1e9 });
  try {
    assert.equal(store.current(), false, 'nothing is migrated yet');
    const item = (id: string, start = 0) => ({ id, projectId: 'p', start });
    const first = { projects: [{ id: 'p' }], clips: [item('a'), item('b'), item('c')], operations: [], users: [], currentUserId: '', settings: { snapping: true } };
    store.replace(first, 1);
    assert.throws(() => { (first.clips[0] as { start: number }).start = 9; }, TypeError, 'a stored entity cannot change behind the store');
    const rowids = () => new Map((db.prepare("SELECT id,rowid FROM workspace_items WHERE collection='clips'").all() as { id: string; rowid: number }[]).map(row => [row.id, row.rowid]));
    const before = rowids();
    const second = { ...first, clips: [first.clips[0], item('b', 5), first.clips[2], item('d')], operations: [item('op')] };
    store.save(second, 2);
    const after = rowids();
    assert.equal(after.get('a'), before.get('a')); assert.equal(after.get('c'), before.get('c'), 'untouched rows are not rewritten');
    assert.notEqual(after.get('b'), before.get('b')); assert.ok(after.has('d'));
    assert.throws(() => store.transaction(() => { store.save({ ...second, clips: [] }, 3); throw new Error('rolled back'); }), /rolled back/);
    const third = { ...second, clips: [item('z'), ...second.clips.slice(1), item('e')], settings: { snapping: false } };
    store.save(third, 3);
    const expected = { ...Object.fromEntries(COLLECTIONS.map(key => [key, []])), ...plain(third) };
    assert.deepEqual(storedState(file), expected, 'a fresh reader sees the last commit, not the rolled-back one');
    store.writeLegacy();
    assert.deepEqual(legacyState(file), expected, 'the legacy row an older build reads holds the same workspace');
  } finally { await store.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('every acknowledged save survives a killed server, and a clean restart and the legacy row agree', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-crash-')), file = join(dataDir, 'frameline.sqlite');
  const child = await startChild(dataDir);
  let app: App | undefined, base = child.base;
  const { call, signup, edit } = client(() => base);
  try {
    const alice = await signup('alice'), bob = await signup('bob');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('film', alice.id), project('shared', alice.id, true));
    initial.state.timelines.push({ id: 'main', projectId: 'film', name: 'Main', duration: 60 });
    initial.state.tracks.push(track('v1', 'video', 1) as never, track('a1', 'audio', 1) as never);
    await call('/state', alice.cookie, initial, 'PUT');
    const media = (await call('/media?projectId=film&name=shot.mp4&placeholder=1', alice.cookie, {})).asset.id as string;
    await edit(alice.cookie, state => ({ ...state, clips: [clip('c1', media, 0), clip('c2', media, 2)] as never, operations: [operation('op1', alice.id, 'c1'), ...state.operations] as never }));
    await edit(alice.cookie, state => ({ ...state, clips: state.clips.map(item => item.id === 'c1' ? { ...item, start: 4 } : item), operations: [operation('op2', alice.id, 'c1'), ...state.operations] as never }));
    await edit(alice.cookie, state => ({ ...state, clips: state.clips.filter(item => item.id !== 'c2'), operations: [operation('op3', alice.id, 'c2'), ...state.operations.map(op => op.id === 'op1' ? { ...op, undone: true } : op)] as never,
      comments: [{ id: 'note', projectId: 'film', userId: alice.id, text: 'Tighten this', timestamp: 1, time: 3, resolved: false, replies: [{ id: 'reply', userId: alice.id, text: 'Done', timestamp: 2 }] }] as never }));
    await edit(alice.cookie, state => ({ ...state, snapshots: [{ id: 'snap', projectId: 'film', name: 'Cut 1', note: '', userId: alice.id, timestamp: 3, state: { clips: state.clips, tracks: state.tracks, nodes: [], comments: [] } }] as never, settings: { ...state.settings, uiScale: '110%' } }));
    await call(`/media/${media}`, alice.cookie, { name: 'Renamed shot' }, 'PATCH');
    await call(`/media/${media}/upload`, alice.cookie, { size: 2048, fingerprint: 'crash-test' });
    const chunk = Buffer.alloc(1024, 7);
    const upload = await fetch(`${base}/media/${media}/upload`, { method: 'PUT', headers: { cookie: alice.cookie, 'upload-offset': '0', 'upload-checksum': createHash('sha256').update(chunk).digest('hex') }, body: chunk });
    assert.equal(upload.status, 200);
    const folder = await call('/library', alice.cookie, { action: 'create', parentId: null, name: 'Class films', shared: true, classRole: 'Viewer', members: [], preview: true });
    const created = await call('/library', alice.cookie, { action: 'create', parentId: null, name: 'Class films', shared: true, classRole: 'Viewer', members: [], revision: folder.preview.revision });
    const move = await call('/library', alice.cookie, { action: 'move', kind: 'project', id: 'shared', parentId: created.id, preview: true });
    await call('/library', alice.cookie, { action: 'move', kind: 'project', id: 'shared', parentId: created.id, revision: move.preview.revision });
    await call('/projects/shared', alice.cookie, { name: 'Shared film' }, 'PATCH');
    await call('/projects/shared', alice.cookie, undefined, 'DELETE');
    await call('/projects/shared/restore', alice.cookie, {});
    await call('/auth/profile', alice.cookie, { name: 'Alice Renamed', email: 'alice@store.test' }, 'PATCH');
    const expected = plain((await call('/state', alice.cookie) as Envelope).state), expectedBob = plain((await call('/state', bob.cookie) as Envelope).state);
    assert.ok(expected.operations.length === 3 && expected.media[0].progress === 50 && expected.projects.length === 2, 'the edits all landed');

    await child.kill();
    app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }); base = await listen(app);
    assert.deepEqual(plain((await call('/state', alice.cookie) as Envelope).state), expected, 'nothing acknowledged was lost to the kill');
    assert.deepEqual(plain((await call('/state', bob.cookie) as Envelope).state), expectedBob);
    assert.deepEqual(legacyState(file), storedState(file), 'the restart brought the legacy row up to date');

    await edit(alice.cookie, state => ({ ...state, clips: state.clips.map(item => ({ ...item, name: 'After the crash' })) }));
    const edited = plain((await call('/state', alice.cookie) as Envelope).state);
    await app.close(); app = undefined;
    assert.deepEqual(legacyState(file), storedState(file), 'a clean shutdown leaves the legacy row complete for a rollback');
    app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }); base = await listen(app);
    assert.deepEqual(plain((await call('/state', alice.cookie) as Envelope).state), edited);
  } finally { await child.kill(); await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a single-row database migrates once, and a legacy row written by an older build or a script is imported', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-migrate-')), file = join(dataDir, 'frameline.sqlite');
  let app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }), base = await listen(app);
  const { call, signup } = client(() => base);
  const restart = async () => { await app.close(); app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }); base = await listen(app); };
  const items = () => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare('SELECT group_concat(rowid) AS rows FROM (SELECT rowid FROM workspace_items ORDER BY rowid)').get() as { rows: string | null }).rows; } finally { db.close(); } };
  const writeLegacy = (sql: string, change: (state: PersistedState) => void) => { const db = new DatabaseSync(file), state = legacyState(file); change(state); db.prepare(sql).run(JSON.stringify(state)); db.close(); };
  try {
    const alice = await signup('alice');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('film', alice.id)); initial.state.timelines.push({ id: 'main', projectId: 'film', name: 'Main', duration: 60 });
    await call('/state', alice.cookie, initial, 'PUT');
    const expected = plain((await call('/state', alice.cookie) as Envelope).state);
    await app.close();
    // What a database from before the item tables looks like: only the single JSON row.
    const old = new DatabaseSync(file); old.exec('DROP TRIGGER workspace_row_inserted; DROP TRIGGER workspace_row_updated; DROP TABLE workspace_items; DROP TABLE workspace_meta'); old.close();
    app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }); base = await listen(app);
    assert.deepEqual(plain((await call('/state', alice.cookie) as Envelope).state), expected, 'the single row migrates');
    const migrated = items(); assert.ok(migrated);
    await restart();
    assert.equal(items(), migrated, 'a second start does not import again');
    assert.deepEqual(plain((await call('/state', alice.cookie) as Envelope).state), expected);
    await app.close();

    // The upsert older builds and the color check scripts use; it leaves the revision alone.
    writeLegacy('INSERT INTO workspace(id,revision,state) VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state', state => { state.projects[0].description = 'Saved by an older build'; });
    app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }); base = await listen(app);
    assert.equal((await call('/state', alice.cookie) as Envelope).state.projects[0].description, 'Saved by an older build');
    await app.close();
    // A plain UPDATE, as the reprobe and color-assistant tests do.
    writeLegacy('UPDATE workspace SET state=? WHERE id=1', state => { state.timelines[0].name = 'Edited in place'; });
    app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }); base = await listen(app);
    const imported = (await call('/state', alice.cookie) as Envelope).state;
    assert.equal(imported.timelines[0].name, 'Edited in place'); assert.equal(imported.projects[0].description, 'Saved by an older build');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('project-bundle exports the latest edits even when the legacy row is behind, and its import appears on the next start', { timeout: 60_000 }, async () => {
  const [source, target, bundle] = await Promise.all(['bundle-from-', 'bundle-to-', 'bundle-'].map(prefix => mkdtemp(join(tmpdir(), prefix))));
  const bundleScript = async (...args: string[]) => { const run = await script('project-bundle.mjs', args[0] === 'export' ? source : target, ...args); assert.equal(run.code, 0, run.output); };
  let from = createFrameLineServer({ dataDir: source, legacyEveryMs: 1e9 }), base = await listen(from);
  const { call, signup, edit } = client(() => base);
  let to: App | undefined;
  try {
    const alice = await signup('alice');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('film', alice.id)); initial.state.timelines.push({ id: 'main', projectId: 'film', name: 'Main', duration: 60 }); initial.state.tracks.push(track('v1', 'video', 1) as never);
    await call('/state', alice.cookie, initial, 'PUT');
    await from.close(); from = createFrameLineServer({ dataDir: source, legacyEveryMs: 1e9 }); base = await listen(from);
    const media = (await call('/media?projectId=film&name=shot.mp4&placeholder=1', alice.cookie, {})).asset.id as string;
    await edit(alice.cookie, state => ({ ...state, clips: [clip('latest', media, 1)] as never }));
    // The server is still up, so its legacy row predates the clip; the export has to read the items.
    assert.equal(legacyState(join(source, 'frameline.sqlite')).clips.length, 0);
    await bundleScript('export', 'film', bundle);

    to = createFrameLineServer({ dataDir: target, legacyEveryMs: 1e9 }); base = await listen(to);
    const bob = await signup('bob'); await to.close(); to = undefined;
    await bundleScript('import', bundle);
    to = createFrameLineServer({ dataDir: target, legacyEveryMs: 1e9 }); base = await listen(to);
    const moved = (await call('/state', bob.cookie) as Envelope).state;
    assert.deepEqual(moved.projects.map(item => item.id), ['film']); assert.deepEqual(moved.clips.map(item => item.id), ['latest']);
  } finally { await from.close(); await to?.close(); await Promise.all([source, target, bundle].map(dir => rm(dir, { recursive: true, force: true }))); }
});
test('a bundle without media links the footage the other machine already has, by name and exact size', { timeout: 60_000 }, async () => {
  const [source, target, bundle, card] = await Promise.all(['bundle-from-', 'bundle-to-', 'bundle-', 'card-'].map(prefix => mkdtemp(join(tmpdir(), prefix))));
  const bundleScript = async (...args: string[]) => { const run = await script('project-bundle.mjs', args[0] === 'export' ? source : target, ...args); assert.equal(run.code, 0, run.output); };
  let from: App | undefined = createFrameLineServer({ dataDir: source, legacyEveryMs: 1e9 }), to: App | undefined, base = await listen(from);
  const { call, signup } = client(() => base);
  try {
    const alice = await signup('alice');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('trip', alice.id)); initial.state.timelines.push({ id: 'main', projectId: 'trip', name: 'Main', duration: 60 }); initial.state.tracks.push(track('v1', 'video', 1) as never);
    await call('/state', alice.cookie, initial, 'PUT');
    const media = (await call('/media?projectId=trip&name=C1088.MP4&placeholder=1', alice.cookie, {})).asset.id as string;
    await from.close(); from = undefined;
    const footage = 'the camera original';
    await mkdir(join(source, 'media', media), { recursive: true }); await writeFile(join(source, 'media', media, 'original'), footage);
    await bundleScript('export', 'trip', bundle, '--no-media');
    assert.equal(existsSync(join(bundle, 'media')), false, 'no footage travels');

    // The laptop's copy of the card: the same clip, and another take with the same name that must not be taken.
    await mkdir(join(card, 'A')); await mkdir(join(card, 'B'));
    await writeFile(join(card, 'A', 'C1088.MP4'), 'another take'); await writeFile(join(card, 'B', 'C1088.MP4'), footage);
    to = createFrameLineServer({ dataDir: target, legacyEveryMs: 1e9 }); base = await listen(to);
    const bob = await signup('bob'); await to.close(); to = undefined;
    await bundleScript('import', bundle, '--originals', card);
    assert.equal(statSync(join(target, 'media', media, 'original')).ino, statSync(join(card, 'B', 'C1088.MP4')).ino, 'linked, not copied');
    assert.equal(legacyState(join(target, 'frameline.sqlite')).media.find((item: { id: string }) => item.id === media)?.status, 'processing', 'prepared on the next start');

    // Back from the trip: the laptop's copy replaces the locked one, keeps this machine's prepared footage and owner.
    to = createFrameLineServer({ dataDir: target, legacyEveryMs: 1e9 }); base = await listen(to);
    await call('/projects/trip/lock', bob.cookie, { note: 'Editing offline' }, 'PUT'); await to.close(); to = undefined;
    const sent = JSON.parse(readFileSync(join(bundle, 'project.json'), 'utf8'));
    sent.clips.push({ ...clip('offline', media, 1), projectId: 'trip' }); sent.comments.push({ id: 'note', projectId: 'trip', userId: alice.id, text: 'hi', timestamp: 1, time: 0, resolved: false, replies: [] });
    Object.assign(sent.media[0], { name: 'Renamed.MP4', proxyUrl: 'from-laptop' }); await writeFile(join(bundle, 'project.json'), JSON.stringify(sent));
    assert.notEqual((await script('project-bundle.mjs', target, 'import', bundle)).code, 0, 'never over an existing project without --replace');
    await bundleScript('import', bundle, '--replace');
    const back = legacyState(join(target, 'frameline.sqlite')), asset = back.media.find((item: { id: string }) => item.id === media);
    assert.deepEqual(back.projects.map((item: { members: unknown; lock?: unknown }) => [item.members, item.lock]), [[[{ userId: bob.id, role: 'Owner' }], undefined]]);
    assert.deepEqual(back.clips.map((item: { id: string }) => item.id), ['offline']); assert.equal(back.comments[0].userId, bob.id);
    assert.equal(asset.name, 'Renamed.MP4'); assert.notEqual(asset.proxyUrl, 'from-laptop', "this machine's record");
  } finally { await from?.close(); await to?.close(); await Promise.all([source, target, bundle, card].map(dir => rm(dir, { recursive: true, force: true }))); }
});
test('the legacy row catches up in the background while the server keeps running', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-backup-')), file = join(dataDir, 'frameline.sqlite');
  const app = createFrameLineServer({ dataDir, legacyEveryMs: 50 }), base = await listen(app);
  const { call, signup, edit } = client(() => base);
  try {
    const alice = await signup('alice');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('film', alice.id));
    await call('/state', alice.cookie, initial, 'PUT');
    const saved = await edit(alice.cookie, state => ({ ...state, projects: state.projects.map(item => ({ ...item, description: 'Copied by the worker' })) }));
    let legacy: { revision: number; state: string } | undefined;
    for (let i = 0; i < 200 && !(legacy && legacy.revision >= saved.revision); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const db = new DatabaseSync(file, { readOnly: true }); legacy = db.prepare('SELECT revision,state FROM workspace WHERE id=1').get() as typeof legacy; db.close();
    }
    assert.ok(legacy && legacy.revision >= saved.revision, 'the worker wrote the legacy row');
    assert.equal(JSON.parse(legacy!.state).projects[0].description, 'Copied by the worker');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('upload progress wakes clients at most once a second', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-progress-'));
  const app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }), base = await listen(app);
  const { call, signup } = client(() => base);
  const events = new AbortController();
  try {
    const alice = await signup('alice');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('film', alice.id));
    await call('/state', alice.cookie, initial, 'PUT');
    const stream = await fetch(`${base}/events?clientId=progress`, { headers: { cookie: alice.cookie }, signal: events.signal });
    let counting = false, changes = 0;
    void (async () => { const reader = stream.body!.getReader(), decoder = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) return; if (counting) changes += decoder.decode(value).split('event: change').length - 1; } } catch { /* aborted */ } })();
    const chunks = 14, size = 64 * 1024, pause = () => new Promise(resolve => setTimeout(resolve, 100));
    // The plain upload route reports progress every 200 ms; the save path lets one through a second.
    const upload = httpRequest(`${base}/media?projectId=film&name=slow.wav`, { method: 'POST', headers: { cookie: alice.cookie, 'content-length': String(chunks * size), 'content-type': 'application/octet-stream' } });
    const finished = new Promise(resolve => upload.on('response', response => { response.resume(); response.on('end', resolve); }));
    upload.write(Buffer.alloc(size)); await pause(); await pause();
    counting = true;
    for (let i = 1; i < chunks - 1; i++) { upload.write(Buffer.alloc(size)); await pause(); }
    counting = false;
    upload.end(Buffer.alloc(size)); await finished;
    assert.ok(changes <= 3, `${changes} progress revisions in ~1.2 s`);
  } finally { events.abort(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a save moves no one else\'s rows, and history added in front never renumbers the list', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-two-users-')), file = join(dataDir, 'frameline.sqlite');
  const app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }), base = await listen(app);
  const { call, signup, edit } = client(() => base);
  const history = (id: string, userId: string, projectId: string) => ({ ...operation(id, userId, 'x'), projectId });
  const rows = () => { const db = new DatabaseSync(file, { readOnly: true }); try { return new Map((db.prepare("SELECT rowid,seq,data FROM workspace_items WHERE collection IN ('operations','projects')").all() as { rowid: number; seq: number; data: string }[]).map(row => [JSON.parse(row.data).id as string, `${row.rowid}:${row.seq}`])); } finally { db.close(); } };
  try {
    const users = [{ ...await signup('alice'), project: 'film' }, { ...await signup('bob'), project: 'other' }];
    for (const user of users) {
      const initial = await call('/state', user.cookie) as Envelope;
      initial.state.projects.push(project(user.project, user.id));
      initial.state.operations = Array.from({ length: 30 }, (_, i) => history(`${user.project}-${i}`, user.id, user.project)) as never;
      await call('/state', user.cookie, initial, 'PUT');
    }
    // Each sees only their own project, so the other's entries are hidden from every save they make.
    // Sixty saves cross the ~50 inserts after which a shrinking gap used to renumber the whole list.
    for (let round = 0; round < 60; round++) {
      const user = users[round % 3 === 2 ? 1 : 0], id = `${user.project}-new${round}`, before = rows();
      await edit(user.cookie, state => ({ ...state, operations: [history(id, user.id, user.project), ...state.operations] as never }));
      const changed = [...rows()].filter(([key, row]) => before.get(key) !== row).map(([key]) => key);
      assert.deepEqual(changed, [id], `save ${round} wrote only its own new entry`);
    }
    for (const user of users) {
      const seen = (await call('/state', user.cookie) as Envelope).state.operations.map(item => item.id);
      const added = Array.from({ length: 60 }, (_, round) => round).filter(round => (round % 3 === 2) === (user.project === 'other')).reverse().map(round => `${user.project}-new${round}`);
      assert.deepEqual(seen, [...added, ...Array.from({ length: 30 }, (_, i) => `${user.project}-${i}`)], 'each still sees their history newest first');
    }
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a second server on the same data folder refuses to start instead of saving over the first', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-second-')), file = join(dataDir, 'frameline.sqlite');
  let app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 });
  const base = await listen(app), { call, signup } = client(() => base);
  const rows = () => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT rowid,data FROM workspace_items ORDER BY rowid').all(); } finally { db.close(); } };
  try {
    const alice = await signup('alice');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('film', alice.id));
    await call('/state', alice.cookie, initial, 'PUT');
    // An asset mid-upload: a second start would mark it interrupted and save that over the live server's row.
    await call('/media?projectId=film&name=shot.mp4&placeholder=1', alice.cookie, {});
    const before = rows();
    assert.throws(() => createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }), /Another SharedCut server/);
    assert.deepEqual(rows(), before, 'the refused start wrote nothing');
    await app.close();
    app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('after a hard kill, sync-legacy-row hands an older build every save; without it, rolling forward keeps what the older build missed', { timeout: 60_000 }, async () => {
  const [dataDir, unsynced] = await Promise.all(['workspace-rollback-', 'workspace-unsynced-'].map(prefix => mkdtemp(join(tmpdir(), prefix))));
  const file = join(dataDir, 'frameline.sqlite'), server = await startChild(dataDir);
  let app: App | undefined, base = server.base;
  const { call, signup, edit } = client(() => base);
  try {
    const alice = await signup('alice');
    const initial = await call('/state', alice.cookie) as Envelope;
    initial.state.projects.push(project('film', alice.id));
    await call('/state', alice.cookie, initial, 'PUT');
    let saved = initial;
    for (const description of ['edit one', 'edit two', 'edit three']) saved = await edit(alice.cookie, state => ({ ...state, projects: state.projects.map(item => ({ ...item, description })) }));
    for (const run of [await script('sync-legacy-row.mjs', dataDir), await script('project-bundle.mjs', dataDir, 'import', dataDir)]) {
      assert.notEqual(run.code, 0, 'scripts that write the workspace refuse to run beside the server'); assert.match(run.output, /Another SharedCut server/);
    }
    await server.kill();
    assert.equal(legacyState(file).projects.length, 0, 'killed before its first background copy, the legacy row predates the project');
    cpSync(dataDir, unsynced, { recursive: true });

    // The documented rollback: stop the server, sync, start the older build.
    const sync = await script('sync-legacy-row.mjs', dataDir); assert.equal(sync.code, 0, sync.output);
    const older = olderBuild(file, state => { state.projects[0].name = 'Renamed on the older build'; });
    assert.equal(older.state.projects[0].description, 'edit three', 'the older build starts from the last acknowledged save');
    assert.ok(older.revision > saved.revision, 'and never reuses a revision an open tab already holds');
    app = createFrameLineServer({ dataDir, legacyEveryMs: 1e9 }); base = await listen(app);
    assert.deepEqual((await call('/state', alice.cookie) as Envelope).state.projects.map(item => [item.name, item.description]), [['Renamed on the older build', 'edit three']]);
    assert.deepEqual(recoveryFiles(dataDir), [], 'nothing was replaced');
    await app.close(); app = undefined;

    // Forgetting the sync: the older build misses the last saves, and rolling forward keeps them in a file.
    olderBuild(join(unsynced, 'frameline.sqlite'), () => {});
    app = createFrameLineServer({ dataDir: unsynced, legacyEveryMs: 1e9 }); base = await listen(app);
    assert.equal((await call('/state', alice.cookie) as Envelope).state.projects.length, 0, 'the latest writer, the older build, wins');
    const [recovery] = recoveryFiles(unsynced);
    assert.ok(recovery, 'the replaced workspace is kept');
    assert.equal(JSON.parse(readFileSync(join(unsynced, recovery), 'utf8')).projects[0].description, 'edit three');
  } finally { await server.kill(); await app?.close(); await Promise.all([dataDir, unsynced].map(dir => rm(dir, { recursive: true, force: true }))); }
});
