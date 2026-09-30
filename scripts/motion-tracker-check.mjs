// Motion tracking on real footage, end to end in the browser: place a point on the soccer ball, track it both ways,
// correct it frame by frame, attach a title to it, then make a face shot follow an eye with camera follow. Isolated
// accounts and database; the live project is only read. Screenshots land in artifacts/qa/motion-tracker-*.png.
//   node --experimental-strip-types scripts/motion-tracker-check.mjs [data]
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, cp, link, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createFrameLineServer } from '../server/index.ts';
import { browserExecutable } from './browser-options.mjs';
import { anchorFrame, pictureBounds, poseLayerPoint, sharedFrames, sourceSize, sourceToLayer, trackAtTimeline, trackerPath } from '../src/services/motionTracker.ts';
import { evaluateClip } from '../src/services/animation.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sourceData = resolve(process.argv[2] || 'data'), shots = resolve('artifacts/qa');
const PROJECT = 'project-b65a6aab56903ac940bc1d5cd5bcad5272bec25a', BALL = 'clip-a4fe560c-1f39-495e-9bb2-e0b7dd45b4d5', FACE = 'clip-c51297a1-fd7b-4a9c-91a3-825637a0f4e9', TITLE = 'clip-2bb272e1-5f72-4f33-a384-60593d1b91a7';
const database = new DatabaseSync(join(sourceData, 'frameline.sqlite'), { readOnly: true });
const source = JSON.parse(database.prepare('SELECT state FROM workspace WHERE id=1').get().state);
// The project's title uses a font uploaded to the shared font library; the export needs it too.
const fonts = database.prepare('SELECT * FROM fonts').all(); database.close();
const project = source.projects.find(p => p.id === PROJECT);
assert.ok(project, 'This check needs the Girls Soccer project.');
const pick = id => structuredClone(source.clips.find(c => c.id === id));
// The ball shot from the timeline start, the face shot after it with more of its source, and the project's title over the ball.
const ball = { ...pick(BALL), start: 0 }, face = { ...pick(FACE), start: 10, duration: 4, sourceIn: 0 };
// A 1.2 s cut of the ball shot, the length of a real sports edit: the editor loops it.
const LOOP = 'clip-short-loop', loop = { ...pick(BALL), id: LOOP, start: 16, duration: 1.2, sourceIn: 2 };
const title = { ...pick(TITLE), id: 'clip-ball-title', start: 0, duration: ball.duration, keyframes: undefined, properties: { ...pick(TITLE).properties, x: 0, y: 0, zoom: 100, rotation: 0 } };
for (const clip of [ball, face, loop]) { delete clip.keyframes; delete clip.motionTrackers; clip.properties = { ...clip.properties, x: 0, y: 0, zoom: 100, rotation: 0, anchorX: 0, anchorY: 0 }; }
const media = source.media.filter(m => [ball.mediaId, face.mediaId].includes(m.id));
const timelines = source.timelines.filter(t => t.id === ball.timelineId);
const tracks = source.tracks.filter(t => t.timelineId === ball.timelineId);

