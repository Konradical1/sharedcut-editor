import assert from 'node:assert/strict';
import test from 'node:test';
import { groupShots, shotKey, shotsCsv, shotsHtml, shotTakes, takeShotKey, takesIndex, type ShotRow } from './shots.ts';
import type { MediaAsset, ScriptBlock, Shot } from '../state/models.ts';

const shot = (id: string, number: string, order: number, more: Partial<Shot> = {}): Shot => ({ id, projectId: 'p1', number, text: '', order, modifiedAt: 0, ...more });
const media = (id: string, name: string, kind: MediaAsset['kind'] = 'video', projectId = 'p1') => ({ id, name, kind, projectId });

test('shot codes in clip names, never camera or phone names', () => {
  assert.equal(shotKey('03a'), '3A'); assert.equal(shotKey(' 12 b '), '12B'); assert.equal(shotKey(''), ''); assert.equal(shotKey('0'), '0');
  for (const [name, key] of [['3A_take2', '3A'], ['03a-t1', '3A'], ['12', '12'], ['4b.mov', '4B'], ['3A take 2.MOV', '3A'], ['Shot 3A', '3A'], ['sh03a', '3A'], ['Trailer_SH12B_T3', '12B'], ['sc1_sh3a', '3A'], ['shot-7.mp4', '7'], ['12_shot3', '3']] as const) assert.equal(takeShotKey(name), key, name);
  for (const name of ['IMG_0003', 'IMG_0003.JPG', 'C0012', 'C0012.MP4', 'A001C003', 'DSC01234', 'MVI_1234', 'GX010123', '20261023_1530', 'PXL_20261023_153012345.mp4', 'Screen Recording 2026-10-23 at 15.30.12.mov', 'Fresh 2.mov', 'Shower 3', 'sh12345', '3take', '2026 trailer', 'interview']) assert.equal(takeShotKey(name), undefined, name);
});

test('takes: hand links first, then name matches by name, one project only', () => {
  const bin = [media('m1', '3A_take10.mov'), media('m2', '3A_take2.mov'), media('m3', 'sh3a sound.wav', 'audio'), media('m4', '3A_take1.mov', 'video', 'p2'), media('m5', 'b-roll.mov'), media('m6', 'Shot 3A still.jpg', 'image')];
  assert.deepEqual(shotTakes([shot('s1', '03a', 1, { mediaIds: ['m5', 'm2', 'gone', 'm4'] })], bin).get('s1'), ['m5', 'm2', 'm1', 'm6']); // take2 before take10
  assert.deepEqual(shotTakes([shot('s1', '3A', 1)], bin).get('s1'), ['m2', 'm1', 'm6']);
  assert.deepEqual(shotTakes([shot('s1', '', 1)], bin).get('s1'), []);
  // A take is under one shot only, the one its badge points to: hand-linked to 2A (a wrong slate), or the first of two 1As.
  const slate = [media('t1', '1A_take1.mov'), media('t2', 'random_clip.mov')];
  assert.deepEqual([...shotTakes([shot('a', '1A', 1), shot('b', '2A', 2, { mediaIds: ['t1', 't2'] })], slate)], [['a', []], ['b', ['t1', 't2']]]);
  assert.deepEqual([...shotTakes([shot('a', '1A', 1), shot('c', '1a', 2)], slate)], [['a', ['t1']], ['c', []]]);
  const index = takesIndex([shot('s2', '3A', 2), shot('s1', '3a', 1), shot('s3', '5', 3, { mediaIds: ['m1', 'm4'] })], bin);
  assert.equal(index.get('m1'), 's3'); // hand link beats the name match
  assert.equal(index.get('m2'), 's1'); // first shot in order wins a tie
  assert.equal(index.get('m6'), 's1');
  assert.equal(index.has('m3'), false); assert.equal(index.has('m4'), false); assert.equal(index.has('m5'), false);
});

test('shots group under their scenes in reading order', () => {
  const block = (id: string, scriptId: string, kind: ScriptBlock['kind'], text: string, order: number): ScriptBlock => ({ id, projectId: 'p1', scriptId, kind, text, order, modifiedAt: 0 });
  const blocks = [block('b2', 'A', 'scene', 'ext. park', 2), block('b1', 'A', 'scene', 'INT. HOUSE', 1), block('b3', 'A', 'action', 'Kids play.', 3), block('c1', 'B', 'scene', 'INT. CAR', 1), block('x1', 'gone', 'scene', 'INT. LOST', 1)];
  const shots = [shot('s1', '2A', 2, { sceneId: 'b2' }), shot('s2', '2B', 1, { sceneId: 'b2' }), shot('s3', '9', 3, { sceneId: 'b3' }), shot('s4', '10', 4, { sceneId: 'deleted' }), shot('s5', '11', 5), shot('s6', '1A', 6, { sceneId: 'c1' }), shot('s7', '12', 0, { sceneId: 'x1' })];
  const two = groupShots(shots, [{ id: 'B', name: 'Teaser', order: 2 }, { id: 'A', name: 'Feature', order: 1 }], blocks);
  assert.deepEqual(two.map(g => [g.label, g.sceneId, g.scene, g.shots.map(s => s.id)]), [
    ['Feature · 1. INT. HOUSE', 'b1', 1, []], ['Feature · 2. EXT. PARK', 'b2', 2, ['s2', 's1']], ['Teaser · 1. INT. CAR', 'c1', 1, ['s6']], ['No scene', undefined, undefined, ['s7', 's3', 's4', 's5']],
  ]);
  assert.deepEqual(groupShots(shots.slice(0, 2), [{ id: 'A', name: 'Feature', order: 1 }], blocks).map(g => g.label), ['1. INT. HOUSE', '2. EXT. PARK']);
});

test('csv quotes and defuses formulas; html escapes', () => {
  const row: ShotRow = { number: '1A', scene: '1. INT. HOUSE', size: 'CU', movement: 'Push in', text: 'She says "hi", then\nleaves', cast: '=HYPERLINK("x")', location: '+1', notes: '@me', done: true, takes: 2 };
  assert.equal(shotsCsv([row]), 'Shot,Scene,Size,Movement,Description,Cast,Location,Notes,Done,Takes\r\n1A,1. INT. HOUSE,CU,Push in,"She says ""hi"", then\nleaves","\'=HYPERLINK(""x"")",\'+1,\'@me,Yes,2\r\n');
  assert.equal(shotsCsv([{ ...row, text: '-x', cast: '\tx', location: '', notes: 'a,b', done: false }]).split('\r\n')[1], "1A,1. INT. HOUSE,CU,Push in,'-x,'\tx,,\"a,b\",,2");
  const html = shotsHtml([{ ...row, text: '<img src=x onerror=alert(1)>' }], 'Shots & <b>');
  assert.doesNotMatch(html, /<img|<b>/); assert.match(html, /&lt;img src=x/); assert.match(html, /<th[^>]*>Description<\/th>/);
  assert.match(shotsHtml([], 'Shots & <b>', { page: true }), /^<!doctype html>[^]*size: letter landscape[^]*<h1[^>]*>Shots &amp; &lt;b&gt;<\/h1>/);
});
