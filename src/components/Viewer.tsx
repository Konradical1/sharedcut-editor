import { footageSummary, retryFootage } from '../services/footageCache';
import { FootageRelay, footageRelayed, subscribeFootage } from './footageRelay';
import SmartMaskEditor from './SmartMaskOverlay';
import MotionTrackerEditor from './MotionTrackerEditor';
import MotionTrackerOverlay from './MotionTrackerOverlay';
import { DepthFocusPicker } from './DepthInspector';
import TextOverlay from './TextOverlay';
import ShapeOverlay from './ShapeOverlay';
import { refreshFonts, useFonts, detectLocalFonts } from '../services/fonts';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { SkipBack, SkipForward, Play, Pause, ChevronLeft, ChevronRight, Volume2, VolumeX, Maximize, Scan, Settings2, Columns2, Radio } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { attachPlayback, projectSize, type PlaybackStatus } from '../services/playback';
import { FOCUS_ZOOMS, followFocus, sourceFocus, stepFocus, useFocusClipId, useFocusKind, useFocusZoom } from '../services/sourceFocus';
import { sourceSize } from '../services/motionTracker';
import { IconButton } from './ui';
import { LiveTimecode } from './LiveTimecode';

/**
 * Streaming is the default, and deliberately not the sharpest option. The all-intra proxies hold
 * every frame as a keyframe so a scrub lands instantly, which also makes the full one run about
 * 80 Mbit/s — fine across the room, impossible across the internet. Anyone who needs frame-accurate
 * picture on the LAN can still pick one.
 */
const viewerQuality = (preference: unknown) => preference === 'Quarter resolution' ? '1/4' : preference === 'Half resolution' ? '1/2' : preference === 'Full resolution' ? 'Full' : 'Stream';

