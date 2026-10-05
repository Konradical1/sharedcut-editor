import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from './backoff.ts';

const none = () => 0, nearOne = () => 0.999999;

test('the delay doubles from the base and stops at the cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(attempt => backoffDelay(attempt, 2000, 15000, 0.25, none)), [2000, 4000, 8000, 15000, 15000, 15000]);
});

test('jitter only ever shortens a delay, so the cap is a hard ceiling', () => {
  for (const attempt of [0, 1, 5, 40]) {
    const longest = backoffDelay(attempt, 2000, 15000, 0.25, none), shortest = backoffDelay(attempt, 2000, 15000, 0.25, nearOne);
    assert.ok(shortest >= longest * 0.75 - 1 && shortest <= longest, `attempt ${attempt}: ${shortest} vs ${longest}`);
    assert.ok(longest <= 15000);
  }
});

test('a huge or invalid attempt count cannot overflow into a zero, negative or infinite wait', () => {
  for (const attempt of [1e6, Infinity, -3, NaN]) {
    const delay = backoffDelay(attempt, 1000, 60000, 0.25, none);
    assert.ok(Number.isFinite(delay) && delay >= 1000 && delay <= 60000, `attempt ${attempt} gave ${delay}`);
  }
});

test('without jitter the schedule is exact, and the default random source stays inside the band', () => {
  assert.equal(backoffDelay(2, 1000, 60000, 0, nearOne), 4000);
  for (let i = 0; i < 50; i++) {
    const delay = backoffDelay(3, 1000, 60000);
    assert.ok(delay >= 6000 && delay <= 8000, `${delay}`);
  }
});
