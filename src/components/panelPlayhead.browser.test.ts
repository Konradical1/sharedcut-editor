// Browser regressions for panels that stopped following the moving playhead (usePanelPlayhead/usePausedPlayhead).
// Run: node --experimental-strip-types --test src/components/panelPlayhead.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-panel-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

async function openProject(t: { after: (fn: () => Promise<void>) => void }, panel?: 'Titles' | 'Shapes') {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-panel-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Panel Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('panel@example.test');
  await page.locator('input[type=password]').fill('Panel-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Panel playhead');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  if (panel === 'Titles') { await page.getByRole('tab', { name: 'Titles' }).click(); await page.locator('button[aria-label^="Add "][aria-label$=" title"]').first().click(); await page.locator('.text-box').first().waitFor(); }
  if (panel === 'Shapes') { await page.getByRole('tab', { name: 'Shapes', exact: true }).click(); await page.getByRole('button', { name: 'Add Rectangle shape', exact: true }).click(); }
  const saved = () => page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  const text = async () => { const state = (await (await context.request.get(`${url}/api/state`)).json()).state; return JSON.parse(state.clips.find((c: { properties: { textDocument?: string } }) => c.properties.textDocument).properties.textDocument).runs.map((r: { text: string }) => r.text).join(''); };
  return { page, saved, text };
}
const rotation = (page: Page) => page.locator('.text-box').first().evaluate(e => /rotate\(([-\d.]+)deg\)/.exec((e as HTMLElement).style.transform)?.[1]);

test('play then pause inside a title being edited on canvas keeps its text and the Space shortcut', async t => {
  const { page, saved, text } = await openProject(t, 'Titles');
  await page.locator('.text-box').first().dblclick();
  await page.locator('.inline-text-editor').fill('Keep this headline');
  await saved();
  await page.locator('.timeline-track-heading').first().click();
  await page.keyboard.press('Space'); await page.waitForTimeout(600);
  await page.keyboard.press('Space'); await page.waitForTimeout(300);
  assert.notEqual(await page.evaluate(() => document.activeElement?.className), 'inline-text-editor', 'pausing must not focus the on-canvas editor');
  await page.keyboard.press('Space'); await page.waitForTimeout(800);
  assert.equal(await text(), 'Keep this headline');
});

test('dragging an unkeyframed property previews the clip at the playhead, not its opening pose', async t => {
  const { page } = await openProject(t, 'Titles');
  await page.locator('.text-box').first().click();
  const rot = page.getByRole('textbox', { name: 'Rotation', exact: true }).first();
  await rot.waitFor();
  await page.getByRole('button', { name: 'Add Rotation keyframe', exact: true }).first().click();
  const step = async (key: string, n: number) => { await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); for (let i = 0; i < n; i++) await page.keyboard.press(key); };
  await step('ArrowRight', 48); await rot.fill('90'); await rot.blur(); await step('ArrowLeft', 24);
  await page.waitForTimeout(300);
  assert.equal(await rotation(page), '45');
  const box = (await page.locator('label.scrub-label', { hasText: /^Scale$/ }).first().boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 }); await page.waitForTimeout(200);
  assert.equal(await rotation(page), '45', 'Rotation stays at its playhead value while Scale is dragged');
  await page.mouse.up(); await page.waitForTimeout(300);
  assert.equal(await rotation(page), '45');
});

test('shape handles keep their on-screen size after the viewer resizes', async t => {
  const { page } = await openProject(t, 'Shapes');
  const handle = page.getByRole('button', { name: 'Resize shape se', exact: true });
  const size = async () => (await handle.boundingBox())!.width;
  const before = await size();
  await page.setViewportSize({ width: 1000, height: 700 }); await page.waitForTimeout(400);
  assert.ok(Math.abs(await size() - before) < .5, `handle ${before}px before the resize, ${await size()}px after`);
});
