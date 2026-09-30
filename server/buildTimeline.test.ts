import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain .mjs script without types
import { buildDelta } from '../scripts/build-timeline.mjs';
import { applyStateDelta } from '../src/services/stateDelta.ts';
import { getText, validateText } from '../src/services/text.ts';

test('build-timeline turns an edit JSON into one delta: clips, graphics, gain keys and styled captions', () => {
  const state = {
    projects: [{ id: 'p', name: 'fisch.builds Part 1', resolution: '1080 × 1920', fps: 30 }], timelines: [{ id: 'tl', projectId: 'p', name: 'Main', duration: 10 }],
    tracks: [{ id: 'hand', timelineId: 'tl', name: 'Main picture', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 }],
    media: [{ id: 'm1', projectId: 'p', name: 'IMG_6454.MOV', kind: 'video' }, { id: 'm2', projectId: 'p', name: 'beat.mp3', kind: 'audio' }],
    clips: [{ id: 'by-hand', projectId: 'p', timelineId: 'tl', trackId: 'hand', mediaId: 'm1', name: 'x', start: 50, duration: 1, sourceIn: 0, color: '', disabled: false, properties: {}, effects: [] }],
  } as any;
  const words = [{ text: 'we', start: 1, end: 1.2 }, { text: 'built', start: 1.2, end: 1.5 }, { text: 'this', start: 1.5, end: 1.8 }, { text: 'overnight.', start: 1.8, end: 2.4 }, { text: 'Tonight', start: 3, end: 3.5 }];
  const edit = {
    project: 'fisch.builds Part 1',
    tracks: [{ id: 'v1', kind: 'video', number: 1 }, { id: 'v2', name: 'Graphics', kind: 'video', number: 2 }, { id: 'a2', name: 'Music', kind: 'audio', number: 2, gain: -8 }],
    clips: [
      { id: 'hook', track: 'v1', media: 'IMG_6454.MOV', start: 0, in: 12.5, out: 15.5, properties: { flipH: true } },
      { id: 'music', track: 'a2', media: 'beat.mp3', start: 0, in: 0, duration: 62, gain: [[0.9, 0], [1.1, -14, 'outCubic'], [2.4, -14], [2.7, 0]] },
    ],
    text: [{ id: 'title', track: 'v2', start: 0, duration: 1.5, doc: { runs: [{ text: 'NIGHT 1', style: { fontFamily: 'Montserrat', fontSize: 160, fontWeight: 900, italic: false, underline: false, letterSpacing: 0, color: '#c4f876' } }], x: .05, y: .1, width: .9, height: .2, align: 'center', lineHeight: 1.1, opacity: 100 }, keyframes: { 'properties.zoom': [[0, 80, 'outBack'], [.2, 100]] } }],
    graphics: [{ id: 'bar', track: 'v2', start: 1, duration: 2, shape: { kind: 'rounded', fill: '#c4f876' } }],
    captions: { tracks: ['v1'], wordsPerLine: 3, preset: 'reel', style: { fontFamily: 'FL-abc', fontSize: 190, outlineWidth: 25, y: .65, accent: '#c4f876', wordPop: true } },
  };
  const delta = buildDelta(state, edit, words);
  const clips = delta.clips.upsert;
  assert.equal(clips.length, 2 + 1 + 1 + 3, 'two media clips, a title, a shape and three caption lines');
  assert.equal(delta.tracks.upsert.find((t: any) => t.number === 1 && t.kind === 'video').id, 'hand', 'an existing track is reused by kind and number');
  const hook = clips.find((c: any) => c.name === 'hook');
  assert.equal(hook.duration, 3); assert.equal(hook.sourceIn, 12.5); assert.equal(hook.properties.flipH, true);
  const music = clips.find((c: any) => c.name === 'music');
  assert.deepEqual(music.keyframes['properties.gain'][1].curve, [.33, 1, .68, 1]);
  const lines = clips.filter((c: any) => c.properties.captionSet);
  assert.deepEqual(lines.map((c: any) => c.start), [1, 1.8, 3]);
  const first = getText(lines[0]);
  assert.deepEqual(first.caption!.words.map(w => Math.round(w.start * 1000) / 1000), [0, .2, .5], 'caption words are relative to their line');
  assert.equal(first.runs[0].style.fontFamily, 'FL-abc'); assert.equal(first.outlineWidth, 25); assert.equal(first.caption!.accent, '#c4f876'); assert.equal(first.caption!.preset, 'reel');
  for (const line of lines) validateText(getText(line));
  assert.equal(delta.timelines.upsert[0].duration, 62);
  const captionTrack = delta.tracks.upsert.find((t: any) => t.captionSets);
  assert.equal(captionTrack.captionSets[0].trackIds[0], 'hand');

  const next = applyStateDelta(state, delta);
  const again = buildDelta(next, { ...edit, clips: [edit.clips[0]], captions: undefined, text: [], graphics: [] }, words);
  assert.equal(again.clips.remove.length, 6, 'a rerun removes what the last run wrote and is no longer in the edit');
  assert.ok(!again.clips.remove.includes('by-hand'), 'clips made by hand are left alone');
  assert.throws(() => buildDelta(state, { ...edit, clips: [{ ...edit.clips[0], media: 'missing.mov' }] }, words), /no media/);
});
