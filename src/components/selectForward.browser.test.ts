// Browser regressions for the Select Forward tool: the gesture lives in Timeline.tsx, which no unit test reaches.
// Run: node --experimental-strip-types --test src/components/selectForward.browser.test.ts
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
import { defaultShape } from '../services/shapes.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-forward-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

// Rectangles on three video tracks, 24 fps. Selecting forward from `D` (8 s) takes D, E, B, F and G; `A` runs across the line and stays behind.
//   v1  A[0-12)             B[14-18)
//   v2     C[2-5)  D[8-12)             E[20-24)
//   v3             F[8-10)       G[16-18)
// Dragging left, B is stopped by A first (2 s), then D by C (3 s), then F by time zero (8 s).
interface Spec { id: string; track: 'v1' | 'v2' | 'v3'; start: number; duration: number; link?: string }
const scene: Spec[] = [
  { id: 'A', track: 'v1', start: 0, duration: 12 }, { id: 'B', track: 'v1', start: 14, duration: 4 },
  { id: 'C', track: 'v2', start: 2, duration: 3 }, { id: 'D', track: 'v2', start: 8, duration: 4 }, { id: 'E', track: 'v2', start: 20, duration: 4 },
  { id: 'F', track: 'v3', start: 8, duration: 2 }, { id: 'G', track: 'v3', start: 16, duration: 2 },
];
const ROOM = 2, ZOOM_IN = 4;
type Clips = Record<string, { start: number; duration: number; track: string }>;

