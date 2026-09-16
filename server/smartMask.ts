import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { smartMaskFrame, smartMaskSignature, validateSmartMask } from '../src/services/smartMask.ts';
import type { SmartMaskDocument, SmartMaskManifest } from '../src/services/smartMask.ts';
import type { Clip, MediaAsset } from '../src/state/models.ts';
import { colorTransform, cubeText, interpretation, makeCube } from '../src/services/color.ts';

const worker = fileURLToPath(new URL('../scripts/smart-mask.py', import.meta.url));
const python = () => process.env.FRAME_LINE_MASK_PYTHON || fileURLToPath(new URL('../.venv-mask/bin/python', import.meta.url));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
export class SmartMaskError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const fail = (status: number, message: string): never => { throw new SmartMaskError(status, message); };
type Direction = 'forward' | 'backward' | 'both';
type Job = { key: string; signature: string; projectId: string; clipId: string; maskId: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'; progress: number; error?: string; manifestUrl?: string };
type Manifest = SmartMaskManifest;
type Binding = { projectId: string; clipId: string; maskId: string; signature: string; sourceFingerprint: string; analysisIdentity: string; workerIdentity: string; direction?: Direction; anchorTime?: number };

// Kill the process group: model jobs may have their own FFmpeg decoder children.
export function runMaskProcess(command: string, args: string[], signal?: AbortSignal, progress?: (value: number) => void): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error('Smart Mask cancelled.'));
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let output = '', errors = '', pending = '', failure: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Process already exited. */ } };
    const abort = () => { failure = new Error('Smart Mask cancelled.'); kill('SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 2000); timer.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { output += data; pending += data; if (output.length > 4 * 1024 ** 2) { failure = new Error('Smart Mask worker output exceeds limit.'); kill('SIGKILL'); } const lines = pending.split('\n'); pending = lines.pop() || ''; for (const line of lines) { try { const value = JSON.parse(line).progress; if (Number.isFinite(value)) progress?.(Math.max(0, Math.min(99, value))); } catch { /* Worker diagnostics. */ } } });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.on('close', code => { if (!signal?.aborted) clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(errors.trim() || `Smart Mask worker exited ${code}.`)); else resolveOutput(output); });
  });
}

let capabilitiesRequest: ReturnType<typeof checkCapabilities> | undefined;
let capabilitiesExpiry = 0;
export function smartMaskCapabilities() {
  if (!capabilitiesRequest || Date.now() >= capabilitiesExpiry) { capabilitiesExpiry = Date.now() + 30_000; capabilitiesRequest = checkCapabilities(); }
  return capabilitiesRequest;
}
async function checkCapabilities() {
  if (!existsSync(python()) || !existsSync(worker)) return { available: false, preserveMotionBlur: false, finalQuality: false, reason: 'Smart Mask models are not installed on this server.' };
  try {
    const lines = (await runMaskProcess(python(), [worker, '--check'], AbortSignal.timeout(60_000))).trim().split('\n');
    const result = JSON.parse(lines.at(-1)!);
    return { ...result, available: result.available === true, preserveMotionBlur: result.preserveMotionBlur === true, finalQuality: result.finalQuality === true, reason: result.reason || result.error };
  } catch (error) { return { available: false, preserveMotionBlur: false, finalQuality: false, reason: (error as Error).message }; }
}

