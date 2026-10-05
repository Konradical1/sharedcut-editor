// Browser check: the Effects panel's Adjustment layer lands on the timeline and its grade changes the picture below it.
// Run: node --experimental-strip-types --test src/components/adjustment.browser.test.ts
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
import { primaryDefaults } from '../services/color.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-adjust-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('an adjustment layer from the Effects panel grades the tracks below it in the preview', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-adjust-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Adjust Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('adjust@example.test');
  await page.locator('input[type=password]').fill('Adjust-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Adjust');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  const save = async (delta: (view: { state: { projects: { id: string }[]; timelines: { id: string }[]; clips: { id: string; mediaId: string; start: number; duration: number }[] } }) => object) => {
    for (let attempt = 0; ; attempt++) {
      const view = await (await context.request.get(`${url}/api/state`)).json();
      const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: delta(view) } });
      if (patched.ok()) return;
      assert.ok(patched.status() === 409 && attempt < 10, `saved (${patched.status()} ${await patched.text()})`);
      await page.waitForTimeout(100);
    }
  };
  await save(view => { const project = view.state.projects[0].id, timelineId = view.state.timelines[0].id; return { clips: { upsert: [{ id: 'green', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: 'frameline-shape', name: 'green', start: 0, duration: 8, sourceIn: 0, color: '#b8894f', disabled: false, effects: [], properties: { shapeDocument: JSON.stringify({ ...defaultShape('rectangle'), x: 0, y: 0, width: 1, height: 1, cornerRadius: 0, fill: '#19994d' }) } }], remove: [] } }; });
  await page.reload();
  const centre = () => page.locator('.viewer-frame canvas').evaluate(c => { const v = c as HTMLCanvasElement; return [...v.getContext('2d')!.getImageData(v.width >> 1, v.height >> 1, 1, 1).data].slice(0, 3); });
  const settle = async (ok: (p: number[]) => boolean) => { for (let i = 0; i < 100 && !ok(await centre()); i++) await page.waitForTimeout(100); return centre(); };
  assert.ok((await settle(p => p[1] > 120 && p[0] < 60)).every((v, i) => Math.abs(v - [25, 153, 77][i]) <= 4), 'green before the adjustment');

  await page.getByRole('tab', { name: 'Effects', exact: true }).click();
  await page.getByRole('button', { name: /Adjustment layer/ }).click();
  const added = page.locator('.timeline-clip.adjustment-clip');
  await added.first().waitFor();
  let adjustment: { id: string; start: number; duration: number } | undefined;
  for (let i = 0; i < 50 && !adjustment; i++) { adjustment = (await (await context.request.get(`${url}/api/state`)).json()).state.clips.find((c: { mediaId: string }) => c.mediaId === 'frameline-adjustment'); if (!adjustment) await page.waitForTimeout(100); }
  assert.ok(adjustment, 'the adjustment clip is saved');
  assert.equal(adjustment!.duration, 5, 'defaults to 5 seconds');
  assert.ok((await centre())[1] > 120, 'an empty adjustment changes nothing');

  await save(view => ({ nodes: { upsert: [{ id: 'mono', projectId: view.state.projects[0].id, clipId: adjustment!.id, name: 'Mono', kind: 'serial', enabled: true, order: 1, parameters: { ...primaryDefaults, saturation: 0 } }], remove: [] } }));
  const grey = await settle(p => Math.max(...p) - Math.min(...p) < 12);
  assert.ok(Math.max(...grey) - Math.min(...grey) < 12, `the grade on the adjustment greys the picture below: ${grey}`);
  assert.deepEqual(errors, []);
});
