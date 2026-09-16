import type { GradeNode } from '../state/models.ts';

/** SDR adjustments shared by the viewer and original-media renderer. */
export function gradeValues(nodes: Pick<GradeNode, 'enabled' | 'name' | 'parameters'>[]) {
  const result = { exposure: 0, contrast: 1, pivot: .5, saturation: 1, temperature: 0, tint: 0, lift: 0, gamma: 0, gain: 1, offset: 0 };
  for (const node of nodes.filter(node => node.enabled)) {
    const p = Object.fromEntries(Object.entries(node.parameters).map(([key, value]) => [key.toLowerCase(), value]));
    for (const [key, value] of Object.entries(p)) {
      if (!Number.isFinite(value)) throw new Error(`${node.name}: ${key} must be a finite number.`);
      if (![...Object.keys(result), 'intensity', 'warmth', 'warmhighlights', 'coolshadows', 'hue'].includes(key)) throw new Error(`${node.name}: ${key} is not supported by the SDR renderer. Remove or bypass this node.`);
    }
    result.exposure += p.exposure ?? 0;
    result.contrast *= p.contrast ?? 1;
    result.pivot = p.pivot ?? result.pivot;
    result.saturation *= p.saturation == null ? 1 : p.saturation < 0 ? 1 + p.saturation / 100 : p.saturation / 100;
    result.temperature += (p.temperature ?? 0) + ((p.warmth ?? 0) + (p.warmhighlights ?? 0) - (p.coolshadows ?? 0)) * 20 * ((p.intensity ?? 100) / 100);
    result.tint += p.tint ?? 0;
    result.lift += p.lift ?? 0;
    result.gamma += p.gamma ?? 0;
    result.gain *= p.gain ?? 1;
    result.offset += p.offset ?? 0;
    if (p.hue) throw new Error(`${node.name}: hue rotation is not supported. Reset Hue to zero or bypass this node.`);
  }
  return result;
}
