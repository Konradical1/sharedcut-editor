// The color jobs against a fake SharedCut server (the Color Assistant needs OpenColorIO and an AI login, which a test
// machine lacks): the real store and save loop run, only fetch is answered here. Walks grade view → assistant start,
// poll, stills, apply → LUT add and rewrite, and the help topic generated from the app's own tables.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';
import { neutralLook, type LookOption } from '../../src/services/colorAssistant.ts';
import type { PersistedState } from '../../src/services/index.ts';

process.env.FRAME_LINE_URL = 'http://color.test';
process.env.FRAME_LINE_COOKIE = 'frameline_session=test';

// A demo project with two shots ready for the assistant (verified S-Log3 camera input, wide-gamut grade, ACES 2) and a legacy one.
const s = () => store.getState();
const a = s().clips.find(c => c.id === 'c3')!, projectId = a.projectId;
const [b, legacy] = s().clips.filter(c => c.projectId === projectId && c.id !== a.id && s().tracks.find(t => t.id === c.trackId)?.kind === 'video');
store.setState({ media: s().media.map(m => [a.mediaId, b.mediaId].includes(m.id) ? { ...m, cameraMetadataVersion: 2, inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } : m) });
for (const id of [a.id, b.id]) { s().updateProperty(id, 'inputProfile', 'S-Log3'); s().updateProperty(id, 'inputGamut', 'S-Gamut3.Cine'); s().initializeColorGrade(id); }
let server: PersistedState = structuredClone(persistentState(s()));
server.projects = server.projects.map(p => p.id === projectId ? { ...p, modifiedAt: Date.now() + 1e9 } : p);
let revision = 1;

const jobId = '0123abcd-2222-3333-4444-555555555555', base = `/api/projects/${projectId}/color-assistant`;
const option = (name: string, intensity: LookOption['intensity'], contrast: number): LookOption => ({ name, intensity, description: `${name} look`, extraNodes: [],
  look: { ...neutralLook(), contrast, curves: { ...neutralLook().curves, rgb: [{ x: 0, y: 0 }, { x: .5, y: .6 }, { x: 1, y: 1 }] } }, shots: [{ clipId: a.id, confidence: .8, warnings: [{ code: 'clipping', text: 'sky' }], rationale: '' }] });
const posted: any[] = [];
let polls = 0, cancelled = 0, failWith = 0;
const job = () => ({ id: jobId, projectId, mode: 'looks', createdAt: 1, request: posted[0], skipped: [],
  ...(polls < 2 ? { status: 'running', stage: 'Asking fake', progress: 40 } : { status: 'done', stage: 'Done', progress: 100,
    result: { looks: [option('Clean', 'natural', 1.2), option('Neon', 'bold', 1.5), option('Bleach', 'extreme', 2)], stills: [{ clipId: a.id, frame: 0, before: `${base}/${jobId}/stills/s0-f0-before.jpg`, after: [1, 2, 3].map(i => `${base}/${jobId}/stills/s0-f0-look${i}.jpg`) }] } }) });
