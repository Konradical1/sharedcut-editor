// Run a script with a project venv's interpreter, on any host.
//   node scripts/venv-run.mjs <venv-dir> <script.py> [args...]
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const [venv, ...rest] = process.argv.slice(2);
if (!venv || !rest.length) { console.error('Usage: node scripts/venv-run.mjs <venv-dir> <script.py> [args...]'); process.exit(2); }
const root = resolve(import.meta.dirname, '..');
const python = join(root, venv, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
execFileSync(python, rest.map(a => (a.endsWith('.py') ? resolve(root, a) : a)), { stdio: 'inherit', cwd: root });
