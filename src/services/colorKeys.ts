import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';
import { fittedPoint, poseLayerPoint, type Size, type Vec } from './motionTracker.ts';
import { interpretation, processingStages } from './color.ts';
import { PARAM, fromOpponent, hueOf, on, opponent, sse, windowLocal } from './grading.ts';

/**
 * Color page keys (docs/color-grading-v3.md, Qualifier and Windows): the maths behind the qualifier panel and the window
 * handles on the viewer, pure so it is tested against grading.ts. Window coordinates are source-picture normalised
 * (0–1, top-left origin, sizes in picture heights); the viewer draws them through the clip's letterbox and pose.
 */
type Params = Record<string, number>;
export type Point = readonly [number, number];
const val = (p: Params, key: string) => p[key] ?? PARAM[key].initial;
const mod = (v: number, m = 360) => (v % m + m) % m;
const W709 = [.2126, .7152, .0722];
/** Each value clamped to its registry range and rounded to a ten-thousandth. */
export const tidyParams = (patch: Params) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, Math.max(PARAM[k].min, Math.min(PARAM[k].max, Math.round(v * 1e4) / 1e4))]));

// ---- Picture ↔ viewer ---------------------------------------------------------------------------------------------------

/** A 2-D affine map in SVG `matrix(a b c d e f)` order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = readonly [number, number, number, number, number, number];
export const apply = ([a, b, c, d, e, f]: Affine, x: number, y: number): Vec => ({ x: a * x + c * y + e, y: b * x + d * y + f });
/** `m` applied after `n`. */
export const multiply = ([a, b, c, d, e, f]: Affine, [A, B, C, D, E, F]: Affine): Affine => [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
/** Non-finite when the map is flat (a clip zoomed or scaled to 0). */
export function invert([a, b, c, d, e, f]: Affine): Affine { const det = a * d - b * c; return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]; }
/** Source picture → project canvas pixels: the letterbox, then the clip's pose (`clip` evaluated at the playhead), as playback
 *  draws the layer. Both steps are affine, so three points define the map. */
export function pictureToCanvas(clip: Clip, source: Size, project: Size): Affine {
  const at = (u: number, v: number) => poseLayerPoint(clip, fittedPoint(u, v, source, project), project), o = at(0, 0), x = at(1, 0), y = at(0, 1);
  return [x.x - o.x, x.y - o.y, y.x - o.x, y.y - o.y, o.x, o.y];
}
/** Window-local units (picture heights, turned `angle`° clockwise about the centre) → picture: the inverse of grading.windowLocal. */
export function windowFrame(aspect: number, cx: number, cy: number, angle: number): Affine {
  const a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c / aspect, s, -s / aspect, c, cx, cy];
}

// ---- Windows ------------------------------------------------------------------------------------------------------------

