// Plays a real timeline on sharedcut.com (or any ORIGIN) as a signed-in user and measures what a remote
// editor sees: first picture, pictures per second, freezes and "Loading picture…" time, cold and cached.
// Look-only: it switches timeline tabs and presses Play/Pause; it never edits.
//
//   node scripts/agent/agent-session.mjs <owner email> 1        # once, on the server: writes ~/sharedcut-agent/cookie.txt
//   node scripts/remote-playback-check.mjs [report.json]
//
// Env: ORIGIN (https://sharedcut.com)  PROJECT  TIMELINE (tab text)  SECONDS (30)  PASSES (2)  FPS (30)
//      QUALITY (Preview quality option)  CACHE_WAIT ms between passes (30000)  PROFILE=1 (main-thread hotspots)
//      DIST=<built client dir>: serve that build's HTML/assets/worker instead of the live bundle, so a client
//        change is measured against live data before it is deployed.
//      MIN_FPS, MAX_FREEZE_MS, MAX_LOADING_PCT: thresholds for the cached pass; any miss exits 1.
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const ORIGIN = process.env.ORIGIN ?? 'https://sharedcut.com';
const PROJECT = process.env.PROJECT ?? 'project-7694cce382b0915d28eed8117c563129367ccda0';
const TIMELINE = process.env.TIMELINE ?? 'Part 1 v2';
const SECONDS = Number(process.env.SECONDS ?? 30), PASSES = Number(process.env.PASSES ?? 2), FPS = Number(process.env.FPS ?? 30);
const out = process.argv[2] ?? 'artifacts/qa/remote-playback.json';
const cookie = (process.env.FRAME_LINE_COOKIE ?? readFileSync(join(homedir(), 'sharedcut-agent', 'cookie.txt'), 'utf8')).trim();
const token = cookie.replace(/^frameline_session=/, '');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addCookies([{ name: 'frameline_session', value: token, url: ORIGIN }]);
if (process.env.DIST) {
  const dist = resolve(process.env.DIST);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };
  await context.route((url) => url.origin === new URL(ORIGIN).origin && !url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname, file = join(dist, path);
    const target = existsSync(file) && extname(file) ? file : route.request().resourceType() === 'document' ? join(dist, 'index.html') : undefined;
    if (!target) return route.continue();
    await route.fulfill({ status: 200, body: readFileSync(target), headers: { 'content-type': types[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...(path.endsWith('worker.js') ? { 'service-worker-allowed': '/' } : {}) } });
  });
}
await context.addInitScript(() => {
  window.qaReset = () => { window.qa = { frames: [], health: [] }; };
  window.qaReset();
  window.addEventListener('frameline:frame', (e) => window.qa.frames.push([performance.now(), e.detail?.dataset?.sourceTimestamp]));
  window.addEventListener('frameline:playback-health', (e) => { const d = e.detail; if (d.playing) window.qa.health.push([performance.now(), d.loading, d.engine, d.loading ? d.reason : '', d.error ?? '']); });
});
const page = await context.newPage();
const t0 = Date.now(), consoleErrors = [], failed = [];
const stamp = () => +((Date.now() - t0) / 1000).toFixed(1);
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('cloudflareinsights')) consoleErrors.push(`${stamp()} ${m.text().slice(0, 240)}`); });
page.on('pageerror', (e) => consoleErrors.push(`${stamp()} pageerror: ${e.message.slice(0, 240)}`));
page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/media/')) failed.push(`${stamp()} ${r.status()} ${r.url().replace(ORIGIN, '').slice(0, 120)}`); });

await page.goto(`${ORIGIN}/project/${PROJECT}`);
await page.locator('.timeline-tabs button', { hasText: TIMELINE }).first().click({ timeout: 120000 });
const report = { origin: ORIGIN, timeline: TIMELINE, dist: process.env.DIST ?? null, tabAt: stamp() };
report.firstPictureAt = await page.waitForFunction(() => document.querySelector('.viewer canvas')?.dataset.hasPicture === 'true', null, { timeout: 60000 }).then(stamp, () => null);
report.gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no webgl2'; });
if (process.env.QUALITY) await page.getByRole('combobox', { name: 'Preview quality', exact: true }).selectOption(process.env.QUALITY);

