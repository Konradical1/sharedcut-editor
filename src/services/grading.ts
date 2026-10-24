import type { ColorCurve, ColorCurves, GradeNode } from '../state/models.ts';

/**
 * Color page v3 (docs/color-grading-v3.md): the grade parameter registry and the CPU reference for log wheels, tone
 * sliders, hue/boost/density, HSL curves, the RGB mixer, the HSL qualifier, windows, the film noise and the per-pixel half of
 * Dehaze/Clarity (its maps are in filmLook.ts). The GPU preview
 * (colorPreview.ts) and the export worker (scripts/color-render.py) implement these formulas exactly. Every key lives
 * in GradeNode.parameters and an absent key is identity, so a node only stores the tools it uses.
 */
export type GradeGroup = 'primaries' | 'wheels' | 'log' | 'mixer' | 'qualifier' | 'circle' | 'rectangle' | 'gradient' | 'film' | 'detail';
/** `limit` is what preview and export accept (default min..max); the UI offers min..max. */
export interface GradeParam { key: string; group: GradeGroup; label: string; initial: number; min: number; max: number; step: number; unit?: string; doc: string; limit?: [number, number] }
const param = (group: GradeGroup, key: string, label: string, initial: number, min: number, max: number, step: number, doc: string, unit?: string, limit?: [number, number]): GradeParam => ({ key, group, label, initial, min, max, step, doc, ...(unit ? { unit } : {}), ...(limit ? { limit } : {}) });
const toggle = (group: GradeGroup, key: string, label: string, doc: string) => param(group, key, label, 0, 0, 1, 1, doc);
const WHEELS = [['lift', 'Shadows', 'Lift'], ['gamma', 'Midtones', 'Gamma'], ['gain', 'Highlights', 'Gain'], ['offset', 'Offset', 'Offset']] as const;

