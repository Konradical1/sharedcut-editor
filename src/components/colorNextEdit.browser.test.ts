// Browser check: on the Color page Next/Previous edit step shot to shot; a logo over many shots never takes the step.
// Run: node --experimental-strip-types --test src/components/colorNextEdit.browser.test.ts
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
import { ADJUSTMENT_MEDIA } from '../services/adjustment.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-colornav-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('Next edit on the Color page lands on the next shot, not a logo laid over it', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-colornav-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Color Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('colornav@example.test');
  await page.locator('input[type=password]').fill('Colornav-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Nav');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  const first = await (await context.request.get(`${url}/api/state`)).json();
  const project = first.state.projects[0].id, timelineId = first.state.timelines[0].id;
  // V1: A 0–4, B 4–6, gap, C 6.5–9. Logo on V9 from 4 s to 9 s, starting on B's first frame.
  const shot = (name: string, trackId: string, start: number, duration: number) => ({ id: name.replace(' ', '-'), name, projectId: project, timelineId, trackId, mediaId: ADJUSTMENT_MEDIA, start, duration, sourceIn: 0, color: '#b8894f', disabled: false, effects: [], properties: {} });
  const delta = {
    tracks: { upsert: [{ id: 'logo-track', timelineId, name: 'Logo', kind: 'video', number: 9, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 }], remove: [] },
    clips: { upsert: [shot('Shot A', `${project}-v1`, 0, 4), shot('Shot B', `${project}-v1`, 4, 2), shot('Shot C', `${project}-v1`, 6.5, 2.5), shot('Logo', 'logo-track', 4, 5)], remove: [] },
  };
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json();
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Color', exact: true }).click();
  const name = page.locator('.scrub-clip-name'), next = page.getByRole('button', { name: 'Next edit' }), previous = page.getByRole('button', { name: 'Previous edit' });
  await page.getByRole('button', { name: /^Shot 1: Shot A/ }).click();
  await name.filter({ hasText: 'Shot A' }).waitFor({ timeout: 5000 });
  for (const [button, expected] of [[next, 'Shot B'], [next, 'Shot C'], [previous, 'Shot B'], [previous, 'Shot A']] as const) {
    await button.click();
    await name.filter({ hasText: expected }).waitFor({ timeout: 5000 });
  }
  assert.deepEqual(errors, []);
});
