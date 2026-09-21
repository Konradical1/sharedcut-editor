import type { Clip, Effect } from '../state/models.ts';
import { effectEnabled, effectValue } from './effects.ts';
import { flowFrames } from './opticalFlow.ts';

export const stabilizeKeys = ['amount', 'crop', 'smoothness', 'lock'] as const;
export type StabilizeSettings = Record<typeof stabilizeKeys[number], number>;
export type StabilizeRange = { from: number; to: number };
/** Row-major 2×3 warps in source pixels, one per analysed frame, mapping source → stabilized output. */
export type StabilizeSolve = { version: 1; width: number; height: number; fps: number; from: number; to: number; zoom: number; zoomMin: number; matrices: number[][] };
export type StabilizePreview = { status: 'preparing' | 'ready' | 'failed'; key: string; error?: string; progress: number; solve?: StabilizeSolve; /** Largest and smallest zoom the solve reached, e.g. 1.083 for an 8.3 % crop. */ zoom?: number; zoomMin?: number };

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

/** Zoom the crop budget implies, before any smooth extra zoom the solve adds around whip pans. */
export const stabilizeZoom = (settings: StabilizeSettings) => 1 / (1 - 2 * Math.min(.45, Math.max(0, settings.crop / 100)));

/** The warp for a source time, indexed exactly as the export render indexes it. */
export function stabilizeMatrixAt(solve: StabilizeSolve, sourceTime: number): number[] {
  const index = Math.round((sourceTime - solve.from) * solve.fps);
  return solve.matrices[Math.max(0, Math.min(solve.matrices.length - 1, index))];
}

/** Re-express a source-pixel warp for a canvas where the source sits letterboxed at `scale` from (`left`,`top`).
 *  Returns the six arguments of `setTransform`, so a picture already drawn on that canvas warps in one draw. */
export function stabilizeTransform(matrix: number[], scale: number, left: number, top: number): [number, number, number, number, number, number] {
  const [a, c, e, b, d, f] = matrix;
  // Conjugate by the letterbox fit: canvas = A · source · A⁻¹ with A = [[scale,0,left],[0,scale,top]].
  return [a, b, c, d, scale * e + left - a * left - c * top, scale * f + top - b * left - d * top];
}

/** The frame's warp as `setTransform` arguments for a layer canvas showing `element` letterboxed in `width`×`height`.
 *  The element is usually a proxy while the solve is measured on the original, so its translations are in original
 *  pixels: the scale that carries them onto the layer is the letterboxed width over the analysed width, not over
 *  the proxy's. Aspect is preserved by every proxy, so the letterbox rectangle itself is the element's. */
export function stabilizeLayerTransform(solve: StabilizeSolve, sourceTime: number, width: number, height: number, elementWidth: number, elementHeight: number) {
  const fit = Math.min(width / elementWidth, height / elementHeight), boxWidth = elementWidth * fit, boxHeight = elementHeight * fit;
  return stabilizeTransform(stabilizeMatrixAt(solve, sourceTime), boxWidth / solve.width, (width - boxWidth) / 2, (height - boxHeight) / 2);
}
