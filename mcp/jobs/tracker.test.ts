// The tracker jobs against a fake SharedCut server holding the demo workspace: PATCH saves land on a server copy, and
// the tracker routes answer like server/index.ts (409 while the tracker is unsaved). Walks place -> track (queued,
// running, done) -> result installed and saved -> attach through the editor's own client. Run: node --test mcp/jobs/tracker.test.ts
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';

process.env.FRAME_LINE_URL = 'http://fake.local';
process.env.FRAME_LINE_COOKIE = 'frameline_session=test';
let saved: any = structuredClone(persistentState(store.getState()));
let revision = 1, caps: any = { available: false, reason: 'The motion tracker is not installed on this server. Run npm run setup:tracker.' }, views: any[] = [];
const KEY = 'a'.repeat(64), times = Array.from({ length: 94 * 24 }, (_, i) => i / 24), requests: string[] = [];
const row = (id: string, frame: number) => [id, frame, times[frame], .5 + frame / 1000, .4, .9, 1, 0, 0];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined, path = url.pathname;
  requests.push(`${method} ${path}`);
  if (path === '/api/auth/me') return json({ user: saved.users.find((u: any) => u.id === saved.currentUserId) });
  if (path === '/api/state' && method === 'GET') return json(url.searchParams.has('since') ? { revision } : { revision, state: saved });
  if (path === '/api/state' && method === 'PATCH') { saved = applyStateDelta(saved, body.delta); return json({ revision: ++revision }); }
  if (path === '/api/motion-trackers/capabilities') return json(caps);
  if (path === '/api/motion-trackers/source-times') return json({ sourceTimes: times });
  if (path === '/api/motion-trackers/track') {
    const tracker = saved.clips.find((c: any) => c.id === body.clipId)?.motionTrackers?.find((t: any) => t.id === body.trackerIds[0]);
    if (!tracker) return json({ error: 'This tracker is still saving. Try again in a moment.' }, 409);
    return json({ id: '11111111-1111-1111-1111-111111111111', status: 'queued', progress: 0, rows: [], next: 0, bases: { [tracker.id]: tracker.result?.key ?? null }, stops: {}, warnings: [] }, 202);
  }
  if (path.startsWith('/api/motion-trackers/jobs/')) { const view = views.shift(); return view ? json(view) : json({ error: 'Tracking job not found.' }, 404); }
  if (path === `/api/motion-trackers/samples/${KEY}`) {
    const frames = [73, 74, 75];
    return json({ version: 1, mediaId: 'm1', frames, times: frames.map(f => times[f]), x: frames.map(f => .5 + f / 1000), y: frames.map(() => .4), confidence: frames.map(() => .9), scale: frames.map(() => 1), rotation: frames.map(() => 0), flags: frames.map(() => 0) });
  }
  return json({ error: `unexpected ${method} ${path}` }, 500);
}) as typeof fetch;

const { ready } = await import('../edit.ts');
const { jobs } = await import('./tracker.ts');
const { isPoller } = await import('./kit.ts');
await ready();
store.getState().openProject('city-after-dark');

async function run(kind: string, params: Record<string, unknown>) {
  const started = await jobs[kind].start(params);
  if (!isPoller(started)) return started.text;
  for (let i = 0; i < 10; i++) { const step = await started.poll(); if (step.done) return step.text; }
  throw new Error('never finished');
}
const tracker = () => saved.clips.find((c: any) => c.id === 'c2').motionTrackers?.[0];

test('a point lands on the exact source frame shown at t, saved before tracking', async () => {
  assert.equal(saved.clips.find((c: any) => c.id === 'c2').mediaId, 'm1');
  assert.match(await run('track-point', { clip: 'c2', t: 3, x: .57, y: .4, box: { w: .05, h: .08 } }), /^\+ tracker @[0-9a-f]{8} "Track 1" point at t 3s \(frame 72\) · 1 placed/);
  assert.deepEqual(tracker().keys, [{ time: times[72], x: .57, y: .4 }]);
  assert.deepEqual(tracker().feature, { width: .05, height: .08 });
  await assert.rejects(run('track-point', { clip: 'c2', t: 3, x: 640, y: .4 }), /0–1 of the source picture/);
});

