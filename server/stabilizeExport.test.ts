import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeMedia, renderTimeline, type RenderRequest } from './media.ts';
import { stabilizePython } from './stabilize.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

test('Stabilize export bakes a shaky clip and rejects conflicting effects', { timeout: 180000 }, async () => {
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
    await assert.rejects(renderTimeline({ ...request, clips: [{ ...clip, properties: { ...clip.properties, opticalFlow: true } }] }), /optical flow/);
    if (!existsSync(stabilizePython())) { console.log('Stabilize worker not installed; skipping the bake.'); return; }
    const progress: number[] = [];
    await renderTimeline({ ...request, onProgress: value => progress.push(value) });
    const output = await probeMedia(request.outputPath);
    assert.ok(Math.abs(output.duration - 2) < .1, `duration ${output.duration}`);
    assert.equal(output.width, 280);
    assert.ok(progress.some(value => value > 0 && value < 45) && progress.at(-1)! >= 99, 'progress spans bake and composite');
    assert.ok(existsSync(path.join(dir, 'cache')) && (await exec('ls', [path.join(dir, 'cache')])).stdout.includes('.path.json'), 'analysis is cached in stabilizeDir');
    // Speed edits reuse the same analysis and keep working on the baked media.
    await renderTimeline({ ...request, clips: [{ ...clip, duration: 1, properties: { ...clip.properties, speed: 200 } }], settings: { ...request.settings, rangeOut: '1' }, outputPath: path.join(dir, 'fast.mp4') });
    assert.ok(Math.abs((await probeMedia(path.join(dir, 'fast.mp4'))).duration - 1) < .1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
