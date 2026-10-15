import test from 'node:test';
import assert from 'node:assert/strict';
import { connection } from './api.ts';
import { createDenoisePreview, denoiseStatus, denoiseStatusText, retryDenoise } from './denoisePreview.ts';
import type { Clip } from '../state/models.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const clipOf = (id: string, properties: Record<string, unknown> = {}, amount = 50) => ({ id, projectId: 'p', mediaId: 'm', start: 0, duration: 10, sourceIn: 0, properties, effects: [{ id: `nr-${id}`, name: 'Noise Reduction', enabled: true, amount }] }) as unknown as Clip;
const ntsc = { fps: 60000 / 1001, duration: 10 }, film = { fps: 24000 / 1001, duration: 3 }, plain = { fps: 24, duration: 10 };
type Call = { method: string; url: string; body?: { clipId: string; chunk: number; quality: string; view: string; settings: Record<string, number> } };
/** The server as the test says, recording every request; a DELETE always succeeds. */
function serve(answer: (body: NonNullable<Call['body']>) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return call.method === 'DELETE' ? json({ ok: true }) : answer(call.body!);
  }) as typeof fetch;
  return { calls, posts: (clipId: string) => calls.filter(c => c.method === 'POST' && c.body!.clipId === clipId).map(c => c.body!) };
}
const key = (letter: string) => letter.repeat(64);
const ready = (body: NonNullable<Call['body']>, fps = 24) => json({ status: 'ready', key: key(String(body.chunk)), url: `/api/denoise/${key(String(body.chunk))}/files/video.mp4?projectId=p`, progress: 100, from: body.chunk * 2, duration: 2, fps });
connection.enabled = true;

test('the chunk is the one holding the frame a decoder shows (the frame whose interval holds the time), at 59.94 and 23.976 fps, and never past the source', async () => {
  const server = serve(() => json({ status: 'preparing', key: key('a'), progress: 0, stage: 'queued', from: 0, duration: 2, fps: 24 }));
  const preview = createDenoisePreview(() => {});
  try {
    // 59.94: chunk 0 is frames 0-119 (2 s is 119.88 frames). At 2.000 s a decoder still shows frame 119, though 120 is nearer.
    // 23.976: chunk 0 is frames 0-47; 2.000 s is frame 47.95, still frame 47. 3 s is 72 frames, so chunk 1 is the last.
    const cases = [['a', ntsc, 119 / ntsc.fps, 0], ['b', ntsc, 120 / ntsc.fps, 1], ['c', ntsc, 2, 0], ['d', film, 47 / film.fps, 0], ['e', film, 2, 0], ['e2', film, 48 / film.fps, 1], ['f', film, 4.5, 1]] as const;
    for (const [id, asset, time] of cases) preview.get(clipOf(id), asset, time, 'Full', 'denoised');
    await sleep(350);
    for (const [id, , time, chunk] of cases) assert.deepEqual(server.posts(id).map(b => b.chunk), [chunk], `${id} at ${time}`);
    assert.deepEqual(server.posts('a')[0], { clipId: 'a', chunk: 0, quality: 'Full', view: 'denoised', settings: { amount: 50, chroma: 60, frames: 2, spatial: 50, detail: 30 } });
    assert.deepEqual(denoiseStatus('a'), { status: 'preparing', stage: 'queued', progress: 0 });
  } finally { preview.dispose(); }
  assert.equal(denoiseStatus('a'), undefined, 'a closed viewer leaves no status behind');
});

test('a changed setting cancels the stale chunk, and a scrub leaves no queue behind', async () => {
  const server = serve(body => json({ status: 'preparing', key: key(body.settings.amount === 50 ? 'a' : 'b'), progress: 40, stage: 'denoise', from: body.chunk * 2, duration: 2, fps: 24 }));
  const preview = createDenoisePreview(() => {});
  try {
    preview.get(clipOf('s'), plain, 1, 'Stream', 'denoised');
    await sleep(350);
    assert.equal(preview.get(clipOf('s'), plain, 1, 'Stream', 'denoised')?.progress, 40);
    assert.equal(denoiseStatusText(denoiseStatus('s')), 'Denoising · 40%');
    preview.get(clipOf('s', {}, 70), plain, 1, 'Stream', 'denoised');
    assert.deepEqual(server.calls.filter(c => c.method === 'DELETE').map(c => c.url), [`/api/denoise/${key('a')}?projectId=p`]);
    await sleep(350);
    assert.equal(server.posts('s').at(-1)!.settings.amount, 70, 'the new setting is asked for');
    // The playhead moves on three chunks while that one prepares: the GPU stops on it.
    preview.get(clipOf('s', {}, 70), plain, 7, 'Stream', 'denoised');
    assert.equal(server.calls.filter(c => c.method === 'DELETE').at(-1)!.url, `/api/denoise/${key('b')}?projectId=p`);
    await sleep(350);
    assert.equal(server.posts('s').at(-1)!.chunk, 3);
  } finally { preview.dispose(); }
});

