import { primaryDefaults } from './color.ts';
import { lookNodePatch } from './colorAssistant.ts';
import { RECIPES, recipeLook } from './colorLooks.ts';
import { FILM_KEYS, HSL_CURVES, PARAM } from './grading.ts';
import type { ColorCurve, ColorCurves } from '../state/models.ts';

/**
 * The Color page's look library: the Color Assistant's hand-tuned looks plus film stocks in the spirit of Dehancer's
 * profiles (colour response + halation, bloom, grain). Values are DaVinci Intermediate (a Look node between the CSTs);
 * applyColorLook puts one on a node. Retune on real footage, never by eye on a laptop alone.
 */
export type LookGroup = 'Looks' | 'Film stocks' | 'Black & white';
export interface ColorLook { id: string; name: string; group: LookGroup; about: string; parameters: Record<string, number>; curves?: Partial<Record<keyof ColorCurves, [number, number][]>> }

const STOCKS: ColorLook[] = [
  { id: 'kodak-2383', name: 'Kodak 2383 print', group: 'Film stocks', about: 'The classic cinema print: rich contrast, dense colour, warm highlights, teal-leaning shadows.',
    parameters: { contrast: 1.16, saturation: 96, density: 30, highlights: -25, logShadowR: -.004, logShadowB: .006, logHighlightR: .006, logHighlightB: -.008, filmHalation: 18, filmHalationThreshold: 2, filmBloom: 10, filmBloomThreshold: 2.5, filmBloomRadius: 5, filmGrain: 14, filmGrainSize: 1.1, filmVignette: 12 } },
  { id: 'vision3-250d', name: 'Kodak Vision3 250D', group: 'Film stocks', about: 'Daylight negative, neutral print: natural colour, gentle contrast, soft highlight roll-off.',
    parameters: { contrast: 1.06, saturation: 98, density: 15, highlights: -20, shadows: 6, logHighlightR: .003, logHighlightB: -.004, filmHalation: 12, filmBloom: 6, filmGrain: 12 } },
  { id: 'vision3-500t', name: 'Kodak Vision3 500T', group: 'Film stocks', about: 'Tungsten night stock: cool deep shadows, warm practicals with halation, visible grain.',
    parameters: { contrast: 1.1, saturation: 94, density: 20, highlights: -15, logShadowR: -.006, logShadowB: .01, logMidB: .003, logHighlightR: .005, filmHalation: 35, filmHalationThreshold: 1.5, filmBloom: 15, filmGrain: 24, filmGrainSize: 1.3, filmVignette: 15 } },
  { id: 'portra-400', name: 'Kodak Portra 400', group: 'Film stocks', about: 'Portrait stock: soft contrast, warm natural skin, pastel greens and blues.',
    parameters: { contrast: 1, saturation: 92, boost: 8, density: 10, highlights: -12, shadows: 8, logMidR: .004, logMidB: -.004, logShadowB: .004, filmHalation: 10, filmGrain: 20, filmGrainSize: 1.3, filmGrainColor: 35, filmVignette: 8 },
    curves: { HueSat: [[0, .5], [.2, .5], [.35, .44], [.55, .46], [.7, .45], [.85, .5], [1, .5]] } },
  { id: 'eterna-500', name: 'Fuji Eterna 500', group: 'Film stocks', about: 'Low-contrast cinema stock: muted colour, cyan-green shadows, elegant highlights.',
    parameters: { contrast: .94, saturation: 82, density: 22, highlights: -15, logShadowR: -.005, logShadowG: .004, logShadowB: .006, logMidG: .002, filmHalation: 8, filmGrain: 16, filmGrainSize: 1.1 } },
  { id: 'cinestill-800t', name: 'CineStill 800T', group: 'Film stocks', about: 'Tungsten stock with no anti-halation layer: strong red glow around lights, cool shadows.',
    parameters: { contrast: 1.12, saturation: 104, density: 12, logShadowR: -.006, logShadowB: .012, logHighlightR: .004, filmHalation: 75, filmHalationThreshold: 1, filmHalationRadius: 1.4, filmHalationHue: 6, filmHalationSat: 100, filmBloom: 18, filmBloomRadius: 5, filmGrain: 26, filmGrainSize: 1.4, filmGrainColor: 40 } },
  { id: 'ektachrome', name: 'Ektachrome E100', group: 'Film stocks', about: 'Slide film: punchy contrast, clean saturated colour, cool whites, fine grain.',
    parameters: { contrast: 1.2, saturation: 114, boost: 10, density: 18, shadows: -10, logShadowB: .004, logHighlightB: .002, filmGrain: 9, filmGrainSize: .9 } },
  { id: 'super8', name: 'Super 8 home movie', group: 'Film stocks', about: 'Old home movie: warm faded blacks, heavy grain, glow, vignette, weave and flicker.',
    parameters: { contrast: 1.1, saturation: 88, highlights: -30, lift: .015, logShadowR: .006, logShadowG: .003, logHighlightB: -.006, filmHalation: 30, filmBloom: 28, filmBloomRadius: 6, filmGrain: 55, filmGrainSize: 2.4, filmGrainColor: 50, filmVignette: 45, filmVignetteSize: 35, filmVignetteSoftness: 60, filmWeave: 60, filmBreath: 45, filmAberration: 35 } },
  { id: '16mm', name: '16mm documentary', group: 'Film stocks', about: '16mm reversal feel: dense colour, clear grain, light weave and breath.',
    parameters: { contrast: 1.12, saturation: 94, density: 18, highlights: -15, filmHalation: 18, filmGrain: 36, filmGrainSize: 1.8, filmVignette: 20, filmWeave: 25, filmBreath: 15 } },
  { id: 'tri-x', name: 'Tri-X 400', group: 'Black & white', about: 'Classic black and white: red-filter mix, punchy contrast, crisp grain.',
    parameters: { mixRR: .4, mixRG: .5, mixRB: .1, mixMono: 1, contrast: 1.2, shadows: -10, highlights: -10, filmGrain: 34, filmGrainSize: 1.4, filmGrainColor: 0, filmVignette: 15 } },
  { id: 'soft-silver', name: 'Soft silver', group: 'Black & white', about: 'Gentle black and white: open shadows, smooth tones, fine grain.',
    parameters: { mixRR: .3, mixRG: .59, mixRB: .11, mixMono: 1, contrast: .98, shadows: 12, highlights: -15, filmBloom: 10, filmGrain: 16, filmGrainColor: 0 } },
];
const ASSISTANT: ColorLook[] = RECIPES.map(r => {
  const { parameters, curves } = lookNodePatch(recipeLook(r.id, 1), () => 'p');
  return { id: r.id, name: r.name, group: r.id === 'mono' ? 'Black & white' : 'Looks', about: r.about[0].toUpperCase() + r.about.slice(1), parameters, curves: Object.fromEntries(Object.entries(curves ?? {}).map(([k, c]) => [k, c!.points.map(p => [p.x, p.y])])) };
});
export const COLOR_LOOKS: ColorLook[] = [...ASSISTANT, ...STOCKS];

