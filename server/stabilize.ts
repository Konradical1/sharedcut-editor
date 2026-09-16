import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StabilizeSettings } from '../src/services/stabilize.ts';
import { stabilizeKeys } from '../src/services/stabilize.ts';

/** Stabilize worker (scripts/stabilize.py): analysis and render stages, cached by content identity. */
const worker = fileURLToPath(new URL('../scripts/stabilize.py', import.meta.url));
export const stabilizePython = () => process.env.FRAME_LINE_STABILIZE_PYTHON || fileURLToPath(new URL(process.platform === 'win32' ? '../.venv-stabilize/Scripts/python.exe' : '../.venv-stabilize/bin/python', import.meta.url));
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = () => process.env.FFPROBE_PATH || 'ffprobe';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let workerQueue = Promise.resolve();

// Kill the process group: the worker owns ffmpeg decoder and encoder children.
export function runStabilizeProcess(command: string, args: string[], signal?: AbortSignal, progress?: (value: number) => void): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error('Stabilize cancelled.'));
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let output = '', errors = '', pending = '', failure: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Process already exited. */ } };
    const abort = () => { failure = new Error('Stabilize cancelled.'); kill('SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 2000); timer.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { output += data; pending += data; if (output.length > 4 * 1024 ** 2) { failure = new Error('Stabilize worker output exceeds limit.'); kill('SIGKILL'); } const lines = pending.split('\n'); pending = lines.pop() || ''; for (const line of lines) { try { const value = JSON.parse(line).progress; if (Number.isFinite(value)) progress?.(Math.max(0, Math.min(99, value))); } catch { /* Worker diagnostics. */ } } });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.on('close', code => { if (!signal?.aborted) clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(errors.trim() || `Stabilize worker exited ${code}.`)); else resolveOutput(output); });
  });
}

