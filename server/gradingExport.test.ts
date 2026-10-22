// Color page v3 through the real export renderer: windows and film take the per-frame colour worker (never a LUT), at the
// preview's source frame numbers, in exports, /api/frames stills and on adjustment clips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import { createStillCache, stillSettings } from './previewCache.ts';
import { venvPython } from './platform.ts';
import { processingStages } from '../src/services/color.ts';
import { applyFilm } from '../src/services/filmLook.ts';
import { ADJUSTMENT_MEDIA } from '../src/services/adjustment.ts';
import type { Clip, GradeNode, MediaAsset, Project, Track } from '../src/state/models.ts';

const ff = process.env.FFMPEG_PATH || 'ffmpeg', skip = !existsSync(process.env.FRAME_LINE_COLOR_PYTHON || venvPython('.venv-color')) && 'the colour worker (npm run setup:color) is not installed';
const project = { id: 'p', fps: 24, resolution: '64 × 36' } as Project;
const track = (id: string, number: number): Track => ({ id, timelineId: 't', number, kind: 'video', name: id, muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 });
const asset = (id: string, resolution = '64 × 36'): MediaAsset => ({ id, projectId: 'p', name: id, kind: 'video', binId: '', thumbnail: '', duration: 2, resolution, fps: 24, size: '', status: 'ready', progress: 100, hasAudio: false, inputProfile: 'Rec.709', inputGamut: 'Rec.709' });
const clip = (id: string, extra: Partial<Clip> = {}): Clip => ({ id, projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'grey', name: id, start: 0, duration: 1, sourceIn: 0, color: '', disabled: false, properties: {}, effects: [], ...extra });
const node = (id: string, clipId: string, order: number, parameters: Record<string, number>): GradeNode => ({ id, projectId: 'p', clipId, name: id, kind: 'serial', enabled: true, order, parameters });
/** Every frame of a render as RGB floats (0-1), from 16-bit samples. */
async function frames(file: string, width = 64, height = 36) {
  const data = await run(ff, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-'], { binary: true, maxBytes: 64 * 1024 * 1024 }), size = width * height * 3;
  return Array.from({ length: data.length / 2 / size }, (_, f) => Float32Array.from({ length: size }, (_, i) => data.readUInt16LE((f * size + i) * 2) / 65535));
}
const at = (frame: Float32Array, x: number, y: number, width = 64) => (frame[(y * width + x) * 3] + frame[(y * width + x) * 3 + 1] + frame[(y * width + x) * 3 + 2]) / 3;
function correlation(a: ArrayLike<number>, b: ArrayLike<number>) {
  let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= b.length;
  let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  return ab / Math.sqrt(aa * bb);
}

test('windows and film export frame by frame: the window places the grade, film grain follows the source frame', { skip, timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-grading-export-'));
  try {
    const grey = path.join(dir, 'grey.mkv'), big = path.join(dir, 'big.mkv');
    await run(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=64x36:r=24:d=2', '-c:v', 'ffv1', '-pix_fmt', 'gbrp', grey]);
    await run(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=256x144:r=24:d=2', '-c:v', 'ffv1', '-pix_fmt', 'gbrp', big]);
    const base: Omit<RenderRequest, 'clips' | 'nodes' | 'outputPath'> = { project, timeline: { id: 't', projectId: 'p', name: 'T', duration: 1 }, tracks: [track('v1', 1), track('v2', 2)],
      assets: [{ asset: asset('grey'), path: grey }, { asset: asset('big', '256 × 144'), path: big }], settings: { fps: '24', resolution: '64 × 36', codec: 'Apple ProRes 4444', audio: 'Disabled', rangeIn: '0', rangeOut: '.5' } };

    // Grain alone, sourceIn at source frame 10: export frame k carries the grain of source frame 10 + k, as the preview draws it.
    const shot = clip('shot', { sourceIn: 10 / 24 }), grain = [node('g', 'shot', 1, { filmGrain: 100, filmGrainColor: 0 })];
    await renderTimeline({ ...base, clips: [shot], nodes: grain, outputPath: path.join(dir, 'grain.mov') });
    const out = await frames(path.join(dir, 'grain.mov')), stage = processingStages(shot, grain).find(s => s.type === 'film')!;
    assert.equal(out.length, 12);
    const flat = new Float32Array(64 * 36 * 3).fill(128 / 255), reference = (frame: number) => applyFilm(flat, 64, 36, stage as never, frame);
    for (const k of [0, 3, 11]) {
      const right = correlation(out[k], reference(10 + k)), wrong = Math.max(correlation(out[k], reference(9 + k)), correlation(out[k], reference(11 + k)));
      assert.ok(right > .95 && wrong < .3, `export frame ${k}: grain of source frame ${10 + k} (r ${right.toFixed(3)}), not a neighbour (r ${wrong.toFixed(3)})`);
    }
    // A still runs on the clip's own clock at the project rate: a range from .25 s shows frames 6, 7, ... of its grain.
    const png = path.join(dir, 'grey.png');
    await run(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=64x36', '-frames:v', '1', png]);
    const photo = clip('photo', { mediaId: 'photo' }), photoGrain = [node('g', 'photo', 1, { filmGrain: 100, filmGrainColor: 0 })];
    await renderTimeline({ ...base, assets: [{ asset: { ...asset('photo'), kind: 'image', fps: 0 }, path: png }], clips: [photo], nodes: photoGrain, settings: { ...base.settings, rangeIn: '.25', rangeOut: '.5' }, outputPath: path.join(dir, 'photo.mov') });
    const photoFrames = await frames(path.join(dir, 'photo.mov'));
    for (const k of [0, 4]) assert.ok(correlation(photoFrames[k], reference(6 + k)) > .95, `still frame ${k} carries grain frame ${6 + k}`);

    // A circle window brightens only the middle; a film vignette on a second node darkens the corners. Rendered from a source
    // four times the project size, which grades at the size it ends up on.
    for (const [mediaId, properties] of [['grey', {}], ['big', {}], ['grey', { colorPipeline: 'nodes-v2', inputProfile: 'Gamma 2.4', inputGamut: 'Rec.709' }]] as const) {
      const windowed = clip('w', { mediaId, properties: { ...properties } }), nodes = [node('a', 'w', 1, { offset: .25, circOn: 1, circW: .25, circH: .25, circSoft: .02 }), node('b', 'w', 2, { filmVignette: 100, filmVignetteSize: 60 })];
      await renderTimeline({ ...base, clips: [windowed], nodes, outputPath: path.join(dir, `window-${mediaId}.mov`) });
      const [picture] = await frames(path.join(dir, `window-${mediaId}.mov`)), grey = 128 / 255;
      assert.ok(at(picture, 32, 18) > grey + .15, `${mediaId}: the window's inside is graded (${at(picture, 32, 18)})`);
      assert.ok(Math.abs(at(picture, 12, 18) - grey) < .03, `${mediaId}: outside the window, away from the corners, stays as shot (${at(picture, 12, 18)})`);
      assert.ok(at(picture, 1, 1) < grey - .1, `${mediaId}: the vignette darkens the corners (${at(picture, 1, 1)})`);
    }

    // /api/frames: the same grade as a cached still through the export renderer.
    const stills = createStillCache(path.join(dir, 'stills'), renderTimeline), still = stillSettings(project, 1, .25, 64);
    const nodes = [node('a', 'w', 1, { offset: .25, circOn: 1, circW: .25, circH: .25, circSoft: .02 }), node('b', 'w', 2, { filmVignette: 100, filmVignetteSize: 60, filmGrain: 10 })];
    const jpeg = await stills.still({ ...base, clips: [clip('w')], nodes, settings: still.settings }, undefined, 'png');
    const [image] = await frames(jpeg, still.width, still.height);
    assert.ok(at(image, still.width / 2, still.height / 2, still.width) > at(image, 4, still.height / 2, still.width) + .1 && at(image, 1, 1, still.width) < .4, 'the still shows the window and the vignette');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an adjustment clip with windows and film grades the composite under it, only over its own span', { skip, timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-grading-adjust-'));
  try {
    const grey = path.join(dir, 'grey.mkv');
    await run(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=64x36:r=24:d=2', '-c:v', 'ffv1', '-pix_fmt', 'gbrp', grey]);
    const shot = clip('shot', { duration: 1 }), adjustment = clip('adj', { trackId: 'v2', mediaId: ADJUSTMENT_MEDIA, start: .25, duration: .25 });
    const nodes = [node('a', 'adj', 1, { offset: .25, circOn: 1, circW: .25, circH: .25, circSoft: .02 }), node('b', 'adj', 2, { filmVignette: 100, filmVignetteSize: 30, filmGrain: 30 })];
    for (const transparent of [false, true]) {
      const outputPath = path.join(dir, `adjust-${transparent}.mov`);
      await renderTimeline({ project, timeline: { id: 't', projectId: 'p', name: 'T', duration: 1 }, tracks: [track('v1', 1), track('v2', 2)], clips: [shot, adjustment], nodes,
        assets: [{ asset: asset('grey'), path: grey }], settings: { fps: '24', resolution: '64 × 36', codec: 'Apple ProRes 4444', audio: 'Disabled', rangeIn: '0', rangeOut: '1' }, outputPath, transparent });
      const out = await frames(outputPath), g = 128 / 255;
      assert.equal(out.length, 24);
      for (const k of [0, 5, 18, 23]) assert.ok(Math.abs(at(out[k], 32, 18) - g) < .01 && Math.abs(at(out[k], 1, 1) - g) < .01, `frame ${k}, outside the adjustment, is the plain shot`);
      for (const k of [6, 8, 11]) assert.ok(at(out[k], 32, 18) > g + .15 && at(out[k], 1, 1) < g - .1, `frame ${k}: the adjustment's window and vignette are on the composite (${at(out[k], 32, 18)}, ${at(out[k], 1, 1)})`);
      assert.ok(Math.abs(at(out[6], 20, 30) - at(out[7], 20, 30)) > 1e-3 || Math.abs(at(out[6], 40, 8) - at(out[7], 40, 8)) > 1e-3, 'its grain moves from frame to frame');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
