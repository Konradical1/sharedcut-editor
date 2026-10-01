import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { useEditorStore as store } from './store.ts';
import { forwardRoom } from '../services/selection.ts';
import type { Clip, Timeline, Track } from './models.ts';

// Select Forward proven end to end on a real timeline layout (anonymised from "Part 1 v2": 413 clips, 16 tracks, a
// caption track, float drift in stored times) and on seeded generated timelines. Every line below is exercised the same way:
// (a) the selection, (b) a plain move +2 s and its undo, (c) cut through then move +2 s, move back by the room, three undos.
// The oracles are written out here from the contract, not taken from selection.ts, so a bug there cannot hide itself.
const baseline = store.getState();
const state = () => store.getState();
const TL = 'main-timeline', PROJECT = 'city-after-dark', TOL = 1e-9, SHIFT = 2;
const proto = baseline.clips.find(c => c.id === 'c7')!, trackProto = baseline.tracks.find(t => t.id === 'v1')!;
beforeEach(() => store.setState({ ...baseline, locks: [], operations: [], notifications: [] }, true));

interface Layout { fps: number; duration: number; tracks: { id: string; kind: 'video' | 'audio'; number: number; locked: boolean; hidden: boolean; muted: boolean; captionSets?: { id: string; start: number; end: number; wordsPerLine: number; preset: string; trackIds: string[] }[] }[]; clips: { id: string; trackId: string; mediaId: string; start: number; duration: number; sourceIn: number; disabled: boolean; properties: Record<string, number | string | boolean> }[] }
const layout = JSON.parse(readFileSync(new URL('./fixtures/part1-v2-layout.json', import.meta.url), 'utf8')) as Layout;

const track = (id: string, kind: 'video' | 'audio', number: number, o: Partial<Track> = {}): Track => ({ ...trackProto, id, timelineId: TL, name: id, kind, number, locked: false, hidden: false, muted: false, ...o });
const piece = (id: string, trackId: string, start: number, duration: number, o: Partial<Clip> = {}): Clip => ({ ...structuredClone(proto), id, name: id, trackId, timelineId: TL, start, duration, sourceIn: 0, ...o, properties: { ...proto.properties, ...o.properties } });
// A clip of another timeline that must never be selected, moved or cut.
const decoys = () => Array.from({ length: 40 }, (_, i) => piece(`decoy${i}`, 'v1-review', i * 3, 2, { timelineId: 'review-timeline' }));
interface Scene { fps: number; tracks: Track[]; clips: Clip[]; timelines?: Timeline[] }
const load = (s: Scene) => {
  const end = Math.max(0, ...s.clips.map(c => c.start + c.duration));
  store.setState({
    ...baseline, locks: [], operations: [], notifications: [], comments: [], nodes: [], selectedClipId: null, selectedClipIds: [],
    projects: baseline.projects.map(p => p.id === PROJECT ? { ...p, fps: s.fps } : p),
    // moveClip clamps to the timeline length when no server is connected, so leave room past the last clip.
    timelines: [...baseline.timelines.map(t => ({ ...t, duration: end + 100 })), ...(s.timelines ?? [])],
    tracks: [...s.tracks, ...baseline.tracks.filter(t => t.timelineId !== TL)], clips: [...s.clips, ...decoys()],
    settings: { ...baseline.settings, linkSelection: true },
  }, true);
};
const fixtureScene = (locked: string[] = []): Scene => ({
  fps: layout.fps,
  tracks: layout.tracks.map(t => track(t.id, t.kind, t.number, { locked: t.locked || locked.includes(t.id), hidden: t.hidden, muted: t.muted, ...(t.captionSets ? { captionSets: t.captionSets.map(s => ({ ...s, signature: '', jobId: '' })) } : {}) })),
  clips: layout.clips.map(c => piece(c.id, c.trackId, c.start, c.duration, { mediaId: c.mediaId, sourceIn: c.sourceIn, disabled: c.disabled, properties: c.properties })),
});

