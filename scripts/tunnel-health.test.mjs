import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverTunnel } from './tunnel-health.mjs';

test('only restart after three failed readiness checks', async () => {
  for (const sequence of [[true], [false, true], [false, false, true], [false, false, false]]) {
    let probes = 0, restarts = 0, waits = 0;
    const restarted = await recoverTunnel(() => sequence[probes++], () => restarts++, async () => { waits++; });
    assert.equal(restarted, !sequence.includes(true));
    assert.equal(restarts, Number(restarted));
    assert.equal(probes, sequence.length);
    assert.equal(waits, sequence.length - 1);
  }
});
