import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import { depthService } from './depth.ts';
import { maskAnalysis, maskSourceFingerprint, smartMaskService } from './smartMask.ts';
import { venvPython } from './platform.ts';
import { stabilizePython } from './stabilize.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';
import { createSmartMask, smartMaskSignature, type SmartMaskManifest } from '../src/services/smartMask.ts';

// The model-free engine: depth is the source's luma, so bright is near and dark is far.
process.env.FRAME_LINE_DEPTH_ENGINE = 'synthetic';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const python = process.env.FRAME_LINE_DEPTH_PYTHON || venvPython('.venv-mask');
const torch = (() => { try { execFileSync(python, ['-c', 'import torch'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const W = 320, H = 180, FPS = 25;

/** Bright 4 px checker (near) left of x = 60 + 4 n, dark checker (far) right of it, n the source frame. Luma stays inside
 *  video levels so both checkers keep their full contrast in RGB. */
function fixture(name: string, shake = '') {
  const dir = mkdtempSync(path.join(tmpdir(), `frameline-depth-export-test-${name}-`)), source = path.join(dir, 'source.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=${W + 40}x${H + 24}:r=${FPS}:d=3`, '-vf', `geq=lum='if(lt(X,80+4*N),190,20)+30*mod(floor(X/4)+floor(Y/4),2)':cb=128:cr=128,${shake || 'crop=w=320:h=180:x=20:y=12'}`,
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-g', '25', source]);
  const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'source.mp4', kind: 'video', binId: 'all', duration: 3, fps: FPS, resolution: `${W} × ${H}`, size: '1 MB', status: 'ready', progress: 100, thumbnail: '', hasAudio: false, inputProfile: 'Rec.709', inputGamut: 'Rec.709' };
  const masks = smartMaskService(path.join(dir, 'masks')), depth = depthService(path.join(dir, 'depth'), { sourceTimes: masks.sourceTimes });
  const track: Track = { id: 'v1', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
  const clip: Clip = { id: 'clip', projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: 'Checker', trackId: 'v1', start: 0, duration: 2, sourceIn: 0, color: 'red', disabled: false, properties: { ...defaultProperties },
    effects: [{ id: 'depth', name: 'Depth', enabled: true, amount: 100, parameters: { blur: 100, focus: 0, range: 40 } }] };
  const request = (clips: Clip[], duration: number, extra: Partial<RenderRequest> = {}): RenderRequest => ({ project: { id: 'project', resolution: `${W} × ${H}`, fps: FPS } as Project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration }, tracks: [track], clips, nodes: [], assets: [{ asset, path: source }],
    settings: { resolution: `${W} × ${H}`, fps: String(FPS), codec: 'Apple ProRes 422 HQ', rangeIn: '0', rangeOut: String(duration), audio: 'Disabled' }, outputPath: path.join(dir, 'out.mov'), depth, smartMaskDir: path.join(dir, 'masks'), ...extra });
  const close = async () => { await Promise.all([depth.close(), masks.close()]); rmSync(dir, { recursive: true, force: true }); };
  return { dir, source, asset, clip, track, depth, request, close };
}

async function luma(file: string, time: number, width = W, height = H) {
  const data = await run(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { binary: true });
  return (x: number, y: number) => data[y * width + x];
}
/** Mean absolute neighbour difference over columns [from, to): high-frequency detail. */
function detail(at: (x: number, y: number) => number, from: number, to: number, height = H) {
  let sum = 0, n = 0;
  for (let y = 10; y < height - 10; y++) for (let x = from; x < to - 1; x++) { sum += Math.abs(at(x + 1, y) - at(x, y)) + Math.abs(at(x, y + 1) - at(x, y)); n++; }
  return sum / n;
}
/** The first column whose mean luma is dark: where near meets far in the picture. */
function boundary(at: (x: number, y: number) => number, width = W, height = H) {
  for (let x = 16; x < width; x++) { let sum = 0; for (let y = 0; y < height; y++) sum += at(x, y); if (sum / height < 128) return x; }
  return width;
}

test('Depth lens blur exports: the far side loses detail, the near side keeps it, previews too', { timeout: 300_000, skip: !torch && 'the depth worker (torch) is not installed' }, async () => {
  const f = fixture('blur');
  try {
    const request = f.request([f.clip], 2);
    await renderTimeline(request);
    const at = await luma(request.outputPath, 1), cut = boundary(at), source = await luma(f.source, 1);
    assert.ok(Math.abs(cut - 160) <= 4, `the picture is source frame 25 (edge at 160): ${cut}`);
    const sharp = detail(source, 20, 140);
    assert.ok(detail(at, 20, cut - 8) > .9 * sharp, `near stays sharp: ${detail(at, 20, cut - 8)} of ${sharp}`);
    assert.ok(detail(at, cut + 12, 300) < .3 * detail(source, cut + 12, 300), `far is blurred: ${detail(at, cut + 12, 300)} of ${detail(source, cut + 12, 300)}`);
    // A small H.264 export bakes the same way (timeline previews skip Depth ranges; the editor draws them live).
    const preview = path.join(f.dir, 'preview.mp4');
    await renderTimeline({ ...request, outputPath: preview, settings: { ...request.settings, resolution: '160 × 90', codec: 'H.264' } });
    const small = await luma(preview, 1, 160, 90);
    assert.ok(detail(small, 120, 150, 90) < .5 * detail(small, 10, 70, 90), 'the preview is blurred on the far side too');
    assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('frameline-depth-export-') && !name.includes('-test-')).length, 0, 'the bake is cleaned up');
  } finally { await f.close(); }
});

test('a trimmed, fast, reversed clip takes the depth of the frame it shows', { timeout: 300_000, skip: !torch && 'the depth worker (torch) is not installed' }, async () => {
  const f = fixture('timing');
  try {
    // Reads source 0.4..2.0 s backwards at double speed: frame n shows source frame about 50 - 2 n.
    const clip = { ...f.clip, sourceIn: .4, duration: .8, properties: { ...f.clip.properties, speed: 200, reverse: true } };
    const request = f.request([clip], .8);
    await renderTimeline(request);
    const early = await luma(request.outputPath, .2), late = await luma(request.outputPath, .6);
    const a = boundary(early), b = boundary(late);
    assert.ok(a - b > 70 && a - b < 90, `reverse at double speed moves the edge 80 px left in 0.4 s: ${a} -> ${b}`);
    for (const [at, cut] of [[early, a], [late, b]] as const) {
      const near = detail(at, cut - 12, cut - 2), far = detail(at, cut + 3, cut + 13);
      // A depth frame 2+ frames off puts the depth edge 8+ px from the picture's: one of these strips flips.
      assert.ok(near > 12 && far < 4, `edge at ${cut}: near detail ${near}, far detail ${far}`);
    }
  } finally { await f.close(); }
});

test('a keyframed rack focus changes the focus frame by frame', { timeout: 300_000, skip: !torch && 'the depth worker (torch) is not installed' }, async () => {
  const f = fixture('rack');
  try {
    const clip = { ...f.clip, sourceIn: .4, keyframes: { 'effects.depth.parameters.focus': [{ id: 'a', time: 0, value: 0, interpolation: 'linear' as const }, { id: 'b', time: .4, value: 0, interpolation: 'linear' as const }, { id: 'c', time: 1.6, value: 100, interpolation: 'linear' as const }] } };
    const request = f.request([clip], 2);
    await renderTimeline(request);
    const early = await luma(request.outputPath, .2), late = await luma(request.outputPath, 1.8), a = boundary(early), b = boundary(late);
    assert.ok(detail(early, 20, a - 6) > 12 && detail(early, a + 4, Math.min(W, a + 60)) < 4, 'focused near at the start');
    assert.ok(detail(late, 20, b - 6) < 6 && detail(late, b + 4, W) > 12, 'focused far at the end');
  } finally { await f.close(); }
});

/** A full-alpha Smart Mask on every source frame, analysed for `clip` (which must carry a Smart Mask effect on `subject`). */
function fullMatte(f: ReturnType<typeof fixture>, clip: Clip) {
  const key = 'e'.repeat(64), cache = path.join(f.dir, 'masks', key), n = 75;
  mkdirSync(path.join(cache, 'frames'), { recursive: true });
  writeFileSync(path.join(f.dir, 'alpha.raw'), Buffer.alloc(W * H * 2 * n, 0xff));
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'gray16le', '-video_size', `${W}x${H}`, '-framerate', String(FPS), '-i', path.join(f.dir, 'alpha.raw'), '-start_number', '0', path.join(cache, 'frames', '%d.png')]);
  const mask = createSmartMask(clip, f.asset, 'subject');
  mask.prompts = [{ id: 'point', time: 1, kind: 'include', points: [{ x: .5, y: .5 }], radius: .01 }]; mask.result = { key, signature: smartMaskSignature(mask) }; clip.smartMasks = [mask];
  const manifest: SmartMaskManifest = { version: 1, key, signature: mask.result.signature, projectId: 'project', mediaId: 'asset', sourceFingerprint: maskSourceFingerprint(f.source), engine: 'fixture', modelRevision: 'fixture', quality: 'final', width: W, height: H, sourceTimes: Array.from({ length: n }, (_, i) => i / FPS), range: mask.range, alpha: 'gray16',
    frames: Array.from({ length: n }, (_, i) => ({ index: i, time: i / FPS, file: `frames/${i}.png` })).filter(frame => frame.time >= mask.range.start - 1e-6 && frame.time < mask.range.end - 1e-6) };
  mkdirSync(path.join(cache, 'source'));
  for (const frame of manifest.frames) writeFileSync(path.join(cache, 'source', `${frame.index}.jpg`), 'Source image fixture');
  writeFileSync(path.join(cache, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(cache, 'binding.json'), JSON.stringify({ projectId: 'project', clipId: clip.id, maskId: 'subject', signature: mask.result.signature, sourceFingerprint: maskSourceFingerprint(f.source), analysisIdentity: maskAnalysis(clip, f.asset).identity, workerIdentity: 'fixture' }));
}

// A matte sends the pre-depth pass down the exact-colour path, which looked up the frame before the half-frame-early
// seek: the bake ran one source frame early against its depth, and its first frame (before the matte) was black.
test('a Smart Mask above Depth keeps the picture and its depth on the same frame', { timeout: 300_000, skip: (!torch || !existsSync(process.env.FRAME_LINE_COLOR_PYTHON || venvPython('.venv-color'))) && 'the depth or colour worker is not installed' }, async () => {
  const f = fixture('mask');
  try {
    const clip: Clip = { ...f.clip, sourceIn: .4, duration: 1.2, effects: [{ id: 'cut', name: 'Smart Mask', enabled: true, amount: 100, maskId: 'subject' }, ...f.clip.effects] };
    fullMatte(f, clip);
    const request = f.request([clip], 1.2);
    await renderTimeline(request);
    for (const time of [0, .2, .6, 1]) {
      const at = await luma(request.outputPath, time), cut = boundary(at), expected = 60 + 4 * Math.round((.4 + time) * FPS);
      assert.ok(Math.abs(cut - expected) <= 1, `at ${time} s the picture is source frame ${Math.round((.4 + time) * FPS)} (edge at ${expected}): ${cut}`);
      const near = detail(at, cut - 12, cut - 2), far = detail(at, cut + 3, cut + 13);
      assert.ok(near > 12 && far < 4, `at ${time} s the depth edge sits on the picture's (${cut}): near detail ${near}, far detail ${far}`);
    }
  } finally { await f.close(); }
});

// A timeline preview is a 4 s range of the whole project: it baked every Depth clip whole, hidden ones included.
test('only the Depth this render shows is analysed and baked, and only over the range', { timeout: 300_000, skip: !torch && 'the depth worker (torch) is not installed' }, async () => {
  const f = fixture('range');
  try {
    // Hidden, or outside the range: Depth draws nothing there, so no analysis is needed and nothing fails.
    await renderTimeline(f.request([f.clip], 2, { tracks: [{ ...f.track, hidden: true }], depth: undefined }));
    const early = f.request([{ ...f.clip, duration: 1 }], 2, { depth: undefined });
    await renderTimeline({ ...early, settings: { ...early.settings, rangeIn: '1.2' } });
    // A range inside the clip bakes that range alone, on the right frames.
    const asked: { from: number; to: number }[] = [], request = f.request([f.clip], 2, { depth: { ready: (job, signal, progress) => { asked.push(job); return f.depth.ready(job, signal, progress); } } });
    await renderTimeline({ ...request, settings: { ...request.settings, rangeIn: '1', rangeOut: '1.6' } });
    assert.equal(asked.length, 1);
    assert.ok(asked[0].from >= .95 && asked[0].to <= 1.7, `analysed ${asked[0].from}..${asked[0].to} s for a 1..1.6 s range`);
    for (const time of [0, .3, .56]) {
      const at = await luma(request.outputPath, time), cut = boundary(at), expected = 60 + 4 * Math.round((1 + time) * FPS);
      assert.ok(Math.abs(cut - expected) <= 1, `at ${time} s the picture is source frame ${Math.round((1 + time) * FPS)} (edge at ${expected}): ${cut}`);
      assert.ok(detail(at, cut - 12, cut - 2) > 12 && detail(at, cut + 3, cut + 13) < 4, `at ${time} s the depth edge sits on the picture's`);
    }
  } finally { await f.close(); }
});

test('a Depth switched on by a keyframe is baked', { timeout: 300_000, skip: !torch && 'the depth worker (torch) is not installed' }, async () => {
  const f = fixture('keyed-on');
  try {
    const clip = { ...f.clip, effects: [{ ...f.clip.effects[0], enabled: false }], keyframes: { 'effects.depth.enabled': [{ id: 'on', time: 0, value: true, interpolation: 'hold' as const }] } };
    const request = f.request([clip], 2);
    await renderTimeline(request);
    const at = await luma(request.outputPath, 1), cut = boundary(at), source = await luma(f.source, 1);
    assert.ok(detail(at, cut + 12, 300) < .3 * detail(source, cut + 12, 300), `far is blurred: ${detail(at, cut + 12, 300)} of ${detail(source, cut + 12, 300)}`);
  } finally { await f.close(); }
});

test('cancelling a Depth export stops the bake and removes its files', { timeout: 300_000, skip: !torch && 'the depth worker (torch) is not installed' }, async () => {
  const f = fixture('cancel'), scratch = path.join(f.dir, 'tmp'), previous = process.env.TMPDIR;
  mkdirSync(scratch);
  try {
    process.env.TMPDIR = scratch;
    const controller = new AbortController();
    const rendering = renderTimeline({ ...f.request([f.clip], 2), signal: controller.signal, onStage: stage => { if (/^Baking depth .* \d+%$/.test(stage)) controller.abort(); } });
    await assert.rejects(rendering, /cancel/i);
    for (let i = 0; i < 50 && readdirSync(scratch).some(name => /^frameline-(depth-export|color)-/.test(name)); i++) await delay(100);
    assert.deepEqual(readdirSync(scratch).filter(name => /^frameline-(depth-export|color)-/.test(name)), [], 'no bake or graph files are left');
    assert.ok(!existsSync(f.request([f.clip], 2).outputPath), 'no output');
  } finally { process.env.TMPDIR = previous; if (previous === undefined) delete process.env.TMPDIR; await f.close(); }
});

test('Depth export refuses what it cannot bake, by name', { timeout: 300_000, skip: !torch && 'the depth worker (torch) is not installed' }, async () => {
  const f = fixture('reject');
  try {
    await assert.rejects(renderTimeline(f.request([{ ...f.clip, properties: { ...f.clip.properties, opticalFlow: true } }], 2)), /needs warped depth/);
    await assert.rejects(renderTimeline(f.request([{ ...f.clip, mediaId: 'frameline-composition', properties: { ...f.clip.properties, compositionId: 'nested' } }], 2)), /not on compositions or titles/);
    await assert.rejects(renderTimeline(f.request([{ ...f.clip, effects: [{ id: 'blur', name: 'Gaussian blur', enabled: true, amount: 50 }, ...f.clip.effects], keyframes: { 'effects.blur.amount': [{ id: 'k0', time: 0, value: 0, interpolation: 'linear' }, { id: 'k1', time: 1, value: 50, interpolation: 'linear' }] } }], 2)), /keyframed grades or effects above Depth/);
    // Variable frame rate: every third frame lands 12 ms late.
    const vfr = path.join(f.dir, 'vfr.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=3`, '-vf', "settb=1/1000,setpts='PTS+if(eq(mod(N,3),0),12,0)'", '-fps_mode', 'passthrough', '-enc_time_base', '1/1000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vfr]);
    await assert.rejects(renderTimeline({ ...f.request([f.clip], 2), assets: [{ asset: f.asset, path: vfr }] }), /constant-frame-rate/);
    // Every section off: Depth is the identity, so nothing is analysed and nothing fails.
    await renderTimeline(f.request([{ ...f.clip, effects: [{ ...f.clip.effects[0], parameters: { blur: 0 } }] }], 2, { depth: undefined }));
  } finally { await f.close(); }
});

test('a stabilized clip warps its depth with the picture', { timeout: 600_000, skip: (!torch || !existsSync(stabilizePython())) && 'the depth or stabilize worker is not installed' }, async () => {
  // Up to 12 px of shake: depth left on the original framing would sit that far off the stabilized picture's edge.
  const f = fixture('stabilize', "crop=w=320:h=180:x='20+12*sin(n*.9)':y='12+8*cos(n*1.3)'");
  try {
    const clip = { ...f.clip, sourceIn: .5, duration: 1, effects: [{ id: 'steady', name: 'Stabilize', enabled: true, amount: 100, parameters: { crop: 8 } }, ...f.clip.effects] };
    const request = f.request([clip], 1, { stabilizeDir: path.join(f.dir, 'stabilize') });
    await renderTimeline(request);
    for (const time of [.2, .5, .8]) {
      const at = await luma(request.outputPath, time), cut = boundary(at);
      const near = detail(at, cut - 12, cut - 2), far = detail(at, cut + 3, cut + 13);
      assert.ok(near > 12 && far < 4, `at ${time} s the depth edge sits on the picture's (${cut}): near detail ${near}, far detail ${far}`);
    }
  } finally { await f.close(); }
});
