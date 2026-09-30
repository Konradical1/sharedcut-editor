import { colorStages, interpretation, primaryDefaults, processingStages, validateGradeNode } from './color.ts';
import type { Clip, ColorCurve, GradeNode, MediaAsset } from '../state/models.ts';

/** Shared by server and client: the model only proposes these numbers; SharedCut's engine renders and applies them. */
export type AssistantMode = 'looks' | 'balance' | 'match';
export type Rgb = { r: number; g: number; b: number };
export interface BalanceValues { exposure: number; temperature: number; tint: number; lift: Rgb; gamma: Rgb; gain: Rgb; offset: Rgb }
export interface CurvePoints { x: number; y: number }
export interface LookValues { contrast: number; pivot: number; saturation: number; lift: number; gamma: number; gain: number; offset: number; liftRgb: Rgb; gammaRgb: Rgb; gainRgb: Rgb; offsetRgb: Rgb; curves: { rgb: CurvePoints[]; r: CurvePoints[]; g: CurvePoints[]; b: CurvePoints[] } }
export type WarningCode = 'clipping' | 'lighting-change' | 'low-confidence' | 'large-residual' | 'different-scene' | 'skin' | 'other';
export interface ShotNote { clipId: string; confidence: number; warnings: { code: WarningCode; text: string }[]; rationale: string }
export interface LookOption { name: string; intensity: 'natural' | 'bold' | 'extreme'; description: string; look: LookValues; extraNodes: LookValues[]; shots: ShotNote[] }
export interface LooksOutput { options: LookOption[] }
export interface BalanceOutput { shots: (ShotNote & { balance: BalanceValues })[] }
export type Eligibility = { ok: true } | { ok: false; code: 'legacy-pipeline' | 'unverified-camera' | 'not-aces' | 'missing-nodes' | 'masked-node' | 'keyframed'; text: string };

type Range = readonly [number, number];
/** Tighter than the engine's own limits (colorStages). */
export const LIMITS = { exposure: [-3, 3], temperature: [-2000, 2000], tint: [-100, 100], contrast: [.5, 2.5], pivot: [.15, .65], saturation: [0, 200], lift: [-.4, .4], gamma: [-.4, .4], gain: [.6, 1.4], offset: [-.4, .4], rgb: [-.4, .4], confidence: [0, 1], extraNodes: 2, curvePoints: 8, text: 300, name: 60, warnings: 8 } as const;
const INTENSITIES = ['natural', 'bold', 'extreme'] as const, WARNINGS: WarningCode[] = ['clipping', 'lighting-change', 'low-confidence', 'large-residual', 'different-scene', 'skin', 'other'];
const RGB = ['r', 'g', 'b'] as const, WHEELS = ['lift', 'gamma', 'gain', 'offset'] as const, CURVES = [['rgb', 'RGB'], ['r', 'R'], ['g', 'G'], ['b', 'B']] as const;
const LOOK_NUMBERS = ['contrast', 'pivot', 'saturation', 'lift', 'gamma', 'gain', 'offset'] as const, LOOK_RGB = ['liftRgb', 'gammaRgb', 'gainRgb', 'offsetRgb'] as const;
const NOTE_KEYS = ['clipId', 'confidence', 'warnings', 'rationale'];

