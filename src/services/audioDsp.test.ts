import assert from 'node:assert/strict';
import test from 'node:test';
import { kWeighting, loudnessWindow, responseDb, eqBiquads, type Biquad } from './audioDsp.ts';

const filter = (samples: Float64Array, stages: Biquad[]) => {
  for (const [b0, b1, b2, a1, a2] of stages) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) { const x = samples[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; samples[i] = y; }
  }
  return samples;
};
const sine = (amplitude: number, seconds: number, rate: number) => Float64Array.from({ length: seconds * rate }, (_, i) => amplitude * Math.sin(2 * Math.PI * 997 * i / rate));

test('K-weighting reproduces the BS.1770 coefficients at 48 kHz', () => {
  const [shelf, high] = kWeighting(48000);
  [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, .73248077421585].forEach((v, i) => assert.ok(Math.abs(shelf[i] - v) < 1e-7, `shelf ${i}: ${shelf[i]}`));
  [1, -2, 1, -1.99004745483398, .99007225036621].forEach((v, i) => assert.ok(Math.abs(high[i] - v) < 1e-7, `high-pass ${i}: ${high[i]}`));
});

test('a full-scale 997 Hz sine reads −3.01 LUFS momentary and short-term, at 48 and 44.1 kHz', () => {
  for (const rate of [48000, 44100]) for (const [amplitude, expected] of [[1, -3.01], [.1, -23.01]]) {
    const weighted = filter(sine(amplitude, 4, rate), kWeighting(rate)), meter = loudnessWindow(rate);
    for (let i = 0; i < weighted.length; i += 1024) { const chunk = weighted.subarray(i, i + 1024); meter.push(chunk.reduce((sum, x) => sum + x * x, 0), chunk.length, amplitude); }
    const { momentary, shortTerm, peak } = meter.read();
    assert.ok(Math.abs(momentary - expected) < .02, `${rate} Hz momentary ${momentary}`);
    assert.ok(Math.abs(shortTerm - expected) < .02, `${rate} Hz short-term ${shortTerm}`);
    assert.equal(peak, amplitude);
  }
  assert.equal(loudnessWindow(48000).read().momentary, -Infinity);
});

test('the EQ response is flat at defaults away from its bands and peaks where the export peaks', () => {
  const flat = eqBiquads(20, 0, 0, 48000);
  assert.ok(Math.abs(responseDb(flat, 1000, 48000)) < .01);
  const shaped = eqBiquads(80, 6, -4, 48000);
  assert.ok(Math.abs(responseDb(shaped, 3000, 48000) - 6) < .3, 'presence peaks at 3 kHz');
  assert.ok(Math.abs(responseDb(shaped, 80, 48000) + 3) < .2, 'the low cut is −3 dB at its corner');
  assert.ok(responseDb(shaped, 20000, 48000) < -3.5, 'air shelves the top down');
});
