import assert from 'node:assert/strict';
import test from 'node:test';
import { clipSpan, extendClip, playbackLayers, sourceTime, syncClip } from './playback.ts';
import { trimLeak, leakRange, validateTransitionParams, nearestCut, timelineTransitions, transitionProgress, transitionParams, transitionCurve, alignShare, motionGap, motionSamples, transitionDefinitions, leakAudioTrack, wipeEdge, maximumDuration, bestAlign, mirrorTile } from './transitions.ts';
import type { Clip, MediaAsset, Track } from '../state/models.ts';

const asset: MediaAsset = { id: 'asset', projectId: 'p', name: 'a.mp4', kind: 'video', binId: '', duration: 10, fps: 24, resolution: '1920 × 1080', size: '', status: 'ready', progress: 100, thumbnail: '', hasAudio: true };
const track: Track = { id: 'v1', timelineId: 't', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
const clip = (id: string, start: number, duration: number, sourceIn: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, projectId: 'p', timelineId: 't', mediaId: 'asset', name: id, trackId: 'v1', start, duration, sourceIn, color: '#888', disabled: false, properties: {}, effects: [], ...extra });

test('a transition window reads out of the handles without moving either clip', () => {
  const a = clip('a', 0, 2, 2);
  const b = clip('b', 2, 2, 4, { transition: 'Cross dissolve', properties: { transitionDuration: 1 } });
  const [record] = timelineTransitions([a, b], 't', [asset]);
  const spanA = clipSpan(a, [record]), spanB = clipSpan(b, [record]);
  assert.deepEqual(spanA, { start: 0, end: 2.5 }, 'The outgoing clip plays half a second past its out point.');
  assert.deepEqual(spanB, { start: 1.5, end: 4 }, 'The incoming clip starts half a second early.');

  const extendedB = extendClip(b, spanB.start, spanB.end - spanB.start);
  assert.equal(extendedB.sourceIn, 3.5, 'Pulling the head back half a second reads half a second earlier in the source.');
  assert.equal(extendedB.duration, 2.5);
  const extendedA = extendClip(a, spanA.start, spanA.end - spanA.start);
  assert.equal(extendedA.sourceIn, 2, 'Extending a tail never moves the in point.');
  assert.equal(extendedA.duration, 2.5);

  // Retimed footage consumes handles at its own rate.
  const fast = clip('f', 2, 2, 4, { properties: { speed: 200 } });
  assert.equal(extendClip(fast, 1.5, 2.5).sourceIn, 3, 'At 200% a half-second lead costs a whole second of source.');
});

test('both shots are on screen through the window, and only through the window', () => {
  const a = clip('a', 0, 2, 2);
  const b = clip('b', 2, 2, 4, { transition: 'Cross dissolve', properties: { transitionDuration: 1 } });
  const state = { clips: [a, b], tracks: [track], media: [asset], projectId: 'p', timelineId: 't' };
  const records = timelineTransitions([a, b], 't', [asset]);
  const at = (playhead: number) => playbackLayers({ ...state, playhead }, 24, records.filter(record => transitionProgress(record, playhead))).map(layer => layer.clip.id);
  assert.deepEqual(at(1), ['a'], 'Before the window only the outgoing clip plays.');
  assert.deepEqual(at(1.75), ['a', 'b'], 'Inside the window both shots are live.');
  assert.deepEqual(at(2.25), ['a', 'b'], 'Both stay live past the cut until the window closes.');
  assert.deepEqual(at(3), ['b'], 'After the window only the incoming clip plays.');
  // With the window filtered out, the layers must collapse back to an ordinary hard cut.
  assert.deepEqual(playbackLayers({ ...state, playhead: 1.75 }, 24, []).map(layer => layer.clip.id), ['a']);
});

