import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Activity, AudioLines, ChevronDown, Headphones, ListMusic, Plus, Power, RotateCcw, SlidersHorizontal, Volume2 } from 'lucide-react';
import { useEditorStore } from '../state/store';
import type { Clip, Track } from '../state/models';
import { Badge, Button, IconButton, NumberInput } from '../components/ui';
import { Property } from '../components/Inspector';
import { effectDefinitions } from '../services/effects';
import Viewer from '../components/Viewer';
import Timeline from '../components/Timeline';
import './workspaces.css';

const effects = ['EQ', 'Compressor', 'Limiter', 'Noise Reduction'];
const trackColors = ['#b4c6b1', '#a2b0c7', '#c7b790', '#bba5c8'];

function useMeterLevel(playing: boolean, trackId?: string) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!playing) { setLevel(0); return; }
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ tracks: Record<string, number>; master: number }>).detail;
      const value = trackId ? detail.tracks[trackId] || 0 : detail.master;
      setLevel(Number.isFinite(value) ? Math.max(0, value) : 0);
    };
    window.addEventListener('frameline:meters', update);
    return () => window.removeEventListener('frameline:meters', update);
  }, [playing, trackId]);
  return playing ? level : 0;
}

function LevelMeter({ playing, master = false, trackId }: { playing: boolean; master?: boolean; trackId?: string }) {
  const level = useMeterLevel(playing, trackId);
  const fraction = level > .001 ? Math.min(1, Math.max(0, (20 * Math.log10(level) + 60) / 60)) : 0;
  return <div className={`audio-level-meter ${master ? 'master-meter' : ''}`} aria-label={level > 0 ? `${(20 * Math.log10(level)).toFixed(1)} dBFS RMS` : 'Audio level meter idle'}><div className="meter-lane"><span style={{ transform: `scaleY(${fraction})` }}/></div><div className="meter-lane"><span style={{ transform: `scaleY(${fraction})` }}/></div></div>;
}

function MasterLevel({ playing }: { playing: boolean }) {
  const level = useMeterLevel(playing);
  return <div className="master-loudness"><strong className="mono">{level > .00001 ? (20 * Math.log10(level)).toFixed(1) : '−∞'}</strong><span>dBFS · RMS</span></div>;
}

function MixerStrip({ track, index, clip }: { track: Track; index: number; clip?: Clip }) {
  const s = useEditorStore();
  const color = trackColors[index % trackColors.length];
  const selected = clip?.id === s.selectedClipId;
  return <div className={`mixer-strip ${selected ? 'selected' : ''}`} style={{ '--channel-color': color } as CSSProperties}>
    <button className="mixer-channel-name" onClick={() => clip && s.selectClip(clip.id)}><span className="mono">A{track.number}</span><strong>{track.name}</strong><ChevronDown size={11}/></button>
    <div className="mixer-routing">Stereo <ChevronDown size={9}/></div>
    <div className="mixer-inserts">{['EQ', index === 0 ? 'Compressor' : index === 1 ? 'Limiter' : 'Noise Reduction'].map(effect => <button key={effect} onClick={() => { if (clip) { s.selectClip(clip.id); if (!clip.effects.some(e => e.name === effect)) s.addEffect(clip.id, effect); } }}><span className={clip?.effects.some(item => item.name === effect && item.enabled && clip.properties[`${effect}_enabled`] !== false) ? 'insert-led' : ''}/>{effect}<SlidersHorizontal size={9}/></button>)}</div>
    <label className="pan-control"><span>L</span><input aria-label={`${track.name} pan`} type="range" min="-100" max="100" value={track.pan} onChange={e => s.updateTrack(track.id, { pan: Number(e.target.value) })}/><span>R</span></label>
    <div className="mixer-pan-value mono">{track.pan === 0 ? 'C' : `${Math.abs(track.pan)} ${track.pan < 0 ? 'L' : 'R'}`}</div>
    <div className="fader-area"><div className="fader-scale mono"><span>+6</span><span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−∞</span></div><input className="channel-fader" type="range" min="-60" max="6" step=".1" value={track.gain} onChange={e => s.updateTrack(track.id, { gain: Number(e.target.value) })} aria-label={`${track.name} gain`}/><LevelMeter trackId={track.id} playing={s.playing && !track.muted && (!s.tracks.some(t => t.timelineId === track.timelineId && t.solo && !t.muted) || track.solo)}/></div>
    <label className="channel-gain"><NumberInput aria-label={`${track.name} gain in decibels`} min={-60} max={6} step={.1} decimals={1} value={track.gain} onCommit={gain => s.updateTrack(track.id, { gain })}/><span>dB</span></label>
    <div className="channel-buttons"><button className={track.muted ? 'muted-active' : ''} aria-label={`Mute ${track.name}`} aria-pressed={track.muted} onClick={() => s.updateTrack(track.id, { muted: !track.muted })}>M</button><button className={track.solo ? 'solo-active' : ''} aria-label={`Solo ${track.name}`} aria-pressed={track.solo} onClick={() => s.updateTrack(track.id, { solo: !track.solo })}>S</button><button aria-label={`Inspect ${track.name}`} onClick={() => clip && s.selectClip(clip.id)}><Headphones size={12}/></button></div>
  </div>;
}

