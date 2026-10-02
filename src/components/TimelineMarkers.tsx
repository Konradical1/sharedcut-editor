import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { Copy, Flag, MessageSquare, Pencil, Play, Plus, Clipboard, Trash2 } from 'lucide-react';
import { useEditorStore } from '../state/store';
import type { Marker } from '../state/models';
import { markersOf } from '../services/timeline';
import { snapTime, SNAP_PIXELS } from '../services/snapping';
import { Button, ContextMenu, timecode } from './ui';

type Placed = Marker & { id: string };
export type RulerMenu = { x: number; y: number; time: number };
const SWATCHES = ['#4f8ef7', '#4fd1e0', '#5fcf73', '#f2d14a', '#f59b4c', '#f0625f', '#f28ad0', '#a77df2', '#e8e2d4'];
const actions = useEditorStore.getState;
const selectMarkers = (ids: string[]) => { if (ids.length) actions().selectClips([]); useEditorStore.setState({ selectedMarkerIds: ids }); };

/**
 * Markers and timed comments on the ruler. Click goes to a marker, Shift-click adds it to the selection, drag moves the
 * selection (snapping like clips), double-click or right-click edits. Every change is one undo through setMarkers.
 */
export function TimelineMarkers({ pixels, fps, snapping, screenPixels, rulerMenu, closeRulerMenu }: { pixels: number; fps: number; snapping: boolean; screenPixels: () => number; rulerMenu: RulerMenu | null; closeRulerMenu: () => void }) {
  // Select the stored array (a stable reference) and give ids after: markersOf makes new objects for id-less markers.
  const saved = useEditorStore(s => s.timelines.find(t => t.id === s.timelineId)?.markers);
  const markers = useMemo(() => markersOf({ markers: saved }), [saved]);
  const selected = useEditorStore(s => s.selectedMarkerIds);
  const canPaste = useEditorStore(s => !!s.markerClipboard?.length);
  const comments = useEditorStore(useShallow(s => s.comments.filter(c => c.projectId === s.projectId && !c.resolved && (c.timelineId ? c.timelineId === s.timelineId : !!c.clipId && s.clips.some(clip => clip.id === c.clipId && clip.timelineId === s.timelineId)))));
  const users = useEditorStore(s => s.users);
  const anchor = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; primary: string; origin: Map<string, number>; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [editor, setEditor] = useState<{ x: number; y: number; marker: Placed; isNew: boolean } | null>(null);

  // A click anywhere but on markers and their menus drops the selection, so Delete goes back to clips.
  useEffect(() => {
    if (!selected.length) return;
    const clear = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest('.timeline-marker,.marker-editor,.context-menu')) useEditorStore.setState({ selectedMarkerIds: [] }); };
    document.addEventListener('pointerdown', clear, true);
    return () => document.removeEventListener('pointerdown', clear, true);
  }, [selected.length]);

  const down = (e: ReactPointerEvent<HTMLButtonElement>, marker: Placed) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const current = actions().selectedMarkerIds;
    const ids = e.shiftKey || e.metaKey ? (current.includes(marker.id) ? current.filter(id => id !== marker.id) : [...current, marker.id]) : current.includes(marker.id) ? current : [marker.id];
    selectMarkers(ids);
    if (!ids.includes(marker.id)) return;
    drag.current = { x: e.clientX, primary: marker.id, origin: new Map(markers.filter(m => ids.includes(m.id)).map(m => [m.id, m.time])), moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
    d.moved = true;
    const s = actions(), from = d.origin.get(d.primary)!, scale = screenPixels();
    let at = from + (e.clientX - d.x) / scale;
    const fixed = [s.playhead, ...s.clips.filter(c => c.timelineId === s.timelineId).flatMap(c => [c.start, c.start + c.duration]), ...markers.filter(m => !d.origin.has(m.id)).map(m => m.time)];
    const hit = snapping ? snapTime([at], fixed, SNAP_PIXELS / scale) : null;
    at = hit ? hit.at : Math.round(at * fps) / fps;
    const shift = Math.max(at - from, -Math.min(...d.origin.values()));
    setDraft(Object.fromEntries([...d.origin].map(([id, time]) => [id, time + shift])));
  };
  const up = (marker: Placed, commit: boolean) => {
    const d = drag.current, moved = draftRef.current;
    drag.current = null; setDraft(null);
    if (!d || !commit) return;
    if (d.moved && moved) actions().setMarkers(markers.map(m => moved[m.id] === undefined ? m : { ...m, time: moved[m.id] }), d.origin.size > 1 ? `moved ${d.origin.size} markers` : `moved marker ${marker.name}`);
    else if (!d.moved) actions().setPlayhead(marker.time);
  };
  const openEditor = (marker: Placed, x: number, y: number, isNew = false) => { setMenu(null); closeRulerMenu(); setEditor({ x, y, marker, isNew }); };
  const targets = (id: string) => actions().selectedMarkerIds.includes(id) ? actions().selectedMarkerIds : [id];
  const point = (e: { clientX: number; clientY: number; currentTarget: Element }) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX || r.left, y: e.clientY || r.bottom }; };
  const fresh = (time: number): Placed => ({ id: '', time, name: `Marker ${markers.length + 1}`, color: users.find(u => u.id === actions().currentUserId)?.color ?? SWATCHES[0] });
  // Menus and the editor sit outside the scrolling ruler on screen but inside it in React, where its events still bubble:
  // a press would scrub the ruler (and capture the pointer, eating the click) and a right-click would open its menu.
  const timeline = anchor.current?.closest<HTMLElement>('.timeline');
  const overlay = (children: ReactNode) => timeline && createPortal(<div style={{ display: 'contents' }} onPointerDown={e => e.stopPropagation()} onPointerMove={e => e.stopPropagation()} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }} onDoubleClick={e => e.stopPropagation()}>{children}</div>, timeline);
  const menuMarker = menu && markers.find(m => m.id === menu.id);

  return <>
    <span ref={anchor} hidden/>
    {comments.map(c => { const author = users.find(u => u.id === c.userId); return <button key={c.id} className="timeline-marker timeline-comment-flag" style={{ left: c.time * pixels, color: author?.color }} title={`${author?.name ?? 'Comment'}: ${c.text}`} aria-label={`Comment by ${author?.name ?? 'someone'} at ${timecode(c.time, fps)}: ${c.text}`}
      onPointerDown={e => e.stopPropagation()} onClick={() => { actions().setPlayhead(c.time); actions().setSidePanel('comments'); }}><MessageSquare size={11} fill="currentColor"/></button>; })}
    {markers.map(m => <button key={m.id} className={`timeline-marker ${selected.includes(m.id) ? 'selected' : ''} ${draft?.[m.id] !== undefined ? 'dragging' : ''}`} style={{ left: (draft?.[m.id] ?? m.time) * pixels, color: m.color }}
      title={`${m.name}${m.note ? `\n${m.note}` : ''}\nDrag to move · double-click to edit`} aria-label={`Marker ${m.name} at ${timecode(m.time, fps)}`} aria-pressed={selected.includes(m.id)}
      onPointerDown={e => down(e, m)} onPointerMove={move} onPointerUp={() => up(m, true)} onPointerCancel={() => up(m, false)} onLostPointerCapture={() => { if (drag.current) up(m, true); }}
      onDoubleClick={e => { const p = point(e); openEditor(m, p.x, p.y); }}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const p = point({ clientX: 0, clientY: 0, currentTarget: e.currentTarget }); openEditor(m, p.x, p.y); } }}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!actions().selectedMarkerIds.includes(m.id)) selectMarkers([m.id]); const p = point(e); closeRulerMenu(); setMenu({ ...p, id: m.id }); }}>
      <Flag size={12} fill="currentColor"/>{m.note && <i className="timeline-marker-note"/>}
    </button>)}
    {menu && menuMarker && overlay(<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      <span className="menu-heading">{targets(menuMarker.id).length > 1 ? `${targets(menuMarker.id).length} markers` : menuMarker.name}</span>
      <button role="menuitem" onClick={() => openEditor(menuMarker, menu.x, menu.y)}><Pencil/>Edit marker…</button>
      <button role="menuitem" onClick={() => { setMenu(null); actions().setPlayhead(menuMarker.time); }}><Play/>Go to marker</button>
      <div className="divider"/>
      <button role="menuitem" onClick={() => { setMenu(null); actions().copyMarkers(targets(menuMarker.id)); }}><Copy/>Copy<kbd>⌘C</kbd></button>
      <button role="menuitem" className="danger-text" onClick={() => { setMenu(null); actions().deleteMarkers(targets(menuMarker.id)); }}><Trash2/>Delete<kbd>⌫</kbd></button>
    </ContextMenu>)}
    {rulerMenu && overlay(<ContextMenu x={rulerMenu.x} y={rulerMenu.y} onClose={closeRulerMenu}>
      <span className="menu-heading">{timecode(rulerMenu.time, fps)}</span>
      <button role="menuitem" onClick={() => openEditor(fresh(rulerMenu.time), rulerMenu.x, rulerMenu.y, true)}><Flag/>Add marker here…</button>
      <button role="menuitem" onClick={() => openEditor(fresh(actions().playhead), rulerMenu.x, rulerMenu.y, true)}><Plus/>Add marker at playhead…<kbd>M</kbd></button>
      {canPaste && <button role="menuitem" onClick={() => { closeRulerMenu(); actions().pasteMarkers(); }}><Clipboard/>Paste markers at playhead<kbd>⌘V</kbd></button>}
    </ContextMenu>)}
    {editor && overlay(<MarkerEditor key={`${editor.marker.id}:${editor.marker.time}`} {...editor} fps={fps} onClose={() => setEditor(null)}/>)}
  </>;
}

