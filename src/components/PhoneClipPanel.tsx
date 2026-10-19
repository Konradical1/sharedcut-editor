import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, ArrowRightLeft, Blend, Check, ChevronDown, ChevronUp, Copy, Droplet, Film, FlipHorizontal2, Gauge, Music, Palette, RotateCcw, Move, Scissors, SlidersHorizontal, Snowflake, Trash2, Type, Captions, Rewind, Volume2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore, usePanelPlayhead, usePausedPlayhead } from '../state/store';
import { onPicture } from './LiveTimecode';
import { Filmstrip, clock, mainTrack } from './PhoneTimeline';
import TextInspector, { TextContentEditor } from './TextInspector';
import CaptionInspector from './CaptionInspector';
import Inspector from './Inspector';
import { evaluateClip } from '../services/animation';
import { isTitle } from '../services/text';
import { isCaption } from '../services/captions';
import { isShape } from '../services/shapes';
import { isAdjustment } from '../services/adjustment';
import { transitionDuration, transitionName } from '../services/transitions';
import type { Clip } from '../state/models';

type Tool = 'overview' | 'speed' | 'volume' | 'fade' | 'transition' | 'transform' | 'opacity' | 'text' | 'style' | 'caption' | 'more';
const TRANSITIONS = ['Cross dissolve', 'Dip to black', 'Dip to white', 'Blur dissolve', 'Camera flash', 'Push left', 'Push right', 'Slide over', 'Whip pan', 'Zoom in', 'Spin', 'Linear wipe', 'Iris', 'RGB split'];
const s = useEditorStore.getState;

/** One slider drag is one undo step and holds the collaborative lock on what it changes. */
function useClipEdit() {
  const gesture = useRef<string | undefined>(undefined), held = useRef<{ id: string; key: string }[]>([]), allowed = useRef(true);
  const end = () => { for (const lock of held.current) s().releaseLock(lock.id, lock.key); held.current = []; gesture.current = undefined; allowed.current = true; };
  useEffect(() => end, []);
  const begin = (targets: Clip[], key: string) => {
    end();
    if (!targets.every(c => s().acquireLock(c.id, key))) { for (const c of targets) s().releaseLock(c.id, key); s().notify('Someone else is changing this', 'info'); allowed.current = false; return; }
    held.current = targets.map(c => ({ id: c.id, key })); gesture.current = `phone-${key}-${Date.now()}`;
  };
  const set = (targets: Clip[], key: string, value: number | boolean) => {
    if (!allowed.current) return;
    for (const target of targets) {
      const path = `properties.${key}`, clip = s().clips.find(c => c.id === target.id);
      // An animated property takes a keyframe at the playhead, as the Inspector's own fields do.
      if (clip?.keyframes?.[path]?.length && typeof value === 'number') s().keyframeProperty(target.id, path, value, gesture.current);
      else s().updateProperty(target.id, key, value, gesture.current);
    }
  };
  return { begin, set, end };
}

function Slider({ label, value, min, max, step = 1, display, onBegin, onChange, onEnd }: { label: string; value: number; min: number; max: number; step?: number; display: string; onBegin: () => void; onChange: (value: number) => void; onEnd: () => void }) {
  return <label className="pc-slider"><span><span>{label}</span><b>{display}</b></span>
    <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} aria-label={label} style={{ '--fill': `${(Math.min(max, Math.max(min, value)) - min) / (max - min) * 100}%` } as CSSProperties}
      onPointerDown={onBegin} onKeyDown={e => { if (e.key.startsWith('Arrow')) onBegin(); }} onPointerUp={onEnd} onPointerCancel={onEnd} onKeyUp={onEnd}
      onChange={e => onChange(Number(e.target.value))}/></label>;
}

/** A clip property on a slider; `targets` all take the value (a video and its linked sound for a fade). */
function PropSlider({ targets, prop, label, min, max, step = 1, initial = 0, display }: { targets: Clip[]; prop: string; label: string; min: number; max: number; step?: number; initial?: number; display: (value: number) => string }) {
  const edit = useClipEdit(), clip = targets[0];
  const playhead = usePanelPlayhead(!!clip.keyframes?.[`properties.${prop}`]?.length);
  const value = Number((playhead ? evaluateClip(clip, playhead) : clip).properties[prop] ?? initial);
  return <Slider label={label} value={value} min={min} max={max} step={step} display={display(value)} onBegin={() => edit.begin(targets, prop)} onChange={v => edit.set(targets, prop, v)} onEnd={edit.end}/>;
}

