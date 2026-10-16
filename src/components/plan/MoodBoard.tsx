// Plan → Board: a pan-and-zoom canvas of picture, note, text and color cards. Cards are shared rows (store actions,
// locks, undo); where you are looking is yours alone, remembered per project in this browser.
import './board.css';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BringToFront, Check, Columns2, Copy, FolderSearch, Image as ImageIcon, ImageOff, ImagePlus, Images, LoaderCircle, Maximize, Palette, Pencil, Pipette, Plus, StickyNote, Trash2, Type, ZoomIn, ZoomOut } from 'lucide-react';
import { useEditorStore } from '../../state/store';
import type { BoardItem, MediaAsset, User } from '../../state/models';
import { PLAN_LIMITS } from '../../services/plan';
import { palette } from '../../services/palette';
import { api, connection } from '../../services/api';
import { fieldOwnsKey, typingSurface } from '../../services/focus';
import { ContextMenu, EmptyState, IconButton, Modal } from '../ui';
import { addToTimelineEnd, PlanActions } from './slot';
import { copyRich } from './download';

const s = useEditorStore.getState;
const MEDIA_DRAG = 'application/x-frameline-media';
// The world is one plane wider than any card can reach (±coord plus the largest card), so data-cursor-anchor="board"
// covers the whole board and a remote cursor over empty space lands on the same board spot at any pan or zoom.
const L = PLAN_LIMITS.coord + PLAN_LIMITS.maxSize + 30_000;
const WORLD: CSSProperties = { left: -L, top: -L, width: 2 * L, height: 2 * L, transformOrigin: `${L}px ${L}px` }, ORIGIN: CSSProperties = { left: L, top: L };
const ZOOM_MIN = .1, ZOOM_MAX = 4, PICTURE_W = 320;
const SIZES = { note: [220, 160], text: [360, 64], swatch: [120, 150] } as const;
const TINTS = [['Yellow', '#f2c878'], ['Rose', '#eea6b4'], ['Sky', '#9cc4ee'], ['Mint', '#bce8c7'], ['Lilac', '#c5b4ee']] as const;
// What the server reads as a picture (by extension); anything else would be stored as video and fail to prepare.
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|tiff?|bmp|heic)$/i;

type View = { x: number; y: number; zoom: number };
type Point = { x: number; y: number };
type CardDrag = { kind: 'move' | 'resize'; pointer: number; start: Point; moved: boolean; solo?: string; ids: string[]; origin: Map<string, BoardItem>; els: HTMLElement[]; gesture: string; z: Map<string, number>; dx: number; dy: number; lease: number; locked: boolean };
type Drag = CardDrag
  | { kind: 'pan'; pointer: number; start: Point; view: View; moved: boolean; clear: boolean }
  | { kind: 'marquee'; pointer: number; start: Point; moved: boolean; base: string[] }
  | { kind: 'pinch'; dist: number; mid: Point; view: View };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const viewKey = (projectId: string) => `sharedcut:board-view:${projectId}`;
const readView = (projectId: string): View | null => {
  try { const v = JSON.parse(localStorage.getItem(viewKey(projectId)) ?? 'null'); return v && [v.x, v.y, v.zoom].every(Number.isFinite) ? { x: v.x, y: v.y, zoom: clamp(v.zoom, ZOOM_MIN, ZOOM_MAX) } : null; }
  catch { return null; }
};
const ratioOf = (asset?: MediaAsset) => { const m = /(\d+)\s*[×x]\s*(\d+)/.exec(asset?.resolution ?? ''); return m && +m[1] ? clamp(+m[2] / +m[1], .1, 10) : 11 / 16; };
const fileRatio = async (file: File) => { try { const bitmap = await createImageBitmap(file), r = bitmap.height / bitmap.width; bitmap.close(); return clamp(r, .1, 10); } catch { return 11 / 16; } };
// 480 px thumbnails until a card is big on screen: 300 decoded 1920 px pictures would cost gigabytes. A video's proxy is a video.
const imageSrc = (asset: MediaAsset, sharp: boolean) => (sharp && asset.kind === 'image' && asset.proxyUrl) || asset.thumbnail || (asset.kind === 'image' && asset.proxyUrl) || '';
// The server keeps the name as given and reads the kind from its extension; a pasted picture is often a bare "image".
const imageName = (file: File) => { const name = file.name.replace(/[\\/\x00-\x1f]/g, '-').trim().slice(-200) || 'Pasted image', type = file.type.split('/')[1]; return IMAGE_FILE.test(name) ? name : `${name}.${type === 'jpeg' ? 'jpg' : type || 'png'}`; };
// copyRich falls back to a selection copy where the clipboard API is missing (plain-HTTP LAN address); colors are #rrggbb, safe as HTML.
const copyHex = (color?: string) => { if (color) void copyRich(color, color).then(ok => ok ? s().notify(`Copied ${color}`, 'success') : s().notify('Could not copy the color', 'error')); };
const projectCards = () => { const st = s(); return st.boardItems.filter(i => i.projectId === st.projectId); };

