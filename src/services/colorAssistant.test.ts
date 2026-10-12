import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, balanceParameters, eligibility, findGradeNodes, lookNodePatch, lookOption, neutralBalance, neutralLook, outputSchema, proposedNodes, shotBalance, validateOutput, type BalanceValues, type LookValues } from './colorAssistant.ts';
import { colorStages, processingStages, starterGrade, validateGradeNode } from './color.ts';
import { recipeLook, RECIPES } from './colorLooks.ts';
import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';

const clip = { id: 'c1', projectId: 'p1', name: 'Shot 1', properties: { colorPipeline: 'nodes-v2', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' }, keyframes: {}, effects: [] } as unknown as Clip;
const asset = { id: 'a1', cameraMetadataVersion: 2, inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } as MediaAsset;
const grade = (c = clip) => { let n = 0; const nodes = starterGrade(c, asset, () => `${c.id}-g${++n}`), out = nodes[3].effects![0]; if (out.type === 'cst') Object.assign(out, { toneMapping: 'aces2', gamutMapping: 'none' }); return nodes; };
const named = (nodes: GradeNode[], name: string) => nodes.find(n => n.name === name)!;
const shot = (clipId = 'c1') => ({ clipId, confidence: .8, warnings: [{ code: 'clipping', text: ' Sky is clipped. ' }], rationale: 'Warm window light.' });
const look = (over: Partial<LookValues> = {}): LookValues => ({ ...neutralLook(), contrast: 1.2, liftRgb: { r: -.02, g: 0, b: .03 }, curves: { rgb: [{ x: 0, y: 0 }, { x: .5, y: .55 }, { x: 1, y: 1 }], r: [], g: [], b: [{ x: 0, y: .02 }, { x: 1, y: .97 }] }, ...over });
const looks = () => ({ shots: [{ ...shot(), keepBalance: false, exposure: .4, temperature: -600, tint: 4 }, { ...shot('c2'), warnings: [], keepBalance: true, exposure: 0, temperature: 0, tint: 0 }], options: [
  { intensity: 'natural', recipe: 'clean', strength: .8, warmth: 0, name: 'Clean', description: 'Close to camera.' },
  { intensity: 'bold', recipe: 'teal-amber', strength: .6, warmth: .2, name: 'Teal night', description: 'Teal shadows.' },
  { intensity: 'extreme', recipe: 'bleach', strength: 1, warmth: -.3, name: 'Bleach', description: 'All out.' },
] });
const bal = (): BalanceValues => ({ ...neutralBalance(), exposure: .5, temperature: -300, tint: 12, lift: { r: .01, g: 0, b: -.02 }, gain: { r: .05, g: 0, b: -.1 } });
const balances = () => ({ shots: [{ ...shot(), balance: bal() }, { ...shot('c2'), warnings: [], balance: neutralBalance() }] });
const ids = ['c1', 'c2'];

/** Minimal JSON Schema walker for the keywords outputSchema uses; also asserts OpenAI strict-mode rules. */
function conforms(schema: any, v: any, path = '$'): void {
  const bad = (why: string) => assert.fail(`${path}: ${why}`);
  if (schema.enum && !schema.enum.includes(v)) bad('not in enum');
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} must be closed`); assert.deepEqual(schema.required, Object.keys(schema.properties), `${path} requires every key`);
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad('not an object');
    assert.deepEqual(Object.keys(v).sort(), Object.keys(schema.properties).sort(), path);
    for (const k of Object.keys(schema.properties)) conforms(schema.properties[k], v[k], `${path}.${k}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(v) || v.length > schema.maxItems || v.length < (schema.minItems ?? 0)) bad('array size');
    v.forEach((x: unknown, i: number) => conforms(schema.items, x, `${path}[${i}]`));
  } else if (schema.type === 'number') { if (typeof v !== 'number' || v < schema.minimum || v > schema.maximum) bad('number range'); }
  else if (schema.type === 'string') { if (typeof v !== 'string' || v.length > schema.maxLength) bad('string'); }
  else if (schema.type === 'boolean') { if (typeof v !== 'boolean') bad('boolean'); }
  else bad(`unsupported schema type ${schema.type}`);
}

