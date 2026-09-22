import { footageSummary, retryFootage, useFootageVersion } from '../services/footageCache';
import SmartMaskOverlay from './SmartMaskOverlay';
import TextOverlay from './TextOverlay';
import ShapeOverlay from './ShapeOverlay';
import { refreshFonts, useFonts, detectLocalFonts } from '../services/fonts';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SkipBack, SkipForward, Play, Pause, ChevronLeft, ChevronRight, Volume2, VolumeX, Maximize, Scan, Settings2, Columns2, Radio } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { attachPlayback, projectSize, type PlaybackStatus } from '../services/playback';
import { IconButton, timecode } from './ui';

/**
 * Streaming is the default, and deliberately not the sharpest option. The all-intra proxies hold
 * every frame as a keyframe so a scrub lands instantly, which also makes the full one run about
 * 80 Mbit/s — fine across the room, impossible across the internet. Anyone who needs frame-accurate
 * picture on the LAN can still pick one.
 */
const viewerQuality = (preference: unknown) => preference === 'Quarter resolution' ? '1/4' : preference === 'Half resolution' ? '1/2' : preference === 'Full resolution' ? 'Full' : 'Stream';

function FootageLoading({ retry }: { retry: () => void }) {
  useFootageVersion();
  const { entries, transferred, speed, active } = footageSummary();
  const ready = entries.filter(entry => entry.state === 'green').length;
  const failures = entries.some(entry => entry.state === 'red');
  return <details className="footage-loading">
    <summary>{failures ? 'Media needs attention' : active ? 'Loading footage' : 'Footage on this computer'} <span>{ready}/{entries.length} cached</span></summary>
    <div className="footage-loading-body">
      <p>Footage saves automatically as you edit. Green means saved on this computer. Playback preparation is shown separately.</p>
      <div className="footage-legend"><span className="gray">Queued</span><span className="blue">Downloading</span><span className="yellow">Waiting / processing</span><span className="green">Cached</span><span className="red">Failed</span></div>
      <p>{(transferred / 1e6).toFixed(1)} MB transferred this session{active && speed > 0 ? ` · ${(speed / 1e6).toFixed(1)} MB/s average` : ''}</p>
      <ul>{entries.map(entry => <li key={entry.id}><strong>{entry.name}</strong><span className={entry.state}>{entry.detail}</span>{entry.playback && <span className={entry.playback.failed?'red':'yellow'}>{entry.playback.detail}</span>}{entry.total > 0 && <><progress value={entry.progress} max={100} aria-label={`${entry.name} cached`} /><small>{(entry.cached / 1e6).toFixed(1)} / ~{(entry.total / 1e6).toFixed(1)} MB</small></>}</li>)}</ul>
      {!entries.length && <p>No cacheable footage in this view. Originals and images may still be streaming.</p>}
      <button onClick={retry}>Retry media</button>
    </div>
  </details>;
}

