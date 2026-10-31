// Blackmagic RAW on the server: the helper built by `npm run setup:braw` (scripts/braw/braw.cpp) decodes through Blackmagic's
// RAW SDK with the clip's Camera Raw settings, and FFmpeg writes what it decodes. A clip is developed into a full-resolution
// ProRes 422 HQ master (Film log stays 10-bit 4:2:2, as the camera itself records ProRes), which every other part of
// SharedCut then reads like any original: previews, exports, Smart Mask, Depth, Noise Reduction. Stills for the Color page's
// live Camera Raw preview come straight from the SDK.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { cpus, setPriority } from 'node:os';
import path from 'node:path';
import { admitStart, killProcessTree, trackChild } from './processTree.ts';
import { JOB_COST_BYTES } from './hostGuard.ts';
import { MEDIA_CONCURRENCY, fullPreview } from './media.ts';
import { RAW_KEYS } from '../src/services/braw.ts';
import type { BrawInfo, RawValue } from '../src/state/models.ts';

const root = path.resolve(import.meta.dirname, '..');
export const brawHelper = () => process.env.FRAME_LINE_BRAW || path.join(root, '.braw', process.platform === 'win32' ? 'braw.exe' : 'braw');
const brawLibrary = () => process.env.FRAME_LINE_BRAW_LIB || path.join(path.dirname(brawHelper()), 'lib');
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
export const brawReady = () => existsSync(brawHelper());
export const BRAW_MISSING = 'Blackmagic RAW needs the Blackmagic RAW SDK on this server. Run npm run setup:braw there, then Retry.';
// The share of the machine one media job gets in media.ts; a develop someone is waiting on (new Camera Raw settings) gets
// what an export gets, since it runs alone.
const cores = Math.max(2, cpus().length), jobThreads = String(Math.max(2, Math.floor(cores * 3 / 4 / MEDIA_CONCURRENCY))), aloneThreads = String(Math.max(2, Math.floor(cores * 3 / 4)));
const NICE = Math.max(0, Math.min(19, Number(process.env.FRAME_LINE_MEDIA_NICE) || 10));
// A .braw file is a QuickTime movie: FFmpeg reads its sound, never its picture.
const container = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov'];
/** Developed pictures are video-range BT.709 Y′CbCr with no transfer or primaries tag, like full-v3: the colour pipeline reads their values. */
const toVideo = 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv422p10le,setparams=range=tv:color_primaries=unknown:color_trc=unknown:colorspace=bt709';

const setArgs = (settings: Record<string, RawValue>) => RAW_KEYS.filter(key => settings[key] !== undefined).flatMap(key => ['--set', `${key}=${settings[key]}`]);
/** The master for one set of settings; a change develops a new file beside it, so a running export keeps reading its own. */
export const masterName = (signature: string) => `developed-${createHash('sha256').update(signature).digest('hex').slice(0, 12)}.mov`;
/** Every master except `keep`; one an export still reads fails to delete on Windows and goes with the next develop. */
export async function removeMasters(directory: string, keep: string) {
  for (const name of readdirSync(directory)) if (/^developed-[0-9a-f]{12}\.mov$/.test(name) && name !== keep) await rm(path.join(directory, name), { force: true }).catch(() => {});
}

