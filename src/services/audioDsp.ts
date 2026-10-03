/** A biquad as [b0, b1, b2, a1, a2], normalized so a0 = 1. */
export type Biquad = [number, number, number, number, number];

/** ITU-R BS.1770 K-weighting at any sample rate: the shelving pre-filter, then the RLB high-pass. These are libebur128's
 *  analog parameters, which reproduce the standard's 48 kHz coefficients exactly. */
export function kWeighting(rate: number): Biquad[] {
  let K = Math.tan(Math.PI * 1681.974450955533 / rate), Q = .7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** .4996667741545416, a0 = 1 + K / Q + K * K;
  const shelf: Biquad = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan(Math.PI * 38.13547087602444 / rate); Q = .5003270373238773;
  const d = 1 + K / Q + K * K;
  return [shelf, [1, -2, 1, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d]];
}

/** The EQ effect (RBJ cookbook): a Q 0.707 high-pass at Low cut, a Q 1 peak at 3 kHz and a slope-1 shelf at 10 kHz.
 *  The export runs these exact coefficients through FFmpeg's biquad filter, the preview through IIRFilterNodes. */
export function eqBiquads(lowCut: number, presence: number, air: number, rate: number): Biquad[] {
  const norm = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad => [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  const w = (f: number, q: number) => { const w0 = 2 * Math.PI * f / rate; return { cos: Math.cos(w0), alpha: Math.sin(w0) / (2 * q) }; };
  const hp = w(lowCut, .707), peak = w(3000, 1), shelf = w(10000, Math.SQRT1_2);
  const P = 10 ** (presence / 40), A = 10 ** (air / 40), s = 2 * Math.sqrt(A) * shelf.alpha;
  return [
    norm((1 + hp.cos) / 2, -(1 + hp.cos), (1 + hp.cos) / 2, 1 + hp.alpha, -2 * hp.cos, 1 - hp.alpha),
    norm(1 + peak.alpha * P, -2 * peak.cos, 1 - peak.alpha * P, 1 + peak.alpha / P, -2 * peak.cos, 1 - peak.alpha / P),
    norm(A * ((A + 1) + (A - 1) * shelf.cos + s), -2 * A * ((A - 1) + (A + 1) * shelf.cos), A * ((A + 1) + (A - 1) * shelf.cos - s), (A + 1) - (A - 1) * shelf.cos + s, 2 * ((A - 1) - (A + 1) * shelf.cos), (A + 1) - (A - 1) * shelf.cos - s),
  ];
}

/** Gain in dB of a biquad cascade at `frequency`. */
export function responseDb(filters: Biquad[], frequency: number, rate: number) {
  const w = 2 * Math.PI * frequency / rate, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  return filters.reduce((db, [b0, b1, b2, a1, a2]) => {
    const nr = b0 + b1 * c1 + b2 * c2, ni = b1 * s1 + b2 * s2, dr = 1 + a1 * c1 + a2 * c2, di = a1 * s1 + a2 * s2;
    return db + 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }, 0);
}

/**
 * Ungated BS.1770 loudness over the last 400 ms (momentary) and 3 s (short-term), plus the sample peak over 3 s, of
 * K-weighted audio fed in chunks: `energy` is Σx² over every channel of the chunk, `samples` its length per channel.
 */
export function loudnessWindow(rate: number) {
  let chunks: { energy: number; samples: number; peak: number }[] = [];
  const lufs = (seconds: number) => {
    let energy = 0, samples = 0;
    for (let i = chunks.length - 1; i >= 0 && samples < seconds * rate; i--) {
      const take = Math.min(chunks[i].samples, seconds * rate - samples);
      energy += chunks[i].energy * take / chunks[i].samples; samples += take;
    }
    return samples && energy ? -.691 + 10 * Math.log10(energy / samples) : -Infinity;
  };
  return {
    push(energy: number, samples: number, peak = 0) {
      if (samples <= 0) return;
      chunks.push({ energy, samples, peak });
      let kept = 0;
      for (let i = chunks.length - 1; i >= 0; i--) if ((kept += chunks[i].samples) > 3 * rate) { chunks = chunks.slice(i); break; }
    },
    read: () => ({ momentary: lufs(.4), shortTerm: lufs(3), peak: chunks.reduce((max, chunk) => Math.max(max, chunk.peak), 0) }),
    reset() { chunks = []; },
  };
}
