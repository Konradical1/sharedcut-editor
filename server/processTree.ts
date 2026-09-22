import { spawn, type ChildProcess } from 'node:child_process';

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

// Kill the process group: model jobs may have their own FFmpeg decoder children.
export function runWorkerProcess(command: string, args: string[], signal?: AbortSignal, progress?: (value: number) => void, label = 'Worker'): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error(`${label} cancelled.`));
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let output = '', errors = '', pending = '', failure: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => killProcessTree(child, kind);
    const abort = () => { failure = new Error(`${label} cancelled.`); kill('SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 2000); timer.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { output += data; pending += data; if (output.length > 4 * 1024 ** 2) { failure = new Error(`${label} output exceeds limit.`); kill('SIGKILL'); } const lines = pending.split('\n'); pending = lines.pop() || ''; for (const line of lines) { try { const value = JSON.parse(line).progress; if (Number.isFinite(value)) progress?.(Math.max(0, Math.min(99, value))); } catch { /* Worker diagnostics. */ } } });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.on('close', code => { if (!signal?.aborted) clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(errors.trim() || `${label} exited ${code}.`)); else resolveOutput(output); });
  });
}
