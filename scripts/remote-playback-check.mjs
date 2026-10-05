// Plays a real timeline on sharedcut.com (or any ORIGIN) as a signed-in user and measures what a remote
// editor sees: first picture, pictures per second, freezes and "Loading picture…" time, cold and cached.
// Look-only: it switches timeline tabs and presses Play/Pause; it never edits.
//
//   node scripts/agent/agent-session.mjs <owner email> 1        # once, on the server: writes ~/sharedcut-agent/cookie.txt
//   node scripts/remote-playback-check.mjs [report.json]
//
// Env: ORIGIN (https://sharedcut.com)  PROJECT  TIMELINE (tab text)  SECONDS (30)  PASSES (2)  FPS (30)
//      QUALITY (Preview quality option)  CACHE_WAIT ms between passes (30000)  PROFILE=1 (main-thread hotspots)
//      RELOAD=1: reload the page before every pass after the first, a later visit: saved footage stays, choices the
//        page made in memory (such as playing an asset's low stream) do not.
//      DIST=<built client dir>: serve that build's HTML/assets/worker instead of the live bundle, so a client
//        change is measured against live data before it is deployed.
//      MIN_FPS, MAX_FREEZE_MS, MAX_LOADING_PCT: thresholds for the cached pass; any miss exits 1.
//      DOWN_MBPS, RTT_MS: a home connection. Every byte the browser exchanges with the site (page, decoder workers and
//        the footage service worker alike) crosses one shared link: a local CONNECT proxy that releases downstream bytes
//        at DOWN_MBPS and delays each direction by RTT_MS/2. CDP network emulation is set per target, each with its own
//        budget; the proxy puts every target on one line, as a home connection does. The report's `link` (proxy byte
//        counts) and each pass's `workerMbps` (the worker's own chunk timings) show the limit held.
//        DIST assets are served locally and skip the link; compare `firstPictureAfterTabS` across builds.
//      CPU_RATE: Emulation.setCPUThrottlingRate on the page, e.g. 4 for a weak laptop. Slows the page's main thread,
//        where compositing runs; decoder workers are not targeted.
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const ORIGIN = process.env.ORIGIN ?? 'https://sharedcut.com';
const PROJECT = process.env.PROJECT ?? 'project-7694cce382b0915d28eed8117c563129367ccda0';
const TIMELINE = process.env.TIMELINE ?? 'Part 1 v2';
const SECONDS = Number(process.env.SECONDS ?? 30), PASSES = Number(process.env.PASSES ?? 2), FPS = Number(process.env.FPS ?? 30);
const START_EDITS = Number(process.env.START_EDITS ?? 0);
const DOWN_MBPS = Number(process.env.DOWN_MBPS ?? 0), RTT_MS = Number(process.env.RTT_MS ?? 0), CPU_RATE = Number(process.env.CPU_RATE ?? 1);
const out = process.argv[2] ?? 'artifacts/qa/remote-playback.json';
const cookie = (process.env.FRAME_LINE_COOKIE ?? readFileSync(join(homedir(), 'sharedcut-agent', 'cookie.txt'), 'utf8')).trim();
const token = cookie.replace(/^frameline_session=/, '');

