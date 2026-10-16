import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFrameLineServer } from './index.ts';
import type { PersistedState } from '../src/services/index.ts';

const PLAN = ['scripts', 'scriptBlocks', 'shots', 'boardItems'] as const;
const script = { id: 's1', projectId: 'p1', name: 'Pilot', format: 'screenplay', credit: 'Written by Ada', order: 1, modifiedAt: 1 };
const block = (id: string, order: number, extra: object = {}) => ({ id, projectId: 'p1', scriptId: 's1', kind: 'action', text: `Block ${id}`, order, modifiedAt: 1, ...extra });
// mediaIds and sceneId point at nothing that exists: Plan references are soft.
const shot = { id: 'sh1', projectId: 'p1', number: '1A', sceneId: 'b1', text: 'Wide on the door', size: 'WS', movement: 'Static', cast: 'Ada', location: 'Hall', notes: 'Morning light', mediaIds: ['still', 'gone'], done: false, order: 1, modifiedAt: 1 };
const card = { id: 'card1', projectId: 'p1', kind: 'image', x: 10, y: -20, w: 320, h: 180, z: 1, mediaId: 'still', color: '#aabbcc', modifiedAt: 1 };

// Project p1 (private) owned by Ada with Bo as Editor, Cy as Commenter and Di as Viewer; Eve is signed in but not a member.
// Bo saves one script, two blocks, a shot and a board card that uses the image 'still'.
async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-plan-'));
  const app = createFrameLineServer({ dataDir });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const signUp = async (name: string) => {
    const response = await fetch(`${origin}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.com`, password: 'a long plan password' }) });
    assert.equal(response.status, 201, await response.clone().text());
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], id: (await response.json()).user.id as string };
  };
  const [ada, bo, cy, di, eve] = await Promise.all(['Ada', 'Bo', 'Cy', 'Di', 'Eve'].map(signUp));
  type Who = typeof ada;
  const call = (who: Who, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`${origin}/api${path}`, { method, headers: { ...headers, cookie: who.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async (who: Who) => (await (await call(who, '/state')).json()) as { revision: number; state: PersistedState };
  const put = async (who: Who, edit: (state: PersistedState) => void) => { const current = await read(who); edit(current.state); return call(who, '/state', current, 'PUT'); };
  const patch = async (who: Who, delta: object) => call(who, '/state', { revision: (await read(who)).revision, delta }, 'PATCH');
  const upsert = (key: string, ...items: object[]) => ({ [key]: { upsert: items, remove: [] } });
  const remove = (key: string, ...ids: string[]) => ({ [key]: { upsert: [], remove: ids } });

  assert.equal((await put(ada, state => { state.projects.push({ id: 'p1', name: 'Short film', description: '', thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, shared: false, status: 'In progress', members: [{ userId: ada.id, role: 'Owner' }] }); })).status, 200);
  const shared = await call(ada, '/projects/p1', { access: 'people', members: [{ userId: bo.id, role: 'Editor' }, { userId: cy.id, role: 'Commenter' }, { userId: di.id, role: 'Viewer' }] }, 'PATCH');
  assert.equal(shared.status, 200, await shared.text());
  assert.equal((await call(ada, '/media?projectId=p1&id=still&name=still.png&placeholder=1', undefined, 'POST')).status, 201);
  const seeded = await put(bo, state => { state.scripts.push(script as any); state.scriptBlocks.push(block('b1', 1, { kind: 'scene', text: 'INT. HALL - DAY' }) as any, block('b2', 2) as any); state.shots.push(shot); state.boardItems.push(card as any); });
  assert.equal(seeded.status, 200, await seeded.text());
  return { dataDir, ada, bo, cy, di, eve, call, read, patch, upsert, remove, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('an editor saves a script, blocks, shots and board items; members read them back and nobody else sees them', async () => {
  const { ada, cy, eve, bo, read, patch, upsert, close } = await boot();
  try {
    for (const who of [ada, cy]) {
      const { state } = await read(who);
      assert.deepEqual(state.scripts, [script]);
      assert.deepEqual(state.scriptBlocks, [block('b1', 1, { kind: 'scene', text: 'INT. HALL - DAY' }), block('b2', 2)]);
      assert.deepEqual(state.shots, [shot]);
      assert.deepEqual(state.boardItems, [card]);
    }
    const outsider = (await read(eve)).state;
    for (const key of PLAN) assert.deepEqual(outsider[key], [], `A private project's ${key} stay out of an outsider's view.`);
    assert.equal((await patch(eve, upsert('scriptBlocks', block('b9', 9)))).status, 403, 'Nor can an outsider write into it.');

    // A PATCH that edits one block and adds a shot round-trips too; the block's script may dangle (soft reference).
    assert.equal((await patch(bo, { ...upsert('scriptBlocks', block('b2', 2, { text: 'She waits.' }), block('b3', 3, { scriptId: 'deleted-script' })), ...upsert('shots', { ...shot, id: 'sh2', number: '1B', order: 2 }) })).status, 200);
    const after = (await read(ada)).state;
    assert.equal(after.scriptBlocks.find(item => item.id === 'b2')!.text, 'She waits.');
    assert.deepEqual(after.scriptBlocks.map(item => item.id).sort(), ['b1', 'b2', 'b3']);
    assert.deepEqual(after.shots.map(item => item.number).sort(), ['1A', '1B']);
  } finally { await close(); }
});

test('commenters and viewers cannot change the plan, bad shapes get 400, and plan history is accepted', async () => {
  const { bo, cy, di, patch, upsert, remove, close } = await boot();
  try {
    for (const who of [cy, di]) {
      assert.equal((await patch(who, upsert('scriptBlocks', block('b9', 9)))).status, 403, 'Adding a block is refused.');
      assert.equal((await patch(who, upsert('scriptBlocks', block('b1', 1, { text: 'Rewritten' })))).status, 403, 'Editing one is refused.');
      assert.equal((await patch(who, remove('scriptBlocks', 'b2'))).status, 403, 'Deleting one is refused.');
    }
    const refused = async (delta: object, why: string) => { const response = await patch(bo, delta); assert.equal(response.status, 400, `${why}: ${await response.text()}`); };
    await refused(upsert('scriptBlocks', block('b9', 9, { kind: 'poem' })), 'unknown block kind');
    await refused(upsert('scriptBlocks', block('b9', 9, { text: 'x'.repeat(20_001) })), 'oversize block text');
    await refused(upsert('boardItems', { ...card, id: 'card2', color: 'red' }), 'bad color');
    await refused(upsert('boardItems', { ...card, id: 'card2', x: 1e6 + 1 }), 'x out of range');
    await refused(upsert('boardItems', { ...card, id: 'card2', w: 7 }), 'card too small');
    await refused(upsert('scripts', { ...script, id: 's2', format: 'novel' }), 'unknown script format');
    await refused(upsert('scripts', { ...script, id: 's2', author: 'x'.repeat(256) }), 'oversize author');
    await refused(upsert('shots', { ...shot, id: 'sh9', number: ' ' }), 'blank shot number');
    await refused(upsert('shots', { ...shot, id: 'sh9', mediaIds: ['../x'] }), 'bad media id');
    assert.equal((await patch(bo, upsert('boardItems', { ...card, id: 'card2', x: -1e6, w: 8, h: 20_000, kind: 'swatch' }))).status, 200, 'The limits themselves are allowed.');

    const operation = { id: 'op1', projectId: 'p1', userId: bo.id, timestamp: Date.now(), targetId: 'b1', type: 'ScriptChanged', description: 'Edited the script', oldState: [{ collection: 'scriptBlocks', id: 'b1', value: block('b1', 1) }], newState: [{ collection: 'scriptBlocks', id: 'b1', value: block('b1', 1, { text: 'Edited' }) }] };
    const history = await patch(bo, { ...upsert('operations', operation), ...upsert('scriptBlocks', block('b1', 1, { text: 'Edited' })) });
    assert.equal(history.status, 200, await history.text());
  } finally { await close(); }
});

test('a lock on one script block blocks only that block, and only saved blocks are lockable', async () => {
  const { ada, bo, call, patch, upsert, remove, close } = await boot();
  try {
    assert.equal((await call(ada, '/locks', { projectId: 'p1', targetId: 'b1', field: 'text' })).status, 200);
    assert.equal((await patch(bo, upsert('scriptBlocks', block('b1', 1, { text: 'Mine now' })))).status, 423, 'A collaborator cannot change a block she is typing in.');
    assert.equal((await patch(bo, remove('scriptBlocks', 'b1'))).status, 423, 'Nor delete it.');
    assert.equal((await patch(bo, upsert('scriptBlocks', block('b2', 2, { text: 'Next door' })))).status, 200, 'The block beside it is free.');
    assert.equal((await patch(ada, upsert('scriptBlocks', block('b1', 1, { text: 'Her own edit' })))).status, 200, 'Her own lock does not stop her.');
    for (const targetId of ['s1', 'sh1', 'card1']) assert.equal((await call(bo, '/locks', { projectId: 'p1', targetId, field: 'manipulation' })).status, 200, `${targetId} is lockable.`);
    assert.equal((await call(ada, '/locks', { projectId: 'p1', targetId: 'b-never-saved', field: 'text' })).status, 404);
  } finally { await close(); }
});

test('deleting a project removes its plan, and a backup written before the plan existed still restores', async () => {
  const { dataDir, ada, call, read, close } = await boot();
  try {
    assert.equal((await call(ada, '/projects/p1', undefined, 'DELETE')).status, 200);
    for (const key of PLAN) assert.deepEqual((await read(ada)).state[key], [], `${key} go with the project.`);
    const restored = await call(ada, '/projects/p1/restore', {});
    assert.equal(restored.status, 200, await restored.text());
    assert.deepEqual((await read(ada)).state.scripts, [script], 'A restore brings the plan back.');

    // Strip the Plan lists from the stored backup, as a backup written by an older build would be.
    assert.equal((await call(ada, '/projects/p1', undefined, 'DELETE')).status, 200);
    const db = new DatabaseSync(join(dataDir, 'frameline.sqlite'), { timeout: 5000 });
    try {
      const row = db.prepare('SELECT data FROM deleted_projects WHERE id=?').get('p1') as { data: string };
      const backup = JSON.parse(row.data);
      assert.deepEqual(backup.boardItems, [card], 'The backup carries the plan.');
      for (const key of PLAN) delete backup[key];
      db.prepare('UPDATE deleted_projects SET data=? WHERE id=?').run(JSON.stringify(backup), 'p1');
    } finally { db.close(); }
    const old = await call(ada, '/projects/p1/restore', {});
    assert.equal(old.status, 200, await old.text());
    const { state } = await read(ada);
    assert.ok(state.projects.some(project => project.id === 'p1'));
    for (const key of PLAN) assert.deepEqual(state[key], []);
  } finally { await close(); }
});

test('an image on the mood board cannot be deleted, one only linked to a shot can', async () => {
  const { ada, bo, call, patch, remove, close } = await boot();
  try {
    const refused = await call(ada, '/media/still', undefined, 'DELETE');
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /mood board/);
    assert.equal((await patch(bo, remove('boardItems', 'card1'))).status, 200);
    assert.equal((await call(ada, '/media/still', undefined, 'DELETE')).status, 200, 'The shot still lists it, which does not block deleting it.');
  } finally { await close(); }
});

test('presence keeps a known plan tab and drops anything else', async () => {
  const { bo, call, close } = await boot();
  try {
    const publish = async (planTab: unknown) => {
      const response = await call(bo, '/presence', { projectId: 'p1', clientId: 'tab', active: true, playhead: 0, activity: 'plan', planTab });
      assert.equal(response.status, 200);
      return ((await response.json()).presence as { userId: string; planTab?: string }[]).find(person => person.userId === bo.id)!;
    };
    assert.equal((await publish('board')).planTab, 'board');
    assert.equal((await publish('backstage')).planTab, undefined);
    assert.equal((await publish({ tab: 'script' })).planTab, undefined);
  } finally { await close(); }
});
