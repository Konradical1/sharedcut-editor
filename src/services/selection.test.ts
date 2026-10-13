import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacentShot, forwardRoom, forwardSelection } from './selection.ts';
import type { Clip, Track } from '../state/models.ts';

/** Only the fields the two helpers read. */
const clip = (id: string, trackId: string, start: number, duration: number, timelineId = 't1', linkGroup?: string) => ({ id, trackId, timelineId, start, duration, properties: linkGroup === undefined ? {} : { linkGroup } }) as unknown as Clip;
const track = (id: string, o: Partial<Track> = {}) => ({ id, timelineId: 't1', locked: false, hidden: false, muted: false, ...o }) as unknown as Track;
const TRACKS = [track('v1'), track('a1'), track('v7')];
const sel = (clips: Clip[], at: number, fps = 24, tracks: Track[] = TRACKS, timelineId = 't1', linked = false) => forwardSelection(clips, tracks, timelineId, at, fps, linked);
const FPS = [23.976, 24, 25, 29.97, 30, 59.94];

test('a clip starting exactly at the anchor is selected, one ending exactly at it is left alone', () => {
  assert.deepEqual(sel([clip('before', 'v1', 5, 5), clip('at', 'v1', 10, 2), clip('after', 'a1', 12, 1)], 10), { ids: ['at', 'after'], crossing: [] });
});

test('a clip starting a hair before the anchor still counts as forward; a clear miss crosses', () => {
  // 24 fps: half a frame is 0.0208 s
  assert.deepEqual(sel([clip('hair', 'v1', 9.99, 2), clip('near', 'a1', 9.97, 2)], 10), { ids: ['hair'], crossing: ['near'] });
});

test('a clip ending a hair past the anchor is not crossing; more than half a frame is', () => {
  assert.deepEqual(sel([clip('drift', 'v1', 9, 1.01), clip('over', 'a1', 9, 1.03)], 10), { ids: [], crossing: ['over'] });
});

test('real drift: a caption ending at 105.0700001 does not cross a cut at 105.07, the next one is forward', () => {
  const prev = clip('c1', 'v7', 104.54, 0.5300001), next = clip('c2', 'v7', 105.0700001, 0.4), early = clip('c3', 'v7', 105.07 - 1e-7, 0.4);
  assert.ok(prev.start + prev.duration > 105.07, 'fixture really drifts past the cut');
  assert.deepEqual(sel([prev, next, early], 105.07), { ids: ['c2', 'c3'], crossing: [] });
});

test('half a frame scales with fps: 23.976, 24, 25, 29.97, 30, 59.94', () => {
  for (const fps of FPS) {
    const f = 1 / fps;
    const r = sel([clip('startIn', 'v1', 50 - .4 * f, 10), clip('startOut', 'v1', 50 - .6 * f, 10), clip('endIn', 'a1', 40, 10 + .4 * f), clip('endOut', 'a1', 40, 10 + .6 * f)], 50, fps);
    assert.deepEqual(r, { ids: ['startIn'], crossing: ['startOut', 'endOut'] }, `fps ${fps}`);
  }
});

test('fps 0, NaN or undefined fall back to 24 (not to an infinite slack)', () => {
  const clips = [clip('p1', 'v1', 49.981, 10), clip('p2', 'v1', 49.5, 10), clip('p3', 'a1', 40, 10.019), clip('p4', 'a1', 40, 10.5)];
  const at24 = sel(clips, 50, 24);
  assert.deepEqual(at24, { ids: ['p1'], crossing: ['p2', 'p4'] });
  for (const fps of [0, NaN, undefined as unknown as number]) assert.deepEqual(sel(clips, 50, fps), at24);
  assert.notDeepEqual(sel(clips, 50, 30), at24, 'the probes tell 24 and 30 apart');
});

test('locked tracks are excluded from both lists; hidden and muted tracks are included', () => {
  const tracks = [track('v1'), track('a1', { locked: true }), track('v2', { hidden: true }), track('a2', { muted: true })];
  const clips = [clip('a', 'v1', 20, 1), clip('b', 'a1', 20, 1), clip('c', 'v2', 20, 1), clip('d', 'a2', 20, 1), clip('x1', 'v1', 5, 20), clip('x2', 'a1', 5, 20), clip('x3', 'v2', 5, 20)];
  assert.deepEqual(sel(clips, 10, 24, tracks), { ids: ['a', 'c', 'd'], crossing: ['x1', 'x3'] });
});

test('with linked selection a clip whose link partner is on a locked track stays behind, and so does its partner', () => {
  const tracks = [track('v1'), track('a1', { locked: true }), track('a2')];
  const clips = [clip('pinned', 'v1', 20, 1, 't1', 'g'), clip('partner', 'a1', 20, 1, 't1', 'g'), clip('free', 'v1', 21, 1, 't1', 'h'), clip('freePartner', 'a2', 21, 1, 't1', 'h'), clip('plain', 'v1', 22, 1), clip('pinnedCross', 'v1', 5, 20, 't1', 'g')];
  assert.deepEqual(sel(clips, 10, 24, tracks, 't1', true), { ids: ['free', 'freePartner', 'plain'], crossing: [] }, 'the pinned group is neither selected nor counted as crossing');
  assert.deepEqual(sel(clips, 10, 24, tracks), { ids: ['pinned', 'free', 'freePartner', 'plain'], crossing: ['pinnedCross'] }, 'without link selection the partner is not the clip\'s business');
});

