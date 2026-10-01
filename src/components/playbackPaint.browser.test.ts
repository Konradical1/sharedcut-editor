// Browser regression: playback must not write to the page's layout every frame (LiveTimecode, LocalPlayhead).
// A per-frame text or style change re-ran layout, hover hit testing and compositing for the whole page.
// Run: node --experimental-strip-types --test src/components/playbackPaint.browser.test.ts
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

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-paint-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('playing moves the playhead and both timecodes without per-frame DOM writes, and pausing restores plain text', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-paint-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Paint Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('paint@example.test');
  await page.locator('input[type=password]').fill('Paint-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Paint playback');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  // A title gives the timeline something to play through.
  await page.getByRole('tab', { name: 'Titles' }).click(); await page.locator('button[aria-label^="Add "][aria-label$=" title"]').first().click(); await page.locator('.text-box').first().waitFor();
  await page.locator('.timeline-track-heading').first().click(); await page.keyboard.press('Home');
  const paused = await page.locator('.transport-time').innerText();
  assert.match(paused, /^\d\d:\d\d:\d\d:\d\d$/);

  await page.getByRole('button', { name: 'Play playback', exact: true }).click();
  await page.locator('.transport-time canvas').waitFor();
  await page.locator('.local-playhead-canvas').waitFor();
  // The moving playhead's pixels: its canvas is presented on its own, so look at what reaches the screen.
  const drawnAt = () => page.locator('.local-playhead-canvas').screenshot();
  const x0 = await drawnAt(), time0 = await page.locator('.transport-time').textContent();
  // Watch the editor for a second of playback: only canvas fallback text may change, and nothing animates.
  await page.evaluate(() => {
    const w = window as unknown as { writes: string[] }; w.writes = [];
    new MutationObserver(list => { for (const m of list) { const target = m.target instanceof Element ? m.target : m.target.parentElement; if (target?.closest('canvas')) continue; w.writes.push(`${m.type}:${m.attributeName ?? ''}:${target?.className}`); } })
      .observe(document.querySelector('.editor-main')!, { subtree: true, attributes: true, characterData: true, childList: true, attributeFilter: ['style', 'class', 'data-text'] });
  });
  await page.waitForTimeout(1000);
  const writes = await page.evaluate(() => (window as unknown as { writes: string[] }).writes.filter(w => /playhead|time|transport/.test(w)));
  const x1 = await drawnAt(), time1 = await page.locator('.transport-time').textContent();
  // A running animation (even one on the compositor) makes every frame recalculate style and intersection observers.
  const running = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').map(a => (a.effect as KeyframeEffect | null)?.target?.className));
  assert.deepEqual(writes, [], 'no per-frame style or text writes to the playhead or the timecodes');
  assert.deepEqual(running, [], 'nothing animates while playing');
  assert.ok(!x0.equals(x1), 'the drawn playhead moves');
  assert.equal(await page.locator('.local-playhead').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  assert.notEqual(time1, time0, 'the timecode keeps counting (canvas fallback text)');
  assert.match(time1 ?? '', /^\d\d:\d\d:\d\d:\d\d$/);

  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.transport-time canvas') && !document.querySelector('.local-playhead-canvas'));
  const stopped = await page.locator('.transport-time').innerText();
  assert.match(stopped, /^\d\d:\d\d:\d\d:\d\d$/);
  assert.equal(await page.locator('.timeline-time').innerText(), stopped);
  const head = page.locator('.local-playhead');
  assert.equal(await head.evaluate(el => getComputedStyle(el).visibility), 'visible');
  assert.ok(await head.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41) > 0, 'paused, the playhead element takes over where playback stopped');
});
