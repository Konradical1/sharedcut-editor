// Preview/export parity for the Depth effect (docs/superpowers/specs/2026-10-03-depth-fx-math.md): the same synthetic
// picture and depth go through the WebGL2 preview (depthFx.ts in headless Chrome) and depth-fx.py --parity, both at
// N = 48 taps. Passes when the mean error is under 1/255 and the 99th percentile under 4/255 per case.
//   node scripts/depth-fx-check.mjs
// Python: FRAME_LINE_DEPTH_PYTHON or .venv-mask; without torch there it runs on FRAME_LINE_DEPTH_PARITY_SSH (default
// gpu-host) in C:/Users/jdoe/Desktop/depth-bench/parity. FFMPEG_PATH converts the PNGs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { browserExecutable } from './browser-options.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = resolve(import.meta.dirname, '..'), ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const W = 1024, H = 576, w = 462, h = 259, near = .9, far = .1, taps = 48; // Not multiples: both area filters work.
const light = { light: 80, lightStart: 30, lightSoftness: 20, bgExposure: -1, bgWarmth: 50, bgContrast: 130, bgSaturation: 70 };
const fog = { fog: 70, fogStart: 30, fogDensity: 60, fogHue: 30, fogSaturation: 30, fogBrightness: 90, fogHorizon: 60 };
const lens = { blur: 80, focus: 30, range: 10, nearBlur: 60, bokeh: 100 };
const glow = { glow: 80, glowThreshold: 45, glowRadius: 40, glowStart: 30 };
const cases = { 'light + fog': { ...light, ...fog }, 'lens blur + bokeh': lens, glow, 'everything, Mix 85': { ...light, ...fog, ...lens, ...glow, amount: 85 } };

// The scene in normalised coordinates: a sky-to-ground gradient with fine checkers, small lights far away, and a near
// subject (an ellipse) with its own texture. Depth is drawn from the same shapes so the bilateral upsample has edges.
const subject = (u, v) => ((u - .3) / .17) ** 2 + ((v - .62) / .3) ** 2 < 1;
const lights = [[.62, .18], [.75, .3], [.86, .12], [.55, .4], [.92, .45], [.68, .08]];
const rgb = new Uint8Array(W * H * 4), depth = new Uint8Array(w * h);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const u = (x + .5) / W, v = (y + .5) / H, check = ((x / 6 | 0) + (y / 6 | 0)) % 2 ? .08 : -.08, i = (y * W + x) * 4;
  let c = [.55 - .3 * v + check, .6 - .25 * v + check, .8 - .5 * v + check];
  if (subject(u, v)) c = [.62 + check, .38 + check, .3 + check * .5];
  if (lights.some(([lu, lv]) => Math.hypot((u - lu) * W, (v - lv) * H) < 4)) c = [1, .95, .85];
  rgb.set([...c.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255)), 255], i);
}
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const u = (x + .5) / w, v = (y + .5) / h;
  depth[y * w + x] = Math.round((subject(u, v) ? .85 : .15 + .4 * v) * 255);
}

