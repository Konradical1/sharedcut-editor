import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
