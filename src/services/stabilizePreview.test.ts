import test from 'node:test';
import assert from 'node:assert/strict';
import { connection } from './api.ts';
import { createStabilizePreview } from './stabilizePreview.ts';
import type { StabilizePreview, StabilizeSolve } from './stabilize.ts';
import type { Clip } from '../state/models.ts';

const clip = { id: 'clip', projectId: 'project', mediaId: 'media' } as Clip;
const range = { from: 0, to: 8 }, settings = { amount: 100, crop: 5, smoothness: 50, lock: 0 }, fps = 24;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const solve: StabilizeSolve = { version: 1, width: 1920, height: 1080, fps, from: 0, to: 8, zoom: 1.11, zoomMin: 1.11, matrices: [[1, 0, 0, 0, 1, 0]] };

/** Reply with whatever the test currently says, and record every request body. */
function serve(reply: () => StabilizePreview, requests: unknown[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(reply()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

test('one solve per clip: it polls until ready, then stops asking', async () => {
  const requests: unknown[] = [];
  let value: StabilizePreview = { status: 'preparing', key: 'k', progress: 40 };
  const restore = serve(() => value, requests), was = connection.enabled;
  connection.enabled = true;
  const preview = createStabilizePreview(() => {});
  try {
    assert.equal(preview.get(clip, range, settings, fps), undefined, 'nothing is known before the first reply');
    await sleep(300);
    assert.equal(preview.get(clip, range, settings, fps)?.progress, 40, 'analysis progress is reported while it runs');
    assert.deepEqual(requests[0], { clipId: 'clip', fps, settings });

    value = { status: 'ready', key: 'k', progress: 100, solve, zoom: 1.11, zoomMin: 1.11 };
    await sleep(1000);
    assert.equal(preview.get(clip, range, settings, fps)?.solve?.matrices.length, 1, 'the ready solve carries its matrices');
    const settled = requests.length;
    // Every frame of playback calls get(); a solved clip must not re-ask the server for any of them.
    for (let i = 0; i < 50; i++) preview.get(clip, range, settings, fps);
    await sleep(1200);
    assert.equal(requests.length, settled, `a ready solve is final, got ${requests.length - settled} extra requests`);
  } finally { preview.dispose(); restore(); connection.enabled = was; }
});

test('changed settings drop the solve in flight and ask for the new one', async () => {
  const requests: { settings: typeof settings }[] = [];
  const restore = serve(() => ({ status: 'preparing', key: 'k', progress: 5 }), requests as unknown[]), was = connection.enabled;
  connection.enabled = true;
  const preview = createStabilizePreview(() => {});
  try {
    preview.get(clip, range, settings, fps);
    await sleep(300);
    const tighter = { ...settings, crop: 9 };
    preview.get(clip, range, tighter, fps);
    await sleep(300);
    assert.equal(requests.at(-1)?.settings.crop, 9, 'the newest request carries the new crop');
    assert.equal(preview.get(clip, range, tighter, fps)?.progress, 5);
    preview.retain(new Set(['someone-else']));
    await sleep(900);
    const settled = requests.length;
    await sleep(900);
    assert.equal(requests.length, settled, 'a clip that left the timeline stops polling');
  } finally { preview.dispose(); restore(); connection.enabled = was; }
});
