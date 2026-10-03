import test from 'node:test';
import assert from 'node:assert/strict';
import { depthCoc, depthTapBudget, depthTaps, glowWeights } from './depthFx.ts';

test('tap budget: 16 / 32 / 48 by preview quality, half again while paused', () => {
  assert.deepEqual(['1/4', 'Stream', '1/2', 'Full', 'Color'].map(q => depthTapBudget(q, false, true)), [16, 32, 32, 48, 48]);
  assert.equal(depthTapBudget('1/4', true, true), 48, 'original media decodes at full quality');
  assert.deepEqual(['1/4', 'Stream', 'Full'].map(q => depthTapBudget(q, false, false)), [24, 48, 72]);
});

test('gather taps follow the spec sequence exactly: r from RS by RS/r, golden-angle steps, about N of them', () => {
  // Rb never passes .025 × 960 = 24 working pixels, so RS stays well under Rb for every preview budget.
  for (const [Rb, N] of [[24, 48], [24, 32], [12, 16], [24, 72], [24, 96]]) {
    const taps = depthTaps(Rb, N), RS = Math.max(.5, Rb * Rb / (2 * N));
    let r = RS, ang = 0;
    for (const [dx, dy, radius] of taps) {
      assert.ok(Math.abs(radius - r) < 1e-12 && Math.abs(dx - Math.cos(ang) * r) < 1e-12 && Math.abs(dy - Math.sin(ang) * r) < 1e-12);
      assert.ok(radius < Rb);
      ang += 2.39996323; r += RS / r;
    }
    assert.ok(r >= Rb, 'the sequence runs until r reaches Rb');
    assert.ok(taps.length <= N && taps.length >= .8 * N, `Rb ${Rb}, N ${N}: ${taps.length} taps`);
  }
  assert.equal(depthTaps(24, 48).length, 45, 'the parity budget at the largest preview radius');
  assert.deepEqual(depthTaps(.9, 48), [], 'Rb < 1 skips the gather');
  const small = depthTaps(3, 48);
  assert.equal(small[0][2], .5, 'RS never drops below half a pixel');
  assert.ok(small.length < 48);
});

test('circle of confusion: zero inside the depth-of-field band, ramps over .35, foreground scaled by Foreground blur', () => {
  const p = { blur: 100, focus: 30, range: 10, nearBlur: 60 }, W = 1920, R = .025 * W;
  assert.equal(depthCoc(.3, p, W), 0);
  assert.equal(depthCoc(.34, p, W), 0, 'within band = range/100 × .5 of Focus');
  assert.ok(Math.abs(depthCoc(.3 + .05 + .175, p, W) - R / 2) < 1e-9, 'half way up the ramp');
  assert.equal(depthCoc(1, p, W), R, 'far: full radius');
  assert.ok(Math.abs(depthCoc(0, { ...p, focus: 70 }, W) - R * .6) < 1e-9, 'near: × nearBlur');
  assert.equal(depthCoc(1, { ...p, blur: 0 }, W), 0);
  assert.equal(depthCoc(.9, { ...p, blur: 50 }, 960), .5 * .025 * 960);
});

test('glow weights: normalised, truncated at 3σ, a lone tap for tiny radii', () => {
  for (const sigma of [.2, 1, 4.5, 19.2]) {
    const weights = glowWeights(sigma);
    assert.equal(weights.length - 1, Math.floor(3 * sigma));
    assert.ok(Math.abs(weights.reduce((sum, w, i) => sum + (i ? 2 * w : w), 0) - 1) < 1e-12);
    assert.ok(weights.every((w, i) => !i || w < weights[i - 1]));
  }
  assert.deepEqual(glowWeights(.2), [1]);
});
