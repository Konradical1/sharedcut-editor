// Browser check: video and image files dropped from the desktop straight onto a timeline lane upload, show a ghost, and
// land where they were dropped at their real length (the clip's own, a still's default) once the server has them ready.
// Run: node --experimental-strip-types --test src/components/timelineDrop.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-drop-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('files dropped on a lane upload and land there at their real length', { timeout: 240000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-drop-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', clip = join(temp, 'Drop clip.mp4'), still = join(temp, 'Drop still.png');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3.5', '-pix_fmt', 'yuv420p', clip]);
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=320x180', '-frames:v', '1', still]);

  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Drop Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('drop@example.test');
  await page.locator('input[type=password]').fill('Drop-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Drop');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const lane = page.locator('.track-lane').first();
  await lane.waitFor();

  const drop = async (path: string, name: string, type: string, time: number) => {
    const box = (await lane.boundingBox())!, span = Number(await lane.getAttribute('data-time-span'));
    const data = await page.evaluateHandle(({ bytes, name, type }) => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], name, { type })); return d; }, { bytes: (await readFile(path)).toString('base64'), name, type });
    const at = { dataTransfer: data, clientX: box.x + time * box.width / span, clientY: box.y + box.height / 2 };
    await lane.dispatchEvent('dragover', at);
    await lane.dispatchEvent('drop', at);
  };
  const saved = async (name: string) => {
    for (let i = 0; i < 900; i++) {
      const found = (await (await context.request.get(`${url}/api/state`)).json()).state.clips.find((c: { name: string }) => c.name === name);
      if (found) return found as { start: number; duration: number; trackId: string };
      await page.waitForTimeout(100);
    }
    assert.fail(`${name} never landed on the timeline`);
  };

  await drop(clip, 'Drop clip.mp4', 'video/mp4', 2);
  await page.locator('.timeline-drop-ghost', { hasText: 'Drop clip.mp4' }).waitFor();
  const ghost = await page.locator('.timeline-drop-ghost', { hasText: 'Drop clip.mp4' }).boundingBox(), box = (await lane.boundingBox())!, span = Number(await lane.getAttribute('data-time-span'));
  assert.ok(Math.abs(ghost!.width - 3.5 * box.width / span) < 4, `the ghost is the clip's length as the browser reads it: ${ghost!.width}px`);
  const video = await saved('Drop clip.mp4');
  assert.ok(Math.abs(video.start - 2) < .05, `lands where dropped: ${video.start}`);
  assert.ok(Math.abs(video.duration - 3.5) < .05, `at the file's real length: ${video.duration}`);
  await page.locator('.timeline-drop-ghost', { hasText: 'Drop clip.mp4' }).waitFor({ state: 'detached' });

  await drop(still, 'Drop still.png', 'image/png', 8);
  const image = await saved('Drop still.png');
  assert.ok(Math.abs(image.start - 8) < .05 && image.duration === 5, `a still lands at the default still length: ${image.start} ${image.duration}`);
  assert.deepEqual(errors, []);
});
