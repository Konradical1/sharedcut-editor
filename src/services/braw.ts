// Blackmagic RAW Camera Raw settings, shared by the Color page, the server and the MCP. The keys are the RAW SDK's
// .sidecar names; the server's helper (scripts/braw/braw.cpp) hands them to the SDK as they are, so a setting here means
// exactly what it means in DaVinci Resolve's Camera Raw panel.
import type { BrawInfo, BrawState, RawValue } from '../state/models.ts';

/** In the order the helper applies them: science, gamut and gamma first, because choosing a gamma resets its curve. */
export const RAW_KEYS = ['viewing_bmdgen', 'viewing_gamut', 'viewing_gamma', 'tone_curve_contrast', 'tone_curve_saturation', 'tone_curve_midpoint', 'tone_curve_highlights',
  'tone_curve_shadows', 'tone_curve_black_level', 'tone_curve_white_level', 'tone_curve_video_black_level', 'highlight_recovery', 'gamut_compression_enable',
  'post_3dlut_mode', 'iso', 'white_balance_kelvin', 'white_balance_tint', 'exposure'] as const;
export type RawKey = typeof RAW_KEYS[number];
export const TONE_KEYS = RAW_KEYS.filter(key => key.startsWith('tone_curve_'));
const CHOICES = ['viewing_bmdgen', 'viewing_gamut', 'viewing_gamma', 'post_3dlut_mode', 'iso'];
const SWITCHES = ['highlight_recovery', 'gamut_compression_enable', 'tone_curve_video_black_level'];
const WHOLE = ['white_balance_kelvin', 'white_balance_tint'];
/** The gammas whose curve the custom sliders edit (SDK guide: Blackmagic Design Video keeps them disabled). */
const CURVED = ['Blackmagic Design Film', 'Blackmagic Design Extended Video', 'Blackmagic Design Custom'];

