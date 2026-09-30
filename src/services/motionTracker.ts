import type { Clip, Keyframe, MediaAsset } from '../state/models.ts';
import { animatedSourceOffset, boundedAnimationValue, evaluateClip, sampleKeyframes } from './animation.ts';
import { getShape, isShape } from './shapes.ts';

/**
 * Motion tracking: a point followed through a video clip's source frames, and the arithmetic that turns it into
 * keyframes on another layer ("attach") or on the clip itself ("camera follow").
 *
 * A tracker document lives on the video clip and holds only intent: the boxes, the settings and the points the
 * editor placed by hand. The per-frame samples an analysis produces are content-addressed files on the server
 * (`result.key`), like Smart Mask mattes, so a correction never copies a whole track into the edit history.
 * Positions are normalized to the source picture (0 = left/top edge, 1 = right/bottom edge) and times are source
 * seconds, so a track survives trims, speed changes and proxy swaps.
 */

export type MotionTrackerModel = 'position' | 'similarity';
export type MotionTrackerSource = { mediaId: string; fps: number; width: number; height: number; duration: number };
/** A point the editor placed or corrected by hand. It wins over the analysis on its frame and fences re-tracking. */
export type MotionTrackerKey = { time: number; x: number; y: number };
export type MotionTrackerLayerOptions = { scale: boolean; rotation: boolean; smoothing: number; offsetX: number; offsetY: number };
export type MotionTrackerCameraOptions = { framing: 'keep' | 'center'; smoothing: number; zoom: 'dynamic' | 'steady' | 'off'; minZoom: number; maxZoom: number; rotation: boolean; offsetX: number; offsetY: number };
/** A layer this track drives. `time` is the tracked clip's source time on the frame the layer was attached at, and
 *  `base` the layer's transform there, so an improved track can be applied again without the layer drifting from where
 *  the editor put it, even after the clips have been moved or trimmed. */
export type MotionTrackerLink = { clipId: string; target: 'layer' | 'camera'; time: number; base: { x: number; y: number; zoom: number; rotation: number }; layer?: MotionTrackerLayerOptions; camera?: MotionTrackerCameraOptions };
export type MotionTracker = {
  version: 1; id: string; name: string; color: string; source: MotionTrackerSource;
  /** Feature box (the pattern) and search box (where the next frame looks), as fractions of source width and height. */
  feature: { width: number; height: number }; search: { width: number; height: number };
  model: MotionTrackerModel; minConfidence: number; whenLost: 'search' | 'stop';
  keys: MotionTrackerKey[]; result?: { key: string }; links?: MotionTrackerLink[];
};
/** Analysis output, one entry per source frame, sorted by frame. Flags: 0 tracked, 2 filled across an occlusion. */
export type MotionTrackerSamples = { version: 1; mediaId: string; frames: number[]; times: number[]; x: number[]; y: number[]; confidence: number[]; scale: number[]; rotation: number[]; flags: number[] };
export type TrackPoint = { frame?: number; time: number; x: number; y: number; scale: number; rotation: number; confidence: number; flag: 0 | 1 | 2 };
export type SampleRow = TrackPoint & { frame: number };
export const FLAG_TRACKED = 0, FLAG_MANUAL = 1, FLAG_FILLED = 2;

export const MAX_TRACKERS = 16, MAX_KEYS = 5000, MAX_LINKS = 64, MAX_SAMPLES = 200_000;
export const trackerColors = ['#ffd24a', '#5ee0ff', '#ff7ad9', '#8dff6a', '#ff9f43', '#b18cff'];
export const defaultLayerOptions: MotionTrackerLayerOptions = { scale: false, rotation: false, smoothing: 0, offsetX: 0, offsetY: 0 };
// Follow locks the point by default: a smoothed camera path leaves handheld shake in, and the zoom magnifies it.
export const defaultCameraOptions: MotionTrackerCameraOptions = { framing: 'keep', smoothing: 0, zoom: 'dynamic', minZoom: 100, maxZoom: 400, rotation: false, offsetX: 0, offsetY: 0 };

const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const number = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function validateLayerOptions(value: unknown): asserts value is MotionTrackerLayerOptions {
  if (!object(value) || typeof value.scale !== 'boolean' || typeof value.rotation !== 'boolean' || !number(value.smoothing, 0, 60) || !number(value.offsetX, -100000, 100000) || !number(value.offsetY, -100000, 100000)) throw Error('Invalid tracker layer options.');
}
export function validateCameraOptions(value: unknown): asserts value is MotionTrackerCameraOptions {
  if (!object(value) || !['keep', 'center'].includes(String(value.framing)) || !number(value.smoothing, 0, 60) || !['dynamic', 'steady', 'off'].includes(String(value.zoom)) || !number(value.minZoom, 1, 800) || !number(value.maxZoom, 1, 800) || Number(value.maxZoom) < Number(value.minZoom) || typeof value.rotation !== 'boolean' || !number(value.offsetX, -100000, 100000) || !number(value.offsetY, -100000, 100000)) throw Error('Invalid camera follow options.');
}