test('overlay cuts tolerate millisecond source rounding and screen-blend both shots', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const outgoing = createCanvas(2, 2), incoming = createCanvas(2, 2), overlay = createCanvas(2, 2), target = createCanvas(2, 2);
  for (const [canvas, color] of [[outgoing, '#c02010'], [incoming, '#1040c0'], [overlay, '#000000']] as const) {
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 2, 2);
  }
  for (const rounding of [-.00081233333333, .00081233333333]) {
    const a = clip('a', 0, 2 + rounding, 2);
    const b = clip('b', 2, 2, 4, { transition: 'Light leak', properties: { transitionDuration: 1 } });
    const [record] = timelineTransitions([a, b], 't', [asset]);
    assert.equal(record.outgoingId, a.id, 'Source rounding must not drop the outgoing shot.');
    assert.equal(nearestCut([a, b], 'v1', 't', a.duration, .1)?.side, 'in', 'The shared cut belongs to the incoming clip.');
    for (const raw of [.25, .75]) {
      transitionDefinitions[record.name].draw({ target: target.getContext('2d') as unknown as CanvasRenderingContext2D,
        outgoing: (record.outgoingId ? outgoing : null) as unknown as CanvasImageSource | null,
        incoming: incoming as unknown as CanvasImageSource, overlay: overlay as unknown as CanvasImageSource,
        raw, progress: raw, params: record.params, width: 2, height: 2 });
      assert.deepEqual([...target.getContext('2d').getImageData(0, 0, 1, 1).data], raw < .5 ? [192, 32, 16, 255] : [16, 64, 192, 255], 'A black screen overlay leaves each shot visible.');
    }
    const [gap] = timelineTransitions([{ ...a, duration: 2 - 1 / 240 }, b], 't', [asset]);
    assert.equal(gap.outgoingId, undefined, 'A real frame gap remains an open clip edge.');
  }
});

test('progress runs the eased curve across the window and stops at its edges', () => {
  const b = clip('b', 2, 2, 4, { transition: 'Cross dissolve', properties: { transitionDuration: 1, transitionCurve: '0,0,1,1' } });
  const [record] = timelineTransitions([clip('a', 0, 2, 2), b], 't', [asset]);
  assert.equal(transitionProgress(record, 1.4), null, 'Outside the window there is no blend.');
  assert.equal(transitionProgress(record, 2.5), null, 'The window is half-open, so its end belongs to the next clip.');
  assert.equal(transitionProgress(record, 1.5)!.raw, 0);
  assert.ok(Math.abs(transitionProgress(record, 2)!.raw - .5) < 1e-9);
  assert.ok(Math.abs(transitionProgress(record, 2)!.eased - .5) < .02, 'A linear curve eases to its own midpoint.');
  const snappy = timelineTransitions([clip('a', 0, 2, 2), { ...b, properties: { ...b.properties, transitionCurve: '0.8,0,0.2,1' } }], 't', [asset])[0];
  assert.ok(transitionProgress(snappy, 1.7)!.eased < transitionProgress(record, 1.7)!.eased, 'A snap curve holds back before it accelerates.');
});

test('alignment decides which clip lends the frames', () => {
  assert.equal(alignShare('center'), .5);
  assert.equal(alignShare('in'), 0);
  assert.equal(alignShare('out'), 1);
  const b = clip('b', 2, 2, 4, { transition: 'Cross dissolve', properties: { transitionDuration: 1, transitionAlign: 'in' } });
  const [record] = timelineTransitions([clip('a', 0, 2, 2), b], 't', [asset]);
  assert.equal(record.start, 2, 'Start-at-cut takes every frame from the incoming clip.');
  assert.equal(record.end, 3);
});

