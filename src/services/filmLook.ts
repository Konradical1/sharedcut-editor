import { decodeLog, encodeLog } from './color.ts';
import { DETAIL, detailStops, filmMotion, grainKey, grainNoise, halationTint, smoothstep, sse } from './grading.ts';

/**
 * CPU reference of the film stage (docs/color-grading-v3.md, "Film stage"): gate weave, aberration, halation, bloom,
 * breath, vignette and grain on a whole picture, and of the Dehaze/Clarity maps on the same blur pieces. The GPU preview and color-render.py implement the same steps; tests
 * hold all three to this. `rgb` is interleaved RGB of a width×height picture in the stage's encoding.
 */
export interface FilmStage { p: Record<string, number>; gamma: string; weights: number[] }
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/** Bilinear sample of channel `c` at texel coordinates (sx, sy), edges clamped: the GPU's LINEAR + CLAMP_TO_EDGE. */
function sample(data: Float32Array, width: number, height: number, channels: number, c: number, sx: number, sy: number) {
  const x = clamp(sx, 0, width - 1), y = clamp(sy, 0, height - 1), x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1), fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) => data[(yy * width + xx) * channels + c];
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx, bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
  return top + (bottom - top) * fy;
}

/** filmBlur's 2×2 box halving: ⌈w/2⌉ × ⌈h/2⌉ texels, input indices clamped. */
export function halve(data: Float32Array, w: number, h: number, channels: number): Float32Array {
  const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2), next = new Float32Array(nw * nh * channels);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const x0 = 2 * x, x1 = Math.min(2 * x + 1, w - 1), y0 = 2 * y, y1 = Math.min(2 * y + 1, h - 1);
    for (let c = 0; c < channels; c++) next[(y * nw + x) * channels + c] = (data[(y0 * w + x0) * channels + c] + data[(y0 * w + x1) * channels + c] + data[(y1 * w + x0) * channels + c] + data[(y1 * w + x1) * channels + c]) / 4;
  }
  return next;
}
/** filmBlur's separable Gaussian at σ' = s on a w×h picture: radius ⌈3s⌉ taps, weights exp(−i²/2s²) normalised, edges clamped. */
export function gaussian(data: Float32Array, w: number, h: number, channels: number, s: number): Float32Array {
  const radius = Math.ceil(3 * s), kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * s * s))), total = kernel.reduce((a, b) => a + b);
  const pass = (input: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(input.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) { const xx = horizontal ? clamp(x + k, 0, w - 1) : x, yy = horizontal ? y : clamp(y + k, 0, h - 1); sum += kernel[k + radius] * input[(yy * w + xx) * channels + c]; }
      out[(y * w + x) * channels + c] = sum / total;
    }
    return out;
  };
  return pass(pass(data, true), false);
}
/** filmBlur's upsample of a w×h picture to width×height: bilinear, half-pixel centres, edges clamped. */
export function upsample(data: Float32Array, w: number, h: number, channels: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) out[(y * width + x) * channels + c] = sample(data, w, h, channels, c, (x + .5) * w / width - .5, (y + .5) * h / height - .5);
  return out;
}
/** The shared blur: 2×2 box halvings until σ' ∈ [4, 8), a separable Gaussian (radius ⌈3σ'⌉, clamped edges), bilinear upsample. */
export function filmBlur(src: Float32Array, width: number, height: number, channels: number, sigma: number): Float32Array {
  if (sigma < .5) return src;
  const levels = Math.max(0, Math.floor(Math.log2(sigma / 4)));
  let data = src, w = width, h = height;
  for (let level = 0; level < levels; level++) { data = halve(data, w, h, channels); w = Math.ceil(w / 2); h = Math.ceil(h / 2); }
  const blurred = gaussian(data, w, h, channels, sigma / 2 ** levels);
  return levels ? upsample(blurred, w, h, channels, width, height) : blurred;
}

/** Dehaze/Clarity maps at pyramid level k (wk×hk, RGBA): M1 = blurred (a_c, b_c, α, β), M2 = B2 = blurred (μd, c_md, dvr, dvb). */
export interface DetailMaps { k: number; wk: number; hk: number; m1: Float32Array; m2: Float32Array }
/**
 * The maps of a detail point (docs/color-grading-v3.md, "Detail") from the whole width×height node input in the stage's encoding:
 * lin = decode(rgb, gamma) × gain (G; 1 when absent), sources halved k times, the soft dark channel on the small Gaussian, the
 * guided filters on the large one. One level, no frame statistic: every value depends only on pixels within the blur support.
 */
