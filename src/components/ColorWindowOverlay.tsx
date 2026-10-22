import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useEditorStore, usePausedPlayhead } from '../state/store';
import type { Clip } from '../state/models';
import { evaluateClip, evaluateNodes } from '../services/animation';
import { projectSize } from '../services/playback';
import { isAdjustment } from '../services/adjustment';
import { sourceSize, type Size, type Vec } from '../services/motionTracker';
import { lockedAxis } from '../services/snapping';
import { PARAM, on } from '../services/grading';
import { probeNodeInput } from '../services/colorPreview';
import { apply, dragWindow, frameOf, invert, multiply, nodeWeights, pickQualifier, pictureToCanvas, tidyParams, windowContours, windowHandles, type Point, type WindowHandle, type WindowKind } from '../services/colorKeys';
import { createId } from '../services';
import { useColorUi } from '../workspaces/colorUi';
import '../workspaces/colorKeys.css';

type Params = Record<string, number>;
type Drag = { nodeId: string; kind: WindowKind; handle: WindowHandle; p: Params; from: Vec; start: Vec; gesture: string; moved: boolean };
const NAMES: Record<WindowKind, string> = { grad: 'gradient', circ: 'circle', rect: 'rectangle' };
const label = (kind: WindowKind, handle: WindowHandle) => {
  const name = NAMES[kind], Name = name[0].toUpperCase() + name.slice(1);
  return handle === 'move' ? `Move ${name}` : handle === 'rotate' ? `Rotate ${name}` : handle === 'soft' ? `${Name} softness` : handle === 'size' ? `Resize ${name}`
    : `${Name} ${kind === 'circ' ? (handle === 'w' ? 'radius X' : 'radius Y') : handle === 'w' ? 'width' : 'height'}`;
};
const resizeCursor = (dx: number, dy: number) => ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(((Math.atan2(dy, dx) * 180 / Math.PI) % 180 + 180) % 180 / 45) % 4];

export default memo(ColorWindowOverlay);
/** Color page viewer tools for the selected node: its windows with handles (Windows tab) and the qualifier eyedropper. */
function ColorWindowOverlay() {
  const color = useEditorStore(s => s.workspace === 'color'), tool = useColorUi(s => s.tool), picking = useColorUi(s => s.picking);
  return color && (tool === 'Windows' || picking) ? <WindowEditor picking={picking} windows={tool === 'Windows'}/> : null;
}

/**
 * Windows are stored in source-picture coordinates (docs/color-grading-v3.md, Windows); they are drawn through the clip's
 * letterbox and pose (colorKeys.pictureToCanvas, the mapping playback draws with) and the pointer is mapped back the same way,
 * so a handle stays under the cursor through any zoom, rotation or Scale X/Y. One drag is one gesture: one Undo.
 */
