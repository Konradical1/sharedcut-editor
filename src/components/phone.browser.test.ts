// Browser check for the phone editor: an iPhone gets the CapCut-style layout and a 640 px preview; a tap opens the clip's
// panel, its tools edit the clip, and turning the phone keeps the same running viewer.
// Run: node --experimental-strip-types --test src/components/phone.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import type { Clip, Track } from '../state/models.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-phone-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('phone editor: tap a clip, edit it from the panel, turn the phone without restarting playback', { timeout: 240000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-phone-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext(devices['iPhone 14']), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  const clips = async () => { const state = (await (await context.request.get(`${url}/api/state`)).json()).state; const video = new Set(state.tracks.filter((k: Track) => k.kind === 'video').map((k: Track) => k.id)); return (state.clips as Clip[]).filter(c => video.has(c.trackId)).sort((a, b) => a.start - b.start); };
  const until = async (check: (list: Clip[]) => boolean, what: string) => { for (let i = 0; i < 120; i++) { if (check(await clips())) return; await page.waitForTimeout(250); } assert.fail(what); };

  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Phone Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('phone@example.test');
  await page.locator('input[type=password]').fill('Phone-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).waitFor();
  assert.equal(await page.getByText('Import Resolve').count(), 0, 'desktop-only imports are hidden on a phone');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Phone');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.ph').waitFor();
  assert.equal(await page.locator('.workspace-nav, .app-statusbar').count(), 0, 'no desktop chrome on a phone');

  const files = [1, 2].map(i => { const file = join(temp, `shot${i}.mp4`); execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=24:d=${2 + i * 2}`, '-f', 'lavfi', '-i', `sine=duration=${2 + i * 2}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]); return file; });
  await page.locator('.pt-empty').click();
  await page.locator('.ph-sheet input[type=file]').setInputFiles(files);
  await page.locator('.ph-sheet header button').click();
  await until(list => list.length === 2, 'both uploads land on the main track');
  await page.waitForFunction(() => document.querySelector('.viewer canvas')?.getAttribute('data-has-picture') === 'true', null, { timeout: 60000 }).catch(() => {});
  const canvas = await page.locator('.viewer canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  assert.deepEqual(canvas, [640, 360], 'a phone composites at 640 px on the long side');

  // Speed from the panel a tap opens.
  if (await page.locator('.pc-done').count()) await page.locator('.pc-done').click();
  await page.locator('.pt-main').first().click();
  await page.locator('.pc').waitFor();
  await page.locator('.pc-tools').getByRole('button', { name: 'Speed', exact: true }).click();
  await page.getByRole('button', { name: '2.0x', exact: true }).click();
  await until(list => Number(list[0].properties.speed) === 200 && Math.abs(list[0].duration - 2) < .05, 'Speed 2x halves the first clip');

  // Split at a point picked on the clip's own strip, then undo it.
  await page.locator('.pc-done').click();
  await page.locator('.pt-main').nth(1).click();
  const strip = await page.locator('.pc-scrub').boundingBox();
  await page.mouse.click(strip!.x + strip!.width / 2, strip!.y + strip!.height / 2);
  await page.getByRole('button', { name: 'Split here' }).click();
  await until(list => list.length === 3, 'the split leaves three video clips');
  await page.locator('.pc-done').click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await until(list => list.length === 2, 'undo joins it again');

  // Turning the phone rearranges the same editor: the viewer (and its playback engine) is not rebuilt.
  await page.locator('.viewer canvas').evaluate(c => { (c as HTMLCanvasElement & { kept?: boolean }).kept = true; });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('.ph.is-landscape').waitFor();
  assert.equal(await page.locator('.viewer canvas').evaluate(c => !!(c as HTMLCanvasElement & { kept?: boolean }).kept), true, 'the same viewer survives the rotation');
  assert.deepEqual(errors, []);
});
