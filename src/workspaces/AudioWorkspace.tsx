import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Activity, AudioLines, ChevronDown, Headphones, ListMusic, Plus, Power, RotateCcw, SlidersHorizontal, Volume2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore, type EditorStore } from '../state/store';
import type { Clip, Track } from '../state/models';
import { Badge, Button, IconButton, NumberInput } from '../components/ui';
import { Property } from '../components/Inspector';
import { audioEffectNames, effectDefinitions, effectValue } from '../services/effects';
import { eqBiquads, responseDb } from '../services/audioDsp';
import Viewer from '../components/Viewer';
import Timeline from '../components/Timeline';
import './workspaces.css';

const effects = audioEffectNames;
const trackColors = ['#b4c6b1', '#a2b0c7', '#c7b790', '#bba5c8'];

type Meters = { tracks: Record<string, number>; master: number; momentary?: number; shortTerm?: number; peak?: number };
/** Meters write straight to their DOM nodes, so React stays idle while playback runs. `null` is idle. */
function useMeters(playing: boolean, draw: (meters: Meters | null) => void) {
  const latest = useRef(draw); latest.current = draw;
  useEffect(() => {
    latest.current(null);
    if (!playing) return;
    const update = (event: Event) => latest.current((event as CustomEvent<Meters>).detail);
    window.addEventListener('frameline:meters', update);
    return () => { window.removeEventListener('frameline:meters', update); latest.current(null); };
  }, [playing]);
}
const decibels = (value: number | undefined, floor: number) => value !== undefined && Number.isFinite(value) && value > floor ? value.toFixed(1) : '−∞';