function WindowEditor({ picking, windows }: { picking: boolean; windows: boolean }) {
  const playhead = usePausedPlayhead(), clips = useEditorStore(s => s.clips), tracks = useEditorStore(s => s.tracks), media = useEditorStore(s => s.media), nodes = useEditorStore(s => s.nodes);
  const timelineId = useEditorStore(s => s.timelineId), selectedClipId = useEditorStore(s => s.selectedClipId), selectedNodeId = useEditorStore(s => s.selectedNodeId), preview = useEditorStore(s => s.clipPreview), project = useEditorStore(s => s.projects.find(p => p.id === s.projectId));
  const root = useRef<SVGSVGElement>(null), drag = useRef<Drag | null>(null);
  // Handles keep their screen size: re-measure when the canvas resizes or the viewer zooms.
  const [, remeasure] = useState(0);
  useEffect(() => { const el = root.current; if (!el) return; const bump = () => remeasure(n => n + 1), resize = new ResizeObserver(bump), zoom = new MutationObserver(bump), frame = el.closest('.viewer-frame'); resize.observe(el); if (frame) zoom.observe(frame, { attributes: true, attributeFilter: ['style'] }); return () => { resize.disconnect(); zoom.disconnect(); }; }, []);
  useEffect(() => {
    if (!picking) return;
    const cancel = (e: globalThis.KeyboardEvent) => { if (e.key !== 'Escape') return; e.preventDefault(); e.stopPropagation(); useColorUi.setState({ picking: false }); };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [picking]);

  const [width, height] = projectSize(project?.resolution ?? '1920 × 1080'), size: Size = [width, height], fps = project?.fps || 24;
  // The Color page's shot and node, chosen as ColorWorkspace does: the selected shot when it is on screen, else the topmost one
  // there; its selected node, else its first. Editing overlays rest while playing.
  const trackOf = (c: Clip) => tracks.find(t => t.id === c.trackId);
  const visible = playhead < 0 ? [] : clips.filter(c => c.timelineId === timelineId && trackOf(c)?.kind === 'video' && !trackOf(c)?.hidden && !c.disabled && (isAdjustment(c) || media.some(m => m.id === c.mediaId)) && c.start <= playhead && c.start + c.duration > playhead);
  const clip = visible.find(c => c.id === selectedClipId) ?? [...visible].sort((a, b) => (trackOf(b)?.number ?? 0) - (trackOf(a)?.number ?? 0))[0];
  const own = clip ? nodes.filter(n => n.clipId === clip.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [], stored = own.find(n => n.id === selectedNodeId) ?? own[0];
  const node = clip && stored ? evaluateNodes([stored], clip, playhead)[0] : undefined, asset = clip && media.find(m => m.id === clip.mediaId);
  // An adjustment clip grades the composite below it, which is the project canvas.
  const source: Size = clip && !isAdjustment(clip) && asset ? sourceSize(asset) : size, aspect = source[0] / source[1];
  const toCanvas = clip && pictureToCanvas(preview?.id === clip.id ? preview : evaluateClip(clip, playhead, fps), source, size), toPicture = toCanvas && invert(toCanvas);
  const usable = !!node && !!toCanvas && !!toPicture?.every(Number.isFinite);

  const framePoint = (e: { clientX: number; clientY: number }): Vec => { const q = root.current!.createSVGPoint(); q.x = e.clientX; q.y = e.clientY; const r = q.matrixTransform(root.current!.getScreenCTM()!.inverse()); return { x: r.x, y: r.y }; };
  const unit = width / (root.current?.getBoundingClientRect().width || 640);
  const begin = (e: PointerEvent<SVGElement>, kind: WindowKind, handle: WindowHandle) => {
    if (e.button !== 0 || picking || !usable) return;
    e.preventDefault(); e.stopPropagation();
    const start = framePoint(e);
    drag.current = { nodeId: node!.id, kind, handle, p: node!.parameters, from: apply(toPicture!, start.x, start.y), start, gesture: createId('grade'), moved: false };
    root.current!.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current; if (!d || !toPicture) return;
    let q = framePoint(e);
    // A click that wobbles a pixel only grabs.
    if (!d.moved) { if (Math.hypot(q.x - d.start.x, q.y - d.start.y) / unit < 2) return; d.moved = true; }
    // Shift holds a move to its main direction on screen, and turns in 15° steps or resizes evenly otherwise.
    if (d.handle === 'move' && e.shiftKey) q = lockedAxis(q.x - d.start.x, q.y - d.start.y) === 'x' ? { x: q.x, y: d.start.y } : { x: d.start.x, y: q.y };
    useEditorStore.getState().updateNode(d.nodeId, { parameters: dragWindow(d.kind, d.handle, d.p, aspect, d.from, apply(toPicture, q.x, q.y), e.shiftKey) }, d.gesture);
  };
  const end = () => { drag.current = null; };
  const pick = async (e: PointerEvent<SVGSVGElement>) => {
    if (!picking || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (!usable) return;
    const q = framePoint(e), at = apply(toPicture!, q.x, q.y), extend = e.shiftKey, nodeId = node!.id;
    if (at.x < 0 || at.x > 1 || at.y < 0 || at.y > 1) return;
    const rgb = await probeNodeInput(nodeId, at.x, at.y), s = useEditorStore.getState();
    if (!rgb) { s.notify('Pick again once the frame is ready', 'info'); return; }
    const now = s.nodes.find(n => n.id === nodeId), shot = now && s.clips.find(c => c.id === now.clipId);
    if (!now || !shot) return;
    s.updateNode(nodeId, { parameters: pickQualifier(rgb, nodeWeights(shot, s.media.find(m => m.id === shot.mediaId), s.nodes, nodeId), evaluateNodes([now], shot, s.playhead)[0].parameters, extend) }, createId('grade'));
    if (!extend) useColorUi.setState({ picking: false });
  };
  // Arrows nudge: a centre by a thousandth of the picture (Shift: ten), a knob by a degree (Shift: 15°), sizes and softness by .002.
  const nudge = (e: KeyboardEvent, kind: WindowKind, handle: WindowHandle) => {
    const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0, dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!usable || !dx && !dy) return;
    e.preventDefault(); e.stopPropagation();
    const k = (name: string) => kind + name, get = (name: string) => node!.parameters[k(name)] ?? PARAM[k(name)].initial, step = e.shiftKey ? 10 : 1, grow = (dx || -dy) * step * .002;
    const patch = handle === 'move' ? { [k(dx ? 'X' : 'Y')]: get(dx ? 'X' : 'Y') + (dx || dy) * step * .001 } : handle === 'rotate' ? { [k('Angle')]: get('Angle') + (dx || dy) * (e.shiftKey ? 15 : 1) }
      : Object.fromEntries((handle === 'soft' ? ['Soft'] : handle === 'size' ? ['W', 'H'] : [handle.toUpperCase()]).map(n => [k(n), get(n) + grow]));
    useEditorStore.getState().updateNode(node!.id, { parameters: tidyParams(patch) });
  };

  const p = node?.parameters ?? {}, reach = 24 * unit, margin = 9 * unit;
  // A knob pushed off the frame flips to the inside of its shape, and stays on the frame either way: the frame clips the rest.
  const onFrame = (q: Vec) => q.x >= margin && q.y >= margin && q.x <= width - margin && q.y <= height - margin;
  const push = (base: Vec, dx: number, dy: number) => {
    const out = { x: base.x + dx * reach, y: base.y + dy * reach }, q = onFrame(out) ? out : { x: base.x - dx * reach, y: base.y - dy * reach };
    return { x: Math.max(margin, Math.min(width - margin, q.x)), y: Math.max(margin, Math.min(height - margin, q.y)) };
  };
  const shapes = usable && windows ? (['grad', 'circ', 'rect'] as const).filter(kind => on(p[`${kind}On`])).map(kind => {
    const L = multiply(toCanvas!, frameOf(kind, p, aspect)), at = (u: number, v: number) => apply(L, u, v), centre = at(0, 0), closed = kind !== 'grad';
    const path = (points: Point[]) => points.map(([u, v], i) => { const q = at(u, v); return `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`; }).join('') + (closed ? 'Z' : '');
    const handles = windowHandles(kind, p).map(h => {
      const base = at(h.at[0], h.at[1]);
      if (!h.out) return { ...h, base, x: base.x, y: base.y };
      const tip = at(h.at[0] + h.out[0], h.at[1] + h.out[1]), length = Math.hypot(tip.x - base.x, tip.y - base.y) || 1;
      return { ...h, base, ...push(base, (tip.x - base.x) / length, (tip.y - base.y) / length) };
    });
    // A gradient's arrow points into the side it grades.
    const ahead = at(0, on(p.gradInvert) ? 1 : -1), arrowLength = Math.hypot(ahead.x - centre.x, ahead.y - centre.y) || 1, dir = { x: (ahead.x - centre.x) / arrowLength, y: (ahead.y - centre.y) / arrowLength };
    const feather = handles.find(h => h.handle === 'soft')!.base, band = kind === 'grad' ? Math.hypot(feather.x - centre.x, feather.y - centre.y) : 0, tip = { x: centre.x + dir.x * (band + reach * 1.3), y: centre.y + dir.y * (band + reach * 1.3) };
    return { kind, contours: windowContours(kind, p), path, centre, handles, arrow: kind === 'grad' ? { tip, dir } : undefined };
  }) : [];

  return <div className={`color-window-overlay${picking ? ' picking' : ''}`}>
    <svg ref={root} viewBox={`0 0 ${width} ${height}`} aria-label={picking ? 'Pick a colour for the qualifier' : 'Color windows'} onPointerDown={e => { if (picking) void pick(e); }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {shapes.map(w => {
        // Light lines over dark halos read on any picture (CSS filters on SVG elements are not dependable in Safari).
        const lines = [...[w.contours.outer, w.contours.inner].flatMap(c => c ? [['ckw-ring', w.path(c)]] : []), ['ckw-edge', w.path(w.contours.edge)],
          ...w.handles.filter(h => h.handle === 'rotate' && w.kind !== 'grad').map(h => ['ckw-guide', `M${h.base.x.toFixed(1)} ${h.base.y.toFixed(1)}L${h.x.toFixed(1)} ${h.y.toFixed(1)}`]),
          ...w.arrow ? [['ckw-arrow', `M${w.centre.x.toFixed(1)} ${w.centre.y.toFixed(1)}L${w.arrow.tip.x.toFixed(1)} ${w.arrow.tip.y.toFixed(1)}`]] : []];
        return <g key={w.kind} className={`ckw-window ckw-${w.kind}`}>
          {w.kind !== 'grad' && <path className="ckw-body" d={w.path(w.contours.edge)} onPointerDown={e => begin(e, w.kind, 'move')}/>}
          {lines.map(([kind, d], i) => <path key={`halo-${i}`} className={`ckw-halo ${kind}-halo`} d={d}/>)}
          {lines.map(([kind, d], i) => <path key={i} className={kind} d={d}/>)}
          {w.arrow && <path className="ckw-head" d={`M${w.arrow.tip.x + w.arrow.dir.x * 7 * unit} ${w.arrow.tip.y + w.arrow.dir.y * 7 * unit}L${w.arrow.tip.x - w.arrow.dir.y * 5 * unit} ${w.arrow.tip.y + w.arrow.dir.x * 5 * unit}L${w.arrow.tip.x + w.arrow.dir.y * 5 * unit} ${w.arrow.tip.y - w.arrow.dir.x * 5 * unit}Z`}/>}
        </g>;
      })}
      {shapes.flatMap(w => w.handles.map((h, i) => {
        const s = unit, cursor = h.handle === 'move' ? 'move' : h.handle === 'rotate' ? 'grab' : resizeCursor(h.x - w.centre.x, h.y - w.centre.y);
        return <g key={`${w.kind}-${i}`} className={`ckw-handle ckw-${h.handle}`} transform={`translate(${h.x.toFixed(1)} ${h.y.toFixed(1)})`} style={{ cursor }} role="button" tabIndex={0} aria-label={label(w.kind, h.handle)}
          onPointerDown={e => begin(e, w.kind, h.handle)} onKeyDown={e => nudge(e, w.kind, h.handle)}>
          <circle className="ckw-hit" r={11 * s}/>
          {h.handle === 'move' ? <><circle className="ckw-halo" r={6.5 * s}/><circle className="ckw-shape" r={6.5 * s}/><circle className="ckw-dot" r={1.6 * s}/></>
            : h.handle === 'rotate' ? <circle className="ckw-shape" r={4.5 * s}/>
            : h.handle === 'soft' ? <rect className="ckw-shape" x={-3.5 * s} y={-3.5 * s} width={7 * s} height={7 * s} transform="rotate(45)"/>
            : <rect className="ckw-shape" x={-4 * s} y={-4 * s} width={8 * s} height={8 * s}/>}
        </g>;
      }))}
    </svg>
    {picking && <div className="ckw-hint" role="status">Click a colour to key it · Shift-click adds to the key · Esc cancels</div>}
  </div>;
}
