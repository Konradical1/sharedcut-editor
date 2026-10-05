import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeMedia, renderTimeline, run, type RenderRequest } from './media.ts';
import { venvPython } from './platform.ts';
import { maskAnalysis, maskSourceFingerprint } from './smartMask.ts';
import { createSmartMask, smartMaskSignature, type SmartMaskManifest } from '../src/services/smartMask.ts';
import { stabilizePython } from './stabilize.ts';
import { flowPython } from './opticalFlow.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

// ~60 s alone; Stabilize saturates every core, so beside the rest of `npm test` it took over 180 s and was cancelled.
test('Stabilize export bakes a shaky clip and rejects conflicting effects', { timeout: 600000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-stabilize-'));
  try {
    const source = path.join(dir, 'shaky.mp4');
    await exec(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=3', '-vf', "crop=w=280:h=160:x='20+15*sin(n)':y='10+8*cos(n*1.3)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', source]);
    const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'shaky.mp4', kind: 'video', binId: 'all', duration: 3, fps: 24, resolution: '280 × 160', size: '10 KB', status: 'ready', progress: 100, thumbnail: '', hasAudio: false };
    const project = { id: 'project', resolution: '280 × 160', fps: 24 } as Project;
    const track: Track = { id: 'v1', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
    const stabilize = { id: 'fx', name: 'Stabilize', enabled: true, amount: 100, parameters: { crop: 6 } };
    const clip: Clip = { id: 'clip', projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: 'Shaky', trackId: 'v1', start: 0, duration: 2, sourceIn: .5, color: 'red', disabled: false, properties: { ...defaultProperties }, effects: [stabilize] };
    const request: RenderRequest = { project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 2 }, tracks: [track], clips: [clip], nodes: [], assets: [{ asset, path: source }], settings: { resolution: '280 × 160', fps: '24', rangeIn: '0', rangeOut: '2', audio: 'Disabled' }, outputPath: path.join(dir, 'out.mp4'), stabilizeDir: path.join(dir, 'cache') };
    if (!existsSync(stabilizePython())) { console.log('Stabilize worker not installed; skipping the bake.'); return; }
    const progress: number[] = [];
    await renderTimeline({ ...request, onProgress: value => progress.push(value) });
    const output = await probeMedia(request.outputPath);
    assert.ok(Math.abs(output.duration - 2) < .1, `duration ${output.duration}`);
    assert.equal(output.width, 280);
    assert.ok(progress.some(value => value > 0 && value < 45) && progress.at(-1)! >= 99, 'progress spans bake and composite');
    assert.ok(existsSync(path.join(dir, 'cache')) && (await readdir(path.join(dir, 'cache'))).some(name=>name.endsWith('.path.json')), 'analysis is cached in stabilizeDir');
    // Speed edits reuse the same analysis and keep working on the baked media.
    await renderTimeline({ ...request, clips: [{ ...clip, duration: 1, properties: { ...clip.properties, speed: 200 } }], settings: { ...request.settings, rangeOut: '1' }, outputPath: path.join(dir, 'fast.mp4') });
    assert.ok(Math.abs((await probeMedia(path.join(dir, 'fast.mp4'))).duration - 1) < .1);
    if (!existsSync(flowPython())) { console.log('Optical flow worker not installed; skipping the flow chain.'); return; }
    // Stabilize bakes first, optical flow then interpolates the stabilized frames: at half speed the held render repeats
    // every frame (two identical pictures in a row), the flow render has a new picture on every one.
    const slow = { ...clip, duration: 2, properties: { ...clip.properties, speed: 50 } };
    const stillest = async (name: string, flow: boolean) => {
      const file = path.join(dir, name);
      await renderTimeline({ ...request, clips: [{ ...slow, properties: { ...slow.properties, opticalFlow: flow } }], outputPath: file });
      const size = 280 * 160, raw = await run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { binary: true });
      // The last picture repeats the one before it (nothing lies beyond the clip to interpolate toward), so it is not counted.
      const steps = Array.from({ length: raw.length / size - 2 }, (_, k) => raw.subarray(k * size, (k + 1) * size).reduce((sum, value, i) => sum + Math.abs(value - raw[(k + 1) * size + i]), 0) / size);
      assert.ok(Math.abs((await probeMedia(file)).duration - 2) < .1, `${name} keeps the clip's length`);
      return Math.min(...steps);
    };
    const held = await stillest('held.mp4', false), smooth = await stillest('smooth.mp4', true);
    assert.ok(smooth > held + 1, `optical flow after Stabilize interpolates: still-frame step ${smooth.toFixed(2)} vs ${held.toFixed(2)} held`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// The bake starts at the clip's own source range, so a trimmed clip's reused matte has to move with it. Before the
// fix every matte was looked up range.from seconds early: here the subject appears at source frame 30 (1.25 s), the
// clip starts reading at 1 s, and the whole export came out black. A trim between frames moves the bake to the nearest
// source frame, and the matte has to follow that frame, not the raw trim: at 1 + 0.7/24 s the bake starts on frame 25.
test('Stabilize keeps a Smart Mask on its source frames on a trimmed clip', { timeout: 600000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-stabilize-mask-'));
  try {
    if (!existsSync(stabilizePython())) { console.log('Stabilize worker not installed; skipping.'); return; }
    if (!existsSync(process.env.FRAME_LINE_COLOR_PYTHON || venvPython('.venv-color'))) { console.log('Colour worker not installed; skipping.'); return; }
    const source = path.join(dir, 'shaky.mp4');
    await exec(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=200x120:r=24:d=3', '-vf', "crop=w=160:h=96:x='20+10*sin(n)':y='12+6*cos(n*1.3)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', source]);
    // Alpha 1 from source frame 30 (1.25 s) on, 0 before.
    const raw = Buffer.alloc(160 * 96 * 2 * 72);
    for (let f = 30; f < 72; f++) raw.fill(0xff, f * 160 * 96 * 2, (f + 1) * 160 * 96 * 2);
    await writeFile(path.join(dir, 'alpha.raw'), raw);
    const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'shaky.mp4', kind: 'video', binId: 'all', duration: 3, fps: 24, resolution: '160 × 96', size: '10 KB', status: 'ready', progress: 100, thumbnail: '', hasAudio: false, inputProfile: 'Rec.709', inputGamut: 'Rec.709' };
    const track: Track = { id: 'v1', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
    for (const [sourceIn, firstFrame] of [[1, 24], [1 + .7 / 24, 25]]) {
      const key = 'e'.repeat(64), masks = path.join(dir, `masks-${firstFrame}`), cache = path.join(masks, key);
      await mkdir(path.join(cache, 'frames'), { recursive: true });
      await exec(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'gray16le', '-video_size', '160x96', '-framerate', '24', '-i', path.join(dir, 'alpha.raw'), '-start_number', '0', path.join(cache, 'frames', '%d.png')]);
      const clip: Clip = { id: 'clip', projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: 'Shaky', trackId: 'v1', start: 0, duration: 1, sourceIn, color: 'red', disabled: false, properties: { ...defaultProperties }, effects: [{ id: 'fx', name: 'Stabilize', enabled: true, amount: 100, parameters: { crop: 6 } }, { id: 'cut', name: 'Smart Mask', enabled: true, amount: 100, maskId: 'subject' }] };
      const mask = createSmartMask(clip, asset, 'subject');
      mask.prompts = [{ id: 'point', time: 1, kind: 'include', points: [{ x: .5, y: .5 }], radius: .01 }]; mask.result = { key, signature: smartMaskSignature(mask) }; clip.smartMasks = [mask];
      const manifest: SmartMaskManifest = { version: 1, key, signature: mask.result.signature, projectId: 'project', mediaId: 'asset', sourceFingerprint: maskSourceFingerprint(source), engine: 'authored alpha fixture', modelRevision: 'fixture', quality: 'final', width: 160, height: 96, sourceTimes: Array.from({ length: 72 }, (_, i) => i / 24), range: mask.range, alpha: 'gray16', frames: Array.from({ length: 72 }, (_, i) => ({ index: i, time: i / 24, file: `frames/${i}.png` })).filter(f => f.index >= Math.floor(mask.range.start * 24 + 1e-7) && f.time < mask.range.end - 1e-6) };
      await mkdir(path.join(cache, 'source'));
      for (const f of manifest.frames) await writeFile(path.join(cache, 'source', `${f.index}.jpg`), 'Source image fixture');
      await writeFile(path.join(cache, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(path.join(cache, 'binding.json'), JSON.stringify({ projectId: 'project', clipId: 'clip', maskId: 'subject', signature: mask.result.signature, sourceFingerprint: maskSourceFingerprint(source), analysisIdentity: maskAnalysis(clip, asset).identity, workerIdentity: 'fixture' }));
      const outputPath = path.join(dir, `out-${firstFrame}.mov`);
      await renderTimeline({ project: { id: 'project', resolution: '160 × 96', fps: 24 } as Project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 1 }, tracks: [track], clips: [clip], nodes: [], assets: [{ asset, path: source }], settings: { resolution: '160 × 96', fps: '24', codec: 'Apple ProRes 422 HQ', rangeIn: '0', rangeOut: '1', audio: 'Disabled' }, outputPath, smartMaskDir: masks, stabilizeDir: path.join(dir, 'cache') });
      // Mean luma of the centre of every output frame: 0 while the cutout is empty, the picture once the subject shows.
      const frames = await run(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'crop=80:48:40:24', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { binary: true }), size = 80 * 48;
      const brightness = Array.from({ length: frames.length / size }, (_, k) => frames.subarray(k * size, (k + 1) * size).reduce((sum, value) => sum + value, 0) / size);
      assert.equal(brightness.findIndex(value => value > 40), 30 - firstFrame, `the subject shows from source frame 30 (bake starts on ${firstFrame}): ${brightness.slice(0, 10).map(Math.round).join(' ')}`);
      assert.ok(brightness.slice(30 - firstFrame).every(value => value > 40), 'and stays');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