/** The footage panel re-reads the cache with the timeline's badges (footageRelay): decoder statuses change at every cut. */
function FootageLoading({ retry }: { retry: () => void }) {
  const shown = useSyncExternalStore(subscribeFootage, footageRelayed);
  return useMemo(() => <><FootageRelay/><FootageSummary retry={retry}/></>, [shown, retry]);
}
function FootageSummary({ retry }: { retry: () => void }) {
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

// Memoized: the workspaces around it re-render on panel-playhead steps and store changes, and none of that reaches its props.
export default memo(Viewer);
function Viewer({ compact = false, colorAccurate=false }: { compact?: boolean; colorAccurate?:boolean }) {
  const fontsRevision = useFonts(s => s.revision);
  useEffect(() => { detectLocalFonts(); void refreshFonts(); const timer = setInterval(() => void refreshFonts(), 15000); return () => clearInterval(timer); }, []);
  // The shared overlay pack is needed to draw a light-leak transition, not only to browse one.
  const loadLeaks = useEditorStore(s => s.loadLeaks);
  useEffect(() => { loadLeaks(); }, [loadLeaks]);
  const project = useEditorStore(s => s.projects.find(p => p.id === s.projectId));
  const timelineId = useEditorStore(s => s.timelineId);
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
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // A frame editor (motion tracker, Smart Mask) turns the viewer into its clip's source monitor: same engine and
  // transport, the clip's own frames, and the editor's bar above the picture and frame strip below it.
  const focusKind = useFocusKind(), focusClipId = useFocusClipId(), focusZoom = useFocusZoom(s => s.zoom);
  const focusClip = useEditorStore(s => focusClipId ? s.clips.find(c => c.id === focusClipId) : undefined);
  const focusAsset = useEditorStore(s => focusClip ? s.media.find(m => m.id === focusClip.mediaId) : undefined);
  const [focusBar, setFocusBar] = useState<HTMLDivElement | null>(null), [focusStrip, setFocusStrip] = useState<HTMLDivElement | null>(null);
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
    const engine = attachPlayback(canvas.current!, () => { const state=useEditorStore.getState();const view=state.clipPreview || state.textPreview.length ? {...state,renderPreviewAllowed:false,clips:state.clips.map(clip=>state.textPreview.find(c=>c.id===clip.id)??(clip.id===state.clipPreview?.id?state.clipPreview:clip))} : state;return {...view,focus:sourceFocus()}; }, () => options.current, value => { setStatus(value); useEditorStore.setState({ playbackBuffering: !!value?.loading }); });
    playback.current = engine;
    const unfollow = followFocus(canvas.current!);
    const gesture = (event: Event) => {
      if (event instanceof KeyboardEvent && (event.code !== 'Space' || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable],dialog[open]'))) return;
      engine.resume();
    };
    document.addEventListener('pointerdown', gesture, { passive: true });
    document.addEventListener('keydown', gesture);
    return () => { unfollow(); document.removeEventListener('pointerdown', gesture); document.removeEventListener('keydown', gesture); engine.dispose(); playback.current = null; useEditorStore.setState({ playbackBuffering: false }); };
  }, []);
  useEffect(() => { if (playing) playback.current?.resume(); }, [playing]);
  const fps = project?.fps ?? 24;
  const [width, height] = projectSize(project?.resolution ?? '1920 × 1080');
  const navigateEdit = (direction: number) => {
    const { clips, playhead } = useEditorStore.getState();
    const times = [...new Set(clips.filter(c => c.timelineId === timelineId).flatMap(c => [c.start, c.start + c.duration]))].sort((a, b) => a - b);
    const duration = useEditorStore.getState().timelines.find(t => t.id === timelineId)?.duration ?? 0;
    setPlayhead(direction > 0 ? times.find(t => t > playhead + .5 / fps) ?? duration : times.reverse().find(t => t < playhead - .5 / fps) ?? 0);
  };
  const focused = !!focusKind && focusAsset?.kind === 'video';
  const [frameWidth, frameHeight] = focused ? sourceSize(focusAsset) : [width, height];
  const zoomed = focused && focusZoom !== 'Fit';
  // A new zoom starts centred, before paint and before the tracker's own effect brings its point into view.
  useLayoutEffect(() => { const el = stage.current; if (el && zoomed) { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; } }, [focusZoom, zoomed]);
  const step = (delta: number) => { if (!stepFocus(delta)) setPlayhead(useEditorStore.getState().playhead + delta / fps); };
  const lockedPlayback = liveMode === 'following';
  const blockingStatus = status && (status.error || status.loading || status.title === 'No picture at playhead');
  const retry = useCallback(() => { retryFootage(); playback.current?.retry(); }, []);
  // Reopens only the skipped layers: a global retry would reload every healthy layer mid-playback.
  const retryLayers = useCallback(() => { playback.current?.retryLayers(); }, []);
  return <section ref={ref} className={`viewer panel ${compact ? 'viewer-compact' : ''}`} aria-label="Video viewer">
    <header className="viewer-header"><div className="row"><span className="viewer-sequence-dot"/><span>{focused ? 'Source' : compact ? 'Program monitor' : 'Timeline viewer'}</span><span className="viewer-divider">/</span><span className="muted">{focused ? focusClip?.name : project?.name}</span></div><div className="row">{focused ? <select aria-label="Viewer zoom" title="Source pixels. Scroll to pan when zoomed in; paused frames show the original's own pixels." value={focusZoom} onChange={e => { useFocusZoom.setState({ zoom: e.target.value as typeof focusZoom }); e.currentTarget.blur(); }}>{FOCUS_ZOOMS.map(z => <option key={z} value={z}>{z === 'Fit' ? 'Fit' : `${z}%`}</option>)}</select> : <select aria-label="Viewer zoom" value={zoom} onChange={e => setZoom(e.target.value)}><option>Fit</option><option>50%</option><option>100%</option><option>150%</option></select>}<IconButton label="Viewer settings" className={settings ? 'active' : ''} onClick={() => setSettings(!settings)}><Settings2 size={15}/></IconButton></div></header>
    <FootageLoading retry={retry}/>
    <div className="viewer-focus-bar" ref={setFocusBar}/>
    <div ref={stage} className={`viewer-stage${focused ? ' focused' : ''}${zoomed ? ' focus-zoomed' : ''}`}>
      <div className="viewer-frame" style={{ '--frame-ratio': frameWidth / frameHeight, ...(zoomed ? { width: frameWidth * Number(focusZoom) / 100, height: frameHeight * Number(focusZoom) / 100 } : {}), transform: focused || zoom === 'Fit' ? undefined : `scale(${width * parseInt(zoom) / 100 / fitWidth})` } as CSSProperties}>
        <canvas ref={canvas} role="img" aria-label={focused ? `Source picture of ${focusClip?.name ?? 'the clip'}` : 'Timeline picture'}/>
        {focused ? <>
          {focusKind === 'tracker' && <MotionTrackerEditor bar={focusBar} strip={focusStrip}/>}
          {focusKind === 'mask' && <SmartMaskEditor bar={focusBar} strip={focusStrip}/>}
        </> : <>
          <TextOverlay/>
          <ShapeOverlay/>
          <MotionTrackerOverlay/>
          <DepthFocusPicker canvas={canvas}/>
          {safe && <div className="safe-areas"><div/><div/></div>}
          {compare && <div className="viewer-compare"><span>UNGRADED</span></div>}
        </>}
        {blockingStatus && <div className="viewer-playback-status" role={status.error ? 'alert' : 'status'}><span>{status.title}</span>{status.detail && <small>{status.detail}</small>}{(status.error || status.loading) && <button onClick={retry}>Retry media</button>}</div>}
      </div>
      {status && !blockingStatus && <span className="viewer-demo-note" role="status" title={status.detail}>{status.title}{status.fallback && <> · reduced precision <button onClick={retry}>Retry selected quality</button></>}{status.skipped && <> · {status.detail} <button onClick={retryLayers}>Retry</button></>}</span>}
      {liveMode !== 'independent' && <div className={`live-viewer-badge ${liveMode}`}><Radio size={13}/><b>LIVE</b> {liveMode === 'following' ? `Following ${users.find(u => u.id === followUserId)?.name ?? 'collaborator'}` : 'Presenting timeline'}</div>}
      {settings && <div className="viewer-settings popover"><span className="eyebrow">VIEWER OVERLAYS</span><label><input type="checkbox" checked={safe} onChange={e => setSafe(e.target.checked)}/> Title & action safe areas</label><label><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)}/> Compare ungraded image</label><label><input type="checkbox" checked={original} onChange={e => setOriginal(e.target.checked)}/> Decode original media</label><small className="muted">Preview uses browser decoders and SDR processing up to 1920 pixels wide. Exports use originals at the selected resolution.</small></div>}
    </div>
    <div className="viewer-focus-strip" ref={setFocusStrip}/>
    <div className="viewer-transport"><div className="row viewer-quality"><button className="proxy-indicator" onClick={() => setOriginal(!original)} title="Toggle proxy / original"><i/>{status?.fallback ? 'STREAM FALLBACK' : original ? 'ORIGINAL' : 'PROXY'}</button><select aria-label="Preview quality" value={quality} onChange={e => setQuality(e.target.value)}><option value="Color">Color · high precision</option><option value="Stream">Auto · streaming</option><option>1/4</option><option>1/2</option><option>Full</option></select></div><div className="transport-controls"><IconButton label={focused ? 'First frame' : 'Previous edit'} disabled={lockedPlayback} onClick={() => { if (!stepFocus(-1e9)) navigateEdit(-1); }}><SkipBack size={14}/></IconButton><IconButton label="Previous frame" disabled={lockedPlayback} onClick={() => step(-1)}><ChevronLeft size={17}/></IconButton><IconButton label={playing ? 'Pause playback' : 'Play playback'} disabled={lockedPlayback} className="play-button" onClick={() => { playback.current?.resume(); setPlaying(!playing); }}>{playing ? <Pause size={17} fill="currentColor"/> : <Play size={17} fill="currentColor"/>}</IconButton><IconButton label="Next frame" disabled={lockedPlayback} onClick={() => step(1)}><ChevronRight size={17}/></IconButton><IconButton label={focused ? 'Last frame' : 'Next edit'} disabled={lockedPlayback} onClick={() => { if (!stepFocus(1e9)) navigateEdit(1); }}><SkipForward size={14}/></IconButton><LiveTimecode className="transport-time mono" fps={fps}/></div><div className="row viewer-tools"><IconButton label={volume ? 'Mute viewer' : 'Unmute viewer'} onClick={() => setVolume(volume ? 0 : 80)}>{volume ? <Volume2 size={15}/> : <VolumeX size={15}/>}</IconButton><input aria-label="Viewer volume" type="range" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))}/><IconButton label="Compare reference" className={compare ? 'active' : ''} onClick={() => setCompare(!compare)}><Columns2 size={15}/></IconButton><IconButton label="Safe areas" className={safe ? 'active' : ''} onClick={() => setSafe(!safe)}><Scan size={15}/></IconButton><IconButton label="Fullscreen viewer" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void ref.current?.requestFullscreen().catch(() => useEditorStore.getState().notify('Fullscreen unavailable', 'info')); }}><Maximize size={15}/></IconButton></div></div>
  </section>;
}
