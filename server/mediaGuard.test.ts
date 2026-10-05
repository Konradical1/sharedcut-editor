import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostGuard, GIB, JOB_COST_BYTES, type AdmitRequest } from './hostGuard.ts';
import { encodeCostBytes, refreshing, run } from './media.ts';
import { liveChildren, setStartGate, type StartGate } from './processTree.ts';

// run()'s opt-in hook into the host guard, the memory estimate of one encode, and the cached capability probe.
// Only short-lived node children are spawned: no ffmpeg, no Python.

function recordingGate(hold?: Promise<void>) {
  const requests: AdmitRequest[] = [], events: string[] = [];
  const gate: StartGate = {
    async admit(request) { requests.push(request); events.push('asked'); await hold; events.push('admitted'); return () => { events.push('released'); }; },
    passes: max => max,
  };
  return { requests, events, gate };
}

test('a run that opts in asks the guard first, with its cancel signal, and gives the slot back when the child exits', async () => {
  const { requests, events, gate } = recordingGate(), unset = setStartGate(gate), controller = new AbortController();
  try {
    await run(process.execPath, ['-e', ''], { signal: controller.signal, guard: { kind: 'prepare', costBytes: 1.5 * GIB, label: 'Media preparation' } });
    assert.deepEqual(events, ['asked', 'admitted', 'released']);
    assert.equal(requests[0].kind, 'prepare');
    assert.equal(requests[0].costBytes, 1.5 * GIB);
    assert.equal(requests[0].label, 'Media preparation');
    assert.equal(requests[0].signal, controller.signal);
  } finally { unset(); }
});

test('the slot is released when the child fails, and a run that does not opt in never asks', async () => {
  const { events, gate } = recordingGate(), unset = setStartGate(gate);
  try {
    await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)'], { guard: { kind: 'export', costBytes: JOB_COST_BYTES.renderPass } }), /Media processing failed/);
    assert.deepEqual(events, ['asked', 'admitted', 'released']);
    events.length = 0;
    await run(process.execPath, ['-e', '']);
    assert.deepEqual(events, [], 'ffprobe, -version and stream copies pass no guard and are never held');
  } finally { unset(); }
});

test('nothing starts while the guard holds the run, and cancelling the wait ends it as cancelled', async () => {
  const guard = createHostGuard({ sample: () => ({ availableBytes: 1 * GIB, commitHeadroomBytes: null }), envMode: 'enforce', log: () => undefined });
  const unset = setStartGate(guard), before = liveChildren(), controller = new AbortController();
  try {
    const waiting = run(process.execPath, ['-e', ''], { signal: controller.signal, guard: { kind: 'export', costBytes: JOB_COST_BYTES.renderPass } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(guard.snapshot().queued, 1, 'held for memory');
    assert.equal(liveChildren(), before, 'a waiting job holds no memory: no child exists yet');
    controller.abort();
    await assert.rejects(waiting, /Canceled by you/);
    assert.equal(guard.snapshot().queued, 0);
  } finally { unset(); guard.stop(); }
});

test('a refused admission fails the run and nothing is spawned', async () => {
  const before = liveChildren();
  const unset = setStartGate({ admit: () => Promise.reject(Object.assign(new Error('Low memory for too long.'), { code: 'HOST_MEMORY_WAIT' })), passes: max => max });
  try {
    await assert.rejects(run(process.execPath, ['-e', ''], { guard: { kind: 'prepare', costBytes: JOB_COST_BYTES.prepare } }), /Low memory for too long\./);
    assert.equal(liveChildren(), before);
  } finally { unset(); }
});

test('an encode that opens video decoders costs the measured 4K pass, one that opens none a sound-sized step', () => {
  assert.equal(encodeCostBytes(0), JOB_COST_BYTES.soundStem);
  assert.equal(encodeCostBytes(1), JOB_COST_BYTES.renderPass);
  assert.equal(encodeCostBytes(6), JOB_COST_BYTES.renderPass);
});

test('refreshing answers from the last result inside its lifetime and reads once', async () => {
  let clock = 0, reads = 0;
  const probe = refreshing(async () => ++reads, 60_000, () => clock);
  assert.equal(await probe(), 1);
  clock = 59_999;
  assert.equal(await probe(), 1);
  assert.equal(reads, 1);
});

test('a stale result is served at once while one refresh runs in the background', async () => {
  let clock = 0, reads = 0, finish!: () => void;
  const probe = refreshing(() => new Promise<number>(resolve => { const value = ++reads; if (value === 1) resolve(value); else finish = () => resolve(value); }), 60_000, () => clock);
  assert.equal(await probe(), 1);
  clock = 60_000;
  assert.equal(await probe(), 1, 'the slow refresh is not waited for');
  assert.equal(await probe(), 1, 'nor started a second time');
  assert.equal(reads, 2);
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await probe(), 2, 'the next caller sees the refreshed answer');
});

test('the first call waits for the probe, and a failed first read can be tried again', async () => {
  let reads = 0;
  const probe = refreshing(async () => { if (++reads === 1) throw new Error('not yet'); return reads; }, 1_000);
  await assert.rejects(probe(), /not yet/);
  assert.equal(await probe(), 2);
});

test('a failed refresh keeps serving the old answer and raises nothing unhandled', async () => {
  let clock = 0, reads = 0;
  const unhandled: unknown[] = [], note = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', note);
  try {
    const probe = refreshing(async () => { if (++reads === 2) throw new Error('refresh failed'); return reads; }, 100, () => clock);
    assert.equal(await probe(), 1);
    clock = 200;
    assert.equal(await probe(), 1, 'stale answer while the refresh fails');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await probe(), 1, 'still the old answer, and this call starts another refresh');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await probe(), 3, 'the failure was dropped and the later refresh landed');
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', note); }
});
