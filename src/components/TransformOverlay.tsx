import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useEditorStore, usePausedPlayhead } from '../state/store';
import type { Clip, Track } from '../state/models';
import { evaluateClip } from '../services/animation';
import { projectSize } from '../services/playback';
import { isComposition } from '../services/compositions';
import { isTitle } from '../services/text';
import { isShape } from '../services/shapes';
import { pictureBounds, poseLayerPoint, sourceSize, type Size, type Vec } from '../services/motionTracker';
import { lockedAxis, overlayBoxes, snapBox, SNAP_PIXELS, type SnapBox, type SnapGuide } from '../services/snapping';
import './transform.css';

type Mode = 'move' | 'scale' | 'rotate';
type Pose = { x: number; y: number; zoom: number; rotation: number };
type Picture = { clip: Clip; track: Track; corners: Vec[] };
type Drag = { clip: Clip; mode: Mode; start: Vec; pivot: Vec; corners: Vec[]; pose: Pose; next: Pose; moved: boolean; renewed: number; targets: SnapBox[] };
// The lock fields match the Inspector's, so a collaborator dragging the same property there is held off.
const FIELDS: Record<Mode, (keyof Pose)[]> = { move: ['x', 'y'], scale: ['zoom'], rotate: ['rotation'] };
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const poseOf = (clip: Clip): Pose => ({ x: Number(clip.properties.x ?? 0), y: Number(clip.properties.y ?? 0), zoom: Number(clip.properties.zoom ?? 100), rotation: Number(clip.properties.rotation ?? 0) });
const bounds = (points: Vec[], [width, height]: Size): SnapBox => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y), left = Math.min(...xs), top = Math.min(...ys);
  return { x: left / width, y: top / height, width: (Math.max(...xs) - left) / width, height: (Math.max(...ys) - top) / height };
};

/**
 * Bounding boxes for footage, stills and compositions on the program picture: click to select the topmost one under
 * the pointer, drag to move it, a corner to scale it, the round handle to rotate it. Titles and shapes keep their own
 * overlays above this one. The box is the letterboxed picture inside its crop under the clip's pose — the same
 * mapping playback and export draw with (motionTracker.poseLayerPoint).
 */
