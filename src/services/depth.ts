// Depth analysis: the contract shared by server/depth.ts, scripts/depth.py and the editor.
// A run covers a range of source frames of one original; its depth lives in 64-frame segments.
import { smartMaskFrame } from './smartMask.ts';

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
};
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
