import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameLineServer } from './index.ts';

// A project of 2100 video clips (c0..c2099) on v1, one clip on the locked track v2, an audio track a1, and two signed-in editors.
async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-drag-'));
  const app = createFrameLineServer({ dataDir });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const signUp = async (name: string, email: string) => {
    const response = await fetch(`${origin}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ name, email, password: 'a shared drag password' }) });
    assert.equal(response.status, 201, await response.text());
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const ada = await signUp('Ada', 'ada@example.com'), bo = await signUp('Bo', 'bo@example.com');
  const post = (cookie: string, path: string, body: unknown, method = 'POST') => fetch(`${origin}/api${path}`, { method, headers: { ...headers, cookie }, body: JSON.stringify(body) });
  const start = await (await fetch(`${origin}/api/state`, { headers: { cookie: ada } })).json();
  const text = JSON.stringify({ runs: [{ text: 'Hi', style: { fontFamily: 'Helvetica Neue', fontSize: 96, fontWeight: 600, italic: false, underline: false, letterSpacing: 0, color: '#ffffff' } }], x: 0, y: 0, width: .5, height: .2, align: 'center', lineHeight: 1.2, opacity: 100 });
  const clip = (id: string, trackId: string, at: number) => ({ id, projectId: 'p1', timelineId: 't1', trackId, mediaId: 'frameline-title', name: id, start: at, duration: 1, sourceIn: 0, color: '#abcdef', disabled: false, properties: { textDocument: text }, effects: [] });
  const track = (id: string, kind: string, number: number, locked = false) => ({ id, timelineId: 't1', name: id, kind, number, muted: false, solo: false, locked, hidden: false, gain: 0, pan: 0 });
  const clips = [...Array.from({ length: 2100 }, (_, i) => clip(`c${i}`, 'v1', i)), clip('held-by-track', 'v2', 0)];
  const draft = { ...start.state,
    projects: [{ id: 'p1', name: 'Shared cut', description: '', thumbnail: '', modifiedAt: 1, duration: 2100, resolution: '1920x1080', fps: 24, shared: true, status: 'In progress', members: [] }],
    timelines: [{ id: 't1', projectId: 'p1', name: 'Main', duration: 2100 }],
    tracks: [track('v1', 'video', 1), track('v2', 'video', 2, true), track('a1', 'audio', 1)], clips };
  const seeded = await post(ada, '/state', { revision: start.revision, state: draft }, 'PUT');
  assert.equal(seeded.status, 200, await seeded.text());
  return { origin, ada, bo, post, start, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

// A multi-clip drag publishes one preview entry and holds one lock per moving clip. The client trims its
// preview to 1000 (src/services/sync.ts), so this pins the server's side of that contract.
test('drag previews of up to 1000 clips pass, anything else a collaborator cannot see is refused, and a clip-per-lock burst works', async () => {
  const { origin, ada, bo, post, start, close } = await boot();
  try {
    const entry = (id: string, at = 5, trackId = 'v1') => ({ id, trackId, start: at, duration: 1 });
    const preview = (cookie: string, items: unknown[], extra: object = {}) => post(cookie, '/presence', { projectId: 'p1', timelineId: 't1', clientId: 'x', active: true, playhead: 0, preview: { clips: items }, ...extra });
    const ids = (count: number) => Array.from({ length: count }, (_, i) => entry(`c${i}`));

    assert.equal((await preview(ada, ids(1000))).status, 200, 'The most the client sends is accepted.');
    const over = await preview(ada, ids(1001));
    assert.equal(over.status, 400, 'One more is refused; the client trims to 1000 so this never reaches it.');
    assert.match((await over.json()).error, /drag preview/i);
    assert.equal((await preview(ada, [entry('nope')])).status, 400, 'An unknown clip is refused.');
    assert.equal((await preview(ada, [entry('c0', 5, 'a1')])).status, 400, 'A clip cannot preview on a track of the other kind.');
    assert.equal((await preview(ada, [entry('held-by-track', 5, 'v1')])).status, 400, 'A clip on a locked track cannot preview.');
    assert.equal((await preview(ada, [entry('c0', 5, 'v2')])).status, 400, 'A locked track is not a preview target.');
    assert.equal((await preview(ada, [{ ...entry('c0'), duration: 0 }])).status, 400, 'A zero-length clip is refused.');

    // The mover's lock holds the clip: it blocks a collaborator's preview of it, never her own.
    assert.equal((await post(ada, '/locks', { projectId: 'p1', targetId: 'c5', field: 'manipulation' })).status, 200);
    assert.equal((await preview(bo, [entry('c4'), entry('c5')])).status, 423, 'A collaborator cannot preview a clip someone else is moving.');
    assert.equal((await preview(bo, [entry('c4'), entry('c6')])).status, 200);
    assert.equal((await preview(ada, [entry('c5'), entry('c6')])).status, 200, 'Her own lock does not block her own preview.');
    assert.equal((await post(ada, '/locks', { projectId: 'p1', targetId: 'c5', field: 'manipulation' }, 'DELETE')).status, 200);
    assert.equal((await preview(bo, [entry('c5')])).status, 200, 'Releasing the lock frees the clip.');

    // One lock request per moving clip, renewed and released the same way: 400 of each.
    const burst = Array.from({ length: 400 }, (_, i) => ({ projectId: 'p1', targetId: `c${i}`, field: 'manipulation' }));
    const all = async (cookie: string, method: string, expected: number, bodies = burst) => {
      const statuses = await Promise.all(bodies.map(body => post(cookie, '/locks', body, method).then(response => response.status)));
      assert.deepEqual([...new Set(statuses)], [expected]);
    };
    await all(ada, 'POST', 200);
    await all(ada, 'POST', 200);                                            // the 2 s renewal
    const state = await (await fetch(`${origin}/api/state?since=${start.revision + 1}`, { headers: { cookie: bo } })).json();
    assert.equal(state.locks.filter((lock: { userId: string }) => lock.userId !== state.currentUserId).length, 400, 'A collaborator sees every held clip.');
    await all(bo, 'POST', 409, burst.slice(0, 5));                          // Bo cannot take any of them
    await all(ada, 'DELETE', 200);
    await all(bo, 'POST', 200, burst.slice(0, 5));                          // all free again
  } finally { await close(); }
});

// A multi-clip drag takes, renews and releases all its locks with one request each (targetIds), all or nothing.
test('batched locks are all-or-nothing, renew in place, release only your own, and stay within 2000 ids', async () => {
  const { origin, ada, bo, post, start, close } = await boot();
  try {
    const lock = (cookie: string, targetIds: string[], method = 'POST', field = 'manipulation') => post(cookie, '/locks', { projectId: 'p1', targetIds, field }, method);
    const held = async (cookie: string) => ((await (await fetch(`${origin}/api/state?since=${start.revision + 1}`, { headers: { cookie } })).json()).locks as { userId: string; targetId: string; expiresAt: number }[]);
    const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `c${from + i}`);
    const lockRevision = async () => (await (await fetch(`${origin}/api/state?since=${start.revision + 1}`, { headers: { cookie: bo } })).json()).lockRevision as number;

    const before = await lockRevision();
    const first = await lock(ada, ids(0, 400));
    assert.equal(first.status, 200);
    const { locks } = await first.json();
    assert.equal(locks.length, 400, 'One request takes every clip and answers every lock.');
    assert.equal((await held(bo)).length, 400, 'A collaborator sees all of them.');
    assert.equal(await lockRevision() - before, 1, 'Collaborators are told once, not 400 times.');

    // Renewal: the same request again extends every expiry and still answers 200.
    await new Promise(resolve => setTimeout(resolve, 20));
    const again = (await (await lock(ada, ids(0, 400))).json()).locks as { expiresAt: number }[];
    assert.ok(again.every((renewed, i) => renewed.expiresAt > locks[i].expiresAt), 'Renewing extends every lease.');
    assert.equal(await lockRevision() - before, 1, 'A renewal tells nobody anything.');

    // One conflicting clip refuses the whole batch and takes nothing, so the 399 free ones stay free.
    const refused = await lock(bo, [...ids(400, 405), 'c10']);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).lock.targetId, 'c10');
    assert.equal((await held(ada)).length, 400, 'Nothing from the refused batch was taken.');
    assert.equal((await lock(ada, ids(400, 405))).status, 200, 'The five he tried are still free.');

    // Releasing removes only what the caller holds: Bo's DELETE of Ada's clips changes nothing, Ada's removes hers.
    assert.equal((await lock(bo, ids(0, 400), 'DELETE')).status, 200);
    assert.equal((await held(bo)).length, 405, 'Bo cannot release her locks.');
    assert.equal((await lock(ada, [...ids(0, 405), 'c900'], 'DELETE')).status, 200, 'An id she does not hold in the list is skipped.');
    assert.equal((await held(bo)).length, 0);
    assert.equal((await lock(bo, ids(0, 5))).status, 200, 'All free again.');

    // Edges of the batch form.
    assert.equal((await lock(ada, ids(5, 2005))).status, 200, '2000 ids is the most.');
    assert.equal((await lock(ada, ids(5, 2006))).status, 400, 'One more is refused.');
    assert.equal((await lock(ada, [])).status, 400, 'An empty batch is refused.');
    assert.equal((await post(ada, '/locks', { projectId: 'p1', targetIds: 'c1', field: 'manipulation' })).status, 400, 'targetIds must be a list.');
    assert.equal((await lock(ada, ['c50', 3 as unknown as string])).status, 400, 'Every id must be text.');
    assert.equal((await lock(ada, ['c50', 'nope'])).status, 404, 'An id that is not lockable here refuses the batch.');
    assert.equal((await lock(ada, ['c50', 'c50', 'c50'])).status, 200, 'Repeats collapse.');
  } finally { await close(); }
});

test('the single targetId form works exactly as before', async () => {
  const { ada, bo, post, close } = await boot();
  try {
    const one = (cookie: string, targetId: string, method = 'POST', field = 'manipulation') => post(cookie, '/locks', { projectId: 'p1', targetId, field }, method);
    const taken = await one(ada, 'c1');
    assert.equal(taken.status, 200);
    const { lock } = await taken.json();
    assert.deepEqual([lock.targetId, lock.field, lock.id], ['c1', 'manipulation', 'p1:c1:manipulation']);
    assert.equal((await one(ada, 'c1')).status, 200, 'Renewing is fine.');
    const conflict = await one(bo, 'c1', 'POST', 'start');
    assert.equal(conflict.status, 409, 'Movement fields conflict with each other.');
    assert.equal((await conflict.json()).lock.userId, lock.userId);
    assert.equal((await one(bo, 'c1', 'POST', 'speed')).status, 200, 'An unrelated field does not.');
    assert.equal((await one(bo, 'c1', 'DELETE')).status, 200);
    assert.equal((await one(bo, 'c2')).status, 200);
    assert.equal((await one(bo, 'c1')).status, 409, 'Bo deleting his own (absent) lock did not free hers.');
    assert.equal((await one(ada, 'c1', 'DELETE')).status, 200);
    assert.equal((await one(bo, 'c1')).status, 200);
    assert.equal((await one(ada, 'nope')).status, 404);
    assert.equal((await post(ada, '/locks', { projectId: 'p1', field: 'manipulation' })).status, 400, 'No target at all is refused.');
  } finally { await close(); }
});
