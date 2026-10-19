import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronDown, Play, Pause, Undo2, Redo2, Maximize2, Minimize2, Clapperboard, Type, Music, Captions, Scissors, SquarePen, Upload, Download, LoaderCircle, Check, Film } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../state/store';
import Viewer from './Viewer';
import PhoneTimeline, { clock, mainTrack } from './PhoneTimeline';
import PhoneClipPanel from './PhoneClipPanel';
import { LiveTimecode } from './LiveTimecode';
import TitleLibrary from './TitleLibrary';
import SoundLibrary from './SoundLibrary';
import CaptionLibrary from './CaptionLibrary';
import UploadQueue from './UploadQueue';
import { projectSize } from '../services/playback';
import { timecode } from '../services/timecode';
import { isTitle } from '../services/text';
import type { MediaAsset } from '../state/models';

type Sheet = 'media' | 'text' | 'audio' | 'captions' | 'export';
const s = useEditorStore.getState;

/** Where new media goes: the main-track cut nearest the playhead, pushing later clips right (CapCut's insert). */
function insertPoint() {
  const state = s(), main = mainTrack(state.tracks.filter(t => t.timelineId === state.timelineId));
  const cuts = [0, ...state.clips.filter(c => c.trackId === main?.id).flatMap(c => [c.start, c.start + c.duration])];
  return { main, at: cuts.reduce((best, t) => Math.abs(t - state.playhead) < Math.abs(best - state.playhead) ? t : best, 0) };
}

function Sheet({ title, onClose, children, tall = false }: { title: string; onClose: () => void; children: ReactNode; tall?: boolean }) {
  return <>{tall && <div className="ph-backdrop" onClick={onClose}/>}<div className={`ph-sheet${tall ? ' is-tall' : ''}`} role="dialog" aria-label={title}>
    <header><b>{title}</b><button aria-label="Close" onClick={onClose}><ChevronDown size={22}/></button></header>
    <div className="ph-sheet-body">{children}</div>
  </div></>;
}

function MediaSheet({ onClose }: { onClose: () => void }) {
  const projectId = useEditorStore(st => st.projectId);
  const media = useEditorStore(useShallow(st => st.media.filter(m => m.projectId === st.projectId)));
  const [kind, setKind] = useState<'all' | MediaAsset['kind']>('all');
  const input = useRef<HTMLInputElement>(null);
  const add = (asset: MediaAsset) => {
    if (asset.status !== 'ready') { s().notify('Still preparing this clip', 'info'); return; }
    if (asset.kind === 'audio') s().addMediaToTimeline(asset.id, s().playhead);
    else { const { main, at } = insertPoint(); s().addMediaToTimeline(asset.id, at, main?.id, true); s().setPlayhead(at); }
    onClose();
  };
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const { main, at } = insertPoint();
    s().uploadMedia([...files], main ? { start: at, trackId: main.id } : undefined);
  };
  const shown = media.filter(m => kind === 'all' || m.kind === kind).reverse();
  return <Sheet title="Media" onClose={onClose} tall>
    <input ref={input} type="file" hidden multiple accept="video/*,image/*,audio/*" onChange={e => { upload(e.target.files); e.target.value = ''; }}/>
    <button className="ph-upload" onClick={() => input.current?.click()}><Upload size={18}/>Add from this phone</button>
    <UploadQueue projectId={projectId} media={media} onSelectFiles={() => input.current?.click()}/>
    <div className="ph-filters">{(['all', 'video', 'image', 'audio'] as const).map(k => <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k === 'image' ? 'Photos' : k === 'video' ? 'Videos' : 'Audio'}</button>)}</div>
    {shown.length ? <div className="ph-media">{shown.map(asset => <button key={asset.id} className="ph-media-item" aria-label={`Add ${asset.name}`} onClick={() => add(asset)}>
      <span className="ph-media-thumb" style={{ backgroundImage: asset.thumbnail ? `url(${asset.thumbnail})` : undefined }}>{asset.kind === 'audio' && <Music size={22}/>}{asset.status !== 'ready' && <i><LoaderCircle size={16} className="spin"/></i>}{asset.kind !== 'image' && asset.duration > 0 && <small>{clock(asset.duration)}</small>}</span>
      <span className="ph-media-name">{asset.name}</span>
    </button>)}</div> : <p className="ph-empty">No media yet. Add videos and photos from this phone.</p>}
  </Sheet>;
}

