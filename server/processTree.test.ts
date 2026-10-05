import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { createHostGuard, GIB, JOB_COST_BYTES, type AdmitRequest } from './hostGuard.ts';
import { admitStart, exportPassCount, liveChildren, runWorkerProcess, setStartGate, trackChild, workerCost, type StartGate } from './processTree.ts';

// Facts the host guard hook rests on: every importer of runWorkerProcess (depth, motionTracker, opticalFlow, stabilize,
// smartMask, colorAssistant) keeps its signature, and nothing here spawns ffmpeg or Python, only short-lived node children.

const quickWorker = ['-e', "console.log(JSON.stringify({ progress: 50 })); console.log('done')"];

type Recorded = { requests: AdmitRequest[]; events: string[]; gate: StartGate; open: () => void };

/** A gate that holds every start until `open()`, and records what it was asked. */
function holdingGate(): Recorded {
  const requests: AdmitRequest[] = [], events: string[] = [];
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  const gate: StartGate = {
    async admit(request) { requests.push(request); events.push('asked'); await opened; events.push('admitted'); return () => { events.push('released'); }; },
    passes: (max, cost) => Math.max(1, Math.min(max, Math.floor((8 * GIB) / cost))),
  };
  return { requests, events, gate, open };
}

test('workerCost prices the heavy Python workers by name and leaves probes, checks and unknown workers free', () => {
  assert.equal(workerCost('python', ['worker.py', 'job.json'], 'Depth'), JOB_COST_BYTES.depth);
  assert.equal(workerCost('python', ['worker.py', 'job.json'], 'Optical flow'), JOB_COST_BYTES.flow);
  assert.equal(workerCost('python', ['worker.py', 'job.json'], 'Stabilize'), JOB_COST_BYTES.stabilize);
  assert.equal(workerCost('python', ['worker.py', 'job.json'], 'Motion tracker'), JOB_COST_BYTES.tracker);
  assert.equal(workerCost('python', ['worker.py', 'job.json'], 'Smart Mask'), JOB_COST_BYTES.smartMask);
  assert.equal(workerCost('python', ['worker.py', '--check'], 'Depth'), 0, 'a --check probe is never held, or a missing feature would look broken under memory pressure');
  assert.equal(workerCost(join('tools', 'ffprobe.exe'), ['-v', 'error', 'x.mp4'], 'Smart Mask'), 0, 'Smart Mask runs ffprobe through the same function');
  assert.equal(workerCost(join('usr', 'bin', 'ffmpeg'), ['-i', 'x'], 'Smart Mask'), 0);
  assert.equal(workerCost(join('ff', 'ffprobe-7.1.exe'), ['x'], 'Smart Mask'), 0, 'a renamed FFPROBE_PATH is still a probe');
  assert.equal(workerCost('python', ['worker.py', 'measure', 'x.json'], 'Color Assistant'), 0, 'not estimated yet, so not gated');
  assert.equal(workerCost('python', ['x.py'], 'Worker'), 0);
});

test('a heavy worker asks the gate first, spawns only once it is admitted, and gives the slot back when it ends', async () => {
  const { requests, events, gate, open } = holdingGate(), unset = setStartGate(gate);
  try {
    const before = liveChildren();
    const controller = new AbortController();
    const finished = runWorkerProcess(process.execPath, quickWorker, controller.signal, undefined, 'Depth');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(events, ['asked'], 'the worker waits for permission');
    assert.equal(liveChildren(), before, 'nothing is spawned while it waits, so a waiting job holds no memory');
    assert.equal(requests[0].kind, 'ai');
    assert.equal(requests[0].costBytes, JOB_COST_BYTES.depth);
    assert.equal(requests[0].label, 'Depth');
    assert.equal(requests[0].signal, controller.signal, 'cancelling the job also cancels its wait');
    open();
    assert.match(await finished, /done/);
    assert.deepEqual(events, ['asked', 'admitted', 'released']);
    assert.equal(liveChildren(), before, 'the child is counted while alive and forgotten when it closes');
  } finally { unset(); }
});

