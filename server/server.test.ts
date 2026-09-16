import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { createFrameLineServer } from './index.ts';
import { getMediaCapabilities } from './media.ts';
import type { PersistedState } from '../src/services/index.ts';
import { createServer as createViteServer, loadConfigFromFile } from 'vite';

test('development proxy preserves browser origin for signup and authenticated writes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-proxy-'));
  const app = createFrameLineServer({ dataDir });
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' });
    const proxy = loaded!.config.server!.proxy!['/api'];
    vite = await createViteServer({ configFile: false, plugins: [], logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/api': typeof proxy === 'string' ? target : { ...proxy, target } } } });
    await vite.listen();
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const signup = await fetch(`${origin}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ name: 'Proxy Editor', email: 'proxy@example.com', password: 'proxy regression password' }) });
    assert.equal(signup.status, 201, await signup.text());
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
    assert.equal((await me.json()).user.email, 'proxy@example.com');
    const profile = await fetch(`${origin}/api/auth/profile`, { method: 'PATCH', headers: { ...headers, cookie }, body: JSON.stringify({ name: 'Updated Editor', email: 'proxy@example.com' }) });
    assert.equal(profile.status, 200, await profile.text());
    const hostile = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { ...headers, cookie, origin: 'https://attacker.example' } });
    assert.equal(hostile.status, 403);
    const crossSite = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { ...headers, cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
  } finally { await vite?.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP accounts, private/shared projects, role enforcement, conflicts and persistence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-http-'));
  let app = createFrameLineServer({ dataDir });
  const listen = async () => { await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
  let base = await listen(); let aliceCookie = '', bobCookie = '';
  const request = async (path: string, method = 'GET', body?: unknown, cookie = aliceCookie, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await response.json(); return { response, data };
  };
  const state = async (cookie = aliceCookie) => (await request('/state', 'GET', undefined, cookie)).data as { revision: number; state: PersistedState };
  const save = (value: { revision: number; state: PersistedState }, cookie = aliceCookie) => request('/state', 'PUT', value, cookie);
  const project = (id: string, owner: string, shared = false) => ({ id, name: id, description: '', shared, thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress' as const, members: [{ userId: owner, role: 'Owner' as const }] });
  try {
    assert.equal((await request('/auth/me', 'GET', undefined, '')).data.user, null);
    assert.equal((await request('/state', 'GET', undefined, '')).response.status, 401);
    assert.equal((await request('/auth/signup', 'POST', { name: 'Alice', email: 'a@example.com', password: 'short' }, '')).response.status, 400);
    const signup = await request('/auth/signup', 'POST', { name: 'Alice Editor', email: 'A@example.com', password: 'correct horse battery' }, '');
    assert.equal(signup.response.status, 201); aliceCookie = signup.response.headers.get('set-cookie')!.split(';')[0];
    assert.match(signup.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/); const alice = signup.data.user;
    assert.equal((await request('/auth/me')).data.user.id, alice.id);
    const initial = await state(); assert.equal(initial.state.projects.length, 0); assert.equal(initial.state.media.length, 0); assert.equal(initial.state.currentUserId, alice.id);
    initial.state.projects.push(project('private-project', alice.id), project('shared-project', alice.id, true));
    assert.equal((await save(initial)).response.status, 200);
    const bobSignup = await request('/auth/signup', 'POST', { name: 'Bob', email: 'b@example.com', password: 'a long secure password' }, ''); bobCookie = bobSignup.response.headers.get('set-cookie')!.split(';')[0]; const bob = bobSignup.data.user;
    assert.equal((await request('/auth/login', 'POST', { email: 'b@example.com', password: 'wrong password' }, '')).response.status, 401);
    assert.equal((await request('/auth/login', 'POST', { email: 'B@example.com', password: 'a long secure password' }, '')).response.status, 200);
    const bobView = await state(bobCookie); assert.deepEqual(bobView.state.projects.map(project => project.id), ['shared-project']); assert.equal(bobView.state.projects[0].members.find(member => member.userId === bob.id)?.role, 'Editor');
    const privileged = structuredClone(bobView); privileged.state.projects[0].members.find(member => member.userId === bob.id)!.role = 'Owner'; assert.equal((await save(privileged, bobCookie)).response.status, 403);
    const stolen = structuredClone(bobView); stolen.state.projects.push(project('private-project', bob.id)); assert.equal((await save(stolen, bobCookie)).response.status, 403);
    const impersonated = structuredClone(bobView); impersonated.state.currentUserId = alice.id; assert.equal((await save(impersonated, bobCookie)).response.status, 403);
    const ownProfile = structuredClone(bobView); ownProfile.state.users.find(user => user.id === bob.id)!.name = 'Impersonation'; assert.equal((await save(ownProfile, bobCookie)).response.status, 403);
    const privateAccess = structuredClone(bobView); privateAccess.state.projects[0].shared = false; assert.equal((await save(privateAccess, bobCookie)).response.status, 403);
    const csrf = await request('/state', 'PUT', bobView, bobCookie, { origin: 'https://attacker.example' }); assert.equal(csrf.response.status, 403);
    bobView.state.projects[0].description = 'Real shared edit'; assert.equal((await save(bobView, bobCookie)).response.status, 200);
    const oldSave = await save(initial); assert.equal(oldSave.response.status, 409); assert.equal(oldSave.data.state.projects.find((project: { id: string }) => project.id === 'shared-project').description, 'Real shared edit');
    const publishedHistory = await state();
    publishedHistory.state.operations.push({ id: 'history-check', projectId: 'shared-project', userId: alice.id, timestamp: Date.now(), targetId: 'shared-project', type: 'PropertyChanged', description: 'Saved entry', oldState: [], newState: [] });
    assert.equal((await save(publishedHistory)).response.status, 200);
    const reordered = await state(); reordered.state.operations = reordered.state.operations.map(op => Object.fromEntries(Object.entries(op).reverse()) as typeof op);
    assert.equal((await save(reordered)).response.status, 200, 'JSON field order is not a history edit.');
    const modifiedHistory = await state(); modifiedHistory.state.operations[0].description = 'Rewritten entry';
    assert.equal((await save(modifiedHistory)).response.status, 403, 'Even the author cannot rewrite history.');
    const foreignUndo = await state(bobCookie); foreignUndo.state.operations[0].undone = true;
    assert.equal((await save(foreignUndo, bobCookie)).response.status, 403);
    const ownUndo = await state(); ownUndo.state.operations[0].undone = true;
    assert.equal((await save(ownUndo)).response.status, 200);
    const concurrent = await state(); concurrent.state.settings.uiScale = '110%'; const results = await Promise.all([save(concurrent), save(concurrent)]); assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
    const invalid = await state(); invalid.state.timelines.push({ id: 'bad-timeline', projectId: 'missing', name: 'Invalid', duration: 100 }); assert.equal((await save(invalid)).response.status, 403);
    const fakeMedia = await state(); fakeMedia.state.media.push({ id: 'fake', projectId: 'private-project' } as never); assert.equal((await save(fakeMedia)).response.status, 400);
    assert.equal((await request('/auth/profile', 'PATCH', { name: 'Alice Updated', email: 'a@example.com', color: '#aabbcc' })).response.status, 200);
    assert.equal((await request('/auth/profile', 'PATCH', { name: 'Alice Updated', email: 'b@example.com' })).response.status, 409);
    const hostile = await fetch(`${base}/api/state`, { method: 'PUT', headers: { cookie: aliceCookie, 'content-type': 'application/json' }, body: '{"__proto__":{"polluted":true}}' }); assert.equal(hostile.status, 400);
    await app.close(); app = createFrameLineServer({ dataDir }); base = await listen();
    assert.equal((await request('/auth/me')).data.user.name, 'Alice Updated'); assert.equal((await state()).state.settings.uiScale, '110%'); assert.equal((await state(bobCookie)).state.projects[0].description, 'Real shared edit');
    assert.equal((await request('/presence', 'POST', { projectId: 'private-project', playhead: 0, cursor: { x: 0, y: 0 } }, bobCookie)).response.status, 404);
    assert.equal((await request('/presence', 'POST', { projectId: 'shared-project', playhead: 2, cursor: { x: 10, y: 20 }, presenting: true }, bobCookie)).response.status, 200);
    assert.equal((await request('/state')).data.presence[0].userId, bob.id);
    const presenceExchange = await request('/presence', 'POST', { projectId: 'shared-project', activity: 'color', playhead: 3, cursor: { x: 33, y: 44 } }, bobCookie);
    assert.equal(presenceExchange.data.presence.find((p: any) => p.userId === bob.id).activity, 'color');
    assert.ok(presenceExchange.data.presence.every((p: any) => p.projectId === 'shared-project'));
    assert.equal(presenceExchange.data.state, undefined, 'Cursor updates do not transfer the project document.');
    const anchoredCursor = { surface: 'timeline', anchor: 'track-1', x: 12345, y: .75 };
    const anchoredPresence = await request('/presence', 'POST', { projectId: 'shared-project', cursor: anchoredCursor }, bobCookie);
    assert.deepEqual(anchoredPresence.data.presence.find((p: any) => p.userId === bob.id).cursor, anchoredCursor);
    const hiddenPresence = await request('/presence', 'POST', { projectId: 'shared-project', cursor: null }, bobCookie);
    assert.equal(hiddenPresence.data.presence.find((p: any) => p.userId === bob.id).cursor, null);

    const publish = (clientId: string, fields: Record<string, unknown>, cookie = bobCookie) => request('/presence', 'POST', { projectId: 'shared-project', clientId, ...fields }, cookie);
    await publish('editing-tab', { active: true, cursor: anchoredCursor, playhead: 7, activity: 'edit' });
    for (let i = 0; i < 4; i++) {
      const background = await publish('background-tab', { active: false, cursor: null, playhead: 0, activity: 'color' });
      const people = background.data.presence.filter((p: any) => p.userId === bob.id);
      assert.equal(people.length, 1, 'Each account still has one visible collaborator.');
      assert.deepEqual(people[0].cursor, anchoredCursor, 'Background heartbeats must not erase the active cursor.');
      assert.equal(people[0].playhead, 7);
      assert.equal(people[0].activity, 'edit');
      await publish('editing-tab', { active: true, cursor: anchoredCursor, playhead: 7, activity: 'edit' });
    }
    const closedTab = await publish('background-tab', { online: false });
    assert.deepEqual(closedTab.data.presence.find((p: any) => p.userId === bob.id).cursor, anchoredCursor);
    const login = await request('/auth/login', 'POST', { email: 'b@example.com', password: 'a long secure password' }, '');
    const otherDevice = login.response.headers.get('set-cookie')!.split(';')[0];
    await publish('editing-tab', { active: true, cursor: { ...anchoredCursor, x: 88 }, playhead: 99 }, otherDevice);
    for (let i = 0; i < 4; i++) {
      const concurrent = await publish('editing-tab', { active: true, cursor: anchoredCursor, playhead: 7 });
      assert.equal(concurrent.data.presence.find((p: any) => p.userId === bob.id).playhead, 7, 'Two focused devices must not alternate with packet arrival order.');
      const other = await publish('editing-tab', { active: true, cursor: { ...anchoredCursor, x: 88 }, playhead: 99 }, otherDevice);
      assert.equal(other.data.presence.find((p: any) => p.userId === bob.id).playhead, 7);
    }
    const handoff = await publish('editing-tab', { active: false, cursor: null });
    assert.equal(handoff.data.presence.find((p: any) => p.userId === bob.id).playhead, 99, 'Blurring the owner hands presence to another active device.');
    await request('/auth/logout', 'POST', undefined, otherDevice);
    const remaining = (await request('/state')).data.presence.find((p: any) => p.userId === bob.id);
    assert.ok(remaining, 'Signing out on another device must not remove this session.');
    assert.equal(remaining.cursor, null);
    assert.equal((await publish('x'.repeat(161), { active: true })).response.status, 400);

    const commentState = await state(bobCookie); const comment = { id: 'comment', projectId: 'shared-project', userId: bob.id, text: 'Keep the original author', timestamp: Date.now(), time: 0, resolved: false, replies: [] }; commentState.state.comments.push(comment); assert.equal((await save(commentState, bobCookie)).response.status, 200);
    const snapshotState = await state(); snapshotState.state.snapshots.push({ id: 'snapshot', projectId: 'shared-project', userId: alice.id, name: 'Review', note: '', timestamp: Date.now(), state: { clips: [], tracks: [], nodes: [], comments: [comment] } }); assert.equal((await save(snapshotState)).response.status, 200);
    const removed = await state(); removed.state.comments = []; assert.equal((await save(removed)).response.status, 200);
    const restored = await state(); restored.state.comments = [comment]; assert.equal((await save(restored)).response.status, 200, 'a snapshot can restore another user’s original comment');
    const forged = await state(); forged.state.snapshots.push({ id: 'forged', projectId: 'shared-project', userId: alice.id, name: 'Forged', note: '', timestamp: Date.now(), state: { clips: [], tracks: [], nodes: [], comments: [{ ...comment, id: 'forged-comment', text: 'Forged text' }] } }); assert.equal((await save(forged)).response.status, 403);
    const memberPath = `/projects/shared-project/members/${bob.id}`;
    assert.equal((await request(memberPath, 'PATCH', { role: 'Viewer' }, bobCookie)).response.status, 403);
    assert.equal((await request(`/projects/shared-project/members/${alice.id}`, 'PATCH', { role: 'Viewer' })).response.status, 403);
    assert.equal((await request(memberPath, 'PATCH', { role: 'Owner' })).response.status, 400);
    assert.equal((await request(memberPath, 'PATCH', { role: 'Commenter' })).response.status, 200);
    const commenter = await state(bobCookie); commenter.state.comments.push({ ...comment, id: 'review-note', text: 'A commenter can leave feedback.' }); commenter.state.projects[0].modifiedAt = Date.now(); assert.equal((await save(commenter, bobCookie)).response.status, 200);
    const timelineEdit = await state(bobCookie); timelineEdit.state.timelines.push({ id: 'unauthorized-timeline', projectId: 'shared-project', name: 'Forbidden', duration: 120 }); assert.equal((await save(timelineEdit, bobCookie)).response.status, 403);
    assert.equal((await request(memberPath, 'PATCH', { role: 'Viewer' })).response.status, 200);
    const viewer = await state(bobCookie); viewer.state.comments.push({ ...comment, id: 'forbidden-review', text: 'Viewer cannot post.' }); assert.equal((await save(viewer, bobCookie)).response.status, 403);
    assert.equal((await request(memberPath, 'PATCH', { role: 'Editor' })).response.status, 200);
    const history = await state(bobCookie); history.state.operations.push({ id: 'bob-operation', projectId: 'shared-project', userId: bob.id, timestamp: Date.now(), targetId: 'comment', type: 'CommentAdded', description: 'Bob added a comment', oldState: [], newState: [] }); assert.equal((await save(history, bobCookie)).response.status, 200);
    const rewritten = await state(); rewritten.state.operations[0].description = 'Rewritten history'; assert.equal((await save(rewritten)).response.status, 403);
    const removedHistory = await state(); removedHistory.state.operations = []; assert.equal((await save(removedHistory)).response.status, 403);
    const undoHistory = await state(bobCookie); undoHistory.state.operations[0].undone = true; assert.equal((await save(undoHistory, bobCookie)).response.status, 200);
    const settings = await request('/projects/shared-project', 'PATCH', { name: 'Shared privately', description: 'Invited editors only', status: 'In review', resolution: '1280 × 720', fps: 30, access: 'people', memberIds: [bob.id] });
    assert.equal(settings.response.status, 200); assert.equal(settings.data.project.shared, false); assert.ok((await state(bobCookie)).state.projects.some(project => project.id === 'shared-project'));
    const deleted = await request('/projects/shared-project', 'DELETE'); assert.equal(deleted.response.status, 200); assert.ok(deleted.data.expiresAt > Date.now()); assert.equal((await state(bobCookie)).state.projects.length, 0);
    assert.equal((await request('/projects/shared-project/restore', 'POST', {})).response.status, 200); assert.ok((await state(bobCookie)).state.projects.some(project => project.id === 'shared-project'));
    assert.equal((await request('/auth/logout', 'POST', undefined, bobCookie)).response.status, 200); assert.equal((await request('/state', 'GET', undefined, bobCookie)).response.status, 401);
    const bytes = await readFile(join(dataDir, 'frameline.sqlite')); assert.equal(bytes.includes(Buffer.from('correct horse battery')), false);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('real upload, authenticated range playback, locks, export download and media protection', async t => {
  if (!(await getMediaCapabilities()).available) { t.skip('FFmpeg is required for media integration.'); return; }
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-media-http-')); const app = createFrameLineServer({ dataDir, maxUploadBytes: 1024 * 1024 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; let cookie = '';
  const request = async (path: string, method = 'GET', body?: unknown, customCookie = cookie) => { const response = await fetch(`${base}/api${path}`, { method, headers: { cookie: customCookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json(), response }; };
  const waitFor = async (predicate: (state: PersistedState) => boolean) => { for (let attempt = 0; attempt < 160; attempt++) { const data = (await request('/state')).data; if (predicate(data.state)) return data; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail('Media operation did not finish within 16 seconds.'); };
  try {
    const signup = await request('/auth/signup', 'POST', { name: 'Owner', email: 'owner@example.com', password: 'correct horse battery' }); cookie = signup.response.headers.get('set-cookie')!.split(';')[0];
    let data = (await request('/state')).data; const ownerId = signup.data.user.id;
    data.state.projects.push({ id: 'film', name: 'Film', description: '', shared: true, thumbnail: '', modifiedAt: Date.now(), duration: 1, resolution: '320 × 180', fps: 24, status: 'In progress', members: [{ userId: ownerId, role: 'Owner' }] });
    data.state.timelines.push({ id: 'timeline', projectId: 'film', name: 'Main', duration: 1 }); data.state.tracks.push({ id: 'track', timelineId: 'timeline', name: 'V1', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 });
    assert.equal((await request('/state', 'PUT', data)).status, 200);
    const fixture = join(dataDir, 'fixture.mp4'); execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture]);
    const bytes = await readFile(fixture); const uploaded = await fetch(`${base}/api/media?projectId=film&id=source&name=fixture.mp4`, { method: 'POST', headers: { cookie }, body: bytes }); assert.equal(uploaded.status, 202);
    data = await waitFor(state => ['ready', 'failed'].includes(state.media[0]?.status)); const asset = data.state.media[0]; assert.equal(asset.status, 'ready', asset.error); assert.ok(asset.waveform.length > 0); assert.equal(asset.hasAudio, true);
    const ranged = await fetch(`${base}${asset.proxyUrl}`, { headers: { cookie, range: 'bytes=0-15' } }); assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 16); assert.match(ranged.headers.get('content-range')!, /^bytes 0-15\//);
    assert.equal((await fetch(`${base}${asset.proxyUrl}`)).status, 401);
    const beyond = await fetch(`${base}${asset.proxyUrl}`, { headers: { cookie, range: 'bytes=99999999-' } }); assert.equal(beyond.status, 416);
    data.state.clips.push({ id: 'clip', projectId: 'film', timelineId: 'timeline', trackId: 'track', mediaId: 'source', name: 'Clip', start: 0, duration: 1, sourceIn: 0, color: '#aabbcc', disabled: false, properties: { speed: 100, volume: 0, opacity: 100, zoom: 1 }, effects: [] });
    assert.equal((await request('/state', 'PUT', data)).status, 200);
    for (const inspectorTab of ['Video', 'Audio', 'Effects', 'Info']) {
      const published = await request('/presence', 'POST', { projectId: 'film', timelineId: 'timeline', selectedClipId: 'clip', mediaTab: 'SFX', inspectorTab, cursor: null });
      const person = published.data.presence.find((p: any) => p.userId === ownerId);
      assert.equal(person.inspectorTab, inspectorTab);
      assert.equal(person.mediaTab, 'SFX');
      assert.equal(person.selectedClipId, 'clip');
    }
    for (const fields of [{}, { mediaTab: 'Invalid', inspectorTab: 'Invalid', selectedClipId: 'clip' }, { inspectorTab: 'Video', selectedClipId: 'missing' }]) {
      const published = await request('/presence', 'POST', { projectId: 'film', ...fields });
      const person = published.data.presence.find((p: any) => p.userId === ownerId);
      assert.equal(person.inspectorTab, undefined);
      assert.equal(person.mediaTab, undefined);
    }
    assert.equal((await request('/media/source', 'DELETE')).status, 409);
    const collaborator = await request('/auth/signup', 'POST', { name: 'Editor', email: 'editor@example.com', password: 'correct horse battery' }); const editorCookie = collaborator.response.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/locks', 'POST', { projectId: 'film', targetId: 'clip', field: 'speed' }, editorCookie)).status, 200);
    assert.equal((await request('/locks', 'POST', { projectId: 'film', targetId: 'clip', field: 'speed' })).status, 409);
    data = (await request('/state')).data; data.state.clips[0].properties.speed = 200; assert.equal((await request('/state', 'PUT', data)).status, 423);
    assert.equal((await request('/locks', 'DELETE', { projectId: 'film', targetId: 'clip', field: 'speed' }, editorCookie)).status, 200);
    const render = await request('/renders', 'POST', { projectId: 'film', name: 'First export', preset: 'Quick Export', settings: { resolution: '320 × 180', fps: '24', codec: 'H.264', audio: 'AAC · 320 kb/s · 48 kHz' } }); assert.equal(render.status, 202);
    data = await waitFor(state => ['complete', 'failed'].includes(state.renderJobs[0]?.status)); const job = data.state.renderJobs[0]; assert.equal(job.status, 'complete', job.error);
    const download = await fetch(`${base}${job.outputUrl}`, { headers: { cookie } }); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /First export/); assert.ok((await download.arrayBuffer()).byteLength > 1000);
    assert.equal((await fetch(`${base}${job.outputUrl}`)).status, 401);
    const rename = await request('/media/source', 'PATCH', { name: 'Renamed source.mp4' }); assert.equal(rename.data.asset.name, 'Renamed source.mp4');
    await request('/media/source', 'PATCH', { name: 'malicious.html' }); const original = await fetch(`${base}/api/media/source/original`, { headers: { cookie } }); assert.equal(original.headers.get('content-type'), 'application/octet-stream'); assert.match(original.headers.get('content-disposition')!, /^attachment/); await original.arrayBuffer();
    // Re-pulling the whole proxy on every page load is what made a remote viewer's first playback
    // stall. Prepared media is versioned and never rewritten, so it has to survive in the cache, and
    // a range request needs a strong validator to resume from it at all.
    const cached = await fetch(`${base}${asset.proxyUrl}`, { headers: { cookie } }); await cached.arrayBuffer();
    assert.match(cached.headers.get('cache-control')!, /immutable/); const tag = cached.headers.get('etag')!;
    assert.ok(tag && !tag.startsWith('W/'), 'A weak validator cannot satisfy If-Range.');
    assert.equal((await fetch(`${base}${asset.proxyUrl}`, { headers: { cookie, 'if-none-match': tag } })).status, 304);
    data = (await request('/state')).data; data.state.projects[0].shared = false; assert.equal((await request('/state', 'PUT', data)).status, 200);
    assert.equal((await fetch(`${base}${asset.proxyUrl}`, { headers: { cookie: editorCookie } })).status, 404); assert.equal((await fetch(`${base}${job.outputUrl}`, { headers: { cookie: editorCookie } })).status, 404);
    assert.equal((await request('/media/source/retry', 'POST', undefined, editorCookie)).status, 404); assert.equal((await request('/media/source', 'DELETE', undefined, editorCookie)).status, 404);
    const badUpload = await fetch(`${base}/api/media?projectId=film&id=invalid&name=..%2Fevil.mp4`, { method: 'POST', headers: { cookie }, body: bytes }); assert.equal(badUpload.status, 400);
    const oversized = await fetch(`${base}/api/media?projectId=film&id=oversized&name=large.mp4`, { method: 'POST', headers: { cookie }, body: Buffer.alloc(1024 * 1024 + 1) }); assert.equal(oversized.status, 413);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('configured registration access code gates new class members', async () => {
  const previous = process.env.FRAME_LINE_SIGNUP_CODE; process.env.FRAME_LINE_SIGNUP_CODE = 'class-access-secret';
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-registration-')); const app = createFrameLineServer({ dataDir });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    assert.equal((await (await fetch(`${base}/api/auth/me`)).json()).registrationRequiresCode, true);
    const signup = (inviteCode?: string) => fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Classmate', email: 'classmate@example.com', password: 'correct horse battery', inviteCode }) });
    assert.equal((await signup()).status, 403); assert.equal((await signup('wrong')).status, 403); assert.equal((await signup('class-access-secret')).status, 201);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.FRAME_LINE_SIGNUP_CODE; else process.env.FRAME_LINE_SIGNUP_CODE = previous; }
});

test('behind a trusted proxy, plain-http requests redirect to https and https requests do not', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-https-'));
  const previous = process.env.FRAME_LINE_TRUST_PROXY;
  process.env.FRAME_LINE_TRUST_PROXY = '1';
  const app = createFrameLineServer({ dataDir });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const port = (app.server.address() as { port: number }).port;
    const raw = (host: string, proto: string, path = '/api/health') => new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path, headers: { host, 'x-forwarded-proto': proto } }, response => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, location: response.headers.location });
      });
      request.on('error', reject); request.end();
    });

    const insecure = await raw('sharedcut.com', 'http', '/api/health?a=1');
    assert.equal(insecure.status, 301);
    assert.equal(insecure.location, 'https://sharedcut.com/api/health?a=1');

    assert.equal((await raw('sharedcut.com', 'https')).status, 200);

    const hostile = await raw('sharedcut.com/evil.example', 'http');
    assert.notEqual(hostile.status, 301);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.FRAME_LINE_TRUST_PROXY; else process.env.FRAME_LINE_TRUST_PROXY = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('placeholder media plus resumable chunked upload survives retries, bad offsets and corrupt chunks', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-chunked-'));
  const app = createFrameLineServer({ dataDir });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
    const signup = await fetch(`${base}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'chunk@example.com', password: 'correct horse battery' }) });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const ownerId = (await signup.json()).user.id;

    const state = await (await fetch(`${base}/state`, { headers: { cookie } })).json();
    state.state.projects.push({ id: 'film', name: 'Film', description: '', shared: true, thumbnail: '', modifiedAt: Date.now(), duration: 1, resolution: '320 × 180', fps: 24, status: 'In progress', members: [{ userId: ownerId, role: 'Owner' }] });
    assert.equal((await fetch(`${base}/state`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(state) })).status, 200);

    const created = await fetch(`${base}/media?projectId=film&id=source&name=clip.bin&placeholder=1`, { method: 'POST', headers: { cookie } });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).asset.status, 'uploading');

    const bytes = new Uint8Array(1000).fill(7); const fingerprint = 'clip.bin:1000:1';
    const put = (offset: number, chunk: Uint8Array<ArrayBuffer>, digest?: string) => fetch(`${base}/media/source/upload`, { method: 'PUT', headers: { cookie, 'upload-offset': String(offset), 'upload-checksum': digest ?? createHash('sha256').update(chunk).digest('hex') }, body: chunk });
    const init = () => fetch(`${base}/media/source/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ size: bytes.length, fingerprint }) });

    assert.equal((await (await init()).json()).offset, 0);
    assert.equal((await (await put(0, bytes.slice(0, 400))).json()).offset, 400);

    assert.equal((await init()).status, 200);
    assert.equal((await (await init()).json()).offset, 400, 'resume must report the server offset');
    assert.equal((await put(0, bytes.slice(0, 400))).status, 409, 'a stale offset must be rejected');
    assert.equal((await put(400, bytes.slice(400, 600), 'deadbeef')).status, 400, 'a corrupt chunk must be rejected');
    assert.equal((await (await fetch(`${base}/media/source/upload`, { headers: { cookie } })).json()).offset, 400, 'a rejected chunk must not advance the offset');

    assert.equal((await (await put(400, bytes.slice(400, 900))).json()).offset, 900);
    const last = await put(900, bytes.slice(900));
    assert.equal(last.status, 202);
    assert.equal((await last.json()).complete, true);

    const mismatched = await fetch(`${base}/media/source/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ size: 1000, fingerprint: 'other.bin:1000:1' }) });
    assert.equal((await mismatched.json()).complete, true, 'a finished upload is idempotent');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('locks cover every collection and an up-to-date poll skips the workspace copy', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-locks-'));
  const app = createFrameLineServer({ dataDir });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const signUp = async (name: string, email: string) => {
      const response = await fetch(`${origin}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ name, email, password: 'a shared lockdown password' }) });
      assert.equal(response.status, 201, await response.text());
      return response.headers.get('set-cookie')!.split(';')[0];
    };
    const ada = await signUp('Ada', 'ada@example.com'), bo = await signUp('Bo', 'bo@example.com');
    const read = async (cookie: string, since?: number) => {
      const response = await fetch(`${origin}/api/state${since === undefined ? '' : `?since=${since}`}`, { headers: { cookie } });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body);
    };
    const write = (cookie: string, revision: number, state: unknown) =>
      fetch(`${origin}/api/state`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ revision, state }) });

    const start = await read(ada);
    const draft = { ...start.state,
      projects: [{ id: 'p1', name: 'Shared cut', description: '', thumbnail: '', modifiedAt: 1, duration: 0, resolution: '1920x1080', fps: 24, shared: true, status: 'In progress', members: [] }],
      timelines: [{ id: 't1', projectId: 'p1', name: 'Main', duration: 0 }],
      tracks: [{ id: 'tr1', timelineId: 't1', name: 'V1', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 }] };
    assert.equal((await write(ada, start.revision, draft)).status, 200);

    // A track is lockable: before this, only clips and grades could be claimed at all.
    const claim = await fetch(`${origin}/api/locks`, { method: 'POST', headers: { ...headers, cookie: ada }, body: JSON.stringify({ projectId: 'p1', targetId: 'tr1', field: '*' }) });
    assert.equal(claim.status, 200, await claim.text());

    // Bo may still save unrelated work, but not the track Ada holds.
    const boView = await read(bo);
    const untouched = { ...boView.state, timelines: [{ ...boView.state.timelines[0], name: 'Renamed by Bo' }] };
    assert.equal((await write(bo, boView.revision, untouched)).status, 200);
    const current = await read(bo);
    const stolen = { ...current.state, tracks: [{ ...current.state.tracks[0], name: 'Renamed by Bo' }] };
    const rejected = await write(bo, current.revision, stolen);
    assert.equal(rejected.status, 423, await rejected.text());

    // Ada owns the lock, so the same edit from her goes through.
    const adaView = await read(ada);
    assert.equal((await write(ada, adaView.revision, { ...adaView.state, tracks: [{ ...adaView.state.tracks[0], name: 'Renamed by Ada' }] })).status, 200);

    // A client that already holds the current revision gets locks and presence, not the workspace.
    const latest = await read(ada);
    const short = await read(ada, latest.revision);
    assert.equal(short.state, undefined, 'An up-to-date poll must not resend the whole project.');
    assert.equal(short.revision, latest.revision);
    assert.ok(short.locks.some((lock: { targetId: string }) => lock.targetId === 'tr1'));
    assert.ok((await read(ada, latest.revision - 1)).state, 'A stale client still receives the full copy.');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