test('a drop finds the nearest eligible cut and ignores cuts that already meet', () => {
  const clips = [clip('a', 0, 2, 0), clip('b', 2, 2, 0), clip('c', 6, 2, 0)];
  assert.equal(nearestCut(clips, 'v1', 't', 2.05, .5)?.clip.id, 'b', 'A shared cut is addressed through the incoming clip.');
  assert.equal(nearestCut(clips, 'v1', 't', 2.05, .5)?.side, 'in');
  assert.equal(nearestCut(clips, 'v1', 't', 4.02, .5)?.clip.id, 'b', 'An open tail accepts a transition to nothing.');
  assert.equal(nearestCut(clips, 'v1', 't', 4.02, .5)?.side, 'out');
  assert.equal(nearestCut(clips, 'v1', 't', 1, .2), null, 'Mid-clip is not a cut.');
  assert.equal(nearestCut(clips, 'v1', 't', 2.05, .5)?.cut, 2);
  assert.equal(nearestCut(clips, 'other', 't', 2.05, .5), null, 'Cuts belong to their own track.');
});

test('stored parameters fall back to the definition rather than breaking the draw', () => {
  const base = clip('b', 2, 2, 0, { transition: 'Light leak' });
  assert.equal(transitionParams(base, 'in').blend, 'Screen', 'An unset parameter uses its default.');
  assert.equal(transitionParams({ ...base, properties: { transitionParams: 'not json' } }, 'in').blend, 'Screen');
  assert.equal(transitionParams({ ...base, properties: { transitionParams: JSON.stringify({ blend: 'Add' }) } }, 'in').blend, 'Add');
  assert.deepEqual(transitionCurve({ ...base, properties: { transitionCurve: 'junk' } }, 'in'), [1 / 3, 1 / 3, 2 / 3, 2 / 3]);
  assert.deepEqual(transitionCurve({ ...base, transition: 'Camera flash', properties: {} }, 'in'), [.2, .9, .4, 1], 'A definition may ship its own curve.');
  // An unknown name resolves to nothing at all rather than a half-configured transition.
  assert.equal(timelineTransitions([clip('a', 0, 2, 0), { ...base, transition: 'Nonsense' }], 't', [asset]).length, 0);
});

test('motion blur samples follow how far the picture actually travels', () => {
  assert.equal(motionSamples(0, 1920, .5, 24), 1, 'A closed shutter costs nothing.');
  // A 1920px push across half a second at 24fps moves 160px per frame; at 180° that is 80px of
  // smear, which needs far more samples than a slow zoom of a few pixels.
  const whip = motionSamples(180, 1920, .35, 24), slow = motionSamples(180, 120, 2, 24);
  assert.ok(whip > slow * 3, `A fast whip must sample far more finely than a slow move, saw ${whip} vs ${slow}`);
  assert.ok(whip <= 32, 'Sampling is capped so a long window cannot swamp the serial render queue.');
  assert.equal(motionSamples(180, 2, 1, 24), 1, 'Sub-pixel travel needs no blur at all.');
  // Whatever spacing the cap leaves behind is what the matching blur has to close.
  assert.ok(motionGap(180, 1920, .35, 24) > 1, 'A capped fast move leaves a gap for the blur to close.');
  assert.equal(motionGap(180, 2, 1, 24), 0, 'No samples, no gap.');
  for (const [name, definition] of Object.entries(transitionDefinitions)) {
    if (definition.motion) assert.ok(definition.travel, `${name} must declare how far it travels.`);
  }
  for (const [name, definition] of Object.entries(transitionDefinitions)) {
    assert.ok(typeof definition.draw === 'function', `${name} must draw in the preview.`);
    assert.ok(definition.ffmpeg.xfade || definition.ffmpeg.side, `${name} must also render on export.`);
  }
});

test('an expanded sound only counts while its clip still exists', () => {
  const owner = clip('b', 2, 2, 4, { transition: 'Light leak', properties: { transitionDuration: 1, transitionAudioId: 'sound-1' } });
  const sound = clip('sound-1', 1.5, 1, 0, { trackId: 'a1' });
  assert.equal(timelineTransitions([clip('a', 0, 2, 2), owner, sound], 't', [asset])[0].audioClipId, 'sound-1');
  // Deleting the audio clip must bring the embedded copy back rather than leaving silence.
  assert.equal(timelineTransitions([clip('a', 0, 2, 2), owner], 't', [asset])[0].audioClipId, undefined);
});

