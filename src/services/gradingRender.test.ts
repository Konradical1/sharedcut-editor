// The export worker (scripts/color-render.py) against the CPU reference (grading.ts, filmLook.ts, color.ts): every per-pixel
// v3 step, windows by pixel position and the film stage on whole frames, through --stream as the export feeds it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorTransform, defaultCST, encodeLog, gradePicture, processingStages, starterGrade } from './color.ts';
import { eligibility } from './colorAssistant.ts';
import { GRADE_PARAMS, windowAlpha, opponent, hueOf } from './grading.ts';
import { applyFilm } from './filmLook.ts';
import { venvPython } from '../../server/platform.ts';
import type { Clip, ColorCurve, GradeNode, MediaAsset } from '../state/models.ts';

const python = process.env.FRAME_LINE_COLOR_PYTHON || venvPython('.venv-color'), script = fileURLToPath(new URL('../../scripts/color-render.py', import.meta.url));
const skip = !existsSync(python) && 'the colour worker (npm run setup:color) is not installed';
const legacy = { id: 'c', properties: {} } as unknown as Clip;
const managed = { id: 'c', properties: { colorPipeline: 'nodes-v2', inputProfile: 'DaVinci Intermediate', inputGamut: 'DaVinci Wide Gamut' } } as unknown as Clip;
const gamma = { id: 'c', properties: { colorPipeline: 'nodes-v2', inputProfile: 'Gamma 2.4', inputGamut: 'Rec.709' } } as unknown as Clip;
const node = (id: string, order: number, parameters: Record<string, number>, extra: Partial<GradeNode> = {}) => ({ id, projectId: 'p', clipId: 'c', kind: 'serial', name: id, enabled: true, order, parameters, ...extra }) as GradeNode;
const curve = (points: [number, number][]): ColorCurve => ({ mode: 'smooth', points: points.map(([x, y], i) => ({ id: `p${i}`, x, y })) });
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** Interleaved RGB frames through color-render.py --stream (planar G,B,R floats both ways, as the export decoder feeds it). */
function stream(job: Record<string, unknown>, frames: Float32Array[], width: number, height: number): Float32Array[] {
  const dir = mkdtempSync(join(tmpdir(), 'frameline-grading-render-')), file = join(dir, 'job.json'), n = width * height;
  try {
    writeFileSync(file, JSON.stringify({ width, height, ...job }));
    const input = new Float32Array(frames.length * n * 3);
    frames.forEach((rgb, f) => { for (let i = 0; i < n; i++) [1, 2, 0].forEach((c, plane) => { input[f * n * 3 + plane * n + i] = rgb[i * 3 + c]; }); });
    const out = execFileSync(python, [script, file, '--stream'], { input: Buffer.from(input.buffer), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
    const data = new Float32Array(new Uint8Array(out).buffer);
    assert.equal(data.length, frames.length * n * 3, 'one output frame per input frame');
    return frames.map((_, f) => { const rgb = new Float32Array(n * 3); for (let i = 0; i < n; i++) [1, 2, 0].forEach((c, plane) => { rgb[i * 3 + c] = data[f * n * 3 + plane * n + i]; }); return rgb; });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const job = (clip: Clip, nodes: GradeNode[], extra: Record<string, unknown> = {}) => ({ stages: processingStages(clip, nodes), managed: clip.properties.colorPipeline === 'nodes-v2', ...extra });
function worst(a: ArrayLike<number>, b: ArrayLike<number>) { let max = 0, sum = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); max = Math.max(max, d); sum += d; } return { max, mean: sum / a.length }; }

test('the worker reads the registry defaults (a key a node leaves out)', { skip }, () => {
  const defaults = JSON.parse(execFileSync(python, [script, '--defaults']).toString()) as Record<string, number>;
  for (const [key, value] of Object.entries(defaults)) assert.equal(value, GRADE_PARAMS.find(p => p.key === key)?.initial, key);
  for (const p of GRADE_PARAMS) if (/^(log(Low|High)Range|qual(?!On|Invert)|circ(?!On|Invert)|rect(?!On|Invert)|grad(?!On|Invert)|mix(?!Mono))/.test(p.key)) assert.ok(p.key in defaults, `the worker knows ${p.key}`);
});

test('every per-pixel v3 step grades like colorTransform, legacy and nodes-v2', { skip }, () => {
  const colors: number[][] = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) colors.push([r / 5, g / 5, b / 5].map(v => .02 + v * .93));
  colors.push([0, 0, 0], [1, 1, 1], [.336, .336, .336], [.5, .5, .5], [-.02, .3, 1.04], [.8, .2, .2], [.2, .7, .2], [.25, .3, .85], [.85, .55, .4], [.6, .62, .6]);
  const flat = Float32Array.from(colors.flat()), [red] = [[.8, .2, .2]], [, cb, cr] = opponent(red, [.2126, .7152, .0722]), redHue = hueOf(cb, cr, [.2126, .7152, .0722]) * 360;
  const hue = curve([[0, .5], [.08, .62], [.35, .44], [.7, .55], [1, .5]]);
  const cases: [string, GradeNode[]][] = [
    ['log wheels', [node('n', 1, { logShadowB: .05, logMid: -.03, logMidR: .02, logHighlight: .04, logHighlightG: -.02, logLowRange: .3, logHighRange: .62 })]],
    ['shadows and highlights', [node('n', 1, { shadows: 60, highlights: -40, contrast: 1.2, pivot: .42 })]],
    ['shadows and highlights the other way', [node('n', 1, { shadows: -50, highlights: 70 })]],
    ['hue, boost, density', [node('n', 1, { hue: 35, boost: 40, density: 60, saturation: 110 })]],
    ['hue alone', [node('n', 1, { hue: -120 })]], ['boost down', [node('n', 1, { boost: -50 })]], ['density', [node('n', 1, { density: 100 })]],
    ['hue vs hue', [node('n', 1, {}, { curves: { HueHue: hue } })]], ['hue vs sat', [node('n', 1, {}, { curves: { HueSat: curve([[0, .3], [.3, .7], [.6, .5], [1, .3]]) } })]],
    ['hue vs lum', [node('n', 1, {}, { curves: { HueLum: curve([[0, .65], [.4, .4], [1, .65]]) } })]], ['lum vs sat', [node('n', 1, {}, { curves: { LumSat: curve([[0, .2], [.5, .6], [1, .35]]) } })]],
    ['sat vs sat', [node('n', 1, {}, { curves: { SatSat: curve([[0, .5], [.4, .7], [1, .4]]) } })]], ['sat vs lum', [node('n', 1, {}, { curves: { SatLum: curve([[0, .5], [.6, .35], [1, .6]]) } })]],
    ['all six HSL curves with custom curves', [node('n', 1, { saturation: 120 }, { curves: { RGB: curve([[0, 0], [.4, .35], [1, 1]]), G: curve([[0, .02], [1, .97]]), HueHue: hue, HueSat: curve([[0, .55], [.5, .45], [1, .55]]), HueLum: curve([[0, .45], [.3, .6], [1, .45]]), LumSat: curve([[0, .4], [1, .6]]), SatSat: curve([[0, .5], [1, .45]]), SatLum: curve([[0, .5], [1, .55]]) } })]],
    ['mixer', [node('n', 1, { mixRR: .8, mixRG: .3, mixRB: -.1, mixGR: .1, mixGG: .9, mixBB: 1.2, mixBG: -.2 })]],
    ['monochrome mixer', [node('n', 1, { mixRR: .3, mixRG: .6, mixRB: .1, mixMono: 1 })]],
    ['qualifier on red with soft edges', [node('n', 1, { offset: .1, saturation: 140, qualOn: 1, qualHue: redHue, qualHueWidth: 40, qualHueSoft: 25, qualSatLow: 15, qualSatSoft: 10, qualLumHigh: 85, qualLumSoft: 12 })]],
    ['inverted qualifier, hard saturation floor', [node('n', 1, { gain: .7, qualOn: 1, qualInvert: 1, qualHue: 200, qualHueWidth: 90, qualHueSoft: 30, qualSatLow: 30, qualSatSoft: 0 })]],
    ['everything over two nodes', [node('a', 1, { exposure: .3, temperature: 400, tint: -10, liftR: .02, gammaB: -.05, gainG: .03, offsetR: .01, logShadowR: .02, shadows: 25, hue: 10, boost: 20, density: 30, saturationShadows: 120, mixRG: .05, mixRR: .95 }, { curves: { HueSat: curve([[0, .55], [.5, .45], [1, .55]]) } }),
      node('b', 2, { contrast: 1.1, highlights: -30, logHighlightB: -.02, qualOn: 1, qualLumLow: 40, qualLumSoft: 20, saturation: 90 }, { curves: { SatLum: curve([[0, .5], [1, .45]]), LumSat: curve([[0, .45], [1, .55]]) } })]],
  ];
  for (const clip of [legacy, managed, gamma]) for (const [name, nodes] of cases) {
    const [out] = stream(job(clip, nodes), [flat], colors.length, 1), cpu = colorTransform(clip, undefined, nodes);
    colors.forEach((rgb, i) => cpu(rgb).forEach((v, c) => { const py = clamp(out[i * 3 + c]); assert.ok(Math.abs(v - py) <= 1e-5, `${clip.properties.colorPipeline ?? 'legacy'} ${clip.properties.inputProfile ?? ''} ${name}: ${rgb} channel ${c}: ${v} vs ${py}`); }));
  }
  // A camera input CST, then a v3 node in DaVinci Wide Gamut / Intermediate.
  const camera = { id: 'c', properties: { colorPipeline: 'nodes-v2', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } } as unknown as Clip;
  const nodes = [node('in', 1, {}, { effects: [defaultCST('cst')] }), node('look', 2, { hue: 15, boost: 30, shadows: -20, qualOn: 1, qualHue: 30, qualHueWidth: 60, qualHueSoft: 20 }, { curves: { HueLum: curve([[0, .55], [.5, .45], [1, .55]]) } })];
  const [out] = stream(job(camera, nodes), [flat], colors.length, 1), cpu = colorTransform(camera, undefined, nodes);
  colors.forEach((rgb, i) => cpu(rgb).forEach((v, c) => assert.ok(Math.abs(v - clamp(out[i * 3 + c])) <= 1e-5, `S-Log3 input CST then a v3 node: ${rgb} ${c}`)));
  // Apple Log both ways: exposure on the camera signal (before the Input CST), Rec.2020 into the working space and back out to Apple Log.
  const iphone = { id: 'c', properties: { colorPipeline: 'nodes-v2', inputProfile: 'Apple Log', inputGamut: 'Rec.2020' } } as unknown as Clip;
  const apple = [node('in', 1, { exposure: .3, temperature: 300 }, { effects: [defaultCST('cst', 'Apple Log', 'Rec.2020')] }), node('look', 2, { saturation: 120, shadows: 15, logMid: .02 }),
    node('back', 3, {}, { effects: [defaultCST('out', 'DaVinci Intermediate', 'DaVinci Wide Gamut', 'Apple Log', 'Rec.2020')] })];
  const [phone] = stream(job(iphone, apple), [flat], colors.length, 1), reference = colorTransform(iphone, undefined, apple);
  colors.forEach((rgb, i) => reference(rgb).forEach((v, c) => assert.ok(Math.abs(v - clamp(phone[i * 3 + c])) <= 1e-5, `Apple Log in and out: ${rgb} channel ${c}: ${v} vs ${phone[i * 3 + c]}`)));
});

test('windows blend by pixel position like windowAlpha, across stripes and odd sizes', { skip }, () => {
  const width = 37, height = 150, n = width * height, picture = new Float32Array(n * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) picture.set([.15 + .7 * x / width, .2 + .6 * y / height, .45], (y * width + x) * 3);
  const windows = { circOn: 1, circX: .4, circY: .55, circW: .3, circH: .2, circAngle: 30, circSoft: .1, rectOn: 1, rectX: .6, rectY: .2, rectW: .25, rectH: .15, rectAngle: -20, rectSoft: .04, rectRound: .4, rectInvert: 1, gradOn: 1, gradAngle: 160, gradY: .8, gradSoft: .2 };
  for (const clip of [legacy, managed]) {
    const nodes = [node('a', 1, { offset: .2, saturation: 130, ...windows }), node('b', 2, { gain: .8, gradOn: 1, gradAngle: 90, gradX: .3, gradSoft: .5, qualOn: 1, qualLumLow: 30, qualLumSoft: 10 })];
    const [out] = stream(job(clip, nodes), [picture], width, height);
    let max = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, px = (x + .5) / width, py = (y + .5) / height, alpha = (id: string) => windowAlpha(px, py, width / height, nodes.find(item => `window:${item.id}` === id)!.parameters);
      colorTransform(clip, undefined, nodes, undefined, alpha)([...picture.subarray(i * 3, i * 3 + 3)]).forEach((v, c) => { max = Math.max(max, Math.abs(v - clamp(out[i * 3 + c]))); });
    }
    assert.ok(max <= 1e-5, `${clip.properties.colorPipeline ?? 'legacy'} windows: worst ${max}`);
  }
});