// Normalize: answers every posted shot (targets and context) at once; the job applies the targets only.
// phone: a display-referred answer (gamma/gain only); stale: a shot measured through another interpretation, which the store skips.
const normalizeId = 'feed0000-2222-3333-4444-555555555555', nbase = `/api/projects/${projectId}/color-normalize`, normalizePosted: any[] = [];
let phone = false, stale = '';
const normalized = () => { const body = normalizePosted.at(-1); return { id: normalizeId, projectId, status: 'done', stage: 'Done', progress: 100, createdAt: 1, skipped: [{ clipId: 'gone', code: 'missing-media', text: 'Media is missing.' }],
  result: { shots: [...body.clipIds, ...(body.contextIds ?? [])].map((clipId: string) => ({ clipId, balance: phone ? { exposure: 0, temperature: 0, tint: 0, lift: 0, gamma: .5, gain: .8 } : { exposure: .3, temperature: -500, tint: 2, lift: -.01 }, confidence: .9, warnings: [{ code: 'clipping', text: 'sky' }],
    ...(clipId === stale && { input: { profile: 'Rec.709', gamut: 'Rec.709' } }) })), level: { group: .18, target: .18 } } }; };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input)), path = url.pathname, method = init.method ?? 'GET';
  if (path === '/api/auth/me') return json({ user: server.users.find(u => u.id === server.currentUserId) });
  if (path === '/api/state' && method === 'GET') return json(url.searchParams.has('since') ? { revision } : { revision, state: server });
  if (path === '/api/state' && method === 'PATCH') { const body = JSON.parse(String(init.body)); assert.equal(body.revision, revision); server = applyStateDelta(server, body.delta); return json({ revision: ++revision }); }
  if (path === '/api/color-assistant/capabilities') return json({ available: true, model: 'fake' });
  if (path === base && method === 'POST') { posted.push(JSON.parse(String(init.body))); return json({ jobId }, 202); }
  if (path === base) return json(job());
  if (path === `${base}/${jobId}` && method === 'DELETE') { cancelled++; return json({ ok: true }); }
  if (path === `${base}/${jobId}`) { if (failWith) return json({ error: `fake ${failWith}` }, failWith); polls++; return json(job()); }
  if (path === nbase && method === 'POST') { normalizePosted.push(JSON.parse(String(init.body))); return json({ jobId: normalizeId }, 202); }
  if (path === `${nbase}/${normalizeId}`) return json(normalized());
  if (path.startsWith(`${base}/${jobId}/stills/`)) return new Response(Buffer.from(path), { headers: { 'content-type': 'image/jpeg' } });
  return json({ error: `not faked: ${method} ${path}` }, 404);
}) as typeof fetch;

const { ready } = await import('../edit.ts');
const { jobs, topics, primaryTable } = await import('./color.ts');
const { isPoller } = await import('./kit.ts');
const short = (id: string) => '@' + id.slice(0, 8);
const nodes = (clipId: string) => server.nodes.filter(n => n.clipId === clipId).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
async function run(kind: string, params: Record<string, unknown>) {
  await ready();
  const started = await jobs[kind].start(params);
  if (!isPoller(started)) return started;
  for (;;) { const step = await started.poll(); if (step.done) return step; }
}
const dir = await mkdtemp(join(tmpdir(), 'sharedcut-color-'));
test.after(() => rm(dir, { recursive: true, force: true }));

