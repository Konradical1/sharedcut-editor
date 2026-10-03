// Browser regressions for redo, ripple delete and the ripple trim tool: the keys and the drag live in shortcuts.ts and Timeline.tsx.
// Run: node --experimental-strip-types --test src/components/editTools.browser.test.ts
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
import { defaultShape } from '../services/shapes.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-edit-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

// Three rectangles end to end on V1, 24 fps: A[0-4) B[4-8) C[8-12).
const scene = [{ id: 'A', start: 0 }, { id: 'B', start: 4 }, { id: 'C', start: 8 }];
type Clips = Record<string, { start: number; duration: number }>;

async function openScene(t: { after: (fn: () => Promise<void>) => void }) {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-edit-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Edit Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('edit@example.test');
  await page.locator('input[type=password]').fill('Edit-tools-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Edit tools');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  let project = '';
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), timelineId = view.state.timelines[0].id;
    project = view.state.projects[0].id;
    const upsert = scene.map(c => ({ id: c.id, projectId: project, timelineId, trackId: `${project}-v1`, mediaId: 'frameline-shape', name: c.id, start: c.start, duration: 4, sourceIn: 0, color: '#b8894f', disabled: false, properties: { shapeDocument: JSON.stringify(defaultShape('rectangle')) }, effects: [] }));
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert, remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, 'the scene is saved');
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.locator('.timeline-clip').first().waitFor();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom timeline in', exact: true }).click();
  const state = async (): Promise<Clips> => Object.fromEntries((await (await context.request.get(`${url}/api/state`)).json()).state.clips.map((c: { id: string; start: number; duration: number }) => [c.id, { start: c.start, duration: c.duration }]));
  // A save that lands on the server shows as Saved; poll the server until it agrees, so a test never reads the state between the two.
  const settle = async (want: (clips: Clips) => boolean) => { for (let i = 0; i < 50; i++) { if (want(await state())) return state(); await page.waitForTimeout(100); } return state(); };
  const xAt = async (time: number) => { const lane = page.locator('.track-lane').first(), box = (await lane.boundingBox())!, span = Number(await lane.getAttribute('data-time-span')); return box.x + time * box.width / span; };
  const clipBox = async (id: string) => (await page.locator(`[data-clip="${id}"]`).first().boundingBox())!;
  return { page, state, settle, xAt, clipBox };
}
const near = (a: number, b: number, why: string) => assert.ok(Math.abs(a - b) < 1e-6, `${why}: ${a} vs ${b}`);

test('Shift+Delete ripple deletes; ⌘Z undoes it and ⌘⇧Z / Ctrl+Y redo it', async t => {
  const { page, settle, clipBox } = await openScene(t);
  const b = await clipBox('B');
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('Shift+Backspace');
  let clips = await settle(c => !c.B);
  assert.equal(clips.B, undefined, 'B is gone');
  near(clips.C.start, 4, 'C closed the gap');
  await page.keyboard.press('Control+z');
  clips = await settle(c => !!c.B);
  near(clips.B.start, 4, 'undo puts B back'); near(clips.C.start, 8, 'and C where it was');
  await page.keyboard.press('Control+Shift+z');
  clips = await settle(c => !c.B);
  assert.equal(clips.B, undefined, 'redo deletes it again'); near(clips.C.start, 4, 'and closes the gap again');
  await page.keyboard.press('Control+z');
  await settle(c => !!c.B);
  await page.keyboard.press('Control+y');
  clips = await settle(c => !c.B);
  near(clips.C.start, 4, 'Ctrl+Y redoes too');
  await page.getByRole('button', { name: 'Undo my action (⌘Z)' }).click();
  await settle(c => !!c.B);
  await page.getByRole('button', { name: 'Redo my action (⌘⇧Z / Ctrl+Y)' }).click();
  clips = await settle(c => !c.B);
  near(clips.C.start, 4, 'the Redo button redoes');
});

test('R picks ripple trim; dragging an edge shows the change and pushes the clips after it', async t => {
  const { page, settle, xAt, clipBox } = await openScene(t);
  const button = page.getByRole('button', { name: 'Ripple trim tool (R)' });
  assert.match(await button.getAttribute('title') ?? '', /everything after it on the track moves/, 'the tooltip says what the tool does');
  await page.keyboard.press('r');
  assert.match(await button.getAttribute('class') ?? '', /active/);
  const a = await clipBox('A'), y = a.y + a.height / 2, from = (await xAt(4)) - 3, step = (await xAt(1)) - (await xAt(0));
  await page.mouse.move(from, y); await page.mouse.down();
  await page.mouse.move(from + step, y, { steps: 8 });
  assert.equal((await page.locator('.trim-readout').innerText()).trim(), 'Ripple trim +24f · +1.00s', 'a live readout while dragging');
  const preview = (await clipBox('C')).x;
  assert.ok(Math.abs(preview - ((await xAt(9)))) < 3, 'C previews where the ripple will put it');
  await page.mouse.up();
  const clips = await settle(c => Math.abs(c.A.duration - 5) < 1e-6);
  near(clips.A.duration, 5, 'A is a second longer'); near(clips.A.start, 0, 'A starts where it did');
  near(clips.B.start, 5, 'B moved along'); near(clips.C.start, 9, 'C moved along');
  assert.equal(await page.locator('.trim-readout').count(), 0, 'the readout goes when the drag ends');
});

test('J/K/L shuttle: K+L and K+J step a frame, L plays, repeated L speeds up, K stops, J runs backward', async t => {
  const { page } = await openScene(t);
  const time = async () => (await page.locator('.timeline-time').innerText()).trim();
  await page.keyboard.down('k'); await page.keyboard.press('l'); await page.keyboard.press('l'); await page.keyboard.press('j'); await page.keyboard.up('k');
  assert.equal(await time(), '00:00:00:01', 'K held: L, L, J steps two frames forward and one back');
  await page.keyboard.press('l'); await page.keyboard.press('l');
  await page.waitForTimeout(600);
  await page.keyboard.press('k');
  const stopped = await time();
  assert.notEqual(stopped, '00:00:00:01', 'L then L shuttles forward');
  await page.waitForTimeout(300);
  assert.equal(await time(), stopped, 'K stops');
  await page.keyboard.press('j'); await page.keyboard.press('j'); await page.keyboard.press('j');
  await page.waitForFunction(() => document.querySelector('.timeline-time')?.textContent?.trim() === '00:00:00:00', null, { timeout: 5000 });
});
