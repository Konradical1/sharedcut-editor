import { interpretation, primaryDefaults, processingStages, starterGrade } from './color.ts';
import { findGradeNodes } from './colorAssistant.ts';
import { detailParams } from './grading.ts';
import type { Clip, ColorCurves, ColorTransformEffect, GradeNode, MediaAsset } from '../state/models.ts';

/**
 * Color groups and Normalize, shared by the editor, the server and the MCP.
 *
 * A group is not a record of its own: membership is `clip.properties.colorGroup` (the group id) and the group's shared grade is
 * one node per member, marked `node.group` (the same id), named after the group and placed right after the shot's Balance node.
 * Every member's group node holds the same values; changing one changes them all (store: updateColorGroup). So undo, snapshots,
 * copy/paste, splits and older builds all keep working, and the three render engines see an ordinary correction node.
 *
 * Normalize sets each shot's Balance node from the server's measurement (scripts/color-normalize.py): exposure and white balance
 * in linear light, and a black-point lift. The Input CST is reset to the camera interpretation and log footage gets the ACES 2
 * output, so the shot is measured exactly as it will be shown.
 */

/** What Normalize writes into a shot's Balance node: exposure (stops) and white balance in linear light, black-point lift on DaVinci Intermediate values;
 * display-referred shots (phones) get a mid-tone gamma with the gain that keeps white in place instead of exposure. */
export interface AutoBalance { exposure: number; temperature: number; tint: number; lift: number; gamma?: number; gain?: number }
export type NormalizeWarningCode = 'display-referred' | 'low-confidence' | 'clipping' | 'lighting-change' | 'highlight-guard' | 'large-change';
/** `input`: the source interpretation the shot was measured through (the server sets it). */
export interface NormalizeShot { clipId: string; balance: AutoBalance; confidence: number; key?: number; warnings: { code: NormalizeWarningCode; text: string }[]; input?: { profile: string; gamut: string } }
export interface NormalizeResult { shots: NormalizeShot[]; level?: { group: number; target: number } | null }
export type GroupTemplate = { parameters: Record<string, number>; curves?: ColorCurves; enabled: boolean };
export interface ColorGroup { id: string; name: string; color: string; clipIds: string[]; node?: GradeNode }

export const AUTO_LIMITS = { exposure: [-4, 4], temperature: [-4000, 4000], tint: [-60, 60], lift: [-.1, 0] } as const;
export const MIDTONE_LIMITS = { gamma: [-.6, 1], gain: [.5, 1.5] } as const;
export const GROUP_ID = /^cg-[A-Za-z0-9-]{1,80}$/;
const SDR = ['Rec.709', 'Gamma 2.4'];
const PALETTE = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];

export const isGroupNode = (node?: GradeNode) => typeof node?.group === 'string' && node.group.length > 0;
export const colorGroupOf = (clip?: Clip) => { const id = clip?.properties.colorGroup; return typeof id === 'string' && id ? id : undefined; };
export const groupNodeOf = (clipId: string, nodes: GradeNode[]) => nodes.find(n => n.clipId === clipId && isGroupNode(n));
export function groupColor(id: string) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
export const groupTemplate = (node?: GradeNode): GroupTemplate | undefined => node && { parameters: { ...node.parameters }, ...(node.curves && { curves: structuredClone(node.curves) }), enabled: node.enabled };

/** The project's groups, in timeline order of their first member. Name and shared values come from a member's group node. */
export function colorGroups(clips: Clip[], nodes: GradeNode[]): ColorGroup[] {
  const groups = new Map<string, ColorGroup>();
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const id = colorGroupOf(clip); if (!id) continue;
    const group = groups.get(id) ?? { id, name: '', color: groupColor(id), clipIds: [] }, node = nodes.find(n => n.clipId === clip.id && n.group === id);
    group.clipIds.push(clip.id); if (node && !group.node) { group.node = node; group.name = node.name; }
    groups.set(id, group);
  }
  return [...groups.values()].map(g => ({ ...g, name: g.name || 'Color group' }));
}
export function nextGroupName(groups: { name: string }[]) { let n = groups.length + 1; while (groups.some(g => g.name === `Group ${n}`)) n++; return `Group ${n}`; }