async function openScene(t: { after: (fn: () => Promise<void>) => void }, specs: Spec[], options: { locked?: string[]; filler?: number } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-forward-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Forward Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('forward@example.test');
  await page.locator('input[type=password]').fill('Forward-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Select forward');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  // The app saves on its own just after the project exists; a 409 means the revision moved, so read again.
  let project = '';
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), timelineId = view.state.timelines[0].id;
    project = view.state.projects[0].id;
    const clips = [...specs, ...Array.from({ length: options.filler ?? 0 }, (_, i): Spec => ({ id: `fill${i}`, track: (['v1', 'v2', 'v3'] as const)[i % 3], start: 30 + Math.floor(i / 3) * 1.5, duration: 1 }))];
    const upsert = clips.map(c => ({ id: c.id, projectId: project, timelineId, trackId: `${project}-${c.track}`, mediaId: 'frameline-shape', name: c.id, start: c.start, duration: c.duration, sourceIn: 0, color: '#b8894f', disabled: false, properties: { shapeDocument: JSON.stringify(defaultShape('rectangle')), ...(c.link ? { linkGroup: c.link } : {}) }, effects: [] }));
    const locked = view.state.tracks.filter((track: { id: string }) => options.locked?.some(id => track.id === `${project}-${id}`)).map((track: object) => ({ ...track, locked: true }));
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert, remove: [] }, ...(locked.length ? { tracks: { upsert: locked, remove: [] } } : {}) } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, 'the scene is saved');
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole('button', { name: /Select forward/ }).waitFor();
  await page.locator('.timeline-clip').first().waitFor();
  for (let i = 0; i < ZOOM_IN; i++) await page.getByRole('button', { name: 'Zoom timeline in', exact: true }).click();
  const state = async (): Promise<Clips> => Object.fromEntries((await (await context.request.get(`${url}/api/state`)).json()).state.clips.map((c: { id: string; start: number; duration: number; trackId: string }) => [c.id, { start: c.start, duration: c.duration, track: c.trackId.slice(project.length + 1) }]));
  const saved = () => page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  // Screen position of a time on the lanes, and of a track's row.
  const laneBox = async (track = 'v1') => (await page.locator(`[data-track="${project}-${track}"]`).boundingBox())!;
  const xAt = async (time: number) => { const lane = page.locator('.track-lane').first(), box = (await lane.boundingBox())!, span = Number(await lane.getAttribute('data-time-span')); return box.x + time * box.width / span; };
  const clipPoint = async (id: string) => { const box = (await page.locator(`[data-clip="${id}"]`).first().boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const hint = async () => (await page.locator('.timeline-hint').innerText()).replace(/\s+/g, ' ').trim();
  const press = async (id: string) => { const p = await clipPoint(id); await page.mouse.move(p.x, p.y); await page.mouse.down(); return p; };
  return { page, context, url, project, state, saved, laneBox, xAt, clipPoint, hint, press };
}
const moved = (before: Clips, after: Clips) => Object.keys(before).filter(id => Math.abs(before[id].start - after[id].start) > 1e-9 || before[id].track !== after[id].track || Math.abs(before[id].duration - after[id].duration) > 1e-9);
const near = (a: number, b: number, why: string) => assert.ok(Math.abs(a - b) < 1e-6, `${why}: ${a} vs ${b}`);
const FORWARD = ['B', 'D', 'E', 'F', 'G'];

test('A picks the tool; a plain click selects forward and offers Cut through, which cuts at the line in one undo step', async t => {
  const { page, state, saved, press, hint } = await openScene(t, scene);
  const button = page.getByRole('button', { name: 'Select forward tool (A)' });
  assert.ok(!/active/.test(await button.getAttribute('class') ?? ''));
  await page.keyboard.press('a');
  assert.ok(/active/.test(await button.getAttribute('class') ?? ''), 'the A key picks Select Forward');
  const before = await state();
  await press('D'); await page.mouse.up();
  assert.equal(await hint(), '5 clips from 00:00:08:00 · 1 cross the line Cut through', 'a click that never moved still offers the cut');
  assert.equal(await page.locator('.timeline-clip.selected').count(), 5);
  assert.deepEqual(moved(before, await state()), [], 'a click moves nothing');
  await page.getByRole('button', { name: 'Cut through', exact: true }).click(); await saved();
  const after = await state();
  assert.equal(Object.keys(after).length, 8, 'one clip was split');
  near(after.A.duration, 8, 'A now ends at the line, not at the playhead'); near(after.A.start, 0, 'A keeps its start');
  assert.equal(await hint(), '6 clips from 00:00:08:00', 'the right half joined the selection and nothing crosses any more');
  await page.getByRole('button', { name: 'Undo my action (⌘Z)' }).click(); await saved();
  assert.deepEqual(await state(), before, 'one undo puts everything back');
});

test('a click on empty lane space selects from there and the same gesture drags it, in time only', async t => {
  const { page, state, saved, xAt, laneBox, hint } = await openScene(t, scene);
  await page.keyboard.press('a');
  const before = await state(), lane = await laneBox('v3'), x = await xAt(7.5), step = (await xAt(1)) - (await xAt(0));
  await page.mouse.move(x, lane.y + lane.height / 2); await page.mouse.down();
  assert.equal(await hint(), '5 clips from 00:00:08:00 · 1 cross the line Cut through');
  const two = (await laneBox('v1')).y - lane.y;
  await page.mouse.move(x + 2 * step, lane.y + lane.height / 2 + two, { steps: 8 });
  assert.match(await hint(), /^Move 5 clips to 00:00:10:00$/);
  await page.mouse.up(); await saved();
  const after = await state();
  assert.deepEqual(moved(before, after).sort(), FORWARD, 'only the forward selection moved');
  for (const id of FORWARD) { near(after[id].start, before[id].start + 2, `${id} moved 2 s`); assert.equal(after[id].track, before[id].track, `${id} stayed on its track`); }
});

test('dragging right with the pointer drifting over other tracks moves the clips in time only', async t => {
  const { page, state, saved, press, xAt, laneBox, hint } = await openScene(t, scene);
  await page.keyboard.press('a');
  const before = await state(), p = await press('D'), step = (await xAt(1)) - (await xAt(0)), top = (await laneBox('v3')).y;
  await page.mouse.move(p.x + 3 * step, top + 4, { steps: 10 });
  assert.match(await hint(), /^Move 5 clips to 00:00:11:00$/, 'over another track the preview carries on');
  // Released over a different track from the one it was grabbed on.
  const low = await laneBox('v1');
  await page.mouse.move(p.x + 3 * step, low.y + low.height / 2, { steps: 10 });
  assert.match(await hint(), /^Move 5 clips to 00:00:11:00$/);
  await page.mouse.up(); await saved();
  const after = await state();
  assert.deepEqual(moved(before, after).sort(), FORWARD);
  for (const id of FORWARD) { near(after[id].start, before[id].start + 3, `${id} moved 3 s`); assert.equal(after[id].track, before[id].track, `${id} stayed on its track`); }
});

test('dragging left stops where the first clip left behind is met, without a snap line to a place it never reaches', async t => {
  const { page, state, saved, press, xAt, hint } = await openScene(t, scene);
  await page.keyboard.press('a');
  const before = await state(), p = await press('D'), step = (await xAt(1)) - (await xAt(0));
  // Three seconds back would put D at C's end (5 s) and the snap would take it there; the room is only 2 s.
  await page.mouse.move(p.x - 3 * step, p.y, { steps: 12 });
  assert.match(await hint(), /^Move 5 clips to 00:00:06:00$/, 'the preview stops at the room');
  assert.equal(await page.locator('.timeline-snap-line').count(), 0, 'no snap line at a place the selection cannot reach');
  await page.mouse.move(p.x - 40 * step, p.y, { steps: 12 });
  assert.match(await hint(), /^Move 5 clips to 00:00:06:00$/);
  await page.mouse.up(); await saved();
  const after = await state();
  assert.deepEqual(moved(before, after).sort(), FORWARD, 'A and C were not overwritten');
  for (const id of FORWARD) near(after[id].start, before[id].start - ROOM, `${id} moved back by the room`);
  near(after.A.duration, 12, 'A is whole');
});

test('Escape cancels a forward drag even while edge scrolling keeps the timeline rendering', async t => {
  const { page, context, state, saved, press, xAt } = await openScene(t, scene, { filler: 240 });
  await page.keyboard.press('a');
  // Heavy renders and a slow CPU are what open the window: a keydown listener that is re-added after every render can be skipped by the dispatch in flight.
  await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const before = await state(), scroll = page.locator('.timeline-scroll'), view = (await scroll.boundingBox())!, step = (await xAt(1)) - (await xAt(0));
  for (let attempt = 1; attempt <= 6; attempt++) {
    await scroll.evaluate(el => { el.scrollLeft = 0; });
    const p = await press('D');
    await page.mouse.move(p.x + 2 * step, p.y, { steps: 4 });
    await page.mouse.move(view.x + view.width - 10, p.y, { steps: 6 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    const stopped = await scroll.evaluate(el => el.scrollLeft);
    await page.waitForTimeout(250);
    const drifted = await scroll.evaluate(el => el.scrollLeft) - stopped;
    await page.mouse.up(); await saved();
    assert.equal(drifted, 0, `attempt ${attempt}: the timeline stopped scrolling at Escape`);
    assert.deepEqual(moved(before, await state()), [], `attempt ${attempt}: releasing after Escape moved nothing`);
  }
});

test('a clip whose linked partner is on a locked track stays out of the selection, and the rest still drags', async t => {
  const linked: Spec[] = [...scene.filter(c => c.id !== 'G'), { id: 'G', track: 'v3', start: 16, duration: 2, link: 'pair' }, { id: 'H', track: 'v1', start: 20, duration: 2, link: 'pair' }];
  const { page, state, saved, press, hint, xAt } = await openScene(t, linked, { locked: ['v3'] });
  await page.keyboard.press('a');
  const before = await state(), p = await press('D'), step = (await xAt(1)) - (await xAt(0));
  // F and G are on the locked v3 and H is G's partner: those three stay put; B, D and E remain.
  assert.equal(await hint(), '3 clips from 00:00:08:00 · 1 cross the line Cut through');
  await page.mouse.move(p.x + 2 * step, p.y, { steps: 8 }); await page.mouse.up(); await saved();
  const after = await state();
  assert.deepEqual(moved(before, after).sort(), ['B', 'D', 'E']);
  for (const id of ['B', 'D', 'E']) near(after[id].start, before[id].start + 2, `${id} moved 2 s`);
  // Clicking the pinned clip itself selects what follows it but there is nothing of it to drag, and it says why.
  await press('H'); await page.mouse.up();
  await page.getByText('A linked clip is on a locked track').waitFor();
  assert.deepEqual(moved(after, await state()), []);
});

test('a hand-picked selection carried into the tool gets no line and no Cut through', async t => {
  const { page, press, hint } = await openScene(t, scene);
  await press('D'); await page.mouse.up();
  await page.keyboard.press('a');
  assert.equal(await hint(), 'Click a clip or empty space to select everything after it', 'one clip picked with V is not a forward selection');
  assert.equal(await page.locator('.timeline-forward-line').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cut through', exact: true }).count(), 0);
});
