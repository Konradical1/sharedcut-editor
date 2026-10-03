// Depth analysis: the contract shared by server/depth.ts, scripts/depth.py and the editor.
// A run covers a range of source frames of one original; its depth lives in 64-frame segments.
import { smartMaskFrame, type DepthKeyBinding } from './smartMask.ts';

export const DEPTH_SEGMENT = 64;
/** Frames analysed per run at most: ten minutes at 60 fps, about 1 GB of segments. */
export const DEPTH_MAX_FRAMES = 36_000;
/** Seconds of source analysed beyond each end of the clip, so trims and slips keep their depth. */
export const DEPTH_HANDLE = 1;
/** Container rate of preview segments. Frame i of a segment has presentation time i / DEPTH_SEGMENT_RATE. */
export const DEPTH_SEGMENT_RATE = 30;
export type DepthSegment = { n: number; first: number; count: number }; // first = source frame index of the segment's first frame
export type DepthRun = {
  key: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'; progress: number; error?: string;
  mediaId: string; first: number; frames: number;       // analysed source frames [first, first + frames)
  times: number[];                                      // presentation time (source seconds, zero-based like smartMask sourceTimes) of each analysed frame; only in a response without ?after (or after=0)
  width: number; height: number;                        // analysis size (preview and master frames)
  lo: number; hi: number;                               // stored value v = clamp((disparity - lo) / (hi - lo), 0, 1); valid once segments arrive
  near: number; far: number;                            // stored values where distance 0 and 100 sit (first-window p99 and p1)
  segments: DepthSegment[];                             // with ?after=n only the new ones
  next: number;                                         // cursor for ?after
  telemetry?: DepthTelemetry;                           // the worker's last line, once it finished
};
/** Frames per second end to end and of the analysis alone (model loading left out), and the CUDA peak in GB. */
export type DepthTelemetry = { frames: number; seconds: number; fps: number; analysisFps: number; engine?: string; device?: string; peakVram?: number; reservedVram?: number; microBatch?: number };
export type DepthCapabilities = { available: boolean; reason?: string; engine?: string; device?: string };

/** Video Depth Anything's input size: short side 518, both sides multiples of 14, narrower beyond 16:9 to bound memory. */
export function depthAnalysisSize(width: number, height: number) {
  if (!(width > 0 && height > 0)) throw new Error('Invalid source size.');
  const short = Math.min(width, height), long = Math.max(width, height), ratio = long / short;
  const side = ratio > 1.78 ? Math.round(518 * 1.777 / ratio / 14) * 14 : 518;
  const across = Math.max(14, Math.round(long * side / short / 14) * 14);
  return width >= height ? { width: across, height: side } : { width: side, height: across };
}