// Typing holds the card's text lock, as TextInspector does: flush first (the server only locks a card it has saved), renew
// every 3 s, release when typing ends. Text goes out 400 ms after the last key, one undo step per edit.
function CardText({ item, onDone }: { item: BoardItem; onDone: () => void }) {
  const [draft, setDraft] = useState(item.text ?? ''), ref = useRef<HTMLTextAreaElement>(null), latest = useRef(draft), timer = useRef(0), gesture = useMemo(() => crypto.randomUUID(), []);
  const commit = () => { clearTimeout(timer.current); const now = s().boardItems.find(i => i.id === item.id); if (now && latest.current !== (now.text ?? '')) s().updateBoardItems([{ id: item.id, patch: { text: latest.current } }], gesture); };
  const commitRef = useRef(commit); commitRef.current = commit;
  useEffect(() => {
    const el = ref.current; el?.focus({ preventScroll: true }); el?.setSelectionRange(el.value.length, el.value.length);
    let live = true, lease = 0;
    void connection.flush().catch(() => {}).then(() => {
      if (!live) return;
      if (!s().acquireLock(item.id, 'text')) { onDone(); return; }
      lease = window.setInterval(() => { if (!s().renewLock(item.id, 'text') && !s().acquireLock(item.id, 'text')) onDone(); }, 3000);
    });
    return () => { live = false; clearInterval(lease); commitRef.current(); s().releaseLock(item.id, 'text'); };
  }, [item.id]);
  return <textarea ref={ref} className="board-words" aria-label={item.kind === 'note' ? 'Note text' : 'Board text'} spellCheck maxLength={PLAN_LIMITS.boardText} value={draft}
    onChange={e => { latest.current = e.target.value; setDraft(e.target.value); clearTimeout(timer.current); timer.current = window.setTimeout(commit, 400); }}
    onBlur={onDone} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onDone(); } }}/>;
}

type CardProps = { item: BoardItem; asset?: MediaAsset; selected: boolean; owner?: User; editing: boolean; handle: boolean; sharp: boolean; editable: boolean; onDone: () => void };
// Memoised by props, so a drag, a remote edit or a pan re-renders only the cards it touches. Pointer handling is delegated to the viewport.
const Card = memo(function Card({ item, asset, selected, owner, editing, handle, sharp, editable, onDone }: CardProps) {
  const style = { transform: `translate(${item.x}px,${item.y}px)`, width: item.w, height: item.h, zIndex: Math.round(item.z), '--tint': item.color, ...(owner ? { '--owner-color': owner.color } : {}) } as CSSProperties;
  const label = item.kind === 'image' ? asset?.name ?? 'Image removed' : item.kind === 'swatch' ? `Color ${item.color}` : item.text || (item.kind === 'note' ? 'Empty note' : 'Empty text');
  const src = asset ? imageSrc(asset, sharp) : '';
  return <div data-board-card={item.id} data-cursor-anchor={item.id} role="group" aria-label={label} className={`board-card board-${item.kind}${selected ? ' selected' : ''}${owner ? ' owned' : ''}`} style={style}>
    {item.kind === 'image' ? asset ? <>{src ? <img src={src} alt={asset.name} draggable={false} loading="lazy" decoding="async"/>
      : <span className="board-missing">{asset.status === 'failed' ? <><ImageOff size={16}/>Could not prepare this picture</> : <><LoaderCircle size={16} className="spin"/>Preparing…</>}</span>}
      <span className="board-caption">{asset.name}</span></>
      : <span className="board-missing"><ImageOff size={16}/>Image removed</span>
    : item.kind === 'swatch' ? <><span className="board-swatch-color" style={{ background: item.color }}/><button type="button" className="board-hex mono" data-board-hex title="Copy hex">{item.color}</button></>
    : editing ? <CardText item={item} onDone={onDone}/>
    : <p className="board-words">{item.text || (editable && <span className="board-placeholder">{item.kind === 'note' ? 'Double-click to write' : 'Double-click to type'}</span>)}</p>}
    {owner && <span className="board-owner"><i/>{owner.name}</span>}
    {handle && <span className="board-resize" data-board-resize aria-hidden="true"/>}
  </div>;
});

