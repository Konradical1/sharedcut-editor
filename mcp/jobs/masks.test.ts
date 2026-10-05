// The Smart Mask jobs against a fake SharedCut server (no SAM worker on the Mac): the store holds the demo workspace,
// PATCH saves land in a server copy, and the /api/smart-masks routes answer like server/index.ts (preview needs the
// saved mask, analyze needs the saved signature). Walks view -> guide -> preview tint -> analyze -> result install.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';
import { smartMaskSignature } from '../../src/services/smartMask.ts';

process.env.FRAME_LINE_URL = 'http://fake.local';
process.env.FRAME_LINE_COOKIE = 'frameline_session=test';
let saved: any = structuredClone(persistentState(store.getState()));
let revision = 1, statuses: any[] = [];
const requests: { method: string; path: string; body?: any }[] = [];
const KEY = 'b'.repeat(64), TIMES = Array.from({ length: 94 * 24 }, (_, i) => i / 24);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function picture(type: 'png' | 'jpeg', box?: number[]) {
  const canvas = createCanvas(384, 216), ctx = canvas.getContext('2d');
  ctx.fillStyle = type === 'png' ? '#000' : '#556'; ctx.fillRect(0, 0, 384, 216);
  if (box) { ctx.fillStyle = '#fff'; ctx.fillRect(box[0] * 384, box[1] * 216, (box[2] - box[0]) * 384, (box[3] - box[1]) * 216); }
  return new Response(new Uint8Array(await canvas.encode(type as 'png')), { headers: { 'content-type': `image/${type}` } });
}
const savedMask = (clipId: string, maskId: string) => saved.clips.find((c: any) => c.id === clipId)?.smartMasks?.find((m: any) => m.id === maskId);
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input), method = init.method ?? 'GET', path = url.pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ method, path: path + url.search, body });
  if (path === '/api/auth/me') return json({ user: saved.users.find((u: any) => u.id === saved.currentUserId) });
  if (path === '/api/state' && method === 'GET') return json({ revision, state: saved });
  if (path === '/api/state' && method === 'PATCH') { saved = applyStateDelta(saved, body.delta); return json({ revision: ++revision }); }
  if (path === '/api/motion-trackers/source-times') return json({ sourceTimes: TIMES });
  if (path === '/api/smart-masks/source') return picture('jpeg');
  if (path === '/api/smart-masks/capabilities') return json({ available: true, engine: 'SAM test', preserveMotionBlur: false, finalQuality: false });
  if (path === '/api/smart-masks/preview' && method === 'POST') {
    if (!savedMask(body.clipId, body.maskId)) return json({ error: 'Mask not found.' }, 404);
    return json({ url: `/api/smart-masks/preview/${'c'.repeat(64)}.png?projectId=city-after-dark` });
  }
  if (path.startsWith('/api/smart-masks/preview/')) return picture('png', [.25, .2, .5, .8]);
  if (path === '/api/smart-masks' && method === 'POST') {
    if (smartMaskSignature(savedMask(body.clipId, body.maskId)) !== body.signature) return json({ error: 'Mask edits are still saving. Retry analysis after saving.' }, 409);
    return json({ key: KEY, signature: body.signature, status: 'queued', progress: 0 }, 202);
  }
  if (path === `/api/smart-masks/${KEY}` && method === 'GET') return json(statuses.shift());
  if (path === `/api/smart-masks/${KEY}` && method === 'DELETE') return json({ ok: true });
  if (path === `/api/smart-masks/${KEY}/manifest`) return json({ frames: TIMES.slice(0, 22 * 24).map((time, index) => ({ index, time, file: `${index}.png` })), range: { start: 0, end: 22 } });
  const frame = /\/(preview|frames)\/(\d+)\.png$/.exec(path);
  if (frame?.[1] === 'preview' && frame[2] === '527') return json({ error: 'This mask has no playback-size matte' }, 404);
  if (frame) return picture('png', frame[2] === '264' ? undefined : [.3, .2, .5, .8]);
  return json({ error: `unexpected ${method} ${path}` }, 500);
}) as typeof fetch;

const { ready, edit } = await import('../edit.ts');
const { jobs, topics } = await import('./masks.ts');
const { isPoller } = await import('./kit.ts');
await ready();
store.getState().openProject('city-after-dark');

async function run(kind: string, params: Record<string, unknown>) {
  const started = await jobs[kind].start(params);
  if (!isPoller(started)) return started;
  for (let i = 0; i < 10; i++) { const step = await started.poll(); if (step.done) return step; }
  throw new Error('never finished');
}
const last = (path: string) => [...requests].reverse().find(r => r.path === path)!;
const mask = () => store.getState().clips.find(c => c.id === 'c2')!.smartMasks!.at(-1)!;
let maskId = '';

test('mask-view shows the source frame with a grid before any mask exists', async () => {
  const step = await run('mask-view', { clip: 'c2', at: 2 });
  assert.match(step.text, /^@c2 frame 48 \(clip 49\/528\) t=2\.000s · 0 guides here · no mask yet/);
  const img = await loadImage(Buffer.from((step.content![0] as { data: string }).data, 'base64'));
  assert.equal(img.width, 768);
});

