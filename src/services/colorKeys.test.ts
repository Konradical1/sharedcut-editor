import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, bandKey, dragWindow, frameOf, hueColor, hueKey, invert, multiply, nodeWeights, pickQualifier, pictureToCanvas, unionArc, windowContours, windowFrame, windowHandles, type WindowKind } from './colorKeys.ts';
import { fittedPoint, poseLayerPoint } from './motionTracker.ts';
import { hueOf, opponent, qualifierAlpha, windowAlpha, windowLocal } from './grading.ts';
import { luminanceWeights } from './color.ts';
import type { Clip, GradeNode } from '../state/models.ts';

const near = (a: number, b: number, message: string, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${message}: ${a} vs ${b}`);
const W = [.2126, .7152, .0722];
const clip = (properties: Record<string, unknown> = {}) => ({ id: 'c', projectId: 'p', properties }) as unknown as Clip;
const project = [1920, 1080] as const;
let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

test('picture → canvas is the letterbox and pose playback draws with, and inverts exactly', () => {
  const plain = pictureToCanvas(clip(), [3840, 2160], project);
  assert.deepEqual([apply(plain, 0, 0), apply(plain, 1, 1)], [{ x: 0, y: 0 }, { x: 1920, y: 1080 }]);
  const square = pictureToCanvas(clip(), [1000, 1000], project);
  assert.deepEqual([apply(square, 0, 0), apply(square, 1, 1)], [{ x: 420, y: 0 }, { x: 1500, y: 1080 }], 'a square picture is pillarboxed');
  const posed = clip({ x: 130, y: -45, zoom: 73, rotation: 21, scaleX: 120, scaleY: 85, anchorX: 40, anchorY: -12 }), source = [1440, 1080] as const, m = pictureToCanvas(posed, source, project), back = invert(m);
  for (let i = 0; i < 20; i++) {
    const u = random() * 1.4 - .2, v = random() * 1.4 - .2, want = poseLayerPoint(posed, fittedPoint(u, v, source, project), project), got = apply(m, u, v);
    near(got.x, want.x, 'x', 1e-6); near(got.y, want.y, 'y', 1e-6);
    const round = apply(back, got.x, got.y); near(round.x, u, 'u round trip', 1e-9); near(round.y, v, 'v round trip', 1e-9);
  }
});

test('Flip H: handles and picks follow the mirrored picture playback shows (adjustment clips never flip)', () => {
  const flipped = pictureToCanvas(clip({ flipH: true }), [1920, 1080], project), plain = pictureToCanvas(clip(), [1920, 1080], project);
  assert.deepEqual(apply(flipped, .25, .4), apply(plain, .75, .4), 'circX .25 is drawn where the mirrored grade shows it');
  const back = apply(invert(flipped), 1440, 540); near(back.x, .25, 'a click on the right picks the left of the source'); near(back.y, .5, 'y');
  const adjustment = clip({ flipH: true, adjustment: true }); (adjustment as unknown as { mediaId: string }).mediaId = 'frameline-adjustment';
  assert.deepEqual(apply(pictureToCanvas(adjustment, [1920, 1080], project), .25, .4), apply(plain, .25, .4));
});

test('a window frame is the exact inverse of grading.windowLocal', () => {
  for (let i = 0; i < 20; i++) {
    const aspect = .5 + random() * 2, cx = random(), cy = random(), angle = random() * 720 - 360, f = windowFrame(aspect, cx, cy, angle), u = random() - .5, v = random() - .5;
    const p = apply(f, u, v), [lu, lv] = windowLocal(p.x, p.y, aspect, cx, cy, angle);
    near(lu, u, 'u', 1e-12); near(lv, v, 'v', 1e-12);
    const twice = multiply(invert(f), f), q = apply(twice, u, v); near(q.x, u, 'composed x', 1e-12); near(q.y, v, 'composed y', 1e-12);
  }
});

test('the drawn contours are where the renderer keys: edge ½, inner ring 1, outer ring 0', () => {
  const aspect = 16 / 9, shapes: [WindowKind, Record<string, number>][] = [
    ['circ', { circOn: 1, circX: .4, circY: .55, circW: .3, circH: .18, circAngle: 30, circSoft: .08 }],
    ['rect', { rectOn: 1, rectX: .6, rectY: .4, rectW: .5, rectH: .3, rectAngle: -20, rectSoft: .06, rectRound: .4 }],
    ['rect', { rectOn: 1, rectX: .5, rectY: .5, rectW: .4, rectH: .3, rectAngle: 75, rectSoft: .2, rectRound: .1 }],
    ['grad', { gradOn: 1, gradX: .5, gradY: .3, gradAngle: 35, gradSoft: .25 }],
  ];
  for (const [kind, p] of shapes) {
    const contours = windowContours(kind, p), frame = frameOf(kind, p, aspect);
    for (const [ring, want] of [['edge', .5], ['inner', 1], ['outer', 0]] as const) {
      const points = contours[ring]!;
      assert.ok(points.length >= 2, `${kind} has its ${ring}`);
      // A gradient's lines run far past the frame; check the stretch across the picture.
      for (const [u, v] of kind === 'grad' ? [-.6, -.1, .3, .8].map(t => [t, points[0][1]]) : points) {
        const q = apply(frame, u, v); near(windowAlpha(q.x, q.y, aspect, p), want, `${kind} ${ring} at ${u.toFixed(3)},${v.toFixed(3)}`, 1e-9);
      }
    }
  }
  assert.deepEqual(Object.keys(windowContours('circ', { circSoft: 0 })), ['edge'], 'no feather, no rings');
  assert.equal(windowContours('rect', { rectW: .2, rectH: .1, rectSoft: .3 }).inner, undefined, 'a feather wider than the box has no inside ring');
});

test('handles sit on the shape and the arrow side of a gradient is the graded side', () => {
  const p = { circW: .3, circH: .2, circSoft: .1 }, handles = windowHandles('circ', p);
  assert.deepEqual(handles.filter(h => h.handle === 'w').map(h => h.at), [[.3, 0], [-.3, 0]]);
  const soft = handles.find(h => h.handle === 'soft')!.at, frame = frameOf('circ', { ...p, circOn: 1 }, 1), q = apply(frame, soft[0], soft[1]);
  near(windowAlpha(q.x, q.y, 1, { ...p, circOn: 1 }), 0, 'the feather handle is on the outer ring', 1e-9);
  for (const invert of [0, 1]) {
    const g = { gradOn: 1, gradInvert: invert, gradAngle: 50, gradSoft: .2 }, at = windowHandles('grad', g).find(h => h.handle === 'soft')!.at, f = frameOf('grad', g, 1.5), s = apply(f, at[0], at[1]);
    near(windowAlpha(s.x, s.y, 1.5, g), 1, `the gradient's feather handle is on its graded edge (invert ${invert})`, 1e-9);
  }
});

