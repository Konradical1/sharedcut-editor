import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import type { Clip, GradeNode, Project, Timeline, Track, MediaAsset } from '../src/state/models.ts';
import { ADJUSTMENT_MEDIA } from '../src/services/adjustment.ts';
import { primaryDefaults } from '../src/services/color.ts';

test('an adjustment clip grades and moves the composite below it, only inside its own time', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-adjustment-'));
  try {
    const width = 128, height = 64, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const project = { id: 'p', resolution: '128 × 64', fps: 8 } as Project;
    const timeline = { id: 't', projectId: 'p', name: 'Adjust', duration: 1 } as Timeline;
    const track = (id: string, number: number) => ({ id, timelineId: 't', name: id, number, kind: 'video', muted: false, hidden: false, solo: false, locked: false, gain: 0, pan: 0 }) as Track;
    // Left half red, right half blue.
    const video = path.join(dir, 'base.mkv');
    await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xc82828:s=${width}x${height}:r=8:d=1,drawbox=x=64:y=0:w=64:h=64:c=0x2828c8:t=fill`, '-c:v', 'ffv1', video]);
    const asset = { id: 'media', projectId: 'p', name: 'Base', kind: 'video', duration: 1, resolution: '128 × 64', fps: 8, hasAudio: false, inputProfile: 'Rec.709' } as MediaAsset;
    const base: Clip = { id: 'base', projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'media', name: 'Base', start: 0, duration: 1, sourceIn: 0, color: '#fff', disabled: false, effects: [], properties: {} };
    const adjustment: Clip = { ...base, id: 'adj', trackId: 'v2', mediaId: ADJUSTMENT_MEDIA, name: 'Adjustment layer', start: .5, duration: .5, properties: { x: 64 } };
    const grey: GradeNode = { id: 'n', projectId: 'p', clipId: 'adj', name: 'Mono', kind: 'serial', enabled: true, parameters: { ...primaryDefaults, saturation: 0 } };
    const request: RenderRequest = { project, timeline, tracks: [track('v1', 1), track('v2', 2)], clips: [base, adjustment], assets: [{ asset, path: video }], nodes: [grey], settings: { audio: 'Disabled', codec: 'H.264', rangeIn: '0', rangeOut: '1' }, outputPath: path.join(dir, 'out.mp4') };
    await renderTimeline(request);
    const frame = async (at: number) => {
      const pixels = await run(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', request.outputPath, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { binary: true });
      return (x: number, y: number) => [...pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
    };
    const neutral = (p: number[]) => Math.max(...p) - Math.min(...p) < 16;
    const before = await frame(.1), inside = await frame(.75);
    assert.ok(before(100, 32)[2] > 150 && !neutral(before(100, 32)), `before the clip the right half is blue: ${before(100, 32)}`);
    // Moved 64 px right: the red half now sits on the right, graded to grey.
    assert.ok(neutral(inside(100, 32)), `the moved composite is graded: ${inside(100, 32)}`);
    // Uncovered by the move, the picture below shows through ungraded, as Premiere's adjustment layer does.
    assert.ok(inside(10, 32)[0] > 150 && !neutral(inside(10, 32)), `the uncovered edge is the ungraded picture: ${inside(10, 32)}`);

    // Inside a composition it adjusts that composition's lower tracks; the parent sees the adjusted result.
    const nested = { id: 'c', projectId: 'p', name: 'Comp', duration: 1, composition: true } as Timeline;
    const inner = (clip: Clip, trackId: string): Clip => ({ ...clip, timelineId: 'c', trackId });
    const holder: Clip = { ...base, id: 'holder', mediaId: 'frameline-composition', name: 'Comp', properties: { compositionId: 'c' } };
    const composed: RenderRequest = { ...request, timelines: [timeline, nested], tracks: [track('v1', 1), { ...track('c1', 1), timelineId: 'c' }, { ...track('c2', 2), timelineId: 'c' }], clips: [holder, inner(base, 'c1'), inner(adjustment, 'c2')], outputPath: path.join(dir, 'composed.mp4') };
    await renderTimeline(composed);
    request.outputPath = composed.outputPath;
    const outer = await frame(.75), outerBefore = await frame(.1);
    assert.ok(neutral(outer(100, 32)), `graded inside the composition: ${outer(100, 32)}`);
    assert.ok(outerBefore(100, 32)[2] > 150, `untouched before it: ${outerBefore(100, 32)}`);

    // Keyframed, it goes through the per-frame bake and still adjusts what is below.
    const keyed: RenderRequest = { ...request, timelines: undefined, tracks: request.tracks.slice(0, 1).concat(track('v2', 2)), clips: [base, { ...adjustment, keyframes: { 'properties.x': [{ id: 'k1', time: 0, value: 64, interpolation: 'linear' }, { id: 'k2', time: .4, value: 64, interpolation: 'linear' }] } }], outputPath: path.join(dir, 'keyed.mp4') };
    await renderTimeline(keyed);
    request.outputPath = keyed.outputPath;
    const baked = await frame(.75);
    assert.ok(neutral(baked(100, 32)) && baked(10, 32)[0] > 150, `keyframed adjustment: ${baked(100, 32)} / ${baked(10, 32)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