export function detailMaps(rgb: Float32Array, width: number, height: number, stage: { gamma: string; weights: number[]; gain?: number[] }): DetailMaps {
  const K = DETAIL, w = stage.weights, gain = stage.gain ?? [1, 1, 1], sigma = K.R / 100 * height, k = Math.max(0, Math.floor(Math.log2(sigma / 4))), s = sigma / 2 ** k, n = width * height;
  // Per pixel SA = (l, l², lm, mx), SB = 1/clamp(lin, M0, 1)⁴ (products, never pow), then filmBlur's halvings.
  let sa: Float32Array = new Float32Array(n * 4), sb: Float32Array = new Float32Array(n * 3), wk = width, hk = height;
  for (let i = 0; i < n; i++) {
    const lin = [0, 1, 2].map(c => decodeLog(rgb[i * 3 + c], stage.gamma) * gain[c]), l = detailStops(w[0] * lin[0] + w[1] * lin[1] + w[2] * lin[2]), mx = Math.max(...lin, 0), lm = detailStops(mx);
    sa[i * 4] = l; sa[i * 4 + 1] = l * l; sa[i * 4 + 2] = lm; sa[i * 4 + 3] = mx;
    for (let c = 0; c < 3; c++) { const r = 1 / clamp(lin[c], K.M0, 1); sb[i * 3 + c] = r * r * (r * r); }
  }
  for (let level = 0; level < k; level++) { sa = halve(sa, wk, hk, 4); sb = halve(sb, wk, hk, 3); wk = Math.ceil(wk / 2); hk = Math.ceil(hk / 2); }
  const m = wk * hk, pb = gaussian(sb, wk, hk, 3, s * K.RD / K.R), t1 = new Float32Array(m * 4), t2 = new Float32Array(m * 4);
  for (let i = 0; i < m; i++) {
    // Soft dark channel: the power-mean soft minimum per channel, its veil colour within SMAX stops of neutral, and sky and clouds
    // (the level-k box mean of the max channel) taken out before any blur.
    const sm = [0, 1, 2].map(c => 1 / Math.sqrt(Math.sqrt(pb[i * 3 + c]))), vr = Math.log2(sm[0] / sm[1]), vb = Math.log2(sm[2] / sm[1]), sc = Math.min(1, K.SMAX / Math.max(Math.sqrt(vr * vr + vb * vb), 1e-6));
    const dk = Math.min(...sm) * (1 - smoothstep(K.GLO, K.GHI, sa[i * 4 + 3])), lm = sa[i * 4 + 2], j = i * 4;
    t1[j] = sa[j]; t1[j + 1] = sa[j + 1]; t1[j + 2] = lm; t1[j + 3] = lm * lm; t2[j] = dk; t2[j + 1] = lm * dk; t2[j + 2] = dk * vr * sc; t2[j + 3] = dk * vb * sc;
  }
  const b1 = gaussian(t1, wk, hk, 4, s), b2 = gaussian(t2, wk, hk, 4, s), coefficients = new Float32Array(m * 4);
  for (let j = 0; j < m * 4; j += 4) {
    // Clarity: the self-guided base of l; Dehaze: the haze map guided by lm, so it snaps to ridgelines.
    const vl = Math.max(b1[j + 1] - b1[j] ** 2, 0), vm = Math.max(b1[j + 3] - b1[j + 2] ** 2, 0), ac = vl / (vl + K.EPS_C), al = (b2[j + 1] - b1[j + 2] * b2[j]) / (vm + K.EPS_D);
    coefficients[j] = ac; coefficients[j + 1] = (1 - ac) * b1[j]; coefficients[j + 2] = al; coefficients[j + 3] = b2[j] - al * b1[j + 2];
  }
  return { k, wk, hk, m1: gaussian(coefficients, wk, hk, 4, s), m2: b2 };
}
/** The 8 map values (M1 then M2) at pixel (x, y) of the width×height picture: filmBlur's half-pixel-centre bilinear, clamped. */
export function detailAt(maps: DetailMaps, width: number, height: number, x: number, y: number): number[] {
  const { wk, hk } = maps, sx = (x + .5) * wk / width - .5, sy = (y + .5) * hk / height - .5;
  return [0, 1, 2, 3, 4, 5, 6, 7].map(i => sample(i < 4 ? maps.m1 : maps.m2, wk, hk, 4, i % 4, sx, sy));
}