// ---- oracles ----------------------------------------------------------------------------------------------------
const fpsNow = () => state().projects.find(p => p.id === PROJECT)!.fps;
const hereClips = (clips: readonly Clip[]) => clips.filter(c => c.timelineId === TL);
const openTracks = () => new Set(state().tracks.filter(t => t.timelineId === TL && !t.locked).map(t => t.id));
/** Spec (a): every clip of this timeline on an unlocked track that starts at or after the line, less half a frame. */
const forwardIds = (clips: readonly Clip[], line: number) => { const open = openTracks(), slack = .5 / fpsNow(); return hereClips(clips).filter(c => open.has(c.trackId) && c.start >= line - slack).map(c => c.id).sort(); };
/** The clips cutThrough must split: they run across the line by more than half a frame, and both pieces are at least a frame long. */
const cutSet = (clips: readonly Clip[], line: number) => { const open = openTracks(), fps = fpsNow(); return hereClips(clips).filter(c => open.has(c.trackId) && c.start < line - .5 / fps && c.start + c.duration > line + .5 / fps && Math.min(line - c.start, c.start + c.duration - line) >= 1 / fps - 1e-6); };
/** Linked selection: a clip drags its link group along. */
const withLinks = (ids: readonly string[]) => { const set = new Set(ids), groups = new Set(state().clips.filter(c => set.has(c.id) && c.properties.linkGroup !== undefined).map(c => c.properties.linkGroup)); return new Set([...set, ...state().clips.filter(c => c.timelineId === TL && c.properties.linkGroup !== undefined && groups.has(c.properties.linkGroup)).map(c => c.id)]); };
const byId = (id: string) => state().clips.find(c => c.id === id)!;
const json = (clips: readonly Clip[]) => new Map(clips.map(c => [c.id, JSON.stringify(c)]));
// A cut also records fade bookkeeping (fadeOrigin, fadeDuration) and an empty keyframe map on both pieces, as a playhead split does.
const strip = (c: Clip) => { const { linkGroup, fadeOrigin, fadeDuration, ...properties } = c.properties; return JSON.stringify({ ...c, id: 0, start: 0, duration: 0, sourceIn: 0, keyframes: 0, properties }); };
const noLinkJson = (c: Clip) => { const { linkGroup, ...properties } = c.properties; return JSON.stringify({ ...c, properties }); };
const near = (a: number, b: number, why: string) => assert.ok(Math.abs(a - b) < TOL, `${why}: ${a} vs ${b}`);

/** After an edit: nothing added or removed, the moving clips are exactly `delta` later on their own tracks, every other clip is as it was. */
function movedBy(why: string, before: readonly Clip[], moving: ReadonlySet<string>, delta: number) {
  const now = state().clips, was = json(before), olds = new Map(before.map(c => [c.id, c]));
  assert.equal(now.length, before.length, `${why}: no clip added or removed`);
  for (const c of now) {
    const old = olds.get(c.id);
    assert.ok(old, `${why}: ${c.id} was there before`);
    if (moving.has(c.id)) { near(c.start, old.start + delta, `${why}: ${c.id} moved by ${delta}`); assert.equal(JSON.stringify({ ...old, start: c.start }), JSON.stringify(c), `${why}: ${c.id} changed more than its start`); }
    else assert.equal(was.get(c.id), JSON.stringify(c), `${why}: ${c.id} must not change`);
  }
}
const total = (clips: readonly Clip[]) => { const sums = new Map<string, number>(); for (const c of hereClips(clips)) sums.set(c.trackId, (sums.get(c.trackId) ?? 0) + c.duration); return sums; };
function noOverlap(why: string) {
  const lanes = new Map<string, Clip[]>();
  for (const c of hereClips(state().clips)) (lanes.get(c.trackId) ?? lanes.set(c.trackId, []).get(c.trackId)!).push(c);
  for (const [id, lane] of lanes) { lane.sort((a, b) => a.start - b.start); for (let i = 1; i < lane.length; i++) assert.ok(lane[i].start >= lane[i - 1].start + lane[i - 1].duration - 1e-6, `${why}: ${lane[i - 1].id} and ${lane[i].id} overlap on ${id}`); }
}
/** The moving set's own room to slide left, worked out per lane: the gap to the last clip that stays behind, or to time zero. */
function roomOf(moving: ReadonlySet<string>) {
  let room = Infinity;
  for (const c of hereClips(state().clips)) if (moving.has(c.id)) {
    let edge = 0;
    for (const o of hereClips(state().clips)) if (!moving.has(o.id) && o.trackId === c.trackId && o.start < c.start) edge = Math.max(edge, o.start + o.duration);
    room = Math.min(room, c.start - edge);
  }
  return room;
}
/** Any selected clip can be the one grabbed in a drag; vary it with the line so captions, audio and right halves all take a turn. */
const handleOf = (ids: readonly string[], line: number, salt: number) => ids[(Math.floor(line * 997) + salt) % ids.length];
const opsLive = () => state().operations.filter(o => !o.undone).length;
// What the lines actually exercised, so a generator that quietly stops producing links, captions or compositions fails loudly.
const seen: Record<string, number> = {};
const tick = (key: string, n = 1) => { if (n) seen[key] = (seen[key] ?? 0) + n; };
const reset = () => { for (const key of Object.keys(seen)) delete seen[key]; };

