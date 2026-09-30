import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clip, MediaAsset } from '../src/state/models.ts';
import { createMotionTracker, emptySamples, mergeSamples, placeKey, trackerPath, type MotionTracker } from '../src/services/motionTracker.ts';
import { clipFrames, frameAt, motionTrackerService, planRun, trackerPython } from './motionTracker.ts';

const asset = { id: 'media', projectId: 'p', name: 'Pan', kind: 'video', binId: 'all', thumbnail: '', duration: 2, resolution: '640 × 360', fps: 30, size: '', status: 'ready', progress: 100 } as MediaAsset;
const clip = { id: 'clip', projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'media', name: 'Pan', start: 5, duration: 2, sourceIn: 0, color: '#fff', disabled: false, properties: {}, effects: [] } as Clip;
const times = Array.from({ length: 60 }, (_, i) => i / 30);

test('frames and runs: a run starts on a placed or tracked point and stops before the next placed one', () => {
  assert.equal(frameAt(times, 1 / 30 - 1e-9), 1, 'a frame whose time is a hair early still counts');
  assert.equal(frameAt(times, .05), 1);
  assert.deepEqual(clipFrames({ ...clip, sourceIn: .5, duration: 1 }, asset, times), { first: 15, last: 44 });
  assert.deepEqual(clipFrames({ ...clip, properties: { reverse: true } }, asset, times), { first: 0, last: 59 });
  const tracker = createMotionTracker(asset, 'track', 0, { x: .5, y: .5, time: 10 / 30 });
  const fenced = { ...tracker, keys: placeKey(tracker, 40 / 30, .4, .4) };
  const bounds = clipFrames(clip, asset, times);
  assert.deepEqual([planRun(fenced, undefined, times, bounds, 10 / 30, 1).stop, planRun(fenced, undefined, times, bounds, 10 / 30, -1).stop], [39, 0]);
  assert.deepEqual([planRun(fenced, undefined, times, bounds, 40 / 30, -1).stop, planRun(fenced, undefined, times, bounds, 40 / 30, 1).stop], [11, 59]);
  assert.equal(planRun(fenced, undefined, times, bounds, 10 / 30, 1, 1).stop, 11, 'one frame at a time');
  assert.throws(() => planRun(tracker, undefined, times, bounds, 20 / 30, 1), /Place Track 1 on this frame/);
  // A tracked sample is as good a start as a placed one; its scale and rotation carry into the run.
  const samples = mergeSamples(emptySamples('media'), -1, -1, [{ frame: 20, time: 20 / 30, x: .3, y: .3, confidence: .9, scale: 1.2, rotation: 5, flag: 0 }]);
  assert.deepEqual(planRun(tracker, samples, times, bounds, 20 / 30, 1).seed, { x: .3, y: .3, scale: 1.2, rotation: 5 });
  assert.throws(() => planRun(tracker, samples, times, { first: 30, last: 59 }, 20 / 30, 1), /playhead onto this clip/);
});

const ready = existsSync(trackerPython()) && (() => { try { execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a job tracks a real encoded pan to a tenth of a pixel, stops at placed points and clears ranges', { skip: !ready && 'needs npm run setup:tracker and FFmpeg' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameline-tracker-'));
  try {
    // A blurred-noise texture panned exactly 4 px right and 2 px down per frame, so the truth is known everywhere.
    const texture = join(directory, 'texture.png'), video = join(directory, 'pan.mp4');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=1280x720:d=1,noise=alls=100:allf=0,gblur=sigma=2.5', '-frames:v', '1', texture]);
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-framerate', '30', '-t', '2', '-i', texture, '-vf', 'crop=640:360:x=4*n:y=2*n,format=yuv420p', '-c:v', 'libx264', '-g', '30', video]);
    const service = motionTrackerService(join(directory, 'trackers'));
    const finish = async (view: { id: string; status: string }) => {
      let current = view;
      for (let tries = 0; tries < 600 && ['queued', 'running'].includes(current.status); tries++) { await new Promise(resolve => setTimeout(resolve, 50)); current = service.get('p', view.id); }
      return service.get('p', view.id);
    };
    const truth = (frame: number) => ({ x: .6 - 4 * frame / 640, y: .6 - 2 * frame / 360 });
    let tracker: MotionTracker = { ...createMotionTracker(asset, 'track', 0, { x: .6, y: .6, time: 0 }), feature: { width: .05, height: .09 }, search: { width: .15, height: .27 } };
    const forward = await finish(await service.start({ projectId: 'p', clip, asset, sourcePath: video, times, trackers: [tracker], time: 0, direction: 1 }));
    assert.equal(forward.status, 'done', forward.error);
    assert.equal(forward.stops.track.reason, 'end');
    const samples = await service.read(forward.results!.track);
    assert.deepEqual(samples.frames, Array.from({ length: 59 }, (_, i) => i + 1), 'every frame after the placed one');
    for (let i = 0; i < samples.frames.length; i++) {
      const expected = truth(samples.frames[i]);
      assert.ok(Math.hypot((samples.x[i] - expected.x) * 640, (samples.y[i] - expected.y) * 360) < .1, `frame ${samples.frames[i]}`);
    }
    assert.equal(forward.rows.length, 59, 'rows stream back as they settle');
    assert.equal(service.get('p', forward.id, 50).rows.length, 9, 'and can be read from where the editor left off');
    // A hand-placed correction on frame 30 fences the next run from frame 10 at frame 29, and replaces only 11..29.
    tracker = { ...tracker, keys: placeKey(tracker, 30 / 30, truth(30).x + .01, truth(30).y), result: { key: forward.results!.track } };
    const fenced = await finish(await service.start({ projectId: 'p', clip, asset, sourcePath: video, times, trackers: [tracker], time: 10 / 30, direction: 1 }));
    assert.equal(fenced.stops.track.frame, 29);
    assert.equal(fenced.stops.track.reason, 'key');
    const refenced = await service.read(fenced.results!.track);
    assert.equal(refenced.frames.length, 59, 'frames outside the run are kept');
    assert.equal(trackerPath(tracker, refenced).find(point => point.frame === 30)?.flag, 1, 'the placed point wins on its frame');
    // Backward from the placed point runs down to the clip start.
    const backward = await finish(await service.start({ projectId: 'p', clip, asset, sourcePath: video, times, trackers: [{ ...tracker, result: { key: fenced.results!.track } }], time: 30 / 30, direction: -1 }));
    assert.equal(backward.stops.track.frame, 1, 'the frame after the first placed point');
    const cleared = await service.clear({ ...tracker, result: { key: backward.results!.track } }, times, 40 / 30, 50 / 30);
    assert.ok(cleared && !(await service.read(cleared)).frames.some(frame => frame >= 40 && frame <= 50));
    // Cancelling keeps what settled before the stop.
    const long = await service.start({ projectId: 'p', clip, asset, sourcePath: video, times, trackers: [{ ...tracker, keys: [{ time: 0, x: .6, y: .6 }], result: undefined }], time: 0, direction: 1 });
    service.cancel('p', long.id);
    const cancelled = await finish(long);
    assert.equal(cancelled.status, 'cancelled');
    service.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
