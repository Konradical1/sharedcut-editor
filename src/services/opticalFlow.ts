import type { Clip } from '../state/models.ts';
import { animatedSourceOffset, sampleKeyframes, validateKeyframes } from './animation.ts';

export const timingPaths = ['properties.speed', 'properties.reverse', 'properties.freeze'];
export const flowChunkSeconds = 4;
export function flowTiming(clip: Clip) {
  return { mediaId: clip.mediaId, sourceIn: clip.sourceIn, duration: clip.duration,
    properties: { speed: clip.properties.speed ?? 100, reverse: !!clip.properties.reverse, freeze: !!clip.properties.freeze },
    keyframes: Object.fromEntries(timingPaths.filter(p => clip.keyframes?.[p]?.length).map(p => [p, clip.keyframes![p]])) };
}
export function flowFrames(clip: Clip, fps: number, sourceFps: number, sourceDuration: number, from = 0, duration = clip.duration) {
  if (![fps, sourceFps, sourceDuration, from, duration, clip.sourceIn].every(Number.isFinite) || fps < 1 || fps > 120 || sourceFps <= 0 || sourceDuration <= 0 || duration <= 0 || duration > 21600 || from < 0 || from + duration > clip.duration + 1e-6) throw new Error('Invalid optical-flow frame range.');
  if (clip.keyframes) validateKeyframes(clip.keyframes);
  const speed=Number(clip.properties.speed??100);
  if(!Number.isFinite(speed)||speed<1||speed>800||clip.keyframes?.['properties.speed']?.some(k=>typeof k.value!=='number'))throw new Error('Optical flow requires a valid numeric speed.');
  const freeze = clip.keyframes?.['properties.freeze'];
  return Array.from({ length: Math.ceil(duration * fps - 1e-7) }, (_, index) => {
    const local = from + index / fps;
    const time=Math.max(0, Math.min(sourceDuration - 1 / sourceFps, clip.sourceIn + animatedSourceOffset(clip, local, sourceFps)));
    if(!Number.isFinite(time))throw new Error('The speed curve produced an invalid source time.');
    return { time,
      interpolate: !(freeze?.length ? sampleKeyframes(freeze, local) : clip.properties.freeze) };
  });
}

export type FlowPreview = { status: 'preparing' | 'ready' | 'failed'; key: string; url?: string; error?: string; progress: number; from: number; duration: number; fps: number };