await mkdir(shots, { recursive: true });
const temp = await realpath(await mkdtemp(join(tmpdir(), 'frameline-tracker-qa-')));
await cp(resolve(process.env.QA_DIST || 'dist'), join(temp, 'dist'), { recursive: true });
delete process.env.FRAME_LINE_SIGNUP_CODE;
let app = createFrameLineServer({ dataDir: temp, distDir: join(temp, 'dist') });
const listen = async () => { await new Promise(r => app.server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${app.server.address().port}`; };
let url = await listen();
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
const report = {};
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const registration = await context.request.post(url + '/api/auth/signup', { data: { name: 'Tracker QA', email: 'tracker@example.test', password: 'FrameLine-tracker-QA-2026' } });
  assert.equal(registration.status(), 201); const owner = (await registration.json()).user;
  await app.close();
  const db = new DatabaseSync(join(temp, 'frameline.sqlite'));
  const state = JSON.parse(db.prepare('SELECT state FROM workspace WHERE id=1').get().state);
  Object.assign(state, { projects: [{ ...project, members: [{ userId: owner.id, role: 'Owner' }] }], media, timelines: timelines.map(t => ({ ...t, duration: 20 })), tracks, clips: [ball, face, title, loop], nodes: [] });
  db.prepare('UPDATE workspace SET state=?, revision=revision+1 WHERE id=1').run(JSON.stringify(state));
  for (const font of fonts) db.prepare('INSERT OR REPLACE INTO fonts(id,name,data,uploader,createdAt) VALUES(?,?,?,?,?)').run(font.id, font.name, font.data, owner.id, font.createdAt);
  db.close();
  // Hard links: the 4K originals stay where they are and this copy never writes into the live media folder.
  for (const asset of media) {
    const from = join(sourceData, 'media', asset.id), to = join(temp, 'media', asset.id);
    await mkdir(join(to, 'prepared'), { recursive: true });
    const place = async (a, b) => { try { await link(a, b); } catch { await copyFile(a, b, constants.COPYFILE_FICLONE); } };
    await place(join(from, 'original'), join(to, 'original'));
    for (const file of await readdir(join(from, 'prepared'))) if (!file.startsWith('.')) await place(join(from, 'prepared', file), join(to, 'prepared', file));
  }
  app = createFrameLineServer({ dataDir: temp, distDir: join(temp, 'dist') }); url = await listen();
  const capability = await (await context.request.get(url + '/api/motion-trackers/capabilities')).json();
  assert.equal(capability.available, true, capability.reason);

  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${url}/project/${PROJECT}`);
  await page.locator(`[data-clip="${BALL}"]`).waitFor({ timeout: 60_000 });
  const stateOf = async () => (await (await context.request.get(url + '/api/state')).json()).state;
  const select = async id => { await page.locator(`[data-clip="${id}"]`).focus(); await page.keyboard.press('Enter'); };
  const openTracking = async () => {
    const section = page.locator('details.inspector-section', { has: page.locator('summary', { hasText: 'Tracking' }) });
    await section.waitFor();
    if (await section.getAttribute('open') === null) await section.locator('summary').click();
  };
  const setRange = async (locator, value) => locator.evaluate((el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  // The tracker draws over the viewer's own picture: its tools in the bar above it, its frames in the strip below.
  const editor = page.locator('.motion-tracker-bar'), marks = page.locator('.motion-tracker-marks'), strip = page.locator('.viewer-focus-strip .focus-strip');
  const sourceTimes = async clipId => (await (await context.request.get(`${url}/api/motion-trackers/source-times?clipId=${clipId}`)).json()).sourceTimes;
  const frameAt = (times, time) => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= time + 1e-7) lo = m + 1; else hi = m; } return Math.max(0, lo - 1); };
  const shownFrame = async () => Number((await page.locator('.viewer-focus-strip .focus-frame').getAttribute('title')).match(/Source frame (\d+)/)[1]) - 1;
  // The picture on screen, from the engine itself: the source frame its last drawn picture carries, once it is not loading.
  const pictureFrame = async times => { const at = await page.evaluate(() => { const c = document.querySelector('.viewer-frame > canvas'); return c.dataset.buffering === 'false' && c.dataset.sourceTimestamp ? Number(c.dataset.sourceTimestamp) : null; }); return at === null ? -1 : frameAt(times, at + .25 / 59.94); };
  const goToFrame = async (times, frame) => {
    const box = await strip.boundingBox(), count = Number(await strip.getAttribute('aria-valuemax')), first = await shownFrame() - (Number(await strip.getAttribute('aria-valuenow')) - 1);
    await page.mouse.click(box.x + (frame - first + .5) / count * box.width, box.y + box.height / 2);
    for (let i = 0; i < 12 && await shownFrame() !== frame; i++) await page.keyboard.press(await shownFrame() < frame ? 'ArrowRight' : 'ArrowLeft');
    assert.equal(await shownFrame(), frame, 'the strip and arrow keys reach the frame');
    const began = Date.now();
    while (await pictureFrame(times) !== frame) { if (Date.now() - began > 30_000) throw Error(`the picture never showed source frame ${frame}`); await page.waitForTimeout(40); }
    await page.waitForTimeout(150);
  };
  const clickSource = async (x, y) => { const box = await marks.boundingBox(); await page.mouse.click(box.x + x * box.width, box.y + y * box.height); };
  const drawSource = async (x0, y0, x1, y1) => { const box = await marks.boundingBox(), at = (x, y) => [box.x + x * box.width, box.y + y * box.height]; await page.mouse.move(...at(x0, y0)); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(...at(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8)); await page.mouse.up(); };
  const placed = () => page.waitForFunction(() => document.querySelector('.motion-tracker-marks text')?.textContent?.includes('placed'));
  const idle = async () => { await page.waitForTimeout(300); await page.waitForFunction(() => !document.querySelector('.motion-tracker-bar progress') && !document.querySelector('.focus-status.busy'), null, { timeout: 240_000 }); await page.waitForTimeout(500); };
  const tracker = async clipId => (await stateOf()).clips.find(c => c.id === clipId).motionTrackers?.[0];
  const samples = async key => (await (await context.request.get(`${url}/api/motion-trackers/samples/${key}?projectId=${PROJECT}`)).json());

  // --- The ball: place on the frame at 3.99 s, track forward, then back to the clip start.
  await select(BALL); await openTracking();
  await page.getByRole('button', { name: 'Add tracker' }).click();
  await editor.waitFor();
  const ballTimes = await sourceTimes(BALL), ballFrame = ballTimes.findLastIndex(t => t <= 3.99 + 1e-7);
  await goToFrame(ballTimes, ballFrame);
  // Draw the feature box around the ball, a little bigger than it, the way an editor sizes a pattern.
  await drawSource(.574 - .029, .778 - .052, .574 + .029, .778 + .052); await placed();
  const drawn = await tracker(BALL);
  Object.assign(report, { ballFeaturePx: [Math.round(drawn.feature.width * 3840), Math.round(drawn.feature.height * 2160)], ballPlaced: drawn.keys[0] });
  assert.ok(Math.abs(drawn.feature.width * 3840 - 223) < 12 && Math.abs(drawn.keys[0].x - .574) < .003, 'the drawn box sized the pattern and centred the point');
  await page.screenshot({ path: join(shots, 'motion-tracker-ball-placed.png') });
  let started = Date.now();
  await editor.getByLabel('Track forward').click();
  await page.waitForTimeout(1500); await page.screenshot({ path: join(shots, 'motion-tracker-ball-tracking.png') });
  await idle(); report.ballForwardSeconds = (Date.now() - started) / 1000;
  await goToFrame(ballTimes, ballFrame);
  started = Date.now();
  await editor.getByLabel('Track backward').click(); await idle(); report.ballBackwardSeconds = (Date.now() - started) / 1000;
  // Around frame 100 the ball sits against the dribbler's white boot: the tracker has to stop and say so there.
  report.ballBackwardStatus = await page.locator('.focus-status').textContent({ timeout: 2000 }).catch(() => '');
  const ballTracker = await tracker(BALL);
  assert.ok(ballTracker?.result?.key, 'the ball track was saved');
  const ballSamples = await samples(ballTracker.result.key);
  Object.assign(report, { ballFrames: ballSamples.frames.length, ballFirst: ballSamples.frames[0], ballLast: ballSamples.frames.at(-1) });
  assert.ok(ballSamples.frames[0] <= ballFrame - 100, 'backward tracked a hundred frames or more');
  await page.screenshot({ path: join(shots, 'motion-tracker-ball-backward.png') });
  assert.ok(ballSamples.frames[0] === 0 || /Lost|left/.test(report.ballBackwardStatus), `an early stop says why: ${JSON.stringify(report)}`);
  assert.ok(ballSamples.frames.at(-1) > ballFrame + 60, 'forward tracked well past the placed frame');
  // --- Playback with the editor open: the picture streams, the point rides the exact frame on screen, the clip loops.
  await goToFrame(ballTimes, ballSamples.frames[0]);
  const playback = await page.evaluate(async ({ times, fps }) => {
    const canvas = document.querySelector('.viewer-frame > canvas'), shown = new Set(), gaps = [];
    const frameAt = t => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= t + 1e-7) lo = m + 1; else hi = m; } return Math.max(0, lo - 1); };
    let samples = 0, matched = 0, moved = 0, wrapped = false, last = -1, lastPose = '', lastAt = 0;
    // A frame after the engine draws: by then the editor has re-rendered on that picture's own timestamp.
    const onFrame = () => requestAnimationFrame(() => {
      const picture = frameAt(Number(canvas.dataset.sourceTimestamp) + .25 / fps), label = Number(document.querySelector('.focus-frame')?.getAttribute('title')?.match(/Source frame (\d+)/)?.[1]) - 1;
      const pose = document.querySelector('.motion-tracker-marks > g[transform]')?.getAttribute('transform') ?? '', now = performance.now();
      if (lastAt) gaps.push(now - lastAt); lastAt = now;
      shown.add(picture); samples++; if (label === picture) matched++; if (pose && pose !== lastPose) { moved++; lastPose = pose; }
      if (last >= 0 && picture < last - 5) wrapped = true; last = picture;
    });
    window.addEventListener('frameline:frame', onFrame);
    const began = performance.now();
    document.querySelector('[aria-label="Play playback"]').click();
    await new Promise(r => setTimeout(r, 10_000));
    document.querySelector('[aria-label="Pause playback"]').click();
    window.removeEventListener('frameline:frame', onFrame);
    gaps.sort((a, b) => a - b);
    return { seconds: (performance.now() - began) / 1000, samples, distinctFrames: shown.size, matched, moved, wrapped, medianGapMs: Math.round(gaps[gaps.length >> 1]), p95GapMs: Math.round(gaps[Math.floor(gaps.length * .95)]) };
  }, { times: ballTimes, fps: 59.94 });
  await page.waitForTimeout(600);
  Object.assign(report, { editorPlayback: { ...playback, fps: Math.round(playback.samples / playback.seconds * 10) / 10 } });
  assert.ok(playback.samples / playback.seconds > 20, `the editor plays the picture, not just the sound (${JSON.stringify(playback)})`);
  assert.ok(playback.distinctFrames > 120, 'playback walks through the source frames');
  assert.ok(playback.matched / playback.samples > .9, 'the tracker marks the exact frame on screen while playing');
  assert.ok(playback.moved > 60, 'the point moves with the picture');
  assert.ok(playback.wrapped, 'playback loops over the clip being edited');
  assert.equal(await shownFrame(), await pictureFrame(ballTimes), 'pausing leaves the editor on the frame on screen');
  await page.screenshot({ path: join(shots, 'motion-tracker-ball-paused-after-play.png') });
  // Stepping frame by frame answers at scrub speed: every step lands on its own source frame of the 60p shot.
  const stepTimes = [];
  for (let i = 0; i < 10; i++) {
    const target = await shownFrame() + 1, began = Date.now();
    await page.getByLabel('Next frame', { exact: true }).click();
    while (await pictureFrame(ballTimes) !== target) { if (Date.now() - began > 10_000) throw Error('a step never reached its frame'); await page.waitForTimeout(5); }
    stepTimes.push(Date.now() - began);
  }
  stepTimes.sort((a, b) => a - b);
  report.stepMs = { median: stepTimes[5], worst: stepTimes[9] };
  // Frame by frame: step to a later frame, nudge the point there, and re-track forward from the correction.
  await goToFrame(ballTimes, ballFrame + 40); await page.screenshot({ path: join(shots, 'motion-tracker-ball-review.png') });
  await marks.focus();
  await page.keyboard.press('Shift+ArrowRight'); await placed();
  await editor.getByLabel('Track forward').click(); await idle();
  const corrected = await tracker(BALL);
  assert.equal(corrected.keys.length, 2, 'the correction is a second placed point');
  assert.notEqual(corrected.result.key, ballTracker.result.key, 're-tracking from the correction produced a new track');
  await page.screenshot({ path: join(shots, 'motion-tracker-ball-corrected.png') });
  // Zoomed in and paused, the picture under the point is the original's own pixels, not the soft proxy.
  await page.getByLabel('Viewer zoom', { exact: true }).selectOption('200');
  await page.waitForFunction(() => { const still = document.querySelector('.focus-still'); return still && !still.hidden && still.width === 3840; }, null, { timeout: 60_000 });
  await page.screenshot({ path: join(shots, 'motion-tracker-ball-zoom-200.png') });
  await page.getByLabel('Viewer zoom', { exact: true }).selectOption('Fit');
  // Delete belongs to the tracker while it is open: on a frame with no placed point it does nothing, never deletes the clip.
  await goToFrame(ballTimes, ballSamples.frames[0] + 5); await marks.focus(); await page.keyboard.press('Delete'); await page.waitForTimeout(600);
  assert.ok((await stateOf()).clips.some(c => c.id === BALL), 'Delete in the tracker never deletes the clip');
  assert.equal((await tracker(BALL)).keys.length, 2, 'Delete on a frame without a placed point changes nothing');
  await page.keyboard.press('Escape'); await editor.waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('.viewer-focus-strip .focus-strip') && document.querySelector('.viewer-header')?.textContent?.includes('Timeline viewer'));
  await select(BALL); await openTracking();

  // --- Attach the title to the ball where the playhead stands (the editor moved it to the corrected frame).
  await page.getByRole('button', { name: 'Attach layer' }).click();
  await page.getByLabel('Layer to attach').selectOption(title.id);
  await page.getByRole('button', { name: 'Attach to track' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Layers Track 1 moves"]'), null, { timeout: 30_000 });
  const withTitle = await stateOf(), attached = withTitle.clips.find(c => c.id === title.id), ballNow = withTitle.clips.find(c => c.id === BALL);
  assert.ok(attached.keyframes?.['properties.x']?.length > 2 && attached.keyframes?.['properties.y']?.length > 2, 'the title has position keyframes');
  const trackNow = ballNow.motionTrackers[0], path = trackerPath(trackNow, await samples(trackNow.result.key)), project4k = [3840, 2160], asset = media.find(m => m.id === ball.mediaId);
  const linkNow = trackNow.links.find(l => l.clipId === title.id);
  // The link keeps its anchor as a source time of the ball shot; find the timeline frame that shows it.
  const anchorAt = anchorFrame({ tracked: ball, asset: media.find(m => m.id === ball.mediaId), source: [3840, 2160], project: [3840, 2160], fps: 30, path }, sharedFrames(ball, title, 30), linkNow.time);
  const q = time => poseLayerPoint(evaluateClip(ball, time, 30), sourceToLayer(trackAtTimeline(path, ball, asset, time, 30), sourceSize(asset), project4k), project4k);
  let worst = 0, checked = 0;
  for (let n = 0; n < Math.round(ball.duration * 30); n++) {
    const time = n / 30; if (!trackAtTimeline(path, ball, asset, time, 30)) continue;
    const p = evaluateClip(attached, time, 30).properties, expected = { x: linkNow.base.x + q(time).x - q(anchorAt).x, y: linkNow.base.y + q(time).y - q(anchorAt).y };
    worst = Math.max(worst, Math.hypot(Number(p.x) - expected.x, Number(p.y) - expected.y)); checked++;
  }
  Object.assign(report, { titleFramesChecked: checked, titleWorstErrorPx: Math.round(worst * 1000) / 1000, titleKeys: attached.keyframes['properties.x'].length });
  assert.ok(worst < .1, `the title follows the ball (worst ${worst} px)`);
  await page.screenshot({ path: join(shots, 'motion-tracker-title-attached.png') });

  // --- The face: place a tracker on the eye, track both ways, and make the shot follow it, centred.
  await select(FACE); await openTracking();
  await page.getByRole('button', { name: 'Add tracker' }).click(); await editor.waitFor();
  const faceTimes = await sourceTimes(FACE), faceFrame = faceTimes.findLastIndex(t => t <= .55 + 1e-7);
  await goToFrame(faceTimes, faceFrame);
  await clickSource(.346, .262); await placed();
  await editor.getByLabel('Track forward').click(); await idle();
  await goToFrame(faceTimes, faceFrame); await editor.getByLabel('Track backward').click(); await idle();
  const faceTracker = await tracker(FACE), faceSamples = await samples(faceTracker.result.key);
  Object.assign(report, { faceFrames: faceSamples.frames.length, faceFirst: faceSamples.frames[0], faceLast: faceSamples.frames.at(-1) });
  await goToFrame(faceTimes, faceFrame + 90); await page.screenshot({ path: join(shots, 'motion-tracker-face-review.png') });
  await editor.getByLabel('Close tracker editor').click();
  await page.getByRole('button', { name: 'Camera follow' }).click();
  await page.getByLabel('Camera framing').selectOption('center');
  await page.getByRole('button', { name: 'Follow this point' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.motion-tracker-links li span')].some(s => s.textContent.includes('camera follow')), null, { timeout: 30_000 });
  const followed = (await stateOf()).clips.find(c => c.id === FACE), faceAsset = media.find(m => m.id === face.mediaId);
  assert.ok(followed.keyframes?.['properties.zoom']?.length >= 2, 'camera follow keyframed the zoom');
  // No frame may uncover an edge of the picture, and the eye stays centred wherever the zoom allows.
  const facePath = trackerPath(faceTracker, faceSamples), bounds = pictureBounds(followed, sourceSize(faceAsset), project4k);
  let uncovered = 0, offMark = 0, frames = 0;
  for (let n = 0; n < 120; n++) {
    const time = 10 + n / 30, point = trackAtTimeline(facePath, followed, faceAsset, time, 30);
    if (!point) continue; frames++;
    const pose = evaluateClip(followed, time, 30), p = pose.properties, zoom = Number(p.zoom) / 100;
    for (const [cx, cy] of [[0, 0], [3840, 0], [0, 2160], [3840, 2160]]) {
      const lx = 1920 + (cx - 1920 - Number(p.x)) / zoom, ly = 1080 + (cy - 1080 - Number(p.y)) / zoom;
      if (lx < bounds.left - .5 || lx > bounds.right + .5 || ly < bounds.top - .5 || ly > bounds.bottom + .5) uncovered++;
    }
    const at = poseLayerPoint(pose, sourceToLayer(point, sourceSize(faceAsset), project4k), project4k);
    if (Math.hypot(at.x - 1920, at.y - 1080) > 60) offMark++;
  }
  const zooms = followed.keyframes['properties.zoom'].map(k => k.value);
  Object.assign(report, { faceFollowFrames: frames, faceUncoveredCorners: uncovered, faceOffMarkFrames: offMark, faceZoomRange: [Math.min(...zooms), Math.max(...zooms)] });
  // The raw track and the follow it produced, for looking into a result offline.
  await writeFile(join(shots, 'motion-tracker-face.json'), JSON.stringify({ tracker: faceTracker, samples: faceSamples, followed, asset: faceAsset }));
  assert.equal(uncovered, 0, 'camera follow never shows an edge');
  assert.equal(offMark, 0, 'the eye stays centred: the zoom this shot needs is under the most allowed');
  await page.screenshot({ path: join(shots, 'motion-tracker-face-follow.png') });
  // --- A short clip loops in the editor at nearly the full rate: each lap's backward seek is covered, not waited out.
  await select(LOOP); await openTracking();
  await page.getByRole('button', { name: 'Add tracker' }).click(); await editor.waitFor();
  await page.waitForFunction(() => !document.querySelector('.focus-status')?.textContent?.includes('Reading source') && document.querySelector('.viewer-frame > canvas')?.dataset.buffering === 'false', null, { timeout: 90_000 });
  await page.waitForTimeout(500);
  report.shortLoop = await page.evaluate(async () => {
    const canvas = document.querySelector('.viewer-frame > canvas'), shown = new Set(), gaps = []; let samples = 0, lastAt = 0;
    const onFrame = () => requestAnimationFrame(() => { const now = performance.now(); if (lastAt) gaps.push(now - lastAt); lastAt = now; samples++; shown.add(canvas.dataset.sourceTimestamp); });
    window.addEventListener('frameline:frame', onFrame);
    const began = performance.now(); document.querySelector('[aria-label="Play playback"]').click();
    await new Promise(r => setTimeout(r, 6000));
    document.querySelector('[aria-label="Pause playback"]').click(); window.removeEventListener('frameline:frame', onFrame);
    gaps.sort((a, b) => a - b);
    return { fps: Math.round(samples / ((performance.now() - began) / 1000) * 10) / 10, distinct: shown.size, worstGapMs: Math.round(gaps.at(-1)), p95GapMs: Math.round(gaps[Math.floor(gaps.length * .95)]) };
  });
  assert.ok(report.shortLoop.fps > 24, `a 1.2 s clip loops at nearly the full 30 fps (${JSON.stringify(report.shortLoop)})`);
  await editor.getByLabel('Close tracker editor').click();

  // --- Export both segments and look at the delivered pictures: the title rides the ball, the follow shows no edge.
  const exported = {};
  for (const [name, from, to] of [['title', 0, 5.6], ['follow', 10, 14]]) {
    const settings = { codec: 'H.264', resolution: '1920 × 1080', fps: '30', quality: 'High · 20 Mb/s', rangeIn: String(from), rangeOut: String(to), audio: 'Disabled', timelineId: ball.timelineId };
    const began = Date.now(), queued = await context.request.post(url + '/api/renders', { data: { projectId: PROJECT, name: `${name}.mp4`, preset: 'Custom', settings } });
    assert.equal(queued.status(), 202, await queued.text());
    const id = (await queued.json()).job.id;
    let job;
    for (;;) { job = (await stateOf()).renderJobs.find(j => j.id === id); if (['complete', 'failed'].includes(job?.status)) break; await new Promise(r => setTimeout(r, 1000)); }
    assert.equal(job.status, 'complete', job.error);
    const file = join(temp, `${name}.mp4`);
    await writeFile(file, Buffer.from(await (await context.request.get(url + job.outputUrl)).body()));
    exported[name] = { file, seconds: (Date.now() - began) / 1000 };
  }
  report.exportSeconds = Object.fromEntries(Object.entries(exported).map(([name, value]) => [name, value.seconds]));
  const grab = (file, time, out) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(time), '-i', file, '-frames:v', '1', out]);
  for (const time of [.5, 2, 3.5, 5]) grab(exported.title.file, time, join(shots, `motion-tracker-export-title-${time}s.png`));
  // Edge rows and columns of every followed frame: a border would be a run of black there.
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', exported.follow.file, '-vf', 'scale=192:108,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  let darkest = 255;
  for (let f = 0; f * 192 * 108 < raw.length; f++) {
    const at = (x, y) => raw[f * 192 * 108 + y * 192 + x], edges = [];
    for (let x = 0; x < 192; x++) edges.push(at(x, 0), at(x, 107));
    for (let y = 0; y < 108; y++) edges.push(at(0, y), at(191, y));
    darkest = Math.min(darkest, edges.reduce((a, b) => a + b, 0) / edges.length);
  }
  report.followDarkestEdgeMean = darkest;
  assert.ok(darkest > 20, `the followed export shows no black edge (darkest edge mean ${darkest})`);
  grab(exported.follow.file, 2, join(shots, 'motion-tracker-export-follow-2s.png'));
  report.pageErrors = errors.filter(e => !/favicon|ResizeObserver/.test(e));
  assert.deepEqual(report.pageErrors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close(); await app.close();
  await rm(temp, { recursive: true, force: true });
}
