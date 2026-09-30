import test from 'node:test';
import assert from 'node:assert/strict';
import type { Clip, MediaAsset } from '../state/models.ts';
import { evaluateClip } from './animation.ts';
import { transformMotion } from './motionBlur.ts';
import {
  cameraKeyframes, createMotionTracker, defaultCameraOptions, defaultLayerOptions, emptySamples, envelope, fittedPoint, layerKeyframes, mergeSamples, nextKey,
  pictureBounds, placeKey, pointOnFrame, poseLayerPoint, simplify, sourceToLayer, trackAtTimeline, trackerPath, validateMotionTracker, validateMotionTrackers,
  validateMotionTrackerSamples, writeChannel, type MotionTrackerSamples, type SampleRow, type TrackPoint,
} from './motionTracker.ts';

const asset = { id: 'media', kind: 'video', fps: 30, resolution: '3840 × 2160', duration: 20 } as MediaAsset;
const video = (patch: Partial<Clip> = {}): Clip => ({ id: 'clip', projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'media', name: 'Shot', start: 10, duration: 4, sourceIn: 2, color: '#fff', disabled: false, properties: { x: 0, y: 0, zoom: 100, rotation: 0, anchorX: 0, anchorY: 0 }, effects: [], ...patch });
const rows = (frames: number[], fps: number, at: (frame: number) => [number, number]): SampleRow[] => frames.map(frame => ({ frame, time: frame / fps, x: at(frame)[0], y: at(frame)[1], confidence: .9, scale: 1, rotation: 0, flag: 0 }));
const samples = (frames: number[], fps: number, at: (frame: number) => [number, number]) => mergeSamples(emptySamples('media'), -1, -1, rows(frames, fps, at));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('tracker documents validate their boxes, points, results and links', () => {
  const tracker = createMotionTracker(asset, 'track-1', 0, { x: .5, y: .4, time: 3 });
  validateMotionTracker(tracker);
  assert.equal(tracker.name, 'Track 1');
  assert.ok(Math.abs(tracker.feature.width * 3840 - tracker.feature.height * 2160) < 1, 'feature box is square on screen');
  validateMotionTracker({ ...tracker, search: { width: tracker.feature.width / 2, height: tracker.search.height } });
  assert.throws(() => validateMotionTracker({ ...tracker, keys: [{ time: 2, x: .5, y: .5 }, { time: 1, x: .5, y: .5 }] }));
  assert.throws(() => validateMotionTracker({ ...tracker, keys: [{ time: 2, x: Number.NaN, y: .5 }] }));
  assert.throws(() => validateMotionTracker({ ...tracker, result: { key: 'nope' } }));
  validateMotionTracker({ ...tracker, result: { key: 'a'.repeat(64) }, links: [{ clipId: 'title', target: 'layer', time: 11, base: { x: 1, y: 2, zoom: 100, rotation: 0 }, layer: defaultLayerOptions }] });
  assert.throws(() => validateMotionTracker({ ...tracker, links: [{ clipId: 'title', target: 'camera', time: 11, base: { x: 1, y: 2, zoom: 100, rotation: 0 }, layer: defaultLayerOptions }] }));
  assert.throws(() => validateMotionTrackers(video({ mediaId: 'other', motionTrackers: [tracker] })));
  assert.throws(() => validateMotionTrackers(video({ motionTrackers: [tracker, tracker] })));
  validateMotionTrackers(video({ motionTrackers: [tracker] }));
});

