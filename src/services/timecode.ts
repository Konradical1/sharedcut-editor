/** Non-drop timecode: fractional playback rates still have integer frame labels. */
export function timecode(seconds: number, fps = 24) {
  const rate=Number.isFinite(fps)&&fps>0?fps:24, nominal=Math.max(1,Math.round(rate));
  const frames=Math.max(0,Math.floor((Number.isFinite(seconds)?seconds:0)*rate+1e-7));
  return [Math.floor(frames/nominal/3600),Math.floor(frames/nominal/60)%60,Math.floor(frames/nominal)%60,frames%nominal].map(n=>String(n).padStart(2,'0')).join(':');
}

/** Give entrance and exit equal scrub space without changing timeline timing. */
export function previewTime(progress: number, duration: number, entrance: number, exit: number) {
  const p = Math.max(0, Math.min(1, progress));
  if (entrance + exit >= duration) return p * duration;
  return p < .4 ? p / .4 * entrance : p > .6 ? duration - exit + (p - .6) / .4 * exit : entrance + (p - .4) / .2 * (duration - entrance - exit);
}
