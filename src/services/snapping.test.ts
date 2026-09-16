import test from 'node:test';
import assert from 'node:assert/strict';
import { lockedAxis, overlayBoxes, shapeBox, snapBox, snapTime, textBox } from './snapping.ts';
import { defaultShape } from './shapes.ts';
import { presetDocument } from './text.ts';
import type { Clip, Track } from '../state/models.ts';

const clip = (id: string, mediaId: string, properties: Clip['properties']): Clip =>
  ({ id, timelineId: 't', trackId: 'v1', mediaId, name: id, start: 0, duration: 10, sourceIn: 0, color: '#fff', properties }) as Clip;

test('a box snaps to the nearest frame line and reports the guide to draw', () => {
  const near = { x: .251, y: .4, width: .5, height: .2 };
  const centred = snapBox(near, [], { x: .01, y: .01 });
  // The box centre (.501) is nearer the frame centre than its left edge is to anything else.
  assert.ok(Math.abs(centred.dx + .001) < 1e-9);
  assert.deepEqual(centred.guides, [{ axis: 'x', at: .5 }, { axis: 'y', at: .5 }]);
  assert.deepEqual(snapBox({ x: .004, y: .9, width: .2, height: .2 }, [], { x: .01, y: .01 }).guides, [{ axis: 'x', at: 0 }, { axis: 'y', at: 1 }]);
  // Out of range, and axes Shift has locked, are both left alone.
  assert.deepEqual(snapBox({ x: .2, y: .3, width: .13, height: .17 }, [], { x: .001, y: .001 }), { dx: 0, dy: 0, guides: [] });
  assert.deepEqual(snapBox(near, [], { x: .01, y: .01 }, { x: false, y: true }).guides, [{ axis: 'y', at: .5 }]);
});

test('another object edge wins when it is closer than the frame', () => {
  const other = { x: .7, y: 0, width: .2, height: 1 };
  const result = snapBox({ x: .62, y: .4, width: .1, height: .2 }, [other], { x: .05, y: .001 });
  assert.equal(result.guides[0].at, .7);           // right edge .72 → the neighbour's left edge
  assert.ok(Math.abs(result.dx + .02) < 1e-9);
});

test('nearest match wins, not the first one offered', () => {
  assert.equal(snapTime([5], [0, 4, 5.4, 12], 1)!.at, 5.4);
  assert.equal(snapTime([5, 9], [9.2], .5)!.at, 9.2);  // the clip's end can snap too
  assert.equal(snapTime([5], [0, 12], 1), null);
});

test('Shift picks the axis travelled furthest in screen pixels, and keeps re-deciding', () => {
  assert.equal(lockedAxis(4, -90), 'y');
  assert.equal(lockedAxis(-120, 30), 'x');
});

test('boxes follow the clip transform, and moving the document moves them one for one', () => {
  const shape = clip('s', 'frameline-shape', { zoom: 50, x: 192, shapeDocument: JSON.stringify(defaultShape()) });
  const doc = defaultShape(), box = shapeBox(shape, doc, 1920, 1080);
  assert.ok(Math.abs(box.width - doc.width / 2) < 1e-9);
  assert.ok(Math.abs(shapeBox(shape, { ...doc, x: doc.x + .1 }, 1920, 1080).x - (box.x + .1)) < 1e-9);
  const title = clip('t', 'frameline-title', { zoom: 50, y: -108, textDocument: JSON.stringify(presetDocument(0)) });
  const text = presetDocument(0), area = textBox(title, text, 1920, 1080);
  assert.ok(Math.abs(area.y - (.5 + .5 * (text.y - .5) - .1)) < 1e-9);
  assert.ok(Math.abs(textBox(title, { ...text, x: text.x + .1 }, 1920, 1080).x - (area.x + .05)) < 1e-9);

  const tracks = [{ id: 'v1', timelineId: 't', kind: 'video', number: 1, name: 'V1' }] as Track[];
  const state = { clips: [shape, title, { ...clip('h', 'frameline-title', title.properties), trackId: 'v9' }], tracks, timelineId: 't', playhead: 1 };
  assert.equal(overlayBoxes(state, 1920, 1080).length, 3);        // every title and shape under the playhead
  assert.equal(overlayBoxes(state, 1920, 1080, 's').length, 2);   // minus the one being dragged
});