export function maskSourceFingerprint(sourcePath: string) {
  const file = statSync(sourcePath);
  if (!file.isFile()) fail(409, 'Original media is missing.');
  return hash([resolve(sourcePath), file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs]);
}
export function maskAnalysis(clip: Clip, asset: MediaAsset) {
  const input = interpretation(clip, asset);
  const properties = { inputProfile: input.profile, inputGamut: input.gamut };
  const text = cubeText(makeCube(colorTransform({ ...clip, properties, effects: [] }, asset, []), 33));
  return { text, identity: hash([text, clip.properties.dataLevels || 'auto', clip.properties.yuvMatrix || asset.colorMatrix || 'auto']) };
}
function inputMatrix(clip: Clip, asset: MediaAsset) {
  const value = String(clip.properties.yuvMatrix || asset.colorMatrix || 'auto');
  return value.startsWith('bt2020') ? 'bt2020' : ['bt470bg', 'smpte170m'].includes(value) ? 'bt601' : ['bt709', 'bt601'].includes(value) ? value : 'auto';
}
function json(path: string) { return JSON.parse(readFileSync(path, 'utf8')); }
function atomicJson(path: string, value: unknown) { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); }
function regularFile(path: string) { try { const file = lstatSync(path); return file.isFile() && file.size > 0; } catch { return false; } }
function alphaHeader(path: string, width: number, height: number) {
  const descriptor = openSync(path, 'r'), header = Buffer.alloc(26);
  try { readSync(descriptor, header, 0, header.length, 0); } finally { closeSync(descriptor); }
  return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && header.toString('ascii', 12, 16) === 'IHDR' && header.readUInt32BE(16) === width && header.readUInt32BE(20) === height && header[24] === 16 && header[25] === 0;
}

export function validateMaskManifest(manifest: Manifest, expected: { key: string; signature: string; mask: SmartMaskDocument; direction?: Direction; anchorTime?: number }, directory: string) {
  const { mask } = expected;
  if (manifest.version !== 1 || manifest.key !== expected.key || manifest.signature !== expected.signature || manifest.width !== mask.source.width || manifest.height !== mask.source.height || manifest.alpha !== 'gray16' || !Array.isArray(manifest.frames) || !manifest.frames.length || manifest.frames.length > 36_000) fail(409, 'Smart Mask worker returned an invalid manifest.');
  let previousFrame = -1, previousTime = -1;
  for (const entry of manifest.frames) {
    if (!Number.isSafeInteger(entry.index) || entry.index <= previousFrame || !Number.isFinite(entry.time) || entry.time <= previousTime || entry.time < mask.range.start - 1e-6 || entry.time >= mask.range.end + 1e-6 || entry.file !== `frames/${entry.index}.png` || !regularFile(join(directory, 'frames', `${entry.index}.png`)) || !regularFile(join(directory, 'source', `${entry.index}.jpg`))) fail(409, 'Smart Mask frames are incomplete or out of order.');
    if (!alphaHeader(join(directory, entry.file), manifest.width, manifest.height)) fail(409, 'Smart Mask alpha must be native-resolution 16-bit grayscale PNG.');
    previousFrame = entry.index; previousTime = entry.time;
  }
  if (manifest.frames.some((entry, index) => index > 0 && entry.index !== manifest.frames[index - 1].index + 1)) fail(409, 'Smart Mask frames have gaps.');
  if (!Array.isArray(manifest.sourceTimes) || !manifest.sourceTimes.length || manifest.sourceTimes.some((time, index) => !Number.isFinite(time) || time < 0 || index > 0 && time <= manifest.sourceTimes![index - 1])) fail(409, 'Smart Mask is missing valid source timestamps.');
  if (!manifest.range || !Number.isFinite(manifest.range.start) || !Number.isFinite(manifest.range.end) || manifest.range.start < mask.range.start - 1e-6 || manifest.range.end > mask.range.end + 1e-6 || manifest.range.end <= manifest.range.start) fail(409, 'Smart Mask returned an invalid analysis range.');
  const expectedFrames = manifest.sourceTimes!.map((time, index) => ({ time, index })).filter(entry => entry.time >= manifest.range.start - 1e-6 && entry.time < manifest.range.end - 1e-6);
  if (expectedFrames.length !== manifest.frames.length || expectedFrames.some((entry, index) => entry.index !== manifest.frames[index].index || Math.abs(entry.time - manifest.frames[index].time) > 1e-6)) fail(409, 'Smart Mask coverage does not match source timestamps.');
  if (expected.direction !== undefined && expected.anchorTime !== undefined) {
    const anchor = smartMaskFrame(expected.anchorTime, mask.source, manifest.sourceTimes);
    const requestedFrames = manifest.sourceTimes!.map((time, index) => ({ time, index })).filter(entry => entry.time >= mask.range.start - 1e-6 && entry.time < mask.range.end - 1e-6 && (expected.direction !== 'forward' || entry.index >= anchor) && (expected.direction !== 'backward' || entry.index <= anchor));
    if (requestedFrames.length !== manifest.frames.length || requestedFrames.some((entry, index) => entry.index !== manifest.frames[index].index)) fail(409, 'Smart Mask did not cover the requested direction and range.');
  }
}

