import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFrameLineServer } from '../server/index.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp = await mkdtemp(join(tmpdir(), 'sharedcut-progress-'));
const app = createFrameLineServer({ dataDir: join(temp, 'data') });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const ffmpeg = (...args) => promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', ...args]);
try {
  await mkdir(resolve('artifacts/qa'), { recursive: true });
  const video = join(temp, 'Green footage.mp4'), image = join(temp, 'Blue image.png');
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=0x20c060:s=640x360:r=24:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video);
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=640x360', '-frames:v', '1', image);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Import Check');
  await page.getByRole('textbox', { name: 'Email address' }).fill('imports@example.test');
  await page.locator('input[type=password]').fill('local thumbnail check 2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Import progress check');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Upload media files').waitFor({ state: 'attached' });
  // Hold original bytes until the small preview has arrived through the real upload endpoint.
  let releaseUpload;
  let uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  await page.route('**/api/media/*/upload', async route => { if (route.request().method() === 'PUT') await uploadGate; await route.continue(); });
  for (const [file, name, channel] of [[video, 'Green footage.mp4', 1], [image, 'Blue image.png', 2]]) {
    await page.getByLabel('Upload media files').setInputFiles(file);
    const card = page.getByRole('button', { name: `Select media ${name}`, exact: true });
    await card.locator('.media-state-icon.uploading').waitFor();
    await card.locator('img').waitFor();
    await card.locator('img').evaluate(img => img.decode());
    assert.match(await card.locator('img').getAttribute('src'), /^\/api\/media\/.+\/files\/thumbnail.jpg$/);
    const rgb = await card.locator('img').evaluate(img => { const canvas = document.createElement('canvas'); canvas.width=1;canvas.height=1; const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]; });
    assert.ok(rgb[channel] > 160 && rgb[channel] > rgb[(channel + 1) % 3] + 60, `${name} displays its own pixels during upload: ${rgb}`);
    await page.screenshot({ path: resolve(`artifacts/qa/${channel === 1 ? 'video' : 'image'}-upload-preview.png`) });
    releaseUpload();
    await card.locator('.media-state-icon.ready').waitFor({ timeout: 45000 });
    assert.equal(await card.locator('.media-progress').count(), 0, 'Completed upload updates in place without reload.');
    uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  }
  releaseUpload();
  if (process.env.FRAME_LINE_LIVE_LINK_CHECK === '1') {
    await page.getByRole('button', { name: 'Add media', exact: true }).click();
    await page.getByLabel('YouTube video or Spotify track link').fill('https://youtu.be/jNQXAC9IVRw');
    await page.getByLabel('Maximum quality').selectOption('720');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add media' }).waitFor({ state: 'hidden' });
    const poster = page.locator('.media-scrub-thumbnail img[src="https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg"]');
    await poster.waitFor(); await poster.evaluate(img => img.decode());
    const card = poster.locator('xpath=ancestor::*[contains(@class,"media-asset")][1]');
    assert.ok(await card.locator('.media-state-icon.downloading').count(), 'The real YouTube poster appears before download completion.');
    await page.screenshot({ path: resolve('artifacts/qa/youtube-downloading-preview.png') });
    await card.locator('.media-state-icon.ready').waitFor({ timeout: 180000 });
    assert.equal(await card.locator('.media-progress').count(), 0);
    console.log('PASS live YouTube poster and download completion without reload');
  }
  assert.deepEqual(errors, []);
  console.log('PASS video and image previews during upload; both become ready without reload');
} finally { await browser.close(); await app.close(); await rm(temp, { recursive: true, force: true }); }
