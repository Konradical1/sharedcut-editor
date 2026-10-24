// Dehaze and Clarity (docs/color-grading-v3.md, "Detail"): the CPU reference against final_detail.py's pinned vectors, its edge cases,
// and the detail point inside the grade (decode × G, first in its node, limited by the node blend, whole frames only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorTransform, decodeLog, encodeLog, gradePicture, luminanceWeights } from './color.ts';
import { applyDetail, detailActive, qualifierAlpha, spatialGrade, validateGradeParameters } from './grading.ts';
import { detailAt, detailMaps } from './filmLook.ts';
import { lookPatch } from './colorPresets.ts';
import { neutralBalance, neutralLook, proposedNodes } from './colorAssistant.ts';
import type { Clip, GradeNode } from '../state/models.ts';

const node = (id: string, order: number, parameters: Record<string, number>, extra: Partial<GradeNode> = {}) => ({ id, projectId: 'p', clipId: 'c', kind: 'serial', name: id, enabled: true, order, parameters, ...extra }) as GradeNode;
const clip = (properties: Record<string, unknown>) => ({ id: 'c', projectId: 'p', name: 'Shot', properties }) as unknown as Clip;
const managed = clip({ colorPipeline: 'nodes-v2', inputProfile: 'DaVinci Intermediate', inputGamut: 'DaVinci Wide Gamut' }), legacy = clip({});
/** DaVinci Wide Gamut luma weights as float32, as final_detail.py used them. */
const W_DWG = [0.2741185128688812, 0.8736318945884705, -0.14775040745735168];

/** final_detail.pattern(H, W): linear blue sky with a white 1.6 cloud over a hazy textured ridge. */
function pattern(H: number, W: number) {
  const img = new Float32Array(H * W * 3);
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
    const v = (i + .5) / H, u = (j + .5) / W, ridge = .38 + .06 * Math.sin(6.1 * u) + .02 * Math.sin(31 * u), fade = 1 - .6 * Math.min(Math.max(v - ridge, 0), 1);
    const tex = 2 ** (.8 * Math.sin(53 * u + 3 * v) * Math.sin(41 * v - 2 * u) + .4 * Math.sin(170 * u) * Math.sin(150 * v));
    img.set((u - .3) ** 2 * (W / H) ** 2 + (v - .18) ** 2 < .07 ** 2 ? [1.6, 1.6, 1.6] : v < ridge ? [.2, .28, .55].map(c => c * (1 + .25 * v)) : [1, .95, .86].map((c, k) => .045 * tex * c * .5 + [.3, .33, .38][k] * .5 * fade), (i * W + j) * 3);
  }
  return img;
}
/** final_detail.detail: maps, then the tools at every pixel, on a linear picture. */
function detail(lin: Float32Array, width: number, height: number, p: Record<string, number>, w = W_DWG) {
  const maps = detailMaps(lin, width, height, { gamma: 'Linear', weights: w }), out = new Float32Array(lin.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 3; out.set(applyDetail(Array.from(lin.subarray(i, i + 3)), w, p, detailAt(maps, width, height, x, y)), i); }
  return out;
}
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const encoded = (lin: Float32Array, gamma: string) => lin.map(v => encodeLog(v, gamma));

