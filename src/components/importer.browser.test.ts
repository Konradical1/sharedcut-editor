// sharedcut.com/importer in a real browser: a guest brings a Final Cut export and its footage in, a classmate watches it
// arrive on Projects, and the upload survives a dropped Wi-Fi, a reload and a pause. Every screen and state is saved at
// 1440×900 and 390×844 to artifacts/qa/importer/NN-name-{1440,390}.png.
// Run: npm run test:importer. DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks Chrome; FFMPEG_PATH picks
// FFmpeg (without one the clips are random bytes and the walk stops at Getting it ready).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)), SHOTS = join(root, 'artifacts', 'qa', 'importer');
const CODE = 'class-2026', FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// DEFER_PREP: footage waits at Getting it ready until the classmate's retry prepares it, so that screen is always seen.
const ENV = { FRAME_LINE_SIGNUP_CODE: CODE, FRAME_LINE_MIN_FREE_GB: '0', FRAME_LINE_DEFER_PREP: '1' };
const savedEnv = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
let browser: Browser, app: ReturnType<typeof createFrameLineServer>, url = '', temp = '', dist = process.env.DIST ?? '', video = true;
let a: Page, aContext: BrowserContext, b: Page, bContext: BrowserContext, shotNo = 0;
const problems: string[] = [];
let expect403 = false;

// Final Cut's export: two clips in a library in Movies (one never found), one on an SD card, a title in Barlow Condensed.
const asset = (id: string, path: string, seconds = 2) => `<asset id="${id}" start="0s" duration="${seconds}s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file://${path}"/></asset>`;
const fcpxml = (name: string, uid: string, assets: string, spine: string) => `<?xml version="1.0" encoding="UTF-8"?><fcpxml version="1.11"><resources><format id="r1" frameDuration="100/2500s" width="1920" height="1080"/>${assets}<effect id="t" name="Basic Title"/></resources>
<library><event name="Event 1"><project name="${name}" uid="${uid}"><sequence format="r1" duration="6s" tcStart="0s"><spine>${spine}</spine></sequence></project></event></library></fcpxml>`;
const LIBRARY = '/Users/maya/Movies/School%20Library.fcpbundle/Event%201/Original%20Media';
const film = (words = 'Game day') => fcpxml('My Film', 'FILM-1', asset('a', `${LIBRARY}/A001.mp4`) + asset('b', '/Volumes/SD%20CARD/DCIM/100CANON/C0001.mp4') + asset('c', `${LIBRARY}/A002.mp4`),
  `<asset-clip ref="a" offset="0s" start="0s" duration="2s"><title ref="t" lane="1" offset="0s" start="0s" duration="1s"><text><text-style ref="s">${words}</text-style></text><text-style-def id="s"><text-style font="Barlow Condensed" fontSize="80"/></text-style-def></title></asset-clip><asset-clip ref="b" offset="2s" start="0s" duration="2s"/><asset-clip ref="c" offset="4s" start="0s" duration="2s"/>`);
// The resume pass: a clip bigger than one 8 MiB chunk, and a small one.
// A poster with a title in a font nobody added: the Fonts screen as Safari shows it.
const poster = fcpxml('Poster', 'POS-1', asset('p', '/Users/lee/Desktop/Party.mp4', 1), '<asset-clip ref="p" offset="0s" start="0s" duration="1s"><title ref="t" lane="1" offset="0s" start="0s" duration="1s"><text><text-style ref="s">Party</text-style></text><text-style-def id="s"><text-style font="Futura PT" fontSize="80"/></text-style-def></title></asset-clip>');
const interview = fcpxml('Interview', 'INT-1', asset('i', '/Users/maya/Desktop/Interview/Interview.mp4') + asset('j', '/Users/maya/Desktop/Interview/Cutaway.mp4'),
  '<asset-clip ref="i" offset="0s" start="0s" duration="2s"/><asset-clip ref="j" offset="2s" start="0s" duration="2s"/>');