test('color-grade shows the nodes in order, the transforms, the render check and assistant readiness', async () => {
  const { text } = await run('color-grade', { clip: a.id });
  const lines = text.split('\n');
  assert.match(lines[0], /nodes-v2 · source S-Log3\/S-Gamut3\.Cine · 4 nodes/);
  assert.match(lines[1], /^1 @\w+ "Input CST" \[cst S-Log3\/S-Gamut3\.Cine→DaVinci Intermediate\/DaVinci Wide Gamut/);
  assert.match(lines[4], /^4 @\w+ "Output CST" \[cst DaVinci Intermediate\/DaVinci Wide Gamut→Gamma 2\.4\/Rec\.709 aces2/);
  assert.match(text, /render check: ok/);
  assert.match(text, /assistant: ready/);
  assert.match((await run('color-grade', { clip: legacy.id })).text, /legacy .*\nrender check: ok\nassistant: no, Start wide-gamut grade first\.\nstart: act/);
});

test('color-looks pre-filters shots, saves, posts, polls to three looks, shows stills and applies one like the panel', async () => {
  const step = await run('color-looks', { clips: [a.id, b.id, legacy.id], prompt: ' warm dusk ', stills: true });
  assert.deepEqual(posted[0], { mode: 'looks', clipIds: [a.id, b.id], prompt: 'warm dusk' });
  assert.match(step.text, /Color Assistant job 0123abcd: 3 looks for 2 shots/);
  assert.match(step.text, new RegExp(`skipped: ${short(legacy.id)} Start wide-gamut grade first\\. \\(fix: act\\{do:\\[\\["initializeColorGrade","${short(legacy.id)}"\\]\\]\\}\\)`));
  assert.match(step.text, new RegExp(`job:"${jobId}", apply:N`), 'the full id: it resolves after an MCP restart');
  assert.match(step.text, /\n1 natural "Clean": contrast 1\.2 curves rgb3 — "Clean look" · @\w+ 80% clipping/);
  assert.match(step.text, /\n3 extreme "Bleach": contrast 2 /);
  assert.match(step.text, /images: before on @\w+, look 1, look 2, look 3/);
  assert.equal(step.content?.length, 4);
  assert.equal(Buffer.from((step.content![2] as { data: string }).data, 'base64').toString(), `${base}/${jobId}/stills/s0-f0-look2.jpg`);

  const snapshots = server.snapshots.length;
  const applied = await run('color-looks', { job: '0123abcd', apply: 2 });
  assert.match(applied.text, /Applied "Neon" to 2 shots/);
  for (const clip of [a, b]) {
    const look = nodes(clip.id).find(n => n.name === 'Look')!;
    assert.equal(look.parameters.contrast, 1.5);
    assert.equal(look.curves?.RGB?.points.length, 3);
  }
  assert.equal(server.snapshots.length, snapshots + 1, 'one snapshot, saved to the server');
  await assert.rejects(run('color-looks', { job: '0123abcd', apply: 4 }), /apply must be 1 to 3/);
});

test('a running assistant job can be cancelled and a 4xx ends the wait', async () => {
  polls = 0;
  const started = await jobs['color-looks'].start({ job: 'latest' });
  assert.ok(isPoller(started));
  assert.match((await started.poll()).text, /Asking fake 40%/);
  failWith = 502;
  assert.match((await started.poll()).text, /server unreachable, retrying/);
  failWith = 404;
  await assert.rejects(started.poll(), /fake 404/);
  failWith = 0;
  await started.cancel!();
  assert.equal(cancelled, 1);
  await assert.rejects(jobs['color-looks'].start({ job: 'ffffffff' }), /No Color Assistant job "ffffffff"/);
});

test('color-lut adds a .cube like the UI import and rewrites a list without the LUT data', async () => {
  const file = join(dir, 'teal.cube'), data = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];
  await writeFile(file, `TITLE "teal"\nLUT_3D_SIZE 2\n${data.reduce((rows, v, i) => rows + v + (i % 3 === 2 ? '\n' : ' '), '')}`);
  const balance = nodes(a.id).find(n => n.name === 'Balance')!;
  const added = await run('color-lut', { node: balance.id, file, amount: .5 });
  assert.match(added.text, /~ node @\w+ effects changed/);
  const lut = nodes(a.id).find(n => n.id === balance.id)!.effects![0];
  assert.ok(lut.type === 'lut');
  assert.deepEqual({ name: lut.name, amount: lut.amount, inputGamma: lut.inputGamma, inputGamut: lut.inputGamut, size: lut.cube.size, data: lut.cube.data }, { name: 'teal.cube', amount: .5, inputGamma: 'DaVinci Intermediate', inputGamut: 'DaVinci Wide Gamut', size: 2, data });
  assert.match((await run('color-grade', { clip: a.id })).text, /\[lut "teal\.cube" 2³ amount 0\.5 expects DaVinci Intermediate\/DaVinci Wide Gamut @\w+\]/);

  // What get{} hands the model: the data shortened to a string. The job restores it from the stored effect.
  await run('color-lut', { node: balance.id, effects: [{ ...lut, amount: .8, cube: { ...lut.cube, data: '[24 numbers]' } }] });
  const kept = nodes(a.id).find(n => n.id === balance.id)!.effects![0];
  assert.ok(kept.type === 'lut' && kept.amount === .8 && kept.cube.data.length === 24);
  await run('color-lut', { node: balance.id, effects: [] });
  assert.deepEqual(nodes(a.id).find(n => n.id === balance.id)!.effects, []);

  await assert.rejects(run('color-lut', { node: balance.id, file: 'teal.cube' }), /absolute path/);
  await writeFile(file, 'LUT_3D_SIZE 2\n0 0 0\n');
  await assert.rejects(run('color-lut', { node: balance.id, file }), /Incomplete LUT data/);
  await assert.rejects(run('color-lut', { node: balance.id, effects: [{ id: 'x', type: 'lut', enabled: true }] }), /was refused: Invalid node effect|Invalid 3D LUT|Unsupported effect input/);
});

test('color-normalize measures, applies as one undo into a new group, and joins it by name with the members as context', async () => {
  const snapshots = server.snapshots.length, other = s().clips.find(c => c.id === 'c4')!;
  const step = await run('color-normalize', { clips: [a.id, legacy.id, b.id], group: 'Night' });
  assert.deepEqual(normalizePosted[0], { clipIds: [a.id, legacy.id, b.id] });
  const id = server.clips.find(c => c.id === a.id)!.properties.colorGroup as string;
  assert.match(step.text, new RegExp(`^Normalized 2 of 3 shots into "Night" ${id} \\(2 shots\\); a snapshot keeps the old grades\\.`), 'the still is skipped by the store');
  assert.match(step.text, /\nbalance: @\w+ exp 0\.3 temp -500 tint 2 lift -0\.01 90% clipping · @\w+ .*\nskipped: @gone Media is missing\./);
  for (const clip of [a, legacy]) {
    assert.deepEqual(nodes(clip.id).map(n => n.name), ['Input CST', 'Balance', 'Night', 'Look', 'Output CST']);
    assert.equal(nodes(clip.id)[1].parameters.exposure, .3);
  }
  assert.equal(server.snapshots.length, snapshots + 1);
  assert.match((await run('color-grade', { clip: a.id })).text, new RegExp(`"Night" \\[group ${id}\\]`));

  const joined = await run('color-normalize', { clips: [other.id], group: 'night', clean: true });
  assert.deepEqual(normalizePosted[1], { clipIds: [other.id], contextIds: [legacy.id, a.id], clean: true }, 'the members go along for pooling, in timeline order; clean is measured as rebuilt');
  assert.match(joined.text, new RegExp(`^Normalized 1 of 1 shot into "Night" ${id} \\(3 shots\\), grades rebuilt;`));
  assert.equal(server.clips.find(c => c.id === other.id)!.properties.colorGroup, id);
  await assert.rejects(run('color-normalize', { clips: [a.id], group: 'cg-nope' }), /No color group cg-nope/);
  s().selectClips([]); await assert.rejects(run('color-normalize', {}), /select shots first/);
});

test('color-normalize names the group the shots moved into, measures a grouped shot with its group, and reports a phone balance', async () => {
  const other = s().clips.find(c => c.id === 'c4')!, night = server.clips.find(c => c.id === a.id)!.properties.colorGroup;
  await run('color-normalize', { clips: [other.id], group: null });
  stale = a.id;
  const dusk = await run('color-normalize', { clips: [a.id, other.id], group: 'Dusk' }), id = server.clips.find(c => c.id === other.id)!.properties.colorGroup as string;
  stale = '';
  assert.equal(server.clips.find(c => c.id === a.id)!.properties.colorGroup, night, 'the skipped shot keeps its group');
  assert.match(dusk.text, new RegExp(`^Normalized 1 of 2 shots into "Dusk" ${id} \\(1 shot\\);`), 'not the skipped shot\'s group');
  phone = true;
  const own = await run('color-normalize', { clips: [a.id] });
  phone = false;
  assert.deepEqual(normalizePosted.at(-1), { clipIds: [a.id], contextIds: [legacy.id] }, 'no group given: the rest of the shot\'s group is measured too');
  assert.match(own.text, /\nbalance: @\w+ gamma 0\.5 gain 0\.8 90% clipping/);
});

test('the help topic carries the app\'s slider ranges, render limits and color spaces', () => {
  const table = primaryTable();
  assert.equal(table.length, 6, 'all six Primaries sliders parsed from ColorWorkspace.tsx');
  assert.match(topics.color, /^Color grading/);
  assert.match(topics.color, /exposure 0 \(-6\.\.6, stops; render ±16\)/);
  assert.match(topics.color, /saturation 100 \(0\.\.200, 100 = unchanged; render ≤400\)/);
  assert.match(topics.color, /saturationShadows saturationMidtones saturationHighlights 100 \(0\.\.400/);
  assert.match(topics.color, /gammas: Rec\.709, S-Log3, .*Gamma 2\.4/);
  for (const line of Object.values(jobs).map(j => j.doc)) assert.ok(!line.includes('\n') && line.length < 200, line);
});
