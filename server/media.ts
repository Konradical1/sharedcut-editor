import { venvPython, quotedFilterPath } from './platform.ts';
import { exportPassCount, admitStart, killProcessTree, trackChild } from './processTree.ts';
import { JOB_COST_BYTES, type AdmitRequest } from './hostGuard.ts';
import { readCameraColor, type CameraColor } from './cameraMetadata.ts';
import { resolveSmartMaskArtifact } from './smartMask.ts';
import { activeDepthKeys, nodeMaskId, smartMaskFrame, type SmartMaskManifest } from '../src/services/smartMask.ts';
import { depthFrameAt, depthKeyTable } from '../src/services/depth.ts';
import { activeSmartMasks } from '../src/services/smartMaskPreview.ts';
import { transformMotion, motionArtwork, type MotionPose } from '../src/services/motionBlur.ts';
import { motionBlurFilters } from './motionBlur.ts';
import { renderCaptionTimeline } from './captionRender.ts';
import { bakeAnimatedGraphics, streamableGraphic } from './graphicsRender.ts';
import { shownSourceTime } from '../src/services/motionTracker.ts';
import { isCaption } from '../src/services/captions.ts';
import { animatedSourceOffset, evaluateClip, evaluateNodes, fadeLevel, isAnimated, sampleKeyframes, validateKeyframes } from '../src/services/animation.ts';
export { isAnimated };
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { isTitle, getText, drawText, validateText } from '../src/services/text.ts';
import { isShape, getShape, drawShape, validateShape } from '../src/services/shapes.ts';
import { adjustmentAsset, isAdjustment } from '../src/services/adjustment.ts';
import { placement, streamsTransform, transformFilters } from './streamedTransform.ts';
import { audioEffectNames, effectDefinitions, effectValue, effectEnabled, loudnessTarget } from '../src/services/effects.ts';
import { denoiseEffect, denoiseKeys, denoiseSettings } from '../src/services/denoise.ts';
import { denoiseBake, trimDenoiseBakes } from './denoise.ts';
import { eqBiquads } from '../src/services/audioDsp.ts';
import { clipSpan, extendClip } from '../src/services/playback.ts';
import { blendModeOf } from '../src/services/blendModes.ts';
import { clipPart, uncoveredParts } from '../src/services/timeline.ts';
import { isLeakMedia, leakRange, leakIdOf, motionGap, motionSamples, timelineTransitions, transitionDefinitions, type TransitionRecord } from '../src/services/transitions.ts';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, readFile, writeFile, mkdtemp, rename, utimes } from 'node:fs/promises';
import { existsSync, rmSync, statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Clip, Effect, GradeNode, MediaAsset, Project, Timeline, Track } from '../src/state/models.ts';
import { colorTransform, cubeText, makeCube, parseCube, hasACES, interpretation, processingStages, hdrToSdr, isHdrTransfer, rangeDefaults, type Cube } from '../src/services/color.ts';
import { tmpdir, cpus, setPriority, totalmem } from 'node:os';
import { renderOpticalFlow, trimFlowCache } from './opticalFlow.ts';
import { renderStabilized, stabilizeSolve, stabilizeWarpMattes, trimStabilizeCache } from './stabilize.ts';
import { stabilizeEffect, stabilizeMatrixAt, stabilizeRange, stabilizeSettings, type StabilizeSolve } from '../src/services/stabilize.ts';
import { flowFrames, timingPaths } from '../src/services/opticalFlow.ts';
import { gpuJob } from './workQueue.ts';
import { depthDiskFloor, type depthService } from './depth.ts';
import { depthFocusAt } from '../src/services/depth.ts';

type ProcessOptions = { signal?: AbortSignal; onProgress?: (percent: number) => void; duration?: number; binary?: boolean; maxBytes?: number; jsonProgress?: boolean | 'stderr'; /** Process priority (nice 0-19, 19 is Idle on Windows); defaults to BACKGROUND_NICE. */ nice?: number;
  /** Heavy starts only: the host guard may hold the run until there is memory for it. Probes and stream copies leave this out and never wait. */
  guard?: Pick<AdmitRequest, 'kind' | 'costBytes' | 'label' | 'onStatus'> };
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = () => process.env.FFPROBE_PATH || 'ffprobe';
// Accept self-contained media only: playlist/concat inputs could read other server files.
const safeInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf,wav,mp3,aac,flac,aiff,ogg,caf,au,flv,image2,image2pipe,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,apng'];

export async function run(command: string, args: string[], options: ProcessOptions = {}): Promise<Buffer> {
  if (options.signal?.aborted) throw new Error('Canceled by you');
  const release = options.guard ? await admitRun(options.guard, options.signal) : undefined;
  try { return await spawnProcess(command, args, options); } finally { release?.(); }
}

/** The guard rejects a cancelled wait as "Cancelled."; a run reports its own wording. Any other refusal is passed on as it is. */
async function admitRun(guard: NonNullable<ProcessOptions['guard']>, signal?: AbortSignal) {
  try { return await admitStart({ ...guard, signal }); }
  catch (error) { throw signal?.aborted ? new Error('Canceled by you') : error; }
}

function spawnProcess(command: string, args: string[], options: ProcessOptions): Promise<Buffer> {
  if (options.signal?.aborted) return Promise.reject(new Error('Canceled by you'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    trackChild(child);
    // Preparation is background work and must never outrank the request loop that serves uploads
    // and playback. At equal priority, ffmpeg saturating every core pushed a trivial /api/health
    // from 57ms to 6.5s and dragged a local 64 MB/s import down to 1 MB/s.
    try { setPriority(child.pid!, options.nice ?? BACKGROUND_NICE); } catch { /* Not permitted here; thread budget still caps the load. */ }
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

/**
 * A reading served from its last result. A result younger than `ttlMs` is returned as it is; an older one is returned at
 * once while a single refresh runs in the background (a failed refresh keeps the old answer and is retried by a later
 * call). Only the very first call waits for the read, and a failed first read is not remembered.
 */
export function refreshing<T>(read: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; value: T } | undefined, flight: Promise<T> | undefined;
  return () => {
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.value);
    flight ??= read().then(value => { last = { at: now(), value }; return value; }).finally(() => { flight = undefined; });
    if (!last) return flight;
    flight.catch(() => undefined);
    return Promise.resolve(last.value);
  };
}

async function probeMediaCapabilities() {
  try {
    await Promise.all([run(ffmpeg(), ['-version']), run(ffprobe(), ['-version'])]);
    return { available: true as const, ffmpeg: ffmpeg(), ffprobe: ffprobe(), hwaccel: await decodeAccelName() };
  } catch (error) { return { available: false as const, ffmpeg: ffmpeg(), ffprobe: ffprobe(), error: (error as Error).message }; }
}
/** /api/health answers from this, so the tunnel watchdog's checks spawn nothing: the two version probes run once a minute in the background. */
const CAPABILITIES_TTL_MS = 60_000;
export const getMediaCapabilities = refreshing(probeMediaCapabilities, CAPABILITIES_TTL_MS);

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

/** Bump to re-probe every ready video at startup (v2: display rotation, transfer; v3: alpha). */
export const PROBE_VERSION = 3;
/** An alpha plane in the decoded format (ProRes 4444, PNG/QuickTime Animation), or VP9/WebM's alpha side stream. */
export const alphaFormat = (pixFmt?: string, alphaMode?: string) => /^(yuva|gbrap|ya\d|argb|rgba|abgr|bgra)/.test(pixFmt ?? '') || alphaMode === '1';
// ponytail: tone-mapping knob; compare 100 against 203 on real footage and set FRAME_LINE_HDR_NPL.
export const hdrNpl = () => Number(process.env.FRAME_LINE_HDR_NPL) || 100;
/** The HDR-to-SDR table as a transform, or undefined for SDR sources. */
export const hdrTransform = (transfer?: string) => isHdrTransfer(transfer) ? hdrToSdr(transfer!, hdrNpl()) : undefined;
/**
 * Appended right after a `scale=…:in_color_matrix=bt2020nc` fragment: the scale converts to RGB, the LUT
 * tone-maps, and a second scale returns to Rec.709 video levels. Empty for SDR sources.
 */
async function toneMap(transfer: string | undefined, directory: string, outRange = 'tv') {
  const transform = hdrTransform(transfer);
  if (!transform) return '';
  const file = path.join(directory, `hdr-${transfer}-${hdrNpl()}.cube`);
  if (!existsSync(file)) await writeFile(file, cubeText(makeCube(transform, 65)));
  // Retag as Rec.709: encoders copy the frame's HLG tag otherwise, and the browser would tone-map the proxy a second time.
  return `,format=gbrpf32le,lut3d=file=${quotedFilterPath(file)}:interp=tetrahedral,scale=out_color_matrix=bt709:out_range=${outRange}:flags=accurate_rnd+full_chroma_int,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709`;
}

export async function probeMedia(inputPath: string, signal?: AbortSignal) {
  const file = await stat(inputPath);
  if (!file.isFile()) throw new Error('Media source is not a file.');
  const data = JSON.parse((await run(ffprobe(), ['-v', 'error', ...safeInput, '-show_streams', '-show_format', '-of', 'json', inputPath], { signal })).toString()) as {
    streams: { codec_type: string; codec_name?: string; color_range?: string; color_space?: string; color_primaries?: string; color_transfer?: string; pix_fmt?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; sample_rate?: string; channels?: number; disposition?: { attached_pic?: number }; side_data_list?: { rotation?: number }[]; tags?: Record<string, string> }[];
    format: { duration?: string; format_name?: string };
  };
  const video = data.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  if (!video && !audio) throw new Error('This file contains no decodable video, image, or audio stream.');
  const image = Boolean(video && !audio && /image2|image2pipe|_pipe|gif/.test(data.format.format_name || '') && !Number(data.format.duration));
  const duration = image ? 10 : finite(data.format.duration || video?.duration || audio?.duration, 'Source duration (seconds)', .001, 86400);
  const fps = video && !image ? finite(ratio(video.avg_frame_rate), 'Source frame rate', .01, 1000) : 0;
  if (video) { finite(video.width, 'Source width', 1, 16384); finite(video.height, 'Source height', 1, 16384); }
  // Phones store portrait as landscape plus a display matrix. FFmpeg decodes it upright, so report it that way.
  const rotation = Number(video?.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? 0);
  const [width, height] = Math.abs(rotation) % 180 === 90 ? [video?.height, video?.width] : [video?.width, video?.height];
  const color: CameraColor = (video && await readCameraColor(inputPath, file.size)) || { colorEvidence: video?.color_transfer ? 'Stream transfer tag: '+video.color_transfer+'; verify camera profile' : 'Camera profile untagged; set input manually for log footage' };
  return { ...color, cameraMetadataVersion: 2, colorRange: video?.color_range || 'unknown', colorMatrix: video?.color_space || color.colorMatrix || 'auto', frameRate: video?.avg_frame_rate, kind: image ? 'image' as const : video ? 'video' as const : 'audio' as const, duration, fps, hasAlpha: Boolean(video && !image && alphaFormat(video.pix_fmt, video.tags?.alpha_mode ?? video.tags?.ALPHA_MODE)), hasAudio: Boolean(audio), resolution: video ? `${width} × ${height}` : `${Math.round(Number(audio?.sample_rate || 48000) / 1000)} kHz · ${audio?.channels === 1 ? 'Mono' : 'Stereo'}`, width, height, colorTransfer: video?.color_transfer, probeVersion: PROBE_VERSION, size: file.size };
}

/**
 * Every FFmpeg call used to be pinned to 2 threads while one job ran at a time, so a 15-core machine
 * did media work on 13% of itself. The budget is per job because the queue now runs several: threads
 * and concurrency multiply, and oversubscribing them thrashes worse than the old serial pass.
 */
/**
 * Hardware decode is the half worth taking: it cut a full-rate 4K pass from 56s of
 * CPU to 7s, which is what lets several jobs share the machine. Preview encoding stays on libx264:
 * NVENC does have a constant-quality mode (exports use it, see videoCodecArgs), but it spends about
 * twice the bits for the same SSIM, and preview files are what fill the server's disk.
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
// Exports run one at a time and new media waits for them, so an export gets the whole 75% budget.
const exportThreads = String(Math.max(2, Math.floor(cores * 3 / 4)));
const BACKGROUND_NICE = Math.max(0, Math.min(19, Number(process.env.FRAME_LINE_MEDIA_NICE) || 10));
/**
 * Media storage v3 (docs/superpowers/specs/2026-10-03-media-storage-design.md): three video files per opaque clip.
 * full-v3 is Full, Color and the optical-flow input: up to 1920 wide, 10-bit 4:2:2 like the old all-intra grading
 * proxy, but with a half-second GOP, which measured 2-4x smaller at SSIM 0.996 against it.
 */
export const FULL_VARIANT = 'full-v3.mp4';
// v2: CRF 16. Log footage is low-contrast, so CRF 20 spent ~1.5 Mbit/s and the sky fell apart once a grade
// stretched it; CRF 16 measured 4.5 Mbit/s at 960p60 with half the sky error, same encode time.
// Also 1/2. The name and recipe stay, so remote footage caches stay valid.
export const STREAM_VARIANT = 'stream-v2.mp4';
// v2: the v1 recipe with a half-second GOP, because it is now also 1/4, the paused-scrub stand-in, the hover
// thumbnail and the filmstrip source, which the all-intra quarter proxy used to be.
export const STREAM_LOW_VARIANT = 'stream-low-v2.mp4';
export const AUDIO_VARIANT = 'audio-v1.m4a';
/** Names older builds wrote for an opaque video that the v3 set replaces; mediaMigration deletes them once nothing references them. */
export const SUPERSEDED_PREVIEWS = ['proxy.mp4', 'proxy-v2.mp4', 'color-v1.mp4', 'proxy-half-v1.mp4', 'proxy-quarter-v1.mp4', 'stream-low-v1.mp4', 'stream-v1.mp4'];
const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', jobThreads, '-filter_threads', jobThreads, '-filter_complex_threads', jobThreads];
const exportCommon = (threads = exportThreads) => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', threads, '-filter_threads', threads, '-filter_complex_threads', threads];
/**
 * Passes of one export that run side by side. Each opens only its own range's decoders, and a 4K 4:2:2
 * decoder holds about 1 GB of frames, so memory caps this as well as cores. FRAME_LINE_EXPORT_JOBS overrides.
 */
// Measured on a 32-thread, 32 GB host: 2 passes 57 s, 3 passes 50 s, 4 passes 45 s for the same re-export.
const EXPORT_PASSES = Math.max(1, Math.min(8, Number(process.env.FRAME_LINE_EXPORT_JOBS) || Math.min(4, Math.floor(cores / 8), Math.floor(totalmem() / 2 ** 33))));
// A 4K 4:2:2 software decoder holds about 1 GB at default threads, 0.6 GB at 8, 0.3 GB at 4 (the biggest single memory lever of a
// render), so no video decoder gets more than this many threads. FRAME_LINE_DECODE_THREADS overrides.
const DECODE_THREADS = Math.max(1, Math.floor(Number(process.env.FRAME_LINE_DECODE_THREADS)) || 8);
/** Host guard cost of one encode: the measured 4K pass when it opens video decoders, a sound-sized step when it opens none. Estimates beyond the 4K pass; observe mode logs the real drop. */
export const encodeCostBytes = (videoDecoders: number) => videoDecoders > 0 ? JOB_COST_BYTES.renderPass : JOB_COST_BYTES.soundStem;
const PREPARE_GUARD = { kind: 'prepare', costBytes: JOB_COST_BYTES.prepare, label: 'Media preparation' } as const;

/**
 * A long edit's filter graph outgrew Windows' 32,767-character command line (46,877 for a 45 s cut: spawn
 * ENAMETOOLONG; macOS allows about a megabyte), so graphs travel in a file. FFmpeg 7 reads any option from a
 * file with `-/`; the Docker image's Debian FFmpeg 5.1 only has -filter_complex_script, deprecated since.
 */
let graphOption: Promise<string> | undefined;
export async function graphArgs(graph: string, file: string): Promise<string[]> {
  graphOption ??= run(ffmpeg(), ['-hide_banner', '-version']).then(out => Number(/version n?(\d+)\./.exec(out.toString())?.[1] ?? 99) >= 7 ? '-/filter_complex' : '-filter_complex_script', () => '-filter_complex_script');
  await writeFile(file, graph);
  return [await graphOption, file];
}

/**
 * NVENC encodes a 4K frame in a fifth of libx264's time here (4.2 s vs 20.9 s for 180 frames; libx265 27 s),
 * which is most of why an NLE on this GPU exports so quickly. A build lists it even with no NVIDIA GPU present,
 * so one tiny encode proves it before an export relies on it. FRAME_LINE_HWENC=off keeps exports on the CPU.
 */
const hardwareEncoders = new Map<string, Promise<boolean>>();
function hardwareEncoder(name: string) {
  if (process.env.FRAME_LINE_HWENC === 'off') return Promise.resolve(false);
  let probe = hardwareEncoders.get(name);
  if (!probe) hardwareEncoders.set(name, probe = run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1', '-c:v', name, '-f', 'null', '-']).then(() => true, () => false));
  return probe;
}

async function videoCodecArgs(codec: string, quality: string | undefined, threads: string, width: number, height: number): Promise<string[]> {
  if (codec.includes('ProRes')) return ['-c:v', 'prores_ks', '-profile:v', codec.endsWith('4444') ? '4' : '3', '-vendor', 'apl0', '-threads', threads];
  const crf = quality === 'Visually lossless' ? 12 : quality?.startsWith('Maximum') ? 16 : 20;
  const cap = quality?.includes('20 Mb/s') ? ['-maxrate', '20M', '-bufsize', '40M'] : quality?.includes('50 Mb/s') ? ['-maxrate', '50M', '-bufsize', '100M'] : [];
  const hevc = codec !== 'H.264', gpu = hevc ? 'hevc_nvenc' : 'h264_nvenc', tag = hevc ? ['-tag:v', 'hvc1'] : [];
  // NVENC spends about twice libx264's bits for the same SSIM (7.7 vs 3.7 Mb/s at 0.963 on S-Log3), so CQ sits three above CRF.
  // It refuses tiny frames (145 px wide for H.264), which only tests and sound-only renders use.
  if (width >= 256 && height >= 144 && await hardwareEncoder(gpu)) return ['-c:v', gpu, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf + 3), '-b:v', '0', ...cap, '-spatial-aq', '1', '-bf', '3', '-b_ref_mode', 'middle', ...tag];
  // x265 takes -threads as frame threads and rejects 16 or more, which failed every H.265 export on a 32-thread host; its pool does the work.
  return ['-c:v', hevc ? 'libx265' : 'libx264', '-preset', 'fast', '-crf', String(crf), ...cap, ...tag, ...(hevc ? ['-x265-params', `pools=${threads}:log-level=error`, '-threads', String(Math.min(8, Number(threads)))] : ['-threads', threads])];
}

function audioCodecArgs(audio: string, internal: boolean): string[] {
  if (!audio.startsWith('Linear PCM')) return ['-c:a', 'aac', '-b:a', audio.includes('192') ? '192k' : '320k', '-ar', '48000'];
  return ['-c:a', internal ? 'pcm_f32le' : audio.includes('24-bit') ? 'pcm_s24le' : 'pcm_s16le', '-ar', '48000'];
}

/**
 * Tables are made of their inputs, not of the clip: ten clips sharing one ACES grade ran the 5 s Python bake ten
 * times, and every frame of an animation window rebuilt its 65³ table in JavaScript. Ids never enter the colour
 * maths, so they stay out of the key and copied grades share one table. One directory per server process.
 */
const processDirectories = new Map<string, Promise<string>>();
/** A scratch directory that lives as long as this server process and goes when it exits. */
function processDirectory(prefix: string) {
  let directory = processDirectories.get(prefix);
  if (!directory) processDirectories.set(prefix, directory = mkdtemp(path.join(tmpdir(), prefix)).then(made => { process.once('exit', () => rmSync(made, { recursive: true, force: true })); return made; }));
  return directory;
}
const luts = new Map<string, Promise<{ file: string; identity: boolean }>>(), lutUsers = new Map<string, number>();
const withoutIds = (key: string, value: unknown) => ['id', 'clipId', 'projectId'].includes(key) ? undefined : value;
/** `users` collects this pass's claims; hand it to releaseLuts once the pass's FFmpeg has finished reading. */
export function cachedLut(key: unknown, build: (file: string) => Promise<boolean | void>, users: string[]) {
  const id = createHash('sha256').update(JSON.stringify(key, withoutIds)).digest('hex').slice(0, 40);
  users.push(id); lutUsers.set(id, (lutUsers.get(id) ?? 0) + 1);
  let entry = luts.get(id);
  if (entry) { luts.delete(id); luts.set(id, entry); return entry; }
  entry = (async () => {
    const file = path.join(await processDirectory('frameline-luts-'), `${id}.cube`);
    return { file, identity: await build(file) === true };
  })();
  luts.set(id, entry);
  entry.catch(() => luts.delete(id));
  // Oldest first, but never a table a running render still reads: previews render alongside exports, and on
  // Windows deleting a file FFmpeg holds open fails outright. A failed delete is only a leftover temp file.
  for (const [old, pending] of luts) {
    if (luts.size <= 64) break;
    if (lutUsers.has(old)) continue;
    luts.delete(old);
    pending.then(({ file }) => rm(file, { force: true })).catch(() => {});
  }
  return entry;
}
export const releaseLuts = (users: string[]) => { for (const id of users) { const left = (lutUsers.get(id) ?? 1) - 1; if (left > 0) lutUsers.set(id, left); else lutUsers.delete(id); } };
/** A table that changes nothing: ungraded Rec.709, log shown as recorded, every title. Skipping it skips a float pass. */
function isIdentity(cube: Cube) {
  const n = cube.size - 1;
  for (let b = 0, i = 0; b <= n; b++) for (let g = 0; g <= n; g++) for (let r = 0; r <= n; r++, i += 3)
    if (Math.abs(cube.data[i] - r / n) > 1e-6 || Math.abs(cube.data[i + 1] - g / n) > 1e-6 || Math.abs(cube.data[i + 2] - b / n) > 1e-6) return false;
  return true;
}
/** Everything colorTransform reads: these clip properties, the source's own profile, and this clip's nodes. */
const colorInputs = (clip: Clip, asset: MediaAsset, nodes: GradeNode[]) => [
  ['colorPipeline', 'inputProfile', 'inputGamut', 'inputExposure', 'inputTemperature', 'bypassResolveLook'].map(key => clip.properties[key] ?? null),
  asset.inputProfile ?? null, asset.inputGamut ?? null, nodes.filter(node => node.clipId === clip.id)];
const lookTables = new Map<string, Cube>();
function lookCube(text: string) {
  const id = createHash('sha256').update(text).digest('hex');
  let cube = lookTables.get(id);
  if (!cube) { cube = parseCube(text); lookTables.set(id, cube); if (lookTables.size > 16) lookTables.delete(lookTables.keys().next().value!); }
  return { id, cube };
}

/** `work` over `items`, `limit` at a time. The first failure stops new work and aborts what is still running. */
async function inParallel<T>(items: T[], limit: number, signal: AbortSignal | undefined, work: (item: T, index: number, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController(), stop = () => controller.abort();
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  let next = 0, failure: unknown;
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !controller.signal.aborted) {
        const index = next++;
        try { await work(items[index], index, controller.signal); } catch (error) { failure ??= error; controller.abort(); }
      }
    }));
  } finally { signal?.removeEventListener('abort', stop); }
  if (failure !== undefined) throw failure;
  if (signal?.aborted) throw new Error('Canceled by you');
}
export type PreviewOutput = 'full' | 'stream' | 'low' | 'audio';
const gop = (fps: number, seconds: number) => String(Math.max(2, Math.round((fps || 24) * seconds)));
const knownMatrix = (matrix?: string) => ['bt709', 'bt470bg', 'smpte170m', 'bt2020nc'].includes(matrix ?? '') ? matrix! : 'auto';
/**
 * Any of the v3 preview files in one FFmpeg run, written into `temp` under their final names (the caller verifies
 * and renames them). `prepared` marks a `video` this module already made (full-v3, or an old color-v1): up to 1920
 * wide, BT.709, video range and tone-mapped. An original gets the matrix, range and HDR handling the grading proxy
 * always had. The smaller files are scaled from the same converted frames, so they are video range too.
 * `videoStart` / `audioStart`: a separate input's own start time, kept instead of moved to zero. FFmpeg zeroes each input
 * on its own, so a picture that starts after its sound (an edit list in color-v1) would otherwise slide onto the sound.
 */