test('output schemas are strict, bounded by LIMITS and name only requested shots', () => {
  const looksSchema = outputSchema('looks', ids), balanceSchema = outputSchema('balance', ids), text = JSON.stringify([looksSchema, balanceSchema]);
  for (const word of ['allOf', 'anyOf', 'oneOf', '"not"', '"if"', 'patternProperties', 'uniqueItems', '$ref']) assert.ok(!text.includes(word), word);
  conforms(looksSchema, looks()); conforms(balanceSchema, balances()); conforms(outputSchema('match', ids), balances());
  const p = (looksSchema as any).properties, options = p.options, option = options.items.properties, q = p.shots.items.properties;
  assert.deepEqual(Object.keys(p), ['shots', 'options'], 'balance every shot first, then the looks');
  assert.equal(options.minItems, 3); assert.equal(options.maxItems, 3); assert.deepEqual(option.intensity.enum, ['natural', 'bold', 'extreme']); assert.equal(option.name.maxLength, 60);
  assert.deepEqual(option.recipe.enum, RECIPES.map(r => r.id)); assert.deepEqual([option.strength.minimum, option.strength.maximum, option.warmth.minimum, option.warmth.maximum], [.2, 1, -1, 1]);
  assert.deepEqual(q.clipId.enum, ids); assert.equal(p.shots.maxItems, 2); assert.equal(q.keepBalance.type, 'boolean'); assert.deepEqual(Object.keys(q).slice(0, 2), ['clipId', 'rationale'], 'reasoning before numbers');
  assert.deepEqual([q.exposure.minimum, q.exposure.maximum, q.temperature.minimum, q.temperature.maximum, q.tint.maximum], [-2, 2, -4000, 4000, 100]);
  const b = (balanceSchema as any).properties.shots.items.properties;
  assert.deepEqual([b.balance.properties.exposure.maximum, b.balance.properties.temperature.minimum, b.balance.properties.tint.maximum, b.warnings.maxItems, b.confidence.maximum], [3, -2000, 100, 8, 1]);
  assert.throws(() => outputSchema('looks', []), /at least one shot/);
});

test('valid output is returned as a trimmed deep copy; the shots list may cover a subset of shots', () => {
  const raw = looks(), out = validateOutput('looks', raw, ids);
  assert.equal(out.shots[0].warnings[0].text, 'Sky is clipped.'); out.shots[0].warnings[0].text = 'x'; assert.equal(raw.shots[0].warnings[0].text, ' Sky is clipped. ');
  assert.equal(validateOutput('looks', { ...looks(), shots: [looks().shots[1]] }, ids).shots.length, 1);
  assert.deepEqual(out.options.map(o => [o.recipe, o.strength, o.warmth]), [['clean', .8, 0], ['teal-amber', .6, .2], ['bleach', 1, -.3]]);
  const b = validateOutput('match', balances(), ids); assert.deepEqual(b.shots[0].balance, bal()); assert.equal(b.shots[1].clipId, 'c2');
});

test('an answer becomes node values: each shot its Balance (none when kept), each option a library look at its strength and warmth', () => {
  const out = validateOutput('looks', looks(), ids);
  assert.deepEqual(shotBalance(out.shots[0]), { ...neutralBalance(), exposure: .4, temperature: -600, tint: 4 }); assert.equal(shotBalance(out.shots[1]), undefined);
  const option = lookOption(out.options[2], []), bleach = RECIPES.find(r => r.id === 'bleach')!.look;
  assert.deepEqual([option.recipe, option.look.contrast, option.look.saturation, option.look.saturationShadows, option.extraNodes], ['bleach', bleach.contrast, bleach.saturation, bleach.saturationShadows, []]);
  assert.ok(option.look.offsetRgb.b > 0 && option.look.offsetRgb.r < 0, 'warmth -0.3 cools');
  const half = recipeLook('teal-amber', .5), full = recipeLook('teal-amber', 1);
  assert.equal(half.contrast, +((1 + full.contrast) / 2).toFixed(5)); assert.ok(half.curves.b[1].y - .15 > 0 && half.curves.b[1].y - .15 < full.curves.b[1].y - .15, 'half strength moves curves half way');
  assert.throws(() => recipeLook('purple-haze', 1), /Unknown look/);
});