// Memoized and off the moving playhead, like the text and shape overlays: nothing is editable while playing.
export default memo(TransformOverlay);
function TransformOverlay() {
  const clips = useEditorStore(s => s.clips), tracks = useEditorStore(s => s.tracks), media = useEditorStore(s => s.media), timelineId = useEditorStore(s => s.timelineId), playhead = usePausedPlayhead();
  const selectedId = useEditorStore(s => s.selectedClipId), selectedIds = useEditorStore(s => s.selectedClipIds), preview = useEditorStore(s => s.clipPreview), drawing = useEditorStore(s => s.textTool || !!s.shapeTool), project = useEditorStore(s => s.projects.find(p => p.id === s.projectId));
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const root = useRef<SVGSVGElement>(null), drag = useRef<Drag | null>(null), s = useEditorStore.getState;
  const [width, height] = projectSize(project?.resolution ?? '1920 × 1080'), size: Size = [width, height];
  // Handles are sized from the on-screen canvas width; re-measure when the canvas resizes or the viewer zooms.
  const [, remeasure] = useState(0);
  useEffect(() => { const el = root.current; if (!el) return; const bump = () => remeasure(n => n + 1), resize = new ResizeObserver(bump), zoom = new MutationObserver(bump), frame = el.closest('.viewer-frame'); resize.observe(el); if (frame) zoom.observe(frame, { attributes: true, attributeFilter: ['style'] }); return () => { resize.disconnect(); zoom.disconnect(); }; }, []);
  const release = (d: Drag) => { for (const field of FIELDS[d.mode]) s().releaseLock(d.clip.id, field); };
  useEffect(() => () => { const d = drag.current; if (d) { release(d); useEditorStore.setState({ clipPreview: null }); } }, []);

  // Bottom track first, as playback composites them, so the topmost picture is the last element and wins the click.
  const pictures: Picture[] = drawing ? [] : clips.filter(c => c.timelineId === timelineId && !c.disabled && c.start <= playhead && c.start + c.duration > playhead && !isTitle(c) && !isShape(c)).flatMap(c => {
    const track = tracks.find(t => t.id === c.trackId), asset = media.find(m => m.id === c.mediaId);
    if (track?.kind !== 'video' || track.hidden) return [];
    const source: Size | undefined = isComposition(c) ? size : asset && (asset.kind === 'video' || asset.kind === 'image') ? sourceSize(asset) : undefined;
    if (!source) return [];
    const clip = preview?.id === c.id ? preview : evaluateClip(c, playhead, project?.fps || 24), b = pictureBounds(clip, source, size);
    return [{ clip, track, corners: [[b.left, b.top], [b.right, b.top], [b.right, b.bottom], [b.left, b.bottom]].map(([x, y]) => poseLayerPoint(clip, { x, y }, size)) }];
  }).sort((a, b) => a.track.number - b.track.number);

  const framePoint = (e: { clientX: number; clientY: number }): Vec => { const p = root.current!.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const q = p.matrixTransform(root.current!.getScreenCTM()!.inverse()); return { x: q.x, y: q.y }; };
  const end = (cancel = false) => {
    const d = drag.current; if (!d) return; drag.current = null; setGuides([]);
    if (!cancel && d.moved) {
      // One gesture id: Undo takes the whole drag back, both axes included, keyframed or not.
      const gesture = `transform-${d.clip.id}-${Date.now()}`;
      for (const key of FIELDS[d.mode]) { const value = Math.round(d.next[key] * 100) / 100; if (value !== Math.round(d.pose[key] * 100) / 100) s().updateProperty(d.clip.id, key, value, gesture); }
    }
    release(d); useEditorStore.setState({ clipPreview: null });
  };
  const begin = (e: PointerEvent<SVGElement>, picture?: Picture, mode: Mode = 'move') => {
    if (e.button !== 0 || drawing) return;
    e.preventDefault(); e.stopPropagation();
    if (!picture) { s().selectClip(null); return; }
    const { clip, track } = picture;
    if (e.shiftKey) { s().selectClip(clip.id, true); return; }
    if (!selectedIds.includes(clip.id)) s().selectClip(clip.id);
    if (track.locked) return;
    const fields = FIELDS[mode];
    if (!fields.every(field => s().acquireLock(clip.id, field))) { for (const field of fields) s().releaseLock(clip.id, field); return; }
    const pose = poseOf(clip);
    drag.current = { clip, mode, start: framePoint(e), pivot: { x: width / 2 + Number(clip.properties.anchorX ?? 0) + pose.x, y: height / 2 + Number(clip.properties.anchorY ?? 0) + pose.y }, corners: picture.corners, pose, next: pose, moved: false, renewed: Date.now(),
      targets: mode === 'move' ? [...overlayBoxes(s(), width, height), ...pictures.filter(p => p.clip.id !== clip.id).map(p => bounds(p.corners, size))] : [] };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const q = framePoint(e), dx = q.x - d.start.x, dy = q.y - d.start.y, screen = root.current!.getBoundingClientRect();
    // A click that wobbles a pixel or two only selects.
    if (!d.moved) { if (Math.hypot(dx, dy) * screen.width / width < 3) return; d.moved = true; }
    if (Date.now() - d.renewed > 2000) { if (!FIELDS[d.mode].every(field => s().renewLock(d.clip.id, field))) { end(true); return; } d.renewed = Date.now(); }
    const next = { ...d.pose };
    if (d.mode === 'move') {
      // Shift locks the drag to its dominant direction; Alt suspends snapping, as in the title and shape overlays.
      const axis = e.shiftKey ? lockedAxis(dx, dy) : null;
      let mx = axis === 'y' ? 0 : dx, my = axis === 'x' ? 0 : dy;
      if (e.altKey) setGuides([]);
      else {
        const snap = snapBox(bounds(d.corners.map(c => ({ x: c.x + mx, y: c.y + my })), size), d.targets, { x: SNAP_PIXELS / screen.width, y: SNAP_PIXELS / screen.height }, { x: axis !== 'y', y: axis !== 'x' });
        mx += snap.dx * width; my += snap.dy * height; setGuides(snap.guides);
      }
      next.x = d.pose.x + mx; next.y = d.pose.y + my;
    } else if (d.mode === 'scale') {
      // About the anchor, like the Zoom field: the corner follows the pointer's distance from it.
      next.zoom = clamp(d.pose.zoom * Math.hypot(q.x - d.pivot.x, q.y - d.pivot.y) / Math.max(1, Math.hypot(d.start.x - d.pivot.x, d.start.y - d.pivot.y)), 1, 800);
    } else {
      const turn = (Math.atan2(q.y - d.pivot.y, q.x - d.pivot.x) - Math.atan2(d.start.y - d.pivot.y, d.start.x - d.pivot.x)) * 180 / Math.PI, angle = d.pose.rotation + ((turn + 540) % 360 - 180);
      next.rotation = clamp(e.shiftKey ? Math.round(angle / 15) * 15 : angle, -360, 360);
    }
    d.next = next;
    useEditorStore.setState({ clipPreview: { ...d.clip, keyframes: undefined, properties: { ...d.clip.properties, ...next } } });
  };
  // Arrows nudge the box by a pixel (Shift: 10), a corner's zoom by a percent, the knob's rotation by a degree.
  const nudge = (e: KeyboardEvent, clip: Clip, mode: Mode = 'move') => {
    if (e.key === 'Enter') { s().selectClip(clip.id); return; }
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault(); e.stopPropagation();
    const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1), pose = poseOf(clip);
    if (mode === 'scale') s().updateProperty(clip.id, 'zoom', clamp(pose.zoom + (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1) * Math.abs(step), 1, 800));
    else if (mode === 'rotate') s().updateProperty(clip.id, 'rotation', clamp(pose.rotation + step, -360, 360));
    else { const key = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? 'x' : 'y'; s().updateProperty(clip.id, key, pose[key] + step); }
  };

  const unit = width / (root.current?.getBoundingClientRect().width || 640), handle = 9 * unit;
  const primary = pictures.find(p => p.clip.id === selectedId);
  let knob: Vec | undefined;
  if (primary) {
    // The rotate knob sits above the top edge, or just inside it when that would leave the frame (a full-frame clip).
    const [a, b] = primary.corners, top = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, centre = { x: primary.corners.reduce((n, c) => n + c.x, 0) / 4, y: primary.corners.reduce((n, c) => n + c.y, 0) / 4 };
    const length = Math.hypot(top.x - centre.x, top.y - centre.y) || 1, ux = (top.x - centre.x) / length, uy = (top.y - centre.y) / length, reach = 26 * unit;
    knob = { x: top.x + ux * reach, y: top.y + uy * reach };
    if (knob.x < 0 || knob.y < 0 || knob.x > width || knob.y > height) knob = { x: top.x - ux * reach, y: top.y - uy * reach };
    // A box pushed past the frame edge still keeps a reachable knob: the frame clips everything outside it.
    knob = { x: clamp(knob.x, handle, width - handle), y: clamp(knob.y, handle, height - handle) };
  }
  const points = (corners: Vec[]) => corners.map(c => `${c.x},${c.y}`).join(' ');
  return <div className={`transform-overlay${drawing ? ' transform-inactive' : ''}`}>
    <svg ref={root} viewBox={`0 0 ${width} ${height}`} aria-label="Picture canvas" onPointerDown={e => begin(e)} onPointerMove={move} onPointerUp={() => end()} onPointerCancel={() => end(true)} onLostPointerCapture={() => { if (drag.current) end(true); }}>
      {pictures.map(p => <polygon key={p.clip.id} points={points(p.corners)} className={`transform-hit${selectedIds.includes(p.clip.id) ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`Select clip: ${p.clip.name}`} aria-pressed={selectedIds.includes(p.clip.id)} onPointerDown={e => begin(e, p)} onKeyDown={e => nudge(e, p.clip)}/>)}
      {primary && knob && !primary.track.locked && <g>
        <line x1={(primary.corners[0].x + primary.corners[1].x) / 2} y1={(primary.corners[0].y + primary.corners[1].y) / 2} x2={knob.x} y2={knob.y} className="transform-guide"/>
        <circle cx={knob.x} cy={knob.y} r={handle * .62} className="transform-handle transform-rotate" role="button" tabIndex={0} aria-label="Rotate clip" onPointerDown={e => begin(e, primary, 'rotate')} onKeyDown={e => nudge(e, primary.clip, 'rotate')}/>
        {primary.corners.map((c, i) => <rect key={i} x={c.x - handle / 2} y={c.y - handle / 2} width={handle} height={handle} className={`transform-handle transform-corner-${i}`} role="button" tabIndex={0} aria-label="Scale clip" onPointerDown={e => begin(e, primary, 'scale')} onKeyDown={e => nudge(e, primary.clip, 'scale')}/>)}
      </g>}
      {guides.map((g, i) => <line key={i} className="snap-guide" x1={g.axis === 'x' ? g.at * width : 0} y1={g.axis === 'x' ? 0 : g.at * height} x2={g.axis === 'x' ? g.at * width : width} y2={g.axis === 'x' ? height : g.at * height}/>)}
    </svg>
  </div>;
}
