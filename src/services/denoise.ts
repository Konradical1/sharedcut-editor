import type { Clip, Effect, MediaAsset } from '../state/models.ts';
import { effectEnabled, effectValue } from './effects.ts';

/** Picture Noise Reduction parameters, in effectDefinitions order. `amount` is Strength. */
export const denoiseKeys = ['amount', 'chroma', 'frames', 'spatial', 'detail'] as const;
export type DenoiseSettings = Record<typeof denoiseKeys[number], number>;
/** `noise` shows what was removed (original − denoised around mid grey), for tuning. */
export type DenoiseView = 'denoised' | 'noise';
/** Seconds of SOURCE per preview chunk. Chunks are source-time, so moving, trimming or retiming a clip keeps them. */
export const denoiseChunkSeconds = 2;
/** `from` is the chunk's first frame time in the source (first / fps); its media time 0 shows that frame. */
export type DenoisePreview = { status: 'preparing' | 'ready' | 'failed'; key: string; url?: string; error?: string; progress: number; stage?: 'queued' | 'profile' | 'denoise'; from: number; duration: number; fps: number };

/** Denoise all (server/denoise.ts `all`): one batch per project, every chunk its clips show. `done` counts ready chunks. */
export type DenoiseAllStatus = { status: 'none' | 'running' | 'done' | 'stopped'; timelineId?: string; quality?: string; clips: Record<string, { done: number; total: number; error?: string }> };

/** The enabled Noise Reduction that changes the picture, if any. It runs on the camera original, before the grade. */
export const denoiseEffect = (clip: Clip): Effect | undefined => clip.effects.find(effect => effect.name === 'Noise Reduction' && effectEnabled(clip, effect) && effectValue(clip, effect, 'amount') > 0);
export const denoiseSettings = (clip: Clip, effect: Effect): DenoiseSettings => Object.fromEntries(denoiseKeys.map(key => [key, effectValue(clip, effect, key)])) as DenoiseSettings;

/** Source frame i sits at i / fps on the constant-rate grid the worker decodes to; a time between two frames takes
 *  the nearest, a tie the earlier one (as the Stabilize bake picks frames). */
export const denoiseFrameAt = (sourceTime: number, fps: number) => Math.max(0, Math.ceil(sourceTime * fps - .5 - 1e-6));
/** The chunk holding the frame a decoder shows at a source time: the frame whose interval contains it (floor), not the nearest. */
export const denoiseChunkOf = (sourceTime: number, fps: number) => Math.floor(Math.max(0, Math.floor(sourceTime * fps + 1e-6)) / (denoiseChunkSeconds * fps) + 1e-9);
/** Every chunk a clip shows: its source span [sourceIn, sourceIn + duration · speed), one frame for a freeze. */
export function denoiseClipChunks(clip: Pick<Clip, 'sourceIn' | 'duration' | 'properties'>, asset: Pick<MediaAsset, 'fps' | 'duration'>) {
  const fps = asset.fps, last = denoiseChunkOf((Math.max(1, Math.round(asset.duration * fps)) - 1) / fps, fps);
  const span = clip.properties.freeze ? 0 : clip.duration * Number(clip.properties.speed || 100) / 100;
  const from = Math.min(last, denoiseChunkOf(clip.sourceIn, fps)), to = Math.min(last, denoiseChunkOf(Math.max(clip.sourceIn, clip.sourceIn + span - 1 / fps), fps));
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
/** Chunk n holds frames [first, first + frames): every frame i with floor(i / (seconds · fps)) = n. */
export function denoiseChunkFrames(chunk: number, fps: number, sourceDuration: number) {
  const total = Math.max(1, Math.round(sourceDuration * fps)), edge = (n: number) => Math.ceil(n * denoiseChunkSeconds * fps - 1e-6);
  const first = Math.max(0, edge(chunk));
  return { first, frames: Math.max(0, Math.min(total, edge(chunk + 1)) - first) };
}