// vectors.json (final_detail.py, ~/sc-dehaze/work/final): input pattern(H, W), W_DWG, G = 1, linear in and out; texels [row, col, M1 xyzw, M2 xyzw]
// at level k (size = wk×hk), pixels [row, col] and their outputs per 'dehaze,clarity'. Five of the eight pinned pixels: sky, cloud, sky by the ridge, terrain.
const VECTORS: { height: number; width: number; k: number; size: number[]; texels: number[][]; pixels: number[][]; out: Record<string, number[][]> }[] = [
  { height: 37, width: 61, k: 0, size: [61, 37], texels: [[7,18,0.725533,0.845337,-0.006729,0.022773,0.000607,0.001032,-6.8e-05,0.000136],[14,30,0.310145,0.102927,-0.051476,0.156131,0.120545,0.040283,-0.013401,0.020671],[25,48,0.051643,-0.284557,0.001132,0.140509,0.140855,-0.012251,-0.014428,0.021773]],
    pixels: [[1,6],[6,18],[14,10],[16,49],[34,57]], out: { '60,0': [[0.1928244,0.2747274,0.5536424],[1.6,1.6,1.6],[0.212483,0.3017818,0.6059871],[0.1227216,0.1306,0.1436622],[0.0828643,0.0882115,0.0970824]], '0,60': [[0.2020262,0.2828368,0.5555722],[1.611644,1.611644,1.611644],[0.2281149,0.3193609,0.6273161],[0.1588181,0.1716539,0.1929115],[0.1103952,0.1190585,0.1333918]], '-50,0': [[0.2490715,0.3205436,0.5617617],[1.6,1.6,1.6],[0.2649015,0.3428958,0.6061269],[0.2260638,0.2364038,0.253528],[0.1614905,0.1685635,0.1802655]], '100,100': [[0.1859474,0.2689958,0.5535685],[1.6194538,1.6194538,1.6194538],[0.220857,0.3174285,0.6485142],[0.1027115,0.1087612,0.1188052],[0.0672362,0.0714213,0.0783848]], '35,-40': [[0.1968107,0.2781793,0.5542271],[1.5961374,1.5961374,1.5961374],[0.2128236,0.3003259,0.5972451],[0.1396267,0.1494728,0.1657868],[0.0966354,0.1033391,0.1144433]] } },
  { height: 270, width: 480, k: 0, size: [480, 270], texels: [[53,143,0.702329,0.920452,-0.006684,0.022481,0.000352,0.000598,-4e-05,7.9e-05],[107,239,0.32325,0.094503,-0.05211,0.15726,0.117729,0.038437,-0.014207,0.020624],[188,383,0.069279,-0.27612,0.001375,0.140747,0.14179,-0.011305,-0.014271,0.021542]],
    pixels: [[13,47],[48,143],[107,81],[121,397],[255,455]], out: { '60,0': [[0.1934183,0.2754997,0.5549875],[1.6,1.6,1.6],[0.2127827,0.302089,0.6073582],[0.1129131,0.1211828,0.1349555],[0.0908861,0.0958366,0.1040027]], '0,60': [[0.2024998,0.2834997,0.5568745],[1.6128539,1.6128539,1.6128539],[0.2300822,0.322115,0.632726],[0.1493249,0.1624712,0.1843023],[0.1182712,0.1266221,0.1403859]], '-50,0': [[0.2494512,0.3211205,0.5630045],[1.6,1.6,1.6],[0.2652868,0.34326,0.6064194],[0.2190429,0.2297695,0.2475823],[0.1662321,0.1729237,0.1839526]], '100,100': [[0.1866426,0.2698513,0.5549129],[1.6214803,1.6214803,1.6214803],[0.2237994,0.3214982,0.6583879],[0.0924412,0.0990617,0.1101215],[0.0761663,0.0798158,0.0858426]], '35,-40': [[0.19735,0.2789035,0.5555584],[1.5957383,1.5957383,1.5957383],[0.2126211,0.2999631,0.5969219],[0.1312185,0.1414797,0.1585413],[0.1031609,0.1094422,0.1197985]] } },
  { height: 541, width: 963, k: 1, size: [482, 271], texels: [[54,144,0.726589,0.842865,-0.006361,0.021373,0.000398,0.000677,-4.5e-05,8.9e-05],[108,240,0.314747,0.080246,-0.049291,0.159678,0.127013,0.04088,-0.015282,0.022135],[189,384,0.06964,-0.279892,0.001373,0.140343,0.141282,-0.011908,-0.014256,0.021517]],
    pixels: [[27,96],[97,288],[216,163],[243,798],[513,913]], out: { '60,0': [[0.1934725,0.2755688,0.5551037],[1.6,1.6,1.6],[0.212412,0.3019658,0.6085745],[0.1136811,0.1219187,0.1356332],[0.0932844,0.0981303,0.1061079]], '0,60': [[0.2025414,0.2835579,0.5569888],[1.6129121,1.6129121,1.6129121],[0.2316711,0.3243395,0.6370955],[0.1499916,0.163138,0.1849665],[0.1206455,0.1289304,0.1425706]], '-50,0': [[0.2494836,0.321171,0.5631161],[1.6,1.6,1.6],[0.2659688,0.3437461,0.6062443],[0.2193736,0.2300871,0.2478757],[0.1674145,0.1740106,0.1848705]], '100,100': [[0.1867072,0.2699283,0.5550262],[1.6215779,1.6215779,1.6215779],[0.2253784,0.3246585,0.6679401],[0.0932597,0.0998175,0.1107672],[0.0791031,0.0826023,0.0883622]], '35,-40': [[0.1973985,0.2789679,0.5556747],[1.5957191,1.5957191,1.5957191],[0.2120103,0.2993061,0.5963829],[0.1318261,0.1420636,0.1590818],[0.1049961,0.1111669,0.1213261]] } },
  { height: 1080, width: 1920, k: 2, size: [480, 270], texels: [[53,143,0.702216,0.920865,-0.00571,0.019145,0.000246,0.000419,-2.8e-05,5.5e-05],[107,239,0.322922,0.094022,-0.050664,0.15746,0.119368,0.042393,-0.014491,0.020928],[188,383,0.069352,-0.27612,0.001363,0.140737,0.141779,-0.011312,-0.014273,0.021544]],
    pixels: [[53,191],[194,575],[431,326],[485,1592],[1025,1823]], out: { '60,0': [[0.1933887,0.2754616,0.5549222],[1.6,1.6,1.6],[0.2125201,0.3019668,0.6080548],[0.1139215,0.1221584,0.1358711],[0.0949817,0.0997361,0.1075506]], '0,60': [[0.2024767,0.2834673,0.5568109],[1.61292,1.61292,1.61292],[0.2308893,0.3232451,0.6349457],[0.1502417,0.1633836,0.185203],[0.1223601,0.1306127,0.1441901]], '-50,0': [[0.2494329,0.3210924,0.562943],[1.6,1.6,1.6],[0.2658194,0.3436701,0.606416],[0.2197151,0.2304255,0.2482082],[0.1684537,0.1749979,0.1857647]], '100,100': [[0.1866077,0.2698089,0.5548484],[1.6215914,1.6215914,1.6215914],[0.2244112,0.3229305,0.6632895],[0.0934477,0.1000025,0.1109467],[0.0811664,0.0845188,0.0900209]], '35,-40': [[0.1973233,0.2788679,0.5554937],[1.5957164,1.5957164,1.5957164],[0.2122831,0.2996134,0.5967216],[0.1320847,0.142321,0.1593364],[0.1063427,0.1124348,0.1224535]] } },
];

