// Cross-platform optical-flow check: does the non-Darwin engine synthesize intermediate motion?
//
// A white box moves exactly 8 px per source frame. Played at 50% speed the engine must place it at
// the half steps (4 px apart). Frame duplication would show a 0,8,0,8 stair instead.
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderOpticalFlow, flowEngineLabel } from '../server/opticalFlow.ts';

const W = 640, H = 120, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const dir = await mkdtemp(join(tmpdir(), 'flowcheck-'));
const src = join(dir, 'src.mp4');
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=2:r=24`,
  '-f', 'lavfi', '-i', 'color=white:s=40x40:d=2:r=24', '-filter_complex', "[0:v][1:v]overlay=x='192*t':y=40", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-y', src]);

const clip = { id: 'c', projectId: 'p', mediaId: 'm', sourceIn: 0, duration: 2, properties: { speed: 50 }, effects: [], name: 'check' };
const asset = { id: 'm', fps: 24, duration: 2 };
const started = Date.now();
const { output } = await renderOpticalFlow({ clip, asset, input: src, directory: join(dir, 'out'), fps: 24 });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 5e8 });
const size = W * H, count = Math.floor(raw.length / size);
const centres = [];
for (let f = 0; f < count; f++) {
  let sum = 0, weight = 0;
  for (let i = 0; i < size; i++) { const v = raw[f * size + i]; if (v > 128) { sum += (i % W) * v; weight += v; } }
  centres.push(weight ? sum / weight : NaN);
}
const steps = centres.slice(1, 25).map((c, i) => c - centres[i]).filter(Number.isFinite);
const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
const worst = Math.max(...steps.map(s => Math.abs(s - mean)));
console.log(`engine        ${flowEngineLabel()}`);
console.log(`frames out    ${count} (expected 48)`);
console.log(`step per out  mean ${mean.toFixed(2)} px, worst deviation ${worst.toFixed(2)} px  (4.00 = true half steps, 0/8 alternating = duplication)`);
console.log(`elapsed       ${seconds}s for 2s of 640x120 @24fps`);
// Duplication is the failure this guards against, and it shows up as a zero step: two output
// frames holding the same source frame. Block estimation on a hard-edged synthetic jitters by a
// pixel or two around the half step, so the mean and the absence of stalls are the real signal.
const stalled = steps.filter(step => Math.abs(step) < 1).length;
console.log(`stalled steps ${stalled} of ${steps.length} (any means a frame was duplicated, not synthesized)`);
const ok = count === 48 && Math.abs(mean - 4) < 0.6 && stalled === 0;
console.log(ok ? 'PASS  intermediate frames are synthesized' : 'FAIL  motion is not being interpolated');
await rm(dir, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
