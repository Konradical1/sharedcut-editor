// Plan end to end in a real browser: script typing and exports, the shot list with a take, the mood board and the Color
// reference, a second editor seeing a held line, layout at phone to desktop widths, and screenshots in artifacts/qa/.
// Run: PLAYWRIGHT_EXECUTABLE_PATH=<chrome> node --experimental-strip-types --test src/components/plan.browser.test.ts
// DIST=<built dist> skips the build; without a Chrome path the installed Chrome is used. Needs FFmpeg (pictures get thumbnails).
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)), qa = join(root, 'artifacts', 'qa');
const ready = (() => { try { execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let browser: Browser, dist = process.env.DIST ?? '', built = '', temp = '', url = '', projectId = '';
let app: ReturnType<typeof createFrameLineServer>, context: BrowserContext, page: Page;
const refused: string[] = [];
afterEach(() => { assert.deepEqual(refused.splice(0), [], 'no lock request was refused'); });

type Block = { id: string; projectId: string; kind: string; text: string; order: number };
type Shot = { id: string; number: string; sceneId?: string; text: string; size?: string; movement?: string; notes?: string; done?: boolean; order: number };
type Clip = { id: string; projectId: string; mediaId: string; start: number; duration: number };
type Card = { id: string; kind: string; x: number; y: number; w: number; h: number; text?: string; color?: string; mediaId?: string };
const server = async () => (await (await context.request.get(`${url}/api/state`)).json()).state;
const byOrder = <T extends { order: number }>(list: T[]) => [...list].sort((a, b) => a.order - b.order);
const lines = async (): Promise<Block[]> => byOrder((await server()).scriptBlocks.filter((b: Block) => b.projectId === projectId));
const shotList = async (): Promise<Shot[]> => byOrder((await server()).shots);
const cards = async (): Promise<Card[]> => (await server()).boardItems;
/** Polls until `check` returns something truthy; fails with `what` and the last value. */
async function until<T>(check: () => Promise<T> | T, what: string, timeout = 20_000): Promise<Exclude<T, false | 0 | '' | null | undefined>> {
  const end = Date.now() + timeout; let last: T | undefined;
  while (Date.now() < end) { last = await check(); if (last) return last as Exclude<T, false | 0 | '' | null | undefined>; await new Promise(r => setTimeout(r, 150)); }
  assert.fail(`${what} (last: ${JSON.stringify(last)})`);
}
const focused = (p: Page = page) => p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
const focusIs = (label: string, p: Page = page) => until(async () => (await focused(p)) === label, `focus on "${label}"`, 5000);
// macOS moves the caret to a line's ends with ⌘←/⌘→ (Home and End scroll there).
const lineStart = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home', lineEnd = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';
const nav = (p: Page = page) => p.getByRole('navigation', { name: 'Editor workspaces' });
const tab = (name: 'Script' | 'Shots' | 'Board', p: Page = page) => p.getByRole('tab', { name, exact: true });
const openTab = async (name: 'Script' | 'Shots' | 'Board', p: Page = page) => { await tab(name, p).click(); await until(async () => await tab(name, p).getAttribute('aria-selected') === 'true', `${name} tab open`); };
/** A PNG drawn in the page: circus-tent stripes in exactly two colors, or a warm spotlight for a take. */
const png = async (kind: 'tent' | 'take') => Buffer.from(await page.evaluate(kind => {
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 400 }), g = c.getContext('2d')!;
  if (kind === 'tent') for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#f1e4c3' : '#b3202a'; g.fillRect(i * 40, 0, 40, 400); }
  else { const r = g.createRadialGradient(320, 150, 8, 320, 210, 300); r.addColorStop(0, '#ffd88a'); r.addColorStop(.35, '#a8642c'); r.addColorStop(1, '#140f0c'); g.fillStyle = r; g.fillRect(0, 0, 640, 400); }
  return c.toDataURL('image/png').split(',')[1];
}, kind), 'base64');

async function signUp(p: Page, name: string, email: string) {
  await p.goto(url);
  await p.getByRole('button', { name: 'Create account', exact: true }).click();
  await p.getByRole('textbox', { name: 'Your name' }).fill(name);
  await p.getByRole('textbox', { name: 'Email address' }).fill(email);
  await p.locator('input[type=password]').fill('Plan-test-password-2026');
  await p.getByRole('button', { name: 'Create account', exact: true }).last().click();
}

before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-plan-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
  await mkdir(qa, { recursive: true });
  temp = await mkdtemp(join(tmpdir(), 'frameline-plan-'));
  app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }); page = await context.newPage();
  page.on('pageerror', e => console.error('PAGEERROR', e.message));
  // A lock the server refuses is a toast the user sees ("Lock target not found."); each test checks there were none.
  page.on('response', r => { if (r.url().endsWith('/api/locks') && !r.ok() && r.request().method() !== 'DELETE') refused.push(`${r.status()} ${r.request().postData()}`); });
  await signUp(page, 'Ada Director', 'ada@example.test');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Pippin Trailer');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  // A class project, so a second account opens it as an Editor.
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(); projectId = view.state.projects[0].id;
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { projects: { upsert: [{ ...view.state.projects[0], shared: true }], remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the project is shared (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload(); await page.locator('.timeline-track').first().waitFor();
});
after(async () => { await context?.close(); await browser?.close(); await app?.close(); if (temp) await rm(temp, { recursive: true, force: true }); if (built) await rm(built, { recursive: true, force: true }); });

test('script: Enter picks the next element, Tab cycles it, Backspace joins, and the server keeps kinds and order', async () => {
  await nav().getByRole('button', { name: 'Plan', exact: true }).click();
  await until(async () => await tab('Script').getAttribute('aria-selected') === 'true', 'Plan opens on the Script tab');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  await focusIs('Scene heading line');
  await page.keyboard.type('int. circus tent - day'); await page.keyboard.press('Enter');
  await focusIs('Action line');
  await page.keyboard.type('Lanterns sway over the empty ring. THEO, the Leading Player, steps into the only light.'); await page.keyboard.press('Enter');
  await focusIs('Action line');
  await page.keyboard.type('THEO'); await page.keyboard.press('Enter');
  await focusIs('Dialogue line');
  assert.equal(await page.getByRole('textbox', { name: 'Character line' }).inputValue(), 'THEO', 'the caps line became a character cue');
  await page.keyboard.type('Join us! Leave your fields to flower.');
  await page.keyboard.press('Tab'); await focusIs('Transition line');
  await page.keyboard.press('Shift+Tab'); await focusIs('Dialogue line');
  // A new line, then Backspace at its start: it joins the dialogue above, caret at the join.
  await page.keyboard.press('Enter'); await focusIs('Character line');
  await page.keyboard.type(' We have magic to do.'); await page.keyboard.press(lineStart); await page.keyboard.press('Backspace');
  await focusIs('Dialogue line');
  assert.equal(await page.evaluate(() => { const el = document.activeElement as HTMLTextAreaElement; return [el.value, el.selectionStart]; }).then(([v, at]) => `${v}|${at}`), 'Join us! Leave your fields to flower. We have magic to do.|37');
  await page.keyboard.press(lineEnd); await page.keyboard.press('Enter'); await focusIs('Character line');
  await page.keyboard.press('Enter'); await focusIs('Action line'); // Enter on an empty line makes it action
  await page.keyboard.type('Acrobats tumble from the rigging as the band kicks in.'); await page.keyboard.press('Enter');
  await page.keyboard.type('ext. big top - night'); await page.keyboard.press('Enter'); await focusIs('Action line');
  await page.keyboard.type('The crowd spills out under strings of bulbs.');
  await page.locator('.script-footer').click(); // blur: the last line commits
  const want = [['scene', 'int. circus tent - day'], ['action', 'Lanterns sway over the empty ring. THEO, the Leading Player, steps into the only light.'], ['character', 'THEO'], ['dialogue', 'Join us! Leave your fields to flower. We have magic to do.'], ['action', 'Acrobats tumble from the rigging as the band kicks in.'], ['scene', 'ext. big top - night'], ['action', 'The crowd spills out under strings of bulbs.']];
  await until(async () => JSON.stringify((await lines()).map(b => [b.kind, b.text])) === JSON.stringify(want), 'the server holds the scene, line by line', 15_000)
    .catch(async error => { console.error('server lines', JSON.stringify((await lines()).map(b => [b.kind, b.text]))); throw error; });
  assert.equal(await page.locator('.script-outline-list > button').count(), 2, 'the outline lists both scenes');
});

test('export: Word and Fountain downloads hold the script', async () => {
  const exported = async (item: string) => {
    await page.locator('.plan-actions').getByRole('button', { name: 'Export' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item }).click()]);
    return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
  };
  const docx = await exported('Download Word (.docx)');
  assert.match(docx.name, /\.docx$/); assert.equal(docx.bytes.subarray(0, 2).toString('latin1'), 'PK', 'a zip (docx) file');
  const fountain = await exported('Download Fountain (.fountain)');
  assert.match(fountain.name, /\.fountain$/);
  const text = fountain.bytes.toString('utf8');
  assert.match(text, /INT\. CIRCUS TENT - DAY/i); assert.match(text, /\nTHEO\n/); assert.match(text, /We have magic to do\./);
});

