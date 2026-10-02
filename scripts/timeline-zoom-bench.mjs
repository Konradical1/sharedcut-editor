// Timeline zoom smoothness: seeds a project with many clips on a throwaway server, then replays a pinch-zoom
// (ctrl+wheel, one event per frame) and reports frame times, long tasks and DOM churn.
//   node --experimental-strip-types scripts/timeline-zoom-bench.mjs
// CLIPS=<n> clips per track row (default 40), DIST=<built dist> skips the build, CPU=<n> throttles the CPU n times,
// PLAYWRIGHT_CHROME_PATH picks Chrome (default: installed Chrome).
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createFrameLineServer } from '../server/index.ts';
import { defaultProperties } from '../src/state/demo.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const per = Number(process.env.CLIPS ?? 40), cpu = Number(process.env.CPU ?? 1), dy = Number(process.env.DY ?? 14); // DY: wheel delta per frame (14 = a fast pinch, 4 = a slow one)
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp = await mkdtemp(join(tmpdir(), 'frameline-zoom-bench-'));
let dist = process.env.DIST ?? '';
if (!dist) { dist = join(temp, 'dist'); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error', ...(process.env.PROFILE ? ['--minify', 'false'] : [])], { cwd: root, stdio: 'inherit' }); }
const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } }), page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  const fixture = join(temp, 'bench.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture]);
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Zoom Bench');
  await page.getByRole('textbox', { name: 'Email address' }).fill('zoom@example.test');
  await page.locator('input[type=password]').fill('Zoom-bench-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Zoom bench');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Upload media files').setInputFiles(fixture);
  await page.waitForFunction(() => document.querySelector('.media-state-icon.ready'), {}, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  // Clone the asset across tracks as hand-made clips: a patch is how the agent scripts build timelines too.
  const view = await (await context.request.get(url + '/api/state')).json(), s = view.state;
  const asset = s.media[0], timeline = s.timelines[0], project = s.projects[0];
  const find = (kind, n) => s.tracks.find(t => t.timelineId === timeline.id && t.kind === kind && t.number === n);
  const upsertTracks = [], rows = [];
  for (const [kind, n] of [['video', 1], ['video', 2], ['video', 3], ['audio', 1], ['audio', 2]]) {
    let track = find(kind, n);
    if (!track) { track = { id: `bench-${kind}-${n}`, projectId: project.id, timelineId: timeline.id, kind, number: n, name: `${kind === 'video' ? 'V' : 'A'}${n}`, muted: false, locked: false, hidden: false, solo: false }; upsertTracks.push(track); }
    rows.push(track);
  }
  const dur = asset.duration || 8, clips = [];
  rows.forEach((track, row) => { for (let i = 0; i < per; i++) clips.push({ id: `bench-${row}-${i}`, projectId: project.id, timelineId: timeline.id, trackId: track.id, mediaId: asset.id, name: `${asset.name} ${row}.${i}`, start: i * (dur + .5) + row * 1.3, duration: dur, sourceIn: 0, color: '#6aa3ff', disabled: false, properties: { ...defaultProperties }, effects: [] }); });
  const length = Math.max(...clips.map(c => c.start + c.duration));
  const patched = await context.request.patch(url + '/api/state', { data: { revision: view.revision, delta: { clips: { upsert: clips, remove: [] }, tracks: { upsert: upsertTracks, remove: [] }, timelines: { upsert: [{ ...timeline, duration: length }], remove: [] } } } });
  if (!patched.ok()) throw new Error('seed failed: ' + await patched.text());
  await page.reload();
  await page.locator('.timeline-clip').first().waitFor();
  if (process.env.CSS) await page.addStyleTag({ content: process.env.CSS }); // experiment: inject CSS before measuring
  await page.waitForTimeout(1500);
  if (cpu > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
  if (process.env.SHOT) {
    // Real wheel events (ctrl = pinch), one notch in, then settled.
    await page.screenshot({ path: process.env.SHOT + '-default.png' });
    await page.mouse.move(800, 760); await page.keyboard.down('Control'); await page.mouse.wheel(0, -300); await page.keyboard.up('Control');
    await page.waitForTimeout(900); await page.screenshot({ path: process.env.SHOT + '-zoomed.png' });
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 500); await page.keyboard.up('Control');
    await page.waitForTimeout(900); await page.screenshot({ path: process.env.SHOT + '-out.png' });
  }
  const cdp = process.env.PROFILE ? await context.newCDPSession(page) : null;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
  const trace = process.env.TRACE ? join(temp, 'trace.json') : '';
  if (trace) await browser.startTracing(page, { path: trace, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  const result = await page.evaluate(async ([dy, scroll]) => {
    const el = document.querySelector('.timeline-scroll'), r = el.getBoundingClientRect();
    const frames = [], longTasks = [];
    new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] });
    let mutations = 0; const tally = {}; window.__tally = tally; const mo = new MutationObserver(list => { mutations += list.length; for (const m of list) { const t = m.target; const key = (t.nodeType === 1 ? (t.className?.baseVal ?? t.className ?? t.tagName).toString().split(' ').slice(0, 2).join('.') : '#text') + ':' + (m.attributeName ?? m.type); tally[key] = (tally[key] ?? 0) + 1; } }); mo.observe(el, { subtree: true, childList: true, attributes: true });
    const send = (dy, x) => el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: dy, deltaMode: 0, clientX: x, clientY: r.top + 200, bubbles: true, cancelable: true }));
    const run = async (frameCount, dy) => { let last = performance.now(); for (let i = 0; i < frameCount; i++) { await new Promise(res => requestAnimationFrame(res)); const now = performance.now(); frames.push(now - last); last = now; send(dy, r.left + r.width * .6); } };
    if (scroll) { let last = performance.now(); for (let i = 0; i < 180; i++) { await new Promise(res => requestAnimationFrame(res)); const now = performance.now(); frames.push(now - last); last = now; el.scrollLeft += i < 90 ? 70 : -70; } }
    else {
      await run(90, -dy); // zoom in ~1.5s
      await run(90, dy);  // and back out
    }
    await new Promise(res => setTimeout(res, 400));
    mo.disconnect();
    return { tally: Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8)), frames, longTasks, mutations, clips: document.querySelectorAll('.timeline-clip').length };
  }, [dy, !!process.env.SCROLL]);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop'), self = new Map(), dt = profile.timeDeltas, byId = new Map(profile.nodes.map(n => [n.id, n]));
    profile.samples.forEach((id, i) => { const n = byId.get(id), key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000); });
    console.log('top self-time ms:', JSON.stringify([...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${Math.round(v)} ${k}`), null, 1));
  }
  if (trace) {
    await browser.stopTracing();
    const events = JSON.parse(await (await import('node:fs/promises')).readFile(trace, 'utf8')).traceEvents, totals = {};
    for (const e of events) if (e.ph === 'X' && e.dur && ['UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'FunctionCall', 'FireAnimationFrame', 'ResizeObserver', 'HitTest', 'IntersectionObserverController::computeIntersections', 'UpdateLayer', 'RunMicrotasks', 'EventDispatch', 'TimerFire', 'MajorGC', 'MinorGC'].includes(e.name)) totals[e.name] = Math.round((totals[e.name] ?? 0) + e.dur / 1000);
    console.log('trace ms by event (renderer, whole run):', JSON.stringify(totals));
  }
  if (process.env.TRACE || process.env.TALLY) console.log('top mutations:', JSON.stringify(result.tally));
  const sorted = [...result.frames].sort((a, b) => a - b), q = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const over = ms => result.frames.filter(f => f > ms).length;
  console.log(JSON.stringify({ clipsOnTimeline: result.clips, cpuThrottle: cpu, frames: result.frames.length, p50: +q(.5).toFixed(1), p95: +q(.95).toFixed(1), p99: +q(.99).toFixed(1), worst: +sorted.at(-1).toFixed(1), over20ms: over(20), over33ms: over(33), over50ms: over(50), longTasks: result.longTasks.length, longTaskTotalMs: Math.round(result.longTasks.reduce((a, b) => a + b, 0)), domMutations: result.mutations, errors }));
} finally { await browser.close(); await app.close(); await rm(temp, { recursive: true, force: true }); }