export type WindowKind = 'grad' | 'circ' | 'rect';
export type WindowHandle = 'move' | 'rotate' | 'soft' | 'w' | 'h' | 'size';
export const frameOf = (kind: WindowKind, p: Params, aspect: number) => windowFrame(aspect, val(p, `${kind}X`), val(p, `${kind}Y`), val(p, `${kind}Angle`));
const LONG = 8;
const ellipse = (rx: number, ry: number, n = 128): Point[] => Array.from({ length: n }, (_, i) => [rx * Math.cos(2 * Math.PI * i / n), ry * Math.sin(2 * Math.PI * i / n)]);
function roundedRect(hw: number, hh: number, r: number, n = 12): Point[] {
  r = Math.max(0, Math.min(r, hw, hh));
  return ([[1, 1], [-1, 1], [-1, -1], [1, -1]] as const).flatMap(([sx, sy], corner): Point[] => r
    ? Array.from({ length: n + 1 }, (_, i) => { const t = (corner + i / n) * Math.PI / 2; return [sx * (hw - r) + r * Math.cos(t), sy * (hh - r) + r * Math.sin(t)]; })
    : [[sx * hw, sy * hh]]);
}
const rectDistance = (u: number, v: number, hw: number, hh: number, r: number) => { const qx = Math.abs(u) - hw + r, qy = Math.abs(v) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
const extent = (kind: 'circ' | 'rect', p: Params) => kind === 'circ' ? [val(p, 'circW'), val(p, 'circH')] : [val(p, 'rectW') / 2, val(p, 'rectH') / 2];

/** What the viewer draws, in the window's local units: the edge (α = ½) and where the feather ends inside (α = 1) and outside
 *  (α = 0), before Invert. A gradient's are lines across the frame, its graded side towards −v. No feather, no rings. */
export function windowContours(kind: WindowKind, p: Params): { edge: Point[]; inner?: Point[]; outer?: Point[] } {
  const soft = val(p, `${kind}Soft`) / 2;
  if (kind === 'grad') { const line = (v: number): Point[] => [[-LONG, v], [LONG, v]]; return { edge: line(0), ...(soft ? { inner: line(-soft), outer: line(soft) } : {}) }; }
  const [hw, hh] = extent(kind, p);
  if (kind === 'circ') { const k = soft / Math.min(hw, hh); return { edge: ellipse(hw, hh), ...(soft ? { outer: ellipse(hw * (1 + k), hh * (1 + k)), ...(k < 1 ? { inner: ellipse(hw * (1 - k), hh * (1 - k)) } : {}) } : {}) }; }
  const r = val(p, 'rectRound') * Math.min(hw, hh);
  return { edge: roundedRect(hw, hh, r), ...(soft ? { outer: roundedRect(hw + soft, hh + soft, r + soft), ...(hw > soft && hh > soft ? { inner: roundedRect(hw - soft, hh - soft, r - soft) } : {}) } : {}) };
}
/** The handles, in local units. `out`: the viewer pushes the handle a fixed screen distance from `at` in that local direction
 *  (rotation knobs, a gradient's feather handle), so they stay reachable at any size. */
export function windowHandles(kind: WindowKind, p: Params): { handle: WindowHandle; at: Point; out?: Point }[] {
  const move = { handle: 'move' as const, at: [0, 0] as Point };
  if (kind === 'grad') return [move, { handle: 'rotate', at: [0, 0], out: [1, 0] }, { handle: 'soft', at: [0, val(p, 'gradSoft') / 2 * (on(p.gradInvert) ? 1 : -1)], out: [-1, 0] }];
  const [hw, hh] = extent(kind, p), soft = val(p, `${kind}Soft`) / 2, k = soft / Math.min(hw, hh);
  return [move, { handle: 'w', at: [hw, 0] }, { handle: 'w', at: [-hw, 0] }, { handle: 'h', at: [0, hh] }, { handle: 'h', at: [0, -hh] },
    ...kind === 'rect' ? ([[1, 1], [-1, 1], [-1, -1], [1, -1]] as const).map(([x, y]) => ({ handle: 'size' as const, at: [x * hw, y * hh] as Point })) : [],
    { handle: 'soft', at: kind === 'circ' ? [hw * (1 + k) * Math.SQRT1_2, hh * (1 + k) * Math.SQRT1_2] : [hw + soft, Math.min(hh / 2, hh - val(p, 'rectRound') * Math.min(hw, hh))] },
    { handle: 'rotate', at: [0, -hh], out: [0, -1] }];
}
/** The parameters a drag sets: from the window's values `p` when the drag began and the pointer's picture positions then
 *  (`from`) and now (`to`). Sizes and feathers follow the pointer's change in distance, so grabbing a handle off-centre never
 *  jumps. `even`: rotation in 15° steps, both sizes scale together. Clamped to the registry. */
export function dragWindow(kind: WindowKind, handle: WindowHandle, p: Params, aspect: number, from: Vec, to: Vec, even = false): Params {
  const key = (name: string) => kind + name, get = (name: string) => val(p, key(name)), cx = get('X'), cy = get('Y'), angle = get('Angle');
  const [u0, v0] = windowLocal(from.x, from.y, aspect, cx, cy, angle), [u1, v1] = windowLocal(to.x, to.y, aspect, cx, cy, angle), out: Params = {};
  if (handle === 'move') { out[key('X')] = cx + to.x - from.x; out[key('Y')] = cy + to.y - from.y; }
  else if (handle === 'rotate') {
    let next = angle + mod((Math.atan2(v1, u1) - Math.atan2(v0, u0)) * 180 / Math.PI + 180) - 180;
    if (even) next = Math.round(next / 15) * 15;
    out[key('Angle')] = next > 360 ? next - 360 : next < -360 ? next + 360 : next;
  } else if (kind === 'grad') out.gradSoft = get('Soft') + 2 * (Math.abs(v1) - Math.abs(v0));
  else {
    const [hw, hh] = extent(kind, p), scale = kind === 'rect' ? 2 : 1;
    if (handle === 'soft') out[key('Soft')] = get('Soft') + 2 * (kind === 'circ'
      ? (Math.hypot(u1 / hw, v1 / hh) - Math.hypot(u0 / hw, v0 / hh)) * Math.min(hw, hh)
      : rectDistance(u1, v1, hw, hh, get('Round') * Math.min(hw, hh)) - rectDistance(u0, v0, hw, hh, get('Round') * Math.min(hw, hh)));
    else if (even) { const f = Math.hypot(u1 / hw, v1 / hh) / Math.max(1e-9, Math.hypot(u0 / hw, v0 / hh)); out[key('W')] = get('W') * f; out[key('H')] = get('H') * f; }
    else { if (handle !== 'h') out[key('W')] = get('W') + scale * (Math.abs(u1) - Math.abs(u0)); if (handle !== 'w') out[key('H')] = get('H') + scale * (Math.abs(v1) - Math.abs(v0)); }
  }
  return tidyParams(out);
}

// ---- Qualifier ----------------------------------------------------------------------------------------------------------

/** qualifierAlpha's hue key at hue `deg`. */
export function hueKey(deg: number, p: Params) {
  const width = val(p, 'qualHueWidth'); if (width >= 360) return 1;
  const d = mod(deg - val(p, 'qualHue'));
  return 1 - sse(width / 2, width / 2 + val(p, 'qualHueSoft'), Math.min(d, 360 - d));
}
/** qualifierAlpha's saturation or luminance key, on the 0–100 scale. */
export const bandKey = (x: number, low: number, high: number, soft: number) => (low <= 0 ? 1 : sse(low - soft, low, x)) * (high >= 100 ? 1 : 1 - sse(high, high + soft, x));
/** The display colour (0–255) of qualifier hue `deg`: a chroma vector at hueOf's angle through the opponent space, stretched to
 *  full range. Shifting along grey and scaling the chroma both keep the hue. */
export function hueColor(deg: number, w: number[] = W709): [number, number, number] {
  const t = Math.atan2(.5, -w[0] / (2 * (1 - w[2]))) + deg * Math.PI / 180, rgb = fromOpponent(0, Math.cos(t), Math.sin(t), w), lo = Math.min(...rgb), hi = Math.max(...rgb);
  return rgb.map(v => Math.round((v - lo) / (hi - lo) * 255)) as [number, number, number];
}
/** The shortest arc [start, length] (degrees) covering arcs a and b; length 360 is every hue. */
export function unionArc(a: number, la: number, b: number, lb: number): [number, number] {
  const cover = (s: number) => Math.max(mod(a - s) + la, mod(b - s) + lb), ca = cover(a), cb = cover(b);
  return Math.min(ca, cb) >= 360 ? [0, 360] : ca <= cb ? [mod(a), ca] : [mod(b), cb];
}
/** Below this saturation (percent) a sample has no hue worth keying: a fresh pick keys every hue, an added one keeps the hue range. */
const GREY = 2;
/** What the eyedropper writes for node input colour `rgb` (the node's luma weights `w`): a key around the sample (hue ±15° with
 *  a 20° feather, saturation ±15, luminance ±20), or with `extend` the current key widened just enough to take it in. */
export function pickQualifier(rgb: number[], w: number[], p: Params, extend: boolean): Params {
  const [y, cb, cr] = opponent(rgb, w), sat = Math.min(1, 2 * Math.hypot(cb, cr)) * 100, lum = Math.max(0, Math.min(1, y)) * 100, hue = hueOf(cb, cr, w) * 360;
  const sample = { qualSatLow: Math.max(0, sat - 15), qualSatHigh: Math.min(100, sat + 15), qualLumLow: Math.max(0, lum - 20), qualLumHigh: Math.min(100, lum + 20) };
  const round = (patch: Params) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  if (!extend || !on(p.qualOn)) return round({ qualOn: 1, qualHue: hue, qualHueWidth: sat < GREY ? 360 : 30, qualHueSoft: 20, ...sample });
  const width = val(p, 'qualHueWidth'), centre = val(p, 'qualHue');
  const [start, length] = width >= 360 || sat < GREY ? [centre - width / 2, Math.min(360, width)] : unionArc(centre - width / 2, width, hue - 15, 30);
  return round({ qualOn: 1, qualHue: mod(start + length / 2), qualHueWidth: length,
    qualSatLow: Math.min(val(p, 'qualSatLow'), sample.qualSatLow), qualSatHigh: Math.max(val(p, 'qualSatHigh'), sample.qualSatHigh),
    qualLumLow: Math.min(val(p, 'qualLumLow'), sample.qualLumLow), qualLumHigh: Math.max(val(p, 'qualLumHigh'), sample.qualLumHigh) });
}
/** Luma weights of the node's correction stage, the opponent space its qualifier keys in, as if the node were on; Rec.709 when
 *  the grade cannot be read. */
export function nodeWeights(clip: Clip, asset: MediaAsset | undefined, nodes: GradeNode[], nodeId: string): number[] {
  try {
    const source = interpretation(clip, asset);
    const stage = processingStages({ ...clip, properties: { ...clip.properties, inputProfile: source.profile, inputGamut: source.gamut } }, nodes.map(n => n.id === nodeId ? { ...n, enabled: true } : n)).find(s => s.type === 'correction' && s.node.id === nodeId);
    if (stage?.type === 'correction') return stage.weights;
  } catch { /* an unreadable grade keys on Rec.709 */ }
  return W709;
}