test('Dehaze/Clarity reference vectors: maps and pixels at k = 0, 0, 1, 2 (the GPU and color-render.py reproduce these)', t => {
  // a_c and b_c come from E[l²] − E[l]², which float32 accumulation in numpy (and the GPU) rounds to ~3e-5; everything else agrees to rounding.
  let mapError = 0, coefficientError = 0, pixelError = 0;
  for (const v of VECTORS) {
    const pic = pattern(v.height, v.width), maps = detailMaps(pic, v.width, v.height, { gamma: 'Linear', weights: W_DWG });
    assert.deepEqual([maps.k, maps.wk, maps.hk], [v.k, ...v.size], `${v.width}×${v.height}: level and size`);
    for (const [r, c, ...want] of v.texels) want.forEach((x, i) => { const e = Math.abs((i < 4 ? maps.m1 : maps.m2)[(r * maps.wk + c) * 4 + i % 4] - x); if (i < 2) coefficientError = Math.max(coefficientError, e); else mapError = Math.max(mapError, e); });
    for (const [key, outs] of Object.entries(v.out)) {
      const [dehaze, clarity] = key.split(',').map(Number);
      v.pixels.forEach(([r, c], i) => { const at = (r * v.width + c) * 3, got = applyDetail(Array.from(pic.subarray(at, at + 3)), W_DWG, { dehaze, clarity }, detailAt(maps, v.width, v.height, c, r)); got.forEach((x, ch) => pixelError = Math.max(pixelError, Math.abs(x - outs[i][ch]) / Math.max(1, Math.abs(outs[i][ch])))); });
    }
  }
  t.diagnostic(`max error: a_c/b_c ${coefficientError.toExponential(2)}, α/β/M2 ${mapError.toExponential(2)}, pixels ${pixelError.toExponential(2)} (relative)`);
  assert.ok(coefficientError < 5e-5 && mapError < 1e-6 && pixelError < 1e-6, `a_c/b_c ${coefficientError}, maps ${mapError}, pixels ${pixelError}`);
});