const at = (...parts: string[]) => join(temp, 'mac', ...parts);
function clip(path: string, seconds: number, big = false) {
  mkdirSync(dirname(path), { recursive: true });
  const source = big ? "nullsrc=s=640x360:r=25,geq=lum='random(1)*255':cb=128:cr=128" : 'testsrc=size=320x180:rate=25';
  if (video) try { execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', ...(big ? ['-preset', 'ultrafast', '-qp', '0'] : []), path]); return; } catch { video = false; }
  writeFileSync(path, randomBytes(big ? 12 * 1024 * 1024 : seconds * 32 * 1024));
}

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sharedcut-importer-browser-'));
  clip(at('Movies', 'School Library.fcpbundle', 'Event 1', 'Original Media', 'A001.mp4'), 2);
  clip(at('SD CARD', 'DCIM', '100CANON', 'C0001.mp4'), 2);
  clip(at('Desktop', 'Footage', 'C0001.mp4'), 5);   // the same name, a different clip
  clip(at('Desktop', 'Interview', 'Interview.mp4'), 2, true);
  clip(at('Desktop', 'Interview', 'Cutaway.mp4'), 2);
  clip(at('Desktop', 'Party.mp4'), 1);
  clip(at('Desktop', 'Cards', 'Card 1', 'A001.mp4'), 2);   // two clips called A001.mp4, neither in the library
  clip(at('Desktop', 'Cards', 'Card 2', 'A001.mp4'), 3);
  writeFileSync(at('Desktop', 'My Film.fcpxml'), film());
  writeFileSync(at('Desktop', 'My Film v2.fcpxml'), film('Game day!'));
  writeFileSync(at('Desktop', 'Interview.fcpxml'), interview);
  writeFileSync(at('Desktop', 'Poster.fcpxml'), poster);
  // Every run's pictures, and only its: a state renamed or dropped leaves no stale picture behind.
  rmSync(SHOTS, { recursive: true, force: true }); mkdirSync(SHOTS, { recursive: true });
  if (!dist) { dist = join(temp, 'dist'); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  Object.assign(process.env, ENV);
  app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
  // B: a classmate with a real account, watching Projects.
  bContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); b = await bContext.newPage();
  const signup = await bContext.request.post(`${url}/api/auth/signup`, { data: { name: 'Konrad Fischer', email: 'konrad@example.test', password: 'Importer-browser-2026', inviteCode: CODE } });
  assert.equal(signup.status(), 201, await signup.text());
  aContext = await guestContext(); a = await aContext.newPage();
});
after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await browser?.close(); await app?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

