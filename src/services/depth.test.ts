import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_SEGMENT, depthAnalysisSize, depthDistance, depthFrameAt, depthRange, depthSegmentFor, depthValue } from './depth.ts';

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
