import assert from 'node:assert/strict';
import test from 'node:test';
import type { Clip } from '../state/models.ts';
import { acceptsEffect, effectDefinitions } from './effects.ts';
import { stabilizeEffect, stabilizeLayerTransform, stabilizeMatrixAt, stabilizeRange, stabilizeSettings, stabilizeTransform, type StabilizeSolve } from './stabilize.ts';

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
  assert.deepEqual(stabilizeSettings(c, stabilize), { amount: 100, crop: 5, smoothness: 50, lock: 0 });
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

const solve = (matrices: number[][]): StabilizeSolve => ({ version: 1, width: 1920, height: 1080, fps: 24, from: 2, to: 2 + matrices.length / 24, zoom: 1.11, zoomMin: 1.11, matrices });

test('a source time picks the frame the export render would warp', () => {
  const s = solve([[1, 0, 0, 0, 1, 0], [1, 0, -4, 0, 1, 3], [1, 0, -8, 0, 1, 6]]);
  assert.deepEqual(stabilizeMatrixAt(s, 2), s.matrices[0]);
  assert.deepEqual(stabilizeMatrixAt(s, 2 + 1 / 24), s.matrices[1], 'one frame in is the second matrix');
  assert.deepEqual(stabilizeMatrixAt(s, 2 + 1.4 / 24), s.matrices[1], 'times round to the nearest analysed frame');
  // Before and after the analysed range the clip holds the nearest solved frame instead of jumping to identity.
  assert.deepEqual(stabilizeMatrixAt(s, 0), s.matrices[0]);
  assert.deepEqual(stabilizeMatrixAt(s, 99), s.matrices[2]);
});

test('with optical flow the warp blends the two analysed frames around the source time', () => {
  // Flow shows pictures between source frames; a nearest-frame warp would step every other picture and shake the slow motion.
  const s = solve([[1, 0, 0, 0, 1, 0], [1, 0, -4, 0, 1, 3], [1, 0, -8, 0, 1, 6]]);
  const near = (actual: number[], expected: number[], message: string) => assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 1e-9), `${message}: ${actual}`);
  near(stabilizeMatrixAt(s, 2 + .5 / 24, true), [1, 0, -2, 0, 1, 1.5], 'half way between two frames');
  near(stabilizeMatrixAt(s, 2 + 1.25 / 24, true), [1, 0, -5, 0, 1, 3.75], 'a quarter past the second frame');
  near(stabilizeMatrixAt(s, 2 + 1 / 24, true), s.matrices[1], 'on an analysed frame it is that frame’s matrix');
  near(stabilizeMatrixAt(s, 0, true), s.matrices[0], 'before the range it holds the first');
  near(stabilizeMatrixAt(s, 99, true), s.matrices[2], 'after the range it holds the last');
  near(stabilizeMatrixAt(s, 2 + 1.4 / 24), s.matrices[1], 'without flow it still rounds to the nearest frame');
  const layer = stabilizeLayerTransform(s, 2 + .5 / 24, 960, 540, 1920, 1080, true);
  near(layer as unknown as number[], stabilizeTransform([1, 0, -2, 0, 1, 1.5], .5, 0, 0), 'the layer transform takes the blended matrix');
});

test('the warp is re-expressed for the letterboxed layer it is drawn on', () => {
  // Source pixels: translate by (-8, 6) about the frame centre.
  const identity = stabilizeTransform([1, 0, 0, 0, 1, 0], .5, 100, 20);
  assert.deepEqual(identity, [1, 0, 0, 1, 0, 0], 'an unmoved frame leaves the layer alone at any fit');
  const [a, b, c, d, e, f] = stabilizeTransform([1, 0, -8, 0, 1, 6], .5, 100, 20);
  assert.deepEqual([a, b, c, d], [1, 0, 0, 1]);
  assert.ok(Math.abs(e + 4) < 1e-9 && Math.abs(f - 3) < 1e-9, `a half-scale layer moves half as far, got ${e},${f}`);
  // A rotation must pivot about the same source point after the change of basis: the layer position of
  // the source centre is the one point the warp leaves alone when the matrix is a pure rotation about it.
  const angle = .05, [cx, cy] = [960, 540], cos = Math.cos(angle), sin = Math.sin(angle);
  const spin = [cos, -sin, cx - cos * cx + sin * cy, sin, cos, cy - sin * cx - cos * cy];
  const [ra, rb, rc, rd, re, rf] = stabilizeTransform(spin, .5, 100, 20);
  const [px, py] = [.5 * cx + 100, .5 * cy + 20];
  assert.ok(Math.abs(ra * px + rc * py + re - px) < 1e-6 && Math.abs(rb * px + rd * py + rf - py) < 1e-6, 'the source centre stays put on the layer');
});

test('a proxy is measured in the original’s pixels, not its own', () => {
  // Analysis always runs on the 4K original; playback usually shows a 1080p proxy of it. A 96-pixel
  // shift at 3840 wide has to arrive as 96/3840 of the letterboxed width whichever proxy is on screen.
  const s = solve([[1, 0, -96, 0, 1, 48]]);
  s.width = 3840; s.height = 2160;
  const layer = 960, high = stabilizeLayerTransform(s, 2, layer, 540, 1920, 1080);
  const low = stabilizeLayerTransform(s, 2, layer, 540, 960, 540);
  const full = stabilizeLayerTransform(s, 2, layer, 540, 3840, 2160);
  assert.ok(Math.abs(high[4] - low[4]) < 1e-9 && Math.abs(high[4] - full[4]) < 1e-9, `every proxy must warp identically, got ${high[4]}, ${low[4]}, ${full[4]}`);
  assert.ok(Math.abs(high[4] + 96 * layer / 3840) < 1e-9, `96 original pixels is ${96 * layer / 3840} layer pixels, got ${high[4]}`);
  assert.ok(Math.abs(high[5] - 48 * layer / 3840) < 1e-9);
  // Letterboxing still comes from what is actually on screen: a 4:3 element is pillarboxed in a 16:9 layer.
  const narrow = stabilizeLayerTransform(s, 2, layer, 540, 1440, 1080);
  assert.ok(Math.abs(narrow[4] + 96 * (1440 * (540 / 1080)) / 3840) < 1e-9, 'the fit follows the element that is drawn');
});
