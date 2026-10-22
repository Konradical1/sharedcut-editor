// The color jobs against a fake SharedCut server (the Color Assistant needs OpenColorIO and an AI login, which a test
// machine lacks): the real store and save loop run, only fetch is answered here. Walks grade view → assistant start,
// poll, stills, apply → LUT add and rewrite → the v3 tools in the grade view → color-measure on a stubbed /api/frames
// picture against a reference PNG, a media item and another clip, and the help topic generated from the registry.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';
import { neutralLook, type LookOption } from '../../src/services/colorAssistant.ts';
import { GRADE_PARAMS } from '../../src/services/grading.ts';
import { COLOR_LOOKS } from '../../src/services/colorPresets.ts';
import { colorTransform, encodeLog, gamutMatrix } from '../../src/services/color.ts';
import { measure, hints, regionHint } from '../colorStats.ts';
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
// /api/frames: the rendered frame (a timeline) or a file's own picture (mediaId); `refuse` answers as the server does for a frame it
// cannot render alone, from request `refuseFrom` + 1 on.
const frames: Record<string, string>[] = [];
let frameJpeg = Buffer.alloc(0), mediaJpeg = Buffer.alloc(0), refuse: { live: string; error: string } | null = null, refuseFrom = 0;
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
  if (path === '/api/frames') {
    frames.push(Object.fromEntries(url.searchParams));
    if (refuse && frames.length > refuseFrom) return json(refuse, 409);
    return new Response(url.searchParams.has('mediaId') ? mediaJpeg : frameJpeg, { headers: { 'content-type': 'image/jpeg' } });
  }
  return json({ error: `not faked: ${method} ${path}` }, 404);
}) as typeof fetch;

const { ready } = await import('../edit.ts');
const { jobs, topics, gradeModel } = await import('./color.ts');
const { edit } = await import('../edit.ts');
const { help } = await import('../catalog.ts');
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