type PreviewMetadata = { fps: number; colorMatrix?: string; colorRange?: string; colorTransfer?: string };
const sizing = 'flags=lanczos+accurate_rnd+full_chroma_int';
/** The conversion every v3 preview file starts from: up to 1920 wide, BT.709, video range, tone-mapped. */
const previewBase = async (prepared: boolean, metadata: PreviewMetadata, temp: string) => prepared ? `scale=w='min(1920,iw)':h=-2:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv:${sizing}`
  : `scale=w='min(1920,iw)':h=-2:in_color_matrix=${knownMatrix(metadata.colorMatrix)}:out_color_matrix=bt709:in_range=${metadata.colorRange === 'pc' ? 'pc' : metadata.colorRange === 'tv' ? 'tv' : 'auto'}:out_range=tv:${sizing}${await toneMap(metadata.colorTransfer, temp)}`;
// Tags go on the frames: FFmpeg 8+ takes primaries and transfer from them and ignores -color_primaries / -color_trc.
const bt709 = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
const previewRecipes = (fps: number) => ({
  // Primaries and transfer stay untagged as on the grading proxy: the colour pipeline reads the planes itself.
  full: { name: FULL_VARIANT, scale: 0, tag: 'setparams=range=tv:color_primaries=unknown:color_trc=unknown:colorspace=bt709', codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-g', gop(fps, .5), '-pix_fmt', 'yuv422p10le'] },
  stream: { name: STREAM_VARIANT, scale: 960, tag: bt709, codec: ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '16', '-g', gop(fps, 2), '-pix_fmt', 'yuv420p'] },
  low: { name: STREAM_LOW_VARIANT, scale: 480, tag: bt709, codec: ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20', '-maxrate', '900k', '-bufsize', '1800k', '-g', gop(fps, .5), '-pix_fmt', 'yuv420p'] },
});
/** What one file adds after the shared 4:2:2 frames: its own size, then its tags. */
const previewTail = (recipe: ReturnType<typeof previewRecipes>[keyof ReturnType<typeof previewRecipes>]) => `${recipe.scale ? `scale=w='min(${recipe.scale},iw)':h=-2:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv:${sizing},format=yuv420p,setsar=1,` : ''}${recipe.tag}`;
/** One preview file's exact conversion and encode for an original's own Y′CbCr frames: a Noise Reduction chunk stands in for
 *  that file, so the browser's grade must read the same planes from it. `scale` is the file's widest picture. */
export async function previewEncode(output: Exclude<PreviewOutput, 'audio'>, metadata: PreviewMetadata, temp: string) {
  const recipe = previewRecipes(metadata.fps)[output];
  return { filter: `${await previewBase(false, metadata, temp)},setsar=1,format=yuv422p10le,${previewTail(recipe)}`, codec: recipe.codec, scale: recipe.scale || 1920 };
}
export async function encodePreviews(options: { video: string; prepared: boolean; audio?: string; audioCopy?: boolean; videoStart?: number; audioStart?: number; metadata: PreviewMetadata & { duration: number }; outputs: PreviewOutput[]; temp: string; signal?: AbortSignal; onProgress?: (percent: number) => void }) {
  const { video, metadata, outputs, temp } = options, base = await previewBase(options.prepared, metadata, temp), recipes = previewRecipes(metadata.fps);
  const pictures = outputs.filter((output): output is Exclude<PreviewOutput, 'audio'> => output !== 'audio');
  const audioInput = options.audio === undefined ? undefined : options.audio === video ? 0 : 1;
  const audioCodec = options.audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k'];
  const kept = (start?: number) => start ? ['-itsoffset', String(start)] : [];
  const args = [...common, ...options.prepared ? [] : await decodeAccel(), ...kept(options.videoStart), ...safeInput, '-i', video, ...audioInput === 1 ? [...kept(options.audioStart), ...safeInput, '-i', options.audio!] : []];
  if (pictures.length) args.push('-filter_complex', [`[0:v]${base},setsar=1,format=yuv422p10le,split=${pictures.length}${pictures.map((_, i) => `[v${i}]`).join('')}`,
    ...pictures.map((output, i) => `[v${i}]${previewTail(recipes[output])}[o${i}]`)].join(';'));
  pictures.forEach((output, i) => args.push('-map', `[o${i}]`, ...audioInput === undefined ? [] : ['-map', `${audioInput}:a:0?`, ...audioCodec], ...recipes[output].codec, '-movflags', '+faststart', path.join(temp, recipes[output].name)));
  if (outputs.includes('audio') && audioInput !== undefined) args.push('-map', `${audioInput}:a:0`, '-vn', ...audioCodec, '-movflags', '+faststart', path.join(temp, AUDIO_VARIANT));
  if (options.onProgress) args.push('-progress', 'pipe:1', '-nostats');
  await run(ffmpeg(), args, { signal: options.signal, duration: metadata.duration, onProgress: options.onProgress, guard: PREPARE_GUARD });
  return outputs.map(output => output === 'audio' ? AUDIO_VARIANT : recipes[output].name);
}

/**
 * H.264 has no alpha, so a ProRes 4444 graphic previewed over black. Browsers decode VP9 WebM with its alpha
 * plane (Chrome, Edge, Firefox), and the canvas composites it like any other layer. Read from the original:
 * hardware decoders drop the alpha plane, and so does FFmpeg's native VP9 decoder on a WebM input.
 * Two sizes cover every quality: the stream sizes are the same files, since graphics are short and light.
 */
async function prepareAlphaVariants(inputPath: string, outputDir: string, baseUrl: string, metadata: Awaited<ReturnType<typeof probeMedia>>, signal?: AbortSignal, refresh?: boolean) {
  const half = 'proxy-half-alpha-v1.webm', quarter = 'proxy-quarter-alpha-v1.webm', audioName = 'audio-v1.m4a';
  const temp = await mkdtemp(path.join(outputDir, '.preview-'));
  try {
    const written: string[] = [], args = [...common, ...safeInput, '-i', inputPath];
    for (const [name, width] of [[half, 960], [quarter, 480]] as const) if (refresh || !existsSync(path.join(outputDir, name))) {
      args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=w='min(${width},iw)':h=-2:flags=lanczos`, ...alphaVideo(metadata.fps), '-c:a', 'libopus', '-b:a', '128k', path.join(temp, name));
      written.push(name);
    }
    if (metadata.hasAudio && (refresh || !existsSync(path.join(outputDir, audioName)))) { args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.join(temp, audioName)); written.push(audioName); }
    if (written.length) await run(ffmpeg(), args, { signal, duration: metadata.duration });
    for (const name of written) await rename(path.join(temp, name), path.join(outputDir, name));
    const url = (name: string) => `${baseUrl}/${name}`;
    return { proxyVariants: { '1/2': url(half), '1/4': url(quarter), Stream: url(half), StreamLow: url(quarter) }, ...(metadata.hasAudio ? { audioProxyUrl: url(audioName) } : {}) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
/** VP9 with alpha. `-auto-alt-ref 0` is required: alt-ref frames and the alpha side stream do not mix. */
const alphaVideo = (fps: number) => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-crf', '28', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-g', String(Math.max(1, Math.round((fps || 24) / 2))), '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

export async function prepareMediaThumbnail(inputPath: string, outputDir: string, signal?: AbortSignal, transfer?: string) {
  await mkdir(outputDir, { recursive: true });
  const temporary = await mkdtemp(path.join(outputDir, '.thumbnail-'));
  try {
    const tone = await toneMap(transfer, temporary);
    await run(ffmpeg(), [...common, ...safeInput, '-i', inputPath, '-vf', `thumbnail=12,scale=480:-2${tone ? ':in_color_matrix=bt2020nc' + tone : ''}`, '-frames:v', '1', path.join(temporary, 'thumbnail.jpg')], { signal });
    await rename(path.join(temporary, 'thumbnail.jpg'), path.join(outputDir, 'thumbnail.jpg'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
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
    // A tile is 96px wide, so a 480px stream already carries five times the detail one can show.
    // Reading the 4K original instead is a full-rate decode of every frame: 28.5s against 0.33s on a
    // 3.5-minute clip. Prefer the smallest variant already on disk; fall back to the original.
    const source = [STREAM_LOW_VARIANT, STREAM_VARIANT, FULL_VARIANT]
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
  // Measured with the waveform so the preview can apply Normalize loudness as a gain; the export measures the clip itself.
  const loudness = await measureLoudness(inputPath, { signal }).catch(error => { if (signal?.aborted) throw error; return undefined; });
  return { waveform, waveformVersion: 2, ...(loudness === undefined ? {} : { loudness }) };
}

/** Integrated loudness (LUFS, BS.1770) of the first audio stream or a section of it, as it plays: 48 kHz stereo, after
 *  `filters`. Undefined for silence. */
export async function measureLoudness(inputPath: string, options: { seek?: number; duration?: number; filters?: string[]; signal?: AbortSignal } = {}) {
  const chain = [...options.filters ?? [], 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo', 'asetnsamples=n=48000:p=0', 'ebur128=metadata=1', 'ametadata=print:key=lavfi.r128.I:file=-'];
  const output = await run(ffmpeg(), [...common, ...options.seek ? ['-ss', options.seek.toFixed(6)] : [], ...options.duration ? ['-t', options.duration.toFixed(6)] : [], ...safeInput, '-i', inputPath, '-map', '0:a:0', '-vn', '-af', chain.join(','), '-f', 'null', '-'], { signal: options.signal });
  const value = Number([...output.toString().matchAll(/lavfi\.r128\.I=([^\r\n]+)/g)].at(-1)?.[1]);
  return Number.isFinite(value) && value > -70 ? Math.round(value * 100) / 100 : undefined;
}
// A clip's measurement is the same for every pass of every export until its source, trim or effects change.
const loudnessCache = new Map<string, Promise<number | undefined>>();
async function clipLoudness(inputPath: string, seek: number, duration: number, filters: string[]) {
  // Size and time too: Replace Media puts a new file at the same path.
  const file = await stat(inputPath), key = JSON.stringify([inputPath, file.size, file.mtimeMs, seek, duration, filters]);
  let measured = loudnessCache.get(key);
  if (!measured) {
    while (loudnessCache.size >= 256) loudnessCache.delete(loudnessCache.keys().next().value!);
    // No caller's signal: renders share this promise, so one cancelled render must not fail another's measurement.
    measured = measureLoudness(inputPath, { seek, duration, filters });
    loudnessCache.set(key, measured);
    measured.catch(() => loudnessCache.delete(key));
  }
  return measured;
}

export async function prepareMedia(options: { inputPath: string; outputDir: string; baseUrl: string; signal?: AbortSignal; refresh?: boolean; onProgress?: (percent: number) => void; onThumbnail?: (url: string) => void; onStage?: (stage: string) => void; onPlayable?: (asset: Awaited<ReturnType<typeof probeMedia>> & {proxyUrl: string; thumbnail: string; colorProxyUrl?: string}) => void }) {
  const { inputPath, outputDir, baseUrl, signal, onProgress, onThumbnail, onStage, onPlayable } = options;
  onStage?.('Reading camera metadata');
  const metadata = await probeMedia(inputPath, signal);
  await mkdir(outputDir, { recursive: true });
  const opaque = metadata.kind === 'video' && !metadata.hasAlpha, url = (name: string) => `${baseUrl}/${name}`;
  // image-v2: portrait stills fit a 1920 square instead of a 1080-high landscape box.
  const proxyName = metadata.kind === 'audio' ? 'audio.m4a' : metadata.kind === 'image' ? 'image-v2.png' : metadata.hasAlpha ? 'proxy-alpha-v1.webm' : FULL_VARIANT;
  const proxy = path.join(outputDir, proxyName), thumbnail = metadata.kind === 'audio' ? '' : url('thumbnail.jpg');
  // publish() spreads a result over the stored row, so a field this kind of media no longer has is cleared by name.
  const cleared = { proxyVariants: undefined, audioProxyUrl: undefined, colorProxyUrl: undefined, filmstrip: undefined, filmstripFrames: undefined, filmstripVersion: undefined };
  const input = [...metadata.hasAlpha ? [] : await decodeAccel(), ...safeInput, '-i', inputPath];
  let filmstripFrames = 0, temp: string | undefined;
  onProgress?.(5);
  try {
    if (metadata.kind !== 'audio') {
      onStage?.('Creating thumbnail');
      await prepareMediaThumbnail(inputPath, outputDir, signal, metadata.colorTransfer);
      onThumbnail?.(thumbnail);
    }
    onStage?.('Creating playable preview');
    // Encoded beside it and renamed in, so a failed or killed re-prepare leaves the file the row names untouched (and a
    // check server's hard-linked copy is replaced, never written through to the live file).
    temp = await mkdtemp(path.join(outputDir, '.preview-'));
    const staged = path.join(temp, proxyName);
    if (metadata.hasAlpha) {
      await run(ffmpeg(), [...common, ...input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=w='min(1920,iw)':h=-2:flags=lanczos`, ...alphaVideo(metadata.fps), '-c:a', 'libopus', '-b:a', '128k', '-progress', 'pipe:1', '-nostats', staged], { signal, duration: metadata.duration, onProgress: value => onProgress?.(5 + value * .7), guard: PREPARE_GUARD });
    } else if (metadata.kind === 'image') {
      await run(ffmpeg(), [...common, ...input, '-vf', 'scale=w=1920:h=1920:force_original_aspect_ratio=decrease', '-frames:v', '1', staged], { signal });
    } else if (metadata.kind === 'audio') {
      await run(ffmpeg(), [...common, ...input, '-vn', '-map', '0:a:0?', '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', staged], { signal, duration: metadata.duration, onProgress: value => onProgress?.(5 + value * .7) });
    } else {
      await encodePreviews({ video: inputPath, prepared: false, audio: metadata.hasAudio ? inputPath : undefined, metadata, outputs: ['full'], temp, signal, onProgress: value => onProgress?.(5 + value * .7) });
    }
    await rename(staged, proxy);
    onProgress?.(80);
    onStage?.('Preparing audio waveform');
    const peaks = metadata.hasAudio ? await prepareWaveform(inputPath, metadata.duration, signal) : { waveform: [], waveformVersion: 2 };
    // Full and Color both read full-v3, so it is the grading picture from the moment the clip plays.
    const colorProxyUrl = opaque ? url(proxyName) : undefined;
    onPlayable?.({ ...metadata, ...peaks, proxyUrl: url(proxyName), colorProxyUrl, thumbnail });
    let previews: Pick<MediaAsset, 'proxyVariants' | 'audioProxyUrl'> = {};
    if (metadata.hasAlpha) previews = await prepareAlphaVariants(inputPath, outputDir, baseUrl, metadata, signal, options.refresh);
    else if (opaque) {
      onStage?.('Creating smaller playback previews');
      // From full-v3, already converted and tone-mapped; its AAC is copied. A plain re-prepare keeps files on disk.
      const missing = (name: string) => options.refresh || !existsSync(path.join(outputDir, name));
      const outputs = ([['stream', STREAM_VARIANT], ['low', STREAM_LOW_VARIANT], ...metadata.hasAudio ? [['audio', AUDIO_VARIANT]] : []] as [PreviewOutput, string][]).filter(([, name]) => missing(name)).map(([output]) => output);
      if (outputs.length) for (const name of await encodePreviews({ video: proxy, prepared: true, audio: metadata.hasAudio ? proxy : undefined, audioCopy: true, metadata, outputs, temp, signal, onProgress: value => onProgress?.(80 + value * .19) })) await rename(path.join(temp, name), path.join(outputDir, name));
      previews = { proxyVariants: { Stream: url(STREAM_VARIANT), '1/2': url(STREAM_VARIANT), StreamLow: url(STREAM_LOW_VARIANT), '1/4': url(STREAM_LOW_VARIANT) }, audioProxyUrl: metadata.hasAudio ? url(AUDIO_VARIANT) : undefined };
    }
    // After the variants, so the strip is tiled from the 480px stream rather than the 4K original.
    if (metadata.kind === 'video') onStage?.('Creating timeline thumbnails');
    if (metadata.kind === 'video') filmstripFrames = await prepareMediaFilmstrip(inputPath, outputDir, metadata.duration, signal);
    onProgress?.(100);
    return { ...cleared, ...metadata, ...previews, colorProxyUrl, proxyUrl: url(proxyName), thumbnail, ...(filmstripFrames ? { filmstrip: url('filmstrip.jpg'), filmstripFrames, filmstripVersion: FILMSTRIP_VERSION } : {}), ...peaks };
  } finally { if (temp) await rm(temp, { recursive: true, force: true }); }
}

export function audioFilters(clip: Clip): string[] {
  const filters: string[] = [];
  for (const effect of clip.effects.filter(effect => effectEnabled(clip,effect))) {
    const value = (key: string, fallback: number, min: number, max: number) => finite(effectValue(clip,effect,key.slice(effect.name.length+1)), key, min, max);
    // The coefficients the preview plays and the Audio workspace draws. FFmpeg's own shelf widths change meaning
    // between versions (9.0 reads treble's q 0.5 as 0.707), so the export takes them literally at a known rate.
    if (effect.name === 'EQ') filters.push('aresample=48000', ...eqBiquads(value('EQ_Low cut', 80, 20, 500), value('EQ_Presence', 2, -12, 12), value('EQ_Air', 1, -12, 12), 48000).map(([b0, b1, b2, a1, a2]) => `biquad=b0=${b0}:b1=${b1}:b2=${b2}:a0=1:a1=${a1}:a2=${a2}`));
    else if (effect.name === 'Compressor') filters.push(`acompressor=threshold=${10 ** (value('Compressor_Threshold', -18, -60, 0) / 20)}:ratio=${value('Compressor_Ratio', 3, 1, 20)}:attack=${value('Compressor_Attack', 15, 1, 100)}:release=${value('Compressor_Release', 120, 10, 1000)}:makeup=1`);
    else if (effect.name === 'Limiter') filters.push(`volume=${-value('Limiter_Threshold', -6, -24, 0)}dB`, `alimiter=limit=${10 ** (value('Limiter_Ceiling', -1, -12, 0) / 20)}:release=${value('Limiter_Release', 80, 10, 500)}:level=0:latency=1`);
    else if (effect.name === 'Audio Noise Reduction') filters.push(`afftdn=nr=${.01 + value('Audio Noise Reduction_Reduction', 35, 0, 100) * .96}:nf=${-20 - value('Audio Noise Reduction_Sensitivity', 50, 0, 100) * .6}:gs=${Math.round(value('Audio Noise Reduction_Smoothing', 25, 0, 100) / 2)}`);
    else if (!['Film grain', 'Vignette', 'Gaussian blur', 'Sharpen', 'Bloom', 'Smart Mask', 'Depth', 'Stabilize', 'Noise Reduction'].includes(effect.name)) throw new Error(`${clip.name}: ${effect.name} is not supported for audio.`);
  }
  return filters;
}

/**
 * `decode`: the chain reads the original YUV source (not the colour render's RGB), so the clip's matrix and
 * range apply even when its table is an identity and skipped. `fit`: scale to the canvas in that same pass.
 */
function videoFilters(clip: Clip, lutPath: string | undefined, asset: MediaAsset, masks:Map<string,{index:number;timing:string[]}>=new Map(), decode=Boolean(lutPath), fit?: string, interpolation = 'trilinear'): string[] {
  const matrix=String(clip.properties.yuvMatrix||asset.colorMatrix||(asset.inputProfile?.startsWith('S-Log')?'bt709':'auto')).replace('bt2020-ncl','bt2020nc');
  const range=clip.properties.dataLevels==='Full'?'pc':clip.properties.dataLevels==='Video'?'tv':'auto';
  const convert = `scale=${fit ? `${fit}:` : ''}in_color_matrix=${["bt709","bt470bg","smpte170m","bt2020nc"].includes(matrix)?matrix:"auto"}:in_range=${range}`;
  const filters = decode ? [convert, ...(lutPath || !fit ? ['format=gbrapf32le'] : []), ...(lutPath ? [`lut3d=file=${quotedFilterPath(lutPath)}:interp=${interpolation}`] : [])] : fit ? [`scale=${fit}`] : [];
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
    else if (effect.name === 'Depth') { /* Baked before compositing (renderDepthTimeline); one left here has every section off. */ }
    else if (effect.name === 'Film grain') filters.push(`noise=alls=${Math.round(amount / 3)}:allf=t+u:all_seed=${Math.round(effectValue(clip,effect,'seed'))}`);
    else if (effect.name === 'Bloom') {
      const cut = Math.round(effectValue(clip,effect,'threshold') / 100 * 255), gain = (1 / Math.max(.05, 1 - effectValue(clip,effect,'threshold') / 100)).toFixed(3);
      const lift = `clip((val-${cut})*${gain},0,255)`;
      filters.push(`format=gbrp,split=2[bloomsrc][bloomcut];[bloomcut]lutrgb=r='${lift}':g='${lift}':b='${lift}',gblur=sigma=${effectValue(clip,effect,'radius').toFixed(2)}[bloomblur];[bloomsrc][bloomblur]blend=all_mode=screen:all_opacity=${(amount / 100).toFixed(3)}`);
    }
    else if (effect.name === 'Vignette') filters.push(`vignette=angle=${amount / 100 * Math.PI / 3}:x0=w*${effectValue(clip,effect,'centerX')/100}:y0=h*${effectValue(clip,effect,'centerY')/100}`);
    else if (effect.name === 'Gaussian blur') filters.push('premultiply=inplace=1', `gblur=sigma=${amount / 100 * effectValue(clip,effect,'radius')}`, 'unpremultiply=inplace=1');
    else if (effect.name === 'Sharpen') filters.push(`unsharp=${Math.round(effectValue(clip,effect,'radius'))*2+1}:${Math.round(effectValue(clip,effect,'radius'))*2+1}:${amount / 25}`);
    else if (effect.name === 'Noise Reduction') { /* Baked from the camera original before anything else (renderDenoisedTimeline). */ }
    else if (!audioEffectNames.includes(effect.name)) throw new Error(`${clip.name}: ${effect.name} is not supported for video. Remove or bypass the effect.`);
  }
  return filters;
}

