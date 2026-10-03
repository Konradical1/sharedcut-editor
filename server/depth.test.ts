import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { depthService } from './depth.ts';
import { smartMaskService } from './smartMask.ts';
import { createFrameLineServer } from './index.ts';
import { run } from './media.ts';
import { defaultShape } from '../src/services/shapes.ts';
import type { Clip, MediaAsset } from '../src/state/models.ts';

const asset = { id: 'media', projectId: 'project', kind: 'video', duration: 20, fps: 25, resolution: '1920 × 1080', inputProfile: 'Rec.709' } as MediaAsset;
const clip = (id: string, projectId = 'project') => ({ id, projectId, mediaId: 'media', sourceIn: 0, start: 0, duration: 1, properties: {}, effects: [] }) as unknown as Clip;
const times = Array.from({ length: 500 }, (_, i) => i / 25);

/** A stand-in for scripts/depth.py: same arguments, JSON lines and files, no model. */
function fakeWorker(directory: string, behaviour: { gate?: string; grandchild?: string; bytes?: number; device?: string } = {}) {
  const path = join(directory, 'fake-depth.cjs');
  writeFileSync(path, `
const fs = require('node:fs'), path = require('node:path');
const say = value => console.log(JSON.stringify(value));
if (process.argv[2] === '--check') { say({ available: true, engine: 'Fake', device: ${JSON.stringify(behaviour.device ?? 'cpu')}, workerIdentity: { engine: 'fake' } }); process.exit(0); }
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.appendFileSync(${JSON.stringify(join(directory, 'runs.log'))}, job.first + ':' + job.frames + '\\n');
${behaviour.grandchild ? `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(behaviour.grandchild)},'ran'),1200);setInterval(()=>{},1000)`)}], { stdio: 'ignore' });` : ''}
const mapping = { lo: -1, hi: 5, near: 5 / 6, far: 1 / 6 }, segments = [];
say({ mapping });
for (const name of ['preview', 'master']) fs.mkdirSync(path.join(job.output, name), { recursive: true });
const wait = file => new Promise(resolve => { const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); resolve(); } }, 20); });
(async () => {
  for (let n = 0; n * 64 < job.frames; n++) {
    const segment = { n, first: job.first + n * 64, count: Math.min(64, job.frames - n * 64) };
    fs.writeFileSync(path.join(job.output, 'preview', n + '.mp4'), Buffer.alloc(${behaviour.bytes ?? 100}, 1));
    fs.writeFileSync(path.join(job.output, 'master', n + '.mkv'), Buffer.alloc(${behaviour.bytes ?? 100}, 2));
    segments.push(segment); say({ segment: n, first: segment.first, count: segment.count }); say({ progress: 50 });
    ${behaviour.gate ? `if (n === 0) await wait(${JSON.stringify(behaviour.gate)});` : ''}
    ${behaviour.grandchild ? 'await new Promise(() => setInterval(() => {}, 1000));' : ''}
  }
  fs.writeFileSync(path.join(job.output, 'manifest.json'), JSON.stringify({ version: 1, key: job.key, engine: 'Fake', workerIdentity: job.workerIdentity, width: job.width, height: job.height, first: job.first, frames: job.frames, segments, ...mapping }));
})();
`);
  return path;
}
function fixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `frameline-depth-${name}-`)), source = join(directory, 'original');
  writeFileSync(source, 'immutable source');
  return { directory, source, cache: join(directory, 'cache') };
}
const until = async (check: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out.'); await delay(10); } };
const runs = (directory: string) => existsSync(join(directory, 'runs.log')) ? readFileSync(join(directory, 'runs.log'), 'utf8').trim().split('\n') : [];

test('two clips of one take share a run; a ready run covering the range is reused, others get their own', async () => {
  const f = fixture('reuse'), service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory), sourceTimes: async () => times });
  try {
    const first = await service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 4, to: 8 });
    // 4..8 s at 25 fps with 1 s handles is frames 75..224, snapped to 64..255.
    assert.deepEqual([first.first, first.frames, first.width, first.height, first.times.length], [64, 192, 924, 518, 192]);
    await until(() => service.get('project', first.key).status === 'ready');
    const split = await service.enqueue({ clip: clip('b'), asset, sourcePath: f.source, from: 5, to: 7 });
    assert.equal(split.key, first.key); assert.equal(split.status, 'ready');
    // A viewer or reviewer joins a covering run but never starts one.
    assert.equal((await service.enqueue({ clip: clip('v'), asset, sourcePath: f.source, from: 5, to: 7, joinOnly: true })).key, first.key);
    await assert.rejects(service.enqueue({ clip: clip('v'), asset, sourcePath: f.source, from: 15, to: 16, joinOnly: true }), (error: Error & { status?: number }) => error.status === 409 && /editor/.test(error.message));
    const later = await service.enqueue({ clip: clip('c'), asset, sourcePath: f.source, from: 15, to: 18 });
    assert.notEqual(later.key, first.key);
    await until(() => service.get('project', later.key).status === 'ready');
    assert.deepEqual(runs(f.directory), ['64:192', '320:180']);
    // A different analysis look is a different run.
    const graded = await service.enqueue({ clip: { ...clip('d'), properties: { inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } }, asset, sourcePath: f.source, from: 5, to: 7 });
    assert.notEqual(graded.key, first.key);
    // Another project only reaches a run through its own clip of the same source.
    assert.throws(() => service.get('other', first.key), /not found/);
  } finally { await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('segments are served once recorded, by cursor, and only to projects bound to the run', async () => {
  const f = fixture('partial'), gate = join(f.directory, 'gate');
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory, { gate }), sourceTimes: async () => times });
  try {
    const job = await service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 0, to: 3 });
    assert.equal(job.frames, 128);
    await until(() => service.get('project', job.key).segments.length === 1);
    const running = service.get('project', job.key);
    assert.deepEqual(Object.keys(running).sort(), ['far', 'first', 'frames', 'height', 'hi', 'key', 'lo', 'mediaId', 'near', 'next', 'progress', 'segments', 'status', 'times', 'width'], 'nothing server-side (projects, base, used, bytes) leaks');
    assert.equal(service.get('project', job.key, 99).times.length, 128, 'a cursor past the end is from an earlier run of the key and starts over');
    assert.deepEqual(service.get('project', job.key, 0, false).times, [], 'a poller that has the times does not get them again');
    assert.equal(running.status, 'processing'); assert.equal(running.next, 1); assert.equal(running.lo, -1); assert.equal(running.near, 5 / 6);
    assert.equal(readFileSync(service.preview('project', job.key, 0))[0], 1);
    assert.throws(() => service.preview('project', job.key, 1), /not found/, 'an unrecorded segment is not served');
    assert.throws(() => service.preview('other', job.key, 0), /not found/, 'another project cannot read it');
    assert.deepEqual(service.get('project', job.key, 1).segments, []);
    writeFileSync(gate, '');
    await until(() => service.get('project', job.key).status === 'ready');
    const tail = service.get('project', job.key, 1);
    assert.deepEqual(tail.segments, [{ n: 1, first: 64, count: 64 }]); assert.equal(tail.next, 2); assert.deepEqual(tail.times, []);
    assert.equal(service.get('project', job.key).times.length, 128);
    assert.equal(readFileSync(service.preview('project', job.key, 1))[0], 1, 'segments stay at the same address once committed');
    assert.throws(() => service.preview('project', job.key, 2), /not found/);
    assert.ok(existsSync(join(f.cache, job.key, 'manifest.json')));
    assert.equal(readdirSync(f.cache).filter(name => name.startsWith('.partial-')).length, 0);
  } finally { writeFileSync(gate, ''); await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('cancelling a running analysis kills the worker and its children', async () => {
  const f = fixture('cancel'), marker = join(f.directory, 'grandchild-finished');
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory, { grandchild: marker }), sourceTimes: async () => times });
  try {
    const job = await service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 0, to: 3 });
    await until(() => service.get('project', job.key).segments.length === 1);
    assert.throws(() => service.cancel('other', job.key), /not found/);
    service.cancel('project', job.key);
    assert.equal(service.get('project', job.key).status, 'cancelled');
    await delay(1500);
    assert.equal(existsSync(marker), false, 'the worker\'s child process was killed with it');
    assert.equal(service.get('project', job.key).status, 'cancelled');
    assert.deepEqual(service.get('project', job.key).segments, []);
    assert.throws(() => service.preview('project', job.key, 0), /not found/);
    assert.equal(readdirSync(f.cache).filter(name => name.startsWith('.partial-')).length, 0);
  } finally { await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('a restart fails interrupted runs and removes partial and orphaned folders', async () => {
  const f = fixture('restart'), [running, ready, missing, orphan] = ['b', 'c', 'd', 'e'].map(c => c.repeat(64));
  mkdirSync(join(f.cache, `.partial-${running}-x`, 'preview'), { recursive: true });
  mkdirSync(join(f.cache, ready)); writeFileSync(join(f.cache, ready, 'manifest.json'), '{}');
  mkdirSync(join(f.cache, orphan)); writeFileSync(join(f.cache, orphan, 'manifest.json'), '{}');
  const record = (key: string, status: string) => writeFileSync(join(f.cache, `${key}.job.json`), JSON.stringify({ key, base: 'x', status, progress: 40, mediaId: 'media', first: 0, frames: 64, times: [], width: 924, height: 518, lo: 0, hi: 1, near: 1, far: 0, segments: [{ n: 0, first: 0, count: 64 }], projects: ['project'], used: 1 }));
  const old = 'f'.repeat(64);
  record(running, 'processing'); record(ready, 'ready'); record(missing, 'ready'); record(old, 'failed');
  // Focus tracks go with their run: a ready run keeps its own, a failed one's and a half-written one go.
  mkdirSync(join(f.cache, 'focus')); for (const name of [`${ready}-a.json`, `${running}-a.json`, `${ready}-b.json.1.tmp`]) writeFileSync(join(f.cache, 'focus', name), '{}');
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory), sourceTimes: async () => times });
  try {
    assert.equal(service.get('project', running).status, 'failed');
    assert.match(service.get('project', running).error!, /restarted/);
    assert.deepEqual(service.get('project', running).segments, []);
    assert.equal(service.get('project', ready).status, 'ready');
    assert.equal(service.get('project', missing).status, 'failed');
    assert.deepEqual(readdirSync(f.cache).filter(name => !name.endsWith('.job.json') && name !== 'focus').sort(), [ready]);
    assert.deepEqual(readdirSync(join(f.cache, 'focus')), [`${ready}-a.json`]);
    assert.equal(JSON.parse(readFileSync(join(f.cache, `${running}.job.json`), 'utf8')).status, 'failed');
    assert.throws(() => service.get('project', old), /not found/, 'a failure already shown before this start is dropped');
    assert.ok(!existsSync(join(f.cache, `${old}.job.json`)));
  } finally { await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('the cache stays under its cap by evicting the least recently used run, never a held one', async () => {
  const f = fixture('evict'), previous = process.env.FRAME_LINE_DEPTH_CACHE_GB;
  // Each run is two segments of 2 × 1 MB. With a 10 MB cap and room kept for the next run's estimate (40 KB a
  // frame, about 5 MB here), two finished runs fit.
  process.env.FRAME_LINE_DEPTH_CACHE_GB = String(10 * 1024 ** 2 / 1024 ** 3);
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory, { bytes: 1024 ** 2 }), sourceTimes: async () => times });
  const analyse = async (from: number) => { const job = await service.enqueue({ clip: clip(`c${from}`), asset, sourcePath: f.source, from, to: from + .5 }); await until(() => service.get('project', job.key).status === 'ready'); return job.key; };
  try {
    const a = await analyse(3), b = await analyse(8);
    writeFileSync(join(f.cache, 'focus', `${a}-track.json`), '{}');
    const c = await analyse(13);
    assert.throws(() => service.get('project', a), /not found/, 'the oldest run went');
    assert.ok(!existsSync(join(f.cache, a)));
    assert.ok(!existsSync(join(f.cache, 'focus', `${a}-track.json`)), 'with its focus track');
    assert.equal(service.get('project', b).status, 'ready'); // b is now the most recently used
    const release = service.hold(c);
    const d = await analyse(17);
    assert.equal(service.get('project', c).status, 'ready', 'a held run survives');
    assert.equal(service.get('project', d).status, 'ready');
    assert.throws(() => service.get('project', b), /not found/);
    release();
  } finally {
    if (previous === undefined) delete process.env.FRAME_LINE_DEPTH_CACHE_GB; else process.env.FRAME_LINE_DEPTH_CACHE_GB = previous;
    await service.close(); rmSync(f.directory, { recursive: true, force: true });
  }
});

test('a new run is refused when it would take the disk below the free-space floor, never under the server reserve', async () => {
  const f = fixture('disk'), previous = process.env.FRAME_LINE_MIN_FREE_GB;
  let free = 4.9 * 1024 ** 3;
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory), sourceTimes: async () => times, freeBytes: () => free });
  try {
    // Under the server's 5 GB reserve uploads fail and /api/health reports the disk low, so depth stops there too.
    await assert.rejects(service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 10, to: 11 }), (error: Error & { status?: number }) => error.status === 507 && /4\.9 GB free.*keeps 5\.0 GB/.test(error.message));
    process.env.FRAME_LINE_MIN_FREE_GB = '1'; // A smaller reserve still leaves depth its own 2 GB floor.
    free = 1.9 * 1024 ** 3;
    await assert.rejects(service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 10, to: 11 }), (error: Error & { status?: number }) => error.status === 507 && /1\.9 GB free.*keeps 2\.0 GB/.test(error.message));
    assert.equal(runs(f.directory).length, 0, 'no worker started');
    free = 2.5 * 1024 ** 3;
    const job = await service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 10, to: 11 });
    await until(() => service.get('project', job.key).status === 'ready');
    assert.equal(runs(f.directory).length, 1);
  } finally {
    if (previous === undefined) delete process.env.FRAME_LINE_MIN_FREE_GB; else process.env.FRAME_LINE_MIN_FREE_GB = previous;
    await service.close(); rmSync(f.directory, { recursive: true, force: true });
  }
});

test('an export waiting for a run keeps it: an editor cancelling it meanwhile (a trim, the effect removed) fails nothing', async () => {
  const f = fixture('export-wait'), gate = join(f.directory, 'gate');
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory, { gate }), sourceTimes: async () => times });
  try {
    const request = { clip: clip('a'), asset, sourcePath: f.source, from: 0, to: 3 };
    const waiting = service.ready(request);
    const { key } = await service.enqueue(request);
    await until(() => service.get('project', key).segments.length === 1);
    service.cancel('project', key);
    assert.equal(service.get('project', key).status, 'processing', 'the editor\'s cancel leaves a run an export waits for');
    writeFileSync(gate, '');
    const { run, release } = await waiting;
    assert.equal(run.status, 'ready');
    release();
    // Nothing waits any more: a cancel stops the next run as before.
    const next = await service.enqueue({ clip: clip('b'), asset, sourcePath: f.source, from: 13, to: 14 });
    service.cancel('project', next.key);
    assert.equal(service.get('project', next.key).status, 'cancelled');
  } finally { writeFileSync(gate, ''); await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});


test('a CUDA run or bake first stops an idle Smart Mask preview worker; a CPU one leaves it running', async () => {
  for (const device of ['cuda', 'cpu']) {
    const f = fixture(`gpu-${device}`);
    let freed = 0;
    const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory, { device }), sourceTimes: async () => times, freeGpu: () => { freed++; } });
    try {
      const job = await service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 0, to: 1 });
      await until(() => service.get('project', job.key).status === 'ready');
      assert.equal(freed, device === 'cuda' ? 1 : 0, `${device} run`);
      service.freeGpu(); // The export bake asks the same way.
      assert.equal(freed, device === 'cuda' ? 2 : 0, `${device} bake`);
    } finally { await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});


test('a request refused for low disk keeps the cache when evicting could not make room anyway', async () => {
  const f = fixture('disk-cache');
  let free = 10 * 1024 ** 3;
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory), sourceTimes: async () => times, freeBytes: () => free });
  try {
    const a = await service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 3, to: 3.5 });
    await until(() => service.get('project', a.key).status === 'ready');
    free = 1.5 * 1024 ** 3; // Low for reasons that have nothing to do with depth.
    await assert.rejects(service.enqueue({ clip: clip('b'), asset, sourcePath: f.source, from: 13, to: 13.5 }), (error: Error & { status?: number }) => error.status === 507);
    assert.equal(service.get('project', a.key).status, 'ready');
    assert.ok(existsSync(join(f.cache, a.key, 'manifest.json')));
  } finally { await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('an eviction that cannot delete an old run never fails the run that just finished', async () => {
  const f = fixture('evict-locked'), previous = process.env.FRAME_LINE_DEPTH_CACHE_GB;
  process.env.FRAME_LINE_DEPTH_CACHE_GB = String(14 * 1024 ** 2 / 1024 ** 3);
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory, { bytes: 2 * 1024 ** 2 }), sourceTimes: async () => times });
  const analyse = async (from: number) => { const job = await service.enqueue({ clip: clip(`c${from}`), asset, sourcePath: f.source, from, to: from + .5 }); await until(() => ['ready', 'failed'].includes(service.get('project', job.key).status)); return job.key; };
  let locked = '';
  try {
    const a = await analyse(3);
    locked = join(f.cache, a, 'preview');
    chmodSync(locked, 0o500); // Stands in for a Windows handle on a segment being streamed (a no-op on Windows).
    const b = await analyse(8);
    const done = service.get('project', b);
    assert.equal(done.status, 'ready', done.error);
    assert.ok(done.segments.length > 0, 'its segments survive');
    assert.throws(() => service.get('project', a), /not found/, 'the old run is out of the records even if its files stay');
    assert.ok(!existsSync(join(f.cache, `${a}.job.json`)));
  } finally {
    if (locked && existsSync(locked)) chmodSync(locked, 0o700);
    if (previous === undefined) delete process.env.FRAME_LINE_DEPTH_CACHE_GB; else process.env.FRAME_LINE_DEPTH_CACHE_GB = previous;
    await service.close(); rmSync(f.directory, { recursive: true, force: true });
  }
});

test('a cancelled queued run can be asked for again at once; a shared run survives one project leaving', async () => {
  const f = fixture('requeue'), gate = join(f.directory, 'gate');
  const service = depthService(f.cache, { python: process.execPath, worker: fakeWorker(f.directory, { gate }), sourceTimes: async () => times });
  try {
    const running = await service.enqueue({ clip: clip('a'), asset, sourcePath: f.source, from: 0, to: 3 });
    await until(() => service.get('project', running.key).segments.length === 1);
    const queued = await service.enqueue({ clip: clip('b'), asset, sourcePath: f.source, from: 13, to: 14 });
    assert.equal(queued.status, 'queued');
    service.cancel('project', queued.key);
    const again = await service.enqueue({ clip: clip('b'), asset, sourcePath: f.source, from: 13, to: 14 });
    assert.equal(again.key, queued.key); assert.equal(again.status, 'queued');
    // Another project's clip of the same take joins the running run; this project leaving does not stop it.
    await service.enqueue({ clip: clip('x', 'other'), asset, sourcePath: f.source, from: 1, to: 2 });
    service.cancel('project', running.key);
    assert.throws(() => service.get('project', running.key), /not found/);
    assert.equal(service.get('other', running.key).status, 'processing');
    writeFileSync(gate, '');
    await until(() => service.get('other', running.key).status === 'ready' && service.get('project', again.key).status === 'ready');
    assert.deepEqual(runs(f.directory), ['0:128', '256:128']);
  } finally { writeFileSync(gate, ''); await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('the real worker with the synthetic engine analyses a clip into decodable segments', async t => {
  let python = '';
  try { python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(); } catch { t.skip('python3 is not installed'); return; }
  const f = fixture('synthetic'), ff = process.env.FFMPEG_PATH || 'ffmpeg', source = join(f.directory, 'source.mp4'), previous = process.env.FRAME_LINE_DEPTH_ENGINE;
  process.env.FRAME_LINE_DEPTH_ENGINE = 'synthetic';
  await run(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=24:d=3', '-c:v', 'libx264', '-g', '48', '-pix_fmt', 'yuv420p', source]);
  const masks = smartMaskService(join(f.directory, 'masks')), video = { ...asset, duration: 3, fps: 24, resolution: '64 × 36' } as MediaAsset;
  const service = depthService(f.cache, { python, sourceTimes: masks.sourceTimes });
  try {
    const job = await service.enqueue({ clip: clip('a'), asset: video, sourcePath: source, from: 1, to: 2 });
    assert.deepEqual([job.first, job.frames], [0, 72]);
    await until(() => ['ready', 'failed'].includes(service.get('project', job.key).status), 60_000);
    const done = service.get('project', job.key);
    assert.equal(done.status, 'ready', done.error);
    assert.deepEqual(done.segments, [{ n: 0, first: 0, count: 64 }, { n: 1, first: 64, count: 8 }]);
    assert.ok(done.hi > done.lo && done.near > done.far);
    assert.ok(done.telemetry?.frames === 72 && done.telemetry.fps > 0 && /synthetic/i.test(done.telemetry.engine ?? ''), `the worker's last line is kept: ${JSON.stringify(done.telemetry)}`);
    const probe = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,pix_fmt,color_range,nb_read_frames', '-of', 'json', service.preview('project', job.key, 1)], { encoding: 'utf8' })).streams[0];
    assert.deepEqual([probe.width, probe.height, probe.pix_fmt, probe.color_range, probe.nb_read_frames], [924, 518, 'yuvj420p', 'pc', '8']);
  } finally {
    if (previous === undefined) delete process.env.FRAME_LINE_DEPTH_ENGINE; else process.env.FRAME_LINE_DEPTH_ENGINE = previous;
    await service.close(); await masks.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test('HTTP routes need editor rights to cancel and project membership to read or join', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameline-depth-http-'));
  const app = createFrameLineServer({ dataDir: directory });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const request = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  };
  try {
    const owner = await request('', '/auth/signup', 'POST', { name: 'Depth Owner', email: 'depth-owner@example.test', password: 'strong-depth-password' });
    const viewer = await request('', '/auth/signup', 'POST', { name: 'Depth Viewer', email: 'depth-viewer@example.test', password: 'strong-depth-password' });
    const state = (await request(owner.cookie, '/state')).data;
    state.state.projects = [{ id: 'project', name: 'Depth', description: '', shared: true, classRole: 'Viewer', thumbnail: '', modifiedAt: 1, duration: 1, resolution: '64 × 32', fps: 2, status: 'In progress', members: [{ userId: owner.data.user.id, role: 'Owner' }] }];
    state.state.timelines = [{ id: 'timeline', projectId: 'project', name: 'Timeline', duration: 1 }];
    state.state.tracks = [{ id: 'track', timelineId: 'timeline', name: 'Video', kind: 'video', number: 1, muted: false, hidden: false, solo: false, locked: false, gain: 0, pan: 0 }];
    state.state.clips = [{ ...clip('clip'), timelineId: 'timeline', trackId: 'track', mediaId: 'frameline-shape', name: 'Shape', color: '#fff', disabled: false, properties: { shapeDocument: JSON.stringify(defaultShape()) } }];
    assert.equal((await request(owner.cookie, '/state', 'PUT', state)).status, 200);
    assert.equal((await request(owner.cookie, '/depth/capabilities')).data.available !== undefined, true);
    // A viewer's POST may join a run (the service refuses to start one for it), so it reaches the clip checks.
    assert.equal((await request(viewer.cookie, '/depth', 'POST', { projectId: 'project', clipId: 'clip' })).status, 400);
    assert.equal((await request(viewer.cookie, '/depth', 'POST', { projectId: 'private', clipId: 'clip' })).status, 404, 'a clip outside the project body is not found');
    assert.equal((await request(owner.cookie, '/depth', 'POST', { projectId: 'project', clipId: 'clip' })).status, 400, 'a shape has no source to analyse');
    assert.equal((await request(viewer.cookie, `/depth/${'a'.repeat(64)}?projectId=project`, 'DELETE')).status, 403);
    assert.equal((await request(viewer.cookie, `/depth/${'a'.repeat(64)}?projectId=project`)).status, 404);
    assert.equal((await request(viewer.cookie, `/depth/${'a'.repeat(64)}/preview/0.mp4?projectId=private`)).status, 404);
    assert.equal((await request('', `/depth/${'a'.repeat(64)}?projectId=project`)).status, 401);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
