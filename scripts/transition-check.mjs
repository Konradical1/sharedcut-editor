import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFrameLineServer } from '../server/index.ts';
import { bestAlign, maximumDuration, timelineTransitions, transitionDefinitions } from '../src/services/transitions.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp = await mkdtemp(join(tmpdir(), 'frameline-transitions-'));
await cp(resolve('dist'), join(temp, 'dist'), { recursive: true });
const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: join(temp, 'dist') });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.overlayDraws = [];
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
    if (source instanceof HTMLVideoElement && source.src.includes('/qa-leak.mp4')) window.overlayDraws.push({ time: source.currentTime, seeking: source.seeking });
    return draw.call(this, source, ...args);
  };
});

const out = resolve('artifacts/qa'); await mkdir(out, { recursive: true });
const ffmpeg = (...args) => promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
const fetchState = async () => (await (await context.request.get(url + '/api/state')).json());
const saved = () => page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
const painted = () => page.waitForFunction(() => document.querySelector('.viewer-frame canvas')?.dataset.hasPicture === 'true', {}, { timeout: 20000 });

/** Rewrite the timeline straight through the save endpoint, then reload so the UI reads it back. */
const write = async mutate => {
  const body = await fetchState();
  mutate(body.state);
  const response = await context.request.put(url + '/api/state', { data: { revision: body.revision, state: body.state } });
  assert.equal(response.status(), 200, await response.text());
  await page.reload();
  await page.locator('.timeline').waitFor();
  await page.getByRole('button', { name: 'Fit', exact: true }).click().catch(() => {});
  await painted().catch(() => {});
};

/** Read the preview canvas back at its own resolution — downsampling first would smooth away the
 *  very banding these measurements are looking for. */
const pixels = () => page.locator('.viewer-frame canvas').evaluate(canvas => {
  const context = canvas.getContext('2d') ?? (() => { const s = document.createElement('canvas'); s.width = canvas.width; s.height = canvas.height; const c = s.getContext('2d'); c.drawImage(canvas, 0, 0); return c; })();
  const w = canvas.width, h = canvas.height;
  const { data } = context.getImageData(0, 0, w, h);
  const at = (x, y) => { const i = (y * w + x) * 4; return (data[i] + data[i + 1] + data[i + 2]) / 3; };
  let energy = 0, count = 0, total = 0, ripples = 0, rows = 0;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 3; x++) { energy += Math.abs(at(x, y) - at(x + 1, y)); count++; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) total += at(x, y);
  // Direction reversals along a row. A true smear ramps one way; a stack of discrete ghosts
  // ripples, reversing every few pixels — which is exactly what "not smooth" looks like.
  for (let y = 4; y < h - 4; y += 4) {
    let previous = 0, reversals = 0;
    for (let x = 2; x < w - 3; x++) {
      const delta = at(x + 1, y) - at(x, y);
      if (Math.abs(delta) < 1.2) continue;
      const sign = Math.sign(delta);
      if (previous && sign !== previous) reversals++;
      previous = sign;
    }
    ripples += reversals; rows++;
  }
  // Strip means, not single pixels: real footage has black in it, but the bug blanked whole edges.
  const strip = (x0, y0, x1, y1) => { let sum = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += at(x, y); n++; } return sum / n; };
  const edge = Math.max(2, Math.round(w * .02));
  return {
    size: `${w}x${h}`, energy: energy / count, mean: total / (w * h), ripples: ripples / rows,
    strips: { left: strip(0, 0, edge, h), right: strip(w - edge, 0, w, h), top: strip(0, 0, w, edge), bottom: strip(0, h - edge, w, h) },
  };
});

/** Step the playhead with the frame keys. Geometry-free, so it survives any timeline zoom. */
let fps = 24;
const nowFrames = async () => {
  const text = await page.locator('.transport-time').first().textContent();
  const [h, m, sec, f] = text.trim().split(':').map(Number);
  return ((h * 60 + m) * 60 + sec) * fps + f;
};
const scrubTo = async time => {
  await page.locator('.timeline').click({ position: { x: 8, y: 8 } });
  const want = Math.round(time * fps);
  for (let guard = 0; guard < 3; guard++) {
    const delta = want - await nowFrames();
    if (!delta) break;
    const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
    for (let i = 0; i < Math.min(Math.abs(delta), 600); i++) await page.keyboard.press(key);
  }
  assert.equal(await nowFrames(), want, `playhead parked on frame ${want}`);
  await page.waitForTimeout(420);
};

