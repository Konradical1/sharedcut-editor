import { primaryDefaults } from './color.ts';
import type { CurvePoints, LookValues, Rgb } from './colorAssistant.ts';

/** The Color Assistant's look library: hand-tuned Look node values, judged on real footage through ACES 2 (S-Log3 stage, Canon Log 3 sports and night).
 * The model picks a look and a strength; it never writes these numbers itself. Values are DaVinci Intermediate: one stop is about 0.073, so
 * channel moves of a few thousandths are already visible. Split toning lives in per-channel curves that pin the mid-grey point, so skin
 * (which sits in the mids) keeps its hue. Retune with scripts/color-look-lab.mjs. */
export type LookRecipe = { id: string; name: string; about: string; look: Partial<LookValues> };
const P = primaryDefaults.pivot;
/** A per-channel curve: shadows moved by `low` at DI .15 (about -2.5 stops), highlights by `high` at DI .6 (about +3.5); black, mid-grey and white pinned. */
const tone = (low: number, high: number): CurvePoints[] => [{ x: 0, y: 0 }, { x: .15, y: .15 + low }, { x: P, y: P }, { x: .6, y: .6 + high }, { x: 1, y: 1 }];

export const RECIPES: LookRecipe[] = [
  { id: 'clean', name: 'Clean', about: 'a careful colorist\'s polish: a little contrast and density, true color, clean blacks. Suits anything.',
    look: { contrast: 1.08, saturation: 104, saturationShadows: 90, saturationHighlights: 94 } },
  { id: 'warm-film', name: 'Warm film', about: 'print-film warmth: soft warm highlights, slightly cool dense shadows, gentle saturation. Flattering on people.',
    look: { contrast: 1.12, saturation: 95, saturationShadows: 75, saturationHighlights: 86, lift: .006, offsetRgb: { r: .007, g: .002, b: -.009 }, curves: { rgb: [], r: tone(-.01, .014), g: tone(.002, .005), b: tone(.014, -.02) } } },
  { id: 'teal-amber', name: 'Teal and amber', about: 'the blockbuster split: teal shadows, warm highlights, skin kept natural. Strong on night, city and action.',
    look: { contrast: 1.16, saturation: 108, saturationShadows: 88, curves: { rgb: [], r: tone(-.02, .02), g: tone(.007, .004), b: tone(.018, -.022) } } },
  { id: 'golden', name: 'Golden hour', about: 'late sun: warm overall, rich but not orange skin, soft highlights. Daylight, outdoor, sport, travel.',
    look: { contrast: 1.06, saturation: 108, saturationHighlights: 94, offsetRgb: { r: .008, g: .003, b: -.011 }, curves: { rgb: [], r: tone(0, .006), g: [], b: tone(0, -.006) } } },
  { id: 'moody-cool', name: 'Moody cool', about: 'quiet and cold: a touch darker, cooler, less saturated, deep shadows. Drama, interviews, overcast.',
    look: { contrast: 1.16, saturation: 78, saturationShadows: 66, offset: -.015, offsetRgb: { r: -.002, g: .001, b: .002 }, curves: { rgb: [], r: tone(-.008, 0), g: tone(.003, 0), b: tone(.01, 0) } } },
  { id: 'bleach', name: 'Bleach bypass', about: 'silver-retention film: hard contrast, drained color, metallic highlights. Gritty sport, war, music.',
    look: { contrast: 1.28, saturation: 62, saturationShadows: 55, saturationHighlights: 60 } },
  { id: 'faded', name: 'Faded film', about: 'soft matte blacks, gentle highlights, muted pastel color. Nostalgic, lifestyle, indie.',
    look: { contrast: .96, saturation: 86, saturationShadows: 72, curves: { rgb: [{ x: 0, y: .05 }, { x: .2, y: .21 }, { x: P, y: P }, { x: .8, y: .78 }, { x: 1, y: .94 }], r: tone(0, .005), g: [], b: tone(.004, -.005) } } },
  { id: 'night', name: 'Moonlit night', about: 'a night look: darker, blue shadows and mids, restrained color, lights stay bright. Night or dusk scenes.',
    look: { contrast: 1.12, saturation: 68, saturationHighlights: 85, offset: -.03, offsetRgb: { r: -.004, g: .001, b: .003 }, curves: { rgb: [], r: tone(-.012, .002), g: tone(.004, 0), b: tone(.016, -.002) } } },
  { id: 'mono', name: 'Black and white', about: 'rich monochrome with deep blacks and bright whites. Portraits, documentary, drama.',
    look: { contrast: 1.18, saturation: 0 } },
  { id: 'vintage', name: '70s vintage', about: 'yellowed old print: warm-yellow cast, lifted blacks, low contrast, faded greens and blues.',
    look: { contrast: .96, saturation: 84, saturationShadows: 68, offsetRgb: { r: .008, g: .004, b: -.014 }, curves: { rgb: [{ x: 0, y: .045 }, { x: P, y: P }, { x: 1, y: .96 }], r: [], g: [], b: tone(.01, -.008) } } },
  { id: 'cyan-green', name: 'Cyan green', about: 'thriller palette: green-yellow highlights, cyan shadows, low saturation. Tension, tech, urban night.',
    look: { contrast: 1.15, saturation: 76, saturationShadows: 66, curves: { rgb: [], r: tone(-.018, 0), g: tone(.008, .005), b: tone(.012, -.011) } } },
  { id: 'vivid', name: 'Vivid', about: 'punchy and bright: more contrast and saturation, clean whites. Sport, events, festivals, ads.',
    look: { contrast: 1.12, saturation: 120, saturationShadows: 95, saturationHighlights: 100 } },
  { id: 'steel', name: 'Cold steel', about: 'desaturated blue-grey, cool and hard. Industrial, winter, sci-fi.',
    look: { contrast: 1.12, saturation: 68, saturationShadows: 60, offsetRgb: { r: -.006, g: -.001, b: .007 } } },
];
/** Offset per unit of warmth (DI); +1 warms about as much as the Golden hour look does. */
const WARMTH = .006;

