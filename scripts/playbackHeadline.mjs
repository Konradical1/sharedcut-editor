// The numbers that judge a playback pass, as the remote playback check prints them.
// Realtime factor is timeline seconds played per wall second: 1.00 is smooth, 0.80 means a 30 s pass reached 24 s.
// picturesPerSec comes last on purpose: it counts distinct footage pictures, which a slowed or frozen clip lowers by design.

/** Timeline seconds played per wall second, 0 when the pass has no wall time. */
export function realtimeFactor(pass) {
  return pass.wallSeconds > 0 ? Math.max(0, pass.advancedSeconds) / pass.wallSeconds : 0;
}

/** One line per pass: realtime factor, painted pictures per second, share of time loading, longest single wait. */
export function headline(pass) {
  return `pass ${pass.pass}: realtime ${realtimeFactor(pass).toFixed(2)} (${pass.advancedSeconds}s of ${pass.wallSeconds}s) | rendered ${pass.renderedPerSec}/s | loading ${pass.loadingPct}% | longest wait ${pass.longestLoadingMs} ms | pictures ${pass.picturesPerSec}/s`;
}
