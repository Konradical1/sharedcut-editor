import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, readdir, link, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { flowFrames, flowTiming } from '../src/services/opticalFlow.ts';
import type { Clip, MediaAsset } from '../src/state/models.ts';
import { run } from './media.ts';

const source = fileURLToPath(new URL('../scripts/optical-flow.m', import.meta.url));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
let executable: Promise<string> | undefined;
let ffmpegEngine: Promise<string> | undefined;
let nativeQueue = Promise.resolve();

/**
 * Two engines, one contract. `flowFrames` hands either of them the exact source timestamp of every
 * output frame; the engine's job is to synthesize a frame at each one.
 *
 *   darwin  VideoToolbox frame-rate conversion, quality prioritization. The best available.
 *   other   FFmpeg `minterpolate`: bidirectional motion estimation with adaptive overlapped block
 *           compensation, so intermediate frames are synthesized rather than cross-dissolved.
 *
 * The identity string is folded into the preview cache key, so moving between hosts or FFmpeg
 * builds invalidates cached flow instead of serving one engine's output as though it were the other's.
 */
export async function flowWorker(): Promise<string> {
  if (process.platform !== 'darwin') return ffmpegEngine ??= (async () => {
    const version = (await run(ffmpeg(), ['-hide_banner', '-version'])).toString().split('\n')[0].trim();
    if (!/\bminterpolate\b/.test((await run(ffmpeg(), ['-hide_banner', '-filters'])).toString())) throw new Error('Optical flow needs an FFmpeg build with the minterpolate filter. Set FFMPEG_PATH to a full build.');
    return `minterpolate-v1 ${version}`;
  })().catch(error => { ffmpegEngine = undefined; throw error; });
  return executable ??= (async () => {
    const id = hash([await readFile(source, 'utf8'), release()]);
    const directory = join(tmpdir(), `frameline-optical-${process.getuid?.() ?? 'user'}-${id}`), binary = join(directory, 'worker');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(binary)) {
      const temporary = `${binary}-${process.pid}`;
      await run('xcrun', ['clang', '-O2', '-fobjc-arc', '-Wno-deprecated-declarations', source, '-framework', 'Foundation', '-framework', 'AVFoundation', '-framework', 'VideoToolbox', '-framework', 'CoreMedia', '-framework', 'CoreVideo', '-o', temporary]);
      await rename(temporary, binary);
    }
    await run(binary, ['--check']); return binary;
  })().catch(error => { executable = undefined; throw error; });
}

/** What the inspector shows next to the Optical flow toggle. */
export const flowEngineLabel = () => process.platform === 'darwin' ? 'Apple VideoToolbox · quality priority' : 'FFmpeg minterpolate · motion compensated';

export async function flowIdentity(clip: Clip, input: string, fps: number, from: number, duration: number, preview: boolean) {
  const file = await stat(input);
  return hash(['color-precision-v2',await flowWorker(), flowTiming(clip), input, file.size, file.mtimeMs, fps, from, duration, preview]);
}

const MAX_RESAMPLE_FPS = 240;
/**
 * Resample the needed source span to a constant rate fine enough that every requested timestamp
 * lands on its own synthesized frame, then select those frames in schedule order. One decode and
 * one interpolation pass per section, rather than a process per frame.
 *
 * ponytail: monotonic schedules with distinct timestamps only. A freeze, or slow motion finer than
 * the 240 fps resampling cap resolves, asks for the same synthesized frame twice and `select` can
 * emit each frame only once; a curve that reverses direction mid-section would need them out of
 * order. Both want the engine to stream raw frames through Node between two FFmpeg processes, so a
 * frame can be written more than once and in any order. Until then they raise, rather than quietly
 * dropping frames and shortening the clip.
 */