/** One shaped line for every connection: a FIFO downlink at `mbps` plus `rtt` of propagation delay. */
async function shapedLink(mbps, rtt) {
  const perSecond = new Map(), sockets = new Set();
  // Bytes queued past this many ms push back on the far end (TCP window), as a modem buffer does.
  const QUEUE_MS = 250;
  let free = 0;
  const pipe = (from, to, rate) => {
    const queue = []; let timer;
    const drain = () => {
      timer = undefined; const now = performance.now();
      while (queue.length && queue[0].at <= now) { const { data } = queue.shift(); if (rate) { const second = Math.floor(Date.now() / 1000); perSecond.set(second, (perSecond.get(second) ?? 0) + data.length); } to.write(data); }
      if (rate && from.isPaused() && free - now < QUEUE_MS / 2) from.resume();
      // A paused socket with nothing queued still has to wake once other connections' bytes have drained.
      const next = queue.length ? queue[0].at : rate && from.isPaused() ? free - QUEUE_MS / 2 : undefined;
      if (next !== undefined) timer = setTimeout(drain, Math.max(1, next - now));
    };
    from.on('data', (data) => {
      const now = performance.now();
      let at = now;
      if (rate) { free = Math.max(free, now) + data.length * 8 / (rate * 1000); at = free; if (free - now > QUEUE_MS) from.pause(); }
      queue.push({ at: at + rtt / 2, data });
      timer ??= setTimeout(drain, Math.max(0, queue[0].at - now));
    });
    from.on('end', () => { const close = () => (queue.length ? setTimeout(close, 20) : to.end()); close(); });
  };
  const server = createServer((_, response) => response.writeHead(405).end());
  server.on('connect', (request, client, head) => {
    const [host, port] = request.url.split(':');
    const upstream = connect(Number(port) || 443, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      pipe(client, upstream, 0); pipe(upstream, client, mbps);
    });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => { client.destroy(); upstream.destroy(); }); socket.on('close', () => sockets.delete(socket)); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    /** Downstream Mbps between two Date.now() stamps: mean, and the busiest whole second. */
    stats: (from, to) => { const seconds = [...perSecond].filter(([s]) => s >= Math.ceil(from / 1000) && s < Math.floor(to / 1000)); const bytes = seconds.reduce((n, [, b]) => n + b, 0); return { meanMbps: +(bytes * 8 / 1e6 / Math.max(1, seconds.length)).toFixed(2), peakSecondMbps: +(Math.max(0, ...seconds.map(([, b]) => b)) * 8 / 1e6).toFixed(2), megabytes: +(bytes / 1e6).toFixed(1) }; },
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}
const link = DOWN_MBPS || RTT_MS ? await shapedLink(DOWN_MBPS, RTT_MS) : undefined;

const browser = await chromium.launch({ channel: 'chrome', headless: true, ...(link ? { proxy: { server: link.server } } : {}), args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
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
  // [at, loading, engine, reason, error, playhead, showing the automatic low stream ("reduced bandwidth" note)]
  window.addEventListener('frameline:playback-health', (e) => { const d = e.detail; if (d.playing) window.qa.health.push([performance.now(), d.loading, d.engine, d.loading ? d.reason : '', d.error ?? '', d.playhead, !!document.querySelector('.viewer-demo-note')?.textContent?.includes('reduced bandwidth')]); });
  // What the footage worker downloads and saves, for the whole session: [at, bytes, ms] and [at, url, bytes].
  window.qaNet = { transfer: [], stored: [] };
  navigator.serviceWorker?.addEventListener('message', (e) => { const d = e.data; if (d?.type === 'footage-transfer') window.qaNet.transfer.push([performance.now() - (d.ago || 0), d.bytes, d.milliseconds]); if (d?.type === 'footage-stored') window.qaNet.stored.push([performance.now(), d.url, d.size]); });
  /** The worker's downloads since `since`: bytes over the time any download was running, and saved MB per kind of file. */
  window.qaNetSummary = (since) => {
    const spans = window.qaNet.transfer.filter(([at]) => at >= since).map(([at, bytes, ms]) => [at - ms, at, bytes]).sort((a, b) => a[0] - b[0]);
    let busy = 0, end = -Infinity, bytes = 0;
    for (const [from, to, n] of spans) { bytes += n; busy += Math.max(0, to - Math.max(from, end)); end = Math.max(end, to); }
    const savedMB = {};
    for (const [at, url, size] of window.qaNet.stored) if (at >= since) { const kind = /stream-low/.test(url) ? 'streamLow' : /stream-v\d/.test(url) ? 'stream' : /full-v\d/.test(url) ? 'full' : /\.webm/.test(url) ? 'webm' : /audio/.test(url) ? 'audioProxy' : 'other'; savedMB[kind] = +((savedMB[kind] ?? 0) + size / 1e6).toFixed(1); }
    const slowestChunkMs = spans.map(([from, to]) => Math.round(to - from)).sort((a, b) => b - a).slice(0, 5);
    return { workerMbps: busy ? +(bytes * 8 / 1e3 / busy).toFixed(2) : 0, workerMB: +(bytes / 1e6).toFixed(1), savedMB, slowestChunkMs };
  };
});
const page = await context.newPage();
if (CPU_RATE > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
const t0 = Date.now(), consoleErrors = [], failed = [];
const stamp = () => +((Date.now() - t0) / 1000).toFixed(1);
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('cloudflareinsights')) consoleErrors.push(`${stamp()} ${m.text().slice(0, 240)}`); });
page.on('pageerror', (e) => consoleErrors.push(`${stamp()} pageerror: ${e.message.slice(0, 240)}`));
page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/media/')) failed.push(`${stamp()} ${r.status()} ${r.url().replace(ORIGIN, '').slice(0, 120)}`); });

