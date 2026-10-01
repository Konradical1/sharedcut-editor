import assert from 'node:assert/strict';
import test from 'node:test';
import type { Clip, Track } from '../state/models.ts';
import { companionAudioTrack, filmstripTiles, forwardClickTime, trackGap, uncoveredParts } from './timeline.ts';

test('overwrites preserve left, right, full coverage, adjacency, reverse and freeze offsets', () => {
  const clip = { start: 10, duration: 20, sourceIn: 5, properties: { speed: 200 } } as unknown as Clip;
  const ranges = (start: number, end: number, properties=clip.properties) => uncoveredParts({...clip,properties},start,end).map(c=>[c.start,c.duration,c.sourceIn]);
  assert.deepEqual(ranges(5,15),[[15,15,15]]);
  assert.deepEqual(ranges(25,35),[[10,15,5]]);
  assert.deepEqual(ranges(0,40),[]);
  assert.deepEqual(ranges(30,40),[[10,20,5]]);
  assert.deepEqual(ranges(15,25),[[10,5,5],[25,5,35]]);
  assert.deepEqual(ranges(15,25,{speed:200,reverse:true}),[[10,5,35],[25,5,5]]);
  assert.deepEqual(ranges(15,25,{speed:200,freeze:true}),[[10,5,5],[25,5,5]]);
  // A sub-frame remnant is float residue from the drop, not an edit. Left behind it becomes an
  // invisible clip that still counts as the neighbour at the cut, so transitions find no handles.
  assert.deepEqual(ranges(15,29.999),[[10,5,5]]);
});

test('gap selection merges overlaps and excludes clips and trailing canvas',()=>{
 const clips=[{start:5,duration:5},{start:8,duration:4},{start:15,duration:2}];
 assert.deepEqual(trackGap(clips,0),{start:0,end:5});
 assert.equal(trackGap(clips,10),null);
 assert.deepEqual(trackGap(clips,12),{start:12,end:15});
 assert.equal(trackGap(clips,17),null);
 assert.equal(trackGap([],0),null);
});

test('audio preview picks the same unlocked companion track or describes the new row',()=>{
  const target={timelineId:'t',kind:'video',number:2} as Track;
  const tracks=[{id:'a1',timelineId:'t',kind:'audio',number:1},{id:'a2',timelineId:'t',kind:'audio',number:2,locked:true},{id:'other',timelineId:'other',kind:'audio',number:2}] as Track[];
  assert.equal(companionAudioTrack(tracks,target).id,'a1');
  const pending=companionAudioTrack(tracks.map(t=>({...t,locked:true})),target);
  assert.equal(pending.id,'pending-audio');assert.equal(pending.number,3);assert.equal(pending.locked,false);
});

test('filmstrip tiles follow source time through trim, speed and reverse', () => {
  const clip = (over: Partial<Clip> = {}) => ({ duration: 10, sourceIn: 0, properties: {}, ...over } as Clip);
  const source = { duration: 100, frames: 201 };
  // 800px wide at 80px per tile: ten tiles walking evenly across the first ten seconds of source.
  const plain = filmstripTiles(clip(), source, 80);
  assert.equal(plain.length, 10);
  assert.deepEqual(plain.map(t => t.frame), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  assert.ok(plain.every((t, i) => i === 0 || t.frame > plain[i - 1].frame), 'frames advance, never repeat');

  // A trim pushes every tile later in the source by the same offset.
  assert.deepEqual(filmstripTiles(clip({ sourceIn: 50 }), source, 80).map(t => t.frame), plain.map(t => t.frame + 100));
  // Double speed covers twice the source in the same on-screen width.
  assert.deepEqual(filmstripTiles(clip({ properties: { speed: 200 } }), source, 80).map(t => t.frame), plain.map(t => t.frame * 2));
  // Reverse walks the same frames backwards.
  assert.deepEqual(filmstripTiles(clip({ properties: { reverse: true } }), source, 80).map(t => t.frame), [...plain.map(t => t.frame)].reverse());
  // A freeze holds one frame, which is the one case where repeating is correct.
  assert.deepEqual(new Set(filmstripTiles(clip({ sourceIn: 20, properties: { freeze: true } }), source, 80).map(t => t.frame)), new Set([40]));

  // Tiles stay bounded on a very wide clip by widening instead of multiplying.
  const wide = filmstripTiles(clip({ duration: 3600 }), source, 200, 80, 240);
  assert.equal(wide.length, 240);
  assert.ok(wide[0].tile > 80);
  // Frames never fall outside the sprite, however far a trim or speed reaches past the source.
  assert.ok(filmstripTiles(clip({ sourceIn: 95, properties: { speed: 800 } }), source, 80).every(t => t.frame >= 0 && t.frame <= 200));
});


test('taller filmstrips fit fewer proportional tiles while zoom adds time samples', () => {
  const clip = { duration: 10, sourceIn: 0, properties: {} } as Clip;
  const source = { duration: 100, frames: 201 };
  const short = filmstripTiles(clip, source, 80, 45 * 96 / 54);
  const tall = filmstripTiles(clip, source, 80, 90 * 96 / 54);
  assert.equal(tall.length, short.length / 2);
  assert.equal(tall[0].tile, short[0].tile * 2);
  const zoomed = filmstripTiles(clip, source, 160, 90 * 96 / 54);
  assert.equal(zoomed.length, short.length);
  assert.deepEqual(zoomed.map(t => t.frame), short.map(t => t.frame));
});

test('select forward click lands on a nearby cut exactly, else on a frame, never before zero',()=>{
 const cuts=[0,10,105.07];
 assert.equal(forwardClickTime(105.0,cuts,.1,24),105.07);
 assert.equal(forwardClickTime(104.5,cuts,.1,24),104.5);
 assert.equal(forwardClickTime(104.51,cuts,.1,24),104.5);
 assert.equal(forwardClickTime(105.0,null,.1,24),105);
 assert.equal(forwardClickTime(-3,null,.1,24),0);
 assert.equal(forwardClickTime(.04,cuts,.1,24),0);
});