/** The pixels a stationary, unrotated layer can cover. Leave a two-pixel conversion border and use even edges. */
export function blendRegion(width: number, height: number, layerWidth: number, layerHeight: number, shiftX: number, shiftY: number) {
  const left = Math.trunc((width - layerWidth) / 2 + shiftX), top = Math.trunc((height - layerHeight) / 2 + shiftY);
  const x = Math.max(0, Math.floor(left / 2) * 2 - 2), y = Math.max(0, Math.floor(top / 2) * 2 - 2);
  const right = Math.min(width, Math.ceil((left + layerWidth) / 2) * 2 + 2), bottom = Math.min(height, Math.ceil((top + layerHeight) / 2) * 2 + 2);
  return right > x && bottom > y && (right - x) * (bottom - y) < width * height / 2 ? { x, y, width: right - x, height: bottom - y } : undefined;
}

/**
 * Composite `layer` onto `under` with a blend mode the way the preview's canvas does (W3C Compositing). The layer is
 * placed on a transparent frame and blended against the picture in float RGB; over an opaque picture that gives
 * (1 − αs)·Cb + αs·B(Cb, Cs), so a layer over nothing blends with black exactly as the canvas does. A `transparent`
 * render (a composition's own) also weighs the backdrop's alpha in, so over nothing the layer stays itself. Add is
 * Porter-Duff plus: min(1, Cb + αs·Cs).
 */
export function blendFilters(o: { under: string; layer: string; output: string; mode: string; tag: string; width: number; height: number; fps: number; duration: number; x: string; y: string; enable: string; transparent?: boolean; region?: ReturnType<typeof blendRegion> }): string[] {
  const { tag: t, enable } = o, add = o.mode === 'Add', formula = blendModeOf(o.mode)?.ffmpeg;
  if (!formula) throw new Error(`${o.mode} blending is not available.`);
  const colors = [0, 1, 2].map(c => formula.includes('(') ? `c${c}_expr='${formula}'` : `c${c}_mode=${formula}`).join(':');
  // Small logos once converted and blended the entire output in float RGB on every frame. Keep placement
  // unchanged, then crop both blend inputs to the same covered pixels before conversion. Transparent
  // compositions and Add retain their full-frame alpha math; moving and rotated layers supply no region.
  const region = !o.transparent && !add ? o.region : undefined;
  const crop = region ? `crop=${region.width}:${region.height}:${region.x}:${region.y},` : '';
  // Add over an opaque picture places the layer on opaque black, which premultiplies it (αs·Cs). The premultiply filter
  // would too, but FFmpeg 9 tags its frames premultiplied and negotiates that onto the next clip's blend, which then
  // premultiplies that clip's layer a second time.
  const placed = [`color=c=black${add && !o.transparent ? '' : '@0'}:s=${o.width}x${o.height}:r=${o.fps}:d=${o.duration},format=rgba[${t}c]`, `[${o.layer}]scale=in_color_matrix=bt709:in_range=tv,format=rgba[${t}p]`,
    `[${t}c][${t}p]overlay=format=rgb:alpha=straight:x=${o.x}:y=${o.y}:eof_action=pass:repeatlast=0:enable='${enable}',${crop}format=gbrapf32le${add && o.transparent ? ',premultiply=inplace=1' : ''}${o.transparent && !add ? ',split=3' : ''}[${t}l]${o.transparent && !add ? `[${t}o][${t}a]` : ''}`];
  if (!o.transparent) return [...placed, `[${o.under}]split[${t}k][${t}u]`, `[${t}u]${crop}scale=in_color_matrix=bt709:in_range=tv,format=gbrapf32le[${t}b]`,
    // The picture under is opaque, so darken keeps the layer's alpha and addition saturates it to opaque.
    `[${t}l][${t}b]blend=${colors}:c3_mode=${add ? 'addition' : 'darken'}:enable='${enable}',scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[${t}m]`,
    `[${t}k][${t}m]overlay=format=yuv444p10:alpha=straight:x=${region?.x ?? 0}:y=${region?.y ?? 0}:eof_action=pass:repeatlast=0:enable='${enable}'[${o.output}]`];
  if (add) return [...placed, `[${o.under}]format=gbrapf32le,premultiply=inplace=1[${t}b]`, `[${t}b][${t}l]blend=all_mode=addition:enable='${enable}',unpremultiply=inplace=1,format=rgba[${o.output}]`];
  // Over a translucent backdrop the layer's colour becomes (1 − αb)·Cs + αb·B(Cb, Cs) before it goes on top.
  // ponytail: 8-bit like every composition render; a float overlay would lift it when nesting supports HDR.
  return [...placed, `[${o.under}]split[${t}k][${t}u]`, `[${t}u]format=gbrapf32le[${t}b]`, `[${t}l][${t}b]blend=${colors}:c3_expr=B[${t}m]`,
    `[${t}o]format=gbrpf32le[${t}s]`, `[${t}s][${t}m]overlay=format=rgb:alpha=straight:x=0:y=0,format=gbrapf32le[${t}x]`,
    `[${t}x][${t}a]blend=c3_mode=darken,format=rgba[${t}y]`, `[${t}k][${t}y]overlay=format=rgb:alpha=straight:x=0:y=0:eof_action=pass:repeatlast=0:enable='${enable}'[${o.output}]`];
}

/** A clip whose own span changes over time, and so cannot be composited in a single pass. */

/**
 * Keyed gain as one `volume` expression in clip time (T = t + `from`), so ducking renders in the single
 * static pass. Linear and hold segments are exact; Bézier segments are sampled every 1/16 of their span.
 */
export function gainExpression(clip: Clip, from: number, trackGain: number) {
  const keys = clip.keyframes?.['properties.gain'];
  if (!keys?.length) return undefined;
  const db = (time: number) => Math.max(-60, Math.min(12, Number(sampleKeyframes(keys, time)))) + trackGain;
  const points: [number, number][] = [[keys[0].time, db(keys[0].time)]];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (a.interpolation === 'hold') points.push([b.time - 1e-6, db(a.time)]);
    else if (a.interpolation === 'bezier') for (let n = 1; n < 16; n++) { const t = a.time + (b.time - a.time) * n / 16; points.push([t, db(t)]); }
    points.push([b.time, db(b.time)]);
  }
  const T = `(t+${from.toFixed(6)})`, f = (n: number) => n.toFixed(6);
  const terms = [`lt(${T},${f(points[0][0])})*${f(points[0][1])}`, `gte(${T},${f(points.at(-1)![0])})*${f(points.at(-1)![1])}`];
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1], [t1, v1] = points[i];
    if (t1 - t0 > 1e-9) terms.push(`gte(${T},${f(t0)})*lt(${T},${f(t1)})*(${f(v0)}+(${f(v1 - v0)})*(${T}-${f(t0)})/${f(t1 - t0)})`);
  }
  return `volume='pow(10,(${terms.join('+')})/20)':eval=frame`;
}

export interface RenderRequest {
  project: Project; timeline: Timeline; timelines?: Timeline[]; clips: Clip[]; tracks: Track[]; nodes: GradeNode[];
  assets: { asset: MediaAsset; path: string }[]; settings: Record<string, string>; outputPath: string;
  signal?: AbortSignal; onProgress?: (percent: number) => void; onStage?: (stage: string) => void; resolveDir?: string; smartMaskDir?: string; stabilizeDir?: string;
  /** Noise Reduction storage (server/denoise.ts): noise profiles and the export bakes it keeps between exports. */
  denoiseDir?: string;
  /** Internal composition renders keep alpha and defer the master limiter to the outer timeline. */
  transparent?: boolean; compositionPath?: string[]; sampledFrame?: boolean;
  transformSamples?: Record<string, MotionPose[]>;
  /** Resolves a light-leak id from the shared overlay pack to a file on disk. */
  overlayPath?: (id: string) => string | null;
  /** Mattes already re-rendered to match a baked picture, keyed `clipId:maskId`. Stabilize fills this so a
   *  Smart Mask lands on the stabilized frame; without it the matte would sit on the original framing. `offset` is
   *  the original source second at which the baked media starts: its times are the manifest's minus that. */
  maskArtifacts?: Map<string, { directory: string; manifest: SmartMaskManifest; offset?: number }>;
  /** Internal, one pass of a split export: `video` renders picture for its own range, `audio` mixes sound for the whole range. */
  pass?: 'video' | 'audio';
  /** Internal, audio pass: mix only these clips. Every clip still decides whose embedded sound would play twice. */
  only?: Set<string>;
  /** Internal, audio pass: also carry transitions' embedded light-leak sound. */
  leakSound?: boolean;
  /** Internal: thread budget when several FFmpeg passes share the export. */
  threads?: number;
  /** A timeline preview: render as one FFmpeg pass or refuse, never split into parallel passes that take export threads. */
  singlePass?: boolean;
  /** Process priority of the final encode (nice 19 is Idle on Windows); a preview must never outrank the editor. */
  nice?: number;
  /** Internal: 'Waiting for memory' or 'Low memory' while the host guard holds or squeezes an encode of this render, null when clear. */
  onWait?: (text: string | null) => void;
  /** Depth analysis: clips with a Depth effect start or join their run and wait for it. */
  depth?: Pick<ReturnType<typeof depthService>, 'ready' | 'focus'> & Partial<Pick<ReturnType<typeof depthService>, 'freeGpu'>>;
  /** Gives idle GPU workers' memory back before a CUDA bake (Smart Mask and Noise Reduction previews). */
  freeGpu?: () => void;
  /** Internal: the camera original behind a Stabilize bake, keyed by clip, for a Depth that reads its analysis. */
  stabilized?: Map<string, { clip: Clip; source: { asset: MediaAsset; path: string }; offset: number; solve: StabilizeSolve }>;
  /** Internal: the camera original behind a Noise Reduction bake, keyed by clip. Stabilize analyses it (so its cache and the
   *  editor's preview stay valid) and Depth reads its analysis. The bake's frame k is the original's frame at offset + k / fps. */
  denoised?: Map<string, { clip: Clip; source: { asset: MediaAsset; path: string }; offset: number }>;
  /** Internal: hand over the finished FFmpeg command, which writes the lone clip's layer as raw rgba64le on stdout,
   *  instead of running it (the Depth bake reads its pre-depth frames this way). */
  decoder?: (command: string[]) => Promise<void>;
  /** Internal: the clips as the render started. Depth reads its run from these (depthRun), however a pass, an In/Out
   *  range, a preview chunk, a bake or a per-frame render cuts a clip by now. */
  wholeClips?: Clip[];
  /** Keyframed position, zoom and rotation render in the streaming pass (streamedTransform.ts) rather than one render per
   *  frame. Decided once, from the codec the export ends in, and carried into its compositions and passes. */
  streamTransforms?: boolean;
}

/** The source span of a clip's one depth run, shared by every reader: the editor (POST /api/depth), an export's wait
 *  before the render queue, the Depth bake, a depth-keyed grade and a timeline preview. It is everything the clip reads in
 *  the edit, speed ramps, reverse, freeze and transition handles included. Each run sets its own near/far, so a smaller
 *  one would put Focus, Fog and keys at other depths than the preview the user tuned. */
export function depthSpan(clip: Clip, asset: MediaAsset, clips: Clip[], media: MediaAsset[]) {
  if (asset.kind !== 'video') return { from: 0, to: 1 };
  const records = timelineTransitions(clips.filter(c => c.projectId === clip.projectId), clip.timelineId, media);
  const span = clipSpan(clip, records), geometry = extendClip(clip, Math.max(0, span.start), span.end - Math.max(0, span.start));
  return stabilizeRange(geometry, asset.fps, asset.duration);
}
/** A render's depth.ready request for a clip: the run (depthSpan) of the clip as the render started. `source` is the
 *  media the analysis reads: the original under a Stabilize bake. */
export function depthRun(request: Pick<RenderRequest, 'clips' | 'wholeClips' | 'assets'>, clip: Clip, source: { asset: MediaAsset; path: string }) {
  const clips = request.wholeClips ?? request.clips, whole = clips.find(c => c.id === clip.id) ?? clip;
  return { clip: whole, asset: source.asset, sourcePath: source.path, ...depthSpan(whole, source.asset, clips, request.assets.map(a => a.asset)) };
}

/**
 * Windows land wherever the handles allow, usually between frames (the flash here ran 56.43 → 71.57), so the
 * window's own frames never matched the slots it had to fill and an edge frame came out black. Snap inward
 * onto the export's frame grid: never wider than the handles, and every frame in it is a whole frame.
 */
function framedTransitions(records: TransitionRecord[], rangeIn: number, fps: number): TransitionRecord[] {
  return records.flatMap(record => {
    const start = rangeIn + Math.ceil((record.start - rangeIn) * fps - 1e-6) / fps, end = rangeIn + Math.floor((record.end - rangeIn) * fps + 1e-6) / fps;
    return end - start > 1e-9 ? [{ ...record, start, end, duration: end - start }] : [];
  });
}

// Pictures a pass may decode at once, the longest stretch it takes, and clips per sound pass (bounded by
// Windows' command line: each input spends ~380 characters on its path and whitelists).
const PASS_INPUTS = 6, PASS_SECONDS = 20, PASS_SOUNDS = 48;
const ADJUSTMENT_LABELS = 100_000;

/**
 * Frame ranges for the picture passes of one export. A single FFmpeg graph with every clip in it opens every
 * decoder at once: a 45 s cut of 4K 4:2:2 (about 1 GB of frames per decoder) committed 32 GB on this 32 GB
 * machine and ran at a third of the speed. A pass holds only the clips on screen in its own range. Boundaries
 * fall on the edit's own cuts where they can, never inside a transition window (it must render whole), and a
 * long stretch without cuts is split anyway so it still renders side by side.
 */
export function renderPasses(spans: { from: number; to: number }[], windows: { from: number; to: number }[], total: number, maxInputs = PASS_INPUTS, maxFrames = Infinity) {
  const straddled = (frame: number) => windows.some(window => window.from < frame && frame < window.to);
  const stops = [...new Set(spans.flatMap(span => [span.from, span.to]))].filter(frame => frame > 0 && frame < total && !straddled(frame)).sort((a, b) => a - b).concat(total);
  const passes: { from: number; to: number }[] = [];
  for (let from = 0; from < total;) {
    const inputs = (to: number) => spans.filter(span => span.from < to && span.to > from).length;
    let to = 0;
    for (const stop of stops) {
      if (stop <= from) continue;
      if (stop - from > maxFrames || to && inputs(stop) > maxInputs) break;
      to = stop;
      if (inputs(stop) > maxInputs) break;
    }
    if (!to) {
      to = Math.min(total, from + maxFrames);
      for (let moved = true; moved;) { moved = false; for (const window of windows) { const end = Math.min(total, window.to); if (window.from < to && to < end) { to = end; moved = true; } } }
    }
    passes.push({ from, to });
    from = to;
  }
  return passes;
}

/**
 * A clip nobody can see or hear. Its keyframes still forced a render per frame: a speed ramp on a muted audio
 * copy cost the Newspaper export 188 s of one-frame FFmpeg runs that drew nothing.
 */
function unseen(clip: Clip, request: Pick<RenderRequest, 'tracks' | 'settings'>) {
  const track = request.tracks.find(t => t.id === clip.trackId);
  if (!track) return false;
  const soloed = request.tracks.some(t => t.timelineId === track.timelineId && t.solo && !t.muted);
  const silent = request.settings.audio === 'Disabled' || track.muted || soloed && !track.solo;
  return silent && (track.kind === 'audio' || track.hidden);
}
/** Whether the clip needs one render per frame: animated in a way the streaming pass cannot draw. */
const perFrame = (clip: Clip, request: Pick<RenderRequest, 'streamTransforms'>) => isAnimated(clip) && !(request.streamTransforms && streamsTransform(clip));
const animationWork = (request: Pick<RenderRequest, 'clips' | 'timeline' | 'tracks' | 'settings' | 'streamTransforms'>) => request.clips.filter(c => c.timelineId === request.timeline.id && !c.disabled && perFrame(c, request) && !unseen(c, request));

/** A vertical project exported at 1920 × 1080 is squashed, not letterboxed; refuse it up front. */
export function exportAspect(resolution: string | undefined, projectResolution: string) {
  if (!resolution) return;
  const [w, h] = dimensions(resolution), [pw, ph] = dimensions(projectResolution);
  if (Math.abs(w / h - pw / ph) > .01) throw new Error(`Export at ${projectResolution.replace('x', '×')} or another size with the same shape. ${resolution} would stretch the picture.`);
}