test('every library look, at any strength and warmth, is a node the engine accepts; at strength 0 it changes nothing', () => {
  assert.equal(new Set(RECIPES.map(r => r.id)).size, RECIPES.length);
  for (const r of RECIPES) for (const strength of [.2, .6, 1]) for (const warmth of [-1, 0, 1]) {
    const node = { id: 'n', projectId: '', clipId: '', name: 'Look', kind: 'serial', enabled: true, ...lookNodePatch(recipeLook(r.id, strength, warmth), (() => { let i = 0; return () => `p${++i}`; })()) } as GradeNode;
    assert.doesNotThrow(() => { validateGradeNode(node); colorStages({ id: '' } as Clip, [node]); }, `${r.id} ${strength} ${warmth}`);
  }
  for (const r of RECIPES) {
    const zero = recipeLook(r.id, 0);
    assert.deepEqual({ ...zero, curves: neutralLook().curves }, { ...neutralLook(), ...Object.fromEntries(['saturationShadows', 'saturationMidtones', 'saturationHighlights'].filter(k => k in zero).map(k => [k, 100])) }, r.id);
    assert.ok(Object.values(zero.curves).flat().every(p => Math.abs(p.y - p.x) < 1e-5), `${r.id} curves are identity`);
  }
});

test('every rule rejects the whole output with the bad field named', () => {
  type Case = [string, (v: any) => void, RegExp];
  const lookCases: Case[] = [
    ['root array', v => { v.options = { length: 3 }; }, /options must have exactly 3/],
    ['two options', v => v.options.pop(), /options must have exactly 3/],
    ['four options', v => v.options.push(v.options[0]), /options must have exactly 3/],
    ['intensity order', v => { v.options[0].intensity = 'bold'; v.options[1].intensity = 'natural'; }, /options\[0\]\.intensity must be natural/],
    ['extra root key', v => { v.notes = 'hi'; }, /output\.notes is not allowed/],
    ['raw look values', v => { v.options[2].look = neutralLook(); }, /options\[2\]\.look is not allowed/],
    ['missing key', v => { delete v.options[1].description; }, /options\[1\]\.description is missing/],
    ['unknown look', v => { v.options[1].recipe = 'purple-haze'; }, /options\[1\]\.recipe is not a look in the library/],
    ['strength', v => { v.options[2].strength = 1.2; }, /options\[2\]\.strength must be a number from 0\.2 to 1/],
    ['weak strength', v => { v.options[0].strength = .1; }, /options\[0\]\.strength must be a number from 0\.2/],
    ['warmth', v => { v.options[0].warmth = -1.5; }, /options\[0\]\.warmth must be a number from -1 to 1/],
    ['string number', v => { v.options[0].strength = '0.5'; }, /strength must be a number/],
    ['NaN', v => { v.options[0].warmth = NaN; }, /warmth must be a number/],
    ['no shots', v => { v.shots = []; }, /shots must have 1 to 2/],
    ['too many shots', v => v.shots.push(v.shots[0]), /shots must have 1 to 2/],
    ['unknown clip', v => { v.shots[0].clipId = 'c9'; }, /shots\[0\]\.clipId is not one of the requested shots/],
    ['duplicate clip', v => { v.shots[1].clipId = 'c1'; }, /shots\[1\]\.clipId repeats c1/],
    ['keepBalance', v => { v.shots[0].keepBalance = 'no'; }, /shots\[0\]\.keepBalance must be true or false/],
    ['exposure', v => { v.shots[0].exposure = 2.5; }, /shots\[0\]\.exposure must be a number from -2 to 2/],
    ['temperature', v => { v.shots[0].temperature = 4001; }, /shots\[0\]\.temperature must be a number from -4000 to 4000/],
    ['tint', v => { v.shots[0].tint = -101; }, /shots\[0\]\.tint/],
    ['raw balance', v => { v.shots[0].balance = neutralBalance(); }, /shots\[0\]\.balance is not allowed/],
    ['confidence', v => { v.shots[0].confidence = 1.2; }, /confidence must be a number from 0 to 1/],
    ['empty name', v => { v.options[1].name = '   '; }, /options\[1\]\.name must not be empty/],
    ['long name', v => { v.options[1].name = 'x'.repeat(61); }, /name must be at most 60/],
    ['long description', v => { v.options[1].description = 'x'.repeat(301); }, /description must be at most 300/],
    ['non-text rationale', v => { v.shots[0].rationale = 5; }, /rationale must be text/],
    ['nine warnings', v => { v.shots[0].warnings = Array(9).fill({ code: 'other', text: '' }); }, /warnings must have 0 to 8/],
    ['unknown warning', v => { v.shots[0].warnings[0].code = 'banding'; }, /warnings\[0\]\.code is not a known warning/],
    ['long warning', v => { v.shots[0].warnings[0].text = 'x'.repeat(301); }, /warnings\[0\]\.text must be at most 300/],
  ];
  for (const [name, mutate, message] of lookCases) { const v = looks() as any; mutate(v); assert.throws(() => validateOutput('looks', v, ids), message, name); }
  assert.doesNotThrow(() => validateOutput('looks', { ...looks(), options: looks().options.map(o => ({ ...o, name: `  ${'x'.repeat(60)}  ` })) }, ids), 'length counts after trimming');
  assert.throws(() => validateOutput('looks', null, ids), /output must be an object/);
  assert.throws(() => validateOutput('looks', [], ids), /output must be an object/);
  const balanceCases: Case[] = [
    ['no shots', v => { v.shots = []; }, /shots must have 1 to 2/],
    ['unknown clip', v => { v.shots[1].clipId = 'c3'; }, /shots\[1\]\.clipId is not one of/],
    ['duplicate clip', v => { v.shots[1].clipId = 'c1'; }, /shots\[1\]\.clipId repeats c1/],
    ['exposure', v => { v.shots[0].balance.exposure = 3.5; }, /shots\[0\]\.balance\.exposure must be a number from -3 to 3/],
    ['temperature', v => { v.shots[0].balance.temperature = -2001; }, /balance\.temperature/],
    ['tint', v => { v.shots[0].balance.tint = 101; }, /balance\.tint/],
    ['rgb delta', v => { v.shots[0].balance.offset.g = -.41; }, /balance\.offset\.g/],
    ['look key in balance', v => { v.shots[0].balance.contrast = 1; }, /balance\.contrast is not allowed/],
    ['missing balance', v => { delete v.shots[0].balance; }, /shots\[0\]\.balance is missing/],
    ['look output for balance', v => { v.options = []; delete v.shots; }, /output\.options is not allowed/],
  ];
  for (const mode of ['balance', 'match'] as const) for (const [name, mutate, message] of balanceCases) { const v = balances(); mutate(v); assert.throws(() => validateOutput(mode, v, ids), message, `${mode}: ${name}`); }
  assert.throws(() => validateOutput('grade' as never, balances(), ids), /mode is unknown/);
});