test('a full queue (429) is asked again quietly; a missing worker (503) is unavailable with its reason until Retry', async () => {
  let full = true, missing = true;
  const reason = 'Noise Reduction needs the denoise worker on this server. Run npm run setup:denoise.';
  const server = serve(body => body.clipId === 'q' ? (full ? (full = false, json({ error: 'The Noise Reduction preview queue is full.' }, 429)) : ready(body)) : missing ? json({ error: reason }, 503) : ready(body));
  let repaints = 0;
  const preview = createDenoisePreview(() => { repaints++; });
  try {
    preview.get(clipOf('q'), plain, 0, '1/2', 'denoised'); preview.get(clipOf('u'), plain, 0, '1/2', 'denoised');
    await sleep(350);
    assert.equal(preview.get(clipOf('q'), plain, 0, '1/2', 'denoised'), undefined, 'nothing failed');
    assert.equal(denoiseStatus('q')?.status, 'preparing');
    assert.equal(preview.get(clipOf('u'), plain, 0, '1/2', 'denoised')?.status, 'failed');
    assert.deepEqual(denoiseStatus('u'), { status: 'unavailable', progress: 0, error: reason });
    assert.equal(denoiseStatusText(denoiseStatus('u')), reason);
    await sleep(1700);
    assert.equal(server.posts('q').length, 2, 'asked again after a short wait');
    assert.equal(preview.get(clipOf('q'), plain, 0, '1/2', 'denoised')?.status, 'ready');
    assert.equal(server.posts('u').length, 1, 'an unavailable worker is not asked again by itself');
    missing = false; const before = repaints;
    retryDenoise('u');
    assert.ok(repaints > before, 'Retry makes the viewer draw again');
    preview.get(clipOf('u'), plain, 0, '1/2', 'denoised');
    await sleep(350);
    assert.equal(server.posts('u').length, 2);
    assert.equal(denoiseStatus('u')?.status, 'ready');
    // A chunk the worker failed is deleted on Retry, so the server does not repeat the failure.
    const broken = serve(() => json({ status: 'failed', key: key('f'), progress: 0, error: 'Noise Reduction: out of memory', from: 0, duration: 2, fps: 24 }));
    preview.get(clipOf('w'), plain, 0, '1/2', 'denoised'); await sleep(350);
    assert.equal(denoiseStatusText(denoiseStatus('w')), 'Noise Reduction: out of memory');
    retryDenoise('w');
    assert.deepEqual(broken.calls.filter(c => c.method === 'DELETE').map(c => c.url), [`/api/denoise/${key('f')}?projectId=p`]);
  } finally { preview.dispose(); }
});

test('once the chunk under the playhead is ready the next one in playing order is asked for, never past either end', async () => {
  const server = serve(body => ready(body));
  const preview = createDenoisePreview(() => {});
  try {
    preview.get(clipOf('n'), plain, .5, 'Color', 'noise');
    await sleep(350);
    assert.equal(preview.next('n'), undefined, 'nothing is asked ahead before the chunk shown is ready');
    assert.equal(preview.get(clipOf('n'), plain, .5, 'Color', 'noise')?.from, 0);
    await sleep(350);
    assert.deepEqual(server.posts('n').map(b => [b.chunk, b.view]), [[0, 'noise'], [1, 'noise']]);
    assert.equal(preview.next('n')?.from, 2, 'the viewer can warm the next chunk');
    // Reversed, the next chunk is the one before; the last chunk asks for nothing after it (10 s at 24 fps: chunks 0-4).
    const reversed = clipOf('r', { reverse: true });
    preview.get(reversed, plain, 5, 'Color', 'denoised'); await sleep(350); preview.get(reversed, plain, 5, 'Color', 'denoised'); await sleep(350);
    assert.deepEqual(server.posts('r').map(b => b.chunk), [2, 1]);
    preview.get(clipOf('l'), plain, 9.99, 'Color', 'denoised'); await sleep(350); preview.get(clipOf('l'), plain, 9.99, 'Color', 'denoised'); await sleep(350);
    assert.deepEqual(server.posts('l').map(b => b.chunk), [4]);
    // Nor past the clip's own end: a clip out at 5.5 s ends in chunk 2, one out at 6.5 s reads chunk 3 too; reversed, its in point.
    for (const [id, end, chunks] of [['o1', 5.5, [2]], ['o2', 6.5, [2, 3]]] as const) { preview.get(clipOf(id), plain, 5, 'Color', 'denoised', end); await sleep(350); preview.get(clipOf(id), plain, 5, 'Color', 'denoised', end); await sleep(350); assert.deepEqual(server.posts(id).map(b => b.chunk), chunks, id); }
    preview.get(reversed, plain, 5, 'Color', 'denoised', 4.5); await sleep(350); preview.get({ ...reversed, id: 'r2' }, plain, 5, 'Color', 'denoised', 4.5); await sleep(350); preview.get({ ...reversed, id: 'r2' }, plain, 5, 'Color', 'denoised', 4.5); await sleep(350);
    assert.deepEqual(server.posts('r2').map(b => b.chunk), [2]);
  } finally { preview.dispose(); }
});

