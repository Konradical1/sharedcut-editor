import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFrameLineServer } from '../server/index.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp = await mkdtemp(join(tmpdir(), 'frameline-presence-'));
const app = createFrameLineServer({ dataDir: temp, distDir: resolve('dist') });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
const errors = [];
try {
  const owner = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const peer = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  for (const [context, name] of [[owner, 'Owner'], [peer, 'Peer']]) {
    const response = await context.request.post(`${url}/api/auth/signup`, { data: { name, email: `${name}@example.test`, password: 'Presence-regression-2026' } });
    assert.equal(response.status(), 201);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  }
  const page = await owner.newPage();
  let networkMode = 'normal', packet = 0, hung = false, recovered = false;
  await page.route('**/api/presence', async route => {
    if (networkMode === 'delayed') {
      const response = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, [0, 35, 120][packet++ % 3]));
      await route.fulfill({ response });
    } else if (networkMode === 'stalled' && !hung) {
      hung = true;
    } else {
      if (networkMode === 'stalled') recovered = true;
      await route.continue();
    }
  });
  // Real LAN computers need not agree on wall-clock time.
  await page.addInitScript(() => { const realNow = Date.now; Date.now = () => realNow() + 120_000; });
  await page.goto(url);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Presence regression');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Add Rectangle shape', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  const projectUrl = page.url();
  const second = await peer.newPage();
  await second.goto(projectUrl);
  const field = second.getByRole('textbox', { name: 'Shape Position X', exact: true });
  await field.hover();
  const visible = () => page.waitForFunction(() => {
    const node = document.querySelector('[data-remote-user]');
    return node?.style.opacity === '1' && node.querySelector('.remote-cursor').style.visibility === 'visible';
  });
  await visible();
  const stableFrames = async () => {
    const frames = await page.evaluate(() => new Promise(resolve => {
      const frames = [], until = performance.now() + 1500;
      const sample = now => {
        const node = document.querySelector('[data-remote-user]');
        frames.push(node?.style.opacity === '1' && node.style.display === 'block' && node.querySelector('.remote-cursor').style.visibility === 'visible' && node.querySelector('.remote-panel-glow').style.display === 'block');
        if (now < until) requestAnimationFrame(sample); else resolve(frames);
      };
      requestAnimationFrame(sample);
    }));
    assert.ok(frames.length > 20);
    assert.ok(frames.every(Boolean), `Cursor/panel flickered in ${frames.filter(value => !value).length}/${frames.length} frames.`);
  };
  // Both people hovering the same control must not interfere with hit testing.
  await page.getByRole('textbox', { name: 'Shape Position X', exact: true }).hover();
  await stableFrames();
  console.log('PASS two accounts, overlapping cursors and a two-minute clock offset');

  const background = await peer.newPage();
  await background.addInitScript(() => { document.hasFocus = () => false; });
  await background.goto(projectUrl);
  await background.getByRole('textbox', { name: 'Shape Position X', exact: true }).waitFor();
  networkMode = 'delayed';
  await stableFrames();
  await field.fill('23'); await field.blur(); await field.hover();
  await page.waitForFunction(() => document.querySelector('#shape-x')?.value === '23');
  await stableFrames();
  await background.close();
  await stableFrames();
  console.log('PASS background tab heartbeats/closure and real shared edits under uneven packets');
  assert.ok(packet > 4, 'The delay simulation must intercept real presence requests.');

  // A request which never returns must time out and allow the next heartbeat.
  networkMode = 'stalled';
  const deadline = Date.now() + 15_000;
  while (!recovered && Date.now() < deadline) await page.waitForTimeout(100);
  assert.ok(recovered, 'A stalled request must not permanently stop presence polling.');
  networkMode = 'normal';
  await visible();
  await stableFrames();
  await second.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  await page.waitForFunction(() => document.querySelector('[data-remote-user]')?.style.opacity === '0');
  assert.deepEqual(errors, []);
  console.log('PASS stalled-request recovery and immediate inactive-window withdrawal');
} finally {
  await browser.close(); await app.close(); await rm(temp, { recursive: true, force: true });
}