test('eligibility never guesses the camera and refuses grades the assistant cannot edit safely', () => {
  const nodes = grade(), code = (c: Clip, a: MediaAsset | undefined, n: GradeNode[]) => { const r = eligibility(c, a, n); return r.ok ? 'ok' : r.code; };
  assert.equal(code(clip, asset, nodes), 'ok');
  assert.equal(code({ ...clip, properties: { ...clip.properties, colorPipeline: '' } }, asset, nodes), 'legacy-pipeline');
  for (const a of [undefined, { ...asset, cameraMetadataVersion: 1 }, { ...asset, inputProfile: undefined }, { ...asset, inputProfile: 'Canon Log 3' }, { ...asset, inputGamut: 'S-Gamut3' }, { ...asset, inputGamut: undefined }]) assert.equal(code(clip, a, nodes), 'unverified-camera');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Input CST' ? { ...n, enabled: false } : n)), 'unverified-camera');
  assert.equal(code(clip, asset, starterGrade(clip, asset, () => Math.random().toString(36))), 'not-aces');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Output CST' ? { ...n, enabled: false } : n)), 'not-aces');
  assert.equal(code(clip, asset, nodes.filter(n => n.name !== 'Look')), 'missing-nodes');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Balance' ? { ...n, name: 'Primary' } : n)), 'missing-nodes');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Look' ? { ...n, order: 9 } : n)), 'missing-nodes');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Look' ? { ...n, order: 1.5 } : n)), 'missing-nodes');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Input CST' ? { ...n, order: 2.5 } : n)), 'missing-nodes');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Input CST' ? { ...n, effects: n.effects!.map(e => e.type === 'cst' ? { ...e, outputGamma: 'Gamma 2.4', outputGamut: 'Rec.709' } : e) } : n)), 'missing-nodes');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Balance' || n.name === 'Look' ? { ...n, enabled: false } : n)), 'ok');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Balance' ? { ...n, mask: { id: 'm', enabled: true, invert: false, amount: 100 } } : n)), 'masked-node');
  assert.equal(code(clip, asset, nodes.map(n => n.name === 'Balance' ? { ...n, mask: { id: 'm', enabled: false, invert: false, amount: 100 } } : n)), 'ok');
  const key = { id: 'k', time: 0, value: 1, interpolation: 'linear' as const };
  assert.equal(code({ ...clip, keyframes: { [`nodes.${named(nodes, 'Look').id}.parameters.contrast`]: [key] } }, asset, nodes), 'keyframed');
  assert.equal(code({ ...clip, keyframes: { [`nodes.${named(nodes, 'Balance').id}.curves`]: [key] } }, asset, nodes), 'keyframed');
  assert.equal(code({ ...clip, keyframes: { 'properties.opacity': [key], [`nodes.${named(nodes, 'Look').id}.parameters.contrast`]: [] } }, asset, nodes), 'ok');
  assert.equal(code({ ...clip, keyframes: { [`nodes.${named(nodes, 'Output CST').id}.enabled`]: [key] } }, asset, nodes), 'keyframed', 'any node on the shot, not only Balance/Look');
  const userNode = { ...named(nodes, 'Look'), id: 'user-node', name: 'Glow', order: 3.5 };
  assert.equal(code({ ...clip, keyframes: { [`nodes.user-node.parameters.exposure`]: [key] } }, asset, [...nodes, userNode]), 'keyframed');
});