test('dragging handles: move follows the pointer, rotate turns by the pointer angle, sizes follow the distance', () => {
  const aspect = 16 / 9, p = { circX: .5, circY: .5, circW: .3, circH: .2, circAngle: 0, circSoft: .1 };
  assert.deepEqual(dragWindow('circ', 'move', p, aspect, { x: .5, y: .5 }, { x: .62, y: .45 }), { circX: .62, circY: .45 });
  // A quarter turn clockwise on screen about the centre, in picture-height units (x is stretched by the aspect).
  const at = (u: number, v: number) => ({ x: .5 + u / aspect, y: .5 + v });
  near(dragWindow('circ', 'rotate', p, aspect, at(0, -.3), at(.3, 0)).circAngle, 90, 'rotate');
  near(dragWindow('circ', 'rotate', { ...p, circAngle: 350 }, aspect, at(0, -.3), at(.3, 0)).circAngle, 80, 'rotation wraps instead of leaving the range');
  near(dragWindow('circ', 'rotate', p, aspect, at(0, -.3), at(.3, -.27)).circAngle, 45, 'Shift snaps', 45);
  assert.equal(dragWindow('circ', 'rotate', p, aspect, at(0, -.3), at(.3, -.27), true).circAngle, 45);
  assert.deepEqual(dragWindow('circ', 'w', p, aspect, at(.3, 0), at(.42, .05)), { circW: .42 });
  assert.deepEqual(dragWindow('circ', 'w', p, aspect, at(.3, 0), at(.45, 0), true), { circW: .45, circH: .3 }, 'Shift keeps the shape');
  const rect = { rectX: .5, rectY: .5, rectW: .6, rectH: .4, rectAngle: 90, rectSoft: .05, rectRound: 0 };
  // Turned 90°, the rectangle's width runs down the screen: dragging a corner .1 further out on each local axis adds .2 to both sizes.
  const local = (u: number, v: number) => apply(frameOf('rect', rect, aspect), u, v);
  const sized = dragWindow('rect', 'size', rect, aspect, local(.3, .2), local(.4, .3));
  near(sized.rectW, .8, 'width', 1e-4); near(sized.rectH, .6, 'height', 1e-4);
  near(dragWindow('rect', 'soft', rect, aspect, local(.325, 0), local(.375, 0)).rectSoft, .15, 'feather follows the distance from the edge', 1e-4);
  near(dragWindow('circ', 'soft', p, aspect, at(.3 * 1.25, 0), at(.3 * 1.5, 0)).circSoft, .2, 'circle feather', 1e-4);
  assert.deepEqual(dragWindow('circ', 'w', p, aspect, at(.3, 0), at(0, 0)), { circW: .005 }, 'sizes stop at the registry minimum');
  const g = { gradX: .5, gradY: .5, gradAngle: 0, gradSoft: .3 };
  near(dragWindow('grad', 'soft', g, aspect, { x: .5, y: .35 }, { x: .5, y: .25 }).gradSoft, .5, 'gradient feather', 1e-4);
});

