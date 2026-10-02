import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowRightLeft, AudioLines, Info, Trash2 } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { useShallow } from 'zustand/react/shallow';
import { alignShare, leakRange, trimLeak, transitionShare, transitionProperty, maximumDuration, timelineTransitions, transitionAligns, transitionDefinitions, type TransitionParams, type TransitionAlign, type TransitionRecord } from '../services/transitions';
import { ContextMenu } from './ui';

/**
 * The bowtie straddling a cut. Dragging an edge changes the duration, dragging the body moves the
 * window across the cut. Both are clamped live to the handles the two clips can actually lend,
 * which is why a transition never needs to move a clip to make room for itself.
 */
export default function TransitionChips({ trackId, timelineId, pixels }: { trackId: string; timelineId: string; pixels: number }) {
  const { clips, media, leaks, selected } = useEditorStore(useShallow(state => ({ clips: state.clips, media: state.media, leaks: state.leaks, selected: state.selectedTransition })));
  const [menu, setMenu] = useState<{ x: number; y: number; record: TransitionRecord } | null>(null);
  const [draft, setDraft] = useState<{ id: string; duration: number; align: TransitionAlign; blendPoint?: number; params?: TransitionParams } | null>(null);
  const drag = useRef<{ record: TransitionRecord; mode: 'left' | 'right' | 'move'; x: number; duration: number; align: TransitionAlign } | null>(null);
  const actions = useEditorStore.getState;

  const all = useMemo(() => timelineTransitions(clips, timelineId, media), [clips, timelineId, media]);
  const records = useMemo(() => { const track = new Set(clips.filter(clip => clip.trackId === trackId).map(clip => clip.id)); return all.filter(record => track.has(record.clipId)); }, [all, clips, trackId]);
  if (!records.length && !menu) return null;

  const start = (event: PointerEvent<HTMLElement>, record: TransitionRecord, mode: 'left' | 'right' | 'move') => {
    // Only the primary button drags. A right-click used to capture the pointer here, which
    // retargeted the next pointerdown to the chip and swallowed the context menu's own click.
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const clip = clips.find(item => item.id === record.clipId);
    if (!clip) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { record, mode, x: event.clientX, duration: record.duration, align: record.align };
    setDraft({ id: record.clipId + record.side, duration: record.duration, align: record.align });
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    const clip = clips.find(item => item.id === state.record.clipId);
    if (!clip) return;
    const delta = (event.clientX - state.x) / Math.max(1, pixels);
    const overlay = transitionDefinitions[state.record.name]?.overlay;
    const share = transitionShare(state.record.name, state.record.params, state.align);
    if (state.mode === 'move' && overlay) {
      const blendPoint = Math.round(Math.max(0, Math.min(1, share - delta / state.duration)) * 100);
      const candidate = { ...clip, properties: { ...clip.properties, [transitionProperty(state.record.side, 'Params')]: JSON.stringify({ ...state.record.params, blendPoint }) } };
      const room = maximumDuration(clips, candidate, state.record.side, state.align, media, true);
      if (room >= state.duration - 1e-6) setDraft({ id: state.record.clipId + state.record.side, duration: state.duration, align: state.align, blendPoint });
      return;
    }
    if (state.mode === 'move') {
      // Three stops rather than free movement: centred, entirely before the cut, entirely after.
      const shifted = alignShare(state.align) - delta / Math.max(.001, state.duration);
      const align = transitionAligns.reduce((best, item) => Math.abs(alignShare(item) - shifted) < Math.abs(alignShare(best) - shifted) ? item : best, state.align);
      const room = maximumDuration(clips, clip, state.record.side, align, media, true);
      if (room >= state.duration - 1e-6) setDraft({ id: state.record.clipId + state.record.side, duration: state.duration, align });
      return;
    }
    if (overlay) {
      const leak = leaks.find(item => item.id === state.record.params.leak);
      if (!leak) return;
      const range = leakRange(state.record.params, leak.duration), rate = range.duration / state.duration;
      const peak = range.start + range.duration * share;
      const minimum = rate / 48;
      const patch: TransitionParams = state.mode === 'left'
        ? { leakIn: Math.max(0, Math.min(peak, range.end - minimum, range.start + delta * rate)) }
        : { leakOut: Math.min(leak.duration, Math.max(peak, range.start + minimum, range.end + delta * rate)) };
      const trimmed = trimLeak(state.record, leak.duration, patch);
      const candidate = { ...clip, properties: { ...clip.properties, [transitionProperty(state.record.side, 'Params')]: JSON.stringify(trimmed.params) } };
      const room = maximumDuration(clips, candidate, state.record.side, state.align, media, true);
      if (trimmed.duration <= room + 1e-6) setDraft({ id: state.record.clipId + state.record.side, align: state.align, ...trimmed });
      return;
    }
    const room = maximumDuration(clips, clip, state.record.side, state.align, media, true);
    const scale = state.mode === 'right' ? 1 : -1;
    const wanted = state.duration + delta * scale * (state.align === 'center' ? 2 : 1);
    setDraft({ id: state.record.clipId + state.record.side, duration: Math.max(1 / 48, Math.min(wanted, room)), align: state.align });
  };
  const finish = (cancel = false) => {
    const state = drag.current;
    drag.current = null;
    const current = draft;
    setDraft(null);
    if (!state || cancel || !current) return;
    if (Math.abs(current.duration - state.record.duration) < 1e-6 && current.align === state.record.align && current.blendPoint === undefined && !current.params) {
      actions().selectTransition(state.record.clipId, state.record.side);
      return;
    }
    actions().updateTransition(state.record.clipId, state.record.side, { duration: current.duration, align: current.align, ...(current.params ? { params: current.params } : current.blendPoint !== undefined ? { params: { blendPoint: current.blendPoint } } : {}) });
  };

  return <>
    {records.map(record => {
      const key = record.clipId + record.side;
      const live = draft?.id === key ? draft : null;
      const duration = live?.duration ?? record.duration;
      const align = live?.align ?? record.align;
      const share = transitionShare(record.name, { ...record.params, ...live?.params, ...(live?.blendPoint !== undefined ? { blendPoint: live.blendPoint } : {}) }, align);
      const from = live ? record.cut - duration * share : record.start;
      const active = selected?.clipId === record.clipId && selected.side === record.side;
      const short = record.requested - record.duration > 1e-3;
      return <div
        key={key}
        className={`transition-chip ${active ? 'selected' : ''} ${short ? 'clamped' : ''} ${transitionDefinitions[record.name]?.overlay ? 'overlay' : ''}`}
        style={{ left: Math.max(0, from) * pixels, width: Math.max(10, duration * pixels) }}
        role="button" tabIndex={0}
        aria-label={`${record.name} transition, ${duration.toFixed(2)} seconds${short ? ', shortened to fit the available handles' : ''}`}
        title={short ? `${record.name} · ${duration.toFixed(2)}s — shortened from ${record.requested.toFixed(2)}s by the available trim handles` : `${record.name} · ${duration.toFixed(2)}s`}
        onPointerDown={event => start(event, record, 'move')}
        onPointerMove={move}
        onPointerUp={() => finish()}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => { if (drag.current) finish(true); }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); actions().selectTransition(record.clipId, record.side); }
          // Stop the key here, or the timeline's own Delete deletes the clip underneath as well.
          if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); actions().removeTransition(record.clipId, record.side); }
        }}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, record }); }}
      >
        <span className="transition-chip-bowtie" aria-hidden="true" style={transitionDefinitions[record.name]?.overlay ? { background: 'none', left: `${Math.max(0, Math.min(100, (record.cut - Math.max(0, from)) / duration * 100))}%`, right: 'auto', borderLeft: '1px solid currentColor' } : undefined} />
        <span className="transition-chip-label">{record.name}</span>
        <span className="transition-chip-edge left" onPointerDown={event => start(event, record, 'left')} onPointerMove={move} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} />
        <span className="transition-chip-edge right" onPointerDown={event => start(event, record, 'right')} onPointerMove={move} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} />
      </div>;
    })}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      <span className="menu-heading">{menu.record.name}</span>
      <button role="menuitem" onClick={() => { actions().selectTransition(menu.record.clipId, menu.record.side); setMenu(null); }}><Info />Transition properties</button>
      {transitionDefinitions[menu.record.name]?.overlay && <button role="menuitem" disabled={!!menu.record.audioClipId} onClick={() => { actions().expandTransitionAudio(menu.record.clipId, menu.record.side); setMenu(null); }}><AudioLines />{menu.record.audioClipId ? 'Sound already on a track' : 'Expand audio to track'}</button>}
      <button role="menuitem" onClick={() => { actions().selectTransition(menu.record.clipId, menu.record.side); actions().notify('Pick a replacement in the Transitions panel', 'info'); setMenu(null); }}><ArrowRightLeft />Replace transition…</button>
      <div className="divider" />
      <button role="menuitem" className="danger-text" onClick={() => { actions().removeTransition(menu.record.clipId, menu.record.side); setMenu(null); }}><Trash2 />Remove transition<kbd>⌫</kbd></button>
    </ContextMenu>}
  </>;
}
