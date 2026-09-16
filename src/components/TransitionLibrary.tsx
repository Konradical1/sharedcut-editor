import { memo, useEffect, useRef, useState } from 'react';
import { Plus, Star, Search, Sparkles, Upload } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { ease } from '../services/animation';
import { leakRange, transitionPresetId, transitionDefinitions, transitionKinds, type TransitionKind, type TransitionParams } from '../services/transitions';
import { EmptyState } from './ui';

/**
 * Cards preview through the very same `draw` the timeline uses, over two bundled demo stills, so
 * what you scrub in the library is the shipping implementation rather than a canned animation.
 */
const SAMPLES = ['/media/mountains.jpg', '/media/street.jpg'];
/** A leak with no measured peak falls back to the middle of its own length. */
const clampPeak = (peak?: number) => Number.isFinite(peak) && peak! > 0 && peak! < 1 ? peak! : .5;
const CARD_WIDTH = 192, CARD_HEIGHT = 108;

let samplesPromise: Promise<(CanvasImageSource | null)[]> | null = null;
function loadSamples() {
  samplesPromise ??= Promise.all(SAMPLES.map(src => new Promise<CanvasImageSource | null>(resolve => {
    const image = new Image();
    image.onload = () => {
      // Pre-fit each still to the card so a transition never pays for a rescale mid-scrub.
      const canvas = document.createElement('canvas');
      canvas.width = CARD_WIDTH; canvas.height = CARD_HEIGHT;
      const context = canvas.getContext('2d');
      if (!context) { resolve(null); return; }
      const fit = Math.max(CARD_WIDTH / image.naturalWidth, CARD_HEIGHT / image.naturalHeight);
      const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
      context.drawImage(image, (CARD_WIDTH - w) / 2, (CARD_HEIGHT - h) / 2, w, h);
      resolve(canvas);
    };
    image.onerror = () => resolve(null);
    image.src = src;
  })));
  return samplesPromise;
}

