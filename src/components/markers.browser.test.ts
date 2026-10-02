// Browser regressions for timeline markers, Delete Gaps and jumping to a collaborator's playhead.
// Run: node --experimental-strip-types --test src/components/markers.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import { defaultShape } from '../services/shapes.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-markers-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

interface Spec { id: string; track: 'v1' | 'v2' | 'v3'; start: number; duration: number }
const near = (a: number, b: number, why: string, within = 1 / 23) => assert.ok(Math.abs(a - b) <= within, `${why}: ${a} vs ${b}`);

async function signUp(page: Page, url: string, name: string, email: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill(name);
  await page.getByRole('textbox', { name: 'Email address' }).fill(email);
  await page.locator('input[type=password]').fill('Markers-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
}

async function openScene(t: { after: (fn: () => Promise<void>) => void }, specs: Spec[], options: { shared?: boolean } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-markers-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  page.on('pageerror', e => console.error('PAGEERROR', e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await signUp(page, url, 'Marker Owner', 'owner@example.test');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Markers');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  let project = '';
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), timelineId = view.state.timelines[0].id;
    project = view.state.projects[0].id;
    const upsert = specs.map(c => ({ id: c.id, projectId: project, timelineId, trackId: `${project}-${c.track}`, mediaId: 'frameline-shape', name: c.id, start: c.start, duration: c.duration, sourceIn: 0, color: '#b8894f', disabled: false, properties: { shapeDocument: JSON.stringify(defaultShape('rectangle')) }, effects: [] }));
    const projects = options.shared ? { projects: { upsert: [{ ...view.state.projects[0], shared: true }], remove: [] } } : {};
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert, remove: [] }, ...projects } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the scene is saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.locator('.timeline-clip').first().waitFor();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom timeline in', exact: true }).click();
  return { page, context, url, ...helpers(page, context, url) };
}

