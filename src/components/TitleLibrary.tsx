import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Type, Search, Star, Layers } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { drawText, getText } from '../services/text';
import { drawShape, getShape } from '../services/shapes';
import { createTitleTemplate, titleTemplates } from '../services/titleTemplates';
import { evaluateClip } from '../services/animation';
import { previewTime } from '../services/timecode';
import type { Clip } from '../state/models';
import './text.css';

function TitleCard({ index, animated, favorite, onFavorite }: { index: number; animated: boolean; favorite: boolean; onFavorite: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), playhead = useRef<HTMLSpanElement>(null), request = useRef(0), time = useRef(0), position = useRef(.48);
  const template = useMemo(() => createTitleTemplate(index, animated), [index, animated]);
  const clips = useMemo(() => template.layers.map((layer, i): Clip => ({ id: `preview-${i}`, projectId: '', timelineId: '', trackId: '', mediaId: layer.text ? 'frameline-title' : 'frameline-shape', name: layer.name, start: 0, duration: template.duration, sourceIn: 0, color: '', disabled: false, effects: [], properties: { ...layer.properties, ...(layer.text ? { textDocument: JSON.stringify(layer.text) } : { shapeDocument: JSON.stringify(layer.shape) }) }, keyframes: layer.keyframes })), [template]);
  const paint = (at: number) => {
    const c = canvas.current, ctx = c?.getContext('2d'); if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const raw of clips) {
      const clip = evaluateClip(raw, at), p = clip.properties;
      const shape = raw.mediaId === 'frameline-shape' ? getShape(clip) : undefined;
      const anchorX = shape ? (shape.x + shape.width / 2 - .5) * c.width : 0, anchorY = shape ? (shape.y + shape.height / 2 - .5) * c.height : 0;
      ctx.save(); ctx.globalAlpha = Number(p.opacity ?? 100) / 100;
      ctx.translate(c.width / 2 + anchorX + Number(p.x ?? 0) * c.width / 1920, c.height / 2 + anchorY + Number(p.y ?? 0) * c.height / 1080);
      ctx.rotate(Number(p.rotation ?? 0) * Math.PI / 180); ctx.scale(Number(p.zoom ?? 100) / 100, Number(p.zoom ?? 100) / 100); ctx.translate(-c.width / 2 - anchorX, -c.height / 2 - anchorY);
      if (raw.mediaId === 'frameline-title') drawText(ctx, getText(clip), c.width, c.height, 1920, 1080, at, p.animationTypingCount as number | undefined);
      else drawShape(ctx, getShape(clip), c.width, c.height, 1920, 1080);
      ctx.restore();
    }
  };
  useEffect(() => { time.current = template.duration * .48; paint(time.current); return () => cancelAnimationFrame(request.current); }, [clips]);
  const scrub = (progress: number) => {
    if (!animated) return;
    position.current = progress;
    time.current = Math.min(template.duration - 1/24, index === 34 ? progress * template.duration : previewTime(progress, template.duration, Number(template.layers[0].properties?.animationEntrance ?? 1), Number(template.layers[0].properties?.animationExit ?? .65)));
    if (playhead.current) playhead.current.style.left = `${progress * 100}%`;
    cancelAnimationFrame(request.current); request.current = requestAnimationFrame(() => paint(time.current));
  };
  return <div className="title-preset">
    <button className="title-preset-button" data-cursor-anchor={`title-${index}`} draggable aria-label={`Add ${template.name} title`} onDragStart={e => { const id = `title:${index}:${animated ? 'animated' : 'static'}`; useEditorStore.setState({ draggingMediaId: id }); e.dataTransfer.setData('application/x-frameline-media', id); e.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={() => useEditorStore.setState({ draggingMediaId: null })} onClick={() => useEditorStore.getState().addTitle(index, undefined, undefined, animated)} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); scrub(Math.max(0, Math.min(1, position.current + (e.key === 'ArrowRight' ? .05 : -.05)))); } }}>
      <div className={`title-preset-art title-art-${index % 4}`} onPointerMove={e => { const bounds = e.currentTarget.getBoundingClientRect(); scrub(Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width))); }}>
        <canvas ref={canvas} width={480} height={270} aria-hidden="true"/>
        {animated && <span ref={playhead} className="title-scrub-playhead" style={{ left: '48%' }}/>}<span className="title-add"><Plus size={15}/></span>
        {template.layers.length > 1 && <span className="title-composition-icon" title="Layered composition"><Layers size={12}/></span>}
      </div>
      <span className="title-preset-meta"><b>{template.name}</b><small>{titleTemplates[index].category}</small></span>
    </button>
    <button className={`title-favorite ${favorite ? 'active' : ''}`} title={favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label={`${favorite ? 'Unfavorite' : 'Favorite'} ${template.name}`} aria-pressed={favorite} onClick={onFavorite}><Star size={13} fill={favorite ? 'currentColor' : 'none'}/></button>
  </div>;
}
export default function TitleLibrary() {
  const [query, setQuery] = useState(''), [category, setCategory] = useState('All'), [animated, setAnimated] = useState(true), [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState<number[]>(() => { try { const stored = JSON.parse(localStorage.getItem('frameline-title-favorites') ?? '[]'); return Array.isArray(stored) ? stored.filter(i => Number.isInteger(i) && i >= 0 && i < titleTemplates.length) : []; } catch { return []; } });
  const tool = useEditorStore(s => s.textTool);
  const filtered = titleTemplates.map((p,index) => ({p,index})).filter(({p,index}) => (category === 'All' || p.category === category) && (!favoritesOnly || favorites.includes(index)) && `${p.name} ${p.category}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="title-library">
    <div className="title-library-toolbar"><div className="title-mode" aria-label="Title animation">{[true,false].map(value => <button key={String(value)} className={animated === value ? 'active' : ''} aria-pressed={animated === value} onClick={() => setAnimated(value)}>{value ? 'Animated' : 'Static'}</button>)}</div><button className={`draw-text-button ${tool ? 'active' : ''}`} title="Draw a text box (T)" aria-label="Draw a text box" onClick={() => useEditorStore.setState({ textTool: !tool, shapeTool: null, playing: false })}><Type size={16}/><Plus size={11}/></button></div>
    <div className="media-search"><Search size={13}/><input aria-label="Search titles" placeholder="Search titles…" value={query} onChange={e => setQuery(e.target.value)}/></div>
    <div className="title-library-filters"><select aria-label="Title category" value={category} onChange={e => setCategory(e.target.value)}>{['All', 'Simple', 'Cinematic', 'Bold', 'Colorful', 'Lower Thirds', 'News', 'Credits'].map(value => <option key={value}>{value}</option>)}</select><button className={favoritesOnly ? 'active' : ''} aria-label="Show favorite titles" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}><Star size={13} fill={favoritesOnly ? 'currentColor' : 'none'}/></button><small>{filtered.length} titles</small></div>
    <div className="title-presets">{filtered.map(({index}) => <TitleCard key={index} index={index} animated={animated} favorite={favorites.includes(index)} onFavorite={() => setFavorites(current => { const next = current.includes(index) ? current.filter(i => i !== index) : [...current,index]; try { localStorage.setItem('frameline-title-favorites', JSON.stringify(next)); } catch { /* Favorites remain available for this session. */ } return next; })}/>)}</div>
    {!filtered.length && <p className="title-no-results">No matching titles.</p>}
  </div>;
}