test('the qualifier pictures are its key: hue and band keys multiply to qualifierAlpha', () => {
  for (let i = 0; i < 200; i++) {
    const p = { qualOn: 1, qualHue: random() * 360, qualHueWidth: random() < .1 ? 360 : random() * 200, qualHueSoft: random() * 60, qualSatLow: random() * 50, qualSatHigh: 50 + random() * 60, qualSatSoft: random() * 20, qualLumLow: random() * 40, qualLumHigh: 60 + random() * 50, qualLumSoft: random() * 20 };
    const rgb = [random(), random(), random()], [y, cb, cr] = opponent(rgb, W), s = Math.min(1, 2 * Math.hypot(cb, cr)) * 100;
    const ours = hueKey(hueOf(cb, cr, W) * 360, p) * bandKey(s, p.qualSatLow, p.qualSatHigh, p.qualSatSoft) * bandKey(Math.max(0, Math.min(1, y)) * 100, p.qualLumLow, p.qualLumHigh, p.qualLumSoft);
    near(ours, qualifierAlpha(rgb, W, p), `sample ${i}`, 1e-12);
  }
});

test('the hue strip shows each hue as hueOf reads it, red at 0', () => {
  assert.deepEqual(hueColor(0), [255, 0, 0]);
  for (let deg = 0; deg < 360; deg += 7.5) {
    const rgb = hueColor(deg).map(v => v / 255), [, cb, cr] = opponent(rgb, W), d = Math.abs(hueOf(cb, cr, W) * 360 - deg);
    assert.ok(Math.min(d, 360 - d) < 1.2, `hue ${deg} shows as ${hueOf(cb, cr, W) * 360}`);
  }
});

test('arc union: overlapping, disjoint, contained and wrapping arcs', () => {
  assert.deepEqual(unionArc(10, 30, 100, 30), [10, 120]);
  assert.deepEqual(unionArc(10, 30, 0, 20), [0, 40]);
  assert.deepEqual(unionArc(0, 100, 20, 30), [0, 100]);
  assert.deepEqual(unionArc(350, 20, 5, 30), [350, 45], 'across red');
  assert.deepEqual(unionArc(0, 30, 180, 200), [180, 210], 'the arc through red is shorter');
  assert.deepEqual(unionArc(0, 200, 180, 200), [0, 360]);
});

test('eyedropper: a fresh key around the sample, shift widens it, grey keys every hue', () => {
  const red = pickQualifier([1, 0, 0], W, {}, false);
  assert.deepEqual(red, { qualOn: 1, qualHue: 0, qualHueWidth: 30, qualHueSoft: 20, qualSatLow: 85, qualSatHigh: 100, qualLumLow: 1.3, qualLumHigh: 41.3 });
  const yellowish = [.8, .7, .2], [, cb, cr] = opponent(yellowish, W), hue = hueOf(cb, cr, W) * 360;
  const added = pickQualifier(yellowish, W, red, true);
  assert.ok(added.qualHueWidth > 30 && added.qualHueWidth < 30 + hue + 1, `width ${added.qualHueWidth}`);
  near(added.qualHue, (hue + 15 - 15) / 2, 'centre between the two', .1);
  assert.equal(added.qualSatHigh, 100);
  assert.ok(added.qualLumHigh > 41.3 && added.qualSatLow < 85);
  // Every pixel the first key or the new sample's key selected fully is still selected.
  for (const rgb of [[1, 0, 0], yellowish]) assert.equal(qualifierAlpha(rgb, W, { ...red, ...added, qualSatSoft: 0, qualLumSoft: 0 }), 1);
  assert.equal(pickQualifier([.5, .5, .5], W, {}, false).qualHueWidth, 360);
  assert.equal(pickQualifier([.5, .5, .5], W, red, true).qualHueWidth, 30, 'a grey sample leaves the hue range');
  assert.deepEqual(pickQualifier([0, 1, 0], W, { qualOn: 0 }, true).qualHueWidth, 30, 'nothing to extend: a fresh key');
});

test('the eyedropper keys in the node stage weights', () => {
  const node = (id: string, order: number, extra: Partial<GradeNode> = {}) => ({ id, projectId: 'p', clipId: 'c', kind: 'serial', name: id, enabled: true, order, parameters: {}, ...extra }) as GradeNode;
  assert.deepEqual(nodeWeights(clip(), undefined, [node('a', 1)], 'a'), W);
  const managed = clip({ colorPipeline: 'nodes-v2', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' });
  const cst = { id: 'x', type: 'cst', enabled: true, inputGamma: 'S-Log3', inputGamut: 'S-Gamut3.Cine', outputGamma: 'DaVinci Intermediate', outputGamut: 'DaVinci Wide Gamut', toneMapping: 'none', gamutMapping: 'none' } as const;
  const nodes = [node('in', 1, { effects: [cst] }), node('grade', 2, { enabled: false })];
  assert.deepEqual(nodeWeights(managed, undefined, nodes, 'in'), luminanceWeights('S-Gamut3.Cine'));
  assert.deepEqual(nodeWeights(managed, undefined, nodes, 'grade'), luminanceWeights('DaVinci Wide Gamut'), 'after the CST, even while bypassed');
});