export function validateMotionTracker(value: unknown): asserts value is MotionTracker {
  if (!object(value) || value.version !== 1 || !validId(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) throw Error('Invalid motion tracker.');
  const source = value.source;
  if (!object(source) || !validId(source.mediaId) || !number(source.fps, 1, 1200) || !number(source.duration, .001, 21600) || ![source.width, source.height].every(v => number(v, 1, 16384) && Number.isInteger(v))) throw Error('Invalid motion tracker source.');
  const box = (item: unknown, min: number) => object(item) && number(item.width, min, 1) && number(item.height, min, 1);
  if (!box(value.feature, .002) || !box(value.search, .004)) throw Error('Invalid motion tracker boxes.');
  // Search smaller than feature is allowed: two editors' merged edits can produce it, and the worker widens it itself.
  if (!['position', 'similarity'].includes(String(value.model)) || !number(value.minConfidence, .2, .98) || !['search', 'stop'].includes(String(value.whenLost))) throw Error('Invalid motion tracker settings.');
  if (!Array.isArray(value.keys) || value.keys.length > MAX_KEYS) throw Error('Too many tracking points.');
  let previous = -Infinity;
  for (const key of value.keys) {
    if (!object(key) || !number(key.time, 0, Number(source.duration)) || Number(key.time) <= previous || !number(key.x, -.5, 1.5) || !number(key.y, -.5, 1.5)) throw Error('Invalid tracking point.');
    previous = Number(key.time);
  }
  if (value.result !== undefined && (!object(value.result) || typeof value.result.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.result.key))) throw Error('Invalid motion tracker result.');
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > MAX_LINKS) throw Error('Too many linked layers.');
    const targets = new Set<string>();
    for (const link of value.links) {
      if (!object(link) || !validId(link.clipId) || targets.has(String(link.clipId)) || !['layer', 'camera'].includes(String(link.target)) || !number(link.time, -86400, 86400) || !object(link.base) || !['x', 'y', 'zoom', 'rotation'].every(k => number((link.base as Record<string, unknown>)[k], -100000, 100000))) throw Error('Invalid linked layer.');
      if (link.target === 'layer') validateLayerOptions(link.layer); else validateCameraOptions(link.camera);
      targets.add(String(link.clipId));
    }
  }
}

export function validateMotionTrackers(clip: Clip) {
  const trackers = clip.motionTrackers;
  if (trackers === undefined) return;
  if (!Array.isArray(trackers) || trackers.length > MAX_TRACKERS) throw Error('Too many motion trackers on a clip.');
  const ids = new Set<string>();
  for (const tracker of trackers) {
    validateMotionTracker(tracker);
    if (tracker.source.mediaId !== clip.mediaId || ids.has(tracker.id)) throw Error('Motion tracker source does not match its clip.');
    ids.add(tracker.id);
  }
}

export function validateMotionTrackerSamples(value: unknown): asserts value is MotionTrackerSamples {
  if (!object(value) || value.version !== 1 || !validId(value.mediaId) || !Array.isArray(value.frames) || value.frames.length > MAX_SAMPLES) throw Error('Invalid tracking samples.');
  const length = value.frames.length;
  for (const field of ['times', 'x', 'y', 'confidence', 'scale', 'rotation', 'flags'] as const) if (!Array.isArray(value[field]) || (value[field] as unknown[]).length !== length) throw Error('Invalid tracking samples.');
  const v = value as MotionTrackerSamples;
  for (let i = 0; i < length; i++) {
    if (!Number.isSafeInteger(v.frames[i]) || v.frames[i] < 0 || i && v.frames[i] <= v.frames[i - 1] || !number(v.times[i], 0, 21600) || i && v.times[i] <= v.times[i - 1] || !number(v.x[i], -2, 3) || !number(v.y[i], -2, 3) || !number(v.confidence[i], 0, 1) || !number(v.scale[i], .01, 100) || !number(v.rotation[i], -100000, 100000) || ![FLAG_TRACKED, FLAG_FILLED].includes(v.flags[i])) throw Error('Invalid tracking sample.');
  }
}

export const emptySamples = (mediaId: string): MotionTrackerSamples => ({ version: 1, mediaId, frames: [], times: [], x: [], y: [], confidence: [], scale: [], rotation: [], flags: [] });

/** Replace every sample in [from, to] (frame numbers, either order) with `rows`, keeping the rest. */
export function mergeSamples(base: MotionTrackerSamples, from: number, to: number, rows: SampleRow[]): MotionTrackerSamples {
  const low = Math.min(from, to), high = Math.max(from, to), merged = new Map<number, SampleRow>();
  base.frames.forEach((frame, i) => { if (frame < low || frame > high) merged.set(frame, { frame, time: base.times[i], x: base.x[i], y: base.y[i], confidence: base.confidence[i], scale: base.scale[i], rotation: base.rotation[i], flag: base.flags[i] as 0 | 2 }); });
  for (const row of rows) merged.set(row.frame, row);
  const ordered = [...merged.values()].sort((a, b) => a.frame - b.frame);
  return { version: 1, mediaId: base.mediaId, frames: ordered.map(r => r.frame), times: ordered.map(r => r.time), x: ordered.map(r => r.x), y: ordered.map(r => r.y), confidence: ordered.map(r => r.confidence), scale: ordered.map(r => r.scale), rotation: ordered.map(r => r.rotation), flags: ordered.map(r => r.flag) };
}

function insertionIndex(points: { time: number }[], time: number) {
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle].time < time) low = middle + 1; else high = middle; }
  return low;
}
function nearestIndex(points: { time: number }[], time: number) {
  if (!points.length) return -1;
  const index = insertionIndex(points, time);
  if (index === 0) return 0;
  if (index === points.length) return points.length - 1;
  return time - points[index - 1].time <= points[index].time - time ? index - 1 : index;
}