test('identity at 0 or absent; a flat field stays flat, black stays black, wild input stays finite', () => {
  const lin = [.2, .3, .1], u = [.5, .1, .2, .3, .1, 0, .01, .02];
  assert.equal(applyDetail(lin, W_DWG, {}, u), lin); assert.equal(applyDetail(lin, W_DWG, { dehaze: 0, clarity: 0 }, u), lin);
  assert.ok(!detailActive({}) && !detailActive({ dehaze: 0, clarity: 0 }) && detailActive({ clarity: -1 }));
  const flat = new Float32Array(120 * 160 * 3).fill(.2);
  assert.ok(maxDiff(detail(flat, 160, 120, { clarity: 100 }), flat) < 1e-6, 'clarity leaves a flat field alone');
  for (const p of [{ dehaze: 60, clarity: 40 }, { dehaze: -60, clarity: -40 }]) { const out = detail(flat, 160, 120, p); assert.ok(Math.max(...out) - Math.min(...out) < 1e-6, `${JSON.stringify(p)}: flat stays flat`); }
  const black = new Float32Array(90 * 160 * 3);
  for (const p of [{ dehaze: 100, clarity: 100 }, { dehaze: -100, clarity: -100 }]) assert.ok(Math.max(...detail(black, 160, 90, p).map(Math.abs)) < 1e-9, `${JSON.stringify(p)}: black stays black`);
  let seed = 1; const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32;
  const wild = Float32Array.from({ length: 81 * 107 * 3 }, (_, i) => 2 ** (-3 + 4 * (random() - .5)) * (i % 7 === 0 ? -3 : i % 11 === 0 ? 1e4 : 1));
  for (const p of [{ dehaze: 100, clarity: 100 }, { dehaze: -100, clarity: -100 }, { dehaze: 35, clarity: 20 }, { dehaze: 100 }, { dehaze: -100 }] as Record<string, number>[]) assert.ok(detail(wild, 107, 81, p).every(Number.isFinite), `${JSON.stringify(p)}: finite`);
});

test('local: a bright object far away changes nothing beyond the blur support (no frame statistic)', () => {
  // 270 rows: k = 0, σ' = 5.4, support 5 + 17 + 17 texels; the check starts 54 pixels away.
  const pic = pattern(270, 480), bright = pic.slice();
  for (let y = 100; y < 150; y++) bright.fill(8, y * 480 * 3, (y * 480 + 40) * 3);
  for (const p of [{ dehaze: 60, clarity: 30 }, { dehaze: 100, clarity: 100 }, { dehaze: -50 }] as Record<string, number>[]) {
    const a = detail(pic, 480, 270, p), b = detail(bright, 480, 270, p);
    for (let y = 0; y < 270; y++) for (let x = 94; x < 480; x++) for (let c = 0; c < 3; c++) assert.equal(b[(y * 480 + x) * 3 + c], a[(y * 480 + x) * 3 + c], `${JSON.stringify(p)} moved at ${x}, ${y}`);
  }
});

