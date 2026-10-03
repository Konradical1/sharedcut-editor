import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import type { Clip, Project, Timeline, Track, MediaAsset } from '../src/state/models.ts';
import { defaultShape } from '../src/services/shapes.ts';

test('Screen and Multiply export: black on top vanishes, white box lightens or tints the picture below', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-blend-'));
  try {
    const width = 128, height = 64, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const project = { id: 'p', resolution: '128 × 64', fps: 8 } as Project;
    const timeline = { id: 't', projectId: 'p', name: 'Blend', duration: 1 } as Timeline;
    const track = (id: string, number: number) => ({ id, timelineId: 't', name: id, number, kind: 'video', muted: false, hidden: false, solo: false, locked: false, gain: 0, pan: 0 }) as Track;
    const base: Clip = { id: 'base', projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'frameline-shape', name: 'Base', start: 0, duration: 1, sourceIn: 0, color: '#fff', disabled: false, effects: [], properties: { shapeDocument: JSON.stringify({ ...defaultShape(), x: 0, y: 0, width: 1, height: 1, fill: '#804020' }) } } as Clip;
    // Black frame with a white box in the middle.
    const video = path.join(dir, 'top.mkv');
    await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=8:d=1,drawbox=x=48:y=16:w=32:h=32:c=white:t=fill`, '-c:v', 'ffv1', video]);
    const asset = { id: 'media', projectId: 'p', name: 'Top', kind: 'video', duration: 1, resolution: '128 × 64', fps: 8, hasAudio: false } as MediaAsset;
    const top = (blendMode: string): Clip => ({ ...base, id: 'top', trackId: 'v2', mediaId: 'media', name: 'Top', properties: { blendMode } });
    const render = async (blendMode: string) => {
      const request: RenderRequest = { project, timeline, tracks: [track('v1', 1), track('v2', 2)], clips: [base, top(blendMode)], assets: [{ asset, path: video }], nodes: [], settings: { audio: 'Disabled', codec: 'H.264', rangeIn: '0', rangeOut: '.5' }, outputPath: path.join(dir, `${blendMode}.mp4`) } as RenderRequest;
      await renderTimeline(request);
      const pixels = await run(ffmpeg, ['-v', 'error', '-i', request.outputPath, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { binary: true });
      return (x: number, y: number) => [...pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
    };
    const near = (a: number[], b: number[], what: string) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 12), `${what}: got ${a}, wanted ${b}`);
    const screen = await render('Screen');
    near(screen(8, 8), [128, 64, 32], 'Screen: black leaves the picture below untouched');
    near(screen(64, 32), [255, 255, 255], 'Screen: white turns the picture white');
    const multiply = await render('Multiply');
    near(multiply(8, 8), [0, 0, 0], 'Multiply: black darkens to black');
    near(multiply(64, 32), [128, 64, 32], 'Multiply: white leaves the picture untouched');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