test('a window never reaches before the start of the timeline', () => {
  // A centred transition on a clip that opens the timeline has no room on its leading side.
  const head = clip('a', 0, 3, 2, { transition: 'Cross dissolve', properties: { transitionDuration: 1 } });
  const [record] = timelineTransitions([head], 't', [asset]);
  assert.equal(record.start, 0, 'The window is clamped to the timeline, not pushed negative.');
  assert.equal(record.end, .5);
  assert.equal(record.duration, .5, 'Duration follows the clamped window so progress still spans it.');
  assert.equal(record.requested, 1, 'The stored length is untouched.');
  assert.equal(transitionProgress(record, 0)!.raw, 0);
  assert.ok(Math.abs(transitionProgress(record, .25)!.raw - .5) < 1e-9);
});

test('expanded leak sound avoids an occupied track and reports when none is free', () => {
  const video: Track = { ...track, id: 'v1', number: 1 };
  const a1: Track = { ...track, id: 'a1', kind: 'audio', number: 1, name: 'A1' };
  const a2: Track = { ...track, id: 'a2', kind: 'audio', number: 2, name: 'A2' };
  const busy = clip('busy', 1, 3, 0, { trackId: 'a1' });
  // A1 is nearest but already occupied across the window, so the sound belongs on A2.
  assert.equal(leakAudioTrack([a1, a2], video, [busy], 1.5, 2.5)?.id, 'a2');
  // Clear of the existing clip, the nearest track is fine.
  assert.equal(leakAudioTrack([a1, a2], video, [busy], 5, 6)?.id, 'a1');
  // Every track busy means the caller has to make one rather than overlap.
  assert.equal(leakAudioTrack([a1], video, [busy], 1.5, 2.5), undefined);
  // A locked track is never a candidate, occupied or not.
  assert.equal(leakAudioTrack([{ ...a1, locked: true }], video, [], 1.5, 2.5), undefined);
});

test('a linear wipe reveals the incoming shot from the correct edge', () => {
  const width = 1920;
  // A Left wipe brings the next shot in from the right edge and sweeps it left, so the revealed
  // span grows with progress and the soft edge always points into the revealed side.
  const early = wipeEdge('Left', .1, width, .2), late = wipeEdge('Left', .9, width, .2);
  assert.ok(early.boundary > late.boundary, 'The edge travels leftwards as the wipe progresses.');
  assert.ok(width - late.boundary > width * .85, 'By 90% the incoming shot covers most of the frame.');
  assert.ok(width - early.boundary < width * .15, 'At 10% it covers only a sliver.');
  assert.ok(late.tip > late.boundary, 'Left softens toward the revealed right-hand side.');

  const right = wipeEdge('Right', .9, width, .2);
  assert.ok(right.boundary > width * .85, 'A Right wipe grows from the left edge instead.');
  assert.ok(right.tip < right.boundary, 'Right softens toward the revealed left-hand side.');

  // Full travel at the ends, whichever way it runs.
  for (const axis of ['Left', 'Right', 'Up', 'Down']) {
    assert.ok(Math.abs(wipeEdge(axis, 0, width, .2).boundary - (axis === 'Left' || axis === 'Up' ? width : 0)) < 1e-6, `${axis} starts hidden.`);
    assert.ok(Math.abs(wipeEdge(axis, 1, width, .2).boundary - (axis === 'Left' || axis === 'Up' ? 0 : width)) < 1e-6, `${axis} ends fully revealed.`);
  }
  assert.equal(wipeEdge('Left', .5, width, 0).feather, 1, 'Zero softness still leaves a one-pixel edge.');
});

