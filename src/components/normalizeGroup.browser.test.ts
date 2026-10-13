// Browser check: on the Color page, Normalize & Group balances two shots into one color group, a group slider changes both, Ungroup takes them out.
// Needs FFmpeg and the color venv (npm run setup:color) for the real Normalize run; skips without them.
// Run: node --experimental-strip-types --test src/components/normalizeGroup.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import { colorPython } from '../../server/colorAssistant.ts';
import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)), ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ready = existsSync(colorPython()) && (() => { try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  if (!ready) return;
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-normalize-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('Normalize & Group puts two shots in one group; its Exposure changes both; Ungroup takes them out', { timeout: 300000, skip: !ready && 'needs npm run setup:color and FFmpeg' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-normalize-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 10 }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Group Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('groups@example.test');
  await page.locator('input[type=password]').fill('Groups-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Groups');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  type View = { revision: number; state: { projects: { id: string }[]; timelines: { id: string }[]; media: MediaAsset[]; clips: Clip[]; nodes: GradeNode[] } };
  const server = async () => (await (await context.request.get(`${url}/api/state`)).json()) as View;
  const until = async (check: (view: View) => boolean, what: string) => { for (let i = 0; i < 100; i++) { if (check(await server())) return; await page.waitForTimeout(100); } assert.fail(what); };
  const { state: { projects: [{ id: project }], timelines: [{ id: timelineId }] } } = await server();

  // Colour bars squeezed into a log-like code range, as the server's Normalize test does.
  const video = join(temp, 'bars.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-vf', 'lutrgb=r=val*0.55+50:g=val*0.55+50:b=val*0.55+50', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const bytes = await readFile(video);
  assert.ok((await context.request.post(`${url}/api/media?projectId=${project}&id=bars&name=bars.mp4&placeholder=1`)).ok());
  await context.request.post(`${url}/api/media/bars/upload`, { data: { size: bytes.length, fingerprint: `bars.mp4:${bytes.length}:1` } });
  assert.equal((await context.request.put(`${url}/api/media/bars/upload`, { headers: { 'upload-offset': '0', 'upload-checksum': createHash('sha256').update(bytes).digest('hex') }, data: bytes })).status(), 202);
  for (let i = 0; i < 600 && (await server()).state.media[0]?.status !== 'ready'; i++) await page.waitForTimeout(100);
  assert.equal((await server()).state.media[0].status, 'ready');
  const shot = (name: string, start: number) => ({ id: name.replace(' ', '-').toLowerCase(), projectId: project, timelineId, trackId: `${project}-v1`, mediaId: 'bars', name, start, duration: 1.5, sourceIn: start, color: '#4f8bb8', disabled: false, properties: {}, effects: [] });
  for (let attempt = 0; ; attempt++) {
    const { revision } = await server();
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision, delta: { clips: { upsert: [shot('Shot A', 0), shot('Shot B', 1.5)], remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the clips are saved: ${await patched.text()}`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Color', exact: true }).click();
  await page.getByRole('button', { name: /^Shot 1: Shot A/ }).click();
  await page.getByRole('button', { name: 'Show effects panel' }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Groups', exact: true }).click();

  // One shot picked: "All shots" picks both, then the dialog balances them into a new group.
  await page.getByRole('button', { name: 'All shots', exact: true }).click();
  await page.getByRole('button', { name: 'Normalize & Group 2 shots…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Normalize & Group' });
  await dialog.getByText('Balances 2 shots').waitFor();
  await dialog.getByRole('textbox', { name: 'New group name' }).fill('Gym');
  await dialog.getByRole('button', { name: 'Normalize', exact: true }).click();
  await dialog.getByText('Balanced 2 shots into Gym.').waitFor({ timeout: 240000 });
  await until(({ state }) => { const ids = state.clips.map(c => c.properties.colorGroup); return Boolean(ids[0]) && ids.every(id => id === ids[0]) && state.nodes.filter(n => n.group === ids[0] && n.name === 'Gym').length === 2; }, 'both shots are in Gym with a group node each');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: /^Shot 2: Shot B, group Gym/ }).waitFor();

  // The shown shot's group is open: its Exposure is shared by both shots.
  await page.getByRole('list', { name: 'Color groups' }).getByRole('textbox', { name: 'Exposure value' }).fill('0.5');
  await page.keyboard.press('Enter');
  await until(({ state }) => state.nodes.filter(n => n.group && n.parameters.exposure === .5).length === 2, 'Exposure reaches both group nodes');

  await page.getByRole('button', { name: 'Ungroup', exact: true }).click();
  await until(({ state }) => state.clips.every(c => !c.properties.colorGroup) && !state.nodes.some(n => n.group), 'Ungroup takes both shots out');
  await page.getByText('No color groups yet.').waitFor();
  assert.deepEqual(errors, []);
});
