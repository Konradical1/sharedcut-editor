// Browser check for the Color page v3 layout and tools (ColorWorkspace.tsx, ColorPanels.tsx, ColorTools.tsx, color.css): it fits a
// MacBook Air (1470×760) and 1280×720 with no page scroll and no clipped control, every tool tab renders, sliders, wheels, HSL
// curves, the mixer, film and a library look change the selected node, a slider drag is one undo, New Node makes a Film node,
// and the tool area keeps its dragged height after a reload. Needs FFmpeg for the test clip.
// Run: node --experimental-strip-types --test src/workspaces/colorPage.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome); SHOTS=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)), ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg', shots = process.env.SHOTS;
const ready = (() => { try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const TABS = ['Primaries', 'Curves', 'Qualifier', 'Windows', 'Mixer', 'Film'];
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  if (!ready) return;
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-colorpage-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

/** What does not fit: page scroll, a workspace or header overflow, and any control of the tool area outside its box. */
const misfit = (page: Page, tab: string) => page.evaluate(tab => {
  const out: string[] = [], d = document.documentElement, inside = (r: DOMRect, b: DOMRect) => r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
  if (d.scrollHeight > innerHeight || d.scrollWidth > innerWidth) out.push(`page scrolls ${d.scrollWidth}×${d.scrollHeight}`);
  for (const selector of ['.color-workspace', '.tool-header', '.color-main', '.color-bottom']) { const el = document.querySelector(selector)!; if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) out.push(`${selector} overflows`); }
  const body = document.querySelector<HTMLElement>('.grade-tool-body')!, box = body.getBoundingClientRect();
  if (body.scrollWidth > body.clientWidth + 1) out.push(`${tab} is wider than the tool area`);
  // The other engineers' Qualifier and Windows panels may scroll; ours must fit the default height.
  if (!['Qualifier', 'Windows'].includes(tab)) {
    if (body.scrollHeight > body.clientHeight + 1) out.push(`${tab} needs ${body.scrollHeight - body.clientHeight}px more height`);
    for (const el of body.querySelectorAll<HTMLElement>('input,button,select,[role=application],.color-wheel')) { const r = el.getBoundingClientRect(); if (r.width && !inside(r, box)) out.push(`${tab}: ${el.getAttribute('aria-label') ?? el.textContent} is clipped`); }
  }
  for (const el of document.querySelectorAll<HTMLElement>('.tool-header button')) { const r = el.getBoundingClientRect(), header = document.querySelector('.tool-header')!.getBoundingClientRect(); if (r.width && !inside(r, header)) out.push(`header ${el.textContent} is clipped`); }
  if (!body.firstElementChild || body.textContent!.trim().length < 3) out.push(`${tab} rendered nothing`);
  return out;
}, tab);

test('Color page v3: fits a MacBook, every tool works and saves to the selected node', { timeout: 240000, skip: !ready && 'needs FFmpeg' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-colorpage-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1470, height: 760 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 10 }); });
  type View = { revision: number; state: { projects: { id: string }[]; timelines: { id: string }[]; media: MediaAsset[]; clips: Clip[]; nodes: GradeNode[] } };
  const server = async () => (await (await context.request.get(`${url}/api/state`)).json()) as View;
  const node = async (name: string) => (await server()).state.nodes.find(n => n.name === name)!;
  const until = async (check: (view: View) => boolean, what: string) => { for (let i = 0; i < 80; i++) { if (check(await server())) return; await page.waitForTimeout(100); } assert.fail(what); };
  const param = (name: string, key: string) => (view: View) => view.state.nodes.find(n => n.name === name)?.parameters[key];

  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Grade Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('colorpage@example.test');
  await page.locator('input[type=password]').fill('Colorpage-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Grade');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  const video = join(temp, 'bars.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  await page.getByLabel('Upload media files').setInputFiles(video);
  let asset: MediaAsset | undefined;
  for (let i = 0; i < 240 && !asset; i++) { asset = (await server()).state.media.find(m => m.status === 'ready' && !m.preparationStage); if (!asset) await page.waitForTimeout(250); }
  assert.ok(asset, 'the upload is prepared');
  for (let attempt = 0; ; attempt++) {
    const view = await server(), project = view.state.projects[0].id, timelineId = view.state.timelines[0].id;
    const clip = { id: 'shot', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: asset.id, name: 'Bars', start: 0, duration: 2, sourceIn: 0, color: '#4f8bb8', disabled: false, properties: {}, effects: [] };
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert: [clip], remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the clip is saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole('navigation', { name: 'Editor workspaces' }).getByRole('button', { name: 'Color', exact: true }).click();
  await page.getByRole('button', { name: 'Start wide-gamut grade', exact: true }).first().click();
  await until(view => view.state.nodes.length === 4, 'the wide-gamut grade makes four nodes');
  await page.getByRole('button', { name: /^Node 2: Balance/ }).click();
  const tool = (name: string) => page.locator('.tool-tabs').getByRole('button', { name, exact: true });

  // Layout: nothing scrolls or clips at either laptop size, on any tab.
  for (const [width, height] of [[1470, 760], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    for (const tab of TABS) {
      await tool(tab).click();
      await page.waitForTimeout(120);
      assert.deepEqual(await misfit(page, tab), [], `${tab} at ${width}×${height}`);
      if (shots) await page.screenshot({ path: join(shots, `colorpage-${tab}-${width}x${height}.png`) });
    }
  }
  await page.setViewportSize({ width: 1470, height: 760 });

  // Primaries: registry sliders, Shadows/Midtones/Highlights wheels, double-click reset, Log wheels.
  await tool('Primaries').click();
  for (const label of ['Shadows color balance', 'Midtones color balance', 'Highlights color balance', 'Offset color balance']) assert.ok(await page.getByRole('group', { name: new RegExp(`^${label}`) }).isVisible(), label);
  assert.equal(await page.getByText('Lift', { exact: true }).count(), 0, 'no Lift/Gamma/Gain labels');
  await page.getByLabel('Exposure value', { exact: true }).fill('0.5');
  await page.getByLabel('Exposure value', { exact: true }).press('Tab');
  await until(view => param('Balance', 'exposure')(view) === .5, 'Exposure saves');
  const saturation = page.getByRole('slider', { name: 'Saturation', exact: true });
  await saturation.focus();
  for (let i = 0; i < 3; i++) await saturation.press('ArrowRight');
  await until(view => param('Balance', 'saturation')(view) === 103, 'Saturation saves');
  await page.locator('.grade-slider', { has: saturation }).locator('span').first().dblclick();
  await until(view => param('Balance', 'saturation')(view) === 100, 'double-click resets Saturation');
  for (const key of ['hue', 'boost', 'shadows', 'highlights', 'density']) assert.equal(await page.locator('.grade-slider').filter({ has: page.getByRole('slider', { name: { hue: 'Hue', boost: 'Color Boost', shadows: 'Shadows', highlights: 'Highlights', density: 'Density' }[key], exact: true }) }).count(), 1, key);
  const wheel = page.getByRole('group', { name: /^Shadows color balance/ });
  await wheel.focus();
  for (let i = 0; i < 10; i++) await wheel.press('ArrowRight');
  // Right on the wheel is blue on the vectorscope, with luma unchanged.
  await until(view => (param('Balance', 'liftB')(view) ?? 0) > .015, 'the Shadows wheel moves toward blue');
  const lifted = (await node('Balance')).parameters;
  assert.ok(Math.abs(.2126 * (lifted.liftR ?? 0) + .7152 * (lifted.liftG ?? 0) + .0722 * lifted.liftB) < 1e-4, 'a wheel move keeps luma');
  // One drag, one undo, even though the wheel had focus when the slider was pressed.
  const exposure = page.getByRole('slider', { name: 'Exposure', exact: true }), bar = (await exposure.boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(bar.x + bar.width / 2 + i * 9, bar.y + bar.height / 2);
  await page.mouse.up();
  await until(view => (param('Balance', 'exposure')(view) ?? 0) > .6, 'Exposure drags');
  await page.keyboard.press('Control+z');
  await until(view => param('Balance', 'exposure')(view) === .5, 'one undo takes back the whole drag');
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await page.getByLabel('Shadow R', { exact: true }).fill('0.02');
  await page.getByLabel('Shadow R', { exact: true }).press('Tab');
  await until(view => param('Balance', 'logShadowR')(view) === .02, 'Log Shadow R saves');
  assert.ok(await page.getByRole('slider', { name: 'Low range', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Primary', exact: true }).click();

  // Curves: a hue curve starts with the six hue points; dragging green up and clicking adds a point.
  await tool('Curves').click();
  await page.getByRole('button', { name: 'Hue vs Sat', exact: true }).click();
  const editor = page.getByRole('application', { name: /^Hue vs Sat curve/ }), area = (await editor.boundingBox())!;
  assert.equal(await editor.locator('circle[data-point]').count(), 7);
  const pad = 6, at = (x: number, y: number) => [area.x + pad + x * (area.width - 2 * pad), area.y + pad + (1 - y) * (area.height - 2 * pad)] as const;
  await page.mouse.move(...at(.3521, .5)); await page.mouse.down(); await page.mouse.move(...at(.3521, .7), { steps: 5 }); await page.mouse.up();
  await page.mouse.click(...at(.8, .5));
  await until(view => view.state.nodes.find(n => n.name === 'Balance')?.curves?.HueSat?.points.length === 8, 'a click adds a point to Hue vs Sat');
  const hueSat = (await node('Balance')).curves!.HueSat!;
  assert.ok(hueSat.points.find(p => Math.abs(p.x - .3521) < .01)!.y > .6, 'green is boosted');
  assert.equal(hueSat.points[0].y, hueSat.points.at(-1)!.y, 'the hue curve wraps');
  assert.match(await page.locator('.curve-point-controls').innerText(), /Hue 288°/);
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  assert.ok(await page.getByRole('application', { name: /RGB custom curve/ }).isVisible());

  // Mixer and Film.
  await tool('Mixer').click();
  await page.getByRole('button', { name: 'B&W neutral', exact: true }).click();
  await until(view => param('Balance', 'mixMono')(view) === 1 && param('Balance', 'mixRG')(view) === .7152, 'the B&W preset saves');
  await page.getByRole('button', { name: 'Identity', exact: true }).click();
  await until(view => param('Balance', 'mixMono')(view) === 0 && param('Balance', 'mixRG')(view) === 0, 'Identity resets the mixer');
  await tool('Film').click();
  await page.getByLabel('Grain value', { exact: true }).fill('35');
  await page.getByLabel('Grain value', { exact: true }).press('Tab');
  await until(view => param('Balance', 'filmGrain')(view) === 35, 'Grain saves');
  await page.getByRole('button', { name: 'Reset Grain', exact: true }).click();
  await until(view => param('Balance', 'filmGrain')(view) === 0, 'Reset Grain');

  // A library look goes on the selected node; its strength re-applies it.
  await page.getByRole('button', { name: /^Node 3: Look/ }).click();
  await page.getByRole('button', { name: 'Show effects panel' }).click();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: /^Kodak 2383 print/ }).click();
  await until(view => param('Look', 'contrast')(view) === 1.16 && param('Look', 'filmHalation')(view) === 18, 'the look applies at full strength');
  const strength = page.getByRole('slider', { name: 'Look strength' });
  await strength.focus();
  for (let i = 0; i < 50; i++) await strength.press('ArrowLeft');
  await until(view => param('Look', 'contrast')(view) === 1.08, 'half strength re-applies the look');
  await page.getByRole('button', { name: 'Close effects panel' }).click();

  // New Node → Film starts a film node, marked on its card, and opens the Film tools.
  await page.getByRole('button', { name: 'New node type' }).click();
  await page.getByRole('menuitem', { name: /^Film node/ }).click();
  await until(view => view.state.nodes.some(n => n.name === 'Film' && n.parameters.filmGrain === 20 && n.parameters.filmHalation === 15), 'a Film node');
  assert.equal(await tool('Film').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.getByRole('button', { name: /^Node \d: Film/ }).locator('.node-badges i[title=Film]').isVisible());

  // The tool area keeps its dragged height in this browser.
  const handle = page.getByRole('separator', { name: 'Resize tool area' }), before = (await page.locator('.color-bottom').boundingBox())!.height, grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 3); await page.mouse.down(); await page.mouse.move(grip.x + grip.width / 2, grip.y - 57, { steps: 4 }); await page.mouse.up();
  const taller = (await page.locator('.color-bottom').boundingBox())!.height;
  assert.ok(Math.abs(taller - before - 60) <= 2, `dragged ${before} → ${taller}`);
  await page.reload();
  await page.getByRole('navigation', { name: 'Editor workspaces' }).getByRole('button', { name: 'Color', exact: true }).click();
  await page.locator('.color-bottom').waitFor();
  assert.ok(Math.abs((await page.locator('.color-bottom').boundingBox())!.height - taller) <= 1, 'the height is remembered');
  assert.deepEqual(await misfit(page, 'Primaries'), []);
  assert.deepEqual(errors, []);
});