test('media sync inside a transition window keeps advancing with the playhead', () => {
  // The window borrows handles from both sides, so the decoders have to keep rolling through it.
  // Reading the *stored* clip made `sourceTime` clamp to its own span, which pinned the target
  // while the element played on — the sync then yanked it back and both shots jittered.
  const a = clip('a', 0, 2, 2);
  const b = clip('b', 2, 2, 4, { transition: 'Cross dissolve', properties: { transitionDuration: 1 } });
  const records = timelineTransitions([a, b], 't', [asset]);
  const at = (id: string, time: number) => {
    const active = records.filter(record => transitionProgress(record, time));
    const layer = playbackLayers({ clips: [a, b], tracks: [track], media: [asset], projectId: 'p', timelineId: 't', playhead: time }, 24, active).find(item => item.clip.id === id);
    return layer && sourceTime(syncClip([a, b].find(c => c.id === id), layer.clip), time, 24, asset.duration);
  };
  for (const id of ['a', 'b']) {
    const samples = [1.55, 1.65, 1.75, 1.85, 1.95, 2.05].map(time => at(id, time)!);
    samples.forEach((value, index) => assert.ok(value !== undefined, `${id} is on screen at sample ${index}`));
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i] - samples[i - 1] > .09, `${id} advances across the window (${samples[i - 1]} -> ${samples[i]})`);
    }
  }
});

test('a cut with handles on one side only still takes a transition', () => {
  // The real project hit this: the outgoing clip ran to the last frame of its media while the
  // incoming clip had a full second of head spare. Centred needs both, so the alignment that only
  // needs the side that actually has frames is the one to offer.
  const short: MediaAsset = { ...asset, duration: 4 };
  const a = clip('a', 0, 2, 2);                      // reads to the final frame of its media: no tail
  const b = clip('b', 2, 2, 1.084);                  // a second of head to spare
  assert.equal(maximumDuration([a, b], b, 'in', 'center', [short]), 0, 'Centred still needs frames from both sides.');
  assert.equal(maximumDuration([a, b], b, 'in', 'in', [short]), 0, 'Sitting after the cut asks the outgoing clip for a tail it has not got.');
  assert.ok(maximumDuration([a, b], b, 'in', 'out', [short]) > 1, 'Sitting before the cut only needs the head the incoming clip has.');
  assert.equal(bestAlign([a, b], b, 'in', [short]), 'out', 'Adding a transition here picks the alignment that fits.');

  // But a centred window that is merely short stays centred: straddling the cut is the edit people
  // mean, and trimming it a little beats shoving the whole thing to one side.
  const roomy = clip('r', 0, 2, 1.7);                // 0.3s of tail left in four seconds of media
  const after = clip('s', 2, 2, 2);                  // a full two seconds of head
  assert.equal(maximumDuration([roomy, after], after, 'in', 'center', [short]).toFixed(2), '0.60', 'centred cannot carry the full second');
  assert.equal(maximumDuration([roomy, after], after, 'in', 'out', [short]), 2, 'sitting before the cut could carry far more');
  assert.equal(bestAlign([roomy, after], after, 'in', [short], 1), 'center', 'it is still shortened rather than moved off the cut');
});

