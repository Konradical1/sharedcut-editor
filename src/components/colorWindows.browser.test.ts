// Browser check: on the Color page the selected node's circle window is moved, resized, feathered and rotated from its handles on
// the viewer (one drag, one Undo), and the Qualifier panel picks a hue, switches its key view and runs the eyedropper.
// Run: node --experimental-strip-types --test src/components/colorWindows.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome); SHOTS=<folder> saves screenshots.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { chromium, type Browser, type Page } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)), shots = process.env.SHOTS;
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (shots) await mkdir(shots, { recursive: true });
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-colorwindows-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const drag = async (page: Page, path: { x: number; y: number }[]) => {
  await page.mouse.move(path[0].x, path[0].y); await page.mouse.down();
  for (const p of path.slice(1)) await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
};
const middle = async (page: Page, name: string, nth = 0) => { const b = (await page.getByRole('button', { name, exact: true }).nth(nth).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

test('circle window handles on the Color viewer, and the qualifier panel', { timeout: 240000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-colorwindows-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  // A MacBook Air's browser window: the Color page has to work at this height.
  const context = await browser.newContext({ viewport: { width: 1470, height: 760 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Window Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('windows@example.test');
  await page.locator('input[type=password]').fill('Windows-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Windows');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();

  // 16:9 colour bars over a grey ramp, the project's own shape, so the picture fills the frame.
  const image = createCanvas(640, 360), g = image.getContext('2d');
  ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'].forEach((c, i) => { g.fillStyle = c; g.fillRect(Math.floor(i * 640 / 7), 0, Math.ceil(640 / 7) + 1, 250); });
  const ramp = g.createLinearGradient(0, 0, 640, 0); ramp.addColorStop(0, '#000'); ramp.addColorStop(1, '#fff'); g.fillStyle = ramp; g.fillRect(0, 250, 640, 110);
  await page.getByLabel('Upload media files').setInputFiles({ name: 'bars.png', mimeType: 'image/png', buffer: await image.encode('png') });
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).state.media.some((m: { name: string; status: string }) => m.name === 'bars.png' && m.status === 'ready'));
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), project = view.state.projects[0].id, timelineId = view.state.timelines[0].id;
    const clips = [{ id: 'bars', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: view.state.media[0].id, name: 'bars', start: 0, duration: 4, sourceIn: 0, color: '#467879', disabled: false, properties: {}, effects: [] }];
    // Desaturated inside a circle at the centre: the window's edge shows on the picture.
    const nodes = [{ id: 'key', projectId: project, clipId: 'bars', name: 'Key', kind: 'serial', enabled: true, order: 1, parameters: { saturation: 0, circOn: 1, circX: .5, circY: .5, circW: .3, circH: .3, circAngle: 0, circSoft: .1 } }];
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert: clips, remove: [] }, nodes: { upsert: nodes, remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the scene is saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Color', exact: true }).click();
  await page.getByRole('button', { name: /^Shot 1: bars/ }).click();
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  const overlay = page.locator('.color-window-overlay svg');
  await page.getByRole('button', { name: 'Move circle', exact: true }).waitFor();
  const params = async () => { await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved'); return (await (await context.request.get(`${url}/api/state`)).json()).state.nodes.find((n: { id: string }) => n.id === 'key').parameters as Record<string, number>; };
  const frame = (await overlay.boundingBox())!, centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const near = (a: number, b: number, message: string, e: number) => assert.ok(Math.abs(a - b) <= e, `${message}: ${a}, wanted ${b}`);
  await page.waitForTimeout(800);
  await shot(page, '1-windows');

  // The centre handle sits at the picture's middle and drags the circle in picture units.
  const handle = await middle(page, 'Move circle');
  near(handle.x, centre.x, 'centre handle x', 1.5); near(handle.y, centre.y, 'centre handle y', 1.5);
  await drag(page, [centre, { x: centre.x + 30, y: centre.y - 10 }, { x: centre.x + 60, y: centre.y - 30 }]);
  let p = await params();
  near(p.circX, .5 + 60 / frame.width, 'moved x', .002); near(p.circY, .5 - 30 / frame.height, 'moved y', .002);
  await shot(page, '2-moved');
  await page.keyboard.press('ControlOrMeta+z');
  p = await params();
  assert.deepEqual([p.circX, p.circY], [.5, .5], 'one Undo takes the whole drag back');

  // Radius X: the right handle sits one radius (in picture heights) right of the centre and follows the pointer.
  const right = await middle(page, 'Circle radius X');
  near(right.x - centre.x, .3 * frame.height, 'radius handle', 1.5);
  await drag(page, [right, { x: right.x + 40, y: right.y + 3 }]);
  p = await params();
  near(p.circW, .3 + 40 / frame.height, 'radius X', .002); assert.equal(p.circH, .3, 'radius Y kept');
  // Shift resizes evenly.
  const top = await middle(page, 'Circle radius Y', 1);
  await page.keyboard.down('Shift'); await drag(page, [top, { x: top.x, y: top.y - 30 }]); await page.keyboard.up('Shift');
  p = await params();
  near(p.circH / p.circW, .3 / (.3 + 40 / frame.height), 'the shape is kept', .01);
  // Softness: the diamond on the outer ring.
  const soft = await middle(page, 'Circle softness'), before = p.circSoft;
  await drag(page, [soft, { x: soft.x + 15, y: soft.y + 15 }]);
  p = await params();
  assert.ok(p.circSoft > before + .02, `softness grew: ${before} → ${p.circSoft}`);
  // Rotation: the knob above the circle, turned a quarter clockwise round the centre.
  const knob = await middle(page, 'Rotate circle'), r = Math.hypot(knob.x - centre.x, knob.y - centre.y);
  // Grown past the frame's top, the knob turns inside the circle rather than leaving the picture.
  near(knob.x, centre.x, 'the knob is on the circle\'s vertical axis', 1.5);
  assert.ok(knob.y < centre.y - 20 && knob.y > frame.y, `the knob is above the centre and on the frame (${knob.y})`);
  await drag(page, Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i / 9 * Math.PI / 2; return { x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) }; }));
  p = await params();
  near(p.circAngle, 90, 'rotated', 1);
  await shot(page, '3-edited');

  // Qualifier: a press on the hue strip picks that hue, the key view switches, the eyedropper waits for a click and Esc cancels.
  await page.getByRole('button', { name: 'Qualifier', exact: true }).click();
  const hue = page.getByRole('group', { name: 'Hue range' });
  await hue.waitFor();
  const strip = (await hue.boundingBox())!;
  await page.mouse.click(strip.x + strip.width / 3, strip.y + strip.height / 2);
  p = await params();
  near(p.qualHue, 120, 'picked hue', 1.5); assert.equal(p.qualHueWidth, 30); assert.equal(p.qualOn, 1, 'editing the key turns it on');
  // The range's body moves the centre, an edge pulls the width both ways at once, the numbers take typed values.
  const degree = strip.width / 360, mid = strip.y + strip.height / 2, at = (deg: number) => strip.x + deg * degree;
  await drag(page, [{ x: at(p.qualHue), y: mid }, { x: at(p.qualHue + 30), y: mid }]);
  p = await params();
  near(p.qualHue, 150, 'dragged hue', 1.5); assert.equal(p.qualHueWidth, 30);
  await drag(page, [{ x: at(165), y: mid }, { x: at(180), y: mid }]);
  p = await params();
  near(p.qualHueWidth, 60, 'pulled width', 2); near(p.qualHue, 150, 'the centre stays', .01);
  await page.getByRole('textbox', { name: 'Hue width', exact: true }).fill('45');
  await page.keyboard.press('Enter');
  p = await params();
  assert.equal(p.qualHueWidth, 45);
  const sat = (await page.getByRole('group', { name: 'Saturation range' }).boundingBox())!;
  await drag(page, [{ x: sat.x + 2, y: sat.y + sat.height / 2 }, { x: sat.x + 2 + sat.width * .4, y: sat.y + sat.height / 2 }]);
  p = await params();
  near(p.qualSatLow, 40, 'saturation low edge', 1); assert.equal(p.qualSatHigh, undefined, 'the high edge is untouched (absent = 100)');
  await shot(page, '4-qualifier');
  for (const mode of ['Highlight', 'Matte', 'Off']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    assert.equal(await page.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'), 'true', mode);
    if (mode === 'Highlight') await shot(page, '5-highlight');
  }
  await page.getByRole('button', { name: 'Pick', exact: true }).click();
  await page.getByLabel('Pick a colour for the qualifier').waitFor();
  await shot(page, '5-picking');
  await page.keyboard.press('Escape');
  await page.getByLabel('Pick a colour for the qualifier').waitFor({ state: 'detached' });
  // Picking the red bar keys red, or (before the frame can be read) says so and keeps the picker up.
  await page.getByRole('button', { name: 'Pick', exact: true }).click();
  await page.mouse.click(frame.x + frame.width * 5.5 / 7, frame.y + frame.height * .3);
  await page.waitForFunction(() => !document.querySelector('.color-window-overlay.picking') || document.body.textContent?.includes('Pick again once the frame is ready'));
  if (!(await page.locator('.color-window-overlay.picking').count())) {
    p = await params();
    near(p.qualHue, 0, 'the eyedropper keyed red', 6); assert.equal(p.qualHueWidth, 30);
  } else console.log('probeNodeInput returned no colour: the picker asked to pick again');
  await shot(page, '6-picked');
  assert.deepEqual(errors, []);
});
