import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFrameLineServer } from './index.ts';
import type { PersistedState } from '../src/services/index.ts';

test('a locked project is read-only for everyone, its owner included, until the owner unlocks it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-lock-')), app = createFrameLineServer({ dataDir });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie = '') => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const signup = async (name: string) => { const r = await request('/auth/signup', 'POST', { name, email: `${name}@example.com`, password: 'a long secure password' }); return { id: r.data.user.id as string, cookie: r.cookie }; };
  const state = async (cookie: string) => (await request('/state', 'GET', undefined, cookie)).data as { revision: number; state: PersistedState };
  const trip = (view: { state: PersistedState }) => view.state.projects.find(p => p.id === 'trip')!;
  try {
    const alice = await signup('alice'), bob = await signup('bob');
    const initial = await state(alice.cookie);
    initial.state.projects.push({ id: 'trip', name: 'Trip', description: '', shared: true, thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: alice.id, role: 'Owner' }] });
    assert.equal((await request('/state', 'PUT', initial, alice.cookie)).status, 200);

    assert.equal((await request('/projects/trip/lock', 'PUT', { note: 'Editing offline' }, bob.cookie)).status, 403, 'only the owner locks');
    assert.equal((await request('/projects/trip/lock', 'PUT', { note: 'Editing offline' }, alice.cookie)).status, 200);
    for (const who of [alice, bob]) {
      const view = await state(who.cookie);
      assert.equal(trip(view).lock?.note, 'Editing offline');
      trip(view).description = 'changed while locked';
      const refused = await request('/state', 'PUT', view, who.cookie);
      assert.equal(refused.status, 423); assert.match(refused.data.error, /“Trip” is locked: Editing offline/);
    }
    assert.equal((await request('/projects/trip', 'DELETE', undefined, alice.cookie)).status, 403, 'nor deleted');
    // A save that leaves the lock out does not clear it.
    const unlocking = await state(alice.cookie); delete trip(unlocking).lock;
    await request('/state', 'PUT', unlocking, alice.cookie);
    assert.ok(trip(await state(alice.cookie)).lock);

    assert.equal((await request('/projects/trip/lock', 'DELETE', undefined, bob.cookie)).status, 403, 'only the owner unlocks');
    assert.equal((await request('/projects/trip/lock', 'DELETE', undefined, alice.cookie)).status, 200);
    const open = await state(bob.cookie); trip(open).description = 'edited after unlocking';
    assert.equal((await request('/state', 'PUT', open, bob.cookie)).status, 200);
    assert.equal(trip(open).members.find(m => m.userId === alice.id)?.role, 'Owner', 'roles come back with the unlock');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