/** Speed on a log scale, 0.1x to 8x: half the travel is slow motion. */
function SpeedSlider({ clip }: { clip: Clip }) {
  const edit = useClipEdit(), speed = Number(clip.properties.speed ?? 100);
  const toSlider = (percent: number) => Math.round(Math.log(percent / 10) / Math.log(80) * 1000), fromSlider = (p: number) => Math.round(10 * 80 ** (p / 1000));
  const label = (percent: number) => `${(percent / 100).toFixed(percent < 100 ? 2 : 1)}x`;
  return <>
    <Slider label="Speed" value={toSlider(speed)} min={0} max={1000} display={label(speed)} onBegin={() => edit.begin([clip], 'speed')} onChange={p => edit.set([clip], 'speed', fromSlider(p))} onEnd={edit.end}/>
    <div className="pc-chips">{[25, 50, 100, 150, 200, 400].map(v => <button key={v} className={speed === v ? 'active' : ''} onClick={() => s().updateProperty(clip.id, 'speed', v)}>{label(v)}</button>)}</div>
  </>;
}

function Toggle({ on, icon, label, onChange }: { on: boolean; icon: ReactNode; label: string; onChange: (on: boolean) => void }) {
  return <button className={`pc-toggle${on ? ' active' : ''}`} aria-pressed={on} onClick={() => onChange(!on)}>{icon}{label}</button>;
}

/** The clip's own picture strip with the playhead on it: scrub inside the clip to find a split point without the timeline. */
function ClipScrubber({ clip }: { clip: Clip }) {
  const asset = useEditorStore(st => st.media.find(m => m.id === clip.mediaId));
  const playing = useEditorStore(st => st.playing), paused = usePausedPlayhead();
  const bar = useRef<HTMLDivElement>(null), head = useRef<HTMLSpanElement>(null), scrubbing = useRef(false);
  const [width, setWidth] = useState(340);
  useLayoutEffect(() => { const el = bar.current!; setWidth(el.clientWidth); const resize = new ResizeObserver(() => setWidth(el.clientWidth)); resize.observe(el); return () => resize.disconnect(); }, []);
  const show = (time: number) => { if (head.current) head.current.style.left = `${Math.min(1, Math.max(0, (time - clip.start) / clip.duration)) * 100}%`; };
  useLayoutEffect(() => { if (paused >= 0) show(paused); }, [paused, clip.start, clip.duration]);
  useEffect(() => playing ? onPicture(show) : undefined, [playing, clip.start, clip.duration]);
  const seek = (x: number) => { const r = bar.current!.getBoundingClientRect(); s().setPlayhead(clip.start + Math.min(.9999, Math.max(0, (x - r.left) / r.width)) * clip.duration); };
  return <div ref={bar} className="pc-scrub" role="slider" aria-label="Position in clip" aria-valuemin={0} aria-valuemax={clip.duration} aria-valuenow={Math.max(0, paused - clip.start)}
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); scrubbing.current = true; s().setPlaying(false); seek(e.clientX); }}
    onPointerMove={e => { if (scrubbing.current) seek(e.clientX); }} onPointerUp={() => { scrubbing.current = false; }} onPointerCancel={() => { scrubbing.current = false; }}>
    {asset?.kind === 'audio' ? <span className="pc-scrub-audio"><Music size={14}/>{clip.name}</span> : <Filmstrip clip={clip} asset={asset} pps={width / clip.duration} height={44}/>}
    <span ref={head} className="pc-scrub-head"/>
  </div>;
}

function TransitionLength({ clip }: { clip: Clip }) {
  const gesture = useRef<string | undefined>(undefined), duration = transitionDuration(clip, 'in');
  return <Slider label="Length" value={duration} min={.1} max={3} step={.05} display={`${duration.toFixed(2)}s`} onBegin={() => { gesture.current = `phone-transition-${Date.now()}`; }} onChange={v => s().updateTransition(clip.id, 'in', { duration: v }, gesture.current)} onEnd={() => { gesture.current = undefined; }}/>;
}

/** The lower panel a tapped clip opens over the timeline: CapCut's clip tools, each with its own controls. Collapsed, only the
 *  tool strip stays and the timeline shows again, with the clip's trim handles. */