test('a locked clip in another timeline with the same link group pins nothing here', () => {
  const tracks = [track('v1'), track('a1', { timelineId: 't2', locked: true })];
  assert.deepEqual(sel([clip('mine', 'v1', 20, 1, 't1', 'g'), clip('theirs', 'a1', 20, 1, 't2', 'g')], 10, 24, tracks, 't1', true), { ids: ['mine'], crossing: [] });
});

test('only the given timeline counts: its clips on its tracks', () => {
  const tracks = [track('v1'), track('v1', { timelineId: 't2', locked: true }), track('v9', { timelineId: 't2' })];
  const clips = [clip('mine', 'v1', 20, 1), clip('other', 'v1', 20, 1, 't2'), clip('stray', 'v9', 20, 1), clip('otherCross', 'v9', 5, 20, 't2')];
  assert.deepEqual(sel(clips, 10, 24, tracks), { ids: ['mine'], crossing: [] });
  // t2's v1 is locked, v9 is open: only t2's clip on v9 qualifies, and it crosses
  assert.deepEqual(sel(clips, 10, 24, tracks, 't2'), { ids: [], crossing: ['otherCross'] });
});

test('a clip whose track is missing is in neither list', () => {
  assert.deepEqual(sel([clip('ghost', 'nope', 20, 1), clip('ghostCross', 'nope', 5, 20), clip('ok', 'v1', 20, 1)], 10), { ids: ['ok'], crossing: [] });
});

test('an anchor at 0 selects every clip on an unlocked track, nothing crosses', () => {
  const tracks = [track('v1'), track('a1', { locked: true }), track('v7')];
  const r = sel([clip('layer', 'v1', 0, 124.73), clip('later', 'v7', 50, 1), clip('locked', 'a1', 0, 5)], 0, 24, tracks);
  assert.deepEqual(r, { ids: ['layer', 'later'], crossing: [] });
});

test('an anchor past the end selects nothing, and nothing crosses', () => {
  const clips = [clip('layer', 'v1', 0, 124.73), clip('tail', 'a1', 100, 24.73)];
  assert.deepEqual(sel(clips, 200), { ids: [], crossing: [] });
  assert.deepEqual(sel(clips, 124.73), { ids: [], crossing: [] });
  assert.deepEqual(sel(clips, 124.74), { ids: [], crossing: [] }, 'within half a frame of the end');
});

test('a full-length overlay (0..124.73) crosses at every interior cut', () => {
  const layer = clip('overlay', 'v1', 0, 124.73);
  for (const at of [.05, 1, 30, 105.07, 124.6]) assert.deepEqual(sel([layer], at), { ids: [], crossing: ['overlay'] }, `at ${at}`);
  assert.deepEqual(sel([layer], 0), { ids: ['overlay'], crossing: [] });
});

test('caption-track clips are selected like any other', () => {
  const r = sel([clip('cap1', 'v7', 10, .5), clip('cap2', 'v7', 10.5, .5), clip('cap0', 'v7', 9, .5), clip('v', 'v1', 10, 3)], 10);
  assert.deepEqual(r.ids.sort(), ['cap1', 'cap2', 'v']);
});

test('ids come back in clip order and the input is left alone', () => {
  const clips = [clip('c', 'v1', 30, 1), clip('a', 'a1', 12, 1), clip('b', 'v7', 20, 1)], before = JSON.stringify(clips);
  assert.deepEqual(sel(clips, 10).ids, ['c', 'a', 'b']);
  assert.equal(JSON.stringify(clips), before);
});

test('a Part 1 v2 shaped cut: four full-length layers cross, the captions from the cut on are selected', () => {
  const tracks = [...['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'].map(id => track(id)), ...Array.from({ length: 9 }, (_, i) => track(`a${i + 1}`))];
  const layers = [clip('roomtone', 'a1', 0, 124.73), clip('music', 'a2', 0, 124.73), clip('ov1', 'v5', 0, 124.73), clip('ov2', 'v6', 0, 124.73)];
  const caps = Array.from({ length: 133 }, (_, i) => clip(`cap${i}`, 'v7', i * .79, .79));
  const r = sel([...layers, ...caps], 100 * .79, 24, tracks);
  assert.deepEqual(r.crossing, ['roomtone', 'music', 'ov1', 'ov2']);
  assert.deepEqual(r.ids, caps.slice(100).map(c => c.id));
});

// ---- forwardRoom ----

test('room: the gap to the clip left behind on the same track', () => {
  assert.equal(forwardRoom([clip('stay', 'v1', 0, 10), clip('go', 'v1', 14, 6)], ['go']), 4);
});

