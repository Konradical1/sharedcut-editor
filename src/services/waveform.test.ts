import assert from 'node:assert/strict';
import test from 'node:test';
import { waveformBars } from './waveform.ts';

test('waveform retains transients, normalizes quiet audio, preserves silence, trims and reverses', () => {
  assert.deepEqual(waveformBars([0, .002, 0, .008], 2), [.5, 1]);
  assert.deepEqual(waveformBars([0, 0, 0], 10), Array(10).fill(0));
  assert.deepEqual(waveformBars([0, .002, 0, .008], 2, .5, 1, true), [1, 0]);
  assert.equal(waveformBars([.0001], 400).length, 400);
  assert.ok(waveformBars([.0001], 400).every(v => v === 1));
  assert.equal(waveformBars([NaN, Infinity, 0], 2).some(v => !Number.isFinite(v)), false);
});
