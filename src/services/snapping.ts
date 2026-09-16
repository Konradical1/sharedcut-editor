import type { Clip, Track } from '../state/models.ts';
import { evaluateClip } from './animation.ts';
import { getShape, isShape, type ShapeDocument } from './shapes.ts';
import { getText, isTitle, type TextDocument } from './text.ts';

export interface SnapBox { x: number; y: number; width: number; height: number }
export interface SnapGuide { axis: 'x' | 'y'; at: number }

/** Snap radius in screen pixels, for the viewer overlays and for the timeline. */
export const SNAP_PIXELS = 6;

const lines = (box: SnapBox, axis: 'x' | 'y') => axis === 'x' ? [box.x, box.x + box.width / 2, box.x + box.width] : [box.y, box.y + box.height / 2, box.y + box.height];

/** Nearest match between any moving value and any fixed one — the shared core of both snappers. */
export function snapTime(moving: number[], fixed: number[], tolerance: number) {
  let best: { shift: number; at: number } | null = null;
  for (const edge of moving) for (const at of fixed) {
    const shift = at - edge;
    if (Math.abs(shift) <= tolerance && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, at };
  }
  return best;
}

/**
 * Where a shape actually sits on screen. The clip's position, scale and anchor move the drawn box
 * away from its document box, so a guide drawn from the document alone would line up with nothing.
 * Rotation is deliberately ignored: a rotated box has no horizontal or vertical edges to snap to.
 */
export function shapeBox(clip: Clip, doc: ShapeDocument, width: number, height: number): SnapBox {
  const zoom = Math.max(.01, Number(clip.properties.zoom ?? 100) / 100);
  const pivotX = (doc.x + doc.width / 2) * width + Number(clip.properties.anchorX ?? 0);
  const pivotY = (doc.y + doc.height / 2) * height + Number(clip.properties.anchorY ?? 0);
  return {
    x: (pivotX + Number(clip.properties.x ?? 0) + zoom * (doc.x * width - pivotX)) / width,
    y: (pivotY + Number(clip.properties.y ?? 0) + zoom * (doc.y * height - pivotY)) / height,
    width: doc.width * zoom, height: doc.height * zoom,
  };
}

/** The same for a text box, which scales about the clip anchor rather than its own centre. */
export function textBox(clip: Clip, doc: TextDocument, width: number, height: number): SnapBox {
  const zoom = Math.max(.01, Number(clip.properties.zoom ?? 100) / 100);
  const originX = .5 + Number(clip.properties.anchorX ?? 0) / width, originY = .5 + Number(clip.properties.anchorY ?? 0) / height;
  return {
    x: originX + zoom * (doc.x - originX) + Number(clip.properties.x ?? 0) / width,
    y: originY + zoom * (doc.y - originY) + Number(clip.properties.y ?? 0) / height,
    width: doc.width * zoom, height: doc.height * zoom,
  };
}

/** Every other title and shape on screen at the playhead — what a drag can line itself up against. */
export function overlayBoxes(state: { clips: Clip[]; tracks: Track[]; timelineId: string; playhead: number }, width: number, height: number, exclude?: string): SnapBox[] {
  return state.clips
    .filter(c => c.timelineId === state.timelineId && c.id !== exclude && !c.disabled && (isTitle(c) || isShape(c))
      && c.start <= state.playhead && c.start + c.duration > state.playhead && !state.tracks.find(t => t.id === c.trackId)?.hidden)
    .map(c => { const clip = evaluateClip(c, state.playhead); return isShape(clip) ? shapeBox(clip, getShape(clip), width, height) : textBox(clip, getText(clip), width, height); });
}

/**
 * Photoshop's rule: each of the moving box's three lines per axis — near edge, centre, far edge —
 * looks for the nearest line on the frame or on another object, and the closest match wins that
 * axis. `free` drops an axis that Shift has locked, so a locked drag cannot be pulled sideways.
 */
export function snapBox(box: SnapBox, others: SnapBox[], tolerance: { x: number; y: number }, free: { x: boolean; y: boolean } = { x: true, y: true }) {
  const targets = [{ x: 0, y: 0, width: 1, height: 1 }, ...others];
  const delta = { x: 0, y: 0 }, guides: SnapGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    if (!free[axis]) continue;
    const hit = snapTime(lines(box, axis), targets.flatMap(target => lines(target, axis)), tolerance[axis]);
    if (hit) { delta[axis] = hit.shift; guides.push({ axis, at: hit.at }); }
  }
  return { dx: delta.x, dy: delta.y, guides };
}

/**
 * Shift-drag locks to whichever direction the pointer has travelled furthest, measured in screen
 * pixels so a 16:9 frame does not bias it. It re-decides on every move: travelling further the
 * other way switches the axis, and releasing Shift frees both again.
 */
export const lockedAxis = (dx: number, dy: number) => Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
