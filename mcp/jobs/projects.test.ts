// The project jobs against a fake SharedCut server that answers the project routes like server/index.ts (owner
// fields, sharing, the class members route, delete with a 7-day backup, restore). Run: node --test mcp/jobs/projects.test.ts
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';

process.env.FRAME_LINE_URL = 'http://fake.local';
process.env.FRAME_LINE_COOKIE = 'frameline_session=test';
let saved: any = structuredClone(persistentState(store.getState()));
let revision = 1;
let recentProjectActivity: Record<string, { userId: string; kind: 'edited' | 'viewed'; timestamp: number }> = {};
// SharedCut Desktop's /api/remote: signed in to sharedcut.com, one project there not kept yet.
let remoteLink: { user: { email: string } | null; expired?: string; online: boolean; projects: { id: string; name: string; kept: boolean; status?: string; uploading: number; downloading: number }[] } = { user: { email: 'konrad@example.com' }, online: true, projects: [{ id: 'trip-1', name: 'Konrad Trip', kept: false, uploading: 0, downloading: 0 }] };
const deleted: any[] = [], calls: { method: string; path: string; body?: any }[] = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const project = (id: string) => saved.projects.find((p: any) => p.id === id);
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined, path = url.pathname;
  if (path === '/api/transitions') return json({ leaks: [], presets: [], favorites: [] }); // loaded once at connect
  if (path !== '/api/state' && path !== '/api/auth/me') calls.push({ method, path, body });
  if (path === '/api/auth/me') return json({ user: saved.users.find((u: any) => u.id === saved.currentUserId) });
  if (path === '/api/state' && method === 'GET') return json(url.searchParams.get('since') === String(revision) ? { revision } : { revision, state: saved });
  if (path === '/api/state' && method === 'PATCH') { saved = applyStateDelta(saved, body.delta); return json({ revision: ++revision }); }
  if (path === '/api/library') return json({ activity: recentProjectActivity, revision: 1, folders: [], locations: {}, directMembers: Object.fromEntries(saved.projects.map((p: any) => [p.id, p.members])) });
  if (path === '/api/projects/deleted') return json({ projects: deleted.map(p => ({ id: p.id, name: p.name, expiresAt: Date.parse('2026-10-12T10:00:00Z') })) });
  if (path === '/api/remote') return json(remoteLink);
  const keep = /^\/api\/remote\/projects\/([\w-]+)$/.exec(path);
  if (keep) { remoteLink.projects = remoteLink.projects.map(p => p.id === keep[1] ? { ...p, kept: method === 'PUT', status: method === 'PUT' ? 'synced' : undefined } : p); return json(remoteLink); }
  const restore = /^\/api\/projects\/([\w-]+)\/restore$/.exec(path);
  if (restore) { const i = deleted.findIndex(p => p.id === restore[1]); saved.projects.push(...deleted.splice(i, 1)); revision++; return json({ projectId: restore[1] }); }
  const member = /^\/api\/projects\/([\w-]+)\/members\/([\w-]+)$/.exec(path);
  if (member) {
    const p = project(member[1]);
    if (!p.shared) return json({ error: 'Only Class projects have collaborator roles.' }, 400);
    p.members = [...p.members.filter((m: any) => m.userId !== member[2]), { userId: member[2], role: body.role }]; revision++;
    return json({ project: p });
  }
  const lock = /^\/api\/projects\/([\w-]+)\/lock$/.exec(path);
  if (lock) { const p = project(lock[1]); if (method === 'PUT') p.lock = { userId: saved.currentUserId, at: 1, note: body.note }; else delete p.lock; revision++; return json({ project: p }); }
  const route = /^\/api\/projects\/([\w-]+)$/.exec(path);
  if (route && method === 'DELETE') { const p = project(route[1]); saved.projects = saved.projects.filter((x: any) => x !== p); deleted.push(p); revision++; return json({ projectId: p.id, expiresAt: Date.parse('2026-10-12T10:00:00Z') }); }
  if (route && method === 'PATCH') {
    const p = project(route[1]), owner = p.members.find((m: any) => m.role === 'Owner');
    if (owner.userId !== saved.currentUserId) return json({ error: 'Only the project owner can change project access.' }, 403);
    const access = body.access ?? (p.shared ? 'class' : p.members.length > 1 ? 'people' : 'private');
    let members = body.members ?? p.members.filter((m: any) => m.role !== 'Owner');
    if (access === 'private') members = [];
    Object.assign(p, { name: body.name ?? p.name, description: body.description ?? p.description, status: body.status ?? p.status, classRole: body.classRole ?? p.classRole, shared: access === 'class', members: [owner, ...members] });
    revision++;
    return json({ project: p });
  }
  return json({ error: `unexpected ${method} ${path}` }, 404);
}) as typeof fetch;

