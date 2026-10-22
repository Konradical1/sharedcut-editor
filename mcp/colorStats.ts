// Picture statistics for job color-measure (mcp/jobs/color.ts): what a colorist reads off the waveform and vectorscope,
// as a few numbers, and plain hints that name the grade controls when a reference picture is given. Pure maths on 8-bit
// RGBA. Everything is display code values 0–100 with Rec.709 luma weights, so a rendered frame and a reference image
// compare like for like. Hue is the qualifier's and HSL curves' hue (grading.ts hueOf: red 0, then yellow, green, …).
import { hueOf, PARAM } from '../src/services/grading.ts';

export interface Pixels { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
/** A box on the picture as fractions of its width and height, top-left origin. */
export interface Box { x: number; y: number; w: number; h: number }
/** Mean colour of some pixels: share of them (%), luma, R/G/B, cast = channel − luma, warm = (R − B)/2 (+ warm, − cool),
 *  mag = (R + B)/2 − G (+ magenta, − green), saturation (vectorscope chroma, 0–100) and spread: how far the pixels' chroma
 *  scatters around the cast (a cast moves the cast and keeps the spread; saturation scales both). */
export interface Tone { share: number; luma: number; rgb: number[]; cast: number[]; warm: number; mag: number; sat: number; spread: number }
/** `luma`: percentiles p1 p5 p25 p50 p75 p95 p99; black/white: % of pixels crushed (all channels ≤ 2/255) or clipped
 *  (a channel ≥ 253/255); zones: shadows (luma < 25), mids, highlights (> 75); hues: % of the colour (saturation-weighted)
 *  in 12 bins of 30° centred on HUES; hue: the saturation-weighted mean hue in degrees. */
export interface Stats { n: number; luma: number[]; black: number; white: number; all: Tone; zones: Tone[]; sat: number; sat90: number; hues: number[]; hue: number }

const W = [.2126, .7152, .0722], PERCENTILES = [1, 5, 25, 50, 75, 95, 99];
export const ZONES = ['shadows', 'mids', 'highlights'] as const;
export const HUES = ['red', 'orange', 'yellow', 'lime', 'green', 'mint', 'cyan', 'azure', 'blue', 'violet', 'magenta', 'pink'];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const at = (sorted: Float32Array, p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(p / 100 * (sorted.length - 1)))] * 100 : 0;
const warmOf = (c: number[]) => (c[0] - c[2]) / 2, magOf = (c: number[]) => (c[0] + c[2]) / 2 - c[1];

/** Statistics of the pixels inside `box` (default the whole picture). */
export function measure(px: Pixels, box: Box = { x: 0, y: 0, w: 1, h: 1 }): Stats {
  const x0 = clamp(Math.floor(box.x * px.width), 0, px.width - 1), x1 = clamp(Math.ceil((box.x + box.w) * px.width), x0 + 1, px.width);
  const y0 = clamp(Math.floor(box.y * px.height), 0, px.height - 1), y1 = clamp(Math.ceil((box.y + box.h) * px.height), y0 + 1, px.height);
  const n = (x1 - x0) * (y1 - y0), lumas = new Float32Array(n), sats = new Float32Array(n), bins = new Array(12).fill(0);
  // Per zone and for all: count, R, G, B, luma, saturation, squared chroma.
  const sums = [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0, 0, 0]);
  let i = 0, black = 0, white = 0, hx = 0, hy = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, i++) {
    const o = (y * px.width + x) * 4, R = px.data[o], G = px.data[o + 1], B = px.data[o + 2], r = R / 255, g = G / 255, b = B / 255;
    const l = W[0] * r + W[1] * g + W[2] * b, cb = (b - l) / (2 * (1 - W[2])), cr = (r - l) / (2 * (1 - W[0])), s = Math.min(1, 2 * Math.hypot(cb, cr));
    lumas[i] = l; sats[i] = s;
    if (R <= 2 && G <= 2 && B <= 2) black++;
    if (R >= 253 || G >= 253 || B >= 253) white++;
    for (const k of [l < .25 ? 0 : l > .75 ? 2 : 1, 3]) { const t = sums[k]; t[0]++; t[1] += r; t[2] += g; t[3] += b; t[4] += l; t[5] += s; t[6] += (r - l) ** 2 + (g - l) ** 2 + (b - l) ** 2; }
    // Greys and near-black pixels have no reliable hue.
    if (s > .03 && l > .02) { const h = hueOf(cb, cr, W); bins[Math.round(h * 12) % 12] += s; hx += s * Math.cos(2 * Math.PI * h); hy += s * Math.sin(2 * Math.PI * h); }
  }
  lumas.sort(); sats.sort();
  const tone = ([count, r, g, b, l, s, c2]: number[]): Tone => {
    if (!count) return { share: 0, luma: 0, rgb: [0, 0, 0], cast: [0, 0, 0], warm: 0, mag: 0, sat: 0, spread: 0 };
    const rgb = [r, g, b].map(v => v / count * 100), luma = l / count * 100, cast = rgb.map(v => v - luma);
    return { share: count / n * 100, luma, rgb, cast, warm: warmOf(cast), mag: magOf(cast), sat: s / count * 100, spread: Math.sqrt(Math.max(0, c2 / count * 1e4 - cast.reduce((a, v) => a + v * v, 0))) };
  };
  const weight = bins.reduce((a, v) => a + v, 0), colour = weight > n * .005;
  return {
    n, luma: PERCENTILES.map(p => at(lumas, p)), black: black / n * 100, white: white / n * 100,
    all: tone(sums[3]), zones: [0, 1, 2].map(z => tone(sums[z])), sat: sums[3][5] / n * 100, sat90: at(sats, 90),
    hues: bins.map(v => colour ? v / weight * 100 : 0), hue: colour ? ((Math.atan2(hy, hx) / (2 * Math.PI) + 1) % 1) * 360 : 0,
  };
}

