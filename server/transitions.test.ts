import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { getMediaCapabilities, renderTimeline } from './media.ts';
import type { RenderRequest } from './media.ts';
import { transitionLibrary } from './transitions.ts';
import { validateTransition, transitionDefinitions, timelineTransitions, maximumDuration, availableHandle, bestAlign } from '../src/services/transitions.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';
import { primaryDefaults } from '../src/services/color.ts';

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ff = (args: string[]) => exec(ffmpeg, ['-v', 'error', '-y', '-threads', '2', '-filter_complex_threads', '1', ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });

test('transition validation rejects anything a save should not carry', () => {
  assert.doesNotThrow(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionDuration: 1, transitionAlign: 'center', transitionCurve: '0.4,0,0.2,1' } }));
  assert.doesNotThrow(() => validateTransition({ transition: undefined, properties: {} }));
  assert.throws(() => validateTransition({ transition: 'Rm -rf', properties: {} }), /Unknown transition/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionDuration: 0 } }), /duration/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionDuration: 99 } }), /duration/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionDuration: Number.NaN } }), /duration/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionAlign: 'sideways' } }), /alignment/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionCurve: '5,0,0.2,1' } }), /curve/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionParams: '{oops' } }), /parameters/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionParams: '{"__proto__":1}' } }), /parameter name/);
  assert.throws(() => validateTransition({ transition: 'Cross dissolve', properties: { transitionParams: JSON.stringify({ a: { nested: true } }) } }), /parameter value/);
  assert.throws(() => validateTransition({ properties: { transitionOut: 'Nope' } } as never), /Unknown transition/);
  // Every shipped transition must survive its own defaults, or the library offers a broken card.
  for (const [name, definition] of Object.entries(transitionDefinitions)) {
    const params = Object.fromEntries(definition.parameters.map(parameter => [parameter.key, parameter.initial]));
    assert.doesNotThrow(() => validateTransition({ transition: name, properties: { transitionParams: JSON.stringify(params) } }), name);
  }
});

const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'source.mp4', kind: 'video', binId: 'all', duration: 6, fps: 24, resolution: '320 × 180', size: '10 KB', status: 'ready', progress: 100, thumbnail: '', hasAudio: true };
const clip = (id: string, start: number, duration: number, sourceIn: number): Clip =>
  ({ id, projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: id, trackId: 'base', start, duration, sourceIn, color: 'red', disabled: false, properties: { ...defaultProperties }, effects: [] });

test('a transition borrows trim handles and never moves a clip', () => {
  const a = clip('a', 0, 2, 1), b = clip('b', 2, 2, 3);
  // a: sourceIn 1, ends at source 3 of 6 -> 3s of tail handle. b: sourceIn 3 -> 3s of head handle.
  assert.equal(availableHandle(a, 'out', asset), 3);
  assert.equal(availableHandle(b, 'in', asset), 3);
  const withTransition = { ...b, transition: 'Cross dissolve', properties: { ...b.properties, transitionDuration: 1 } };
  const records = timelineTransitions([a, withTransition], 'timeline', [asset]);
  assert.equal(records.length, 1);
  assert.equal(records[0].cut, 2);
  assert.equal(records[0].start, 1.5, 'A centred window straddles the cut.');
  assert.equal(records[0].end, 2.5);
  assert.equal(records[0].outgoingId, 'a');
  assert.equal(records[0].incomingId, 'b');
  // The clips themselves are untouched: the window is served entirely from unused handles.
  assert.equal(withTransition.start, 2);
  assert.equal(a.start + a.duration, 2);

  // A clip trimmed hard against the start of its media has no head handle to lend — and the head is
  // what a window sitting *before* the cut comes out of, since that is where the incoming shot has
  // to appear early. The outgoing clip's tail pays for the half *after* the cut.
  const tight = { ...clip('t', 2, 2, 0), transition: 'Cross dissolve', properties: { ...b.properties, transitionDuration: 1 } };
  assert.equal(availableHandle(tight, 'in', asset), 0);
  assert.equal(maximumDuration([a, tight], tight, 'in', 'center', [asset]), 0);
  assert.equal(maximumDuration([a, tight], tight, 'in', 'out', [asset]), 0, 'Sitting before the cut asks the incoming clip for a head it has not got.');
  // The outgoing clip still has three seconds of tail, so a window entirely after the cut fits.
  assert.equal(maximumDuration([a, tight], tight, 'in', 'in', [asset]), 2);
  assert.equal(bestAlign([a, tight], tight, 'in', [asset]), 'in', 'A transition added here lands where the frames actually are.');
  const clamped = timelineTransitions([a, tight], 'timeline', [asset]);
  assert.ok(clamped[0].duration <= 1 / 100, 'A window with no handles collapses rather than reading past the media.');
  assert.equal(clamped[0].requested, 1, 'The stored duration is kept so restoring the handles restores the transition.');
});