// Completed assets are immutable and retained for undo/snapshots, including after cancellation.
export function resolveSmartMaskArtifact(directory: string, clip: Clip, mask: SmartMaskDocument, sourcePath: string, asset: MediaAsset) {
  const result = mask.result;
  if (!result || !validKey(result.key) || result.signature !== smartMaskSignature(mask)) fail(409, `${mask.name}: analyze the current mask before exporting.`);
  const root = join(directory, result!.key);
  if (!regularFile(join(root, 'binding.json')) || !regularFile(join(root, 'manifest.json'))) fail(409, `${mask.name}: the analyzed mask is unavailable.`);
  const binding = json(join(root, 'binding.json')) as Binding;
  // A copied mask can share immutable pixels when project, source and exact intent match.
  if (binding.projectId !== clip.projectId || binding.signature !== result!.signature || binding.sourceFingerprint !== maskSourceFingerprint(sourcePath) || binding.analysisIdentity !== maskAnalysis(clip, asset).identity) fail(409, `${mask.name}: the analyzed mask is stale or belongs to another source.`);
  const manifest = json(join(root, 'manifest.json')) as Manifest;
  validateMaskManifest(manifest, { key: result!.key, signature: result!.signature, mask, direction: binding.direction, anchorTime: binding.anchorTime }, root);
  return { directory: root, manifest };
}

/** Only a verified, unpainted inference with identical source/model/prompts can seed new repairs. */
export function resolveSmartMaskRepairBase(directory: string, clip: Clip, mask: SmartMaskDocument, sourcePath: string, asset: MediaAsset, workerIdentity: string, direction: Direction, anchorTime: number): string | undefined {
  if (!mask.result || !validKey(mask.result.key)) return;
  const root = join(directory, mask.result.key);
  if (!regularFile(join(root, 'binding.json'))) return;
  const binding = json(join(root, 'binding.json')) as Binding;
  if (binding.projectId !== clip.projectId || binding.workerIdentity !== workerIdentity || binding.direction !== direction || binding.anchorTime !== anchorTime) return;
  const previous = { ...mask, ...JSON.parse(binding.signature), result: { key: mask.result.key, signature: binding.signature } } as SmartMaskDocument;
  validateSmartMask(previous);
  if (smartMaskSignature({ ...previous, repairs: [] }) !== smartMaskSignature({ ...mask, repairs: [] })) return;
  const artifact = resolveSmartMaskArtifact(directory, clip, previous, sourcePath, asset);
  for (const frame of artifact.manifest.frames) {
    const alpha = join(root, 'base-frames', `${frame.index}.png`);
    if (!regularFile(alpha) || !alphaHeader(alpha, mask.source.width, mask.source.height)) return;
  }
  return artifact.directory;
}