// Preview side.
const vite = await createServer({ root, appType: 'custom', logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
vite.middlewares.use('/__depth-check', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Depth parity</title>'); });
await vite.listen();
const browser = await chromium.launch({ headless: true, channel: browserExecutable() ? undefined : 'chrome', executablePath: browserExecutable(), args: JSON.parse(process.env.QA_BROWSER_ARGS || '[]') });
const preview = {};
let renderer = '';
try {
  const page = await browser.newPage();
  await page.goto(new URL('/__depth-check', vite.resolvedUrls.local[0]).href);
  for (const [name, params] of Object.entries(cases)) {
    const out = await page.evaluate(async ({ rgb, depth, params, options }) => {
      const { depthFxPixels } = await import('/src/services/depthFx.ts');
      const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
      const pixels = depthFxPixels(bytes(rgb), options.W, options.H, bytes(depth), options.w, options.h, params, { near: options.near, far: options.far, taps: options.taps });
      if (!pixels) throw new Error('WebGL2 with float render targets is not available in this browser.');
      let text = '';
      for (let i = 0; i < pixels.length; i += 32768) text += String.fromCharCode(...pixels.slice(i, i + 32768));
      return btoa(text);
    }, { rgb: Buffer.from(rgb).toString('base64'), depth: Buffer.from(depth).toString('base64'), params, options: { W, H, w, h, near, far, taps } });
    preview[name] = Buffer.from(out, 'base64');
  }
  renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'), info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
} finally { await browser.close(); await vite.close(); }

// Export side.
const work = mkdtempSync(join(tmpdir(), 'depth-parity-'));
const toPng = (data, format, width, height, path) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', format, '-s', `${width}x${height}`, '-i', '-', path], { input: data });
toPng(rgb, 'rgba', W, H, join(work, 'rgb.png'));
toPng(depth, 'gray', w, h, join(work, 'depth.png'));
const names = Object.keys(cases);
names.forEach((name, n) => writeFileSync(join(work, `params${n}.json`), JSON.stringify({ params: cases[name], near, far, taps })));
const python = process.env.FRAME_LINE_DEPTH_PYTHON || join(root, '.venv-mask', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const script = join(root, 'scripts', 'depth-fx.py');
let where;
try { execFileSync(python, ['-c', 'import torch, cv2'], { stdio: 'ignore' }); where = `local ${python}`; } catch { where = undefined; }
try {
  if (where) for (let n = 0; n < names.length; n++) execFileSync(python, [script, '--parity', join(work, `params${n}.json`), join(work, 'rgb.png'), join(work, 'depth.png'), join(work, `out${n}.png`)], { stdio: ['ignore', 'ignore', 'inherit'] });
  else {
    // ponytail: scp to a fixed scratch folder on the Dell; a configurable remote folder when there is a second host.
    const host = process.env.FRAME_LINE_DEPTH_PARITY_SSH || 'gpu-host', remote = 'C:/Users/jdoe/Desktop/depth-bench/parity';
    const remotePython = 'C:/Users/jdoe/Desktop/SharedCut/.venv-mask/Scripts/python.exe';
    where = `${host} ${remotePython}`;
    execFileSync('ssh', [host, `New-Item -ItemType Directory -Force ${remote} | Out-Null`], { stdio: 'inherit' });
    execFileSync('scp', ['-q', script, join(work, 'rgb.png'), join(work, 'depth.png'), ...names.map((_, n) => join(work, `params${n}.json`)), `${host}:${remote}/`], { stdio: 'inherit' });
    execFileSync('ssh', [host, names.map((_, n) => `& ${remotePython} ${remote}/depth-fx.py --parity ${remote}/params${n}.json ${remote}/rgb.png ${remote}/depth.png ${remote}/out${n}.png; if ($LASTEXITCODE) { exit 1 }`).join('; ')], { stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('scp', ['-q', ...names.map((_, n) => `${host}:${remote}/out${n}.png`), `${work}/`], { stdio: 'inherit' });
  }
  // Compare in 1/255 steps over RGB.
  let failed = false;
  console.log(`Preview: ${renderer}. Export: ${where}. ${W}x${H}, depth ${w}x${h}, N = ${taps}.`);
  names.forEach((name, n) => {
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', join(work, `out${n}.png`), '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-'], { maxBuffer: 64 << 20 });
    const exported = new Uint16Array(raw.buffer, raw.byteOffset, W * H * 3), web = preview[name], errors = new Float32Array(W * H * 3);
    let change = 0; // How much the effect moved the picture, so a pass is not two untouched copies agreeing.
    for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) { errors[p * 3 + c] = Math.abs(web[p * 4 + c] - exported[p * 3 + c] / 257); change += Math.abs(web[p * 4 + c] - rgb[p * 4 + c]); }
    const sorted = errors.slice().sort(), mean = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    const p99 = sorted[Math.floor(.99 * (sorted.length - 1))], max = sorted[sorted.length - 1], effect = change / errors.length, ok = mean < 1 && p99 < 4 && effect > 2;
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} mean ${mean.toFixed(3)}  p99 ${p99.toFixed(2)}  max ${max.toFixed(1)}  (/255; the effect moved pixels by ${effect.toFixed(1)})`);
  });
  if (failed) process.exitCode = 1;
} finally { rmSync(work, { recursive: true, force: true }); }