const timecode = (t) => { const [h, m, s, f] = String(t).split(':').map(Number); return h * 3600 + m * 60 + s + f / FPS; };
report.passes = [];
for (let pass = 0; pass < PASSES; pass++) {
  await page.keyboard.press('Home').catch(() => {});
  await page.evaluate(() => window.qaReset());
  const cdp = process.env.PROFILE && pass === PASSES - 1 ? await context.newCDPSession(page) : undefined;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  const startTime = await page.locator('.transport-time').textContent();
  await page.getByRole('button', { name: 'Play playback', exact: true }).click();
  await page.waitForTimeout(SECONDS * 1000);
  const endTime = await page.locator('.transport-time').textContent();
  const statusText = await page.locator('.viewer-playback-status').textContent().catch(() => '');
  const footage = await page.locator('.footage-loading summary').textContent().catch(() => '');
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click().catch(() => {});
  const metrics = await page.evaluate(() => {
    const f = window.qa.frames, h = window.qa.health;
    let distinct = 0, last, lastAt = f[0]?.[0] ?? 0; const gaps = [];
    for (const [at, ts] of f) if (ts !== last) { if (last !== undefined) gaps.push(at - lastAt); distinct++; last = ts; lastAt = at; }
    gaps.sort((a, b) => b - a);
    let loadingMs = 0, run = 0; const runs = [], reasons = {}, errors = new Set();
    for (let i = 1; i < h.length; i++) {
      const dt = h[i][0] - h[i - 1][0];
      if (h[i - 1][4]) errors.add(h[i - 1][4]);
      if (h[i - 1][1]) { loadingMs += dt; run += dt; const r = (h[i - 1][3] || '?').slice(0, 90); reasons[r] = (reasons[r] || 0) + dt; } else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    const span = h.length > 1 ? h.at(-1)[0] - h[0][0] : 1;
    return { renderedPerSec: +(f.length / (span / 1000)).toFixed(1), picturesPerSec: +(distinct / (span / 1000)).toFixed(1), worstFreezesMs: gaps.slice(0, 5).map(Math.round),
      loadingPct: +(100 * loadingMs / span).toFixed(1), longestLoadingMs: Math.round(Math.max(0, ...runs)), engines: [...new Set(h.map((x) => x[2]).filter(Boolean))], errors: [...errors].slice(0, 5),
      loadingReasonsMs: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, Math.round(v)])) };
  });
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    const byId = new Map(profile.nodes.map((n) => [n.id, n])), self = new Map();
    profile.samples.forEach((id, i) => { const c = byId.get(id).callFrame, key = `${c.functionName || '(anon)'} ${c.url.split('/').pop()}:${c.lineNumber}:${c.columnNumber}`; self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    metrics.idlePct = +(100 * (self.get('(idle) :-1:-1') ?? 0) / total).toFixed(1);
    metrics.hotspots = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${(100 * v / total).toFixed(1)}% ${k}`);
  }
  const p = { pass, cached: /on this computer/i.test(footage ?? ''), advancedSeconds: +(timecode(endTime) - timecode(startTime)).toFixed(2), wallSeconds: SECONDS, status: statusText?.slice(0, 120), footage: footage?.slice(0, 60), ...metrics };
  report.passes.push(p);
  console.log(JSON.stringify(p));
  if (pass < PASSES - 1) await page.waitForTimeout(Number(process.env.CACHE_WAIT ?? 30000));
}
report.consoleErrors = consoleErrors.slice(0, 20);
report.failedMedia = failed.slice(0, 20);
const last = report.passes.at(-1), problems = [];
if (!report.firstPictureAt) problems.push('no first picture');
if (last.errors.length) problems.push(`playback errors: ${last.errors.join(' | ')}`);
if (failed.length) problems.push(`${failed.length} media requests failed`);
if (process.env.MIN_FPS && last.picturesPerSec < Number(process.env.MIN_FPS)) problems.push(`picturesPerSec ${last.picturesPerSec} < ${process.env.MIN_FPS}`);
if (process.env.MAX_FREEZE_MS && (last.worstFreezesMs[0] ?? 0) > Number(process.env.MAX_FREEZE_MS)) problems.push(`freeze ${last.worstFreezesMs[0]} ms > ${process.env.MAX_FREEZE_MS}`);
if (process.env.MAX_LOADING_PCT && last.loadingPct > Number(process.env.MAX_LOADING_PCT)) problems.push(`loading ${last.loadingPct}% > ${process.env.MAX_LOADING_PCT}%`);
report.problems = problems;
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(problems.length ? `FAIL: ${problems.join('; ')}` : 'PASS', '→', out);
await browser.close();
process.exit(problems.length ? 1 : 0);