test('mask-guide saves guides on the exact frame, replaces that frame, and returns the tinted preview', async () => {
  maskId = (await edit(run => run('addSmartMask', 'c2'))).value as string;
  assert.ok(savedMask('c2', maskId), 'act saved the mask before any preview');
  const step = await run('mask-guide', { clip: 'c2', mask: maskId, frame: 48, include: [[.4, .5]], exclude: [[.9, .1]] });
  assert.deepEqual(mask().prompts.map(p => [p.kind, p.time, p.radius, p.points]), [['include', 2, .012, [{ x: .4, y: .5 }]], ['exclude', 2, .012, [{ x: .9, y: .1 }]]]);
  assert.deepEqual(savedMask('c2', maskId).prompts, mask().prompts, 'saved');
  const preview = last('/api/smart-masks/preview');
  assert.equal(preview.body.frame, 48);
  assert.equal(preview.body.prompts.length, 2);
  assert.match(step.text, /^1 include, 1 exclude\n.* frame 48 .*2 guides here · not analyzed · matte preview 1[45]\.\d% bbox x\.25–\.50 y\.20–\.80$/);
  assert.equal(step.content?.length, 1);

  await run('mask-guide', { clip: 'c2', frame: 48, strokes: [{ kind: 'include', points: [[.3, .3], [.35, .4]] }], image: false });
  assert.deepEqual(mask().prompts.map(p => p.points.length), [2], 'replace swaps the frame\'s guides');
  await run('mask-guide', { clip: 'c2', frame: 96, include: [[.5, .5]], replace: false, image: false });
  await run('mask-guide', { clip: 'c2', frame: 48, strokes: [{ kind: 'remove', points: [[.1, .1]] }], image: false });
  assert.equal(mask().prompts.length, 2, 'a repair keeps the frame\'s guides');
  assert.deepEqual(mask().repairs.map(r => r.kind), ['background']);
  await assert.rejects(run('mask-guide', { clip: 'c2', frame: 48, image: false }), /clear:true/, 'nothing given is refused, not a silent clear');
  await run('mask-guide', { clip: 'c2', frame: 48, clear: true, image: false });
  assert.deepEqual(mask().prompts.map(p => p.time), [4], 'clear:true empties the frame');
  assert.equal(mask().repairs.length, 0);
  await run('mask-guide', { clip: 'c2', frame: 48, include: [[.4, .5]], image: false });
  await assert.rejects(run('mask-guide', { clip: 'c2', include: [[1.2, .5]] }), /0–1 of the source frame/);
});

test('mask-analyze sends the saved signature, polls, installs the result and samples the frames', async () => {
  statuses = [{ key: KEY, status: 'processing', progress: 40 }, { key: KEY, status: 'ready', progress: 100 }];
  const started = await jobs['mask-analyze'].start({ clip: 'c2' });
  assert.ok(isPoller(started));
  const post = last('/api/smart-masks');
  assert.deepEqual([post.body.direction, post.body.anchorTime, post.body.signature], ['both', mask().range.start, smartMaskSignature(mask())]);
  assert.match((await started.poll()).text, /analyzing 40%/);
  const step = await started.poll();
  assert.ok(step.done);
  assert.match(step.text, /ready · 528 frames 0\.00–22\.00s · samples f0 11\.9% · f132 11\.9% · f264 0\.0% !empty · f395 11\.9% · f527 11\.9%\nFlagged frames/);
  assert.ok(step.text.length < 400 && !step.text.includes('"prompts"'), 'never echoes the signature');
  assert.equal(mask().result?.key, KEY);
  assert.equal(savedMask('c2', maskId).result.key, KEY, 'result saved');
  const look = await run('mask-view', { clip: 'c2', frame: 50, image: false, matte: true });
  assert.match(look.text, /analysis current · matte analyzed 11\.9% bbox x\.30–\.50/);
});

test('a mask edited during analysis is not given the old result', async () => {
  statuses = [{ key: KEY, status: 'ready', progress: 100 }];
  await run('mask-guide', { clip: 'c2', frame: 48, include: [[.45, .5]], image: false });
  const started = await jobs['mask-analyze'].start({ clip: 'c2', direction: 'forward' });
  assert.equal(last('/api/smart-masks').body.anchorTime, 2, 'forward anchors on the first include guide');
  await run('mask-guide', { clip: 'c2', frame: 96, include: [[.6, .5]], image: false });
  assert.ok(isPoller(started));
  assert.match((await started.poll()).text, /changed during analysis: analyze again/);
  assert.notEqual(mask().result?.signature, smartMaskSignature(mask()));
  await started.cancel!();
  assert.equal(requests.at(-1)!.method, 'DELETE');
});

test('a collaborator\'s edit saved during analysis is seen before the result is installed', async () => {
  statuses = [{ key: KEY, status: 'ready', progress: 100 }];
  const started = await jobs['mask-analyze'].start({ clip: 'c2' });
  saved = structuredClone(saved); revision++;
  savedMask('c2', maskId).name = 'Theirs'; savedMask('c2', maskId).range = { ...savedMask('c2', maskId).range, end: 10 };
  assert.ok(isPoller(started));
  assert.match((await started.poll()).text, /changed during analysis/);
  assert.equal(mask().range.end, 10, 'their edit was taken');
  assert.notEqual(savedMask('c2', maskId).result?.signature, smartMaskSignature(savedMask('c2', maskId)), 'no stale result saved');
});

test('docs are one line and the topic opens with its header', () => {
  for (const [kind, job] of Object.entries(jobs)) assert.ok(!job.doc.includes('\n') && job.doc.length < 200, kind);
  assert.match(topics.masks.split('\n')[0], /^masks: /);
  assert.match(topics.masks, /invert:0\|1/);
});