let capabilitiesRequest: Promise<{ available: boolean; reason?: string; opencv?: string }> | undefined, capabilitiesExpiry = 0;
export function stabilizeCapabilities() {
  if (!capabilitiesRequest || Date.now() >= capabilitiesExpiry) { capabilitiesExpiry = Date.now() + 30_000; capabilitiesRequest = checkCapabilities(); }
  return capabilitiesRequest;
}
async function checkCapabilities() {
  if (!existsSync(stabilizePython()) || !existsSync(worker)) return { available: false, reason: 'The Stabilize worker is not installed on this server. Run npm run setup:stabilize.' };
  try {
    const lines = (await runStabilizeProcess(stabilizePython(), [worker, '--check'], AbortSignal.timeout(60_000))).trim().split('\n');
    const result = JSON.parse(lines.at(-1)!);
    return { available: result.available === true, opencv: String(result.opencv ?? ''), reason: result.reason || result.error };
  } catch (error) { return { available: false, reason: (error as Error).message }; }
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;
export function normalizeSettings(raw: Partial<StabilizeSettings> | undefined): StabilizeSettings {
  const defaults: StabilizeSettings = { amount: 100, crop: 5, smoothness: 50, lock: 0 };
  return Object.fromEntries(stabilizeKeys.map(key => { const value = Number(raw?.[key]); return [key, Number.isFinite(value) ? round(value) : defaults[key]]; })) as StabilizeSettings;
}

let workerHash: Promise<string> | undefined;
const workerIdentity = () => workerHash ??= readFile(worker, 'utf8').then(text => hash(text)).catch(error => { workerHash = undefined; throw error; });
async function inputIdentity(input: string) { const file = await stat(input); return [resolve(input), file.size, file.mtimeMs]; }

export async function stabilizeAnalysisIdentity(input: string, from: number, to: number) {
  return hash(['stabilize-analysis-v1', await workerIdentity(), await inputIdentity(input), round(from), round(to)]);
}
export async function stabilizeIdentity(analysisKey: string, settings: StabilizeSettings, from: number, to: number, preview: boolean, input?: string) {
  return hash(['stabilize-render-v2', analysisKey, normalizeSettings(settings), round(from), round(to), preview, input ? await inputIdentity(input) : null]);
}

async function runStage(job: Record<string, unknown>, directory: string, prefix: string, signal: AbortSignal | undefined, onProgress: ((value: number) => void) | undefined) {
  const temporary = await mkdtemp(join(directory, prefix));
  try {
    const file = join(temporary, 'job.json');
    await writeFile(file, JSON.stringify(job));
    const task = workerQueue.then(() => runStabilizeProcess(stabilizePython(), [worker, file], signal, onProgress));
    workerQueue = task.then(() => {}, () => {});
    const output = await task;
    if (signal?.aborted) throw new Error('Stabilize cancelled.');
    return { temporary, output };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

/** Camera-path analysis over the source range, cached as data/stabilize/<key>.path.json. */
export async function stabilizeAnalysis(options: { input: string; directory: string; from: number; to: number; signal?: AbortSignal; onProgress?: (value: number) => void }) {
  const { input, directory, from, to, signal, onProgress } = options;
  if (!(to > from) || from < 0) throw new Error('Invalid stabilize range.');
  const key = await stabilizeAnalysisIdentity(input, from, to), output = join(directory, `${key}.path.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (existsSync(output)) { onProgress?.(100); return { key, output }; }
  const { temporary } = await runStage({ stage: 'analyze', ffmpeg: ffmpeg(), ffprobe: ffprobe(), input, from, to, output: join(directory, `.analysis-${key}.tmp`) }, directory, '.stabilize-analyze-', signal, onProgress);
  try { await rename(join(directory, `.analysis-${key}.tmp`), output); onProgress?.(100); return { key, output }; }
  finally { await rm(temporary, { recursive: true, force: true }); await rm(join(directory, `.analysis-${key}.tmp`), { force: true }); }
}

/** Stabilized picture for [from,to) of the source in source time. Preview: x264 mp4. Export: ProRes mov. */
/** `analysisInput` is the camera original: proxies lose tracking and invent rotation. `input` may be a proxy of the same aspect for previews. */
export async function renderStabilized(options: { input: string; analysisInput?: string; directory: string; analysisDirectory?: string; range: { from: number; to: number }; from: number; to: number; settings: StabilizeSettings; preview: boolean; signal?: AbortSignal; onProgress?: (value: number) => void }) {
  const { input, analysisInput = input, directory, analysisDirectory = directory, range, from, to, preview, signal, onProgress } = options, settings = normalizeSettings(options.settings);
  if (!(to > from) || from < range.from - 1e-6 || to > range.to + 1e-6) throw new Error('Stabilize render range must lie inside the analysed range.');
  const analysis = await stabilizeAnalysis({ input: analysisInput, directory: analysisDirectory, from: range.from, to: range.to, signal, onProgress: value => onProgress?.(value * .3) });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = await stabilizeIdentity(analysis.key, settings, from, to, preview, input), output = join(directory, `${key}.${preview ? 'mp4' : 'mov'}`), sidecar = join(directory, `${key}.json`);
  const zoomOf = async () => { try { const value = JSON.parse(await readFile(sidecar, 'utf8')); return { zoom: Number.isFinite(Number(value.zoom)) ? Number(value.zoom) : undefined, zoomMin: Number.isFinite(Number(value.zoomMin)) ? Number(value.zoomMin) : undefined }; } catch { return { zoom: undefined, zoomMin: undefined }; } };
  if (existsSync(output)) { onProgress?.(100); return { key, output, ...await zoomOf() }; }
  const { temporary, output: log } = await runStage({ stage: 'render', ffmpeg: ffmpeg(), ffprobe: ffprobe(), input, path: analysis.output, from, to, preview, settings, output: join(directory, `.render-${key}.tmp.${preview ? 'mp4' : 'mov'}`) }, directory, '.stabilize-render-', signal, value => onProgress?.(30 + value * .7));
  try {
    const report = log.split('\n').map(line => { try { return JSON.parse(line) as { zoom?: number; zoomMin?: number }; } catch { return undefined; } }).find(value => value && Number.isFinite(Number(value.zoom)));
    const zoom = report ? Number(report.zoom) : undefined, zoomMin = report && Number.isFinite(Number(report.zoomMin)) ? Number(report.zoomMin) : zoom;
    if (zoom !== undefined) await writeFile(sidecar, JSON.stringify({ zoom, zoomMin }));
    await rename(join(directory, `.render-${key}.tmp.${preview ? 'mp4' : 'mov'}`), output); onProgress?.(100); return { key, output, zoom, zoomMin };
  }
  finally { await rm(temporary, { recursive: true, force: true }); await rm(join(directory, `.render-${key}.tmp.${preview ? 'mp4' : 'mov'}`), { force: true }); }
}

// Evict finished previews only; analysis files are tiny and exports are removed by their caller.
export async function trimStabilizeCache(directory: string, keep: Set<string>, limit = 2 * 1024 ** 3) {
  const files = await Promise.all((await readdir(directory).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mp4$/.test(name)).map(async name => ({ name, ...await stat(join(directory, name)) })));
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (bytes <= limit) break;
    if (!keep.has(file.name.slice(0, -4))) { await rm(join(directory, file.name), { force: true }); bytes -= file.size; }
  }
}