test('the registry: whole frames only (spatialGrade, no LUT), limits validated', () => {
  assert.ok(spatialGrade('c', [node('n', 1, { clarity: 20 })]) && !spatialGrade('c', [node('n', 1, { dehaze: 0 })]) && !spatialGrade('c', [node('n', 1, { dehaze: 50 }, { enabled: false })]));
  assert.throws(() => colorTransform(managed, undefined, [node('n', 1, { dehaze: 50 })])([.3, .3, .3]), /Dehaze and Clarity need whole frames/);
  assert.throws(() => colorTransform(legacy, undefined, [node('n', 1, { clarity: 50 })])([.3, .3, .3]), /cannot be baked into an RGB LUT/);
  assert.deepEqual(colorTransform(managed, undefined, [node('n', 1, { dehaze: 0, clarity: 0, saturation: 120 })])([.3, .4, .5]), colorTransform(managed, undefined, [node('n', 1, { saturation: 120 })])([.3, .4, .5]), 'zero is no detail point');
  assert.throws(() => validateGradeParameters('N', { dehaze: 101 }), /dehaze is outside/); assert.throws(() => validateGradeParameters('N', { clarity: NaN }), /clarity is outside/);
  assert.doesNotThrow(() => validateGradeParameters('N', { dehaze: -100, clarity: 100 }));
});

test('in the grade: the maps and tools see decode × G of the node input; Dehaze on Balance equals its own node after Balance', () => {
  const W = 160, H = 90, lin = pattern(H, W).map(v => v * .4), pic = encoded(lin, 'DaVinci Intermediate'), grade = { exposure: .4, temperature: 800, tint: 10 };
  const together = gradePicture(managed, undefined, [node('b', 1, { ...grade, dehaze: 60, clarity: 30 })], pic, W, H), apart = gradePicture(managed, undefined, [node('b', 1, grade), node('d', 2, { dehaze: 60, clarity: 30 })], pic, W, H);
  assert.ok(maxDiff(together, apart) < 1e-5, `Balance + detail vs a detail node after it: ${maxDiff(together, apart)}`);
  assert.ok(maxDiff(together, gradePicture(managed, undefined, [node('b', 1, grade)], pic, W, H)) > .01, 'and it does something');
  // A linear nodes-v2 clip: the grade is G, then the tools, against detailMaps + applyDetail on G × input.
  const linear = clip({ colorPipeline: 'nodes-v2', inputProfile: 'Linear', inputGamut: 'DaVinci Wide Gamut' }), w = luminanceWeights('DaVinci Wide Gamut');
  const gained = lin.map(v => v * 2 ** -.5), direct = detail(gained, W, H, { dehaze: 60, clarity: -30 }, w).map(v => Math.max(0, Math.min(1, v)));
  assert.ok(maxDiff(gradePicture(linear, undefined, [node('n', 1, { exposure: -.5, dehaze: 60, clarity: -30 })], lin, W, H), direct) < 1e-6, 'exposure is part of G');
  // Legacy: Gamma 2.4 with G = 1 at the start of the stage; the camera exposure runs once, before the maps.
  const lift = clip({ inputExposure: 1 }), exposed = pic.map(v => encodeLog(decodeLog(v, 'Rec.709') * 2, 'Rec.709'));
  const legacyDirect = encoded(detail(exposed.map(v => decodeLog(v, 'Gamma 2.4')), W, H, { dehaze: 50 }, [.2126, .7152, .0722]), 'Gamma 2.4').map(v => Math.max(0, Math.min(1, v)));
  assert.ok(maxDiff(gradePicture(lift, undefined, [node('n', 1, { dehaze: 50 })], pic, W, H), legacyDirect) < 1e-6, 'legacy detail point');
});

