// Browser check for Noise Reduction in the viewer (denoisePreview.ts, playback.ts, NoiseReductionInspector.tsx): with the effect
// on a clip the viewer asks the server for the chunk under the playhead, plays the ready chunk in place of the proxy, and
// "Show removed noise" asks for the removed-noise view. The worker is the stand-in in server/denoise.fixture.ts (frames pass
// through), so it needs ffmpeg but no torch.
// Run: node --experimental-strip-types --test src/components/denoise.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import { useDenoiseStandIn } from '../../server/denoise.fixture.ts';
import type { MediaAsset } from '../state/models.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-denoise-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('Noise Reduction: the viewer asks for the chunk under the playhead, plays it once ready, and Show removed noise asks for the noise view', { timeout: 180000 }, async t => {
  const saved = { python: process.env.FRAME_LINE_DENOISE_PYTHON, worker: process.env.FRAME_LINE_DENOISE_WORKER };
  const temp = await mkdtemp(join(tmpdir(), 'frameline-denoise-browser-'));
  useDenoiseStandIn(temp);
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  const posts: { chunk: number; quality: string; view: string; settings: Record<string, number> }[] = [], chunks: string[] = [], native: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/denoise') posts.push(request.postDataJSON());
    const chunk = /\/api\/denoise\/([a-f0-9]{64})\/files\/video\.mp4/.exec(request.url())?.[1];
    if (chunk && !chunks.includes(chunk)) chunks.push(chunk);
    // Read by a <video> element rather than the WebCodecs worker.
    if (chunk && request.resourceType() === 'media') native.push(chunk);
  });
  t.after(async () => {
    await context.close(); await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    for (const [key, value] of [['FRAME_LINE_DENOISE_PYTHON', saved.python], ['FRAME_LINE_DENOISE_WORKER', saved.worker]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Noise Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('noise@example.test');
  await page.locator('input[type=password]').fill('Noise-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Noise');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();

  // Grey with heavy temporal noise, 3 s at 24 fps: chunks 0 (frames 0-47) and 1.
  const source = join(temp, 'noisy.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=480x270:r=24:d=3', '-vf', 'noise=alls=28:allf=t', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  await page.getByLabel('Upload media files').setInputFiles(source);
  let asset: MediaAsset | undefined;
  for (let i = 0; i < 240 && !asset; i++) { asset = (await (await context.request.get(`${url}/api/state`)).json()).state.media.find((m: MediaAsset) => m.status === 'ready' && !m.preparationStage); if (!asset) await page.waitForTimeout(250); }
  assert.ok(asset, 'the upload is prepared');
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), project = view.state.projects[0].id, timelineId = view.state.timelines[0].id;
    const clip = { id: 'shot', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: asset.id, name: 'shot', start: 0, duration: 3, sourceIn: 0, color: '#4f8bb8', disabled: false, properties: {}, effects: [] };
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert: [clip], remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the clip is saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole('combobox', { name: 'Preview quality', exact: true }).selectOption('Full');
  await page.locator('[data-clip="shot"]').first().click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Effects', exact: true }).click();
  await page.getByRole('combobox', { name: 'Add clip effect' }).selectOption('Noise Reduction');

  // The chunk under the playhead (source second 0) is asked for with the panel's settings, becomes ready and is decoded.
  const ready = async (count: number) => {
    await page.locator('.viewer-demo-note', { hasText: 'Noise Reduction · Ready' }).waitFor({ timeout: 60000 });
    for (let i = 0; i < 120 && chunks.length < count; i++) await page.waitForTimeout(250);
    assert.ok(chunks.length >= count, `chunk file ${count} is streamed to the viewer`);
  };
  await ready(1);
  assert.deepEqual(posts[0], { clipId: 'shot', chunk: 0, quality: 'Full', view: 'denoised', settings: { amount: 50, chroma: 60, frames: 2, spatial: 50, detail: 30 } });
  assert.equal(await page.locator('.depth-inspector .depth-status').innerText(), 'Ready', 'the Inspector panel shows the same status');
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.viewer-frame canvas')?.dataset.hasPicture === 'true');
  assert.ok(!posts.some(p => p.view === 'noise'));

  // Show removed noise asks for the noise view of the same chunk, a new file, and the viewer plays that one.
  await page.getByRole('checkbox', { name: 'Show removed noise' }).check();
  await ready(2);
  assert.deepEqual(posts.filter(p => p.view === 'noise').map(p => p.chunk).slice(0, 1), [0]);

  // Reversed, the chunk is decoded natively: its own element loads it (it used to wait for a load nothing started).
  const view = await (await context.request.get(`${url}/api/state`)).json(), shot = view.state.clips.find((c: { id: string }) => c.id === 'shot');
  const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert: [{ ...shot, properties: { ...shot.properties, reverse: true }, effects: shot.effects.map((e: { name: string }) => e.name === 'Noise Reduction' ? { ...e, amount: 70 } : e) }], remove: [] } } } });
  assert.ok(patched.ok(), await patched.text());
  await page.reload();
  await page.getByRole('combobox', { name: 'Preview quality', exact: true }).selectOption('Full');
  await page.locator('.viewer-demo-note', { hasText: 'Noise Reduction · Ready' }).waitFor({ timeout: 60000 });
  const reversed = posts.filter(p => p.settings.amount === 70).map(p => p.chunk);
  assert.equal(reversed[0], 1, 'reversed, the playhead starts on the last chunk');
  for (let i = 0; i < 120 && !native.some(key => !chunks.slice(0, 2).includes(key)); i++) await page.waitForTimeout(250);
  assert.ok(native.some(key => !chunks.slice(0, 2).includes(key)), 'the reversed clip\'s chunk is loaded by its video element');
  assert.deepEqual(errors, []);
});