/** The track as the editor sees it: analysis samples with the hand-placed points laid over their frames.
 *  A hand point borrows scale and rotation from the analysis nearest to it, since only position is placed. */
export function trackerPath(tracker: Pick<MotionTracker, 'keys' | 'source'>, samples?: MotionTrackerSamples): TrackPoint[] {
  const half = .5 / tracker.source.fps, points: TrackPoint[] = [];
  if (samples) for (let i = 0; i < samples.frames.length; i++) points.push({ frame: samples.frames[i], time: samples.times[i], x: samples.x[i], y: samples.y[i], scale: samples.scale[i], rotation: samples.rotation[i], confidence: samples.confidence[i], flag: samples.flags[i] as 0 | 2 });
  for (const key of tracker.keys) {
    const index = nearestIndex(points, key.time), near = index >= 0 ? points[index] : undefined, same = !!near && Math.abs(near.time - key.time) < half;
    const manual: TrackPoint = { frame: same ? near!.frame : undefined, time: key.time, x: key.x, y: key.y, scale: near?.scale ?? 1, rotation: near?.rotation ?? 0, confidence: 1, flag: FLAG_MANUAL };
    if (same) points[index] = manual;
    else points.splice(insertionIndex(points, key.time), 0, manual);
  }
  return points;
}

/** The sample on the frame showing at `time` (the latest frame starting at or before it), or undefined off the track. */
export function pointOnFrame(path: TrackPoint[], time: number, fps: number): TrackPoint | undefined {
  const index = insertionIndex(path, time + 1e-6) - 1;
  if (index < 0) return undefined;
  const point = path[index];
  // A gap in the analysis is not the previous frame held; the point is simply unknown there.
  return time - point.time < 1 / fps - 1e-6 ? point : undefined;
}

/** Linear blend between the samples either side of `time`; used where the picture itself is interpolated. */
export function pointBetween(path: TrackPoint[], time: number, fps: number): TrackPoint | undefined {
  const index = insertionIndex(path, time);
  const after = path[index], before = path[index - 1];
  if (after && Math.abs(after.time - time) < 1e-6) return after;
  if (!before || !after || after.time - before.time > 1.5 / fps) return pointOnFrame(path, time, fps);
  const t = (time - before.time) / (after.time - before.time), mix = (a: number, b: number) => a + (b - a) * t;
  return { time, x: mix(before.x, after.x), y: mix(before.y, after.y), scale: mix(before.scale, after.scale), rotation: mix(before.rotation, after.rotation), confidence: Math.min(before.confidence, after.confidence), flag: before.flag === FLAG_MANUAL && after.flag === FLAG_MANUAL ? FLAG_MANUAL : before.flag === FLAG_FILLED || after.flag === FLAG_FILLED ? FLAG_FILLED : FLAG_TRACKED };
}

/** Index of the source frame showing at `time` in a presentation-time table: the last one starting at or before it. */
export function frameAt(times: number[], time: number) {
  let low = 0, high = times.length;
  while (low < high) { const middle = (low + high) >>> 1; if (times[middle] <= time + 1e-7) low = middle + 1; else high = middle; }
  return Math.max(0, Math.min(times.length - 1, low - 1));
}

/** First and last source frames the clip reads, in either direction of play. */
export function clipFrames(clip: Clip, asset: Pick<MediaAsset, 'fps' | 'duration'>, times: number[]) {
  const fps = asset.fps || 24, a = clipSourceTime(clip, clip.start, asset), b = clipSourceTime(clip, clip.start + Math.max(0, clip.duration - 1 / fps), asset);
  return { first: frameAt(times, Math.min(a, b)), last: frameAt(times, Math.max(a, b)) };
}

/** Source seconds the clip reads at timeline time `time`; the same mapping preview and Smart Mask use. */
export function clipSourceTime(clip: Clip, time: number, asset: Pick<MediaAsset, 'fps' | 'duration'>) {
  const fps = asset.fps || 24;
  return clamp(clip.sourceIn + animatedSourceOffset(clip, Math.max(0, time - clip.start), fps), 0, Math.max(0, asset.duration - 1 / fps));
}

/** Local playback rate at `time`, signed: negative while reversed, zero while frozen. */
function playbackRate(clip: Clip, time: number) {
  const local = Math.max(0, time - clip.start), value = (name: string) => { const keys = clip.keyframes?.[`properties.${name}`]; return keys?.length ? boundedAnimationValue(`properties.${name}`, sampleKeyframes(keys, local)) : clip.properties[name]; };
  return value('freeze') ? 0 : (value('reverse') ? -1 : 1) * Math.max(.01, Number(value('speed') ?? 100) / 100);
}

/**
 * Source time to look a picture up at, for the timeline frame at `time` whose source time is `source`. The export
 * seeks to the clip's in point, keeps the first source frame at or after it and counts time from that frame; then it
 * resamples to the timeline rate by taking, for each output frame, the latest source frame that starts less than half
 * an output frame after it (FFmpeg's fps filter). So the picture delivered is the one showing that lead plus half an
 * output frame (in source time) after `source`: with equal rates and an in point on a frame exactly the frame at
 * `source`, with a 59.94 fps source on a 30 fps timeline the frame just after it. Frozen and reversed clips read
 * `source` itself.
 */
export function shownSourceTime(clip: Clip, time: number, source: number, timelineFps: number, sourceFps: number) {
  const rate = playbackRate(clip, time);
  if (rate <= 0) return source;
  const lead = sourceFps > 0 ? Math.max(0, Math.ceil(clip.sourceIn * sourceFps - 1e-6) / sourceFps - clip.sourceIn) : 0;
  return source + lead + .5 * rate / timelineFps - 1e-6;
}

