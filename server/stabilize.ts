import { runWorkerProcess } from './processTree.ts';
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

export const runStabilizeProcess = (command: string, args: string[], signal?: AbortSignal, progress?: (value: number) => void) => runWorkerProcess(command, args, signal, progress, 'Stabilize');

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
/** The solve depends on the analysis and settings only, never on a range or a render size. */
export const stabilizeSolveIdentity = (analysisKey: string, settings: StabilizeSettings) => hash(['stabilize-solve-v1', analysisKey, normalizeSettings(settings)]);

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
  // Honest progress: a fresh analysis is most of the first section's wait, so it owns 0–70; once cached, the render owns 0–100.
  const weight = existsSync(join(analysisDirectory, `${await stabilizeAnalysisIdentity(analysisInput, range.from, range.to)}.path.json`)) ? 0 : .7;
  const analysis = await stabilizeAnalysis({ input: analysisInput, directory: analysisDirectory, from: range.from, to: range.to, signal, onProgress: value => onProgress?.(value * weight) });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = await stabilizeIdentity(analysis.key, settings, from, to, preview, input), output = join(directory, `${key}.${preview ? 'mp4' : 'mov'}`), sidecar = join(directory, `${key}.json`);
  // The camera-path solve depends on the analysis and settings only: one file serves every section and both preview tiers.
  const solve = join(analysisDirectory, `${stabilizeSolveIdentity(analysis.key, settings)}.solve.npz`);
  const zoomOf = async () => { try { const value = JSON.parse(await readFile(sidecar, 'utf8')); return { zoom: Number.isFinite(Number(value.zoom)) ? Number(value.zoom) : undefined, zoomMin: Number.isFinite(Number(value.zoomMin)) ? Number(value.zoomMin) : undefined }; } catch { return { zoom: undefined, zoomMin: undefined }; } };
  if (existsSync(output)) { onProgress?.(100); return { key, output, ...await zoomOf() }; }
  const { temporary, output: log } = await runStage({ stage: 'render', ffmpeg: ffmpeg(), ffprobe: ffprobe(), input, path: analysis.output, solve, from, to, preview, settings, output: join(directory, `.render-${key}.tmp.${preview ? 'mp4' : 'mov'}`) }, directory, '.stabilize-render-', signal, value => onProgress?.(weight * 100 + value * (1 - weight)));
  try {
    const report = log.split('\n').map(line => { try { return JSON.parse(line) as { zoom?: number; zoomMin?: number }; } catch { return undefined; } }).find(value => value && Number.isFinite(Number(value.zoom)));
    const zoom = report ? Number(report.zoom) : undefined, zoomMin = report && Number.isFinite(Number(report.zoomMin)) ? Number(report.zoomMin) : zoom;
    if (zoom !== undefined) await writeFile(sidecar, JSON.stringify({ zoom, zoomMin }));
    await rename(join(directory, `.render-${key}.tmp.${preview ? 'mp4' : 'mov'}`), output); onProgress?.(100); return { key, output, zoom, zoomMin };
  }
  finally { await rm(temporary, { recursive: true, force: true }); await rm(join(directory, `.render-${key}.tmp.${preview ? 'mp4' : 'mov'}`), { force: true }); }
}

export type StabilizeSolve = { version: 1; width: number; height: number; fps: number; from: number; to: number; zoom: number; zoomMin: number; matrices: number[][] };

/** Per-frame warp matrices for the whole analysed range. The browser applies them to the picture it already
 *  decodes, so a preview costs one analysis and one small JSON instead of a decode/warp/encode per section. */
export async function stabilizeSolve(options: { input: string; directory: string; range: { from: number; to: number }; settings: StabilizeSettings; signal?: AbortSignal; onProgress?: (value: number) => void }): Promise<{ key: string; solve: StabilizeSolve }> {
  const { input, directory, range, signal, onProgress } = options, settings = normalizeSettings(options.settings);
  // A fresh analysis is the whole wait; the solve itself is a linear program over a path already in memory.
  const analysed = existsSync(join(directory, `${await stabilizeAnalysisIdentity(input, range.from, range.to)}.path.json`));
  const analysis = await stabilizeAnalysis({ input, directory, from: range.from, to: range.to, signal, onProgress: value => onProgress?.(analysed ? value : value * .95) });
  const key = stabilizeSolveIdentity(analysis.key, settings), output = join(directory, `${key}.solve.json`);
  const read = async () => JSON.parse(await readFile(output, 'utf8')) as StabilizeSolve;
  if (existsSync(output)) { onProgress?.(100); return { key, solve: await read() }; }
  const { temporary } = await runStage({ stage: 'solve', path: analysis.output, solve: join(directory, `${key}.solve.npz`), settings, output: join(directory, `.solve-${key}.tmp`) }, directory, '.stabilize-solve-', signal, value => onProgress?.((analysed ? 0 : 95) + value * (analysed ? 1 : .05)));
  try { await rename(join(directory, `.solve-${key}.tmp`), output); onProgress?.(100); return { key, solve: await read() }; }
  finally { await rm(temporary, { recursive: true, force: true }); await rm(join(directory, `.solve-${key}.tmp`), { force: true }); }
}

/** Warp an analysed Smart Mask matte sequence with the picture's own matrices, so the matte follows the
 *  stabilized frame instead of the original framing. `frames` are absolute PNG paths with their source times. */
export async function stabilizeWarpMattes(options: { input: string; directory: string; range: { from: number; to: number }; settings: StabilizeSettings; frames: { input: string; output: string; time: number }[]; signal?: AbortSignal; onProgress?: (value: number) => void }) {
  const { input, directory, range, frames, signal, onProgress } = options, settings = normalizeSettings(options.settings);
  if (!frames.length) return;
  const analysis = await stabilizeAnalysis({ input, directory, from: range.from, to: range.to, signal });
  const { temporary } = await runStage({ stage: 'warp', path: analysis.output, solve: join(directory, `${stabilizeSolveIdentity(analysis.key, settings)}.solve.npz`), settings, frames }, directory, '.stabilize-warp-', signal, onProgress);
  await rm(temporary, { recursive: true, force: true });
}

/** Next preview to render: sections someone is polling right now go first, then everything else, each in request order. */
export function pickStabilizeJob<T extends { created: number; polled: number }>(pending: T[], now = Date.now()): T | undefined {
  const watched = pending.filter(job => now - job.polled < 2000);
  return (watched.length ? watched : pending).reduce<T | undefined>((best, job) => !best || job.created < best.created ? job : best, undefined);
}

// Evict finished previews only; analysis files are tiny and exports are removed by their caller.
export async function trimStabilizeCache(directory: string, keep: Set<string>, limit = 2 * 1024 ** 3, now = Date.now()) {
  const names = await readdir(directory).catch(() => []);
  // Leftovers of a render the server died in the middle of; nothing writes them for longer than an hour.
  for (const name of names) {
    if (!/^\.(render|analysis|solve|stabilize)-/.test(name)) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info && info.mtimeMs < now - 3600_000) await rm(join(directory, name), { recursive: true, force: true });
  }
  const files = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.mp4$/.test(name)).map(async name => ({ name, ...await stat(join(directory, name)) })));
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (bytes <= limit) break;
    if (!keep.has(file.name.slice(0, -4))) { await rm(join(directory, file.name), { force: true }); bytes -= file.size; }
  }
}