/** The picture inside black letterbox or pillarbox bars (rows/columns black edge to edge), or the whole picture. */
export function content(px: Pixels): Box {
  let top = 0, bottom = px.height, left = 0, right = px.width;
  // JPEG bleeds a little colour into the bar line next to the picture: a bar line is near zero on average and never bright.
  const black = (count: number, offset: (i: number) => number) => {
    let sum = 0, max = 0;
    for (let i = 0; i < count; i++) { const o = offset(i), r = px.data[o], g = px.data[o + 1], b = px.data[o + 2]; sum += W[0] * r + W[1] * g + W[2] * b; max = Math.max(max, r, g, b); }
    return sum <= 2 * count && max <= 24;
  };
  const row = (y: number) => black(px.width, x => (y * px.width + x) * 4), column = (x: number) => black(bottom - top, i => ((top + i) * px.width + x) * 4);
  while (top < bottom && row(top)) top++;
  while (bottom > top && row(bottom - 1)) bottom--;
  while (left < right && column(left)) left++;
  while (right > left && column(right - 1)) right--;
  // Bars leave a real picture (a vertical video pillarboxed in 16:9 keeps 32% of the width); less is a fade or a dark frame.
  if (bottom - top < px.height / 5 || right - left < px.width / 5) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: left / px.width, y: top / px.height, w: (right - left) / px.width, h: (bottom - top) / px.height };
}

// ---- Text -------------------------------------------------------------------------------------------------------------

const int = (v: number) => String(Math.round(v));
const one = (v: number) => { const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : '') + (r || 0).toFixed(1); };
const pct = (v: number) => `${v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : Math.round(v)}%`;
const rgb = (t: Tone) => t.rgb.map(int).join('/');
export const hueName = (degrees: number) => HUES[Math.round(degrees / 30) % 12];
export function topHues(s: Stats, count = 3) {
  const top = s.hues.map((v, i) => [v, i]).filter(([v]) => v >= 5).sort((a, b) => b[0] - a[0]).slice(0, count);
  return top.length ? top.map(([v, i]) => `${HUES[i]} ${pct(v)}`).join(' ') : 'none (near grey)';
}
const toneText = (t: Tone) => `${pct(t.share)} rgb ${rgb(t)} warm ${one(t.warm)} mag ${one(t.mag)} sat ${int(t.sat)}`;