/** Source second the paused timeline shows at `playhead`: the frame export delivers there, as the program viewer draws it. */
export function pictureTimeAt(clip: Clip, asset: Pick<MediaAsset, 'fps' | 'duration'>, playhead: number, timelineFps: number) {
  const fps = asset.fps || timelineFps, target = clipSourceTime(clip, playhead, asset);
  return Math.max(target, Math.min(asset.duration - 1 / fps, shownSourceTime(clip, playhead, target, timelineFps, fps)));
}

/**
 * The timeline frame whose paused picture is the source frame starting at `time`, so leaving a frame editor keeps the
 * program on the frame that was edited. Where no timeline frame shows it (a 59.94p source on a 30p timeline shows every
 * other frame) the nearest one that shows a neighbour; undefined when the clip never gets near it.
 */
export function playheadShowing(clip: Clip, asset: Pick<MediaAsset, 'fps' | 'duration'>, time: number, timelineFps: number) {
  const sourceFps = asset.fps || timelineFps, p = clip.properties;
  const first = Math.ceil(clip.start * timelineFps - 1e-6), last = Math.ceil((clip.start + clip.duration) * timelineFps - 1e-6) - 1;
  const straight = !p.reverse && !p.freeze && !Object.keys(clip.keyframes ?? {}).some(path => ['properties.speed', 'properties.reverse', 'properties.freeze'].includes(path));
  // Played straight through, the frame sits where the rate puts it; reversed, frozen or ramped, every frame is looked at.
  const guess = straight ? Math.round((clip.start + (time - clip.sourceIn) / Math.max(.01, Number(p.speed ?? 100) / 100)) * timelineFps) : undefined;
  let nearest: number | undefined, gap = Infinity;
  for (let n = guess === undefined ? first : Math.max(first, guess - 3); n <= (guess === undefined ? last : Math.min(last, guess + 3)); n++) {
    const shown = pictureTimeAt(clip, asset, n / timelineFps, timelineFps);
    if (shown >= time - 1e-6 && shown < time + 1 / sourceFps - 1e-6) return n / timelineFps;
    if (Math.abs(shown - time) < gap) { gap = Math.abs(shown - time); nearest = n / timelineFps; }
  }
  return gap < 1.5 / sourceFps ? nearest : undefined;
}

/** The track at timeline time `time` of `clip`, on the source frame the export shows there (`shownSourceTime`).
 *  Optical flow draws in-between pictures, so there the track is blended between frames instead. */
export function trackAtTimeline(path: TrackPoint[], clip: Clip, asset: Pick<MediaAsset, 'fps' | 'duration'>, time: number, timelineFps: number): TrackPoint | undefined {
  const fps = asset.fps || 24, source = clipSourceTime(clip, time, asset);
  if (clip.properties.opticalFlow) return pointBetween(path, source, fps);
  const shown = shownSourceTime(clip, time, source, timelineFps, fps);
  if (shown === source) return pointOnFrame(path, source, fps);
  const index = insertionIndex(path, shown) - 1;
  if (index < 0) return undefined;
  const point = path[index];
  return source - point.time < 1 / fps + 1e-6 ? point : pointOnFrame(path, source, fps);
}

export type Size = readonly [number, number];
export type Vec = { x: number; y: number };
/** 2×3 row-major warp in source pixels (Stabilize), applied to the point before the clip's own transform. */
export type SourceWarp = (sourceTime: number) => number[] | undefined;

/** Where normalized source point (u, v) lands on the project canvas before the clip's transform: contain-fitted
 *  and centred, the same letterbox playback and export draw with. */
export function fittedPoint(u: number, v: number, source: Size, project: Size): Vec {
  const fit = Math.min(project[0] / source[0], project[1] / source[1]);
  return { x: (project[0] - source[0] * fit) / 2 + u * source[0] * fit, y: (project[1] - source[1] * fit) / 2 + v * source[1] * fit };
}
export function fittedRect(source: Size, project: Size) {
  const fit = Math.min(project[0] / source[0], project[1] / source[1]), width = source[0] * fit, height = source[1] * fit;
  return { left: (project[0] - width) / 2, top: (project[1] - height) / 2, right: (project[0] + width) / 2, bottom: (project[1] + height) / 2 };
}

/** The point every layer transform pivots on, relative to the canvas centre: the anchor, plus a shape's own centre. */
export function pivotOffset(clip: Clip, project: Size): Vec {
  const shape = isShape(clip) ? getShape(clip) : undefined;
  return { x: Number(clip.properties.anchorX ?? 0) + (shape ? (shape.x + shape.width / 2 - .5) * project[0] : 0), y: Number(clip.properties.anchorY ?? 0) + (shape ? (shape.y + shape.height / 2 - .5) * project[1] : 0) };
}

/** Layer point `layer` (project pixels, before the transform) on the canvas: C + position + A + zoom·R·(layer − C − A),
 *  exactly the pose playback (motionBlur.transformMotion) and export (media.ts overlay placement) apply. `clip` must
 *  already be evaluated at the time in question. */