function start(command: string, args: string[], stdin: 'ignore' | 'pipe') {
  const child = spawn(command, args, { stdio: [stdin, 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  trackChild(child);
  try { setPriority(child.pid!, NICE); } catch { /* Not permitted here. */ }
  return child;
}
const ended = (child: ChildProcess) => new Promise<number>(resolve => { child.on('error', () => resolve(1)); child.on('close', code => resolve(code ?? 1)); });

/** The clip as the SDK reads it: size, rate, camera, the as-shot settings and every choice the Camera Raw panel offers. */
export async function brawInfo(file: string, signal?: AbortSignal): Promise<BrawInfo> {
  if (!brawReady()) throw new Error(BRAW_MISSING);
  const child = start(brawHelper(), ['info', file, '--lib', brawLibrary()], 'ignore');
  let out = '', errors = '';
  child.stdout!.on('data', chunk => { out += chunk; });
  child.stderr!.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  const stop = () => killProcessTree(child);
  signal?.addEventListener('abort', stop, { once: true });
  const code = await ended(child);
  signal?.removeEventListener('abort', stop);
  if (signal?.aborted) throw new Error('Canceled by you');
  if (code) throw new Error(errors.trim().replace(/^braw: /, '') || 'Blackmagic RAW could not read this clip.');
  const raw = JSON.parse(out), metadata = raw.metadata ?? {};
  const settings = raw.settings ?? {}, options = raw.options ?? {};
  // Only a LUT the clip carries can be applied: no .sidecar reaches the server.
  const luts = (options.post_3dlut_mode ?? []).filter((mode: string) => mode === 'Disabled' || (mode === 'Embedded' && metadata.post_3dlut_embedded_name));
  return {
    camera: raw.camera || metadata.camera_type || 'Blackmagic RAW', width: raw.width, height: raw.height, fps: raw.fps, frames: raw.frames, lens: metadata.lens_type || undefined,
    asShot: Object.fromEntries(RAW_KEYS.filter(key => settings[key] !== undefined && settings[key] !== null).map(key => [key, settings[key]])),
    options: { viewing_bmdgen: options.viewing_bmdgen ?? [], viewing_gamut: options.viewing_gamut ?? [], viewing_gamma: options.viewing_gamma ?? [], post_3dlut_mode: luts, iso: options.iso ?? [] },
    ranges: raw.ranges ?? {}, toneCurves: raw.toneCurves ?? {}, scales: raw.scales,
  };
}

/** The helper's frames into FFmpeg. Either failing fails the run: FFmpeg would otherwise finish a short file at the decoder's EOF. */
async function pipeline(decode: string[], encode: string[], options: { signal?: AbortSignal; duration?: number; onProgress?: (percent: number) => void; guard?: boolean }) {
  if (!brawReady()) throw new Error(BRAW_MISSING);
  if (options.signal?.aborted) throw new Error('Canceled by you');
  const release = options.guard ? await admitStart({ kind: 'prepare', costBytes: JOB_COST_BYTES.prepare, label: 'Blackmagic RAW', signal: options.signal }) : undefined;
  try {
    const decoder = start(brawHelper(), decode, 'ignore'), encoder = start(ffmpeg(), encode, 'pipe');
    decoder.stdout!.pipe(encoder.stdin!);
    encoder.stdin!.on('error', () => { /* FFmpeg stopped reading: its own exit says why. */ });
    let decodeErrors = '', encodeErrors = '', progress = '';
    decoder.stderr!.on('data', chunk => { decodeErrors = (decodeErrors + chunk).slice(-4000); });
    encoder.stderr!.on('data', chunk => { encodeErrors = (encodeErrors + chunk).slice(-4000); });
    encoder.stdout!.on('data', chunk => {
      progress += chunk; const lines = progress.split('\n'); progress = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('out_time_us=') && options.duration) options.onProgress?.(Math.max(0, Math.min(99, Number(line.slice(12)) / 1e6 / options.duration * 100)));
    });
    const stop = () => { killProcessTree(decoder); killProcessTree(encoder); };
    options.signal?.addEventListener('abort', stop, { once: true });
    const [decoded, encoded] = await Promise.all([ended(decoder).then(code => { if (code) killProcessTree(encoder); return code; }), ended(encoder).then(code => { if (code) killProcessTree(decoder); return code; })]);
    options.signal?.removeEventListener('abort', stop);
    if (options.signal?.aborted) throw new Error('Canceled by you');
    const said = decodeErrors.split('\n').filter(line => line && !line.startsWith('size ')).join('\n').replace(/^braw: /gm, '').trim();
    if (decoded) throw new Error(`Blackmagic RAW decode failed: ${said || `exit ${decoded}`}`);
    if (encoded) throw new Error(`Media processing failed: ${encodeErrors.trim().slice(-2500) || `exit ${encoded}`}`);
  } finally { release?.(); }
}

/**
 * Develops the whole clip at full resolution with `settings` into `output`, a ProRes 422 HQ movie carrying the clip's sound,
 * and from the same frames `full`, the clip's full-v3 preview, so a new look plays without decoding the master again.
 * `frameRate` is FFmpeg's exact rate for the file (24000/1001), so the master keeps the original's timing.
 */
// ponytail: a master is ~1.5× the .braw on disk (ProRes 422 HQ). Decode exports straight from the SDK if storage gets tight.
export async function developBraw(options: { original: string; output: string; full: string; info: BrawInfo; settings: Record<string, RawValue>; frameRate?: string; audio: boolean; alone?: boolean; signal?: AbortSignal; onProgress?: (percent: number) => void }) {
  const { info } = options, threads = options.alone ? aloneThreads : jobThreads, preview = fullPreview(info.fps);
  const temporary = path.join(path.dirname(options.output), `.developing-${randomUUID()}.mov`), temporaryFull = path.join(path.dirname(options.full), `.developing-${randomUUID()}.mp4`);
  const decode = ['decode', options.original, '--lib', brawLibrary(), '--scale', 'full', '--threads', threads, ...setArgs(options.settings)];
  const sound = (codec: string[]) => options.audio ? ['-map', '1:a:0?', ...codec] : [];
  const encode = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', threads, '-filter_complex_threads', threads, '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-video_size', `${info.width}x${info.height}`, '-framerate', options.frameRate || String(info.fps), '-i', 'pipe:0',
    ...options.audio ? [...container, '-i', options.original] : [], '-progress', 'pipe:1', '-nostats',
    '-filter_complex', `[0:v]${toVideo},split=2[master][picture];[picture]scale=w='min(1920,iw)':h=-2:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1,format=yuv422p10le,${preview.tag}[full]`,
    '-map', '[master]', ...sound(['-c:a', 'pcm_s24le']), '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-threads', threads, '-f', 'mov', temporary,
    '-map', '[full]', ...sound(['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k']), ...preview.codec, '-movflags', '+faststart', '-f', 'mp4', temporaryFull];
  try {
    await pipeline(decode, encode, { signal: options.signal, duration: info.frames / (info.fps || 24), onProgress: options.onProgress, guard: true });
    await rename(temporary, options.output);
    await rename(temporaryFull, options.full);
  } finally { await rm(temporary, { force: true }).catch(() => {}); await rm(temporaryFull, { force: true }).catch(() => {}); }
}

/** One frame developed with `settings`, encoded like full-v3 (1920 wide, 10-bit 4:2:2), for the viewer to grade like the clip's own. */
export async function brawFrame(options: { original: string; output: string; info: BrawInfo; settings: Record<string, RawValue>; frame: number; signal?: AbortSignal }) {
  const scale = options.info.width > 1920 ? 'half' : 'full', [width, height] = options.info.scales?.[scale] ?? [options.info.width, options.info.height];
  const temporary = path.join(path.dirname(options.output), `.frame-${randomUUID()}.mp4`);
  const decode = ['decode', options.original, '--lib', brawLibrary(), '--scale', scale, '--start', String(options.frame), '--count', '1', '--jobs', '1', ...setArgs(options.settings)];
  const encode = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-video_size', `${width}x${height}`, '-framerate', String(options.info.fps || 24), '-i', 'pipe:0',
    '-vf', `scale=w='min(1920,iw)':h=-2:flags=lanczos,${toVideo}`, '-frames:v', '1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv422p10le', '-movflags', '+faststart', temporary];
  try { await pipeline(decode, encode, { signal: options.signal }); await rename(temporary, options.output); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
