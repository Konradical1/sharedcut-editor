import assert from 'node:assert/strict';
import test from 'node:test';
import { workQueue, limiter } from './workQueue.ts';

test('exports bypass active media, run serially, and block further background work', async () => {
  const queue = workQueue(), events: string[] = [];
  let releaseMedia!: () => void, releaseRender!: () => void;
  const media = new Promise<void>(resolve => { releaseMedia = resolve; });
  const render = new Promise<void>(resolve => { releaseRender = resolve; });
  queue.add(async () => { events.push('media'); await media; });
  await new Promise(resolve => setImmediate(resolve));
  queue.add(async () => { events.push('background'); });
  queue.add(async () => { events.push('export'); await render; }, true);
  queue.add(async () => { events.push('next export'); }, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['media', 'export']);
  releaseMedia();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['media', 'export']);
  releaseRender(); await queue.drain();
  assert.deepEqual(events, ['media', 'export', 'next export', 'background']);
});

test('the heavy-job limiter runs at most its limit at once and keeps order', async () => {
  const run = limiter(2), events: string[] = [], gates: (() => void)[] = [];
  const job = (name: string) => run(async () => { events.push(name); await new Promise<void>(resolve => gates.push(resolve)); });
  const all = Promise.all(['a', 'b', 'c', 'd'].map(job));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['a', 'b']);
  gates.shift()!(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['a', 'b', 'c']);
  while (gates.length) { gates.shift()!(); await new Promise(resolve => setImmediate(resolve)); }
  await all; assert.deepEqual(events, ['a', 'b', 'c', 'd']);
});
