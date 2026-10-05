import type { Clip, MediaAsset } from '../state/models.ts';

/**
 * An adjustment clip has no picture of its own. Its grade, effects and transform apply to everything the tracks
 * below it have composited by that point, then the result is drawn back over them like any other layer (opacity and
 * blend mode included), the way Premiere and Resolve treat an adjustment layer. Inside a composition it adjusts only
 * that composition's lower tracks.
 */
export const ADJUSTMENT_MEDIA = 'frameline-adjustment';
export const isAdjustment = (clip: Pick<Clip, 'mediaId'>) => clip.mediaId === ADJUSTMENT_MEDIA;
export const ADJUSTMENT_DURATION = 5;

/** The composite it reads is display-referred Rec.709 at the project size, so it is graded as a Rec.709 still. */
export const adjustmentAsset = (clip: Clip, resolution = ''): MediaAsset => ({ id: ADJUSTMENT_MEDIA, projectId: clip.projectId, name: clip.name, kind: 'image', binId: '', thumbnail: '', duration: clip.duration, resolution, fps: 0, size: '', status: 'ready', progress: 100, inputProfile: 'Rec.709' });