/** A picture with a dark-to-mid gradient, saturated patches and a few small bright lights (what halation and bloom read). */
function filmPicture(width: number, height: number, bright: number) {
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3, u = x / width, v = y / height;
    rgb.set([.08 + .5 * u, .1 + .4 * v, .3 - .2 * u * v], i);
    if (x > width * .6 && y < height * .3) rgb.set([.75, .2, .15], i);
    if (Math.hypot(x - width * .3, y - height * .5) < height * .06 || Math.hypot(x - width * .8, y - height * .75) < height * .03) rgb.fill(bright, i, i + 3);
  }
  return rgb;
}
const everyFilm = { filmHalation: 80, filmHalationThreshold: .5, filmHalationRadius: 6, filmBloom: 60, filmBloomThreshold: .3, filmBloomRadius: 18, filmBloomWarmth: 40, filmGrain: 70, filmGrainSize: 1.3, filmGrainColor: 45, filmGrainResponse: 60, filmGrainSeed: 11,
  filmVignette: 60, filmVignetteSize: 40, filmVignetteSoftness: 60, filmVignetteRoundness: 30, filmWeave: 100, filmBreath: 100, filmAberration: 100 };

test('the film stage renders like applyFilm, between nodes, at the source frame', { skip }, () => {
  const cases: { clip: Clip; width: number; height: number; bright: number; film: Record<string, number>; frames: number[]; job: Record<string, unknown> }[] = [
    // Gamma 2.4 (legacy), every effect, the frame from the decoder clock: seek 37/24 s at 24 fps is frame 37, then 38.
    { clip: legacy, width: 160, height: 90, bright: .97, film: everyFilm, frames: [37, 38], job: { seek: 37 / 24, numericFps: 24 } },
    // DaVinci Intermediate, odd sizes (ceil halvings, clamped edges), blur levels 0-2, frames counted from media.ts's filmFrame.
    { clip: managed, width: 157, height: 91, bright: .62, film: { ...everyFilm, filmHalationRadius: 3, filmGrainStatic: 0, filmGrainColor: 0 }, frames: [1200, 1201], job: { filmFrame: 1200, numericFps: 30 } },
    { clip: managed, width: 240, height: 135, bright: .6, film: { filmHalation: 100, filmHalationRadius: 10, filmHalationHue: 30, filmHalationSat: 60, filmBloom: 100, filmBloomRadius: 20, filmBloomWarmth: -50, filmGrain: 40, filmGrainStatic: 1, filmVignette: -40 }, frames: [5], job: { seek: 0, numericFps: 25, filmFrame: 5 } },
  ];
  for (const { clip, width, height, bright, film, frames, job: extra } of cases) {
    const before = node('a', 1, { offset: .02, saturation: 110 }), after = node('b', 2, { saturation: 120, gain: .95 }), grain = node('f', 1.5, film);
    const nodes = [before, grain, after], stages = processingStages(clip, nodes), stage = stages.find(s => s.type === 'film')! as Extract<typeof stages[number], { type: 'film' }>;
    assert.deepEqual(stages.map(s => s.type), ['correction', 'correction', 'film', 'correction']);
    const picture = filmPicture(width, height, bright), n = width * height, first = colorTransform(clip, undefined, [before, grain]), last = colorTransform(clip, undefined, [after]);
    const graded = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) graded.set(first([...picture.subarray(i * 3, i * 3 + 3)]), i * 3);
    const out = stream(job(clip, nodes, extra), frames.map(() => picture), width, height);
    frames.forEach((frame, f) => {
      const filmed = applyFilm(graded, width, height, stage, frame), expected = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) expected.set(last([...filmed.subarray(i * 3, i * 3 + 3)]), i * 3);
      const { max, mean } = worst(expected, out[f].map(clamp));
      assert.ok(mean <= 1e-4 && max <= 1e-3, `${clip.properties.inputProfile ?? 'legacy'} ${width}×${height} frame ${frame}: mean ${mean} max ${max}`);
    });
    if (frames.length > 1 && !film.filmGrainStatic) assert.ok(worst(out[0], out[1]).max > .01, 'grain and weave move from frame to frame');
  }
});