test('samples merge by frame and hand-placed points win on their frame', () => {
  const base = samples(range(0, 9), 30, frame => [frame / 100, .5]);
  validateMotionTrackerSamples(base);
  const merged = mergeSamples(base, 4, 6, rows([4, 5], 30, () => [.9, .9]));
  assert.deepEqual(merged.frames, [0, 1, 2, 3, 4, 5, 7, 8, 9], 'frame 6 was in the replaced run and got no new sample');
  assert.equal(merged.x[4], .9);
  assert.throws(() => validateMotionTrackerSamples({ ...base, frames: [...base.frames].reverse() }));
  const tracker = { source: { mediaId: 'media', fps: 30, width: 3840, height: 2160, duration: 20 }, keys: [{ time: 2 / 30, x: .7, y: .1 }, { time: 12 / 30, x: .2, y: .2 }] };
  const path = trackerPath(tracker, base);
  assert.equal(path.length, 11);
  assert.deepEqual([path[2].x, path[2].flag, path[2].frame], [.7, 1, 2]);
  assert.deepEqual([path.at(-1)!.x, path.at(-1)!.flag, path.at(-1)!.frame], [.2, 1, undefined]);
  assert.equal(pointOnFrame(path, 11 / 30, 30), undefined, 'a gap in the analysis is not held');
  assert.equal(nextKey(tracker, 2 / 30, 1)?.time, 12 / 30);
  assert.equal(nextKey(tracker, 2 / 30, -1), undefined);
  assert.deepEqual(placeKey({ ...tracker, keys: tracker.keys }, 2 / 30 + .001, .3, .3).map(key => key.x), [.3, .2], 'placing on a keyed frame moves that point');
});

test('the track is read on the source frame the export shows', () => {
  const at = (frame: number): [number, number] => [frame, 0];
  // 59.94 fps source on a 30 fps timeline: FFmpeg's fps filter shows frame 2n at output frame n.
  const fast = { ...asset, fps: 60000 / 1001 };
  const path = trackerPath({ keys: [], source: { mediaId: 'media', fps: fast.fps, width: 3840, height: 2160, duration: 20 } }, mergeSamples(emptySamples('media'), -1, -1, range(0, 400).map(frame => ({ frame, time: frame * 1001 / 60000, x: frame, y: 0, confidence: 1, scale: 1, rotation: 0, flag: 0 as const }))));
  const clip = video({ sourceIn: 0, start: 0, duration: 6 });
  for (const n of [1, 7, 100, 199]) assert.equal(trackAtTimeline(path, clip, fast, n / 30, 30)?.x, 2 * n, `output frame ${n}`);
  // Same rate: frame n at output frame n, including after a trim.
  const same = trackerPath({ keys: [], source: { mediaId: 'media', fps: 30, width: 3840, height: 2160, duration: 20 } }, samples(range(0, 400), 30, at));
  for (const n of [0, 5, 59]) assert.equal(trackAtTimeline(same, video(), asset, 10 + n / 30, 30)?.x, 60 + n);
  // Half speed holds each source frame for two output frames.
  assert.deepEqual([0, 1, 2, 3].map(n => trackAtTimeline(same, video({ properties: { speed: 50 } }), asset, 10 + n / 30, 30)?.x), [60, 60, 61, 61]);
  // Optical flow draws the in-between pictures, so the point is in between too.
  assert.equal(trackAtTimeline(same, video({ properties: { speed: 50, opticalFlow: 'Balanced' } }), asset, 10 + 1 / 30, 30)?.x, 60.5);
});

