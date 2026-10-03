// Real-model depth check: runs Video Depth Anything through the depth service (server/depth.ts) on a clip, then reports
// the analysis speed, the GPU memory peak, whether every segment decodes, and flicker on what stands still.
//   npm run test:depth:inference -- [source video] [--seconds N]
// Without a source it analyses a generated locked-off 1080p shot (testsrc2: fixed patterns, a few moving parts).
// Flicker: per pair of consecutive frames, the mean absolute change of distance (0..100) over the pixels whose picture did
// not change (luma at the depth grid moved at most 1/255); a model that holds still on a still scene reads near zero.
// Env: FRAME_LINE_DEPTH_PYTHON (worker interpreter), FRAME_LINE_DEPTH_WEIGHTS, FFMPEG_PATH, FFPROBE_PATH;
// On CUDA, DEPTH_CHECK_MAX_VRAM (3.5 GB) fails the check and an analysis under DEPTH_CHECK_MIN_FPS (24) warns.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depthCapabilities, depthService } from '../server/depth.ts';
import { smartMaskService } from '../server/smartMask.ts';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const args = process.argv.slice(2), at = args.indexOf('--seconds'), limit = at >= 0 ? Number(args.splice(at, 2)[1]) : 30;
const work = mkdtempSync(join(tmpdir(), 'sharedcut-depth-inference-'));
let source = args[0];

/** Frames of `bytes` each from a process's stdout, pulled one at a time; the process is paused a few frames ahead. */
function frames(command, argv, bytes) {
  const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chunks = [];
  let length = 0, ended = false, wake, errors = '';
  child.stdout.on('data', chunk => { chunks.push(chunk); length += chunk.length; if (length > 4 * bytes) child.stdout.pause(); wake?.(); });
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
  child.on('close', () => { ended = true; wake?.(); });
  return {
    async next() {
      while (length < bytes && !ended) { child.stdout.resume(); await new Promise(resolve => { wake = resolve; }); }
      if (length < bytes) { if (errors.trim()) throw new Error(errors.trim()); return null; }
      const all = Buffer.concat(chunks, length), frame = Buffer.from(all.subarray(0, bytes));
      chunks.length = 0; if (all.length > bytes) chunks.push(all.subarray(bytes)); length -= bytes;
      if (length <= 4 * bytes) child.stdout.resume();
      return frame;
    },
    stop() { child.kill(); },
  };
}

