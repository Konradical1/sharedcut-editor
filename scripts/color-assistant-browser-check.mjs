// Color Assistant "three looks" end to end in the browser with the fake model provider: pick two shots, generate,
// wait for three cards with rendered stills, apply look 2, then one undo. Isolated account, database and a synthetic
// S-Log3 clip; the live data folder is never read or written. Screenshots land in artifacts/qa/color-assistant/.
//   node --experimental-strip-types scripts/color-assistant-browser-check.mjs   (QA_DIST=<built client> skips the build; FRAME_LINE_AI_PROVIDER=anthropic uses real Claude)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { browserExecutable } from './browser-options.mjs';

const EMAIL = 'color-assistant@example.test';
process.env.FRAME_LINE_AI_PROVIDER ||= 'fake'; delete process.env.FRAME_LINE_AI_USERS; delete process.env.FRAME_LINE_SIGNUP_CODE;
const { createFrameLineServer } = await import('../server/index.ts');
const { starterGrade } = await import('../src/services/color.ts');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve('artifacts/qa/color-assistant'); await mkdir(out, { recursive: true });
const temp = await realpath(await mkdtemp(join(tmpdir(), 'frameline-assistant-qa-')));
const dist = process.env.QA_DIST ? resolve(process.env.QA_DIST) : join(temp, 'dist');
if (!process.env.QA_DIST) execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { stdio: 'inherit' });

