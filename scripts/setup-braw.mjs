// Build the Blackmagic RAW helper (scripts/braw/braw.cpp) against Blackmagic's RAW SDK on this machine.
//
//   npm run setup:braw [-- <Blackmagic RAW SDK folder>]
//
// The SDK is free from blackmagicdesign.com/support ("Blackmagic RAW", Developer SDK). Its installer puts the SDK at
// /Applications/Blackmagic RAW/Blackmagic RAW SDK (macOS), C:\Program Files\Blackmagic Design\Blackmagic RAW\Blackmagic RAW SDK
// (Windows) and /usr/lib64/blackmagic/BlackmagicRAWSDK (the Linux rpm); any copy of that folder works too.
// Writes .braw/braw[.exe] and copies the SDK's libraries to .braw/lib, which the server finds by itself
// (FRAME_LINE_BRAW and FRAME_LINE_BRAW_LIB override both). Windows needs a Visual Studio developer prompt (cl, midl).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const platform = { darwin: 'Mac', linux: 'Linux', win32: 'Win' }[process.platform];
if (!platform) throw new Error(`The Blackmagic RAW SDK has no ${process.platform} build.`);
const candidates = [process.argv[2], process.env.BRAW_SDK,
  '/Applications/Blackmagic RAW/Blackmagic RAW SDK', join(homedir(), 'BlackmagicRAWSDK'), '/usr/lib64/blackmagic/BlackmagicRAWSDK', '/opt/BlackmagicRAWSDK',
  'C:\\Program Files\\Blackmagic Design\\Blackmagic RAW\\Blackmagic RAW SDK'].filter(Boolean);
const sdk = candidates.map(dir => resolve(dir)).find(dir => existsSync(join(dir, platform, 'Libraries')) && existsSync(join(dir, 'Samples', 'Common', 'PlatformHelpers.h')));
if (!sdk) throw new Error(`No Blackmagic RAW SDK found. Download "Blackmagic RAW" from blackmagicdesign.com/support, install it, or pass its SDK folder: npm run setup:braw -- <folder>\nLooked in:\n  ${candidates.join('\n  ')}`);

const out = join(root, '.braw'), lib = join(out, 'lib'), include = join(sdk, platform, 'Include');
const helper = join(out, process.platform === 'win32' ? 'braw.exe' : 'braw'), source = join(root, 'scripts', 'braw', 'braw.cpp');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The framework is a bundle with its own internal links; keep them as they are.
cpSync(join(sdk, platform, 'Libraries'), lib, { recursive: true, verbatimSymlinks: true });
console.log(`Blackmagic RAW SDK: ${sdk}`);

const run = (command, args, options = {}) => { console.log(`> ${command} ${args.join(' ')}`); execFileSync(command, args, { stdio: 'inherit', ...options }); };
const common = [`-I${include}`, `-I${join(sdk, 'Samples', 'Common')}`, source, join(include, 'BlackmagicRawAPIDispatch.cpp'), '-o', helper];
if (process.platform === 'darwin') run('clang++', ['-std=c++17', '-O2', ...common, '-framework', 'CoreFoundation']);
else if (process.platform === 'linux') run(process.env.CXX || 'g++', ['-std=c++17', '-O2', ...common, '-ldl', '-lpthread']);
else {
  // MIDL turns the SDK's IDL into the header and interface ids the Windows build includes.
  const build = join(out, 'build');
  mkdirSync(build, { recursive: true });
  run('midl', ['/nologo', '/h', 'BlackmagicRawAPI.h', '/iid', 'BlackmagicRawAPI_i.c', '/out', build, join(include, 'BlackmagicRawAPI.idl')]);
  run('cl', ['/nologo', '/std:c++17', '/O2', '/EHsc', `/I${build}`, `/I${include}`, `/I${join(sdk, 'Samples', 'Common')}`, source, join(include, 'BlackmagicRawAPIDispatch.cpp'), join(build, 'BlackmagicRawAPI_i.c'), `/Fo${build}\\`, `/Fe${helper}`, 'ole32.lib', 'oleaut32.lib'], { cwd: build });
}

// Prove it end to end on the SDK's own sample clip, kept beside the helper for server/braw.test.ts.
const sample = join(sdk, 'Media', 'sample.braw');
if (existsSync(sample)) {
  cpSync(sample, join(out, 'sample.braw'));
  const info = JSON.parse(execFileSync(helper, ['info', sample, '--lib', lib]).toString());
  console.log(`Blackmagic RAW ready: ${info.camera}, ${info.width} × ${info.height}, ${info.fps} fps`);
} else console.log(`Built ${helper}`);