test('values map onto node parameters and curves and back without loss', () => {
  const b = bal(), p = balanceParameters(b);
  assert.deepEqual({ contrast: p.contrast, pivot: p.pivot, saturation: p.saturation, lift: p.lift, gamma: p.gamma, gain: p.gain, offset: p.offset }, { contrast: 1, pivot: .336043, saturation: 100, lift: 0, gamma: 0, gain: 1, offset: 0 });
  const rgbOf = (params: Record<string, number>, k: string) => ({ r: params[`${k}R`], g: params[`${k}G`], b: params[`${k}B`] });
  assert.deepEqual({ exposure: p.exposure, temperature: p.temperature, tint: p.tint, lift: rgbOf(p, 'lift'), gamma: rgbOf(p, 'gamma'), gain: rgbOf(p, 'gain'), offset: rgbOf(p, 'offset') }, b);
  let n = 0; const l = look({ pivot: .4, saturation: 80, lift: .01, gamma: -.05, gain: 1.1, offset: .02, gammaRgb: { r: .01, g: .02, b: .03 } }), patch = lookNodePatch(l, () => `pt${++n}`), q = patch.parameters;
  assert.deepEqual([q.exposure, q.temperature, q.tint], [0, 0, 0]);
  const curve = (k: 'RGB' | 'R' | 'G' | 'B') => patch.curves?.[k]?.points.map(({ x, y }) => ({ x, y })) ?? [];
  assert.deepEqual({ contrast: q.contrast, pivot: q.pivot, saturation: q.saturation, lift: q.lift, gamma: q.gamma, gain: q.gain, offset: q.offset, liftRgb: rgbOf(q, 'lift'), gammaRgb: rgbOf(q, 'gamma'), gainRgb: rgbOf(q, 'gain'), offsetRgb: rgbOf(q, 'offset'), curves: { rgb: curve('RGB'), r: curve('R'), g: curve('G'), b: curve('B') } }, l);
  assert.deepEqual(Object.keys(patch.curves!).sort(), ['B', 'RGB']); assert.equal(patch.curves!.RGB!.mode, 'smooth'); assert.deepEqual(patch.curves!.RGB!.points.map(p => p.id), ['pt1', 'pt2', 'pt3']);
  assert.deepEqual(lookNodePatch(neutralLook(), () => 'x').curves, {});
  assert.deepEqual(balanceParameters(neutralBalance()), { exposure: 0, temperature: 0, tint: 0, contrast: 1, pivot: .336043, saturation: 100, lift: 0, gamma: 0, gain: 1, offset: 0, liftR: 0, liftG: 0, liftB: 0, gammaR: 0, gammaG: 0, gammaB: 0, gainR: 0, gainG: 0, gainB: 0, offsetR: 0, offsetG: 0, offsetB: 0 });
});