// ---- the three phases -------------------------------------------------------------------------------------------
/** (a) the selection, for the line itself and for a pointer a fraction of a frame either side of it. */
function phaseSelect(why: string, line: number, anchor?: Clip) {
  const ops = state().operations.length, fps = fpsNow();
  for (const [name, at] of [['line', line], ['line + 0.4 frame', line + .4 / fps], ['line + 0.6 frame', line + .6 / fps]] as const) {
    state().selectForward({ time: at });
    assert.deepEqual([...state().selectedClipIds].sort(), forwardIds(state().clips, at), `${why}: selection from ${name}`);
    assert.equal(state().selectedClipId, state().selectedClipIds.at(-1) ?? null, `${why}: the last picked clip is the primary`);
  }
  if (anchor) {
    state().selectForward({ clipId: anchor.id });
    assert.deepEqual([...state().selectedClipIds].sort(), forwardIds(state().clips, anchor.start), `${why}: selection from clip ${anchor.id}`);
    if (forwardIds(state().clips, anchor.start).includes(anchor.id)) assert.equal(state().selectedClipId, anchor.id, `${why}: the clicked clip is the primary`);
  }
  assert.equal(state().operations.length, ops, `${why}: selecting is not an edit`);
}
/** (b) a plain forward drag of +2 s, then undo. */
function phaseMove(why: string, line: number, anchor?: Clip) {
  const original = state().clips, originalJson = JSON.stringify(original);
  state().selectForward(anchor ? { clipId: anchor.id } : { time: line });
  const ids = [...state().selectedClipIds], primary = state().selectedClipId;
  if (!ids.length) { assert.equal(primary, null, `${why}: nothing ahead, no primary`); return; }
  const handle = handleOf(ids, line, 0);
  const moving = withLinks(ids), ops = opsLive();
  // A group straddling the line drags its members from before it along: that is linked selection, not Select Forward, so it is only counted.
  if (moving.size !== ids.length) { tick('pulled'); return; }
  tick('moves'); tick('movedClips', ids.length); tick('movedLinked', ids.some(id => byId(id).properties.linkGroup !== undefined) ? 1 : 0);
  state().moveClip(handle, byId(handle).start + SHIFT);
  assert.equal(opsLive(), ops + 1, `${why}: a move is one undo step`);
  movedBy(`${why} move`, original, moving, SHIFT);
  noOverlap(`${why} move`);
  state().undo();
  assert.equal(JSON.stringify(state().clips), originalJson, `${why}: undo restores every clip`);
}
/** (c) cut through, move +2 s, move back by the room, then three undos. */
function phaseCut(why: string, line: number, anchor?: Clip) {
  const fps = fpsNow(), original = state().clips, originalJson = JSON.stringify(original), originalTimelines = JSON.stringify(state().timelines), originalTracks = JSON.stringify(state().tracks);
  state().selectForward(anchor ? { clipId: anchor.id } : { time: line });
  const ids = [...state().selectedClipIds], primary = state().selectedClipId, ops = opsLive();
  const cut = cutSet(original, line), open = openTracks(), crossing = hereClips(original).filter(c => open.has(c.trackId) && c.start < line - .5 / fps && c.start + c.duration > line + .5 / fps);
  tick('lines'); tick('cut', cut.length); tick('slivers', crossing.length - cut.length); tick('emptyCut', ids.length ? 0 : 1);
  for (const c of cut) { tick('cutLinked', c.properties.linkGroup ? 1 : 0); tick('cutComposition', c.mediaId === 'frameline-composition' ? 1 : 0); tick('cutCaption', c.properties.captionSet ? 1 : 0); tick('cutReverse', c.properties.reverse ? 1 : 0); tick('cutFreeze', c.properties.freeze ? 1 : 0); tick('cutSpeed', Number(c.properties.speed) !== 100 ? 1 : 0); }
  assert.equal(state().cutThrough(line), cut.length, `${why}: clips cut`);
  assert.equal(opsLive(), ops + (cut.length ? 1 : 0), `${why}: the cut is one undo step`);
  const afterCut = state().clips, afterCutJson = JSON.stringify(afterCut), afterCutAt = new Map(afterCut.map(c => [c.id, c.start])), known = new Set(original.map(c => c.id)), here = new Set(original.map(c => c.timelineId));
  const fresh = afterCut.filter(c => !known.has(c.id)), freshHere = fresh.filter(c => c.timelineId === TL);
  assert.equal(freshHere.length, cut.length, `${why}: one right half per cut clip`);
  assert.ok(fresh.every(c => c.timelineId === TL || !here.has(c.timelineId)), `${why}: copies of a composition's contents go to a new timeline only`);
  const cutIds = new Set(cut.map(c => c.id)), rightOf = new Map<string, Clip>();
  for (const c of original) if (!cutIds.has(c.id)) assert.equal(noLinkJson(byId(c.id)), noLinkJson(c), `${why}: ${c.id} was not cut and must not change`);
  for (const c of cut) {
    const offset = line - c.start, speed = Number(c.properties.speed || 100), left = byId(c.id), right = freshHere.find(f => f.trackId === c.trackId)!;
    assert.ok(right, `${why}: right half of ${c.id} on ${c.trackId}`);
    rightOf.set(c.id, right);
    assert.equal(left.start, c.start, `${why}: left half of ${c.id} keeps its start`);
    near(left.start + left.duration, line, `${why}: left half of ${c.id} ends at the line`);
    near(right.start, line, `${why}: right half of ${c.id} starts at the line`);
    near(right.duration, c.duration - offset, `${why}: right half of ${c.id} lasts the rest`);
    near(left.sourceIn, c.properties.reverse ? c.sourceIn + (c.duration - offset) * speed / 100 : c.sourceIn, `${why}: left source of ${c.id}`);
    near(right.sourceIn, c.properties.freeze || c.properties.reverse ? c.sourceIn : c.sourceIn + offset * speed / 100, `${why}: right source of ${c.id}`);
    assert.equal(strip(left), strip(c), `${why}: left half of ${c.id} is the same clip otherwise`);
    assert.equal(strip(right), strip(c), `${why}: right half of ${c.id} is the same clip otherwise`);
  }
  // Links: the left halves and everything that stays behind keep the old group; the right halves and the peers that move with them share one new group,
  // unless that would be a group of one. A group the cut did not touch is not renamed.
  const groups = new Map<unknown, Clip[]>();
  for (const c of hereClips(original)) if (c.properties.linkGroup !== undefined) groups.set(c.properties.linkGroup, [...groups.get(c.properties.linkGroup) ?? [], c]);
  for (const [group, members] of groups) {
    const cutMembers = members.filter(m => cutIds.has(m.id)), movers = [...cutMembers.map(m => rightOf.get(m.id)!), ...members.filter(m => ids.includes(m.id))];
    for (const m of members) if (cutIds.has(m.id) || !ids.includes(m.id)) assert.equal(byId(m.id).properties.linkGroup, group, `${why}: ${m.id} stays in link group ${String(group)}`);
    if (!cutMembers.length) { for (const m of members) assert.equal(byId(m.id).properties.linkGroup, group, `${why}: untouched group ${String(group)} keeps its name`); continue; }
    tick('linkGroupsCut');
    const now = movers.map(m => byId(m.id).properties.linkGroup);
    if (movers.length > 1) {
      assert.ok(now[0] !== undefined && now[0] !== group && now.every(g => g === now[0]), `${why}: the right halves and their moving peers share one new link group, got ${now.map(String)}`);
      assert.equal(afterCut.filter(c => c.properties.linkGroup === now[0]).length, movers.length, `${why}: the new link group holds only them`);
    } else assert.equal(now[0], undefined, `${why}: a right half alone in its group is not linked`);
  }
  // The selection after the cut is exactly what a fresh Select Forward at the line would take: right halves in, left halves out.
  assert.deepEqual([...state().selectedClipIds].sort(), forwardIds(afterCut, line), `${why}: the right halves joined the selection`);
  assert.deepEqual([...state().selectedClipIds].sort(), [...ids, ...freshHere.map(c => c.id)].sort(), `${why}: selection is the old one plus the right halves`);
  assert.equal(state().selectedClipId, primary ?? freshHere.at(-1)?.id ?? null, `${why}: the primary stays the primary`);
  if (!state().selectedClipIds.length) { assert.equal(JSON.stringify(state().clips), afterCutJson); return; }
  const moving = withLinks(state().selectedClipIds);
  tick('movedCut', state().selectedClipIds.length); tick('lockedLines', state().tracks.some(t => t.timelineId === TL && t.locked) ? 1 : 0);
  // A group that still reaches back behind the line (a member that ends before it, or a sliver left whole) takes that member along on a drag: linked selection, not Select Forward. Stop at undoing the cut.
  if (moving.size !== state().selectedClipIds.length) {
    tick('pulledAfterCut');
    if (cut.length) state().undo();
    assert.equal(JSON.stringify(state().clips), originalJson, `${why}: undo of the cut restores every clip`);
    return;
  }
  const lead = handleOf([...state().selectedClipIds], line, 1);
  state().moveClip(lead, byId(lead).start + SHIFT);
  movedBy(`${why} cut+move`, afterCut, moving, SHIFT);
  noOverlap(`${why} cut+move`);
  const afterMove = state().clips, afterMoveJson = JSON.stringify(afterMove);
  for (const c of cut) {
    const left = byId(c.id), right = freshHere.find(f => f.trackId === c.trackId)!;
    near(byId(right.id).start, line + SHIFT, `${why}: right half of ${c.id} moved`);
    near(left.start + left.duration, line, `${why}: left half of ${c.id} stayed at the line`);
  }
  const before = total(original), after = total(afterMove);
  for (const [id, sum] of before) near(after.get(id) ?? 0, sum, `${why}: covered duration of ${id}`);
  const room = forwardRoom(state().clips, [...moving]);
  near(room, roomOf(moving), `${why}: forwardRoom`);
  assert.ok(room >= SHIFT - 1e-6, `${why}: room ${room} must be at least the distance moved`);
  if (cut.length) assert.ok(Math.abs(room - SHIFT) < 1 / fps, `${why}: room ${room} is the ${SHIFT} s the cut left open`);
  tick('roomWide', room > SHIFT + 1e-6 ? 1 : 0); tick('roomTight', Math.abs(room - SHIFT) < TOL ? 1 : 0);
  state().moveClip(lead, byId(lead).start - room);
  movedBy(`${why} move back`, afterMove, moving, -room);
  noOverlap(`${why} move back`);
  if (Math.abs(room - SHIFT) < TOL) for (const id of moving) near(byId(id).start, afterCutAt.get(id)!, `${why}: ${id} is back where the cut left it`);
  assert.equal(state().clips.length, afterMove.length, `${why}: moving back trims and deletes nothing`);
  state().undo();
  assert.equal(JSON.stringify(state().clips), afterMoveJson, `${why}: undo of the move back`);
  state().undo();
  assert.equal(JSON.stringify(state().clips), afterCutJson, `${why}: undo of the move`);
  if (cut.length) state().undo();
  assert.equal(JSON.stringify(state().clips), originalJson, `${why}: undo of the cut restores every clip`);
  assert.equal(JSON.stringify(state().timelines), originalTimelines, `${why}: timelines restored`);
  assert.equal(JSON.stringify(state().tracks), originalTracks, `${why}: tracks restored`);
  assert.equal(opsLive(), ops, `${why}: every step undone`);
}