/** The frame's statistics, one metric per line, each with the reference's after " | ref " when given. */
export function statsLines(f: Stats, r?: Stats): string[] {
  const both = (label: string, text: (s: Stats) => string) => `${label}: ${text(f)}${r ? ` | ref ${text(r)}` : ''}`;
  return [
    both('luma p1/5/25/50/75/95/99', s => s.luma.map(int).join(' ')),
    both('crushed black/clipped white', s => `${pct(s.black)} ${pct(s.white)}`),
    ...ZONES.map((name, z) => both(name, s => toneText(s.zones[z]))),
    both('saturation mean/p90', s => `${int(s.sat)} ${int(s.sat90)}`),
    both('hues', s => topHues(s)),
  ];
}
/** A region in one line: its mean colour and its main hue in degrees. */
export const regionText = (s: Stats) => `luma ${int(s.all.luma)} rgb ${rgb(s.all)} warm ${one(s.all.warm)} mag ${one(s.all.mag)} sat ${int(s.all.sat)}${s.hues.some(Boolean) ? ` hue ${int(s.hue)}° ${hueName(s.hue)}` : ''}`;

// ---- Hints ------------------------------------------------------------------------------------------------------------

/**
 * How the clip's own grade answers a change made at its start (where Balance sits), from the CPU reference
 * (color-measure builds it): each returns the change that moves a grey at display luma `level` (0–100) as asked.
 */