const EXPORTS = [{ name: '720p', edge: 1280 }, { name: '1080p', edge: 1920 }, { name: '4K', edge: 3840 }];
function ExportSheet({ onClose }: { onClose: () => void }) {
  const project = useEditorStore(st => st.projects.find(p => p.id === st.projectId));
  const timeline = useEditorStore(st => st.timelines.find(t => t.id === st.timelineId));
  const jobs = useEditorStore(useShallow(st => st.renderJobs.filter(j => j.projectId === st.projectId)));
  const [width, height] = projectSize(project?.resolution ?? '1920 × 1080');
  const [choice, setChoice] = useState('1080p');
  const size = (edge: number) => { const scale = edge / Math.max(width, height), even = (n: number) => Math.round(n * scale / 2) * 2; return `${even(width)} × ${even(height)}`; };
  // The same settings Deliver's Quick Export sends, for the whole timeline.
  const start = () => {
    const state = s(), fps = project?.fps || 24, end = Math.max(0, ...state.clips.filter(c => c.timelineId === state.timelineId).map(c => c.start + c.duration));
    if (end < 1 / fps) { state.notify('Add a clip before exporting', 'info'); return; }
    const resolution = size(EXPORTS.find(e => e.name === choice)!.edge);
    state.enqueueRender(`${(project?.name || 'Untitled').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${choice}.mp4`, 'Quick Export', { destination: 'Server exports', resolution, fps: String(fps), codec: 'H.264', quality: choice === '4K' ? 'Maximum · 50 Mb/s' : 'High · 20 Mb/s', masterGain: String(state.settings.masterGain ?? 0), masterMuted: String(state.settings.masterMuted ?? false), range: 'Entire timeline', rangeIn: '0', rangeOut: String(end), duration: String(end), timecodeIn: timecode(0, fps), timecodeOut: timecode(end, fps), sourceFrameRate: String(fps), audio: 'AAC · 320 kb/s · 48 kHz', subtitles: 'None', timeline: timeline?.name || 'Main timeline', timelineId: state.timelineId });
  };
  const save = (url: string, name: string) => { const link = document.createElement('a'); link.href = url; link.download = name; link.click(); };
  return <Sheet title="Export" onClose={onClose}>
    <div className="ph-export">
      <div className="ph-filters is-wide" role="radiogroup" aria-label="Export resolution">{EXPORTS.map(e => <button key={e.name} role="radio" aria-checked={choice === e.name} className={choice === e.name ? 'active' : ''} onClick={() => setChoice(e.name)}>{e.name}<small>{size(e.edge)}</small></button>)}</div>
      <button className="ph-primary" onClick={start}><Film size={18}/>Export video</button>
      <p className="ph-note">Renders from your original footage on the server. Keep editing; the file shows up here when it's done.</p>
      <ul className="ph-jobs">{[...jobs].reverse().slice(0, 6).map(job => <li key={job.id}>
        <span className="ph-job-name"><b>{job.name}</b><small>{job.status === 'rendering' ? `${Math.round(job.progress)}% · ${job.remaining || 'Rendering'}` : job.status === 'waiting' ? 'Queued' : job.status === 'failed' ? job.error || job.remaining || 'Failed' : 'Ready'}</small></span>
        {job.status === 'complete' && job.outputUrl ? <button className="ph-job-save" onClick={() => save(job.outputUrl!, job.name)}><Download size={16}/>Save</button> : job.status === 'complete' ? <Check size={18}/> : job.status !== 'failed' && <LoaderCircle size={18} className="spin"/>}
        {job.status === 'rendering' && <i className="ph-job-bar" style={{ transform: `scaleX(${job.progress / 100})` }}/>}
      </li>)}</ul>
    </div>
  </Sheet>;
}

/** The phone editor. Portrait: picture edge to edge on top, transport, a CapCut-style timeline, tools below it. Landscape: the
 *  web editor's arrangement, simpler: tools on the left, picture over timeline, the clip's properties on the right. */