export const GRADE_PARAMS: GradeParam[] = [
  param('primaries', 'exposure', 'Exposure', 0, -6, 6, .01, 'Exposure in stops (linear light on nodes-v2).', 'stops', [-16, 16]),
  param('primaries', 'temperature', 'Temp', 0, -2000, 2000, 10, 'White balance: + warmer, − cooler.', '', [-10000, 10000]),
  param('primaries', 'tint', 'Tint', 0, -100, 100, 1, '+ magenta, − green.', '', [-200, 200]),
  param('primaries', 'contrast', 'Contrast', 1, 0, 3, .01, 'Contrast around Pivot (1 = unchanged).', '×', [-8, 8]),
  param('primaries', 'pivot', 'Pivot', .336043, 0, 1, .001, 'Contrast pivot: DaVinci Intermediate mid grey .336 (legacy clips .5).', '', [-2, 2]),
  param('primaries', 'saturation', 'Saturation', 100, 0, 200, 1, '100 = unchanged.', '%', [0, 400]),
  param('primaries', 'hue', 'Hue', 0, -180, 180, .5, 'Rotates every hue; + turns red toward yellow.', '°'),
  param('primaries', 'boost', 'Color Boost', 0, -100, 100, 1, 'Vibrance: saturates muted colours more than vivid ones.'),
  param('primaries', 'shadows', 'Shadows', 0, -100, 100, 1, 'Lifts (+) or deepens (−) the dark tones; black stays put.'),
  param('primaries', 'highlights', 'Highlights', 0, -100, 100, 1, 'Brightens (+) or recovers (−) the bright tones; white stays put.'),
  param('primaries', 'density', 'Density', 0, 0, 100, 1, 'Film-style subtractive saturation: saturated colours get deeper, not brighter.'),
  ...(['Shadows', 'Midtones', 'Highlights'] as const).map(r => param('primaries', `saturation${r}`, `${r.slice(0, -1)} sat`, 100, 0, 200, 1, `Saturation of the ${r.toLowerCase()} after Saturation (100 = unchanged).`, '%', [0, 400])),
  param('detail', 'dehaze', 'Dehaze', 0, -100, 100, 1, 'Removes (+) or adds (−) haze in linear light; skies and bright areas are kept; + darkens hazy areas, so lift Exposure on a later node.'),
  param('detail', 'clarity', 'Clarity', 0, -100, 100, 1, 'Midtone local contrast on luminance: + punchier texture, − smoother; no hue shift, shadows and highlights kept.'),
  ...WHEELS.flatMap(([key, label, davinci]) => [
    param('wheels', key, label, key === 'gain' ? 1 : 0, key === 'gain' ? 0 : -1, key === 'gain' ? 2 : 1, .001, `${label} wheel master (DaVinci ${davinci}).`, '', key === 'lift' || key === 'offset' ? [-4, 4] : [-8, 8]),
    ...['R', 'G', 'B'].map(c => param('wheels', key + c, `${label} ${c}`, 0, -1, 1, .001, `${label} wheel, ${c} channel (added to the master).`, '', [-2, 2])),
  ]),
  ...(['Shadow', 'Mid', 'Highlight'] as const).flatMap(r => ['', 'R', 'G', 'B'].map(c => param('log', `log${r}${c}`, `Log ${r === 'Mid' ? 'Midtone' : r} ${c || 'master'}`, 0, -1, 1, .001, `Log wheel: ${c ? `${c} channel` : 'all channels'} offset in the ${r === 'Mid' ? 'midtone' : r.toLowerCase()} range.`, '', [-2, 2]))),
  param('log', 'logLowRange', 'Low range', .333, 0, 1, .001, 'Where the log Shadow range ends (signal level).'),
  param('log', 'logHighRange', 'High range', .55, 0, 1, .001, 'Where the log Highlight range starts (signal level).'),
  ...['R', 'G', 'B'].flatMap(row => ['R', 'G', 'B'].map(col => param('mixer', `mix${row}${col}`, `${row} from ${col}`, row === col ? 1 : 0, -2, 2, .01, `RGB mixer: share of input ${col} in output ${row}.`))),
  toggle('mixer', 'mixMono', 'Monochrome', 'All three channels take the Red output row.'),
  toggle('qualifier', 'qualOn', 'Qualifier', 'Limit this node to the colours the HSL key selects.'),
  toggle('qualifier', 'qualInvert', 'Invert key', 'Grade everything except the selected colours.'),
  param('qualifier', 'qualHue', 'Hue center', 0, 0, 360, .5, 'Hue to select (0 red, ~72 yellow, ~127 green, 180 cyan, ~252 blue, ~315 magenta).', '°'),
  param('qualifier', 'qualHueWidth', 'Hue width', 360, 0, 360, .5, 'Hues fully selected around the centre; 360 = any hue.', '°'),
  param('qualifier', 'qualHueSoft', 'Hue soft', 20, 0, 180, .5, 'Feather outside the hue width.', '°'),
  param('qualifier', 'qualSatLow', 'Sat low', 0, 0, 100, .5, 'Lowest saturation selected (0 = none excluded).', '%'),
  param('qualifier', 'qualSatHigh', 'Sat high', 100, 0, 100, .5, 'Highest saturation selected (100 = none excluded).', '%'),
  param('qualifier', 'qualSatSoft', 'Sat soft', 10, 0, 100, .5, 'Feather of the saturation range.', '%'),
  param('qualifier', 'qualLumLow', 'Lum low', 0, 0, 100, .5, 'Darkest level selected (0 = none excluded).', '%'),
  param('qualifier', 'qualLumHigh', 'Lum high', 100, 0, 100, .5, 'Brightest level selected (100 = none excluded).', '%'),
  param('qualifier', 'qualLumSoft', 'Lum soft', 10, 0, 100, .5, 'Feather of the luminance range.', '%'),
  toggle('circle', 'circOn', 'Circle', 'Radial window: an ellipse with soft edges.'),
  toggle('circle', 'circInvert', 'Invert circle', 'Grade outside the circle.'),
  param('circle', 'circX', 'Center X', .5, -1, 2, .001, 'Centre, 0 left edge → 1 right edge of the picture.'),
  param('circle', 'circY', 'Center Y', .5, -1, 2, .001, 'Centre, 0 top → 1 bottom.'),
  param('circle', 'circW', 'Radius X', .3, .005, 4, .001, 'Horizontal radius in picture heights.'),
  param('circle', 'circH', 'Radius Y', .3, .005, 4, .001, 'Vertical radius in picture heights.'),
  param('circle', 'circAngle', 'Rotation', 0, -360, 360, .5, 'Rotation, clockwise.', '°'),
  param('circle', 'circSoft', 'Softness', .1, 0, 2, .001, 'Edge feather width in picture heights, centred on the edge.'),
  toggle('rectangle', 'rectOn', 'Rectangle', 'Rectangular window with optional rounded corners.'),
  toggle('rectangle', 'rectInvert', 'Invert rectangle', 'Grade outside the rectangle.'),
  param('rectangle', 'rectX', 'Center X', .5, -1, 2, .001, 'Centre, 0 left → 1 right.'),
  param('rectangle', 'rectY', 'Center Y', .5, -1, 2, .001, 'Centre, 0 top → 1 bottom.'),
  param('rectangle', 'rectW', 'Width', .6, .005, 8, .001, 'Width in picture heights.'),
  param('rectangle', 'rectH', 'Height', .4, .005, 4, .001, 'Height in picture heights.'),
  param('rectangle', 'rectAngle', 'Rotation', 0, -360, 360, .5, 'Rotation, clockwise.', '°'),
  param('rectangle', 'rectSoft', 'Softness', .05, 0, 2, .001, 'Edge feather width in picture heights.'),
  param('rectangle', 'rectRound', 'Roundness', 0, 0, 1, .01, 'Corner rounding, 1 = fully round ends.'),
  toggle('gradient', 'gradOn', 'Gradient', 'Linear gradient window (sky, ground, side light).'),
  toggle('gradient', 'gradInvert', 'Invert gradient', 'Swap the graded side.'),
  param('gradient', 'gradX', 'Center X', .5, -1, 2, .001, 'A point on the middle of the transition, 0 left → 1 right.'),
  param('gradient', 'gradY', 'Center Y', .5, -1, 2, .001, 'A point on the middle of the transition, 0 top → 1 bottom.'),
  param('gradient', 'gradAngle', 'Angle', 0, -360, 360, .5, 'Direction of the graded side: 0 up, 90 right, 180 down.', '°'),
  param('gradient', 'gradSoft', 'Softness', .3, .001, 4, .001, 'Width of the transition in picture heights.'),
  param('film', 'filmHalation', 'Halation', 0, 0, 100, 1, 'Red glow that film adds around bright lights.'),
  param('film', 'filmHalationThreshold', 'Halation threshold', 1.5, -3, 8, .05, 'Brightness where halation starts, stops above mid grey.', 'stops'),
  param('film', 'filmHalationRadius', 'Halation radius', 1, .1, 10, .05, 'Spread, % of picture height.', '%'),
  param('film', 'filmHalationHue', 'Halation hue', 12, 0, 360, 1, 'Glow colour (0 red, 30 orange).', '°'),
  param('film', 'filmHalationSat', 'Halation saturation', 90, 0, 100, 1, 'Glow saturation.', '%'),
  param('film', 'filmBloom', 'Bloom', 0, 0, 100, 1, 'Soft glow that bleeds highlights into their surroundings.'),
  param('film', 'filmBloomThreshold', 'Bloom threshold', 1, -3, 8, .05, 'Brightness where bloom starts, stops above mid grey.', 'stops'),
  param('film', 'filmBloomRadius', 'Bloom radius', 4, .2, 20, .1, 'Spread, % of picture height.', '%'),
  param('film', 'filmBloomWarmth', 'Bloom warmth', 0, -100, 100, 1, 'Tints the glow warm (+) or cool (−).'),
  param('film', 'filmGrain', 'Grain', 0, 0, 100, 1, 'Film grain strength.'),
  param('film', 'filmGrainSize', 'Grain size', 1, .25, 4, .05, 'Grain size, 1 = one pixel of a 1080p frame.'),
  param('film', 'filmGrainColor', 'Grain colour', 30, 0, 100, 1, '0 monochrome grain, 100 independent per channel.', '%'),
  param('film', 'filmGrainResponse', 'Grain in mids', 50, 0, 100, 1, '0 even across tones, 100 mostly in the midtones (like negative film).', '%'),
  param('film', 'filmGrainSeed', 'Grain seed', 0, 0, 9999, 1, 'Changes the grain pattern.'),
  toggle('film', 'filmGrainStatic', 'Still grain', 'The same grain on every frame (off = it moves like film).'),
  param('film', 'filmVignette', 'Vignette', 0, -100, 100, 1, 'Darkens (+) or brightens (−) the corners, up to 2 stops.'),
  param('film', 'filmVignetteSize', 'Vignette size', 55, 0, 100, 1, 'Where the falloff starts, % of the half-diagonal.', '%'),
  param('film', 'filmVignetteSoftness', 'Vignette softness', 50, 1, 100, 1, 'Length of the falloff.', '%'),
  param('film', 'filmVignetteRoundness', 'Vignette roundness', 50, 0, 100, 1, '0 follows the frame shape, 100 a circle.', '%'),
  param('film', 'filmWeave', 'Gate weave', 0, 0, 100, 1, 'The picture drifts slightly, as film does in a projector gate.'),
  param('film', 'filmBreath', 'Breath', 0, 0, 100, 1, 'Frame-to-frame exposure flicker of film.'),
  param('film', 'filmAberration', 'Aberration', 0, 0, 100, 1, 'Lens colour fringing toward the edges.'),
];
export const PARAM = Object.fromEntries(GRADE_PARAMS.map(p => [p.key, p])) as Record<string, GradeParam>;
/** Keys this module validates and renders (the rest are the original primaries, checked in colorStages). */
const LEGACY = new Set(['exposure', 'temperature', 'tint', 'contrast', 'pivot', 'saturation', ...WHEELS.flatMap(([k]) => [k, k + 'R', k + 'G', k + 'B']), 'saturationShadows', 'saturationMidtones', 'saturationHighlights']);
export const V3_KEYS = new Set(GRADE_PARAMS.map(p => p.key).filter(k => !LEGACY.has(k)));
export const FILM_AMOUNTS = ['filmHalation', 'filmBloom', 'filmGrain', 'filmVignette', 'filmWeave', 'filmBreath', 'filmAberration'] as const;
export const FILM_KEYS = GRADE_PARAMS.filter(p => p.group === 'film').map(p => p.key);
export const HSL_CURVES = ['HueHue', 'HueSat', 'HueLum', 'LumSat', 'SatSat', 'SatLum'] as const;
export const HUE_CURVES: readonly string[] = ['HueHue', 'HueSat', 'HueLum'];
export const CURVE_KEYS: readonly string[] = ['RGB', 'R', 'G', 'B', ...HSL_CURVES];
const MIX = ['RR', 'RG', 'RB', 'GR', 'GG', 'GB', 'BR', 'BG', 'BB'].map(k => 'mix' + k);

