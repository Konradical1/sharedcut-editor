import assert from 'node:assert/strict';
import test from 'node:test';
import type { Clip } from '../state/models.ts';
import { acceptsEffect, effectDefinitions } from './effects.ts';
import { stabilizeChunk, stabilizeChunkCount, stabilizeChunkRange, stabilizeEffect, stabilizeRange, stabilizeSettings } from './stabilize.ts';

const clip = (overrides: Partial<Clip> = {}): Clip => ({ id: 'c', projectId: 'p', timelineId: 't', trackId: 'v', mediaId: 'm', name: 'Shot', start: 0, duration: 2, sourceIn: 1, color: '', disabled: false, properties: {}, effects: [], ...overrides });
const stabilize = { id: 'e', name: 'Stabilize', enabled: true, amount: 100 };

test('Stabilize is offered on plain video only', () => {
  assert.ok(effectDefinitions.Stabilize);
  assert.ok(acceptsEffect(clip(), 'video', 'Stabilize'));
  assert.equal(acceptsEffect(clip(), 'audio', 'Stabilize'), false);
  assert.equal(acceptsEffect(clip(), 'image', 'Stabilize'), false);
  assert.equal(acceptsEffect(clip({ properties: { captionSet: 'x' } }), 'video', 'Stabilize'), false);
  assert.equal(acceptsEffect(clip({ properties: { compositionId: 'x' } }), 'video', 'Stabilize'), false);
  assert.equal(acceptsEffect(clip({ mediaId: 'frameline-title' }), 'video', 'Stabilize'), false);
});

test('settings come from the registry defaults and clamp', () => {
  const c = clip({ effects: [stabilize] });
  assert.deepEqual(stabilizeSettings(c, stabilize), { amount: 100, smoothness: 50, cropMode: 0, zoom: 10, tripod: 0, maxShift: 15, maxAngle: 5 });
  assert.equal(stabilizeSettings(c, { ...stabilize, parameters: { smoothness: 500 } }).smoothness, 100);
  assert.equal(stabilizeEffect(c), stabilize);
  assert.equal(stabilizeEffect(clip({ effects: [{ ...stabilize, enabled: false }] })), undefined);
  assert.equal(stabilizeEffect(clip({ effects: [{ ...stabilize, amount: 0 }] })), undefined);
});

test('the analysed range follows the source frames the clip reads', () => {
  const plain = stabilizeRange(clip(), 24, 100);
  assert.equal(plain.from, 1); assert.ok(Math.abs(plain.to - 3) < 1e-6);
  const fast = stabilizeRange(clip({ properties: { speed: 200 } }), 24, 100);
  assert.ok(Math.abs(fast.to - fast.from - 4) < .1, `speed 200 reads ${fast.to - fast.from}s`);
  const reversed = stabilizeRange(clip({ properties: { reverse: true } }), 24, 100);
  assert.equal(reversed.from, 1); assert.ok(Math.abs(reversed.to - 3) < 1e-6);
  assert.ok(stabilizeRange(clip({ sourceIn: 99.5 }), 24, 100).to <= 100);
});

test('chunks index source time inside the range', () => {
  const range = { from: 10, to: 19 };
  assert.equal(stabilizeChunkCount(range), 3);
  assert.equal(stabilizeChunk(10, range), 0); assert.equal(stabilizeChunk(14.5, range), 1); assert.equal(stabilizeChunk(18.9, range), 2);
  assert.equal(stabilizeChunk(50, range), 2); assert.equal(stabilizeChunk(-5, range), 0);
  assert.deepEqual(stabilizeChunkRange(2, range), { from: 18, to: 19 });
});
