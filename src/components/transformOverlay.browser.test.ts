// Browser check: footage and stills get a bounding box on the viewer that moves, scales and undoes in one step.
// Run: node --experimental-strip-types --test src/components/transformOverlay.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { chromium, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-transform-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('a still is selected, moved, undone and scaled from its box on the viewer', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-transform-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Transform Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('transform@example.test');
  await page.locator('input[type=password]').fill('Transform-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Transform');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();

  // A square still at half size: letterboxed, then centred in a 16:9 frame with room around it.
  const image = createCanvas(36, 36), drawing = image.getContext('2d'); drawing.fillStyle = '#3388ff'; drawing.fillRect(0, 0, 36, 36);
  await page.getByLabel('Upload media files').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: await image.encode('png') });
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).state.media.some((m: { name: string; status: string }) => m.name === 'square.png' && m.status === 'ready'));
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), project = view.state.projects[0].id, timelineId = view.state.timelines[0].id;
    const upsert = [{ id: 'still', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: view.state.media[0].id, name: 'still', start: 0, duration: 4, sourceIn: 0, color: '#467879', disabled: false, properties: { x: 0, y: 0, zoom: 50 }, effects: [] }];
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert, remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the scene is saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  const svg = page.locator('.transform-overlay svg'), box = page.getByRole('button', { name: 'Select clip: still' });
  await box.waitFor();
  const frame = (await svg.boundingBox())!, scale = 1920 / frame.width, cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
  const still = async () => { await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved'); return (await (await context.request.get(`${url}/api/state`)).json()).state.clips.find((c: { id: string }) => c.id === 'still').properties; };

  // Clicking the letterbox beside the still selects nothing; clicking the picture selects it.
  await page.mouse.click(frame.x + 10, cy);
  assert.equal(await box.getAttribute('aria-pressed'), 'false');
  await page.mouse.click(cx, cy);
  assert.equal(await box.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Scale clip' }).count(), 4, 'four corner handles');

  // Alt holds snapping off so the drag lands exactly where the pointer went.
  await page.keyboard.down('Alt');
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 40, { steps: 8 }); await page.mouse.up();
  await page.keyboard.up('Alt');
  const moved = await still();
  assert.ok(Math.abs(moved.x - 80 * scale) < 2 && Math.abs(moved.y - 40 * scale) < 2, `moved to ${moved.x}, ${moved.y}, wanted ${80 * scale}, ${40 * scale}`);

  await page.keyboard.press('ControlOrMeta+z');
  const undone = await still();
  assert.deepEqual([undone.x, undone.y], [0, 0], 'one Undo takes back both axes');

  // Dragging a corner twice as far from the centre doubles the zoom.
  const corner = (await page.getByRole('button', { name: 'Scale clip' }).first().boundingBox())!, hx = corner.x + corner.width / 2, hy = corner.y + corner.height / 2;
  await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(cx - (cx - hx) * 2, cy - (cy - hy) * 2, { steps: 8 }); await page.mouse.up();
  const scaled = await still();
  assert.ok(Math.abs(scaled.zoom - 100) < 2, `zoom ${scaled.zoom}, wanted 100`);
  assert.deepEqual(errors, []);
});