test('in the grade: film splits after its node, detail before; the node blend (window, mask, qualifier) limits both tools', () => {
  const W = 160, H = 90, pic = encoded(pattern(H, W).map(v => v * .4), 'DaVinci Intermediate'), tools = { dehaze: 80, clarity: 60 };
  const film = node('f', 1, { filmVignette: 40 }), filmed = gradePicture(managed, undefined, [film], pic, W, H);
  assert.ok(maxDiff(gradePicture(managed, undefined, [film, node('d', 2, tools)], pic, W, H), gradePicture(managed, undefined, [node('d', 2, tools)], filmed, W, H)) < 1e-6, 'the maps see the film output');
  const full = gradePicture(managed, undefined, [node('d', 1, tools)], pic, W, H), clamped = pic.map(v => Math.max(0, Math.min(1, v)));
  const rows = (a: Float32Array, from: number, to: number) => a.slice(from * W * 3, to * W * 3);
  const windowed = gradePicture(managed, undefined, [node('d', 1, { ...tools, gradOn: 1, gradSoft: .001 })], pic, W, H);
  assert.equal(maxDiff(rows(windowed, 46, H), rows(clamped, 46, H)), 0, 'outside the gradient window: the node input');
  assert.ok(maxDiff(rows(windowed, 0, 44), rows(full, 0, 44)) < 1e-12, 'inside: the full tools');
  const masked = gradePicture(managed, undefined, [node('d', 1, tools, { mask: { id: 'm1', enabled: true, invert: false, amount: 100 } })], pic, W, H, { maskAt: (id, i) => { assert.equal(id, 'm1'); return i % W < W / 2 ? 0 : 1; } });
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(masked[i * 3 + c] - (i % W < W / 2 ? clamped : full)[i * 3 + c]) < 1e-12, 'a Smart Mask');
  const key = { qualOn: 1, qualLumHigh: 40, qualLumSoft: 0 }, keyed = gradePicture(managed, undefined, [node('d', 1, { ...tools, ...key })], pic, W, H), w = luminanceWeights('DaVinci Wide Gamut');
  let both = 0;
  for (let i = 0; i < W * H; i++) { const a = qualifierAlpha(Array.from(pic.subarray(i * 3, i * 3 + 3)), w, key); if (a !== 0 && a !== 1) continue; both |= a + 1; for (let c = 0; c < 3; c++) assert.ok(Math.abs(keyed[i * 3 + c] - (a ? full : clamped)[i * 3 + c]) < 1e-12, 'the qualifier keys on the pre-detail node input'); }
  assert.equal(both, 3, 'the key selects some pixels and not others');
});

test('a node\'s Dehaze/Clarity survives a look and a Color Assistant proposal', () => {
  const look = lookPatch('kodak-2383');
  assert.ok(!look.replaces('dehaze') && !look.replaces('clarity') && !('dehaze' in look.parameters));
  const nodes = [node('in', 1, {}), node('bal', 2, { dehaze: 40 }, { name: 'Balance' }), node('look', 3, { clarity: 25 }, { name: 'Look' }), node('out', 4, {}, { effects: [{ id: 'aces', type: 'cst', enabled: true, inputGamma: 'DaVinci Intermediate', inputGamut: 'DaVinci Wide Gamut', outputGamma: 'Gamma 2.4', outputGamut: 'Rec.709', toneMapping: 'aces2', gamutMapping: 'none' }] })];
  const { next } = proposedNodes(managed, nodes, { balance: neutralBalance(), look: { look: neutralLook(), extraNodes: [] } }, prefix => `${prefix}-1`);
  assert.equal(next.find(n => n.id === 'bal')!.parameters.dehaze, 40); assert.equal(next.find(n => n.id === 'look')!.parameters.clarity, 25);
});
