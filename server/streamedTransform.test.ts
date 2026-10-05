import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import { piecewise, placement, streamsTransform } from './streamedTransform.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';

const exec = promisify(execFile), ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
// The expression FFmpeg evaluates, run as JavaScript (`in` is a keyword there).
const evaluate = (expression: string, frame: number) => new Function('n', 'between', 'gte', 'min', `return ${expression.replace(/\bin\b/g, 'n')}`)(frame, (x: number, a: number, b: number) => +(x >= a && x <= b), (x: number, a: number) => +(x >= a), Math.min);

test('piecewise keeps every frame within tolerance and holds the last value', () => {
  const eased = Array.from({ length: 90 }, (_, i) => 400 * (1 - Math.cos(Math.PI * i / 89)) / 2 - 17.5);
  for (const values of [eased, [5, 5, 5, 5], [0, 1, 2, 3, 10, 10, 9], [42]]) {
    const expression = piecewise(values);
    values.forEach((value, frame) => assert.ok(Math.abs(evaluate(expression, frame) - value) <= .021, `frame ${frame}: ${evaluate(expression, frame)} vs ${value}`));
    assert.ok(Math.abs(evaluate(expression, values.length + 5) - values.at(-1)!) <= .021, 'past the end the last value holds');
  }
  assert.ok(piecewise(Array.from({ length: 300 }, (_, i) => i * 2.5)).split('+').length <= 2, 'a linear move is one term');
});

test('placement turns zoom and rotation about the anchor', () => {
  const plain = placement({ x: 100, y: -50, zoom: 100, rotation: 0, anchorX: 0, anchorY: 0 }, 1920, 1080, 3840, 2160);
  assert.deepEqual([plain.shiftX, plain.shiftY, plain.zoom], [50, -25, 1]);
  // Anchored at a point, a 2x zoom keeps that point where it was.
  const anchored = placement({ x: 0, y: 0, zoom: 200, rotation: 0, anchorX: 400, anchorY: 200 }, 1920, 1080, 3840, 2160);
  assert.deepEqual([anchored.shiftX, anchored.shiftY], [-200, -100]);
});

test('only position, zoom, rotation and anchor keys stream', () => {
  const clip = (keyframes: Clip['keyframes'], properties = {}): Clip => ({ id: 'c', projectId: 'p', timelineId: 't', trackId: 'v', mediaId: 'm', name: 'Shot', start: 0, duration: 2, sourceIn: 0, color: '', disabled: false, properties: { ...defaultProperties, ...properties }, effects: [], keyframes });
  const key = (value: number) => [{ id: 'k', time: 0, value, interpolation: 'linear' as const }];
  assert.ok(streamsTransform(clip({ 'properties.zoom': key(100), 'properties.gain': key(-3) })));
  assert.ok(!streamsTransform(clip({ 'properties.zoom': key(100), 'properties.opacity': key(50) })), 'opacity keys still render per frame');
  assert.ok(!streamsTransform(clip({ 'properties.zoom': key(100) }, { motionBlur: true })), 'motion blur samples inside each frame');
  assert.ok(!streamsTransform(clip({ 'properties.gain': key(-3) })), 'nothing to stream');
});

// The streamed pass must draw what the per-frame renders drew: a 1 s Ken Burns zoom with a slide and a tilt.
test('a streamed keyframed transform matches the per-frame render', { timeout: 300000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-streamed-'));
  try {
    const source = path.join(dir, 'source.mp4');
    await exec(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '12', source]);
    const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'source.mp4', kind: 'video', binId: 'all', duration: 2, fps: 24, resolution: '640 × 360', size: '1 MB', status: 'ready', progress: 100, thumbnail: '', hasAudio: false };
    const track: Track = { id: 'v1', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
    const keys = (from: number, to: number) => [{ id: 'a', time: 0, value: from, interpolation: 'linear' as const }, { id: 'b', time: 1, value: to, interpolation: 'linear' as const }];
    const clip: Clip = { id: 'clip', projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: 'Zoom', trackId: 'v1', start: 0, duration: 1, sourceIn: .5, color: 'red', disabled: false,
      properties: { ...defaultProperties }, effects: [], keyframes: { 'properties.zoom': keys(100, 160), 'properties.x': keys(0, 120), 'properties.rotation': keys(0, 8) } };
    const request = (streamTransforms: boolean): RenderRequest => ({ project: { id: 'project', resolution: '640 × 360', fps: 24 } as Project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 1 }, tracks: [track], clips: [clip], nodes: [], assets: [{ asset, path: source }],
      settings: { resolution: '640 × 360', fps: '24', codec: 'H.264', quality: 'Visually lossless', rangeIn: '0', rangeOut: '1', audio: 'Disabled' }, outputPath: path.join(dir, `${streamTransforms}.mp4`), streamTransforms });
    const started = Date.now();
    await renderTimeline(request(true));
    const streamedSeconds = (Date.now() - started) / 1000;
    await renderTimeline(request(false));
    const frames = async (file: string) => await run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { binary: true, maxBytes: 64 * 1024 ** 2 });
    const [streamed, reference] = [await frames(path.join(dir, 'true.mp4')), await frames(path.join(dir, 'false.mp4'))];
    assert.equal(streamed.length, reference.length, 'same frame count');
    const size = 640 * 360;
    for (let frame = 0; frame < streamed.length / size; frame += 4) {
      let difference = 0;
      for (let i = frame * size; i < (frame + 1) * size; i++) difference += Math.abs(streamed[i] - reference[i]);
      assert.ok(difference / size < 4, `frame ${frame}: mean difference ${(difference / size).toFixed(2)} levels`);
    }
    console.log(`streamed render ${streamedSeconds.toFixed(1)} s`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