await page.goto(`${ORIGIN}/project/${PROJECT}`);
await page.locator('.timeline-tabs button', { hasText: TIMELINE }).first().click({ timeout: 120000 });
const report = { origin: ORIGIN, timeline: TIMELINE, dist: process.env.DIST ?? null, network: { downMbps: DOWN_MBPS || null, rttMs: RTT_MS || null, cpuRate: CPU_RATE }, tabAt: stamp() };
report.firstPictureAt = await page.waitForFunction(() => document.querySelector('.viewer canvas')?.dataset.hasPicture === 'true', null, { timeout: 60000 }).then(stamp, () => null);
report.firstPictureAfterTabS = report.firstPictureAt === null ? null : +(report.firstPictureAt - report.tabAt).toFixed(1);
report.beforeFirstPicture = await page.evaluate(() => window.qaNetSummary(0));
report.gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no webgl2'; });
if (process.env.QUALITY) await page.getByRole('combobox', { name: 'Preview quality', exact: true }).selectOption(process.env.QUALITY);

const timecode = (t) => { const [h, m, s, f] = String(t).split(':').map(Number); return h * 3600 + m * 60 + s + f / FPS; };
report.passes = [];
for (let pass = 0; pass < PASSES; pass++) {
  if (pass && process.env.RELOAD) {
    await page.reload();
    await page.locator('.timeline-tabs button', { hasText: TIMELINE }).first().click({ timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('.viewer canvas')?.dataset.hasPicture === 'true', null, { timeout: 60000 }).catch(() => {});
    if (process.env.QUALITY) await page.getByRole('combobox', { name: 'Preview quality', exact: true }).selectOption(process.env.QUALITY);
  }
  // The editor has no Home shortcut: step back edit by edit so every pass plays the same opening seconds.
  for (let i = 0; i < 500 && timecode(await page.locator('.transport-time').textContent()) > 0; i++) await page.getByRole('button', { name: /^(Previous edit|First frame)$/ }).first().click();
  // START_EDITS=N plays from the Nth edit instead of the opening (the timeline's later stretches are not the graded opening).
  for (let i = 0; i < START_EDITS; i++) await page.getByRole('button', { name: 'Next edit', exact: true }).first().click();
  await page.evaluate(() => window.qaReset());
  const cdp = process.env.PROFILE && pass === PASSES - 1 ? await context.newCDPSession(page) : undefined;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  const startTime = await page.locator('.transport-time').textContent();
  if (link) report[`linkBeforePass${pass}`] = link.stats(pass ? report.passes.at(-1).endedAt : t0, Date.now());
  const startedAt = Date.now(), pageStart = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: 'Play playback', exact: true }).first().click();
  await page.waitForTimeout(SECONDS * 1000);
  // Read without waiting, then pause at once: a locator waits 30 s for the status line, which only exists while something
  // loads, and playback ran on meanwhile, so passes covered 30 or 60 s depending on what was loading.
  const { endTime, statusText, footage } = await page.evaluate(() => ({ endTime: document.querySelector('.transport-time')?.textContent ?? '', statusText: document.querySelector('.viewer-playback-status')?.textContent ?? '', footage: document.querySelector('.footage-loading summary')?.textContent ?? '' }));
  await page.getByRole('button', { name: 'Pause playback', exact: true }).first().click().catch(() => {});
  await page.getByRole('button', { name: 'Play playback', exact: true }).first().waitFor({ timeout: 5000 }).catch(() => page.keyboard.press('Space'));
  const endedAt = Date.now();
  const metrics = await page.evaluate((since) => {
    const f = window.qa.frames, h = window.qa.health;
    let distinct = 0, last, lastAt = f[0]?.[0] ?? 0; const gaps = [];
    for (const [at, ts] of f) if (ts !== last) { if (last !== undefined) gaps.push([at - lastAt, lastAt]); distinct++; last = ts; lastAt = at; }
    gaps.sort((a, b) => b[0] - a[0]);
    // Where on the timeline each long freeze began, so a genuine gap in the edit is not mistaken for a stall.
    const playheadAt = (at) => h.find((x) => x[0] >= at)?.[5];
    const freezesAt = gaps.filter(([ms]) => ms > 250).slice(0, 5).map(([ms, at]) => `${Math.round(ms)}ms@${Number(playheadAt(at)).toFixed(2)}s`);
    let loadingMs = 0, lowMs = 0, run = 0; const runs = [], reasons = {}, errors = new Set();
    for (let i = 1; i < h.length; i++) {
      const dt = h[i][0] - h[i - 1][0];
      if (h[i - 1][6]) lowMs += dt;
      if (h[i - 1][4]) errors.add(h[i - 1][4]);
      if (h[i - 1][1]) { loadingMs += dt; run += dt; const r = (h[i - 1][3] || '?').slice(0, 90); reasons[r] = (reasons[r] || 0) + dt; } else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    const span = h.length > 1 ? h.at(-1)[0] - h[0][0] : 1;
    return { renderedPerSec: +(f.length / (span / 1000)).toFixed(1), picturesPerSec: +(distinct / (span / 1000)).toFixed(1), worstFreezesMs: gaps.slice(0, 5).map(([ms]) => Math.round(ms)), freezesAt,
      loadingPct: +(100 * loadingMs / span).toFixed(1), lowStreamPct: +(100 * lowMs / span).toFixed(1), longestLoadingMs: Math.round(Math.max(0, ...runs)), engines: [...new Set(h.map((x) => x[2]).filter(Boolean))], errors: [...errors].slice(0, 5),
      loadingReasonsMs: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, Math.round(v)])), ...window.qaNetSummary(since) };
  }, pageStart);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    const byId = new Map(profile.nodes.map((n) => [n.id, n])), self = new Map();
    profile.samples.forEach((id, i) => { const c = byId.get(id).callFrame, key = `${c.functionName || '(anon)'} ${c.url.split('/').pop()}:${c.lineNumber}:${c.columnNumber}`; self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    metrics.idlePct = +(100 * (self.get('(idle) :-1:-1') ?? 0) / total).toFixed(1);
    metrics.hotspots = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${(100 * v / total).toFixed(1)}% ${k}`);
  }
  const p = { pass, endedAt, ...(link ? { link: link.stats(startedAt, endedAt) } : {}), cached: /on this computer/i.test(footage ?? ''), from: startTime, to: endTime, advancedSeconds: +(timecode(endTime) - timecode(startTime)).toFixed(2), wallSeconds: SECONDS, status: statusText?.slice(0, 120), footage: footage?.slice(0, 60), ...metrics };
  report.passes.push(p);
  console.log(JSON.stringify(p));
  if (pass < PASSES - 1) await page.waitForTimeout(Number(process.env.CACHE_WAIT ?? 30000));
}
// With DIST, Chrome's worker update check bypasses routing: confirm which footage worker actually served the run.
report.footageWorker = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
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
link?.close();
process.exit(problems.length ? 1 : 0);