export async function renderTimeline(request: RenderRequest): Promise<void> {
  exportAspect(request.settings.resolution, request.project.resolution);
  if (!request.wholeClips) request = { ...request, wholeClips: request.clips };
  // `perspective` draws 8-bit RGB: fine for an export that ends in 8-bit H.264/H.265, not for 10-bit ProRes.
  if (request.streamTransforms === undefined) request = { ...request, streamTransforms: !(request.settings.codec ?? '').includes('ProRes') };
  if (!request.pass) {
  if(request.clips.some(c=>c.timelineId===request.timeline.id&&isCaption(c)))return renderCaptionTimeline(request);
  rejectDepth(request);
  if(request.clips.some(c=>c.timelineId===request.timeline.id&&c.mediaId==='frameline-composition'&&!c.disabled))return renderCompositions(request);
  if(!request.sampledFrame&&request.clips.some(c=>c.timelineId===request.timeline.id&&!c.disabled&&denoisesPicture(request,c)))return renderDenoisedTimeline(request);
  if(!request.sampledFrame&&request.clips.some(c=>c.timelineId===request.timeline.id&&!c.disabled&&stabilizeEffect(c)))return renderStabilizedTimeline(request);
  if(!request.sampledFrame&&request.clips.some(c=>c.timelineId===request.timeline.id&&!c.disabled&&c.properties.opticalFlow))return renderFlowTimeline(request);
  if(!request.sampledFrame&&depthClips(request).length)return renderDepthTimeline(request);
  // Animated titles and shapes (a title attached to a motion track, say) are drawn frame by frame into one movie,
  // as the preview draws them, instead of rendering the whole timeline once per frame.
  if(!request.sampledFrame&&animationWork(request).some(streamableGraphic)) {
    const directory=await mkdtemp(path.join(tmpdir(),'frameline-graphics-'));
    try {
      const baked=await bakeAnimatedGraphics(request,directory);
      if(baked)return await renderTimeline({...baked,onProgress:p=>request.onProgress?.(40+p*.6)});
    } finally {await rm(directory,{recursive:true,force:true});}
  }
  if(!request.sampledFrame&&animationWork(request).length) {
    // Animated export bakes the timeline down to one flattened clip, which a transition spanning
    // two clips cannot survive. Render each window first and splice it in as an ordinary clip.
    if (timelineTransitions(request.clips.filter(clip => clip.projectId === request.project.id), request.timeline.id, request.assets.map(entry => entry.asset)).length) return renderFlattenedTransitions(request);
    return renderAnimatedTimeline(request);
  }
  }
  const { project, timeline, settings, outputPath, signal, onProgress } = request;
  const soundOnly = request.pass === 'audio', threads = String(request.threads ?? exportThreads);
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
  if (!request.pass && path.extname(outputPath).toLowerCase() !== (isProRes ? '.mov' : '.mp4')) throw new Error(`Choose a ${isProRes ? '.mov' : '.mp4'} filename for ${codec}.`);
  if (audio.startsWith('Linear PCM') && !isProRes) throw new Error('Linear PCM requires a ProRes MOV export. Choose AAC for MP4.');
  if (audio !== 'Disabled' && !/^(AAC · (320|192) kb\/s|Linear PCM · (24|16)-bit) · 48 kHz$/.test(audio)) throw new Error('Choose AAC with 192/320 kb/s, or Linear PCM with 16/24-bit in a MOV export.');
  if (settings.quality && !['Automatic', 'High · 20 Mb/s', 'Maximum · 50 Mb/s', 'Visually lossless'].includes(settings.quality)) throw new Error('Unsupported export quality.');
  const tracks = request.tracks.filter(track => track.timelineId === timeline.id);
  const solo = tracks.some(track => track.solo && !track.muted);
  // Transitions borrow trim handles rather than moving clips, so they widen a clip's rendered
  // span without changing the edit. Windows outside the export range are dropped entirely.
  const transitions = framedTransitions(timelineTransitions(request.clips.filter(clip => clip.projectId === project.id), timeline.id, request.assets.map(entry => entry.asset)), rangeIn, fps)
    .filter(record => record.start < rangeOut && record.end > rangeIn);
  // A clip ending on the range's first frame overlaps it by float noise only (3.6e-15 s, which FFmpeg's duration
  // parser rejects); split exports cut on exactly those frames, so such a clip is not in the range at all.
  const inRange = (start: number, end: number) => start < rangeOut - 1e-6 && end > rangeIn + 1e-6;
  // A range ending (or starting) inside a window still holds the other side's half of it, though that clip's own body
  // is outside: it takes part for its picture only (`audible` checks the body).
  const clips = request.clips.filter(clip => clip.timelineId === timeline.id && clip.projectId === project.id && !clip.disabled && inRange(...Object.values(clipSpan(clip, transitions)) as [number, number]))
    .sort((a, b) => (tracks.find(track => track.id === a.trackId)?.number ?? 0) - (tracks.find(track => track.id === b.trackId)?.number ?? 0) || a.start - b.start);
  // A name the registry does not know is reported rather than dropped: a silently missing
  // transition looks exactly like a bug in the edit.
  for (const clip of request.clips.filter(item => item.timelineId === timeline.id && !item.disabled)) {
    for (const name of [clip.transition, clip.properties?.transitionOut]) {
      if (typeof name === 'string' && name && !transitionDefinitions[name]) throw new Error(`${clip.name}: the ${name} transition is not available in this version. Remove it before exporting.`);
    }
  }
  if (!request.pass && !request.sampledFrame) {
    // Frames this range holds, counted the way the base source and -t emit them: every frame starting before the out point.
    const frame = (seconds: number) => Math.round((seconds - rangeIn) * fps), total = Math.ceil(duration * fps - 1e-6);
    const spans = clips.filter(clip => { const track = tracks.find(t => t.id === clip.trackId); return track?.kind === 'video' && !track.hidden && !isAdjustment(clip); })
      .map(clip => { const span = clipSpan(clip, transitions); return { from: Math.max(0, frame(span.start)), to: Math.min(total, frame(span.end)) }; })
      .filter(span => span.to > span.from);
    const passes = renderPasses(spans, transitions.map(record => ({ from: frame(record.start), to: frame(record.end) })), total, PASS_INPUTS, Math.round(PASS_SECONDS * fps));
    const sounds = audio === 'Disabled' ? [] : clips.filter(clip => { const track = tracks.find(t => t.id === clip.trackId); return track && !track.muted && (!solo || track.solo) && inRange(clip.start, clip.start + clip.duration); });
    if (passes.length > 1 || sounds.length > PASS_SOUNDS) {
      // A preview is one pass or nothing: parallel passes would each take export threads and a decoder per clip.
      if (request.singlePass) throw new Error('This part stacks too many clips for a quick preview. It plays live in the editor.');
      return renderSplit(request, { passes, sounds, fps, total, duration });
    }
  }
  // One pass holds every clip it renders; a split export keeps each pass far below this.
  if ((request.only ? clips.filter(clip => request.only!.has(clip.id)) : clips).length > 128) throw new Error('This render range stacks more than 128 clips at once. Export shorter ranges.');
  const colorClips = clips.filter(clip => {
    const track = tracks.find(track => track.id === clip.trackId);
    return track?.kind === 'video' && !track.hidden && (activeSmartMasks(clip, request.nodes).length > 0 || activeDepthKeys(clip, request.nodes).length > 0 || clip.properties.colorPipeline === 'nodes-v2' && hasACES(request.nodes, clip.id));
  });
  // Stage weights estimate work, not time; native frame counts supply progress within each stage.
  // ACES without a matte is a one-second table bake, so only matted clips carry real per-frame colour work.
  const colorBudget = soundOnly ? 0 : colorClips.some(clip => activeSmartMasks(clip, request.nodes).length || activeDepthKeys(clip, request.nodes).length) ? 50 : colorClips.length ? 5 : 0;
  let colorsDone = 0;
  const overlayInputs = new Map<string, number>();
  const lutDir = await mkdtemp(path.join(tmpdir(), 'frameline-color-')), tables: string[] = [], depthHolds: (() => void)[] = [];
  try {
  // FFmpeg's 10-bit YUV overlay darkens translucent RGB on transparent bases.
  // ponytail: groups composite in 8-bit RGB; use a 16-bit RGB compositor when HDR nesting is supported.
  const args = exportCommon(threads), filters = soundOnly || request.decoder ? [] : [`color=c=${request.transparent?'black@0':'black'}:s=${width}x${height}:r=${fps}:d=${duration},format=${request.transparent?'rgba':'yuv444p10le'},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[base]`];
  let inputIndex = 0, currentVideo = 'base', videoDecoders = 0, adjustments = 0;
  const audioLabels: string[] = [];
  // Each side of a cut is split off its own clip chain, so the untouched body of the clip stays
  // bit-identical and only the window pays for the transition.
  const windowSides = new Map<TransitionRecord, { out?: string; in?: string }>();
  let windowIndex = 0;
  const overlayPlace = (shiftX: number, shiftY: number) => `overlay=format=${request.transparent ? 'rgb' : 'yuv444p10'}:alpha=straight:x=(W-w)/2+${shiftX}:y=(H-h)/2+${shiftY}:eof_action=pass:repeatlast=0`;

  // Placement is decided on whole output frames. Comparing float seconds against `t`, and setpts truncating
  // `offset/TB`, each dropped a frame at clip edges seemingly at random (a black flash at most cuts).
  const frameAt = (seconds: number) => Math.round(seconds * fps);
  const onScreen = (from: number, to: number) => `gte(n,${frameAt(from)})*lt(n,${frameAt(to)})`;
  const leakFile = async (record: TransitionRecord) => {
    const id = String(record.params.leak ?? '');
    const file = id && request.overlayPath ? request.overlayPath(id) : null;
    if (!file) throw new Error(`${record.name}: choose a light leak before exporting, or remove the transition.`);
    return { file, probed: await probeMedia(file, signal) };
  };
  const leakInput = ({ file, probed }: Awaited<ReturnType<typeof leakFile>>) => { args.push('-t', String(probed.duration), ...safeInput, '-i', file); return inputIndex++; };
  // A leak's own sound, fitted to its window like the picture. Expanding it to a track replaces this
  // embedded copy, so it must not play twice. A split export mixes it in its first sound pass.
  const leakSound = (record: TransitionRecord, leakIndex: number, probed: { duration: number; hasAudio: boolean }) => {
    if (!probed.hasAudio || audio === 'Disabled' || record.audioClipId) return;
    const start = Math.max(0, record.start - rangeIn), span = Math.min(duration, record.end - rangeIn) - start;
    const sourceRange = leakRange(record.params, probed.duration), skip = Math.max(0, rangeIn - record.start);
    const gain = finite(record.params.leakGain ?? -6, `${record.name} sound`, -60, 12);
    const tempoFilters: string[] = [];
    let tempo = sourceRange.duration / record.duration;
    while (tempo < .5) { tempoFilters.push('atempo=0.5'); tempo /= .5; }
    while (tempo > 2) { tempoFilters.push('atempo=2'); tempo /= 2; }
    tempoFilters.push(`atempo=${tempo.toFixed(6)}`);
    filters.push(`[${leakIndex}:a:0]atrim=start=${sourceRange.start.toFixed(6)}:end=${sourceRange.end.toFixed(6)},asetpts=PTS-STARTPTS,${tempoFilters.join(',')},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${gain}dB,atrim=start=${skip.toFixed(5)}:duration=${span.toFixed(5)},asetpts=PTS-STARTPTS,adelay=${Math.round(start * 48000)}S:all=1[leak${leakIndex}a]`);
    audioLabels.push(`[leak${leakIndex}a]`);
  };
  const buildWindow = async (record: TransitionRecord) => {
    const definition = transitionDefinitions[record.name];
    const start = Math.max(0, record.start - rangeIn), end = Math.min(duration, record.end - rangeIn);
    const frames = frameAt(end) - frameAt(start);
    if (!definition || frames < 1) return;
    // A range that cuts into the window still blends over the whole window: the sides are padded with their edge
    // frames out to it (`pre` and `post` frames), and only the frames in range are kept, so progress never compresses.
    const whole = record.end - record.start, total = frameAt(record.end - rangeIn) - frameAt(record.start - rangeIn);
    const pre = frameAt(start) - frameAt(record.start - rangeIn), post = total - frames - pre;
    const shutterAngle = definition.motion ? finite(record.params.shutterAngle ?? 180, `${record.name} shutter angle`, 0, 360) : 0;
    const travel = definition.travel?.({ width, height, params: record.params }) ?? 0;
    const samples = definition.motion ? motionSamples(shutterAngle, travel, whole, fps) : 1;
    // Whatever spacing is left between sub-frames is closed with a blur of about half that gap, so
    // a fast move reads as one smear instead of a stack of discrete ghosts.
    const gap = definition.motion ? motionGap(shutterAngle, travel, whole, fps) : 0;
    const rate = fps * samples;
    const tag = `x${windowIndex++}`;
    const plan = { duration: whole, width, height, fps, params: record.params, samples, tag };
    const sides = windowSides.get(record) ?? {};
    const pixels = 'yuva444p10le';
    // A missing side is transparent black: a head transition fades up out of nothing, and a tail
    // transition fades down into it, which is exactly what "a transition to nothing" means here.
    const prepare = (label: string | undefined, role: 'out' | 'in', name: string) => {
      // Counted in frames: the window is whole frames, and a float duration can land one frame short or long.
      // One spare frame per side: a blend whose float duration ends a hair past the last input frame never
      // emits that frame. The window is cut back to its exact frame count right after the blend.
      if (!label) { filters.push(`color=c=black@0:s=${width}x${height}:r=${rate}:d=${(whole + 2 / fps).toFixed(5)},trim=end_frame=${(total + 1) * samples},format=${pixels},setsar=1[${name}]`); return; }
      // A quarter frame early, not half: the side is already on the 1/fps grid and trim rounds its seconds to that
      // time base, so a half-frame cut sits on the rounding point and toFixed decided the frame. A one-frame window
      // (a still at 11.5) lost its only frame and came out black; longer ones lost the last or gained one at the start.
      const chain = [`trim=start=${Math.max(0, start - .25 / fps).toFixed(6)}:end=${(end - .25 / fps).toFixed(6)}`, 'setpts=PTS-STARTPTS', `fps=${rate}`, 'setsar=1'];
      if (pre || post) chain.push(`tpad=start_mode=clone:start=${pre * samples}:stop_mode=clone:stop=${post * samples}`);
      chain.push(...(definition.ffmpeg.side?.(role, plan) ?? []));
      chain.push(`format=${pixels}`, `trim=end_frame=${total * samples}`, 'setpts=PTS-STARTPTS', `tpad=stop_mode=clone:stop=${samples}`);
      filters.push(`[${label}]${chain.join(',')}[${name}]`);
    };
    prepare(sides.out, 'out', `${tag}a`);
    prepare(sides.in, 'in', `${tag}b`);
    const xfade = typeof definition.ffmpeg.xfade === 'function' ? definition.ffmpeg.xfade(record.params) : definition.ffmpeg.xfade ?? 'fade';
    if (!/^[a-z]+$/.test(xfade)) throw new Error(`${record.name}: unsupported transition mode.`);
    if (definition.overlay) {
      // The cut is a whole frame inside the window; switch half a frame early so float time never lands on it.
      const cutAt = (frameAt(record.cut - rangeIn) - frameAt(record.start - rangeIn) - .5) / fps;
      filters.push(`[${tag}a][${tag}b]blend=all_expr='if(lt(T,${cutAt.toFixed(6)}),A,B)':shortest=1[${tag}x]`);
    } else filters.push(`[${tag}a][${tag}b]xfade=transition=${xfade}:duration=${whole.toFixed(6)}:offset=0[${tag}x]`);
    filters.push(`[${tag}x]trim=end_frame=${total * samples}[${tag}t]`);
    let label = `${tag}t`;

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
      const overlay = await leakFile(record), probed = overlay.probed, leakIndex = leakInput(overlay);
      // Fit the leak to the window rather than cutting it short; these are one-shot bursts.
      const sourceRange = leakRange(record.params, probed.duration);
      const stretch = (record.duration / sourceRange.duration).toFixed(6);
      const opacity = (finite(record.params.leakOpacity ?? 100, `${record.name} opacity`, 0, 100) / 100).toFixed(3);
      const mode = ({ Screen: 'screen', Add: 'addition', Overlay: 'overlay' } as Record<string, string>)[String(record.params.blend ?? 'Screen')] ?? 'screen';
      const zoom = finite(record.params.leakZoom ?? 100, 'Overlay zoom', 100, 300) / 100;
      filters.push(`[${leakIndex}:v:0]trim=start=${sourceRange.start.toFixed(6)}:end=${sourceRange.end.toFixed(6)},setpts=(PTS-STARTPTS)*${stretch},fps=${fps},scale=${Math.ceil(width * zoom / 2) * 2}:${Math.ceil(height * zoom / 2) * 2}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=gbrapf32le,trim=duration=${whole.toFixed(5)},setpts=PTS-STARTPTS[${tag}l]`);
      // Screen/Add/Overlay are RGB operations; on YUV they tint the chroma planes. Alpha (c3) stays the picture's.
      // Float: FFmpeg 8.1's 16-bit screen and overlay overflow on dark pictures (see bloomFilters).
      const leak = [0, 1, 2].map(c => `c${c}_mode=${mode}:c${c}_opacity=${opacity}`).join(':');
      filters.push(`[${label}]format=gbrapf32le[${tag}rgb];[${tag}rgb][${tag}l]blend=${leak}:c3_opacity=0:shortest=1[${tag}o]`);
      label = `${tag}o`;
      leakSound(record, leakIndex, probed);
    }

    // `[IN]`/`[OUT]` let a definition splice its own streams in without knowing the graph.
    for (const fragment of definition.ffmpeg.after?.(plan) ?? []) {
      filters.push(fragment.replaceAll('[IN]', `[${label}]`).replaceAll('[OUT]', `[${tag}f]`));
      if (fragment.includes('[OUT]')) label = `${tag}f`;
    }
    filters.push(`[${label}]${pre || post ? `trim=start_frame=${pre}:end_frame=${pre + frames},` : ''}setpts=PTS-STARTPTS+round(${start}/TB),format=${pixels},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[${tag}s]`);
    filters.push(`[${currentVideo}][${tag}s]${overlayPlace(0, 0)}:enable='${onScreen(start, end)}'[${tag}v]`);
    currentVideo = `${tag}v`;
  };
  for (const clip of clips) {
    finite(clip.start, `${clip.name} start`, 0, timelineDuration);
    finite(clip.duration, `${clip.name} duration`, .001, 21600);
    const track = tracks.find(track => track.id === clip.trackId);
    if (!track) throw new Error(`${clip.name}: track is missing.`);
    let source = request.assets.find(source => source.asset.id === clip.mediaId && source.asset.projectId === project.id);
    if (isTitle(clip) || isShape(clip)) {
      if (track.hidden || track.kind !== 'video' || soundOnly) continue;
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
    // An adjustment clip's picture is the composite the tracks below have made so far: split it off the running stream.
    const adjust = isAdjustment(clip);
    if (adjust) {
      if (track.hidden || track.kind !== 'video' || soundOnly || request.decoder) continue;
      source = { path: '', asset: adjustmentAsset(clip, project.resolution) };
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
    const visual = !soundOnly && track.kind === 'video' && source.asset.kind !== 'audio' && !track.hidden;
    const explicitAudio = clips.some(other => other.id !== clip.id && tracks.find(t => t.id === other.trackId)?.kind === 'audio' && other.mediaId === clip.mediaId && other.start === clip.start && other.sourceIn === clip.sourceIn && other.duration === clip.duration);
    const audible = audio !== 'Disabled' && source.asset.hasAudio && !p.freeze && !track.muted && (!solo || track.solo) && !(track.kind === 'video' && (clip.properties.audioDetached || explicitAudio)) && inRange(clip.start, clip.start + clip.duration);
    if (!visual && !audible || request.only && !request.only.has(clip.id)) continue;
    const blend = String(p.blendMode ?? 'Normal');
    if (!blendModeOf(blend)) throw new Error(`${clip.name}: ${blend} blending is not available. Choose another blend mode.`);

    const speed = property('speed', 100, 1, 800) / 100;
    const localStart = Math.max(rangeIn - geo.start, 0), localEnd = Math.min(geo.duration, rangeOut - geo.start), length = localEnd - localStart;
    const offset = Math.max(0, geo.start - rangeIn);
    const sourceIn = finite(geo.sourceIn, `${clip.name} source in`, 0, 86400);
    const sourceStep = 1 / Math.max(1, source.asset.fps || fps);
    // Hold the source frame containing the requested time. A fractional seek
    // followed by a one-frame -t can otherwise decode zero frames in FFmpeg.
    // A range that starts inside a window held past the media (a still at 6.5 of a 6 s clip) seeks the last frame:
    // -ss 6.5 -t 0 decoded nothing to clone, and the window showed only its other side. Sound reads the same input,
    // so only a clip nobody hears here (its own body is outside the range then).
    const seek = source.asset.kind === 'image' ? sourceIn : p.freeze ? Math.floor(sourceIn / sourceStep + 1e-7) * sourceStep : Math.min(sourceIn + (p.reverse ? geo.duration - localEnd : localStart) * speed, audible ? Infinity : Math.floor(source.asset.duration / sourceStep - 1e-7) * sourceStep);
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
    if (adjust) {}
    else if (source.asset.kind === 'image') args.push('-loop', '1', '-framerate', String(fps));
    // Float noise like 7e-15 stringifies in exponent form, which FFmpeg's -ss parser rejects.
    else args.push('-ss', Math.max(0, seek).toFixed(6));
    // Passes that run side by side give each decoder their share of threads; a picture pass holds only a few
    // decoders, so it can also use the GPU (4:2:2 falls back to software on Ada NVDEC; Blackwell decodes it).
    // Every video decoder is capped, split or not: a render that takes all its threads for each decoder holds about 1 GB per 4K one.
    if (visual && source.asset.kind === 'video') { args.push(...(request.pass === 'video' ? await decodeAccel() : []), '-threads', String(Math.min(DECODE_THREADS, Number(threads)))); videoDecoders++; }
    if (!adjust) args.push('-t', String(source.asset.kind === 'image' ? length : decoded), ...safeInput, '-i', source.path);
    // ponytail: labels only, no FFmpeg input; offset past any real input index (a pass holds at most 128 clips).
    const index = adjust ? ADJUSTMENT_LABELS + adjustments++ : inputIndex++;
    if (visual) {
      let base: Cube | undefined, lookId: string | undefined;
      if (p.resolveLookUrl && p.bypassResolveLook !== true) {
        const match = /^\/api\/projects\/([a-zA-Z0-9_-]+)\/resolve\/([a-zA-Z0-9_-]+\.cube)$/.exec(String(p.resolveLookUrl));
        if (!match || match[1] !== project.id || !request.resolveDir) throw new Error(`${clip.name}: Resolve look is unavailable.`);
        ({ id: lookId, cube: base } = lookCube(await readFile(path.join(request.resolveDir, match[2]), 'utf8')));
      }
      let videoIndex=index,acesCube:string|undefined,acesInterpolation='trilinear';
      const usedMasks=activeSmartMasks(clip,request.nodes),depthKeys=activeDepthKeys(clip,request.nodes),maskStreams=new Map<string,{index:number;timing:string[]}>();
      const exactColor=usedMasks.length>0||depthKeys.length>0||clip.properties.colorPipeline==='nodes-v2'&&hasACES(request.nodes,clip.id);
      if(exactColor&&adjust&&(usedMasks.length||depthKeys.length))throw Error(`${clip.name}: Smart Masks and depth keys need source footage. Grade masked looks on the clips themselves, not on an adjustment clip.`);
      if(exactColor){
        // An adjustment clip only reaches the 129³ table bake, which reads the stages and not the file.
        const metadata=adjust?{width:projectWidth,height:projectHeight,fps,frameRate:String(fps),colorMatrix:'bt709'} as Awaited<ReturnType<typeof probeMedia>>:await probeMedia(source.path,request.signal),colorSource=interpretation(clip,source.asset);
        const jobPath=path.join(lutDir,`${index}.json`),output=path.join(lutDir,`${index}.mkv`);
        const matrix=String(p.yuvMatrix||source.asset.colorMatrix||metadata.colorMatrix||'auto').replace('bt2020-ncl','bt2020nc');
        const masks=usedMasks.map(document=>{
          if(!request.smartMaskDir)throw Error(`${clip.name}: Smart Mask storage is unavailable.`);
          // A baked picture (Stabilize) hands over its own re-warped matte; everything else resolves the stored one.
          const artifact:{directory:string;manifest:SmartMaskManifest;offset?:number}=request.maskArtifacts?.get(`${clip.id}:${document.id}`)??resolveSmartMaskArtifact(request.smartMaskDir,clip,document,source.path,source.asset),manifest=artifact.manifest;
          // A reviewed tracked selection is exportable. Its "preview" identity is
          // retained: exporting it does not turn segmentation into hair matting.
          if(manifest.width!==metadata.width||manifest.height!==metadata.height)throw Error(`${clip.name}: Smart Mask dimensions differ from the source.`);
          // A baked source (Stabilize, Depth) starts at `offset` of the original: move the matte's clock with it.
          const shift=artifact.offset??0,times=manifest.sourceTimes!.map(t=>t-shift),step=1/(metadata.fps||fps);
          if(times.some((t,i)=>i>0&&Math.abs(t-times[i-1]-step)>Math.max(.000003,step*.001)))throw Error(`${clip.name}: Smart Mask export currently requires constant-frame-rate source footage. Convert this source to constant frame rate and reanalyze.`);
          if(shift)document={...document,range:{start:document.range.start-shift,end:document.range.end-shift}};
          return {document,sourceTimes:times,files:Object.fromEntries(manifest.frames.map(f=>[String(f.index),path.join(artifact.directory,f.file)])),...(clip.effects.some(e=>e.maskId===document.id&&effectEnabled(clip,e)&&e.amount>0)?{output:path.join(lutDir,`${index}-${document.id}.mkv`)}:{})};
        });
        // A depth key reads the editor's run: the whole clip as the render started, not the part this pass decodes.
        const image=source.asset.kind==='image';let depth:Awaited<ReturnType<NonNullable<RenderRequest['depth']>['ready']>>|undefined;
        if(depthKeys.length){
          if(!request.depth)throw Error(`${clip.name}: depth analysis is not available on this server.`);
          request.onStage?.(`Analyzing depth · ${clip.name}`);
          depth=await request.depth.ready(depthRun(request,clip,source),request.signal,p=>request.onStage?.(`Analyzing depth · ${clip.name} · ${Math.round(p)}%`));
          depthHolds.push(depth.release);
        }
        // The first frame at or after the seek, as the plain -ss path and the viewer show (and the Depth bake, which
        // seeks half a frame early, wants): a trim between source frames must not start one frame early here.
        const times=masks[0]?.sourceTimes??(image?undefined:depth?.run.times),renderSeek=times?.find(t=>t>=seek-1e-7)??seek;
        if(!masks.length&&times?.some((t,i)=>i>0&&Math.abs(t-times[i-1]-1/(metadata.fps||fps))>Math.max(.000003,.001/(metadata.fps||fps))))throw Error(`${clip.name}: a depth key on export currently needs constant-frame-rate footage. Convert this source to constant frame rate first.`);
        const frameTimes=times?.filter(t=>t>=renderSeek-1e-7&&t<renderSeek+decoded-1e-7);
        // Each decoded frame's depth from the masters; color-render.py keys it with the same table as the preview and
        // upsamples bilinearly to the source size (a grading key, unlike Depth's guided upsample in depth-fx-math.md).
        let depthMasks:{document:{id:string};depth:Record<string,unknown>}[]=[];
        if(depth){
          const {run,masters}=depth,wanted=image?[run.first]:(frameTimes??[]).map(t=>depthFrameAt(run,t)),first=wanted[0],last=wanted.at(-1)!;
          const segments=run.segments.filter(s=>s.first+s.count>first&&s.first<=last).sort((a,b)=>a.n-b.n);
          if(!wanted.length||wanted.some(i=>i<0)||!segments.length||segments[0].first>first||segments.at(-1)!.first+segments.at(-1)!.count<=last||segments.some((s,i)=>i>0&&s.first!==segments[i-1].first+segments[i-1].count))throw Error(`${clip.name}: the depth analysis does not cover this clip. Export again.`);
          const spec={masters:segments.map(s=>path.join(masters,`${s.n}.mkv`)),width:run.width,height:run.height,indices:wanted.map(i=>i-segments[0].first),still:image};
          depthMasks=depthKeys.map(node=>({document:{id:nodeMaskId(node)!},depth:{...spec,table:Array.from(depthKeyTable(run,node.mask,1024))}}));
        }
        const hdr=hdrTransform(source.asset.colorTransfer),camera=clip.properties.colorPipeline!=='nodes-v2'?colorTransform(clip,source.asset,[],base):undefined;
        const inputCube=camera||hdr?makeCube(rgb=>{const sdr=hdr?hdr(rgb):rgb;return camera?camera(sdr):sdr;},65):undefined;
        const job={input:source.path,output,ffmpeg:ffmpeg(),image:source.asset.kind==='image',seek:renderSeek,duration:decoded,width:metadata.width,height:metadata.height,fps:source.asset.kind==='image'?fps:metadata.frameRate||metadata.fps,numericFps:metadata.fps||fps,threads:Number(request.singlePass?threads:exportThreads),frames:frameTimes?.length??Math.ceil(decoded*(metadata.fps||fps)),frameTimes,masks:[...masks,...depthMasks],alpha:masks.length>0,managed:clip.properties.colorPipeline==='nodes-v2',...(inputCube?{inputCube:{...inputCube,data:Array.from(inputCube.data)}}:{}),matrix:['bt709','bt470bg','smpte170m','bt2020nc'].includes(matrix)?matrix:'auto',range:p.dataLevels==='Full'?'pc':p.dataLevels==='Video'?'tv':'auto',stages:processingStages({...clip,properties:{...p,inputProfile:colorSource.profile,inputGamut:colorSource.gamut}},request.nodes)};
        await writeFile(jobPath,JSON.stringify(job));
        const python=process.env.FRAME_LINE_COLOR_PYTHON||venvPython('.venv-color');
        if(!existsSync(python))throw Error('OpenColorIO export is not installed. Run npm run setup:color on the server.');
        const colorStage = `Processing color · ${clip.name} (${colorsDone + 1}/${colorClips.length})`;
        request.onStage?.(colorStage);
        if(!usedMasks.length&&!depthKeys.length){
          // Without a matte every stage is per-pixel. Delivery-quality 8-bit exports use 97³ with tetrahedral
          // sampling (SIMD on x86); three real Canon Log 3 shots differed from 129³ by 0.04–0.06 of an 8-bit
          // step on average, under half a step at p99. Parsing 129³ in every short pass was a large fixed cost.
          // Masters, maximum/lossless quality and internal alpha/frame bakes keep the original 129³ table.
          // The table is made only of these three fields (write_cube in color-render.py). The bake is not tied to
          // this pass's signal: another pass or export may be waiting on the same table.
          const delivery = !isProRes && !request.transparent && !request.sampledFrame && !settings.quality?.startsWith('Maximum') && settings.quality !== 'Visually lossless';
          const size = delivery ? 97 : 129;
          acesInterpolation = delivery ? 'tetrahedral' : 'trilinear';
          acesCube=(await cachedLut(['aces-v2',size,job.stages,job.inputCube??null,job.managed],async file=>{await run(python,[path.resolve('scripts/color-render.py'),jobPath,'--cube',String(size),file]);},tables)).file;
          onProgress?.(++colorsDone/colorClips.length*colorBudget);
        } else {
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
      }
      if (adjust) { filters.push(`[${currentVideo}]split[adjkeep${index}][adjsrc${index}]`); currentVideo = `adjkeep${index}`; }
      const video = adjust ? [`trim=start=${offset.toFixed(6)}:duration=${length.toFixed(6)}`, `setpts=PTS-STARTPTS`] : [`setpts=PTS-STARTPTS`];
      if (p.freeze) video.push('trim=end_frame=1', `tpad=stop_mode=clone:stop_duration=${length}`);
      else {
        if (p.reverse && source.asset.kind !== 'image') video.push('reverse');
        if (source.asset.kind !== 'image') video.push(`setpts=(PTS-STARTPTS)/${speed}`);
        if (holdSeconds > 1e-6) video.push(`tpad=stop_mode=clone:stop_duration=${holdSeconds.toFixed(5)}`);
      }
      let lutPath = acesCube;
      if (!exactColor) {
        // HDR sources tone-map inside the same table, so the grade sees the SDR picture the preview shows.
        const hdr = hdrTransform(source.asset.colorTransfer);
        // Range saturation is a smooth step in luma: at 33³ it drifts several levels from the preview, at 65³ it matches as curves do.
        const size = hdr||clip.properties.colorPipeline==='nodes-v2'||request.nodes.some(n=>n.clipId===clip.id&&(n.curves||n.effects?.length||Object.keys(rangeDefaults).some(k=>n.parameters[k]!==undefined&&n.parameters[k]!==100)))?65:base?.size ?? 33;
        const table = await cachedLut(['look-v1', size, lookId ?? null, colorInputs(clip, source.asset, request.nodes), hdr ? [source.asset.colorTransfer, hdrNpl()] : null], async file => {
          const grade = colorTransform(clip, source.asset, request.nodes, base);
          const cube = makeCube(hdr ? rgb => grade(hdr(rgb)) : grade, size);
          if (isIdentity(cube)) return true;
          await writeFile(file, cubeText(cube));
        }, tables);
        lutPath = table.identity ? undefined : table.file;
      }
      // The fit to the canvas came after the grade, so a 4K source ran its table and float conversion on four times the
      // pixels the export keeps. Fitting first is what the preview does (it grades the smaller proxy), and it cut the
      // Newspaper composite from 152 s to 116 s. Pixel effects keep the old order: their radii are source pixels.
      // Scale X/Y stretch in the clip's own axes, before rotation, about the same anchor as Zoom.
      const zoom = property('zoom', 100, 1, 800) / 100, scaleX = property('scaleX', 100, 1, 800), scaleY = property('scaleY', 100, 1, 800);
      const scaledWidth = Math.max(2, Math.round(width * (zoom * (scaleX / 100)) / 2) * 2), scaledHeight = Math.max(2, Math.round(height * (zoom * (scaleY / 100)) / 2) * 2);
      if (scaledWidth * scaledHeight > 64_000_000) throw new Error(`${clip.name}: zoom requires too much memory at this resolution. Reduce Zoom.`);
      const poses=request.transformSamples?.[clip.id];
      const motion=poses&&poses.length>1;
      const shape=isShape(clip)?getShape(clip):undefined, anchorShift={x:shape?(shape.x+shape.width/2-.5)*width:0,y:shape?(shape.y+shape.height/2-.5)*height:0};
      // Keyframed position, zoom and rotation: each output frame's placement, sampled the way a per-frame render
      // evaluates the clip, drawn by one perspective filter in this pass (streamedTransform.ts).
      const streamed = !motion && !request.decoder && request.streamTransforms && streamsTransform(clip)
        ? Array.from({ length: Math.ceil(length * fps - 1e-6) + 1 }, (_, frame) => {
          const at = evaluateClip(clip, geo.start + localStart + frame / fps, fps).properties;
          const value = (key: string, fallback: number, min: number, max: number) => finite(at[key] ?? fallback, `${clip.name} ${key}`, min, max);
          return placement({ x: value('x', 0, -100000, 100000), y: value('y', 0, -100000, 100000), zoom: value('zoom', 100, 1, 800), scaleX: value('scaleX', 100, 1, 800), scaleY: value('scaleY', 100, 1, 800), rotation: value('rotation', 0, -360, 360), anchorX: value('anchorX', 0, -100000, 100000), anchorY: value('anchorY', 0, -100000, 100000) }, width, height, projectWidth, projectHeight, anchorShift);
        }) : undefined;
      // The clip is graded, cropped and padded on a canvas only as large as it ends up on the output, never larger
      // than the project canvas: a 4K project exported at 1080p used to grade, convert and pad every 4K frame and
      // only then shrink it. Crop stays measured in project pixels, scaled onto that canvas.
      const largest = motion ? Math.max(...poses.map(pose => Math.max(pose.scaleX, pose.scaleY))) * width : streamed ? Math.max(...streamed.map(frame => Math.max(frame.zoom, frame.zoomY))) * width : Math.max(scaledWidth, Math.round(width * (zoom * (scaleY / 100)) / 2) * 2);
      const canvas = Math.min(1, largest / projectWidth), canvasWidth = Math.max(2, Math.round(projectWidth * canvas)), canvasHeight = Math.max(2, Math.round(projectHeight * canvas));
      const fit = `w=${canvasWidth}:h=${canvasHeight}:force_original_aspect_ratio=decrease`;
      const fitFirst = !clip.effects.some(e => effectEnabled(clip, e) && Number(e.amount) > 0 && ![...audioEffectNames, 'Stabilize', 'Depth', 'Noise Reduction'].includes(e.name));
      video.push(`fps=${fps}`, `trim=duration=${length}`, 'setsar=1', ...videoFilters(clip, lutPath, source.asset, maskStreams, videoIndex === index, fitFirst ? fit : undefined, acesInterpolation));
      // After grade and matte (both in source orientation), before crop (measured on what the viewer sees).
      if (p.flipH && !isTitle(clip) && !isShape(clip)) video.push('hflip');
      const left = property('cropLeft', 0, 0, 16384), right = property('cropRight', 0, 0, 16384), top = property('cropTop', 0, 0, 16384), bottom = property('cropBottom', 0, 0, 16384);
      // Crop is measured on the fitted project canvas, preserving the original framing.
      video.push(...(fitFirst ? [] : [`scale=${fit}`]), 'format=gbrap16le', `pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      if (left + right >= projectWidth || top + bottom >= projectHeight) throw new Error(`${clip.name}: crop removes the entire frame.`);
      const [cropLeft, cropRight, cropTop, cropBottom] = [left, right, top, bottom].map(value => Math.round(value * canvas));
      if (left || right || top || bottom) video.push(`crop=${Math.max(1, canvasWidth - cropLeft - cropRight)}:${Math.max(1, canvasHeight - cropTop - cropBottom)}:${cropLeft}:${cropTop}`, `pad=${canvasWidth}:${canvasHeight}:${cropLeft}:${cropTop}:color=black@0`);
      const still = placement({ x: property('x', 0, -100000, 100000), y: property('y', 0, -100000, 100000), zoom: zoom * 100, scaleX, scaleY, rotation: property('rotation', 0, -360, 360), anchorX: property('anchorX', 0, -100000, 100000), anchorY: property('anchorY', 0, -100000, 100000) }, width, height, projectWidth, projectHeight, anchorShift);
      const rotation = still.rotation;
      if (streamed) video.push(...transformFilters(streamed, width, height, Math.min(2, Math.max(1, largest / width))));
      else if(!motion)video.push(`scale=${scaledWidth}:${scaledHeight}`);
      if (rotation&&!motion&&!streamed) video.push(`rotate=${rotation}:ow=rotw(${rotation}):oh=roth(${rotation}):c=none`);
      const opacity = property('opacity', 100, 0, 100);
      if (opacity < 100) video.push(`colorchannelmixer=aa=${opacity / 100}`);
      const fadeDuration=property('fadeDuration',clip.duration,.001,86400),fadeOrigin=property('fadeOrigin',0,-86400,86400);
      const fadeIn=property('fadeIn',0,0,fadeDuration),fadeOut=property('fadeOut',0,0,fadeDuration);
      if(fadeIn||fadeOut) {
        video.push(`setpts=PTS-STARTPTS+${localStart+fadeOrigin}/TB`);
        if(fadeIn)video.push(`fade=t=in:st=0:d=${fadeIn}:alpha=1`);
        if(fadeOut)video.push(`fade=t=out:st=${fadeDuration-fadeOut}:d=${fadeOut}:alpha=1`);
      }
      video.push(`setpts=PTS-STARTPTS+round(${offset}/TB)`, 'scale=out_color_matrix=bt709:out_range=tv', `format=${request.transparent?'rgba':'yuva444p10le'}`, 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709');
      // A motion-blurred or streamed layer is already placed on a full output frame.
      const shiftedX = motion || streamed ? 0 : still.shiftX, shiftedY = motion || streamed ? 0 : still.shiftY;
      filters.push(`[${adjust?`adjsrc${index}`:`${videoIndex}:v:0`}]${video.join(',')}[${motion?'motionbase':'clipv'}${index}]`);
      if(motion)filters.push(...motionBlurFilters(`motionbase${index}`,`clipv${index}`,poses,width,height,projectWidth,projectHeight,fps,length));
      if (request.decoder) { currentVideo = `clipv${index}`; continue; }
      const touching = transitions.filter(record => record.outgoingId === clip.id || record.incomingId === clip.id);
      const visible = onScreen(offset, offset + length);
      // A transition window composites its two sides normally, as the preview's side canvases do.
      const place = (layer: string, enable: string) => filters.push(...blend === 'Normal' ? [`[${currentVideo}][${layer}]${overlayPlace(shiftedX, shiftedY)}:enable='${enable}'[v${index}]`]
        : blendFilters({ under: currentVideo, layer, output: `v${index}`, mode: blend, tag: `bm${index}`, width, height, fps, duration, x: `(W-w)/2+${shiftedX}`, y: `(H-h)/2+${shiftedY}`, enable, transparent: request.transparent,
          region: !rotation && !motion && !streamed ? blendRegion(width, height, scaledWidth, scaledHeight, shiftedX, shiftedY) : undefined }));
      if (!touching.length) place(`clipv${index}`, visible);
      else {
        // One branch per window plus the body, so the clip outside its transitions is untouched.
        const branches = touching.map((_, n) => `w${index}_${n}`);
        filters.push(`[clipv${index}]split=${branches.length + 1}[body${index}]${branches.map(name => `[${name}]`).join('')}`);
        const outside = touching.map(record => `(1-${onScreen(Math.max(0, record.start - rangeIn), Math.min(duration, record.end - rangeIn))})`).join('*');
        place(`body${index}`, `${visible}*${outside}`);
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
      const effects = [...audioFilters(clip), 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'];
      sound.push(...effects);
      if (p.normalize) {
        // Measured on the clip's whole trim after its effects, so every range and pass of an export gets the same constant
        // gain; the master limiter catches what the gain pushes over. Tempo and reverse leave integrated loudness alone.
        const target = loudnessTarget(clip), measured = await clipLoudness(source.path, clip.sourceIn, clip.duration * speed, effects);
        if (measured !== undefined) sound.push(`volume=${(target - measured).toFixed(2)}dB`);
      }
      const gain = property('gain', 0, -60, 12) + finite(track.gain, `${track.name} gain`, -60, 12);
      const pan = Math.max(-1, Math.min(1, (property('pan', 0, -100, 100) + finite(track.pan, `${track.name} pan`, -100, 100)) / 100));
      // Match the browser StereoPannerNode: move both stereo channels toward the selected side.
      const cosine = Math.cos(Math.abs(pan) * Math.PI / 2), sine = Math.sin(Math.abs(pan) * Math.PI / 2);
      const fadeDuration=property('fadeDuration',clip.duration,.001,86400),fadeOrigin=property('fadeOrigin',0,-86400,86400);
      const fadeIn=property('audioFadeIn',0,0,fadeDuration),fadeOut=property('audioFadeOut',0,0,fadeDuration);
      const lead = Math.max(0, audioOffset - offset);
      if (lead > 1e-9) sound.push(`atrim=start=${lead}`, 'asetpts=PTS-STARTPTS');
      if(fadeIn||fadeOut) {sound.push(`asetpts=PTS-STARTPTS+${audioStart+fadeOrigin}/TB`);if(fadeIn)sound.push(`afade=t=in:st=0:d=${fadeIn}`);if(fadeOut)sound.push(`afade=t=out:st=${fadeDuration-fadeOut}:d=${fadeOut}`);sound.push('asetpts=PTS-STARTPTS');}
      const keyed = gainExpression(clip, audioStart, finite(track.gain, `${track.name} gain`, -60, 12));
      // Small frames keep a keyed ramp smooth: eval=frame steps the gain once per frame.
      sound.push(...(keyed ? ['asetnsamples=n=240:p=0', keyed] : [`volume=${gain}dB`]), `pan=stereo|c0=${pan > 0 ? cosine : 1}*c0+${pan < 0 ? sine : 0}*c1|c1=${pan > 0 ? sine : 0}*c0+${pan < 0 ? cosine : 1}*c1`, `atrim=duration=${audioLength}`, `adelay=${Math.round(audioOffset * 48000)}S:all=1`);
      filters.push(`[${index}:a:0]${sound.join(',')}[clipa${index}]`); audioLabels.push(`[clipa${index}]`);
    }
  }
  // A sound pass renders no pictures to hang the windows' embedded leak sound on, so it carries it itself.
  if (soundOnly && request.leakSound && audio !== 'Disabled') for (const record of transitions) {
    const owner = clips.find(clip => clip.id === record.clipId), ownerTrack = owner && tracks.find(t => t.id === owner.trackId);
    if (!transitionDefinitions[record.name]?.overlay || record.audioClipId || ownerTrack?.kind !== 'video' || ownerTrack.hidden) continue;
    if (frameAt(Math.min(duration, record.end - rangeIn)) - frameAt(Math.max(0, record.start - rangeIn)) < 1) continue;
    const leak = await leakFile(record);
    if (leak.probed.hasAudio) leakSound(record, leakInput(leak), leak.probed);
  }
  if (request.decoder) filters.push(`[${currentVideo}]scale=in_color_matrix=bt709:in_range=tv,format=rgba64le[video]`);
  else if (!soundOnly) filters.push(`[${currentVideo}]format=${isProRes ? codec.endsWith('4444') ? 'yuva444p10le' : 'yuv422p10le' : 'yuv420p'},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[video]`);
  if (audio !== 'Disabled') {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`);
    const masterGain = finite(settings.masterGain ?? 0, 'Master gain', -60, 12);
    if (settings.masterMuted && !['true', 'false'].includes(settings.masterMuted)) throw new Error('Master mute must be true or false.');
    // A sound pass is one stem of several; the join applies the master once, to their sum.
    const master = soundOnly ? '' : `,volume=${settings.masterMuted === 'true' ? '0' : `${masterGain}dB`}${request.transparent||request.sampledFrame?'':',alimiter=limit=1:level=0:latency=1'}`;
    filters.push(`[silence]${audioLabels.join('')}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0:dropout_transition=0${master}[audio]`);
  }
  args.push(...await graphArgs(filters.join(';'), path.join(lutDir, 'graph.txt')));
  // Inside the try: the decoder still reads this pass's tables and colour renders.
  if (request.decoder) { await request.decoder([ffmpeg(), ...args, '-map', '[video]', '-frames:v', String(Math.ceil(duration * fps - 1e-6)), '-f', 'rawvideo', '-pix_fmt', 'rgba64le', 'pipe:1']); return; }
  if (!soundOnly) args.push('-map', '[video]');
  if (audio !== 'Disabled') args.push('-map', '[audio]', ...audioCodecArgs(soundOnly ? 'Linear PCM' : audio, soundOnly || Boolean(request.transparent || request.sampledFrame)));
  if (soundOnly) args.push('-t', String(duration), '-rf64', 'auto', '-f', 'wav');
  // A picture pass is joined losslessly afterwards: exact frame count, and no faststart rewrite of a file about to be copied.
  else args.push(...await videoCodecArgs(codec, settings.quality, threads, width, height), '-t', String(duration), ...(request.pass === 'video' ? ['-frames:v', String(Math.ceil(duration * fps - 1e-6))] : ['-movflags', '+faststart']), '-r', String(fps), '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  args.push('-progress', 'pipe:1', '-nostats', outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  request.onStage?.('Encoding video and audio');
  onProgress?.(colorBudget);
  // A preview was admitted once as a whole job (previewCache); every other encode, split pass or frame bake, asks for its own memory.
  const wait = request.onWait ?? ((text: string | null) => request.onStage?.(text ?? 'Encoding video and audio'));
  const guard = request.singlePass ? undefined : { kind: 'export' as const, costBytes: encodeCostBytes(videoDecoders), label: 'Render pass', onStatus: wait };
  try { await run(ffmpeg(), args, { signal, duration, nice: request.nice, guard, onProgress: p => onProgress?.(colorBudget+p*(100-colorBudget)/100) }); onProgress?.(100); }
  catch (error) { await rm(outputPath, { force: true }); throw error; }
  } finally { releaseLuts(tables); for (const release of depthHolds) release(); await rm(lutDir, { recursive: true, force: true }); }
}

/**
 * Render an export as independent passes and join them. Picture passes run side by side, each decoding only
 * its own range. Sound is mixed over the whole range so no filter restarts at a seam, split only when the
 * command line needs it: summing per-clip chains in stems is exactly what one graph did, and the master stage
 * runs once over the sum. The join copies the picture losslessly.
 */
async function renderSplit(request: RenderRequest, plan: { passes: { from: number; to: number }[]; sounds: Clip[]; fps: number; total: number; duration: number }) {
  const { settings, signal, onProgress, outputPath } = request, { fps, duration } = plan;
  const rangeIn = Number(settings.rangeIn ?? 0), codec = settings.codec || 'H.264', audio = settings.audio || 'AAC · 320 kb/s · 48 kHz';
  const internal = Boolean(request.transparent || request.sampledFrame), threads = Math.max(2, Math.floor(Number(exportThreads) / EXPORT_PASSES));
  const directory = await mkdtemp(path.join(tmpdir(), 'frameline-passes-'));
  try {
    const pictures = plan.passes.map((pass, index) => ({ ...pass, file: path.join(directory, `picture-${index}${codec.includes('ProRes') ? '.mov' : '.mp4'}`) }));
    const stems = audio === 'Disabled' ? [] : Array.from({ length: Math.max(1, Math.ceil(plan.sounds.length / PASS_SOUNDS)) }, (_, index) =>
      ({ only: new Set(plan.sounds.slice(index * PASS_SOUNDS, (index + 1) * PASS_SOUNDS).map(clip => clip.id)), file: path.join(directory, `sound-${index}.wav`) }));
    const work = [...stems.map(stem => ({ stem, picture: undefined })), ...pictures.map(picture => ({ picture, stem: undefined }))];
    const progress = work.map(() => 0), weights = work.map(item => item.picture ? .95 * (item.picture.to - item.picture.from) / plan.total : .02 / stems.length);
    const report = () => onProgress?.(progress.reduce((sum, value, index) => sum + value * weights[index], 0));
    let joined = 0;
    request.onStage?.(`Rendering video · 0/${pictures.length} parts`);
    // `threads` stays computed from the ceiling: fewer passes under memory pressure must never mean more decoder threads each.
    const passes = exportPassCount(EXPORT_PASSES, JOB_COST_BYTES.renderPass);
    const onWait = request.onWait ?? ((text: string | null) => request.onStage?.(text ?? `Rendering video · ${joined}/${pictures.length} parts`));
    await inParallel(work, passes, signal, async (item, index, passSignal) => {
      const pass = { ...request, signal: passSignal, threads, onStage: undefined, onWait, onProgress: (value: number) => { progress[index] = value; report(); } };
      if (item.stem) await renderTimeline({ ...pass, pass: 'audio', only: item.stem.only, leakSound: item.stem === stems[0], outputPath: item.stem.file });
      // The last part ends at the export's own out point, which may cut into its final frame.
      else await renderTimeline({ ...pass, pass: 'video', outputPath: item.picture!.file, settings: { ...settings, audio: 'Disabled', rangeIn: String(rangeIn + item.picture!.from / fps), ...(item.picture!.to === plan.total ? {} : { rangeOut: String(rangeIn + item.picture!.to / fps) }) } });
      progress[index] = 100; report();
      if (item.picture) request.onStage?.(`Rendering video · ${++joined}/${pictures.length} parts`);
    });
    request.onStage?.('Joining parts');
    // Exact durations keep every part on the frame grid instead of trusting each file's rounded length.
    const list = path.join(directory, 'pictures.txt');
    await writeFile(list, pictures.map(picture => `file '${picture.file}'\nduration ${((picture.to - picture.from) / fps).toFixed(9)}\n`).join(''));
    const args = [...exportCommon(), '-f', 'concat', '-safe', '0', '-i', list, ...stems.flatMap(stem => ['-i', stem.file]), '-map', '0:v', '-c:v', 'copy'];
    if (stems.length) {
      const master = settings.masterMuted === 'true' ? '0' : `${finite(settings.masterGain ?? 0, 'Master gain', -60, 12)}dB`;
      const sum = stems.length > 1 ? `${stems.map((_, index) => `[${index + 1}:a]`).join('')}amix=inputs=${stems.length}:duration=first:normalize=0:dropout_transition=0,` : '[1:a]';
      args.push(...await graphArgs(`${sum}volume=${master}${internal ? '' : ',alimiter=limit=1:level=0:latency=1'}[audio]`, path.join(directory, 'mix.txt')), '-map', '[audio]', ...audioCodecArgs(audio, internal));
    }
    args.push('-t', String(duration), '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    try { await run(ffmpeg(), args, { signal, duration, onProgress: value => onProgress?.(97 + value * .03) }); onProgress?.(100); }
    catch (error) { await rm(outputPath, { force: true }); throw error; }
  } finally { await rm(directory, { recursive: true, force: true }); }
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
    const fps = finite(request.settings.fps || request.project.fps, 'Frame rate', 1, 120);
    const records = framedTransitions(timelineTransitions(own, request.timeline.id, request.assets.map(entry => entry.asset)), Number(request.settings.rangeIn ?? 0) || 0, fps);
    let clips = [...request.clips];
    const assets = [...request.assets];
    for (const [index, record] of records.entries()) {
      if (request.signal?.aborted) throw new Error('Canceled by you');
      // Split pieces keep their clip's id, because grades, mattes and keyframes are all keyed by it (a renamed
      // piece exported as ungraded log). A clip split by an earlier window has two pieces; only one touches this one.
      const sides = clips.filter(clip => (clip.id === record.outgoingId || clip.id === record.incomingId) && clip.start < record.end - 1e-6 && clip.start + clip.duration > record.start + 1e-6);
      if (!sides.length) continue;
      // The window is rendered whole, so a keyframed *participant* would need per-frame baking of
      // the blend itself. Animation elsewhere on the timeline is fine and is baked afterwards.
      const animated = sides.find(side => perFrame(side, request));
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
        ...clips.filter(clip => !sides.includes(clip)),
        ...sides.flatMap(side => uncoveredParts(side, record.start, record.end).map(part => ({ ...part, transition: '', properties: { ...part.properties, transitionOut: '' } }))),
        { id: mediaId, projectId: request.project.id, timelineId: request.timeline.id, trackId: track.id, mediaId, name: record.name,
          start: record.start, duration: span, sourceIn: 0, color: '#8fb3c4', disabled: false, properties: {}, effects: [] },
      ];
    }
    const flattened = { ...request, clips, assets, onProgress: (p: number) => request.onProgress?.(30+p*.7) };
    // Only the pre-rendered windows needed transitions; what remains may not even be animated.
    if (animationWork(flattened).length) return await renderAnimatedTimeline(flattened);
    return await renderTimeline(flattened);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Stabilize export bakes an export is reading, and how much of them to keep (about 25 s of 4K ProRes 422 HQ per GB).
const stabilizeBakesInUse=new Map<string,number>(), STABILIZE_BAKES_BYTES=16*1024**3;
/** Bake stabilized picture as source-time replacement media, then composite normally. Timing edits stay on the clip. */
async function renderStabilizedTimeline(request: RenderRequest) {
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-stabilize-export-')),claimed:string[]=[];
  try {
  const clips=[...request.clips],assets=[...request.assets],tracks=[...request.tracks];
  // Bakes are named by everything that shapes them (stabilizeIdentity), so a re-export reuses them, and so does the
  // optical-flow bake keyed on this file. They used to live in this export's temporary folder: every export baked
  // every Stabilize clip again and could never hit the flow cache for one.
  const bakes=request.stabilizeDir?path.join(request.stabilizeDir,'exports'):directory;
  const records=timelineTransitions(clips.filter(c=>c.projectId===request.project.id),request.timeline.id,assets.map(a=>a.asset));
  const stabilizing=clips.filter(c=>c.timelineId===request.timeline.id&&!c.disabled&&stabilizeEffect(c));
  // A clip outside the range is never drawn: it only loses the effect, so the render after the bakes does not come back here.
  for(const clip of stabilizing.filter(c=>outsideRange(request,c,records)))clips[clips.indexOf(clip)]={...clip,effects:clip.effects.filter(e=>e.name!=='Stabilize')};
  const candidates=stabilizing.filter(c=>!outsideRange(request,c,records));
  const maskArtifacts=new Map(request.maskArtifacts),stabilized=new Map(request.stabilized);
  for(const [index,clip] of candidates.entries()) {
    // Optical flow needs no check: the bake below is source-time media, so the recursive render hands it to renderFlowTimeline,
    // which interpolates the stabilized frames (stabilize first, then retime).
    // ponytail: the key would need the depth warped like the picture (stabilizeWarpMattes does it for subjects).
    if(activeDepthKeys(clip,request.nodes).length)throw Error(`${clip.name}: a depth key and Stabilize cannot share a clip in export yet. Remove the depth key or Stabilize.`);
    const source=assets.find(a=>a.asset.id===clip.mediaId),track=tracks.find(t=>t.id===clip.trackId);
    if(!source||source.asset.kind!=='video'||!track)throw new Error(`${clip.name}: Stabilize requires a video source.`);
    // Under a Noise Reduction bake everything below runs in the original's time on the original, as the editor's analysis
    // did; only the render reads the clean bake, `shift` seconds later into its own file.
    const denoised=request.denoised?.get(clip.id),original=denoised?.source??source,shift=denoised?.offset??0,base=denoised?.clip??clip;
    const span=clipSpan(base,records),geo=extendClip(base,Math.max(0,span.start),span.end-Math.max(0,span.start));
    const sourceFps=original.asset.fps||finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
    const range=stabilizeRange(geo,sourceFps,original.asset.duration);
    const settings=stabilizeSettings(clip,stabilizeEffect(clip)!);
    // Resolve every matte against the original before the source is swapped for the bake, then move each one
    // with the picture's own matrices. Stabilize first, Smart Mask on top of the stabilized frame.
    const documents=activeSmartMasks(clip,request.nodes);
    // Said here, before the analysis and the bake, rather than by renderFlowTimeline after the first 45 % of the export.
    if(clip.properties.opticalFlow&&documents.length)throw Error(`${clip.name}: Smart Mask and optical-flow retiming need a shared warped matte. Disable optical flow for this clip.`);
    // Moving the mattes owns the front fifth of this clip's slice; the bake owns the rest.
    const mattes=documents.length?.2:0;
    const report=(fraction:number)=>request.onProgress?.((index+Math.max(0,Math.min(1,fraction)))/candidates.length*45);
    // The bake's frame k is the source frame nearest to range.from + k/fps (a tie goes to the earlier one), so a
    // matte's clock moves by that frame's time, not by range.from itself: a trim between frames is otherwise one off.
    const step=1/sourceFps,matteOffset=(times?:number[])=>times?.find(t=>t>=range.from-step/2-1e-6)??range.from;
    for(const [order,document] of documents.entries()) {
      if(!request.smartMaskDir)throw Error(`${clip.name}: Smart Mask storage is unavailable.`);
      // A Noise Reduction bake already resolved it against the original.
      const artifact=request.maskArtifacts?.get(`${clip.id}:${document.id}`)??resolveSmartMaskArtifact(request.smartMaskDir,clip,document,source.path,source.asset);
      const warped=path.join(directory,`mask-${clip.id}-${document.id}`);
      await mkdir(path.join(warped,'frames'),{recursive:true});
      await stabilizeWarpMattes({input:original.path,directory:request.stabilizeDir??directory,range,settings,signal:request.signal,
        onProgress:p=>report(mattes*(order+p/100)/documents.length),
        frames:artifact.manifest.frames.map(f=>({input:path.join(artifact.directory,f.file),output:path.join(warped,f.file),time:f.time}))});
      maskArtifacts.set(`${clip.id}:${document.id}`,{directory:warped,manifest:artifact.manifest,offset:matteOffset(artifact.manifest.sourceTimes)});
    }
    request.onStage?.(`Stabilizing · ${clip.name}`);
    const baked=await renderStabilized({input:source.path,...denoised?{analysisInput:original.path,inputOffset:shift,inputKey:path.basename(source.path)}:{},directory:bakes,analysisDirectory:request.stabilizeDir,range,from:range.from,to:range.to,settings,preview:false,signal:request.signal,onProgress:p=>report(mattes+(1-mattes)*p/100)});
    claimed.push(baked.key);stabilizeBakesInUse.set(baked.key,(stabilizeBakesInUse.get(baked.key)??0)+1);
    // Read again: the cache keeps what was used last.
    const now=new Date();await utimes(baked.output,now,now).catch(()=>{});
    // A Depth on this clip reads analysis of the original and warps it with the picture's own matrices.
    if(depthEffect(clip))stabilized.set(clip.id,{clip:base,source:original,offset:range.from,solve:(await stabilizeSolve({input:original.path,directory:request.stabilizeDir??directory,range,settings,signal:request.signal})).solve});
    const mediaId=`stabilize-${clip.id}`,metadata=await probeMedia(baked.output,request.signal);
    assets.push({path:baked.output,asset:{...source.asset,id:mediaId,duration:range.to-range.from,fps:metadata.fps||sourceFps,hasAudio:false,colorRange:metadata.colorRange,colorMatrix:metadata.colorMatrix}});
    clips[clips.indexOf(clip)]={...clip,mediaId,sourceIn:clip.sourceIn-(range.from-shift),effects:clip.effects.filter(e=>e.name!=='Stabilize'),properties:{...clip.properties,audioDetached:true}};
    const explicitAudio=request.clips.some(other=>other.id!==clip.id&&tracks.find(t=>t.id===other.trackId)?.kind==='audio'&&other.mediaId===clip.mediaId&&other.start===clip.start&&other.sourceIn===clip.sourceIn&&other.duration===clip.duration);
    if(source.asset.hasAudio&&!clip.properties.audioDetached&&!explicitAudio&&request.settings.audio!=='Disabled') {
      const audioId=`stabilize-audio-${clip.id}`;
      tracks.push({...track,id:audioId,kind:'audio'});
      // The original carries the sound; the bake is picture only.
      // opticalFlow off: the sound is never interpolated, and renderFlowTimeline would otherwise bake this clip's picture a second time.
      clips.push({...clip,id:audioId,trackId:audioId,transition:'',properties:{...clip.properties,opticalFlow:false,transitionOut:'',audioDetached:false},keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>timingPaths.includes(path)||/^properties\.(gain|pan|audioFadeIn|audioFadeOut)$/.test(path)||path.startsWith('effects.'))),effects:clip.effects.filter(e=>audioEffectNames.includes(e.name))});
    }
  }
  // The oldest bakes beyond the budget go, and the leftovers of a render the server died in.
  if(bakes!==directory)await Promise.all([trimFlowCache(bakes,new Set(stabilizeBakesInUse.keys()),STABILIZE_BAKES_BYTES,'mov'),trimStabilizeCache(bakes,new Set(),Infinity)]);
  await renderTimeline({...request,clips,assets,tracks,maskArtifacts,stabilized,onProgress:p=>request.onProgress?.(45+p*.55)});
  } finally {
    for(const key of claimed){const left=(stabilizeBakesInUse.get(key)??1)-1;if(left>0)stabilizeBakesInUse.set(key,left);else stabilizeBakesInUse.delete(key);}
    await rm(directory,{recursive:true,force:true});
  }
}
/** A clip whose picture Noise Reduction bakes. One on an audio track (an Audio workspace insert from before Audio Noise
 *  Reduction existed) shapes nothing: picture and sound filters both pass it by. */
export const denoisesPicture = (request: Pick<RenderRequest, 'tracks'>, clip: Clip) => !!denoiseEffect(clip) && request.tracks.find(t => t.id === clip.trackId)?.kind === 'video'
  // A legacy or Final Cut Noise Reduction on what is not camera footage is a no-op, as the filter chain treats it.
  && !isTitle(clip) && !isShape(clip) && !isAdjustment(clip) && !clip.properties.compositionId;
// Noise Reduction export bakes a running export still reads (a re-export reuses the rest, see trimDenoiseBakes).
const denoiseBakesInUse=new Map<string,number>();
/**
 * Bake each clip's Noise Reduction from the camera original into source-time replacement media before anything else reads
 * it, whatever its place in the stack, as Stabilize does: Stabilize, Smart Mask, Depth, optical flow and the grade all take
 * the clean frames. The clip keeps its timing and grade and plays the bake from a remapped sourceIn; its sound plays from
 * the original through a carrier clip.
 */
async function renderDenoisedTimeline(request: RenderRequest) {
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-denoise-export-')),claimed:string[]=[];
  try {
  const clips=[...request.clips],assets=[...request.assets],tracks=[...request.tracks];
  const bakes=request.denoiseDir?path.join(request.denoiseDir,'exports'):directory,profiles=request.denoiseDir?path.join(request.denoiseDir,'profiles'):directory;
  const records=timelineTransitions(clips.filter(c=>c.projectId===request.project.id),request.timeline.id,assets.map(a=>a.asset));
  const denoising=clips.filter(c=>c.timelineId===request.timeline.id&&!c.disabled&&denoisesPicture(request,c));
  const strip=(clip:Clip):Clip=>({...clip,effects:clip.effects.filter(e=>e.name!=='Noise Reduction')});
  // Never drawn (outside the range, on a hidden track) or no footage to bake (a still with a legacy or Final Cut Noise
  // Reduction): the clip only loses the effect, keeping its own media and sound.
  const skipped=(c:Clip)=>outsideRange(request,c,records)||!!tracks.find(t=>t.id===c.trackId)?.hidden||assets.find(a=>a.asset.id===c.mediaId)?.asset.kind!=='video';
  for(const clip of denoising.filter(skipped))clips[clips.indexOf(clip)]=strip(clip);
  const candidates=denoising.filter(c=>!skipped(c)),{rangeIn,rangeOut}=exportRange(request);
  const maskArtifacts=new Map(request.maskArtifacts),denoised=new Map(request.denoised);
  for(const [index,whole] of candidates.entries()) {
    const effect=denoiseEffect(whole)!,source=assets.find(a=>a.asset.id===whole.mediaId)!,track=tracks.find(t=>t.id===whole.trackId);
    if(!track)throw new Error(`${whole.name}: Noise Reduction requires a video source.`);
    if(source.asset.hasAlpha)throw new Error(`${whole.name}: Noise Reduction cannot bake footage with transparency. Remove Noise Reduction from this clip.`);
    // One bake per clip: a setting that changes over time would need the whole clip denoised once per value. Only the paths the
    // bake reads count: older builds keyed parameters no panel shows any more, which the user could not find to remove.
    const read=['enabled',...denoiseKeys.map(k=>k==='amount'?k:`parameters.${k}`)].map(k=>`effects.${effect.id}.${k}`);
    if(read.some(key=>whole.keyframes?.[key]?.length))throw new Error(`${whole.name}: Noise Reduction settings cannot be keyframed. Remove their keyframes.`);
    // ponytail: a depth key reads the original's analysis at the clip's own times; it needs the bake offset like Depth has.
    if(activeDepthKeys(whole,request.nodes).length)throw new Error(`${whole.name}: a depth key and Noise Reduction cannot share a clip in export yet. Remove the depth key or Noise Reduction.`);
    // Bake only what this render shows (an In/Out export), widened to the clip's transitions that reach into it, as Depth
    // does; the worker reads its own context frames around that. A later Stabilize or optical-flow bake reads the whole clip.
    let lo=rangeIn,hi=rangeOut;
    const end=whole.start+whole.duration;
    if(stabilizeEffect(whole)||whole.properties.opticalFlow){lo=-Infinity;hi=Infinity;}
    else for(const r of records)if((r.outgoingId===whole.id||r.incomingId===whole.id)&&r.start<hi&&r.end>lo){lo=Math.min(lo,r.start);hi=Math.max(hi,r.end);}
    const from=lo-whole.start>1/120?lo:whole.start,to=end-hi>1/120?hi:end;
    let clip=whole;
    if(from!==whole.start||to!==end){
      clip={...clipPart(whole,from,to),transition:from===whole.start?whole.transition:''};
      if(to!==end)clip.properties={...clip.properties,transitionOut:''};
      clips.splice(clips.indexOf(whole),1,clip,...uncoveredParts(whole,from,to).filter(part=>part!==whole).map((part,i)=>({...strip(part),id:`${whole.id}-outside-${i}`,transition:part.start===whole.start?whole.transition:'',properties:{...part.properties,transitionOut:part.start===whole.start?'':whole.properties.transitionOut,audioDetached:true}})));
    }
    const handles=clipSpan(whole,records),span={start:from===whole.start?handles.start:from,end:to===end?handles.end:to};
    const geo=extendClip(clip,Math.max(0,span.start),span.end-Math.max(0,span.start));
    const sourceFps=source.asset.fps||finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
    const range=stabilizeRange(geo,sourceFps,source.asset.duration);
    request.onStage?.(`Noise Reduction · ${clip.name}`);
    // `keep`: this export's earlier bakes are claimed below before the next one starts, so making room never takes them.
    const baked=await denoiseBake({name:clip.name,input:source.path,directory:bakes,profiles,range,fps:sourceFps,frameRate:source.asset.frameRate,duration:source.asset.duration,settings:denoiseSettings(whole,effect),signal:request.signal,freeGpu:request.freeGpu,
      dataLevels:whole.properties.dataLevels,keep:new Set(denoiseBakesInUse.keys()),onProgress:p=>request.onProgress?.((index+Math.max(0,Math.min(1,p/100)))/candidates.length*45)});
    claimed.push(baked.key);denoiseBakesInUse.set(baked.key,(denoiseBakesInUse.get(baked.key)??0)+1);
    // Read again: the cache keeps what was used last.
    const now=new Date();await utimes(baked.output,now,now).catch(()=>{});
    // The bake's frame k is the original's frame first + k on the constant-rate grid, so mattes move by that frame's time.
    const offset=baked.first/sourceFps,step=1/sourceFps;
    for(const document of activeSmartMasks(clip,request.nodes)) {
      if(!request.smartMaskDir)throw Error(`${clip.name}: Smart Mask storage is unavailable.`);
      const key=`${clip.id}:${document.id}`,artifact=maskArtifacts.get(key)??resolveSmartMaskArtifact(request.smartMaskDir,whole,document,source.path,source.asset);
      maskArtifacts.set(key,{...artifact,offset:artifact.manifest.sourceTimes?.find(t=>t>=offset-step/2-1e-6)??offset});
    }
    denoised.set(clip.id,{clip,source,offset});
    const mediaId=`denoise-${clip.id}`;
    // Same colour metadata: the bake is the original's own Y′CbCr with its own tags, so grade, LUT and camera fields still apply.
    // Except the range: a full-range source is baked converted to video range (denoiseBake), the only range a MOV reads back as.
    // So is one a Data levels override calls full; any override then says Video, which is what the bake holds.
    const levels=(await probeMedia(baked.output,request.signal)).colorRange,override=clip.properties.dataLevels==='Full'||clip.properties.dataLevels==='Video';
    assets.push({path:baked.output,asset:{...source.asset,id:mediaId,duration:baked.frames/sourceFps,fps:sourceFps,hasAudio:false,colorRange:levels}});
    clips[clips.indexOf(clip)]={...strip(clip),mediaId,sourceIn:clip.sourceIn-offset,properties:{...clip.properties,audioDetached:true,...override?{dataLevels:'Video'}:{}}};
    const explicitAudio=request.clips.some(other=>other.id!==whole.id&&tracks.find(t=>t.id===other.trackId)?.kind==='audio'&&other.mediaId===whole.mediaId&&other.start===whole.start&&other.sourceIn===whole.sourceIn&&other.duration===whole.duration);
    if(source.asset.hasAudio&&!clip.properties.audioDetached&&!explicitAudio&&request.settings.audio!=='Disabled') {
      const audioId=`denoise-audio-${clip.id}`;
      tracks.push({...track,id:audioId,kind:'audio'});
      // The original carries the sound; opticalFlow off, or renderFlowTimeline would bake this clip's picture a second time.
      clips.push({...clip,id:audioId,trackId:audioId,transition:'',properties:{...clip.properties,opticalFlow:false,transitionOut:'',audioDetached:false},keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>timingPaths.includes(path)||/^properties\.(gain|pan|audioFadeIn|audioFadeOut)$/.test(path)||path.startsWith('effects.'))),effects:clip.effects.filter(e=>audioEffectNames.includes(e.name))});
    }
  }
  if(bakes!==directory)await trimDenoiseBakes(bakes,new Set(denoiseBakesInUse.keys()));
  await renderTimeline({...request,clips,assets,tracks,maskArtifacts,denoised,onProgress:p=>request.onProgress?.(45+p*.55)});
  } finally {
    for(const key of claimed){const left=(denoiseBakesInUse.get(key)??1)-1;if(left>0)denoiseBakesInUse.set(key,left);else denoiseBakesInUse.delete(key);}
    await rm(directory,{recursive:true,force:true});
  }
}
const DEPTH_SECTIONS = ['blur', 'fog', 'glow', 'light'];
const depthKeyed = (clip: Clip, effect: Effect) => Object.keys(clip.keyframes ?? {}).filter(key => key.startsWith(`effects.${effect.id}.`) && clip.keyframes![key].length);
/** Switched on, or switched on by a keyframe somewhere (the bake reads the `enabled` channel frame by frame). */
const depthOn = (clip: Clip, effect: Effect) => effect.name === 'Depth' && effectEnabled(clip, { ...effect, enabled: effect.enabled || depthKeyed(clip, effect).includes(`effects.${effect.id}.enabled`) });
/** The clip's Depth when it changes the picture: some Mix and a section on (or keyframed). With every section off it is the identity. */
function depthEffect(clip: Clip) {
  return clip.effects.find(effect => {
    if (!depthOn(clip, effect)) return false;
    const keyed = depthKeyed(clip, effect);
    return (Number(effect.amount) > 0 || keyed.includes(`effects.${effect.id}.amount`)) && DEPTH_SECTIONS.some(key => effectValue(clip, effect, key) > 0 || keyed.includes(`effects.${effect.id}.parameters.${key}`));
  });
}
const exportRange = (request: Pick<RenderRequest, 'settings' | 'timeline'>) => ({ rangeIn: Number(request.settings.rangeIn) || 0, rangeOut: Number(request.settings.rangeOut ?? request.timeline.duration) || request.timeline.duration });
type Shown = Pick<RenderRequest, 'clips' | 'tracks' | 'assets' | 'timeline' | 'project' | 'settings'>;
/** The Depth clips this render shows: on a visible video track, reaching into the range (with their transitions).
 *  One on a hidden track or outside the range is left alone; there Depth draws nothing and has no sound. */
export const depthClips = (request: Shown) => shownClips(request, clip => !!depthEffect(clip));
/** Every depth run this render reads, its Depth clips' and its depth-keyed clips', inside compositions too, as depth.ready
 *  requests: an export waits for these before it joins the render queue. A clip whose span cannot be worked out is left
 *  for the render to report. */
export function depthRuns(request: Shown & Pick<RenderRequest, 'nodes' | 'wholeClips' | 'timelines'>) {
  return renderedTimelines(request).flatMap(part => shownClips(part, readsDepthClip(request.nodes)).flatMap(clip => {
    const source = request.assets.find(a => a.asset.id === clip.mediaId);
    try { return source && ['video', 'image'].includes(source.asset.kind) ? [depthRun(request, clip, source)] : []; } catch { return []; }
  }));
}
const readsDepthClip = (nodes: GradeNode[]) => (clip: Clip) => !!depthEffect(clip) || activeDepthKeys(clip, nodes).length > 0;
function shownClips(request: Shown, wanted: (clip: Clip) => boolean) {
  const own = request.clips.filter(c => c.timelineId === request.timeline.id && !c.disabled && wanted(c));
  if (!own.length) return own;
  const records = timelineTransitions(request.clips.filter(c => c.projectId === request.project.id), request.timeline.id, request.assets.map(a => a.asset)), { rangeIn, rangeOut } = exportRange(request);
  return own.filter(clip => {
    const track = request.tracks.find(t => t.id === clip.trackId), span = clipSpan(clip, records);
    return track?.kind === 'video' && !track.hidden && span.start < rangeOut - 1e-6 && span.end > rangeIn + 1e-6;
  });
}
/** The render's own timeline and every composition under it, each over the range it renders: a composition renders its
 *  whole timeline (renderCompositions), whatever range the parent shows. */
function renderedTimelines<T extends Shown & Pick<RenderRequest, 'timelines'>>(request: T, seen = new Set<string>()): T[] {
  seen.add(request.timeline.id);
  return [request, ...request.clips.flatMap(parent => {
    if (parent.timelineId !== request.timeline.id || parent.mediaId !== 'frameline-composition' || parent.disabled) return [];
    const timeline = request.timelines?.find(t => t.id === parent.properties.compositionId && t.projectId === request.project.id);
    return timeline && !seen.has(timeline.id) ? renderedTimelines({ ...request, timeline, settings: { ...request.settings, rangeIn: '0', rangeOut: String(timeline.duration) } }, seen) : [];
  })];
}
/** Whether rendering this request reads depth anywhere (a Depth bake or a depth key), compositions included. */
export const readsDepth = (request: Shown & Pick<RenderRequest, 'nodes' | 'timelines'>) => renderedTimelines(request).some(part => shownClips(part, readsDepthClip(request.nodes)).length > 0);
/**
 * Whether rendering these clips first bakes whole clips: a composition (its entire timeline, whatever the range), Noise
 * Reduction, Stabilize, optical flow, or keyframes (one FFmpeg run per frame, several at once). Each test is the one renderTimeline's dispatch
 * makes before it renders anything (composition, Stabilize, optical flow, then the per-frame animation bake that streamable
 * titles and shapes skip), and they look at every clip of the timeline. Hand over only the clips that can reach the range
 * and a composition elsewhere in the project no longer counts.
 */
export function bakesWholeClips(request: Pick<RenderRequest, 'clips' | 'timeline' | 'tracks' | 'settings'>): boolean {
  const own = request.clips.filter(c => c.timelineId === request.timeline.id && !c.disabled);
  return own.some(c => c.mediaId === 'frameline-composition' || denoisesPicture(request, c) || stabilizeEffect(c) || c.properties.opticalFlow)
    || animationWork(request).some(c => !streamableGraphic(c));
}
/** Refused by name before anything is decoded or baked. */
function rejectDepth(request: RenderRequest) {
  for (const clip of depthClips(request)) {
    if (clip.mediaId === 'frameline-composition' || clip.properties.compositionId || isTitle(clip) || isShape(clip) || isCaption(clip)) throw new Error(`${clip.name}: Depth works on video and image clips, not on compositions or titles. Remove Depth from this clip.`);
    if (clip.properties.opticalFlow) throw new Error(`${clip.name}: Depth and optical flow cannot share a clip yet. Disable optical flow or remove Depth.`);
    if (clip.effects.filter(e => depthOn(clip, e)).length > 1) throw new Error(`${clip.name}: a clip takes one Depth effect. Remove the extra one.`);
  }
}
/** The clip's grade properties a Depth bake renders once (statically) and takes off the replacement clip; a keyframe on one
 *  would be applied a second time over the bake, so it is refused, as keyframed grade nodes are. */
const BAKED_GRADE = ['colorPipeline', 'inputProfile', 'inputGamut', 'inputExposure', 'inputTemperature', 'resolveLookUrl', 'bypassResolveLook', 'yuvMatrix', 'dataLevels'];
const bakedKeyframe = (key: string) => key.startsWith('nodes.') || BAKED_GRADE.some(name => key === `properties.${name}`);
/** The bake (ProRes 4444, qscale 4) measured 0.4 MB a 4K frame on Sony footage and 1.1 MB on a test pattern on the Dell; the estimate leans high. */
const DEPTH_BAKE_BYTES_4K = 2.5e6;

/**
 * Bake each clip's Depth into source-time replacement media, then composite normally, the way Stabilize does. The bake
 * holds everything that comes before Depth: the grade (table or colour render), the effects above it in the stack and
 * Stabilize (baked first). The clip keeps what comes after, its timing edits, and plays the bake from a remapped sourceIn.
 */
async function renderDepthTimeline(request: RenderRequest) {
  const directory = await mkdtemp(path.join(tmpdir(), 'frameline-depth-export-')), releases: (() => void)[] = [];
  try {
    const clips = [...request.clips], assets = [...request.assets], tracks = [...request.tracks], maskArtifacts = new Map(request.maskArtifacts);
    let nodes = request.nodes;
    const fps = finite(request.settings.fps || request.project.fps, 'Frame rate', 1, 120);
    const records = timelineTransitions(clips.filter(c => c.projectId === request.project.id), request.timeline.id, assets.map(a => a.asset));
    const candidates = depthClips(request), { rangeIn, rangeOut } = exportRange(request);
    const python = process.env.FRAME_LINE_DEPTH_PYTHON || venvPython('.venv-mask'), script = fileURLToPath(new URL('../scripts/depth-fx.py', import.meta.url));
    for (const [index, whole] of candidates.entries()) {
      // Bake only what this render shows (a 4 s timeline preview, an In/Out export): the range, widened to the clip's
      // transitions that reach into it. The parts outside stay on the timeline as they were, unrendered, so the
      // neighbours keep their cuts and handles; neither side of the new cuts takes a transition.
      let lo = rangeIn, hi = rangeOut;
      for (const record of records) if ((record.outgoingId === whole.id || record.incomingId === whole.id) && record.start < hi && record.end > lo) { lo = Math.min(lo, record.start); hi = Math.max(hi, record.end); }
      const end = whole.start + whole.duration, from = lo - whole.start > 1 / 120 ? lo : whole.start, to = end - hi > 1 / 120 ? hi : end;
      const clip: Clip = from === whole.start && to === end ? whole : { ...clipPart(whole, from, to), transition: from === whole.start ? whole.transition : '' };
      if (to !== end) clip.properties = { ...clip.properties, transitionOut: '' };
      const outside = uncoveredParts(whole, from, to).filter(part => part !== whole).map((part, i) => ({ ...part, id: `${whole.id}-outside-${i}`, transition: part.start === whole.start ? whole.transition : '', properties: { ...part.properties, transitionOut: part.start === whole.start ? '' : whole.properties.transitionOut, audioDetached: true } }));
      const effect = depthEffect(clip)!, at = clip.effects.indexOf(effect), before = clip.effects.slice(0, at).filter(e => e.name !== 'Stabilize');
      const source = assets.find(a => a.asset.id === clip.mediaId), track = tracks.find(t => t.id === clip.trackId);
      if (!source || !['video', 'image'].includes(source.asset.kind) || !track) throw new Error(`${clip.name}: Depth needs a video or image source.`);
      if (!request.depth) throw new Error(`${clip.name}: depth analysis is not available on this server.`);
      if (!existsSync(python)) throw new Error('Depth export is not installed on this server. Run npm run setup:depth.');
      // The part before Depth renders in one static pass.
      if (Object.keys(clip.keyframes ?? {}).some(key => bakedKeyframe(key) || before.some(e => key.startsWith(`effects.${e.id}.`)))) throw new Error(`${clip.name}: keyframed grades or effects above Depth cannot be baked yet. Move the keyframed effect below Depth or remove its keyframes.`);
      const image = source.asset.kind === 'image', keyed = depthKeyed(clip, effect);
      if (image && keyed.length) throw new Error(`${clip.name}: Depth keyframes on a still image cannot be exported yet. Remove them.`);
      const metadata = await probeMedia(source.path, request.signal), width = metadata.width ?? 0, height = metadata.height ?? 0;
      if (width < 16 || height < 16 || width % 2 || height % 2 || width > 4096 || height > 4096) throw new Error(`${clip.name}: Depth export needs an even source size up to 4096 pixels; this source is ${width} × ${height}.`);
      const stabilized = request.stabilized?.get(clip.id), original = stabilized ?? request.denoised?.get(clip.id), offset = original?.offset ?? 0, originalAsset = original?.source.asset ?? source.asset;
      const sourceFps = image ? fps : source.asset.fps || metadata.fps;
      const handles = clipSpan(whole, records), span = { start: from === whole.start ? handles.start : from, end: to === end ? handles.end : to };
      const geo = extendClip(clip, Math.max(0, span.start), span.end - Math.max(0, span.start));
      const range = image ? { from: 0, to: 1 } : stabilizeRange(geo, sourceFps, source.asset.duration);
      const report = (fraction: number) => request.onProgress?.((index + Math.max(0, Math.min(1, fraction))) / candidates.length * 45);
      request.onStage?.(`Analyzing depth · ${clip.name}`);
      // The editor's run for the whole clip (of the original under a Stabilize bake), even when only part of it is baked.
      const { run: analysis, masters, release } = await request.depth.ready(depthRun(request, whole, original?.source ?? source), request.signal, p => { request.onStage?.(`Analyzing depth · ${clip.name} · ${Math.round(p)}%`); report(p / 100 * .3); });
      releases.push(release);
      // Bake frame k is the clip's media at `origin + k / fps`, which shows source frame `base + k` of the run.
      const times = analysis.times, step = 1 / (originalAsset.fps || sourceFps);
      if (!image && times.some((t, i) => i > 0 && Math.abs(t - times[i - 1] - step) > Math.max(3e-6, step * .001))) throw new Error(`${clip.name}: Depth export needs constant-frame-rate footage. Convert this source to constant frame rate first.`);
      let origin = 0, base = analysis.first, frames = 1;
      if (!image) {
        if (original) {
          // A Stabilize or Noise Reduction bake resamples to constant rate from `offset`: its frame k is the original frame
          // nearest to offset + k / fps (a tie goes to the earlier one), matrix k of a Stabilize solve.
          const first = Math.floor(range.from * sourceFps + 1e-6);
          origin = first / sourceFps; base = analysis.first + Math.max(0, times.findIndex(t => t >= offset - step / 2 - 1e-6)) + first;
          frames = Math.min(Math.round(source.asset.duration * sourceFps) - first, Math.ceil((range.to - origin) * sourceFps - 1e-6));
        } else {
          const first = smartMaskFrame(range.from, { fps: 1, duration: 0 }, times);
          origin = times[first]; base = analysis.first + first;
          frames = Math.ceil((range.to - origin) * sourceFps - 1e-6);
        }
        frames = Math.min(frames, analysis.first + analysis.frames - base);
      }
      const segments = analysis.segments.filter(segment => segment.first + segment.count > base && segment.first < base + frames).sort((a, b) => a.n - b.n);
      if (frames < 1 || !segments.length || segments[0].first > base) throw new Error(`${clip.name}: the depth analysis does not cover this clip. Export again.`);
      const output = path.join(directory, `${index}.${image ? 'png' : 'mov'}`), alpha = Boolean(source.asset.hasAlpha) || before.some(e => e.name === 'Smart Mask' && effectEnabled(clip, e) && e.amount > 0);
      // A matte above Depth sends the pre-depth pass through color-render.py first, which keeps a 16-bit RGBA FFV1 copy of the
      // whole bake in the temp folder until the bake ends: 8 bytes a pixel, about half that after FFV1.
      const matted = activeSmartMasks({ ...clip, effects: before }, nodes).length > 0 || activeDepthKeys(clip, nodes).length > 0;
      const need = frames * (DEPTH_BAKE_BYTES_4K / (3840 * 2160) + (matted ? 4 : 0)) * width * height + 512 * 1024 ** 2, disk = statfsSync(directory), free = disk.bavail * disk.bsize, floor = depthDiskFloor();
      if (free - need < floor) throw new Error(`${clip.name}: not enough disk space to bake Depth: about ${(need / 1024 ** 3).toFixed(1)} GB needed, ${(free / 1024 ** 3).toFixed(1)} GB free, and ${(floor / 1024 ** 3).toFixed(1)} GB is kept free.`);
      const keys = effectDefinitions.Depth.parameters.map(parameter => parameter.key);
      const params = Object.fromEntries(keys.map(key => [key, effectValue(clip, effect, key)]));
      let animated: Record<string, number[]> | undefined;
      if (keyed.length) {
        // Each bake frame takes the values of the first timeline frame that shows it (the nearest when none does).
        // Each bake frame takes the values of the first timeline frame showing it; frames none shows (handles, frames a
        // fast speed skips) keep the previous one's.
        const shown = new Array<number>(frames).fill(-1);
        flowFrames(geo, fps, sourceFps, source.asset.duration).forEach(({ time }, j) => { const k = Math.floor((time - origin) * sourceFps + 1e-6); if (k >= 0 && k < frames && shown[k] < 0) shown[k] = j; });
        let last = shown.find(j => j >= 0) ?? 0;
        for (let k = 0; k < frames; k++) if (shown[k] < 0) shown[k] = last; else last = shown[k];
        const prefix = `effects.${effect.id}.`, animatedKeys = keys.filter(key => keyed.includes(`${prefix}parameters.${key}`) || key === 'amount' && (keyed.includes(`${prefix}amount`) || keyed.includes(`${prefix}enabled`)));
        animated = Object.fromEntries(animatedKeys.map(key => [key, [] as number[]]));
        for (const j of shown) {
          const evaluated = evaluateClip(geo, geo.start + j / fps), e = evaluated.effects.find(item => item.id === effect.id)!;
          for (const key of animatedKeys) animated[key].push(key === 'amount' && !effectEnabled(evaluated, e) ? 0 : effectValue(evaluated, e, key));
        }
      }
      // Section 7: the subject (Effect.maskId) keeps Lens blur off itself and, with Follow subject, sets Focus per frame. It
      // reads the same saved revision a masked export does (stale or unanalysed blocks the export), by source frame.
      let matte: { files: (string | null)[] } | undefined;
      const lensOn = effectValue(clip, effect, 'blur') > 0 || keyed.includes(`effects.${effect.id}.parameters.blur`);
      if (lensOn && effect.maskId) {
        const doc = clip.smartMasks?.find(mask => mask.id === effect.maskId);
        if (!doc) throw new Error(`${clip.name}: the Depth subject is missing. Choose another Subject or None.`);
        if (!request.smartMaskDir) throw new Error(`${clip.name}: Smart Mask storage is unavailable.`);
        let subject: { directory: string; manifest: SmartMaskManifest };
        try { subject = resolveSmartMaskArtifact(request.smartMaskDir, original?.clip ?? clip, doc, original?.source.path ?? source.path, originalAsset); }
        catch (error) { throw new Error(`${clip.name} (Depth subject): ${(error as Error).message}`); }
        const files = new Map(subject.manifest.frames.map(frame => [frame.index, path.join(subject.directory, frame.file)])), sourceTimes = subject.manifest.sourceTimes ?? [];
        matte = { files: Array.from({ length: frames }, (_, k) => {
          const time = sourceTimes[base + k], file = files.get(base + k);
          if (file || time === undefined || time < doc.range.start - 1e-7 || time >= doc.range.end - 1e-7) return file ?? null; // Outside the mask's range: no subject there.
          throw new Error(`${clip.name}: the Depth subject “${doc.name}” is not analyzed at ${time.toFixed(2)} s of the source. Analyze the mask over the whole clip, or set Subject to None.`);
        }) };
        const following = animated?.followSubject ?? [];
        if (params.followSubject >= .5 || following.some(value => value >= .5)) {
          request.onStage?.(`Measuring subject focus · ${clip.name}`);
          // Cancelling stops waiting at once; the measurement goes on and is kept for the editor, which wants it too.
          const measuring = request.depth.focus(clip.projectId, analysis.key, subject);
          measuring.catch(() => {});
          const track = await new Promise<Awaited<typeof measuring>>((resolve, reject) => {
            const stop = () => reject(new Error('Canceled by you'));
            if (request.signal?.aborted) return stop();
            request.signal?.addEventListener('abort', stop, { once: true });
            measuring.then(resolve, reject).finally(() => request.signal?.removeEventListener('abort', stop));
          });
          // A subject never found in its mask leaves Focus as set, as the preview does.
          if (track.values.length) animated = { ...animated, focus: Array.from({ length: frames }, (_, k) => (following[k] ?? params.followSubject) >= .5 ? depthFocusAt(track, base + k)! : animated?.focus?.[k] ?? params.focus) };
        }
      }
      const warps = stabilized && Array.from({ length: frames }, (_, k) => {
        const m = stabilizeMatrixAt(stabilized.solve, offset + origin + k / sourceFps), sx = width / stabilized.solve.width, sy = height / stabilized.solve.height;
        return [m[0], m[1] * sx / sy, m[2] * sx, m[3] * sy / sx, m[4], m[5] * sy];
      });
      const duration = frames / sourceFps, job = path.join(directory, `${index}.json`);
      const neutral = { speed: 100, reverse: false, freeze: false, zoom: 100, scaleX: 100, scaleY: 100, x: 0, y: 0, anchorX: 0, anchorY: 0, rotation: 0, opacity: 100, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, fadeIn: 0, fadeOut: 0, flipH: false, blendMode: 'Normal', transitionOut: '' };
      // Half a frame early: the decoder keeps the first frame at or after the seek, so float noise cannot skip `origin`.
      const alone: Clip = { ...clip, start: 0, duration, sourceIn: image ? clip.sourceIn : Math.max(0, origin - .5 / sourceFps), transition: '', effects: before, keyframes: {}, properties: { ...clip.properties, ...neutral } };
      request.onStage?.(`Baking depth · ${clip.name}`);
      await renderTimeline({ ...request, clips: [alone], tracks: [{ ...track, kind: 'video', hidden: false, muted: true, solo: false }], assets, nodes, maskArtifacts, transformSamples: undefined, transparent: false, sampledFrame: false, pass: 'video', threads: undefined,
        project: { ...request.project, resolution: `${width} × ${height}`, fps: sourceFps }, timeline: { ...request.timeline, duration },
        settings: { ...request.settings, resolution: `${width} × ${height}`, fps: String(sourceFps), rangeIn: '0', rangeOut: String(duration), codec: 'Apple ProRes 4444', audio: 'Disabled' },
        outputPath: output, onProgress: undefined,
        decoder: async command => {
          await writeFile(job, JSON.stringify({ ffmpeg: ffmpeg(), decoder: command, width, height, frames, fps: image ? String(fps) : metadata.frameRate || String(sourceFps), output, image, alpha, threads: Number(exportThreads), taps: Number(process.env.FRAME_LINE_DEPTH_TAPS) || 96, params, animated, warps, matte, layer: dimensions(request.project.resolution),
            depth: { masters: segments.map(segment => path.join(masters, `${segment.n}.mkv`)), width: analysis.width, height: analysis.height, near: analysis.near, far: analysis.far, indices: Array.from({ length: frames }, (_, k) => base + k - segments[0].first) } }));
          // ponytail: waits here, inside the render queue, while another project's depth run holds the GPU; take the GPU in
          // awaitDepth (server/index.ts) before joining the queue if long foreign runs start blocking exports.
          await gpuJob(() => { request.depth?.freeGpu?.(); return run(python, [script, job], { signal: request.signal, jsonProgress: 'stderr', onProgress: p => { request.onStage?.(`Baking depth · ${clip.name} · ${Math.floor(p)}%`); report(.3 + p / 100 * .7); } }); }, request.signal);
        } });
      const mediaId = `depth-${clip.id}`, dropped = clip.effects.slice(0, at + 1).map(e => e.id);
      assets.push({ path: output, asset: { ...source.asset, id: mediaId, kind: image ? 'image' : 'video', duration: image ? source.asset.duration : duration, fps: image ? 0 : sourceFps, resolution: `${width} × ${height}`, hasAudio: false, hasAlpha: alpha, colorRange: 'tv', colorMatrix: 'bt709', colorTransfer: undefined, inputProfile: 'Rec.709', inputGamut: 'Rec.709' } });
      // The grade is in the bake now: no nodes, look, camera interpretation or YUV hints for the replacement.
      const replacement: Clip = { ...clip, mediaId, sourceIn: image ? clip.sourceIn : clip.sourceIn - origin, effects: clip.effects.slice(at + 1),
        keyframes: Object.fromEntries(Object.entries(clip.keyframes ?? {}).filter(([key]) => !bakedKeyframe(key) && !dropped.some(id => key.startsWith(`effects.${id}.`)))),
        properties: { ...Object.fromEntries(Object.entries(clip.properties).filter(([key]) => !BAKED_GRADE.includes(key))), audioDetached: true } };
      clips[clips.indexOf(whole)] = replacement;
      clips.push(...outside);
      nodes = nodes.filter(node => node.clipId !== clip.id);
      // Mattes below Depth now read the bake, whose clock starts `origin` later than the media it replaced.
      for (const document of activeSmartMasks(replacement, [])) {
        if (!request.smartMaskDir) break;
        const key = `${clip.id}:${document.id}`, artifact: { directory: string; manifest: SmartMaskManifest; offset?: number } = maskArtifacts.get(key) ?? resolveSmartMaskArtifact(request.smartMaskDir, whole, document, source.path, source.asset);
        maskArtifacts.set(key, { ...artifact, offset: (artifact.offset ?? 0) + origin });
      }
      const explicitAudio = request.clips.some(other => other.id !== whole.id && tracks.find(t => t.id === other.trackId)?.kind === 'audio' && other.mediaId === whole.mediaId && other.start === whole.start && other.sourceIn === whole.sourceIn && other.duration === whole.duration);
      if (source.asset.hasAudio && !whole.properties.audioDetached && !explicitAudio && request.settings.audio !== 'Disabled') {
        const audioId = `depth-audio-${whole.id}`;
        tracks.push({ ...track, id: audioId, kind: 'audio' });
        // The original, whole clip carries the sound; the bake is picture only.
        clips.push({ ...whole, id: audioId, trackId: audioId, transition: '', properties: { ...whole.properties, transitionOut: '', audioDetached: false }, keyframes: Object.fromEntries(Object.entries(whole.keyframes ?? {}).filter(([key]) => timingPaths.includes(key) || /^properties\.(gain|pan|audioFadeIn|audioFadeOut)$/.test(key) || key.startsWith('effects.'))), effects: whole.effects.filter(e => audioEffectNames.includes(e.name)) });
      }
    }
    await renderTimeline({ ...request, clips, assets, tracks, nodes, maskArtifacts, onProgress: p => request.onProgress?.(45 + p * .55) });
  } finally {
    for (const release of releases) release();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Bakes a running export still reads: a preview renders flow alongside an export and trims the same directory.
const bakesInUse=new Map<string,number>();

/** Whether none of the clip (with its transition handles) reaches into the export range. Such a clip is never drawn,
 *  so baking it is wasted: a 2.7 s Stabilize clip at 462 s cost the 0-115 s Girls Soccer export a minute. */
function outsideRange(request: RenderRequest, clip: Clip, records: TransitionRecord[]) {
  const { rangeIn, rangeOut } = exportRange(request), span = clipSpan(clip, records);
  return span.start >= rangeOut - 1e-6 || span.end <= rangeIn + 1e-6;
}

/** The most pixels the clip's picture covers in this export: the output frame at the clip's largest zoom. A bake
 *  needs no more than this (a 4K source in a 1080p export at 150 % needs 2880 wide, not the 4K project canvas).
 *  A stretch counts its larger axis on both, so the box keeps the project's shape (compositions render at it). */
function pictureBox(request: RenderRequest, clip: Clip): [number, number] {
  const [width, height] = dimensions(request.settings.resolution || request.project.resolution);
  const most = (key: string) => Math.max(100, ...[clip.properties[key] ?? 100, ...(clip.keyframes?.[`properties.${key}`] ?? []).map(k => k.value)].map(Number).filter(Number.isFinite)) / 100;
  const zoom = most('zoom') * Math.max(most('scaleX'), most('scaleY'));
  return [Math.ceil(width * zoom / 2) * 2, Math.ceil(height * zoom / 2) * 2];
}

/** Bake optical flow before compositing; all subsequent frame reads use the same retimed footage. */
async function renderFlowTimeline(request: RenderRequest) {
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-flow-export-')),claimed:string[]=[];
  try {
    const clips=[...request.clips],assets=[...request.assets],tracks=[...request.tracks];
    const fps=finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
    const records=timelineTransitions(clips.filter(c=>c.projectId===request.project.id),request.timeline.id,assets.map(a=>a.asset));
    const flowing=clips.filter(c=>c.timelineId===request.timeline.id&&!c.disabled&&c.properties.opticalFlow);
    for(const clip of flowing.filter(c=>outsideRange(request,c,records)))clips[clips.indexOf(clip)]={...clip,properties:{...clip.properties,opticalFlow:false}};
    const candidates=flowing.filter(c=>!outsideRange(request,c,records));
    // Bakes are keyed by everything that shapes them (flowIdentity), so a re-export reuses the last one instead of
    // interpolating the same seconds again: every Newspaper attempt spent 165 s re-baking one 4.6 s ramp.
    const bakes=await processDirectory('frameline-flow-bakes-');
    for(const [index,clip] of candidates.entries()) {
      if(activeSmartMasks(clip,request.nodes).length)throw Error('Smart Mask and optical-flow retiming need a shared warped matte. Disable optical flow for this clip.');
      if(activeDepthKeys(clip,request.nodes).length)throw Error(`${clip.name}: a depth key cannot follow optical-flow retiming yet. Disable optical flow for this clip.`);
      const source=assets.find(a=>a.asset.id===clip.mediaId),track=tracks.find(t=>t.id===clip.trackId);
      if(!source||source.asset.kind!=='video'||!track)throw new Error(`${clip.name}: optical flow requires a video source.`);
      const span=clipSpan(clip,records),geo=extendClip(clip,Math.max(0,span.start),span.end-Math.max(0,span.start));
      request.onStage?.(`Optical flow · ${clip.name}`);
      const baked=await renderOpticalFlow({clip:geo,asset:source.asset,input:source.path,directory:bakes,fps,fit:pictureBox(request,clip),threads:Number(exportThreads),signal:request.signal,onProgress:p=>request.onProgress?.((index+p/100)/candidates.length*45)});
      claimed.push(baked.key);bakesInUse.set(baked.key,(bakesInUse.get(baked.key)??0)+1);
      const mediaId=`flow-${clip.id}`,metadata=await probeMedia(baked.output,request.signal);
      assets.push({path:baked.output,asset:{...source.asset,id:mediaId,duration:geo.duration,fps,hasAudio:false,colorRange:metadata.colorRange,colorMatrix:metadata.colorMatrix}});
      clips[clips.indexOf(clip)]={...clip,mediaId,sourceIn:clip.start-geo.start,keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>!timingPaths.includes(path))),properties:{...clip.properties,opticalFlow:false,speed:100,reverse:false,freeze:false,audioDetached:true}};
      const explicitAudio=request.clips.some(other=>other.id!==clip.id&&tracks.find(t=>t.id===other.trackId)?.kind==='audio'&&other.mediaId===clip.mediaId&&other.start===clip.start&&other.sourceIn===clip.sourceIn&&other.duration===clip.duration);
      if(source.asset.hasAudio&&!clip.properties.audioDetached&&!explicitAudio&&request.settings.audio!=='Disabled') {
        const audioId=`flow-audio-${clip.id}`;
        tracks.push({...track,id:audioId,kind:'audio'});
        // Retain the established audio renderer, including its pitch preservation and automation.
        clips.push({...clip,id:audioId,trackId:audioId,transition:'',properties:{...clip.properties,opticalFlow:false,transitionOut:'',audioDetached:false},keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>timingPaths.includes(path)||/^properties\.(gain|pan|audioFadeIn|audioFadeOut)$/.test(path)||path.startsWith('effects.'))),effects:clip.effects.filter(e=>audioEffectNames.includes(e.name))});
      }
    }
    await trimFlowCache(bakes,new Set(bakesInUse.keys()),8*1024**3,'mov');
        const pictures=clips.filter(c=>tracks.find(t=>t.id===c.trackId)?.kind==='video');
    const animated=animationWork({...request,clips,tracks});
    if(!records.length&&animated.length&&!animated.some(c=>pictures.includes(c))&&request.settings.audio!=='Disabled') {
      // Speed-only picture is already baked. Audio automation must not force full-resolution picture through one render per frame.
      const video=path.join(directory,request.settings.codec?.includes('ProRes')?'picture.mov':'picture.mp4'),sound=path.join(directory,'sound.mov');
      await renderTimeline({...request,clips:pictures,assets,tracks,outputPath:video,settings:{...request.settings,audio:'Disabled'},onProgress:p=>request.onProgress?.(45+p*.15)});
      await renderAnimatedTimeline({...request,clips,assets,tracks:tracks.map(t=>({...t,hidden:true})),project:{...request.project,resolution:'16 × 16'},outputPath:sound,settings:{...request.settings,resolution:'16 × 16',codec:'Apple ProRes 4444'},onProgress:p=>request.onProgress?.(60+p*.35)});
      await run(ffmpeg(),[...common,'-i',video,'-i',sound,'-map','0:v:0','-map','1:a:0?','-c','copy','-movflags','+faststart',request.outputPath],{signal:request.signal});
      request.onProgress?.(100);
    } else await renderTimeline({...request,clips,assets,tracks,onProgress:p=>request.onProgress?.(45+p*.55)});
  } finally {
    for(const key of claimed){const left=(bakesInUse.get(key)??1)-1;if(left>0)bakesInUse.set(key,left);else bakesInUse.delete(key);}
    await rm(directory,{recursive:true,force:true});
  }
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
/**
 * Source span and atempo schedule for a clip's retimed sound. Sampled every 50 ms of timeline
 * time; each command fires at the source time where that stretch begins. Null when the clip
 * plays backwards at any point (the schedule must move forward through the source).
 */
