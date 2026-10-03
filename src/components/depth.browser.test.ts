// Browser check for Depth (DepthInspector.tsx, depthPreview.ts, depthFx.ts): the depth map fills in, Lens blur softens
// only what is far, and the focus picker sets Focus from the picture. Uses the model-free synthetic depth engine
// (depth = source luma), so it needs python3 and ffmpeg but no torch.
// Run: node --experimental-strip-types --test src/components/depth.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-depth-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

type Box = [number, number, number, number];
/** Viewer pixels in a box given as fractions of the picture: mean RGB, and detail (standard deviation of luma; the
 *  checkers are the only structure, so blur is what lowers it). */
const probe = (page: Page, box: Box) => page.locator('.viewer-frame canvas').evaluate((element, [x0, y0, x1, y1]) => {
  const canvas = element as HTMLCanvasElement, left = Math.round(x0 * canvas.width), top = Math.round(y0 * canvas.height);
  const width = Math.round((x1 - x0) * canvas.width), height = Math.round((y1 - y0) * canvas.height), count = width * height;
  const data = canvas.getContext('2d')!.getImageData(left, top, width, height).data, mean = [0, 0, 0];
  let sum = 0, squares = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) mean[c] += data[i + c] / count;
    const luma = .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]; sum += luma; squares += luma * luma;
  }
  return { mean: mean.map(Math.round), detail: Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2)) };
}, box);