function MarkerEditor({ x, y, marker, isNew, fps, onClose }: { x: number; y: number; marker: Placed; isNew: boolean; fps: number; onClose: () => void }) {
  const [name, setName] = useState(marker.name), [note, setNote] = useState(marker.note ?? ''), [color, setColor] = useState(marker.color);
  const form = useRef<HTMLFormElement>(null), closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!form.current?.contains(e.target as Node)) closeRef.current(); };
    document.addEventListener('pointerdown', outside);
    form.current?.querySelector<HTMLInputElement>('input')?.select();
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fields = { name: name.trim() || 'Marker', note, color };
    if (isNew) actions().addMarker({ time: marker.time, ...fields });
    else {
      // Edit the marker as it is now: a collaborator may have moved it while this was open.
      const s = actions(), current = markersOf(s.timelines.find(t => t.id === s.timelineId));
      if (!current.some(m => m.id === marker.id)) s.notify('That marker was deleted', 'info');
      else s.setMarkers(current.map(m => m.id === marker.id ? { ...m, ...fields } : m), `edited marker ${fields.name}`);
    }
    onClose();
  };
  return <form ref={form} className="marker-editor" role="dialog" aria-label={isNew ? 'Add marker' : 'Edit marker'} style={{ left: Math.max(8, Math.min(x, window.innerWidth - 300)), top: Math.max(8, Math.min(y + 10, window.innerHeight - 340)) }}
    onSubmit={submit} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); onClose(); } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }}>
    <header><Flag size={13} fill={color} color={color}/><b>{isNew ? 'Add marker' : 'Edit marker'}</b><span className="mono">{timecode(marker.time, fps)}</span></header>
    <label className="form-field"><span>Name</span><input value={name} maxLength={255} onChange={e => setName(e.target.value)}/></label>
    <label className="form-field"><span>Note</span><textarea value={note} maxLength={5000} rows={3} placeholder="Add a note…" onChange={e => setNote(e.target.value)}/></label>
    <div className="marker-colors" role="radiogroup" aria-label="Marker color">
      {SWATCHES.map(swatch => <button type="button" key={swatch} role="radio" aria-checked={color.toLowerCase() === swatch} aria-label={`Color ${swatch}`} className={color.toLowerCase() === swatch ? 'active' : ''} style={{ background: swatch }} onClick={() => setColor(swatch)}/>)}
      <input type="color" aria-label="Custom marker color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#4f8ef7'} onChange={e => setColor(e.target.value)}/>
    </div>
    <footer>
      {!isNew && <Button variant="ghost" type="button" className="danger-text" onClick={() => { actions().deleteMarkers([marker.id]); onClose(); }}><Trash2 size={12}/>Delete</Button>}
      <span className="spacer"/>
      <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="submit">{isNew ? 'Add marker' : 'Save'}</Button>
    </footer>
  </form>;
}
