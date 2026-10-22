import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorTransform, processingStages, validateGradeNode, luminanceWeights } from './color.ts';
import { GRADE_PARAMS, PARAM, V3_KEYS, chroma, filmMotion, flatCurve, grainKey, grainNoise, halationTint, hash32, hslCurves, hueOf, mixer, opponent, qualifierAlpha, sampleHueCurve, tonal, validateGradeParameters, valueNoise2, windowAlpha, filmParams } from './grading.ts';
import { applyFilm, filmBlur } from './filmLook.ts';
import type { Clip, ColorCurve, GradeNode } from '../state/models.ts';

const W = [.2126, .7152, .0722], near = (a: number, b: number, message: string, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${message}: ${a} vs ${b}`);
const luma = (rgb: number[]) => W[0] * rgb[0] + W[1] * rgb[1] + W[2] * rgb[2];
const node = (parameters: Record<string, number>, extra: Partial<GradeNode> = {}) => ({ id: 'n', projectId: 'p', clipId: 'c', kind: 'serial', name: 'Node', enabled: true, order: 1, parameters, ...extra }) as GradeNode;
const legacy = { id: 'c', properties: {} } as unknown as Clip, managed = { id: 'c', properties: { colorPipeline: 'nodes-v2', inputProfile: 'DaVinci Intermediate', inputGamut: 'DaVinci Wide Gamut' } } as unknown as Clip;
const curve = (points: [number, number][]): ColorCurve => ({ mode: 'smooth', points: points.map(([x, y], i) => ({ id: `p${i}`, x, y })) });

test('the registry: unique keys, defaults inside their ranges, v3 keys validated against their limits', () => {
  assert.equal(new Set(GRADE_PARAMS.map(p => p.key)).size, GRADE_PARAMS.length);
  for (const p of GRADE_PARAMS) assert.ok(p.initial >= p.min && p.initial <= p.max && p.min < p.max && p.step > 0 && p.doc, p.key);
  assert.ok(!V3_KEYS.has('lift') && !V3_KEYS.has('saturationShadows') && V3_KEYS.has('qualHue') && V3_KEYS.has('filmGrain'));
  assert.throws(() => validateGradeParameters('N', { qualHue: 400 }), /qualHue is outside/);
  assert.throws(() => validateGradeParameters('N', { filmGrain: NaN }), /filmGrain is outside/);
  assert.doesNotThrow(() => validateGradeParameters('N', { lift: 9, qualHue: 359 }), 'legacy keys are checked by colorStages');
});

test('every v3 key at its default renders exactly like no key, on both pipelines', () => {
  const defaults = Object.fromEntries(GRADE_PARAMS.filter(p => V3_KEYS.has(p.key)).map(p => [p.key, p.initial]));
  for (const clip of [legacy, managed]) {
    const plain = colorTransform(clip, undefined, [node({ saturation: 120, liftR: .02 })]), full = colorTransform(clip, undefined, [node({ saturation: 120, liftR: .02, ...defaults })]);
    for (const rgb of [[.1, .2, .3], [.8, .4, .2], [.5, .5, .5], [0, 0, 0], [1, 1, 1]]) assert.deepEqual(full(rgb), plain(rgb));
  }
});

test('log wheels move only their range; Shadows/Highlights stay monotonic and leave black and white alone', () => {
  const dark = [.1, .1, .1], bright = [.9, .9, .9];
  near(tonal(dark, W, { logShadowB: .05 })[2], .15, 'shadow wheel moves a dark pixel fully');
  near(tonal(bright, W, { logShadowB: .05 })[2], .9, 'and leaves a bright one');
  near(tonal(bright, W, { logHighlight: -.04 })[0], .86, 'highlight master moves every channel');
  near(tonal([.44, .44, .44], W, { logMidR: .02 })[0], .46, 'midtone wheel between the ranges');
  for (const p of [{ shadows: 100 }, { shadows: -100 }, { highlights: 100 }, { highlights: -100 }] as Record<string, number>[]) for (const pivot of [.5, .336043]) {
    let previous = -1;
    for (let i = 0; i <= 200; i++) { const t = i / 200, out = tonal([t, t, t], W, p, pivot)[0]; assert.ok(out >= previous - 1e-12, `${JSON.stringify(p)} pivot ${pivot} monotonic at ${t}`); previous = out; }
    near(tonal([0, 0, 0], W, p, pivot)[0], 0, 'black'); near(tonal([1, 1, 1], W, p, pivot)[0], 1, 'white'); near(tonal([pivot, pivot, pivot], W, p, pivot)[0], pivot, 'the pivot');
  }
  assert.ok(tonal([.15, .15, .15], W, { shadows: 100 })[0] > .2 && tonal([.85, .85, .85], W, { highlights: -100 })[0] < .8);
  assert.ok(tonal([.5, .5, .5], W, { highlights: -100 }, .336043)[0] < .47, 'on a DaVinci Intermediate node the split is its pivot, so highlights start at mid grey');
});

test('hue rotation keeps luma; boost favours muted colours; density darkens saturated ones', () => {
  const red = [.8, .2, .2], [, cb, cr] = opponent(red, W), h = hueOf(cb, cr, W);
  const turned = chroma(red, W, { hue: 120 }), [, cb2, cr2] = opponent(turned, W);
  near(luma(turned), luma(red), 'luma kept', 1e-12); near(hueOf(cb2, cr2, W), (h + 1 / 3) % 1, 'hue moved a third of a turn', 1e-12);
  const muted = [.5, .45, .4], vivid = [.9, .1, .1], gain = (rgb: number[]) => { const a = opponent(rgb, W), b = opponent(chroma(rgb, W, { boost: 50 }), W); return Math.hypot(b[1], b[2]) / Math.hypot(a[1], a[2]); };
  assert.ok(gain(muted) > gain(vivid) && gain(vivid) >= 1, 'boost');
  assert.ok(luma(chroma(vivid, W, { density: 100 })) < luma(vivid) - .05 && Math.abs(luma(chroma([.5, .5, .5], W, { density: 100 })) - .5) < 1e-12, 'density');
});

test('HSL curves: periodic hue curves are smooth across red; each curve does its one job', () => {
  const hc = curve([[0, .5], [.1, .9], [.6, .3], [1, .5]]), d = 1e-5;
  near(sampleHueCurve(1 - d, hc), sampleHueCurve(d, hc), 'continuous across red', 1e-3);
  near((sampleHueCurve(d, hc) - sampleHueCurve(1 - d, hc)) / (2 * d), (sampleHueCurve(2 * d, hc) - sampleHueCurve(0, hc)) / (2 * d), 'slope continuous across red', 1e-2);
  const red = [.8, .2, .2], green = [.2, .7, .2], c = (rgb: number[]) => Math.hypot(...opponent(rgb, W).slice(1));
  const halfRed = hslCurves(red, W, { HueSat: curve([[0, .25], [.2, .5], [.85, .5], [1, .25]]) });
  near(c(halfRed), c(red) / 2, 'Hue vs Sat halves red'); near(c(hslCurves(green, W, { HueSat: curve([[0, .25], [.2, .5], [.85, .5], [1, .25]]) })), c(green), 'and leaves green', 1e-6);
  near(luma(hslCurves(red, W, { HueLum: curve([[0, .7], [.2, .5], [.85, .5], [1, .7]]) })), luma(red) + .1, 'Hue vs Lum lifts red luma');
  const grey = [.4, .4, .4];
  assert.deepEqual(hslCurves(grey, W, { HueLum: curve([[0, .9], [1, .9]]) }).map(v => +v.toFixed(12)), grey, 'Hue vs Lum ignores grey');
  near(luma(hslCurves(grey, W, { SatLum: curve([[0, .7], [1, .7]]) })), .5, 'Sat vs Lum at zero saturation');
  for (const k of ['HueHue', 'HueSat', 'HueLum', 'LumSat', 'SatSat', 'SatLum']) hslCurves(red, W, { [k]: flatCurve() }).forEach((v, i) => near(v, red[i], `${k} flat is identity`, 1e-12));
  const hh = hslCurves(red, W, { HueHue: curve([[0, .5 + 1 / 6], [1, .5 + 1 / 6]]) }), [, hb, hr] = opponent(hh, W), [, rb, rr] = opponent(red, W);
  near(hueOf(hb, hr, W), hueOf(rb, rr, W) + 1 / 6, 'Hue vs Hue turns red by 60°', 1e-9);
});

test('mixer and monochrome', () => {
  const mono = .3 * .2 + .6 * .4 + .1 * .6;
  mixer([.2, .4, .6], { mixRR: .3, mixRG: .6, mixRB: .1, mixMono: 1 }).forEach(v => near(v, mono, 'mono row R', 1e-15));
  const rgb = [.2, .4, .6]; assert.equal(mixer(rgb, {}), rgb);
  assert.deepEqual(mixer(rgb, { mixRR: 0, mixRB: 1, mixBB: 0, mixBR: 1 }), [.6, .4, .2]);
});

test('qualifier: hue, saturation and luminance ranges, softness, grey and invert', () => {
  const red = [.8, .2, .2], green = [.2, .7, .2], grey = [.5, .5, .5], key = { qualOn: 1, qualHue: 0, qualHueWidth: 30, qualHueSoft: 10 };
  const [, cb, cr] = opponent(red, W), h = hueOf(cb, cr, W) * 360, onRed = { ...key, qualHue: h };
  assert.equal(qualifierAlpha(red, W, onRed), 1); assert.equal(qualifierAlpha(green, W, onRed), 0);
  assert.equal(qualifierAlpha(grey, W, key), 1, 'grey reads as hue 0 in every engine');
  assert.equal(qualifierAlpha(grey, W, { ...key, qualSatLow: 20, qualSatSoft: 0 }), 0, 'a saturation floor drops grey');
  assert.equal(qualifierAlpha(red, W, { ...onRed, qualInvert: 1 }), 0);
  assert.equal(qualifierAlpha(red, W, { qualOn: 0, qualHue: 180, qualHueWidth: 1 }), 1, 'off');
  near(qualifierAlpha(red, W, { qualOn: 1, qualHue: (h + 20) % 360, qualHueWidth: 30, qualHueSoft: 10 }), .5, 'half way through the hue feather', 1e-9);
  assert.equal(qualifierAlpha([.9, .9, .9], W, { qualOn: 1, qualLumHigh: 80, qualLumSoft: 0 }), 0);
});

test('windows: circle, rectangle and gradient geometry, rotation, union and invert', () => {
  const circle = { circOn: 1, circX: .5, circY: .5, circW: .2, circH: .2, circSoft: .1 }, A = 16 / 9;
  assert.equal(windowAlpha(.5, .5, A, circle), 1); assert.equal(windowAlpha(.05, .05, A, circle), 0);
  near(windowAlpha(.5, .7, A, circle), .5, 'on the edge vertically'); near(windowAlpha(.5 + .2 / A, .5, A, circle), .5, 'and horizontally: round on a wide picture');
  const rect = { rectOn: 1, rectW: .4, rectH: .2, rectSoft: 0 };
  assert.equal(windowAlpha(.5 + .19 / A, .5, A, rect), 1); assert.equal(windowAlpha(.5, .62, A, rect), 0);
  assert.equal(windowAlpha(.5, .68, A, { ...rect, rectAngle: 90 }), 1, 'turned 90° the long side runs vertically');
  const grad = { gradOn: 1, gradSoft: .2 };
  assert.equal(windowAlpha(.5, .05, A, grad), 1, 'angle 0 grades the top'); assert.equal(windowAlpha(.5, .95, A, grad), 0); near(windowAlpha(.3, .5, A, grad), .5, 'centre line');
  assert.equal(windowAlpha(.95, .5, A, { ...grad, gradAngle: 90 }), 1, 'angle 90 grades the right');
  near(windowAlpha(.05, .05, A, { ...circle, circInvert: 1 }), 1, 'inverted circle');
  near(windowAlpha(.5, .05, A, { ...grad, ...circle }), 1, 'union: the gradient covers the top'); near(windowAlpha(.5, .5, A, { ...grad, ...circle }), 1, 'and the circle the middle');
  assert.equal(windowAlpha(.1, .1, A, {}), 1, 'no window: the whole picture');
});

test('noise and film reference vectors (GPU and color-render.py must reproduce these)', () => {
  assert.deepEqual([[0, 0, 0], [1, 2, 3], [1919, 1079, 123456789], [7, 9, 0xdeadbeef]].map(([x, y, k]) => hash32(x, y, k)), [0, 0.016946732997894287, 0.8105304837226868, 0.3402389883995056]);
  assert.deepEqual([grainKey(0, 0, 0), grainKey(42, 17, 3), grainKey(9999, 123456, 2)], [2246822507, 3154149115, 2683495324]);
  near(valueNoise2(.5, .25, 7), 0.5353816617280245, 'value noise', 1e-15); near(valueNoise2(123.75, 45.5, grainKey(1, 2, 3)), 0.47758874483406544, 'value noise', 1e-15);
  near(grainNoise(10.3, 20.7, grainKey(0, 5, 3)), -0.7669556525773207, 'grain', 1e-15); near(grainNoise(.5, .5, grainKey(3, 0, 0)), 0.443845637058393, 'grain', 1e-15);
  const motion = filmMotion(filmParams({ filmWeave: 100, filmBreath: 100, filmGrainSeed: 7 }), 37);
  near(motion.ox, 0.0014169404374228581, 'weave x', 1e-15); near(motion.oy, 0.0021337956455018776, 'weave y', 1e-15); near(motion.breath, -0.020711009767320404, 'breath', 1e-15);
  halationTint(filmParams({}), W).forEach((v, i) => near(v, [2.380521619897352, 0.6665460535712584, 0.23805216198973517][i], 'halation tint', 1e-12));
});

test('a film node adds a film stage after its own stages; the blend stays on the node\'s last real stage', () => {
  const nodes = [node({ filmGrain: 30 }, { id: 'a', order: 1, effects: [{ id: 'cst', type: 'cst', enabled: true, inputGamma: 'DaVinci Intermediate', inputGamut: 'DaVinci Wide Gamut', outputGamma: 'Gamma 2.4', outputGamut: 'Rec.709', toneMapping: 'none', gamutMapping: 'none' }] }), node({ exposure: .1 }, { id: 'b', order: 2 })];
  const stages = processingStages(managed, nodes);
  assert.deepEqual(stages.map(s => s.type), ['correction', 'cst', 'film', 'correction']);
  assert.deepEqual(stages.map(s => [s.nodeStart, s.nodeEnd]), [[true, false], [false, true], [false, false], [true, true]]);
  const film = stages[2] as Extract<typeof stages[number], { type: 'film' }>;
  assert.equal(film.gamma, 'Gamma 2.4'); assert.deepEqual(film.weights, luminanceWeights('Rec.709')); assert.equal(film.p.filmGrain, 30); assert.equal(film.p.filmGrainSize, PARAM.filmGrainSize.initial);
  assert.deepEqual(processingStages(legacy, [node({ filmVignette: 20 })]).map(s => s.type), ['correction', 'film']);
});

test('windows need pixel positions: maskAt("window:<id>") drives the blend; the qualifier is per pixel', () => {
  const windowed = [node({ offset: .1, circOn: 1 })];
  assert.throws(() => colorTransform(managed, undefined, windowed)([.3, .3, .3]), /window needs pixel positions/);
  const plain = colorTransform(managed, undefined, [node({ offset: .1 })])([.3, .3, .3]), quarter = colorTransform(managed, undefined, windowed, undefined, id => { assert.equal(id, 'window:n'); return .25; })([.3, .3, .3]);
  quarter.forEach((v, i) => near(v, .3 + (plain[i] - .3) * .25, 'quarter blend', 1e-12));
  const [, cb, cr] = opponent([.8, .2, .2], W), keyed = colorTransform(legacy, undefined, [node({ offset: .1, qualOn: 1, qualHue: hueOf(cb, cr, W) * 360, qualHueWidth: 40, qualSatLow: 10 })]);
  assert.ok(keyed([.8, .2, .2])[1] > .29, 'red is graded'); near(keyed([.2, .7, .2])[1], .7, 'green is not', 1e-12);
});

test('validation: hue curves wrap, unknown curves and CSTs on windowed nodes are refused', () => {
  assert.throws(() => validateGradeNode({ curves: { HueSat: curve([[0, .5], [1, .6]]) } }), /hue curve wraps/);
  assert.doesNotThrow(() => validateGradeNode({ curves: { HueSat: curve([[0, .4], [.5, .7], [1, .4]]), LumSat: curve([[0, .2], [1, .9]]) } }));
  assert.throws(() => validateGradeNode({ curves: { Bogus: curve([[0, 0], [1, 1]]) } as never }), /Unknown curve/);
  assert.throws(() => validateGradeNode({ parameters: { gradOn: 1 }, effects: [{ id: 'x', type: 'cst', enabled: true, inputGamma: 'S-Log3', inputGamut: 'S-Gamut3.Cine', outputGamma: 'DaVinci Intermediate', outputGamut: 'DaVinci Wide Gamut', toneMapping: 'none', gamutMapping: 'none' }] }), /without windows or a qualifier/);
});

test('film reference: blur, vignette, grain statistics and determinism, halation colour', () => {
  // Blur keeps a flat field flat and spreads a dot symmetrically, with and without downsampling.
  for (const sigma of [2, 9.5]) {
    const w = 64, h = 48, flat = filmBlur(new Float32Array(w * h).fill(.3), w, h, 1, sigma);
    flat.forEach(v => near(v, .3, `flat at sigma ${sigma}`, 1e-6));
    const dot = new Float32Array(w * h); dot[24 * w + 32] = 1; const spread = filmBlur(dot, w, h, 1, sigma);
    assert.ok(spread[24 * w + 32] < .2 && spread[24 * w + 30] > 0 && spread[24 * w + 34] > 0, `dot spread at sigma ${sigma}`);
  }
  const width = 96, height = 54, stage = (p: Record<string, number>) => ({ p: filmParams(p), gamma: 'Gamma 2.4', weights: W });
  const grey = new Float32Array(width * height * 3).fill(.5);
  const vignette = applyFilm(grey, width, height, stage({ filmVignette: 100 }), 0);
  assert.ok(vignette[0] < .3 && Math.abs(vignette[(27 * width + 48) * 3] - .5) < 1e-6, 'corners darker, centre untouched');
  const grained = applyFilm(grey, width, height, stage({ filmGrain: 50 }), 3), again = applyFilm(grey, width, height, stage({ filmGrain: 50 }), 3), next = applyFilm(grey, width, height, stage({ filmGrain: 50 }), 4);
  const diff = Array.from(grained, v => v - .5), mean = diff.reduce((a, b) => a + b) / diff.length, sd = Math.sqrt(diff.reduce((a, b) => a + b * b, 0) / diff.length);
  assert.ok(Math.abs(mean) < .004 && sd > .01 && sd < .05, `grain mean ${mean} sd ${sd}`);
  assert.deepEqual(grained, again, 'same frame, same grain'); assert.notDeepEqual(grained, next, 'grain moves frame to frame');
  assert.deepEqual(applyFilm(grey, width, height, stage({ filmGrain: 50, filmGrainStatic: 1 }), 3), applyFilm(grey, width, height, stage({ filmGrain: 50, filmGrainStatic: 1 }), 9), 'still grain');
  const lamp = new Float32Array(width * height * 3).fill(.2); for (let y = 25; y < 29; y++) for (let x = 46; x < 50; x++) lamp.fill(1, (y * width + x) * 3, (y * width + x) * 3 + 3);
  const halo = applyFilm(lamp, width, height, stage({ filmHalation: 100, filmHalationThreshold: 0, filmHalationRadius: 4 }), 0), at = (27 * width + 53) * 3;
  assert.ok(halo[at] > .25 && halo[at] - .2 > 3 * (halo[at + 2] - .2), `a red glow next to the lamp: ${halo[at]} ${halo[at + 1]} ${halo[at + 2]}`);
});