test('canvas mapping is the pose playback draws, for video, rotated, anchored and shape layers', () => {
  const project = [1920, 1080] as const;
  const chain = (clip: Clip, point: { x: number; y: number }) => {
    // drawMotionPose: translate(W/2 + pose.x, H/2 + pose.y), rotate, scale, translate(-W/2, -H/2).
    const pose = transformMotion(clip, clip.start, 30, project[0], project[1])[0], c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    const dx = (point.x - project[0] / 2) * pose.scaleX, dy = (point.y - project[1] / 2) * pose.scaleY;
    return { x: project[0] / 2 + pose.x + c * dx - s * dy, y: project[1] / 2 + pose.y + s * dx + c * dy };
  };
  const shape = JSON.stringify({ kind: 'rectangle', x: .1, y: .2, width: .3, height: .1, fill: '#ffffff', fillOpacity: 100, outline: '#000000', outlineWidth: 0, opacity: 100, cornerRadius: 0, shadowColor: '#000000', shadowOpacity: 0, shadowBlur: 0, shadowX: 0, shadowY: 0 });
  const cases: Clip[] = [
    video(),
    video({ properties: { x: 120, y: -80, zoom: 137, rotation: 21, anchorX: 300, anchorY: -40 } }),
    video({ mediaId: 'frameline-shape', properties: { x: 10, y: 5, zoom: 80, rotation: -33, anchorX: 12, anchorY: 7, shapeDocument: shape } }),
  ];
  for (const clip of cases) for (const point of [{ x: 0, y: 0 }, { x: 700, y: 300 }, { x: 1920, y: 1080 }]) {
    const expected = chain(clip, point), actual = poseLayerPoint(clip, point, project);
    assert.ok(Math.hypot(expected.x - actual.x, expected.y - actual.y) < 1e-6, JSON.stringify({ clip: clip.properties, point, expected, actual }));
  }
  // Letterbox: a 4:3 source in 16:9 centres with bars left and right; the right edge lands at the bar.
  assert.deepEqual(fittedPoint(1, .5, [1440, 1080], project), { x: 1680, y: 540 });
  assert.deepEqual(sourceToLayer({ x: .5, y: .5, time: 0 }, [3840, 2160], project, () => [1, 0, 384, 0, 1, 0]), { x: 1152, y: 540 }, 'Stabilize warp is applied in source pixels');
});

const project = [1920, 1080] as const;
const wander = (frame: number): [number, number] => [.5 + .22 * Math.sin(frame / 17) + .03 * Math.sin(frame * 1.3), .5 + .2 * Math.cos(frame / 23)];

test('an attached layer keeps its place at the attach frame and moves with the subject', () => {
  const tracked = video(), title = { ...video({ id: 'title', mediaId: 'frameline-title', start: 11, duration: 2 }), properties: { x: 240, y: -310, zoom: 100, rotation: 0 } } as Clip;
  const path = trackerPath({ keys: [], source: { mediaId: 'media', fps: 30, width: 3840, height: 2160, duration: 20 } }, samples(range(0, 400), 30, wander));
  const context = { tracked, asset, source: [3840, 2160] as const, project, fps: 30, path };
  const base = { x: 240, y: -310, zoom: 100, rotation: 0 }, attach = 11.5;
  const channels = layerKeyframes(context, title, attach, base, defaultLayerOptions, 'k')!;
  const moved = { ...title, keyframes: channels }, q = (time: number) => poseLayerPoint(evaluateClip(tracked, time, 30), sourceToLayer(trackAtTimeline(path, tracked, asset, time, 30)!, [3840, 2160], project), project);
  const at = (time: number) => evaluateClip(moved, time, 30).properties;
  assert.ok(Math.abs(Number(at(attach).x) - 240) < .06 && Math.abs(Number(at(attach).y) + 310) < .06, 'unchanged at the attach frame');
  for (const time of [11, 11.2, 12.4, 12.9]) {
    const delta = { x: q(time).x - q(attach).x, y: q(time).y - q(attach).y };
    assert.ok(Math.abs(Number(at(time).x) - 240 - delta.x) < .06 && Math.abs(Number(at(time).y) + 310 - delta.y) < .06, `follows at ${time}`);
  }
  assert.ok(channels['properties.x'].length <= 61, 'at most one key per frame');
  const smooth = layerKeyframes({ ...context, path: trackerPath({ keys: [], source: { mediaId: 'media', fps: 30, width: 3840, height: 2160, duration: 20 } }, samples(range(0, 400), 30, frame => [.3 + frame / 1000, .5])) }, title, attach, base, defaultLayerOptions, 'k')!;
  assert.ok(smooth['properties.x'].length <= 3 && smooth['properties.y'].length <= 3, 'a straight move needs only its ends');
  assert.equal(channels['properties.zoom'], undefined);
});