test('two whole clips butt-cut together still take a transition, holding the outgoing frame', () => {
  // The real project hit this: both clips were dropped in at full length, so neither had a frame
  // of handle anywhere and the cut simply refused every transition. Holding the outgoing clip's
  // last frame is what the renderer already does for a span that reads past the media.
  const exact: MediaAsset = { ...asset, duration: 4 };
  const a = clip('a', 0, 4, 0);                      // whole media: no head, no tail
  const b = clip('b', 4, 4, 0);                      // likewise
  assert.equal(maximumDuration([a, b], b, 'in', 'center', [exact]), 0, 'No real frames back a window here.');
  assert.equal(bestAlign([a, b], b, 'in', [exact], 1), 'in', 'A held window only works after the cut.');
  assert.equal(maximumDuration([a, b], b, 'in', 'in', [exact], true), 4, 'Held, the outgoing clip can cover its own length.');
  assert.equal(maximumDuration([a, b], b, 'in', 'out', [exact], true), 0, 'Reaching back would slip the incoming clip, so it stays refused.');

  const held = clip('b', 4, 4, 0, { transition: 'Cross dissolve', properties: { transitionDuration: 1, transitionAlign: 'in' } });
  const [record] = timelineTransitions([a, held], 't', [exact]);
  assert.equal(record.duration.toFixed(2), '1.00', 'The stored window survives instead of collapsing to nothing.');
  const span = clipSpan(a, [record]);
  assert.equal(span.end, 5, 'The outgoing clip plays a second past its media.');
  const extended = extendClip(a, span.start, span.end - span.start);
  assert.equal(sourceTime(extended, 4.5, 24, exact.duration).toFixed(3), (4 - 1 / 24).toFixed(3), 'Past the media it holds the last frame rather than reading nothing.');

  // A cut that does have handles is untouched: the fallback never steals a real dissolve.
  const roomy = clip('r', 0, 2, 1.7), after = clip('s', 2, 2, 2);
  assert.equal(bestAlign([roomy, after], after, 'in', [exact], 1), 'center', 'Handles still win.');
});

test('motion blur samples the fastest moment, not the average one', () => {
  // An eased window moves far faster through its middle than end-to-end travel suggests. Sizing
  // the shutter from the average left the middle of every whip and push visibly stepped.
  const whip: [number, number, number, number] = [.8, 0, .2, 1];
  const middle = motionSamples(180, 1920, .35, 24, whip, .5);
  const edge = motionSamples(180, 1920, .35, 24, whip, 0);
  assert.ok(middle > edge * 1.5, `the middle of an eased window asks for more samples (${middle} vs ${edge})`);
  assert.equal(motionSamples(180, 1920, .35, 24, whip, .5), motionSamples(180, 1920, .35, 24, whip, .5));
  assert.ok(motionSamples(0, 1920, .35, 24, whip, .5) === 1, 'A closed shutter never samples.');
});

test('a mirrored surround has no unfilled quadrant', () => {
  // Nine reflected draws put both the -1 and +1 tiles in the same place, so a zoom-out showed
  // black down the left and along the top. The tiling is periodic over two frames; check the
  // mapping covers every quadrant around the original exactly once.
  for (const column of [-2, -1, 0, 1, 2]) for (const row of [-2, -1, 0, 1, 2]) {
    const tile = mirrorTile(column, row, 100, 50);
    // Where the unit frame actually lands once the tile's transform is applied.
    const left = Math.min(tile.translateX, tile.translateX + tile.scaleX * 100);
    const top = Math.min(tile.translateY, tile.translateY + tile.scaleY * 50);
    assert.equal(left, column * 100, `tile ${column},${row} spans the column it belongs to`);
    assert.equal(top, row * 50, `tile ${column},${row} spans the row it belongs to`);
    assert.equal(tile.scaleX, column % 2 === 0 ? 1 : -1, `tile ${column} alternates its reflection`);
    assert.equal(tile.scaleY, row % 2 === 0 ? 1 : -1, `row ${row} alternates its reflection`);
  }
});