export default function MoodBoard() {
  const projectId = useEditorStore(st => st.projectId), focus = useEditorStore(st => st.planFocus);
  const items = useEditorStore(useShallow(st => st.boardItems.filter(i => i.projectId === st.projectId)));
  const media = useEditorStore(st => st.media), users = useEditorStore(st => st.users);
  const editor = useEditorStore(st => ['Owner', 'Editor'].includes(st.projects.find(p => p.id === st.projectId)?.members.find(m => m.userId === st.currentUserId)?.role ?? ''));
  // Every envelope replaces the locks list; a string key re-renders only when who holds which card changes.
  const lockKey = useEditorStore(st => st.locks.filter(l => l.projectId === st.projectId && l.userId !== st.currentUserId && l.expiresAt > Date.now()).map(l => `${l.targetId}\t${l.userId}`).sort().join('\n'));
  const owners = useMemo(() => new Map<string, User>(lockKey ? lockKey.split('\n').map(line => { const [id, userId] = line.split('\t'); return [id, users.find(u => u.id === userId) ?? { id: userId, name: 'Someone', email: '', initials: '?', color: '#bf8fea' }]; }) : []), [lockKey, users]);
  const assets = useMemo(() => new Map(media.filter(m => m.projectId === projectId).map(m => [m.id, m])), [media, projectId]);

  const viewport = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), colorInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 }), viewRef = useRef(view); viewRef.current = view;
  const [selected, setSelected] = useState<string[]>([]), selectedRef = useRef(selected); selectedRef.current = selected;
  const [editing, setEditing] = useState<string | null>(null), [picking, setPicking] = useState(false), [spaced, setSpaced] = useState(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id?: string; at?: Point } | null>(null);
  const drag = useRef<Drag | null>(null), pointers = useRef(new Map<number, Point>()), press = useRef(0), space = useRef(false);
  const colorTarget = useRef<{ id: string; gesture: string } | null>(null), nudged = useRef({ gesture: '', at: 0 });

  const size = () => ({ w: viewport.current?.clientWidth || 800, h: viewport.current?.clientHeight || 600 });
  // Pointer to viewport pixels; the ratio undoes the app's ui-scale zoom.
  const local = (e: { clientX: number; clientY: number }): Point => { const el = viewport.current!, r = el.getBoundingClientRect(), k = r.width / el.offsetWidth || 1; return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; };
  const toWorld = (p: Point, v = viewRef.current): Point => ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom });
  const centre = () => { const { w, h } = size(); return toWorld({ x: w / 2, y: h / 2 }); };
  const zoomAt = (px: number, py: number, factor: number) => setView(v => { const zoom = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX); return { zoom, x: px - (px - v.x) * zoom / v.zoom, y: py - (py - v.y) * zoom / v.zoom }; });
  const zoomCentre = (factor: number) => { const { w, h } = size(); zoomAt(w / 2, h / 2, factor); };
  const fitTo = (list: readonly BoardItem[]): View => {
    const { w, h } = size(); if (!list.length) return { x: w / 2, y: h / 2, zoom: 1 };
    const x0 = Math.min(...list.map(i => i.x)), y0 = Math.min(...list.map(i => i.y)), x1 = Math.max(...list.map(i => i.x + i.w)), y1 = Math.max(...list.map(i => i.y + i.h));
    const zoom = clamp(Math.min(Math.max(1, w - 96) / (x1 - x0), Math.max(1, h - 96) / (y1 - y0)), ZOOM_MIN, 1);
    return { zoom, x: w / 2 - (x0 + x1) / 2 * zoom, y: h / 2 - (y0 + y1) / 2 * zoom };
  };

  // Before the first paint: the remembered view, else the whole board fitted (an empty one centres 0,0 at 100%).
  useLayoutEffect(() => { setView(readView(projectId) ?? fitTo(projectCards())); }, [projectId]);
  useEffect(() => { const t = setTimeout(() => { try { localStorage.setItem(viewKey(projectId), JSON.stringify(view)); } catch { /* private window: the view is just not remembered */ } }, 300); return () => clearTimeout(t); }, [view, projectId]);
  // openPlan('board', id): centre the card (zooming out if it does not fit) and select it.
  useEffect(() => {
    const item = focus ? projectCards().find(i => i.id === focus) : undefined; if (!item) return;
    const { w, h } = size(), zoom = Math.min(viewRef.current.zoom, Math.max(ZOOM_MIN, Math.min((w - 96) / item.w, (h - 96) / item.h)));
    setView({ zoom, x: w / 2 - (item.x + item.w / 2) * zoom, y: h / 2 - (item.y + item.h / 2) * zoom });
    setSelected([item.id]); useEditorStore.setState({ planFocus: null });
  }, [focus]);

  // A card centred on `at`; one already sitting exactly there pushes the newcomer down and right, so repeats fan out.
  const spot = (w: number, h: number, at = centre()) => { let x = Math.round(at.x - w / 2), y = Math.round(at.y - h / 2); const taken = projectCards(); while (taken.some(i => Math.abs(i.x - x) < 4 && Math.abs(i.y - y) < 4)) { x += 24; y += 24; } return { x, y }; };
  const editColor = (id: string) => {
    const input = colorInput.current, item = s().boardItems.find(i => i.id === id), v = viewRef.current; if (!input || !item || !editor) return;
    colorTarget.current = { id, gesture: crypto.randomUUID() }; input.value = item.color ?? '#bce8c7';
    // The picker opens beside its input, so the input sits on the card.
    Object.assign(input.style, { left: `${v.x + (item.x + item.w / 2) * v.zoom}px`, top: `${v.y + (item.y + item.h / 2) * v.zoom}px` });
    try { input.showPicker(); } catch { input.click(); }
  };
  const startEdit = (id: string) => {
    const item = s().boardItems.find(i => i.id === id); if (!editor || !item || (item.kind !== 'note' && item.kind !== 'text')) return;
    const owner = owners.get(id); if (owner) { s().notify(`${owner.name} is editing this card`, 'info'); return; }
    setSelected([id]); setEditing(id);
  };
  // `at` (from the board menu) is the card's top-left corner; without it the card lands mid-view.
  const addCard = (kind: keyof typeof SIZES, at?: Point) => {
    const [w, h] = SIZES[kind], [id] = s().addBoardItems([{ kind, w, h, ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : spot(w, h)) }]);
    if (!id) return; setSelected([id]);
    if (kind === 'swatch') editColor(id); else setEditing(id);
  };
  const addPictures = (list: { mediaId: string; ratio: number }[], at?: Point) => {
    if (!list.length) return;
    let { x, y } = spot(PICTURE_W, PICTURE_W * list[0].ratio, at);
    const added = s().addBoardItems(list.map(({ mediaId, ratio }) => { const card = { kind: 'image' as const, mediaId, x, y, w: PICTURE_W, h: Math.round(PICTURE_W * ratio) }; x += PICTURE_W + 16; return card; }));
    if (added.length) setSelected(added);
  };
  const addMedia = (ids: string[], at?: Point) => {
    const list = ids.map(id => assets.get(id)).filter((m): m is MediaAsset => !!m && (m.kind === 'image' || m.kind === 'video'));
    if (!list.length) { s().notify('Only pictures and video can go on the board', 'info'); return; }
    addPictures(list.map(m => ({ mediaId: m.id, ratio: ratioOf(m) })), at);
  };
  // One request per picture (as Grab still does) with our own id, so the card can point at it the moment it exists.
  const upload = async (files: File[], at = centre()) => {
    if (!editor) { s().notify('Editing requires an editor role', 'info'); return; }
    const pictures = files.map(file => ({ file, name: imageName(file) })).filter(p => IMAGE_FILE.test(p.name));
    if (!pictures.length) { if (files.length) s().notify('Only pictures can go on the board', 'info', 'PNG, JPEG, WebP, GIF, TIFF, BMP or HEIC.'); return; }
    if (!connection.enabled) { s().notify('Pictures need the SharedCut server', 'error', 'This copy is offline, so nothing can be uploaded.'); return; }
    const projectId = s().projectId, done: { mediaId: string; ratio: number }[] = [];
    s().notify(`Uploading ${plural(pictures.length, 'image')}…`, 'info');
    await connection.flush().catch(() => {});
    for (const { file, name } of pictures) {
      const id = `media-${crypto.randomUUID()}`;
      try {
        await api(`/media?${new URLSearchParams({ projectId, id, name })}`, { method: 'POST', body: file });
        // Into the fixed 'Mood board' bin; a failed move only leaves the picture in B-roll.
        await api(`/media/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ binId: 'board' }) }).catch(() => {});
        done.push({ mediaId: id, ratio: await fileRatio(file) });
      } catch (error) { s().notify(`Could not upload ${file.name || 'the picture'}`, 'error', (error as Error).message); }
    }
    if (!done.length) return;
    await connection.refresh();
    if (s().projectId === projectId) addPictures(done, at);
  };
  const uploadRef = useRef(upload); uploadRef.current = upload;
  // Swatches of the picture's main colors in a row under it, read from the small thumbnail (same origin, so the canvas stays readable).
  const pullColors = async (item: BoardItem) => {
    const asset = assets.get(item.mediaId ?? ''), src = asset && imageSrc(asset, false);
    if (!src) { s().notify('The picture is still being prepared', 'info'); return; }
    try {
      const img = new Image(); img.src = src; await img.decode();
      const k = Math.min(1, 200 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h }), context = canvas.getContext('2d', { willReadFrequently: true })!;
      // Nearest pixel, not smoothed: a downscale's blends where two colors meet are not colors of the picture.
      context.imageSmoothingEnabled = false; context.drawImage(img, 0, 0, w, h);
      const colors = palette(context.getImageData(0, 0, w, h).data, 5);
      if (!colors.length) { s().notify('No colors found in this picture', 'info'); return; }
      const gap = 12, side = Math.max(64, Math.floor((item.w - gap * (colors.length - 1)) / colors.length));
      const ids = s().addBoardItems(colors.map((color, i) => ({ kind: 'swatch' as const, color, x: item.x + i * (side + gap), y: item.y + item.h + 16, w: side, h: side + 26 })));
      if (ids.length) setSelected(ids);
    } catch { s().notify('Could not read the picture', 'error'); }
  };
  const toFront = (ids: string[]) => {
    const all = projectCards(), top = Math.max(0, ...all.filter(i => !ids.includes(i.id)).map(i => i.z));
    s().updateBoardItems(all.filter(i => ids.includes(i.id)).sort((a, b) => a.z - b.z).map((i, n) => ({ id: i.id, patch: { z: top + 1 + n } })));
  };
  const remove = (ids: string[]) => { s().deleteBoardItems(ids); setSelected(list => list.filter(id => s().boardItems.some(i => i.id === id))); };
  const duplicate = (ids: string[]) => {
    const added = s().addBoardItems(projectCards().filter(i => ids.includes(i.id)).map(({ kind, x, y, w, h, mediaId, text, color }) => ({ kind, x: x + 24, y: y + 24, w, h, mediaId, text, color })));
    if (added.length) setSelected(added);
  };
  // A burst of arrow presses is one undo step.
  const nudge = (dx: number, dy: number) => {
    const ids = selectedRef.current; if (!editor || !ids.length || (!dx && !dy)) return;
    const g = nudged.current; if (Date.now() - g.at > 1000) g.gesture = crypto.randomUUID(); g.at = Date.now();
    s().updateBoardItems(projectCards().filter(i => ids.includes(i.id)).map(i => ({ id: i.id, patch: { x: i.x + dx, y: i.y + dy } })), g.gesture);
  };
  const openMenu = (clientX: number, clientY: number, id?: string) => {
    const item = id ? s().boardItems.find(i => i.id === id) : undefined;
    if (item) { if (!editor && (item.kind === 'note' || item.kind === 'text')) return; if (!selectedRef.current.includes(item.id)) setSelected([item.id]); setMenu({ x: clientX, y: clientY, id: item.id }); }
    else if (editor) setMenu({ x: clientX, y: clientY, at: toWorld(local({ clientX, clientY })) });
  };

  // Drags write transforms straight to the DOM; the store hears about it once, at the drop: every save seals its history row,
  // so commits mid-drag made a permanent row (and an upload of every dragged card) per step.
  const sized = (d: CardDrag, o: BoardItem): [number, number] => {
    const { minSize: lo, maxSize: hi } = PLAN_LIMITS;
    if (o.kind !== 'image') return [Math.round(clamp(o.w + d.dx, lo, hi)), Math.round(clamp(o.h + d.dy, lo, hi))];
    // Pictures keep their shape: the larger pull wins.
    const k = clamp(Math.max((o.w + d.dx) / o.w, (o.h + d.dy) / o.h), Math.max(lo / o.w, lo / o.h), Math.min(hi / o.w, hi / o.h));
    return [Math.round(o.w * k), Math.round(o.h * k)];
  };
  const patchOf = (d: CardDrag, o: BoardItem): { x?: number; y?: number; w?: number; h?: number; z?: number } => { const z = d.z.get(o.id), front = z === undefined ? {} : { z }; if (d.kind === 'move') return { x: Math.round(o.x + d.dx), y: Math.round(o.y + d.dy), ...front }; const [w, h] = sized(d, o); return { w, h, ...front }; };
  const paint = (d: CardDrag) => { for (const el of d.els) { const o = d.origin.get(el.dataset.boardCard!)!, p = patchOf(d, o); if (d.kind === 'move') el.style.transform = `translate(${p.x}px,${p.y}px)`; else { el.style.width = `${p.w}px`; el.style.height = `${p.h}px`; } if (p.z !== undefined) el.style.zIndex = String(p.z); } };
  const commit = (d: CardDrag) => { s().updateBoardItems([...d.origin.values()].map(o => ({ id: o.id, patch: patchOf(d, o) })), d.gesture); };
  // Back to what the store holds (a refused move must not leave a card where the pointer let go), and the locks go.
  const settle = (d: CardDrag) => {
    clearInterval(d.lease); if (d.locked) s().releaseLocks(d.ids, 'manipulation');
    for (const el of d.els) { const i = s().boardItems.find(item => item.id === el.dataset.boardCard); if (i) Object.assign(el.style, { transform: `translate(${i.x}px,${i.y}px)`, width: `${i.w}px`, height: `${i.h}px`, zIndex: String(Math.round(i.z)) }); }
  };
  // The first real move takes the cards' manipulation locks, after a flush: the server only locks cards it has saved.
  const begin = (d: CardDrag) => {
    d.els = d.ids.map(id => world.current?.querySelector<HTMLElement>(`[data-board-card="${CSS.escape(id)}"]`)).filter((el): el is HTMLElement => !!el);
    void connection.flush().catch(() => {}).then(() => {
      if (drag.current !== d) return;
      if (!s().acquireLocks(d.ids, 'manipulation')) { drag.current = null; settle(d); return; }
      d.locked = true; d.lease = window.setInterval(() => s().acquireLocks(d.ids, 'manipulation'), 3000);
    });
  };
  const end = () => {
    const d = drag.current; drag.current = null; clearTimeout(press.current); if (!d) return;
    if (d.kind === 'pan' && !d.moved && d.clear) setSelected([]);
    else if (d.kind === 'marquee') setMarquee(null);
    else if ((d.kind === 'move' || d.kind === 'resize') && d.moved) { commit(d); settle(d); }
    else if (d.kind === 'move' && d.solo) setSelected([d.solo]); // a click without a drag picks just that card
  };
  useEffect(() => () => { const d = drag.current; if (d?.kind === 'move' || d?.kind === 'resize') settle(d); }, []);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (e.button === 2 || target.closest('textarea')) return;
    if (e.button === 1) e.preventDefault(); // no autoscroll: the middle button pans
    viewport.current?.focus({ preventScroll: true });
    // A mouse has one pointer: a press whose release we missed (let go outside the window) must not block this one.
    if (e.pointerType !== 'touch') { pointers.current.clear(); end(); }
    const p = local(e); pointers.current.set(e.pointerId, p); clearTimeout(press.current);
    if (e.pointerType === 'touch' && pointers.current.size === 2) {
      end(); const [a, b] = [...pointers.current.values()];
      drag.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: viewRef.current }; return;
    }
    if (pointers.current.size > 1 || drag.current) return;
    const id = target.closest<HTMLElement>('[data-board-card]')?.dataset.boardCard;
    // Touch has no right button: holding still for half a second opens the menu.
    if (e.pointerType === 'touch') { const { clientX, clientY } = e; press.current = window.setTimeout(() => { drag.current = null; openMenu(clientX, clientY, id); }, 500); }
    if (!id || space.current || e.button === 1) {
      drag.current = !id && e.shiftKey && e.button === 0 ? { kind: 'marquee', pointer: e.pointerId, start: p, moved: false, base: selectedRef.current } : { kind: 'pan', pointer: e.pointerId, start: p, view: viewRef.current, moved: false, clear: !id && !e.shiftKey };
      return;
    }
    const was = selectedRef.current, picked = was.includes(id);
    if (e.shiftKey) { setSelected(picked ? was.filter(x => x !== id) : [...was, id]); if (picked) return; }
    else if (!picked) setSelected([id]);
    // Viewers look around: dragging a card pans the board instead.
    if (!editor) { drag.current = { kind: 'pan', pointer: e.pointerId, start: p, view: viewRef.current, moved: false, clear: false }; return; }
    const resize = !!target.closest('[data-board-resize]'), moving = resize ? [id] : e.shiftKey ? [...was, id] : picked ? was : [id];
    const held = moving.find(x => owners.has(x)); if (held) { s().notify(`${owners.get(held)!.name} is editing this card`, 'info'); return; }
    const all = projectCards(), origin = new Map(all.filter(i => moving.includes(i.id)).map(i => [i.id, i])), top = Math.max(0, ...all.filter(i => !origin.has(i.id)).map(i => i.z));
    // Dragged cards come to the front, keeping their order among themselves; already on top, z stays put.
    const order = [...origin.values()].sort((a, b) => a.z - b.z), z = new Map<string, number>(order.every(i => i.z > top) ? [] : order.map((i, n) => [i.id, top + 1 + n]));
    drag.current = { kind: resize ? 'resize' : 'move', pointer: e.pointerId, start: p, moved: false, solo: picked && !e.shiftKey && was.length > 1 ? id : undefined, ids: [...origin.keys()], origin, els: [], gesture: crypto.randomUUID(), z, dx: 0, dy: 0, lease: 0, locked: false };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e); pointers.current.set(e.pointerId, p);
    const d = drag.current; if (!d) return;
    if (d.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()]; if (!b) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom = clamp(d.view.zoom * Math.hypot(a.x - b.x, a.y - b.y) / d.dist, ZOOM_MIN, ZOOM_MAX), at = toWorld(d.mid, d.view);
      setView({ zoom, x: mid.x - at.x * zoom, y: mid.y - at.y * zoom }); return;
    }
    if (d.pointer !== e.pointerId) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      // Capture only now: a plain click must still reach the hex button under it.
      d.moved = true; clearTimeout(press.current); viewport.current?.setPointerCapture(e.pointerId);
      if (d.kind === 'move' || d.kind === 'resize') begin(d);
    }
    if (d.kind === 'pan') setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
    else if (d.kind === 'marquee') {
      const box = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) }, a = toWorld(box), b = toWorld({ x: box.x + box.w, y: box.y + box.h });
      setMarquee(box); setSelected([...new Set([...d.base, ...projectCards().filter(i => i.x < b.x && i.x + i.w > a.x && i.y < b.y && i.y + i.h > a.y).map(i => i.id)])]);
    } else {
      d.dx = dx / viewRef.current.zoom; d.dy = dy / viewRef.current.zoom; paint(d);
    }
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d?.kind === 'pinch') { if (pointers.current.size < 2) drag.current = null; return; }
    if (d && d.pointer === e.pointerId) end(); else clearTimeout(press.current);
  };

  // Wheel and trackpad pan; ctrl+wheel (a trackpad pinch) or ⌘ / Ctrl + wheel zooms around the pointer. Not passive, to keep the page still.
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('textarea')) return; // a long note scrolls its own text
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1, p = local(e);
      if (e.ctrlKey || e.metaKey) { zoomAt(p.x, p.y, Math.exp(-clamp(e.deltaY * unit, -50, 50) / 100)); return; }
      const sideways = e.shiftKey && !e.deltaX, dx = (sideways ? e.deltaY : e.deltaX) * unit, dy = (sideways ? 0 : e.deltaY) * unit;
      setView(v => ({ ...v, x: v.x - dx, y: v.y - dy }));
    };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  }, []);
  // Capture, like the motion tracker: while the board has focus and nothing is being typed, its keys beat the editor's
  // (Delete would otherwise delete the selected timeline clip, arrows move the playhead).
  const keys = useRef<(e: KeyboardEvent) => boolean | 'pass'>(() => false);
  keys.current = e => {
    const mod = e.metaKey || e.ctrlKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key, ids = selectedRef.current;
    if (key === ' ') { space.current = true; setSpaced(true); return true; }
    if (key === 'Escape') { setSelected([]); return true; }
    // ⌘V goes on to the browser, which fires the paste that brings pictures in; the clip clipboard stays out of the board.
    if (mod && (key === 'c' || key === 'x' || key === 'v')) return 'pass';
    if (mod && key === 'a') { setSelected(projectCards().map(i => i.id)); return true; }
    if (mod && key === 'd') { if (editor) duplicate(ids); return true; }
    if (key === 'Delete' || key === 'Backspace') { if (editor && ids.length) remove(ids); return true; }
    if (key === 'Enter') { if (ids.length === 1) startEdit(ids[0]); return true; }
    if (key.startsWith('Arrow')) { const step = mod ? 0 : e.shiftKey ? 10 : 1; nudge(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0); return true; }
    return false;
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || fieldOwnsKey(e.target as Element, e.key) || !viewport.current?.contains(document.activeElement)) return;
      const handled = keys.current(e); if (!handled) return;
      if (handled !== 'pass') e.preventDefault(); e.stopImmediatePropagation();
    };
    const release = () => { space.current = false; setSpaced(false); }, up = (e: KeyboardEvent) => { if (e.key === ' ') release(); }; // blur: a Space let go in another window
    const paste = (e: ClipboardEvent) => {
      const active = document.activeElement, files = Array.from(e.clipboardData?.files ?? []);
      if (!viewport.current?.contains(active) || typingSurface(active) || !files.length) return;
      e.preventDefault(); void uploadRef.current(files);
    };
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', release); document.addEventListener('paste', paste);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', release); document.removeEventListener('paste', paste); };
  }, []);

  const accepts = (e: DragEvent) => e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(MEDIA_DRAG);
  const onDone = useCallback(() => { setEditing(null); viewport.current?.focus({ preventScroll: true }); }, []);
  const cardId = (el: EventTarget) => (el as Element).closest<HTMLElement>('[data-board-card]')?.dataset.boardCard;
  const single = selected.length === 1 ? selected[0] : null, chosen = useMemo(() => new Set(selected), [selected]), dpr = window.devicePixelRatio || 1;
  let grid = 24 * view.zoom; while (grid < 12) grid *= 4; // the dot grid thins out instead of turning grey

  const menuItems = (m: NonNullable<typeof menu>) => {
    const run = (fn: () => void) => () => { setMenu(null); fn(); };
    if (!m.id) return <><button role="menuitem" onClick={run(() => addCard('note', m.at))}><StickyNote/>Add note here</button><button role="menuitem" onClick={run(() => addCard('text', m.at))}><Type/>Add text here</button></>;
    const item = items.find(i => i.id === m.id); if (!item) return null;
    const ids = selected.includes(item.id) ? selected : [item.id], edit = editor && !owners.has(item.id), asset = item.mediaId ? assets.get(item.mediaId) : undefined;
    const tail = edit && <><button role="menuitem" onClick={run(() => toFront(ids))}><BringToFront/>Bring to front</button><button role="menuitem" onClick={run(() => remove(ids))}><Trash2/>Delete<kbd>⌫</kbd></button></>;
    if (item.kind === 'image') return <>
      <button role="menuitem" disabled={!editor || !asset} onClick={run(() => void pullColors(item))}><Pipette/>Pull colors</button>
      <button role="menuitem" disabled={!asset} onClick={run(() => s().setColorReference(asset!.id))}><Columns2/>Compare on Color page</button>
      <button role="menuitem" disabled={!asset} onClick={run(() => s().revealMedia(asset!.id))}><FolderSearch/>Show in media</button>
      <button role="menuitem" disabled={!editor || asset?.status !== 'ready'} title={asset && asset.status !== 'ready' ? 'Still being prepared' : undefined} onClick={run(() => addToTimelineEnd([asset!.id], asset!.name))}><Plus/>Add to timeline</button>
      {edit && <div className="divider"/>}{tail}</>;
    if (item.kind === 'swatch') return <><button role="menuitem" onClick={run(() => copyHex(item.color))}><Copy/>Copy hex</button>{edit && <button role="menuitem" onClick={run(() => editColor(item.id))}><Palette/>Edit color</button>}{edit && <div className="divider"/>}{tail}</>;
    const tinted = ids.filter(id => items.some(i => i.id === id && (i.kind === 'note' || i.kind === 'text')));
    return <>{edit && <><span className="menu-heading">Color</span><div className="board-tints">{TINTS.map(([name, color]) => <button key={color} role="menuitem" aria-label={name} title={name} className={item.color === color ? 'active' : ''} style={{ '--tint': color } as CSSProperties} onClick={run(() => s().updateBoardItems(tinted.map(id => ({ id, patch: { color } }))))}/>)}</div>
      <button role="menuitem" onClick={run(() => startEdit(item.id))}><Pencil/>Edit text<kbd>↵</kbd></button><div className="divider"/></>}{tail}</>;
  };
  const onBoard = picking ? new Set(items.map(i => i.mediaId)) : null;
  const pictures = picking ? [...assets.values()].filter(m => (m.kind === 'image' || m.kind === 'video') && m.status !== 'failed').sort((a, b) => a.name.localeCompare(b.name)) : [];

  return <section className="mood-board panel" aria-label="Mood board">
    <PlanActions><div className="board-actions">
      <IconButton label="Add note" disabled={!editor} onClick={() => addCard('note')}><StickyNote size={15}/></IconButton>
      <IconButton label="Add text" disabled={!editor} onClick={() => addCard('text')}><Type size={15}/></IconButton>
      <IconButton label="Add color swatch" disabled={!editor} onClick={() => addCard('swatch')}><Palette size={15}/></IconButton>
      <IconButton label="Upload images" disabled={!editor} onClick={() => fileInput.current?.click()}><ImagePlus size={15}/></IconButton>
      <IconButton label="Add from project media" disabled={!editor} onClick={() => setPicking(true)}><Images size={15}/></IconButton>
      <span className="board-divider" aria-hidden="true"/>
      <IconButton label="Zoom out" className="board-zoom-step" onClick={() => zoomCentre(1 / 1.25)}><ZoomOut size={15}/></IconButton>
      <button type="button" className="board-zoom mono" title="Zoom to 100%" onClick={() => zoomCentre(1 / viewRef.current.zoom)}>{Math.round(view.zoom * 100)}%</button>
      <IconButton label="Zoom in" className="board-zoom-step" onClick={() => zoomCentre(1.25)}><ZoomIn size={15}/></IconButton>
      <IconButton label="Fit board to view" onClick={() => setView(fitTo(projectCards()))}><Maximize size={15}/></IconButton>
    </div></PlanActions>
    <div ref={viewport} className={`board-viewport${spaced ? ' panning' : ''}`} tabIndex={0} role="application" aria-label="Mood board canvas" aria-roledescription="board"
      style={{ '--grid': `${grid}px`, '--grid-x': `${view.x}px`, '--grid-y': `${view.y}px` } as CSSProperties}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={e => { const id = cardId(e.target); if (id) startEdit(id); }}
      onContextMenu={e => { if ((e.target as Element).closest('textarea')) return; e.preventDefault(); clearTimeout(press.current); openMenu(e.clientX, e.clientY, cardId(e.target)); }}
      onClick={e => { const hex = (e.target as Element).closest('[data-board-hex]'); if (!hex) return; copyHex(s().boardItems.find(i => i.id === cardId(hex))?.color); viewport.current?.focus({ preventScroll: true }); }}
      onDragOver={e => { if (!accepts(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = editor ? 'copy' : 'none'; }}
      onDrop={e => {
        // Always ours: the media panel's own drop would upload the files a second time, into B-roll.
        e.preventDefault(); e.stopPropagation(); if (!accepts(e)) return;
        if (!editor) { s().notify('Editing requires an editor role', 'info'); return; }
        const at = toWorld(local(e)), ids = e.dataTransfer.getData(MEDIA_DRAG);
        if (ids) addMedia(ids.split('\n').filter(Boolean), at); else void upload(Array.from(e.dataTransfer.files), at);
      }}
      // Focusing a card's text can scroll this overflow-hidden box; the view is the transform alone.
      onScroll={e => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; }}>
      <div ref={world} className="board-world" data-cursor-anchor="board" style={{ ...WORLD, transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})`, '--zoom': view.zoom } as CSSProperties}>
        <div className="board-origin" style={ORIGIN}>{items.map(item => <Card key={item.id} item={item} asset={item.mediaId ? assets.get(item.mediaId) : undefined} selected={chosen.has(item.id)} owner={owners.get(item.id)} editing={editing === item.id}
          handle={editor && single === item.id && editing !== item.id && !owners.has(item.id)} sharp={item.w * view.zoom * dpr > 560} editable={editor} onDone={onDone}/>)}</div>
      </div>
      {marquee && <div className="board-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}/>}
    </div>
    {!items.length && <p className="board-hint">{editor ? 'Drop images, paste, or add a note. Right-click an image to pull its colors or compare it on the Color page.' : 'Nothing on the board yet.'}</p>}
    <input ref={fileInput} type="file" multiple accept="image/*" className="visually-hidden" tabIndex={-1} aria-label="Upload images to the board" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void upload(files); }}/>
    <input ref={colorInput} type="color" className="visually-hidden" tabIndex={-1} aria-label="Card color" onChange={e => { const t = colorTarget.current; if (t) s().updateBoardItems([{ id: t.id, patch: { color: e.target.value } }], t.gesture); }}/>
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>{menuItems(menu)}</ContextMenu>}
    {picking && <Modal title="Add from project" wide onClose={() => setPicking(false)}><div className="modal-body">
      {pictures.length ? <div className="board-picker">{pictures.map(m => <button key={m.id} type="button" className="board-pick" title={m.name} onClick={() => addMedia([m.id])}>
        <span className="board-pick-thumb">{m.thumbnail ? <img src={m.thumbnail} alt="" loading="lazy" draggable={false}/> : <ImageIcon size={18}/>}</span>
        <span className="board-pick-name">{m.name}</span>{onBoard!.has(m.id) && <Check size={11} className="board-pick-on" aria-label="On the board"/>}
      </button>)}</div> : <EmptyState icon={<Images size={26}/>} title="No pictures yet" description="Upload images or video to this project first."/>}
    </div></Modal>}
  </section>;
}