test('scale and rotation turn the layer around the tracked point', () => {
  const tracked = video(), title = { ...video({ id: 'title', mediaId: 'frameline-title' }), properties: { x: 0, y: -200, zoom: 100, rotation: 0 } } as Clip;
  const base: TrackPoint[] = range(0, 400).map(frame => ({ frame, time: frame / 30, x: .5, y: .5, scale: 1 + frame / 300, rotation: frame / 3, confidence: 1, flag: 0 }));
  const path = trackerPath({ keys: [], source: { mediaId: 'media', fps: 30, width: 3840, height: 2160, duration: 20 } }, mergeSamples(emptySamples('media'), -1, -1, base as SampleRow[]));
  const channels = layerKeyframes({ tracked, asset, source: [3840, 2160], project, fps: 30, path }, title, 10, { x: 0, y: -200, zoom: 100, rotation: 0 }, { ...defaultLayerOptions, scale: true, rotation: true }, 'k')!;
  const moved = evaluateClip({ ...title, keyframes: channels }, 12, 30).properties;
  // Two seconds in: scale 1.2 (source frames 60 → 120), turned 20°. The pivot 200 px above the point swings with it.
  const growth = (1 + 120 / 300) / (1 + 60 / 300), turn = 20 * Math.PI / 180;
  assert.ok(Math.abs(Number(moved.zoom) - 100 * growth) < .01);
  assert.ok(Math.abs(Number(moved.rotation) - 20) < .01);
  assert.ok(Math.abs(Number(moved.x) - 200 * growth * Math.sin(turn)) < .06 && Math.abs(Number(moved.y) + 200 * growth * Math.cos(turn)) < .06);
});

test('camera follow keeps the point on its mark and never shows a border', () => {
  for (const [label, options, clipPatch] of [
    ['dynamic', { ...defaultCameraOptions, smoothing: 0 }, {}],
    ['smoothed', { ...defaultCameraOptions, smoothing: 2 }, {}],
    ['steady centred', { ...defaultCameraOptions, zoom: 'steady' as const, framing: 'center' as const, smoothing: 0 }, {}],
    ['rotated, cropped and anchored', { ...defaultCameraOptions, maxZoom: 800, smoothing: 0 }, { properties: { x: 0, y: 0, zoom: 100, rotation: 8, anchorX: 90, anchorY: -30, cropLeft: 40, cropTop: 12 } }],
    ['capped zoom', { ...defaultCameraOptions, maxZoom: 130, framing: 'center' as const }, {}],
  ] as const) {
    const tracked = video(clipPatch as Partial<Clip>), source = [3840, 2160] as const;
    const path = trackerPath({ keys: [], source: { mediaId: 'media', fps: 30, width: 3840, height: 2160, duration: 20 } }, samples(range(0, 400), 30, wander));
    const context = { tracked, asset, source, project, fps: 30, path }, base = { x: 0, y: 0, zoom: 100, rotation: Number(tracked.properties.rotation) };
    const channels = cameraKeyframes(context, 11, base, options, 'c')!;
    const followed = { ...tracked, keyframes: channels }, bounds = pictureBounds(tracked, source, project);
    const goal = options.framing === 'center' ? { x: 960, y: 540 } : poseLayerPoint(evaluateClip(tracked, 11, 30), sourceToLayer(trackAtTimeline(path, tracked, asset, 11, 30)!, source, project), project);
    let onMark = 0;
    for (let n = 0; n < 120; n++) {
      const time = 10 + n / 30, pose = evaluateClip(followed, time, 30), point = poseLayerPoint(pose, sourceToLayer(trackAtTimeline(path, tracked, asset, time, 30)!, source, project), project);
      // Invert the pose at each canvas corner: it must land on picture, not on a bar or the cropped edge.
      const p = pose.properties, zoom = Number(p.zoom) / 100, angle = -Number(p.rotation) * Math.PI / 180, cx = 960 + Number(p.anchorX ?? 0), cy = 540 + Number(p.anchorY ?? 0);
      for (const corner of [{ x: 0, y: 0 }, { x: 1920, y: 0 }, { x: 0, y: 1080 }, { x: 1920, y: 1080 }]) {
        const dx = corner.x - cx - Number(p.x), dy = corner.y - cy - Number(p.y);
        const lx = cx + (Math.cos(angle) * dx - Math.sin(angle) * dy) / zoom, ly = cy + (Math.sin(angle) * dx + Math.cos(angle) * dy) / zoom;
        assert.ok(lx >= bounds.left - .2 && lx <= bounds.right + .2 && ly >= bounds.top - .2 && ly <= bounds.bottom + .2, `${label}: border at ${time.toFixed(3)} corner ${JSON.stringify(corner)}`);
      }
      if (Math.hypot(point.x - goal.x, point.y - goal.y) < .3) onMark++;
    }
    // Smoothing lets the camera ignore jitter, so the point swings about its mark; a cap lets it off rather than show a border.
    if (label === 'capped zoom' || label === 'smoothed') assert.ok(onMark < 120, label);
    else assert.ok(onMark >= 118, `${label}: on the mark ${onMark}/120`);
  }
});

