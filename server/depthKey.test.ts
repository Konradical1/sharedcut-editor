import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { depthSpan, renderTimeline, run, type RenderRequest } from './media.ts';
import { depthService } from './depth.ts';
import { smartMaskService } from './smartMask.ts';
import { venvPython } from './platform.ts';
import type { Clip, GradeNode, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';

// The model-free depth engine: depth is the source's luma, so the bright half is near and the dark half far.
process.env.FRAME_LINE_DEPTH_ENGINE = 'synthetic';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const colorPython = process.env.FRAME_LINE_COLOR_PYTHON || venvPython('.venv-color');
const depthPython = process.env.FRAME_LINE_DEPTH_PYTHON || (existsSync(venvPython('.venv-mask')) ? venvPython('.venv-mask') : 'python3');
const W = 320, H = 180, FPS = 25;

test('a node keyed to the far region grades only the far pixels in export', { timeout: 300_000, skip: !existsSync(colorPython) && 'the colour worker (npm run setup:color) is not installed' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frameline-depth-key-test-')), source = path.join(dir, 'source.mp4');
  // Left: bright warm checker (near). Right: dark cool checker (far).
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}:d=2`, '-vf',
    `format=rgb24,geq=r='if(lt(X,160),220-20*mod(floor(X/8)+floor(Y/8),2),40)':g='if(lt(X,160),200-20*mod(floor(X/8)+floor(Y/8),2),50)':b='if(lt(X,160),80,120-20*mod(floor(X/8)+floor(Y/8),2))'`,
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-g', '25', source]);
  const masks = smartMaskService(path.join(dir, 'masks')), depth = depthService(path.join(dir, 'depth'), { sourceTimes: masks.sourceTimes, python: depthPython });
  try {
    const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'source.mp4', kind: 'video', binId: 'all', duration: 2, fps: FPS, resolution: `${W} × ${H}`, size: '1 MB', status: 'ready', progress: 100, thumbnail: '', hasAudio: false, inputProfile: 'Rec.709', inputGamut: 'Rec.709' };
    const track: Track = { id: 'v1', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
    const clip: Clip = { id: 'clip', projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: 'Halves', trackId: 'v1', start: 0, duration: 1, sourceIn: .4, color: 'red', disabled: false, properties: { ...defaultProperties }, effects: [] };
    const node: GradeNode = { id: 'far', projectId: 'project', clipId: 'clip', kind: 'primary', name: 'Background', enabled: true, parameters: { offset: .25 }, mask: { source: 'depth', enabled: true, invert: false, amount: 100, near: 50, far: 100, softness: 5 } };
    const request = (nodes: GradeNode[], name: string): RenderRequest => ({ project: { id: 'project', resolution: `${W} × ${H}`, fps: FPS } as Project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 1 }, tracks: [track], clips: [clip], nodes, assets: [{ asset, path: source }],
      settings: { resolution: `${W} × ${H}`, fps: String(FPS), codec: 'Apple ProRes 422 HQ', rangeIn: '0', rangeOut: '1', audio: 'Disabled' }, outputPath: path.join(dir, `${name}.mov`), depth, smartMaskDir: path.join(dir, 'masks') });
    const rgb = async (file: string) => { const data = await run(ffmpeg, ['-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { binary: true }); return (x: number, y: number) => [0, 1, 2].map(c => data[(y * W + x) * 3 + c]); };
    const plainRequest = request([], 'plain'), keyedRequest = request([node], 'keyed'), invertedRequest = request([{ ...node, mask: { ...node.mask!, invert: true } as GradeNode['mask'] }], 'inverted');
    await renderTimeline(plainRequest); await renderTimeline(keyedRequest); await renderTimeline(invertedRequest);
    const plain = await rgb(plainRequest.outputPath), keyed = await rgb(keyedRequest.outputPath), inverted = await rgb(invertedRequest.outputPath);
    const shift = (a: number[], b: number[]) => Math.max(...a.map((v, c) => Math.abs(v - b[c])));
    for (const [x, y] of [[40, 40], [100, 120], [130, 90]]) {
      assert.ok(shift(keyed(x, y), plain(x, y)) <= 2, `near pixel (${x}, ${y}) is unchanged: ${keyed(x, y)} vs ${plain(x, y)}`);
      assert.ok(shift(inverted(x, y), plain(x, y)) > 30, `inverted, the near pixel (${x}, ${y}) is graded: ${inverted(x, y)} vs ${plain(x, y)}`);
    }
    for (const [x, y] of [[200, 40], [260, 120], [300, 90]]) {
      assert.ok(keyed(x, y).every((v, c) => v - plain(x, y)[c] > 30), `far pixel (${x}, ${y}) is graded: ${keyed(x, y)} vs ${plain(x, y)}`);
      assert.ok(shift(inverted(x, y), plain(x, y)) <= 2, `inverted, the far pixel (${x}, ${y}) is unchanged: ${inverted(x, y)} vs ${plain(x, y)}`);
    }
    // Stabilize would need warped depth: refused by name before anything is baked.
    await assert.rejects(() => renderTimeline({ ...keyedRequest, clips: [{ ...clip, effects: [{ id: 'stab', name: 'Stabilize', enabled: true, amount: 100 }] }] }), /depth key and Stabilize/);
  } finally { await Promise.all([depth.close(), masks.close()]); rmSync(dir, { recursive: true, force: true }); }
});

const track: Track = { id: 'v1', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
const keyNode: GradeNode = { id: 'key', projectId: 'project', clipId: 'clip', kind: 'primary', name: 'Key', enabled: true, parameters: {}, mask: { source: 'depth', enabled: true, invert: false, amount: 100, near: 0, far: 100, softness: 5 } };
const fixture = (source: string, w: number, h: number, fps: number, duration: number, clip: Partial<Clip>) => {
  const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'source.mp4', kind: 'video', binId: 'all', duration, fps, resolution: `${w} × ${h}`, size: '1 MB', status: 'ready', progress: 100, thumbnail: '', hasAudio: false, inputProfile: 'Rec.709', inputGamut: 'Rec.709' };
  return { asset, clip: { id: 'clip', projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: 'Clip', trackId: 'v1', start: 0, duration: 1, sourceIn: 0, color: 'red', disabled: false, properties: { ...defaultProperties }, effects: [], ...clip } as Clip };
};
const exportOf = (dir: string, source: string, asset: MediaAsset, clip: Clip, nodes: GradeNode[], name: string, settings: Record<string, string>, depth: RenderRequest['depth']): RenderRequest => {
  const [w, h] = asset.resolution.split(' × ');
  return { project: { id: 'project', resolution: asset.resolution, fps: Number(settings.fps) } as Project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: clip.start + clip.duration }, tracks: [track], clips: [clip], nodes, assets: [{ asset, path: source }],
    settings: { resolution: `${w} × ${h}`, codec: 'Apple ProRes 422 HQ', audio: 'Disabled', ...settings }, outputPath: path.join(dir, `${name}.mov`), depth, smartMaskDir: path.join(dir, 'masks') };
};

test('a depth-keyed In/Out export joins the editor\'s depth run, not a smaller stale one', { timeout: 300_000, skip: !existsSync(colorPython) && 'the colour worker (npm run setup:color) is not installed' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frameline-depth-key-run-')), source = path.join(dir, 'long.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=10', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-g', '25', source]);
  const masks = smartMaskService(path.join(dir, 'masks')), depth = depthService(path.join(dir, 'depth'), { sourceTimes: masks.sourceTimes, python: depthPython });
  try {
    const { asset, clip } = fixture(source, 160, 90, 25, 10, { duration: 6, sourceIn: 2 });
    // An older trim left a ready run over part of the take; each run sets its own near/far.
    const stale = await depth.ready({ clip, asset, sourcePath: source, from: 6, to: 6.2 });
    const editor = await depth.ready({ clip, asset, sourcePath: source, ...depthSpan(clip, asset, [clip], [asset]) });
    stale.release(); editor.release();
    assert.notEqual(stale.run.key, editor.run.key);
    const used: string[] = [];
    const spy: RenderRequest['depth'] = { ready: async (...args) => { const held = await depth.ready(...args); used.push(held.run.key); return held; } };
    await renderTimeline(exportOf(dir, source, asset, clip, [keyNode], 'inout', { fps: '25', rangeIn: '4', rangeOut: '4.2' }, spy));
    assert.deepEqual(used, [editor.run.key], 'the export keys with the run the editor previews');
  } finally { await Promise.all([depth.close(), masks.close()]); rmSync(dir, { recursive: true, force: true }); }
});

test('a depth key does not move a clip trimmed between source frames', { timeout: 300_000, skip: !existsSync(colorPython) && 'the colour worker (npm run setup:color) is not installed' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frameline-depth-key-seek-')), source = path.join(dir, 'count.mp4');
  // 30 fps, luma counts frames 8 levels apart; on a 24 fps timeline, trimmed between source frames 12 and 13.
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x72:r=30:d=1', '-vf', "format=yuv444p,geq=lum='N*8':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-g', '30', source]);
  const masks = smartMaskService(path.join(dir, 'masks')), depth = depthService(path.join(dir, 'depth'), { sourceTimes: masks.sourceTimes, python: depthPython });
  try {
    const { asset, clip } = fixture(source, 128, 72, 30, 1, { duration: .25, sourceIn: .41 });
    const plain = exportOf(dir, source, asset, clip, [], 'plain', { fps: '24', rangeIn: '0', rangeOut: '.25' }, depth), keyed = { ...plain, nodes: [keyNode], outputPath: path.join(dir, 'keyed.mov') };
    await renderTimeline(plain); await renderTimeline(keyed);
    const luma = async (file: string) => [...await run(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { binary: true })].filter((_, i) => i % (128 * 72) === 64 * 128 + 64);
    const a = await luma(plain.outputPath), b = await luma(keyed.outputPath);
    assert.equal(a.length, 6);
    assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 2), `same source frames with and without the key: ${a} vs ${b}`);
  } finally { await Promise.all([depth.close(), masks.close()]); rmSync(dir, { recursive: true, force: true }); }
});
