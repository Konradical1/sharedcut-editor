import { venvPython, quotedFilterPath } from './platform.ts';
import { killProcessTree } from './processTree.ts';
import { resolveSmartMaskArtifact } from './smartMask.ts';
import type { SmartMaskManifest } from '../src/services/smartMask.ts';
import { activeSmartMasks } from '../src/services/smartMaskPreview.ts';
import { transformMotion, motionArtwork, type MotionPose } from '../src/services/motionBlur.ts';
import { motionBlurFilters } from './motionBlur.ts';
import { renderCaptionTimeline } from './captionRender.ts';
import { isCaption } from '../src/services/captions.ts';
import { animatedSourceOffset, evaluateClip, evaluateNodes, fadeLevel, validateKeyframes } from '../src/services/animation.ts';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { isTitle, getText, drawText, validateText } from '../src/services/text.ts';
import { isShape, getShape, drawShape, validateShape } from '../src/services/shapes.ts';
import { effectValue, effectEnabled } from '../src/services/effects.ts';
import { clipSpan, extendClip } from '../src/services/playback.ts';
import { uncoveredParts } from '../src/services/timeline.ts';
import { isLeakMedia, leakRange, leakIdOf, motionGap, motionSamples, timelineTransitions, transitionDefinitions, type TransitionRecord } from '../src/services/transitions.ts';
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, open, readFile, writeFile, mkdtemp, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Clip, GradeNode, MediaAsset, Project, Timeline, Track } from '../src/state/models.ts';
import { colorTransform, cubeText, makeCube, parseCube, hasACES, interpretation, processingStages } from '../src/services/color.ts';
import { tmpdir, cpus, setPriority } from 'node:os';
import { renderOpticalFlow } from './opticalFlow.ts';
import { renderStabilized, stabilizeWarpMattes } from './stabilize.ts';
import { stabilizeEffect, stabilizeRange, stabilizeSettings } from '../src/services/stabilize.ts';
import { timingPaths } from '../src/services/opticalFlow.ts';

type ProcessOptions = { signal?: AbortSignal; onProgress?: (percent: number) => void; duration?: number; binary?: boolean; maxBytes?: number; jsonProgress?: boolean | 'stderr' };
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = () => process.env.FFPROBE_PATH || 'ffprobe';
// Accept self-contained media only: playlist/concat inputs could read other server files.
const safeInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf,wav,mp3,aac,flac,aiff,ogg,caf,au,flv,image2,image2pipe,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,apng'];