test('shots: one per scene, edit and tick a row, a take by name shows in the row and the bin, Show in script returns', { skip: !ready && 'needs FFmpeg' }, async () => {
  await openTab('Shots');
  await page.getByRole('button', { name: 'One shot per scene' }).click();
  const scenes = (await lines()).filter(b => b.kind === 'scene').map(b => b.id);
  await until(async () => JSON.stringify((await shotList()).map(s => [s.number, s.sceneId])) === JSON.stringify([['1A', scenes[0]], ['2A', scenes[1]]]), 'shots 1A and 2A under their scenes');
  await page.locator('tr.shot-group', { hasText: /circus tent/i }).getByRole('button', { name: 'shot', exact: true }).click();
  await until(async () => (await shotList()).map(s => s.number).join() === '1A,1B,2A', 'shot 1B joins scene 1, before 2A');
  const fill = async (number: string, values: { text: string; size: string; movement: string; cast: string; location: string; notes?: string }) => {
    await page.getByRole('textbox', { name: `Shot ${number} description` }).fill(values.text);
    await page.getByRole('combobox', { name: `Shot ${number} size` }).selectOption(values.size);
    await page.getByRole('combobox', { name: `Shot ${number} movement` }).selectOption(values.movement);
    await page.getByRole('textbox', { name: `Shot ${number} cast` }).fill(values.cast);
    await page.getByRole('textbox', { name: `Shot ${number} location` }).fill(values.location);
    if (values.notes) await page.getByRole('textbox', { name: `Shot ${number} notes` }).fill(values.notes);
  };
  await fill('1A', { text: 'Wide on the ring as Theo steps into the spotlight', size: 'WS', movement: 'Push in', cast: 'Theo', location: 'Circus tent', notes: 'Haze on, single follow spot' });
  await fill('1B', { text: 'Acrobats drop from the rigging, low angle', size: 'MS', movement: 'Crane', cast: 'Acrobats', location: 'Circus tent' });
  await fill('2A', { text: 'Crowd leaves under the bulbs', size: 'EWS', movement: 'Static', cast: 'Ensemble', location: 'Big top, exterior' });
  await page.getByRole('checkbox', { name: 'Shot 1A done' }).check();
  await until(async () => { const a = (await shotList())[0]; return a.text === 'Wide on the ring as Theo steps into the spotlight' && a.size === 'WS' && a.movement === 'Push in' && a.done === true; }, 'shot 1A saved with its description, size, move and done');

  // A take named by shot number links itself: uploaded raw, as Grab still's fallback does.
  const posted = await context.request.post(`${url}/api/media?${new URLSearchParams({ projectId, name: '1A_take1.png' })}`, { data: await png('take'), headers: { 'content-type': 'image/png' } });
  assert.ok(posted.ok(), `uploaded (${posted.status()} ${await posted.text()})`);
  const take = (await posted.json()).asset.id as string;
  await until(async () => (await server()).media.find((m: { id: string; status: string }) => m.id === take)?.status === 'ready', 'the take is prepared', 90_000);
  const row = page.locator('tr.shot-row', { has: page.getByRole('textbox', { name: 'Shot 1A number' }) });
  await row.locator('.shot-take img').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.shot-tip').count(), 0, 'the take-naming tip goes once a take links');
  await row.getByRole('button', { name: 'Show 1A_take1.png in media' }).click();
  await until(async () => await nav().getByRole('button', { name: 'Edit', exact: true }).getAttribute('aria-current') === 'page', 'revealing a take opens Edit');
  const badge = page.getByRole('button', { name: 'Shot 1A — show in shot list' });
  await badge.waitFor({ timeout: 10_000 });
  await badge.click();
  await until(async () => await tab('Shots').getAttribute('aria-selected') === 'true', 'the badge opens the shot list');
  await page.locator('tr.shot-row.flash').waitFor({ timeout: 5000 });
  await page.locator('tr.shot-group', { hasText: /circus tent/i }).getByRole('button', { name: 'Show in script' }).click();
  await until(async () => await tab('Script').getAttribute('aria-selected') === 'true', 'Show in script opens the Script tab');
  await focusIs('Scene heading line');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), 'int. circus tent - day', 'on that scene');
  assert.equal(await page.locator('.script-shots').first().innerText().then(t => t.replace(/\s+/g, ' ').trim()), '2 shots', 'the scene heading counts its shots');
});

