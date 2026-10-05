import test from 'node:test';
import assert from 'node:assert/strict';
import { createCopyProbe } from './copyProbe.ts';

test('an empty probe reads zeros', () => {
  assert.deepEqual(createCopyProbe().read(), { copies: 0, demandCopies: 0, waits: 0, demandWaits: 0, copyMsP50: 0, copyMsP95: 0, copyMsMax: 0 });
});

test('copies, waits and the demand share are counted, with median, 95th percentile and worst copy time', () => {
  const probe = createCopyProbe();
  for (let ms = 1; ms <= 100; ms++) probe.copied(ms, ms % 4 === 0);
  probe.waited(true); probe.waited(false); probe.waited(false);
  const reading = probe.read();
  assert.equal(reading.copies, 100);
  assert.equal(reading.demandCopies, 25);
  assert.equal(reading.waits, 3);
  assert.equal(reading.demandWaits, 1);
  assert.equal(reading.copyMsP50, 51);
  assert.equal(reading.copyMsP95, 96);
  assert.equal(reading.copyMsMax, 100);
});

test('reading with reset starts a new count, and a plain read leaves the count alone', () => {
  const probe = createCopyProbe();
  probe.copied(10, false); probe.waited(false);
  assert.equal(probe.read().copies, 1);
  assert.equal(probe.read(true).copies, 1, 'the reset read still returns what was counted');
  assert.deepEqual(probe.read(), { copies: 0, demandCopies: 0, waits: 0, demandWaits: 0, copyMsP50: 0, copyMsP95: 0, copyMsMax: 0 });
});

test('only the most recent copy times are kept, so a long session cannot grow the probe', () => {
  const probe = createCopyProbe();
  for (let i = 0; i < 5000; i++) probe.copied(i < 3500 ? 1000 : 5, false);
  const reading = probe.read();
  assert.equal(reading.copies, 5000, 'the counter is not capped');
  assert.equal(reading.copyMsMax, 1000, 'the retained window still holds some old samples at the cut-off');
  assert.equal(reading.copyMsP50, 5, 'but most of it is recent');
});