async function renderMinterpolate(options: { input: string; output: string; fps: number; sourceFps: number; frames: { time: number; interpolate: boolean }[]; directory: string; signal?: AbortSignal; onProgress?: (value: number) => void }) {
  const { input, output, fps, sourceFps, frames, directory, signal, onProgress } = options;
  const times = frames.map(frame => frame.time);
  const descending = times.length > 1 && times[times.length - 1] < times[0];
  const ordered = descending ? [...times].reverse() : times;
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index] < ordered[index - 1] - 1e-9) throw new Error('Optical flow on this host cannot follow a speed curve that changes direction inside one section. Split the ramp, or render it on the Mac.');
  }
  let smallest = Infinity;
  for (let index = 1; index < ordered.length; index++) { const gap = ordered[index] - ordered[index - 1]; if (gap > 1e-9 && gap < smallest) smallest = gap; }
  if (!Number.isFinite(smallest)) smallest = 1 / Math.max(1, sourceFps);
  const rate = Math.min(MAX_RESAMPLE_FPS, Math.max(Math.ceil(sourceFps), Math.ceil(1 / smallest)));
  const start = ordered[0], indices = ordered.map(time => Math.round((time - start) * rate));
  if (new Set(indices).size !== indices.length) throw new Error(`Optical flow on this host cannot hold a frame, or slow further than ${rate} fps resampling resolves. Remove the freeze, raise the speed, or render it on the Mac.`);

  // Two source frames of lead-in, so the first requested timestamp has motion behind it to estimate
  // from instead of being extrapolated off the front of the section.
  const lead = Math.min(start, 2 / Math.max(1, sourceFps));
  const span = ordered[ordered.length - 1] - start + lead + 2 / Math.max(1, sourceFps);
  const graph = [
    `[0:v]minterpolate=fps=${rate}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff:scd_threshold=10`,
    `trim=start_frame=${Math.round(lead * rate)}`,
    'setpts=PTS-STARTPTS',
    `select='${indices.map(index => `eq(n\\,${index})`).join('+')}'`,
    ...(descending ? ['reverse'] : []),
    `setpts=N/${fps}/TB[v]`,
  ].join(',');
  // One select term per output frame outgrows a Windows command line, so FFmpeg reads the graph
  // from a file. That also keeps the expression clear of two layers of shell quoting.
  const script = join(directory, 'flow.filter');
  await writeFile(script, graph);
  await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', (start - lead).toFixed(6), '-t', span.toFixed(6), '-i', input,
    '-filter_complex_script', script, '-map', '[v]', '-an',
    // `setpts` above already lays the selected frames on the output grid, so `-r` only stamps the
    // container rate. Pairing it with a non-CFR `-fps_mode` is a contradiction FFmpeg rejects.
    '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le',
    '-r', String(fps), '-progress', 'pipe:1', '-nostats', output],
    { signal, duration: frames.length / fps, onProgress });
  onProgress?.(100);
}

export async function renderOpticalFlow(options: { clip: Clip; asset: MediaAsset; input: string; directory: string; fps: number; from?: number; duration?: number; preview?: boolean; signal?: AbortSignal; onProgress?: (value: number) => void }) {
  const { clip, asset, input, directory, fps, signal, onProgress, preview = false, from = 0, duration = clip.duration } = options;
  const key = await flowIdentity(clip, input, fps, from, duration, preview);
  const output = join(directory, `${key}.${preview ? 'mp4' : 'mov'}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (existsSync(output)) { onProgress?.(100); return { key, output }; }
  const temporary = await mkdtemp(join(directory, '.flow-'));
  try {
    const movie = join(temporary, 'flow.mov');
    const frames = flowFrames(clip, fps, asset.fps || fps, asset.duration, from, duration);
    const progress = (value: number) => onProgress?.(value * (preview ? .9 : 1));
    // One interpolation job at a time on either engine: it is the most expensive thing this server
    // runs, and several at once starve the request loop that is feeding them.
    if (process.platform === 'darwin') {
      const job = join(temporary, 'job.json');
      // AVFoundation needs a container suffix; the media store deliberately calls every original
      // "original". Never a symlink — those need elevated privileges on Windows. A hard link costs
      // nothing on the same volume, and a copy is the honest fallback across volumes.
      const nativeInput = join(temporary, 'source.mov');
      try { await link(resolve(input), nativeInput); } catch { await copyFile(resolve(input), nativeInput); }
      await writeFile(job, JSON.stringify({ input: nativeInput, output: movie, fps, frames }));
      const native = nativeQueue.then(async () => { await run(await flowWorker(), [job], { signal, onProgress: progress, jsonProgress: true }); });
      nativeQueue = native.catch(() => {}); await native;
    } else {
      await flowWorker();
      const job = nativeQueue.then(() => renderMinterpolate({ input, output: movie, fps, sourceFps: asset.fps || fps, frames, directory: temporary, signal, onProgress: progress }));
      nativeQueue = job.catch(() => {}); await job;
    }
    let result = movie;
    if (preview) {
      result = join(temporary, 'preview.mp4');
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', movie, '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-qp', '0', '-g', String(Math.max(1, Math.round(fps / 2))), '-pix_fmt', 'yuv422p10le', '-color_range', 'tv', '-movflags', '+faststart', result], { signal });
    }
    if (signal?.aborted) throw new Error('Optical flow cancelled.');
    await rename(result, output); onProgress?.(100);
    return { key, output };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

// Evict only finished previews, never source media or a worker's temporary directory.
export async function trimFlowCache(directory: string, keep: Set<string>, limit = 2 * 1024 ** 3) {
  const files = await Promise.all((await readdir(directory).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mp4$/.test(name)).map(async name => ({ name, ...await stat(join(directory, name)) })));
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a,b) => a.mtimeMs - b.mtimeMs)) {
    if (bytes <= limit) break;
    if (!keep.has(file.name.slice(0, -4))) { await rm(join(directory, file.name), { force: true }); bytes -= file.size; }
  }
}