const { ready } = await import('../edit.ts');
const { jobs, topics } = await import('./projects.ts');
const { isPoller } = await import('./kit.ts');
await ready();
// Only the demo City After Dark has timelines, so it stays open; the private demo project is named explicitly.
const T = { project: 'above-the-treeline' };
const run = async (kind: string, params: Record<string, unknown> = {}) => { const step = await jobs[kind].start(params); assert.ok(!isPoller(step)); return step.text; };
const last = () => calls.at(-1)!;

test('project: no fields shows the project and who can be added; fields PATCH like the Dashboard dialog', async () => {
  const shown = await run('project', T);
  assert.match(shown, /@above-the-treeline "Above the Treeline" · Complete · 3840×2160 24fps · access private/);
  assert.match(shown, /others: Ashley @ashley, Jacob @jacob, Maya @maya/);
  assert.equal(calls.length, 0, 'showing calls nothing');
  const text = await run('project', { ...T, name: 'Treeline', status: 'In review' });
  assert.deepEqual(last(), { method: 'PATCH', path: '/api/projects/above-the-treeline', body: { name: 'Treeline', status: 'In review' } });
  assert.match(text, /"Treeline" · In review/);
  assert.equal(store.getState().projects.find(p => p.id === 'above-the-treeline')!.name, 'Treeline', 'refreshed into the store');
  await assert.rejects(run('project', { ...T, fps: 30 }), /setTimelineFormat/);
});

test('project members on a private project turn it into a people share (access is sent with them)', async () => {
  const text = await run('project', { ...T, members: [['Ashley', 'Editor'], { user: 'maya', role: 'Commenter' }] });
  assert.deepEqual(last().body, { members: [{ userId: 'ashley', role: 'Editor' }, { userId: 'maya', role: 'Commenter' }], access: 'people' });
  assert.match(text, /access people\nmembers: Kyle @kyle Owner, Ashley @ashley Editor, Maya @maya Commenter/);
  await assert.rejects(run('project', { ...T, members: [['ashley', 'Owner']] }), /role must be/);
  await assert.rejects(run('project', { ...T, members: [['nobody', 'Editor']] }), /No one called "nobody"/);
});

