// Browser check for media storage v3: full-v3 (10-bit 4:2:2, half-second GOP) decodes in real Chrome through WebCodecs
// as I422P10 and reaches the colour pipeline as 10-bit planes in Full and Color; the scrub worker's GOP seeks return
// exactly the pictures of each GOP of the short-GOP stream-low-v2.
// Run: node --experimental-strip-types --test src/components/fullProxy.browser.test.ts
// DIST=<built dist> skips the build; PLAYWRIGHT_CHROME_PATH picks a Chrome binary (default: installed Chrome).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createFrameLineServer } from '../../server/index.ts';
import type { MediaAsset } from '../state/models.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
let browser: Browser, dist = process.env.DIST ?? '', built = '';
before(async () => {
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  if (!dist) { built = dist = await mkdtemp(join(tmpdir(), 'frameline-v3-dist-')); execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' }); }
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); if (built) await rm(built, { recursive: true, force: true }); });

test('full-v3 decodes as I422P10 in WebCodecs and grades as 10-bit; the scrub worker returns whole GOPs of stream-low-v2', { timeout: 180000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'frameline-v3-'));
  const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: dist });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); await app.close(); await rm(temp, { recursive: true, force: true }); });
  // The app's own WebCodecs demuxer, served from this origin so the page can import it.
  await context.route('**/__mediabunny.mjs', route => route.fulfill({ path: join(root, 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'), contentType: 'text/javascript' }));
  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Storage Tester');
  await page.getByRole('textbox', { name: 'Email address' }).fill('storage@example.test');
  await page.locator('input[type=password]').fill('Storage-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Storage v3');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.timeline-track').first().waitFor();

  // An ordinary 8-bit 4:2:0 camera file: full-v3 is 10-bit 4:2:2 whatever the source.
  const source = join(temp, 'shot.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  await page.getByLabel('Upload media files').setInputFiles(source);
  let asset: MediaAsset | undefined;
  for (let i = 0; i < 240 && !asset; i++) { asset = (await (await context.request.get(`${url}/api/state`)).json()).state.media.find((m: MediaAsset) => m.status === 'ready' && !m.preparationStage); if (!asset) await page.waitForTimeout(250); }
  assert.ok(asset, 'the upload is prepared');
  assert.match(asset.proxyUrl!, /\/full-v3\.mp4$/); assert.equal(asset.colorProxyUrl, asset.proxyUrl); assert.match(asset.proxyVariants!['1/4'], /\/stream-low-v2\.mp4$/);

  // 1. full-v3 through WebCodecs: every picture of the long-GOP file decodes, as I422P10, including a seek mid-GOP.
  const decoded = await page.evaluate(async file => {
    const { Input, MP4, UrlSource, VideoSampleSink } = await import('/__mediabunny.mjs' as string);
    const input = new Input({ source: new UrlSource(file), formats: [MP4] }), track = await input.getPrimaryVideoTrack();
    const sink = new VideoSampleSink(track), formats = new Set<string>(); let count = 0;
    for await (const sample of sink.samples()) { const frame = sample.toVideoFrame(); formats.add(String(frame.format)); frame.close(); sample.close(); count++; }
    const middle = await sink.getSample(1.3), frame = middle.toVideoFrame(), seek = { format: frame.format, timestamp: middle.timestamp }; frame.close(); middle.close();
    return { codec: await track.getCodecParameterString(), canDecode: await track.canDecode(), formats: [...formats], count, seek };
  }, asset.proxyUrl!);
  assert.equal(decoded.canDecode, true); assert.match(decoded.codec, /^avc1\.7a/, 'High 4:2:2 profile');
  assert.deepEqual(decoded.formats, ['I422P10']); assert.equal(decoded.count, 72);
  assert.equal(decoded.seek.format, 'I422P10'); assert.ok(Math.abs(decoded.seek.timestamp - 31 / 24) < 1e-3, `seek landed on ${decoded.seek.timestamp}`);

  // 2. The real scrub worker on stream-low-v2: a GOP seek returns that GOP's pictures, forward into the next GOP carries
  // on, and a jump back starts over at the right keyframe. GOPs come from the file itself.
  const keys = execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', join(temp, 'data', 'media', asset.id, 'prepared', 'stream-low-v2.mp4')]).toString().trim().split(/\s+/).map(k => k.startsWith('1'));
  const gopOf = (frame: number) => { let key = frame; while (!keys[key]) key--; let end = frame + 1; while (end < keys.length && !keys[end]) end++; return [key, end]; };
  assert.ok(keys.filter(Boolean).length >= 6, 'stream-low-v2 has a keyframe every half second');
  const worker = (await readdir(join(dist, 'assets'))).find(name => /^videoDecodeWorker-.*\.js$/.test(name));
  assert.ok(worker, 'the built scrub worker');
  const delivered = await page.evaluate(async ({ worker, file }) => {
    const decoder = new Worker(`/assets/${worker}`, { type: 'module' }), batches: number[][] = [];
    let batch: number[] = [], formats = new Set<string>(), settled: () => void = () => {}, timer = 0;
    decoder.onmessage = event => { const message = event.data; if (message.type === 'frame') { batch.push(Math.round(message.frame.timestamp / 1e6 * 24)); formats.add(message.frame.format); message.frame.close(); clearTimeout(timer); timer = setTimeout(() => settled(), 800) as unknown as number; } else if (message.type === 'error') throw new Error(message.error); };
    decoder.postMessage({ type: 'open', url: new URL(file, location.href).href, cacheEnabled: false });
    let generation = 0;
    for (const time of [1.3, 1.6, .2]) {
      await new Promise<void>(resolve => { settled = resolve; decoder.postMessage({ type: 'seek', generation: ++generation, time, count: 3, gop: true }); timer = setTimeout(() => settled(), 8000) as unknown as number; });
      batches.push(batch); batch = [];
    }
    decoder.terminate();
    return { batches, formats: [...formats] };
  }, { worker, file: asset.proxyVariants!['1/4'] });
  for (const [i, frame] of [Math.floor(1.3 * 24), Math.floor(1.6 * 24), Math.floor(.2 * 24)].entries()) {
    const [key, end] = gopOf(frame), want = Array.from({ length: Math.max(end, frame + 3) - key }, (_, n) => key + n);
    // Carrying on into the next GOP may also deliver the frame the previous batch stopped before; only its own GOP counts.
    assert.deepEqual(delivered.batches[i].filter(n => n >= key), want, `seek ${i + 1} (frame ${frame}) delivers its GOP ${key}-${end - 1}`);
  }
  assert.deepEqual(delivered.formats, ['I420']);

  // 3. In the editor, Full and Color play full-v3 through WebCodecs with 10-bit planes in the colour pipeline; 1/4 is the 8-bit stream.
  for (let attempt = 0; ; attempt++) {
    const view = await (await context.request.get(`${url}/api/state`)).json(), project = view.state.projects[0].id, timelineId = view.state.timelines[0].id;
    const clip = { id: 'shot', projectId: project, timelineId, trackId: `${project}-v1`, mediaId: asset.id, name: 'shot', start: 0, duration: 3, sourceIn: 0, color: '#b8894f', disabled: false, properties: { dataLevels: 'Video' }, effects: [] };
    const patched = await context.request.patch(`${url}/api/state`, { data: { revision: view.revision, delta: { clips: { upsert: [clip], remove: [] } } } });
    if (patched.ok()) break;
    assert.ok(patched.status() === 409 && attempt < 10, `the clip is saved (${patched.status()} ${await patched.text()})`);
    await page.waitForTimeout(100);
  }
  await page.reload();
  const precision = async (quality: string) => {
    await page.getByRole('combobox', { name: 'Preview quality', exact: true }).selectOption(quality);
    await page.waitForFunction(want => { const c = document.querySelector<HTMLCanvasElement>('.viewer-frame canvas'); return c?.dataset.hasPicture === 'true' && c.dataset.playbackEngine === 'webcodecs' && c.dataset.buffering === 'false' && c.dataset.colorPrecision === want; }, quality === '1/4' ? '8-bit YUV' : '10-bit YUV', { timeout: 30000 });
  };
  for (const quality of ['Full', 'Color', '1/4', 'Full']) await precision(quality);
  assert.deepEqual(errors, []);
});