export function applyFilm(rgb: Float32Array, width: number, height: number, stage: FilmStage, frame: number): Float32Array {
  const p = stage.p, w = stage.weights, aspect = width / height, n = width * height, { ox, oy, breath } = filmMotion(p, frame), ab = .004 * p.filmAberration / 100;
  // 1–2. Gate weave and aberration move where each channel is read from.
  let src = rgb;
  if (ox || oy || ab) {
    src = new Float32Array(rgb.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
      const k = c === 0 ? 1 + ab : c === 2 ? 1 - ab : 1, qx = .5 + ((x + .5) / width - .5) * k - ox / aspect, qy = .5 + ((y + .5) / height - .5) * k - oy;
      src[(y * width + x) * 3 + c] = sample(rgb, width, height, 3, c, qx * width - .5, qy * height - .5);
    }
  }
  // 3–7 in linear light.
  const lin = src.map(v => decodeLog(v, stage.gamma)), out = Float32Array.from(lin), luma = (i: number) => w[0] * lin[i * 3] + w[1] * lin[i * 3 + 1] + w[2] * lin[i * 3 + 2];
  if (p.filmHalation > 0) {
    const threshold = .18 * 2 ** p.filmHalationThreshold, source = new Float32Array(n);
    for (let i = 0; i < n; i++) source[i] = Math.max(0, luma(i) - threshold);
    const glow = filmBlur(source, width, height, 1, p.filmHalationRadius / 100 * height), tint = halationTint(p), k = p.filmHalation / 100 * .25;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] += k * glow[i] * tint[c];
  }
  if (p.filmBloom > 0) {
    const threshold = .18 * 2 ** p.filmBloomThreshold, source = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const y = luma(i), f = Math.max(0, y - threshold) / Math.max(y, 1e-4); for (let c = 0; c < 3; c++) source[i * 3 + c] = lin[i * 3 + c] * f; }
    const glow = filmBlur(source, width, height, 3, p.filmBloomRadius / 100 * height), warm = .3 * p.filmBloomWarmth / 100, tint = [1 + warm, 1, 1 - warm], k = p.filmBloom / 100 * .5;
    for (let i = 0; i < n * 3; i++) out[i] += k * glow[i] * tint[i % 3];
  }
  if (breath) { const gain = 2 ** breath; for (let i = 0; i < n * 3; i++) out[i] *= gain; }
  if (p.filmVignette) {
    const ax = 1 + (aspect - 1) * p.filmVignetteRoundness / 100, size = p.filmVignetteSize / 100, soft = Math.max(.01, p.filmVignetteSoftness / 100), norm = Math.sqrt(ax * ax + 1);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const d = Math.hypot(((x + .5) / width - .5) * 2 * ax, ((y + .5) / height - .5) * 2) / norm, gain = 2 ** (-2 * p.filmVignette / 100 * sse(size, size + soft, d));
      for (let c = 0; c < 3; c++) out[(y * width + x) * 3 + c] *= gain;
    }
  }
  const result = out.map(v => encodeLog(v, stage.gamma));
  // 9. Grain, on the encoded picture.
  if (p.filmGrain > 0) {
    const r = p.filmGrainResponse / 100, amp = .1 * p.filmGrain / 100, color = p.filmGrainColor / 100, fg = p.filmGrainStatic >= .5 ? 0 : frame, scale = 1080 / p.filmGrainSize / height;
    const keys = [0, 1, 2, 3].map(c => grainKey(p.filmGrainSeed, fg, c));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3, lx = (x + .5) * scale, ly = (y + .5) * scale, t = clamp(w[0] * result[i] + w[1] * result[i + 1] + w[2] * result[i + 2]), gain = amp * ((1 - r) + r * 4 * t * (1 - t)), mono = grainNoise(lx, ly, keys[3]);
      for (let c = 0; c < 3; c++) result[i + c] += gain * (color ? mono + (grainNoise(lx, ly, keys[c]) - mono) * color : mono);
    }
  }
  return result;
}