export function retimeSchedule(clip: Clip, step = .05) {
  const offsets: number[] = [];
  for (let t = 0; t < clip.duration + step - 1e-9; t += step) offsets.push(animatedSourceOffset(clip, Math.min(t, clip.duration)));
  const commands: [number, number][] = [];
  for (let i = 1; i < offsets.length; i++) {
    const dt = Math.min(i * step, clip.duration) - (i - 1) * step, ds = offsets[i] - offsets[i - 1];
    if (ds < -1e-6) return null;
    const tempo = Math.min(8, Math.max(.01, ds / dt));
    if (!commands.length || Math.abs(tempo / commands.at(-1)![1] - 1) > 1e-3) commands.push([offsets[i - 1] - offsets[0], tempo]);
  }
  return { from: offsets[0], to: offsets.at(-1)!, commands };
}

/**
 * A speed ramp baked one frame at a time runs atempo over 1/fps of audio per frame, which comes
 * out as chopped, clicking sound. Bake each retimed clip's sound once, continuously, and hand the
 * renderer a plain 100% audio clip in its place; gain, pan, fades and audio effects still apply there.
 */
async function bakeRetimedAudio(request: RenderRequest, directory: string): Promise<RenderRequest> {
  if (request.settings.audio === 'Disabled') return request;
  const clips = [...request.clips], assets = [...request.assets], tracks = [...request.tracks];
  for (const clip of request.clips) {
    if (clip.timelineId !== request.timeline.id || clip.disabled) continue;
    const p = clip.properties, track = tracks.find(t => t.id === clip.trackId), source = assets.find(a => a.asset.id === clip.mediaId);
    const ramped = Object.keys(clip.keyframes ?? {}).some(key => timingPaths.includes(key));
    if (!track || !source?.asset.hasAudio || track.muted || (!ramped && (Number(p.speed ?? 100) === 100 || p.reverse || p.freeze))) continue;
    if (track.kind === 'video' && (p.audioDetached || clips.some(o => o.id !== clip.id && tracks.find(t => t.id === o.trackId)?.kind === 'audio' && o.mediaId === clip.mediaId && o.start === clip.start && o.sourceIn === clip.sourceIn && o.duration === clip.duration))) continue;
    const schedule = retimeSchedule(clip);
    if (!schedule) continue;
    // Chain enough atempo stages that every stage stays at or above its 0.5 floor.
    const lowest = Math.min(...schedule.commands.map(c => c[1])), stages = Math.max(1, Math.ceil(Math.log(lowest) / Math.log(.5)));
    const names = Array.from({ length: stages }, (_, n) => `atempo@r${n}`);
    const cmd = schedule.commands.map(([at, tempo]) => `${at.toFixed(4)} ${names.map(name => `${name} tempo ${Math.pow(tempo, 1 / stages).toFixed(6)}`).join(',')}`).join(';');
    const first = Math.pow(schedule.commands[0]?.[1] ?? 1, 1 / stages).toFixed(6);
    const output = path.join(directory, `retimed-${clips.indexOf(clip)}.wav`);
    // A long ramp schedules hundreds of tempo commands; the graph goes through a file like every export graph.
    await run(ffmpeg(), [...common, '-ss', (clip.sourceIn + schedule.from).toFixed(6), '-t', (schedule.to - schedule.from + .5).toFixed(6), ...safeInput, '-i', source.path,
      ...await graphArgs(`[0:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,asendcmd=c='${cmd}',${names.map(name => `${name}=${first}`).join(',')},apad,atrim=duration=${clip.duration.toFixed(6)}[a]`, `${output}.graph`),
      '-map', '[a]', '-c:a', 'pcm_f32le', output], { signal: request.signal });
    const mediaId = `retimed-${clip.id}`;
    assets.push({ path: output, asset: { ...source.asset, id: mediaId, kind: 'audio', duration: clip.duration, hasAudio: true } });
    const sound: Clip = { ...clip, mediaId, sourceIn: 0, transition: '', keyframes: Object.fromEntries(Object.entries(clip.keyframes ?? {}).filter(([key]) => !timingPaths.includes(key))), properties: { ...p, speed: 100, reverse: false, freeze: false, transitionOut: '', audioDetached: false } };
    if (track.kind === 'audio') clips[clips.indexOf(clip)] = sound;
    else {
      // The picture keeps its ramp; its embedded sound moves to a track of its own.
      const trackId = `retimed-track-${clip.id}`;
      tracks.push({ ...track, id: trackId, kind: 'audio', hidden: false });
      clips[clips.indexOf(clip)] = { ...clip, properties: { ...p, audioDetached: true } };
      clips.push({ ...sound, id: mediaId, trackId, effects: clip.effects.filter(e => audioEffectNames.includes(e.name)) });
    }
  }
  return { ...request, clips, assets, tracks };
}