export function poseLayerPoint(clip: Clip, layer: Vec, project: Size): Vec {
  const p = clip.properties, pivot = pivotOffset(clip, project), zoom = Number(p.zoom ?? 100) / 100, angle = Number(p.rotation ?? 0) * Math.PI / 180;
  const cx = project[0] / 2 + pivot.x, cy = project[1] / 2 + pivot.y, dx = layer.x - cx, dy = layer.y - cy;
  return { x: cx + Number(p.x ?? 0) + zoom * (Math.cos(angle) * dx - Math.sin(angle) * dy), y: cy + Number(p.y ?? 0) + zoom * (Math.sin(angle) * dx + Math.cos(angle) * dy) };
}

/** Source point of a tracked clip in project pixels on the fitted canvas, with Stabilize's warp when it has one. */
export function sourceToLayer(point: Pick<TrackPoint, 'x' | 'y' | 'time'>, source: Size, project: Size, warp?: SourceWarp): Vec {
  let u = point.x, v = point.y;
  const matrix = warp?.(point.time);
  if (matrix) { const px = u * source[0], py = v * source[1]; u = (matrix[0] * px + matrix[1] * py + matrix[2]) / source[0]; v = (matrix[3] * px + matrix[4] * py + matrix[5]) / source[1]; }
  return fittedPoint(u, v, source, project);
}

/** Where the tracked point is on the program picture at timeline time `time`, or undefined off the track. */
export function trackOnCanvas(path: TrackPoint[], clip: Clip, asset: Pick<MediaAsset, 'fps' | 'duration'>, source: Size, project: Size, time: number, timelineFps: number, warp?: SourceWarp) {
  const point = trackAtTimeline(path, clip, asset, time, timelineFps);
  if (!point) return undefined;
  return { point, canvas: poseLayerPoint(evaluateClip(clip, time, timelineFps), sourceToLayer(point, source, project, warp), project) };
}

/** Gaussian smoothing over consecutive frames; `sigma` in frames, 0 leaves the values alone. */
export function smoothSeries(values: number[], sigma: number) {
  if (sigma <= .01 || values.length < 3) return values.slice();
  const radius = Math.ceil(sigma * 3), weights = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-.5 * ((i - radius) / sigma) ** 2));
  return values.map((_, index) => {
    let total = 0, weight = 0;
    for (let k = -radius; k <= radius; k++) { const i = clamp(index + k, 0, values.length - 1); total += values[i] * weights[k + radius]; weight += weights[k + radius]; }
    return total / weight;
  });
}

/** A curve that never dips under `required` yet only glides: each need is held `hold` frames either side, then
 *  blurred over `sigma`, twice; the final max() only has float residue left to add. */
export function envelope(required: number[], hold: number, sigma: number) {
  let curve = required.slice();
  for (let pass = 0; pass < 2; pass++) {
    const held = curve.map((_, i) => { let peak = -Infinity; for (let k = Math.max(0, i - hold); k <= Math.min(curve.length - 1, i + hold); k++) peak = Math.max(peak, curve[k]); return peak; });
    curve = smoothSeries(held, sigma).map((value, i) => Math.max(value, required[i]));
  }
  return curve;
}

