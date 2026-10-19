import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { createFrameLineServer } from './index.ts';
import type { PersistedState } from '../src/services/index.ts';

type App = ReturnType<typeof createFrameLineServer>;
const listen = async (app: App, port = 0) => { await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
const PASSWORD = 'a long secure password';

test('a desktop copy stays live with sharedcut.com, keeps editing offline and merges when it is back', async () => {
  const liveDir = await mkdtemp(join(tmpdir(), 'sharedcut-live-')), deskDir = await mkdtemp(join(tmpdir(), 'sharedcut-desk-'));
  let live = createFrameLineServer({ dataDir: liveDir }); const liveUrl = await listen(live), port = Number(new URL(liveUrl).port);
  const desk = createFrameLineServer({ dataDir: deskDir, remote: liveUrl, remoteEveryMs: 3_600_000 }); const deskUrl = await listen(desk);
  const request = async (base: string, path: string, method = 'GET', body?: unknown, cookie = '') => {
    const binary = body instanceof Uint8Array, response = await fetch(`${base}/api${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !binary ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : binary ? body as Uint8Array<ArrayBuffer> : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const signup = async (base: string, name: string) => { const r = await request(base, '/auth/signup', 'POST', { name, email: `${name}@example.com`, password: PASSWORD }); return { id: r.data.user.id as string, cookie: r.cookie }; };
  const read = async (base: string, who: { cookie: string }) => (await request(base, '/state', 'GET', undefined, who.cookie)).data as { revision: number; state: PersistedState };
  const put = async (base: string, who: { cookie: string }, change: (state: PersistedState) => void) => { const view = await read(base, who); change(view.state); const r = await request(base, '/state', 'PUT', view, who.cookie); assert.equal(r.status, 200, JSON.stringify(r.data)); };
  const until = async (done: () => Promise<boolean>, label: string) => { for (const end = Date.now() + 60_000; !(await done()); await new Promise(r => setTimeout(r, 200))) { if (Date.now() > end) assert.fail(`timed out: ${label}`); await desk.remote!.tick(); } };
  const png = () => new Uint8Array(createCanvas(32, 32).toBuffer('image/png'));
  const clip = (id: string, mediaId: string, start = 0) => ({ id, projectId: 'trip', timelineId: 'tl', trackId: 'v1', mediaId, name: id, start, duration: 4, sourceIn: 0, color: '#ffffff', disabled: false, properties: {}, effects: [] });
  const tripOf = (view: { state: PersistedState }) => ({ project: view.state.projects.find(p => p.id === 'trip'), clips: view.state.clips.filter(c => c.projectId === 'trip'), comments: view.state.comments.filter(c => c.projectId === 'trip'), media: view.state.media.filter(m => m.projectId === 'trip') });
  try {
    const alice = await signup(liveUrl, 'alice'), konrad = await signup(deskUrl, 'konrad');
    await put(liveUrl, alice, state => {
      state.projects.push({ id: 'trip', name: 'Trip', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: alice.id, role: 'Owner' }] });
      state.timelines.push({ id: 'tl', projectId: 'trip', name: 'Trip', duration: 60 });
      state.tracks.push({ id: 'v1', timelineId: 'tl', name: 'V1', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 });
    });
    assert.equal((await request(liveUrl, '/media?projectId=trip&id=m1&name=still.png', 'POST', png(), alice.cookie)).status, 202);
    for (const end = Date.now() + 30_000; tripOf(await read(liveUrl, alice)).media[0]?.status !== 'ready';) { assert.ok(Date.now() < end, 'the still prepares on sharedcut.com'); await new Promise(r => setTimeout(r, 200)); }
    await put(liveUrl, alice, state => { state.clips.push(clip('c1', 'm1')); state.comments.push({ id: 'k1', projectId: 'trip', userId: alice.id, text: 'Nice', timestamp: 1, time: 0, resolved: false, replies: [] }); });

    // Sign in from the desktop with the sharedcut.com account, then keep the project on this computer.
    assert.equal((await request(deskUrl, '/remote/login', 'POST', { email: 'alice@example.com', password: 'wrong password!!' }, konrad.cookie)).status, 401);
    const linked = await request(deskUrl, '/remote/login', 'POST', { email: 'alice@example.com', password: PASSWORD }, konrad.cookie);
    assert.equal(linked.status, 200); assert.equal(linked.data.user.id, alice.id);
    assert.deepEqual(linked.data.projects.map((p: { id: string; kept: boolean }) => [p.id, p.kept]), [['trip', false]]);
    assert.equal((await request(deskUrl, '/remote/projects/trip', 'PUT', undefined, konrad.cookie)).status, 200);
    await desk.remote!.tick();
    let here = tripOf(await read(deskUrl, konrad));
    assert.deepEqual(here.project?.members, [{ userId: konrad.id, role: 'Owner' }]);
    assert.deepEqual(here.clips.map(c => c.id), ['c1']);
    assert.equal(here.comments[0].userId, konrad.id, 'the sharedcut.com account is this computer\'s account here');
    await until(async () => tripOf(await read(deskUrl, konrad)).media[0]?.status === 'ready', 'the footage comes down and is prepared here');
    assert.ok(existsSync(join(deskDir, 'media', 'm1', 'original')));

    // Live both ways; when both change the same field, this computer's edit wins.
    await put(deskUrl, konrad, state => { state.clips = state.clips.map(c => c.id === 'c1' ? { ...c, name: 'Desk name', start: 2 } : c); });
    await put(liveUrl, alice, state => { state.projects = state.projects.map(p => p.id === 'trip' ? { ...p, description: 'from the web' } : p); state.clips = state.clips.map(c => c.id === 'c1' ? { ...c, start: 3 } : c); });
    await desk.remote!.tick();
    for (const view of [await read(liveUrl, alice), await read(deskUrl, konrad)]) {
      const trip = tripOf(view);
      assert.equal(trip.project?.description, 'from the web'); assert.equal(trip.clips[0].name, 'Desk name'); assert.equal(trip.clips[0].start, 2);
    }
    assert.equal((await request(deskUrl, '/remote', 'GET', undefined, konrad.cookie)).data.projects[0].status, 'synced');

    // Offline: sharedcut.com goes away, edits keep landing here, and merge when it is back.
    await live.close();
    await put(deskUrl, konrad, state => { state.clips.push(clip('c2', 'm1', 6)); state.comments.push({ id: 'k2', projectId: 'trip', userId: konrad.id, text: 'Cut here', timestamp: 2, time: 6, resolved: false, replies: [] }); });
    await desk.remote!.tick();
    assert.equal((await request(deskUrl, '/remote', 'GET', undefined, konrad.cookie)).data.projects[0].status, 'offline');
    live = createFrameLineServer({ dataDir: liveDir }); await listen(live, port);
    await put(liveUrl, alice, state => { state.projects = state.projects.map(p => p.id === 'trip' ? { ...p, name: 'Trip!' } : p); state.clips = state.clips.filter(c => c.id !== 'c1'); });
    await desk.remote!.tick();
    for (const view of [await read(liveUrl, alice), await read(deskUrl, konrad)]) {
      const trip = tripOf(view);
      assert.equal(trip.project?.name, 'Trip!'); assert.deepEqual(trip.clips.map(c => c.id), ['c2'], 'a delete on one side is not brought back by the other');
      assert.deepEqual(trip.comments.map(c => c.id).sort(), ['k1', 'k2']);
    }
    assert.equal(tripOf(await read(liveUrl, alice)).comments.find(c => c.id === 'k2')?.userId, alice.id);

    // Footage added on this computer goes up and is prepared there.
    assert.equal((await request(deskUrl, '/media?projectId=trip&id=m2&name=desk.png', 'POST', png(), konrad.cookie)).status, 202);
    await until(async () => tripOf(await read(deskUrl, konrad)).media.find(m => m.id === 'm2')?.status === 'ready', 'the new still prepares here');
    await put(deskUrl, konrad, state => { state.clips.push(clip('c3', 'm2', 12)); });
    await until(async () => { const trip = tripOf(await read(liveUrl, alice)); return trip.media.find(m => m.id === 'm2')?.status === 'ready' && trip.clips.some(c => c.id === 'c3' && c.mediaId === 'm2'); }, 'the new still and its clip go up, and the still prepares on sharedcut.com');
  } finally {
    await desk.close(); await live.close();
    await rm(liveDir, { recursive: true, force: true }); await rm(deskDir, { recursive: true, force: true });
  }
});