/**
 * A per-frame bake chops sound into 1/fps pieces, which clicks and breaks fades, ducking and EQ. So the
 * picture is baked silent and the sound is rendered once, statically, then the two are muxed.
 */
async function renderAnimatedSplit(request: RenderRequest) {
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-animation-split-'));
  try {
    const isProRes=request.settings.codec?.includes('ProRes'),picture=path.join(directory,isProRes?'picture.mov':'picture.mp4'),sound=path.join(directory,'sound.mov');
    await renderAnimatedTimeline({...request,outputPath:picture,settings:{...request.settings,audio:'Disabled'},onProgress:p=>request.onProgress?.(p*.85)});
    const own=(c:Clip)=>c.timelineId===request.timeline.id;
    // Graphics carry no sound; captions would route the audio pass into the caption renderer.
    const audible=await bakeRetimedAudio({...request,clips:request.clips.filter(c=>!(own(c)&&(isTitle(c)||isShape(c))))},directory);
    // Only sound keys survive. Gain renders statically; keyed pan or audio fades still take the per-frame sound path
    // (the sound pass hides every picture track, so it cannot split again).
    // ponytail: pan/afade as expressions would keep those static too; add when a reel needs them.
    const soundKeys=['properties.gain','properties.pan','properties.audioFadeIn','properties.audioFadeOut'];
    const clips=audible.clips.map(c=>{if(!own(c)||!c.keyframes)return c;const kept=Object.fromEntries(Object.entries(c.keyframes).filter(([key])=>soundKeys.includes(key)));return {...c,keyframes:Object.keys(kept).length?kept:undefined};});
    await renderTimeline({...audible,clips,tracks:audible.tracks.map(t=>t.kind==='video'?{...t,hidden:true}:t),project:{...request.project,resolution:'16 × 16'},outputPath:sound,
      settings:{...request.settings,resolution:'16 × 16',codec:'Apple ProRes 4444'},onStage:undefined,onProgress:p=>request.onProgress?.(85+p*.13)});
    await mkdir(path.dirname(request.outputPath),{recursive:true});
    await run(ffmpeg(),[...common,'-i',picture,'-i',sound,'-map','0:v:0','-map','1:a:0','-c','copy',...(request.settings.codec?.startsWith('H.265')?['-tag:v','hvc1']:[]),'-movflags','+faststart',request.outputPath],{signal:request.signal});
    request.onProgress?.(100);
  } finally {await rm(directory,{recursive:true,force:true});}
}

