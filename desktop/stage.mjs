// Copies the SharedCut server, the built editor and the binaries they run on into stage/, which electron-builder ships
// inside the app (package.json "extraResources"). Run `npm run build` at the repo root first. vendor/<platform>-<arch>/
// holds node, ffmpeg and ffprobe for that platform (README.md says where they come from).
// electron-builder never copies the top-level node_modules of a folder it ships, so package.json lists
// stage/app/node_modules as its own entry. Without it the installed app has no server dependencies.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = dirname(fileURLToPath(import.meta.url)), root = join(desktop, '..'), stage = join(desktop, 'stage');
const vendor = join(desktop, 'vendor', `${process.platform}-${process.arch}`);
if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('Build the editor first: npm run build at the repo root.');
if (!existsSync(vendor)) throw new Error(`Missing ${vendor} with node, ffmpeg and ffprobe for this platform.`);
rmSync(stage, { recursive: true, force: true });
// Tracked files only, so a checkout's .env, session cookies and Python venvs never end up in the app.
const tracked = execFileSync('git', ['ls-files', '-z', 'server', 'src', 'public', 'scripts', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' });
for (const file of tracked.split('\0').filter(file => file && !file.endsWith('.test.ts'))) {
  mkdirSync(dirname(join(stage, 'app', file)), { recursive: true });
  cpSync(join(root, file), join(stage, 'app', file));
}
cpSync(join(root, 'dist'), join(stage, 'app', 'dist'), { recursive: true });
// The server's own dependencies; the editor's are already bundled into dist/.
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: join(stage, 'app'), stdio: 'inherit', shell: process.platform === 'win32' });
// onnxruntime-node (sound effect search) carries the runtime for every OS; this app needs only its own.
const onnx = join(stage, 'app', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
if (existsSync(onnx)) for (const os of readdirSync(onnx)) if (os !== process.platform) rmSync(join(onnx, os), { recursive: true });
cpSync(vendor, join(stage, 'bin'), { recursive: true });