// ---- lines to try -----------------------------------------------------------------------------------------------
/** Every distinct clip start, each with one of the clips that start there, plus evenly spaced times that fall on no particular cut. */
function realLines() {
  const clips = hereClips(state().clips), starts = new Map<number, Clip[]>();
  for (const c of clips) starts.set(c.start, [...starts.get(c.start) ?? [], c]);
  const end = Math.max(...clips.map(c => c.start + c.duration)), lines: { line: number; anchor?: Clip }[] = [...starts].map(([line, here], i) => ({ line, anchor: here[i % here.length] }));
  for (let i = 1; i <= 20; i++) lines.push({ line: end * i / 21 + .0137 });
  lines.push({ line: 0 }, { line: end }, { line: end + 5 });
  return lines;
}

test('real layout: Select Forward from every clip start and from empty space takes exactly the later clips on unlocked tracks', () => {
  load(fixtureScene());
  const lines = realLines();
  assert.ok(lines.length > 300, `${lines.length} lines tried`);
  for (const { line, anchor } of lines) phaseSelect(`real ${line}`, line, anchor);
  // Hidden and muted tracks are included, other timelines never are.
  state().selectForward({ time: 0 });
  assert.equal(state().selectedClipIds.length, layout.clips.length);
  assert.ok(layout.tracks.some(t => t.hidden) && layout.tracks.some(t => t.muted), 'the fixture has hidden and muted tracks');
  assert.ok(state().selectedClipIds.every(id => !id.startsWith('decoy')));
});