type Params = Record<string, number>;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const val = (p: Params, key: string) => p[key] ?? PARAM[key].initial;
export const on = (v: number | undefined) => (v ?? 0) >= .5;
export const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Smoothstep, or a hard step at `a` when the edge has no width. */
export const sse = (a: number, b: number, x: number) => b > a ? smoothstep(a, b, x) : x >= a ? 1 : 0;
const dot = (w: number[], rgb: number[]) => w[0] * rgb[0] + w[1] * rgb[1] + w[2] * rgb[2];

export const hasWindow = (p: Params = {}) => on(p.circOn) || on(p.rectOn) || on(p.gradOn);
export const hasQualifier = (p: Params = {}) => on(p.qualOn);
export const filmActive = (p: Params = {}) => FILM_AMOUNTS.some(k => (p[k] ?? 0) !== 0);
/** Every film key with its default filled in: what a film stage carries to the renderers. */
export const filmParams = (p: Params) => Object.fromEntries(FILM_KEYS.map(k => [k, val(p, k)]));
/** Dehaze or Clarity is on: the node's correction stage is a detail point (whole-frame maps, docs/color-grading-v3.md "Detail"). */
export const detailActive = (p: Params = {}) => (p.dehaze ?? 0) !== 0 || (p.clarity ?? 0) !== 0;
/** A node's Dehaze/Clarity keys: Balance, Look and Normalize rewrites keep them (they are neither a balance nor a look). */
export const detailParams = (p: Params = {}) => Object.fromEntries(Object.entries(p).filter(([k]) => PARAM[k]?.group === 'detail'));
/** A clip whose grade needs pixel positions (windows) or whole frames (film, Dehaze/Clarity): no LUT can hold it. */
export const spatialGrade = (clipId: string, nodes: GradeNode[]) => nodes.some(n => n.clipId === clipId && n.enabled && (hasWindow(n.parameters) || filmActive(n.parameters) || detailActive(n.parameters)));