test('Depth: the map fills in, Lens blur softens only the far region, and the focus picker sets Focus', { timeout: 240000 }, async t => {
  let python = '';
  try { python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(); } catch { t.skip('python3 is not installed'); return; }
  const saved = { engine: process.env.FRAME_LINE_DEPTH_ENGINE, python: process.env.FRAME_LINE_DEPTH_PYTHON, floor: process.env.FRAME_LINE_DEPTH_MIN_FREE_GB };
  Object.assign(process.env, { FRAME_LINE_DEPTH_ENGINE: 'synthetic', FRAME_LINE_DEPTH_PYTHON: python, FRAME_LINE_DEPTH_MIN_FREE_GB: '.05' });
  const temp = await mkdtemp(join(tmpdir(), 'frameline-depth-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => {
    await context.close(); await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    for (const [key, value] of [['FRAME_LINE_DEPTH_ENGINE', saved.engine], ['FRAME_LINE_DEPTH_PYTHON', saved.python], ['FRAME_LINE_DEPTH_MIN_FREE_GB', saved.floor]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Depth Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('depth@example.test');
  await page.locator('input[type=password]').fill('Depth-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Depth');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  type View = { revision: number; state: { projects: { id: string }[]; timelines: { id: string }[]; media: { id: string; status: string }[]; clips: { id: string; effects: { name: string; parameters?: Record<string, number> }[] }[] } };
  const server = async () => (await (await context.request.get(`${url}/api/state`)).json()) as View;
  const { state: { projects: [{ id: project }], timelines: [{ id: timelineId }] } } = await server();

  // A bright checkered box in the middle (near: synthetic depth is luma) on a dark checkered surround (far).
  const video = join(temp, 'depth.mp4'), inside = 'between(X,160,479)*between(Y,90,269)', check = 'mod(floor(X/12)+floor(Y/12),2)';
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=24:d=3', '-vf',
    `format=rgb24,geq=r='${inside}*(255-25*${check})+(1-${inside})*(50-40*${check})':g='${inside}*(235-25*${check})+(1-${inside})*(50-40*${check})':b='${inside}*(60-20*${check})+(1-${inside})*(170-60*${check})'`,
    '-c:v', 'libx264', '-crf', '10', '-g', '24', '-pix_fmt', 'yuv420p', video]);
  const bytes = await readFile(video);
  assert.ok((await context.request.post(`${url}/api/media?projectId=${project}&id=depthsrc&name=depth.mp4&placeholder=1`)).ok());
  await context.request.post(`${url}/api/media/depthsrc/upload`, { data: { size: bytes.length, fingerprint: `depth.mp4:${bytes.length}:1` } });
  assert.equal((await context.request.put(`${url}/api/media/depthsrc/upload`, { headers: { 'upload-offset': '0', 'upload-checksum': createHash('sha256').update(bytes).digest('hex') }, data: bytes })).status(), 202);
  for (let i = 0; i < 600 && (await server()).state.media[0]?.status !== 'ready'; i++) await page.waitForTimeout(100);
  assert.equal((await server()).state.media[0].status, 'ready');
  for (let attempt = 0; ; attempt++) {
    const { revision } = await server();
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision, delta: { clips: { upsert: [{ id: 'shot', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: 'depthsrc', name: 'shot', start: 0, duration: 3, sourceIn: 0, color: '#4f8bb8', disabled: false, properties: {}, effects: [] }], remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the clip is saved: ${await patched.text()}`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole('combobox', { name: 'Preview quality' }).selectOption('Full');
  await page.locator('[data-clip="shot"]').first().click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Effects', exact: true }).click();

  // Adding Depth starts the analysis and shows the depth map (near white, far black) as it arrives.
  await page.getByRole('combobox', { name: 'Add clip effect' }).selectOption('Depth');
  assert.match(await page.locator('.depth-status').innerText(), /Starting depth analysis|Analyzing depth/);
  assert.equal(await page.getByRole('checkbox', { name: 'Show depth map' }).isChecked(), true, 'the map is on for a fresh effect');
  await page.locator('.depth-status', { hasText: 'Depth ready' }).waitFor({ timeout: 90000 });
  assert.ok(!(await page.getByRole('combobox', { name: 'Add clip effect' }).innerText()).includes('Depth'), 'one Depth per clip');
  const near: Box = [.42, .42, .58, .58], far: Box = [.04, .35, .16, .65];
  await page.waitForFunction(() => { const c = document.querySelector('.viewer-frame canvas') as HTMLCanvasElement, [r, g, b] = c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return r > 190 && Math.abs(r - g) < 6 && Math.abs(g - b) < 6; }, undefined, { timeout: 30000 });
  const mapNear = await probe(page, near), mapFar = await probe(page, far);
  assert.ok(mapNear.mean.every(v => v > 190) && Math.max(...mapNear.mean) - Math.min(...mapNear.mean) < 6, `near is white in the map: ${mapNear.mean}`);
  assert.ok(mapFar.mean.every(v => v < 70) && Math.max(...mapFar.mean) - Math.min(...mapFar.mean) < 6, `far is dark in the map: ${mapFar.mean}`);

  // The picture with every section off is the picture.
  await page.getByRole('checkbox', { name: 'Show depth map' }).uncheck();
  await page.waitForFunction(() => { const c = document.querySelector('.viewer-frame canvas') as HTMLCanvasElement, [r, , b] = c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return r - b > 120; }, undefined, { timeout: 15000 });
  const sharpNear = await probe(page, near), sharpFar = await probe(page, far);
  assert.ok(sharpNear.detail > 4 && sharpFar.detail > 2, `the checkers have detail: near ${sharpNear.detail}, far ${sharpFar.detail}`);

  // Lens blur on: Focus comes from the frame centre (the near box), so the surround blurs and the box stays sharp.
  const set = async (label: string, value: number) => { const input = page.getByRole('textbox', { name: `Depth ${label}`, exact: true }); await input.click(); await input.fill(String(value)); await input.press('Enter'); };
  await set('Depth of field', 60);
  await set('Lens blur', 100);
  const parameters = async () => (await server()).state.clips.find(c => c.id === 'shot')!.effects.find(e => e.name === 'Depth')!.parameters ?? {};
  let focus: number | undefined;
  for (let i = 0; i < 100 && (focus = (await parameters()).focus) === undefined; i++) await page.waitForTimeout(100);
  assert.ok(focus !== undefined && focus < 26, `Focus follows the frame centre when Lens blur first turns on: ${focus}`);
  let blurredFar = await probe(page, far);
  for (let i = 0; i < 100 && blurredFar.detail > sharpFar.detail * .35; i++) { await page.waitForTimeout(100); blurredFar = await probe(page, far); }
  const blurredNear = await probe(page, near);
  t.diagnostic(`map near ${mapNear.mean} far ${mapFar.mean}; detail near ${sharpNear.detail.toFixed(1)} → ${blurredNear.detail.toFixed(1)}, far ${sharpFar.detail.toFixed(1)} → ${blurredFar.detail.toFixed(1)}; centre focus ${focus}`);
  assert.ok(blurredFar.detail < sharpFar.detail * .35, `far loses its detail: ${sharpFar.detail.toFixed(2)} → ${blurredFar.detail.toFixed(2)}`);
  assert.ok(blurredNear.detail > sharpNear.detail * .8, `near keeps its detail: ${sharpNear.detail.toFixed(2)} → ${blurredNear.detail.toFixed(2)}`);

  // Focus picker: one click on the far surround focuses there.
  await page.getByRole('button', { name: 'Pick focus in the viewer' }).click();
  const frame = (await page.locator('.viewer-frame canvas').boundingBox())!;
  await page.getByRole('button', { name: 'Set focus here' }).click({ position: { x: frame.width * .1, y: frame.height * .5 } });
  for (let i = 0; i < 50 && ((await parameters()).focus ?? 0) < 60; i++) await page.waitForTimeout(100);
  assert.ok(((await parameters()).focus ?? 0) >= 60, `the picker focuses on the far surround: ${(await parameters()).focus}`);
  assert.equal(await page.getByRole('button', { name: 'Set focus here' }).count(), 0, 'one click, then the picker disarms');
  assert.deepEqual(errors, []);
});