test('real layout: a forward drag of +2 s moves exactly the selection, touches nothing else, and one undo restores it', () => {
  load(fixtureScene()); reset();
  for (const { line, anchor } of realLines()) phaseMove(`real ${line}`, line, anchor);
  assert.ok(seen.moves > 300 && seen.movedClips > 10000, JSON.stringify(seen));
});

test('real layout: cut through, drag +2 s, drag back by the room, undo three times, at every clip start', () => {
  load(fixtureScene()); reset();
  for (const { line, anchor } of realLines()) phaseCut(`real ${line}`, line, anchor);
  for (const [key, least] of Object.entries({ lines: 300, cut: 1500, slivers: 1, cutCaption: 1, cutSpeed: 1, cutFreeze: 1, roomTight: 250 })) assert.ok((seen[key] ?? 0) >= least, `${key} ${seen[key]} < ${least} in ${JSON.stringify(seen)}`);
});

test('real layout: locked tracks never join the selection, move or get cut, and a long cut still undoes in three steps', () => {
  load(fixtureScene(['t12', 't13', 't15']));
  const lines = realLines().filter((_, i) => i % 4 === 0);
  for (const { line, anchor } of lines) {
    const locked = new Set(layout.clips.filter(c => ['t12', 't13', 't15'].includes(c.trackId)).map(c => c.id));
    phaseSelect(`locked ${line}`, line, anchor);
    assert.ok(state().selectedClipIds.every(id => !locked.has(id)), `locked ${line}: no locked clip selected`);
    phaseMove(`locked ${line}`, line, anchor);
    phaseCut(`locked ${line}`, line, anchor);
  }
});

