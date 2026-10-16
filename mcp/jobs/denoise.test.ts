// The denoise job against a fake SharedCut server: the store holds the demo workspace, PATCH saves are applied to a server
// copy, and /api/denoise/capabilities answers like server/index.ts.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';
import { effectDefinitions } from '../../src/services/effects.ts';

process.env.FRAME_LINE_URL = 'http://fake.local';
process.env.FRAME_LINE_COOKIE = 'frameline_session=test';
let saved: any = structuredClone(persistentState(store.getState()));
let revision = 1, caps: any = { available: true, engine: 'denoise', device: 'cuda' }, posted: any, all: any = { status: 'running', clips: { c2: { done: 1, total: 3 } } };
const requests: string[] = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push(`${method} ${url.pathname}`);
  if (url.pathname === '/api/auth/me') return json({ user: saved.users.find((u: any) => u.id === saved.currentUserId) });
  if (url.pathname === '/api/state' && method === 'GET') return json(url.searchParams.has('since') ? { revision } : { revision, state: saved });
  if (url.pathname === '/api/state' && method === 'PATCH') { saved = applyStateDelta(saved, body.delta); return json({ revision: ++revision }); }
  if (url.pathname === '/api/denoise/capabilities') return json(caps);
  if (url.pathname === '/api/denoise/all') { if (method === 'POST') posted = body; else if (method === 'DELETE') all.status = 'stopped'; return json(all); }
  return json({});
}) as typeof fetch;

const { ready } = await import('../edit.ts');
const { jobs, topics } = await import('./denoise.ts');
await ready();
store.getState().openProject('city-after-dark');
const run = async (params: Record<string, unknown>) => (await jobs.denoise.start(params) as { text: string }).text;
const fx = (id: string) => saved.clips.find((c: any) => c.id === id).effects.find((e: any) => e.name === 'Noise Reduction');
const patches = () => requests.filter(r => r.startsWith('PATCH')).length;

test('denoise adds Noise Reduction like the UI, saves it and names the engine', async () => {
  const text = await run({ clip: 'c2', amount: 70, frames: 1.4, detail: 10 });
  assert.deepEqual([fx('c2').amount, fx('c2').parameters], [70, { frames: 1, detail: 10 }]);
  assert.match(text, /@c2 Noise Reduction \(amount 70 chroma 60 frames 1 spatial 50 detail 10\) · engine cuda$/);
  const before = patches();
  assert.match(await run({ clip: 'c2' }), /^@c2 Noise Reduction \(amount 70/);
  assert.equal(patches(), before, 'nothing to change, no save');
  await run({ clip: 'c2', off: true });
  assert.equal(fx('c2').enabled, false);
  await run({ clip: 'c2', chroma: 80 });
  assert.deepEqual([fx('c2').enabled, fx('c2').parameters.chroma], [true, 80], 'a setting switches it back on');
});

test('audio clips and a missing worker are refused; nothing is added without the worker', async () => {
  await assert.rejects(run({ clip: 'c11' }), /video clips only/);
  caps = { available: false, reason: 'Noise Reduction needs the denoise worker on this server. Run npm run setup:denoise.' };
  await assert.rejects(run({ clip: 'c4' }), /setup:denoise/);
  assert.equal(fx('c4'), undefined);
  caps = { available: true, device: 'cpu' };
});

test('the doc is one line and help covers every setting', () => {
  assert.ok(!jobs.denoise.doc.includes('\n') && jobs.denoise.doc.length <= 240);
  for (const p of effectDefinitions['Noise Reduction'].parameters) assert.ok(topics.denoise.includes(p.key) && jobs.denoise.doc.includes(p.key), p.key);
});

test('denoise-all sets every video clip of the timeline, saves first, starts the server run and follows it', async () => {
  const poller = await jobs['denoise-all'].start({ amount: 40, frames: 1.2 }) as any;
  const s = store.getState(), video = s.clips.filter(c => c.timelineId === s.timelineId && s.tracks.find(t => t.id === c.trackId)?.kind === 'video' && s.media.find(m => m.id === c.mediaId)?.kind === 'video');
  assert.ok(video.length > 1);
  for (const c of video) assert.deepEqual([fx(c.id).enabled, fx(c.id).amount, fx(c.id).parameters.frames], [true, 40, 1], c.id);
  assert.ok(requests.lastIndexOf('POST /api/denoise/all') > requests.lastIndexOf('PATCH /api/state'), 'saved before the server reads it');
  assert.deepEqual(posted, { projectId: 'city-after-dark', timelineId: s.timelineId, quality: 'Stream' });
  assert.match((await poller.poll()).text, /running · 0\/1 clips, 1\/3 chunks$/);
  all = { status: 'done', clips: { c2: { done: 3, total: 3 }, c4: { done: 0, total: 2, error: 'boom' } } };
  const last = await poller.poll();
  assert.equal(last.done, true); assert.match(last.text, /done · 1\/2 clips, 3\/5 chunks · failed: @c4 boom$/);
  assert.match((await jobs['denoise-all'].start({ stop: true }) as { text: string }).text, /^Denoise all stopped: stopped/);
});