export default function Viewer({ compact = false, colorAccurate=false }: { compact?: boolean; colorAccurate?:boolean }) {
  const fontsRevision = useFonts(s => s.revision);
  useEffect(() => { detectLocalFonts(); void refreshFonts(); const timer = setInterval(() => void refreshFonts(), 15000); return () => clearInterval(timer); }, []);
  // The shared overlay pack is needed to draw a light-leak transition, not only to browse one.
  const loadLeaks = useEditorStore(s => s.loadLeaks);
  useEffect(() => { loadLeaks(); }, [loadLeaks]);
  const project = useEditorStore(s => s.projects.find(p => p.id === s.projectId));
  const timelineId = useEditorStore(s => s.timelineId);
  const clips = useEditorStore(s => s.clips);
  const playhead = useEditorStore(s => s.playhead);
  const playing = useEditorStore(s => s.playing);
  const setPlaying = useEditorStore(s => s.setPlaying);
  const setPlayhead = useEditorStore(s => s.setPlayhead);
  const liveMode = useEditorStore(s => s.liveMode);
  const followUserId = useEditorStore(s => s.followUserId);
  const users = useEditorStore(s => s.users);
  const preferredQuality = useEditorStore(s => s.settings.viewerQuality);
  const preferredSource = useEditorStore(s => s.settings.preferredSource);
  const [quality, setQuality] = useState(() => colorAccurate?'Color':viewerQuality(preferredQuality));
  const [zoom, setZoom] = useState('Fit');
  const [safe, setSafe] = useState(false);
  const [compare, setCompare] = useState(false);
  const [original, setOriginal] = useState(preferredSource === 'Camera original');
  const [volume, setVolume] = useState(80);
  const [settings, setSettings] = useState(false);
  const [status, setStatus] = useState<PlaybackStatus>(null);
  const [fitWidth, setFitWidth] = useState(1);
  const ref = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playback = useRef<ReturnType<typeof attachPlayback> | null>(null);
  const options = useRef({ quality, original, volume, compare, fontsRevision });
  options.current = { quality, original, volume, compare, fontsRevision };
  useEffect(() => { setQuality(colorAccurate?'Color':viewerQuality(preferredQuality)); }, [preferredQuality,colorAccurate]);
  useEffect(() => { setOriginal(preferredSource === 'Camera original'); }, [preferredSource]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setFitWidth(Math.max(1, entries[0].contentRect.width)));
    observer.observe(canvas.current!.parentElement!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const engine = attachPlayback(canvas.current!, () => { const state=useEditorStore.getState();return state.clipPreview || state.textPreview.length ? {...state,renderPreviewAllowed:false,clips:state.clips.map(clip=>state.textPreview.find(c=>c.id===clip.id)??(clip.id===state.clipPreview?.id?state.clipPreview:clip))} : state; }, () => options.current, value => { setStatus(value); useEditorStore.setState({ playbackBuffering: !!(value?.loading || value?.error) }); });
    playback.current = engine;
    const gesture = (event: Event) => {
      if (event instanceof KeyboardEvent && (event.code !== 'Space' || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable],dialog[open]'))) return;
      engine.resume();
    };
    document.addEventListener('pointerdown', gesture, { passive: true });
    document.addEventListener('keydown', gesture);
    return () => { document.removeEventListener('pointerdown', gesture); document.removeEventListener('keydown', gesture); engine.dispose(); playback.current = null; useEditorStore.setState({ playbackBuffering: false }); };
  }, []);
  useEffect(() => { if (playing) playback.current?.resume(); }, [playing]);
  const fps = project?.fps ?? 24;
  const [width, height] = projectSize(project?.resolution ?? '1920 × 1080');
  const navigateEdit = (direction: number) => {
    const times = [...new Set(clips.filter(c => c.timelineId === timelineId).flatMap(c => [c.start, c.start + c.duration]))].sort((a, b) => a - b);
    const duration = useEditorStore.getState().timelines.find(t => t.id === timelineId)?.duration ?? 0;
    setPlayhead(direction > 0 ? times.find(t => t > playhead + .5 / fps) ?? duration : times.reverse().find(t => t < playhead - .5 / fps) ?? 0);
  };
  const lockedPlayback = liveMode === 'following';
  const blockingStatus = status && (status.error || status.loading || status.title === 'No picture at playhead');
  const retry = () => { retryFootage(); playback.current?.retry(); };
  return <section ref={ref} className={`viewer panel ${compact ? 'viewer-compact' : ''}`} aria-label="Video viewer">
    <header className="viewer-header"><div className="row"><span className="viewer-sequence-dot"/><span>{compact ? 'Program monitor' : 'Timeline viewer'}</span><span className="viewer-divider">/</span><span className="muted">{project?.name}</span></div><div className="row"><select aria-label="Viewer zoom" value={zoom} onChange={e => setZoom(e.target.value)}><option>Fit</option><option>50%</option><option>100%</option><option>150%</option></select><IconButton label="Viewer settings" className={settings ? 'active' : ''} onClick={() => setSettings(!settings)}><Settings2 size={15}/></IconButton></div></header>
    <FootageLoading retry={retry}/>
    <div className="viewer-stage">
      <SmartMaskOverlay/>
      <div className="viewer-frame" style={{ '--frame-ratio': width / height, transform: zoom === 'Fit' ? undefined : `scale(${width * parseInt(zoom) / 100 / fitWidth})` } as CSSProperties}>
        <canvas ref={canvas} role="img" aria-label={`Timeline picture at ${timecode(playhead, fps)}`}/>
        <TextOverlay/>
        <ShapeOverlay/>
        {safe && <div className="safe-areas"><div/><div/></div>}
        {compare && <div className="viewer-compare"><span>UNGRADED</span></div>}
        {blockingStatus && <div className="viewer-playback-status" role={status.error ? 'alert' : 'status'}><span>{status.title}</span>{status.detail && <small>{status.detail}</small>}{(status.error || status.loading) && <button onClick={retry}>Retry media</button>}</div>}
      </div>
      {status && !blockingStatus && <span className="viewer-demo-note" role="status" title={status.detail}>{status.title}{status.fallback && <> · reduced precision <button onClick={retry}>Retry selected quality</button></>}</span>}
      {liveMode !== 'independent' && <div className={`live-viewer-badge ${liveMode}`}><Radio size={13}/><b>LIVE</b> {liveMode === 'following' ? `Following ${users.find(u => u.id === followUserId)?.name ?? 'collaborator'}` : 'Presenting timeline'}</div>}
      {settings && <div className="viewer-settings popover"><span className="eyebrow">VIEWER OVERLAYS</span><label><input type="checkbox" checked={safe} onChange={e => setSafe(e.target.checked)}/> Title & action safe areas</label><label><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)}/> Compare ungraded image</label><label><input type="checkbox" checked={original} onChange={e => setOriginal(e.target.checked)}/> Decode original media</label><small className="muted">Preview uses browser decoders and SDR processing up to 1920 pixels wide. Exports use originals at the selected resolution.</small></div>}
    </div>
    <div className="viewer-transport"><div className="row viewer-quality"><button className="proxy-indicator" onClick={() => setOriginal(!original)} title="Toggle proxy / original"><i/>{status?.fallback ? 'STREAM FALLBACK' : original ? 'ORIGINAL' : 'PROXY'}</button><select aria-label="Preview quality" value={quality} onChange={e => setQuality(e.target.value)}><option value="Color">Color · high precision</option><option value="Stream">Auto · streaming</option><option>1/4</option><option>1/2</option><option>Full</option></select></div><div className="transport-controls"><IconButton label="Previous edit" disabled={lockedPlayback} onClick={() => navigateEdit(-1)}><SkipBack size={14}/></IconButton><IconButton label="Previous frame" disabled={lockedPlayback} onClick={() => setPlayhead(playhead - 1 / fps)}><ChevronLeft size={17}/></IconButton><IconButton label={playing ? 'Pause playback' : 'Play playback'} disabled={lockedPlayback} className="play-button" onClick={() => { playback.current?.resume(); setPlaying(!playing); }}>{playing ? <Pause size={17} fill="currentColor"/> : <Play size={17} fill="currentColor"/>}</IconButton><IconButton label="Next frame" disabled={lockedPlayback} onClick={() => setPlayhead(playhead + 1 / fps)}><ChevronRight size={17}/></IconButton><IconButton label="Next edit" disabled={lockedPlayback} onClick={() => navigateEdit(1)}><SkipForward size={14}/></IconButton><span className="transport-time mono">{timecode(playhead, fps)}</span></div><div className="row viewer-tools"><IconButton label={volume ? 'Mute viewer' : 'Unmute viewer'} onClick={() => setVolume(volume ? 0 : 80)}>{volume ? <Volume2 size={15}/> : <VolumeX size={15}/>}</IconButton><input aria-label="Viewer volume" type="range" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))}/><IconButton label="Compare reference" className={compare ? 'active' : ''} onClick={() => setCompare(!compare)}><Columns2 size={15}/></IconButton><IconButton label="Safe areas" className={safe ? 'active' : ''} onClick={() => setSafe(!safe)}><Scan size={15}/></IconButton><IconButton label="Fullscreen viewer" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void ref.current?.requestFullscreen().catch(() => useEditorStore.getState().notify('Fullscreen unavailable', 'info')); }}><Maximize size={15}/></IconButton></div></div>
  </section>;
}