export function run(command: string, args: string[], options: ProcessOptions = {}): Promise<Buffer> {
  if (options.signal?.aborted) return Promise.reject(new Error('Canceled by you'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    // Preparation is background work and must never outrank the request loop that serves uploads
    // and playback. At equal priority, ffmpeg saturating every core pushed a trivial /api/health
    // from 57ms to 6.5s and dragged a local 64 MB/s import down to 1 MB/s.
    try { setPriority(child.pid!, BACKGROUND_NICE); } catch { /* Not permitted here; thread budget still caps the load. */ }
    const chunks: Buffer[] = [];
    let size = 0, stderr = '', progressBuffer = '', jsonBuffer = '', failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { failure = new Error('Canceled by you'); killProcessTree(child, 'SIGTERM'); killTimer = setTimeout(() => killProcessTree(child), 2000); killTimer.unref(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const jsonProgress = (chunk: Buffer) => {
      jsonBuffer += chunk.toString();
      const lines = jsonBuffer.split('\n'); jsonBuffer = (lines.pop() || '').slice(-8000);
      for (const line of lines) { let value: unknown; try { value = JSON.parse(line).progress; } catch { continue; }
        if (typeof value === 'number' && Number.isFinite(value)) options.onProgress?.(Math.max(0, Math.min(100, value)));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (!options.duration || options.binary) {
        size += chunk.length;
        if (size > (options.maxBytes ?? 8 * 1024 * 1024)) { failure = new Error('Media processor output exceeded its safe limit.'); killProcessTree(child); return; }
        chunks.push(chunk);
      }
      if (options.onProgress && !options.binary) {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split('\n'); progressBuffer = lines.pop() || '';
        if (options.jsonProgress === true) jsonProgress(chunk);
        for (const line of lines) if (line.startsWith('out_time_us=')) {
          const seconds = Number(line.slice(12)) / 1_000_000;
          if (Number.isFinite(seconds) && options.duration) options.onProgress(Math.min(99, Math.max(0, seconds / options.duration * 100)));
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); if (options.jsonProgress === 'stderr') jsonProgress(chunk); });
    child.on('error', error => { failure = new Error(`${path.basename(command)} could not start: ${error.message}. Install FFmpeg or set FFMPEG_PATH and FFPROBE_PATH.`); });
    child.on('close', code => {
      clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Media processing failed: ${stderr.trim().slice(-2500) || `exit ${code}`}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export async function getMediaCapabilities() {
  try {
    await Promise.all([run(ffmpeg(), ['-version']), run(ffprobe(), ['-version'])]);
    return { available: true, ffmpeg: ffmpeg(), ffprobe: ffprobe(), hwaccel: await decodeAccelName() };
  } catch (error) { return { available: false, ffmpeg: ffmpeg(), ffprobe: ffprobe(), error: (error as Error).message }; }
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function finite(value: unknown, name: string, min: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return number;
}
function ratio(value?: string) { const [a, b] = (value || '0/1').split('/').map(Number); return a / (b || 1); }
function dimensions(value: string): [number, number] {
  const match = /^(\d+)\s*[×x]\s*(\d+)$/.exec(value);
  if (!match) throw new Error('Choose a supported width × height resolution.');
  const width = finite(match[1], 'Width', 16, 4096), height = finite(match[2], 'Height', 16, 4096);
  if (width % 2 || height % 2) throw new Error('Export dimensions must be even numbers.');
  return [width, height];
}

export async function probeMedia(inputPath: string, signal?: AbortSignal) {
  const file = await stat(inputPath);
  if (!file.isFile()) throw new Error('Media source is not a file.');
  const data = JSON.parse((await run(ffprobe(), ['-v', 'error', ...safeInput, '-show_streams', '-show_format', '-of', 'json', inputPath], { signal })).toString()) as {
    streams: { codec_type: string; codec_name?: string; color_range?: string; color_space?: string; color_primaries?: string; color_transfer?: string; pix_fmt?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; sample_rate?: string; channels?: number; disposition?: { attached_pic?: number } }[];
    format: { duration?: string; format_name?: string };
  };
  const video = data.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  if (!video && !audio) throw new Error('This file contains no decodable video, image, or audio stream.');
  const image = Boolean(video && !audio && /image2|image2pipe|_pipe|gif/.test(data.format.format_name || '') && !Number(data.format.duration));
  const duration = image ? 10 : finite(data.format.duration || video?.duration || audio?.duration, 'Source duration (seconds)', .001, 86400);
  const fps = video && !image ? finite(ratio(video.avg_frame_rate), 'Source frame rate', .01, 1000) : 0;
  if (video) { finite(video.width, 'Source width', 1, 16384); finite(video.height, 'Source height', 1, 16384); }
  const handle = await open(inputPath, 'r');
  let embedded = '';
  try { const head=Buffer.alloc(Math.min(file.size,2*1024*1024)); await handle.read(head,0,head.length,0); embedded=head.toString('latin1'); } finally { await handle.close(); }
  const sony = /(S-Log(?:2|3)?)\/(S-Gamut(?:3(?:\.Cine)?)?)/.exec(embedded);
  // Canon writes no log tag: a CAEP-brand MP4 that is 10-bit with no transfer characteristic is a Canon Log recording, and Canon Log 3 is the camera default.
  const canon = !sony && embedded.slice(0, 1024).includes('CAEP') && /p10|p12|p16/.test(video?.pix_fmt || '') && !video?.color_transfer;
  const color = sony ? { inputProfile: sony[1], inputGamut: sony[2], colorEvidence: 'Embedded Sony camera metadata: '+sony[0] } : canon ? { inputProfile: 'Canon Log 3', inputGamut: 'Cinema Gamut', colorEvidence: 'Canon container (CAEP), 10-bit, untagged transfer: Canon Log 3 / Cinema Gamut assumed; choose Canon Log 2 if the camera was set that way' } : { colorEvidence: video?.color_transfer ? 'Stream transfer tag: '+video.color_transfer+'; verify camera profile' : 'Camera profile untagged; set input manually for log footage' };
  return { ...color, colorRange: video?.color_range || 'unknown', colorMatrix: video?.color_space || (color.inputProfile === 'S-Log3' ? 'bt709' : 'auto'), frameRate: video?.avg_frame_rate, kind: image ? 'image' as const : video ? 'video' as const : 'audio' as const, duration, fps, hasAudio: Boolean(audio), resolution: video ? `${video.width} × ${video.height}` : `${Math.round(Number(audio?.sample_rate || 48000) / 1000)} kHz · ${audio?.channels === 1 ? 'Mono' : 'Stereo'}`, width: video?.width, height: video?.height, size: file.size };
}

/**
 * Every FFmpeg call used to be pinned to 2 threads while one job ran at a time, so a 15-core machine
 * did media work on 13% of itself. The budget is per job because the queue now runs several: threads
 * and concurrency multiply, and oversubscribing them thrashes worse than the old serial pass.
 */
/**
 * Hardware decode is the half worth taking: it cut a full-rate 4K pass from 56s of
 * CPU to 7s, which is what lets several jobs share the machine. Encoding stays on libx264 — the
 * platform encoders have no CRF mode, and these proxies are quality-critical.
 */
/**
 * Never assume an accelerator: probe what this FFmpeg build actually offers and take the first name
 * this platform prefers. `-hwaccel` is best-effort by design, so a stream the device cannot handle
 * (Ada NVDEC has no 4:2:2 HEVC; Blackwell does) decodes in software instead of failing the job.
 * `FRAME_LINE_HWACCEL` forces one by name, or `off` disables the probe entirely.
 */
const ACCEL_PREFERENCE: Record<string, string[]> = {
  darwin: ['videotoolbox'],
  win32: ['cuda', 'd3d11va', 'qsv'],
  linux: ['cuda', 'vaapi', 'qsv'],
};
let accel: Promise<string[]> | undefined;
export const decodeAccel = () => accel ??= (async () => {
  const forced = process.env.FRAME_LINE_HWACCEL;
  if (forced === 'off') return [];
  try {
    const offered = new Set((await run(ffmpeg(), ['-hide_banner', '-hwaccels'])).toString().split('\n').slice(1).map(line => line.trim()).filter(Boolean));
    if (forced) {
      if (offered.has(forced)) return ['-hwaccel', forced];
      console.warn(`FRAME_LINE_HWACCEL=${forced} is not offered by this FFmpeg build (${[...offered].join(', ') || 'none'}). Decoding in software.`);
      return [];
    }
    const chosen = (ACCEL_PREFERENCE[process.platform] ?? []).find(name => offered.has(name));
    return chosen ? ['-hwaccel', chosen] : [];
  } catch { return []; }
})();
/** The accelerator actually in use, for the capabilities endpoint and the migration checks. */
export const decodeAccelName = async () => (await decodeAccel())[1] ?? 'software';

const cores = Math.max(2, cpus().length);
export const MEDIA_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.FRAME_LINE_MEDIA_JOBS) || Math.max(1, Math.floor(cores / 4))));
// Budget 75% of the machine, never all of it. Handing ffmpeg every core leaves nothing for the
// event loop, the uploader feeding this very queue, or the browser — and the queue then starves
// its own input. The reserve is what keeps the server responsive while a whole shoot imports.
const jobThreads = String(Math.max(2, Math.floor(cores * 3 / 4 / MEDIA_CONCURRENCY)));
const BACKGROUND_NICE = Math.max(0, Math.min(19, Number(process.env.FRAME_LINE_MEDIA_NICE) || 10));
/**
 * The grading proxy is the most expensive output and the least urgent: it is only read when someone
 * actually grades a shot, and its H.264 High 4:4:4 Intra profile is not decodable by any browser.
 * A bulk import can skip it and have the startup upgrade pass fill it in later, once the footage is
 * watchable and cuttable.
 */
export const SKIP_COLOR_PROXY = process.env.FRAME_LINE_SKIP_COLOR_PROXY === '1';
// v2: CRF 16. Log footage is low-contrast, so CRF 20 spent ~1.5 Mbit/s and the sky fell apart once a grade
// stretched it; CRF 16 measured 4.5 Mbit/s at 960p60 with half the sky error, same encode time.
export const STREAM_VARIANT = 'stream-v2.mp4';
export const STREAM_LOW_VARIANT = 'stream-low-v1.mp4';
const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', jobThreads, '-filter_threads', jobThreads, '-filter_complex_threads', jobThreads];
/** Scrubbing proxies (all-intra) and two streaming sizes; publish only complete files. */
export async function preparePreviewVariants(options: { inputPath: string; outputDir: string; baseUrl: string; signal?: AbortSignal; onProgress?: (percent: number) => void }) {
  const { inputPath, outputDir, baseUrl, signal } = options;
  const metadata = await probeMedia(inputPath, signal);
  if (metadata.kind !== 'video') throw new Error('Preview variants require a prepared video.');
  await mkdir(outputDir, { recursive: true });
  const temp = await mkdtemp(path.join(outputDir, '.preview-'));
  // All-intra holds every frame as a keyframe, which is what makes scrubbing instant and what makes
  // the file ~80 Mbit/s at 1080p. That is unstreamable off-site, so playback gets a long-GOP variant
  // at roughly a tenth the bitrate; the all-intra proxies stay for frame-accurate work on the LAN.
  const variants = {
    '1/2': { name: 'proxy-half-v1.mp4', width: 960, crf: '16', gop: '1' },
    '1/4': { name: 'proxy-quarter-v1.mp4', width: 480, crf: '16', gop: '1' },
    Stream: { name: STREAM_VARIANT, width: 960, crf: '16', gop: String(Math.max(2, Math.round((metadata.fps || 24) * 2))) },
    StreamLow: { name: STREAM_LOW_VARIANT, width: 480, crf: '20', gop: String(Math.max(2, Math.round((metadata.fps || 24) * 2))) },
  };
  const audioName = 'audio-v1.m4a';
  // An upgrade pass only owes the variants that are missing; re-encoding what is already on disk
  // is a full FFmpeg run of pure waste per asset in the library.
  const pending = Object.values(variants).filter(variant => !existsSync(path.join(outputDir, variant.name)));
  const wantAudio = metadata.hasAudio && !existsSync(path.join(outputDir, audioName));
  const written: string[] = [];
  const args = [...common, ...await decodeAccel(), ...safeInput, '-i', inputPath];
  try {
    if (pending.length || wantAudio) {
      for (const variant of pending) {
        args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'copy', '-vf', `scale=w='min(${variant.width},iw)':h=-2:in_range=${metadata.colorRange === 'pc' ? 'pc' : 'tv'}:out_range=${metadata.colorRange === 'pc' ? 'pc' : 'tv'}:in_color_matrix=bt709:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1`, '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', variant.crf, ...(variant.name === STREAM_LOW_VARIANT ? ['-maxrate','900k','-bufsize','1800k'] : []), '-g', variant.gop, '-pix_fmt', metadata.colorRange === 'pc' ? 'yuvj420p' : 'yuv420p', '-color_range', metadata.colorRange === 'pc' ? 'pc' : 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', path.join(temp, variant.name));
        written.push(variant.name);
      }
      if (wantAudio) { args.push('-map', '0:a:0', '-vn', '-c:a', 'copy', '-movflags', '+faststart', path.join(temp, audioName)); written.push(audioName); }
      if (options.onProgress) args.push('-progress', 'pipe:1', '-nostats');
      await run(ffmpeg(), args, { signal, duration: metadata.duration, onProgress: options.onProgress });
      for (const name of written) await rename(path.join(temp, name), path.join(outputDir, name));
    }
    return { proxyVariants: Object.fromEntries(Object.entries(variants).map(([quality, variant]) => [quality, `${baseUrl}/${variant.name}`])), ...(metadata.hasAudio ? { audioProxyUrl: `${baseUrl}/${audioName}` } : {}) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function prepareMediaThumbnail(inputPath: string, outputDir: string, signal?: AbortSignal) {
  await mkdir(outputDir, { recursive: true });
  const temporary = await mkdtemp(path.join(outputDir, '.thumbnail-'));
  try {
    await run(ffmpeg(), [...common, ...safeInput, '-i', inputPath, '-vf', 'thumbnail=12,scale=480:-2', '-frames:v', '1', path.join(temporary, 'thumbnail.jpg')], { signal });
    await rename(path.join(temporary, 'thumbnail.jpg'), path.join(outputDir, 'thumbnail.jpg'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Grading proxy: one generation from the original, 10-bit 4:2:2, explicit video levels. */
export async function prepareColorProxy(options:{inputPath:string;outputDir:string;baseUrl:string;signal?:AbortSignal}){
  const {inputPath,outputDir,baseUrl,signal}=options,name='color-v1.mp4',output=path.join(outputDir,name);
  if(existsSync(output))return {colorProxyUrl:`${baseUrl}/${name}`};
  const metadata=await probeMedia(inputPath,signal);
  if(metadata.kind!=='video')throw Error('Color preview requires video.');
  await mkdir(outputDir,{recursive:true});const temp=await mkdtemp(path.join(outputDir,'.color-'));
  try{
    const matrix=['bt709','bt470bg','smpte170m','bt2020nc'].includes(metadata.colorMatrix)?metadata.colorMatrix:'auto';
    // `-qp 0` made this file lossless: 3.7 GB from a 232 MB source, 150 Mbit/s, and 84% of everything
    // the media directory held. CRF 14 in the same 10-bit 4:2:2 all-intra format keeps the grading
    // headroom that matters here and lands ~12x smaller. Raise toward 10 if banding shows on a push.
    await run(ffmpeg(),[...common,...await decodeAccel(),...safeInput,'-i',inputPath,'-map','0:v:0','-an','-vf',`scale=w='min(1920,iw)':h=-2:in_color_matrix=${matrix}:out_color_matrix=bt709:in_range=${metadata.colorRange==='pc'?'pc':metadata.colorRange==='tv'?'tv':'auto'}:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1`,'-c:v','libx264','-preset','veryfast','-crf','14','-g','1','-pix_fmt','yuv422p10le','-color_range','tv','-colorspace','bt709','-color_primaries','unknown','-color_trc','unknown','-movflags','+faststart',path.join(temp,name)],{signal});
    await rename(path.join(temp,name),output);return {colorProxyUrl:`${baseUrl}/${name}`};
  }finally{await rm(temp,{recursive:true,force:true});}
}

/** Frames are tiled into one sprite so a clip can show the shot at each point, not one repeated still. */
export const FILMSTRIP_TILE = { width: 96, height: 54 };
export const FILMSTRIP_VERSION = 2;
/**
 * A tile is ~80px on screen, so the frames needed are duration * pixels-per-second / 80. Two per
 * second covers editing zooms up to ~160px/sec before neighbouring tiles start repeating a frame.
 */
export const filmstripFrameCount = (duration: number) => Math.min(240, Math.max(24, Math.round(duration * 2)));

export async function prepareMediaFilmstrip(inputPath: string, outputDir: string, duration: number, signal?: AbortSignal) {
  const frames = filmstripFrameCount(duration), { width, height } = FILMSTRIP_TILE;
  await mkdir(outputDir, { recursive: true });
  const temporary = await mkdtemp(path.join(outputDir, '.filmstrip-'));
  try {
    // A tile is 96px wide, so a 480px proxy already carries five times the detail one can show.
    // Reading the 4K original instead is a full-rate decode of every frame: 28.5s against 0.33s on a
    // 3.5-minute clip. Prefer the smallest variant already on disk; fall back to the original.
    const source = ['proxy-quarter-v1.mp4', 'proxy-half-v1.mp4', 'proxy.mp4']
      .map(name => path.join(outputDir, name)).find(existsSync) ?? inputPath;
    // fps is frames-per-second of output, so frames/duration lands one tile per even slice of the source.
    const filter = `fps=${frames}/${Math.max(duration, 1 / 60)},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},tile=${frames}x1`;
    await run(ffmpeg(), [...common, ...safeInput, '-i', source, '-vf', filter, '-frames:v', '1', '-q:v', '4', path.join(temporary, 'filmstrip.jpg')], { signal });
    await rename(path.join(temporary, 'filmstrip.jpg'), path.join(outputDir, 'filmstrip.jpg'));
    return frames;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** 200 peak windows/sec, across all channels before any downmix (no phase cancellation). */
export async function prepareWaveform(inputPath: string, duration: number, signal?: AbortSignal) {
  // ponytail: cap long-file overviews at 32,768 peaks; use tiled sidecars for sample-level editing of hours-long sources.
  const window = Math.max(240, Math.ceil(duration * 48000 / 32768));
  const filter = `aresample=48000,asetnsamples=n=${window}:p=1,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-`;
  const output = await run(ffmpeg(), [...common, ...safeInput, '-i', inputPath, '-map', '0:a:0', '-vn', '-af', filter, '-f', 'null', '-'], { signal, maxBytes: 8 * 1024 * 1024 });
  const waveform = [...output.toString().matchAll(/lavfi\.astats\.Overall\.Peak_level=([^\r\n]+)/g)].map(([, db]) => {
    const value = Number(db); return Number.isFinite(value) ? Number(Math.min(1, 10 ** (value / 20)).toPrecision(4)) : 0;
  });
  if (!waveform.length) throw new Error('Could not extract an audio waveform.');
  return { waveform, waveformVersion: 2 };
}

export async function prepareMedia(options: { inputPath: string; outputDir: string; baseUrl: string; signal?: AbortSignal; onProgress?: (percent: number) => void; onThumbnail?: (url: string) => void; onStage?: (stage: string) => void; onPlayable?: (asset: Awaited<ReturnType<typeof probeMedia>> & {proxyUrl: string; thumbnail: string}) => void }) {
  const { inputPath, outputDir, baseUrl, signal, onProgress, onThumbnail, onStage, onPlayable } = options;
  onStage?.('Reading camera metadata');
  const metadata = await probeMedia(inputPath, signal);
  await mkdir(outputDir, { recursive: true });
  const proxyName = metadata.kind === 'audio' ? 'audio.m4a' : metadata.kind === 'image' ? 'image.png' : 'proxy.mp4';
  const proxy = path.join(outputDir, proxyName), thumb = path.join(outputDir, 'thumbnail.jpg');
  const input = [...await decodeAccel(), ...safeInput, '-i', inputPath];
  let filmstripFrames = 0, published = false;
  onProgress?.(5);
  try {
    if (metadata.kind !== 'audio') {
      onStage?.('Creating thumbnail');
      await prepareMediaThumbnail(inputPath, outputDir, signal);
      onThumbnail?.(`${baseUrl}/thumbnail.jpg`);
    }
    onStage?.('Creating playable preview');
    if (metadata.kind === 'image') {
      await run(ffmpeg(), [...common, ...input, '-vf', 'scale=w=1920:h=1080:force_original_aspect_ratio=decrease', '-frames:v', '1', proxy], { signal });
    } else {
      const video = metadata.kind === 'video' ? ['-map', '0:v:0', '-vf', `scale=w='min(1920,iw)':h=-2:in_color_matrix=${["bt709","bt470bg","smpte170m","bt2020nc"].includes(metadata.colorMatrix)?metadata.colorMatrix:"auto"}:in_range=${metadata.colorRange==="pc"?"pc":metadata.colorRange==="tv"?"tv":"auto"}:out_range=${metadata.colorRange==="pc"?"pc":"tv"}:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1,setparams=range=${metadata.colorRange==="pc"?"full":"limited"}:color_primaries=bt709:color_trc=bt709:colorspace=bt709`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '1', '-pix_fmt', metadata.colorRange==='pc'?'yuvj420p':'yuv420p', '-color_range', metadata.colorRange==='pc'?'pc':'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'] : ['-vn'];
      await run(ffmpeg(), [...common, ...input, ...video, '-map', '0:a:0?', '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', proxy], { signal, duration: metadata.duration, onProgress: value => onProgress?.(5 + value * .7) });
    }
    onProgress?.(80);
    onStage?.('Preparing audio waveform');
    const peaks = metadata.hasAudio ? await prepareWaveform(inputPath, metadata.duration, signal) : { waveform: [], waveformVersion: 2 };
    onPlayable?.({ ...metadata, ...peaks, proxyUrl: `${baseUrl}/${proxyName}`, thumbnail: metadata.kind === 'audio' ? '' : `${baseUrl}/thumbnail.jpg` });
    published = Boolean(onPlayable);
    if (metadata.kind === 'video') onStage?.('Creating smaller playback previews');
    const previews: Pick<MediaAsset, 'proxyVariants' | 'audioProxyUrl'> = metadata.kind === 'video' ? await preparePreviewVariants({ inputPath: proxy, outputDir, baseUrl, signal, onProgress: value => onProgress?.(80 + value * .19) }) : {};
    // After the variants, so the strip is tiled from the 480px proxy rather than the 4K original.
    if (metadata.kind === 'video') onStage?.('Creating timeline thumbnails');
    if (metadata.kind === 'video') filmstripFrames = await prepareMediaFilmstrip(inputPath, outputDir, metadata.duration, signal);
    if (onPlayable) onPlayable({ ...metadata, ...peaks, ...previews, proxyUrl: `${baseUrl}/${proxyName}`, thumbnail: metadata.kind === 'audio' ? '' : `${baseUrl}/thumbnail.jpg`, ...(filmstripFrames ? { filmstrip: `${baseUrl}/filmstrip.jpg`, filmstripFrames, filmstripVersion: FILMSTRIP_VERSION } : {}) });
    if (metadata.kind === 'video' && !SKIP_COLOR_PROXY) onStage?.('Creating high-precision color preview');
    const colorPreview=metadata.kind==='video'&&!SKIP_COLOR_PROXY?await prepareColorProxy({inputPath,outputDir,baseUrl,signal}):{};
    onProgress?.(100);
    return { ...metadata, ...previews, ...colorPreview, proxyUrl: `${baseUrl}/${proxyName}`, thumbnail: metadata.kind === 'audio' ? '' : `${baseUrl}/thumbnail.jpg`, ...(filmstripFrames ? { filmstrip: `${baseUrl}/filmstrip.jpg`, filmstripFrames, filmstripVersion: FILMSTRIP_VERSION } : {}), ...peaks };
  } catch (error) { if (!published) await rm(proxy, { force: true }); throw error; }
}

function audioFilters(clip: Clip): string[] {
  const p = clip.properties;
  const filters: string[] = [];
  for (const effect of clip.effects.filter(effect => effectEnabled(clip,effect))) {
    const value = (key: string, fallback: number, min: number, max: number) => finite(effectValue(clip,effect,key.slice(effect.name.length+1)), key, min, max);
    if (effect.name === 'EQ') filters.push(`highpass=f=${value('EQ_Low cut', 80, 20, 500)}`, `equalizer=f=3000:t=q:w=1:g=${value('EQ_Presence', 2, -12, 12)}`, `treble=f=10000:g=${value('EQ_Air', 1, -12, 12)}`);
    else if (effect.name === 'Compressor') filters.push(`acompressor=threshold=${10 ** (value('Compressor_Threshold', -18, -60, 0) / 20)}:ratio=${value('Compressor_Ratio', 3, 1, 20)}:attack=${value('Compressor_Attack', 15, 1, 100)}:release=${value('Compressor_Release', 120, 10, 1000)}:makeup=1`);
    else if (effect.name === 'Limiter') filters.push(`volume=${-value('Limiter_Threshold', -6, -24, 0)}dB`, `alimiter=limit=${10 ** (value('Limiter_Ceiling', -1, -12, 0) / 20)}:release=${value('Limiter_Release', 80, 10, 500)}:level=0:latency=1`);
    else if (effect.name === 'Noise Reduction') filters.push(`afftdn=nr=${.01 + value('Noise Reduction_Reduction', 35, 0, 100) * .96}:nf=${-20 - value('Noise Reduction_Sensitivity', 50, 0, 100) * .6}:gs=${Math.round(value('Noise Reduction_Smoothing', 25, 0, 100) / 2)}`);
    else if (!['Film grain', 'Vignette', 'Gaussian blur', 'Sharpen', 'Bloom', 'Smart Mask'].includes(effect.name)) throw new Error(`${clip.name}: ${effect.name} is not supported for audio.`);
  }
  if (p.normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  return filters;
}

function videoFilters(clip: Clip, lutPath: string | undefined, asset: MediaAsset, masks:Map<string,{index:number;timing:string[]}>=new Map()): string[] {
  const matrix=String(clip.properties.yuvMatrix||asset.colorMatrix||(asset.inputProfile?.startsWith('S-Log')?'bt709':'auto')).replace('bt2020-ncl','bt2020nc');
  const range=clip.properties.dataLevels==='Full'?'pc':clip.properties.dataLevels==='Video'?'tv':'auto';
  const filters = lutPath ? [`scale=in_color_matrix=${["bt709","bt470bg","smpte170m","bt2020nc"].includes(matrix)?matrix:"auto"}:in_range=${range}` ,'format=gbrapf32le', `lut3d=file=${quotedFilterPath(lutPath)}:interp=trilinear`] : [];
  for (const effect of clip.effects.filter(effect => effectEnabled(clip,effect))) {
    const amount = finite(effect.amount, `${effect.name} amount`, 0, 100);
    if (!amount) continue;
    if(effect.name==='Smart Mask') {
      const mask=masks.get(effect.maskId!);if(!mask)throw Error(`${clip.name}: Smart Mask has no finished alpha stream.`);
      const label=`sm_${mask.index}_${clip.effects.indexOf(effect)}`,q=amount/100;
      const alpha=effect.parameters?.invert?'(1-B/65535)':'B/65535';
      filters.push(`format=gbrap16le,split=2[${label}rgb][${label}a];[${label}a]extractplanes=a[${label}old];[${mask.index}:v:0]${mask.timing.join(',')},format=gray16le[${label}mask];[${label}old][${label}mask]blend=all_expr='A*(1-${q}+${q}*${alpha})'[${label}new];[${label}rgb][${label}new]mergeplanes=0x00010210:gbrap16le`);
    }
    else if (effect.name === 'Stabilize') { /* Baked into replacement media before compositing; see renderStabilizedTimeline. */ }
    else if (effect.name === 'Film grain') filters.push(`noise=alls=${Math.round(amount / 3)}:allf=t+u:all_seed=${Math.round(effectValue(clip,effect,'seed'))}`);
    else if (effect.name === 'Bloom') {
      const cut = Math.round(effectValue(clip,effect,'threshold') / 100 * 255), gain = (1 / Math.max(.05, 1 - effectValue(clip,effect,'threshold') / 100)).toFixed(3);
      const lift = `clip((val-${cut})*${gain},0,255)`;
      filters.push(`format=gbrp,split=2[bloomsrc][bloomcut];[bloomcut]lutrgb=r='${lift}':g='${lift}':b='${lift}',gblur=sigma=${effectValue(clip,effect,'radius').toFixed(2)}[bloomblur];[bloomsrc][bloomblur]blend=all_mode=screen:all_opacity=${(amount / 100).toFixed(3)}`);
    }
    else if (effect.name === 'Vignette') filters.push(`vignette=angle=${amount / 100 * Math.PI / 3}:x0=w*${effectValue(clip,effect,'centerX')/100}:y0=h*${effectValue(clip,effect,'centerY')/100}`);
    else if (effect.name === 'Gaussian blur') filters.push('premultiply=inplace=1', `gblur=sigma=${amount / 100 * effectValue(clip,effect,'radius')}`, 'unpremultiply=inplace=1');
    else if (effect.name === 'Sharpen') filters.push(`unsharp=${Math.round(effectValue(clip,effect,'radius'))*2+1}:${Math.round(effectValue(clip,effect,'radius'))*2+1}:${amount / 25}`);
    else if (effect.name === 'Noise Reduction') filters.push(`hqdn3d=${amount / 25}:${amount / 25 * .75}:${effectValue(clip,effect,'temporal')}:${effectValue(clip,effect,'temporal')*.75}`);
    else if (!['EQ', 'Compressor', 'Limiter'].includes(effect.name)) throw new Error(`${clip.name}: ${effect.name} is not supported for video. Remove or bypass the effect.`);
  }
  return filters;
}

/** A clip whose own span changes over time, and so cannot be composited in a single pass. */
export const isAnimated = (clip: Clip) => Boolean(Object.keys(clip.keyframes ?? {}).length || isTitle(clip) && getText(clip).typingEnabled);

export interface RenderRequest {
  project: Project; timeline: Timeline; timelines?: Timeline[]; clips: Clip[]; tracks: Track[]; nodes: GradeNode[];
  assets: { asset: MediaAsset; path: string }[]; settings: Record<string, string>; outputPath: string;
  signal?: AbortSignal; onProgress?: (percent: number) => void; onStage?: (stage: string) => void; resolveDir?: string; smartMaskDir?: string; stabilizeDir?: string;
  /** Internal composition renders keep alpha and defer the master limiter to the outer timeline. */
  transparent?: boolean; compositionPath?: string[]; sampledFrame?: boolean;
  transformSamples?: Record<string, MotionPose[]>;
  /** Resolves a light-leak id from the shared overlay pack to a file on disk. */
  overlayPath?: (id: string) => string | null;
  /** Mattes already re-rendered to match a baked picture, keyed `clipId:maskId`. Stabilize fills this so a
   *  Smart Mask lands on the stabilized frame; without it the matte would sit on the original framing. */
  maskArtifacts?: Map<string, { directory: string; manifest: SmartMaskManifest }>;
}

export async function renderTimeline(request: RenderRequest): Promise<void> {
  if(request.clips.some(c=>c.timelineId===request.timeline.id&&isCaption(c)))return renderCaptionTimeline(request);
  if(request.clips.some(c=>c.timelineId===request.timeline.id&&c.mediaId==='frameline-composition'&&!c.disabled))return renderCompositions(request);
  if(!request.sampledFrame&&request.clips.some(c=>c.timelineId===request.timeline.id&&!c.disabled&&stabilizeEffect(c)))return renderStabilizedTimeline(request);
  if(!request.sampledFrame&&request.clips.some(c=>c.timelineId===request.timeline.id&&!c.disabled&&c.properties.opticalFlow))return renderFlowTimeline(request);
  if(!request.sampledFrame&&request.clips.some(c=>c.timelineId===request.timeline.id&&!c.disabled&&isAnimated(c))) {
    // Animated export bakes the timeline down to one flattened clip, which a transition spanning
    // two clips cannot survive. Render each window first and splice it in as an ordinary clip.
    if (timelineTransitions(request.clips.filter(clip => clip.projectId === request.project.id), request.timeline.id, request.assets.map(entry => entry.asset)).length) return renderFlattenedTransitions(request);
    return renderAnimatedTimeline(request);
  }
  const { project, timeline, settings, outputPath, signal, onProgress } = request;
  const fps = finite(settings.fps || project.fps, 'Frame rate', 1, 120);
  const [width, height] = dimensions(settings.resolution || project.resolution);
  const [projectWidth, projectHeight] = dimensions(project.resolution);
  const timelineDuration = finite(timeline.duration, 'Timeline duration', 1 / fps, 21600);
  const rangeIn = finite(settings.rangeIn ?? 0, 'Range in', 0, timelineDuration);
  const rangeOut = finite(settings.rangeOut ?? timelineDuration, 'Range out', rangeIn + 1 / fps - 1e-8, timelineDuration);
  const duration = rangeOut - rangeIn;
  const codec = settings.codec || 'H.264', audio = settings.audio || 'AAC · 320 kb/s · 48 kHz';
  if (settings.subtitles && settings.subtitles !== 'None') throw new Error('Subtitle export is not available. Choose None.');
  if (!['H.264', 'H.265 / HEVC', 'Apple ProRes 422 HQ', 'Apple ProRes 4444'].includes(codec)) throw new Error(`Unsupported export codec: ${codec}`);
  const isProRes = codec.includes('ProRes');
  if (path.extname(outputPath).toLowerCase() !== (isProRes ? '.mov' : '.mp4')) throw new Error(`Choose a ${isProRes ? '.mov' : '.mp4'} filename for ${codec}.`);
  if (audio.startsWith('Linear PCM') && !isProRes) throw new Error('Linear PCM requires a ProRes MOV export. Choose AAC for MP4.');
  if (audio !== 'Disabled' && !/^(AAC · (320|192) kb\/s|Linear PCM · (24|16)-bit) · 48 kHz$/.test(audio)) throw new Error('Choose AAC with 192/320 kb/s, or Linear PCM with 16/24-bit in a MOV export.');
  if (settings.quality && !['Automatic', 'High · 20 Mb/s', 'Maximum · 50 Mb/s', 'Visually lossless'].includes(settings.quality)) throw new Error('Unsupported export quality.');
  const tracks = request.tracks.filter(track => track.timelineId === timeline.id);
  const solo = tracks.some(track => track.solo && !track.muted);
  const clips = request.clips.filter(clip => clip.timelineId === timeline.id && clip.projectId === project.id && !clip.disabled && clip.start < rangeOut && clip.start + clip.duration > rangeIn)
    .sort((a, b) => (tracks.find(track => track.id === a.trackId)?.number ?? 0) - (tracks.find(track => track.id === b.trackId)?.number ?? 0) || a.start - b.start);
  // ponytail: one filter graph per export, capped at 128 inputs; segment rendering if long edits exceed this ceiling.
  if (clips.length > 128) throw new Error('This render range exceeds 128 clips. Export shorter ranges.');
  // Transitions borrow trim handles rather than moving clips, so they widen a clip's rendered
  // span without changing the edit. Windows outside the export range are dropped entirely.
  const transitions = timelineTransitions(request.clips.filter(clip => clip.projectId === project.id), timeline.id, request.assets.map(entry => entry.asset))
    .filter(record => record.start < rangeOut && record.end > rangeIn);
  // A name the registry does not know is reported rather than dropped: a silently missing
  // transition looks exactly like a bug in the edit.
  for (const clip of request.clips.filter(item => item.timelineId === timeline.id && !item.disabled)) {
    for (const name of [clip.transition, clip.properties?.transitionOut]) {
      if (typeof name === 'string' && name && !transitionDefinitions[name]) throw new Error(`${clip.name}: the ${name} transition is not available in this version. Remove it before exporting.`);
    }
  }
  const colorClips = clips.filter(clip => {
    const track = tracks.find(track => track.id === clip.trackId);
    return track?.kind === 'video' && !track.hidden && (activeSmartMasks(clip, request.nodes).length > 0 || clip.properties.colorPipeline === 'nodes-v2' && hasACES(request.nodes, clip.id));
  });
  // Stage weights estimate work, not time; native frame counts supply progress within each stage.
  const colorBudget = colorClips.length ? 50 : 0;
  let colorsDone = 0;
  const overlayInputs = new Map<string, number>();
  const lutDir = await mkdtemp(path.join(tmpdir(), 'frameline-color-'));
  try {
  // FFmpeg's 10-bit YUV overlay darkens translucent RGB on transparent bases.
  // ponytail: groups composite in 8-bit RGB; use a 16-bit RGB compositor when HDR nesting is supported.
  const args = [...common], filters = [`color=c=${request.transparent?'black@0':'black'}:s=${width}x${height}:r=${fps}:d=${duration},format=${request.transparent?'rgba':'yuv444p10le'},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[base]`];
  let inputIndex = 0, currentVideo = 'base';
  const audioLabels: string[] = [];
  // Each side of a cut is split off its own clip chain, so the untouched body of the clip stays
  // bit-identical and only the window pays for the transition.
  const windowSides = new Map<TransitionRecord, { out?: string; in?: string }>();
  let windowIndex = 0;
  const overlayPlace = (shiftX: number, shiftY: number) => `overlay=format=${request.transparent ? 'rgb' : 'yuv444p10'}:alpha=straight:x=(W-w)/2+${shiftX}:y=(H-h)/2+${shiftY}:eof_action=pass:repeatlast=0`;

  const buildWindow = async (record: TransitionRecord) => {
    const definition = transitionDefinitions[record.name];
    const start = Math.max(0, record.start - rangeIn), end = Math.min(duration, record.end - rangeIn);
    const span = end - start;
    if (!definition || span <= 1 / fps) return;
    const shutterAngle = definition.motion ? finite(record.params.shutterAngle ?? 180, `${record.name} shutter angle`, 0, 360) : 0;
    const travel = definition.travel?.({ width, height, params: record.params }) ?? 0;
    const samples = definition.motion ? motionSamples(shutterAngle, travel, span, fps) : 1;
    // Whatever spacing is left between sub-frames is closed with a blur of about half that gap, so
    // a fast move reads as one smear instead of a stack of discrete ghosts.
    const gap = definition.motion ? motionGap(shutterAngle, travel, span, fps) : 0;
    const rate = fps * samples;
    const tag = `x${windowIndex++}`;
    const plan = { duration: span, width, height, fps, params: record.params, samples, tag };
    const sides = windowSides.get(record) ?? {};
    const pixels = 'yuva444p10le';
    // A missing side is transparent black: a head transition fades up out of nothing, and a tail
    // transition fades down into it, which is exactly what "a transition to nothing" means here.
    const prepare = (label: string | undefined, role: 'out' | 'in', name: string) => {
      if (!label) { filters.push(`color=c=black@0:s=${width}x${height}:r=${fps}:d=${span.toFixed(4)},format=${pixels},setsar=1[${name}]`); return; }
      const chain = [`trim=start=${start.toFixed(5)}:end=${end.toFixed(5)}`, 'setpts=PTS-STARTPTS', `fps=${rate}`, 'setsar=1'];
      chain.push(...(definition.ffmpeg.side?.(role, plan) ?? []));
      chain.push(`format=${pixels}`, `trim=duration=${span.toFixed(5)}`, 'setpts=PTS-STARTPTS');
      filters.push(`[${label}]${chain.join(',')}[${name}]`);
    };
    prepare(sides.out, 'out', `${tag}a`);
    prepare(sides.in, 'in', `${tag}b`);
    const xfade = typeof definition.ffmpeg.xfade === 'function' ? definition.ffmpeg.xfade(record.params) : definition.ffmpeg.xfade ?? 'fade';
    if (!/^[a-z]+$/.test(xfade)) throw new Error(`${record.name}: unsupported transition mode.`);
    if (definition.overlay) {
      const cutAt = record.cut - rangeIn - start;
      filters.push(`[${tag}a][${tag}b]blend=all_expr='if(lt(T,${cutAt.toFixed(6)}),A,B)':shortest=1[${tag}x]`);
    } else filters.push(`[${tag}a][${tag}b]xfade=transition=${xfade}:duration=${span.toFixed(4)}:offset=0[${tag}x]`);
    let label = `${tag}x`;

    // The shutter has to close over the *combined* frame. A push or a slide is positioned by
    // xfade itself, so averaging the sides beforehand would average frames that never moved;
    // running the whole branch at a multiple of the frame rate and averaging after the blend is
    // what actually smears the movement. Any residual spacing between sub-frames is blurred out.
    if (samples > 1) {
      const blur = gap > 2 ? `gblur=sigma=${clampNumber(gap / 2.5, .5, 24).toFixed(2)},` : '';
      filters.push(`[${label}]${blur}tmix=frames=${samples}:weights='${Array.from({ length: samples }, () => 1).join(' ')}',fps=${fps},format=${pixels}[${tag}m]`);
      label = `${tag}m`;
    }

    if (definition.overlay) {
      const id = String(record.params.leak ?? '');
      const file = id && request.overlayPath ? request.overlayPath(id) : null;
      if (!file) throw new Error(`${record.name}: choose a light leak before exporting, or remove the transition.`);
      const probed = await probeMedia(file, signal);
      const leakIndex = inputIndex++;
      args.push('-t', String(probed.duration), ...safeInput, '-i', file);
      // Fit the leak to the window rather than cutting it short; these are one-shot bursts.
      const sourceRange = leakRange(record.params, probed.duration);
      const stretch = (record.duration / sourceRange.duration).toFixed(6);
      const skip = Math.max(0, rangeIn - record.start);
      const opacity = (finite(record.params.leakOpacity ?? 100, `${record.name} opacity`, 0, 100) / 100).toFixed(3);
      const mode = ({ Screen: 'screen', Add: 'addition', Overlay: 'overlay' } as Record<string, string>)[String(record.params.blend ?? 'Screen')] ?? 'screen';
      const zoom = finite(record.params.leakZoom ?? 100, 'Overlay zoom', 100, 300) / 100;
      filters.push(`[${leakIndex}:v:0]trim=start=${sourceRange.start.toFixed(6)}:end=${sourceRange.end.toFixed(6)},setpts=(PTS-STARTPTS)*${stretch},fps=${fps},scale=${Math.ceil(width * zoom / 2) * 2}:${Math.ceil(height * zoom / 2) * 2}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=${pixels},trim=start=${skip.toFixed(5)}:duration=${span.toFixed(5)},setpts=PTS-STARTPTS[${tag}l]`);
      filters.push(`[${label}][${tag}l]blend=all_mode=${mode}:all_opacity=${opacity}:shortest=1[${tag}o]`);
      label = `${tag}o`;
      // Expanding the sound to a track replaces this embedded copy, so it must not play twice.
      if (probed.hasAudio && audio !== 'Disabled' && !record.audioClipId) {
        const gain = finite(record.params.leakGain ?? -6, `${record.name} sound`, -60, 12);
        const tempoFilters: string[] = [];
        let tempo = sourceRange.duration / record.duration;
        while (tempo < .5) { tempoFilters.push('atempo=0.5'); tempo /= .5; }
        while (tempo > 2) { tempoFilters.push('atempo=2'); tempo /= 2; }
        tempoFilters.push(`atempo=${tempo.toFixed(6)}`);
        filters.push(`[${leakIndex}:a:0]atrim=start=${sourceRange.start.toFixed(6)}:end=${sourceRange.end.toFixed(6)},asetpts=PTS-STARTPTS,${tempoFilters.join(',')},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${gain}dB,atrim=start=${skip.toFixed(5)}:duration=${span.toFixed(5)},asetpts=PTS-STARTPTS,adelay=${Math.round(start * 48000)}S:all=1[${tag}la]`);
        audioLabels.push(`[${tag}la]`);
      }
    }

    // `[IN]`/`[OUT]` let a definition splice its own streams in without knowing the graph.
    for (const fragment of definition.ffmpeg.after?.(plan) ?? []) {
      filters.push(fragment.replaceAll('[IN]', `[${label}]`).replaceAll('[OUT]', `[${tag}f]`));
      if (fragment.includes('[OUT]')) label = `${tag}f`;
    }
    filters.push(`[${label}]setpts=PTS-STARTPTS+${start.toFixed(5)}/TB,format=${pixels},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[${tag}s]`);
    filters.push(`[${currentVideo}][${tag}s]${overlayPlace(0, 0)}:enable='gte(t,${start.toFixed(5)})*lt(t,${end.toFixed(5)})'[${tag}v]`);
    currentVideo = `${tag}v`;
  };
  for (const clip of clips) {
    finite(clip.start, `${clip.name} start`, 0, timelineDuration);
    finite(clip.duration, `${clip.name} duration`, .001, 21600);
    const track = tracks.find(track => track.id === clip.trackId);
    if (!track) throw new Error(`${clip.name}: track is missing.`);
    let source = request.assets.find(source => source.asset.id === clip.mediaId && source.asset.projectId === project.id);
    if (isTitle(clip) || isShape(clip)) {
      if (track.hidden || track.kind !== 'video') continue;
      const image=createCanvas(projectWidth,projectHeight),context=image.getContext('2d') as unknown as CanvasRenderingContext2D;
      const artwork=(request.transformSamples?.[clip.id]?.length??0)>1?motionArtwork(clip):clip;
      if(isTitle(clip)) {
        const doc=getText(artwork);validateText(doc);
        for(const run of doc.runs)if(!GlobalFonts.has(run.style.fontFamily))throw new Error(`${clip.name}: font “${run.style.fontFamily}” is missing on the server. Upload it to Shared fonts before exporting.`);
        drawText(context,doc,projectWidth,projectHeight,projectWidth,projectHeight,clip.sourceIn+Math.max(0,rangeIn-clip.start),clip.properties.animationTypingCount as number | undefined);
      } else {const doc=JSON.parse(String(artwork.properties.shapeDocument));validateShape(doc);drawShape(context,doc,projectWidth,projectHeight);}
      const png=path.join(lutDir,`graphic-${inputIndex}.png`);await writeFile(png,await image.encode('png'));
      source={path:png,asset:{id:clip.mediaId,projectId:project.id,name:clip.name,kind:'image',binId:'',thumbnail:'',duration:clip.duration,resolution:project.resolution,fps:0,size:'',status:'ready',progress:100}};
    }
    if (!source && isLeakMedia(clip.mediaId)) {
      // A leak expanded onto an audio track plays from the shared pack, not from project media.
      const file = request.overlayPath?.(leakIdOf(clip.mediaId));
      if (!file) throw new Error(`${clip.name}: that light leak is no longer in the shared overlay pack.`);
      const probed = await probeMedia(file, signal);
      source = { path: file, asset: { id: clip.mediaId, projectId: project.id, name: clip.name, kind: 'audio', binId: '', thumbnail: '', duration: probed.duration, resolution: '', fps: probed.fps, size: '', status: 'ready', progress: 100, hasAudio: probed.hasAudio, inputProfile: 'Rec.709' } };
    }
    if (!source) throw new Error(`${clip.name}: original media is missing. Import the source file before exporting.`);
    // Picture is rendered over the widened span so the transition has frames to work with, while
    // the sound stays on the clip's own bounds — a picture transition must not double the audio.
    const span = clipSpan(clip, transitions);
    const geo = extendClip(clip, Math.max(0, span.start), span.end - Math.max(0, span.start));
    const p = geo.properties;
    const property = (key: string, fallback: number, min: number, max: number) => finite(p[key] ?? fallback, `${clip.name} ${key}`, min, max);
    const visual = track.kind === 'video' && source.asset.kind !== 'audio' && !track.hidden;
    const explicitAudio = clips.some(other => other.id !== clip.id && tracks.find(t => t.id === other.trackId)?.kind === 'audio' && other.mediaId === clip.mediaId && other.start === clip.start && other.sourceIn === clip.sourceIn && other.duration === clip.duration);
    const audible = audio !== 'Disabled' && source.asset.hasAudio && !p.freeze && !track.muted && (!solo || track.solo) && !(track.kind === 'video' && (clip.properties.audioDetached || explicitAudio));
    if (!visual && !audible) continue;
    if (p.blendMode && p.blendMode !== 'Normal') throw new Error(`${clip.name}: ${p.blendMode} blending is not available. Choose Normal.`);

    const speed = property('speed', 100, 1, 800) / 100;
    const localStart = Math.max(rangeIn - geo.start, 0), localEnd = Math.min(geo.duration, rangeOut - geo.start), length = localEnd - localStart;
    const offset = Math.max(0, geo.start - rangeIn);
    const sourceIn = finite(geo.sourceIn, `${clip.name} source in`, 0, 86400);
    const sourceStep = 1 / Math.max(1, source.asset.fps || fps);
    // Hold the source frame containing the requested time. A fractional seek
    // followed by a one-frame -t can otherwise decode zero frames in FFmpeg.
    const seek = source.asset.kind === 'image' ? sourceIn : p.freeze ? Math.floor(sourceIn / sourceStep + 1e-7) * sourceStep : sourceIn + (p.reverse ? geo.duration - localEnd : localStart) * speed;
    const sourceLength = p.freeze ? sourceStep : length * speed;
    // A transition window reaches past the media when neither clip at the cut has handles left. The
    // preview holds the last frame there (`sourceTime` clamps), so the export clones it too rather
    // than decoding frames that do not exist and coming up short.
    const decoded = source.asset.kind === 'image' ? sourceLength : Math.min(sourceLength, Math.max(0, source.asset.duration - seek));
    const holdSeconds = (sourceLength - decoded) / speed;
    // Sound keeps the untouched edit; these offsets trim the widened stream back to the clip.
    const audioStart = Math.max(rangeIn - clip.start, 0), audioEnd = Math.min(clip.duration, rangeOut - clip.start);
    const audioLength = Math.max(0, audioEnd - audioStart), audioOffset = Math.max(0, clip.start - rangeIn);
    // Measured on the clip's own trim, not the widened span: a held transition tail is allowed to
    // run past the media, a clip whose stored trim does is still a broken edit.
    if (source.asset.kind !== 'image' && !p.freeze && clip.sourceIn + clip.duration * speed > source.asset.duration + .1) throw new Error(`${clip.name}: the trim and speed extend beyond the original media. Shorten the clip or reduce its speed.`);
    if (p.reverse && sourceLength > 60) throw new Error(`${clip.name}: reverse playback buffers frames in memory. Export reverse segments of 60 seconds or less.`);
    if (source.asset.kind === 'image') args.push('-loop', '1', '-framerate', String(fps));
    else args.push('-ss', String(seek));
    args.push('-t', String(source.asset.kind === 'image' ? length : decoded), ...safeInput, '-i', source.path);
    const index = inputIndex++;
    if (visual) {
      let base;
      if (p.resolveLookUrl && p.bypassResolveLook !== true) {
        const match = /^\/api\/projects\/([a-zA-Z0-9_-]+)\/resolve\/([a-zA-Z0-9_-]+\.cube)$/.exec(String(p.resolveLookUrl));
        if (!match || match[1] !== project.id || !request.resolveDir) throw new Error(`${clip.name}: Resolve look is unavailable.`);
        base = parseCube(await readFile(path.join(request.resolveDir, match[2]), 'utf8'));
      }
      let videoIndex=index;
      const usedMasks=activeSmartMasks(clip,request.nodes),maskStreams=new Map<string,{index:number;timing:string[]}>();
      const exactColor=usedMasks.length>0||clip.properties.colorPipeline==='nodes-v2'&&hasACES(request.nodes,clip.id);
      if(exactColor){
        const metadata=await probeMedia(source.path,request.signal),colorSource=interpretation(clip,source.asset);
        const jobPath=path.join(lutDir,`${index}.json`),output=path.join(lutDir,`${index}.mkv`);
        const matrix=String(p.yuvMatrix||source.asset.colorMatrix||metadata.colorMatrix||'auto').replace('bt2020-ncl','bt2020nc');
        const masks=usedMasks.map(document=>{
          if(!request.smartMaskDir)throw Error(`${clip.name}: Smart Mask storage is unavailable.`);
          // A baked picture (Stabilize) hands over its own re-warped matte; everything else resolves the stored one.
          const artifact=request.maskArtifacts?.get(`${clip.id}:${document.id}`)??resolveSmartMaskArtifact(request.smartMaskDir,clip,document,source.path,source.asset),manifest=artifact.manifest;
          // A reviewed tracked selection is exportable. Its "preview" identity is
          // retained: exporting it does not turn segmentation into hair matting.
          if(manifest.width!==metadata.width||manifest.height!==metadata.height)throw Error(`${clip.name}: Smart Mask dimensions differ from the source.`);
          const times=manifest.sourceTimes!,step=1/(metadata.fps||fps);
          if(times.some((t,i)=>i>0&&Math.abs(t-times[i-1]-step)>Math.max(.000003,step*.001)))throw Error(`${clip.name}: Smart Mask export currently requires constant-frame-rate source footage. Convert this source to constant frame rate and reanalyze.`);
          return {document,sourceTimes:times,files:Object.fromEntries(manifest.frames.map(f=>[String(f.index),path.join(artifact.directory,f.file)])),...(clip.effects.some(e=>e.maskId===document.id&&effectEnabled(clip,e)&&e.amount>0)?{output:path.join(lutDir,`${index}-${document.id}.mkv`)}:{})};
        });
        const times=masks[0]?.sourceTimes,renderSeek=times?.filter(t=>t<=seek+1e-7).at(-1)??seek;
        const frameTimes=times?.filter(t=>t>=renderSeek-1e-7&&t<renderSeek+decoded-1e-7);
        const inputCube=clip.properties.colorPipeline!=='nodes-v2'?makeCube(colorTransform(clip,source.asset,[],base),65):undefined;
        await writeFile(jobPath,JSON.stringify({input:source.path,output,ffmpeg:ffmpeg(),image:source.asset.kind==='image',seek:renderSeek,duration:decoded,width:metadata.width,height:metadata.height,fps:source.asset.kind==='image'?fps:metadata.frameRate||metadata.fps,numericFps:metadata.fps||fps,frames:frameTimes?.length??Math.ceil(decoded*(metadata.fps||fps)),frameTimes,masks,alpha:masks.length>0,managed:clip.properties.colorPipeline==='nodes-v2',...(inputCube?{inputCube:{...inputCube,data:Array.from(inputCube.data)}}:{}),matrix:['bt709','bt470bg','smpte170m','bt2020nc'].includes(matrix)?matrix:'auto',range:p.dataLevels==='Full'?'pc':p.dataLevels==='Video'?'tv':'auto',stages:processingStages({...clip,properties:{...p,inputProfile:colorSource.profile,inputGamut:colorSource.gamut}},request.nodes)}));
        const python=process.env.FRAME_LINE_COLOR_PYTHON||venvPython('.venv-color');
        if(!existsSync(python))throw Error('OpenColorIO export is not installed. Run npm run setup:color on the server.');
        const colorStage = `Processing color · ${clip.name} (${colorsDone + 1}/${colorClips.length})`;
        request.onStage?.(colorStage);
        await run(python,[path.resolve('scripts/color-render.py'),jobPath],{signal:request.signal,jsonProgress:'stderr',onProgress:p=>{
          request.onStage?.(`${colorStage} · ${Math.floor(p)}%`);
          onProgress?.((colorsDone+p/100)/colorClips.length*colorBudget);
        }});
        onProgress?.(++colorsDone/colorClips.length*colorBudget);
        args.push('-i',output);videoIndex=inputIndex++;
        for(const mask of masks)if(mask.output){
          args.push('-i',mask.output);const timing=['setpts=PTS-STARTPTS'];
          if(p.freeze)timing.push('trim=end_frame=1',`tpad=stop_mode=clone:stop_duration=${length}`);
          else{if(p.reverse)timing.push('reverse');timing.push(`setpts=(PTS-STARTPTS)/${speed}`);if(holdSeconds>1e-6)timing.push(`tpad=stop_mode=clone:stop_duration=${holdSeconds.toFixed(5)}`);}
          timing.push(`fps=${fps}`,`trim=duration=${length}`,'setsar=1');maskStreams.set(mask.document.id,{index:inputIndex++,timing});
        }
      }
      const video = [`setpts=PTS-STARTPTS`];
      if (p.freeze) video.push('trim=end_frame=1', `tpad=stop_mode=clone:stop_duration=${length}`);
      else {
        if (p.reverse && source.asset.kind !== 'image') video.push('reverse');
        if (source.asset.kind !== 'image') video.push(`setpts=(PTS-STARTPTS)/${speed}`);
        if (holdSeconds > 1e-6) video.push(`tpad=stop_mode=clone:stop_duration=${holdSeconds.toFixed(5)}`);
      }
      const lutPath = exactColor ? undefined : path.join(lutDir, `${index}.cube`);
      if(lutPath)await writeFile(lutPath, cubeText(makeCube(colorTransform(clip, source.asset, request.nodes, base), clip.properties.colorPipeline==='nodes-v2'||request.nodes.some(n=>n.clipId===clip.id&&(n.curves||n.effects?.length))?65:base?.size ?? 33)));
      video.push(`fps=${fps}`, `trim=duration=${length}`, 'setsar=1', ...videoFilters(clip, lutPath, source.asset,maskStreams));
      const zoom = property('zoom', 100, 1, 800) / 100;
      const left = property('cropLeft', 0, 0, 16384), right = property('cropRight', 0, 0, 16384), top = property('cropTop', 0, 0, 16384), bottom = property('cropBottom', 0, 0, 16384);
      // Crop is measured on the fitted project canvas, preserving the original framing.
      video.push(`scale=w=${projectWidth}:h=${projectHeight}:force_original_aspect_ratio=decrease`, 'format=gbrap16le', `pad=${projectWidth}:${projectHeight}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      if (left + right >= projectWidth || top + bottom >= projectHeight) throw new Error(`${clip.name}: crop removes the entire frame.`);
      if (left || right || top || bottom) video.push(`crop=${projectWidth - left - right}:${projectHeight - top - bottom}:${left}:${top}`, `pad=${projectWidth}:${projectHeight}:${left}:${top}:color=black@0`);
      const scaledWidth = Math.max(2, Math.round(width * zoom / 2) * 2), scaledHeight = Math.max(2, Math.round(height * zoom / 2) * 2);
      if (scaledWidth * scaledHeight > 64_000_000) throw new Error(`${clip.name}: zoom requires too much memory at this resolution. Reduce Zoom.`);
      const poses=request.transformSamples?.[clip.id];
      const motion=poses&&poses.length>1;
      if(!motion)video.push(`scale=${scaledWidth}:${scaledHeight}`);
      const rotation = property('rotation', 0, -360, 360) * Math.PI / 180;
      if (rotation&&!motion) video.push(`rotate=${rotation}:ow=rotw(${rotation}):oh=roth(${rotation}):c=none`);
      video.push(`colorchannelmixer=aa=${property('opacity', 100, 0, 100) / 100}`);
      const fadeDuration=property('fadeDuration',clip.duration,.001,86400),fadeOrigin=property('fadeOrigin',0,-86400,86400);
      const fadeIn=property('fadeIn',0,0,fadeDuration),fadeOut=property('fadeOut',0,0,fadeDuration);
      if(fadeIn||fadeOut) {
        video.push(`setpts=PTS-STARTPTS+${localStart+fadeOrigin}/TB`);
        if(fadeIn)video.push(`fade=t=in:st=0:d=${fadeIn}:alpha=1`);
        if(fadeOut)video.push(`fade=t=out:st=${fadeDuration-fadeOut}:d=${fadeOut}:alpha=1`);
      }
      video.push(`setpts=PTS-STARTPTS+${offset}/TB`, 'scale=out_color_matrix=bt709:out_range=tv', `format=${request.transparent?'rgba':'yuva444p10le'}`, 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709');
      const x = property('x', 0, -100000, 100000) * width / projectWidth, y = property('y', 0, -100000, 100000) * height / projectHeight;
      const shape=isShape(clip)?getShape(clip):undefined;
      const anchorX = property('anchorX', 0, -100000, 100000) * width / projectWidth+(shape?(shape.x+shape.width/2-.5)*width:0), anchorY = property('anchorY', 0, -100000, 100000) * height / projectHeight+(shape?(shape.y+shape.height/2-.5)*height:0);
      const shiftedX = motion?0:x + anchorX - zoom * (anchorX * Math.cos(rotation) - anchorY * Math.sin(rotation));
      const shiftedY = motion?0:y + anchorY - zoom * (anchorX * Math.sin(rotation) + anchorY * Math.cos(rotation));
      filters.push(`[${videoIndex}:v:0]${video.join(',')}[${motion?'motionbase':'clipv'}${index}]`);
      if(motion)filters.push(...motionBlurFilters(`motionbase${index}`,`clipv${index}`,poses,width,height,projectWidth,projectHeight,fps,length));
      const touching = transitions.filter(record => record.outgoingId === clip.id || record.incomingId === clip.id);
      const visible = `gte(t,${offset})*lt(t,${offset + length})`;
      if (!touching.length) filters.push(`[${currentVideo}][clipv${index}]${overlayPlace(shiftedX, shiftedY)}:enable='${visible}'[v${index}]`);
      else {
        // One branch per window plus the body, so the clip outside its transitions is untouched.
        const branches = touching.map((_, n) => `w${index}_${n}`);
        filters.push(`[clipv${index}]split=${branches.length + 1}[body${index}]${branches.map(name => `[${name}]`).join('')}`);
        const outside = touching.map(record => `(1-(gte(t,${Math.max(0, record.start - rangeIn).toFixed(5)})*lt(t,${Math.min(duration, record.end - rangeIn).toFixed(5)})))`).join('*');
        filters.push(`[${currentVideo}][body${index}]${overlayPlace(shiftedX, shiftedY)}:enable='${visible}*${outside}'[v${index}]`);
        touching.forEach((record, n) => {
          const sides = windowSides.get(record) ?? {};
          if (record.outgoingId === clip.id) sides.out = branches[n];
          if (record.incomingId === clip.id) sides.in = branches[n];
          windowSides.set(record, sides);
        });
      }
      currentVideo = `v${index}`;
      // The clip a transition is stored on is always the later participant, so by the time it is
      // rendered both sides exist and the window can composite in its natural z-position.
      for (const record of transitions.filter(record => record.clipId === clip.id)) await buildWindow(record);
    }
    if (audible) {
      const sound = ['asetpts=PTS-STARTPTS'];
      if (p.reverse) sound.push('areverse');
      let tempo = speed;
      while (tempo < .5) { sound.push('atempo=0.5'); tempo /= .5; }
      while (tempo > 2) { sound.push('atempo=2'); tempo /= 2; }
      // Unity atempo can shift quiet onsets; nested mixes must preserve the original samples.
      if(Math.abs(tempo-1)>1e-9)sound.push(`atempo=${tempo}`);
      sound.push(...audioFilters(clip), 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
      const gain = property('gain', 0, -60, 12) + finite(track.gain, `${track.name} gain`, -60, 12);
      const pan = Math.max(-1, Math.min(1, (property('pan', 0, -100, 100) + finite(track.pan, `${track.name} pan`, -100, 100)) / 100));
      // Match the browser StereoPannerNode: move both stereo channels toward the selected side.
      const cosine = Math.cos(Math.abs(pan) * Math.PI / 2), sine = Math.sin(Math.abs(pan) * Math.PI / 2);
      const fadeDuration=property('fadeDuration',clip.duration,.001,86400),fadeOrigin=property('fadeOrigin',0,-86400,86400);
      const fadeIn=property('audioFadeIn',0,0,fadeDuration),fadeOut=property('audioFadeOut',0,0,fadeDuration);
      const lead = Math.max(0, audioOffset - offset);
      if (lead > 1e-9) sound.push(`atrim=start=${lead}`, 'asetpts=PTS-STARTPTS');
      if(fadeIn||fadeOut) {sound.push(`asetpts=PTS-STARTPTS+${audioStart+fadeOrigin}/TB`);if(fadeIn)sound.push(`afade=t=in:st=0:d=${fadeIn}`);if(fadeOut)sound.push(`afade=t=out:st=${fadeDuration-fadeOut}:d=${fadeOut}`);sound.push('asetpts=PTS-STARTPTS');}
      sound.push(`volume=${gain}dB`, `pan=stereo|c0=${pan > 0 ? cosine : 1}*c0+${pan < 0 ? sine : 0}*c1|c1=${pan > 0 ? sine : 0}*c0+${pan < 0 ? cosine : 1}*c1`, `atrim=duration=${audioLength}`, `adelay=${Math.round(audioOffset * 48000)}S:all=1`);
      filters.push(`[${index}:a:0]${sound.join(',')}[clipa${index}]`); audioLabels.push(`[clipa${index}]`);
    }
  }
  filters.push(`[${currentVideo}]format=${isProRes ? codec.endsWith('4444') ? 'yuva444p10le' : 'yuv422p10le' : 'yuv420p'},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[video]`);
  if (audio !== 'Disabled') {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`);
    const masterGain = finite(settings.masterGain ?? 0, 'Master gain', -60, 12);
    if (settings.masterMuted && !['true', 'false'].includes(settings.masterMuted)) throw new Error('Master mute must be true or false.');
    filters.push(`[silence]${audioLabels.join('')}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0:dropout_transition=0,volume=${settings.masterMuted === 'true' ? '0' : `${masterGain}dB`}${request.transparent||request.sampledFrame?'':',alimiter=limit=1:level=0:latency=1'}[audio]`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[video]');
  if (audio !== 'Disabled') args.push('-map', '[audio]', '-c:a', audio.startsWith('Linear PCM') ? request.transparent||request.sampledFrame ? 'pcm_f32le' : audio.includes('24-bit') ? 'pcm_s24le' : 'pcm_s16le' : 'aac', ...(!audio.startsWith('Linear PCM') ? ['-b:a', audio.includes('192') ? '192k' : '320k'] : []), '-ar', '48000');
  if (isProRes) args.push('-c:v', 'prores_ks', '-profile:v', codec.endsWith('4444') ? '4' : '3', '-vendor', 'apl0');
  else {
    args.push('-c:v', codec === 'H.264' ? 'libx264' : 'libx265', '-preset', 'fast', '-crf', settings.quality === 'Visually lossless' ? '12' : settings.quality?.startsWith('Maximum') ? '16' : '20');
    if (settings.quality?.includes('20 Mb/s')) args.push('-maxrate', '20M', '-bufsize', '40M');
    if (settings.quality?.includes('50 Mb/s')) args.push('-maxrate', '50M', '-bufsize', '100M');
    if (codec !== 'H.264') args.push('-tag:v', 'hvc1', '-x265-params', 'pools=2:frame-threads=2:log-level=error');
  }
  args.push('-threads', '2', '-t', String(duration), '-r', String(fps), '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  request.onStage?.('Encoding video and audio');
  onProgress?.(colorBudget);
  try { await run(ffmpeg(), args, { signal, duration, onProgress: p => onProgress?.(colorBudget+p*(100-colorBudget)/100) }); onProgress?.(100); }
  catch (error) { await rm(outputPath, { force: true }); throw error; }
  } finally { await rm(lutDir, { recursive: true, force: true }); }
}


/**
 * Pre-render every transition window, then hand an ordinary timeline to the animated bake.
 * `uncoveredParts` trims each side back to the window edge exactly as an overwrite does, so the
 * spliced clip carries both the blended picture and the sound for that interval, and the parts
 * either side keep their original source timing.
 */
async function renderFlattenedTransitions(request: RenderRequest) {
  const directory = await mkdtemp(path.join(tmpdir(), 'frameline-transition-'));
  try {
    const own = request.clips.filter(clip => clip.projectId === request.project.id);
    const records = timelineTransitions(own, request.timeline.id, request.assets.map(entry => entry.asset));
    const fps = finite(request.settings.fps || request.project.fps, 'Frame rate', 1, 120);
    let clips = [...request.clips];
    const assets = [...request.assets];
    for (const [index, record] of records.entries()) {
      if (request.signal?.aborted) throw new Error('Canceled by you');
      const sides = clips.filter(clip => clip.id === record.outgoingId || clip.id === record.incomingId);
      if (!sides.length) continue;
      // The window is rendered whole, so a keyframed *participant* would need per-frame baking of
      // the blend itself. Animation elsewhere on the timeline is fine and is baked afterwards.
      const animated = sides.find(isAnimated);
      if (animated) throw new Error(`${animated.name}: a transition cannot sit on a keyframed clip. Remove the keyframes on that clip, or the ${record.name} transition, before exporting.`);
      const track = request.tracks.find(item => item.id === sides[0].trackId);
      if (!track) continue;
      const outputPath = path.join(directory, `${index}.mov`);
      const mediaId = `transition-render-${index}`;
      // Track gain, pan and solo are applied once, when the spliced clip is placed back.
      const neutral = request.tracks.map(item => item.id === track.id ? { ...item, gain: 0, pan: 0, solo: false } : { ...item, solo: false });
      request.onStage?.(`Rendering transition ${index+1}/${records.length} · ${record.name}`);
      await renderTimeline({
        ...request, clips: sides, tracks: neutral, timelines: undefined, transparent: true, sampledFrame: false,
        outputPath, onStage: undefined, onProgress: p => request.onProgress?.((index+p/100)/records.length*30), compositionPath: undefined,
        settings: { ...request.settings, resolution: request.project.resolution, rangeIn: String(record.start), rangeOut: String(record.end),
          codec: 'Apple ProRes 4444', audio: request.settings.audio === 'Disabled' ? 'Disabled' : 'Linear PCM · 24-bit · 48 kHz', masterGain: '0', masterMuted: 'false' },
      });
      const span = record.end - record.start;
      assets.push({ path: outputPath, asset: { id: mediaId, projectId: request.project.id, name: record.name, kind: 'video', binId: '', thumbnail: '', duration: span, resolution: request.project.resolution, fps, size: '', status: 'ready', progress: 100, hasAudio: request.settings.audio !== 'Disabled', inputProfile: 'Rec.709' } });
      clips = [
        ...clips.filter(clip => !sides.some(side => side.id === clip.id)),
        ...sides.flatMap(side => uncoveredParts(side, record.start, record.end).map(part => ({ ...part, id: `${part.id}-${part.start.toFixed(4)}`, transition: '', properties: { ...part.properties, transitionOut: '' } }))),
        { id: mediaId, projectId: request.project.id, timelineId: request.timeline.id, trackId: track.id, mediaId, name: record.name,
          start: record.start, duration: span, sourceIn: 0, color: '#8fb3c4', disabled: false, properties: {}, effects: [] },
      ];
    }
    const flattened = { ...request, clips, assets, onProgress: (p: number) => request.onProgress?.(30+p*.7) };
    // Only the pre-rendered windows needed transitions; what remains may not even be animated.
    if (clips.some(clip => clip.timelineId === request.timeline.id && !clip.disabled && isAnimated(clip))) return await renderAnimatedTimeline(flattened);
    return await renderTimeline(flattened);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Bake stabilized picture as source-time replacement media, then composite normally. Timing edits stay on the clip. */
async function renderStabilizedTimeline(request: RenderRequest) {
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-stabilize-export-'));
  try {
  const clips=[...request.clips],assets=[...request.assets],tracks=[...request.tracks];
  const records=timelineTransitions(clips.filter(c=>c.projectId===request.project.id),request.timeline.id,assets.map(a=>a.asset));
  const candidates=clips.filter(c=>c.timelineId===request.timeline.id&&!c.disabled&&stabilizeEffect(c));
  const maskArtifacts=new Map(request.maskArtifacts);
  for(const [index,clip] of candidates.entries()) {
    if(clip.properties.opticalFlow)throw Error(`${clip.name}: Stabilize and optical flow cannot share a clip yet. Disable optical flow or remove Stabilize.`);
    const source=assets.find(a=>a.asset.id===clip.mediaId),track=tracks.find(t=>t.id===clip.trackId);
    if(!source||source.asset.kind!=='video'||!track)throw new Error(`${clip.name}: Stabilize requires a video source.`);
    const span=clipSpan(clip,records),geo=extendClip(clip,Math.max(0,span.start),span.end-Math.max(0,span.start));
    const sourceFps=source.asset.fps||finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
    const range=stabilizeRange(geo,sourceFps,source.asset.duration);
    const settings=stabilizeSettings(clip,stabilizeEffect(clip)!);
    // Resolve every matte against the original before the source is swapped for the bake, then move each one
    // with the picture's own matrices. Stabilize first, Smart Mask on top of the stabilized frame.
    const documents=activeSmartMasks(clip,request.nodes);
    // Moving the mattes owns the front fifth of this clip's slice; the bake owns the rest.
    const mattes=documents.length?.2:0;
    const report=(fraction:number)=>request.onProgress?.((index+Math.max(0,Math.min(1,fraction)))/candidates.length*45);
    for(const [order,document] of documents.entries()) {
      if(!request.smartMaskDir)throw Error(`${clip.name}: Smart Mask storage is unavailable.`);
      const artifact=resolveSmartMaskArtifact(request.smartMaskDir,clip,document,source.path,source.asset);
      const warped=path.join(directory,`mask-${clip.id}-${document.id}`);
      await mkdir(path.join(warped,'frames'),{recursive:true});
      await stabilizeWarpMattes({input:source.path,directory:request.stabilizeDir??directory,range,settings,signal:request.signal,
        onProgress:p=>report(mattes*(order+p/100)/documents.length),
        frames:artifact.manifest.frames.map(f=>({input:path.join(artifact.directory,f.file),output:path.join(warped,f.file),time:f.time}))});
      maskArtifacts.set(`${clip.id}:${document.id}`,{directory:warped,manifest:artifact.manifest});
    }
    request.onStage?.(`Stabilizing · ${clip.name}`);
    const baked=await renderStabilized({input:source.path,directory,analysisDirectory:request.stabilizeDir,range,from:range.from,to:range.to,settings,preview:false,signal:request.signal,onProgress:p=>report(mattes+(1-mattes)*p/100)});
    const mediaId=`stabilize-${clip.id}`,metadata=await probeMedia(baked.output,request.signal);
    assets.push({path:baked.output,asset:{...source.asset,id:mediaId,duration:range.to-range.from,fps:metadata.fps||sourceFps,hasAudio:false,colorRange:metadata.colorRange,colorMatrix:metadata.colorMatrix}});
    clips[clips.indexOf(clip)]={...clip,mediaId,sourceIn:clip.sourceIn-range.from,effects:clip.effects.filter(e=>e.name!=='Stabilize'),properties:{...clip.properties,audioDetached:true}};
    const explicitAudio=request.clips.some(other=>other.id!==clip.id&&tracks.find(t=>t.id===other.trackId)?.kind==='audio'&&other.mediaId===clip.mediaId&&other.start===clip.start&&other.sourceIn===clip.sourceIn&&other.duration===clip.duration);
    if(source.asset.hasAudio&&!clip.properties.audioDetached&&!explicitAudio&&request.settings.audio!=='Disabled') {
      const audioId=`stabilize-audio-${clip.id}`;
      tracks.push({...track,id:audioId,kind:'audio'});
      // The original carries the sound; the bake is picture only.
      clips.push({...clip,id:audioId,trackId:audioId,transition:'',properties:{...clip.properties,transitionOut:'',audioDetached:false},keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>timingPaths.includes(path)||/^properties\.(gain|pan|audioFadeIn|audioFadeOut)$/.test(path)||path.startsWith('effects.'))),effects:clip.effects.filter(e=>['EQ','Compressor','Limiter','Noise Reduction'].includes(e.name))});
    }
  }
  await renderTimeline({...request,clips,assets,tracks,maskArtifacts,onProgress:p=>request.onProgress?.(45+p*.55)});
  } finally {await rm(directory,{recursive:true,force:true});}
}

/** Bake optical flow before compositing; all subsequent frame reads use the same retimed footage. */
async function renderFlowTimeline(request: RenderRequest) {
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-flow-export-'));
  try {
    const clips=[...request.clips],assets=[...request.assets],tracks=[...request.tracks];
    const fps=finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
    const records=timelineTransitions(clips.filter(c=>c.projectId===request.project.id),request.timeline.id,assets.map(a=>a.asset));
    const candidates=clips.filter(c=>c.timelineId===request.timeline.id&&!c.disabled&&c.properties.opticalFlow);
    for(const [index,clip] of candidates.entries()) {
      if(activeSmartMasks(clip,request.nodes).length)throw Error('Smart Mask and optical-flow retiming need a shared warped matte. Disable optical flow for this clip.');
      const source=assets.find(a=>a.asset.id===clip.mediaId),track=tracks.find(t=>t.id===clip.trackId);
      if(!source||source.asset.kind!=='video'||!track)throw new Error(`${clip.name}: optical flow requires a video source.`);
      const span=clipSpan(clip,records),geo=extendClip(clip,Math.max(0,span.start),span.end-Math.max(0,span.start));
      request.onStage?.(`Optical flow · ${clip.name}`);
      const baked=await renderOpticalFlow({clip:geo,asset:source.asset,input:source.path,directory,fps,signal:request.signal,onProgress:p=>request.onProgress?.((index+p/100)/candidates.length*45)});
      const mediaId=`flow-${clip.id}`,metadata=await probeMedia(baked.output,request.signal);
      assets.push({path:baked.output,asset:{...source.asset,id:mediaId,duration:geo.duration,fps,hasAudio:false,colorRange:metadata.colorRange,colorMatrix:metadata.colorMatrix}});
      clips[clips.indexOf(clip)]={...clip,mediaId,sourceIn:clip.start-geo.start,keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>!timingPaths.includes(path))),properties:{...clip.properties,opticalFlow:false,speed:100,reverse:false,freeze:false,audioDetached:true}};
      const explicitAudio=request.clips.some(other=>other.id!==clip.id&&tracks.find(t=>t.id===other.trackId)?.kind==='audio'&&other.mediaId===clip.mediaId&&other.start===clip.start&&other.sourceIn===clip.sourceIn&&other.duration===clip.duration);
      if(source.asset.hasAudio&&!clip.properties.audioDetached&&!explicitAudio&&request.settings.audio!=='Disabled') {
        const audioId=`flow-audio-${clip.id}`;
        tracks.push({...track,id:audioId,kind:'audio'});
        // Retain the established audio renderer, including its pitch preservation and automation.
        clips.push({...clip,id:audioId,trackId:audioId,transition:'',properties:{...clip.properties,opticalFlow:false,transitionOut:'',audioDetached:false},keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>timingPaths.includes(path)||/^properties\.(gain|pan|audioFadeIn|audioFadeOut)$/.test(path)||path.startsWith('effects.'))),effects:clip.effects.filter(e=>['EQ','Compressor','Limiter','Noise Reduction'].includes(e.name))});
      }
    }
        const pictures=clips.filter(c=>tracks.find(t=>t.id===c.trackId)?.kind==='video');
    if(!records.length&&clips.some(isAnimated)&&!pictures.some(isAnimated)&&request.settings.audio!=='Disabled') {
      // Speed-only picture is already baked. Audio automation must not force full-resolution picture through one render per frame.
      const video=path.join(directory,request.settings.codec?.includes('ProRes')?'picture.mov':'picture.mp4'),sound=path.join(directory,'sound.mov');
      await renderTimeline({...request,clips:pictures,assets,tracks,outputPath:video,settings:{...request.settings,audio:'Disabled'},onProgress:p=>request.onProgress?.(45+p*.15)});
      await renderAnimatedTimeline({...request,clips,assets,tracks:tracks.map(t=>({...t,hidden:true})),project:{...request.project,resolution:'16 × 16'},outputPath:sound,settings:{...request.settings,resolution:'16 × 16',codec:'Apple ProRes 4444'},onProgress:p=>request.onProgress?.(60+p*.35)});
      await run(ffmpeg(),[...common,'-i',video,'-i',sound,'-map','0:v:0','-map','1:a:0?','-c','copy','-movflags','+faststart',request.outputPath],{signal:request.signal});
      request.onProgress?.(100);
    } else await renderTimeline({...request,clips,assets,tracks,onProgress:p=>request.onProgress?.(45+p*.55)});
  } finally {await rm(directory,{recursive:true,force:true});}
}

/**
 * The frame spans animated clips occupy, snapped outward to the bake's frame grid and merged.
 *
 * Frame `f` of the bake covers `[start + f/fps, start + (f+1)/fps)`, so a window has to be a whole
 * number of frames measured from the export's in point or the spliced result lands off-grid.
 */
export function animatedWindows(clips: Clip[], timelineId: string, fps: number, start: number, count: number) {
  const windows: { from: number; to: number }[] = [];
  for (const span of clips.filter(clip => clip.timelineId === timelineId && !clip.disabled && isAnimated(clip))
    .map(clip => ({ from: Math.max(0, Math.floor((clip.start - start) * fps + 1e-7)), to: Math.min(count, Math.ceil((clip.start + clip.duration - start) * fps - 1e-7)) }))
    .filter(span => span.to > span.from)
    .sort((a, b) => a.from - b.from)) {
    const last = windows.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else windows.push(span);
  }
  return windows;
}

/** Reuse the static renderer for arbitrary animated properties, including future effects. */
async function renderAnimatedTimeline(request: RenderRequest) {
  const fps=finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
  const start=finite(request.settings.rangeIn??0,'Range in',0,request.timeline.duration);
  const end=finite(request.settings.rangeOut??request.timeline.duration,'Range out',start+1/fps-1e-8,request.timeline.duration);
  for(const clip of request.clips)if(clip.keyframes)validateKeyframes(clip.keyframes);
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-animation-'));
  const count=Math.ceil((end-start)*fps-1e-7);
  // Only the frames an animated clip actually covers are worth one render each. Everything else is
  // spliced back as ordinary clips and composited in a single pass, the way transition windows
  // already are: one keyframe must not cost a 30-minute edit a render per frame.
  const windows=animatedWindows(request.clips,request.timeline.id,fps,start,count);
  const total=windows.reduce((frames,window)=>frames+window.to-window.from,0);
  // Solo and hidden are read off the original tracks: the bake applies them internally, so the
  // spliced result has to survive the same filters that dropped the clips it replaced.
  const ownTracks=request.tracks.filter(t=>t.timelineId===request.timeline.id);
  const soloed=ownTracks.some(t=>t.solo&&!t.muted);
  const picture=ownTracks.filter(t=>t.kind==='video');
  const hidden=picture.length>0&&picture.every(t=>t.hidden);
  try {
    let clips=[...request.clips];
    const assets=[...request.assets],tracks=[...request.tracks];
    let rendered=0;
    for(const [index,window] of windows.entries()) {
      const files:string[]=[];
      // ponytail: per-frame baking reuses all static effects; batch/GPU rendering when export throughput matters.
      for(let frame=window.from;frame<window.to;frame++) {
        if(request.signal?.aborted)throw new Error('Canceled by you');
        const time=start+frame/fps, duration=1/fps;
        const active=request.clips.filter(c=>c.timelineId===request.timeline.id&&c.start<=time+1e-8&&c.start+c.duration>time+1e-8);
        let nodes=request.nodes;
        const transformSamples:Record<string,MotionPose[]>={};
        const [projectWidth,projectHeight]=dimensions(request.project.resolution);
        const frameClips=active.map(original=>{
          nodes=evaluateNodes(nodes,original,time);
          const clip=evaluateClip(original,time,fps),elapsed=time-original.start,rate=Number(clip.properties.speed??100)/100;
          transformSamples[clip.id]=transformMotion(clip,time,request.project.fps,projectWidth,projectHeight);
          const offset=animatedSourceOffset(original,elapsed,fps)-(clip.properties.reverse?Math.max(0,rate-1)/fps:0);
          const volume=fadeLevel(clip,time,true);
          return {...clip,keyframes:undefined,transition:'',start:0,duration,sourceIn:Math.max(0,original.sourceIn+offset),properties:{...clip.properties,transitionOut:'',opacity:Number(clip.properties.opacity??100)*fadeLevel(clip,time),gain:volume>0?Math.max(-60,Number(clip.properties.gain??0)+20*Math.log10(volume)):-60,fadeIn:0,fadeOut:0,audioFadeIn:0,audioFadeOut:0,fadeOrigin:0,fadeDuration:duration}};
        });
        const outputPath=path.join(directory,`${index}-${frame}.mov`);files.push(`file '${outputPath}'`);
        request.onStage?.(`Rendering animation · frame ${rendered+1}/${total}`);
        await renderTimeline({...request,onStage:undefined,sampledFrame:true,transformSamples,clips:frameClips,nodes,timeline:{...request.timeline,duration},outputPath,onProgress:undefined,settings:{...request.settings,rangeIn:'0',rangeOut:String(duration),codec:'Apple ProRes 4444',audio:request.settings.audio==='Disabled'?'Disabled':'Linear PCM · 24-bit · 48 kHz',masterGain:'0',masterMuted:'false'}});
        request.onProgress?.(++rendered/total*90);
      }
      const list=path.join(directory,`${index}.txt`),baked=path.join(directory,`${index}.mov`);await writeFile(list,files.join('\n'));
      await run(ffmpeg(),[...common,'-f','concat','-safe','0','-i',list,'-c','copy',baked],{signal:request.signal});
      const at=start+window.from/fps, span=(window.to-window.from)/fps, mediaId=`animation-${index}`, trackId=`animation-track-${index}`;
      tracks.push({id:trackId,timelineId:request.timeline.id,name:'Animation',kind:'video',number:1000+index,muted:false,solo:soloed,locked:false,hidden,gain:0,pan:0});
      assets.push({path:baked,asset:{id:mediaId,projectId:request.project.id,name:'Animation',kind:'video',binId:'',thumbnail:'',duration:span,resolution:request.settings.resolution||request.project.resolution,fps,size:'',status:'ready',progress:100,hasAudio:request.settings.audio!=='Disabled',inputProfile:'Rec.709'}});
      clips=[
        ...clips.flatMap(clip=>clip.timelineId===request.timeline.id?uncoveredParts(clip,at,at+span):[clip]),
        {id:mediaId,projectId:request.project.id,timelineId:request.timeline.id,trackId,mediaId,name:'Animation',start:at,duration:span,sourceIn:0,color:'#668b9e',disabled:false,properties:{},effects:[]},
      ];
    }
    // Whatever animation is left lies outside the export range by construction — a window is clamped
    // to it. Dropping those remnants is what guarantees the flattened timeline cannot route back here.
    clips=clips.filter(clip=>!(clip.timelineId===request.timeline.id&&isAnimated(clip)));
    await renderTimeline({...request,clips,tracks,assets,onProgress:p=>request.onProgress?.(total?90+p/10:p)});
  } finally {await rm(directory,{recursive:true,force:true});}
}

/** Render nested timelines once, retaining transparent pixels and their mixed audio. */
async function renderCompositions(request: RenderRequest) {
  const ancestry=request.compositionPath??[];
  if(ancestry.includes(request.timeline.id)||ancestry.length>=32)throw new Error('Composition nesting contains a cycle or exceeds 32 levels.');
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-compositions-'));
  try {
    const clips=[...request.clips],assets=[...request.assets];
    const parents=clips.filter(c=>c.timelineId===request.timeline.id&&c.mediaId==='frameline-composition'&&!c.disabled);
    for(const [index,parent] of parents.entries()) {
      if(request.signal?.aborted)throw new Error('Canceled by you');
      const timeline=request.timelines?.find(t=>t.id===parent.properties.compositionId&&t.projectId===request.project.id);
      if(!timeline)throw new Error(`${parent.name}: composition timeline is missing.`);
      const outputPath=path.join(directory,`${index}.mov`),mediaId=`composition-render-${parent.id}`;
      request.onStage?.(`Rendering composition ${index+1}/${parents.length} · ${parent.name}`);
      await renderTimeline({...request,timeline,onStage:undefined,compositionPath:[...ancestry,request.timeline.id],transparent:true,sampledFrame:false,outputPath,onProgress:p=>request.onProgress?.((index+p/100)/parents.length*50),settings:{...request.settings,resolution:request.project.resolution,rangeIn:'0',rangeOut:String(timeline.duration),codec:'Apple ProRes 4444',audio:request.settings.audio==='Disabled'?'Disabled':'Linear PCM · 24-bit · 48 kHz',masterGain:'0',masterMuted:'false'}});
      clips[clips.indexOf(parent)]={...parent,mediaId};
      assets.push({path:outputPath,asset:{id:mediaId,projectId:request.project.id,name:parent.name,kind:'video',duration:timeline.duration,binId:'',thumbnail:'',fps:Number(request.settings.fps||request.project.fps),resolution:request.project.resolution,size:'',status:'ready',progress:100,hasAudio:request.settings.audio!=='Disabled',inputProfile:'Rec.709'}});
    }
    await renderTimeline({...request,clips,assets,onProgress:p=>request.onProgress?.(50+p*.5)});
  } finally {await rm(directory,{recursive:true,force:true});}
}

/** Bake one clip through the same renderer used by exports, retaining clip audio automation. */
export async function renderSoundEffect(options: { project: Project; clip: Clip; track: Track; asset: MediaAsset; inputPath: string; outputPath: string; signal?: AbortSignal }) {
  const { project, clip, track, asset, inputPath, outputPath, signal } = options;
  const directory = await mkdtemp(path.join(tmpdir(), 'frameline-sfx-'));
  try {
    const baked = path.join(directory, 'sound.mov');
    // ponytail: tiny blank video reuses the complete export engine; add audio-only render output if saves become slow.
    await renderTimeline({ project: { ...project, resolution: '16 × 16' }, timeline: { id: clip.timelineId, projectId: project.id, name: clip.name, duration: clip.start + clip.duration }, clips: [{ ...clip, disabled: false }], tracks: [{ ...track, muted: false, solo: false, gain: 0, pan: 0 }], nodes: [], assets: [{ asset, path: inputPath }], settings: { rangeIn: String(clip.start), rangeOut: String(clip.start + clip.duration), resolution: '16 × 16', codec: 'Apple ProRes 422 HQ', audio: 'Linear PCM · 24-bit · 48 kHz' }, transparent: true, outputPath: baked, signal });
    await run(ffmpeg(), [...common, ...safeInput, '-i', baked, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s24le', '-t', String(clip.duration), outputPath], { signal });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