test('the slot is released when the worker fails', async () => {
  const { events, gate, open } = holdingGate(), unset = setStartGate(gate);
  open();
  try {
    await assert.rejects(runWorkerProcess(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)'], undefined, undefined, 'Stabilize'), /boom/);
    assert.deepEqual(events, ['asked', 'admitted', 'released']);
  } finally { unset(); }
});

test('a --check probe, an unknown worker and a run with no gate start at once without asking', async () => {
  const { events, gate } = holdingGate(), unset = setStartGate(gate);
  try {
    assert.match(await runWorkerProcess(process.execPath, [...quickWorker, '--', '--check'], undefined, undefined, 'Depth'), /done/);
    assert.match(await runWorkerProcess(process.execPath, quickWorker, undefined, undefined, 'Worker'), /done/);
    assert.deepEqual(events, [], 'the gate was never consulted');
  } finally { unset(); }
  assert.match(await runWorkerProcess(process.execPath, quickWorker, undefined, undefined, 'Depth'), /done/, 'no guard installed: starts at once');
});

test('a refused or failed admission fails the job without spawning anything', async () => {
  const before = liveChildren();
  const gate: StartGate = { admit: () => Promise.reject(Object.assign(new Error('Out of memory for too long.'), { code: 'HOST_MEMORY_WAIT' })), passes: max => max };
  const unset = setStartGate(gate);
  try {
    await assert.rejects(runWorkerProcess(process.execPath, quickWorker, undefined, undefined, 'Optical flow'), (error: Error & { code?: string }) => error.code === 'HOST_MEMORY_WAIT' && /Out of memory/.test(error.message));
    assert.equal(liveChildren(), before);
  } finally { unset(); }
});

test('cancelling a worker that waits for memory under the real guard ends it as cancelled, with nothing spawned', async () => {
  const guard = createHostGuard({ sample: () => ({ availableBytes: 1 * GIB, commitHeadroomBytes: null }), envMode: 'enforce', log: () => undefined });
  const unset = setStartGate(guard), before = liveChildren();
  try {
    const controller = new AbortController();
    const waiting = runWorkerProcess(process.execPath, quickWorker, controller.signal, undefined, 'Smart Mask');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(guard.snapshot().queued, 1, 'the job is waiting for memory');
    controller.abort();
    await assert.rejects(waiting, /Smart Mask cancelled\./);
    assert.equal(guard.snapshot().queued, 0, 'the cancelled job left the line');
    assert.equal(liveChildren(), before);
  } finally { unset(); guard.stop(); }
});

test('an already cancelled worker never reaches the gate', async () => {
  const { events, gate } = holdingGate(), unset = setStartGate(gate);
  try {
    await assert.rejects(runWorkerProcess(process.execPath, quickWorker, AbortSignal.abort(), undefined, 'Depth'), /Depth cancelled\./);
    assert.deepEqual(events, []);
  } finally { unset(); }
});

test('exportPassCount follows the installed gate and is the ceiling when there is none', () => {
  assert.equal(exportPassCount(3, JOB_COST_BYTES.renderPass), 3);
  const unset = setStartGate({ admit: () => Promise.resolve(() => undefined), passes: () => 1 });
  try { assert.equal(exportPassCount(3, JOB_COST_BYTES.renderPass), 1); } finally { unset(); }
  assert.equal(exportPassCount(3, JOB_COST_BYTES.renderPass), 3);
});

test('admitStart answers at once with a no-op release when no gate is installed', async () => {
  const release = await admitStart({ kind: 'export', costBytes: 2 * GIB });
  assert.doesNotThrow(() => release());
});

test('an older gate does not clear a newer one when it is removed', () => {
  const first = { admit: () => Promise.resolve(() => undefined), passes: () => 1 } satisfies StartGate;
  const second = { admit: () => Promise.resolve(() => undefined), passes: () => 2 } satisfies StartGate;
  const unsetFirst = setStartGate(first), unsetSecond = setStartGate(second);
  try {
    unsetFirst();
    assert.equal(exportPassCount(3, 1), 2, 'the second gate is still installed');
  } finally { unsetSecond(); }
  assert.equal(exportPassCount(3, 1), 3);
});

test('trackChild counts a child while it lives, once, even if it both errors and closes', async () => {
  const before = liveChildren();
  const missing = spawn('this-program-does-not-exist-frameline', [], { stdio: 'ignore' });
  trackChild(missing);
  assert.equal(liveChildren(), before + 1);
  const gone = new Promise<void>(resolve => missing.once('close', () => resolve()).once('error', () => setTimeout(resolve, 50)));
  missing.on('error', () => undefined);
  await gone;
  assert.equal(liveChildren(), before, 'forgotten once, never counted below the starting number');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  trackChild(child);
  assert.equal(liveChildren(), before + 1);
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  assert.equal(liveChildren(), before);
});