test('thinning, envelopes and channel writes keep their guarantees', () => {
  const times = range(0, 299).map(n => n / 30), values = times.map(t => 200 * Math.sin(t * 2) + 3 * Math.sin(t * 40));
  const kept = simplify(times, values, .05);
  for (let i = 0; i < times.length; i++) {
    const after = kept.findIndex(k => k >= i), b = kept[after], a = kept[Math.max(0, after - 1)];
    const t = b === a ? 0 : (times[i] - times[a]) / (times[b] - times[a]);
    assert.ok(Math.abs(values[a] + (values[b] - values[a]) * t - values[i]) <= .05 + 1e-9);
  }
  const need = range(0, 199).map(n => n === 70 ? 180 : n > 120 && n < 130 ? 150 : 100), curve = envelope(need, 30, 12);
  assert.ok(curve.every((value, i) => value >= need[i]));
  assert.ok(Math.max(...curve.slice(1).map((value, i) => Math.abs(value - curve[i]))) < 6, 'the zoom glides');
  // 'k9' is this writer's own key from a longer earlier track: it goes even though it lies outside the new span.
  const existing = [{ id: 'early', time: .2, value: 5, interpolation: 'linear' as const }, { id: 'inside', time: 1, value: 9, interpolation: 'linear' as const }, { id: 'late', time: 3.5, value: 7, interpolation: 'linear' as const }, { id: 'k9', time: 3, value: 1, interpolation: 'linear' as const }];
  const written = writeChannel(existing, 'properties.x', { start: 10 }, [10.5, 11, 11.5, 12], [1, 2, 3, 4], 'k');
  assert.deepEqual(written.map(key => key.id), ['early', 'k0', 'k1', 'late']);
  // Off the project grid, keys land on the frames themselves; a spin wraps into ±180° and holds across the wrap.
  assert.deepEqual(writeChannel(undefined, 'properties.x', { start: 10.01 }, [10.5, 11], [1, 2], 'k').map(key => key.time), [.49, .99]);
  const spin = writeChannel(undefined, 'properties.rotation', { start: 0 }, range(0, 99).map(n => n / 30), range(0, 99).map(n => n * 7), 'r');
  assert.ok(spin.every(key => Math.abs(Number(key.value)) <= 180));
  for (let n = 0; n < 100; n++) {
    const value = Number(evaluateClip({ ...video(), start: 0, keyframes: { 'properties.rotation': spin } } as Clip, n / 30, 30).properties.rotation);
    assert.ok(Math.abs(((value - n * 7) % 360 + 540) % 360 - 180) < .01, `same angle on screen at frame ${n}`);
  }
  assert.ok(Object.keys(emptySamples('m')).length === 10 && (emptySamples('m') as MotionTrackerSamples).frames.length === 0);
});