/** Ramer–Douglas–Peucker on (time, value): the fewest linear keyframes that stay within `tolerance` of every frame. */
export function simplify(times: number[], values: number[], tolerance: number): number[] {
  if (times.length <= 2) return times.map((_, i) => i);
  const keep = new Uint8Array(times.length); keep[0] = keep[times.length - 1] = 1;
  const stack: [number, number][] = [[0, times.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = -1, index = -1;
    for (let i = first + 1; i < last; i++) {
      const t = (times[i] - times[first]) / (times[last] - times[first]), error = Math.abs(values[first] + (values[last] - values[first]) * t - values[i]);
      if (error > worst) { worst = error; index = i; }
    }
    if (worst > tolerance) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  return [...keep.keys()].filter(i => keep[i]);
}

/** Timeline frames (seconds, on the project grid) where both clips are on screen. */
export function sharedFrames(a: Pick<Clip, 'start' | 'duration'>, b: Pick<Clip, 'start' | 'duration'>, fps: number) {
  const from = Math.max(a.start, b.start), to = Math.min(a.start + a.duration, b.start + b.duration), frames: number[] = [];
  for (let n = Math.ceil(from * fps - 1e-6); n / fps < to - 1e-6; n++) frames.push(n / fps);
  return frames;
}

export type ChannelKeys = Record<string, Keyframe[]>;
/** Largest error a thinned channel may make at any frame: a twentieth of a project pixel, a thousandth of a degree. */
const TOLERANCE: Record<string, number> = { 'properties.x': .05, 'properties.y': .05, 'properties.zoom': .005, 'properties.rotation': .005 };

/** Linear keyframes for the frames given, thinned to what the tolerance needs, merged into `existing`. Keys an earlier
 *  write with the same `prefix` left are replaced wherever they are (a shorter track leaves none behind), and so is
 *  any key inside the span; other keys stay, so an animation either side survives an attach. Key times are the
 *  frames' own, not snapped to a clip-local grid the clip's start may be off. */
export function writeChannel(existing: Keyframe[] | undefined, path: string, clip: Pick<Clip, 'start'>, times: number[], values: number[], prefix: string): Keyframe[] {
  if (!times.length) return existing ?? [];
  const local = times.map(t => Math.round((t - clip.start) * 1e6) / 1e6), from = local[0], to = local.at(-1)!;
  // Rotation keeps to ±180° (the channel allows ±360°, and a spinning subject passes that), with the same angle
  // on screen; the key before each wrap holds, so playback between those two frames never spins back round. The key
  // after it starts 10 µs early: a frame time a float step short of it must not still show the held angle.
  const turns = path === 'properties.rotation';
  const bounded = values.map(value => Number(boundedAnimationValue(path, turns ? value - 360 * Math.round(value / 360) : value)));
  const kept = simplify(local, bounded, TOLERANCE[path] ?? .001);
  const wraps = (n: number) => turns && n >= 0 && kept[n + 1] === kept[n] + 1 && Math.abs(bounded[kept[n + 1]] - bounded[kept[n]]) > 180;
  const written: Keyframe[] = kept.map((i, n) => ({ id: `${prefix}${n.toString(36)}`, time: wraps(n - 1) ? Math.round((local[i] - 1e-5) * 1e6) / 1e6 : local[i], value: Math.round(bounded[i] * 1e4) / 1e4, interpolation: wraps(n) ? 'hold' : 'linear' }));
  const others = (existing ?? []).filter(key => !key.id.startsWith(prefix) && (key.time < from - 1e-6 || key.time > to + 1e-6));
  return [...others, ...written].sort((a, b) => a.time - b.time);
}

export type ApplyContext = { tracked: Clip; asset: Pick<MediaAsset, 'fps' | 'duration'>; source: Size; project: Size; fps: number; path: TrackPoint[]; warp?: SourceWarp };

/** Frames of `frames` that have a track, with the tracked point on the fitted picture there. */
function trackedFrames(context: ApplyContext, frames: number[]) {
  const result: { time: number; point: TrackPoint; layer: Vec }[] = [];
  for (const time of frames) {
    const point = trackAtTimeline(context.path, context.tracked, context.asset, time, context.fps);
    if (point) result.push({ time, point, layer: sourceToLayer(point, context.source, context.project, context.warp) });
  }
  return result;
}

/** The timeline frame a layer is attached at: the one nearest `time` that has a track, among `frames`. */
export function attachFrame(context: ApplyContext, frames: number[], time: number) {
  const tracked = frames.filter(frame => trackAtTimeline(context.path, context.tracked, context.asset, frame, context.fps));
  return tracked.length ? tracked.reduce((best, frame) => Math.abs(frame - time) < Math.abs(best - time) ? frame : best) : undefined;
}

/** The tracked frame, among `frames`, that shows source time `source` of the tracked clip (or comes closest to it). */
export function anchorFrame(context: ApplyContext, frames: number[], source: number) {
  const distance = (frame: number) => Math.abs(clipSourceTime(context.tracked, frame, context.asset) - source);
  const tracked = frames.filter(frame => trackAtTimeline(context.path, context.tracked, context.asset, frame, context.fps));
  return tracked.length ? tracked.reduce((best, frame) => distance(frame) < distance(best) ? frame : best) : undefined;
}

/** Whether a link still means what it meant: its layer exists on the same timeline and overlaps the tracked clip, and a
 *  camera follow belongs to this very clip. A clip copied, split off or pasted keeps its trackers' links, which must not
 *  drive the original's layers or another clip's camera. */
export function linkApplies(tracked: Clip, link: MotionTrackerLink, clips: Pick<Clip, 'id' | 'timelineId' | 'start' | 'duration'>[]) {
  if (link.target === 'camera') return link.clipId === tracked.id;
  const target = clips.find(clip => clip.id === link.clipId);
  return !!target && target.id !== tracked.id && target.timelineId === tracked.timelineId && target.start < tracked.start + tracked.duration && target.start + target.duration > tracked.start;
}

const rotate = (v: Vec, degrees: number): Vec => { const a = degrees * Math.PI / 180; return { x: Math.cos(a) * v.x - Math.sin(a) * v.y, y: Math.sin(a) * v.x + Math.cos(a) * v.y }; };
const nearestFrame = <T extends { time: number }>(frames: T[], time: number) => frames.reduce((best, frame, index) => Math.abs(frame.time - time) < Math.abs(frames[best].time - time) ? index : best, 0);

/**
 * Attach `target` to the track. Every layer point P then follows P(t) = Q(t) + ΔR·Δs·(P(t₀) − Q(t₀)), where Q is the
 * tracked point on the canvas and t₀ the attach frame: the layer keeps exactly where the editor put it, moves with
 * the subject, and with the similarity model also turns and grows with it. Solving the pose for that gives
 * position(t) = Q(t) + ΔR·Δs·(pivot(t₀) − Q(t₀)) − C − A. Offsets then shift the whole result.
 */
export function layerKeyframes(context: ApplyContext, target: Clip, attachTime: number, base: MotionTrackerLink['base'], options: MotionTrackerLayerOptions, prefix: string): ChannelKeys | null {
  const frames = trackedFrames(context, sharedFrames(context.tracked, target, context.fps));
  if (!frames.length) return null;
  const poses = frames.map(frame => evaluateClip(context.tracked, frame.time, context.fps));
  const canvas = frames.map((frame, i) => poseLayerPoint(poses[i], frame.layer, context.project));
  const xs = smoothSeries(canvas.map(p => p.x), options.smoothing), ys = smoothSeries(canvas.map(p => p.y), options.smoothing);
  // Scale and rotation on the canvas include the tracked clip's own zoom and rotation at each frame.
  const scales = smoothSeries(frames.map((frame, i) => frame.point.scale * Number(poses[i].properties.zoom ?? 100)), options.smoothing);
  const turns = smoothSeries(frames.map((frame, i) => frame.point.rotation + Number(poses[i].properties.rotation ?? 0)), options.smoothing);
  const a = nearestFrame(frames, attachTime), pivot = pivotOffset(evaluateClip(target, frames[a].time, context.fps), context.project);
  const lever = { x: context.project[0] / 2 + pivot.x + base.x - xs[a], y: context.project[1] / 2 + pivot.y + base.y - ys[a] };
  const x: number[] = [], y: number[] = [], zoom: number[] = [], rotation: number[] = [];
  frames.forEach((frame, i) => {
    const growth = options.scale ? scales[i] / scales[a] : 1, turn = options.rotation ? turns[i] - turns[a] : 0;
    const arm = rotate({ x: lever.x * growth, y: lever.y * growth }, turn), own = pivotOffset(evaluateClip(target, frame.time, context.fps), context.project);
    x.push(xs[i] + arm.x - context.project[0] / 2 - own.x + options.offsetX);
    y.push(ys[i] + arm.y - context.project[1] / 2 - own.y + options.offsetY);
    zoom.push(base.zoom * growth); rotation.push(base.rotation + turn);
  });
  const times = frames.map(frame => frame.time), channels: ChannelKeys = {};
  const written = (path: string, letter: string) => target.keyframes?.[path]?.some(key => key.id.startsWith(`${prefix}${letter}`));
  channels['properties.x'] = writeChannel(target.keyframes?.['properties.x'], 'properties.x', target, times, x, `${prefix}x`);
  channels['properties.y'] = writeChannel(target.keyframes?.['properties.y'], 'properties.y', target, times, y, `${prefix}y`);
  // Scale or rotation switched off since the last apply: the keys it wrote give way to the layer's own value.
  if (options.scale || written('properties.zoom', 'z')) channels['properties.zoom'] = writeChannel(target.keyframes?.['properties.zoom'], 'properties.zoom', target, times, options.scale ? zoom : times.map(() => base.zoom), `${prefix}z`);
  if (options.rotation || written('properties.rotation', 'r')) channels['properties.rotation'] = writeChannel(target.keyframes?.['properties.rotation'], 'properties.rotation', target, times, options.rotation ? rotation : times.map(() => base.rotation), `${prefix}r`);
  return channels;
}

/** Picture rectangle a clip shows on the fitted canvas: the letterboxed source, inside its crop. */
export function pictureBounds(clip: Clip, source: Size, project: Size) {
  const p = clip.properties, picture = fittedRect(source, project);
  return { left: Math.max(picture.left, Number(p.cropLeft ?? 0)), top: Math.max(picture.top, Number(p.cropTop ?? 0)), right: Math.min(picture.right, project[0] - Number(p.cropRight ?? 0)), bottom: Math.min(picture.bottom, project[1] - Number(p.cropBottom ?? 0)) };
}

/**
 * Camera follow: reposition (and zoom) the tracked clip so the tracked point stays put on the canvas.
 *
 * With the clip's pose P = C + X + A + z·R·(L − C − A), putting fitted-picture point L at canvas point G needs
 * X = G − C − A − z·R·(L − C − A). Then canvas corner K shows picture point L + R⁻¹(K − G)/z, so the picture covers
 * the canvas exactly when every corner's R⁻¹(K − G)/z, placed around L, stays inside the picture: each corner and
 * axis gives a least zoom. The zoom curve rides above those needs (held, then blurred), and where even the largest
 * zoom allowed cannot hide an edge the point is let off its mark instead: no frame ever shows a border.
 */
export function cameraKeyframes(context: ApplyContext, attachTime: number, base: MotionTrackerLink['base'], options: MotionTrackerCameraOptions, prefix: string): ChannelKeys | null {
  const clip = context.tracked, [width, height] = context.project, frames = trackedFrames(context, sharedFrames(clip, clip, context.fps));
  if (!frames.length) return null;
  const a = nearestFrame(frames, attachTime);
  const lx = smoothSeries(frames.map(frame => frame.layer.x), options.smoothing), ly = smoothSeries(frames.map(frame => frame.layer.y), options.smoothing);
  const turns = smoothSeries(frames.map(frame => frame.point.rotation), options.smoothing);
  const poses = frames.map(frame => evaluateClip(clip, frame.time, context.fps));
  const angle = (i: number) => options.rotation ? base.rotation - (turns[i] - turns[a]) : Number(poses[i].properties.rotation ?? 0);
  // Framing: where the point sits now (the attach frame with the clip's transform before this follow) or the centre.
  const before = { ...poses[a], properties: { ...poses[a].properties, x: base.x, y: base.y, zoom: base.zoom, rotation: base.rotation } };
  const goal = options.framing === 'center' ? { x: width / 2, y: height / 2 } : poseLayerPoint(before, { x: lx[a], y: ly[a] }, context.project);
  goal.x += options.offsetX; goal.y += options.offsetY;
  const bounds = pictureBounds(clip, context.source, context.project);
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: height }, { x: width, y: height }];
  const reach = frames.map((_, i) => corners.map(k => rotate({ x: k.x - goal.x, y: k.y - goal.y }, -angle(i))));
  const needed = frames.map((_, i) => {
    let zoom = 0;
    for (const d of reach[i]) {
      const limits: [number, number][] = [[d.x, d.x > 0 ? bounds.right - lx[i] : lx[i] - bounds.left], [d.y, d.y > 0 ? bounds.bottom - ly[i] : ly[i] - bounds.top]];
      for (const [distance, room] of limits) if (Math.abs(distance) > 1e-9) zoom = Math.max(zoom, room > 1e-9 ? Math.abs(distance) / room : Infinity);
    }
    return zoom * 100;
  });
  const floor = needed.map(value => clamp(value, options.minZoom, options.maxZoom));
  const hold = Math.max(1, Math.round(context.fps * 1.25)), sigma = Math.max(1, context.fps * .5);
  const zooms = options.zoom === 'off' ? frames.map(() => base.zoom) : options.zoom === 'steady' ? frames.map(() => Math.max(...floor)) : envelope(floor, hold, sigma).map(value => Math.min(value, options.maxZoom));
  const x: number[] = [], y: number[] = [];
  frames.forEach((_, i) => {
    const z = zooms[i] / 100;
    let px = lx[i], py = ly[i];
    if (options.zoom !== 'off') {
      // Picture points that may sit at the goal without uncovering an edge at this zoom; the point stays inside.
      const low = { x: bounds.left - Math.min(...reach[i].map(d => d.x)) / z, y: bounds.top - Math.min(...reach[i].map(d => d.y)) / z };
      const high = { x: bounds.right - Math.max(...reach[i].map(d => d.x)) / z, y: bounds.bottom - Math.max(...reach[i].map(d => d.y)) / z };
      px = low.x <= high.x ? clamp(px, low.x, high.x) : (low.x + high.x) / 2;
      py = low.y <= high.y ? clamp(py, low.y, high.y) : (low.y + high.y) / 2;
    }
    const own = pivotOffset(poses[i], context.project), c = { x: width / 2 + own.x, y: height / 2 + own.y }, arm = rotate({ x: px - c.x, y: py - c.y }, angle(i));
    x.push(goal.x - c.x - z * arm.x); y.push(goal.y - c.y - z * arm.y);
  });
  const times = frames.map(frame => frame.time), channels: ChannelKeys = {};
  channels['properties.x'] = writeChannel(clip.keyframes?.['properties.x'], 'properties.x', clip, times, x, `${prefix}x`);
  channels['properties.y'] = writeChannel(clip.keyframes?.['properties.y'], 'properties.y', clip, times, y, `${prefix}y`);
  channels['properties.zoom'] = writeChannel(clip.keyframes?.['properties.zoom'], 'properties.zoom', clip, times, zooms, `${prefix}z`);
  if (options.rotation || clip.keyframes?.['properties.rotation']?.some(key => key.id.startsWith(`${prefix}r`))) channels['properties.rotation'] = writeChannel(clip.keyframes?.['properties.rotation'], 'properties.rotation', clip, times, frames.map((_, i) => angle(i)), `${prefix}r`);
  return channels;
}

