import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrubFrames } from './scrubFrames.ts';

test('scrub frames seek once per frame, stand in with the nearest picture, keep a bounded cache and release it', async () => {
  const originals = ['Worker', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const fps = 24, allocated: Frame[] = [], seeks: number[] = [];
  class Frame {
    timestamp: number; duration = 1e6 / fps; closed = false;
    constructor(time: number) { this.timestamp = Math.round(time * 1e6); allocated.push(this); }
    close() { this.closed = true; }
  }
  let worker!: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void; onerror?: unknown; terminated = false;
    constructor() { worker = this; }
    postMessage(message: { type: string; time: number; count: number; generation: number }) {
      if (message.type !== 'seek') return;
      seeks.push(message.time);
      const first = Math.floor(message.time * fps + 1e-6);
      for (let i = 0; i < message.count; i++) {
        const frame = new Frame((first + i) / fps);
        queueMicrotask(() => this.onmessage?.({ data: { type: 'frame', frame, generation: message.generation } }));
      }
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://editor.test/' } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let changes = 0;
  const scrub = createScrubFrames('/api/media/a/files/proxy-quarter-v1.mp4', fps, () => { changes++; });
  try {
    assert.equal(scrub.frame(2), undefined, 'Nothing is held before the first seek lands.');
    scrub.frame(2 + .01);
    assert.deepEqual(seeks, [2], 'Repeated asks inside one frame send one seek.');
    await flush();
    assert.equal(scrub.frame(2)!.timestamp, 2e6);
    assert.equal(scrub.frame(2 + 1 / fps)!.timestamp, Math.round((2 + 1 / fps) * 1e6), 'The frames decoded ahead answer the next small move.');
    assert.ok(changes >= 3, 'Each landed picture repaints the viewer.');

    const jump = 2.5;
    assert.equal(scrub.frame(jump)!.timestamp, Math.round((2 + 2 / fps) * 1e6), 'A miss stands in with the nearest held picture.');
    assert.equal(seeks.at(-1), jump, 'The exact picture is still requested.');
    assert.equal(scrub.frame(40), undefined, 'A picture more than a second away is not a stand-in.');
    await flush();
    assert.equal(scrub.frame(jump)!.timestamp, Math.round(Math.floor(jump * fps + 1e-6) / fps * 1e6));

    for (let i = 0; i < 60; i++) { scrub.frame(10 + i); await flush(); }
    assert.ok(allocated.filter(frame => !frame.closed).length <= 48, 'Held pictures stay bounded.');
    scrub.dispose();
    assert.equal(worker.terminated, true);
    assert.ok(allocated.every(frame => frame.closed), 'Disposing releases every picture.');
  } finally {
    scrub.dispose();
    for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
