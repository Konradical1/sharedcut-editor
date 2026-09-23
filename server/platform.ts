import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const windows = process.platform === 'win32';
const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * A venv interpreter is `.venv-x/bin/python` on macOS and Linux but `.venv-x\Scripts\python.exe` on
 * Windows. Every call site still reads its own `FRAME_LINE_*_PYTHON` override first; this is only
 * the default that makes an un-overridden checkout work on either host.
 */
export const venvPython = (venv: string) => join(root, venv, ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python']));

/**
 * Wrap a filesystem path for use *inside* an FFmpeg filter argument (`lut3d=file='...'`). Argv paths
 * need none of this - only the filtergraph parser does, and on Windows it eats `C:\Users\...` alive:
 * `\` is its escape character and `:` ends an option, so an unescaped absolute path silently became
 * `C` plus garbage and failed every export on this host. Mirrors `filter_path` in scripts/smart-mask.py.
 */
export function filterPath(path: string) {
  // FFmpeg's two unescaping passes cannot agree on a quote inside a quoted option value: every
  // documented spelling either drops it or swallows the option separator behind it. Server-made
  // LUT names never contain one, so this only fires when the temp root itself does.
  if (path.includes("'")) throw new Error(`FFmpeg cannot read a filter path containing an apostrophe (${path}). Point TMPDIR - or TEMP on Windows - at a directory without one.`);
  return path.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}

/** `filterPath` already quoted and escaped, ready to interpolate. */
export const quotedFilterPath = (path: string) => `'${filterPath(path)}'`;

/**
 * Windows refuses a rename with EPERM/EACCES/EBUSY while any process holds a handle on the file or on
 * anything inside a directory - Defender and the search indexer open freshly written files for a moment.
 * That failed finished Smart Mask analyses at 99%. POSIX renames never hit this, so only Windows retries.
 */
export const locked = (error: unknown) => windows && ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');
export async function renameWithRetry(from: string, to: string, attempts = 20) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) { if (!locked(error) || attempt >= attempts) throw error; await delay(Math.min(1000, 50 * 2 ** attempt)); }
  }
}
/** Blocking twin for small metadata files; gives up after about a second. */
export function renameWithRetrySync(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) { if (!locked(error) || attempt >= 8) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, 10 * 2 ** attempt)); }
  }
}