async function renderAnimatedTimeline(request: RenderRequest) {
  // A sound-only pass (every picture track hidden, as the optical-flow path does) has no picture to protect.
  if(request.settings.audio!=='Disabled'&&!request.sampledFrame&&request.tracks.some(t=>t.kind==='video'&&!t.hidden))return renderAnimatedSplit(request);
  const fps=finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
  const start=finite(request.settings.rangeIn??0,'Range in',0,request.timeline.duration);
  const end=finite(request.settings.rangeOut??request.timeline.duration,'Range out',start+1/fps-1e-8,request.timeline.duration);
  for(const clip of request.clips)if(clip.keyframes)validateKeyframes(clip.keyframes);
  const directory=await mkdtemp(path.join(tmpdir(),'frameline-animation-'));
  request=await bakeRetimedAudio(request,directory).catch(async error=>{await rm(directory,{recursive:true,force:true});throw error;});
  const count=Math.ceil((end-start)*fps-1e-7);
  // Only the frames an animated clip actually covers are worth one render each. Everything else is
  // spliced back as ordinary clips and composited in a single pass, the way transition windows
  // already are: one keyframe must not cost a 30-minute edit a render per frame.
  const windows=animatedWindows(animationWork(request),request.timeline.id,fps,start,count);
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
    const [projectWidth,projectHeight]=dimensions(request.project.resolution);
    // A one-frame run is mostly process start and the source's GOP pre-roll, not pixels, so several run side by
    // side on a few threads each (a 4K 4:2:2 decoder at 4 threads holds ~0.3 GB instead of ~1 GB).
    const frameJobs=Math.max(1,Math.min(8,Math.floor(cores/6)));
    for(const [index,window] of windows.entries()) {
      // ponytail: per-frame baking reuses all static effects; stream frames into one encoder (as captions do) if windows get long.
      const frames=Array.from({length:window.to-window.from},(_,i)=>window.from+i);
      const files=frames.map(frame=>path.join(directory,`${index}-${frame}.mov`));
      await inParallel(frames,frameJobs,request.signal,async(frame,position,signal)=>{
        const time=start+frame/fps, duration=1/fps;
        const active=request.clips.filter(c=>c.timelineId===request.timeline.id&&c.start<=time+1e-8&&c.start+c.duration>time+1e-8);
        let nodes=request.nodes;
        const transformSamples:Record<string,MotionPose[]>={},soundTracks:Track[]=[];
        const frameClips=active.flatMap(original=>{
          nodes=evaluateNodes(nodes,original,time);
          const clip=evaluateClip(original,time,fps),elapsed=time-original.start,rate=Number(clip.properties.speed??100)/100;
          transformSamples[clip.id]=transformMotion(clip,time,request.project.fps,projectWidth,projectHeight);
          const offset=animatedSourceOffset(original,elapsed,fps)-(clip.properties.reverse?Math.max(0,rate-1)/fps:0);
          const volume=fadeLevel(clip,time,true);
          const frame:Clip={...clip,keyframes:undefined,transition:'',start:0,duration,sourceIn:Math.max(0,original.sourceIn+offset),properties:{...clip.properties,transitionOut:'',opacity:Number(clip.properties.opacity??100)*fadeLevel(clip,time),gain:volume>0?Math.max(-60,Number(clip.properties.gain??0)+20*Math.log10(volume)):-60,fadeIn:0,fadeOut:0,audioFadeIn:0,audioFadeOut:0,fadeOrigin:0,fadeDuration:duration}};
          // A one-frame render shows the first source frame after its seek; the whole-timeline pass shows the one its
          // fps rule picks (`shownSourceTime`). Where they differ, seek to the latter, so an animated window shows the
          // same frames the plain export would and a motion track keyed to those frames lines up. Sound stays put.
          const track=request.tracks.find(t=>t.id===original.trackId),asset=request.assets.find(a=>a.asset.id===original.mediaId)?.asset;
          const sourceFps=asset?.kind==='video'&&track?.kind==='video'&&!clip.properties.opticalFlow?asset.fps:0;
          const pick=sourceFps?Math.ceil(shownSourceTime(original,time,frame.sourceIn,fps,sourceFps)*sourceFps-1e-9)-1:-1;
          if(!track||!sourceFps||pick<0||pick===Math.ceil(frame.sourceIn*sourceFps-1e-6))return [frame];
          // Just before the frame, but never so far that a slow clip's one-frame window ends before reaching it.
          const picture:Clip={...frame,sourceIn:Math.max(0,pick/sourceFps-Math.min(.25/sourceFps,.25*Math.max(.01,rate)/fps)),properties:{...frame.properties,audioDetached:true}};
          const twin=active.some(o=>o.id!==original.id&&request.tracks.find(t=>t.id===o.trackId)?.kind==='audio'&&o.mediaId===original.mediaId&&o.start===original.start&&o.sourceIn===original.sourceIn&&o.duration===original.duration);
          if(!asset?.hasAudio||clip.properties.audioDetached||twin||request.settings.audio==='Disabled')return [picture];
          const soundId=`frame-sound-${original.id}`;
          soundTracks.push({...track,id:soundId,kind:'audio',hidden:false});
          return [picture,{...frame,id:soundId,trackId:soundId,properties:{...frame.properties,audioDetached:false},effects:frame.effects.filter(e=>audioEffectNames.includes(e.name))}];
        });
        await renderTimeline({...request,signal,threads:4,onStage:undefined,sampledFrame:true,transformSamples,clips:frameClips,tracks:[...request.tracks,...soundTracks],nodes,timeline:{...request.timeline,duration},outputPath:files[position],onProgress:undefined,settings:{...request.settings,rangeIn:'0',rangeOut:String(duration),codec:'Apple ProRes 4444',audio:request.settings.audio==='Disabled'?'Disabled':'Linear PCM · 24-bit · 48 kHz',masterGain:'0',masterMuted:'false'}});
        request.onProgress?.(++rendered/total*90);
        request.onStage?.(`Rendering animation · frame ${rendered}/${total}`);
      });
      const list=path.join(directory,`${index}.txt`),baked=path.join(directory,`${index}.mov`);await writeFile(list,files.map(file=>`file '${file}'`).join('\n'));
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
    clips=clips.filter(clip=>!(clip.timelineId===request.timeline.id&&perFrame(clip,request)));
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
    const records=timelineTransitions(clips.filter(c=>c.projectId===request.project.id),request.timeline.id,assets.map(a=>a.asset));
    const nested=clips.filter(c=>c.timelineId===request.timeline.id&&c.mediaId==='frameline-composition'&&!c.disabled);
    // A composition outside the range is never drawn; it is switched off rather than rendered.
    for(const parent of nested.filter(c=>outsideRange(request,c,records)))clips[clips.indexOf(parent)]={...parent,disabled:true};
    const parents=nested.filter(c=>!outsideRange(request,c,records)),fps=finite(request.settings.fps||request.project.fps,'Frame rate',1,120);
    for(const [index,parent] of parents.entries()) {
      if(request.signal?.aborted)throw new Error('Canceled by you');
      const timeline=request.timelines?.find(t=>t.id===parent.properties.compositionId&&t.projectId===request.project.id);
      if(!timeline)throw new Error(`${parent.name}: composition timeline is missing.`);
      const outputPath=path.join(directory,`${index}.mov`),mediaId=`composition-render-${parent.id}`;
      // Only the stretch of the nested timeline the parent reads (speed, reverse, freeze and transition handles
      // included), at the size the parent covers in this export. Girls Soccer showed 2.2 s of a 135.6 s composition
      // and spent 15 of its 78 minutes rendering all of it in 4K ProRes 4444.
      const span=clipSpan(parent,records),geo=extendClip(parent,Math.max(0,span.start),span.end-Math.max(0,span.start));
      const read=stabilizeRange(geo,fps,timeline.duration),[width,height]=pictureBox(request,parent);
      request.onStage?.(`Rendering composition ${index+1}/${parents.length} · ${parent.name}`);
      await renderTimeline({...request,timeline,onStage:undefined,compositionPath:[...ancestry,request.timeline.id],transparent:true,sampledFrame:false,outputPath,onProgress:p=>request.onProgress?.((index+p/100)/parents.length*50),settings:{...request.settings,resolution:`${width} × ${height}`,rangeIn:String(read.from),rangeOut:String(read.to),codec:'Apple ProRes 4444',audio:request.settings.audio==='Disabled'?'Disabled':'Linear PCM · 24-bit · 48 kHz',masterGain:'0',masterMuted:'false'}});
      clips[clips.indexOf(parent)]={...parent,mediaId,sourceIn:parent.sourceIn-read.from};
      assets.push({path:outputPath,asset:{id:mediaId,projectId:request.project.id,name:parent.name,kind:'video',duration:read.to-read.from,binId:'',thumbnail:'',fps,resolution:`${width} × ${height}`,size:'',status:'ready',progress:100,hasAudio:request.settings.audio!=='Disabled',inputProfile:'Rec.709'}});
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