test('real layout: the fixture really carries float drift, crossings, slivers and non-frame times', () => {
  load(fixtureScene());
  const clips = hereClips(state().clips), starts = [...new Set(clips.map(c => c.start))], fps = fpsNow();
  assert.equal(clips.length, 413);
  assert.equal(state().tracks.filter(t => t.timelineId === TL).length, 16);
  assert.ok(clips.some(c => starts.some(s => s !== c.start + c.duration && Math.abs(s - (c.start + c.duration)) < 1e-6)), 'a clip ends a hair off another clip’s start');
  assert.ok(clips.some(c => Math.abs(c.start * fps - Math.round(c.start * fps)) > 1e-6), 'times off the frame grid');
  // A clip ending a hair past the line is not crossing it: no cut, no half left behind.
  const drift = clips.find(c => starts.some(s => s !== c.start + c.duration && Math.abs(s - (c.start + c.duration)) < 1e-6 && s > c.start))!;
  const line = starts.find(s => s !== drift.start + drift.duration && Math.abs(s - (drift.start + drift.duration)) < 1e-6)!;
  assert.ok(!cutSet(state().clips, line).some(c => c.id === drift.id));
  state().selectForward({ time: line });
  state().cutThrough(line);
  assert.equal(byId(drift.id).duration, drift.duration, 'the drifting clip is left whole');
});

test('the current timeline decides: with another timeline open only its clips are selected and moved', () => {
  load(fixtureScene());
  store.setState({ timelineId: 'review-timeline' });
  const before = state().clips, review = before.filter(c => c.timelineId === 'review-timeline');
  state().selectForward({ time: 30 });
  assert.deepEqual([...state().selectedClipIds].sort(), review.filter(c => c.start >= 30).map(c => c.id).sort());
  assert.ok(review.length === 40 && state().selectedClipIds.length === 30);
  state().moveClip(state().selectedClipId!, byId(state().selectedClipId!).start + SHIFT);
  movedBy('review timeline', before, new Set(state().selectedClipIds), SHIFT);
  assert.ok(hereClips(state().clips).every((c, i) => JSON.stringify(c) === JSON.stringify(hereClips(before)[i])), 'the main timeline is untouched');
});