/** final_detail.pattern(H, W), encoded: a linear blue sky with a 1.6 cloud over a hazy textured ridge (what Dehaze and Clarity read). */
function hazy(width: number, height: number, encode = (v: number) => v) {
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < height; i++) for (let j = 0; j < width; j++) {
    const v = (i + .5) / height, u = (j + .5) / width, ridge = .38 + .06 * Math.sin(6.1 * u) + .02 * Math.sin(31 * u), fade = 1 - .6 * Math.min(Math.max(v - ridge, 0), 1);
    const tex = 2 ** (.8 * Math.sin(53 * u + 3 * v) * Math.sin(41 * v - 2 * u) + .4 * Math.sin(170 * u) * Math.sin(150 * v));
    rgb.set(((u - .3) ** 2 * (width / height) ** 2 + (v - .18) ** 2 < .07 ** 2 ? [1.6, 1.6, 1.6] : v < ridge ? [.2, .28, .55].map(c => c * (1 + .25 * v)) : [1, .95, .86].map((c, k) => .045 * tex * c * .5 + [.3, .33, .38][k] * .5 * fade)).map(encode), (i * width + j) * 3);
  }
  return rgb;
}

test('Dehaze and Clarity grade like gradePicture: alone, in the C993 grade through ACES 2, legacy (also after a CST), after film, under a window and a qualifier, k = 0..3', { skip, timeout: 300_000 }, t => {
  const apple = { id: 'c', properties: { colorPipeline: 'nodes-v2', inputProfile: 'Apple Log', inputGamut: 'Rec.2020' } } as unknown as Clip, log = (v: number) => encodeLog(v * 1.9, 'Apple Log');
  // Konrad's C993 grade (lab c993-stages.json) with a detail node between Balance and Look. TS has no ACES 2 (OCIO only): both engines
  // grade the four nodes, then the same worker's ACES 2 output stages turn each into display codes.
  const c993 = [node('in', 1, {}, { effects: [defaultCST('cst-in', 'Apple Log', 'Rec.2020')] }), node('balance', 2, { exposure: -.95, pivot: .336043 }), node('detail', 2.5, { dehaze: 60, clarity: 35 }),
    node('look', 3, { pivot: .336, saturation: 117, boost: 25, shadows: 25, highlights: -15, logHighRange: .42, logHighlightR: .02, logHighlightB: -.02, logMidR: .005, logMidB: .002, logShadowR: -.002, logShadowB: .0015, gainR: .005, gainB: -.006, logMidG: .001 })];
  const aces = processingStages(apple, [...c993, node('out', 4, {}, { effects: [{ ...defaultCST('cst-out', 'DaVinci Intermediate', 'DaVinci Wide Gamut', 'Gamma 2.4', 'Rec.709'), toneMapping: 'aces2', gamutMapping: 'none' }] })]).filter(s => s.node.id === 'out');
  const film = node('f', 1.5, { filmHalation: 80, filmHalationRadius: 6, filmBloom: 60, filmBloomRadius: 18, filmVignette: 40, filmGrain: 40, filmGrainSeed: 3 });
  const cases: { name: string; clip: Clip; width: number; height: number; nodes: GradeNode[]; picture?: Float32Array; display?: boolean; film?: boolean }[] = [
    { name: 'detail only, two nodes back to back', clip: managed, width: 160, height: 90, nodes: [node('d', 1, { dehaze: 60, clarity: 40, exposure: .3, temperature: 500, tint: -10 }), node('e', 2, { dehaze: -50, clarity: -40, saturation: 110 })] },
    { name: 'C993 through ACES 2, 963×541 (k = 1)', clip: apple, width: 963, height: 541, nodes: c993, picture: hazy(963, 541, log), display: true },
    { name: 'legacy', clip: legacy, width: 157, height: 91, nodes: [node('d', 1, { dehaze: 50, clarity: 30, gain: .9, saturation: 110, lift: .02 }), node('e', 2, { dehaze: -40, contrast: 1.1 })] },
    { name: 'legacy after a CST to DaVinci Intermediate', clip: legacy, width: 160, height: 90, nodes: [node('a', 1, {}, { effects: [defaultCST('cst-a', 'Gamma 2.4', 'Rec.709', 'DaVinci Intermediate', 'Rec.709')] }), node('d', 2, { dehaze: 60, clarity: 40 }), node('z', 3, {}, { effects: [defaultCST('cst-z', 'DaVinci Intermediate', 'Rec.709', 'Gamma 2.4', 'Rec.709')] })] },
    { name: 'after a film node', clip: managed, width: 240, height: 135, nodes: [node('a', 1, { offset: .02 }), film, node('d', 1.7, { dehaze: 60, clarity: 50 }), node('b', 2, { saturation: 120 })], film: true },
    { name: 'under a gradient window and a qualifier', clip: managed, width: 200, height: 113, nodes: [node('d', 1, { dehaze: 70, clarity: 60, gain: 1.05, gradOn: 1, gradAngle: 160, gradY: .5, gradSoft: .3, qualOn: 1, qualLumLow: 30, qualLumSoft: 15 })] },
    { name: '75×1081 (k = 2)', clip: managed, width: 75, height: 1081, nodes: [node('d', 1, { dehaze: 100, clarity: 100 })] },
    { name: '121×2161 (k = 3)', clip: managed, width: 121, height: 2161, nodes: [node('d', 1, { dehaze: 35, clarity: -40, exposure: -.5 })] },
  ];
  for (const { name, clip, width, height, nodes, picture = hazy(width, height, v => encodeLog(v, clip === legacy ? 'Gamma 2.4' : 'DaVinci Intermediate')), display, film: filmed } of cases) {
    const extra = filmed ? { filmFrame: 5, numericFps: 24 } : {}, [py] = stream(job(clip, nodes, extra), [picture], width, height), ts = gradePicture(clip, undefined, nodes, picture, width, height, { frame: 5 });
    const finish = (rgb: Float32Array) => display ? stream({ stages: aces, managed: true }, [rgb], width, height)[0].map(clamp) : rgb;
    const { max, mean } = worst(finish(ts), finish(py.map(clamp)));
    t.diagnostic(`${name}: max ${(max * 255).toExponential(1)}, mean ${(mean * 255).toExponential(1)} ${display ? 'display' : 'output'} codes (of 255)`);
    assert.ok(max <= 1e-4, `${name}: mean ${mean} max ${max}`);
    assert.ok(worst(py.map(clamp), stream(job(clip, nodes.map(n => ({ ...n, parameters: { ...n.parameters, dehaze: 0, clarity: 0 } })), extra), [picture], width, height)[0].map(clamp)).max > .02, `${name}: the tools show`);
  }
});

