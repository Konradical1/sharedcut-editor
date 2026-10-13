import assert from 'node:assert/strict';
import test from 'node:test';
import { identityCurve, primaryDefaults, starterGrade } from './color.ts';
import { autoBalanceParameters, colorGroups, groupColor, nextGroupName, normalizedGrade, normalizeStages, validAutoBalance, type AutoBalance } from './colorGroups.ts';
import type { Clip, ColorTransformEffect, GradeNode, Keyframe, MediaAsset } from '../state/models.ts';

let count = 0;
const id = (prefix: string) => `${prefix}-${++count}`;
const shot = (properties: Clip['properties'] = {}, extra: Partial<Clip> = {}): Clip => ({ id: 'shot', projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'm', name: 'Shot', start: 0, duration: 4, sourceIn: 0, color: '', disabled: false, properties, effects: [], ...extra });
const asset = (inputProfile = 'S-Log3', inputGamut = 'S-Gamut3.Cine'): MediaAsset => ({ id: 'm', projectId: 'p', name: 'A', kind: 'video', binId: 'broll', thumbnail: '', duration: 10, resolution: '3840 × 2160', fps: 24, size: '', status: 'ready', progress: 100, inputProfile, inputGamut });
const balance: AutoBalance = { exposure: .5, temperature: -800, tint: 3, lift: -.02 };
const cst = (node: GradeNode) => node.effects!.find(e => e.type === 'cst') as ColorTransformEffect;
const key: Keyframe = { id: 'k', time: 0, value: 1, interpolation: 'linear' };
/** A wide-gamut grade as initializeColorGrade leaves it, plus a second look node. */
function graded() {
  const clip = shot({ colorPipeline: 'nodes-v2', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' }), nodes = starterGrade(clip, asset(), () => id('grade'));
  Object.assign(cst(nodes[3]), { toneMapping: 'aces2', gamutMapping: 'none' });
  nodes.push({ ...structuredClone(nodes[2]), id: 'look-2', name: 'Look 2', order: 3.5, parameters: { ...primaryDefaults, saturation: 130 } });
  return { clip, nodes };
}

test('a legacy shot gets a fresh wide-gamut grade with the measured Balance and ACES 2 for log', () => {
  const old: GradeNode = { id: 'old', projectId: 'p', clipId: 'shot', name: 'Contrast', kind: 'serial', enabled: true, order: 1, parameters: { ...primaryDefaults, contrast: 1.4 } };
  const { next, removed, properties, unset, ids } = normalizedGrade(shot(), asset(), [old], { balance }, id);
  assert.deepEqual(next.map(n => n.name), ['Input CST', 'Balance', 'Look', 'Output CST']);
  assert.deepEqual([removed, unset], [['old'], []]);
  assert.deepEqual(properties, { colorPipeline: 'nodes-v2', inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' });
  assert.deepEqual(next.find(n => n.id === ids.balance)!.parameters, autoBalanceParameters(balance));
  assert.deepEqual([cst(next[0]).inputGamma, cst(next[0]).outputGamma, cst(next[0]).outputGamut], ['S-Log3', 'DaVinci Intermediate', 'DaVinci Wide Gamut']);
  assert.deepEqual([cst(next[3]).toneMapping, cst(next[3]).gamutMapping], ['aces2', 'none']);
});

test('an SDR source gets no tone mapping and is measured as SDR', () => {
  const { next } = normalizedGrade(shot(), asset('Rec.709', 'Rec.709'), [], { balance }, id);
  assert.deepEqual([cst(next[0]).inputGamma, cst(next[3]).toneMapping, cst(next[3]).gamutMapping], ['Rec.709', 'none', 'none']);
  assert.equal(normalizeStages(shot(), asset('Rec.709', 'Rec.709'), []).sdr, true);
});

test('a wide-gamut grade keeps its Look and extra nodes; the Input CST is reset to the camera', () => {
  const { clip, nodes } = graded();
  nodes[0].parameters.exposure = 1; nodes[0].curves = { RGB: identityCurve() }; cst(nodes[0]).toneMapping = 'shoulder'; nodes[2].parameters.contrast = 1.3;
  const { next, removed, ids } = normalizedGrade(clip, asset(), nodes, { balance }, id);
  assert.deepEqual(removed, []);
  assert.deepEqual(next.map(n => n.id), [nodes[0].id, nodes[1].id, nodes[2].id, 'look-2', nodes[3].id]);
  assert.deepEqual([next[0].parameters, next[0].curves, cst(next[0]).toneMapping], [primaryDefaults, undefined, 'none']);
  assert.deepEqual([next[2].parameters.contrast, next[3].parameters.saturation, cst(next[4]).toneMapping], [1.3, 130, 'aces2']);
  assert.equal(next.find(n => n.id === ids.balance)!.parameters.temperature, -800);
  assert.equal(nodes[0].parameters.exposure, 1, 'the input nodes are not changed');
});

test('clean rebuilds every node', () => {
  const { clip, nodes } = graded();
  const { next, removed } = normalizedGrade(clip, asset(), nodes, { balance, clean: true }, id);
  assert.deepEqual([...removed].sort(), nodes.map(n => n.id).sort());
  assert.deepEqual(next.map(n => n.name), ['Input CST', 'Balance', 'Look', 'Output CST']);
  assert.ok(next.every(n => !removed.includes(n.id)));
});

test('the group node is added after Balance, moved to another group with its values, and removed', () => {
  const { clip, nodes } = graded(), balanceNode = nodes[1];
  const add = normalizedGrade(clip, asset(), nodes, { group: { id: 'cg-a', name: ' Interview ' } }, id), node = add.next.find(n => n.group)!;
  assert.deepEqual([node.kind, node.name, node.group, add.properties.colorGroup, add.ids.group], ['group', 'Interview', 'cg-a', 'cg-a', node.id]);
  assert.deepEqual(node.parameters, primaryDefaults);
  assert.deepEqual(add.next.map(n => n.name), ['Input CST', 'Balance', 'Interview', 'Look', 'Look 2', 'Output CST']);
  assert.ok(node.order! > balanceNode.order! && node.order! < nodes[2].order!);
  const member = { ...clip, properties: { ...clip.properties, colorGroup: 'cg-a' } }, template = { parameters: { ...primaryDefaults, exposure: .4 }, curves: { RGB: identityCurve() }, enabled: false };
  const moved = normalizedGrade(member, asset(), add.next, { group: { id: 'cg-b', name: 'Wide', template } }, id), groupNodes = moved.next.filter(n => n.group);
  assert.equal(groupNodes.length, 1);
  assert.deepEqual([groupNodes[0].id, groupNodes[0].group, groupNodes[0].name, groupNodes[0].parameters.exposure, groupNodes[0].enabled, groupNodes[0].curves], [node.id, 'cg-b', 'Wide', .4, false, template.curves]);
  const out = normalizedGrade(member, asset(), moved.next, { group: null }, id);
  assert.ok(!out.next.some(n => n.group));
  assert.deepEqual([out.removed, out.unset], [[node.id], ['colorGroup']]);
});

test('keyframes on rewritten or removed nodes are dropped, others kept', () => {
  const { clip, nodes } = graded(), look = `nodes.${nodes[2].id}.parameters.contrast`;
  const keyed = { ...clip, keyframes: { [`nodes.${nodes[1].id}.parameters.exposure`]: [key], [look]: [key], 'properties.x': [key] } };
  assert.deepEqual(Object.keys(normalizedGrade(keyed, asset(), nodes, { balance }, id).keyframes!), [look, 'properties.x']);
  assert.equal(normalizedGrade({ ...clip, keyframes: { [look]: [key] } }, asset(), nodes, { balance }, id).keyframes, undefined, 'nothing dropped: no keyframe change');
  assert.deepEqual(normalizedGrade(keyed, asset(), nodes, { balance, clean: true }, id).keyframes, { 'properties.x': [key] });
});

test('Normalize measures through the Input CST only and renders through the output only', () => {
  const { clip, nodes } = graded();
  nodes[2].parameters.contrast = 1.5;
  const { pre, post, sdr } = normalizeStages(clip, asset(), nodes);
  assert.equal(sdr, false);
  assert.deepEqual([...new Set(pre.map(s => s.node.id))], [nodes[0].id], 'pre ends before Balance');
  assert.deepEqual([...new Set(post.map(s => s.node.id))], [nodes[3].id], 'no Look, no group in post');
  assert.ok(post.some(s => s.type === 'cst' && s.effect.toneMapping === 'aces2'));
});

test('groups list in timeline order with the name of a member\'s group node; colors are stable', () => {
  const node = (clipId: string, group: string, name: string): GradeNode => ({ id: `${clipId}-g`, projectId: 'p', clipId, name, kind: 'group', group, enabled: true, order: 2.5, parameters: { ...primaryDefaults } });
  const clips = [shot({ colorGroup: 'cg-x' }, { id: 'a', start: 5 }), shot({ colorGroup: 'cg-x' }, { id: 'b', start: 1 }), shot({ colorGroup: 'cg-y' }, { id: 'c', start: 3 }), shot({}, { id: 'd' })];
  const groups = colorGroups(clips, [node('a', 'cg-x', 'Wide'), node('b', 'cg-x', 'Wide')]);
  assert.deepEqual(groups.map(g => [g.id, g.name, g.clipIds, g.node?.clipId]), [['cg-x', 'Wide', ['b', 'a'], 'b'], ['cg-y', 'Color group', ['c'], undefined]]);
  assert.equal(groupColor('cg-x'), groupColor('cg-x'));
  assert.match(groupColor('cg-y'), /^#[0-9a-f]{6}$/);
  assert.equal(nextGroupName([{ name: 'Group 2' }]), 'Group 3');
  assert.equal(validAutoBalance(balance), true);
  for (const bad of [{ ...balance, exposure: 5 }, { ...balance, lift: NaN }, { ...balance, tint: undefined }, null]) assert.equal(validAutoBalance(bad), false);
});
