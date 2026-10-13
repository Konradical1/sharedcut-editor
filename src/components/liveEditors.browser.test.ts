// Browser check that the home screen shows who has a project open right now.
// Run: node --experimental-strip-types --test src/components/liveEditors.browser.test.ts
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
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-live-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

async function signUp(page: Page, url: string, name: string, email: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill(name);
  await page.getByRole('textbox', { name: 'Email address' }).fill(email);
  await page.locator('input[type=password]').fill('Live-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
}

test('a class project shows who is editing it on everyone else\'s home screen', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-live-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const one = await browser.newContext({ viewport: { width: 1440, height: 900 } }), two = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(async () => { await one.close(); await two.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  const konrad = await one.newPage(), ashley = await two.newPage();

  await signUp(konrad, url, 'Konrad Fischer', 'konrad@example.test');
  await konrad.getByRole('button', { name: 'New project', exact: true }).click();
  await konrad.getByRole('textbox', { name: 'Project name' }).fill('Newspaper');
  await konrad.getByRole('button', { name: 'Create project', exact: true }).click();
  await konrad.locator('.save-status', { hasText: 'Saved' }).waitFor();

  await signUp(ashley, url, 'Ashley Chen', 'ashley@example.test');
  await ashley.getByRole('button', { name: 'Class', exact: true }).click();
  const pill = ashley.locator('.drive-project', { hasText: 'Newspaper' }).locator('.drive-live');
  await pill.waitFor({ timeout: 10_000 });
  assert.equal(await pill.locator('b').textContent(), 'Konrad is editing');
  await ashley.screenshot({ path: join(tmpdir(), 'sharedcut-live-editors.png') });

  // Leaving the project clears it within a poll or two.
  await konrad.goto(url);
  await pill.waitFor({ state: 'detached', timeout: 10_000 });
});
