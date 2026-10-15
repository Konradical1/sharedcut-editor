// Browser check: Grab still beside play saves the frame as a full-size PNG in the Stills bin, and Download hands it back.
// A frame the server cannot render alone (optical flow) saves the viewer's own picture instead. Needs FFmpeg.
// Run: node --experimental-strip-types --test src/components/grabStill.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import type { Clip, MediaAsset, Project, Timeline } from '../state/models.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)), ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ready = (() => { try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  if (!ready) return;
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-still-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

/** Width and height from a PNG's IHDR. */
const pngSize = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

test('Grab still saves a full-size PNG to Stills and Download returns it', { timeout: 240000, skip: !ready && 'needs FFmpeg' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-still-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 10 }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Still Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('stills@example.test');
  await page.locator('input[type=password]').fill('Stills-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Stills');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  type View = { revision: number; state: { projects: Project[]; timelines: Timeline[]; media: MediaAsset[]; clips: Clip[] } };
  const server = async () => (await (await context.request.get(`${url}/api/state`)).json()) as View;
  const { state: { projects: [project], timelines: [timeline] } } = await server();

  const video = join(temp, 'red.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc82828:s=640x360:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const bytes = await readFile(video);
  assert.ok((await context.request.post(`${url}/api/media?projectId=${project.id}&id=red&name=red.mp4&placeholder=1`)).ok());
  await context.request.post(`${url}/api/media/red/upload`, { data: { size: bytes.length, fingerprint: `red.mp4:${bytes.length}:1` } });
  assert.equal((await context.request.put(`${url}/api/media/red/upload`, { headers: { 'upload-offset': '0', 'upload-checksum': createHash('sha256').update(bytes).digest('hex') }, data: bytes })).status(), 202);
  for (let i = 0; i < 600 && (await server()).state.media[0]?.status !== 'ready'; i++) await page.waitForTimeout(100);
  const save = async (properties: Clip['properties']) => {
    for (let attempt = 0; ; attempt++) {
      const { revision } = await server();
      const clip = { id: 'shot', projectId: project.id, timelineId: timeline.id, trackId: `${project.id}-v1`, mediaId: 'red', name: 'Shot', start: 0, duration: 3, sourceIn: 0, color: '#4f8bb8', disabled: false, properties, effects: [] };
      const patched = await context.request.patch(`${url}/api/state`, { data: { revision, delta: { clips: { upsert: [clip], remove: [] } } } });
      if (patched.ok()) return;
      assert.ok(patched.status() === 409 && attempt < 10, `the clip is saved: ${await patched.text()}`);
      await page.waitForTimeout(100);
    }
  };
  await save({});
  await page.reload();
  const stills = async () => (await server()).state.media.filter(m => m.binId === 'stills');
  const grab = async (count: number) => {
    await page.getByRole('button', { name: 'Grab still' }).click();
    await page.getByText('Still saved to Media').last().waitFor({ timeout: 90000 });
    for (let i = 0; i < 300 && (await stills()).filter(m => m.status === 'ready').length < count; i++) await page.waitForTimeout(100);
    const list = await stills();
    assert.equal(list.length, count, 'one more still');
    assert.ok(list.every(m => m.kind === 'image' && m.status === 'ready'), `ready images: ${JSON.stringify(list.map(m => [m.name, m.status, m.error]))}`);
    return list[0];
  };

  // Rendered like Export: the project's own size, and the red frame.
  const still = await grab(1);
  assert.equal(still.name, `${timeline.name} 00.00.00.00.png`);
  await page.getByRole('combobox', { name: 'Folder' }).locator('option', { hasText: 'Stills · 1' }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: `Select media ${still.name}` }).click({ button: 'right' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download' }).click()]);
  assert.equal(download.suggestedFilename(), still.name);
  const png = await readFile(await download.path());
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
  assert.deepEqual(pngSize(png), project.resolution.split(' × ').map(Number), 'at the project size');
  const pixel = execFileSync(ffmpeg, ['-v', 'error', '-i', await download.path(), '-vf', 'crop=2:2:iw/2:ih/2', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.ok(pixel[0] > 150 && pixel[1] < 90 && pixel[2] < 90, `the red frame: ${[...pixel]}`);

  // Optical flow bakes whole clips, so the server skips it: the viewer's picture is saved instead, still in Stills.
  await save({ opticalFlow: true });
  await page.reload();
  await page.locator('canvas[aria-label="Timeline picture"]').waitFor();
  await page.waitForTimeout(1500);
  const fallback = await grab(2);
  await page.getByText(/Saved at viewer size/).waitFor();
  const viewer = await (await context.request.get(`${url}/api/media/${fallback.id}/original`)).body();
  assert.ok(pngSize(viewer)[0] <= 1920, `viewer sized: ${pngSize(viewer)}`);
  assert.deepEqual(errors, []);
});
