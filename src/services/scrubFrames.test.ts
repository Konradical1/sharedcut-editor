import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrubFrames } from './scrubFrames.ts';

/** createScrubFrames over a fake decode worker that answers a GOP seek the way the real one does. */
function fakeScrub(fps: number, gop: number) {
  const originals = ['Worker', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const allocated: Frame[] = [], seeks: number[] = [];
  class Frame {
    timestamp: number; duration = 1e6 / fps; closed = false;
    constructor(time: number) { this.timestamp = Math.round(time * 1e6); allocated.push(this); }
    close() { this.closed = true; }
  }
  let worker!: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void; onerror?: unknown; terminated = false;
    constructor() { worker = this; }
    postMessage(message: { type: string; time: number; count: number; generation: number; gop?: boolean }) {
      if (message.type !== 'seek') return;
      assert.equal(message.gop, true, 'scrubbing asks for the GOP, not one frame');
      seeks.push(message.time);
      // What the worker does with a GOP seek: every picture from the keyframe before the target to the next keyframe,
      // and at least `count` from the target on.
      const target = Math.floor(message.time * fps + 1e-6), key = Math.floor(target / gop) * gop;
      for (let index = key; index < Math.max(key + gop, target + message.count); index++) {
        const frame = new Frame(index / fps);
        queueMicrotask(() => this.onmessage?.({ data: { type: 'frame', frame, generation: message.generation } }));
      }
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://editor.test/' } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const counted = { changes: 0 };
  const scrub = createScrubFrames('/api/media/a/files/stream-low-v2.mp4?v=k1', fps, () => { counted.changes++; });
  const restore = () => { scrub.dispose(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } };
  return { scrub, seeks, allocated, flush, counted, restore, worker: () => worker };
}

test('scrub frames ask for whole GOPs once per frame, stand in with the nearest picture, keep a bounded cache and release it', async () => {
  // stream-low-v2: a keyframe every half second, so 12 frames per GOP at 24 fps.
  const fps = 24, { scrub, seeks, allocated, flush, counted, restore, worker } = fakeScrub(fps, 12);
  try {
    assert.equal(scrub.frame(2), undefined, 'Nothing is held before the first seek lands.');
    scrub.frame(2 + .01);
    assert.deepEqual(seeks, [2], 'Repeated asks inside one frame send one seek.');
    await flush();
    assert.equal(scrub.frame(2)!.timestamp, 2e6);
    assert.equal(scrub.frame(2 + 1 / fps)!.timestamp, Math.round((2 + 1 / fps) * 1e6), 'The frames decoded ahead answer the next small move.');
    assert.equal(scrub.frame(2 + 11 / fps)!.timestamp, Math.round((2 + 11 / fps) * 1e6), 'The rest of the GOP is held too.');
    assert.deepEqual(seeks, [2], 'Moving inside a decoded GOP sends no seek.');
    assert.ok(counted.changes >= 12, 'Each landed picture repaints the viewer.');

    const jump = 2.5 + 3 / fps;
    assert.equal(scrub.frame(jump)!.timestamp, Math.round((2 + 11 / fps) * 1e6), 'A miss stands in with the nearest held picture.');
    assert.equal(seeks.at(-1), jump, 'The exact picture is still requested.');
    assert.equal(scrub.frame(40), undefined, 'A picture more than a second away is not a stand-in.');
    await flush();
    assert.equal(scrub.frame(jump)!.timestamp, Math.round(Math.floor(jump * fps + 1e-6) / fps * 1e6));

    for (let i = 0; i < 60; i++) { scrub.frame(10 + i); await flush(); }
    assert.ok(allocated.filter(frame => !frame.closed).length <= 64, 'Held pictures stay bounded.');
    scrub.dispose();
    assert.equal(worker().terminated, true);
    assert.ok(allocated.every(frame => frame.closed), 'Disposing releases every picture.');
  } finally { restore(); }
});

test('a 240 fps GOP longer than the cache keeps the picture asked for', async () => {
  // round(240 / 2) = 120 pictures per GOP; the asked-for one is the 11th, so dropping the oldest would lose it.
  const fps = 240, { scrub, allocated, flush, restore } = fakeScrub(fps, 120), time = 10 / fps;
  try {
    scrub.frame(time); await flush();
    assert.equal(scrub.frame(time)?.timestamp, Math.round(time * 1e6));
    assert.ok(allocated.filter(frame => !frame.closed).length <= 64, 'still bounded');
  } finally { restore(); }
});