test('color-grade summarizes windows, the qualifier, HSL curves, the mixer and film, marks keyframes and an unset pivot', async () => {
  const look = nodes(a.id).find(n => n.name === 'Look')!, flat = (id: string, ys: number[]) => ({ mode: 'smooth' as const, points: ys.map((y, i) => ({ id: `${id}${i}`, x: i / (ys.length - 1), y })) });
  await edit(run => run('updateNode', look.id, {
    parameters: { circOn: 1, circX: .5, circY: .4, circW: .3, circH: .2, circSoft: .1, circInvert: 1, gradOn: 1, gradY: .3, qualOn: 1, qualHue: 25, qualHueWidth: 30, qualHueSoft: 10, qualSatLow: 20, qualSatHigh: 80, qualLumLow: 10, qualLumHigh: 90, qualSatSoft: 5,
      mixRR: .4, mixRG: .5, mixRB: .1, mixMono: 1, filmGrain: 20, filmHalation: 15, filmBloom: 8, filmVignette: 10, filmGrainSize: 1.3, logShadowB: .01, pivot: .336 },
    curves: { ...look.curves, HueSat: flat('hs', [.5, .5, .3, .5, .5]), LumSat: flat('ls', [.5, .6, .5]) },
  }));
  await edit(run => run('setKeyframes', a.id, `nodes.${look.id}.parameters.circX`, [{ id: 'k1', time: 0, value: .3, interpolation: 'linear' }, { id: 'k2', time: a.duration, value: .7, interpolation: 'linear' }]));
  const { text } = await run('color-grade', { clip: a.id, at: a.start + a.duration / 2 });
  const line = text.split('\n').find(l => l.includes('"Look"'))!;
  assert.match(line, / logShadowB=0\.01 /);
  assert.match(line, / qualSatSoft=5 /, 'the rarely used softness stays a plain value');
  assert.match(line, / filmGrainSize=1\.3 /);
  assert.ok(!/pivot=/.test(line), 'a stored .336 is the default pivot');
  assert.match(line, / curves RGB3 hsl HueSat5,LumSat3 /);
  assert.match(line, / circ\(\.5~,\.4 r\.3x\.2 soft \.1 inv\) /, 'a keyframed field is marked ~');
  assert.match(line, / grad\(\.5,\.3 angle 0 soft \.3\) /);
  assert.match(line, / qual\(hue 25 w30 soft 10, sat 20-80, lum 10-90\) /);
  assert.match(line, / mix\(R \.4\/\.5\/\.1 mono\) /);
  assert.match(line, / film\(hal 15 bloom 8 grain 20 vig 10, unmasked\)$/);
  assert.ok(!/circX=|gradOn=|qualOn=|qualHue=|mixRR=|mixMono=|filmGrain=|filmHalation=/.test(line), `summarized keys are not repeated: ${line}`);
  assert.match(text, /render check: ok/);
  // A node without pivot contrasts around .5, not the .336 a nodes-v2 grade expects.
  await edit(async run => { await run('selectClip', b.id); await run('selectNode', null); await run('addNode', 'Punch', { contrast: 1.2 }); });
  assert.match((await run('color-grade', { clip: b.id })).text, /"Punch" contrast=1\.2 pivot=\.5\(unset\)/);
  await edit(run => run('updateNode', look.id, { parameters: { circOn: 0 } }));
  assert.match((await run('color-grade', { clip: a.id })).text.split('\n').find(l => l.includes('"Look"'))!, / circ\(off\) grad\(/);
});

/** A 512×288 frame: cool left half, neutral right half, a skin patch, and (frame only) 24 px letterbox bars. */
async function scene(cool: number[], plain: number[], skin: number[], bars: number, type: 'jpeg' | 'png') {
  const canvas = createCanvas(512, 288), g = canvas.getContext('2d'), paint = (rgb: number[], x: number, y: number, w: number, h: number) => { g.fillStyle = `rgb(${rgb.join(',')})`; g.fillRect(x, y, w, h); };
  paint([0, 0, 0], 0, 0, 512, 288); paint(cool, 0, bars, 256, 288 - 2 * bars); paint(plain, 256, bars, 256, 288 - 2 * bars); paint(skin, 205, 86, 77, 86);
  return Buffer.from(type === 'png' ? await canvas.encode('png') : await canvas.encode('jpeg', 95));
}

test('color-measure renders the graded frame, measures it against a reference picture and says what to change', async () => {
  frameJpeg = await scene([70, 80, 110], [130, 130, 130], [190, 140, 120], 24, 'jpeg');
  const file = join(dir, 'ref.png');
  await writeFile(file, await scene([105, 100, 95], [165, 158, 145], [215, 160, 125], 0, 'png'));
  frames.length = 0;
  const step = await run('color-measure', { clip: a.id, ref: file, regions: [{ name: 'face', x: .4, y: .3, w: .15, h: .3 }], images: true });
  // The frame under the playhead when it is over the clip, else the clip's middle.
  const fps = server.projects.find(p => p.id === projectId)!.fps, last = a.start + a.duration - 1 / fps, playhead = s().playhead;
  const t = Math.floor((playhead >= a.start && playhead <= last ? playhead : a.start + a.duration / 2) * fps + 1e-6) / fps;
  assert.deepEqual(frames, [{ projectId, timelineId: a.timelineId, t: String(t), w: '512' }], 'one graded frame of the clip\'s timeline');
  const lines = step.text.split('\n');
  assert.match(lines[0], new RegExp(`^${short(a.id)} "[^"]+" \\d\\d:\\d\\d:\\d\\d:\\d\\d \\([\\d.]+s\\) graded frame 512×288 bars trimmed \\(picture 0,\\.083 1x\\.833\\) · ref "ref\\.png" 512×288$`));
  assert.match(step.text, /\nluma p1\/5\/25\/50\/75\/95\/99: [\d ]+ \| ref [\d ]+\n/);
  assert.match(step.text, /\ncrushed black\/clipped white: 0\.0% 0\.0% \| ref 0\.0% 0\.0%\n/, 'the bars are not counted as crushed blacks');
  assert.match(step.text, /\nmids: \d+% rgb \d+\/\d+\/\d+ warm -\d\.\d mag \+\d\.\d sat \d+ \| ref \d+% rgb/);
  assert.match(step.text, /\nregion face \(\.4,\.3 \.15x\.3\): luma \d+ rgb \d+\/\d+\/\d+ warm \+\d+\.\d mag [-+]\d\.\d sat \d+ hue \d+° (red|orange) \| ref luma \d+ .*hue \d+° (red|orange) → luma \+\d+\.\d/);
  // The amounts come from the clip's own grade (nodes-v2, S-Log3 through ACES 2) on the CPU reference. A brighter ref: the
  // exposure hint comes alone (contrast, casts and saturation are judged again once the brightness matches).
  assert.match(step.text, /\nto match the ref \(\+\/− add to the current value, × multiplies it; amounts from this grade, damped; apply top-down to the first exposure or Balance hint, then measure again\):\n- darker than ref \(median 51 vs 62\): exposure \+\.\d\d stops \(Balance\), or gamma \(Midtones\) up; then measure again \(contrast, colour and saturation follow the brightness\)$/);
  assert.equal(step.content?.length, 1, 'frame and ref side by side in one picture');
  const shown = await loadImage(Buffer.from((step.content![0] as { data: string }).data, 'base64'));
  assert.deepEqual([shown.width, shown.height], [772, 216]);

  // As bright, but flatter, warmer and with less colour: contrast and saturation, then one Balance move (divided by both, as they
  // go in the same round), then measure again; the hue mix waits for the casts.
  await writeFile(file, await scene([82, 84, 92], [137, 130, 118], [200, 145, 115], 0, 'png'));
  const match = (await run('color-measure', { clip: a.id, ref: file })).text, todo = match.split('\n').filter(l => l.startsWith('- '));
  const at = (re: RegExp) => todo.findIndex(l => re.test(l));
  assert.deepEqual([/^- more contrast than ref \(p95−p5 27 vs 18\): contrast ×0\.\d\d/, /^- more saturated than ref \(colour spread 8 vs 6, mean 8 vs 6, p90 14 vs 6\): saturation ×0\.\d\d/,
    /^- overall cooler than ref \(warm -2\.9 vs \+1\.6, mag \+2\.3 vs \+0\.3 after the saturation change\): temperature \+\d+, tint -\d+ \(Balance\), or it needs .* via offsetR\/G\/B \(Offset wheel\); then measure again$/,
    /^- ref has more orange .*: once the casts match, /].map(at).map((i, n, all) => i >= 0 && (n === 0 || i > all[n - 1])), [true, true, true, true], match);
  assert.ok(todo.filter(l => /^- (after that, )?(shadows|mids|highlights) /.test(l)).length <= 1, 'one zone a round');

  // Without a reference: the numbers only, at the asked time.
  frames.length = 0;
  const alone = await run('color-measure', { clip: a.id, at: a.start });
  assert.equal(frames[0].t, String(Math.floor(a.start * fps + 1e-6) / fps));
  assert.ok(!alone.text.includes('| ref') && !alone.text.includes('to match') && !alone.content, alone.text);
});

test('color-measure takes a media item or another clip as the reference, and says why a frame cannot be measured', async () => {
  mediaJpeg = await scene([105, 100, 95], [165, 158, 145], [215, 160, 125], 0, 'jpeg');
  const asset = server.media.find(m => m.projectId === projectId && m.kind === 'video')!;
  frames.length = 0;
  const media = await run('color-measure', { clip: a.id, ref: asset.id });
  assert.equal(frames[1].mediaId, asset.id);
  assert.match(media.text.split('\n')[0], new RegExp(`· ref ${short(asset.id)} "[^"]+" @[\\d.]+s ungraded 512×288$`));
  assert.match(media.text, /\n- darker than ref/);
  frames.length = 0;
  const other = await run('color-measure', { clip: a.id, ref: b.id });
  assert.deepEqual(frames.map(f => f.timelineId), [a.timelineId, b.timelineId]);
  assert.match(other.text.split('\n')[0], new RegExp(`· ref ${short(b.id)} "[^"]+" @[\\d.]+s graded 512×288 bars trimmed`));
  assert.match(other.text, /matches the ref within the hint thresholds\./, 'the same picture needs nothing');

  await assert.rejects(run('color-measure', { clip: a.id, ref: 'ref.png' }), /absolute path to an image file, or a media or clip @id/);
  await assert.rejects(run('color-measure', { clip: a.id, ref: join(dir, 'missing.png') }), /No file at/);
  const text = join(dir, 'notes.txt'); await writeFile(text, 'not a picture');
  await assert.rejects(run('color-measure', { clip: a.id, ref: text }), /"notes\.txt" is not a picture|notes\.txt is not a picture/);
  await assert.rejects(run('color-measure', { clip: a.id, regions: [{ x: .9, y: 0, w: .2, h: .5 }] }), /params\.regions: up to 8 boxes/);
  refuse = { live: 'denoise', error: 'Noise Reduction bakes whole clips; this frame shows live in the editor.' };
  await assert.rejects(run('color-measure', { clip: a.id }), /cannot render the graded frame at [\d.]+s on its own \(Noise Reduction bakes whole clips.*\); bypass Noise Reduction while grading, measure, then turn it back on\./);
  // A ref clip is rendered at its middle, which `at` (the measured frame) cannot move.
  refuse = { live: 'cut', error: 'A transition blends two clips here.' }; frames.length = 0; refuseFrom = 1;
  await assert.rejects(run('color-measure', { clip: a.id, ref: b.id }), new RegExp(`cannot render the ref ${short(b.id)} at its middle \\([\\d.]+s\\) on its own \\(A transition blends two clips here\\.\\); use another shot as ref\\.$`));
  refuse = null; refuseFrom = 0;
  // A clip on a hidden track: the frame shows what is drawn instead, and says so.
  await edit(run => run('updateTrack', a.trackId, { hidden: true }));
  assert.match((await run('color-measure', { clip: a.id })).text, /\nnote: its track is hidden: this is what shows instead \(show the track to measure the clip\)\n/);
  await edit(run => run('updateTrack', a.trackId, { hidden: false }));
  assert.ok(!(await run('color-measure', { clip: a.id })).text.includes('hidden'));
});

test('the grade model answers exactly where the grade is linear, and stays finite through a log grade', () => {
  // A legacy clip without nodes: changes multiply the display signal, so every answer has a closed form.
  const plain = { ...legacy, id: 'no-nodes', keyframes: {}, properties: {} } as typeof legacy, model = gradeModel(plain, plain.start)!;
  const near = (actual: number, expected: number, tolerance = 1e-3) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
  near(model.exposure(25, 50), 1);
  const [temperature, tint] = model.balance(50, 2, 1);
  near(temperature, 400, .05); near(tint, 4, .01);
  // Temperature scales R and B by 1 ± t/10000, tint G by 1 − t/200: a grey moves in step with its level.
  model.balanced(50, 400, 4).forEach((v, i) => near(v, [2, -1, -2][i], 1e-3));
  model.balanced(20, 400, 4).forEach((v, i) => near(v, [.8, -.4, -.8][i], 1e-3));
  near(model.saturation(50, 1.5), 150, .01);
  model.channels(['liftR', 'liftG', 'liftB'], 50, [1, 0, -1]).forEach((v, i) => near(v, [.02, 0, -.02][i], 1e-5));
  near(model.contrast(25, 75, 75), 1.5, 1e-3);
  // nodes-v2 S-Log3 with ACES 2 (stood in for by the shoulder curve): monotone, finite answers.
  const log = gradeModel(s().clips.find(c => c.id === b.id)!, b.start + b.duration / 2)!;
  const up = log.exposure(30, 45), down = log.exposure(45, 30);
  assert.ok(up > .1 && up < 3 && down < -.1, `exposure ${up} ${down}`);
  assert.ok(log.balance(40, 2, 0).every(Number.isFinite) && log.balance(40, 2, 0)[0] > 0, 'warmer needs a higher temperature');
  assert.ok(log.channels(['gainR', 'gainG', 'gainB'], 60, [1, 0, -1]).every(Number.isFinite));
});

test('followed literally round by round, the hints match a white balance or an exposure change on Balance (CPU reference)', () => {
  // b's grade as initializeColorGrade makes it (nodes-v2, S-Log3, ACES 2 with the shoulder standing in, as in the model; the
  // tests above left a Punch node after its Output CST) on a daylight scene: sky, skin, foliage, a grey road ramp and a grey card.
  // The ref is the same grade with one Balance change; the frame starts without it.
  const clip = s().clips.find(c => c.id === b.id)!, kept = s().nodes;
  const own = kept.filter(n => n.clipId === b.id && ['Input CST', 'Balance', 'Look', 'Output CST'].includes(n.name)).map(n => n.effects?.length ? n : { ...n, parameters: { pivot: .336043 }, curves: undefined });
  const balance = own.find(n => n.name === 'Balance')!, look = own.find(n => n.name === 'Look')!, W = 96, H = 54, M = gamutMatrix('Rec.709', 'S-Gamut3.Cine');
  const scene = (x: number, y: number) => {
    const u = x / (W - 1), lin = x > W * .8 && y > H * .8 ? [.18, .18, .18] : [[.45, .6, .95].map(v => v * (.8 + .4 * u)), [.42, .28, .2].map(v => v * (.6 + .8 * u)), [.025, .05, .015].map(v => v * (.5 + 1.5 * u)), [1, 1, 1].map(v => v * (.01 + .5 * u))][Math.floor(y / (H / 4))];
    return M.map(row => encodeLog(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2], 'S-Log3'));
  };
  const graded = (patch: Record<string, Record<string, number>>) => own.map(n => ({ ...n, parameters: { ...n.parameters, ...patch[n.id] }, effects: n.effects?.map(e => e.type === 'cst' && e.toneMapping === 'aces2' ? { ...e, toneMapping: 'shoulder' as const, gamutMapping: 'compress' as const } : e) }));
  const render = (patch: Record<string, Record<string, number>>) => {
    const tf = colorTransform(clip, undefined, graded(patch), undefined, () => 0), data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([...tf(scene(x, y)).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)), 255], (y * W + x) * 4);
    return { width: W, height: H, data };
  };
  const card = { x: .82, y: .82, w: .18, h: .18 }, skin = { x: 0, y: .25, w: .78, h: .25 };
  // The help's rule: top-down, every hint with an amount, and stop after an exposure or Balance hint.
  const follow = (todo: string[], patch: Record<string, Record<string, number>>) => {
    const add = (id: string, key: string, v: number) => { patch[id] = { ...patch[id], [key]: (patch[id]?.[key] ?? own.find(n => n.id === id)!.parameters[key] ?? 0) + v }; };
    const times = (key: string, v: number, initial: number) => { patch[look.id] = { ...patch[look.id], [key]: (patch[look.id]?.[key] ?? look.parameters[key] ?? initial) * v }; };
    for (const h of todo) {
      const n = (re: RegExp) => Number(re.exec(h)?.[1] ?? 0), wheel = / via (lift|gamma|gain)R ([-+]?\.\d+|0) \1G ([-+]?\.\d+|0) \1B ([-+]?\.\d+|0)/.exec(h);
      if (/ stops /.test(h)) return add(balance.id, 'exposure', n(/exposure ([-+.\d]+) stops/));
      if (/contrast ×/.test(h)) times('contrast', n(/contrast ×([.\d]+)/), 1);
      if (/saturation ×/.test(h)) times('saturation', n(/saturation ×([.\d]+)/), 100);
      if (h.startsWith('overall ')) { add(balance.id, 'temperature', n(/temperature ([-+]\d+)/)); return add(balance.id, 'tint', n(/tint ([-+]\d+) \(/)); }
      if (wheel) ['R', 'G', 'B'].forEach((c, i) => add(balance.id, wheel[1] + c, Number(wheel[i + 2])));
    }
  };
  try {
    for (const [change, first] of [[{ temperature: (balance.parameters.temperature ?? 0) + 1500 }, /^overall cooler than ref .*: temperature \+1[12]\d0(, tint [-+]\d)? \(Balance\)/], [{ exposure: (balance.parameters.exposure ?? 0) + 1 }, /^darker than ref .*: exposure \+\.[89]\d stops \(Balance\)/]] as const) {
      const ref = render({ [balance.id]: change }), r = measure(ref), patch: Record<string, Record<string, number>> = {}, rounds: string[][] = [];
      for (let round = 0; round < 5; round++) {
        store.setState({ nodes: [...kept.filter(n => n.clipId !== b.id), ...graded(patch)] });
        const todo = hints(measure(render(patch)), r, { linear: true, model: gradeModel(clip, b.start + b.duration / 2) });
        rounds.push(todo);
        if (!todo.length) break;
        follow(todo, patch);
      }
      const trail = rounds.map((todo, i) => `round ${i}:\n${todo.join('\n')}`).join('\n');
      // The one control that made the difference comes first, before any wheel; at most one zone gets a wheel hint.
      const lead = rounds[0].findIndex(h => /^(overall|darker|brighter) /.test(h)), zone = rounds[0].findIndex(h => / than ref:/.test(h));
      assert.match(rounds[0][lead] ?? '', first, trail);
      assert.ok((zone < 0 || zone > lead) && rounds[0].filter(h => / than ref:/.test(h)).length <= 1, trail);
      assert.ok(rounds.length <= 3 && !rounds.at(-1)!.length, `matched within two rounds:\n${trail}`);
      const final = render(patch);
      assert.equal(regionHint(measure(final, card), measure(ref, card)), '', 'the grey card matches');
      assert.equal(regionHint(measure(final, skin), measure(ref, skin)), '', 'skin matches');
    }
  } finally { store.setState({ nodes: kept }); }
});