export function smartMaskService(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const jobs = new Map<string, Job>(), controllers = new Map<string, AbortController>();
  const sourceRequests = new Map<string, Promise<string>>();
  const timeRequests = new Map<string, Promise<number[]>>();
  let queue = Promise.resolve(), closed = false;
  const save = (job: Job) => { jobs.set(job.key, job); atomicJson(join(directory, `${job.key}.job.json`), job); };
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.job\.json$/.test(name)) continue;
    try { const job = json(join(directory, name)) as Job; if (['queued', 'processing'].includes(job.status)) { job.status = 'failed'; job.error = 'The server restarted. Analyze the mask again.'; } save(job); } catch { /* Ignore interrupted or corrupt job records. */ }
  }
  const get = (projectId: string, key: string) => { const job = validKey(key) ? jobs.get(key) : undefined; if (!job || job.projectId !== projectId) fail(404, 'Smart Mask job not found.'); return job!; };
  const sourceTimes = async (clip: Clip, asset: MediaAsset, sourcePath: string): Promise<number[]> => {
    if (closed) fail(503, 'The server is stopping.');
    const key = hash([clip.projectId, asset.id, maskSourceFingerprint(sourcePath)]), output = join(directory, `${key}.times.json`);
    if (regularFile(output)) return json(output);
    const pending = timeRequests.get(key); if (pending) return pending;
    if (timeRequests.size >= 2) fail(429, 'Source timing requests are busy. Retry shortly.');
    const controller = new AbortController(); controllers.set(`times-${key}`, controller);
    const request = (async () => {
      try {
        const outputText = await runMaskProcess(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', sourcePath], AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
        const values = outputText.split('\n').map(line => line.split(',')[0].trim()).filter(value => /^-?\d+(\.\d+)?$/.test(value)).map(Number);
        const times = values.map(time => time - values[0]);
        if (!times.length || times.some((time, index) => !Number.isFinite(time) || index > 0 && time <= times[index - 1])) fail(409, 'Source video does not have valid ordered frame timestamps.');
        atomicJson(output, times); return times;
      } finally { timeRequests.delete(key); controllers.delete(`times-${key}`); }
    })();
    timeRequests.set(key, request); return request;
  };
  return {
    get,
    sourceTimes,
    async source(clip: Clip, asset: MediaAsset, sourcePath: string, frame: number) {
      if (closed) fail(503, 'The server is stopping.');
      if (!Number.isSafeInteger(frame) || frame < 0 || frame >= (await sourceTimes(clip, asset, sourcePath)).length) fail(400, 'Invalid source frame.');
      const analysis = maskAnalysis(clip, asset), key = hash([clip.projectId, asset.id, maskSourceFingerprint(sourcePath), analysis.identity, frame]);
      const root = join(directory, 'source'), output = join(root, `${key}.jpg`);
      if (regularFile(output)) return output;
      const pending = sourceRequests.get(key); if (pending) return pending;
      if (sourceRequests.size >= 4) fail(429, 'Source frame requests are busy. Retry shortly.');
      const controller = new AbortController(); controllers.set(`source-${key}`, controller);
      const request = (async () => {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const temporary = join(root, `.source-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 });
        try {
          const lut = join(temporary, 'analysis.cube'), jpeg = join(temporary, 'frame.jpg'); writeFileSync(lut, analysis.text, { mode: 0o600 });
          const escaped = lut.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
          const scale: string[] = [], range = clip.properties.dataLevels, matrix = inputMatrix(clip, asset);
          if (range === 'Full' || range === 'Video') scale.push(`in_range=${range === 'Full' ? 'pc' : 'tv'}`);
          if (matrix !== 'auto') scale.push(`in_color_matrix=${matrix}`);
          const filters = [`select=eq(n\\,${frame})`, ...(scale.length ? [`scale=${scale.join(':')}`] : []), `lut3d=file='${escaped}'`];
          await runMaskProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,mxf', '-i', sourcePath, '-vf', filters.join(','), '-frames:v', '1', '-q:v', '2', '-threads', '1', jpeg], AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
          if (!regularFile(jpeg)) fail(404, 'Source frame is unavailable.');
          renameSync(jpeg, output); return output;
        } finally { rmSync(temporary, { recursive: true, force: true }); sourceRequests.delete(key); controllers.delete(`source-${key}`); }
      })();
      sourceRequests.set(key, request); return request;
    },
    async enqueue(options: { clip: Clip; asset: MediaAsset; mask: SmartMaskDocument; sourcePath: string; signature: string; direction: Direction; anchorTime: number }) {
      const { clip, asset, mask, sourcePath, signature, direction, anchorTime } = options;
      validateSmartMask(mask);
      if (!mask.prompts.some(prompt => prompt.kind === 'include' && prompt.time >= mask.range.start && prompt.time < mask.range.end)) fail(400, 'Add an Include point inside the analysis range first.');
      if (signature !== smartMaskSignature(mask)) fail(409, 'Mask edits are still saving. Retry analysis after saving.');
      if (!['forward', 'backward', 'both'].includes(direction) || !Number.isFinite(anchorTime) || anchorTime < mask.range.start || anchorTime >= mask.range.end) fail(400, 'Choose an anchor frame inside the analysis range.');
      if (mask.source.mediaId !== asset.id || mask.source.duration > asset.duration + .1 || mask.range.end > asset.duration + .1) fail(400, 'Mask source metadata does not match the original video.');
      const dimensions = asset.resolution.match(/(\d+)\s*[×x]\s*(\d+)/);
      if (!dimensions || Number(dimensions[1]) !== mask.source.width || Number(dimensions[2]) !== mask.source.height || Math.abs(mask.source.fps - asset.fps) > .001) fail(400, 'Mask dimensions or frame rate do not match the original video.');
      if (mask.range.end - mask.range.start > 600 || (mask.range.end - mask.range.start) * mask.source.fps > 36_000) fail(400, 'Analyze ranges of at most ten minutes and 36,000 frames.');
      const capabilities = await smartMaskCapabilities();
      if (closed) fail(503, 'The server is stopping.');
      if (!capabilities.available) fail(503, capabilities.reason || 'Smart Mask worker is unavailable.');
      if (!capabilities.workerIdentity || !['string', 'object'].includes(typeof capabilities.workerIdentity)) fail(503, 'The Smart Mask engine has no verifiable model identity.');
      if (mask.settings.preserveMotionBlur && !capabilities.preserveMotionBlur) fail(409, 'The installed engine cannot preserve source motion blur.');
      if (mask.settings.quality === 'final' && !capabilities.finalQuality) fail(409, 'The installed engine has not qualified for final quality.');
      const analysis = maskAnalysis(clip, asset), sourceFingerprint = maskSourceFingerprint(sourcePath);
      const workerIdentity = hash([readFileSync(worker, 'utf8'), capabilities.workerIdentity]);
      const binding: Binding = { projectId: clip.projectId, clipId: clip.id, maskId: mask.id, signature, sourceFingerprint, analysisIdentity: analysis.identity, workerIdentity, direction, anchorTime };
      const key = hash([binding, direction, anchorTime]);
      const previous = jobs.get(key);
      if (previous?.status === 'ready') { resolveSmartMaskArtifact(directory, clip, { ...mask, result: { key, signature } }, sourcePath, asset); return previous; }
      if (previous && ['queued', 'processing'].includes(previous.status)) return previous;
      if (controllers.has(key)) fail(409, 'The previous analysis is still stopping. Retry shortly.');
      if (regularFile(join(directory, key, 'manifest.json')) && regularFile(join(directory, key, 'binding.json'))) {
        resolveSmartMaskArtifact(directory, clip, { ...mask, result: { key, signature } }, sourcePath, asset);
        const restored: Job = { key, signature, projectId: clip.projectId, clipId: clip.id, maskId: mask.id, status: 'ready', progress: 100, manifestUrl: `/api/smart-masks/${key}/manifest?projectId=${encodeURIComponent(clip.projectId)}` }; save(restored); return restored;
      }
      if ([...jobs.values()].filter(job => ['queued', 'processing'].includes(job.status)).length >= 8) fail(429, 'Smart Mask queue is full.');
      const baseInput = resolveSmartMaskRepairBase(directory, clip, mask, sourcePath, asset, workerIdentity, direction, anchorTime);
      const controller = new AbortController(); controllers.set(key, controller);
      const job: Job = { key, signature, projectId: clip.projectId, clipId: clip.id, maskId: mask.id, status: 'queued', progress: 0 };
      save(job);
      // ponytail: one model process per server; add a device-aware pool only for multi-GPU deployment.
      queue = queue.then(async () => {
        if (closed || controller.signal.aborted) { controllers.delete(key); return; }
        const temporary = join(directory, `.partial-${key}-${randomUUID()}`);
        try {
          if (hash([readFileSync(worker, 'utf8'), capabilities.workerIdentity]) !== workerIdentity) throw new Error('The Smart Mask worker changed while queued. Analyze again.');
          mkdirSync(temporary, { mode: 0o700 });
          job.status = 'processing'; save(job);
          writeFileSync(join(temporary, 'analysis.cube'), analysis.text, { mode: 0o600 });
          const input = { version: 1, key, signature, input: sourcePath, output: temporary, document: mask, direction, anchorTime, projectId: clip.projectId, mediaId: asset.id, sourceFingerprint, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe', workerIdentity, analysisLutPath: join(temporary, 'analysis.cube'), dataLevels: clip.properties.dataLevels || 'auto', yuvMatrix: inputMatrix(clip, asset), ...(baseInput ? { baseInput } : {}) };
          atomicJson(join(temporary, 'job.json'), input);
          await runMaskProcess(python(), [worker, join(temporary, 'job.json')], controller.signal, value => { job.progress = Math.round(value); });
          if (controller.signal.aborted) throw new Error('Smart Mask cancelled.');
          if (maskSourceFingerprint(sourcePath) !== sourceFingerprint) throw new Error('The original media changed during analysis.');
          const manifest = json(join(temporary, 'manifest.json')) as Manifest;
          validateMaskManifest(manifest, { key, signature, mask, direction, anchorTime }, temporary);
          if (manifest.projectId !== clip.projectId || manifest.mediaId !== asset.id || manifest.sourceFingerprint !== sourceFingerprint || manifest.quality !== mask.settings.quality) throw new Error('Smart Mask manifest source binding is invalid.');
          if (!isDeepStrictEqual(JSON.parse(manifest.modelRevision), capabilities.workerIdentity)) throw new Error('The Smart Mask model changed during analysis. Analyze again.');
          const times = await sourceTimes(clip, asset, sourcePath);
          if (JSON.stringify(times) !== JSON.stringify(manifest.sourceTimes)) throw new Error('Smart Mask timestamps differ from the original video.');
          if (controller.signal.aborted || closed) throw new Error('Smart Mask cancelled.');
          if (maskSourceFingerprint(sourcePath) !== sourceFingerprint) throw new Error('The original media changed during analysis.');
          atomicJson(join(temporary, 'binding.json'), binding);
          rmSync(join(temporary, 'job.json')); rmSync(join(temporary, 'analysis.cube'));
          renameSync(temporary, join(directory, key));
          job.status = 'ready'; job.progress = 100; job.manifestUrl = `/api/smart-masks/${key}/manifest?projectId=${encodeURIComponent(clip.projectId)}`; save(job);
        } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = (error as Error).message; save(job); }
        finally { controllers.delete(key); rmSync(temporary, { recursive: true, force: true }); }
      }).catch(error => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = (error as Error).message; controllers.delete(key);
        try { save(job); } catch { /* Keep the in-memory failure visible if the cache volume is full. */ }
      });
      return job;
    },
    cancel(projectId: string, key: string) { const job = get(projectId, key); if (job.status === 'ready') return; controllers.get(key)?.abort(); job.status = 'cancelled'; job.error = 'Cancelled by you.'; save(job); },
    file(projectId: string, key: string, kind: 'manifest' | 'frames' | 'source', frame?: number) {
      const job = get(projectId, key); if (job.status !== 'ready') fail(409, 'Smart Mask is not ready.');
      const root = join(directory, key), binding = json(join(root, 'binding.json')) as Binding;
      if (binding.projectId !== projectId || binding.signature !== job.signature) fail(404, 'Smart Mask asset not found.');
      if (kind === 'manifest') return join(root, 'manifest.json');
      const manifest = json(join(root, 'manifest.json')) as Manifest;
      if (!Number.isSafeInteger(frame) || !manifest.frames.some(entry => entry.index === frame)) fail(404, 'Smart Mask frame not found.');
      return join(root, kind, `${frame}.${kind === 'frames' ? 'png' : 'jpg'}`);
    },
    async close() { closed = true; for (const [key, controller] of controllers) { controller.abort(); const job = jobs.get(key); if (job) { job.status = 'cancelled'; job.error = 'Server stopped.'; save(job); } } await Promise.allSettled([queue, ...sourceRequests.values(), ...timeRequests.values()]); },
  };
}