// JSON Schema for `codex exec --output-schema` (OpenAI strict mode: closed objects, every property required).
const num = ([minimum, maximum]: Range, description?: string) => ({ type: 'number', minimum, maximum, ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown, maxItems: number, minItems?: number, description?: string) => ({ type: 'array', items, maxItems, ...(minItems !== undefined ? { minItems } : {}), ...(description ? { description } : {}) });
const str = (maxLength: number) => ({ type: 'string', maxLength });
const rgbSchema = (description: string) => ({ ...obj(Object.fromEntries(RGB.map(c => [c, num(LIMITS.rgb)]))), description });
const curveSchema = arr(obj({ x: num([0, 1]), y: num([0, 1]) }), LIMITS.curvePoints, undefined, 'DaVinci Intermediate code values. Empty = no curve; otherwise 2-8 points, x strictly ascending, first x=0, last x=1.');
const lookSchema = obj({
  contrast: num(LIMITS.contrast, '1 = unchanged'), pivot: num(LIMITS.pivot, 'DaVinci Intermediate code value; 0.336 = 18% grey'), saturation: num(LIMITS.saturation, '100 = unchanged'),
  lift: num(LIMITS.lift, '0 = unchanged'), gamma: num(LIMITS.gamma, '0 = unchanged'), gain: num(LIMITS.gain, '1 = unchanged'), offset: num(LIMITS.offset, '0 = unchanged'),
  ...Object.fromEntries(LOOK_RGB.map(k => [k, rgbSchema('Per-channel delta added to the master value; 0 = unchanged')])), curves: obj({ rgb: curveSchema, r: curveSchema, g: curveSchema, b: curveSchema }),
});
const balanceSchema = obj({ exposure: num(LIMITS.exposure, 'stops'), temperature: num(LIMITS.temperature, 'positive = warmer'), tint: num(LIMITS.tint, 'positive = more magenta'), ...Object.fromEntries(WHEELS.map(k => [k, rgbSchema(`Per-channel ${k} delta; 0 = unchanged`)])) });
export function outputSchema(mode: AssistantMode, clipIds: string[]): Record<string, unknown> {
  if (!['looks', 'balance', 'match'].includes(mode) || !clipIds.length) throw Error('Color Assistant needs a mode and at least one shot.');
  const note = { clipId: { type: 'string', enum: [...clipIds] }, confidence: num(LIMITS.confidence), warnings: arr(obj({ code: { type: 'string', enum: WARNINGS }, text: str(LIMITS.text) }), LIMITS.warnings), rationale: str(LIMITS.text) };
  if (mode === 'looks') return obj({ options: arr(obj({ name: str(LIMITS.name), intensity: { type: 'string', enum: [...INTENSITIES] }, description: str(LIMITS.text), look: lookSchema, extraNodes: arr(lookSchema, LIMITS.extraNodes), shots: arr(obj(note), clipIds.length) }), 3, 3, 'Exactly three looks in order: natural, bold, extreme.') });
  return obj({ shots: arr(obj({ ...note, balance: balanceSchema }), clipIds.length, 1) });
}

// Independent validation: never trust the schema alone. Nothing is partly accepted.
function fail(path: string, text: string): never { throw Error(`Color Assistant output: ${path} ${text}.`); }
function record(v: unknown, keys: readonly string[], path: string) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${path}.${k}`, 'is not allowed');
  for (const k of keys) if (!Object.hasOwn(o, k)) fail(`${path}.${k}`, 'is missing');
  return o;
}
function number(v: unknown, [min, max]: Range, path: string) { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(path, `must be a number from ${min} to ${max}`); return v; }
function text(v: unknown, max: number, path: string, required = false) {
  if (typeof v !== 'string') fail(path, 'must be text');
  const t = v.trim(); if (t.length > max) fail(path, `must be at most ${max} characters`); if (required && !t) fail(path, 'must not be empty'); return t;
}
function list(v: unknown, path: string, max: number, min = 0) { if (!Array.isArray(v) || v.length < min || v.length > max) fail(path, min === max ? `must have exactly ${max} items` : `must have ${min} to ${max} items`); return v as unknown[]; }
function rgb(v: unknown, path: string): Rgb { const o = record(v, RGB, path); return { r: number(o.r, LIMITS.rgb, `${path}.r`), g: number(o.g, LIMITS.rgb, `${path}.g`), b: number(o.b, LIMITS.rgb, `${path}.b`) }; }
function curve(v: unknown, path: string): CurvePoints[] {
  const points = list(v, path, LIMITS.curvePoints).map((p, i) => { const o = record(p, ['x', 'y'], `${path}[${i}]`); return { x: number(o.x, [0, 1], `${path}[${i}].x`), y: number(o.y, [0, 1], `${path}[${i}].y`) }; });
  if (points.length === 1) fail(path, 'needs no points or 2 to 8 points');
  if (points.length && (points[0].x !== 0 || points.at(-1)!.x !== 1)) fail(path, 'must start at x=0 and end at x=1');
  points.forEach((p, i) => { if (i && p.x - points[i - 1].x < .0001) fail(`${path}[${i}].x`, 'must be larger than the previous point'); });
  return points;
}
function look(v: unknown, path: string): LookValues {
  const o = record(v, [...LOOK_NUMBERS, ...LOOK_RGB, 'curves'], path), c = record(o.curves, CURVES.map(([k]) => k), `${path}.curves`);
  return { ...Object.fromEntries(LOOK_NUMBERS.map(k => [k, number(o[k], LIMITS[k], `${path}.${k}`)])), ...Object.fromEntries(LOOK_RGB.map(k => [k, rgb(o[k], `${path}.${k}`)])), curves: Object.fromEntries(CURVES.map(([k]) => [k, curve(c[k], `${path}.curves.${k}`)])) } as unknown as LookValues;
}
function balance(v: unknown, path: string): BalanceValues {
  const o = record(v, ['exposure', 'temperature', 'tint', ...WHEELS], path);
  return { exposure: number(o.exposure, LIMITS.exposure, `${path}.exposure`), temperature: number(o.temperature, LIMITS.temperature, `${path}.temperature`), tint: number(o.tint, LIMITS.tint, `${path}.tint`), ...Object.fromEntries(WHEELS.map(k => [k, rgb(o[k], `${path}.${k}`)])) } as unknown as BalanceValues;
}
function note(o: Record<string, unknown>, path: string, clipIds: string[], seen: Set<string>): ShotNote {
  const clipId = o.clipId;
  if (typeof clipId !== 'string' || !clipIds.includes(clipId)) fail(`${path}.clipId`, 'is not one of the requested shots');
  if (seen.has(clipId)) fail(`${path}.clipId`, `repeats ${clipId}`); seen.add(clipId);
  const warnings = list(o.warnings, `${path}.warnings`, LIMITS.warnings).map((w, i) => {
    const p = `${path}.warnings[${i}]`, x = record(w, ['code', 'text'], p);
    if (!WARNINGS.includes(x.code as WarningCode)) fail(`${p}.code`, 'is not a known warning'); return { code: x.code as WarningCode, text: text(x.text, LIMITS.text, `${p}.text`) };
  });
  return { clipId, confidence: number(o.confidence, LIMITS.confidence, `${path}.confidence`), warnings, rationale: text(o.rationale, LIMITS.text, `${path}.rationale`) };
}
function checkNode(patch: Partial<GradeNode> & Pick<GradeNode, 'parameters'>) { const node = { id: 'check', projectId: '', clipId: '', name: 'Check', kind: 'serial', enabled: true, ...patch }; validateGradeNode(node); colorStages({ id: '' } as Clip, [node]); }
export function validateOutput(mode: 'looks', value: unknown, clipIds: string[]): LooksOutput;
export function validateOutput(mode: 'balance' | 'match', value: unknown, clipIds: string[]): BalanceOutput;
export function validateOutput(mode: AssistantMode, value: unknown, clipIds: string[]): LooksOutput | BalanceOutput;
export function validateOutput(mode: AssistantMode, value: unknown, clipIds: string[]): LooksOutput | BalanceOutput {
  if (!['looks', 'balance', 'match'].includes(mode)) fail('mode', 'is unknown');
  let n = 0; const pointId = () => `p${++n}`;
  if (mode === 'looks') {
    const options = list(record(value, ['options'], 'output').options, 'options', 3, 3).map((v, i): LookOption => {
      const p = `options[${i}]`, o = record(v, ['name', 'intensity', 'description', 'look', 'extraNodes', 'shots'], p), seen = new Set<string>();
      if (o.intensity !== INTENSITIES[i]) fail(`${p}.intensity`, `must be ${INTENSITIES[i]}`);
      return { name: text(o.name, LIMITS.name, `${p}.name`, true), intensity: INTENSITIES[i], description: text(o.description, LIMITS.text, `${p}.description`), look: look(o.look, `${p}.look`),
        extraNodes: list(o.extraNodes, `${p}.extraNodes`, LIMITS.extraNodes).map((x, j) => look(x, `${p}.extraNodes[${j}]`)),
        shots: list(o.shots, `${p}.shots`, clipIds.length).map((x, j) => note(record(x, NOTE_KEYS, `${p}.shots[${j}]`), `${p}.shots[${j}]`, clipIds, seen)) };
    });
    for (const o of options) for (const l of [o.look, ...o.extraNodes]) checkNode(lookNodePatch(l, pointId));
    return { options };
  }
  const seen = new Set<string>(), shots = list(record(value, ['shots'], 'output').shots, 'shots', clipIds.length, 1).map((x, i) => {
    const p = `shots[${i}]`, o = record(x, [...NOTE_KEYS, 'balance'], p); return { ...note(o, p, clipIds, seen), balance: balance(o.balance, `${p}.balance`) };
  });
  for (const s of shots) checkNode({ parameters: balanceParameters(s.balance) });
  return { shots };
}

const zero = (): Rgb => ({ r: 0, g: 0, b: 0 });
const rgbParameters = (name: string, v: Rgb) => ({ [`${name}R`]: v.r, [`${name}G`]: v.g, [`${name}B`]: v.b });
export function neutralBalance(): BalanceValues { return { exposure: 0, temperature: 0, tint: 0, lift: zero(), gamma: zero(), gain: zero(), offset: zero() }; }
export function neutralLook(): LookValues { return { contrast: 1, pivot: primaryDefaults.pivot, saturation: 100, lift: 0, gamma: 0, gain: 1, offset: 0, liftRgb: zero(), gammaRgb: zero(), gainRgb: zero(), offsetRgb: zero(), curves: { rgb: [], r: [], g: [], b: [] } }; }
/** Complete Balance node parameters: neutral master wheels, the proposal's exposure/white balance and per-channel deltas. */
export function balanceParameters(b: BalanceValues): Record<string, number> {
  return { ...primaryDefaults, exposure: b.exposure, temperature: b.temperature, tint: b.tint, ...Object.assign({}, ...WHEELS.map(k => rgbParameters(k, b[k]))) };
}
/** Complete Look node parameters and curves (an empty channel array means no curve for it). */
export function lookNodePatch(l: LookValues, id: () => string): Pick<GradeNode, 'parameters' | 'curves'> {
  return {
    parameters: { ...primaryDefaults, contrast: l.contrast, pivot: l.pivot, saturation: l.saturation, lift: l.lift, gamma: l.gamma, gain: l.gain, offset: l.offset, ...Object.assign({}, ...WHEELS.map(k => rgbParameters(k, l[`${k}Rgb`]))) },
    curves: Object.fromEntries(CURVES.filter(([k]) => l.curves[k].length).map(([k, key]) => [key, { mode: 'smooth', points: l.curves[k].map(p => ({ id: id(), x: p.x, y: p.y })) } satisfies ColorCurve])),
  };
}

const ordered = (clip: Clip, nodes: GradeNode[]) => nodes.filter(n => n.clipId === clip.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
/** Balance/Look are the effect-free nodes with those names; nodes carrying CSTs or LUTs are never edited. */
export function findGradeNodes(clip: Clip, nodes: GradeNode[]): { balance?: GradeNode; look?: GradeNode; output?: GradeNode; extras: GradeNode[] } {
  const own = ordered(clip, nodes), plain = (name: string) => own.find(n => n.name === name && !n.effects?.length);
  return { balance: plain('Balance'), look: plain('Look'), output: own.filter(n => n.enabled && n.effects?.some(e => e.enabled && e.type === 'cst' && e.toneMapping === 'aces2')).at(-1), extras: own.filter(n => n.id.startsWith('ai-look-')) };
}
export function eligibility(clip: Clip, asset: MediaAsset | undefined, nodes: GradeNode[]): Eligibility {
  const no = (code: Extract<Eligibility, { ok: false }>['code'], text: string): Eligibility => ({ ok: false, code, text });
  if (clip.properties.colorPipeline !== 'nodes-v2') return no('legacy-pipeline', 'Start wide-gamut grade first.');
  const enabled = ordered(clip, nodes).filter(n => n.enabled), input = enabled.flatMap(n => n.effects ?? []).find(e => e.enabled && e.type === 'cst');
  if (asset?.cameraMetadataVersion !== 2 || !asset.inputProfile || input?.type !== 'cst' || input.inputGamma !== asset.inputProfile || input.inputGamut !== asset.inputGamut) return no('unverified-camera', 'Set the camera input first.');
  const { balance, look, output } = findGradeNodes(clip, nodes);
  if (!output) return no('not-aces', 'Use ACES 2 output first.');
  if (!balance || !look || !((output.order ?? 0) > (look.order ?? 0) && (output.order ?? 0) > (balance.order ?? 0))) return no('missing-nodes', 'This grade needs Balance and Look nodes before the ACES 2 output.');
  // The server caches everything before Balance and reads it as DaVinci Intermediate: Input CST < Balance < Look < Output, or previews and Apply disagree.
  if ((balance.order ?? 0) >= (look.order ?? 0)) return no('missing-nodes', 'Put Balance before Look, both before the ACES 2 output.');
  const inWorkingSpace = (order: number) => { try { const source = interpretation(clip, asset), s = processingStages({ ...clip, properties: { ...clip.properties, inputProfile: source.profile, inputGamut: source.gamut } }, nodes).find(stage => (stage.node.order ?? 0) >= order); return s?.type === 'correction' && s.gamma === 'DaVinci Intermediate' && s.gamut === 'DaVinci Wide Gamut'; } catch { return false; } };
  if (!inWorkingSpace(balance.order ?? 0) || !inWorkingSpace(look.order ?? 0)) return no('missing-nodes', 'Balance and Look must come after the Input CST into DaVinci Wide Gamut / Intermediate.');
  if (enabled.some(n => n.mask?.enabled)) return no('masked-node', 'A node on this shot uses a mask.');
  // Stills and measurements use static node values, so any animated node on the shot would make them lie.
  const prefixes = ordered(clip, nodes).map(n => `nodes.${n.id}.`);
  if (Object.entries(clip.keyframes ?? {}).some(([path, keys]) => keys?.length && prefixes.some(p => path.startsWith(p)))) return no('keyframed', 'A grade node on this shot is keyframed.');
  return { ok: true };
}
/** Pure: the clip's node list after the change, plus per-node changes (null = removed). Never touches CST/LUT nodes, masks, keyframes or clip properties. */
export function proposedNodes(clip: Clip, nodes: GradeNode[], change: { balance?: BalanceValues; look?: { look: LookValues; extraNodes: LookValues[] } }, id: (prefix: string) => string): { next: GradeNode[]; changes: { id: string; value: GradeNode | null }[] } {
  const { balance, look, output, extras } = findGradeNodes(clip, nodes), changes: { id: string; value: GradeNode | null }[] = [];
  if (change.balance) { if (!balance) throw Error(`${clip.name}: no Balance node to change.`); changes.push({ id: balance.id, value: { ...structuredClone(balance), enabled: true, parameters: balanceParameters(change.balance) } }); }
  if (change.look) {
    const { look: values, extraNodes } = change.look, lo = look?.order ?? 0, hi = output?.order ?? 0;
    if (!look || !output || !(hi > lo)) throw Error(`${clip.name}: the Look node must come before the ACES 2 output.`);
    if (extraNodes.length > LIMITS.extraNodes) throw Error(`Use at most ${LIMITS.extraNodes} extra look nodes.`);
    // A bypassed target is switched back on: otherwise every proposal would be a silent no-op. Only the node being changed.
    changes.push({ id: look.id, value: { ...structuredClone(look), enabled: true, ...lookNodePatch(values, () => id('point')) } });
    for (const n of extras) if (!n.effects?.length) changes.push({ id: n.id, value: null });
    const at = look.position ?? { x: 400, y: 80 };
    extraNodes.forEach((values, i) => { const nodeId = id('ai-look'); changes.push({ id: nodeId, value: { id: nodeId, projectId: clip.projectId, clipId: clip.id, name: `Look ${i + 2}`, kind: 'serial', enabled: true, order: lo + (i + 1) * (hi - lo) / (extraNodes.length + 1), position: { x: at.x, y: at.y + 120 * (i + 1) }, ...lookNodePatch(values, () => id('point')) } }); });
  }
  const byId = new Map(changes.map(c => [c.id, c.value])), own = ordered(clip, nodes);
  const next = [...own.flatMap(n => byId.has(n.id) ? byId.get(n.id) ? [byId.get(n.id)!] : [] : [n]), ...changes.flatMap(c => c.value && !own.some(n => n.id === c.id) ? [c.value] : [])];
  return { next: next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), changes };
}