test('board: notes, a drag, a swatch, an uploaded picture, Pull colors and Compare on Color page', { skip: !ready && 'needs FFmpeg' }, async () => {
  await openTab('Board');
  const viewport = page.locator('.board-viewport'); await viewport.waitFor();
  // An empty board opens at 100% with 0,0 in the middle.
  const box = (await viewport.boundingBox())!, at = (x: number, y: number) => ({ x: box.x + box.width / 2 + x, y: box.y + box.height / 2 + y });
  await page.getByRole('button', { name: 'Add note' }).click();
  await focusIs('Note text');
  await page.keyboard.type('Warm tungsten. Haze hangs in the spotlight.'); await page.keyboard.press('Escape');
  const note = await until(async () => (await cards()).find(c => c.kind === 'note' && c.text === 'Warm tungsten. Haze hangs in the spotlight.'), 'the note and its text are saved');
  const el = page.locator(`[data-board-card="${note.id}"]`), from = (await el.boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + 40); await page.mouse.down();
  await page.mouse.move(from.x + 40 + 380, from.y + 40 - 120, { steps: 12 }); await page.mouse.up();
  const moved = await until(async () => { const c = (await cards()).find(c => c.id === note.id)!; return c.x - note.x > 300 && note.y - c.y > 80 && c; }, 'the drag is saved');
  assert.ok(Math.abs(moved.x - note.x - 380) < 8 && Math.abs(note.y - moved.y - 120) < 8, `moved by the drag: ${moved.x - note.x}, ${moved.y - note.y}`);

  await page.getByRole('button', { name: 'Add color swatch' }).click();
  const swatch = await until(async () => (await cards()).find(c => c.kind === 'swatch'), 'a swatch is added');
  await page.locator('input[type=color][aria-label="Card color"]').fill('#e8b04a');
  await until(async () => (await cards()).find(c => c.id === swatch.id)?.color === '#e8b04a', 'the swatch takes the picked color');
  await page.keyboard.press('Escape');
  // Out of the way of the picture coming to the middle.
  const sw = (await page.locator(`[data-board-card="${swatch.id}"]`).boundingBox())!;
  await page.mouse.move(sw.x + 30, sw.y + 30); await page.mouse.down(); await page.mouse.move(at(260, 40).x, at(260, 40).y, { steps: 8 }); await page.mouse.up();

  await page.locator('input[aria-label="Upload images to the board"]').setInputFiles({ name: 'big-top-stripes.png', mimeType: 'image/png', buffer: await png('tent') });
  const image = await until(async () => (await cards()).find(c => c.kind === 'image'), 'the uploaded picture becomes a card', 30_000);
  await until(async () => (await server()).media.find((m: { id: string; status: string; binId: string }) => m.id === image.mediaId && m.status === 'ready' && m.binId === 'board'), 'the picture is prepared, in the Mood board bin', 90_000);
  const picture = page.locator(`[data-board-card="${image.id}"]`);
  await picture.locator('img').waitFor({ timeout: 15_000 });
  const swatches = (await cards()).filter(c => c.kind === 'swatch').length;
  await picture.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pull colors' }).click();
  const pulled = await until(async () => { const list = (await cards()).filter(c => c.kind === 'swatch' && c.y > image.y + image.h); return list.length >= 2 && list; }, 'Pull colors adds swatches under the picture');
  assert.equal((await cards()).filter(c => c.kind === 'swatch').length, swatches + pulled.length);
  const near = (hex: string, to: string) => [1, 3, 5].every(i => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(to.slice(i, i + 2), 16)) < 24);
  assert.ok(pulled.some(c => near(c.color!, '#b3202a')) && pulled.some(c => near(c.color!, '#f1e4c3')) && pulled.every(c => near(c.color!, '#b3202a') || near(c.color!, '#f1e4c3')), `the stripes' red and cream, no blend of the two: ${pulled.map(c => c.color)}`);

  // More board for the screenshot: a second note and a title, placed from the board menu.
  await page.mouse.click(at(-560, -150).x, at(-560, -150).y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add note here' }).click(); await focusIs('Note text');
  await page.keyboard.type('Costumes: red and gold, worn velvet, sequins that catch the follow spot.'); await page.keyboard.press('Escape');
  await page.mouse.click(at(-180, -230).x, at(-180, -230).y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add text here' }).click(); await focusIs('Board text');
  await page.keyboard.type('Magic to Do'); await page.keyboard.press('Escape');
  await until(async () => (await cards()).filter(c => c.text).length === 3, 'both notes and the title are saved');

  await picture.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compare on Color page' }).click();
  const reference = page.getByRole('complementary', { name: 'Mood board reference picture' });
  await reference.locator('img').waitFor({ timeout: 10_000 });
  assert.equal(await nav().getByRole('button', { name: 'Color', exact: true }).getAttribute('aria-current'), 'page');
  await page.screenshot({ path: join(qa, 'plan-color-reference.png') });
  await reference.getByRole('button', { name: 'Close reference picture' }).click();
  await reference.waitFor({ state: 'detached', timeout: 5000 });
});

test('board: a slow drag is one history row; Add to timeline lands after the last clip, never over one', { skip: !ready && 'needs FFmpeg' }, async () => {
  await nav().getByRole('button', { name: 'Plan', exact: true }).click(); await openTab('Board');
  const note = (await cards()).find(c => c.kind === 'note' && c.text?.startsWith('Warm tungsten'))!, rows = async () => (await server()).operations.filter((o: { type: string }) => o.type === 'BoardChanged').length;
  const before = await rows(), from = (await page.locator(`[data-board-card="${note.id}"]`).boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + 40); await page.mouse.down();
  for (let i = 1; i <= 15; i++) { await page.mouse.move(from.x + 40 + i * 4, from.y + 40); await page.waitForTimeout(60); }
  await page.mouse.up();
  await until(async () => (await cards()).find(c => c.id === note.id)!.x - note.x > 50, 'the drag is saved');
  await page.waitForTimeout(500);
  assert.equal(await rows(), before + 1, 'a second-long drag writes one history row, not one per 120 ms');

  const image = (await cards()).find(c => c.kind === 'image')!, clips = async (): Promise<Clip[]> => (await server()).clips.filter((c: Clip) => c.projectId === projectId);
  const old = await clips(), end = Math.max(0, ...old.map(c => c.start + c.duration));
  for (let n = 1; n <= 2; n++) {
    await page.locator(`[data-board-card="${image.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to timeline' }).click();
    await until(async () => (await clips()).filter(c => c.mediaId === image.mediaId).length === n, `picture ${n} reaches the timeline`);
  }
  await page.getByText('Added big-top-stripes.png to the end of the timeline').first().waitFor({ timeout: 5000 });
  const now = await clips(), [first, second] = now.filter(c => c.mediaId === image.mediaId).sort((a, b) => a.start - b.start);
  assert.deepEqual(old.map(c => now.find(x => x.id === c.id)), old, 'no clip already there was cut');
  assert.ok(Math.abs(first.start - end) < 1e-6 && Math.abs(second.start - (first.start + first.duration)) < 1e-6, `end to end after the last clip: ${JSON.stringify([end, first, second])}`);
});

test('shots: Escape keeps what was typed; a row added on a slow save locks only once saved', { skip: !ready && 'needs FFmpeg' }, async () => {
  await nav().getByRole('button', { name: 'Plan', exact: true }).click(); await openTab('Shots');
  await page.getByRole('textbox', { name: 'Shot 2A notes' }).click();
  await page.keyboard.type('Hold for'); await page.waitForTimeout(700); await page.keyboard.type(' the last bulb'); await page.keyboard.press('Escape');
  await until(async () => (await shotList()).find(x => x.number === '2A')?.notes === 'Hold for the last bulb', 'Escape keeps the text typed after the idle save');
  // A save slower than the 3 s lease: renewing before the row exists would ask to lock a shot the server lacks (404).
  await page.route('**/api/state', async route => { if (route.request().method() === 'PATCH') await new Promise(r => setTimeout(r, 4000)); await route.fallback(); });
  await page.locator('.plan-actions').getByRole('button', { name: 'Shot', exact: true }).click();
  await focusIs('Shot 1 description');
  await page.waitForTimeout(4500);
  await until(async () => (await shotList()).some(x => x.number === '1'), 'the new shot is saved');
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: 'Shot 1 actions' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await until(async () => !(await shotList()).some(x => x.number === '1'), 'and deleted again');
});

test('collaboration: a line one editor is typing in is read-only, with their name, for another editor', async t => {
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } }), guest = await other.newPage();
  t.after(() => other.close());
  guest.on('pageerror', e => console.error('GUEST PAGEERROR', e.message));
  await signUp(guest, 'Riley Stage', 'riley@example.test');
  await guest.getByText('Class', { exact: true }).click();
  await guest.getByRole('button', { name: 'Open Pippin Trailer' }).click();
  await nav(guest).getByRole('button', { name: 'Plan', exact: true }).click();
  await openTab('Script', guest);
  const line = (p: Page) => p.locator('.script-block').filter({ has: p.locator('textarea[aria-label="Action line"]') }).first();
  await line(guest).locator('textarea').waitFor();
  const free = Date.now();
  await until(async () => await line(guest).locator('textarea').getAttribute('readonly') === null, 'an Editor can write while nobody holds the line', 10_000)
    .catch(async error => { console.error('locks', JSON.stringify((await (await other.request.get(`${url}/api/state`)).json()).locks)); throw error; });
  if (Date.now() - free > 300) console.error(`the line was held for ${Date.now() - free} ms`, JSON.stringify((await (await other.request.get(`${url}/api/state`)).json()).locks));

  await nav().getByRole('button', { name: 'Plan', exact: true }).click(); await openTab('Script');
  const mine = line(page).locator('textarea');
  await mine.click(); await page.keyboard.press(lineEnd);
  await page.keyboard.type(' The band waits.', { delay: 60 });
  const held = line(guest);
  await held.locator('.script-owner', { hasText: 'Ada Director' }).waitFor({ timeout: 10_000 });
  assert.ok(await held.evaluate(el => el.classList.contains('owned')), 'edged in the owner color');
  assert.equal(await held.locator('textarea').getAttribute('readonly'), '', 'read-only for the other editor');
  await held.locator('textarea').click(); // the other editor waits in the held line
  await page.locator('.script-footer').click(); // blur: the lock goes
  await until(async () => await held.locator('textarea').getAttribute('readonly') === null, 'editable again once the typist leaves the line', 12_000);
  await until(async () => (await held.locator('textarea').inputValue()).endsWith('The band waits.'), 'and the other editor sees the typed text');
  // The waiting caret takes the line the moment it frees up, before any typing, so the typing is never unlocked.
  await line(page).locator('.script-owner', { hasText: 'Riley Stage' }).waitFor({ timeout: 10_000 });
  await guest.keyboard.press(lineEnd); await guest.keyboard.type(' The crowd hushes.');
  await guest.locator('.script-footer').click();
  await until(async () => (await lines()).some(b => b.text.endsWith('The band waits. The crowd hushes.')), 'the waiting editor\'s typing is saved');
});

test('script keys: a name is picked only by arrow, Enter at a line start moves it down whole, one press per line, a copied line pastes as text, undo keeps the caret', async () => {
  await nav().getByRole('button', { name: 'Plan', exact: true }).click(); await openTab('Script');
  await page.locator('.script-switcher').click(); await page.getByRole('menuitem', { name: 'New screenplay' }).click();
  await focusIs('Scene heading line');
  const scriptId = (await until(async () => (await server()).scripts.find((x: { name: string }) => x.name === 'Untitled script'), 'the new script is saved')).id as string;
  const mine = async () => byOrder((await server()).scriptBlocks.filter((b: Block & { scriptId: string }) => b.scriptId === scriptId) as Block[]);
  const value = () => page.evaluate(() => { const el = document.activeElement as HTMLTextAreaElement; return `${el.getAttribute('aria-label')}|${el.value}|${el.selectionStart}`; });
  for (const text of ['int. ring - day', 'They sit.', 'SAMANTHA', 'Hi.']) { await page.keyboard.type(text); await page.keyboard.press('Enter'); }
  await focusIs('Character line');
  // SAM beside SAMANTHA: the list offers the longer name, but Enter keeps what was typed and moves on.
  await page.keyboard.type('SAM');
  await page.locator('.script-suggest', { hasText: 'SAMANTHA' }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.script-suggest [aria-selected=true]').count(), 0, 'nothing is picked before an arrow');
  await page.keyboard.press('Enter'); await focusIs('Dialogue line');
  // One line copied with its break pastes into the line, not as a new action line.
  await page.keyboard.type('Again.'); await page.keyboard.press(lineStart);
  await page.evaluate(() => { const data = new DataTransfer(); data.setData('text/plain', 'So \n'); document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
  assert.equal(await value(), 'Dialogue line|So Again.|3');
  // Enter at the start of the heading pushes it down whole: same line (its shots), still a heading, caret kept.
  const scene = (await until(async () => (await mine()).find(b => b.kind === 'scene' && b.text === 'int. ring - day'), 'the heading is saved')).id;
  await page.getByRole('textbox', { name: 'Scene heading line' }).click(); await page.keyboard.press(lineStart); await page.keyboard.press('Enter');
  await until(async () => (await value()) === 'Scene heading line|int. ring - day|0', 'the caret stays on the heading', 5000);
  await until(async () => { const [a, b] = await mine(); return a?.kind === 'action' && !a.text && b?.id === scene && b.kind === 'scene'; }, 'an empty line opens above the heading');
  // Up and down take one press per line, and arriving on a cue opens no list.
  await page.keyboard.press(lineEnd); await page.keyboard.press('ArrowUp');
  assert.equal(await value(), 'Action line||0');
  const walk: string[] = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowDown'); walk.push((await value()).replace(/\|\d+$/, '')); }
  assert.deepEqual(walk, ['Scene heading line|int. ring - day', 'Action line|They sit.', 'Character line|SAMANTHA', 'Dialogue line|Hi.', 'Character line|SAM', 'Dialogue line|So Again.']);
  // An Enter undone at once: the caret goes back to the end of the line above, and typing carries on there.
  await page.keyboard.press(lineEnd); await page.keyboard.press('Enter'); await focusIs('Character line');
  await page.keyboard.press('ControlOrMeta+z'); await focusIs('Dialogue line');
  await page.keyboard.type(' Loudly.');
  await page.locator('.script-footer').click();
  const want = [['action', ''], ['scene', 'int. ring - day'], ['action', 'They sit.'], ['character', 'SAMANTHA'], ['dialogue', 'Hi.'], ['character', 'SAM'], ['dialogue', 'So Again. Loudly.']];
  await until(async () => JSON.stringify((await mine()).map(b => [b.kind, b.text])) === JSON.stringify(want), 'the server holds every line as typed', 15_000)
    .catch(async error => { console.error('server lines', JSON.stringify((await mine()).map(b => [b.kind, b.text]))); throw error; });
  await page.locator('.script-switcher').click(); await page.getByRole('menuitem', { name: 'Delete script…' }).click();
  await page.getByRole('button', { name: 'Delete script', exact: true }).click();
  await until(async () => !(await server()).scripts.some((x: { id: string }) => x.id === scriptId), 'the scratch script is gone again');
});

test('layout: every Plan tab fits 390, 768 and 1440 wide with a one-row toolbar', async () => {
  await nav().getByRole('button', { name: 'Plan', exact: true }).click();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const name of ['Script', 'Shots', 'Board'] as const) {
      await openTab(name);
      await page.locator(name === 'Script' ? '.script-page' : name === 'Shots' ? '.shot-table' : '.board-viewport').waitFor();
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => {
        const header = document.querySelector('.plan-header')!.getBoundingClientRect(), slot = document.querySelector('.plan-actions')!.getBoundingClientRect();
        // Every header control sits inside the one header row: none wrapped above or below it, none cut off at the side.
        const clipped = [...document.querySelectorAll<HTMLElement>('.plan-actions :is(button, select, [role=button])')].filter(el => el.getClientRects().length)
          .map(el => [el.getAttribute('aria-label') ?? el.textContent, el.getBoundingClientRect()] as const)
          .filter(([, r]) => r.top < header.top - 1 || r.bottom > header.bottom + 1 || r.left < slot.left - 1 || r.right > slot.right + 1).map(([what]) => what);
        return { scroll: document.documentElement.scrollWidth, inner: innerWidth, toolbar: document.querySelector('.app-toolbar')!.getBoundingClientRect().height, clipped };
      });
      assert.ok(m.scroll <= m.inner, `${name} at ${width}: no page overflow (${m.scroll} > ${m.inner})`);
      assert.ok(m.toolbar <= 45, `${name} at ${width}: toolbar ${m.toolbar}px`);
      assert.deepEqual(m.clipped, [], `${name} at ${width}: header controls fit the header row`);
    }
  }
});

test('screenshots', async () => {
  const shoot = async (name: 'Script' | 'Shots' | 'Board', file: string) => {
    await openTab(name);
    if (name === 'Board') { await page.getByRole('button', { name: 'Fit board to view' }).click(); await page.locator('.board-image img').first().waitFor(); }
    await page.mouse.move(2, 2); await page.waitForTimeout(400);
    await page.screenshot({ path: join(qa, file) });
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  // Toasts left by earlier tests ("Undone: …") are not part of the page.
  for (const close of await page.getByRole('button', { name: 'Dismiss notification' }).all()) await close.click().catch(() => {});
  await page.locator('.toast-stack .toast').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  for (const [name, file] of [['Script', 'plan-script.png'], ['Shots', 'plan-shots.png'], ['Board', 'plan-board.png']] as const) await shoot(name, file);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, file] of [['Script', 'plan-script-390.png'], ['Shots', 'plan-shots-390.png'], ['Board', 'plan-board-390.png']] as const) await shoot(name, file);
});

// Last: it empties the shot list the screenshots show.
test('shots: Add shot from an emptied, scene-filtered list shows and focuses the new shot', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await nav().getByRole('button', { name: 'Plan', exact: true }).click(); await openTab('Shots');
  const remove = async (number: string) => {
    await page.getByRole('button', { name: `Shot ${number} actions` }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await until(async () => !(await shotList()).some(x => x.number === number), `shot ${number} deleted`);
  };
  await remove('2A');
  await page.getByRole('combobox', { name: 'Scene' }).selectOption({ index: 1 });
  for (const number of (await shotList()).map(x => x.number)) await remove(number);
  await page.getByRole('button', { name: 'Add shot', exact: true }).click();
  await focusIs('Shot 1 description');
  assert.ok(await page.getByRole('textbox', { name: 'Shot 1 number' }).isVisible(), 'the new shot is not hidden by the old scene filter');
});