const masks = smartMaskService(join(work, 'masks')), depth = depthService(join(work, 'depth'), { sourceTimes: masks.sourceTimes });
try {
  if (!source) {
    source = join(work, 'locked-off.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=12', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', source]);
  }
  const stream = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', source], { encoding: 'utf8' }));
  const { width, height, avg_frame_rate: rate } = stream.streams[0], [num, den] = rate.split('/').map(Number), fps = num / (den || 1), duration = Number(stream.format.duration);
  const asset = { id: 'source', projectId: 'check', kind: 'video', name: 'source', duration, fps, resolution: `${width} × ${height}`, inputProfile: 'Rec.709', inputGamut: 'Rec.709' };
  const clip = { id: 'clip', projectId: 'check', timelineId: 't', trackId: 'v', mediaId: 'source', name: 'source', start: 0, duration, sourceIn: 0, color: '', disabled: false, properties: {}, effects: [] };
  const capabilities = await depthCapabilities();
  assert.ok(capabilities.available, `Depth is unavailable: ${capabilities.reason}`);
  console.log(`Source ${source}: ${width}x${height} at ${fps.toFixed(3)} fps, ${duration.toFixed(2)} s. Engine ${capabilities.engine} on ${capabilities.device}.`);
  const started = Date.now();
  let run = await depth.enqueue({ clip, asset, sourcePath: source, from: 0, to: Math.max(.05, Math.min(duration, limit) - 1) }); // The run adds a 1 s handle.
  for (let shown = -10; ['queued', 'processing'].includes(run.status); await new Promise(resolve => setTimeout(resolve, 500))) {
    run = depth.get('check', run.key);
    if (run.progress >= shown + 10) { shown = run.progress; console.log(`  ${run.status} ${Math.round(run.progress)} %`); }
  }
  const wall = (Date.now() - started) / 1000;
  assert.equal(run.status, 'ready', `the run did not complete: ${run.error}`);
  const t = run.telemetry ?? {};
  console.log(`Analysed ${run.frames} frames (${run.width}x${run.height}) in ${wall.toFixed(1)} s wall: worker ${t.fps} fps end to end, ${t.analysisFps} fps analysis (model load left out), peak VRAM ${t.peakVram ?? 'n/a'} GB allocated / ${t.reservedVram ?? 'n/a'} GB reserved, head mini-batch ${t.microBatch ?? 'n/a'}.`);

  // Every segment decodes to its frame count; the masters feed the flicker measure against the picture at the same grid.
  const size = run.width * run.height, folder = join(work, 'depth', run.key), span = run.near - run.far;
  const picture = frames(ffmpeg, ['-v', 'error', '-nostdin', '-i', source, '-frames:v', String(run.first + run.frames), '-fps_mode', 'passthrough', '-vf', `scale=${run.width}:${run.height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], size);
  for (let i = 0; i < run.first; i++) await picture.next();
  const perPair = []; let previous, still = 0, compared = 0;
  for (const segment of run.segments) {
    const preview = Number(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', join(folder, 'preview', `${segment.n}.mp4`)], { encoding: 'utf8' }).trim());
    assert.equal(preview, segment.count, `preview segment ${segment.n} decodes to ${segment.count} frames, not ${preview}`);
    const master = frames(ffmpeg, ['-v', 'error', '-nostdin', '-i', join(folder, 'master', `${segment.n}.mkv`), '-f', 'rawvideo', '-pix_fmt', 'gray10le', '-'], size * 2);
    for (let k = 0; k < segment.count; k++) {
      const raw = await master.next(), luma = await picture.next();
      assert.ok(raw, `master segment ${segment.n} ends after ${k} of ${segment.count} frames`);
      assert.ok(luma, 'the source ended before the analysis');
      const values = new Uint16Array(raw.buffer, raw.byteOffset, size);
      if (previous) {
        let sum = 0, n = 0;
        for (let p = 0; p < size; p++) if (Math.abs(luma[p] - previous.luma[p]) <= 1) { sum += Math.abs(values[p] - previous.values[p]); n++; }
        compared += size; still += n;
        if (n > size * .02) perPair.push(sum / n / 1023 / Math.max(span, 1e-4) * 100);
      }
      previous = { luma, values: Uint16Array.from(values) };
    }
    assert.equal(await master.next(), null, `master segment ${segment.n} holds more than ${segment.count} frames`);
  }
  picture.stop();
  const sorted = [...perPair].sort((a, b) => a - b), mean = perPair.reduce((sum, v) => sum + v, 0) / Math.max(1, perPair.length);
  console.log(`Segments: ${run.segments.length} previews and masters decode to their ${run.frames} frames.`);
  console.log(`Flicker in still regions (${(still / Math.max(1, compared) * 100).toFixed(0)} % of pixels, ${perPair.length} frame pairs): mean ${mean.toFixed(3)}, p95 ${(sorted[Math.floor(.95 * (sorted.length - 1))] ?? 0).toFixed(3)}, max ${(sorted.at(-1) ?? 0).toFixed(3)} distance units of 100.`);
  const report = { source, width, height, fps, frames: run.frames, analysis: [run.width, run.height], wallSeconds: wall, telemetry: t, flicker: { mean, p95: sorted[Math.floor(.95 * (sorted.length - 1))] ?? 0, max: sorted.at(-1) ?? 0, pairs: perPair.length, stillFraction: still / Math.max(1, compared) } };
  console.log(JSON.stringify(report));
  if (capabilities.device === 'cuda') {
    const minFps = Number(process.env.DEPTH_CHECK_MIN_FPS) || 24, maxVram = Number(process.env.DEPTH_CHECK_MAX_VRAM) || 3.5;
    // Speed depends on what else holds the GPU (the Dell's desktop takes a third of it), so it warns; memory is a budget.
    if (!(t.analysisFps >= minFps)) console.log(`WARNING: analysis ran at ${t.analysisFps} fps, under the ${minFps} fps target.`);
    assert.ok(t.peakVram <= maxVram, `peak VRAM ${t.peakVram} GB is over ${maxVram} GB`);
  }
} finally {
  await depth.close(); await masks.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