const projectId = 'assistant-qa', timelineId = 'assistant-qa-timeline', trackId = 'assistant-qa-v1', mediaId = 'assistant-qa-media';
const asset = { id: mediaId, projectId, name: 'Synthetic S-Log3.mp4', kind: 'video', binId: 'all', thumbnail: '', duration: 6, resolution: '640 × 360', fps: 24, size: '1 MB', status: 'ready', progress: 100, camera: 'Sony FX3', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine', colorRange: 'tv', colorMatrix: 'bt709', cameraMetadataVersion: 2, colorEvidence: 'Synthetic QA clip', frameRate: '24/1', hasAudio: false };
const shot = (id, name, start, sourceIn) => ({ id, projectId, timelineId, trackId, mediaId, name, start, duration: 3, sourceIn, color: '#467879', disabled: false, effects: [], keyframes: {}, properties: { x: 0, y: 0, zoom: 100, rotation: 0, anchorX: 0, anchorY: 0, opacity: 100, speed: 100, reverse: false, freeze: false, colorPipeline: 'nodes-v2', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } });
const clips = [shot('assistant-qa-shot-1', 'Street', 0, 0), shot('assistant-qa-shot-2', 'Window', 3, 3)];
let n = 0; const nodes = clips.flatMap(clip => starterGrade(clip, asset, () => `assistant-qa-node-${++n}`));
for (const node of nodes) for (const effect of node.effects ?? []) if (effect.type === 'cst' && effect.outputGamma === 'Gamma 2.4') Object.assign(effect, { toneMapping: 'aces2', gamutMapping: 'none' });

let app = createFrameLineServer({ dataDir: temp, distDir: dist }), url = '';
const listen = async () => { await new Promise(r => app.server.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${app.server.address().port}`; };
await listen();
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable(), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } }), outsider = await browser.newContext();
  const signup = await context.request.post(url + '/api/auth/signup', { data: { name: 'Assistant QA', email: EMAIL, password: 'FrameLine-Assistant-QA-2026' } }); assert.equal(signup.status(), 201);
  const { user } = await signup.json();
  process.env.FRAME_LINE_AI_USERS = user.id; // account ids, read on every request
  assert.equal((await outsider.request.post(url + '/api/auth/signup', { data: { name: 'Collaborator', email: 'collaborator@example.test', password: 'FrameLine-Assistant-QA-2026' } })).status(), 201);
  assert.equal((await (await outsider.request.get(url + '/api/color-assistant/capabilities')).json()).available, false, 'only allow-listed accounts may run the assistant');
  await app.close();
  const db = new DatabaseSync(join(temp, 'frameline.sqlite')), row = db.prepare('select state from workspace where id=1').get(), state = row ? JSON.parse(row.state) : { users: [], settings: {} };
  Object.assign(state, { projects: [{ id: projectId, name: 'Assistant QA', description: '', shared: false, thumbnail: '', modifiedAt: Date.now(), duration: 6, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: user.id, role: 'Owner' }] }],
    media: [asset], timelines: [{ id: timelineId, projectId, name: 'Main timeline', duration: 6 }], tracks: [{ id: trackId, timelineId, name: 'Picture', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 }],
    clips, nodes, comments: [], operations: [], snapshots: [], renderJobs: [] });
  db.prepare('insert into workspace(id,revision,state) values(1,1,?) on conflict(id) do update set state=excluded.state').run(JSON.stringify(state)); db.close();
  // A flat, log-looking test pattern stands in for camera footage.
  await mkdir(join(temp, 'media', mediaId), { recursive: true });
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6', '-vf', 'eq=contrast=.55:brightness=.08:saturation=.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-f', 'mp4', join(temp, 'media', mediaId, 'original')]);
  app = createFrameLineServer({ dataDir: temp, distDir: dist }); await listen();
  const capability = await (await context.request.get(url + '/api/color-assistant/capabilities')).json();
  assert.equal(capability.available, true, capability.reason);

  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const saved = async () => (await (await context.request.get(url + '/api/state')).json()).state;
  const until = async (check, what, ms = 30_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 250))) if (await check()) return; assert.fail(`Timed out waiting for ${what}`); };
  const looks = async () => (await saved()).nodes.filter(n => n.name.startsWith('Look')).map(n => ({ id: n.id, clipId: n.clipId, parameters: n.parameters, curves: n.curves ?? null })).sort((a, b) => a.id.localeCompare(b.id));
  await page.goto(`${url}/project/${projectId}`);
  await page.getByRole('navigation', { name: 'Editor workspaces' }).getByRole('button', { name: 'Color', exact: true }).click();
  await page.getByRole('button', { name: 'Shot 1: Street' }).click();
  await page.getByRole('button', { name: 'Shot 2: Window' }).click({ modifiers: ['ControlOrMeta'] });
  assert.match(await page.getByRole('button', { name: 'Shot 2: Window' }).getAttribute('class'), /picked/, 'Ctrl/Cmd-click marks the extra shot');
  await page.locator('.assistant-open').click(); // the node toolbar's Assistant button opens the side panel on its tab
  assert.equal(await page.locator('.inspector-tabs').getByRole('button', { name: 'Assistant', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Selected shots (2)' }).waitFor();
  await page.getByPlaceholder('cool, dramatic night scene').fill('cool, dramatic night scene');
  const before = await looks(), snapshots = (await saved()).snapshots.length;
  await page.getByRole('button', { name: 'Generate three looks' }).click();
  await page.waitForFunction(() => { const cards = document.querySelectorAll('.assistant-option'), images = [...document.querySelectorAll('.assistant-option img')]; return cards.length === 3 && images.length >= 6 && images.every(i => i.complete && i.naturalWidth > 0); }, null, { timeout: 240_000 });
  await page.screenshot({ path: join(out, 'three-looks.png') });
  assert.equal(await page.getByRole('button', { name: 'Generate three looks' }).isDisabled(), false, 'Generate is ready again once the looks are shown');
  const second = page.locator('.assistant-option').nth(1), compare = second.locator('.assistant-compare');
  assert.notEqual(await compare.locator('img').first().getAttribute('src'), await second.locator('.assistant-before').getAttribute('src'), 'the look still is not the before still');
  await compare.hover({ position: { x: 90, y: 40 } });
  assert.equal(await compare.getAttribute('data-view'), 'split', 'hovering the still wipes between before and the look');
  await page.screenshot({ path: join(out, 'wipe.png') });
  await second.getByRole('button', { name: 'Before', exact: true }).click();
  assert.equal(await compare.getAttribute('data-view'), 'before', 'Before shows the whole frame before the look');
  await page.waitForFunction(() => [...document.querySelectorAll('.assistant-option img')].every(i => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: join(out, 'before.png') });
  await second.getByRole('button', { name: 'Before', exact: true }).click();
  await second.getByRole('button', { name: /^Apply / }).click();
  await until(async () => (await saved()).snapshots.length === snapshots + 1 && JSON.stringify(await looks()) !== JSON.stringify(before), 'the applied look to save');
  const applied = await looks(), state1 = await saved();
  assert.equal(state1.snapshots.length, snapshots + 1, 'Apply saves one snapshot'); assert.match(state1.snapshots[0].name, /^Before Color Assistant: /);
  for (const clip of clips) { const look = applied.find(l => l.clipId === clip.id && !l.id.startsWith('ai-look-')), old = before.find(l => l.clipId === clip.id); assert.notDeepEqual(look.parameters, old.parameters, `${clip.name}: Look node values changed`); }
  assert.deepEqual(state1.nodes.filter(n => n.effects?.length), nodes.filter(n => n.effects?.length), 'CST nodes are untouched');
  await page.screenshot({ path: join(out, 'applied.png') });
  await page.keyboard.press('ControlOrMeta+z');
  await until(async () => JSON.stringify(await looks()) === JSON.stringify(before), 'one undo to restore every Look node');
  assert.deepEqual(await looks(), before, 'one undo restores every Look node and removes added ones');
  await page.screenshot({ path: join(out, 'undone.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, looks: await page.locator('.assistant-option header strong').allTextContents(), extraNodes: applied.filter(l => l.id.startsWith('ai-look-')).length, screenshots: out }));
} finally { await browser.close(); await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); }
