import type { Clip, Effect } from '../state/models.ts';
import { effectEnabled, effectValue } from './effects.ts';
import { flowFrames } from './opticalFlow.ts';

/** Stabilized media stays in source time: previews are cut into source-time chunks of this length. */
export const stabilizeChunkSeconds = 4;
export const stabilizeKeys = ['amount', 'smoothness', 'cropMode', 'zoom', 'tripod', 'maxShift', 'maxAngle'] as const;
export type StabilizeSettings = Record<typeof stabilizeKeys[number], number>;
export type StabilizePreview = { status: 'preparing' | 'ready' | 'failed'; key: string; url?: string; error?: string; progress: number; from: number; duration: number; fps: number };
export type StabilizeRange = { from: number; to: number };
export const stabilizeCropModes = ['Auto zoom', 'Fixed zoom', 'Borders'];

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
export const stabilizeChunkCount = (range: StabilizeRange) => Math.max(1, Math.ceil((range.to - range.from) / stabilizeChunkSeconds - 1e-6));
export const stabilizeChunk = (sourceTime: number, range: StabilizeRange) => Math.max(0, Math.min(stabilizeChunkCount(range) - 1, Math.floor((sourceTime - range.from) / stabilizeChunkSeconds)));
export const stabilizeChunkRange = (chunk: number, range: StabilizeRange): StabilizeRange => ({ from: range.from + chunk * stabilizeChunkSeconds, to: Math.min(range.to, range.from + (chunk + 1) * stabilizeChunkSeconds) });