try {
  // Two visually distinct sources with real detail: a smear is then measurable, and a missing
  // surround shows up as black rather than as more of the same picture.
  const a = join(temp, 'Shot A.mp4'), b = join(temp, 'Shot B.mp4');
  await ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=8', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p', a);
  await ffmpeg('-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=24:duration=8', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p', b);

  await mkdir(join(temp, 'data', 'transitions'), { recursive: true });
  await cp(a, join(temp, 'data', 'transitions', 'qa-leak.mp4'));
  await writeFile(join(temp, 'data', 'transitions', 'manifest.json'), JSON.stringify({ leaks: [{ id: 'qa-leak', name: 'QA leak', file: 'qa-leak.mp4', duration: 8, fps: 24, hasAudio: false, peakAt: .5 }] }));

  await page.goto(url);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Transition QA');
  await page.getByRole('textbox', { name: 'Email address' }).fill('transitions@example.test');
  await page.locator('input[type=password]').fill('Transition-test-password-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Transition checks');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Upload media files').setInputFiles([a, b]);
  await page.waitForFunction(() => document.querySelectorAll('.media-state-icon.ready').length === 2, {}, { timeout: 120000 });
  await saved();
  fps = (await fetchState()).state.projects[0].fps;

  // Two shots meeting at 3s, each trimmed so both sides still have handles to lend.
  const cut = 3, shots = [];
  await write(state => {
    const timeline = state.timelines.find(t => t.projectId === state.projects[0].id);
    const track = state.tracks.find(t => t.timelineId === timeline.id && t.kind === 'video');
    const assets = state.media.filter(m => m.kind === 'video').sort((x, y) => x.name.localeCompare(y.name));
    const base = { projectId: timeline.projectId, timelineId: timeline.id, trackId: track.id, color: '#7aa6b8', disabled: false, effects: [], properties: {} };
    shots.push(
      { ...base, id: 'shot-a', name: 'Shot A', mediaId: assets[0].id, start: 0, duration: cut, sourceIn: 1 },
      { ...base, id: 'shot-b', name: 'Shot B', mediaId: assets[1].id, start: cut, duration: 3, sourceIn: 2 },
    );
    state.clips = shots.map(clip => ({ ...clip }));
  });
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(200);
  console.log(`   built a cut at ${cut}s: Shot A [0,3) sourceIn 1 · Shot B [3,6) sourceIn 2 at ${fps}fps`);

  const readTransitions = async () => {
    const { state } = await fetchState();
    return timelineTransitions(state.clips, state.clips[0].timelineId, state.media);
  };
  const setTransition = (name, properties = {}) => write(state => {
    const clip = state.clips.find(c => c.id === 'shot-b');
    clip.transition = name;
    clip.properties = name ? { transitionDuration: 1, ...properties } : {};
    if (!name) delete clip.transition;
  });

  await setTransition('Light leak', { transitionParams: JSON.stringify({ leak: 'qa-leak' }) });
  await page.locator('.transition-chip').first().click();
  assert.equal(await page.locator('.timeline-clip.selected').count(), 0);
  for (const [label, value] of [['Duration (retime)', '.5'], ['Source start', '.25'], ['Source end', '1'], ['Peak position', '40'], ['Overlay zoom', '110']]) {
    const input = page.getByRole('textbox', { name: label, exact: true });
    await input.fill(value);
    await input.press('Enter');
    await saved();
  }
  const edited = (await fetchState()).state.clips.find(clip => clip.id === 'shot-b');
  assert.ok(Math.abs(edited.properties.transitionDuration - .5 * .75 / 8) < 1e-6, 'Source trims shorten the window at the existing playback rate.');
  const editedParams = JSON.parse(edited.properties.transitionParams);
  assert.equal(editedParams.leakIn, .25); assert.equal(editedParams.leakOut, 1);
  assert.equal(editedParams.blendPoint, 40); assert.equal(editedParams.leakZoom, 110);
  await page.reload(); await page.locator('.transition-chip').first().click();
  assert.equal(Number(await page.getByRole('textbox', { name: 'Source start', exact: true }).inputValue()), .25);
  console.log('PASS transition-only selection exposes numeric controls; edits save and survive reload');
  await setTransition('Light leak', { transitionDuration: 2, transitionParams: JSON.stringify({ leak: 'qa-leak', leakIn: 1, leakOut: 5, blendPoint: 50 }) });
  const trimBox = await page.locator('.transition-chip').first().boundingBox();
  const edge = await page.locator('.transition-chip-edge.right').first().boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - trimBox.width / 8, edge.y + edge.height / 2, { steps: 8 });
  await page.mouse.up(); await saved();
  const edgeEdited = (await fetchState()).state.clips.find(clip => clip.id === 'shot-b');
  const edgeParams = JSON.parse(edgeEdited.properties.transitionParams);
  assert.ok(edgeParams.leakOut < 5, 'Dragging the right edge removes source frames.');
  assert.equal(edgeParams.leakIn, 1);
  assert.ok(Math.abs((edgeParams.leakOut - edgeParams.leakIn) / edgeEdited.properties.transitionDuration - 2) < 1e-6, 'Edge trimming preserves playback rate.');
  console.log('PASS dragging the overlay edge trims source frames without speeding up playback');
  await page.locator('.transition-chip').first().click();
  const presetSaved = page.waitForResponse(response => response.url().endsWith('/api/transitions/presets') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save to transition preset', exact: true }).click();
  assert.equal((await presetSaved).status(), 200);
  const library = await (await context.request.get(url + '/api/transitions')).json();
  const preset = library.presets.find(item => item.id === 'overlay:qa-leak');
  assert.equal(preset.duration, edgeEdited.properties.transitionDuration);
  assert.equal(preset.params.leakOut, edgeParams.leakOut);
  assert.deepEqual((await fetchState()).state.clips.find(clip => clip.id === 'shot-b').properties, edgeEdited.properties, 'Saving a preset leaves the timeline instance untouched.');
  assert.equal((await context.request.patch(url + '/api/projects/' + edgeEdited.projectId, { data: { access: 'private' } })).status(), 200);
  const other = await browser.newContext();
  await other.request.post(url + '/api/auth/signup', { data: { name: 'Other editor', email: 'other-transition@example.test', password: 'Transition-test-password-2026' } });
  assert.deepEqual((await (await other.request.get(url + '/api/transitions')).json()).presets, library.presets, 'Another account receives shared presets.');
  assert.equal((await other.request.put(url + '/api/transitions/presets', { data: { clipId: 'shot-b', side: 'in' } })).status(), 404, 'An unrelated account cannot save a private timeline preset.');
  await page.getByRole('tab', { name: 'Transitions', exact: true }).click();
  await page.getByRole('button', { name: 'Overlays', exact: true }).click();
  const previewCard = page.locator('.transition-card').filter({ hasText: 'QA leak' });
  const previewBox = await previewCard.boundingBox();
  await page.evaluate(() => { window.overlayDraws = []; });
  for (const fraction of [.001, .25, .5, .999]) {
    await page.mouse.move(previewBox.x + previewBox.width * fraction, previewBox.y + 25);
    const expected = preset.params.leakIn + fraction * (preset.params.leakOut - 1 / 24 - preset.params.leakIn);
    await page.waitForFunction(expected => window.overlayDraws.length && Math.abs(window.overlayDraws.at(-1).time - expected) < 1 / 24, expected);
  }
  const previewDraws = await page.evaluate(() => window.overlayDraws);
  assert.ok(previewDraws.length > 0);
  assert.ok(previewDraws.every(frame => !frame.seeking && frame.time >= preset.params.leakIn && frame.time < preset.params.leakOut), 'Library scrub never paints outside the saved source trim or during a pending seek.');
  console.log('PASS overlay library scrubs only the saved source range with frame-level precision');
  await page.getByRole('button', { name: 'Favorite QA leak', exact: true }).click();
  await page.getByRole('button', { name: 'Unfavorite QA leak', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  assert.equal(await page.locator('.transition-card').count(), 1);
  assert.deepEqual((await (await other.request.get(url + '/api/transitions')).json()).favorites, [], 'Favorites are personal.');
  await page.reload(); await page.getByRole('tab', { name: 'Transitions', exact: true }).click();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await page.getByRole('button', { name: 'Unfavorite QA leak', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Unfavorite QA leak', exact: true }).click();
  await page.getByText('No favorite transitions', { exact: true }).waitFor();
  await other.close();
  const cutMarker = await page.locator('.transition-chip-bowtie').first().boundingBox();
  await setTransition('');
  await page.getByRole('tab', { name: 'Transitions', exact: true }).click();
  await page.getByRole('button', { name: 'Overlays', exact: true }).click();
  const lane = page.locator('.timeline-track.video .track-lane').first(), laneBox = await lane.boundingBox();
  await page.locator('.transition-card').filter({ hasText: 'QA leak' }).dragTo(lane, { targetPosition: { x: cutMarker.x - laneBox.x, y: laneBox.height / 2 } });
  await saved();
  const reapplied = (await fetchState()).state.clips.find(clip => clip.id === 'shot-b');
  assert.equal(reapplied.transition, 'Light leak');
  assert.equal(reapplied.properties.transitionDuration, preset.duration);
  assert.deepEqual(JSON.parse(reapplied.properties.transitionParams), preset.params, 'Dragging the saved leak inherits its trims and settings.');
  console.log('PASS shared preset save, account permissions, personal favorites and reload persistence');



  // ---- 1. Playback through the window never seeks a decoder backwards ------------------------
  // Both a plain dissolve and a motion transition, because the blurred one is also the expensive
  // one: if the sampler could not hold frame rate it would stutter for a second, different reason.
  for (const name of ['Cross dissolve', 'Push left']) {
    await setTransition(name, { transitionDuration: 1 });
    const records = await readTransitions();
    assert.equal(records.length, 1, `one ${name} on the timeline`);
    assert.ok(Math.abs(records[0].duration - 1) < .01, `the window is a full second (${records[0].duration})`);
    await scrubTo(2.1);
    await painted();
    await page.locator('.viewer-frame').click();
    await page.keyboard.press('Space');
    // The decoders are detached elements, so the canvas is the honest witness: it stamps the clip
    // it last drew and the exact source frame that came off that decoder.
    const trace = await page.evaluate(async () => {
      const canvas = document.querySelector('.viewer-frame canvas');
      const samples = [];
      const started = performance.now();
      while (performance.now() - started < 2200) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        samples.push({ clip: canvas.dataset.sourceClip ?? '', time: Number(canvas.dataset.sourceTimestamp ?? NaN), at: performance.now() });
      }
      return { samples, span: performance.now() - started };
    });
    await page.keyboard.press('Space');
    const byClip = new Map();
    for (const sample of trace.samples) {
      if (!sample.clip || !Number.isFinite(sample.time)) continue;
      if (!byClip.has(sample.clip)) byClip.set(sample.clip, []);
      byClip.get(sample.clip).push(sample.time);
    }
    let regressions = 0, worst = 0;
    for (const [clip, times] of byClip) {
      for (let i = 1; i < times.length; i++) {
        const delta = times[i] - times[i - 1];
        // A decoder playing forward only ever advances. A backward step is the sync fighting
        // playback, which is exactly what made both shots jitter through every transition.
        if (delta < -1.5 / fps) { regressions++; worst = Math.min(worst, delta); }
      }
      console.log(`   ${name} · ${clip}: ${times.length} painted frames, ${new Set(times).size} distinct source frames, ${times[0].toFixed(3)}s -> ${times[times.length - 1].toFixed(3)}s`);
    }
    const painting = trace.samples.filter(sample => sample.clip).length / (trace.span / 1000);
    console.log(`   ${name}: ${painting.toFixed(0)} painted frames per second`);
    assert.ok(byClip.size >= 1, 'the canvas reported a source clip while playing');
    console.log(`   ${name}: ${regressions} backward steps (worst ${worst.toFixed(3)}s)`);
    assert.equal(regressions, 0, `${name}: no decoder steps backwards during the window (worst ${worst.toFixed(3)}s)`);
    assert.ok(painting > fps * .8, `${name}: the composite keeps pace with the timeline (${painting.toFixed(0)} of ${fps} fps)`);
  }
  console.log('PASS playback through a transition never seeks backwards and keeps pace');

  // ---- 2. Zoom out fills its surround instead of showing black borders ----------------------
  await setTransition('Zoom out', { transitionDuration: 1.2, transitionParams: JSON.stringify({ amount: 90, shutterAngle: 0 }) });
  // Mid-window is where both shots are pulled back furthest and the surround has to carry the
  // whole border; at either end the shot that is on screen is back at full size and reveals nothing.
  const zoomRecord = (await readTransitions())[0];
  await scrubTo(zoomRecord.start + (zoomRecord.end - zoomRecord.start) * .5);
  await painted();
  const zoomed = await pixels();
  await page.locator('.viewer-frame canvas').screenshot({ path: join(out, 'transition-zoom-out.png') });
  const darkest = Math.min(...Object.values(zoomed.strips));
  console.log(`   zoom-out deep in the window: edge strips L ${zoomed.strips.left.toFixed(1)} R ${zoomed.strips.right.toFixed(1)} T ${zoomed.strips.top.toFixed(1)} B ${zoomed.strips.bottom.toFixed(1)} · frame mean ${zoomed.mean.toFixed(0)}`);
  assert.ok(darkest > 10, `the mirrored surround fills every edge of a deep zoom out (darkest strip ${darkest.toFixed(1)})`);
  console.log('PASS zoom out reveals a mirrored surround with no black border');

  // ---- 3. Motion blur actually smears at the fastest moment --------------------------------
  // A push at the peak of its ease is the discriminating case: fast enough that the samples sit
  // pixels apart, slow enough that sizing the shutter from the average silently under-samples it.
  const blurAt = async angle => {
    await setTransition('Push left', { transitionDuration: 1, transitionParams: JSON.stringify({ shutterAngle: angle }) });
    const [record] = await readTransitions();
    await scrubTo(record.start + (record.end - record.start) * .3);
    await painted();
    // The element screenshot is the CSS-sized canvas; write the backing store too, because that is
    // the resolution the export renders at and the resolution the measurements read.
    const native = await page.locator('.viewer-frame canvas').evaluate(canvas => canvas.toDataURL('image/png'));
    await writeFile(join(out, `transition-blur-${angle}.png`), Buffer.from(native.split(',')[1], 'base64'));
    return await pixels();
  };
  const sharp = await blurAt(0), blurred = await blurAt(180), wide = await blurAt(360);
  const reduction = 1 - blurred.energy / sharp.energy;
  console.log(`   push edge energy at the peak of the ease (${await page.locator('.viewer-frame canvas').evaluate(c => `${c.width}x${c.height}`)}): shutter 0 ${sharp.energy.toFixed(3)} · 180 ${blurred.energy.toFixed(3)} · 360 ${wide.energy.toFixed(3)}`);
  console.log(`   direction reversals per row (a smear ramps, a ghost stack ripples): shutter 0 ${sharp.ripples.toFixed(1)} · 180 ${blurred.ripples.toFixed(1)} · 360 ${wide.ripples.toFixed(1)}`);
  assert.ok(reduction > .4, `a 180 degree shutter visibly smears the fastest moment (${(reduction * 100).toFixed(0)}% less edge energy)`);
  assert.ok(blurred.ripples <= sharp.ripples, `the smear reads as one ramp, not a stack of ghosts (${blurred.ripples.toFixed(1)} reversals per row vs ${sharp.ripples.toFixed(1)} unblurred)`);
  assert.ok(wide.ripples <= sharp.ripples, 'a wider shutter stays smooth too');
  await page.screenshot({ path: join(out, 'transition-motion-blur.png') });
  console.log(`PASS motion blur smears at the peak of the move (${(reduction * 100).toFixed(0)}% edge energy removed)`);

  // ---- 4. A cut with handles on one side only still takes a transition ----------------------
  await setTransition('');
  await write(state => {
    // Run the outgoing clip to the final frame of its media: no tail left to lend.
    const clip = state.clips.find(c => c.id === 'shot-a');
    const asset = state.media.find(m => m.id === clip.mediaId);
    clip.sourceIn = Math.max(0, asset.duration - clip.duration);
  });
  const { state: oneSided } = await fetchState();
  const incoming = oneSided.clips.find(c => c.id === 'shot-b');
  const room = Object.fromEntries(['center', 'in', 'out'].map(align => [align, maximumDuration(oneSided.clips, incoming, 'in', align, oneSided.media)]));
  const pick = bestAlign(oneSided.clips, incoming, 'in', oneSided.media, 1);
  console.log(`   one-sided cut: centred ${room.center.toFixed(2)}s · before the cut ${room.out.toFixed(2)}s · after it ${room.in.toFixed(2)}s -> picks "${pick}"`);
  assert.equal(room.center, 0, 'centred still needs frames from both sides');
  assert.ok(room.out > 1, 'the incoming head can carry a window sitting before the cut');
  await setTransition('Cross dissolve', { transitionDuration: 1, transitionAlign: pick });
  const records = await readTransitions();
  assert.equal(records.length, 1, 'the transition was accepted');
  assert.ok(records[0].duration > .9, `it got a usable length from the side that has frames (${records[0].duration.toFixed(2)}s, aligned ${records[0].align})`);
  await page.locator('.transition-chip').first().waitFor();
  console.log(`PASS a one-sided cut carries a ${records[0].duration.toFixed(2)}s transition aligned "${records[0].align}"`);

  // ---- 5. Selecting a transition highlights only the transition -----------------------------
  await page.locator('.transition-chip').first().click();
  await page.waitForTimeout(200);
  const selection = await page.evaluate(() => ({
    chips: document.querySelectorAll('.transition-chip.selected').length,
    clips: document.querySelectorAll('.timeline-clip.selected').length,
    inspector: document.querySelector('.inspector-tabs .active')?.textContent ?? '',
    subject: document.querySelector('.inspector-clip b')?.textContent ?? '',
  }));
  console.log(`   after clicking the chip: ${selection.chips} chip highlighted, ${selection.clips} clips highlighted, inspector on "${selection.inspector}"`);
  assert.equal(selection.chips, 1, 'the chip is highlighted');
  assert.equal(selection.clips, 0, 'no clip is highlighted alongside it');
  assert.equal(selection.inspector, 'Transition', 'the inspector still opens on the transition');
  await page.screenshot({ path: join(out, 'transition-selection.png') });
  console.log('PASS selecting a transition highlights the chip alone; the inspector still follows it');

  // ---- 6. The chip passes behind the sticky track-name column -------------------------------
  const stacking = await page.evaluate(() => {
    const chip = document.querySelector('.transition-chip');
    const label = document.querySelector('.timeline-track.video .track-label');
    const lane = chip.closest('.track-lane');
    let scroller = lane.parentElement;
    while (scroller && scroller.scrollWidth <= scroller.clientWidth) scroller = scroller.parentElement;
    const labelBox = label.getBoundingClientRect();
    if (scroller) scroller.scrollLeft += chip.getBoundingClientRect().left - labelBox.left + chip.getBoundingClientRect().width / 2;
    const chipBox = chip.getBoundingClientRect();
    const overlapping = chipBox.left < labelBox.right && chipBox.right > labelBox.left;
    const top = overlapping ? document.elementFromPoint(Math.max(labelBox.left + 2, Math.min(chipBox.left + chipBox.width / 2, labelBox.right - 2)), chipBox.top + chipBox.height / 2) : null;
    return {
      overlapping, chipZ: getComputedStyle(chip).zIndex, labelZ: getComputedStyle(label).zIndex,
      topmost: top ? (top.closest('.track-label') ? '.track-label' : `.${String(top.className).split(' ')[0]}`) : 'not overlapping',
    };
  });
  console.log(`   chip z-index ${stacking.chipZ} vs track label ${stacking.labelZ}; where they overlap the topmost element is ${stacking.topmost}`);
  assert.ok(Number(stacking.chipZ) < Number(stacking.labelZ), `the chip sits below the sticky track-name column (${stacking.chipZ} < ${stacking.labelZ})`);
  if (stacking.overlapping) assert.equal(stacking.topmost, '.track-label', 'the column paints over the chip where they overlap');
  await page.screenshot({ path: join(out, 'transition-stacking.png') });
  console.log('PASS the transition chip passes behind the track-name column');

  // ---- 7. Every transition that touches the rewritten draw paths still renders ---------------
  // Give the outgoing clip its tail back: the one-sided cut above collapses every window to a
  // single frame, which would sweep nothing.
  await write(state => { state.clips.find(c => c.id === 'shot-a').sourceIn = 1; });
  // Every definition, at a quarter through the window — halfway is a solid colour for the dips by
  // design, and a blank frame is how a draw that throws or clears the wrong buffer shows up.
  const sweep = Object.keys(transitionDefinitions).filter(name => !transitionDefinitions[name].overlay);
  const blank = [];
  for (const name of sweep) {
    await setTransition(name, { transitionDuration: 1 });
    const [record] = await readTransitions();
    await scrubTo(record.start + (record.end - record.start) * .25);
    await painted().catch(() => {});
    const frame = await pixels();
    if (frame.mean < 3 || frame.energy < .002) blank.push(`${name} (mean ${frame.mean.toFixed(1)}, energy ${frame.energy.toFixed(3)})`);
  }
  assert.deepEqual(blank, [], 'every transition paints a real frame inside its window');
  console.log(`PASS all ${sweep.length} transitions paint a real frame inside the window`);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nPASS transition playback, mirrored surround, motion blur, one-sided handles, selection and stacking');
} finally {
  await browser.close();
  app.server.close();
  app.close?.();
  await rm(temp, { recursive: true, force: true });
}
