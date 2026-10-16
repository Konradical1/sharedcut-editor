import assert from 'node:assert/strict';
import test from 'node:test';
import { palette } from './palette.ts';

const image = (...runs: [number, number[]][]) => Uint8ClampedArray.from(runs.flatMap(([n, rgba]) => Array.from({ length: n }, () => rgba).flat()));

test('median-cut palette: colors by population, transparent pixels skipped, near-duplicates dropped', () => {
  assert.deepEqual(palette(image([300, [255, 0, 0, 255]], [100, [0, 0, 255, 255]])), ['#ff0000', '#0000ff']);
  assert.deepEqual(palette(image([10, [250, 250, 250, 255]], [30, [20, 30, 40, 255]], [5, [252, 251, 250, 255]], [500, [0, 255, 0, 0]])), ['#141e28', '#fafafa']);
  assert.deepEqual(palette([18, 52, 86, 200]), ['#123456']);
  assert.deepEqual(palette(image([50, [9, 9, 9, 0]])), []);
  assert.deepEqual(palette([]), []);
  // Stripes scaled down: the 1% blended where they meet is no swatch.
  assert.deepEqual(palette(image([470, [179, 32, 42, 255]], [470, [241, 228, 195, 255]], [10, [212, 136, 123, 255]])).sort(), ['#b3202a', '#f1e4c3']);
  // A big photo-sized buffer is sampled, and never gives more than asked.
  const noise = new Uint8ClampedArray(1_000_000 * 4).map((_, i) => i % 4 === 3 ? 255 : (i * 2654435761) >>> 24);
  const swatches = palette(noise, 4);
  assert.ok(swatches.length >= 1 && swatches.length <= 4 && swatches.every(s => /^#[0-9a-f]{6}$/.test(s)), String(swatches));
});