test('tracking refuses without the worker, then polls the run and installs its result like the editor', async () => {
  await assert.rejects(run('track', { clip: 'c2' }), /not installed/);
  assert.ok(!requests.includes('POST /api/motion-trackers/track'));
  caps = { available: true };
  const id = tracker().id;
  views = [
    { id: 'j', status: 'running', progress: 60, rows: [row(id, 73), row(id, 74)], next: 2, bases: { [id]: null }, stops: {}, warnings: [] },
    { id: 'j', status: 'done', progress: 100, rows: [row(id, 75)], next: 3, results: { [id]: KEY }, bases: { [id]: null }, stops: { [id]: { frame: 75, time: times[75], reason: 'key' } }, warnings: [{ tracker: id, message: 'Low contrast.' }] },
  ];
  const text = await run('track', { clip: 'c2', t: 3 });
  assert.match(text, /^tracked · forward from 3s · @[0-9a-f]{8} \+3f, reached a placed point at 3\.125s/);
  assert.match(text, /warning: Low contrast\./);
  assert.match(text, /"Track 1" position · 3 tracked · 1 placed · 3–3\.125s/);
  assert.deepEqual(tracker().result, { key: KEY }, 'the result is saved on the server copy');
});

test('attach writes the layer keyframes through the editor client; a forgotten job errors', async () => {
  const id = tracker().id;
  assert.match(await run('track-attach', { clip: 'c2', tracker: id, target: 'c1', t: 3 }), /^@c1 "CITY AFTER DARK" follows @[0-9a-f]{8} · 3–3\.\d+s · keys x \d+ y \d+/);
  const c1 = saved.clips.find((c: any) => c.id === 'c1');
  assert.ok(c1.keyframes['properties.x'].some((k: any) => k.id.startsWith(`mt.${id}.`)));
  assert.equal(tracker().links[0].clipId, 'c1');
  await assert.rejects(run('track-attach', { clip: 'c2', tracker: id, target: 'c3' }), /cannot follow/, 'c3 is not on screen with c2');
  assert.match(await run('track-attach', { clip: 'c2', tracker: id, target: 'c1', unlink: true }), /no longer follows/);
  assert.equal(tracker().links, undefined, 'the last link goes, as the Inspector\'s Unlink leaves it');
  assert.ok(c1.keyframes['properties.x'].some((k: any) => k.id.startsWith(`mt.${id}.`)), 'its keyframes stay');
  views = [];
  await assert.rejects(run('track', { clip: 'c2', t: 3 }), /Tracking job not found/);
});

test('a run left running blocks another on that tracker; a failed run still installs what it settled', async () => {
  const id = tracker().id, K2 = 'b'.repeat(64);
  views = [{ id: 'j', status: 'running', progress: 10, rows: [row(id, 73)], next: 1, bases: { [id]: KEY }, stops: {}, warnings: [] }];
  const first = await jobs.track.start({ clip: 'c2', t: 3 });
  assert.ok(isPoller(first));
  assert.equal((await first.poll()).done, false);
  views = [{ id: 'j', status: 'running', progress: 20, rows: [], next: 1, bases: { [id]: KEY }, stops: {}, warnings: [] }];
  await assert.rejects(jobs.track.start({ clip: 'c2', t: 3 }), /still tracking/);
  views = [{ id: 'j', status: 'failed', progress: 20, rows: [], next: 1, results: { [id]: K2 }, bases: { [id]: KEY }, stops: {}, warnings: [], error: 'Decoder died.' }];
  const step = await first.poll();
  assert.match(step.text, /^track failed: Decoder died\. · forward from 3s · @[0-9a-f]{8} \+1f/);
  assert.deepEqual(tracker().result, { key: K2 });
});