export const isBrawName = (name: string) => /\.braw$/i.test(name);
/** The settings a develop uses: the camera's, with the clip's own on top. */
export const effectiveRaw = (braw: Pick<BrawState, 'info' | 'settings'>): Record<string, RawValue> => ({ ...braw.info.asShot, ...braw.settings });
/** The same settings always give the same key, so a look is never developed twice. */
export const rawSignature = (settings: Record<string, RawValue>) => JSON.stringify(RAW_KEYS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
/** A short key of the settings for URLs (FNV-1a over the signature), the same in the browser and on the server. */
export function rawKey(settings: Record<string, RawValue>) {
  let hash = 0x811c9dc5;
  for (const char of rawSignature(settings)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
/** The clip's files are behind its settings: a develop is queued or running. */
export const rawPending = (braw?: BrawState) => !!braw && rawSignature(braw.settings) !== (braw.developed ?? rawSignature({}));

/** The clip's own settings, checked against what its camera offers; values the camera already has are left out. */
export function validateRawSettings(info: BrawInfo, input: unknown): Record<string, RawValue> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Camera Raw settings must be an object.');
  const out: Record<string, RawValue> = {};
  for (const [key, given] of Object.entries(input as Record<string, unknown>)) {
    if (!(RAW_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown Camera Raw setting: ${key}.`);
    let value = given as RawValue;
    if (CHOICES.includes(key)) {
      if (!(info.options[key] ?? []).includes(value)) throw new Error(`${key} must be one of: ${(info.options[key] ?? []).join(', ')}.`);
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number.`);
      if (SWITCHES.includes(key)) { if (value !== 0 && value !== 1) throw new Error(`${key} is 0 or 1.`); }
      else {
        if (WHOLE.includes(key)) value = Math.round(value);
        const [low, high] = info.ranges[key] ?? [-Infinity, Infinity];
        if (value < low - 1e-6 || value > high + 1e-6) throw new Error(`${key} must be between ${low} and ${high}.`);
      }
    }
    if (info.asShot[key] !== value) out[key] = value;
  }
  return out;
}

/** The clip's settings after one control changes, as Resolve's panel behaves: moving a curve slider switches the gamma to
 *  Blackmagic Design Custom, starting from the curve the gamma had; choosing a gamma or science gives that one's own curve. */
export function rawChange(braw: Pick<BrawState, 'info' | 'settings'>, key: RawKey, value: RawValue): Record<string, RawValue> {
  const now = effectiveRaw(braw), next: Record<string, RawValue> = { ...braw.settings, [key]: value };
  if ((TONE_KEYS as string[]).includes(key) && now.viewing_gamma !== 'Blackmagic Design Custom') Object.assign(next, toneCurve(braw), { [key]: value, viewing_gamma: 'Blackmagic Design Custom' });
  if ((key === 'viewing_gamma' && value !== 'Blackmagic Design Custom') || key === 'viewing_bmdgen') for (const tone of TONE_KEYS) delete next[tone];
  return next;
}
export const curveEditable = (effective: Record<string, RawValue>) => CURVED.includes(String(effective.viewing_gamma));
/** The curve the custom sliders show: the chosen gamma's own (Film, Extended Video) or the clip's custom one. */
export function toneCurve(braw: Pick<BrawState, 'info' | 'settings'>): Record<string, number> {
  const e = effectiveRaw(braw), own = braw.info.toneCurves[`${e.viewing_bmdgen}:${e.viewing_gamma}`];
  return e.viewing_gamma !== 'Blackmagic Design Custom' && own ? own : Object.fromEntries(TONE_KEYS.map(key => [key, Number(e[key])]));
}

const GAMMAS: Record<string, string> = { 'DaVinci Intermediate': 'DaVinci Intermediate', 'S-Log3': 'S-Log3', 'Canon Log2': 'Canon Log 2', Linear: 'Linear', 'Rec.709': 'Rec.709',
  'Blackmagic Design Video': 'Rec.709', 'Blackmagic Design Extended Video': 'Rec.709', 'Blackmagic Design Custom': 'Rec.709' };
const GAMUTS: Record<string, string> = { 'Blackmagic Design': 'Blackmagic Wide Gamut', 'Rec.709': 'Rec.709', 'Rec.2020': 'Rec.2020', 'DaVinci Wide Gamut': 'DaVinci Wide Gamut',
  'S-Gamut3.Cine': 'S-Gamut3.Cine', 'S-Gamut3': 'S-Gamut3', 'Canon Cinema Gamut': 'Cinema Gamut' };
/** The source gamma and gamut the colour pipeline reads the developed picture as. Blackmagic Design Video and Extended Video
 *  are display gammas: with the Blackmagic Design gamut they come out as Rec.709 pictures. Film is Gen 5's curve only. */
export function rawColorSpace(effective: Record<string, RawValue>): { inputProfile?: string; inputGamut?: string; colorEvidence: string } {
  const gamma = String(effective.viewing_gamma), gamut = String(effective.viewing_gamut), gen = Number(effective.viewing_bmdgen);
  const display = gamma.startsWith('Blackmagic Design') && gamma !== 'Blackmagic Design Film';
  const inputProfile = gamma === 'Blackmagic Design Film' ? (gen === 5 ? 'Blackmagic Film Gen 5' : undefined) : GAMMAS[gamma];
  const inputGamut = display && gamut === 'Blackmagic Design' ? 'Rec.709' : GAMUTS[gamut];
  const colorEvidence = `Blackmagic RAW developed as ${gamma}${gamma === 'Blackmagic Design Film' ? ` (Gen ${gen})` : ''}, ${gamut === 'Blackmagic Design' ? 'Blackmagic Wide Gamut' : gamut}`;
  return inputProfile && inputGamut ? { inputProfile, inputGamut, colorEvidence }
    : { colorEvidence: `${colorEvidence}. Colour management has no input for that pair: choose Blackmagic Design Film with Gen 5, or DaVinci Intermediate, to grade it managed.` };
}