export default function AudioWorkspace() {
  const s = useEditorStore();
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
  const addEffect = () => { if (!clip) return; s.selectClip(clip.id); if (!appliedEffect) s.addEffect(clip.id, effect); s.updateProperty(clip.id, `${effect}_enabled`, true); };
  const toggleEffect = () => { if (!clip) return; if (!appliedEffect) addEffect(); else s.updateEffect(clip.id, appliedEffect.id, {enabled: !effectEnabled}); };

  return <div className="audio-workspace special-workspace">
    <div className="audio-top"><div className="audio-viewer"><Viewer compact/><div className="audio-monitor-bar"><Headphones size={13}/><span>Studio monitoring</span><span className="spacer"/><button onClick={() => setMonitor(!monitor)} className={monitor ? 'active' : ''}>{monitor ? 'On' : 'Off'}</button><span>48 kHz · 24-bit</span></div></div>
      <section className={`panel audio-mixer ${showInserts ? '' : 'hide-inserts'}`}><div className="panel-header"><SlidersHorizontal size={14}/><span>Track mixer</span><Badge>{audioTracks.length} channels</Badge><span className="spacer"/><Button variant="ghost" onClick={() => setShowInserts(!showInserts)}>Inserts <ChevronDown size={12}/></Button><IconButton label="Reset all mixer channels" onClick={() => audioTracks.forEach(t => s.updateTrack(t.id, { gain: 0, pan: 0, muted: false, solo: false }))}><RotateCcw size={13}/></IconButton></div><div className="mixer-channels">{audioTracks.map((track, i) => <MixerStrip key={track.id} track={track} index={i} clip={audioClips.find(c => c.trackId === track.id)}/>)}
        <div className="mixer-strip master-strip"><div className="mixer-channel-name"><Volume2 size={13}/><strong>Master</strong></div><div className="mixer-routing">Stereo out <ChevronDown size={9}/></div><div className="mixer-inserts"><button onClick={() => { setEffect('Limiter'); if (clip) s.selectClip(clip.id); }}><span className="insert-led"/>Limiter<SlidersHorizontal size={9}/></button><span className="master-route">All tracks → Output</span></div><MasterLevel playing={s.playing && !masterMuted && monitor}/><div className="fader-area"><div className="fader-scale mono"><span>+6</span><span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−∞</span></div><input className="channel-fader" type="range" min="-60" max="6" step=".1" value={masterGain} onChange={e => setMasterGain(Number(e.target.value))} aria-label="Master output gain"/><LevelMeter master playing={s.playing && !masterMuted && monitor}/></div><label className="channel-gain"><NumberInput aria-label="Master gain in decibels" min={-60} max={6} step={.1} decimals={1} value={masterGain} onCommit={setMasterGain}/><span>dB</span></label><div className="channel-buttons"><button className={masterMuted ? 'muted-active' : ''} aria-pressed={masterMuted} aria-label="Mute master output" onClick={() => setMasterMuted(!masterMuted)}>M</button><span className="master-label">MAIN OUT</span></div></div>
      </div><div className="mixer-footer"><span><span className="tiny-dot"/> {s.playing ? 'Monitoring timeline' : 'Ready to monitor'}</span><span>Live RMS meters · server mastering</span></div></section>
    </div>
    <div className="audio-bottom"><div className="audio-timeline"><Timeline audioOnly/><div className="audio-session-notes"><AudioLines size={15}/><div><strong>Give the city its voice.</strong><span>Dialogue, score, and the sounds in between.</span></div><span className="spacer"/><Badge>Mix 01</Badge><span className="mono">48,000 Hz</span></div></div>
      <section className="panel audio-effects" data-cursor-clip={clip?.id} data-cursor-context={effect}><div className="panel-header"><Activity size={14}/><span>Audio inspector</span><span className="spacer"/><Badge>DSP</Badge></div><div className="audio-inspected-clip"><ListMusic size={15}/><div><strong>{clip?.name || 'No audio selected'}</strong><span>{audioTracks.find(t => t.id === clip?.trackId)?.name || 'Select an audio clip'} · Stereo</span></div></div><div className="audio-effect-tabs">{effects.map(name => <button key={name} className={effect === name ? 'active' : ''} onClick={() => setEffect(name)}>{name}</button>)}</div><div className="audio-effect-content"><div className="audio-effect-heading"><Power size={12}/><strong>{effect === 'EQ' ? 'Parametric EQ' : effect}</strong><span className="spacer"/><button className={`effect-toggle ${effectEnabled ? 'on' : ''}`} role="switch" aria-checked={effectEnabled} aria-label={`Enable ${effect}`} disabled={!clip} onClick={toggleEffect}><span/></button></div><div className={`audio-effect-graph ${!effectEnabled ? 'bypassed' : ''}`}><svg viewBox="0 0 280 90" role="img" aria-label={`${effect} response illustration`}><defs><linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#aac8b2" stopOpacity=".17"/><stop offset="1" stopColor="#aac8b2" stopOpacity="0"/></linearGradient></defs>{[18, 45, 72].map(y => <line key={y} x1="0" y1={y} x2="280" y2={y} stroke="#303738" strokeDasharray="3 3"/>)}{[35, 80, 130, 180, 230].map(x => <line key={x} x1={x} y1="0" x2={x} y2="90" stroke="#303738"/>)}{effect === 'EQ' ? <><path d="M0 90C25 90 17 45 48 45S77 55 104 45S150 23 182 34S220 34 280 25V90Z" fill="url(#eq-fill)"/><path d="M0 90C25 90 17 45 48 45S77 55 104 45S150 23 182 34S220 34 280 25" stroke="#b8d2bf" fill="none" strokeWidth="2"/>{[[38, 48], [82, 49], [150, 34], [240, 29]].map(([x, y], i) => <g key={i}><circle cx={x} cy={y} r="4" fill="#1d2622" stroke="#b8d2bf"/><text x={x - 2} y={y - 8} fontSize="8" fill="#9eada4">{i + 1}</text></g>)}</> : effect === 'Compressor' || effect === 'Limiter' ? <><path d="M0 90L280 0" stroke="#69716d" strokeDasharray="4 4"/><path d={effect === 'Limiter' ? 'M0 90L155 26L280 26' : 'M0 90L150 38L280 19'} stroke="#b8d2bf" fill="none" strokeWidth="2"/><circle cx="150" cy={effect === 'Limiter' ? '26' : '38'} r="4" fill="#b8d2bf"/></> : <>{Array.from({ length: 70 }, (_, i) => <g key={i}><line x1={i * 4} x2={i * 4} y1={45 - (Math.sin(i * 2) + 1) * 16} y2={45 + (Math.sin(i * 2) + 1) * 16} stroke="#53685a"/><line x1={i * 4} x2={i * 4} y1={45 - (Math.sin(i * .3) + 1) * 10} y2={45 + (Math.sin(i * .3) + 1) * 10} stroke="#b8d2bf"/></g>)}</>}</svg><small className="muted">Response illustration</small><div className="eq-frequencies mono"><span>{effect === 'EQ' ? '20 Hz' : '−60'}</span><span>{effect === 'EQ' ? '200' : '−36'}</span><span>{effect === 'EQ' ? '2k' : '−18'}</span><span>{effect === 'EQ' ? '20k' : '0 dB'}</span></div></div><div className="audio-effect-parameters">{appliedEffect&&clip&&effectDefinitions[effect].parameters.filter(p=>!['amount','temporal'].includes(p.key)).map(p=><Property key={`${appliedEffect.id}-${p.key}`} clipId={clip.id} effectId={appliedEffect.id} name={p.key} label={p.label} initial={p.initial} min={p.min} max={p.max} step={p.step} suffix={p.suffix}/>)}</div><div className="audio-stack-summary"><span className="muted">{clip?.effects.length || 0} {clip?.effects.length === 1 ? 'effect' : 'effects'} on this clip</span><Button variant="ghost" disabled={!clip || clip.effects.some(e => e.name === effect)} onClick={addEffect}><Plus size={12}/>{clip?.effects.some(e => e.name === effect) ? 'Added to stack' : 'Add effect'}</Button></div></div></section>
    </div>
  </div>;
}