test('the help topic is the parameter registry, the look library and the grading recipes', () => {
  const text = topics.color, lines = text.split('\n');
  assert.match(text, /^Color grading/);
  for (const q of GRADE_PARAMS) assert.ok(lines.some(line => line.split(' ').slice(0, 9).includes(q.key)), `${q.key} has a parameter line`);
  assert.ok(lines.includes('exposure 0 (-6..6 stops; render -16..16) Exposure in stops (linear light on nodes-v2).'));
  assert.ok(lines.includes('saturation 100 (0..200%; render 0..400) 100 = unchanged.'));
  assert.ok(lines.includes('liftR liftG liftB 0 (-1..1; render -2..2) Shadows wheel, R/G/B channel (added to the master).'));
  assert.ok(lines.includes('## Wheels: Shadows/Midtones/Highlights/Offset = DaVinci Lift/Gamma/Gain/Offset, stored as lift/gamma/gain/offset'));
  assert.ok(lines.some(line => line.startsWith('qualOn 0|1 ')));
  for (const look of COLOR_LOOKS) assert.ok(lines.some(line => line.startsWith(`- ${look.id}: `) || line.startsWith(`- ${look.id} (`)), look.id);
  for (const topic of ['Log wheels:', 'HSL curves', 'Qualifier (qualOn 1)', 'Windows (', 'Film:', 'color-measure{', 'Looks: act applyColorLook', '- match a reference picture: 1) job color-measure', '- sky:', '- skin:', '- black and white:']) assert.ok(text.includes(topic), topic);
  assert.match(text, /gammas: Rec\.709, S-Log3, .*Gamma 2\.4/);
  assert.ok(!text.includes('hue≠0'), 'hue renders now');
  // Hints go a round at a time (exposure or white balance first, measure again), and the wheels say what they do on each pipeline.
  assert.ok(text.includes('Apply them top-down; after an exposure or Balance (temperature/tint) hint, measure again before the rest'));
  assert.ok(text.includes('apply the hints top-down (Balance takes exposure, temperature, tint and the wheel amounts; Look contrast and saturation) and stop after an exposure or Balance hint'));
  assert.ok(!text.includes('all of them work applied together'));
  assert.ok(text.includes('Legacy (display signal): lift moves the blacks most and white not at all') && text.includes('lift moves whites about as much as blacks (close to Offset)') && text.includes('To colour one tonal band on nodes-v2, use the log wheels.'));
  // help{topic:"color", filter} keeps whole lines: the windows prose and every circle key.
  const circle = help('color', 'circ');
  assert.match(circle, /^Color grading/);
  assert.match(circle, /\nWindows \(circOn\/rectOn\/gradOn 1/);
  assert.match(circle, /\ncircX \.5 \(-1\.\.2\) Centre/);
  for (const line of Object.values(jobs).map(j => j.doc)) assert.ok(!line.includes('\n') && line.length < 200, line);
});
