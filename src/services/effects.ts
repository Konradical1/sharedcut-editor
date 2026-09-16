import { isTitle } from './text.ts';
import { isShape } from './shapes.ts';
import type { Clip, Effect } from '../state/models.ts';

export interface EffectParameter { key: string; label: string; initial: number; min: number; max: number; step?: number; suffix?: string }
const amount: EffectParameter = { key: 'amount', label: 'Amount', initial: 50, min: 0, max: 100, suffix: '%' };
export const effectDefinitions: Record<string, { kind: 'video' | 'audio' | 'both'; description: string; parameters: EffectParameter[] }> = {
  'Smart Mask': { kind: 'video', description: 'Select a subject, track the shot, and refine its edges.', parameters: [{...amount,initial:100},{key:'invert',label:'Invert',initial:0,min:0,max:1,step:1}] },
  'Film grain': { kind: 'video', description: 'Add texture with adjustable grain strength and seed.', parameters: [amount, { key: 'seed', label: 'Seed', initial: 1, min: 0, max: 10000 }] },
  Bloom: { kind: 'video', description: 'Bleed the highlights into a soft glow.', parameters: [amount, { key: 'threshold', label: 'Threshold', initial: 62, min: 0, max: 100, suffix: '%' }, { key: 'radius', label: 'Radius', initial: 18, min: 1, max: 100, step: .1, suffix: 'px' }] },
  Vignette: { kind: 'video', description: 'Darken the edges around an adjustable center.', parameters: [amount, { key: 'centerX', label: 'Center X', initial: 50, min: 0, max: 100, suffix: '%' }, { key: 'centerY', label: 'Center Y', initial: 50, min: 0, max: 100, suffix: '%' }] },
  'Gaussian blur': { kind: 'video', description: 'Soften detail with a controllable blur radius.', parameters: [amount, { key: 'radius', label: 'Radius', initial: 10, min: 0, max: 100, step: .1, suffix: 'px' }] },
  Sharpen: { kind: 'video', description: 'Restore edge contrast at the chosen detail radius.', parameters: [amount, { key: 'radius', label: 'Radius', initial: 2, min: 1, max: 5, suffix: 'px' }] },
  'Noise Reduction': { kind: 'both', description: 'Reduce picture noise and quiet background audio.', parameters: [amount, { key: 'temporal', label: 'Temporal', initial: 6, min: 0, max: 20, step: .1 }, { key: 'Reduction', label: 'Audio reduction', initial: 35, min: 0, max: 100, suffix: '%' }, { key: 'Sensitivity', label: 'Sensitivity', initial: 50, min: 0, max: 100, suffix: '%' }, { key: 'Smoothing', label: 'Smoothing', initial: 25, min: 0, max: 100, suffix: '%' }] },
  EQ: { kind: 'audio', description: 'Shape low frequencies, presence, and air.', parameters: [{ key: 'Low cut', label: 'Low cut', initial: 80, min: 20, max: 500, suffix: 'Hz' }, { key: 'Presence', label: 'Presence', initial: 2, min: -12, max: 12, step: .1, suffix: 'dB' }, { key: 'Air', label: 'Air', initial: 1, min: -12, max: 12, step: .1, suffix: 'dB' }] },
  Compressor: { kind: 'audio', description: 'Control dynamics with threshold, ratio, and timing.', parameters: [{ key: 'Threshold', label: 'Threshold', initial: -18, min: -60, max: 0, step: .1, suffix: 'dB' }, { key: 'Ratio', label: 'Ratio', initial: 3, min: 1, max: 20, step: .1, suffix: ':1' }, { key: 'Attack', label: 'Attack', initial: 15, min: 1, max: 100, suffix: 'ms' }, { key: 'Release', label: 'Release', initial: 120, min: 10, max: 1000, suffix: 'ms' }] },
  Limiter: { kind: 'audio', description: 'Set a ceiling and catch loud peaks.', parameters: [{ key: 'Ceiling', label: 'Ceiling', initial: -1, min: -12, max: 0, step: .1, suffix: 'dB' }, { key: 'Threshold', label: 'Threshold', initial: -6, min: -24, max: 0, step: .1, suffix: 'dB' }, { key: 'Release', label: 'Release', initial: 80, min: 10, max: 500, suffix: 'ms' }] },
};
export function effectValue(clip: Clip, effect: Effect, key: string): number {
  const parameter = effectDefinitions[effect.name]?.parameters.find(p => p.key === key);
  if (!parameter) return 0;
  const value = Number(key === 'amount' ? effect.amount : effect.parameters?.[key] ?? clip.properties[`${effect.name}_${key}`] ?? parameter.initial);
  return Number.isFinite(value) ? Math.max(parameter.min, Math.min(parameter.max, value)) : parameter.initial;
}
export const effectEnabled = (clip: Clip, effect: Effect) => effect.enabled && clip.properties[`${effect.name}_enabled`] !== false;
export function acceptsEffect(clip: Clip, kind: string | undefined, name: string) {
  if(clip.properties.captionSet)return false;
  if(name==='Smart Mask')return kind==='video'&&!isTitle(clip)&&!isShape(clip)&&!clip.properties.compositionId;
  const definition = effectDefinitions[name];
  if(isTitle(clip)||isShape(clip))kind='image';
  return !!definition && (definition.kind !== 'video' || kind !== 'audio') && (definition.kind !== 'audio' || kind !== 'image');
}

export function detailPixels(pixels: Uint8ClampedArray, width: number, height: number, clip: Clip, effect: Effect, frame = 0) {
  const amount = effectValue(clip, effect, 'amount');
  if (!amount || !effectEnabled(clip, effect)) return;
  if (effect.name === 'Film grain') {
    let seed = (effectValue(clip, effect, 'seed') + frame * 131) >>> 0;
    for (let i = 0; i < pixels.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed / 4294967296 - .5) * amount * .85;
      for (let c = 0; c < 3; c++) pixels[i + c] += noise;
    }
    return;
  }
  if (!['Sharpen', 'Noise Reduction'].includes(effect.name)) return;
  // ponytail: spatial denoise preview; the export uses FFmpeg's temporal denoiser.
  const radius = effect.name === 'Sharpen' ? Math.round(effectValue(clip, effect, 'radius')) : 1;
  const source = new Uint8ClampedArray(pixels), horizontal = new Float32Array(pixels.length);
  for (let y = 0; y < height; y++) for (let c = 0; c < 3; c++) {
    let total = 0;
    const at = (x: number) => source[(y * width + Math.min(width - 1, Math.max(0, x))) * 4 + c];
    for (let offset = -radius; offset <= radius; offset++) total += at(offset);
    for (let x = 0; x < width; x++) {
      horizontal[(y * width + x) * 4 + c] = total / (radius * 2 + 1);
      total += at(x + radius + 1) - at(x - radius);
    }
  }
  for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    let total = 0;
    const at = (y: number) => horizontal[(Math.min(height - 1, Math.max(0, y)) * width + x) * 4 + c];
    for (let offset = -radius; offset <= radius; offset++) total += at(offset);
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4 + c, blurred = total / (radius * 2 + 1);
      pixels[i] = effect.name === 'Sharpen' ? source[i] + (source[i] - blurred) * amount / 25 : source[i] + (blurred - source[i]) * amount / 100;
      total += at(y + radius + 1) - at(y - radius);
    }
  }
}
