// The motion jobs against a fake SharedCut server: the store holds the demo workspace, PATCH saves are applied to a
// server copy, and the Stabilize endpoints answer like server/index.ts (409 when the saved settings differ). This walks
// the happy path the worker-less Mac cannot run live: add Stabilize -> save -> queue full -> analyzing -> ready.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';
import { effectDefinitions } from '../../src/services/effects.ts';
import { stabilizeEffect, stabilizeSettings } from '../../src/services/stabilize.ts';
import { timingPaths } from '../../src/services/opticalFlow.ts';

process.env.FRAME_LINE_URL = 'http://fake.local';
process.env.FRAME_LINE_COOKIE = 'frameline_session=test';
let saved: any = structuredClone(persistentState(store.getState()));
let revision = 1, stabilizeAnswers: any[] = [], stabilizeCaps: any = { available: true };
const requests: string[] = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push(`${method} ${url.pathname}${url.search}`);
  if (url.pathname === '/api/auth/me') return json({ user: saved.users.find((u: any) => u.id === saved.currentUserId) });
  if (url.pathname === '/api/state' && method === 'GET') return json(url.searchParams.has('since') ? { revision } : { revision, state: saved });
  if (url.pathname === '/api/state' && method === 'PATCH') { saved = applyStateDelta(saved, body.delta); return json({ revision: ++revision }); }
  if (url.pathname === '/api/stabilize/capabilities') return json(stabilizeCaps);
  if (url.pathname === '/api/optical-flow/capabilities') return json({ available: true, engine: 'Test flow' });
  if (url.pathname === '/api/stabilize' && method === 'POST') {
    const clip = saved.clips.find((c: any) => c.id === body.clipId), fx = clip && stabilizeEffect(clip);
    if (!fx) return json({ error: 'Add Stabilize to a video clip first.' }, 400);
    if (JSON.stringify(stabilizeSettings(clip, fx)) !== JSON.stringify(body.settings)) return json({ error: 'The Stabilize settings are still saving. Retry shortly.' }, 409);
    const [status, answer] = stabilizeAnswers.shift();
    return json(answer, status);
  }
  return json({});
}) as typeof fetch;

const { ready } = await import('../edit.ts');
const { jobs, topics } = await import('./motion.ts');
const { isPoller } = await import('./kit.ts');
await ready();
store.getState().openProject('city-after-dark');

async function run(kind: string, params: Record<string, unknown>) {
  const started = await jobs[kind].start(params);
  if (!isPoller(started)) return { text: started.text };
  for (let i = 0; i < 10; i++) { const step = await started.poll(); if (step.done) return { text: step.text, poller: started }; }
  throw new Error('never finished');
}
const fx = (id: string) => store.getState().clips.find(c => c.id === id)!.effects.find(e => e.name === 'Stabilize');

test('stabilize adds the effect like the UI, saves, waits out the queue and reports the zoom', async () => {
  const key = 'a'.repeat(64);
  stabilizeAnswers = [[429, { error: 'The Stabilize queue is full. Retry shortly.' }], [200, { status: 'preparing', key, progress: 40 }], [200, { status: 'ready', key, progress: 100, zoom: 1.083, zoomMin: 1.041, solve: { matrices: [[1, 0, 0, 0, 1, 0]] } }]];
  const { text, poller } = await run('stabilize', { clip: 'c2', crop: 3, lock: true });
  assert.equal(fx('c2')?.amount, 50, 'added at the UI starting strength');
  assert.deepEqual(fx('c2')?.parameters, { crop: 3, lock: 1 });
  assert.equal(saved.clips.find((c: any) => c.id === 'c2').effects[0].parameters.crop, 3, 'saved before the analysis was asked for');
  assert.match(text, /@c2 stabilized \(amount 50 crop 3 smoothness 50 lock 1\) · zoom 4\.1–8\.3%/);
  assert.doesNotMatch(text, /matrices/);
  await poller!.cancel!();
  assert.ok(requests.includes(`DELETE /api/stabilize/${key}?projectId=city-after-dark`));
});

test('called again with nothing to change it only checks status, without a save', async () => {
  const patches = requests.filter(r => r.startsWith('PATCH')).length;
  stabilizeAnswers = [[200, { status: 'ready', key: 'b'.repeat(64), progress: 100, zoom: 1.05, zoomMin: 1.05 }]];
  assert.match((await run('stabilize', { clip: 'c2' })).text, /^@c2 stabilized .* zoom 5\.0%$/);
  assert.equal(requests.filter(r => r.startsWith('PATCH')).length, patches);
});

test('a failed analysis and a missing worker come back as errors; nothing is added without the worker', async () => {
  stabilizeAnswers = [[200, { status: 'failed', key: 'c'.repeat(64), progress: 0, error: 'Decode failed.' }]];
  await assert.rejects(run('stabilize', { clip: 'c2' }), /Stabilize failed on @c2: Decode failed\./);
  stabilizeCaps = { available: false, reason: 'The Stabilize worker is not installed on this server. Run npm run setup:stabilize.' };
  await assert.rejects(run('stabilize', { clip: 'c4' }), /not installed/);
  assert.equal(fx('c4'), undefined);
  stabilizeCaps = { available: true };
});

test('optical flow switches on after the server check, and refuses what export cannot combine', async () => {
  await assert.rejects(run('flow', { clip: 'c2' }), /Stabilize is on for @c2/);
  const on = await run('flow', { clip: 'c4' });
  assert.equal(store.getState().clips.find(c => c.id === 'c4')!.properties.opticalFlow, true);
  assert.match(on.text, /flow engine: Test flow/);
  const patches = requests.filter(r => r.startsWith('PATCH')).length;
  assert.match((await run('flow', { clip: 'c4' })).text, /already on/);
  assert.equal(requests.filter(r => r.startsWith('PATCH')).length, patches, 'no undo step for the same value');
  await assert.rejects(run('stabilize', { clip: 'c4' }), /Optical flow is on for @c4/);
  await run('flow', { clip: 'c4', off: true });
  assert.equal(saved.clips.find((c: any) => c.id === 'c4').properties.opticalFlow, false);
});

test('docs are one line and the motion topic follows the app definitions', () => {
  for (const [kind, job] of Object.entries(jobs)) assert.ok(!job.doc.includes('\n') && job.doc.length < 160, `${kind} doc`);
  for (const p of effectDefinitions.Stabilize.parameters) assert.ok(topics.motion.includes(p.key) && jobs.stabilize.doc.includes(p.key), p.key);
  for (const path of [...timingPaths, 'motionBlurStrength', 'motionBlurSamples']) assert.ok(topics.motion.includes(path), path);
});