export interface GradeModel {
  /** Stops that move a grey from display luma `from` to `to`. */
  exposure(from: number, to: number): number;
  /** Contrast factor that makes the luma spread between greys at `low` and `high` equal `spread`. */
  contrast(low: number, high: number, spread: number): number;
  /** Temperature and tint that change a grey's warm and mag by these display units. */
  balance(level: number, warm: number, mag: number): [number, number];
  /** Saturation (%) that scales the display chroma of colours at `level` by `ratio`. */
  saturation(level: number, ratio: number): number;
  /** Values of `keys` (an R, G and B parameter) that move a grey's R, G, B by `need` display units. */
  channels(keys: string[], level: number, need: number[]): number[];
}
const WHEELS = [['lift', 'logShadow', 'Shadows wheel'], ['gamma', 'logMid', 'Midtones wheel'], ['gain', 'logHighlight', 'Highlights wheel']] as const;
/** What the frame is next to the reference, given what it needs: the cast's direction on the warm/magenta plane. */
function castWords(need: number[]) {
  const warm = (need[2] - need[0]) / 2, mag = -(need[0] + need[2]) / 2 + need[1], turn = Math.atan2(mag, warm) / (Math.PI / 4);
  return ['warmer', 'redder', 'more magenta', 'bluer', 'cooler', 'more cyan', 'greener', 'more yellow'][(Math.round(turn) + 8) % 8];
}
const channels = (need: number[]) => 'needs ' + need.map((v, c) => `${'RGB'[c]} ${one(v)}`).join(' ');
const big = (need: number[], limit = 1.5) => need.some(v => Math.abs(v) >= limit);
const minus = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
/** A change to add: +.012, -.3, 0. */
const delta = (v: number, digits = 3) => Math.abs(v) < .5 * 10 ** -digits ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(digits).replace(/^(-?)0\./, '$1.')}`;
const step = (base: string, values: number[]) => values.map((v, c) => `${base}${'RGB'[c]} ${delta(v)}`).join(' ');
const tryModel = <T>(compute: () => T): T | undefined => { try { const v = compute(); return [v].flat().every(x => Number.isFinite(x)) ? v : undefined; } catch { return undefined; } };

/**
 * What to change so the frame looks like the reference, in grading order (brightness, contrast, ends, clipping, overall
 * tint, tint per zone, saturation, hues). Directions are reliable. Amounts come from `model` (the clip's own grade) and are
 * damped so a first step undershoots; without one they are display-gamma guesses (`linear`: exposure and white balance
 * scale linear light, as on nodes-v2, not the display signal, as on legacy). Measure again after each round.
 */
export function hints(f: Stats, r: Stats, options: { linear?: boolean; model?: GradeModel } = {}): string[] {
  const { linear = true, model } = options, out: string[] = [], [f5, f50, f95] = [f.luma[1], f.luma[3], f.luma[5]], [r5, r50, r95] = [r.luma[1], r.luma[3], r.luma[5]];
  // Display code ≈ linear^(1/2.4), so on linear light a ratio of medians is 2.4·log2 stops.
  const gamma = linear ? 2.4 : 1, where = linear ? 'Balance' : 'a node', damp = (k: number, by = .9) => 1 + by * (k - 1);
  if (Math.abs(f50 - r50) >= 3) {
    const stops = clamp(.9 * (tryModel(() => model!.exposure(f50, r50)) ?? .9 * gamma * Math.log2(Math.max(r50, 2) / Math.max(f50, 2))), -4, 4);
    out.push(`${f50 < r50 ? 'darker' : 'brighter'} than ref (median ${int(f50)} vs ${int(r50)}): exposure ${delta(stops, 2)} stops (${where}), or gamma (Midtones) ${f50 < r50 ? 'up' : 'down'}`);
  }
  const fs = f95 - f5, rs = r95 - r5, contrast = fs > 2 && Math.abs(rs / fs - 1) >= .08 ? damp(clamp(tryModel(() => model!.contrast(f5, f95, rs)) ?? rs / fs, .25, 4)) : 1;
  if (contrast !== 1) out.push(`${rs > fs ? 'less' : 'more'} contrast than ref (p95−p5 ${int(fs)} vs ${int(rs)}): contrast ×${contrast.toFixed(2)} around pivot, or an S-curve`);
  if (Math.abs(f5 - r5) >= 3) out.push(`blacks ${f5 > r5 ? 'lifted' : 'deeper'} vs ref (p5 ${int(f5)} vs ${int(r5)}): lift (Shadows master) ${f5 > r5 ? 'down' : 'up'}, or shadows ${f5 > r5 ? '−' : '+'}`);
  if (Math.abs(f95 - r95) >= 3) out.push(`highlights ${f95 < r95 ? 'dimmer' : 'brighter'} vs ref (p95 ${int(f95)} vs ${int(r95)}): gain (Highlights master) ${f95 < r95 ? 'up' : 'down'}, or highlights ${f95 < r95 ? '+' : '−'}`);
  if (f.white - r.white >= 1.5 && f.white >= 1) out.push(`more clipped whites (${pct(f.white)} vs ${pct(r.white)}): highlights − or gain down; on log footage useAcesOutput(clip)`);
  if (f.black - r.black >= 1.5 && f.black >= 1) out.push(`more crushed blacks (${pct(f.black)} vs ${pct(r.black)}): lift up or shadows +`);
  if (r.sat < 2 && f.sat >= 4) {
    out.push(`ref is black and white (saturation ${int(r.sat)}): mixMono 1 with a mix row (looks tri-x, soft-silver), or saturation 0`);
    return out;
  }
  // Saturation scales the chroma of every pixel, a cast shifts it: the ratio of the picture's chroma spreads is the saturation
  // change, and what is left of each mean colour after scaling by it is the cast (so a greener field is saturation, not a
  // green cast). One ratio for the whole picture: a zone's own spread is mostly which pixels fall in it, too noisy to divide by.
  // The saturation and contrast steps suggested below multiply what a change at Balance adds: its amounts are divided by them.
  // Casts are compared after the suggested saturation change, so without one they are compared as they are.
  const spread = f.all.spread >= 1 && r.all.spread >= .5 ? clamp(r.all.spread / f.all.spread, .25, 4) : 1;
  const satHint = Math.abs(spread - 1) >= .12 && Math.abs(r.all.spread - f.all.spread) >= 1.5, ratio = satHint ? spread : 1, scaled = (t: Tone) => t.cast.map(v => v * ratio);
  const saturation = satHint ? damp(clamp((tryModel(() => model!.saturation(f.all.luma, ratio)) ?? ratio * 100) / 100, 0, 4)) : 1;
  const gain = saturation * contrast, overall = minus(r.all.cast, scaled(f.all));
  const warm = (overall[0] - overall[2]) / 2, mag = (overall[0] + overall[2]) / 2 - overall[1];
  const zones = [0, 1, 2].filter(z => f.zones[z].share >= 3 && r.zones[z].share >= 3), needs = zones.map(z => minus(r.zones[z].cast, scaled(f.zones[z])));
  const size = (v: number[]) => Math.max(...v.map(Math.abs));
  // One Balance move only when it brings every zone closer; a split tone (cool shadows, warm highlights) is per zone.
  const global = (Math.abs(warm) >= 1.5 || Math.abs(mag) >= 1.5) && needs.every(need => size(minus(need, overall)) < size(need));
  if (global) {
    // Temperature scales R and B by 1 ± t/10000, tint G by 1 − t/200; the guess without a model assumes Rec.709 primaries.
    const d = Math.max(.1, f.all.luma / 100), [t, k] = (tryModel(() => model!.balance(f.all.luma, warm / gain, mag / gain)) ?? [warm * gamma * 100 / d / gain, mag * gamma * 2 / d / gain]).map(v => .8 * v);
    const temperature = clamp(Math.round(t / 10) * 10, PARAM.temperature.min, PARAM.temperature.max), tint = clamp(Math.round(k), PARAM.tint.min, PARAM.tint.max);
    const moves = [temperature && `temperature ${temperature > 0 ? '+' : ''}${temperature}`, tint && `tint ${tint > 0 ? '+' : ''}${tint}`].filter(Boolean).join(', ');
    out.push(`overall ${castWords(overall)} than ref (warm ${one(f.all.warm)} vs ${one(r.all.warm)}, mag ${one(f.all.mag)} vs ${one(r.all.mag)}${ratio === 1 ? '' : ' after the saturation change'}): ${moves || 'temperature/tint'} (${where}), or it ${channels(overall)} via offsetR/G/B (Offset wheel)`);
  }
  zones.forEach((z, i) => {
    const need = global ? minus(needs[i], overall) : needs[i], [primary, log, wheel] = WHEELS[z];
    if (!big(need)) return;
    const level = f.zones[z].luma, amounts = (base: string) => tryModel(() => model!.channels(['R', 'G', 'B'].map(c => base + c), level, need.map(v => v / gain)).map(v => .8 * v));
    // A log band that does not reach this zone's level cannot be solved for: say so rather than give nothing.
    const a = amounts(primary), b = amounts(log), band = z === 0 ? 'logLowRange' : z === 2 ? 'logHighRange' : 'logLowRange/logHighRange';
    out.push(`${ZONES[z]}${global ? ' also' : ''} ${castWords(need)} than ref: ${channels(need)} via ${a ? step(primary, a) : `${primary}R/G/B`} (${wheel}), or ${b ? step(log, b) : `${log}R/G/B${model && a ? ` once ${band} takes in this level` : ''}`}`);
  });
  if (satHint) {
    // Boost moves muted colours more than vivid ones: say which end the change is mostly about.
    const vivid = r.sat90 / Math.max(1, f.sat90), muted = Math.abs(ratio - 1) - Math.abs(vivid - 1), up = ratio > 1;
    out.push(`${up ? 'less' : 'more'} saturated than ref (colour spread ${int(f.all.spread)} vs ${int(r.all.spread)}, mean ${int(f.sat)} vs ${int(r.sat)}, p90 ${int(f.sat90)} vs ${int(r.sat90)}): saturation ×${saturation.toFixed(2)}${muted > .1 ? `, or mostly boost ${up ? '+' : '−'} (muted colours differ most)` : muted < -.1 ? ` with boost ${up ? '−' : '+'} (vivid colours differ most)` : ''}`);
  }
  if (f.sat >= 4 && r.sat >= 4) {
    const diff = r.hues.map((v, i) => v - f.hues[i]), more = diff.indexOf(Math.max(...diff)), less = diff.indexOf(Math.min(...diff)), up = diff[more] >= 8, down = diff[less] <= -8;
    if (up || down) {
      const x = (i: number) => `x ${String(+(i / 12).toFixed(2)).replace(/^0\./, '.')}`;
      const has = [up && `more ${HUES[more]} (${pct(r.hues[more])} vs ${pct(f.hues[more])} of the colour)`, down && `less ${HUES[less]} (${pct(r.hues[less])} vs ${pct(f.hues[less])})`].filter(Boolean).join(', ');
      const fix = [up && `up at ${HUES[more]} (${x(more)})`, down && `down at ${HUES[less]} (${x(less)})`].filter(Boolean).join(', ');
      out.push(`ref has ${has}: once the casts match, HueSat ${fix}${up && down ? `, or HueHue turning ${HUES[less]} toward ${HUES[more]}` : ''}`);
    }
  }
  return out;
}

/** What one region needs to match the same region of the reference, or '' when it already does. */
export function regionHint(f: Stats, r: Stats): string {
  const need = minus(r.all.cast, f.all.cast), luma = r.all.luma - f.all.luma, sat = r.all.sat - f.all.sat, parts: string[] = [];
  if (Math.abs(luma) >= 3) parts.push(`luma ${one(luma)}`);
  if (big(need)) parts.push(`${castWords(need)}: ${channels(need)}`);
  if (Math.abs(sat) >= 3) parts.push(`sat ${one(sat)}`);
  return parts.join(', ');
}
