// Browser check: the Inspector's Blend mode changes the preview to the W3C result the export renders (server/media.test.ts).
// Run: node --experimental-strip-types --test src/components/blendMode.browser.test.ts
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
import { defaultShape } from '../services/shapes.ts';
import { blendModeNames } from '../services/blendModes.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-blend-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

const w3c = (mode: string, cb: number, cs: number, alpha: number) => {
  const D = (b: number) => b <= .25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  const mixed = ({ Normal: cs, Multiply: cb * cs, Screen: cb + cs - cb * cs, Overlay: cb <= .5 ? 2 * cs * cb : 1 - 2 * (1 - cs) * (1 - cb), 'Soft light': cs <= .5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (D(cb) - cb), Lighten: Math.max(cb, cs), Darken: Math.min(cb, cs), Difference: Math.abs(cb - cs),
    'Hard light': cs <= .5 ? 2 * cs * cb : 1 - 2 * (1 - cs) * (1 - cb), 'Color dodge': cb === 0 ? 0 : cs === 1 ? 1 : Math.min(1, cb / (1 - cs)), 'Color burn': cb === 1 ? 1 : cs === 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs), Exclusion: cb + cs - 2 * cb * cs } as Record<string, number>)[mode];
  return mode === 'Add' ? Math.min(1, cb + alpha * cs) : (1 - alpha) * cb + alpha * mixed;
};

test('the Blend mode dropdown changes the preview to the same pixels the export renders', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-blend-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Blend Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('blend@example.test');
  await page.locator('input[type=password]').fill('Blend-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Blend');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();

  // The same colours as the export test: a green picture under an amber image at 60% opacity.
  const under = [25, 153, 77], over = [255, 179, 51];
  const image = createCanvas(64, 36), drawing = image.getContext('2d'); drawing.fillStyle = '#ffb333'; drawing.fillRect(0, 0, 64, 36);
  await page.getByLabel('Upload media files').setInputFiles({ name: 'amber.png', mimeType: 'image/png', buffer: await image.encode('png') });
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).state.media.some((m: { name: string; status: string }) => m.name === 'amber.png' && m.status === 'ready'));
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), project = view.state.projects[0].id, timelineId = view.state.timelines[0].id;
    const clip = (id: string, track: string, mediaId: string, properties: object) => ({ id, projectId: project, timelineId, trackId: `${project}-${track}`, mediaId, name: id, start: 0, duration: 4, sourceIn: 0, color: '#b8894f', disabled: false, properties, effects: [] });
    const upsert = [clip('green', 'v1', 'frameline-shape', { shapeDocument: JSON.stringify({ ...defaultShape('rectangle'), x: 0, y: 0, width: 1, height: 1, cornerRadius: 0, fill: '#19994d' }) }), clip('amber', 'v2', view.state.media[0].id, { opacity: 60, blendMode: 'Normal' })];
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert, remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the scene is saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.locator('[data-clip="amber"]').first().click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Video', exact: true }).click();
  const canvas = page.locator('.viewer-frame canvas'), select = page.getByRole('combobox', { name: 'Blend mode' });
  const centre = () => canvas.evaluate(c => { const v = c as HTMLCanvasElement; return [...v.getContext('2d')!.getImageData(v.width >> 1, v.height >> 1, 1, 1).data].slice(0, 3); });
  const settle = async (want: number[]) => { await page.waitForFunction(([w]) => { const v = document.querySelector('.viewer-frame canvas') as HTMLCanvasElement; return [...v.getContext('2d')!.getImageData(v.width >> 1, v.height >> 1, 1, 1).data].slice(0, 3).every((x, i) => Math.abs(x - w[i]) <= 3); }, [want], { timeout: 10000 }).catch(() => {}); return centre(); };
  for (const mode of blendModeNames) {
    await select.selectOption(mode);
    const want = under.map((cb, c) => Math.round(255 * w3c(mode, cb / 255, over[c] / 255, .6))), got = await settle(want);
    assert.ok(got.every((v, c) => Math.abs(v - want[c]) <= 3), `${mode}: preview ${got} vs ${want}`);
  }
  assert.deepEqual(errors, []);
});
