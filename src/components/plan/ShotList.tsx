// The Plan workspace's shot list: one row per shot under its script scene, with the takes the media bin holds for it.
import './shots.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowDown, ArrowUp, ClipboardCopy, ClipboardList, Copy, Download, FileSpreadsheet, Film, MoreHorizontal, Plus, Printer, Scissors, ScrollText, Search, Trash2, X } from 'lucide-react';
import { useEditorStore } from '../../state/store';
import { connection } from '../../services/api';
import { createId, lockConflict } from '../../services/index';
import { typingSurface } from '../../services/focus';
import { ordered, PLAN_LIMITS } from '../../services/plan';
import { groupShots, shotTakes, shotsCsv, shotsHtml, takesIndex, SHOT_MOVES, SHOT_SIZES, type ShotGroup, type ShotRow } from '../../services/shots';
import type { MediaAsset, Shot, User } from '../../state/models';
import { Button, ContextMenu, EmptyState, IconButton, Modal } from '../ui';
import { addToTimelineEnd, PlanActions } from './slot';
import { copyRich, downloadFile, printHtml, safeFileName } from './download';

const s = useEditorStore.getState;
const NO_SCENE = 'none', COLUMNS = 10;
const groupKey = (g: ShotGroup) => g.sceneId ?? NO_SCENE;
type TextField = 'number' | 'text' | 'cast' | 'location' | 'notes';
const LIMIT: Record<TextField, number> = { number: PLAN_LIMITS.shotNumber, text: PLAN_LIMITS.shotText, notes: PLAN_LIMITS.shotNotes, cast: PLAN_LIMITS.field, location: PLAN_LIMITS.field };

/** Opens Edit on the take's first clip (this timeline first, then the earliest), selected and under the playhead. */
function jumpToTake(mediaIds: string[]) {
  const st = s(), ids = new Set(mediaIds);
  const clip = st.clips.filter(c => c.projectId === st.projectId && ids.has(c.mediaId)).sort((a, b) => Number(a.timelineId !== st.timelineId) - Number(b.timelineId !== st.timelineId) || a.start - b.start)[0];
  if (!clip) return;
  // ponytail: a take inside a composition opens that timeline directly, without the composition trail; openComposition if it matters.
  // setTimeline resets the playhead and selection, so it goes first.
  if (clip.timelineId !== st.timelineId) st.setTimeline(clip.timelineId);
  st.setWorkspace('edit'); st.selectClip(clip.id); st.setPlayhead(clip.start);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const scroll = document.querySelector<HTMLElement>('.timeline-scroll'), line = scroll?.querySelector<HTMLElement>('.local-playhead');
    if (!scroll || !line) return;
    const box = scroll.getBoundingClientRect(), scale = box.width / (scroll.offsetWidth || 1), x = line.getBoundingClientRect().left;
    if (x < box.left + 170 * scale || x > box.right - 20 * scale) scroll.scrollLeft += (x - (box.left + box.width / 2)) / scale;
  }));
}

/** A row lock while one of its text cells has focus: flushed first (the server only locks rows it has saved), renewed every 3 s. */
function useRowLease(id: string, row: RefObject<HTMLTableRowElement | null>, enabled: boolean) {
  // 0 while the flush is pending: the server cannot lock (404) a row it has not saved yet, so renewing starts only once it holds.
  const lease = useRef<ReturnType<typeof setInterval> | 0 | undefined>(undefined);
  const stop = () => { if (lease.current === undefined) return; clearInterval(lease.current); lease.current = undefined; s().releaseLock(id, 'row'); };
  const lost = () => { stop(); const active = document.activeElement; if (active instanceof HTMLElement && row.current?.contains(active)) active.blur(); };
  useEffect(() => stop, [id]);
  useEffect(() => { if (!enabled) stop(); }, [enabled]);
  return {
    // Selects and the checkbox commit at once, so only typing holds the row.
    onFocus: (e: { target: EventTarget }) => {
      if (!enabled || lease.current !== undefined || !typingSurface(e.target as Element)) return;
      lease.current = 0;
      void connection.flush().then(() => {
        if (lease.current !== 0) return;
        if (!s().acquireLock(id, 'row')) return lost();
        lease.current = setInterval(() => { if (!s().renewLock(id, 'row') && !s().acquireLock(id, 'row')) lost(); }, 3000);
      });
    },
    // Deferred: moving between cells of the row blurs one before the next takes focus.
    onBlur: () => setTimeout(() => { if (!row.current?.contains(document.activeElement)) stop(); }),
  };
}

