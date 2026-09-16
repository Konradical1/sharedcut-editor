import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barSegments } from './renderBar.ts';

test('overlapping clips resolve to colour runs with red over yellow over green', () => {
  const segments = barSegments([
    { start: 0, end: 10, state: 'green' },
    { start: 4, end: 6, state: 'yellow' },
    { start: 5, end: 8, state: 'red' },
    { start: 12, end: 14, state: 'green' },
    { start: 14, end: 16, state: 'green' },
  ]);
  assert.deepEqual(segments, [
    { start: 0, end: 4, state: 'green' },
    { start: 4, end: 5, state: 'yellow' },
    { start: 5, end: 8, state: 'red' },
    { start: 8, end: 10, state: 'green' },
    { start: 12, end: 16, state: 'green' },
  ]);
  assert.deepEqual(barSegments([]), []);
});
