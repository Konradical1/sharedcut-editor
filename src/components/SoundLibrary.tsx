import { Waveform } from './Waveform';
import { useEffect, useRef, useState } from 'react';
import { Search, Play, Pause, Plus, LoaderCircle, Volume2 } from 'lucide-react';
import { api } from '../services/api';
import { soundCategories, type SoundEffect } from '../services/sfx';
import { dragSound, insertSound } from '../services/sfxBrowser';
import { useEditorStore } from '../state/store';
import './sfx.css';
export default function SoundLibrary() {
  const [query, setQuery] = useState(''), [category, setCategory] = useState('');
  const [sounds, setSounds] = useState<SoundEffect[]>([]), [categories, setCategories] = useState<string[]>(soundCategories);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [semantic, setSemantic] = useState(true);
  const [active, setActive] = useState<string | null>(null), [playing, setPlaying] = useState(false), [adding, setAdding] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  const timelinePlaying = useEditorStore(s => s.playing);
  useEffect(() => { if (timelinePlaying) audio.current?.pause(); }, [timelinePlaying]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    const timer = setTimeout(() => {
      void api<{ sounds: SoundEffect[]; categories: string[]; semantic: boolean }>(`/sfx?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}`, { signal: controller.signal })
        .then(data => { if (controller.signal.aborted) return; setSounds(data.sounds); setCategories([...new Set([...soundCategories, ...data.categories])]); setSemantic(data.semantic); })
        .catch(e => { if (!controller.signal.aborted) setError(e.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, category, revision]);
  useEffect(() => {
    const refresh = () => setRevision(n => n + 1);
    window.addEventListener('sfx-saved', refresh);
    const timer = setInterval(() => { if (!document.hidden && !query) refresh(); }, 10000);
    return () => { window.removeEventListener('sfx-saved', refresh); clearInterval(timer); };
  }, [query]);
  useEffect(() => { const player = audio.current; return () => { player?.pause(); player?.removeAttribute('src'); player?.load(); dragSound(null); }; }, []);
  const preview = async (sound: SoundEffect) => {
    const player = audio.current; if (!player || !sound.url) return;
    if (active === sound.id && !player.paused) { player.pause(); return; }
    useEditorStore.getState().setPlaying(false);
    if (active !== sound.id) { player.pause(); player.src = sound.url; setActive(sound.id); }
    if (player.ended) player.currentTime = 0;
    try { await player.play(); } catch (e) { if (e instanceof Error && e.name !== 'AbortError') setError('This sound could not be played. Try again.'); }
  };
  return <div className="sfx-library">
    <div className="media-search"><Search size={14}/><input aria-label="Search sound effects" placeholder="Describe a sound…" value={query} maxLength={200} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="Clear sound search" onClick={() => setQuery('')}>×</button>}</div>
    <div className="sfx-categories"><select aria-label="Sound category" value={category} onChange={e => setCategory(e.target.value)}><option value="">All sounds</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
    <div className="sfx-summary"><span>{loading ? 'Finding sounds…' : `${sounds.length} sounds`}</span><span>{query && !semantic ? 'Name & tag search' : 'Search by name or meaning'}</span></div>
    {error && <div className="sfx-message" role="alert">{error} <button onClick={() => setRevision(n => n + 1)}>Retry</button></div>}
    <div className="sfx-results" aria-busy={loading}>
      {sounds.map(sound => <div key={sound.id} className={`sfx-row ${active === sound.id ? 'active' : ''}`} draggable={sound.status === 'ready'} onDragStart={e => { audio.current?.pause(); dragSound(sound); e.dataTransfer.setData('application/x-frameline-media', sound.id); e.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={() => dragSound(null)}>
        <button className="sfx-preview" aria-label={`${active === sound.id && playing ? 'Pause' : 'Play'} ${sound.name}`} disabled={sound.status !== 'ready'} onClick={() => void preview(sound)}>
          <span className="sfx-play">{sound.status === 'preparing' ? <LoaderCircle size={16} className="spin"/> : active === sound.id && playing ? <Pause size={16}/> : <Play size={16}/>}</span>
          <span className="sfx-detail"><strong title={sound.name}>{sound.name}</strong><small>{sound.status === 'failed' ? sound.error : sound.status === 'preparing' ? 'Preparing sound…' : `${sound.category} · ${sound.duration.toFixed(2)}s`}</small>
            <Waveform samples={sound.waveform}/>
          </span>
        </button>
        <button className="sfx-add" title="Add at playhead" aria-label={`Add ${sound.name} to timeline`} disabled={sound.status !== 'ready' || adding !== null} onClick={() => { audio.current?.pause(); setAdding(sound.id); void insertSound(sound.id).finally(() => setAdding(null)); }}>{adding === sound.id ? <LoaderCircle size={15} className="spin"/> : <Plus size={16}/>}</button>
      </div>)}
      {!loading && !sounds.length && !error && <div className="sfx-empty"><Volume2 size={26}/><strong>{query || category ? 'No matching sounds' : 'Your sound library'}</strong><span>{query || category ? 'Try another description or category.' : 'Right-click an audio clip and choose Save as Sound Effect.'}</span></div>}
    </div>
    <footer className="sfx-footer">Click to preview · Drag or + to add</footer>
    <audio ref={audio} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setError('Preview unavailable. Try another sound or retry.'); }}/>
  </div>;
}