/** A text cell with a local draft: commits after 300 ms idle and on blur, one undo step per focus. */
function TextCell({ shot, field, label, readOnly, area = false, mono = false }: { shot: Shot; field: TextField; label: string; readOnly: boolean; area?: boolean; mono?: boolean }) {
  const stored = shot[field] ?? '', [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), pending = useRef<string | null>(null), gesture = useRef('');
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  // A shot needs a number: an emptied number cell waits for typing and falls back to the saved one on blur.
  const commit = () => { clearTimeout(timer.current); const text = pending.current; pending.current = null; if (text !== null && (field !== 'number' || text.trim())) s().updateShot(shot.id, { [field]: text }, gesture.current); };
  // Leaving the view (a filter change) while typing still saves what was typed.
  useEffect(() => () => commit(), [shot.id]);
  const value = draft ?? stored;
  useLayoutEffect(() => { const el = ref.current; if (!area || !el) return; el.style.height = '0'; el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`; }, [area, value]);
  const props = {
    ref, value, readOnly, maxLength: LIMIT[field], 'aria-label': `Shot ${shot.number} ${label}`, className: mono ? 'mono' : undefined, spellCheck: field !== 'number',
    onFocus: () => { gesture.current = createId('gesture'); },
    onChange: (e: { currentTarget: { value: string } }) => { const text = e.currentTarget.value; setDraft(text); pending.current = text; clearTimeout(timer.current); timer.current = setTimeout(commit, 300); },
    onBlur: () => { commit(); setDraft(null); },
    onKeyDown: (e: { key: string; currentTarget: HTMLElement }) => {
      // Escape leaves the cell like the script and board do, keeping the text: the idle commit has already saved part of it.
      if (e.key === 'Escape' || (e.key === 'Enter' && !area)) e.currentTarget.blur();
    },
  };
  return area ? <textarea rows={1} {...props}/> : <input type="text" autoComplete="off" {...props}/>;
}

function Choice({ shot, field, label, options, disabled }: { shot: Shot; field: 'size' | 'movement'; label: string; options: readonly string[]; disabled: boolean }) {
  const value = shot[field] ?? '';
  // A value typed elsewhere (the MCP, an import) stays selectable instead of reading as blank.
  return <select aria-label={`Shot ${shot.number} ${label}`} value={value} disabled={disabled} onChange={e => s().updateShot(shot.id, { [field]: e.target.value })}>
    <option value="">—</option>{(value && !options.includes(value) ? [...options, value] : options).map(o => <option key={o}>{o}</option>)}
  </select>;
}

function ShotLine({ shot, takes, media, inEdit, owner, editor, flash, onMenu, onLink }: { shot: Shot; takes: string[]; media: Map<string, MediaAsset>; inEdit: string[]; owner?: User; editor: boolean; flash: boolean; onMenu: (id: string, e: MouseEvent<HTMLElement>) => void; onLink: (id: string) => void }) {
  const row = useRef<HTMLTableRowElement>(null), editable = editor && !owner, lease = useRowLease(shot.id, row, editable), readOnly = !editable;
  const cell = (field: TextField, label: string, extra?: { area?: boolean; mono?: boolean }) => <TextCell shot={shot} field={field} label={label} readOnly={readOnly} {...extra}/>;
  return <tr ref={row} data-cursor-anchor={shot.id} className={`shot-row${shot.done ? ' done' : ''}${owner ? ' shot-owned' : ''}${flash ? ' flash' : ''}`} style={owner ? { '--owner-color': owner.color } as CSSProperties : undefined} onFocus={lease.onFocus} onBlur={lease.onBlur}>
    <td className="shot-done"><input type="checkbox" aria-label={`Shot ${shot.number} done`} checked={!!shot.done} disabled={readOnly} onChange={e => s().updateShot(shot.id, { done: e.target.checked })}/></td>
    <td className="shot-number">{cell('number', 'number', { mono: true })}{owner && <span className="shot-owner" title={`${owner.name} is editing this shot`}><i/>{owner.name}</span>}</td>
    <td><Choice shot={shot} field="size" label="size" options={SHOT_SIZES} disabled={readOnly}/></td>
    <td><Choice shot={shot} field="movement" label="movement" options={SHOT_MOVES} disabled={readOnly}/></td>
    <td>{cell('text', 'description', { area: true })}</td>
    <td>{cell('cast', 'cast')}</td>
    <td>{cell('location', 'location')}</td>
    <td>{cell('notes', 'notes')}</td>
    <td className="shot-takes"><div>
      {takes.slice(0, 4).map(id => { const m = media.get(id)!, hand = shot.mediaIds?.includes(id); return <span key={id} className="shot-take">
        <button title={`${m.name} — show in media`} aria-label={`Show ${m.name} in media`} onClick={() => s().revealMedia(id)}>{m.thumbnail ? <img src={m.thumbnail} alt="" loading="lazy" draggable={false}/> : <Film size={12}/>}</button>
        {hand && editable && <button className="shot-unlink" title="Unlink" aria-label={`Unlink ${m.name}`} onClick={() => s().linkShotMedia(shot.id, id, false)}><X size={9}/></button>}
      </span>; })}
      {takes.length > 4 && (editable ? <button className="shot-more" title="All takes" onClick={() => onLink(shot.id)}>+{takes.length - 4}</button> : <span className="shot-more" title={takes.slice(4).map(id => media.get(id)?.name).join('\n')}>+{takes.length - 4}</span>)}
      {!!inEdit.length && <IconButton className="shot-in-edit" label="In the edit — go to the clip" onClick={() => jumpToTake(inEdit)}><Scissors size={13}/></IconButton>}
      {editable && <IconButton className="shot-link" label={`Link takes to ${shot.number}`} onClick={() => onLink(shot.id)}><Plus size={13}/></IconButton>}
    </div></td>
    <td className="shot-menu">{editable && <IconButton label={`Shot ${shot.number} actions`} aria-haspopup="menu" onClick={e => onMenu(shot.id, e)}><MoreHorizontal size={14}/></IconButton>}</td>
  </tr>;
}

function LinkTakes({ shotId, onClose }: { shotId: string; onClose: () => void }) {
  const shot = useEditorStore(st => st.shots.find(x => x.id === shotId && x.projectId === st.projectId));
  const media = useEditorStore(useShallow(st => st.media.filter(m => m.projectId === st.projectId && (m.kind === 'video' || m.kind === 'image'))));
  const shots = useEditorStore(useShallow(st => st.shots.filter(x => x.projectId === st.projectId)));
  const owner = useMemo(() => takesIndex(shots, media), [shots, media]);
  const [query, setQuery] = useState('');
  useEffect(() => { if (!shot) onClose(); }, [shot]);
  if (!shot) return null;
  const find = query.trim().toLowerCase();
  const list = media.filter(m => m.name.toLowerCase().includes(find)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return <Modal title={`Link takes to ${shot.number}`} onClose={onClose}>
    <div className="modal-body shot-link-body">
      <label className="shot-link-search"><Search size={13}/><input type="search" placeholder="Search media…" aria-label="Search media" value={query} onChange={e => setQuery(e.target.value)}/></label>
      <div className="shot-link-list">{list.map(m => {
        const hand = !!shot.mediaIds?.includes(m.id), auto = !hand && owner.get(m.id) === shot.id; // a name match another shot holds is not this one's
        return <label key={m.id} className="shot-link-item"><input type="checkbox" checked={hand || auto} disabled={auto} onChange={e => s().linkShotMedia(shot.id, m.id, e.target.checked)}/>
          <span className="shot-link-thumb">{m.thumbnail ? <img src={m.thumbnail} alt="" loading="lazy"/> : <Film size={12}/>}</span><span className="shot-link-name" title={m.name}>{m.name}</span>{auto && <small>by name</small>}</label>;
      })}{!list.length && <p className="muted">{media.length ? 'No matching media.' : 'No video or images in this project yet.'}</p>}</div>
    </div>
    <div className="modal-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
  </Modal>;
}

export default function ShotList() {
  const projectName = useEditorStore(st => st.projects.find(p => p.id === st.projectId)?.name ?? 'Untitled');
  const editor = useEditorStore(st => ['Owner', 'Editor'].includes(st.projects.find(p => p.id === st.projectId)?.members.find(m => m.userId === st.currentUserId)?.role ?? ''));
  const shots = useEditorStore(useShallow(st => st.shots.filter(x => x.projectId === st.projectId)));
  const scripts = useEditorStore(useShallow(st => st.scripts.filter(x => x.projectId === st.projectId)));
  // Scene headings are all the grouping reads, so typing action lines in the script does not redraw the table.
  const scenes = useEditorStore(useShallow(st => st.scriptBlocks.filter(b => b.projectId === st.projectId && b.kind === 'scene')));
  const media = useEditorStore(useShallow(st => st.media.filter(m => m.projectId === st.projectId)));
  const used = useEditorStore(useShallow(st => [...new Set(st.clips.filter(c => c.projectId === st.projectId).map(c => c.mediaId))]));
  const owners = useEditorStore(useShallow(st => st.locks.filter(l => l.projectId === st.projectId && l.userId !== st.currentUserId && l.expiresAt > Date.now() && lockConflict(l.field, 'row')).map(l => `${l.targetId}\n${l.userId}`)));
  const users = useEditorStore(st => st.users);
  const focus = useEditorStore(st => st.planTab === 'shots' ? st.planFocus : null);
  const [filter, setFilter] = useState('all');
  const [target, setTarget] = useState<string | null>(null), [flash, setFlash] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null), [exportAt, setExportAt] = useState<{ x: number; y: number } | null>(null), [linking, setLinking] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupShots(shots, scripts, scenes), [shots, scripts, scenes]);
  const mediaById = useMemo(() => new Map(media.map(m => [m.id, m])), [media]);
  const takes = useMemo(() => shotTakes(shots, media), [shots, media]);
  const usedSet = useMemo(() => new Set(used), [used]);
  const ownerOf = useMemo(() => new Map(owners.map(o => { const [id, user] = o.split('\n'); return [id, users.find(u => u.id === user)]; })), [owners, users]);
  const visible = filter === 'all' ? groups : groups.filter(g => groupKey(g) === filter);
  const rows = visible.flatMap(g => g.shots), inEdit = (id: string) => (takes.get(id) ?? []).filter(m => usedSet.has(m));

  // A scene deleted by someone else drops back to all scenes rather than an empty table.
  useEffect(() => { if (filter !== 'all' && !groups.some(g => groupKey(g) === filter)) setFilter('all'); }, [filter, groups]);
  // openPlan('shots', id): a scene heading filters to that scene; a shot is scrolled to, flashed and focused.
  useEffect(() => {
    if (!focus) return;
    if (groups.some(g => g.sceneId === focus)) setFilter(focus);
    else { const group = groups.find(g => g.shots.some(x => x.id === focus)); if (group) { if (filter !== 'all' && filter !== groupKey(group)) setFilter('all'); setTarget(focus); } }
    useEditorStore.setState({ planFocus: null });
  }, [focus]);
  // Waits for the row: a new shot or a filter change renders it a moment later.
  useEffect(() => {
    if (!target) return;
    const row = box.current?.querySelector<HTMLElement>(`tr[data-cursor-anchor="${CSS.escape(target)}"]`);
    if (!row) return;
    setTarget(null); setFlash(target); row.scrollIntoView({ block: 'center' });
    row.querySelector<HTMLTextAreaElement>('textarea:not([readonly])')?.focus({ preventScroll: true });
  }, [target, groups, filter]);
  useEffect(() => { if (!flash) return; const timer = setTimeout(() => setFlash(null), 1600); return () => clearTimeout(timer); }, [flash]);

  const add = (sceneId?: string) => { const id = s().addShot(sceneId ? { sceneId } : {}); if (id) setTarget(id); };
  const menuShot = menu && shots.find(x => x.id === menu.id), menuGroup = menuShot && groups.find(g => g.shots.includes(menuShot));
  // Up and down swap with the neighbour in the scene; moveShot places after a shot in the project-wide order.
  const sibling = (step: number) => menuShot && menuGroup?.shots[menuGroup.shots.indexOf(menuShot) + step];
  const moveUp = (shot: Shot, prev: Shot) => { const rest = ordered(shots).filter(x => x.id !== shot.id), at = rest.findIndex(x => x.id === prev.id); s().moveShot(shot.id, at > 0 ? rest[at - 1].id : null); };
  const rowsFor = (): ShotRow[] => visible.flatMap(g => g.shots.map(x => ({ number: x.number, scene: g.label, size: x.size ?? '', movement: x.movement ?? '', text: x.text, cast: x.cast ?? '', location: x.location ?? '', notes: x.notes ?? '', done: !!x.done, takes: takes.get(x.id)?.length ?? 0 })));
  const title = `${projectName} — Shot list`;
  const below = (e: MouseEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: Math.max(8, r.right - 228), y: r.bottom + 4 }; };
  const openMenu = (id: string, e: MouseEvent<HTMLElement>) => setMenu({ id, ...below(e) });

  return <section className="shot-list" data-cursor-surface="panel:shots">
    <PlanActions><div className="shot-actions">
      {!!shots.length && <select className="shot-filter" aria-label="Scene" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All scenes</option>{groups.map(g => <option key={groupKey(g)} value={groupKey(g)}>{g.label}</option>)}</select>}
      {!!shots.length && <span className="shot-count">{rows.length} {rows.length === 1 ? 'shot' : 'shots'} · {rows.filter(x => x.done).length} done · {rows.filter(x => inEdit(x.id).length).length} in edit</span>}
      {editor && <Button onClick={() => add(filter !== 'all' && filter !== NO_SCENE ? filter : undefined)}><Plus size={15}/>Shot</Button>}
      {!!shots.length && <Button variant="ghost" className="shot-export" aria-label="Export" title="Export" aria-haspopup="menu" aria-expanded={!!exportAt} onClick={e => setExportAt(below(e))}><Download size={15}/><span>Export</span></Button>}
    </div></PlanActions>
    {!!shots.length && ![...takes.values()].some(t => t.length) && <p className="shot-tip">Name clips by shot number (3A_take2.mov) and takes link here by themselves.</p>}
    {shots.length ? <div className="shot-scroll" ref={box}><table className="shot-table">
      <colgroup><col className="c-done"/><col className="c-number"/><col className="c-size"/><col className="c-move"/><col className="c-text"/><col className="c-cast"/><col className="c-location"/><col className="c-notes"/><col className="c-takes"/><col className="c-menu"/></colgroup>
      <thead><tr><th><span className="visually-hidden">Done</span></th><th>#</th><th>Size</th><th>Move</th><th>Description</th><th>Cast</th><th>Location</th><th>Notes</th><th>Takes</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
      {visible.map(g => <tbody key={groupKey(g)}>
        <tr className="shot-group"><th colSpan={COLUMNS} scope="colgroup"><div>
          <span className="shot-group-label" title={g.label}>{g.label}</span><span className="shot-group-count">{g.shots.length}</span>
          {editor && <button className="text-button" onClick={() => add(g.sceneId)}><Plus size={12}/>shot</button>}
          {g.sceneId && <button className="text-button" onClick={() => s().openPlan('script', g.sceneId)}><ScrollText size={12}/>Show in script</button>}
        </div></th></tr>
        {g.shots.map(x => <ShotLine key={x.id} shot={x} takes={takes.get(x.id) ?? []} media={mediaById} inEdit={inEdit(x.id)} owner={ownerOf.get(x.id)} editor={editor} flash={flash === x.id} onMenu={openMenu} onLink={setLinking}/>)}
      </tbody>)}
    </table></div>
    : <EmptyState icon={<ClipboardList size={30}/>} title="No shots yet" description={editor ? 'Plan what to film, scene by scene.' : 'Editors can add shots here.'} action={editor && <div className="shot-empty-actions">
        {/* A scene filter left from before the list emptied would hide the new, scene-less shot. */}
        <Button variant="primary" onClick={() => { setFilter('all'); add(); }}><Plus size={15}/>Add shot</Button>
        {groups.some(g => g.sceneId) && <Button onClick={() => groups.forEach(g => { if (g.sceneId && !g.shots.length) s().addShot({ sceneId: g.sceneId }); })}>One shot per scene</Button>}
      </div>}/>}
    {menu && menuShot && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      <button role="menuitem" disabled={!sibling(-1)} onClick={() => { moveUp(menuShot, sibling(-1)!); setMenu(null); }}><ArrowUp size={14}/>Move up</button>
      <button role="menuitem" disabled={!sibling(1)} onClick={() => { s().moveShot(menuShot.id, sibling(1)!.id); setMenu(null); }}><ArrowDown size={14}/>Move down</button>
      <button role="menuitem" onClick={() => { const { text, size, movement, cast, location, notes } = menuShot; const id = s().addShot({ ...(menuGroup?.sceneId ? { sceneId: menuGroup.sceneId } : {}), text, size, movement, cast, location, notes }, menuShot.id); if (id) setTarget(id); setMenu(null); }}><Copy size={14}/>Duplicate</button>
      <button role="menuitem" disabled={!takes.get(menuShot.id)?.length} onClick={() => { const ids = takes.get(menuShot.id)!, ready = ids.filter(id => mediaById.get(id)?.status === 'ready').length; addToTimelineEnd(ids, `${ready} ${ready === 1 ? 'take' : 'takes'}`); setMenu(null); }}><Film size={14}/>Add takes to timeline</button>
      <div className="divider"/>
      <button role="menuitem" className="danger-text" onClick={() => { s().deleteShots([menuShot.id]); setMenu(null); }}><Trash2 size={14}/>Delete</button>
    </ContextMenu>}
    {exportAt && <ContextMenu x={exportAt.x} y={exportAt.y} onClose={() => setExportAt(null)}>
      <button role="menuitem" onClick={() => { setExportAt(null); const list = rowsFor(); void copyRich(shotsHtml(list, title), shotsCsv(list)).then(ok => s().notify(ok ? 'Shot list copied. Paste it into Google Docs or Sheets.' : 'Could not copy the shot list', ok ? 'success' : 'error')); }}><ClipboardCopy size={14}/>Copy table for Google Docs / Sheets</button>
      {/* The byte-order mark makes Excel read the file as UTF-8; Sheets and Numbers ignore it. */}
      <button role="menuitem" onClick={() => { setExportAt(null); downloadFile(`${safeFileName(projectName)}_shot_list.csv`, `﻿${shotsCsv(rowsFor())}`, 'text/csv;charset=utf-8'); }}><FileSpreadsheet size={14}/>Download .csv</button>
      <button role="menuitem" onClick={() => { setExportAt(null); printHtml(shotsHtml(rowsFor(), title, { page: true })); }}><Printer size={14}/>Print or save as PDF</button>
    </ContextMenu>}
    {linking && <LinkTakes shotId={linking} onClose={() => setLinking(null)}/>}
  </section>;
}
