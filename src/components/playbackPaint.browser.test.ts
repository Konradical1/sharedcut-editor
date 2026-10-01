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

async function openProject(t: { after: (fn: () => Promise<void>) => void }) {
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
  return page;
}
const seconds = (text: string | null) => { const [h, m, s, f] = (text ?? '').split(':').map(Number); return h * 3600 + m * 60 + s + f / 30; };

test('playing moves the playhead and both timecodes without per-frame DOM writes, and pausing restores plain text', async t => {
  const page = await openProject(t);
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

  // Crossing the 1250 px breakpoint mid-playback shrinks the transport font: the canvas follows its box.
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForFunction(() => { const e = document.querySelector('.transport-time')!, r = e.getBoundingClientRect(), c = e.querySelector('canvas'); return c && c.width === Math.round(r.right) - Math.round(r.left) && c.height === Math.round(r.bottom) - Math.round(r.top); }, null, { timeout: 2000 });
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.transport-time canvas') && !document.querySelector('.local-playhead-canvas'));
  const stopped = await page.locator('.transport-time').innerText();
  assert.match(stopped, /^\d\d:\d\d:\d\d:\d\d$/);
  assert.equal(await page.locator('.timeline-time').innerText(), stopped);
  const head = page.locator('.local-playhead');
  assert.equal(await head.evaluate(el => getComputedStyle(el).visibility), 'visible');
  assert.ok(await head.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41) > 0, 'paused, the playhead element takes over where playback stopped');
});

test('zoomed in, the playing playhead stops drawing once it leaves the view', async t => {
  // Redrawing the off-screen strip every picture stalled the GPU process ~100 ms every few seconds (zoomed to 30 frames).
  const page = await openProject(t);
  await page.locator('.timeline-zoom button', { hasText: '30f' }).click();
  await page.locator('.timeline-track-heading').first().click(); await page.keyboard.press('Home');
  await page.evaluate(() => {
    const w = window as unknown as { draws: number }, fill = CanvasRenderingContext2D.prototype.fillRect; w.draws = 0;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) { if (this.canvas.classList.contains('local-playhead-canvas')) w.draws++; return fill.apply(this, args); };
  });
  await page.getByRole('button', { name: 'Play playback', exact: true }).click();
  await page.locator('.local-playhead-canvas').waitFor();
  const draws = () => page.evaluate(() => (window as unknown as { draws: number }).draws);
  await page.waitForFunction(() => (window as unknown as { draws: number }).draws > 0);
  // Thirty frames fill the view: after two seconds of playback the line is well past its right edge.
  await page.waitForFunction(() => { const [h, m, s, f] = (document.querySelector('.transport-time')?.textContent ?? '').split(':').map(Number); return h * 3600 + m * 60 + s + f / 30 > 2; });
  const before = await draws(), left = await page.locator('.local-playhead-canvas').evaluate(e => (e as HTMLElement).style.left);
  await page.waitForTimeout(500);
  const time = seconds(await page.locator('.transport-time').textContent());
  assert.ok(time > 2.4, `still playing (${time} s)`);
  assert.equal(await draws(), before, 'no drawing while the playhead is off screen');
  assert.equal(await page.locator('.local-playhead-canvas').evaluate(e => (e as HTMLElement).style.left), left, 'the strip holds still');
  assert.ok(await page.locator('.local-playhead-canvas').evaluate(e => { const c = e as HTMLCanvasElement; return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.every((v, i) => i % 4 !== 3 || v === 0); }), 'the strip is left empty');
});

type Counts = { reads: number; pictures: number; scrubText: number; scrubAttributes: number };
test('Color workspace playback reads no pixels back on the main thread and steps the scrub once per picture', async t => {
  const page = await openProject(t);
  await page.getByRole('navigation', { name: 'Editor workspaces' }).getByRole('button', { name: 'Color', exact: true }).click();
  const scope = page.locator('.scope-display canvas'), viewer = page.locator('.viewer-frame canvas');
  const revision = (locator: typeof scope) => locator.evaluate(e => (e as HTMLElement).dataset.frameRevision ?? '');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.scope-display canvas')?.dataset.frameRevision);
  await page.evaluate(() => {
    const w = window as unknown as Counts, read = CanvasRenderingContext2D.prototype.getImageData;
    Object.assign(w, { reads: 0, pictures: 0, scrubText: 0, scrubAttributes: 0 });
    CanvasRenderingContext2D.prototype.getImageData = function (...args) { w.reads++; return read.apply(this, args); };
    addEventListener('frameline:playback-health', e => { if ((e as CustomEvent<{ playing: boolean }>).detail.playing) w.pictures++; });
    new MutationObserver(list => { for (const m of list) if (m.type === 'attributes') w.scrubAttributes++; else w.scrubText++; })
      .observe(document.querySelector('.color-scrub')!, { subtree: true, attributes: true, characterData: true, childList: true, attributeFilter: ['aria-valuetext', 'value'] });
  });
  await page.getByRole('button', { name: 'Play playback', exact: true }).click();
  const scopeAt = await revision(scope);
  await page.waitForTimeout(300);
  await page.evaluate(() => Object.assign(window, { reads: 0, pictures: 0, scrubText: 0, scrubAttributes: 0 }));
  await page.waitForTimeout(1200);
  const counts = await page.evaluate(() => { const w = window as unknown as Counts; return { reads: w.reads, pictures: w.pictures, scrubText: w.scrubText, scrubAttributes: w.scrubAttributes }; });
  assert.ok(counts.pictures > 5, JSON.stringify(counts));
  assert.equal(counts.reads, 0, 'the scope reads frames back off the main thread while playing');
  assert.notEqual(await revision(scope), scopeAt, 'the scope keeps following the picture');
  assert.equal(counts.scrubAttributes, 0, 'no React render of the scrub per store tick');
  assert.ok(counts.scrubText <= counts.pictures + 1, `scrub text written once per picture at most (${JSON.stringify(counts)})`);
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  // Paused, the scope is plotted at once from the picture shown.
  await page.waitForFunction(() => { const a = document.querySelector<HTMLElement>('.viewer-frame canvas')?.dataset.frameRevision, b = document.querySelector<HTMLElement>('.scope-display canvas')?.dataset.frameRevision; return a && a === b; });
  assert.equal(await revision(scope), await revision(viewer));
  assert.equal(await page.locator('.color-scrub .mono').innerText(), await page.locator('.transport-time').innerText(), 'the scrub timecode shows where playback stopped');
});
