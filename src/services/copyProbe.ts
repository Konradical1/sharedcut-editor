/**
 * Measurement only, no behaviour: how long the raw-plane copies behind the colour preview took, how many a draw had to start
 * itself (nothing prepared the frame earlier) and how many draws found their copy unfinished. A playback check reads it.
 */
export type CopyProbeReading = { copies: number; demandCopies: number; waits: number; demandWaits: number; copyMsP50: number; copyMsP95: number; copyMsMax: number };

const KEEP = 2000;
const percentile = (sorted: number[], share: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] : 0);

export function createCopyProbe() {
  let durations: number[] = [], copies = 0, demandCopies = 0, waits = 0, demandWaits = 0;
  return {
    /** A copy finished `ms` after it was asked for; `demand` when a draw asked for it rather than an earlier prepare. */
    copied(ms: number, demand: boolean) { copies++; if (demand) demandCopies++; durations.push(ms); if (durations.length > KEEP) durations.shift(); },
    /** A draw found its frame's copy unfinished. */
    waited(demand: boolean) { waits++; if (demand) demandWaits++; },
    /** The totals since the last reset; `reset` starts a new count. */
    read(reset = false): CopyProbeReading {
      const sorted = [...durations].sort((a, b) => a - b);
      const reading = { copies, demandCopies, waits, demandWaits, copyMsP50: Math.round(percentile(sorted, .5)), copyMsP95: Math.round(percentile(sorted, .95)), copyMsMax: Math.round(sorted.at(-1) ?? 0) };
      if (reset) { durations = []; copies = demandCopies = waits = demandWaits = 0; }
      return reading;
    },
  };
}