/** A guest's browser: page errors, console errors and any 403 or 5xx (a call the guest allowlist refuses) fail the run. */
async function guestContext(options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  context.setDefaultTimeout(20_000);
  context.on('page', page => {
    page.on('pageerror', e => problems.push(`page error: ${e.message}`));
    // Failed loads are the network's business (offline, a held request aborted by Pause); the responses are checked below.
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    page.on('response', r => {
      if (expect403 && r.status() === 403 && r.url().endsWith('/api/auth/guest')) { expect403 = false; return; }
      if (r.status() === 403 || r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
  });
  return context;
}
const clean = () => assert.deepEqual(problems.splice(0), [], 'no page errors, console errors, 403s or 5xx');

/** Saves this screen at 1440×900 and at 390×844 (where nothing may scroll sideways), each the whole step. */
async function shot(page: Page, name: string, { importer = true } = {}) {
  const n = String(++shotNo).padStart(2, '0'), size = page.viewportSize()!;
  await page.waitForTimeout(450);   // the step's slide-in
  // .importer is its own scroll container; letting the document grow shows the whole step in one picture.
  const grow = importer ? await page.addStyleTag({ content: 'html,body,#root{height:auto!important;overflow:visible!important}.importer{height:auto!important;min-height:100dvh;overflow:visible!important}' }) : undefined;
  await page.screenshot({ path: join(SHOTS, `${n}-${name}-1440.png`), fullPage: importer });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  if (importer) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}: nothing scrolls sideways at 390 px`);
  await page.screenshot({ path: join(SHOTS, `${n}-${name}-390.png`), fullPage: importer });
  await grow?.evaluate(style => (style as Element).remove());
  await page.setViewportSize(size);
}
const heading = (page: Page) => page.locator('#importer-title');
const step = (page: Page, text: string | RegExp) => heading(page).filter({ hasText: text }).waitFor();
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const folder = (page: Page) => page.locator('input[webkitdirectory]');   // Choose folder…'s picker
async function chooseExport(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('or choose it…').click();
  await (await chooser).setFiles(at('Desktop', file));
}
/** Holds PUT chunks the test picks until released, the way a slow link would. */
function holdChunks(page: Page) {
  const held: Route[] = [];
  let hold: (request: Request) => boolean = () => false;
  void page.route('**/api/media/*/upload', route => { if (route.request().method() === 'PUT' && hold(route.request())) held.push(route); else void route.continue().catch(() => {}); });
  return { held, set: (rule: typeof hold) => { hold = rule; }, release: async (n = held.length) => { for (const route of held.splice(0, n)) await route.continue().catch(() => {}); } };
}
const chunkOf = (request: Request) => ({ id: request.url().split('/media/')[1].split('/')[0], offset: Number(request.headers()['upload-offset']) });
/** The classmate's retry starts preparing what the guest sent (the server defers it, as in a bulk import). */
async function prepare(projectId: string) {
  const { media } = await (await bContext.request.get(`${url}/api/fcp/import/${projectId}`)).json() as { media: { id: string; uploaded: boolean; status: string }[] };
  for (const m of media) if (m.uploaded && m.status === 'processing') assert.equal((await bContext.request.post(`${url}/api/media/${m.id}/retry`)).status(), 202);
}
const projectIdOf = async (name: string) => ((await (await bContext.request.get(`${url}/api/state`)).json()).state.projects as { id: string; name: string }[]).find(p => p.name === name)!.id;
const library = async (section?: string) => { await b.goto(url); await b.getByRole('region', { name: 'Project library' }).waitFor(); if (section) await b.getByRole('navigation', { name: 'Project navigation' }).getByRole('button', { name: section }).click(); await b.waitForTimeout(400); };

test('welcome, and a guest gives a name and the class code', async () => {
  await a.goto(`${url}/importer`);
  await step(a, 'Bring your Final Cut project to SharedCut');
  assert.equal(await a.title(), 'Import from Final Cut · SharedCut');
  await shot(a, 'welcome');
  await a.getByRole('textbox', { name: 'Your name' }).fill('Maya Chen');
  await a.getByRole('textbox', { name: 'Class code' }).fill('class-2025');
  await shot(a, 'you-name-tag');
  expect403 = true;
  await button(a, /Let's start/).click();
  await a.getByRole('alert').filter({ hasText: "That code didn't work. Check it with your teacher and try again." }).waitFor();
  assert.equal(await a.evaluate(() => document.activeElement?.getAttribute('aria-describedby')), 'code-hint code-error', 'the code field keeps focus and names its error');
  await shot(a, 'you-wrong-code');
  await a.getByRole('textbox', { name: 'Class code' }).fill(CODE);
  await button(a, /Let's start/).click();
  await step(a, 'Export your project from Final Cut');
  assert.equal(expect403, false, 'the wrong code was refused once');
  clean();
});

test('export: a video is not the export; the exported XML is read', async () => {
  await shot(a, 'export');
  await a.locator('.importer-drop').drop({ files: at('Desktop', 'Party.mp4') });
  await a.getByRole('alert').filter({ hasText: "That's a video. We need the file Final Cut makes with File › Export XML…" }).waitFor();
  await shot(a, 'export-not-the-export');
  await chooseExport(a, 'My Film.fcpxml');
  await a.getByText(/Got it: My Film · 3 clips/).waitFor();
  await a.locator('.ia-received').waitFor();   // the stage shows the clips arriving, not the how-to
  await a.waitForTimeout(2200);   // the picture at rest: every clip on its track, and the check
  await shot(a, 'export-got-it');
  clean();
});

test('fonts: the missing family is dropped in and added', async () => {
  await button(a, /Continue/).click();
  await step(a, "Your titles use fonts SharedCut doesn't have yet");
  await a.getByText('Barlow Condensed · needed').waitFor();
  await shot(a, 'fonts-needed');
  await a.locator('.importer-fonts').drop({ files: join(root, 'public', 'fonts', 'BarlowCondensed-Bold.ttf') });
  await a.getByText('Barlow Condensed · added').waitFor();
  await a.locator('.ia-fontdone').getByText('Game day').waitFor();   // the edit's own title, in the font just added
  await a.waitForTimeout(800);
  await shot(a, 'fonts-added');
  clean();
});

test('footage: places, a different clip with the same name, the right one dropped, two of a kind, then the library', async () => {
  await button(a, /^Continue/).click();
  await step(a, "Now let's find your footage");
  assert.equal(await a.locator('.importer-places > li').count(), 2, 'the library and the SD card');
  assert.match(await a.locator('.importer-places > li').first().innerText(), /Your Final Cut library School Library/);
  assert.match(await a.locator('.importer-stage').innerText(), /Movies/, 'the Finder scene opens Movies');
  assert.equal(await a.getByText(/Continue without/).count(), 0, 'leaving clips out waits until something is found');
  await a.getByText('Macintosh HD › Users › maya › Movies › School Library').waitFor();   // the first place is open
  await shot(a, 'footage');
  const card = a.locator('.importer-places > li').filter({ hasText: 'SD CARD' });
  await folder(a).setInputFiles(at('Desktop', 'Footage'));
  if (video) {
    await a.getByText(/We found a C0001\.MP4 in Footage, but it's a different clip \(5 s long; the project's is 2 s\)/i).waitFor();
    await shot(a, 'footage-different-clip');
  }
  // The SD card's copy, dropped on its own, ties on its name with the different one; it is taken, not the one that failed.
  await a.locator('.importer-places').drop({ files: at('SD CARD', 'DCIM', '100CANON', 'C0001.mp4') });
  await card.getByText(/1 of 1 found/).waitFor();
  await a.locator('.importer-problems').waitFor({ state: 'detached' });
  // A folder with two other A001.mp4 files, neither of them in a library: which one?
  await folder(a).setInputFiles(at('Desktop', 'Cards'));
  await a.getByText(/Two files are called A001\.mp4\. Which one is from this project\?/).waitFor();
  if (video) await a.locator('.importer-choose').getByText('Matches').waitFor();   // Card 1's is as long as the edit's
  await shot(a, 'footage-which-one');
  await folder(a).setInputFiles(at('Movies'));
  await a.locator('.importer-footer').getByText(/2 of 3\s*clips found/).waitFor();
  await a.locator('.importer-choose').waitFor({ state: 'detached' });
  await a.getByText('Macintosh HD › Users › maya › Movies › School Library').waitFor();
  await shot(a, 'footage-found');
  clean();
});

test('check: the Wi-Fi probe, then the size and the time', async () => {
  await button(a, /Continue without 1 clip/).click();
  await step(a, 'Checking your Wi\u2011Fi…');
  await shot(a, 'check-wifi');
  await step(a, 'Ready to upload');
  assert.match(await a.locator('.importer-sentence').textContent() ?? '', /This project is .+\. It might take (about .+|less than a minute) to upload to SharedCut\./, 'what a screen reader hears');
  await a.getByText('Left out: 1 clip not found.').waitFor();
  await a.getByText("It'll show up in SharedCut as My Film, shared with your class.").waitFor();
  await shot(a, 'check-ready');
  clean();
});

test('upload: lanes, a classmate sees it coming in, Wi-Fi drops and comes back, getting ready, done', async t => {
  t.after(() => aContext.setOffline(false));
  const chunks = holdChunks(a);
  chunks.set(() => true);
  await button(a, /Start upload/).click();
  await step(a, /Uploading/);
  await a.waitForFunction(() => document.querySelectorAll('.ia-l-clip').length > 0);
  await a.waitForTimeout(500);
  const lanes = await a.locator('.ia-l-track').count();
  assert.ok(chunks.held.length >= 1 && chunks.held.length <= lanes, `${chunks.held.length} chunks in flight on ${lanes} lanes`);
  await chunks.release(1);   // one clip arrives; the other waits on the line
  await a.locator('.importer-percent').filter({ hasText: /^[1-9]\d?%$/ }).waitFor();
  await shot(a, 'uploading');

  const id = await projectIdOf('My Film');
  await library();
  const incoming = b.locator('.drive-recents').filter({ hasText: 'Coming in from Final Cut' });
  await incoming.getByText(/Maya Chen is importing a project from Final Cut/).waitFor();
  assert.match(await incoming.locator('.drive-import').innerText(), /\d+% · /);
  await shot(b, 'library-importing', { importer: false });

  // The Wi-Fi drops with a chunk on the line.
  await aContext.setOffline(true);
  chunks.set(() => false);
  for (const route of chunks.held.splice(0)) await route.abort('internetdisconnected').catch(() => {});
  await a.locator('.importer-status').getByText('Wi\u2011Fi dropped. Waiting to reconnect… Your progress is saved.').waitFor({ timeout: 3000 });
  await step(a, 'Waiting for Wi\u2011Fi');
  await shot(a, 'upload-offline');
  await a.waitForTimeout(2000);
  await aContext.setOffline(false);
  await step(a, 'Uploaded! SharedCut is getting it ready');
  await a.getByText(/0 of 2\s*clips ready/).waitFor();
  await shot(a, 'getting-ready');
  await library();
  await incoming.getByText('Getting it ready').waitFor();
  await shot(b, 'library-getting-ready', { importer: false });
  if (!video) return;

  await prepare(id);
  await step(a, /My Film is in SharedCut/);
  await a.getByRole('button', { name: 'Save my account' }).waitFor();
  await a.locator('summary').filter({ hasText: '1 clip was left out' }).waitFor();
  await shot(a, 'done');
  await library('Class');
  await b.locator('.drive-project').filter({ hasText: 'My Film' }).getByText('New from Final Cut').first().waitFor();
  await shot(b, 'library-new-from-final-cut', { importer: false });
  clean();
});

test('a guest who opens SharedCut itself is sent back to the importer', async () => {
  await a.goto(url);
  await a.waitForURL(`${url}/importer`);
  await a.getByText(/Welcome back, Maya\./).waitFor();
  await shot(a, 'guest-sent-to-importer');
  // A guest has no password: forgetting her asks first, and offers to save the account.
  await button(a, 'Not Maya? Start fresh').click();
  await a.getByRole('alertdialog').getByText(/This forgets Maya on this Mac\./).waitFor();
  await shot(a, 'guest-start-fresh');
  await button(a, 'Cancel').click();
  await a.getByText(/Welcome back, Maya\./).waitFor();
  clean();
});

test('an edit that changed since its import asks what to do', async () => {
  await button(a, /Let's start/).click();
  await chooseExport(a, 'My Film v2.fcpxml');
  await a.locator('.importer-got').getByText(/Got it: My Film/).waitFor();
  await button(a, /^Continue/).click();
  await step(a, "You've imported My Film before");
  await shot(a, 'decide-changed');
  await a.reload();
  await step(a, 'Bring your Final Cut project to SharedCut');
  clean();
});

test('a closed tab resumes from what arrived; Pause and Resume; the guest saves the account', async () => {
  await button(a, /Let's start/).click();
  await chooseExport(a, 'Interview.fcpxml');
  await button(a, /^Continue/).click();
  await step(a, "Now let's find your footage");
  await folder(a).setInputFiles(at('Desktop', 'Interview'));
  await a.locator('.importer-footer').getByText(/2 of 2\s*clips found/).waitFor();
  await button(a, /^Continue$/).click();
  await step(a, 'Ready to upload');
  // The big clip's first chunk arrives, then the tab closes with the second on the line.
  const chunks = holdChunks(a), sent: { id: string; offset: number }[] = [];
  chunks.set(request => chunkOf(request).offset > 0);
  await button(a, /Start upload/).click();
  await a.getByText(/1 of 2\s*clips sent/).waitFor();
  await a.waitForFunction(() => /^[1-9]\d?%$/.test(document.querySelector('.importer-percent')?.textContent ?? ''));
  await a.waitForTimeout(300);
  assert.equal(chunks.held.length, 1);
  const leaving = new Promise<string>(done => a.once('dialog', dialog => { done(dialog.type()); void dialog.accept(); }));
  await a.reload();
  assert.equal(await leaving, 'beforeunload', 'leaving mid-upload asks first');
  for (const route of chunks.held.splice(0)) await route.abort().catch(() => {});

  await a.locator('.importer-card').filter({ hasText: /Interview is \d+% uploaded\./ }).waitFor();
  await shot(a, 'resume-continue-card');
  a.on('request', request => { if (request.method() === 'PUT' && /\/api\/media\/[^/]+\/upload$/.test(request.url())) sent.push(chunkOf(request)); });
  await button(a, /Continue upload/).click();
  await a.getByText(/Welcome back\. Interview is \d+% uploaded\. Drag in these places again\. The .+ already sent won't be sent again\./).waitFor();
  await shot(a, 'resume-footage');
  await folder(a).setInputFiles(at('Desktop', 'Interview'));
  await a.locator('.importer-footer').getByText(/1 of 1\s*clips found/).waitFor();
  await button(a, /^Continue$/).click();
  await step(a, 'Ready to upload');
  await a.locator('.importer-sentence').filter({ hasText: /1 of 2 clips are already in SharedCut\. .+ left: / }).waitFor({ state: 'attached' });
  await a.getByText('1 of 2 already in SharedCut').waitFor();
  await shot(a, 'resume-check');

  chunks.set(() => true);
  await button(a, /Start upload/).click();
  await a.waitForFunction(() => document.querySelectorAll('.ia-l-clip').length > 0);
  await a.waitForTimeout(300);
  assert.ok(sent.length >= 1 && sent[0].offset >= 8 * 1024 * 1024, `the resumed clip starts after its first chunk (${JSON.stringify(sent)})`);
  assert.equal(new Set(sent.map(s => s.id)).size, 1, 'the clip that already arrived is not sent again');
  await button(a, /Pause/).click();
  await a.locator('.importer-status').getByText('Paused').waitFor();
  await step(a, 'Paused: Interview');
  await shot(a, 'upload-paused');
  chunks.held.splice(0);
  chunks.set(() => false);
  await button(a, /Resume/).click();
  await step(a, 'Uploaded! SharedCut is getting it ready');
  if (!video) return clean();

  const me = (await (await aContext.request.get(`${url}/api/auth/me`)).json()).user;
  await prepare(await projectIdOf('Interview'));
  await step(a, /Interview is in SharedCut/);
  await a.getByRole('textbox', { name: 'Email' }).fill('maya.chen@example.test');
  await a.locator('input[autocomplete="new-password"]').fill('Maya-importer-2026');
  await button(a, 'Save my account').click();
  await a.getByText(/All set\. Next time, sign in at sharedcut\.com with maya\.chen@example\.test\./).waitFor();
  const saved = (await (await aContext.request.get(`${url}/api/auth/me`)).json()).user;
  assert.equal(saved.id, me.id, 'the same account, so her imports stay hers'); assert.equal(saved.guest, undefined);
  await shot(a, 'account-saved');
  clean();
});

test('Projects: every state a Final Cut import card can show', async () => {
  // The server's phase changes are server/importer.test.ts's; here each state is drawn, on copies of the real card.
  const now = Date.now(), base = { total: 4.8e9, received: 2.0e9, files: 38, uploaded: 30, ready: 12, failed: 0, rate: 6.3e6, startedAt: now - 600_000, updatedAt: now - 120_000 };
  const states: [string, object][] = [['Soccer Highlights', { phase: 'paused' }], ['Science Fair', { phase: 'processing', uploaded: 38, received: 4.8e9 }], ['Field Trip', { phase: 'stopped', received: 1.97e9 }], ['Drama Club', { phase: 'ready', uploaded: 38, ready: 38, failed: 3, received: 4.8e9, doneAt: now - 3_600_000 }]];
  await b.route('**/api/state', async route => {
    const response = await route.fetch(), body = await response.json(), real = body.state.projects.find((p: { name: string }) => p.name === 'My Film');
    body.state.projects.push(...states.map(([name, fcp], i) => ({ ...real, id: `${real.id}-copy-${i}`, name, fcpImport: { ...real.fcpImport, ...base, ...fcp } })));
    await route.fulfill({ response, json: body });
  });
  await library();
  await b.getByText('Paused · waiting for Maya Chen\'s Mac').waitFor();
  await shot(b, 'library-card-states', { importer: false });
  await library('Class');
  await b.getByText('Import stopped at 41%').waitFor();
  await b.getByText('3 clips need attention').waitFor();
  await shot(b, 'library-card-states-class', { importer: false });
  await b.unroute('**/api/state');
});

test('reduced motion, and the keyboard alone, from Welcome to the next step', async () => {
  const context = await guestContext({ reducedMotion: 'reduce' }), page = await context.newPage();
  try {
    // 200% zoom on a 1440 × 900 screen: focus moves without scrolling the stage and the rail out of view.
    await page.setViewportSize({ width: 720, height: 450 });
    await page.goto(`${url}/importer`);
    await page.getByRole('textbox', { name: 'Your name' }).waitFor();
    await page.keyboard.type('Ana Ruiz');
    await page.keyboard.press('Tab'); await page.keyboard.type(CODE);
    await page.keyboard.press('Enter');
    await step(page, 'Export your project from Final Cut');
    const focused = () => page.evaluate(() => document.activeElement?.id === 'importer-title' && document.activeElement.textContent);
    assert.equal(await focused(), 'Export your project from Final Cut', 'the new step\'s heading has focus');
    assert.equal(await page.evaluate(() => document.querySelector('.importer')!.scrollTop), 0, 'the page stays at its top');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(800);
    assert.ok(await page.evaluate(() => document.getAnimations().every(animation => animation.playState !== 'running')), 'nothing moves');
    await shot(page, 'reduced-motion-export');
    await page.keyboard.press('Tab');
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(at('Desktop', 'My Film.fcpxml'));
    await page.locator('.importer-got').getByText(/Got it: My Film/).waitFor();
    await page.keyboard.press('Enter');
    await step(page, "Now let's find your footage");   // Maya already added the font
    assert.equal(await focused(), "Now let's find your footage");
    clean();
  } finally { await context.close(); }
});

test('blocked: a phone, and a browser too old for the page', async () => {
  const phone = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const old = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await old.addInitScript(() => { delete (AbortSignal as { any?: unknown }).any; });
  try {
    for (const [context, title, name] of [[phone, 'Open this on your Mac', 'blocked-phone'], [old, 'Your browser needs an update', 'blocked-old-browser']] as const) {
      const page = await context.newPage();
      await page.goto(`${url}/importer`);
      await step(page, title);
      await shot(page, name);
    }
  } finally { await phone.close(); await old.close(); }
});

test('a member: Welcome, every clip found, the class checkbox, SharedCut not answering, out of room, and done', async () => {
  const m = await bContext.newPage();
  m.on('pageerror', e => problems.push(`page error: ${e.message}`));
  m.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(`console: ${message.text()}`); });
  try {
    await m.goto(`${url}/importer`);
    await m.getByText(/Importing as Konrad Fischer/).waitFor();
    await shot(m, 'welcome-member');
    await button(m, /Let's start/).click();
    await chooseExport(m, 'Interview.fcpxml');
    await button(m, /^Continue/).click();
    await step(m, "Now let's find your footage");
    await folder(m).setInputFiles(at('Desktop', 'Interview'));
    await m.locator('.importer-footer').getByText(/2 of 2\s*clips found/).waitFor();
    await m.locator('.ia-found').waitFor();
    await m.waitForTimeout(1200);
    await shot(m, 'footage-all-found');
    await button(m, /^Continue$/).click();
    await step(m, 'Ready to upload');
    assert.equal(await m.getByRole('checkbox', { name: 'Let my class see it on their Projects screen' }).isChecked(), true);
    await shot(m, 'check-member');
    // The server goes away behind the tunnel: its 502 page is not SharedCut answering.
    const page = (route: Route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' });
    await m.route('**/api/health', page); await m.route('**/api/media/*/upload', page);
    await button(m, /Start upload/).click();
    await m.locator('.importer-status').getByText("SharedCut isn't answering right now. We'll keep trying, and nothing is lost.").waitFor();
    await step(m, 'Waiting for SharedCut');
    await shot(m, 'upload-not-answering');
    // Back, but out of room.
    await m.unroute('**/api/health'); await m.unroute('**/api/media/*/upload');
    await m.route('**/api/media/*/upload', route => route.request().method() === 'POST' ? route.fulfill({ status: 507, json: { error: 'The server is almost out of disk space.' } }) : route.continue());
    await m.locator('.importer-status').getByText(/SharedCut ran out of room\. Nothing is lost\./).waitFor({ timeout: 30_000 });
    await step(m, 'SharedCut is out of room');
    await shot(m, 'upload-no-room');
    await m.unroute('**/api/media/*/upload');
    await button(m, /Pause/).click(); await button(m, /Resume/).click();
    await step(m, 'Uploaded! SharedCut is getting it ready');
    if (!video) return clean();
    const me = (await (await bContext.request.get(`${url}/api/auth/me`)).json()).user.id;
    const mine = ((await (await bContext.request.get(`${url}/api/state`)).json()).state.projects as { id: string; name: string; members: { userId: string; role: string }[] }[]).find(p => p.name === 'Interview' && p.members.some(x => x.userId === me && x.role === 'Owner'))!;
    await prepare(mine.id);
    await step(m, /Interview is in SharedCut/);
    await m.getByText("It's in your Projects.").waitFor();
    await shot(m, 'done-member');
    clean();
  } finally { await m.close(); }
});

test('fonts in Safari: no "Add them from this Mac", the drop card leads', async () => {
  const context = await guestContext();
  // Window's operations live on the global object itself ([Global]), so that is where it goes.
  await context.addInitScript(() => { delete (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts; delete (Window.prototype as { queryLocalFonts?: unknown }).queryLocalFonts; });
  try {
    const page = await context.newPage();
    await page.goto(`${url}/importer`);
    await page.getByRole('textbox', { name: 'Your name' }).fill('Lee Kim');
    await page.getByRole('textbox', { name: 'Class code' }).fill(CODE);
    await button(page, /Let's start/).click();
    await chooseExport(page, 'Poster.fcpxml');
    await button(page, /^Continue/).click();
    await step(page, "Your titles use fonts SharedCut doesn't have yet");
    await page.getByText('Drag the font files here', { exact: true }).waitFor();
    assert.equal(await button(page, 'Add them from this Mac').count(), 0);
    await shot(page, 'fonts-safari');
    clean();
  } finally { await context.close(); }
});
