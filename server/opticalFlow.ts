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
import { venvPython } from './platform.ts';
import { runWorkerProcess } from './processTree.ts';

const source = fileURLToPath(new URL('../scripts/optical-flow.m', import.meta.url));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const portableSource = fileURLToPath(new URL('../scripts/optical-flow.py', import.meta.url));
export const flowPython = () => process.env.FRAME_LINE_FLOW_PYTHON || venvPython('.venv-flow');
let executable: Promise<string> | undefined;
let portableEngine: Promise<string> | undefined;
let nativeQueue = Promise.resolve();

/** Exact source timestamps drive both engines; their identity invalidates cached output. */
export async function flowWorker(): Promise<string> {
  if (process.platform !== 'darwin') return portableEngine ??= (async () => {
    if (!existsSync(flowPython())) throw new Error('Run npm run setup:flow to install portable optical flow.');
    const version = await runWorkerProcess(flowPython(), [portableSource, '--check'], AbortSignal.timeout(60000), undefined, 'Optical flow');
    return `opencv-dis-v1 ${version.trim()} ${hash(await readFile(portableSource, 'utf8'))} ${(await run(ffmpeg(), ['-version'])).toString().split('\n')[0]}`;
  })().catch(error => { portableEngine = undefined; throw error; });
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
export const flowEngineLabel = () => process.platform === 'darwin' ? 'Apple VideoToolbox · quality priority' : 'OpenCV · bidirectional motion compensation';

export async function flowIdentity(clip: Clip, input: string, fps: number, from: number, duration: number, preview: boolean, fit?: [number, number]) {
  const file = await stat(input);
  return hash(['color-precision-v2',await flowWorker(), flowTiming(clip), input, file.size, file.mtimeMs, fps, from, duration, preview, ...(fit ? [fit] : [])]);
}

/**
 * `fit`: bake no larger than this box. An export fits every source into its canvas before anything else touches
 * it, so interpolating a 4K source for a 1080p export spent four times the pixels on detail the export drops.
 * Only the portable engine takes it; the VideoToolbox worker bakes at source size, and its key says so.
 */
export async function renderOpticalFlow(options: { clip: Clip; asset: MediaAsset; input: string; directory: string; fps: number; from?: number; duration?: number; preview?: boolean; fit?: [number, number]; threads?: number; signal?: AbortSignal; onProgress?: (value: number) => void }) {
  const { clip, asset, input, directory, fps, signal, onProgress, preview = false, from = 0, duration = clip.duration, threads = 2 } = options;
  if (signal?.aborted) throw new Error('Optical flow cancelled.');
  const fit = process.platform === 'darwin' ? undefined : options.fit;
  const key = await flowIdentity(clip, input, fps, from, duration, preview, fit);
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
      const spec = join(temporary, 'job.json');
      await writeFile(spec, JSON.stringify({ input: resolve(input), output: movie, fps, frames, ffmpeg: ffmpeg(), ffprobe: process.env.FFPROBE_PATH || 'ffprobe', threads, ...(fit ? { fit } : {}) }));
      const job = nativeQueue.then(() => runWorkerProcess(flowPython(), [portableSource, spec], signal, progress, 'Optical flow'));
      nativeQueue = job.then(() => {}, () => {}); await job;
    }
    let result = movie;
    if (preview) {
      result = join(temporary, 'preview.mp4');
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', movie, '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '16', '-g', String(Math.max(1, Math.round(fps / 2))), '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', result], { signal });
    }
    if (signal?.aborted) throw new Error('Optical flow cancelled.');
    await rename(result, output); onProgress?.(100);
    return { key, output };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

// Evict only finished bakes (previews are .mp4, export bakes .mov), never source media or a worker's temporary directory.
export async function trimFlowCache(directory: string, keep: Set<string>, limit = 2 * 1024 ** 3, extension = 'mp4') {
  const files = await Promise.all((await readdir(directory).catch(() => [])).filter(name => new RegExp(`^[a-f0-9]{64}\\.${extension}$`).test(name)).map(async name => ({ name, ...await stat(join(directory, name)) })));
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a,b) => a.mtimeMs - b.mtimeMs)) {
    if (bytes <= limit) break;
    if (!keep.has(file.name.slice(0, -4))) { await rm(join(directory, file.name), { force: true }); bytes -= file.size; }
  }
}
