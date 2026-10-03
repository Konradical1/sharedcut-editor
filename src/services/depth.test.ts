import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_SEGMENT, depthAnalysisSize, depthDistance, depthFrameAt, depthKeyAlpha, depthKeyTable, depthRange, depthSegmentFor, depthValue } from './depth.ts';
import { activeDepthKeys, nodeMaskId, validateNodeMask, validateSmartMaskBindings, type DepthKeyBinding } from './smartMask.ts';
import type { Clip, GradeNode } from '../state/models.ts';

test('analysis size: short side 518, multiples of 14, narrower beyond 16:9', () => {
  assert.deepEqual(depthAnalysisSize(1920, 1080), { width: 924, height: 518 });
  assert.deepEqual(depthAnalysisSize(3840, 2160), { width: 924, height: 518 });
  assert.deepEqual(depthAnalysisSize(1080, 1920), { width: 518, height: 924 });
  assert.deepEqual(depthAnalysisSize(1000, 1000), { width: 518, height: 518 });
  const scope = depthAnalysisSize(4096, 1716);
  assert.ok(scope.height < 518 && scope.width % 14 === 0 && scope.height % 14 === 0 && scope.width * scope.height <= 924 * 518 * 1.05);
  assert.throws(() => depthAnalysisSize(0, 1080));
});

test('range adds handles, snaps to the segment grid and clamps to the source', () => {
  const times = Array.from({ length: 1000 }, (_, i) => i / 25);
  // 10 s..12 s at 25 fps reads frames 250..299; handles widen to 225..324; the grid to 192..383.
  assert.deepEqual(depthRange(times, 10, 12), { first: 192, frames: 192 });
  assert.deepEqual(depthRange(times, 0, .5), { first: 0, frames: 64 });
  assert.deepEqual(depthRange(times, 38, 40), { first: 896, frames: 104 });
  // A range ending exactly on a frame boundary does not pull in the frame that starts there.
  assert.deepEqual(depthRange(times, 0, 64 / 25 - 1), { first: 0, frames: 64 });
  assert.throws(() => depthRange(times, 5, 5));
  assert.throws(() => depthRange([], 0, 1));
});

test('frame and segment lookup use the run timestamps, not a nominal rate', () => {
  // Variable frame timing: a frame index must come from the table, never from time × fps.
  const times = [0, .04, .1, .12, .2];
  const run = { first: 128, frames: 5, times, segments: [{ n: 0, first: 128, count: 5 }] };
  assert.equal(depthFrameAt(run, 0), 128);
  assert.equal(depthFrameAt(run, .099), 129);
  assert.equal(depthFrameAt(run, .1), 130);
  assert.equal(depthFrameAt(run, .27), 132);
  assert.equal(depthFrameAt(run, .28), -1);
  assert.equal(depthFrameAt(run, -.01), -1);
  assert.equal(depthFrameAt({ first: 0, frames: 1, times: [0] }, 99), 0);
  assert.deepEqual(depthSegmentFor(run, 130), { segment: run.segments[0], offset: 2 });
  assert.equal(depthSegmentFor(run, 127), undefined);
  const long = { first: 64, frames: 3 * DEPTH_SEGMENT, segments: [{ n: 0, first: 64, count: 64 }, { n: 1, first: 128, count: 64 }] };
  assert.deepEqual(depthSegmentFor(long, 191), { segment: long.segments[1], offset: 63 });
  assert.equal(depthSegmentFor(long, 192), undefined, 'segment 2 is not recorded yet');
});

test('distance maps the run near/far values to 0..100 and back', () => {
  const run = { near: 5 / 6, far: 1 / 6 };
  assert.equal(depthDistance(run, 5 / 6), 0);
  assert.equal(Math.round(depthDistance(run, 1 / 6)), 100);
  assert.equal(depthDistance(run, 1), 0);
  assert.equal(depthDistance(run, 0), 100);
  assert.ok(Math.abs(depthDistance(run, depthValue(run, 37)) - 37) < 1e-9);
  assert.ok(depthDistance(run, .6) > depthDistance(run, .7), 'larger values are nearer');
});

