// Create a Python venv and install a requirements file, on any host.
//
// The npm scripts used to spell this four times as `python3.12 -m venv .venv-x &&
// .venv-x/bin/pip install -r ...`, which is two Mac assumptions per line: a `python3.12` on PATH
// and a POSIX `bin/` layout. Windows has neither.
//
//   node scripts/setup-venv.mjs <venv-dir> <requirements.txt> [script.py args...]
//
// Anything after the requirements file is run with the new interpreter.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const [venv, requirements, ...then] = process.argv.slice(2);
if (!venv || !requirements) { console.error('Usage: node scripts/setup-venv.mjs <venv-dir> <requirements.txt> [script args...]'); process.exit(2); }

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, venv);
const python = join(target, ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python']));

// Pin to an interpreter that has wheels for the pinned dependencies, newest first. Windows ships
// the `py` launcher for this; POSIX gets versioned names on PATH.
const candidates = process.env.FRAME_LINE_SETUP_PYTHON ? [[process.env.FRAME_LINE_SETUP_PYTHON, []]]
  : windows ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['python', []]]
  : [['python3.13', []], ['python3.12', []], ['python3.11', []], ['python3', []]];

function interpreter() {
  for (const [command, args] of candidates) {
    try { execFileSync(command, [...args, '--version'], { stdio: 'ignore' }); return [command, args]; } catch { /* Try the next one. */ }
  }
  throw new Error(`No usable Python found. Tried ${candidates.map(([c, a]) => [c, ...a].join(' ')).join(', ')}. Set FRAME_LINE_SETUP_PYTHON to one.`);
}

if (!existsSync(python)) {
  const [command, args] = interpreter();
  console.log(`Creating ${venv} with ${[command, ...args].join(' ')}`);
  execFileSync(command, [...args, '-m', 'venv', target], { stdio: 'inherit' });
}
execFileSync(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
execFileSync(python, ['-m', 'pip', 'install', '-r', resolve(root, requirements)], { stdio: 'inherit' });
if (then.length) execFileSync(python, then.map(a => (a.endsWith('.py') ? resolve(root, a) : a)), { stdio: 'inherit', cwd: root });
console.log(`Ready: ${python}`);
