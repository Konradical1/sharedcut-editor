import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { connection } from './api.ts';
import { createTimelinePreview, isHostBrowser, PREVIEW_BUSY_BASE_MS, PREVIEW_BUSY_MAX_MS, PREVIEW_IN_FLIGHT, PREVIEW_POLL_MS } from './timelinePreview.ts';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const globals = ['fetch', 'Worker', 'VideoDecoder', 'location'] as const;
const originals = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const wasEnabled = connection.enabled;
afterEach(() => {
  mock.timers.reset();
  connection.enabled = wasEnabled;
  for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

type Answer = { status?: number; body?: unknown; drop?: boolean };
const preparing = { key: 'k', status: 'preparing', progress: 10, from: 0, duration: 4, fps: 24 };
/** A browser at `hostname` talking to a fake server that answers each preview request from `script`. */
function rig(hostname: string, script: (call: number, chunk: number) => Answer, duration = 3) {
  const requests: { chunk: number }[] = [], workers: string[] = [];
  define('location', { hostname, href: `https://${hostname}/` });
  define('VideoDecoder', class {});
  define('Worker', class { onmessage = null; onerror = null; postMessage(message: { type: string; url?: string }) { if (message.type === 'open') workers.push(String(message.url)); } terminate() {} });
  define('fetch', async (_url: string, init: RequestInit) => {
    const call = requests.push(JSON.parse(String(init.body)));
    const { status = 200, body, drop } = script(call, requests[call - 1].chunk);
    if (drop) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  connection.enabled = true;
  mock.timers.enable({ apis: ['setTimeout'] });
  // A one-chunk timeline, so a single request is in play and its schedule can be read off the clock.
  const state = { projectId: 'p', timelineId: 't', projects: [{ id: 'p', fps: 24 }], timelines: [{ id: 't', projectId: 'p', duration }], clips: [], tracks: [], media: [], nodes: [], settings: {} } as never;
  const preview = createTimelinePreview(() => {});
  return { requests, workers, preview, ask: (enable = true, ahead = 1) => preview.get(state, 0, 960, 540, enable, ahead), tick: async (ms: number) => { mock.timers.tick(ms); await settle(); } };
}

test('only the server\'s own computer is recognised as the host, and exactly', () => {
  for (const name of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1']) assert.equal(isHostBrowser(name), true, name);
  for (const name of ['sharedcut.com', 'www.sharedcut.com', '192.168.1.20', '127.0.0.1.evil.test', 'localhost.evil.test', '', undefined]) assert.equal(isHostBrowser(name), false, String(name));
});

test('a browser on the host never asks the server to render a preview', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    const { requests, ask, tick } = rig(hostname, () => ({ body: preparing }));
    assert.equal(ask(true), undefined);
    await tick(60_000);
    assert.equal(ask(true), undefined);
    assert.equal(requests.length, 0, `${hostname} asked the host to render`);
    mock.timers.reset();
  }
});

test('a remote browser asks once the renderer is in use, and not before', async () => {
  const { requests, ask, tick } = rig('sharedcut.com', () => ({ body: preparing }));
  ask(false); await tick(60_000);
  assert.equal(requests.length, 0, 'the live compositor is enough');
  ask(true); await tick(749); assert.equal(requests.length, 0);
  await tick(1); assert.equal(requests.length, 1);
});

test('"queue busy" is retried after 2 s, then 4, 8 and 15 s at most, never faster', async () => {
  const { requests, ask, tick } = rig('sharedcut.com', () => ({ status: 429, body: { error: 'Preview queue busy' } }));
  ask(true); await tick(750);
  assert.equal(requests.length, 1);
  let calls = 1;
  for (const base of [PREVIEW_BUSY_BASE_MS, 2 * PREVIEW_BUSY_BASE_MS, 4 * PREVIEW_BUSY_BASE_MS, PREVIEW_BUSY_MAX_MS, PREVIEW_BUSY_MAX_MS, PREVIEW_BUSY_MAX_MS]) {
    // Jitter shortens the wait by at most a quarter: nothing before that, always something by the full delay.
    const earliest = Math.ceil(base * 0.75) - 1;
    await tick(earliest); assert.equal(requests.length, calls, `no retry within ${earliest} ms of the ${base} ms step`);
    await tick(base - earliest); assert.equal(requests.length, ++calls, `retry by ${base} ms`);
  }
});

test('the first busy answer is not a reason to hammer: polling is far slower than the old fixed 2 s', async () => {
  const { requests, ask, tick } = rig('sharedcut.com', () => ({ status: 429, body: { error: 'Preview queue busy' } }));
  ask(true); await tick(750);
  // One second at a time: each retry is scheduled only after the previous answer has been handled.
  for (let second = 0; second < 150; second++) await tick(1000);
  // Every 2 s forever would be 75 requests in 150 s; 2, 4, 8, then every 15 s is about a dozen.
  assert.ok(requests.length <= 14, `${requests.length} requests in 150 s`);
});

test('an answer that is not "busy" starts the backoff over', async () => {
  const answers: Answer[] = [{ status: 429, body: { error: 'Preview queue busy' } }, { status: 429, body: { error: 'Preview queue busy' } }, { body: preparing }, { status: 429, body: { error: 'Preview queue busy' } }];
  const { requests, ask, tick } = rig('sharedcut.com', call => answers[call - 1] ?? { status: 429, body: { error: 'Preview queue busy' } });
  ask(true); await tick(750); // call 1: busy, waits 1.5-2 s
  await tick(PREVIEW_BUSY_BASE_MS); assert.equal(requests.length, 2); // call 2: busy, waits 3-4 s
  await tick(2 * PREVIEW_BUSY_BASE_MS); assert.equal(requests.length, 3); // call 3: preparing, polled again in 1 s
  await tick(1000); assert.equal(requests.length, 4); // call 4: busy again, and back at the first step
  await tick(Math.ceil(PREVIEW_BUSY_BASE_MS * 0.75) - 1); assert.equal(requests.length, 4);
  await tick(PREVIEW_BUSY_BASE_MS); assert.equal(requests.length, 5);
});

test('a dropped connection or a server error is retried with the same backoff, and a good answer starts it over', async () => {
  const answers: Answer[] = [{ drop: true }, { status: 502, body: { error: 'Bad gateway' } }, { body: preparing }, { drop: true }];
  const { requests, ask, tick } = rig('sharedcut.com', call => answers[call - 1] ?? { drop: true });
  ask(true); await tick(750); assert.equal(requests.length, 1, 'call 1: the connection dropped');
  await tick(PREVIEW_BUSY_BASE_MS); assert.equal(requests.length, 2, 'retried by 2 s; call 2: a 502');
  await tick(2 * PREVIEW_BUSY_BASE_MS); assert.equal(requests.length, 3, 'retried by 4 s; call 3: preparing');
  await tick(1000); assert.equal(requests.length, 4, 'polled again in 1 s; call 4: dropped again');
  await tick(Math.ceil(PREVIEW_BUSY_BASE_MS * 0.75) - 1); assert.equal(requests.length, 4, 'back at the first step');
  await tick(PREVIEW_BUSY_BASE_MS); assert.equal(requests.length, 5);
});

test('other client errors are final, and transient ones stop after six retries', async () => {
  for (const status of [400, 401, 403, 404]) {
    const { requests, ask, tick } = rig('sharedcut.com', () => ({ status, body: { error: 'No' } }));
    ask(true); await tick(750);
    for (let second = 0; second < 60; second++) await tick(1000);
    assert.equal(requests.length, 1, `a ${status} is not retried`);
    mock.timers.reset();
  }
  const { requests, ask, tick } = rig('sharedcut.com', () => ({ drop: true }));
  ask(true); await tick(750);
  for (let second = 0; second < 300; second++) await tick(1000);
  assert.equal(requests.length, 7, 'the first ask and six retries, then live playback is left alone');
  assert.equal(ask(true), undefined, 'the live compositor keeps drawing');
});

test('a skipped chunk is final: no polling, and the picture stays live', async () => {
  const skipped = { key: 'k', status: 'skipped', progress: 0, from: 0, duration: 4, fps: 24, error: 'Depth plays live in the editor.' };
  const { requests, workers, ask, tick } = rig('sharedcut.com', () => ({ body: skipped }));
  ask(true); await tick(750);
  assert.equal(requests.length, 1);
  for (let second = 0; second < 60; second++) await tick(1000);
  assert.equal(requests.length, 1, 'nothing more is asked of a chunk the server will not render');
  assert.equal(ask(true), undefined, 'the live compositor keeps drawing');
  assert.equal(workers.length, 0, 'no decoder is opened for it');
  for (let second = 0; second < 60; second++) { ask(true); await tick(1000); }
  assert.equal(requests.length, 1, 'still one request however long playback continues over it');
});

test('a preparing chunk is polled every half second until it is ready, then decoded once', async () => {
  const ready = { key: 'k', status: 'ready', progress: 100, from: 0, duration: 4, fps: 24, url: '/api/timeline-previews/k/video.mp4?projectId=p' };
  const { requests, workers, ask, tick } = rig('sharedcut.com', call => ({ body: call < 3 ? preparing : ready }));
  ask(true); await tick(750); assert.equal(requests.length, 1);
  await tick(PREVIEW_POLL_MS - 1); assert.equal(requests.length, 1);
  await tick(1); assert.equal(requests.length, 2);
  await tick(PREVIEW_POLL_MS); assert.equal(requests.length, 3);
  assert.equal(workers.length, 1);
  await tick(30_000); assert.equal(requests.length, 3, 'a ready chunk is not polled again');
});

test('disposing the preview cancels a pending retry', async () => {
  const { requests, preview, ask, tick } = rig('sharedcut.com', () => ({ status: 429, body: { error: 'Preview queue busy' } }));
  ask(true); await tick(750); assert.equal(requests.length, 1);
  preview.dispose();
  await tick(60_000);
  assert.equal(requests.length, 1);
});

test('smooth playback renders ahead nearest first, never more than two chunks at once', async () => {
  const ready = new Set<number>();
  const answer = (chunk: number) => ready.has(chunk) ? { key: `k${chunk}`, status: 'ready', progress: 100, from: chunk * 4, duration: 4, fps: 24, url: `/api/timeline-previews/k${chunk}/video.mp4?projectId=p` } : { ...preparing, key: `k${chunk}`, from: chunk * 4 };
  const { requests, ask, tick } = rig('sharedcut.com', (_call, chunk) => ({ body: answer(chunk) }), 40);
  const asked = () => [...new Set(requests.map(r => r.chunk))].sort((a, b) => a - b);
  ask(true, 4); await tick(750);
  assert.deepEqual(asked(), [0, 1], `${PREVIEW_IN_FLIGHT} at once, the playhead's chunk first`);
  assert.deepEqual(ask(true, 4), { waiting: true }, 'the chunk at the playhead is on its way');
  ready.add(0); ready.add(1); await tick(1000);
  ask(true, 4); await tick(750);
  assert.deepEqual(asked(), [0, 1, 2, 3], 'two more once those are rendered');
  ready.add(2); ready.add(3); await tick(1000);
  ask(true, 4); await tick(750);
  assert.deepEqual(asked(), [0, 1, 2, 3, 4], 'never past the playhead plus the look-ahead');
});

test('a chunk the server refuses plays live: it is not waited for', async () => {
  const { ask, tick } = rig('sharedcut.com', () => ({ status: 400, body: { error: 'Invalid preview range.' } }));
  assert.deepEqual(ask(true), { waiting: true }, 'asked: on its way');
  await tick(750);
  assert.equal(ask(true), undefined, 'a final refusal hands the chunk to the live compositor');
});