const blend = (a: number, b: number, t: number) => +(a + (b - a) * t).toFixed(5);
const blendRgb = (b: Rgb | undefined, t: number): Rgb => ({ r: blend(0, b?.r ?? 0, t), g: blend(0, b?.g ?? 0, t), b: blend(0, b?.b ?? 0, t) });
const blendCurve = (points: CurvePoints[] | undefined, t: number) => (points ?? []).map(p => ({ x: p.x, y: blend(p.x, p.y, t) }));
/** Look node values for a library look at `strength` (0 = no change, 1 = as designed), plus a warmth trim. Unknown ids throw. */
export function recipeLook(id: string, strength: number, warmth = 0): LookValues {
  const recipe = RECIPES.find(r => r.id === id); if (!recipe) throw Error(`Unknown look "${id}".`);
  const l = recipe.look, t = Math.max(0, Math.min(1, strength)), offset = blendRgb(l.offsetRgb, t), range = (k: 'saturationShadows' | 'saturationMidtones' | 'saturationHighlights') => l[k] === undefined ? {} : { [k]: blend(100, l[k]!, t) };
  return {
    contrast: blend(1, l.contrast ?? 1, t), pivot: l.pivot ?? P, saturation: blend(100, l.saturation ?? 100, t), lift: blend(0, l.lift ?? 0, t), gamma: blend(0, l.gamma ?? 0, t), gain: blend(1, l.gain ?? 1, t), offset: blend(0, l.offset ?? 0, t),
    liftRgb: blendRgb(l.liftRgb, t), gammaRgb: blendRgb(l.gammaRgb, t), gainRgb: blendRgb(l.gainRgb, t), offsetRgb: { r: +(offset.r + warmth * WARMTH).toFixed(5), g: offset.g, b: +(offset.b - warmth * WARMTH).toFixed(5) },
    curves: { rgb: blendCurve(l.curves?.rgb, t), r: blendCurve(l.curves?.r, t), g: blendCurve(l.curves?.g, t), b: blendCurve(l.curves?.b, t) },
    ...range('saturationShadows'), ...range('saturationMidtones'), ...range('saturationHighlights'),
  };
}