/** Sizes, thresholds, hues and ranges a look sets outright; everything else scales from neutral with strength. */
const ABSOLUTE = new Set(['pivot', 'logLowRange', 'logHighRange', 'mixMono', 'filmHalationThreshold', 'filmHalationRadius', 'filmHalationHue', 'filmHalationSat', 'filmBloomThreshold', 'filmBloomRadius', 'filmGrainSize', 'filmGrainColor', 'filmGrainResponse', 'filmGrainSeed', 'filmGrainStatic', 'filmVignetteSize', 'filmVignetteSoftness', 'filmVignetteRoundness']);
const LOOK_GROUPS = new Set(['primaries', 'wheels', 'log', 'mixer']), KEEP = new Set(['exposure', 'temperature', 'tint']);
const round = (v: number) => +v.toFixed(5);

/** A look's node values at `strength` (0 = neutral, 1 = as designed), and which existing node keys it replaces. */
export function lookPatch(id: string, strength = 1, managed = true) {
  const look = COLOR_LOOKS.find(l => l.id === id); if (!look) throw Error(`Unknown look "${id}". Looks: ${COLOR_LOOKS.map(l => l.id).join(', ')}.`);
  const t = Math.max(0, Math.min(1, strength)), film = Object.keys(look.parameters).some(k => FILM_KEYS.includes(k));
  const parameters: Record<string, number> = {};
  for (const [key, value] of Object.entries(look.parameters)) {
    if (KEEP.has(key) && !value) continue;
    const initial = PARAM[key]?.initial ?? primaryDefaults[key] ?? 0;
    parameters[key] = ABSOLUTE.has(key) ? value : round(initial + (value - initial) * t);
  }
  if (!managed && parameters.pivot === primaryDefaults.pivot) parameters.pivot = .5;
  const curves: ColorCurves = Object.fromEntries(Object.entries(look.curves ?? {}).map(([key, points]) => {
    const flat = (x: number) => (HSL_CURVES as readonly string[]).includes(key) ? .5 : x;
    return [key, { mode: 'smooth', points: points!.map(([x, y], i) => ({ id: `${key}-${i}`, x, y: round(flat(x) + (y - flat(x)) * t) })) } satisfies ColorCurve];
  }));
  const replaces = (key: string) => !KEEP.has(key) && (/^curve(25|50|75)$/.test(key) || LOOK_GROUPS.has(PARAM[key]?.group) || film && FILM_KEYS.includes(key));
  return { name: look.name, parameters, curves, replaces };
}
/** The value a replaced key resets to when the look does not set it. */
export const neutralValue = (key: string) => PARAM[key]?.initial ?? ({ curve25: .25, curve50: .5, curve75: .75 } as Record<string, number>)[key] ?? 0;