/** Throws for a v3 key outside what preview and export accept. */
export function validateGradeParameters(name: string, p: Params) {
  for (const [key, v] of Object.entries(p)) {
    if (!V3_KEYS.has(key)) continue;
    const [min, max] = PARAM[key].limit ?? [PARAM[key].min, PARAM[key].max];
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name}: ${key} is outside the supported range.`);
  }
}

// ---- Curves -----------------------------------------------------------------------------------------------------------

export function identityCurve(): ColorCurve { return { mode: 'smooth', points: [{ id: 'black', x: 0, y: 0 }, { id: 'white', x: 1, y: 1 }] }; }
/** A neutral HSL curve (y = .5 is no change). */
export function flatCurve(): ColorCurve { return { mode: 'smooth', points: [{ id: 'start', x: 0, y: .5 }, { id: 'end', x: 1, y: .5 }] }; }
export function curveSlope(curve: ColorCurve, i: number) {
  const points = curve.points, p = points[i]; if (p.slope !== undefined) return p.slope;
  const sec = (a: number, b: number) => (points[b].y - points[a].y) / (points[b].x - points[a].x);
  if (i === 0) return sec(0, 1); if (i === points.length - 1) return sec(i - 1, i);
  const a = sec(i - 1, i), b = sec(i, i + 1); return a * b <= 0 ? 0 : 2 * a * b / (a + b);
}
export function sampleCurve(v: number, curve: ColorCurve) {
  const p = curve.points, first = p[0], last = p[p.length - 1];
  // Extrapolate rather than destroying working-space highlight/negative values.
  if (v < first.x) return first.y + (v - first.x) * curveSlope(curve, 0);
  if (v > last.x) return last.y + (v - last.x) * curveSlope(curve, p.length - 1);
  const i = Math.max(0, p.findIndex((point, index) => index < p.length - 1 && v <= p[index + 1].x));
  const a = p[i], b = p[i + 1], h = b.x - a.x, t = (v - a.x) / h;
  if (curve.mode === 'linear') return a.y + (b.y - a.y) * t;
  return (2 * t ** 3 - 3 * t * t + 1) * a.y + (t ** 3 - 2 * t * t + t) * h * curveSlope(curve, i) + (-2 * t ** 3 + 3 * t * t) * b.y + (t ** 3 - t * t) * h * curveSlope(curve, i + 1);
}
/** The curve with one period of points wrapped onto each side, so a hue curve is smooth across red. */
export function periodicCurve(curve: ColorCurve): ColorCurve {
  const p = curve.points, n = p.length;
  return { ...curve, points: [{ ...p[n - 2], x: p[n - 2].x - 1 }, ...p, { ...p[1], x: p[1].x + 1 }] };
}
export const sampleHueCurve = (x: number, curve: ColorCurve) => sampleCurve(x - Math.floor(x), periodicCurve(curve));

// ---- Opponent space ---------------------------------------------------------------------------------------------------

/** [y, cb, cr] for luma weights w. */
export function opponent(rgb: number[], w: number[]) { const y = dot(w, rgb); return [y, (rgb[2] - y) / (2 * (1 - w[2])), (rgb[0] - y) / (2 * (1 - w[0]))]; }
export function fromOpponent(y: number, cb: number, cr: number, w: number[]) { const r = y + 2 * (1 - w[0]) * cr, b = y + 2 * (1 - w[2]) * cb; return [r, (y - w[0] * r - w[2] * b) / w[1], b]; }
/** Hue in turns, red = 0, increasing R→Y→G→C→B→M. Undefined (grey, s < 1e-6) reads as 0 in every engine. */
export function hueOf(cb: number, cr: number, w: number[]) {
  if (2 * Math.hypot(cb, cr) < 1e-6) return 0;
  const h = (Math.atan2(cr, cb) - Math.atan2(.5, -w[0] / (2 * (1 - w[2])))) / (2 * Math.PI);
  return h - Math.floor(h);
}
const rotate = (cb: number, cr: number, turn: number) => { const c = Math.cos(turn), s = Math.sin(turn); return [cb * c - cr * s, cb * s + cr * c]; };

// ---- Per-pixel steps (docs/color-grading-v3.md, steps 3–4, 6–8, 11, 12) ------------------------------------------------

/** Log wheels then the Shadows/Highlights sliders (split at the node's contrast pivot), right after lift/gamma/gain/offset. */
export function tonal(rgb: number[], w: number[], p: Params, pivot = .5) {
  let out = rgb;
  const range = (r: string) => ['R', 'G', 'B'].map(c => (p[`log${r}`] ?? 0) + (p[`log${r}${c}`] ?? 0)), shadow = range('Shadow'), mid = range('Mid'), high = range('Highlight');
  if ([...shadow, ...mid, ...high].some(Boolean)) {
    const t = clamp(dot(w, out)), lo = val(p, 'logLowRange'), hi = val(p, 'logHighRange');
    const ws = 1 - smoothstep(lo - .1, lo + .1, t), wh = smoothstep(hi - .1, hi + .1, t), wm = Math.max(0, 1 - ws - wh);
    out = out.map((v, c) => v + ws * shadow[c] + wm * mid[c] + wh * high[c]);
  }
  const sh = p.shadows ?? 0, hl = p.highlights ?? 0;
  if (sh || hl) {
    // A bump u(1 − u)² over each side of the pivot; |k| ≤ 1 one way and ≤ 3 the other keeps it monotonic.
    const t = clamp(dot(w, out)), m = clamp(pivot, .05, .95), u = t < m ? t / m : (1 - t) / (1 - m), bump = u * (1 - u) ** 2;
    const d = t < m ? sh / 100 * (sh > 0 ? 2 : 1) * m * bump : t > m ? hl / 100 * (hl < 0 ? 2 : 1) * (1 - m) * bump : 0;
    if (d) out = out.map(v => v + d);
  }
  return out;
}
/** Hue rotation, Color Boost and Density, after saturation. */
export function chroma(rgb: number[], w: number[], p: Params) {
  const hue = p.hue ?? 0, boost = p.boost ?? 0, density = p.density ?? 0;
  if (!hue && !boost && !density) return rgb;
  let [y, cb, cr] = opponent(rgb, w);
  if (hue) [cb, cr] = rotate(cb, cr, hue * Math.PI / 180);
  const s = clamp(2 * Math.hypot(cb, cr));
  if (boost) { const f = 1 + boost / 100 * (1 - s); cb *= f; cr *= f; }
  if (density) y -= density / 100 * .2 * s;
  return fromOpponent(y, cb, cr, w);
}
/** Hue vs Hue/Sat/Lum, Lum vs Sat, Sat vs Sat/Lum, all read from the colour after the custom curves. */
export function hslCurves(rgb: number[], w: number[], curves?: ColorCurves) {
  if (!curves || !HSL_CURVES.some(k => curves[k])) return rgb;
  let [y, cb, cr] = opponent(rgb, w);
  const s0 = 2 * Math.hypot(cb, cr), sc = clamp(s0), h0 = hueOf(cb, cr, w), t0 = clamp(y);
  const H = (k: typeof HSL_CURVES[number]) => curves[k] ? sampleHueCurve(h0, curves[k]!) : .5, C = (k: typeof HSL_CURVES[number], x: number) => curves[k] ? sampleCurve(x, curves[k]!) : .5;
  const turn = (H('HueHue') - .5) * 2 * Math.PI;
  if (turn) [cb, cr] = rotate(cb, cr, turn);
  const gain = 2 * H('HueSat') * 2 * C('LumSat', t0) * 2 * C('SatSat', sc);
  cb *= gain; cr *= gain;
  y += (H('HueLum') - .5) * .5 * smoothstep(0, .15, s0) + (C('SatLum', sc) - .5) * .5;
  return fromOpponent(y, cb, cr, w);
}
export function mixer(rgb: number[], p: Params) {
  const m = MIX.map(k => val(p, k)), mono = on(p.mixMono);
  if (!mono && m.every((v, i) => v === (i % 4 === 0 ? 1 : 0))) return rgb;
  const out = [0, 1, 2].map(r => m[r * 3] * rgb[0] + m[r * 3 + 1] * rgb[1] + m[r * 3 + 2] * rgb[2]);
  return mono ? [out[0], out[0], out[0]] : out;
}

// ---- Node alpha: qualifier and windows ---------------------------------------------------------------------------------

/** HSL key of the node's input colour; 1 when the qualifier is off. */
export function qualifierAlpha(rgb: number[], w: number[], p: Params) {
  if (!on(p.qualOn)) return 1;
  const [y, cb, cr] = opponent(rgb, w), s = 2 * Math.hypot(cb, cr), width = val(p, 'qualHueWidth');
  let kh = 1;
  if (width < 360) { let d = Math.abs(hueOf(cb, cr, w) * 360 - val(p, 'qualHue')) % 360; d = Math.min(d, 360 - d); kh = 1 - sse(width / 2, width / 2 + val(p, 'qualHueSoft'), d); }
  const band = (x: number, low: number, high: number, soft: number) => (low <= 0 ? 1 : sse(low - soft, low, x)) * (high >= 100 ? 1 : 1 - sse(high, high + soft, x));
  const a = kh * band(clamp(s) * 100, val(p, 'qualSatLow'), val(p, 'qualSatHigh'), val(p, 'qualSatSoft')) * band(clamp(y) * 100, val(p, 'qualLumLow'), val(p, 'qualLumHigh'), val(p, 'qualLumSoft'));
  return on(p.qualInvert) ? 1 - a : a;
}
/** Window-local coordinates in picture heights, rotated clockwise by `angle` degrees. */
export function windowLocal(px: number, py: number, aspect: number, cx: number, cy: number, angle: number) {
  const X = (px - cx) * aspect, Y = py - cy, a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [X * c + Y * s, -X * s + Y * c];
}
/** Union of the node's enabled windows at picture position (px, py) ∈ [0,1]², top-left origin; 1 when none is on. */
export function windowAlpha(px: number, py: number, aspect: number, p: Params) {
  let keep = 1, any = false;
  const add = (a: number, invert: boolean) => { any = true; keep *= 1 - (invert ? 1 - a : a); };
  if (on(p.circOn)) {
    const [u, v] = windowLocal(px, py, aspect, val(p, 'circX'), val(p, 'circY'), val(p, 'circAngle')), rw = val(p, 'circW'), rh = val(p, 'circH'), k = val(p, 'circSoft') / Math.min(rw, rh);
    add(1 - sse(1 - k / 2, 1 + k / 2, Math.hypot(u / rw, v / rh)), on(p.circInvert));
  }
  if (on(p.rectOn)) {
    const [u, v] = windowLocal(px, py, aspect, val(p, 'rectX'), val(p, 'rectY'), val(p, 'rectAngle')), hw = val(p, 'rectW') / 2, hh = val(p, 'rectH') / 2, r = val(p, 'rectRound') * Math.min(hw, hh), soft = val(p, 'rectSoft');
    const qx = Math.abs(u) - hw + r, qy = Math.abs(v) - hh + r, sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    add(1 - sse(-soft / 2, soft / 2, sd), on(p.rectInvert));
  }
  if (on(p.gradOn)) {
    const X = (px - val(p, 'gradX')) * aspect, Y = py - val(p, 'gradY'), a = val(p, 'gradAngle') * Math.PI / 180, soft = val(p, 'gradSoft');
    add(sse(-soft / 2, soft / 2, X * Math.sin(a) - Y * Math.cos(a)), on(p.gradInvert));
  }
  return any ? 1 - keep : 1;
}

// ---- Detail: Dehaze and Clarity, per pixel (docs/color-grading-v3.md, "Detail"; the maps are detailMaps in filmLook.ts) ----

/** Every Detail constant, identical in GLSL and color-render.py: blur sigmas R, RD in % of picture height, eps in stops². */
export const DETAIL = { R: 2, RD: .5, TOE: 2 ** -10, M0: 2 ** -8, GLO: .25, GHI: .7, LO: .25, HI: .7, EPS_D: .25, EPS_C: .0625, RM: .0625, SMAX: .25, VEPS: 1e-3, OMEGA: .95, TMIN: 1 / 3, UMAX: .8, CHROMA: .6, KAPPA: .6, KN: .5, KH: 1, KAPPA_N: .4, D: .5, GATE: (.08 / .25) ** 2 } as const;
/** Linear light in stops re 18 % grey, with a toe at 2⁻¹⁰. */
export const detailStops = (x: number) => Math.log2(Math.max(x, 0) + DETAIL.TOE) - Math.log2(.18);
const softcap = (u: number) => u / Math.sqrt(Math.sqrt(1 + (u / DETAIL.UMAX) ** 4));
/** Dehaze then Clarity on one linear pixel (`lin` = decode × G); `u` = the node's 8 map values there (detailAt: M1, then M2). */
export function applyDetail(lin: number[], w: number[], p: Params, u: ArrayLike<number>): number[] {
  const K = DETAIL, a = (p.dehaze ?? 0) / 100, c = (p.clarity ?? 0) / 100, y = dot(w, lin), l = detailStops(y), ac = u[0], bc = u[1], base = ac * l + bc;
  let out = lin;
  if (a) {
    // The haze map is read at a smoother base (only ~1 stop edges survive) plus the pixel's own max-over-luma offset: no texture in it.
    const am = K.RM * ac / (K.RM * ac + 1 - ac), bm = am * l + (1 - am) * bc / Math.max(1 - ac, 1e-3), mu = .18 * 2 ** bm;
    const h = y > 1e-6 ? clamp(u[2] * (bm + detailStops(Math.max(...lin, 0)) - l) + u[3]) * (1 - smoothstep(K.LO, K.HI, y)) : 0;
    if (a > 0) {
      // J = (I − A(1 − t))/t with A = 1 on luminance, the removed fraction soft-capped, the veil's own colour taken out of the chroma,
      // then part of the darkening at the local mean given back.
      const t = Math.max(1 - K.OMEGA * a * h, K.TMIN), s = 1 - t, uc = softcap(s / Math.max(y, 1e-6)), q = (1 - uc) / t, gc = q * (1 - K.CHROMA) + K.CHROMA / t, den = u[4] + K.VEPS;
      const col = [2 ** (u[6] / den), 1, 2 ** (u[7] / den)], cy = dot(w, col), back = ((1 - softcap(s / Math.max(mu, 1e-6))) / t) ** -K.KAPPA;
      out = lin.map((v, i) => (q * y + gc * (v - y - uc * y * (col[i] / cy - 1))) * back);
    } else {
      // A neutral veil, stronger where there is haze already, bright areas kept, partly re-darkened at the local mean.
      const v = -a * (K.KN * Math.max(mu - K.TOE, 0) * (1 - smoothstep(K.LO, K.HI, y)) + K.KH * h), back = (mu / (mu + v)) ** K.KAPPA_N;
      out = lin.map(x => (x + v) * back);
    }
  }
  if (c) {
    // One gain on all channels from the soft-limited detail band of the pre-dehaze luma; flat areas and noise gated out.
    const d = l - base, f = d / Math.sqrt(1 + (d / K.D) ** 2), mid = smoothstep(-6, -1.5, base) * (1 - smoothstep(2, 5, base)), g = ac / (ac + K.GATE * (1 - ac)), gain = 2 ** (c * (c > 0 ? 2 : 1) * mid * g * f);
    out = out.map(x => x * gain);
  }
  return out;
}

// ---- Film noise (identical in GLSL and numpy: uint32 arithmetic) --------------------------------------------------------

/** A uniform value in [0,1) from integer lattice coordinates and a key; 24-bit so float32 engines agree exactly. */
export function hash32(x: number, y: number, k: number) {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(k, 0xcb1ab31f)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}
const fade = (t: number) => t * t * (3 - 2 * t);
export function valueNoise2(x: number, y: number, k: number) {
  const ix = Math.floor(x), iy = Math.floor(y), u = fade(x - ix), v = fade(y - iy);
  const a = hash32(ix, iy, k) + (hash32(ix + 1, iy, k) - hash32(ix, iy, k)) * u, b = hash32(ix, iy + 1, k) + (hash32(ix + 1, iy + 1, k) - hash32(ix, iy + 1, k)) * u;
  return a + (b - a) * v;
}
export function valueNoise1(t: number, k: number) { const i = Math.floor(t), u = fade(t - i), a = hash32(i, 0, k); return a + (hash32(i + 1, 0, k) - a) * u; }
const seedKey = (seed: number) => Math.imul(Math.round(seed), 0x01000193) >>> 0;
export const grainKey = (seed: number, frame: number, channel: number) => (seedKey(seed) ^ Math.imul(frame, 0x9E3779B9) ^ Math.imul(channel + 1, 0x85EBCA6B)) >>> 0;
/** Grain at lattice point (x, y): two octaves of value noise, about unit spread. */
export function grainNoise(x: number, y: number, key: number) {
  return 1.6 * (.7 * (2 * valueNoise2(x, y, key) - 1) + .3 * (2 * valueNoise2(2.37 * x + 17.1, 2.37 * y + 17.1, (key ^ 0x68E31DA4) >>> 0) - 1));
}
/** Per-frame gate weave (picture heights) and breath (stops). */
export function filmMotion(p: Params, frame: number) {
  const s = seedKey(val(p, 'filmGrainSeed')), weave = .003 * val(p, 'filmWeave') / 100;
  return {
    ox: weave * (2 * valueNoise1(frame / 6, (s ^ 0xA136AAAD) >>> 0) - 1), oy: weave * (2 * valueNoise1(frame / 6, (s ^ 0x27D4EB2F) >>> 0) - 1),
    breath: .08 * val(p, 'filmBreath') / 100 * (2 * valueNoise1(frame / 3, (s ^ 0x165667B1) >>> 0) - 1),
  };
}
/** Halation tint: the HSV hue at full value, toward white by 1 − sat (brightest channel 1). */
export function halationTint(p: Params) {
  const h = (val(p, 'filmHalationHue') % 360 + 360) % 360 / 60, sat = val(p, 'filmHalationSat') / 100;
  return [Math.abs(h - 3) - 1, 2 - Math.abs(h - 2), 2 - Math.abs(h - 4)].map(v => 1 - sat + sat * clamp(v));
}