test('presets: six named looks, every value a real Depth parameter inside its range, Focus left to the clip', async () => {
  const { depthPresets } = await import('./depth.ts'), { effectDefinitions } = await import('./effects.ts');
  const parameters = new Map(effectDefinitions.Depth.parameters.map(p => [p.key, p]));
  assert.deepEqual(depthPresets.map(p => p.name), ['Portrait', 'Cinematic haze', 'Morning mist', 'Dreamy glow', 'Subject pop', 'Miniature']);
  for (const preset of depthPresets) {
    assert.ok(Object.keys(preset.values).length, preset.name);
    assert.ok(!('focus' in preset.values) && !('amount' in preset.values), `${preset.name} leaves Focus and Mix alone`);
    for (const [key, value] of Object.entries(preset.values)) {
      const p = parameters.get(key);
      assert.ok(p && Number.isFinite(value) && value >= p.min && value <= p.max, `${preset.name}.${key} = ${value}`);
    }
  }
  const pop = depthPresets.find(p => p.name === 'Subject pop')!.values;
  assert.ok(pop.bgExposure < 0 && pop.bgWarmth < 0 && pop.blur > 0 && pop.blur <= 25, 'Subject pop: background darker and cooler, slight blur');
  const mini = depthPresets.find(p => p.name === 'Miniature')!.values;
  assert.ok(mini.nearBlur === 100 && mini.range <= 10 && mini.blur >= 50, 'Miniature: a thin focus slice, both sides blurred');
});

test('depth key: 1 inside [near, far], smooth edges of width softness outside it, and the same table for preview and export', () => {
  const key = { near: 40, far: 70, softness: 10 };
  for (const d of [40, 55, 70]) assert.equal(depthKeyAlpha(key, d), 1);
  for (const d of [0, 30, 80, 100]) assert.equal(depthKeyAlpha(key, d), 0);
  assert.equal(depthKeyAlpha(key, 35), .5);
  assert.equal(depthKeyAlpha(key, 75), .5);
  assert.ok(depthKeyAlpha(key, 32) < depthKeyAlpha(key, 34) && depthKeyAlpha(key, 76) > depthKeyAlpha(key, 78), 'edges ramp monotonically');
  // The ends of the scale key everything; softness 0 is a hard edge.
  for (const d of [0, 50, 100]) assert.equal(depthKeyAlpha({ near: 0, far: 100, softness: 25 }, d), 1);
  assert.deepEqual([49.9, 50, 70, 70.1].map(d => depthKeyAlpha({ near: 50, far: 70, softness: 0 }, d)), [0, 1, 1, 0]);
  // Stored value 0.8 is distance 0 and 0.2 is 100; codes follow v = code / (levels - 1), clamped outside the run.
  const run = { near: .8, far: .2 }, far = { near: 50, far: 100, softness: 5 }, eight = depthKeyTable(run, far, 256), ten = depthKeyTable(run, far, 1024);
  assert.equal(eight.length, 256); assert.equal(ten.length, 1024);
  assert.equal(eight[255], 0); assert.equal(eight[0], 1); assert.equal(ten[Math.round(.2 * 1023)], 1);
  assert.equal(ten[Math.round(.5 * 1023)], Math.fround(depthKeyAlpha(far, depthDistance(run, Math.round(.5 * 1023) / 1023))));
  // Both tables sample the one key function; they differ only by the depth codes they are read at.
  for (let code = 0; code < 256; code++) assert.equal(eight[code], Math.fround(depthKeyAlpha(far, depthDistance(run, code / 255))), `code ${code}`);
});

test('depth key binding: validated at the boundary, keyed by node, active only when it changes the picture', () => {
  const mask: DepthKeyBinding = { source: 'depth', enabled: true, invert: false, amount: 100, near: 50, far: 100, softness: 10 };
  validateNodeMask(mask);
  for (const bad of [{ ...mask, far: 40 }, { ...mask, near: -1 }, { ...mask, softness: 101 }, { ...mask, amount: Number.NaN }, { ...mask, id: 'subject' }, { ...mask, enabled: 'yes' }])
    assert.throws(() => validateNodeMask(bad), /Invalid depth key/);
  validateNodeMask({ id: 'subject', enabled: true, invert: false, amount: 100 });
  const clip = { id: 'clip', mediaId: 'media', effects: [], properties: {} } as unknown as Clip;
  const node = { id: 'n1', clipId: 'clip', enabled: true, mask } as GradeNode;
  // A depth key needs no subject on the clip, unlike a Smart Mask binding; a CST still has to stay unmasked.
  validateSmartMaskBindings(clip, [node]);
  assert.throws(() => validateSmartMaskBindings(clip, [{ ...node, mask: { id: 'missing', enabled: true, invert: false, amount: 100 } }]), /missing smart mask/);
  assert.throws(() => validateSmartMaskBindings(clip, [{ ...node, effects: [{ id: 'cst', type: 'cst', enabled: true } as never] }]), /color-space/);
  assert.equal(nodeMaskId(node), 'depth:n1');
  assert.deepEqual(activeDepthKeys(clip, [node, { ...node, id: 'off', enabled: false }, { ...node, id: 'zero', mask: { ...mask, amount: 0 } }, { ...node, id: 'other', clipId: 'x' }]).map(n => n.id), ['n1']);
});
