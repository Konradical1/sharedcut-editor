/** Peak aggregation retains transients when many stored samples share a screen bar. */
export function waveformBars(samples: number[], bars: number, from = 0, to = 1, reverse = false): number[] {
  bars = Math.max(1, Math.min(8192, Math.floor(bars)));
  let peak = 0;
  for (const value of samples) if (Number.isFinite(value)) peak = Math.max(peak, value);
  if (peak < 1e-7) return Array(bars).fill(0);
  const result: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const a = (from + (to - from) * bar / bars) * samples.length, b = (from + (to - from) * (bar + 1) / bars) * samples.length;
    let value = 0;
    for (let i = Math.max(0, Math.floor(a)); i < Math.min(samples.length, Math.max(Math.floor(a) + 1, Math.ceil(b))); i++) if (Number.isFinite(samples[i])) value = Math.max(value, samples[i]);
    // Display normalization only; preserve silence and never alter playback gain.
    result.push(Math.sqrt(Math.max(0, value) / peak));
  }
  return reverse ? result.reverse() : result;
}