export function validAutoBalance(value: unknown): value is AutoBalance {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  const within = (v: unknown, [lo, hi]: readonly [number, number]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  return (Object.keys(AUTO_LIMITS) as (keyof typeof AUTO_LIMITS)[]).every(k => within(b[k], AUTO_LIMITS[k])) && (Object.keys(MIDTONE_LIMITS) as (keyof typeof MIDTONE_LIMITS)[]).every(k => b[k] === undefined || within(b[k], MIDTONE_LIMITS[k]));
}
/** Complete Balance node parameters for an auto balance: everything else neutral. */
export function autoBalanceParameters(b: AutoBalance): Record<string, number> {
  return { ...primaryDefaults, exposure: +b.exposure.toFixed(3), temperature: Math.round(b.temperature), tint: +b.tint.toFixed(1), lift: +b.lift.toFixed(4), gamma: +(b.gamma ?? 0).toFixed(4), gain: +(b.gain ?? 1).toFixed(4) };
}

const ordered = (clip: Clip, nodes: GradeNode[]) => nodes.filter(n => n.clipId === clip.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const cstOf = (node: GradeNode) => node.effects?.find((e): e is ColorTransformEffect => e.enabled && e.type === 'cst');
/** Input CST → Balance → … → display output, in that order; undefined when the grade is not laid out that way. */
function layout(clip: Clip, own: GradeNode[]) {
  const enabled = own.filter(n => n.enabled), input = enabled.find(n => cstOf(n)), output = [...enabled].reverse().find(n => { const e = cstOf(n); return e?.outputGamma === 'Gamma 2.4' && e.outputGamut === 'Rec.709'; });
  const { balance } = findGradeNodes(clip, own), order = (n?: GradeNode) => n?.order ?? 0;
  if (!input || !balance || !output || input === output || balance.mask?.enabled) return undefined;
  return order(input) < order(balance) && order(balance) < order(output) ? { input, balance, output } : undefined;
}

export interface NormalizeChange { balance?: AutoBalance; group?: { id: string; name: string; template?: GroupTemplate } | null; clean?: boolean }
/**
 * Pure: the shot's grade after Normalize. A shot without a wide-gamut grade, one laid out differently, or any shot with `clean`
 * gets a fresh Input CST → Balance → Look → Output; otherwise its nodes stay and only these change: the Input CST node is reset to
 * the camera interpretation (its own corrections cleared, the source is re-measured through it), log footage gets the ACES 2
 * output, the Balance node takes `balance`, and the group node is added, moved to `group` or removed (`group: null`).
 */
export function normalizedGrade(clip: Clip, asset: MediaAsset | undefined, nodes: GradeNode[], change: NormalizeChange, id: (prefix: string) => string) {
  const source = interpretation(clip, asset), log = !SDR.includes(source.profile), own = ordered(clip, nodes);
  const properties: Record<string, string | number | boolean> = { colorPipeline: 'nodes-v2', inputProfile: source.profile, inputGamut: source.gamut }, unset: string[] = [];
  const found = !change.clean && clip.properties.colorPipeline === 'nodes-v2' ? layout(clip, own) : undefined;
  let next: GradeNode[], removed: string[] = [], input: GradeNode, balance: GradeNode, output: GradeNode;
  const reset = new Set<string>();
  if (!found) {
    next = starterGrade({ ...clip, properties: { ...clip.properties, ...properties } }, asset, () => id('grade'));
    [input, balance, , output] = next;
    removed = own.map(n => n.id);
  } else {
    next = own.map(n => structuredClone(n));
    const at = (n: GradeNode) => next.find(x => x.id === n.id)!;
    input = at(found.input); balance = at(found.balance); output = at(found.output);
    input.parameters = { ...primaryDefaults, ...detailParams(input.parameters) }; delete input.curves; reset.add(input.id);
  }
  const into = cstOf(input)!;
  Object.assign(into, { inputGamma: source.profile, inputGamut: source.gamut, outputGamma: 'DaVinci Intermediate', outputGamut: 'DaVinci Wide Gamut', toneMapping: 'none', gamutMapping: 'none' });
  const out = cstOf(output)!;
  if (log) Object.assign(out, { outputGamma: 'Gamma 2.4', outputGamut: 'Rec.709', toneMapping: 'aces2', gamutMapping: 'none' });
  else if (!found) Object.assign(out, { toneMapping: 'none', gamutMapping: 'none' });
  if (change.balance) { balance.parameters = { ...autoBalanceParameters(change.balance), ...detailParams(balance.parameters) }; delete balance.curves; balance.enabled = true; reset.add(balance.id); }
  if (change.group !== undefined) {
    const current = next.find(n => isGroupNode(n));
    if (change.group === null) { if (current) { next = next.filter(n => n !== current); if (!removed.includes(current.id)) removed.push(current.id); } unset.push('colorGroup'); }
    else {
      const { id: groupId, name, template } = change.group, after = next.filter(n => (n.order ?? 0) > (balance.order ?? 0) && n !== current)[0];
      const order = (balance.order ?? 0) + ((after?.order ?? (balance.order ?? 0) + 2) - (balance.order ?? 0)) / 2;
      const values = template ? structuredClone(template) : current?.group === groupId ? groupTemplate(current)! : { parameters: { ...primaryDefaults }, enabled: true };
      const node: GradeNode = { id: current?.id ?? id('grade'), projectId: clip.projectId, clipId: clip.id, name: name.trim().slice(0, 60) || 'Color group', kind: 'group', group: groupId,
        enabled: values.enabled, order, position: { x: (balance.position?.x ?? 230) + 85, y: (balance.position?.y ?? 80) + 130 }, parameters: values.parameters, ...(values.curves && { curves: values.curves }) };
      next = [...next.filter(n => n !== current), node];
      if (!current || current.group !== groupId || template) reset.add(node.id);
      properties.colorGroup = groupId;
    }
  }
  next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // Keyframes on removed or rewritten nodes would fight the new values.
  const drop = [...removed, ...reset].map(nodeId => `nodes.${nodeId}.`), keys = Object.entries(clip.keyframes ?? {});
  const keyframes = keys.some(([path]) => drop.some(p => path.startsWith(p))) ? Object.fromEntries(keys.filter(([path]) => !drop.some(p => path.startsWith(p)))) : undefined;
  return { next, removed, properties, unset, keyframes, ids: { input: input.id, balance: balance.id, output: output.id, group: next.find(n => isGroupNode(n))?.id } };
}

/** What the Normalize job measures and renders with: every node before the Balance node, and the shot's output after it (no look, no group).
 * `clean`: measured as the rebuilt grade normalizeColorGroup will apply with clean. A masked node before Balance throws (the worker cannot render masks). */
export function normalizeStages(clip: Clip, asset: MediaAsset | undefined, nodes: GradeNode[], { clean = false }: { clean?: boolean } = {}) {
  // Distinct ids: a fresh grade's four nodes must not all match the Balance id below.
  let n = 0;
  const { next, properties, ids } = normalizedGrade(clip, asset, nodes, { balance: { exposure: 0, temperature: 0, tint: 0, lift: 0 }, clean }, prefix => `${prefix}-analysis-${++n}`);
  const at = next.find(x => x.id === ids.balance)!.order ?? 0, used = next.filter(x => x.id === ids.output || ((x.order ?? 0) <= at && !isGroupNode(x)));
  if (used.some(x => x.id !== ids.output && x.enabled && x.mask?.enabled)) throw Error('A node before Balance uses a mask.');
  const stages = processingStages({ ...clip, properties: { ...clip.properties, ...properties } }, used), cut = stages.findIndex(s => s.node.id === ids.balance);
  return { pre: stages.slice(0, cut), post: stages.slice(cut).filter(s => s.node.id !== ids.balance), sdr: SDR.includes(String(properties.inputProfile)) };
}