function LevelMeter({ playing, master = false, trackId }: { playing: boolean; master?: boolean; trackId?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useMeters(playing, meters => {
    const value = meters ? trackId ? meters.tracks[trackId] || 0 : meters.master : 0, level = Number.isFinite(value) ? Math.max(0, value) : 0;
    const fraction = level > .001 ? Math.min(1, Math.max(0, (20 * Math.log10(level) + 60) / 60)) : 0;
    if (!root.current) return;
    root.current.setAttribute('aria-label', level > 0 ? `${(20 * Math.log10(level)).toFixed(1)} dBFS RMS` : 'Audio level meter idle');
    for (const lane of root.current.querySelectorAll<HTMLElement>('.meter-lane span')) lane.style.transform = `scaleY(${fraction})`;
  });
  return <div ref={root} className={`audio-level-meter ${master ? 'master-meter' : ''}`} aria-label="Audio level meter idle"><div className="meter-lane"><span style={{ transform: 'scaleY(0)' }}/></div><div className="meter-lane"><span style={{ transform: 'scaleY(0)' }}/></div></div>;
}

/** RMS of the master plus BS.1770 momentary (400 ms) and short-term (3 s) loudness and the sample peak. */
function MasterLevel({ playing }: { playing: boolean }) {
  const rms = useRef<HTMLElement>(null), momentary = useRef<HTMLElement>(null), shortTerm = useRef<HTMLElement>(null), peak = useRef<HTMLElement>(null);
  useMeters(playing, meters => {
    if (rms.current) rms.current.textContent = decibels(meters?.master ? 20 * Math.log10(meters.master) : undefined, -100);
    if (momentary.current) momentary.current.textContent = decibels(meters?.momentary, -70);
    if (shortTerm.current) shortTerm.current.textContent = decibels(meters?.shortTerm, -70);
    if (peak.current) peak.current.textContent = decibels(meters?.peak ? 20 * Math.log10(meters.peak) : undefined, -100);
  });
  return <><div className="master-loudness"><strong className="mono" ref={rms}>−∞</strong><span>dBFS · RMS</span></div>
    <dl className="master-lufs mono" aria-label="Master loudness"><dt title="Momentary loudness, last 400 ms (EBU R128)">M LUFS</dt><dd ref={momentary}>−∞</dd><dt title="Short-term loudness, last 3 s (EBU R128)">S LUFS</dt><dd ref={shortTerm}>−∞</dd><dt title="Highest sample in the last 3 s, dBFS">Peak</dt><dd ref={peak}>−∞</dd></dl></>;
}

/** The graph for the selected insert, drawn from the values the export uses. */
function ResponseGraph({ effect, value }: { effect: string; value: (key: string) => number }) {
  const line = (points: [number, number][]) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${Math.max(0, Math.min(90, y)).toFixed(1)}`).join('');
  if (effect === 'EQ') {
    // ±15 dB over 20 Hz–20 kHz, log frequency; the export runs these coefficients at 48 kHz.
    const stages = eqBiquads(value('Low cut'), value('Presence'), value('Air'), 48000);
    const x = (f: number) => 280 * Math.log10(f / 20) / 3, y = (f: number) => 45 - 3 * responseDb(stages, f, 48000);
    const curve = line(Array.from({ length: 81 }, (_, i) => { const f = 20 * 1000 ** (i / 80); return [x(f), y(f)]; }));
    return <><path d={`${curve}L280 90L0 90Z`} fill="url(#eq-fill)"/><path d={curve} stroke="#b8d2bf" fill="none" strokeWidth="2"/>{[value('Low cut'), 3000, 10000].map((f, i) => <g key={i}><circle cx={x(f)} cy={Math.max(0, Math.min(90, y(f)))} r="4" fill="#1d2622" stroke="#b8d2bf"/><text x={x(f) - 2} y={Math.max(8, y(f) - 8)} fontSize="8" fill="#9eada4">{i + 1}</text></g>)}</>;
  }
  if (effect === 'Compressor' || effect === 'Limiter') {
    // Static input → output curve, −60…0 dB on both axes.
    const point = (input: number, output: number): [number, number] => [280 * (input + 60) / 60, -90 * output / 60];
    const threshold = value('Threshold'), ceiling = value('Ceiling');
    const points = effect === 'Limiter' ? [point(-60, -60 - threshold), point(ceiling + threshold, ceiling), point(0, ceiling)] : [point(-60, -60), point(threshold, threshold), point(0, threshold - threshold / value('Ratio'))];
    return <><path d="M0 90L280 0" stroke="#69716d" strokeDasharray="4 4"/><path d={line(points)} stroke="#b8d2bf" fill="none" strokeWidth="2"/><circle cx={points[1][0]} cy={Math.max(0, Math.min(90, points[1][1]))} r="4" fill="#b8d2bf"/></>;
  }
  return <>{Array.from({ length: 70 }, (_, i) => <g key={i}><line x1={i * 4} x2={i * 4} y1={45 - (Math.sin(i * 2) + 1) * 16} y2={45 + (Math.sin(i * 2) + 1) * 16} stroke="#53685a"/><line x1={i * 4} x2={i * 4} y1={45 - (Math.sin(i * .3) + 1) * 10} y2={45 + (Math.sin(i * .3) + 1) * 10} stroke="#b8d2bf"/></g>)}</>;
}

// Named fields only: the whole store changes on every playback frame.
const mixerState = (s: EditorStore) => ({ clips: s.clips, playing: s.playing, selectedClipId: s.selectedClipId, settings: s.settings, timelineId: s.timelineId, tracks: s.tracks, addEffect: s.addEffect, selectClip: s.selectClip, setSettings: s.setSettings, updateEffect: s.updateEffect, updateProperty: s.updateProperty, updateTrack: s.updateTrack });
function MixerStrip({ track, index, clip }: { track: Track; index: number; clip?: Clip }) {
  const s = useEditorStore(useShallow(mixerState));
  const color = trackColors[index % trackColors.length];
  const selected = clip?.id === s.selectedClipId;
  return <div className={`mixer-strip ${selected ? 'selected' : ''}`} style={{ '--channel-color': color } as CSSProperties}>
    <button className="mixer-channel-name" onClick={() => clip && s.selectClip(clip.id)}><span className="mono">A{track.number}</span><strong>{track.name}</strong><ChevronDown size={11}/></button>
    <div className="mixer-inserts">{['EQ', index === 0 ? 'Compressor' : index === 1 ? 'Limiter' : 'Audio Noise Reduction'].map(effect => <button key={effect} onClick={() => { if (clip) { s.selectClip(clip.id); if (!clip.effects.some(e => e.name === effect)) s.addEffect(clip.id, effect); } }}><span className={clip?.effects.some(item => item.name === effect && item.enabled && clip.properties[`${effect}_enabled`] !== false) ? 'insert-led' : ''}/>{effect}<SlidersHorizontal size={9}/></button>)}</div>
    <label className="pan-control"><span>L</span><input aria-label={`${track.name} pan`} type="range" min="-100" max="100" value={track.pan} onChange={e => s.updateTrack(track.id, { pan: Number(e.target.value) })}/><span>R</span></label>
    <div className="mixer-pan-value mono">{track.pan === 0 ? 'C' : `${Math.abs(track.pan)} ${track.pan < 0 ? 'L' : 'R'}`}</div>
    <div className="fader-area"><div className="fader-scale mono"><span>+6</span><span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−∞</span></div><input className="channel-fader" type="range" min="-60" max="6" step=".1" value={track.gain} onChange={e => s.updateTrack(track.id, { gain: Number(e.target.value) })} aria-label={`${track.name} gain`}/><LevelMeter trackId={track.id} playing={s.playing && !track.muted && (!s.tracks.some(t => t.timelineId === track.timelineId && t.solo && !t.muted) || track.solo)}/></div>
    <label className="channel-gain"><NumberInput aria-label={`${track.name} gain in decibels`} min={-60} max={6} step={.1} decimals={1} value={track.gain} onCommit={gain => s.updateTrack(track.id, { gain })}/><span>dB</span></label>
    <div className="channel-buttons"><button className={track.muted ? 'muted-active' : ''} aria-label={`Mute ${track.name}`} aria-pressed={track.muted} onClick={() => s.updateTrack(track.id, { muted: !track.muted })}>M</button><button className={track.solo ? 'solo-active' : ''} aria-label={`Solo ${track.name}`} aria-pressed={track.solo} onClick={() => s.updateTrack(track.id, { solo: !track.solo })}>S</button><button aria-label={`Inspect ${track.name}`} onClick={() => clip && s.selectClip(clip.id)}><Headphones size={12}/></button></div>
  </div>;
}

export default function AudioWorkspace() {
  const s = useEditorStore(useShallow(mixerState));
  const [effect, setEffect] = useState('EQ');
  const masterGain = Number(s.settings.masterGain ?? 0);
  const masterMuted = Boolean(s.settings.masterMuted);
  const monitor = s.settings.monitorAudio !== false;
  const setMasterGain = (value: number) => Number.isFinite(value) && s.setSettings({ masterGain: Math.max(-60, Math.min(6, value)) });
  const setMasterMuted = (value: boolean) => s.setSettings({ masterMuted: value });
  const setMonitor = (value: boolean) => s.setSettings({ monitorAudio: value });
  const [showInserts, setShowInserts] = useState(true);
  const audioTracks = s.tracks.filter(t => t.timelineId === s.timelineId && t.kind === 'audio');
  const audioClips = s.clips.filter(c => audioTracks.some(t => t.id === c.trackId));
  const clip = audioClips.find(c => c.id === s.selectedClipId) || audioClips[0];
  const appliedEffect = clip?.effects.find(item => item.name === effect);
  const effectEnabled = Boolean(appliedEffect?.enabled && clip?.properties[`${effect}_enabled`] !== false);
  const parameter = (key: string) => appliedEffect && clip ? effectValue(clip, appliedEffect, key) : effectDefinitions[effect]?.parameters.find(p => p.key === key)?.initial ?? 0;
  const addEffect = () => { if (!clip) return; s.selectClip(clip.id); if (!appliedEffect) s.addEffect(clip.id, effect); s.updateProperty(clip.id, `${effect}_enabled`, true); };
  const toggleEffect = () => { if (!clip) return; if (!appliedEffect) addEffect(); else s.updateEffect(clip.id, appliedEffect.id, {enabled: !effectEnabled}); };

  return <div className="audio-workspace special-workspace">
    <div className="audio-top"><div className="audio-viewer"><Viewer compact/><div className="audio-monitor-bar"><Headphones size={13}/><span>Studio monitoring</span><span className="spacer"/><button onClick={() => setMonitor(!monitor)} className={monitor ? 'active' : ''}>{monitor ? 'On' : 'Off'}</button><span>48 kHz · 24-bit</span></div></div>
      <section className={`panel audio-mixer ${showInserts ? '' : 'hide-inserts'}`}><div className="panel-header"><SlidersHorizontal size={14}/><span>Track mixer</span><Badge>{audioTracks.length} channels</Badge><span className="spacer"/><Button variant="ghost" onClick={() => setShowInserts(!showInserts)}>Inserts <ChevronDown size={12}/></Button><IconButton label="Reset all mixer channels" onClick={() => audioTracks.forEach(t => s.updateTrack(t.id, { gain: 0, pan: 0, muted: false, solo: false }))}><RotateCcw size={13}/></IconButton></div><div className="mixer-channels">{audioTracks.map((track, i) => <MixerStrip key={track.id} track={track} index={i} clip={audioClips.find(c => c.trackId === track.id)}/>)}
        <div className="mixer-strip master-strip"><div className="mixer-channel-name"><Volume2 size={13}/><strong>Master</strong></div><div className="mixer-inserts"><button onClick={() => { setEffect('Limiter'); if (clip) s.selectClip(clip.id); }}><span className="insert-led"/>Limiter<SlidersHorizontal size={9}/></button><span className="master-route">All tracks → Output</span></div><MasterLevel playing={s.playing && !masterMuted && monitor}/><div className="fader-area"><div className="fader-scale mono"><span>+6</span><span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−∞</span></div><input className="channel-fader" type="range" min="-60" max="6" step=".1" value={masterGain} onChange={e => setMasterGain(Number(e.target.value))} aria-label="Master output gain"/><LevelMeter master playing={s.playing && !masterMuted && monitor}/></div><label className="channel-gain"><NumberInput aria-label="Master gain in decibels" min={-60} max={6} step={.1} decimals={1} value={masterGain} onCommit={setMasterGain}/><span>dB</span></label><div className="channel-buttons"><button className={masterMuted ? 'muted-active' : ''} aria-pressed={masterMuted} aria-label="Mute master output" onClick={() => setMasterMuted(!masterMuted)}>M</button><span className="master-label">MAIN OUT</span></div></div>
      </div><div className="mixer-footer"><span><span className="tiny-dot"/> {s.playing ? 'Monitoring timeline' : 'Ready to monitor'}</span><span>RMS · BS.1770 loudness meters</span></div></section>
    </div>
    <div className="audio-bottom"><div className="audio-timeline"><Timeline audioOnly/><div className="audio-session-notes"><AudioLines size={15}/><div><strong>Give the city its voice.</strong><span>Dialogue, score, and the sounds in between.</span></div><span className="spacer"/><Badge>Mix 01</Badge><span className="mono">48,000 Hz</span></div></div>
      <section className="panel audio-effects" data-cursor-clip={clip?.id} data-cursor-context={effect}><div className="panel-header"><Activity size={14}/><span>Audio inspector</span><span className="spacer"/><Badge>DSP</Badge></div><div className="audio-inspected-clip"><ListMusic size={15}/><div><strong>{clip?.name || 'No audio selected'}</strong><span>{audioTracks.find(t => t.id === clip?.trackId)?.name || 'Select an audio clip'}</span></div></div><div className="audio-effect-tabs">{effects.map(name => <button key={name} className={effect === name ? 'active' : ''} onClick={() => setEffect(name)}>{name}</button>)}</div><div className="audio-effect-content"><div className="audio-effect-heading"><Power size={12}/><strong>{effect === 'EQ' ? 'Parametric EQ' : effect}</strong><span className="spacer"/><button className={`effect-toggle ${effectEnabled ? 'on' : ''}`} role="switch" aria-checked={effectEnabled} aria-label={`Enable ${effect}`} disabled={!clip} onClick={toggleEffect}><span/></button></div><div className={`audio-effect-graph ${!effectEnabled ? 'bypassed' : ''}`}><svg viewBox="0 0 280 90" role="img" aria-label={`${effect} ${effect === 'Audio Noise Reduction' ? 'illustration' : 'response'}`}><defs><linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#aac8b2" stopOpacity=".17"/><stop offset="1" stopColor="#aac8b2" stopOpacity="0"/></linearGradient></defs>{[18, 45, 72].map(y => <line key={y} x1="0" y1={y} x2="280" y2={y} stroke="#303738" strokeDasharray="3 3"/>)}{[93.3, 186.7].map(x => <line key={x} x1={x} y1="0" x2={x} y2="90" stroke="#303738"/>)}<ResponseGraph effect={effect} value={parameter}/></svg><small className="muted">{effect === 'EQ' ? '±15 dB · the exported response' : effect === 'Audio Noise Reduction' ? 'Illustration' : 'Static curve · input → output'}</small><div className="eq-frequencies mono"><span>{effect === 'EQ' ? '20 Hz' : '−60'}</span><span>{effect === 'EQ' ? '200' : '−40'}</span><span>{effect === 'EQ' ? '2k' : '−20'}</span><span>{effect === 'EQ' ? '20k' : '0 dB'}</span></div></div><div className="audio-effect-parameters">{appliedEffect&&clip&&effectDefinitions[effect].parameters.filter(p=>p.key!=='amount').map(p=><Property key={`${appliedEffect.id}-${p.key}`} clipId={clip.id} effectId={appliedEffect.id} name={p.key} label={p.label} initial={p.initial} min={p.min} max={p.max} step={p.step} suffix={p.suffix}/>)}</div><div className="audio-stack-summary"><span className="muted">{clip?.effects.length || 0} {clip?.effects.length === 1 ? 'effect' : 'effects'} on this clip</span><Button variant="ghost" disabled={!clip || clip.effects.some(e => e.name === effect)} onClick={addEffect}><Plus size={12}/>{clip?.effects.some(e => e.name === effect) ? 'Added to stack' : 'Add effect'}</Button></div></div></section>
    </div>
  </div>;
}