test('the Color Assistant and Normalize workers grade through film stages (skipped) and windows (by stripe rows)', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'frameline-grading-assistant-'));
  try {
    const nodes = [node('a', 1, { offset: .1, circOn: 1, circX: .3, circY: .6, circSoft: .2 }), node('b', 2, { saturation: 120, filmGrain: 50, filmHalation: 40 })];
    writeFileSync(join(dir, 'stages.json'), JSON.stringify(processingStages(managed, nodes)));
    // graded() is what measure/render/match and Normalize's display() run; grade_frame without its film stage is the reference.
    const out = execFileSync(python, ['-c', `import importlib.util,json,sys,numpy as np
spec=importlib.util.spec_from_file_location('ca',sys.argv[1]);ca=importlib.util.module_from_spec(spec);spec.loader.exec_module(ca)
stages=json.load(open(sys.argv[2]));frame=np.random.default_rng(1).random((150,37,3),dtype=np.float32)*.5+.1
got=ca.graded(frame.copy(),stages);want=ca.engine.grade_frame(frame.copy(),[s for s in stages if s['type']!='film'])
print(json.dumps({'diff':float(np.abs(got-want).max()),'window':float(np.abs(got-frame).max())}))`, script.replace('color-render.py', 'color-assistant.py'), join(dir, 'stages.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const { diff, window } = JSON.parse(out.toString().trim().split('\n').at(-1)!);
    assert.ok(diff === 0 && window > .05, `graded() matches grade_frame without film: ${diff}, and the grade shows: ${window}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the Color Assistant leaves shots with a window or a qualifier alone; film does not block it', () => {
  const shot = { id: 'c1', projectId: 'p1', name: 'Shot', properties: { colorPipeline: 'nodes-v2', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' }, keyframes: {}, effects: [] } as unknown as Clip;
  const camera = { id: 'a1', cameraMetadataVersion: 2, inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } as MediaAsset;
  let n = 0; const nodes = starterGrade(shot, camera, () => `g${++n}`), out = nodes[3].effects![0]; if (out.type === 'cst') Object.assign(out, { toneMapping: 'aces2', gamutMapping: 'none' });
  const with_ = (name: string, p: Record<string, number>) => { const r = eligibility(shot, camera, nodes.map(x => x.name === name ? { ...x, parameters: { ...x.parameters, ...p } } : x)); return r.ok ? 'ok' : `${r.code}: ${r.text}`; };
  assert.equal(with_('Look', {}), 'ok');
  for (const p of [{ circOn: 1 }, { rectOn: 1 }, { gradOn: 1 }, { qualOn: 1 }] as Record<string, number>[]) assert.equal(with_('Look', p), 'masked-node: A node on this shot uses a mask, window or qualifier.', JSON.stringify(p));
  assert.equal(with_('Balance', { circOn: 0, qualOn: 0, filmGrain: 30 }), 'ok', 'switched-off tools and film stay eligible');
});

test('LUT bakes and grades without positions refuse windows, film, dehaze and clarity', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'frameline-grading-cube-'));
  try {
    for (const parameters of [{ circOn: 1 }, { filmGrain: 20 }, { dehaze: 30 }, { clarity: -20 }] as Record<string, number>[]) {
      writeFileSync(join(dir, 'job.json'), JSON.stringify(job(managed, [node('n', 1, { offset: .1, ...parameters })])));
      assert.throws(() => execFileSync(python, [script, join(dir, 'job.json'), '--cube', '9', join(dir, 'out.cube')], { stdio: 'pipe' }), /whole frames/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
