import test from 'node:test';
import assert from 'node:assert/strict';
import { headline, realtimeFactor } from './playbackHeadline.mjs';

const pass = { pass: 0, advancedSeconds: 23.43, wallSeconds: 30, renderedPerSec: 15.6, loadingPct: 21.8, longestLoadingMs: 253, picturesPerSec: 0.9 };

test('realtime factor is timeline seconds played per wall second', () => {
  assert.equal(realtimeFactor(pass).toFixed(2), '0.78');
  assert.equal(realtimeFactor({ ...pass, advancedSeconds: 30 }), 1);
});

test('realtime factor never goes negative and survives a pass with no wall time', () => {
  assert.equal(realtimeFactor({ ...pass, advancedSeconds: -2 }), 0);
  assert.equal(realtimeFactor({ ...pass, wallSeconds: 0 }), 0);
});

test('the headline line names the four numbers that judge a pass', () => {
  assert.equal(headline(pass), 'pass 0: realtime 0.78 (23.43s of 30s) | rendered 15.6/s | loading 21.8% | longest wait 253 ms | pictures 0.9/s');
});