export default function PhoneEditor({ onHome, landscape = false }: { onHome: () => void; landscape?: boolean }) {
  const project = useEditorStore(st => st.projects.find(p => p.id === st.projectId));
  const timelines = useEditorStore(useShallow(st => st.timelines.filter(t => t.projectId === st.projectId && !t.composition)));
  const timelineId = useEditorStore(st => st.timelineId);
  // The edit's length, not the timeline's padded duration: an empty one is 0:00, as in CapCut.
  const duration = useEditorStore(st => st.clips.reduce((end, c) => c.timelineId === st.timelineId ? Math.max(end, c.start + c.duration) : end, 0));
  const playing = useEditorStore(st => st.playing);
  const selected = useEditorStore(st => st.clips.find(c => c.id === st.selectedClipId && c.timelineId === st.timelineId));
  const locked = useEditorStore(st => st.liveMode === 'following');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [theater, setTheater] = useState(false);
  const [width, height] = projectSize(project?.resolution ?? '1920 × 1080');
  const timeline = timelines.find(t => t.id === timelineId);
  // Safari zooms the page into any text field under 16 px and leaves it zoomed; the editor is laid out for the phone already.
  useEffect(() => {
    const meta = document.querySelector('meta[name=viewport]'), before = meta?.getAttribute('content');
    if (before) meta!.setAttribute('content', `${before},maximum-scale=1`);
    return () => { if (before) meta!.setAttribute('content', before); };
  }, []);
  // A title picked in the Text sheet is selected as it lands: close the sheet so its panel opens on the text.
  useEffect(() => { if (sheet === 'text' && selected && isTitle(selected)) setSheet(null); }, [selected?.id]);
  const play = () => s().setPlaying(!playing);
  // Edit opens the clip under the playhead, main track first: no aiming at a thin lane needed.
  const editAtPlayhead = () => {
    const state = s(), main = mainTrack(state.tracks.filter(t => t.timelineId === state.timelineId));
    const under = state.clips.filter(c => c.timelineId === state.timelineId && c.start <= state.playhead && c.start + c.duration > state.playhead);
    const clip = under.find(c => c.trackId === main?.id) ?? under[0];
    if (clip) state.selectClip(clip.id); else state.notify('No clip under the playhead', 'info');
  };
  const tools = [
    { label: 'Edit', icon: <SquarePen size={21}/>, run: editAtPlayhead },
    { label: 'Media', icon: <Clapperboard size={21}/>, run: () => setSheet('media') },
    { label: 'Text', icon: <Type size={21}/>, run: () => setSheet('text') },
    { label: 'Audio', icon: <Music size={21}/>, run: () => setSheet('audio') },
    { label: 'Captions', icon: <Captions size={21}/>, run: () => setSheet('captions') },
    { label: 'Split', icon: <Scissors size={21}/>, run: () => { if (!s().cutThrough(s().playhead)) s().notify('Nothing to split at the playhead', 'info'); } },
  ];
  return <div className={`ph${theater ? ' is-theater' : ''}${landscape ? ' is-landscape' : ''}`}>
    <header className="ph-top">
      <button className="ph-icon" aria-label="Back to projects" onClick={onHome}><ChevronLeft size={24}/></button>
      <div className="ph-title"><b>{project?.name ?? 'Project'}</b>{timelines.length > 1 ? <label className="ph-timeline"><span>{timeline?.name}</span><ChevronDown size={12}/><select aria-label="Timeline" value={timelineId} onChange={e => s().setTimeline(e.target.value)}>{timelines.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label> : <small>{timeline?.name}</small>}</div>
      <button className="ph-export-button" onClick={() => setSheet('export')}>Export</button>
    </header>
    <div className="ph-viewer" style={{ aspectRatio: `${width} / ${height}` }}>
      <Viewer bare/>
      {theater && <button className="ph-theater-close" aria-label="Exit full screen" onClick={() => setTheater(false)}><Minimize2 size={20}/></button>}
      {theater && <div className="ph-theater-bar"><button className="ph-play" aria-label={playing ? 'Pause playback' : 'Play playback'} disabled={locked} onClick={play}>{playing ? <Pause size={22} fill="currentColor"/> : <Play size={22} fill="currentColor"/>}</button><LiveTimecode className="ph-time-now" format={clock}/></div>}
    </div>
    <div className="ph-transport">
      <span className="ph-time"><LiveTimecode className="ph-time-now" format={clock}/><span className="ph-time-total"> / {clock(duration)}</span></span>
      <button className="ph-play" aria-label={playing ? 'Pause playback' : 'Play playback'} disabled={locked} onClick={play}>{playing ? <Pause size={24} fill="currentColor"/> : <Play size={24} fill="currentColor"/>}</button>
      <span className="ph-transport-right">
        <button className="ph-icon" aria-label="Undo" onClick={() => s().undo()}><Undo2 size={20}/></button>
        <button className="ph-icon" aria-label="Redo" onClick={() => s().redo()}><Redo2 size={20}/></button>
        <button className="ph-icon" aria-label="Full screen" onClick={() => setTheater(true)}><Maximize2 size={19}/></button>
      </span>
    </div>
    <div className="ph-work">
      <PhoneTimeline onAdd={() => setSheet('media')}/>
      <nav className="ph-tools" aria-label="Editing tools">{tools.map(t => <button key={t.label} onClick={t.run}>{t.icon}<span>{t.label}</span></button>)}</nav>
      {selected && !sheet && <PhoneClipPanel clip={selected}/>}
      {sheet === 'text' && <Sheet title="Text" onClose={() => setSheet(null)}><div className="ph-lib"><TitleLibrary/></div></Sheet>}
      {sheet === 'audio' && <Sheet title="Sound effects" onClose={() => setSheet(null)}><div className="ph-lib"><SoundLibrary/></div></Sheet>}
      {sheet === 'captions' && <Sheet title="Captions" onClose={() => setSheet(null)}><div className="ph-lib"><CaptionLibrary/></div></Sheet>}
      {sheet === 'export' && <ExportSheet onClose={() => setSheet(null)}/>}
    </div>
    {sheet === 'media' && <MediaSheet onClose={() => setSheet(null)}/>}
  </div>;
}