/** Id prefix of the keyframes `trackerId` writes; ids cannot contain a dot, so one tracker's prefix never starts another's. */
export const trackerKeyPrefix = (trackerId: string) => `mt.${trackerId.slice(0, 140)}.`;

/** Source dimensions from an asset's "W × H" resolution. */
export function sourceSize(asset: Pick<MediaAsset, 'resolution'>): Size {
  const match = asset.resolution.match(/(\d+)\s*[×x]\s*(\d+)/i);
  return [Number(match?.[1] ?? 1920), Number(match?.[2] ?? 1080)];
}

/** A new tracker, optionally already placed on `at` (normalized source point, source seconds). The feature box is a
 *  twentieth of the picture height, square on screen: an eye in a close-up, a player's number in a wide shot. The
 *  editor draws a box around bigger subjects. The search box is three times as wide. */
export function createMotionTracker(asset: MediaAsset, id: string, index: number, at?: { x: number; y: number; time: number }): MotionTracker {
  const [width, height] = sourceSize(asset), side = Math.round(Math.min(width, height) * .05);
  const tracker: MotionTracker = {
    version: 1, id, name: `Track ${index + 1}`, color: trackerColors[index % trackerColors.length],
    source: { mediaId: asset.id, fps: asset.fps || 24, width, height, duration: asset.duration },
    feature: { width: side / width, height: side / height }, search: { width: Math.min(1, side * 3 / width), height: Math.min(1, side * 3 / height) },
    model: 'position', minConfidence: .6, whenLost: 'search', keys: at ? [{ time: at.time, x: clamp(at.x, 0, 1), y: clamp(at.y, 0, 1) }] : [],
  };
  validateMotionTracker(tracker);
  return tracker;
}

/** Add or move the hand-placed point on the frame at `time` (source seconds, a frame's own time). */
export function placeKey(tracker: Pick<MotionTracker, 'keys' | 'source'>, time: number, x: number, y: number): MotionTrackerKey[] {
  const half = .5 / tracker.source.fps, keys = tracker.keys.filter(key => Math.abs(key.time - time) >= half);
  // The time is the frame's own entry in the source table, kept exact: rounded, it could land before its frame.
  keys.push({ time, x: clamp(Math.round(x * 1e7) / 1e7, -.5, 1.5), y: clamp(Math.round(y * 1e7) / 1e7, -.5, 1.5) });
  return keys.sort((a, b) => a.time - b.time);
}

/** The hand-placed point that bounds a run from `time` in `direction`: the run stops on the frame before it. */
export function nextKey(tracker: Pick<MotionTracker, 'keys' | 'source'>, time: number, direction: 1 | -1) {
  const half = .5 / tracker.source.fps;
  return direction > 0 ? tracker.keys.find(key => key.time > time + half) : [...tracker.keys].reverse().find(key => key.time < time - half);
}
