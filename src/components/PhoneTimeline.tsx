import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { Plus, Type, Captions, Shapes, SlidersHorizontal, Gauge } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore, usePausedPlayhead } from '../state/store';
import { onPicture } from './LiveTimecode';
import { Waveform } from './Waveform';
import { filmstripTiles } from '../services/timeline';
import { isTitle, getText, textContent } from '../services/text';
import { isCaption } from '../services/captions';
import { isShape } from '../services/shapes';
import { isAdjustment } from '../services/adjustment';
import type { Clip, MediaAsset, Track } from '../state/models';

const RULER = 26, MAIN = 58, OVERLAY = 38, AUDIO = 32, GAP = 6, MIN_PPS = 2, MAX_PPS = 400;
/** CapCut-style clock: 00:05, 1:02:03 past an hour. */
export const clock = (seconds: number) => { const t = Math.max(0, Math.floor(seconds + 1e-6)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };
/** The lowest video track: the phone timeline's tall filmstrip row, and where new media goes. */
export const mainTrack = (tracks: Track[]) => tracks.filter(t => t.kind === 'video').sort((a, b) => a.number - b.number)[0];
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

export const Filmstrip = memo(function Filmstrip({ clip, asset, pps, height }: { clip: Clip; asset?: MediaAsset; pps: number; height: number }) {
  const frames = asset?.filmstripFrames ?? 0;
  if (!asset?.filmstrip || frames < 2 || !(asset.duration > 0)) return <span className="pt-film" style={{ backgroundImage: asset?.thumbnail ? `url(${asset.thumbnail})` : undefined, backgroundSize: `${height * 16 / 9}px 100%` }}/>;
  const image = `url(${asset.filmstrip})`;
  return <span className="pt-film is-tiled">{filmstripTiles(clip, { duration: asset.duration, frames }, pps, height * 16 / 9, 60).map(({ tile, frame }, i) =>
    <i key={i} style={{ flexBasis: tile, backgroundImage: image, backgroundSize: `${frames * 100}% auto`, backgroundPositionX: `${frame / (frames - 1) * 100}%` }}/>)}</span>;
});

function ClipBody({ clip, asset, pps, height, audio }: { clip: Clip; asset?: MediaAsset; pps: number; height: number; audio: boolean }) {
  const speed = Number(clip.properties.speed ?? 100);
  const badge = speed !== 100 && <span className="pt-badge"><Gauge size={9}/>{(speed / 100).toFixed(speed < 100 ? 2 : 1)}x</span>;
  if (audio) {
    const length = asset?.duration || clip.duration, from = clip.sourceIn / length, to = (clip.sourceIn + clip.duration * speed / 100) / length;
    return <><Waveform samples={asset?.waveform} from={from} to={to} reverse={Boolean(clip.properties.reverse)}/><span className="pt-name">{clip.name}</span>{badge}</>;
  }
  if (isTitle(clip) || isCaption(clip)) { let text = clip.name; try { text = textContent(getText(clip)) || clip.name; } catch { /* a malformed document still shows its name */ } return <><span className="pt-icon">{isCaption(clip) ? <Captions size={11}/> : <Type size={11}/>}</span><span className="pt-name">{text}</span></>; }
  if (isShape(clip) || isAdjustment(clip)) return <><span className="pt-icon">{isShape(clip) ? <Shapes size={11}/> : <SlidersHorizontal size={11}/>}</span><span className="pt-name">{clip.name}</span></>;
  return <><Filmstrip clip={clip} asset={asset} pps={pps} height={height}/>{height < MAIN && <span className="pt-name on-film">{clip.name}</span>}{badge}</>;
}

/** The phone timeline: a fixed centre playhead over lanes that scroll under it, as in CapCut. Scrolling scrubs, a tap selects. */
export default function PhoneTimeline({ onAdd }: { onAdd: () => void }) {
  const clips = useEditorStore(useShallow(s => s.clips.filter(c => c.timelineId === s.timelineId)));
  const tracks = useEditorStore(useShallow(s => s.tracks.filter(t => t.timelineId === s.timelineId)));
  const media = useEditorStore(s => s.media);
  const duration = useEditorStore(s => s.timelines.find(t => t.id === s.timelineId)?.duration ?? 0);
  const selectedId = useEditorStore(s => s.selectedClipId);
  const playing = useEditorStore(s => s.playing);
  const paused = usePausedPlayhead();
  const [pps, setPps] = useState(36);
  const [view, setView] = useState({ left: 0, width: 390 });
  const [trim, setTrim] = useState<{ id: string; start: number; duration: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // The scrollLeft this component last set itself: its scroll event is ours, not a person scrubbing.
  const expected = useRef(-1), touching = useRef(false), ppsRef = useRef(pps);
  ppsRef.current = pps;
  const pad = view.width / 2;
  const s = useEditorStore.getState;

  const place = (time: number) => {
    const el = scroller.current; if (!el) return;
    const x = time * ppsRef.current;
    if (Math.abs(el.scrollLeft - x) < 1) return;
    el.scrollLeft = x; expected.current = el.scrollLeft;
  };
  const publish = (el: HTMLDivElement) => {
    const step = Math.max(40, el.clientWidth / 2), left = Math.floor(el.scrollLeft / step) * step, width = el.clientWidth;
    setView(v => v.left === left && v.width === width ? v : { left, width });
  };
  // Paused, the lanes follow every playhead change from elsewhere (split, undo, the transport). A scrub sets the playhead
  // from scrollLeft, so the match check in place() leaves momentum scrolling alone.
  useLayoutEffect(() => { if (paused >= 0) place(paused); }, [paused, pps, view.width]);
  // Playing, the lanes move with each picture the viewer presents, not with the store's clock.
  useEffect(() => { if (!playing) return; place(s().playhead); return onPicture(time => { if (!touching.current) place(time); }); }, [playing]);
  useLayoutEffect(() => {
    const el = scroller.current!; publish(el);
    const resize = new ResizeObserver(() => publish(el)); resize.observe(el);
    // Pinch to zoom around the centre playhead; two fingers never scroll.
    let pinch: { distance: number; pps: number } | null = null;
    const spread = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const start = (e: TouchEvent) => {
      touching.current = true;
      if (s().playing) s().setPlaying(false);
      if (e.touches.length === 2) pinch = { distance: spread(e), pps: ppsRef.current };
    };
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, pinch.pps * spread(e) / pinch.distance)));
    };
    const end = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; if (!e.touches.length) touching.current = false; };
    el.addEventListener('touchstart', start, { passive: true }); el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', end);
    return () => { resize.disconnect(); el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end); };
  }, []);
  const scrolled = () => {
    const el = scroller.current!; publish(el);
    if (Math.abs(el.scrollLeft - expected.current) < 1) return;
    expected.current = -1;
    const state = s();
    if (state.playing) state.setPlaying(false);
    state.setPlayhead(el.scrollLeft / ppsRef.current);
  };
  // Ctrl-wheel (a trackpad pinch) zooms too, for tablets with a trackpad and desktop testing.
  const wheel = (e: WheelEvent) => { if (e.ctrlKey) setPps(p => Math.min(MAX_PPS, Math.max(MIN_PPS, p * Math.exp(-e.deltaY / 200)))); };

  const main = mainTrack(tracks);
  const rows = useMemo(() => {
    const used = new Set(clips.map(c => c.trackId));
    const video = tracks.filter(t => t.kind === 'video' && (used.has(t.id) || t.id === main?.id)).sort((a, b) => b.number - a.number);
    const audio = tracks.filter(t => t.kind === 'audio' && used.has(t.id)).sort((a, b) => a.number - b.number);
    let top = RULER + 8;
    return [...video, ...audio].map(track => { const height = track.id === main?.id ? MAIN : track.kind === 'audio' ? AUDIO : OVERLAY, row = { track, top, height }; top += height + GAP; return row; });
  }, [clips, tracks, main?.id]);
  const rowOf = new Map(rows.map(r => [r.track.id, r]));
  const contentHeight = (rows.at(-1) ? rows.at(-1)!.top + rows.at(-1)!.height : RULER + MAIN) + 16;
  const end = Math.max(duration, ...clips.map(c => c.start + c.duration));
  const width = end * pps + view.width;
  // Only what is on screen, a screen either side: a long timeline holds hundreds of clips.
  const from = (view.left - view.width - pad) / pps, to = (view.left + view.width * 2.5) / pps;
  const mediaById = useMemo(() => new Map(media.map(m => [m.id, m])), [media]);
  const shown = clips.filter(c => c.start < to && c.start + c.duration > from && rowOf.has(c.trackId));
  const step = RULER_STEPS.find(v => v * pps >= 64) ?? 3600;
  const ticks: number[] = [];
  for (let t = Math.max(0, Math.floor(from / step) * step); t <= Math.min(end + step, to); t += step) ticks.push(t);
  const selected = clips.find(c => c.id === selectedId);
  const rect = (clip: Clip) => trim?.id === clip.id ? trim : clip;

  const drag = useRef<{ x: number; start: number; duration: number; side: 'left' | 'right' } | null>(null);
  const handleDown = (side: 'left' | 'right') => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!selected) return;
    e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: selected.start, duration: selected.duration, side };
  };
  const handleMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current; if (!d || !selected) return;
    const delta = (e.clientX - d.x) / pps;
    const fit = s().fitTrim(selected.id, d.side === 'left' ? d.start + delta : d.start, d.side === 'left' ? d.duration - delta : d.duration + delta);
    if (fit) setTrim({ id: selected.id, ...fit });
  };
  const handleUp = () => {
    const d = drag.current; drag.current = null;
    if (d && trim && selected) s().trimClip(selected.id, trim.start, trim.duration);
    setTrim(null);
  };

  return <div className="pt">
    <div ref={scroller} className="pt-scroll" onScroll={scrolled} onWheel={wheel} onClick={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pt-content')) s().selectClip(null); }}>
      <div className="pt-content" style={{ width, height: contentHeight }}>
        <div className="pt-ruler" style={{ width }}>{ticks.map(t => <span key={t} style={{ left: pad + t * pps }}>{clock(t)}</span>)}{ticks.map(t => <i key={t} style={{ left: pad + (t + step / 2) * pps }}/>)}</div>
        {main && !clips.length && <button className="pt-empty" style={{ left: pad, top: rowOf.get(main.id)!.top, height: MAIN }} onClick={onAdd}><Plus size={18}/>Add media</button>}
        {main && clips.length > 0 && !selected && <div className="pt-add-row" style={{ top: rowOf.get(main.id)!.top, height: MAIN, width }}><button className="pt-add" aria-label="Add media" style={{ left: view.width - 52 }} onClick={onAdd}><Plus size={20}/></button></div>}
        {shown.map(clip => {
          const row = rowOf.get(clip.trackId)!, box = rect(clip), audio = row.track.kind === 'audio', asset = mediaById.get(clip.mediaId);
          const kind = audio ? 'audio' : isTitle(clip) ? 'title' : isCaption(clip) ? 'caption' : isShape(clip) || isAdjustment(clip) ? 'graphic' : row.height === MAIN ? 'main' : 'overlay';
          return <button key={clip.id} className={`pt-clip pt-${kind}${clip.id === selectedId ? ' is-selected' : ''}${clip.disabled || row.track.hidden || row.track.muted && audio ? ' is-off' : ''}`} aria-label={`${clip.name}, ${clock(clip.start)}`} aria-pressed={clip.id === selectedId}
            style={{ left: pad + box.start * pps, width: Math.max(2, box.duration * pps - 1), top: row.top, height: row.height }}
            onClick={e => { e.stopPropagation(); s().selectClip(clip.id); }}>
            <ClipBody clip={clip} asset={asset} pps={pps} height={row.height} audio={audio}/>
          </button>;
        })}
        {selected && rowOf.has(selected.trackId) && (() => { const row = rowOf.get(selected.trackId)!, box = rect(selected); return <div className="pt-selection" style={{ left: pad + box.start * pps - 14, width: box.duration * pps + 28, top: row.top - 2, height: row.height + 4 }}>
          <span className="pt-handle left" role="slider" aria-label="Trim start" aria-valuenow={box.start} onPointerDown={handleDown('left')} onPointerMove={handleMove} onPointerUp={handleUp} onPointerCancel={handleUp}/>
          <span className="pt-handle right" role="slider" aria-label="Trim end" aria-valuenow={box.start + box.duration} onPointerDown={handleDown('right')} onPointerMove={handleMove} onPointerUp={handleUp} onPointerCancel={handleUp}/>
          {trim && <b className="pt-trim-label">{box.duration.toFixed(1)}s</b>}
        </div>; })()}
      </div>
    </div>
    <div className="pt-playhead" aria-hidden="true"/>
  </div>;
}