test('each overlay peak shifts its window while the picture changes exactly at the edit', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const outgoing = createCanvas(2, 2), incoming = createCanvas(2, 2), target = createCanvas(2, 2);
  outgoing.getContext('2d').fillStyle = '#ff0000'; outgoing.getContext('2d').fillRect(0, 0, 2, 2);
  incoming.getContext('2d').fillStyle = '#0000ff'; incoming.getContext('2d').fillRect(0, 0, 2, 2);
  for (const peak of [0, 17, 40, 75, 100]) for (const align of ['in', 'center', 'out'] as const) {
    const a = clip('a', 0, 2, 2), b = clip('b', 2, 2, 4, { transition: 'Light leak', properties: { transitionDuration: 1, transitionAlign: align, transitionParams: JSON.stringify({ blendPoint: peak }) } });
    const [record] = timelineTransitions([a, b], 't', [asset]);
    assert.ok(Math.abs(record.start - (2 - peak / 100)) < 1e-9);
    assert.ok(Math.abs(record.end - (3 - peak / 100)) < 1e-9);
    for (const time of [2 - 1 / 24, 2, 2 + 1 / 24]) {
      const progress = transitionProgress(record, time);
      if (!progress) continue;
      transitionDefinitions[record.name].draw({ target: target.getContext('2d') as unknown as CanvasRenderingContext2D,
        outgoing: outgoing as unknown as CanvasImageSource, incoming: incoming as unknown as CanvasImageSource, overlay: null,
        raw: progress.raw, progress: progress.eased, params: { ...record.params, __cutPoint: (record.cut - record.start) / record.duration }, width: 2, height: 2 });
      assert.deepEqual([...target.getContext('2d').getImageData(0, 0, 1, 1).data], time < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    }
  }
});


test('overlay source trims are bounded and cover scaling fills a different frame shape', async () => {
  assert.deepEqual(leakRange({}, 3), { start: 0, end: 3, duration: 3 });
  assert.deepEqual(leakRange({ leakIn: 1, leakOut: 2 }, 3), { start: 1, end: 2, duration: 1 });
  assert.equal(leakRange({ leakIn: 20, leakOut: 30 }, 3).end, 3);
  assert.throws(() => validateTransitionParams({ leakIn: 2, leakOut: 1 }), /end/);
  assert.throws(() => validateTransitionParams({ leakIn: -1 }), /trim/);
  assert.throws(() => validateTransitionParams({ leakOut: '2' }), /trim/);
  const { createCanvas } = await import('@napi-rs/canvas');
  const overlay = createCanvas(12, 4), target = createCanvas(4, 12);
  const source = overlay.getContext('2d'); source.fillStyle = '#00ff00'; source.fillRect(0, 0, 12, 4);
  source.fillStyle = '#ff0000'; source.fillRect(0, 0, 2, 4); source.fillRect(10, 0, 2, 4);
  transitionDefinitions['Light leak'].draw({ target: target.getContext('2d') as unknown as CanvasRenderingContext2D,
    outgoing: null, incoming: null, overlay: overlay as unknown as CanvasImageSource, raw: .5, progress: .5, params: {}, width: 4, height: 12 });
  for (const [x, y] of [[0, 0], [3, 11], [2, 6]]) assert.deepEqual([...target.getContext('2d').getImageData(x, y, 1, 1).data], [0, 255, 0, 255], 'Cover crops the sides and fills every corner.');
});


test('trimming either overlay edge preserves rate and source frame at the cut', () => {
  const original = { duration: 2, params: { leakIn: 1, leakOut: 5, blendPoint: 50 } };
  for (const patch of [{ leakIn: 2 }, { leakOut: 4 }, { leakIn: 0 }, { leakOut: 6 }] as Record<string, number>[]) {
    const trimmed = trimLeak(original, 8, patch), range = leakRange(trimmed.params, 8);
    assert.equal(range.duration / trimmed.duration, 2);
    assert.equal(range.start + range.duration * Number(trimmed.params.blendPoint) / 100, 3);
    const before = 10 - original.duration * .5, after = 10 - trimmed.duration * Number(trimmed.params.blendPoint) / 100;
    if ('leakIn' in patch) assert.equal(after + trimmed.duration, before + original.duration, 'Trimming the start leaves the end fixed.');
    else assert.equal(after, before, 'Trimming the end leaves the start fixed.');
  }
});