test('a selected clip linked to a clip on a locked track: the whole drag is refused, nothing moves by halves', () => {
  const link = { ...proto.properties, linkGroup: 'L' };
  load({ fps: 24, tracks: [track('v1', 'video', 1), track('v2', 'video', 2), track('a1', 'audio', 1, { locked: true })], clips: [piece('V', 'v1', 10, 10, { properties: link }), piece('A', 'a1', 10, 10, { properties: link }), piece('W', 'v2', 30, 5)] });
  state().selectForward({ time: 5 });
  assert.deepEqual([...state().selectedClipIds], ['W'], 'the locked track stays out of the selection, and V with it: its partner would not move');
  // A hand-made selection can still hold V; moving it is then refused as a whole.
  state().selectClips(['V', 'W']);
  const before = state().clips;
  state().moveClip('W', 32);
  assert.deepEqual(state().clips, before);
  assert.equal(state().operations.length, 0);
});

// ---- generated timelines ----------------------------------------------------------------------------------------
const mulberry32 = (seed: number) => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60], CASES = 300, ANCHORS = 3;
function generate(seed: number): { scene: Scene; lines: { line: number; anchor?: Clip }[] } {
  const rnd = mulberry32(seed), int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1)), pick = <T,>(xs: T[]) => xs[int(0, xs.length - 1)], chance = (p: number) => rnd() < p;
  const fps = pick(FPS), frame = 1 / fps, snap = (x: number) => chance(.5) ? Math.max(frame, Math.round(x * fps) / fps) : x;
  const tracks: Track[] = [], counts = { video: 0, audio: 0 }, total = int(1, 19);
  for (let i = 0; i < total; i++) { const kind = chance(.5) ? 'video' : 'audio'; tracks.push(track(`g${seed}t${i}`, kind, ++counts[kind])); }
  if (chance(.3)) tracks.push(track(`g${seed}cap`, 'video', ++counts.video, { captionSets: [{ id: 'set', start: 0, end: 100, signature: '', trackIds: [], wordsPerLine: 3, preset: 'reel', jobId: '' }] }));
  for (let i = int(0, 3); i > 0; i--) pick(tracks).locked = true;
  const plain = tracks.filter(t => !t.captionSets), videos = plain.filter(t => t.kind === 'video' && !t.locked), audios = plain.filter(t => t.kind === 'audio' && !t.locked);
  const cursor = new Map(tracks.map(t => [t.id, chance(.4) ? 0 : rnd() * 5])), clips: Clip[] = [], timelines: Timeline[] = [];
  const gap = () => chance(.3) ? 0 : chance(.15) ? rnd() * 1e-6 : chance(.3) ? rnd() * frame : rnd() * 4;
  const dur = (max: number) => snap(.1 + rnd() * (chance(.2) ? max * 3 : max));
  const props = () => ({ speed: pick([100, 100, 100, 100, 50, 200, 25, 150]), reverse: chance(.08), freeze: chance(.05) });
  const put = (t: Track, start: number, duration: number, o: Partial<Clip>) => { clips.push(piece(`g${seed}c${clips.length}`, t.id, start, duration, { sourceIn: snap(rnd() * 30), disabled: chance(.05), ...o })); cursor.set(t.id, start + duration); };
  const withComposition = chance(.25) && videos.length > 0;
  if (withComposition) {
    timelines.push({ id: 'comp-inner', projectId: PROJECT, name: 'Inner', duration: 20, composition: true });
    tracks.push({ ...track('comp-v1', 'video', 1), timelineId: 'comp-inner' });
    clips.push(piece('comp-a', 'comp-v1', 0, 12, { timelineId: 'comp-inner' }), piece('comp-b', 'comp-v1', 12, 8, { timelineId: 'comp-inner' }));
  }
  for (let n = int(chance(.08) ? 0 : 10, 160); n > 0; n--) {
    const roll = rnd();
    if (roll < .12 && videos.length && audios.length) {
      const v = pick(videos), a = pick(audios), start = Math.max(cursor.get(v.id)!, cursor.get(a.id)!) + gap(), duration = dur(8), p = { ...props(), linkGroup: `L${clips.length}` };
      put(v, start, duration, { properties: p as Clip['properties'] }); put(a, start, chance(.3) ? Math.max(frame, duration - rnd() * duration * .5) : duration, { properties: p as Clip['properties'] });
    } else if (roll < .18 && videos.length && audios.length) {
      // A group that straddles later lines: a pair plus a third clip that starts after them, as when a group is edited apart.
      const v = pick(videos), a = pick(audios), w = pick(plain.filter(t => !t.locked && t !== v && t !== a).concat(v)), start = Math.max(cursor.get(v.id)!, cursor.get(a.id)!) + gap(), duration = dur(8), p = { ...props(), linkGroup: `L${clips.length}` };
      put(v, start, duration, { properties: p as Clip['properties'] }); put(a, start, duration, { properties: p as Clip['properties'] });
      if (w !== v && w !== a) put(w, Math.max(cursor.get(w.id)!, start + .3 + rnd() * 3), dur(5), { properties: p as Clip['properties'] });
    } else if (roll < .22 && withComposition) {
      const v = pick(videos); put(v, cursor.get(v.id)! + gap(), snap(1 + rnd() * 15), { mediaId: 'frameline-composition', properties: { ...props(), compositionId: 'comp-inner' } as Clip['properties'] });
    } else { const t = pick(plain); put(t, cursor.get(t.id)! + gap(), dur(6), { properties: props() as Clip['properties'] }); }
  }
  const cap = tracks.find(t => t.captionSets);
  if (cap) for (let n = int(0, 60); n > 0; n--) put(cap, cursor.get(cap.id)! + (chance(.5) ? 0 : rnd() * .6), snap(.2 + rnd() * 1.8), { mediaId: 'frameline-title', properties: { captionSet: 'set' } });
  const here = clips.filter(c => c.timelineId === TL), end = Math.max(1, ...here.map(c => c.start + c.duration)), lines: { line: number; anchor?: Clip }[] = [];
  for (let i = 0; i < ANCHORS; i++) {
    const c = here.length ? pick(here) : undefined, kind = int(0, 6);
    if (!c || kind === 6) lines.push({ line: rnd() * (end + 3) });
    else if (kind <= 1) lines.push({ line: c.start, anchor: c });
    else if (kind === 2) lines.push({ line: c.start + c.duration });
    else if (kind === 3) lines.push({ line: Math.max(0, c.start + (chance(.5) ? -.3 : .3) * frame) });
    else if (kind === 4) lines.push({ line: c.start + c.duration - .7 * frame });
    else lines.push({ line: c.start + c.duration * (.2 + rnd() * .6) });
  }
  return { scene: { fps, tracks, clips, timelines }, lines };
}
const generated = (phase: (why: string, line: number, anchor?: Clip) => void) => {
  reset();
  for (let seed = 1; seed <= CASES; seed++) {
    const { scene, lines } = generate(seed);
    load(scene);
    noOverlap(`seed ${seed} generator`);
    for (const { line, anchor } of lines) phase(`seed ${seed} fps ${scene.fps} line ${line}`, line, anchor);
  }
};

test('generated timelines: Select Forward takes exactly the later clips on unlocked tracks, at any fps and off the frame grid', () => generated(phaseSelect));
test('generated timelines: a forward drag moves exactly the selection and one undo restores it, linked pairs included', () => {
  generated(phaseMove);
  assert.ok(seen.moves > 500 && seen.movedLinked > 100 && seen.pulled > 0, JSON.stringify(seen));
});
test('generated timelines: cut through, drag, drag back by the room and undo, with captions, links, locks and compositions', () => {
  generated(phaseCut);
  for (const [key, least] of Object.entries({ lines: 900, cut: 1000, slivers: 10, emptyCut: 1, cutLinked: 100, linkGroupsCut: 50, cutComposition: 10, cutCaption: 10, cutReverse: 10, cutFreeze: 10, cutSpeed: 100, lockedLines: 100, roomTight: 500, roomWide: 10 })) assert.ok((seen[key] ?? 0) >= least, `${key} ${seen[key]} < ${least} in ${JSON.stringify(seen)}`);
});