export default function PhoneClipPanel({ clip }: { clip: Clip }) {
  const asset = useEditorStore(st => st.media.find(m => m.id === clip.mediaId));
  const track = useEditorStore(st => st.tracks.find(t => t.id === clip.trackId));
  const linkedAudio = useEditorStore(useShallow(st => clip.properties.linkGroup ? st.clips.filter(c => c.id !== clip.id && c.timelineId === clip.timelineId && c.properties.linkGroup === clip.properties.linkGroup && st.tracks.find(t => t.id === c.trackId)?.kind === 'audio') : NONE));
  const fps = useEditorStore(st => st.projects.find(p => p.id === st.projectId)?.fps ?? 24);
  const [tool, setTool] = useState<Tool>(() => isTitle(clip) ? 'text' : 'overview');
  const [collapsed, setCollapsed] = useState(false);
  // A title opens on its text, the thing a tap on one is almost always for.
  useEffect(() => { setTool(isTitle(clip) ? 'text' : 'overview'); }, [clip.id]);
  const audio = track?.kind === 'audio', title = isTitle(clip), caption = isCaption(clip), graphic = isShape(clip) || isAdjustment(clip);
  const image = asset?.kind === 'image', video = !audio && !title && !caption && !graphic;
  const sound = audio ? [clip] : linkedAudio.length ? linkedAudio : video && asset?.hasAudio ? [clip] : NONE;

  const split = () => {
    const at = s().playhead;
    if (at <= clip.start + 1 / fps || at >= clip.start + clip.duration - 1 / fps) { s().notify('Move the playhead inside the clip to split it', 'info'); return; }
    s().splitClip(clip.id);
  };
  // The main track closes up like CapCut's; other lanes keep their timing.
  const remove = () => { const main = mainTrack(s().tracks.filter(t => t.timelineId === clip.timelineId)); s().deleteClip(clip.id, clip.trackId === main?.id); };
  const tools: { id: Tool | 'split' | 'duplicate' | 'delete'; label: string; icon: ReactNode; show: boolean }[] = [
    { id: 'text', label: 'Edit', icon: <Type size={20}/>, show: title },
    { id: 'style', label: 'Style', icon: <Palette size={20}/>, show: title },
    { id: 'caption', label: 'Captions', icon: <Captions size={20}/>, show: caption },
    { id: 'split', label: 'Split', icon: <Scissors size={20}/>, show: !caption },
    { id: 'speed', label: 'Speed', icon: <Gauge size={20}/>, show: (video && !image) || audio },
    { id: 'volume', label: 'Volume', icon: <Volume2 size={20}/>, show: sound.length > 0 },
    { id: 'fade', label: 'Fade', icon: <Blend size={20}/>, show: !caption },
    { id: 'transition', label: 'Transition', icon: <ArrowRightLeft size={20}/>, show: video },
    { id: 'transform', label: 'Transform', icon: <Move size={20}/>, show: video || graphic },
    { id: 'opacity', label: 'Opacity', icon: <Droplet size={20}/>, show: video || graphic },
    { id: 'duplicate', label: 'Duplicate', icon: <Copy size={20}/>, show: !caption },
    { id: 'delete', label: 'Delete', icon: <Trash2 size={20}/>, show: true },
    { id: 'more', label: 'More', icon: <SlidersHorizontal size={20}/>, show: !caption },
  ];
  const run = (id: (typeof tools)[number]['id']) => {
    if (id === 'split') split(); else if (id === 'duplicate') s().duplicateClip(clip.id); else if (id === 'delete') remove(); else { setTool(id); setCollapsed(false); }
  };
  const seconds = (v: number) => `${v.toFixed(1)}s`;
  const visual = video || graphic || title ? [clip] : NONE;
  const transition = transitionName(clip, 'in');
  const body = (() => {
    switch (tool) {
      case 'speed': return <><SpeedSlider clip={clip}/>{video && <div className="pc-row"><Toggle on={Boolean(clip.properties.reverse)} icon={<Rewind size={15}/>} label="Reverse" onChange={v => s().updateProperty(clip.id, 'reverse', v)}/><Toggle on={Boolean(clip.properties.freeze)} icon={<Snowflake size={15}/>} label="Freeze" onChange={v => s().updateProperty(clip.id, 'freeze', v)}/></div>}<p className="pc-note">Speed changes the clip's length.</p></>;
      case 'volume': return <><PropSlider targets={sound} prop="gain" label="Volume" min={-60} max={12} step={.5} display={v => v <= -60 ? 'Muted' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}/><div className="pc-row"><button className="pc-toggle" onClick={() => { for (const c of sound) s().updateProperty(c.id, 'gain', -60); }}>Mute</button><button className="pc-toggle" onClick={() => { for (const c of sound) s().updateProperty(c.id, 'gain', 0); }}><RotateCcw size={15}/>Reset</button></div></>;
      case 'fade': {
        const most = Math.max(.1, Math.min(10, clip.duration / 2));
        return <>
          {visual.length > 0 && <><PropSlider targets={visual} prop="fadeIn" label="Fade in" min={0} max={most} step={.05} display={seconds}/><PropSlider targets={visual} prop="fadeOut" label="Fade out" min={0} max={most} step={.05} display={seconds}/></>}
          {sound.length > 0 && <><PropSlider targets={sound} prop="audioFadeIn" label={visual.length ? 'Sound fade in' : 'Fade in'} min={0} max={most} step={.05} display={seconds}/><PropSlider targets={sound} prop="audioFadeOut" label={visual.length ? 'Sound fade out' : 'Fade out'} min={0} max={most} step={.05} display={seconds}/></>}
        </>;
      }
      case 'transition': return <>
        <p className="pc-note">Into this clip from the one before it.</p>
        <div className="pc-grid"><button className={!transition ? 'active' : ''} onClick={() => s().removeTransition(clip.id, 'in')}>None</button>{TRANSITIONS.map(name => <button key={name} className={transition === name ? 'active' : ''} onClick={() => transition ? s().updateTransition(clip.id, 'in', { name }) : s().addTransition(clip.id, 'in', name)}>{name}</button>)}</div>
        {transition && <TransitionLength clip={clip}/>}
      </>;
      case 'transform': return <>
        <PropSlider targets={[clip]} prop="zoom" label="Scale" min={10} max={400} initial={100} display={v => `${Math.round(v)}%`}/>
        <PropSlider targets={[clip]} prop="x" label="Position X" min={-1920} max={1920} display={v => `${Math.round(v)}`}/>
        <PropSlider targets={[clip]} prop="y" label="Position Y" min={-1080} max={1080} display={v => `${Math.round(v)}`}/>
        <PropSlider targets={[clip]} prop="rotation" label="Rotation" min={-180} max={180} display={v => `${Math.round(v)}°`}/>
        <div className="pc-row"><Toggle on={Boolean(clip.properties.flipH)} icon={<FlipHorizontal2 size={15}/>} label="Flip" onChange={v => s().updateProperty(clip.id, 'flipH', v)}/><button className="pc-toggle" onClick={() => { for (const [key, value] of [['zoom', 100], ['x', 0], ['y', 0], ['rotation', 0]] as const) s().updateProperty(clip.id, key, value); }}><RotateCcw size={15}/>Reset</button></div>
      </>;
      case 'opacity': return <PropSlider targets={[clip]} prop="opacity" label="Opacity" min={0} max={100} initial={100} display={v => `${Math.round(v)}%`}/>;
      case 'text': return <div className="pc-text"><TextContentEditor clipId={clip.id}/></div>;
      case 'style': return <div className="pc-embed"><TextInspector/></div>;
      case 'caption': return <div className="pc-embed"><CaptionInspector key={clip.id} id={clip.id}/></div>;
      case 'more': return <div className="pc-embed pc-more"><Inspector/></div>;
      default: return <>
        {!caption && <ClipScrubber clip={clip}/>}
        <div className="pc-actions">
          {!caption && <button onClick={split}><Scissors size={18}/>Split here</button>}
          {!caption && <button onClick={() => s().duplicateClip(clip.id)}><Copy size={18}/>Duplicate</button>}
          <button className="danger" onClick={remove}><Trash2 size={18}/>Delete</button>
        </div>
      </>;
    }
  })();
  const editing = tool !== 'overview' && !collapsed;
  return <section className={`pc${collapsed ? ' is-collapsed' : ''}`} aria-label="Clip properties">
    <header className="pc-head">
      {editing ? <button className="pc-icon" aria-label="Back to clip" onClick={() => setTool('overview')}><ArrowLeft size={19}/></button> : <span className="pc-kind">{audio ? <Music size={15}/> : title ? <Type size={15}/> : caption ? <Captions size={15}/> : <Film size={15}/>}</span>}
      <div className="pc-title"><b>{editing ? tools.find(t => t.id === tool)?.label : clip.name}</b><small>{clock(clip.start)} · {clip.duration.toFixed(1)}s</small></div>
      <button className="pc-icon pc-collapse" aria-label={collapsed ? 'Show clip tools' : 'Show timeline'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronUp size={20}/> : <ChevronDown size={20}/>}</button>
      <button className="pc-done" aria-label="Done" onClick={() => s().selectClip(null)}><Check size={20}/></button>
    </header>
    {!collapsed && <div className="pc-body" key={tool}>{body}</div>}
    <nav className="pc-tools" aria-label="Clip tools">{tools.filter(t => t.show).map(t => <button key={t.id} className={`${tool === t.id && !collapsed ? 'active' : ''}${t.id === 'delete' ? ' danger' : ''}`} onClick={() => run(t.id)}>{t.icon}<span>{t.label}</span></button>)}</nav>
  </section>;
}
const NONE: Clip[] = [];
