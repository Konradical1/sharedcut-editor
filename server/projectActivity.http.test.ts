import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameLineServer } from './index.ts';

test('home activity records real edits and visits, rejects impersonation, and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-activity-'));
  let app = createFrameLineServer({ dataDir: dir });
  const listen = async () => { await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
  let base = await listen();
  const request = async (path: string, cookie = '', body?: unknown, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  try {
    const alice = await request('/auth/signup', '', { name: 'Alice', email: 'alice@activity.test', password: 'activity test password' });
    const bob = await request('/auth/signup', '', { name: 'Bob', email: 'bob@activity.test', password: 'activity test password' });
    const initial = (await request('/state', alice.cookie)).data;
    initial.state.projects.push({ id: 'film', name: 'Film', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: alice.data.user.id, role: 'Owner' }] });
    assert.equal((await request('/state', alice.cookie, initial, 'PUT')).status, 200);
    let activity = (await request('/library', alice.cookie)).data.activity.film;
    assert.equal(activity.userId, alice.data.user.id); assert.equal(activity.kind, 'edited');
    assert.deepEqual((await request('/library', bob.cookie)).data.activity, {});
    assert.equal((await request('/presence', bob.cookie, { projectId: 'film' })).status, 404);
    assert.equal((await request('/projects/film', alice.cookie, { access: 'people', members: [{ userId: bob.data.user.id, role: 'Viewer' }] }, 'PATCH')).status, 200);
    assert.equal((await request('/presence', bob.cookie, { projectId: 'film', active: true, userId: alice.data.user.id, timestamp: 1 })).status, 200);
    activity = (await request('/library', alice.cookie)).data.activity.film;
    assert.equal(activity.kind, 'viewed'); assert.equal(activity.userId, bob.data.user.id); assert.ok(activity.timestamp > Date.now() - 10_000);
    await request('/presence', bob.cookie, { projectId: 'film', online: false });
    const forbidden = (await request('/state', bob.cookie)).data; forbidden.state.projects[0].description = 'Forbidden';
    assert.equal((await request('/state', bob.cookie, forbidden, 'PUT')).status, 403);
    assert.deepEqual((await request('/library', alice.cookie)).data.activity.film, activity, 'failed edits and leaving do not overwrite the last activity');
    await app.close(); app = createFrameLineServer({ dataDir: dir }); base = await listen();
    assert.deepEqual((await request('/library', alice.cookie)).data.activity.film, activity);
    const save = (await request('/state', alice.cookie)).data; save.state.projects[0].description = 'Real edit without a history operation';
    assert.equal((await request('/state', alice.cookie, save, 'PUT')).status, 200);
    assert.equal((await request('/library', bob.cookie)).data.activity.film.kind, 'edited');
    const saved = (await request('/library', alice.cookie)).data.activity.film;
    const noop = (await request('/state', alice.cookie)).data;
    assert.equal((await request('/state', alice.cookie, noop, 'PUT')).status, 200);
    assert.deepEqual((await request('/library', alice.cookie)).data.activity.film, saved, 'no-op saves do not claim an edit');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
