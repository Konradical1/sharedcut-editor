import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { createFrameLineServer } from './index.ts';
import type { PersistedState } from '../src/services/index.ts';

type App = ReturnType<typeof createFrameLineServer>;
const listen = async (app: App, port = 0) => { await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
const PASSWORD = 'a long secure password';
const request = async (base: string, path: string, method = 'GET', body?: unknown, cookie = '') => {
  const binary = body instanceof Uint8Array, response = await fetch(`${base}/api${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !binary ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : binary ? body as Uint8Array<ArrayBuffer> : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
};
const signup = async (base: string, name: string) => { const r = await request(base, '/auth/signup', 'POST', { name, email: `${name}@example.com`, password: PASSWORD }); return { id: r.data.user.id as string, cookie: r.cookie }; };
const read = async (base: string, who: { cookie: string }) => (await request(base, '/state', 'GET', undefined, who.cookie)).data as { revision: number; state: PersistedState };
const put = async (base: string, who: { cookie: string }, change: (state: PersistedState) => void) => { const view = await read(base, who); change(view.state); const r = await request(base, '/state', 'PUT', view, who.cookie); assert.equal(r.status, 200, JSON.stringify(r.data)); };
const png = () => new Uint8Array(createCanvas(32, 32).toBuffer('image/png'));

test('a desktop copy stays live with sharedcut.com, keeps editing offline and merges when it is back', async () => {
  const liveDir = await mkdtemp(join(tmpdir(), 'sharedcut-live-')), deskDir = await mkdtemp(join(tmpdir(), 'sharedcut-desk-'));
  let live = createFrameLineServer({ dataDir: liveDir }); const liveUrl = await listen(live), port = Number(new URL(liveUrl).port);
  const desk = createFrameLineServer({ dataDir: deskDir, remote: liveUrl, remoteEveryMs: 3_600_000 }); const deskUrl = await listen(desk);
  const until = async (done: () => Promise<boolean>, label: string) => { for (const end = Date.now() + 60_000; !(await done()); await new Promise(r => setTimeout(r, 200))) { if (Date.now() > end) assert.fail(`timed out: ${label}`); await desk.remote!.tick(); } };
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

    // Locked on sharedcut.com: nothing moves either way until it is unlocked.
    assert.equal((await request(liveUrl, '/projects/trip/lock', 'PUT', { note: 'Being replaced' }, alice.cookie)).status, 200);
    await put(deskUrl, konrad, state => { state.clips = state.clips.map(c => c.id === 'c1' ? { ...c, name: 'While locked' } : c); });
    await desk.remote!.tick();
    assert.match((await request(deskUrl, '/remote', 'GET', undefined, konrad.cookie)).data.projects[0].error, /Locked on sharedcut\.com \(Being replaced\)/);
    assert.equal(tripOf(await read(deskUrl, konrad)).clips[0].name, 'While locked');
    assert.equal((await request(liveUrl, '/projects/trip/lock', 'DELETE', undefined, alice.cookie)).status, 200);
    await desk.remote!.tick();
    assert.equal(tripOf(await read(liveUrl, alice)).clips[0].name, 'While locked');

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

test('a project made on this computer goes up with its footage, one made offline follows, and one deleted there stays deleted', async () => {
  const liveDir = await mkdtemp(join(tmpdir(), 'sharedcut-live-')), deskDir = await mkdtemp(join(tmpdir(), 'sharedcut-desk-'));
  let live = createFrameLineServer({ dataDir: liveDir }); const liveUrl = await listen(live), port = Number(new URL(liveUrl).port);
  const desk = createFrameLineServer({ dataDir: deskDir, remote: liveUrl, remoteEveryMs: 3_600_000 }); const deskUrl = await listen(desk);
  const until = async (done: () => Promise<boolean>, label: string) => { for (const end = Date.now() + 60_000; !(await done()); await new Promise(r => setTimeout(r, 200))) { if (Date.now() > end) assert.fail(`timed out: ${label}`); await desk.remote!.tick(); } };
  const of = (view: { state: PersistedState }, id: string) => ({ project: view.state.projects.find(p => p.id === id), timelines: view.state.timelines.filter(t => t.projectId === id), tracks: view.state.tracks.filter(t => t.timelineId === `${id}-tl`), clips: view.state.clips.filter(c => c.projectId === id), comments: view.state.comments.filter(c => c.projectId === id), media: view.state.media.filter(m => m.projectId === id) });
  const link = async (who: { cookie: string }) => (await request(deskUrl, '/remote', 'GET', undefined, who.cookie)).data as { user: { id: string } | null; expired: string | null; projects: { id: string; kept: boolean; status?: string; error?: string; uploading: number }[] };
  try {
    const alice = await signup(liveUrl, 'alice'), konrad = await signup(deskUrl, 'konrad');
    const make = (state: PersistedState, id: string, name: string) => {
      state.projects.push({ id, name, description: '', shared: true, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '3840 × 2160', fps: 24, status: 'In progress', members: [{ userId: konrad.id, role: 'Owner' }] });
      state.timelines.push({ id: `${id}-tl`, projectId: id, name, duration: 60 });
      state.tracks.push({ id: `${id}-v1`, timelineId: `${id}-tl`, name: 'V1', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 });
    };
    const clip = (id: string, mediaId: string, start: number) => ({ id, projectId: 'yosemite', timelineId: 'yosemite-tl', trackId: 'yosemite-v1', mediaId, name: id, start, duration: 4, sourceIn: 0, color: '#ffffff', disabled: false, properties: {}, effects: [] });
    // Made on this computer before it was ever signed in: a still that is whole, and one a browser is still sending.
    await put(deskUrl, konrad, state => make(state, 'yosemite', 'Yosemite'));
    assert.equal((await request(deskUrl, '/media?projectId=yosemite&id=y1&name=falls.png', 'POST', png(), konrad.cookie)).status, 202);
    const late = png(), half = late.length >> 1;
    assert.equal((await request(deskUrl, '/media?projectId=yosemite&id=y2&name=late.png&placeholder=1', 'POST', undefined, konrad.cookie)).status, 201);
    assert.equal((await request(deskUrl, '/media/y2/upload', 'POST', { size: late.length, fingerprint: 'browser' }, konrad.cookie)).status, 200);
    const send = (from: number, to: number) => fetch(`${deskUrl}/api/media/y2/upload`, { method: 'PUT', headers: { cookie: konrad.cookie, 'upload-offset': String(from), 'upload-checksum': createHash('sha256').update(late.subarray(from, to)).digest('hex') }, body: late.subarray(from, to) });
    assert.equal((await send(0, half)).status, 200);
    await until(async () => of(await read(deskUrl, konrad), 'yosemite').media.find(m => m.id === 'y1')?.status === 'ready', 'the still prepares here');
    await put(deskUrl, konrad, state => { state.clips.push(clip('yc1', 'y1', 0), clip('yc2', 'y2', 4)); state.comments.push({ id: 'yk1', projectId: 'yosemite', userId: konrad.id, text: 'Half Dome', timestamp: 1, time: 0, resolved: false, replies: [] }); });
    // One whose id sharedcut.com already holds for another account stays here, and says why.
    const bob = await signup(liveUrl, 'bob');
    await put(liveUrl, bob, state => { state.projects.push({ id: 'clash', name: 'Bob', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: bob.id, role: 'Owner' }] }); });
    await put(deskUrl, konrad, state => make(state, 'clash', 'Clash'));
    // One this account deleted on sharedcut.com (say, a bundle's copy here) is not made again there.
    await put(liveUrl, alice, state => { state.projects.push({ id: 'old', name: 'Old', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: alice.id, role: 'Owner' }] }); });
    assert.equal((await request(liveUrl, '/projects/old', 'DELETE', undefined, alice.cookie)).status, 200);
    await put(deskUrl, konrad, state => make(state, 'old', 'Old'));
    // An original that turns up while its upload here is unfinished is not taken as whole.
    writeFileSync(join(deskDir, 'media', 'y2', 'original'), late);
    assert.deepEqual(await link(konrad), { url: liveUrl, user: null, expired: null, online: false, projects: [] });

    // Signed in: it goes up as the sharedcut.com account's private project, same ids, and is kept from then on.
    assert.equal((await request(deskUrl, '/remote/login', 'POST', { email: 'alice@example.com', password: PASSWORD }, konrad.cookie)).status, 200);
    await desk.remote!.tick();
    let there = of(await read(liveUrl, alice), 'yosemite');
    assert.deepEqual(there.project?.members, [{ userId: alice.id, role: 'Owner' }]); assert.equal(there.project?.shared, false, 'sharing is each server\'s own');
    assert.deepEqual([there.timelines.map(t => t.id), there.tracks.map(t => t.id), there.clips.map(c => c.id).sort(), there.media.map(m => m.id).sort()], [['yosemite-tl'], ['yosemite-v1'], ['yc1', 'yc2'], ['y1', 'y2']]);
    assert.equal(there.comments[0].userId, alice.id);
    const projects = (await link(konrad)).projects, row = (id: string) => projects.find(p => p.id === id);
    assert.deepEqual(projects.map(p => [p.id, p.kept, p.status]).sort(), [['clash', true, 'error'], ['old', true, 'error'], ['yosemite', true, 'synced']]);
    assert.match(row('clash')?.error ?? '', /cannot open/); assert.match(row('old')?.error ?? '', /Not on sharedcut\.com any more/); assert.ok(!of(await read(liveUrl, alice), 'old').project);
    // Stopped before they went up, they stay here only.
    for (const id of ['clash', 'old']) assert.equal((await request(deskUrl, `/remote/projects/${id}`, 'DELETE', undefined, konrad.cookie)).status, 200);
    await until(async () => of(await read(liveUrl, alice), 'yosemite').media.find(m => m.id === 'y1')?.status === 'ready', 'the whole still goes up and prepares there');
    for (let i = 0; i < 3; i++) await desk.remote!.tick();
    assert.equal(of(await read(liveUrl, alice), 'yosemite').media.find(m => m.id === 'y2')?.status, 'uploading');
    assert.deepEqual((await request(liveUrl, '/media/y2/upload', 'GET', undefined, alice.cookie)).data, { offset: 0, complete: false, metadata: null }, 'nothing of the unfinished one went up');
    assert.equal((await link(konrad)).projects[0].uploading, 0);
    assert.equal(of(await read(liveUrl, bob), 'clash').project?.name, 'Bob'); assert.ok(of(await read(deskUrl, konrad), 'clash').project);

    // Offline: the browser's upload finishes here and a project is made; both wait, counted.
    await live.close();
    rmSync(join(deskDir, 'media', 'y2', 'original'));
    assert.equal((await send(half, late.length)).status, 202);
    await put(deskUrl, konrad, state => make(state, 'trail', 'Trail'));
    await until(async () => of(await read(deskUrl, konrad), 'yosemite').media.find(m => m.id === 'y2')?.status === 'ready', 'the late still prepares here');
    await desk.remote!.tick();
    assert.deepEqual((await link(konrad)).projects.map(p => [p.id, p.status, p.uploading]), [['yosemite', 'offline', 1]]);
    // Its placeholder sat untouched there for a day, so sharedcut.com dropped it; it goes up all the same.
    const old = new Date(Date.now() - 2 * 86400_000); utimesSync(join(liveDir, 'media', 'y2'), old, old);
    live = createFrameLineServer({ dataDir: liveDir }); await listen(live, port);
    assert.equal(of(await read(liveUrl, alice), 'yosemite').media.find(m => m.id === 'y2')?.status, 'failed');
    await until(async () => { const view = await read(liveUrl, alice); return of(view, 'yosemite').media.find(m => m.id === 'y2')?.status === 'ready' && !!of(view, 'trail').project; }, 'back online, the project made offline and the late still go up');
    there = of(await read(liveUrl, alice), 'trail');
    assert.deepEqual([there.project?.members, there.tracks.map(t => t.id)], [[{ userId: alice.id, role: 'Owner' }], ['trail-v1']]);

    // Deleted on sharedcut.com: never made again. This computer keeps its copy, and stopping keeps it here only.
    assert.equal((await request(liveUrl, '/projects/trail', 'DELETE', undefined, alice.cookie)).status, 200);
    await desk.remote!.tick();
    assert.match((await link(konrad)).projects.find(p => p.id === 'trail')?.error ?? '', /Not on sharedcut\.com any more/);
    assert.equal((await request(deskUrl, '/remote/projects/trail', 'DELETE', undefined, konrad.cookie)).status, 200);
    await put(deskUrl, konrad, state => { state.projects = state.projects.map(p => p.id === 'trail' ? { ...p, description: 'Still here' } : p); });
    await desk.remote!.tick();
    assert.ok(!of(await read(liveUrl, alice), 'trail').project); assert.equal(of(await read(deskUrl, konrad), 'trail').project?.description, 'Still here');

    // Made on sharedcut.com: listed, never downloaded until kept.
    await put(liveUrl, alice, state => { state.projects.push({ id: 'web', name: 'Web', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: alice.id, role: 'Owner' }] }); });
    await desk.remote!.tick();
    assert.ok(!of(await read(deskUrl, konrad), 'web').project);
    assert.deepEqual((await link(konrad)).projects.find(p => p.id === 'web')?.kept, false);

    // sharedcut.com ends the session: the app says so and names the account; signing out forgets it.
    const { cookie } = JSON.parse(readFileSync(join(deskDir, 'remote-sync.json'), 'utf8'));
    assert.equal((await request(liveUrl, '/auth/logout', 'POST', {}, cookie)).status, 200);
    await desk.remote!.tick();
    assert.deepEqual([(await link(konrad)).user, (await link(konrad)).expired], [null, 'alice@example.com']);
    assert.equal((await request(deskUrl, '/remote/logout', 'POST', undefined, konrad.cookie)).data.expired, null);
  } finally {
    await desk.close(); await live.close();
    await rm(liveDir, { recursive: true, force: true }); await rm(deskDir, { recursive: true, force: true });
  }
});
