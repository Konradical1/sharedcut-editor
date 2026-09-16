import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, readdir, symlink } from 'node:fs/promises';
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
let executable: Promise<string> | undefined;
let nativeQueue = Promise.resolve();
export async function flowWorker() {
  if (process.platform !== 'darwin') throw new Error('Optical flow must be processed by the FrameLine server running on your Mac (Apple silicon, macOS 15.4+).');
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

export async function flowIdentity(clip: Clip, input: string, fps: number, from: number, duration: number, preview: boolean) {
  const file = await stat(input);
  return hash(['color-precision-v2',await flowWorker(), flowTiming(clip), input, file.size, file.mtimeMs, fps, from, duration, preview]);
}

export async function renderOpticalFlow(options: { clip: Clip; asset: MediaAsset; input: string; directory: string; fps: number; from?: number; duration?: number; preview?: boolean; signal?: AbortSignal; onProgress?: (value: number) => void }) {
  const { clip, asset, input, directory, fps, signal, onProgress, preview = false, from = 0, duration = clip.duration } = options;
  const key = await flowIdentity(clip, input, fps, from, duration, preview);
  const output = join(directory, `${key}.${preview ? 'mp4' : 'mov'}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (existsSync(output)) { onProgress?.(100); return { key, output }; }
  const temporary = await mkdtemp(join(directory, '.flow-'));
  try {
    const job = join(temporary, 'job.json'), movie = join(temporary, 'flow.mov');
    // AVFoundation needs a container suffix; the media store deliberately calls every original "original".
    const nativeInput=join(temporary,'source.mov');await symlink(resolve(input),nativeInput);
    await writeFile(job, JSON.stringify({ input:nativeInput, output: movie, fps, frames: flowFrames(clip, fps, asset.fps || fps, asset.duration, from, duration) }));
    const native = nativeQueue.then(async () => { await run(await flowWorker(), [job], { signal, onProgress: p => onProgress?.(p * (preview ? .9 : 1)), jsonProgress: true }); });
    nativeQueue = native.catch(() => {}); await native;
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