test('a tail transition needs an empty tail, and a shared cut belongs to the incoming clip', () => {
  const a = { ...clip('a', 0, 2, 1), properties: { ...defaultProperties, transitionOut: 'Dip to black', transitionOutDuration: 1 } };
  const b = clip('b', 2, 2, 3);
  assert.equal(timelineTransitions([a, b], 'timeline', [asset]).length, 0, 'A followed clip has no tail to fade into.');
  assert.equal(timelineTransitions([a], 'timeline', [asset]).length, 1);
  const [record] = timelineTransitions([a], 'timeline', [asset]);
  assert.equal(record.side, 'out');
  assert.equal(record.outgoingId, 'a');
  assert.equal(record.incomingId, undefined, 'A tail transition fades into nothing.');
});

test('the overlay library refuses paths outside its own directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-overlays-'));
  try {
    const library = transitionLibrary(dir);
    assert.deepEqual(library.list(), []);
    assert.equal(library.path('../../etc/passwd'), null);
    assert.equal(library.path('..'), null);
    assert.equal(library.path('missing'), null);
    assert.equal(library.remove('nothing'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('transitions render real blended frames through FFmpeg', { timeout: 300000 }, async () => {
  assert.equal((await getMediaCapabilities()).available, true, 'Install FFmpeg and FFprobe before running integration checks.');
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-transitions-'));
  try {
    // Two flat, saturated sources make a blend unambiguous: anything between the two is the work.
    const red = path.join(dir, 'red.mp4'), blue = path.join(dir, 'blue.mp4'), leak = path.join(dir, 'leak.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
    await ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
    // A green burst with a tone, standing in for one of the cut light leaks.
    await ff(['-f', 'lavfi', '-i', 'color=c=0x006000:s=320x180:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', leak]);

    const project = { id: 'project', resolution: '320 × 180', fps: 24 } as Project;
    const track: Track = { id: 'base', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
    const assets = [
      { asset: { ...asset, id: 'red', name: 'red.mp4', hasAudio: false }, path: red },
      { asset: { ...asset, id: 'blue', name: 'blue.mp4', hasAudio: false }, path: blue },
    ];
    const outputPath = path.join(dir, 'output.mp4');
    const base = (transition: string, extra: Record<string, unknown> = {}): RenderRequest => ({
      project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 4 }, tracks: [track],
      clips: [
        { ...clip('a', 0, 2, 1), mediaId: 'red' },
        { ...clip('b', 2, 2, 2), mediaId: 'blue', transition, properties: { ...defaultProperties, transitionDuration: 1, transitionAlign: 'center', ...extra } },
      ],
      nodes: [], assets, outputPath,
      settings: { resolution: '320 × 180', fps: '24', codec: 'H.264', rangeIn: '0', rangeOut: '4', audio: 'Disabled' },
      overlayPath: () => leak,
    });
    const pixel = async (seconds: number) => [...(await ff(['-ss', String(seconds), '-i', outputPath, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])).stdout];

    await renderTimeline(base('Cross dissolve'));
    const before = await pixel(1.2), middle = await pixel(2), after = await pixel(2.9);
    assert.ok(before[0] > 200 && before[2] < 40, `Outside the window the outgoing clip is untouched, saw ${before}`);
    assert.ok(after[2] > 200 && after[0] < 40, `Outside the window the incoming clip is untouched, saw ${after}`);
    assert.ok(middle[0] > 40 && middle[2] > 40, `Mid-dissolve must contain both shots, saw ${middle}`);
    assert.ok(Math.abs(middle[0] - before[0]) > 40 && Math.abs(middle[2] - after[2]) > 40, 'A dissolve is not a hard cut.');

    const across = async (from: number, to: number, steps = 7) => Promise.all(Array.from({ length: steps }, (_, i) => pixel(from + (to - from) * i / (steps - 1))));
    await renderTimeline(base('Dip to black'));
    const dip = await across(1.6, 2.4);
    assert.ok(dip.some(frame => frame.every(channel => channel < 40)), `Dip to black must reach black inside the window, saw ${JSON.stringify(dip)}`);
    assert.ok((await pixel(1.2))[0] > 200, 'A dip leaves the rest of the clip alone.');

    await renderTimeline(base('Dip to white'));
    const flash = await across(1.6, 2.4);
    assert.ok(flash.some(frame => frame.every(channel => channel > 200)), `Dip to white must reach white inside the window, saw ${JSON.stringify(flash)}`);

    // Motion transitions bake their shutter with tmix, which is the slowest path in the graph.
    await renderTimeline(base('Push left', { transitionParams: JSON.stringify({ shutterAngle: 180 }) }));
    const pushed = await pixel(2);
    assert.ok(pushed[0] > 20 || pushed[2] > 20, `A push must still show picture mid-window, saw ${pushed}`);
    assert.ok((await pixel(1.2))[0] > 200 && (await pixel(2.9))[2] > 200, 'A push leaves both clips intact outside the window.');

    await renderTimeline(base('Zoom out', { transitionParams: JSON.stringify({ amount: 60, shutterAngle: 90 }) }));
    assert.ok((await pixel(1.2))[0] > 200, 'Zoom out leaves the outgoing clip intact before its window.');
    const zoomed = await pixel(2);
    assert.ok(zoomed.some(channel => channel > 20), `Mirror padding must keep the frame filled, saw ${zoomed}`);

    // A light leak screen-blends over the cut and carries its own sound into the mix.
    const withSound: RenderRequest = { ...base('Light leak', { transitionParams: JSON.stringify({ leak: 'demo', blend: 'Screen', leakGain: 0, leakOpacity: 100, blendPoint: 50 }) }), settings: { resolution: '320 × 180', fps: '24', codec: 'H.264', rangeIn: '0', rangeOut: '4', audio: 'AAC · 192 kb/s · 48 kHz' } };
    await renderTimeline(withSound);
    const leaked = await pixel(2);
    const plain = [0, 0, 255];
    assert.ok(leaked[1] > 40, `A screen-blended leak must lift the green channel, saw ${leaked}`);
    assert.ok(leaked[1] > plain[1] + 30, 'The leak is visibly brighter than the underlying cut.');
    const sound = (await ff(['-ss', '1.6', '-i', outputPath, '-t', '0.6', '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1'])).stdout;
    assert.ok(Array.from({ length: sound.length / 4 }, (_, i) => Math.abs(sound.readFloatLE(i * 4))).some(value => value > .02), 'The leak must bring its own sound into the export.');

    for (const blendPoint of [17, 75]) {
      const request = base('Light leak', { transitionParams: JSON.stringify({ leak: 'demo', blendPoint, leakOpacity: 0 }) });
      await renderTimeline(request);
      const beforeCut = await pixel(2 - 1 / 24), atCut = await pixel(2);
      assert.ok(beforeCut[0] > 200 && beforeCut[2] < 40, `Peak ${blendPoint}: outgoing shot lasts until the cut, saw ${beforeCut}`);
      assert.ok(atCut[2] > 200 && atCut[0] < 40, `Peak ${blendPoint}: incoming shot starts at the cut, saw ${atCut}`);
      await renderTimeline({ ...request, settings: { ...request.settings, rangeIn: '1.875', rangeOut: '2.25' } });
      assert.ok((await pixel(0))[0] > 200 && (await pixel(.125))[2] > 200, 'A partial export retains the same edit point.');
    }

    const bursts = path.join(dir, 'bursts.mp4');
    await ff(['-f', 'lavfi', '-i', "color=c=red:s=320x100:r=24:d=1[a];color=c=lime:s=320x100:r=24:d=1[b];color=c=blue:s=320x100:r=24:d=1[c];[a][b][c]concat=n=3:v=1:a=0", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bursts]);
    const trimmed = base('Light leak', { transitionParams: JSON.stringify({ leak: 'demo', leakIn: 1, leakOut: 2 }) });
    await renderTimeline({ ...trimmed, overlayPath: () => bursts });
    for (const time of [1.6, 2.4]) {
      const corner = (await ff(['-ss', String(time), '-i', outputPath, '-frames:v', '1', '-vf', 'crop=2:2:0:0,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])).stdout;
      assert.ok(corner[1] > 100, `Only the selected green burst fills the frame corner at ${time}s, saw ${[...corner]}`);
    }

    // Expanding the sound to a track must not leave the embedded copy playing underneath it.
    // The pointer only counts while that clip exists, so the check needs a real one on a real track.
    const soundTrack: Track = { ...track, id: 'a1', number: 1, kind: 'audio', name: 'A1' };
    const expanded: Clip = { ...clip('sound', 1.5, 1, 0), id: 'sound', trackId: 'a1', mediaId: 'frameline-leak:demo', properties: { ...defaultProperties, gain: -60 } };
    await renderTimeline({
      ...withSound, tracks: [track, soundTrack],
      clips: [...withSound.clips.map(item => item.id === 'b' ? { ...item, properties: { ...item.properties, transitionAudioId: 'sound' } } : item), expanded],
    });
    const silent = (await ff(['-ss', '1.6', '-i', outputPath, '-t', '0.6', '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1'])).stdout;
    assert.ok(Array.from({ length: silent.length / 4 }, (_, i) => Math.abs(silent.readFloatLE(i * 4))).every(value => value < .01), 'An expanded leak sound must not also play from the transition.');

    // A dangling pointer is stale, not a mute: deleting the clip brings the embedded sound back.
    await renderTimeline({ ...withSound, clips: withSound.clips.map(item => item.id === 'b' ? { ...item, properties: { ...item.properties, transitionAudioId: 'deleted-clip' } } : item) });
    const restored = (await ff(['-ss', '1.6', '-i', outputPath, '-t', '0.6', '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1'])).stdout;
    assert.ok(Array.from({ length: restored.length / 4 }, (_, i) => Math.abs(restored.readFloatLE(i * 4))).some(value => value > .02), 'A transition whose expanded clip was deleted plays its own sound again.');

    // A transition at the tail fades into nothing rather than needing a second clip.
    await renderTimeline({
      ...base('Cross dissolve'),
      clips: [{ ...clip('a', 0, 2, 1), mediaId: 'red', properties: { ...defaultProperties, transitionOut: 'Dip to black', transitionOutDuration: 1, transitionOutAlign: 'out' } }],
    });
    assert.ok((await pixel(1.9)).every(channel => channel < 90), 'A tail transition must fade the last clip out.');
    assert.ok((await pixel(0.5))[0] > 200, 'The fade only covers its own window.');

    // Two clips dropped in whole have no handles anywhere, so the only window the cut can carry is
    // one the outgoing clip holds its last frame through. It has to export, not fail on media bounds.
    await renderTimeline({
      ...base('Cross dissolve'),
      timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 12 },
      clips: [
        { ...clip('a', 0, 6, 0), mediaId: 'red' },
        { ...clip('b', 6, 6, 0), mediaId: 'blue', transition: 'Cross dissolve', properties: { ...defaultProperties, transitionDuration: 1, transitionAlign: 'in' } },
      ],
      settings: { resolution: '320 × 180', fps: '24', codec: 'H.264', rangeIn: '5', rangeOut: '8', audio: 'Disabled' },
    });
    const heldBefore = await pixel(.5), heldMid = await pixel(1.5), heldAfter = await pixel(2.5);
    assert.ok(heldBefore[0] > 200 && heldBefore[2] < 40, `A held window leaves the outgoing clip alone before the cut, saw ${heldBefore}`);
    assert.ok(heldMid[0] > 40 && heldMid[2] > 40, `A cut with no handles still blends, holding the outgoing frame, saw ${heldMid}`);
    assert.ok(heldAfter[2] > 200 && heldAfter[0] < 40, `The incoming clip runs on unslipped after the window, saw ${heldAfter}`);

    await assert.rejects(renderTimeline({ ...base('Cross dissolve'), clips: base('Cross dissolve').clips.map(item => item.id === 'b' ? { ...item, transition: 'Teleport' } : item) }), /not available/);
    await assert.rejects(renderTimeline({ ...base('Light leak'), overlayPath: () => null }), /choose a light leak/i);
    // Keyframe animation bakes the timeline flat, so each window is pre-rendered and spliced back.
    // The realistic case is an animated overlay elsewhere on the timeline, not on the cut itself.
    const overlayTrack: Track = { ...track, id: 'v2', number: 2, name: 'V2' };
    const animatedOverlay: Clip = { ...clip('overlay', 0, 4, 0), id: 'overlay', trackId: 'v2', mediaId: 'red',
      properties: { ...defaultProperties, opacity: 0, zoom: 20 },
      keyframes: { 'properties.opacity': [{ id: 'k1', time: 0, value: 0, interpolation: 'linear' as const }, { id: 'k2', time: 4, value: 0, interpolation: 'linear' as const }] } };
    await renderTimeline({ ...base('Cross dissolve'), tracks: [track, overlayTrack], clips: [...base('Cross dissolve').clips, animatedOverlay] });
    const animatedMid = await pixel(2), animatedBefore = await pixel(1.2), animatedAfter = await pixel(2.9);
    assert.ok(animatedBefore[0] > 180 && animatedAfter[2] > 180, `An animated timeline keeps both shots outside the window, saw ${animatedBefore} / ${animatedAfter}`);
    assert.ok(animatedMid[0] > 40 && animatedMid[2] > 40, `A transition survives a keyframed timeline, saw ${animatedMid}`);

    // Motion blur has to smear the *combined* frame. A push is positioned by xfade, so averaging
    // the two sides beforehand averaged frames that never moved and produced no blur at all.
    const sharpness = async () => {
      // Mean absolute horizontal neighbour difference: high on hard edges, low once smeared.
      // Measured at native size: downscaling averages away the very detail the smear removes.
      const raw = (await ff(['-ss', '2', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])).stdout;
      let total = 0, count = 0;
      for (let row = 0; row < 180; row++) for (let column = 1; column < 320; column++) { total += Math.abs(raw[row * 320 + column] - raw[row * 320 + column - 1]); count++; }
      return total / count;
    };
    // Flat colour has no edges to smear, so this pair needs structure.
    const barsA = path.join(dir, 'bars-a.mp4'), barsB = path.join(dir, 'bars-b.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', barsA]);
    await ff(['-f', 'lavfi', '-i', 'smptebars=s=320x180:r=24:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', barsB]);
    const push = (shutterAngle: number): RenderRequest => ({
      ...base('Whip pan', { transitionParams: JSON.stringify({ shutterAngle, direction: 'Left' }), transitionDuration: .35 }),
      assets: [{ asset: { ...asset, id: 'red', hasAudio: false }, path: barsA }, { asset: { ...asset, id: 'blue', hasAudio: false }, path: barsB }],
    });
    await renderTimeline(push(0));
    const closed = await sharpness();
    await renderTimeline(push(320));
    const open = await sharpness();
    assert.ok(closed > .5, `The shutter-closed frame needs real detail to smear, saw ${closed.toFixed(1)}.`);
    // Averaging the sides before the blend left this ratio at 1.0; a real smear lands near 0.7.
    assert.ok(open < closed * .8, `A wide shutter must visibly smear a whip pan, saw ${open.toFixed(1)} against ${closed.toFixed(1)} with the shutter closed.`);

    // A keyframed clip on the cut itself is refused by name rather than exported as a hard cut.
    await assert.rejects(renderTimeline({
      ...base('Cross dissolve'),
      clips: base('Cross dissolve').clips.map(item => item.id === 'a'
        ? { ...item, keyframes: { 'properties.opacity': [{ id: 'k1', time: 0, value: 100, interpolation: 'linear' as const }, { id: 'k2', time: 1.5, value: 50, interpolation: 'linear' as const }] } }
        : item),
    }), /keyframed clip/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the shared overlay pack is named and timed for use', async () => {
  const dir = path.join(process.env.FRAME_LINE_DATA ?? 'data', 'transitions');
  const manifest = await readFile(path.join(dir, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (!manifest) { console.log('No overlay pack in this data directory; run scripts/extract-transitions.mjs.'); return; }
  const leaks = manifest.leaks as { id: string; name: string; duration: number; peakAt?: number; poster?: string }[];
  assert.ok(leaks.length > 0);
  for (const [index, leak] of leaks.entries()) {
    // Sequential, readable names rather than a slug of whichever reel the cut came from.
    assert.equal(leak.id, `leak-${String(index + 1).padStart(2, '0')}`, 'Overlay ids run in sequence.');
    assert.equal(leak.name, `Leak ${String(index + 1).padStart(2, '0')}`, 'Overlay names run in sequence.');
    assert.ok(leak.duration > .3 && leak.duration < 5, `${leak.id} is a transition-length burst, saw ${leak.duration}s.`);
    // The cut is placed at the brightest moment, so every leak has to carry one.
    assert.ok(typeof leak.peakAt === 'number' && leak.peakAt > 0 && leak.peakAt < 1, `${leak.id} needs a measured peak, saw ${leak.peakAt}.`);
    assert.equal(leak.poster, `${leak.id}.jpg`, 'Each overlay has its own card image.');
  }
  // Peaks must not all sit at the middle, or aligning the cut to them would be pointless.
  const spread = new Set(leaks.map(leak => Math.round(leak.peakAt! * 10))).size;
  assert.ok(spread >= 4, `Measured peaks should vary across the pack, saw ${spread} distinct tenths.`);
});

test('23.976 cuts keep every frame, a flash stays white, and a clip split by a window keeps its grade', { timeout: 300000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-frames-'));
  try {
    // NTSC timing is where float placement broke: a clip at frame 64 sits at 2.66933…s, and each edge
    // compared or truncated on float seconds dropped a frame to the black base.
    const fps = 24000 / 1001, red = path.join(dir, 'red.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24000/1001:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
    const project = { id: 'project', resolution: '320 × 180', fps } as Project;
    const track: Track = { id: 'base', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
    const at = (frame: number) => frame / fps;
    const graded = (id: string, from: number, to: number, source: number): Clip => ({ ...clip(id, at(from), at(to) - at(from), at(source)), mediaId: 'red', properties: { ...defaultProperties, colorPipeline: 'nodes-v2' } });
    const cuts = [graded('a', 0, 64, 10), graded('b', 64, 106, 80), graded('c', 106, 132, 130)];
    // Saturation 0 turns red grey, so an ungraded piece is unmistakable.
    const nodes = cuts.map(item => ({ id: `grade-${item.id}`, clipId: item.id, projectId: 'project', name: 'Balance', kind: 'serial', enabled: true, order: 1, position: { x: 0, y: 0 }, parameters: { ...primaryDefaults, saturation: 0 } })) as RenderRequest['nodes'];
    const outputPath = path.join(dir, 'frames.mp4');
    const request = (clips: Clip[]): RenderRequest => ({ project, timeline: { id: 'timeline', projectId: 'project', name: 'frames', duration: at(132) }, tracks: [track], clips, nodes,
      assets: [{ asset: { ...asset, id: 'red', duration: 8, fps, hasAudio: false }, path: red }], outputPath,
      settings: { resolution: '320 × 180', fps: String(fps), codec: 'H.264', rangeIn: '0', rangeOut: String(at(132)), audio: 'Disabled' } });
    const frames = async () => {
      const raw = (await ff(['-i', outputPath, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])).stdout;
      return Array.from({ length: raw.length / 3 }, (_, i) => [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]]);
    };

    await renderTimeline(request(cuts));
    let picture = await frames();
    assert.equal(picture.length, 132);
    assert.deepEqual(picture.flatMap((rgb, i) => rgb.every(channel => channel < 30) ? [i] : []), [], 'No frame at a cut falls through to black.');

    const flashed = cuts.map(item => item.id === 'b' ? { ...item, transition: 'Camera flash', properties: { ...item.properties, transitionDuration: .35, transitionAlign: 'center' } } : item);
    await renderTimeline(request(flashed));
    picture = await frames();
    assert.equal(picture.length, 132);
    assert.deepEqual(picture.flatMap((rgb, i) => rgb.every(channel => channel < 30) ? [i] : []), [], 'The window edges are whole frames.');
    // Screen on YUV planes lifted chroma and turned the flash pink; on grey input it has to stay grey.
    for (const [i, [r, g, b]] of picture.entries()) assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 24, `Frame ${i} is tinted ${r},${g},${b}`);

    // A keyframe anywhere pre-renders the windows and splices the cut clips back in pieces. Grades are keyed by
    // clip id, and renamed pieces used to export ungraded; here that is red instead of grey.
    const animated = flashed.map(item => item.id === 'c' ? { ...item, keyframes: { 'properties.opacity': [{ id: 'k1', time: 0, value: 100, interpolation: 'linear' as const }, { id: 'k2', time: .5, value: 100, interpolation: 'linear' as const }] } } : item);
    await renderTimeline(request(animated));
    picture = await frames();
    assert.equal(picture.length, 132);
    for (const [i, [r, g, b]] of picture.entries()) assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 24 && Math.max(r, g, b) > 30, `Frame ${i} lost its grade or went black: ${r},${g},${b}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