test('member keeps the others: library list + PATCH on people projects, the members route on class projects', async () => {
  await run('member', { ...T, user: 'jacob', role: 'Viewer' });
  assert.equal(calls.at(-2)!.path, '/api/library');
  assert.deepEqual(last().body, { access: 'people', members: [{ userId: 'ashley', role: 'Editor' }, { userId: 'maya', role: 'Commenter' }, { userId: 'jacob', role: 'Viewer' }] });
  await run('member', { ...T, user: 'ashley', role: 'none' });
  assert.deepEqual(last().body.members.map((m: any) => m.userId), ['maya', 'jacob']);
  await assert.rejects(run('member', { ...T, user: 'kyle', role: 'Viewer' }), /owner's role/);
  const text = await run('member', { project: 'city-after-dark', user: 'maya', role: 'Viewer' });
  assert.deepEqual(last(), { method: 'PATCH', path: '/api/projects/city-after-dark/members/maya', body: { role: 'Viewer' } });
  assert.match(text, /access class \(everyone Editor\)\nmembers: Kyle @kyle Owner, Maya @maya Viewer/);
});

test('delete-project needs confirm:true; restore-project lists, then restores by code or name', async () => {
  const before = calls.length;
  await assert.rejects(run('delete-project', { project: 'above-the-treeline' }), /confirm:true/);
  await assert.rejects(run('delete-project', { project: 'tree', confirm: true }), /No project is exactly "tree"/, 'never a partial name');
  assert.equal(calls.length, before, 'nothing deleted without confirm or an exact name');
  const text = await run('delete-project', { project: 'above-the-treeline', confirm: true });
  assert.equal(last().method, 'DELETE');
  assert.match(text, /deleted "Treeline" · restorable until 2026-10-12: job restore-project\{id:"above-the-treeline"\}/);
  assert.ok(!store.getState().projects.some(p => p.id === 'above-the-treeline'));
  assert.equal(await run('restore-project'), 'above-the-treeline "Treeline" · until 2026-10-12');
  await assert.rejects(run('restore-project', { id: 'nope' }), /No deleted project/);
  assert.match(await run('restore-project', { id: 'treeline' }), /restored @above-the-treeline "Treeline"/);
  assert.deepEqual(last(), { method: 'POST', path: '/api/projects/above-the-treeline/restore', body: {} });
  assert.ok(store.getState().projects.some(p => p.id === 'above-the-treeline'));
});

test('history lists edits, snapshots and open comments with handles; topics are derived from the app', async () => {
  const { edit } = await import('../edit.ts');
  await edit(async run => { store.getState().setPlayhead(4); await run('addComment', 'Fix the cut', {}); await run('saveSnapshot', 'Lock', ''); });
  const text = await run('history', { limit: 3 });
  assert.match(text, /^edits \(newest first\):\n@[\w-]+ 0m you: "commented at 0:04"/);
  assert.match(text, /snapshots:\n@[\w-]+ "Lock" you 0m/);
  assert.match(text, /open comments:[\s\S]*0:04\.00 you: "Fix the cut"/);
  for (const key of ['keyframes', 'ids', 'history', 'settings', 'properties']) assert.ok(topics[key]?.length > 200, key);
  assert.match(topics.settings, /^timelineFrameRate: 24 fps\|25 fps\|30 fps\|60 fps/m, 'settings parsed from SettingsDialog');
  assert.match(topics.settings, /^defaultTransition: Cross dissolve\|/m);
  assert.match(topics.properties, /^opacity=100 \(0–100\) %$/m);
  assert.match(topics.properties, /^motionBlurStrength=50 \(0–100\) .* · not animatable$/m);
  for (const job of Object.values(jobs)) assert.ok(!job.doc.includes('\n') && job.doc.length < 220, job.doc);
});

test('lock-project locks with a note and unlocks', async () => {
  const locked = await run('lock-project', { ...T, note: 'Editing offline on the MacBook Air' });
  assert.deepEqual(last(), { method: 'PUT', path: '/api/projects/above-the-treeline/lock', body: { note: 'Editing offline on the MacBook Air' } });
  assert.match(locked, /locked \("Editing offline on the MacBook Air"\) by .+: read-only for everyone until unlocked/);
  const open = await run('lock-project', { ...T, unlock: true });
  assert.deepEqual(last(), { method: 'DELETE', path: '/api/projects/above-the-treeline/lock', body: undefined });
  assert.doesNotMatch(open, /locked/);
});

test('keep-offline keeps a sharedcut.com project on this computer, lists what is kept and stops', async () => {
  assert.match(await run('keep-offline', { project: 'Konrad Trip' }), /"Konrad Trip" synced/);
  assert.deepEqual(last(), { method: 'PUT', path: '/api/remote/projects/trip-1', body: undefined });
  assert.match(await run('keep-offline', {}), /^konrad@example\.com\n.*"Konrad Trip" synced$/);
  assert.match(await run('keep-offline', { project: 'trip-1', stop: true }), /only online/);
  assert.equal(last().method, 'DELETE');
  // A session sharedcut.com ended says so, naming the account to sign in with again.
  remoteLink = { ...remoteLink, user: null, expired: 'konrad@example.com' };
  await assert.rejects(run('keep-offline', {}), /session of konrad@example\.com ended/);
});


test('project-activity shows the latest person, action and relative time, and omits old activity', async () => {
  const s = store.getState(), p = s.projects[0], user = s.users[0];
  recentProjectActivity = { [p.id]: { userId: user.id, kind: 'viewed', timestamp: Date.now() - 32 * 60_000 } };
  assert.match(await run('project-activity'), new RegExp(`${user.name} viewed this 32 minutes ago`));
  recentProjectActivity[p.id] = { userId: user.id, kind: 'edited', timestamp: Date.now() - 2 * 3600_000 };
  assert.match(await run('project-activity', { project: p.id }), /edited this 2 hours ago/);
  recentProjectActivity[p.id].timestamp = Date.now() - 86_400_000;
  assert.equal(await run('project-activity'), 'No activity in the past 24 hours.');
  recentProjectActivity = {};
});
