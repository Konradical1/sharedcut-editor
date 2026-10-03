// Browser regressions for user bins, `,` / `.` from the bin, and subtitle-file export (MediaPanel.tsx, shortcuts.ts, DeliverWorkspace.tsx).
// Run: node --experimental-strip-types --test src/components/binsSubtitles.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome). Needs ffmpeg for the still.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import { defaultShape } from '../services/shapes.ts';
import { captionDocument } from '../services/captions.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-bins-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('a new bin takes media moved into it, `,` inserts and `.` overwrites the bin pick at the playhead, and captions download as SRT', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-bins-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }), page = await context.newPage();
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Bin Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('bins@example.test');
  await page.locator('input[type=password]').fill('Bins-and-subtitles-test-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Bins');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();
  const server = async () => (await (await context.request.get(`${url}/api/state`)).json()) as { revision: number; state: { projects: { id: string }[]; timelines: { id: string }[]; media: { id: string; binId: string; status: string }[]; clips: { id: string; mediaId: string; start: number; duration: number }[] } };
  const { state: { projects: [{ id: project }], timelines: [{ id: timelineId }] } } = await server();

  // A ready still to insert: ffmpeg makes it, the chunked upload route takes it, the server prepares it.
  const still = join(temp, 'still.png'); execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', still]);
  const bytes = await readFile(still);
  assert.ok((await context.request.post(`${url}/api/media?projectId=${project}&id=still&name=still.png&placeholder=1`)).ok());
  await context.request.post(`${url}/api/media/still/upload`, { data: { size: bytes.length, fingerprint: `still.png:${bytes.length}:1` } });
  assert.equal((await context.request.put(`${url}/api/media/still/upload`, { headers: { 'upload-offset': '0', 'upload-checksum': createHash('sha256').update(bytes).digest('hex') }, data: bytes })).status(), 202);
  for (let i = 0; i < 100 && (await server()).state.media[0].status !== 'ready'; i++) await page.waitForTimeout(100);
  assert.equal((await server()).state.media[0].status, 'ready');

  // A rectangle on V1 for the insert to cut, and two caption lines.
  const words = (text: string) => text.split(' ').map((word, i) => ({ text: word, start: i * .4, end: i * .4 + .3 }));
  const caption = (id: string, start: number, duration: number, text: string) => ({ id, projectId: project, timelineId, trackId: 'captions', mediaId: 'frameline-title', name: text, start, duration, sourceIn: 0, color: '#8970b6', disabled: false, properties: { captionSet: 'set-1', textDocument: JSON.stringify(captionDocument(words(text), 'movie', duration)) }, effects: [] });
  for (let attempt = 0; ; attempt++) {
    const { revision } = await server();
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision, delta: {
      tracks: { upsert: [{ id: 'captions', timelineId, name: 'Captions', kind: 'video', number: 9, muted: true, solo: false, locked: false, hidden: false, gain: 0, pan: 0, captionSets: [{ id: 'set-1', start: 0, end: 10, signature: 'test', trackIds: [], wordsPerLine: 5, preset: 'movie', jobId: 'job-1' }] }], remove: [] },
      clips: { upsert: [{ id: 'A', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: 'frameline-shape', name: 'A', start: 0, duration: 4, sourceIn: 0, color: '#b8894f', disabled: false, properties: { shapeDocument: JSON.stringify(defaultShape('rectangle')) }, effects: [] }, caption('cap-2', 3.5, 2.5, 'Second line'), caption('cap-1', 1, 2, 'First line')], remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the scene is saved: ${await patched.text()}`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.locator('[data-clip="A"]').first().waitFor();

  // Bins: make one, move the still into it from the context menu.
  await page.getByRole('button', { name: 'Bins', exact: true }).click();
  await page.getByRole('button', { name: 'New bin…' }).click();
  await page.getByRole('textbox', { name: 'Bin name' }).fill('Selects');
  await page.getByRole('button', { name: 'Create bin', exact: true }).click();
  const folder = page.getByRole('combobox', { name: 'Folder' });
  assert.match(await folder.locator('option:checked').innerText(), /^Selects · 0$/, 'the new bin opens, empty');
  await folder.selectOption('all');
  await page.getByRole('button', { name: 'Select media still.png' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Bin…' }).click();
  await page.getByRole('combobox', { name: 'Destination bin' }).selectOption({ label: 'Selects' });
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  let binId = '';
  for (let i = 0; i < 50 && !(binId = (await server()).state.media[0].binId).startsWith('bin-'); i++) await page.waitForTimeout(100);
  assert.match(binId, /^bin-/, 'the still sits in the new bin on the server');
  await page.getByText('Selects · 1').waitFor({ state: 'attached' });

  // `,` at 2 s cuts A and pushes its tail past the 5 s still; undo; `.` overwrites the tail instead.
  await page.getByRole('button', { name: 'Select media still.png' }).click();
  for (let i = 0; i < 48; i++) await page.keyboard.press('ArrowRight');
  const settle = async (want: (clips: { id: string; mediaId: string; start: number; duration: number }[]) => boolean) => { for (let i = 0; i < 50; i++) { const { clips } = (await server()).state; if (want(clips)) return clips; await page.waitForTimeout(100); } return (await server()).state.clips; };
  await page.keyboard.press(',');
  let clips = await settle(c => c.some(x => x.mediaId === 'still'));
  const placed = clips.find(c => c.mediaId === 'still')!;
  assert.deepEqual([placed.start, placed.duration], [2, 5], 'the still lands on the playhead');
  assert.equal(clips.find(c => c.id === 'A')!.duration, 2);
  assert.ok(clips.some(c => c.mediaId === 'frameline-shape' && c.start === 7 && c.duration === 2), 'insert pushes the rest of A right');
  await page.keyboard.press('Control+z');
  await settle(c => !c.some(x => x.mediaId === 'still'));
  await page.keyboard.press('.');
  clips = await settle(c => c.some(x => x.mediaId === 'still'));
  assert.deepEqual(clips.filter(c => c.mediaId === 'frameline-shape').map(c => [c.start, c.duration]), [[0, 2]], 'overwrite replaces the tail instead of pushing it');

  // Subtitles: the render range covers both lines; the SRT is built in the browser.
  await page.getByRole('button', { name: 'Deliver', exact: true }).click();
  await page.getByRole('button', { name: 'Subtitles', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download SRT' }).click()]);
  assert.match(download.suggestedFilename(), /\.srt$/);
  assert.equal(await readFile((await download.path())!, 'utf8'), '1\n00:00:01,000 --> 00:00:03,000\nFirst line\n\n2\n00:00:03,500 --> 00:00:06,000\nSecond line\n');
});