/** Source frames a clip reading `from`..`to` (source seconds) needs: plus handles, snapped to the segment grid, clamped to the source. */
export function depthRange(times: number[], from: number, to: number) {
  if (!times.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('The clip reads no source frames.');
  const source = { fps: 1, duration: 0 };
  const first = smartMaskFrame(Math.max(0, from - DEPTH_HANDLE), source, times);
  // The frame showing just before `to + handle` is the last one read.
  const last = smartMaskFrame(Math.max(from, to + DEPTH_HANDLE - 1e-6), source, times);
  const start = Math.floor(first / DEPTH_SEGMENT) * DEPTH_SEGMENT;
  const end = Math.min(times.length, Math.ceil((last + 1) / DEPTH_SEGMENT) * DEPTH_SEGMENT);
  return { first: start, frames: end - start };
}

/** Source frame index showing at a source time (seconds, zero-based), from the run's own times; -1 outside the run. */
export function depthFrameAt(run: Pick<DepthRun, 'first' | 'frames' | 'times'>, time: number) {
  const { times } = run;
  if (!times.length || times.length !== run.frames || !Number.isFinite(time) || time < times[0] - 1e-7) return -1;
  const index = smartMaskFrame(time, { fps: 1, duration: 0 }, times), last = times.length - 1;
  // The last frame shows for one more frame interval, not forever (an image's single frame does).
  if (index === last && last > 0 && time >= 2 * times[last] - times[last - 1] - 1e-7) return -1;
  return run.first + index;
}

/** The segment holding source frame `frame`, and the frame's position inside it; undefined until it is recorded. */
export function depthSegmentFor(run: Pick<DepthRun, 'first' | 'frames'> & { segments: DepthSegment[] }, frame: number) {
  if (!Number.isSafeInteger(frame) || frame < run.first || frame >= run.first + run.frames) return;
  const n = Math.floor((frame - run.first) / DEPTH_SEGMENT), segment = run.segments.find(item => item.n === n);
  return segment && frame - segment.first < segment.count ? { segment, offset: frame - segment.first } : undefined;
}

/** Distance 0 (nearest) to 100 (farthest) for a stored value 0..1, in the run's fixed mapping; clamped. */
export function depthDistance(run: Pick<DepthRun, 'near' | 'far'>, value: number) {
  const span = run.near - run.far;
  return span > 0 ? Math.max(0, Math.min(100, (run.near - value) / span * 100)) : 0;
}

/** The stored value at a distance; the inverse of depthDistance. */
export function depthValue(run: Pick<DepthRun, 'near' | 'far'>, distance: number) {
  return run.near - Math.max(0, Math.min(100, distance)) / 100 * (run.near - run.far);
}

/** Depth key alpha (0..1) at a distance 0 (nearest)..100 (farthest): 1 inside [near, far], easing to 0 over `softness`
 *  beyond each end, so near 0 and far 100 key everything. */
export function depthKeyAlpha(key: Pick<DepthKeyBinding, 'near' | 'far' | 'softness'>, distance: number) {
  const soft = Math.max(key.softness, 1e-4), step = (edge: number) => { const t = Math.max(0, Math.min(1, (distance - edge) / soft)); return t * t * (3 - 2 * t); };
  return step(key.near - soft) * (1 - step(key.far));
}

/** The key for every stored depth code 0..levels-1 (v = code / (levels - 1)), distance as in depth-fx-math.md section 0:
 *  256 levels for the 8-bit preview frames, 1024 for the 10-bit export masters. Preview and export share this table. */
export function depthKeyTable(run: Pick<DepthRun, 'near' | 'far'>, key: Pick<DepthKeyBinding, 'near' | 'far' | 'softness'>, levels: number) {
  const span = Math.max(run.near - run.far, 1e-4);
  return Float32Array.from({ length: levels }, (_, code) => depthKeyAlpha(key, Math.max(0, Math.min(1, (run.near - code / (levels - 1)) / span)) * 100));
}

/** Ready-made looks. Each is applied over the Depth defaults as one undoable edit; Focus stays the clip's own. */
export const depthPresets: { name: string; description: string; values: Record<string, number> }[] = [
  { name: 'Portrait', description: 'Shallow focus with soft bokeh; the background a touch darker.', values: { blur: 55, range: 12, nearBlur: 70, bokeh: 50, light: 35, lightStart: 40, lightSoftness: 30, bgExposure: -.3, bgSaturation: 90, bgContrast: 95 } },
  { name: 'Cinematic haze', description: 'Warm air in the distance, gentle defocus and a glow on far highlights.', values: { blur: 20, range: 25, nearBlur: 40, fog: 45, fogStart: 30, fogDensity: 35, fogHue: 35, fogSaturation: 18, fogBrightness: 80, fogHorizon: 40, glow: 25, glowThreshold: 75, glowRadius: 40, glowStart: 45 } },
  { name: 'Morning mist', description: 'Cool, dense mist that swallows the background; nothing defocused.', values: { fog: 75, fogStart: 25, fogDensity: 60, fogHue: 205, fogSaturation: 8, fogBrightness: 92, fogHorizon: 60, light: 30, lightStart: 35, lightSoftness: 40, bgExposure: .2, bgSaturation: 80, bgWarmth: -20, bgContrast: 80 } },
  { name: 'Dreamy glow', description: 'A soft background bloom with bright bokeh and a faint rose haze.', values: { blur: 25, range: 20, nearBlur: 50, bokeh: 70, glow: 60, glowThreshold: 55, glowRadius: 55, glowStart: 30, fog: 20, fogStart: 40, fogDensity: 30, fogHue: 330, fogSaturation: 10, fogBrightness: 95, fogHorizon: 20 } },
  { name: 'Subject pop', description: 'Background darker and cooler with a slight blur, so the subject stands out.', values: { blur: 15, range: 15, nearBlur: 50, bokeh: 30, light: 70, lightStart: 30, lightSoftness: 25, bgExposure: -.8, bgSaturation: 75, bgWarmth: -35, bgContrast: 90 } },
  // Light from distance 0 grades all but the very nearest objects (it is 0 at distance 0); a softness of 15 fades it in
  // over the nearest 15 % instead of drawing a hard edge there.
  { name: 'Miniature', description: 'Tilt-shift: a thin slice in focus, everything nearer and farther blurred, colours like a toy.', values: { blur: 70, range: 6, nearBlur: 100, bokeh: 20, light: 40, lightStart: 0, lightSoftness: 15, bgExposure: .15, bgSaturation: 140, bgContrast: 120 } },
];

/** Focus follows subject: one distance (0..100) per analysed frame, measured once on the server from the depth masters
 *  and the subject's mattes. `values` is empty when the subject was never found; frames before its first or after its
 *  last measurement hold the nearest one. Bump DEPTH_FOCUS_VERSION whenever the measurement or smoothing changes. */
export const DEPTH_FOCUS_VERSION = 1;
/** Seconds the centred moving average spans: long enough that focus does not hunt, short enough to keep a rack. */
export const DEPTH_FOCUS_SMOOTHING = .3;
export type DepthFocusTrack = { status: 'ready'; key: string; first: number; frames: number; measured: number; values: number[] };

/** Median stored value (0..1) of the depth samples whose matte is over half (> 127 of 255); null when fewer than 16 are. */
export function matteMedian(depth: Uint16Array, matte: Uint8Array, scale = 1023) {
  const histogram = new Uint32Array(scale + 1);
  let count = 0;
  for (let i = 0; i < depth.length; i++) if (matte[i] > 127) { histogram[Math.min(scale, depth[i])]++; count++; }
  if (count < 16) return null;
  for (let v = 0, seen = 0; v <= scale; v++) if ((seen += histogram[v]) * 2 >= count) return v / scale;
  return null;
}

/** Gaps (null) filled by straight lines between measurements and held at the ends, then a centred moving average over
 *  about DEPTH_FOCUS_SMOOTHING seconds: zero phase, so focus lands on the subject when it gets there, not after. */
export function smoothFocus(raw: (number | null)[], fps: number) {
  const known = raw.flatMap((value, i) => value === null ? [] : [i]);
  if (!known.length) return [];
  let next = 0;
  const filled = raw.map((value, i) => {
    if (value !== null) { next++; return value; }
    if (next === 0 || next === known.length) return raw[known[Math.min(next, known.length - 1)]]!;
    const a = known[next - 1], b = known[next];
    return raw[a]! + (raw[b]! - raw[a]!) * (i - a) / (b - a);
  });
  const half = Math.max(0, Math.round(DEPTH_FOCUS_SMOOTHING * (Number.isFinite(fps) && fps > 0 ? fps : 30) / 2));
  const sums = [0];
  for (const value of filled) sums.push(sums[sums.length - 1] + value);
  return filled.map((_, i) => { const from = Math.max(0, i - half), to = Math.min(filled.length, i + half + 1); return Math.round((sums[to] - sums[from]) / (to - from) * 100) / 100; });
}

/** The track's focus at source frame `frame` (held at the ends); undefined when the subject was never found. */
export function depthFocusAt(track: Pick<DepthFocusTrack, 'first' | 'values'>, frame: number) {
  return track.values.length ? track.values[Math.max(0, Math.min(track.values.length - 1, Math.round(frame) - track.first))] : undefined;
}