test('room: the smallest gap across tracks wins', () => {
  const clips = [clip('s1', 'v1', 0, 10), clip('g1', 'v1', 14, 3), clip('s2', 'a1', 0, 17.5), clip('g2', 'a1', 20, 3), clip('s3', 'v7', 0, 5), clip('g3', 'v7', 30, 1)];
  assert.equal(forwardRoom(clips, ['g1', 'g2', 'g3']), 2.5);
});

test('room: clips staying on other tracks do not limit', () => {
  assert.equal(forwardRoom([clip('stayOther', 'a1', 8, 1.99), clip('go', 'v1', 10, 5)], ['go']), 10);
});

test('room: clips staying after the moving clip do not limit', () => {
  assert.equal(forwardRoom([clip('before', 'v1', 2, 2), clip('go', 'v1', 10, 5), clip('after', 'v1', 20, 5)], ['go']), 6);
  assert.equal(forwardRoom([clip('go', 'v1', 10, 5), clip('after', 'v1', 20, 5)], ['go']), 10, 'only time zero is left');
});

test('room: the nearest clip left behind governs, whatever the array order', () => {
  const clips = [clip('far', 'v1', 0, 2), clip('go', 'v1', 10, 1), clip('near', 'v1', 5, 3)];
  assert.equal(forwardRoom(clips, ['go']), 2);
  assert.equal(forwardRoom([...clips].reverse(), ['go']), 2);
});

test('room: touching neighbours leave none', () => {
  assert.equal(forwardRoom([clip('stay', 'v1', 0, 10), clip('go', 'v1', 10, 5)], ['go']), 0);
});

test('room: drift that would make it slightly negative gives exactly 0', () => {
  const r = forwardRoom([clip('stay', 'v1', 100, 5.0700001), clip('go', 'v1', 105.07, 3)], ['go']);
  assert.equal(r, 0);
  assert.ok(Object.is(r, 0), 'not -0');
});

test('room: a clip crossing the line and staying behind stops the drag at once', () => {
  assert.equal(forwardRoom([clip('layer', 'v1', 0, 124.73), clip('go', 'v1', 105.07, 3)], ['go']), 0);
});

test('room: time zero bounds it, at the earliest moving start', () => {
  assert.equal(forwardRoom([clip('go', 'v1', 5, 2)], ['go']), 5);
  assert.equal(forwardRoom([clip('a', 'v1', 7, 1), clip('b', 'a1', 3, 1), clip('far', 'v7', 0, .5)], ['a', 'b']), 3);
  assert.equal(forwardRoom([clip('go', 'v1', 0, 2)], ['go']), 0);
});

test('room: moving clips on one track do not block each other', () => {
  assert.equal(forwardRoom([clip('stay', 'v1', 0, 4), clip('m1', 'v1', 10, 2), clip('m2', 'v1', 14, 2)], ['m1', 'm2']), 6);
});

test('room: empty or unknown ids give 0', () => {
  const clips = [clip('stay', 'v1', 0, 4), clip('go', 'v1', 10, 2)];
  assert.equal(forwardRoom(clips, []), 0);
  assert.equal(forwardRoom(clips, ['nope']), 0);
  assert.equal(forwardRoom([], ['go']), 0);
});

test('room: clips of another timeline that share a trackId do not limit', () => {
  assert.equal(forwardRoom([clip('elsewhere', 'v1', 0, 9.9, 't2'), clip('go', 'v1', 10, 2)], ['go']), 10);
  assert.equal(forwardRoom([clip('stay', 'v1', 0, 4, 't2'), clip('go', 'v1', 10, 2, 't2'), clip('mine', 'v1', 0, 9.9)], ['go']), 6);
});

test('room: a moving set holding linked peers on two tracks takes the tighter side', () => {
  const clips = [clip('vStay', 'v1', 0, 17), clip('aStay', 'a1', 0, 18.5), clip('v', 'v1', 20, 10), clip('a', 'a1', 20, 10)];
  assert.equal(forwardRoom(clips, ['v', 'a']), 1.5);
});

test('color next/previous edit steps shot starts; a long overlay starting with a shot never takes the step', () => {
  // The volleyball edit: a logo on V3 from 11 s to 96 s starts on the same frame as the V1 shot, and V1 has a gap.
  const tracks = [track('v1', { number: 1 }), track('v3', { number: 3 }), track('v2', { number: 2, hidden: true })];
  const shots = [clip('s5', 'v1', 6.917, 4.083), clip('logo', 'v3', 11, 85.494), clip('s6', 'v1', 11, 2.109), clip('s7', 'v1', 13.125, 1.894), clip('hid', 'v2', 12, 1)];
  const step = (at: number, direction: number) => adjacentShot(shots, tracks, at, direction, 24)?.id;
  assert.equal(step(9, 1), 's6');
  assert.equal(step(11, 1), 's7', 'the end of s6 and the hidden shot are not stops');
  assert.equal(step(13.125, -1), 's6');
  assert.equal(step(12, -1), 's6', 'previous from inside a shot goes to its start');
  assert.equal(step(13.125, 1), undefined);
});