test('optical flow on the clip takes the preview; the status text', async () => {
  const server = serve(body => ready(body));
  const preview = createDenoisePreview(() => {});
  try {
    assert.equal(preview.get(clipOf('o', { opticalFlow: true }), plain, 1, 'Full', 'denoised'), undefined);
    await sleep(350);
    assert.equal(server.calls.length, 0);
    assert.equal(denoiseStatusText(denoiseStatus('o')), 'Optical flow shows in preview; Noise Reduction shows in export');
  } finally { preview.dispose(); }
  assert.equal(denoiseStatusText(undefined), '');
  assert.equal(denoiseStatusText({ status: 'preparing', progress: 0 }), 'Denoising · 0%');
  assert.equal(denoiseStatusText({ status: 'preparing', stage: 'profile', progress: 12 }), 'Measuring noise');
  assert.equal(denoiseStatusText({ status: 'preparing', stage: 'denoise', progress: 40 }), 'Denoising · 40%');
  assert.equal(denoiseStatusText({ status: 'ready', progress: 100 }), 'Ready');
  assert.equal(denoiseStatusText({ status: 'failed', progress: 0, error: 'Noise Reduction: out of memory' }), 'Noise Reduction: out of memory');
});

test('chunks of clips no longer drawn stop preparing; a closed viewer leaves the server its chunks; a cancel during the ask cancels on the server', async () => {
  const deletes = (calls: Call[]) => calls.filter(c => c.method === 'DELETE').map(c => c.url);
  let server = serve(body => json({ status: 'preparing', key: key(body.clipId), progress: 10, stage: 'denoise', from: 0, duration: 2, fps: 24 }));
  let preview = createDenoisePreview(() => {});
  try {
    // A scrub across a, b, c then e: only what is still drawn asks the server.
    for (const id of ['a', 'b', 'c']) { preview.get(clipOf(id), plain, 0, 'Full', 'denoised'); preview.sweep(); }
    preview.get(clipOf('e'), plain, 0, 'Full', 'denoised'); preview.sweep();
    await sleep(350);
    assert.deepEqual(server.calls.filter(c => c.method === 'POST').map(c => c.body!.clipId), ['e']);
    // Drawn again and again it keeps its chunk; moved off it, the chunk preparing on the server is cancelled there.
    preview.get(clipOf('e'), plain, 0, 'Full', 'denoised'); preview.sweep();
    preview.sweep();
    assert.deepEqual(deletes(server.calls), [`/api/denoise/${key('e')}?projectId=p`]);
    // Switching workspace remounts the viewer: the chunk preparing stays on the server for the next viewer.
    preview.get(clipOf('w'), plain, 0, 'Full', 'denoised'); await sleep(350);
    preview.dispose();
    assert.deepEqual(deletes(server.calls), [`/api/denoise/${key('e')}?projectId=p`]);
  } finally { preview.dispose(); }
  // The server queues a job before it answers: one cancelled while asking is cancelled by the key it answers with.
  let answer: (response: Response) => void = () => {};
  server = { calls: [], posts: () => [] };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    server.calls.push({ method: init?.method ?? 'GET', url: String(url) });
    return init?.method === 'DELETE' ? json({ ok: true }) : new Promise<Response>(resolve => { answer = resolve; });
  }) as typeof fetch;
  preview = createDenoisePreview(() => {});
  try {
    preview.get(clipOf('s'), plain, 0, 'Full', 'denoised'); await sleep(350);
    preview.get(clipOf('s', {}, 70), plain, 0, 'Full', 'denoised');
    answer(json({ status: 'preparing', key: key('s'), progress: 0, from: 0, duration: 2, fps: 24 })); await sleep(10);
    assert.deepEqual(deletes(server.calls), [`/api/denoise/${key('s')}?projectId=p`]);
  } finally { preview.dispose(); }
});

test('a ready chunk whose file stopped loading is asked for again', async () => {
  const server = serve(body => ready(body));
  const preview = createDenoisePreview(() => {});
  try {
    preview.get(clipOf('g'), plain, 0, 'Full', 'denoised'); await sleep(350);
    assert.equal(preview.get(clipOf('g'), plain, 0, 'Full', 'denoised')?.status, 'ready');
    preview.forget(key('0'));
    assert.equal(server.calls.filter(c => c.method === 'DELETE').length, 0, 'a ready chunk is never cancelled on the server');
    preview.get(clipOf('g'), plain, 0, 'Full', 'denoised'); await sleep(350);
    assert.equal(server.posts('g').filter(b => b.chunk === 0).length, 2);
  } finally { preview.dispose(); }
});
