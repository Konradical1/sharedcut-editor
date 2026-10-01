// Real imported media, isolated accounts/database; never edits the live project.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/playback-browser-check.mjs [data] [report.json]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readdir, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readWorkspace } from './workspace-db.mjs';
import { createServer } from 'vite';
import { createFrameLineServer } from '../server/index.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sourceData = resolve(process.argv[2] || 'data');
const sourceDb = new DatabaseSync(join(sourceData, 'frameline.sqlite'), { readOnly: true });
const source = readWorkspace(sourceDb).state; sourceDb.close();
const project = source.projects.find(p => /newspaper/i.test(p.name));
assert.ok(project, 'This benchmark needs the imported Newspaper footage.');
const imported = { project, ...Object.fromEntries(['media', 'timelines', 'tracks', 'clips', 'nodes'].map(k => [k, source[k].filter(x => x.projectId === project.id || k === 'tracks' && source.timelines.some(t => t.projectId === project.id && t.id === x.timelineId))])) };
if (process.env.QA_BYPASS_LOOK === '1') imported.clips = imported.clips.map(c => ({ ...c, properties: { ...c.properties, bypassResolveLook: true } }));
const temp = await realpath(await mkdtemp(join(tmpdir(), 'frameline-playback-')));
await cp(resolve('dist'), join(temp, 'dist'), { recursive: true });
delete process.env.FRAME_LINE_SIGNUP_CODE;
let app = createFrameLineServer({ dataDir: temp, distDir: join(temp, 'dist') });
const listen = async () => { await new Promise(r => app.server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${app.server.address().port}`; };
let apiUrl = await listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
let vite;
try {
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const registration = await context.request.post(apiUrl + '/api/auth/signup', { data: { name: 'Playback QA', email: 'playback@example.test', password: 'FrameLine-playback-QA-2026' } });
  assert.equal(registration.status(), 201); const owner = (await registration.json()).user;
  await app.close();
  const db = new DatabaseSync(join(temp, 'frameline.sqlite'));
  const state = JSON.parse(db.prepare('SELECT state FROM workspace WHERE id=1').get().state);
  state.projects = [{ ...project, members: [{ userId: owner.id, role: 'Owner' }] }];
  for (const k of ['media', 'timelines', 'tracks', 'clips', 'nodes']) state[k] = imported[k];
  db.prepare('UPDATE workspace SET state=?, revision=revision+1 WHERE id=1').run(JSON.stringify(state)); db.close();
  await mkdir(join(temp, 'media'), { recursive: true }); await mkdir(join(temp, 'resolve'), { recursive: true });
  for (const asset of imported.media) {
    const original = join(sourceData, 'media', asset.id), local = join(temp, 'media', asset.id);
    await mkdir(join(local, 'prepared'), { recursive: true });
    await symlink(join(original, 'original'), join(local, 'original'));
    for (const file of await readdir(join(original, 'prepared'))) if (!file.startsWith('.')) await symlink(join(original, 'prepared', file), join(local, 'prepared', file));
  }
  await symlink(join(sourceData, 'resolve', project.id), join(temp, 'resolve', project.id));
  app = createFrameLineServer({ dataDir: temp, distDir: join(temp, 'dist') }); apiUrl = await listen();
  if (process.env.QA_BASELINE !== '1') {
    const deadline = Date.now() + 180000;
    for (;;) {
      const current = (await (await context.request.get(apiUrl + '/api/state')).json()).state;
      if (current.media.filter(m => m.kind === 'video').every(m => m.proxyVariants)) break;
      assert.ok(Date.now() < deadline, 'Existing imports must acquire smaller preview streams.');
      await new Promise(r => setTimeout(r, 500));
    }
  }
  // A stable UI snapshot keeps concurrent workspace edits/HMR out of measured frame times.
  const ui = join(temp, 'ui'); await mkdir(ui);
  for (const file of ['src', 'index.html', 'package.json']) await cp(resolve(file), join(ui, file), { recursive: true });
  await symlink(resolve('node_modules'), join(ui, 'node_modules'));
  vite = await createServer({ root: ui, configFile: resolve('vite.config.ts'), server: { port: 0, host: '127.0.0.1', fs: { allow: [ui, resolve('.')] }, proxy: { '/api': apiUrl } } }); await vite.listen();
  const page = await context.newPage(), errors = [];
  const cdp = await context.newCDPSession(page);
  if (process.env.QA_CPU_RATE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.QA_CPU_RATE) });
  if (process.env.QA_DOWNLOAD_MBPS) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: Number(process.env.QA_DOWNLOAD_MBPS) * 125000, uploadThroughput: 1250000 });
  }
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const NativeAudio = window.AudioContext;
    window.AudioContext = class extends NativeAudio { constructor(options = {}) { super({ ...options, sinkId: { type: 'none' } }); } };
    window.qaMedia = []; window.qaSeeks = []; window.qaCopies = [];
    const create = document.createElement.bind(document);
    document.createElement = function (name, ...args) {
      const element = create(name, ...args);
      if (name === 'video' || name === 'audio') {
        window.qaMedia.push(element); let start;
        element.addEventListener('seeking', () => { start = performance.now(); });
        element.addEventListener('seeked', () => { if (start) window.qaSeeks.push(performance.now() - start); });
      }
      return element;
    };
    if (window.VideoFrame) {
      const copy = VideoFrame.prototype.copyTo;
      VideoFrame.prototype.copyTo = async function (...args) { const start = performance.now(); try { return await copy.apply(this, args); } finally { window.qaCopies.push(performance.now() - start); } };
    }
  });
  if(process.env.QA_NATIVE_FRAMES==='1')await page.addInitScript(()=>{if(window.VideoFrame)Object.defineProperty(VideoFrame.prototype,'format',{get:()=>null});});
  if(process.env.QA_LOW_END==='1')await page.addInitScript(()=>{Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>4});Object.defineProperty(navigator,'deviceMemory',{get:()=>4});});
  const production = process.env.QA_PRODUCTION === '1';
  await page.goto((production ? apiUrl + '/' : vite.resolvedUrls.local[0]) + 'project/' + project.id);
  await page.waitForFunction(() => document.querySelector('.viewer-frame canvas')?.dataset.hasPicture === 'true');
  const results = [];
  await mkdir('artifacts/qa', { recursive: true });
  for (const workspace of (process.env.QA_WORKSPACES || (production ? 'edit' : 'edit,color')).split(',')) {
    await page.getByRole('navigation', { name: 'Editor workspaces' }).getByRole('button', { name: workspace === 'edit' ? 'Edit' : 'Color', exact: true }).click();
    await page.locator(workspace === 'edit' ? '.edit-workspace .viewer-frame canvas' : '.color-viewer .viewer-frame canvas').waitFor();
    // At the default 6 px/second, integer mouse coordinates cap this sweep at 20 positions/s.
    if (production && workspace === 'edit') await page.getByLabel('Timeline zoom', { exact: true }).press('End');
    for (const quality of (process.env.QA_QUALITIES || 'Full,1/4').split(',')) {
      await page.getByLabel('Preview quality', { exact: true }).selectOption(quality);
      // Only the edit workspace mounts a Timeline; the color workspace has no ruler to hold.
      if (workspace === 'edit') { const rulerBox = await page.locator('.timeline-ruler').boundingBox(); await page.mouse.move(rulerBox.x + 2, rulerBox.y + 5); await page.mouse.down(); }
      if (process.env.QA_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
      const result = await page.evaluate(async ({ workspace, quality, production, fixture }) => {
        // Production measurements operate the real transport and timeline event handlers.
        const pixels = () => { const lane = document.querySelector('.track-lane'); return lane.getBoundingClientRect().width / Number(lane.dataset.timeSpan); };
        const setPlayhead = time => { const ruler = document.querySelector('.timeline-ruler'), box = ruler.getBoundingClientRect(); ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, buttons: 1, clientX: box.left + time * pixels(), clientY: box.top + 5 })); window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1})); };
        const setPlaying = playing => document.querySelector(`button[aria-label="${playing ? 'Play' : 'Pause'} playback"]`)?.click();
        // Playing, the timeline draws its playhead into a canvas and .local-playhead holds still: the engine reports the
        // playhead of every picture it presents.
        let enginePlayhead = 0; const presented = event => { enginePlayhead = event.detail.playhead; };
        window.addEventListener('frameline:playback-health', presented);
        const store = production ? { getState: () => ({ clips: fixture.clips, media: fixture.media, timelineId: fixture.timelines[0].id, playhead: enginePlayhead, setPlayhead, setPlaying }) } : (await import('/src/state/store.ts')).useEditorStore;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        store.getState().setPlaying(false); store.getState().setPlayhead(0); await wait(1500);
        const canvas = document.querySelector('.viewer-frame canvas');
        const gl = document.createElement('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); gl.getExtension('WEBGL_lose_context').loseContext();
        const percentile = (list, p) => list.length ? [...list].sort((a, b) => a - b)[Math.floor((list.length - 1) * p)] : 0;
        let frames = [], last = '', started = performance.now();
        const painted = () => {
          const key = canvas.dataset.sourceClip + ':' + canvas.dataset.sourceTimestamp;
          if (key !== last) { last = key; frames.push({ at: performance.now(), clip: canvas.dataset.sourceClip, time: Number(canvas.dataset.sourceTimestamp), playhead: store.getState().playhead }); }
        };
        window.addEventListener('frameline:frame', painted); window.qaSeeks = []; window.qaCopies = [];
        const drops = () => window.qaMedia.filter(m => m.src).reduce((sum, m) => sum + (m.getVideoPlaybackQuality?.().droppedVideoFrames || 0), 0);
        const beforeDrops = drops(); store.getState().setPlaying(true); await wait(10000); store.getState().setPlaying(false);
        const playback = { frames: frames.length, fps: frames.length / ((performance.now() - started) / 1000), p95GapMs: percentile(frames.slice(1).map((f, i) => f.at - frames[i].at), .95), maxGapMs: Math.max(0, ...frames.slice(1).map((f, i) => f.at - frames[i].at)), droppedFrames: drops() - beforeDrops, seeks: window.qaSeeks.length, p95CopyMs: percentile(window.qaCopies, .95) };
        frames = []; last = ''; started = performance.now(); window.qaSeeks = [];
        await new Promise(resolve => { const tick = () => { const elapsed = performance.now() - started; store.getState().setPlayhead(elapsed < 3000 ? elapsed / 300 : Math.max(0, 10 - (elapsed - 3000) / 300)); if (elapsed < 6000) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
        await wait(300);
        const scrub = { frames: frames.length, fps: frames.length / 6, p95GapMs: percentile(frames.slice(1).map((f, i) => f.at - frames[i].at), .95), maxGapMs: Math.max(0, ...frames.slice(1).map((f, i) => f.at - frames[i].at)), p95DecodeMs: percentile(window.qaSeeks, .95) };
        const latencies = [];
        for (const requested of [1, 2, 5, 8, 3, 7, 4, 9, .5, 6]) {
          const target=Math.round(requested*fixture.project.fps)/fixture.project.fps;
          const s = store.getState(), clip = s.clips.find(c => c.timelineId === s.timelineId && c.properties.resolveLookUrl && c.start <= target && c.start + c.duration > target);
          const asset = s.media.find(m => m.id === clip.mediaId), expected = Math.floor((clip.sourceIn + target - clip.start) * asset.fps + 1e-6) / asset.fps;
          const start = performance.now(); store.getState().setPlayhead(target);
          while (performance.now() - start < 5000) { await wait(5); if (canvas.dataset.sourceClip === clip.id && Math.abs(Number(canvas.dataset.sourceTimestamp) - expected) < .002) break; }
          latencies.push(performance.now() - start);
        }
        window.removeEventListener('frameline:frame', painted); window.removeEventListener('frameline:playback-health', presented);
        return { workspace, quality, gpu, playback, scrub, randomSeek: { p95Ms: percentile(latencies, .95), maxMs: Math.max(...latencies) }, media: window.qaMedia.filter(m => m.src).map(m => ({ tag: m.tagName, width: m.videoWidth, url: m.src.split('/').at(-1) })) };
      }, { workspace, quality, production, fixture: imported });
      await page.mouse.up();
      result.conditions = { production, lowEnd: process.env.QA_LOW_END === '1', nativeFrames: process.env.QA_NATIVE_FRAMES === '1', bypassResolveLook: process.env.QA_BYPASS_LOOK === '1', cpuSlowdown: Number(process.env.QA_CPU_RATE || 1), downloadMbps: process.env.QA_DOWNLOAD_MBPS ? Number(process.env.QA_DOWNLOAD_MBPS) : null };
      if (process.env.QA_PROFILE) {
        const { profile } = await cdp.send('Profiler.stop');
        await writeFile(`artifacts/qa/playback-${workspace}-${quality.replace('/', '-')}.cpuprofile`, JSON.stringify(profile));
        console.log('CPU samples', profile.nodes.filter(n => n.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 20).map(n => ({ function: n.callFrame.functionName, url: n.callFrame.url, hits: n.hitCount })));
      }
      results.push(result); console.log(JSON.stringify(result));
    }
  }
  await writeFile(process.argv[3] || 'artifacts/qa/playback-performance.json', JSON.stringify(results, null, 2));
  // The Vite dev proxy resets /api/state often enough that it is noise, not a product defect.
  const fatal = errors.filter(e => production || e !== 'A network error occurred.');
  if (fatal.length < errors.length) console.warn('Ignored transient dev-proxy errors:', errors.length - fatal.length);
  assert.deepEqual(fatal, []);
  if (process.env.QA_BASELINE !== '1') for (const r of results) {
    if (r.quality === '1/4') assert.ok(r.media.filter(m => m.tag === 'VIDEO').every(m => m.width <= 480 && m.url === 'proxy-quarter-v1.mp4'), 'Quarter quality must reduce decoding, not just canvas size.');
    assert.ok(r.playback.fps > 20, 'Display real decoded frames near the 23.976 fps source rate.');
    assert.ok(r.playback.maxGapMs < 250, 'Playback must not freeze at cuts.');
    assert.ok(r.scrub.fps > 20, 'Scrubbing must keep delivering new pictures.');
    assert.ok(r.randomSeek.maxMs < 500, 'Released seeks must settle promptly on the exact source frame.');
  }
} finally { await browser.close(); await vite?.close(); await app.close(); await rm(temp, { recursive: true, force: true }); }