function helpers(page: Page, context: BrowserContext, url: string) {
  const server = async () => (await (await context.request.get(`${url}/api/state`)).json()).state;
  const markers = async (): Promise<{ id: string; time: number; name: string; color: string; note?: string }[]> => (await server()).timelines[0].markers ?? [];
  const clips = async (): Promise<Record<string, number>> => Object.fromEntries((await server()).clips.map((c: { id: string; start: number }) => [c.id, c.start]));
  const saved = () => page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  const xAt = async (time: number) => { const lane = page.locator('.track-lane').first(), box = (await lane.boundingBox())!, span = Number(await lane.getAttribute('data-time-span')); return box.x + time * box.width / span; };
  const rulerY = async () => { const box = (await page.locator('.timeline-ruler').boundingBox())!; return box.y + box.height - 6; };
  const clipPoint = async (id: string) => { const box = (await page.locator(`[data-clip="${id}"]`).first().boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  return { server, markers, clips, saved, xAt, rulerY, clipPoint };
}

test('right-click the ruler adds a marker with a note and color; it drags, edits, copies, pastes, deletes and undoes on its own', async t => {
  const { page, markers, clips, saved, xAt, rulerY } = await openScene(t, [{ id: 'A', track: 'v1', start: 0, duration: 4 }, { id: 'B', track: 'v1', start: 10, duration: 4 }]);
  const before = await clips();
  await page.mouse.click(await xAt(2), await rulerY(), { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add marker here…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add marker' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Intro');
  await dialog.getByRole('textbox', { name: 'Note' }).fill('Check focus');
  await dialog.getByRole('radio', { name: 'Color #f0625f' }).click();
  await dialog.getByRole('button', { name: 'Add marker' }).click();
  await saved();
  const first = await markers();
  assert.equal(first.length, 1);
  assert.deepEqual([first[0].name, first[0].note, first[0].color], ['Intro', 'Check focus', '#f0625f']);
  near(first[0].time, 2, 'added where the ruler was right-clicked');

  // Drag it 4.5 s right (clear of clip edges, so no snap).
  const flag = page.getByRole('button', { name: /^Marker Intro at/ }), box = (await flag.boundingBox())!, step = (await xAt(1)) - (await xAt(0));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 4.5 * step, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  await saved();
  near((await markers())[0].time, 6.5, 'dragged');

  // Right-click it to edit the note.
  await flag.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit marker…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit marker' });
  await edit.getByRole('textbox', { name: 'Note' }).fill('Focus fixed');
  await edit.getByRole('button', { name: 'Save' }).click();
  await saved();
  assert.equal((await markers())[0].note, 'Focus fixed');
  // Hovering the flag shows its name and note right away.
  await flag.hover();
  await page.getByRole('tooltip').filter({ hasText: 'Focus fixed' }).filter({ hasText: 'Intro' }).waitFor({ timeout: 2000 });
  await page.mouse.move(10, 10);
  assert.equal(await page.getByRole('tooltip').count(), 0, 'and hides when the pointer leaves');

  // M adds one at the playhead; Shift-click selects both; ⌘C, then ⌘V at 20 s keeps their spacing; Delete removes the pasted pair.
  await page.mouse.click(await xAt(8.5), await rulerY());
  await page.keyboard.press('m'); await saved();
  assert.equal((await markers()).length, 2);
  await flag.click();
  await page.getByRole('button', { name: /^Marker Marker 2 at/ }).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.timeline-marker.selected').count(), 2);
  await page.keyboard.press('ControlOrMeta+c');
  await page.mouse.click(await xAt(20), await rulerY());
  await page.keyboard.press('ControlOrMeta+v'); await saved();
  const pasted = (await markers()).map(m => m.time);
  assert.equal(pasted.length, 4);
  near(pasted[2], 20, 'paste starts at the playhead'); near(pasted[3] - pasted[2], 2, 'spacing kept');
  await page.keyboard.press('Delete'); await saved();
  assert.equal((await markers()).length, 2, 'Delete removes the selected (pasted) markers');

  // The toolbar flag, then Undo: the marker goes, the clips stay.
  await page.getByRole('button', { name: 'Add marker at playhead (M)' }).click(); await saved();
  assert.equal((await markers()).length, 3);
  await page.getByRole('button', { name: 'Undo my action (⌘Z)' }).click(); await saved();
  assert.equal((await markers()).length, 2, 'undo removes the marker it added');
  assert.deepEqual(await clips(), before, 'and touches no clip');
});

test('Delete gaps on a right-clicked group closes the gaps between them, carries a title along, and undoes', async t => {
  const { page, clips, saved, clipPoint, xAt, rulerY } = await openScene(t, [
    { id: 'A', track: 'v1', start: 0, duration: 4 }, { id: 'B', track: 'v1', start: 6, duration: 2 }, { id: 'C', track: 'v1', start: 12, duration: 2 },
    { id: 'T', track: 'v2', start: 12.5, duration: 1 },
  ]);
  const before = await clips();
  for (const [i, id] of ['A', 'B', 'C'].entries()) { const p = await clipPoint(id); if (i) await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); if (i) await page.keyboard.up('Shift'); }
  assert.equal(await page.locator('.timeline-clip.selected').count(), 3);
  const c = await clipPoint('C');
  await page.mouse.click(c.x, c.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete gaps' }).click(); await saved();
  const after = await clips();
  assert.deepEqual([after.A, after.B, after.C, after.T], [0, 4, 6, 6.5]);
  await page.getByRole('button', { name: 'Undo my action (⌘Z)' }).click(); await saved();
  assert.deepEqual(await clips(), before);
  // Ctrl/⌘X cuts the selected clip; ⌘V puts it back at the playhead.
  const b = await clipPoint('B');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.press('ControlOrMeta+x'); await saved();
  assert.equal((await clips()).B, undefined, 'cut removes the clip');
  await page.mouse.click(await xAt(20), await rulerY());
  await page.keyboard.press('ControlOrMeta+v'); await saved();
  assert.ok(Object.values(await clips()).some(start => Math.abs(start - 20) < 1e-6), 'pasted at the playhead');
});

test("clicking a collaborator's name tag moves your playhead to theirs", async t => {
  const { page, url, rulerY, xAt } = await openScene(t, [{ id: 'A', track: 'v1', start: 0, duration: 20 }], { shared: true });
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } }), guest = await other.newPage();
  t.after(() => other.close());
  await signUp(guest, url, 'Riley Guest', 'guest@example.test');
  await guest.getByText('Class', { exact: true }).click();
  await guest.getByRole('button', { name: 'Open Markers' }).click();
  await guest.locator('.timeline-clip').first().waitFor();
  const theirs = helpers(guest, other, url);
  await guest.mouse.click(await theirs.xAt(6), await theirs.rulerY());
  // Their pointer on the timeline is what puts the name tag on it.
  const lane = (await guest.locator('.track-lane').first().boundingBox())!;
  await guest.mouse.move(lane.x + 200, lane.y + lane.height / 2);
  const tag = page.locator('.remote-panel-glow > span', { hasText: 'Riley Guest' });
  await tag.waitFor({ state: 'visible', timeout: 15000 });
  await page.mouse.click(await xAt(15), await rulerY());
  assert.match(await page.locator('.timeline-time').innerText(), /00:00:15:00/);
  await tag.click();
  await page.waitForFunction(() => /00:00:06:00/.test(document.querySelector('.timeline-time')?.textContent ?? ''));
});