test('proposed nodes render through the engine, land between Look and ACES output, replace earlier extras and never touch CST nodes', () => {
  const other = { ...clip, id: 'c2' } as Clip, base = grade(), balanceNode = named(base, 'Balance');
  balanceNode.curves = { RGB: { mode: 'linear', points: [{ id: 'a', x: 0, y: .05 }, { id: 'b', x: 1, y: 1 }] } };
  const nodes = [...grade(other), ...base], before = structuredClone(nodes);
  let k = 0; const id = (prefix: string) => `${prefix}-${++k}`;
  const { next, changes } = proposedNodes(clip, nodes, { balance: bal(), look: { look: look(), extraNodes: [look({ saturation: 60 }), look({ contrast: .8 })] } }, id);
  assert.deepEqual(nodes, before, 'inputs are not mutated');
  assert.ok(next.every(n => n.clipId === 'c1')); assert.equal(next.length, 6);
  assert.doesNotThrow(() => processingStages(clip, next));
  const names = processingStages(clip, next).map(s => s.node.name).filter((name, i, all) => name !== all[i - 1]);
  assert.deepEqual(names, ['Input CST', 'Balance', 'Look', 'Look 2', 'Look 3', 'Output CST']);
  const { look: lookNode, output, extras, balance } = findGradeNodes(clip, next);
  assert.deepEqual(extras.map(n => n.name), ['Look 2', 'Look 3']); assert.ok(extras.every(n => n.order! > lookNode!.order! && n.order! < output!.order! && n.id.startsWith('ai-look-') && n.kind === 'serial' && n.enabled && n.projectId === 'p1'));
  assert.deepEqual(extras.map(n => n.position), [{ x: lookNode!.position!.x, y: lookNode!.position!.y + 120 }, { x: lookNode!.position!.x, y: lookNode!.position!.y + 240 }]);
  assert.equal(extras[0].parameters.saturation, 60); assert.equal(extras[1].parameters.contrast, .8);
  assert.deepEqual(balance, { ...balanceNode, parameters: balanceParameters(bal()) }, 'Balance keeps curves, name, order and position');
  assert.deepEqual(lookNode, { ...named(base, 'Look'), ...lookNodePatch(look(), (() => { let i = 0; const ids = lookNode!.curves!.RGB!.points.concat(lookNode!.curves!.B!.points).map(p => p.id); return () => ids[i++]; })()) });
  for (const n of base.filter(n => n.effects?.length)) { assert.ok(!changes.some(c => c.id === n.id)); assert.deepEqual(next.find(x => x.id === n.id), n); }
  const again = proposedNodes(clip, next, { look: { look: neutralLook(), extraNodes: [neutralLook()] } }, id);
  assert.deepEqual(again.changes.filter(c => c.value === null).map(c => c.id).sort(), extras.map(n => n.id).sort());
  const replaced = findGradeNodes(clip, again.next).extras;
  assert.equal(replaced.length, 1); assert.equal(replaced[0].name, 'Look 2'); assert.ok(!extras.some(n => n.id === replaced[0].id));
  assert.deepEqual(named(again.next, 'Balance'), balance, 'look-only change leaves Balance alone');
  assert.deepEqual(named(again.next, 'Look').curves, {}); assert.doesNotThrow(() => processingStages(clip, again.next));
  const cleared = proposedNodes(clip, again.next, { look: { look: look(), extraNodes: [] } }, id);
  assert.equal(findGradeNodes(clip, cleared.next).extras.length, 0); assert.equal(cleared.next.length, 4);
  assert.throws(() => proposedNodes(clip, next.filter(n => n.name !== 'Look'), { look: { look: look(), extraNodes: [] } }, id), /Look node/);
  assert.throws(() => proposedNodes(clip, next, { look: { look: look(), extraNodes: [look(), look(), look()] } }, id), /at most 2/);
  assert.equal(LIMITS.extraNodes, 2);
  // A bypassed target node is switched on (else the look is a silent no-op); a node not being changed stays bypassed.
  const bypassed = grade().map(n => n.name === 'Balance' || n.name === 'Look' ? { ...n, enabled: false } : n);
  const both = proposedNodes(clip, bypassed, { balance: bal(), look: { look: look(), extraNodes: [] } }, id);
  assert.ok(['Balance', 'Look'].every(name => named(both.next, name).enabled && both.changes.find(c => c.id === named(bypassed, name).id)!.value!.enabled));
  const only = proposedNodes(clip, bypassed, { balance: bal() }, id);
  assert.equal(named(only.next, 'Balance').enabled, true); assert.equal(named(only.next, 'Look').enabled, false);
});
