import { spawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import { JOB_COST_BYTES, type AdmitRequest, type Release } from './hostGuard.ts';

/** Python workers own decoders/encoders. Windows signals do not kill descendants. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(signal); } catch { /* Already exited. */ } });
  } else {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* Already exited. */ } }
  }
}

// ---- host guard hook ----
// The server installs its host guard here once. Heavy starts (a render pass, a media encode, a Python worker) ask it for
// permission first; with none installed (tests, scripts) every start is immediate. Probes and stream copies never ask.

export type StartGate = {
  admit(request: AdmitRequest): Promise<Release>;
  passes(maxPasses: number, passCost: number): number;
};
let startGate: StartGate | null = null;
const NO_RELEASE: Release = () => undefined;

/** Installs `gate`. The returned function removes it, unless a newer gate has been installed since. */
export function setStartGate(gate: StartGate): () => void {
  startGate = gate;
  return () => { if (startGate === gate) startGate = null; };
}
export const admitStart = (request: AdmitRequest): Promise<Release> => startGate ? startGate.admit(request) : Promise.resolve(NO_RELEASE);
/** Parallel passes an export may use right now: the ceiling, or fewer when memory is short and the guard enforces. */
export const exportPassCount = (maxPasses: number, passCost: number): number => startGate ? startGate.passes(maxPasses, passCost) : maxPasses;

// Live ffmpeg and Python children of this server, for the host health log. Other spawns (captions, graphics) are not counted.
let liveChildCount = 0;
export const liveChildren = () => liveChildCount;
export function trackChild(child: ChildProcess): void {
  liveChildCount++;
  let ended = false;
  const end = () => { if (!ended) { ended = true; liveChildCount--; } };
  child.once('close', end); child.once('error', end);
}

/** Estimated memory of the Python workers the guard holds, by the label their caller gives. Anything not listed is not held. */
const WORKER_COST_BYTES: Readonly<Record<string, number>> = {
  Depth: JOB_COST_BYTES.depth, 'Optical flow': JOB_COST_BYTES.flow, Stabilize: JOB_COST_BYTES.stabilize,
  'Motion tracker': JOB_COST_BYTES.tracker, 'Smart Mask': JOB_COST_BYTES.smartMask, 'Noise Reduction': JOB_COST_BYTES.denoise,
};
// A prefix, not the whole name: FFMPEG_PATH and FFPROBE_PATH may point at a renamed build such as ffprobe-7.1.exe.
const PROBE_PROGRAM = /^ff(probe|mpeg)/i;

/** 0 (never held) for a `--check` probe, for ffprobe or ffmpeg run through a worker helper, and for a worker with no estimate. */
export function workerCost(command: string, args: readonly string[], label: string): number {
  if (args.includes('--check') || PROBE_PROGRAM.test(basename(command))) return 0;
  return WORKER_COST_BYTES[label] ?? 0;
}

async function admitWorker(command: string, args: readonly string[], label: string, signal?: AbortSignal): Promise<Release> {
  const costBytes = workerCost(command, args, label);
  if (costBytes === 0) return NO_RELEASE;
  try { return await admitStart({ kind: 'ai', costBytes, label, signal }); }
  catch (error) { if (signal?.aborted) throw new Error(`${label} cancelled.`); throw error; }
}

// Kill the process group: model jobs may have their own FFmpeg decoder children. With `onMessage` every JSON line is
// handed over as it arrives and not kept, so a worker may stream far more than the output limit.
export async function runWorkerProcess(command: string, args: string[], signal?: AbortSignal, progress?: (value: number) => void, label = 'Worker', onMessage?: (message: Record<string, unknown>) => void): Promise<string> {
  if (signal?.aborted) throw new Error(`${label} cancelled.`);
  const release = await admitWorker(command, args, label, signal);
  try { return await spawnWorker(command, args, signal, progress, label, onMessage); } finally { release(); }
}

function spawnWorker(command: string, args: string[], signal: AbortSignal | undefined, progress: ((value: number) => void) | undefined, label: string, onMessage: ((message: Record<string, unknown>) => void) | undefined): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error(`${label} cancelled.`));
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    trackChild(child);
    let output = '', errors = '', pending = '', failure: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => killProcessTree(child, kind);
    const abort = () => { failure = new Error(`${label} cancelled.`); kill('SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 2000); timer.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { if (!onMessage) output += data; pending += data; if (output.length > 4 * 1024 ** 2 || pending.length > 4 * 1024 ** 2) { failure = new Error(`${label} output exceeds limit.`); kill('SIGKILL'); } const lines = pending.split('\n'); pending = lines.pop() || ''; for (const line of lines) { let message: unknown; try { message = JSON.parse(line); } catch { continue; /* Worker diagnostics. */ } if (!message || typeof message !== 'object') continue; const value = (message as { progress?: unknown }).progress; if (typeof value === 'number' && Number.isFinite(value)) progress?.(Math.max(0, Math.min(99, value))); try { onMessage?.(message as Record<string, unknown>); } catch (error) { failure = error as Error; kill('SIGKILL'); } } });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('error', error => { failure = error; });
    // Once the worker is gone the delayed SIGKILL must not fire: on Windows it would taskkill /T whatever reused the PID.
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(errors.trim() || `${label} exited ${code}.`)); else resolveOutput(output); });
  });
}