const TransitionCard = memo(function TransitionCard({ name, label, params, leakUrl, posterUrl, favorite, onFavorite, duration, sourceFps = 24 }: { name: string; label: string; params: TransitionParams; leakUrl?: string; posterUrl?: string; favorite: boolean; onFavorite: () => void; duration?: number; sourceFps?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const progress = useRef(.5);
  const scrubbing = useRef(false);
  const overlay = useRef<HTMLVideoElement | null>(null);
  const poster = useRef<HTMLImageElement | null>(null);
  const lastOverlay = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const selectedClipId = useEditorStore(state => state.selectedClipId);
  const definition = transitionDefinitions[name];

  useEffect(() => {
    let frame = 0, disposed = false, started = performance.now();
    const render = () => {
      if (disposed) return;
      frame = requestAnimationFrame(render);
      const context = canvas.current?.getContext('2d');
      if (!context || !definition) return;
      if (hovered && !scrubbing.current) progress.current = ((performance.now() - started) % 1600) / 1600;
      else if (!hovered) progress.current = .5;
      void loadSamples().then(([outgoing, incoming]) => {
        if (disposed) return;
        const raw = Math.max(0, Math.min(1, progress.current));
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'source-over';
        context.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
        const leak = overlay.current;
        if (leak && leak.readyState >= 2) {
          const range = leakRange(params, leak.duration || 1);
          const lastFrame = Math.max(range.start, range.end - 1 / sourceFps);
          const wanted = range.start + raw * (lastFrame - range.start);
          if (!leak.seeking && (leak.currentTime < range.start || leak.currentTime >= range.end || Math.abs(leak.currentTime - wanted) > .5 / sourceFps)) leak.currentTime = wanted;
          // Never paint the initial source frame or a decoder's pending seek outside the trim.
          if (!leak.seeking && leak.currentTime >= range.start && leak.currentTime < range.end) {
            const snapshot = lastOverlay.current ?? document.createElement('canvas');
            const height = Math.max(1, Math.round(CARD_WIDTH * leak.videoHeight / leak.videoWidth));
            if (snapshot.width !== CARD_WIDTH || snapshot.height !== height) { snapshot.width = CARD_WIDTH; snapshot.height = height; }
            snapshot.getContext('2d')?.drawImage(leak, 0, 0, snapshot.width, snapshot.height);
            lastOverlay.current = snapshot;
          }
        }
        // Until the clip itself is decoded, the card still shows this leak's own brightest frame.
        const trimmed = Number(params.leakIn) > 0 || Number(params.leakOut) > 0;
        const still = !trimmed && poster.current?.complete && poster.current.naturalWidth ? poster.current : null;
        try {
          definition.draw({
            target: context, outgoing, incoming,
            overlay: lastOverlay.current ?? still,
            progress: Math.max(0, Math.min(1, ease(raw, definition.defaultCurve))), raw,
            params: { ...params, __curve: (definition.defaultCurve ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3]).join(','), __duration: duration ?? definition.defaultDuration ?? 1, __fps: 24 },
            width: CARD_WIDTH, height: CARD_HEIGHT,
          });
        } catch { /* A card never breaks the panel; the timeline reports real failures. */ }
        context.restore();
      });
    };
    frame = requestAnimationFrame(render);
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, [definition, hovered, params, duration, sourceFps]);

  useEffect(() => { lastOverlay.current = null; }, [leakUrl, params.leakIn, params.leakOut]);

  useEffect(() => {
    if (!posterUrl) return;
    const image = new Image();
    image.onload = () => { poster.current = image; };
    image.src = posterUrl;
    return () => { poster.current = null; };
  }, [posterUrl]);

  // Overlay clips are only decoded while their own card is hovered; 45 leaks at once would not fit.
  useEffect(() => {
    if (!hovered || !leakUrl) return;
    const element = document.createElement('video');
    element.src = leakUrl; element.muted = true; element.preload = 'auto'; element.playsInline = true;
    overlay.current = element;
    return () => { overlay.current = null; element.removeAttribute('src'); element.load(); };
  }, [hovered, leakUrl]);

  const place = () => {
    if (!selectedClipId) { useEditorStore.getState().notify('Select a clip, or drag this onto a cut', 'info'); return; }
    useEditorStore.getState().applyTransitionAtPlayhead(name, params);
  };

  return <div className="transition-card-shell"><button
    className="transition-card" draggable
    title={`${definition?.description ?? ''} · drag onto a cut, or move across to scrub`}
    onDragStart={event => {
      event.dataTransfer.setData('application/x-frameline-transition', JSON.stringify({ name, params }));
      event.dataTransfer.effectAllowed = 'copy';
      // dragover cannot read the payload, so the timeline reads the shape from the store instead.
      useEditorStore.setState({ draggingTransition: { name, params } });
    }}
    onDragEnd={() => useEditorStore.setState({ draggingTransition: null })}
    onPointerEnter={() => { scrubbing.current = false; setHovered(true); }}
    onPointerLeave={() => { scrubbing.current = false; setHovered(false); }}
    onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      scrubbing.current = true;
      progress.current = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    }}
    onClick={place}
    onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { scrubbing.current = true; progress.current = Math.max(0, Math.min(1, progress.current + (event.key === 'ArrowRight' ? .1 : -.1))); event.preventDefault(); } }}
  >
    <canvas ref={canvas} width={CARD_WIDTH} height={CARD_HEIGHT} aria-hidden="true" />
    <span className="transition-card-name">{label}</span>
    <span className="transition-card-add" aria-hidden="true"><Plus size={12} /></span>
  </button><button className={`transition-card-favorite ${favorite ? 'active' : ''}`} aria-label={`${favorite ? 'Unfavorite' : 'Favorite'} ${label}`} aria-pressed={favorite} title={`${favorite ? 'Remove from' : 'Add to'} favorites`} onClick={onFavorite}><Star size={12} fill={favorite ? 'currentColor' : 'none'} /></button></div>;
});

