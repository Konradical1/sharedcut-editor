import type { Clip, Effect } from '../state/models.ts';
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

/** The enabled Noise Reduction that changes the picture, if any. It runs on the camera original, before the grade. */
export const denoiseEffect = (clip: Clip): Effect | undefined => clip.effects.find(effect => effect.name === 'Noise Reduction' && effectEnabled(clip, effect) && effectValue(clip, effect, 'amount') > 0);
export const denoiseSettings = (clip: Clip, effect: Effect): DenoiseSettings => Object.fromEntries(denoiseKeys.map(key => [key, effectValue(clip, effect, key)])) as DenoiseSettings;

/** Source frame i sits at i / fps on the constant-rate grid the worker decodes to; a time between two frames takes
 *  the nearest, a tie the earlier one (as the Stabilize bake picks frames). */
export const denoiseFrameAt = (sourceTime: number, fps: number) => Math.max(0, Math.ceil(sourceTime * fps - .5 - 1e-6));
/** The chunk holding the frame a decoder shows at a source time: the frame whose interval contains it (floor), not the nearest. */
export const denoiseChunkOf = (sourceTime: number, fps: number) => Math.floor(Math.max(0, Math.floor(sourceTime * fps + 1e-6)) / (denoiseChunkSeconds * fps) + 1e-9);
/** Chunk n holds frames [first, first + frames): every frame i with floor(i / (seconds · fps)) = n. */
export function denoiseChunkFrames(chunk: number, fps: number, sourceDuration: number) {
  const total = Math.max(1, Math.round(sourceDuration * fps)), edge = (n: number) => Math.ceil(n * denoiseChunkSeconds * fps - 1e-6);
  const first = Math.max(0, edge(chunk));
  return { first, frames: Math.max(0, Math.min(total, edge(chunk + 1)) - first) };
}
