// Browser regression: playback must not write to the page's layout every frame (LiveTimecode, LocalPlayhead, RemotePlayhead).
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
import { chromium, request, type Browser, type BrowserContext } from 'playwright';
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

async function openProject(t: { after: (fn: () => Promise<void>) => void }, prepare?: (context: BrowserContext, url: string) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-paint-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await prepare?.(context, url);
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

type Remote = { userId: string; projectId: string; timelineId: string; from: number; startedAt: number; playing: boolean; sentStill?: boolean };
/** Plays a collaborator in this page alone: the presence the server relays (event stream and replies) gains `window.remote`. */
function fakeCollaborator() {
  const w = window as unknown as { remote?: Remote };
  let real: { userId: string }[] = [], listener: ((event: MessageEvent) => void) | undefined;
  const person = (r: Remote) => ({ userId: r.userId, projectId: r.projectId, timelineId: r.timelineId, cursor: null, activity: 'edit', online: true, updatedAt: Date.now(), playing: r.playing,
    playhead: r.from + (r.playing ? (Date.now() - r.startedAt) / 1000 : 0) });
  const relay = (data: { presence: { userId: string }[] }) => { real = data.presence.filter(p => p.userId !== w.remote?.userId); return w.remote ? { ...data, presence: [...real, person(w.remote)] } : data; };
  const add = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (this: EventSource, type: string, fn: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    if (type !== 'presence') return add.call(this, type, fn, options);
    listener = fn as (event: MessageEvent) => void;
    add.call(this, type, (e: Event) => listener!(new MessageEvent(type, { data: JSON.stringify(relay(JSON.parse((e as MessageEvent).data))) })), options);
  } as typeof add;
  // A playing collaborator publishes at 4 Hz, a still one once.
  setInterval(() => { const r = w.remote; if (r && listener && (r.playing || !r.sentStill)) { r.sentStill = !r.playing; listener(new MessageEvent('presence', { data: JSON.stringify({ projectId: r.projectId, presence: [...real, person(r)], serverTime: Date.now() }) })); } }, 250);
  const fetch = window.fetch;
  window.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input instanceof Request ? input.url : input).includes('/api/presence') || !response.ok) return response;
    const body = await response.clone().json();
    return Array.isArray(body?.presence) ? new Response(JSON.stringify(relay(body)), { status: response.status, headers: response.headers }) : response;
  };
}

test('a collaborator playing is drawn into a canvas, not moved element by element, and their still playhead is the element again', async t => {
  let userId = '';
  const page = await openProject(t, async (context, url) => {
    const other = await request.newContext({ baseURL: url });
    userId = (await (await other.post('/api/auth/signup', { data: { name: 'Remote Player', email: 'remote@example.test', password: 'Remote-test-password-2026' } })).json()).user.id;
    await other.dispose();
    await context.addInitScript(fakeCollaborator);
  });
  const projectId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  const timelineId = (await (await page.request.get(new URL('/api/state', page.url()).href)).json()).state.timelines.find((t: { projectId: string }) => t.projectId === projectId).id;
  await page.evaluate(remote => { (window as unknown as { remote: Remote }).remote = { ...remote, startedAt: Date.now() }; }, { userId, projectId, timelineId, from: .5, startedAt: 0, playing: true });
  const strip = page.locator('.remote-playhead-canvas:not([hidden])');
  await strip.waitFor();
  const before = await strip.screenshot();
  await page.evaluate(() => {
    const w = window as unknown as { writes: string[] }; w.writes = [];
    new MutationObserver(list => { for (const m of list) if (m.target instanceof Element && m.target.closest('.remote-playhead,.remote-playhead-canvas')) w.writes.push(`${m.attributeName}:${m.target.className}`); })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  });
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { writes: string[] }).writes), [], 'no per-frame style writes while the collaborator plays');
  assert.ok(!before.equals(await strip.screenshot()), 'the drawn line moves');
  assert.equal(await page.locator('.remote-playhead').evaluate(el => getComputedStyle(el).visibility), 'hidden');

  // They stop: the line settles and the element takes over where it stopped.
  const stopped = await page.evaluate(() => { const r = (window as unknown as { remote: Remote }).remote; r.from += (Date.now() - r.startedAt) / 1000; r.playing = false; return r.from; });
  await page.waitForFunction(() => !document.querySelector('.remote-playhead-canvas:not([hidden])') && getComputedStyle(document.querySelector('.remote-playhead')!).visibility === 'visible');
  const x = await page.locator('.remote-playhead').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41);
  // The default zoom is 6 px a second.
  assert.ok(Math.abs(x - stopped * 6) <= 1, `still at ${x}px for ${stopped}s`);
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