export default function TransitionLibrary() {
  const leaks = useEditorStore(state => state.leaks);
  const loadLeaks = useEditorStore(state => state.loadLeaks);
  const presets = useEditorStore(state => state.transitionPresets);
  const favorites = useEditorStore(state => state.transitionFavorites);
  const [kind, setKind] = useState<TransitionKind | 'Favorites'>('Dissolves');
  const [query, setQuery] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => { loadLeaks(); }, [loadLeaks]);

  // A search spans every kind: you look for "wipe", not for which tab someone filed it under.
  const search = query.trim().toLowerCase();
  const matches = (...fields: (string | undefined)[]) => !search || fields.some(field => field?.toLowerCase().includes(search));
  const entries = Object.entries(transitionDefinitions).filter(([name, definition]) => !definition.overlay && (search || kind === 'Favorites' ? matches(name, definition.description) : definition.kind === kind));
  // Overlays list one card per leak rather than one card for the whole pack.
  const overlayCards = leaks.filter(leak => matches(leak.name)).map(leak => ({ key: leak.id, name: 'Light leak', label: leak.name, params: { ...Object.fromEntries(transitionDefinitions['Light leak'].parameters.map(p => [p.key, p.initial])), leak: leak.id, blendPoint: Math.round(clampPeak(leak.peakAt) * 100) } as TransitionParams, leakUrl: leak.url, posterUrl: leak.posterUrl, sourceFps: leak.fps || 24 }));
  const namedCards = entries.map(([name, definition]) => ({ key: name, name, label: name, params: Object.fromEntries(definition.parameters.map(p => [p.key, p.initial])) as TransitionParams, leakUrl: undefined, posterUrl: undefined, sourceFps: 24 }));
  const cards = (kind === 'Favorites' || search ? [...namedCards, ...overlayCards] : kind === 'Overlays' ? overlayCards : namedCards)
    .map(card => { const id = transitionPresetId(card.name, card.params), preset = presets.find(item => item.id === id); return { ...card, id, duration: preset?.duration, params: { ...card.params, ...preset?.params } }; })
    .filter(card => kind !== 'Favorites' || favorites.includes(card.id));

  return <div className="transition-library">
    <div className="media-search">
      <Search size={14} />
      <input placeholder="Search transitions…" aria-label="Search transitions" value={query} onChange={event => setQuery(event.target.value)} />
      {query && <button className="search-clear" aria-label="Clear transition search" onClick={() => setQuery('')}>×</button>}
    </div>
    {!search && <div className="transition-kinds">{(['Favorites', ...transitionKinds] as const).map(item => <button key={item} className={kind === item ? 'active' : ''} onClick={() => setKind(item)}>{item}</button>)}</div>}
    <div className="transition-grid">
      {cards.map(card => <TransitionCard key={card.key} name={card.name} label={card.label} params={card.params} leakUrl={card.leakUrl} posterUrl={card.posterUrl} duration={card.duration} sourceFps={card.sourceFps} favorite={favorites.includes(card.id)} onFavorite={() => void useEditorStore.getState().toggleTransitionFavorite(card.id)} />)}
      {!cards.length && (kind === 'Favorites' ? <EmptyState title="No favorite transitions" description="Star a transition to find it here." /> : search
        ? <EmptyState title="No matching transitions" description="Try a shorter word, or clear the search to browse by kind." />
        : kind === 'Overlays' && <EmptyState title="No overlays yet" description="Run scripts/extract-transitions.mjs to cut a light-leak reel into the shared pack, or add one below." />)}
    </div>
    {!search && kind === 'Overlays' && <footer className="transition-footer">
      <input ref={upload} type="file" accept="video/*" className="visually-hidden" aria-label="Add a light leak overlay"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void useEditorStore.getState().addLeak(file);
        }} />
      <button className="upload-button" onClick={() => upload.current?.click()}><Upload size={14} /><span>Add overlay</span><Plus size={13} /></button>
      <span className="media-upload-note"><Sparkles size={11} /> Shared with everyone on this server</span>
    </footer>}
  </div>;
}