test('the paused preview picks the exported frame, and nothing changes when the rates match', async () => {
  const { shownSourceTime } = await import('./motionTracker.ts');
  const frameOf = (time: number, fps: number) => Math.floor(time * fps + 1e-6);
  // What the export delivers at output frame n: it keeps the first frame at or after the in point, then FFmpeg's fps
  // filter takes the latest frame starting before n + ½ output frames, counted from that first frame.
  const ffmpeg = (n: number, sourceFps: number, outFps: number, speed: number, sourceIn: number) => Math.ceil(sourceIn * sourceFps - 1e-6) + Math.ceil((n + .5) * speed / outFps * sourceFps - 1e-9) - 1;
  for (const sourceIn of [0, .1, 1 / 30]) for (const [sourceFps, outFps, speed] of [[30, 30, 1], [24, 24, 1], [60000 / 1001, 30, 1], [30000 / 1001, 30, 1], [24, 30, 1], [30, 30, .5], [60, 24, 1]] as const) {
    const clip = video({ start: 0, sourceIn, duration: 60, properties: { speed: speed * 100 } });
    for (let n = 0; n < 900; n++) {
      const source = sourceIn + n / outFps * speed, shown = frameOf(shownSourceTime(clip, n / outFps, source, outFps, sourceFps), sourceFps);
      assert.equal(shown, ffmpeg(n, sourceFps, outFps, speed, sourceIn), `${sourceFps} on ${outFps} at ${speed} from ${sourceIn}: frame ${n}`);
      if (sourceIn === 0 && Math.abs(sourceFps - outFps / speed) < 1e-9) assert.equal(shown, frameOf(source, sourceFps), 'equal rates keep the frame they always showed');
    }
  }
  const held = video({ properties: { freeze: true } });
  assert.equal(shownSourceTime(held, 11, 2.5, 30, 30), 2.5, 'a freeze reads its own frame');
  assert.equal(shownSourceTime(video({ properties: { reverse: true } }), 11, 2.5, 30, 30), 2.5, 'reverse reads its own frame');
});

test('a frame editor and the timeline playhead name the same picture, also for frames a 30p timeline skips', async () => {
  const { pictureTimeAt, playheadShowing } = await import('./motionTracker.ts');
  const sixty = { fps: 60, duration: 20 }, clip = video({ properties: { speed: 100 } }), frameOf = (t: number) => Math.floor(t * 60 + 1e-6);
  let exact = 0;
  for (let i = 2 * 60; i < 6 * 60; i++) {
    const at = playheadShowing(clip, sixty, i / 60, 30);
    assert.ok(at !== undefined && at >= clip.start && at < clip.start + clip.duration, `frame ${i} has a playhead`);
    const shown = frameOf(pictureTimeAt(clip, sixty, at, 30));
    assert.ok(Math.abs(shown - i) <= 1, `frame ${i} lands next to itself (${shown})`);
    if (shown === i) exact++;
  }
  assert.equal(exact, 120, 'every other 60p frame is on the 30p timeline, and each of those is found exactly');
  assert.equal(playheadShowing(clip, sixty, 15, 30), undefined, 'a frame the clip never reaches does not move the playhead');
  // Reversed or ramped, there is no straight line to follow: each frame the clip shows is still found.
  for (const shot of [video({ properties: { reverse: true } }), video({ keyframes: { 'properties.speed': [{ id: 'a', time: 0, value: 50 }, { id: 'b', time: 4, value: 200 }] } as never })]) {
    const at = 10 + 37 / 30, shown = pictureTimeAt(shot, asset, at, 30), back = playheadShowing(shot, asset, Math.floor(shown * 30 + 1e-6) / 30, 30);
    assert.ok(back !== undefined && Math.floor(pictureTimeAt(shot, asset, back, 30) * 30 + 1e-6) === Math.floor(shown * 30 + 1e-6), 'the searched frame shows the same picture');
  }
});
