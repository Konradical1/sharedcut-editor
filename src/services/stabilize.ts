import type { Clip, Effect } from '../state/models.ts';
import { effectEnabled, effectValue } from './effects.ts';
import { flowFrames } from './opticalFlow.ts';

/** Stabilized media stays in source time: previews are cut into source-time chunks of this length. */
export const stabilizeChunkSeconds = 4;
export const stabilizeKeys = ['amount', 'crop', 'smoothness', 'lock'] as const;
export type StabilizeSettings = Record<typeof stabilizeKeys[number], number>;
export type StabilizePreview = { status: 'preparing' | 'ready' | 'failed'; key: string; url?: string; error?: string; progress: number; from: number; duration: number; fps: number; /** Largest and smallest zoom the render used, e.g. 1.083 for an 8.3 % crop. */ zoom?: number; zoomMin?: number };
export type StabilizeRange = { from: number; to: number };

/** The enabled Stabilize effect that actually changes the picture, if any. */
export const stabilizeEffect = (clip: Clip): Effect | undefined => clip.effects.find(effect => effect.name === 'Stabilize' && effectEnabled(clip, effect) && effectValue(clip, effect, 'amount') > 0);
export const stabilizeSettings = (clip: Clip, effect: Effect): StabilizeSettings => Object.fromEntries(stabilizeKeys.map(key => [key, effectValue(clip, effect, key)])) as StabilizeSettings;

/** Source-time range the clip reads, including speed ramps, reverse and freeze. Analysis covers all of it. */
export function stabilizeRange(clip: Clip, sourceFps: number, sourceDuration: number): StabilizeRange {
  const fps = Math.max(1, Math.min(120, sourceFps || 24));
  const times = flowFrames(clip, fps, fps, sourceDuration).map(frame => frame.time);
  const from = Math.max(0, Math.min(clip.sourceIn, ...times));
  const to = Math.min(sourceDuration, Math.max(...times) + 1 / fps);
  if (!(to > from)) throw new Error('The clip reads no source frames to stabilize.');
  return { from, to };
}
/** Chunk edges land on whole source frames so consecutive sections never repeat or skip a frame. */
const chunkLength = (fps: number) => Math.max(1, Math.round(stabilizeChunkSeconds * Math.max(1, fps || 24))) / Math.max(1, fps || 24);
export const stabilizeChunkCount = (range: StabilizeRange, fps: number) => Math.max(1, Math.ceil((range.to - range.from) / chunkLength(fps) - 1e-6));
export const stabilizeChunk = (sourceTime: number, range: StabilizeRange, fps: number) => Math.max(0, Math.min(stabilizeChunkCount(range, fps) - 1, Math.floor((sourceTime - range.from) / chunkLength(fps))));
export const stabilizeChunkRange = (chunk: number, range: StabilizeRange, fps: number): StabilizeRange => ({ from: range.from + chunk * chunkLength(fps), to: Math.min(range.to, range.from + (chunk + 1) * chunkLength(fps)) });
/** Zoom the crop budget implies, before any smooth extra zoom the worker adds around whip pans. */
export const stabilizeZoom = (settings: StabilizeSettings) => 1 / (1 - 2 * Math.min(.45, Math.max(0, settings.crop / 100)));
