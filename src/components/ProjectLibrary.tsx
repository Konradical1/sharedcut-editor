import SharingFields, { type SharingValue } from './SharingFields';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, Check, ChevronRight, Clock3, Film, Folder, FolderPlus, Grid2X2, List, LockKeyhole, MoreHorizontal, MoveRight, Pause, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import type { Project, User } from '../state/models';
import { projectCover } from '../services/library';
import { importCard } from '../services/importer';
import type { AccessPreview, LibraryChange, LibraryView, ProjectFolder } from '../services/library';
import { api } from '../services/api';
import { useEditorStore } from '../state/store';
import { flushChanges, liveEditors, refreshState } from '../services/sync';
import { useStore } from 'zustand';
import { Avatar, Button, ContextMenu, durationLabel, Modal } from './ui';

type Item = { kind: 'project' | 'folder'; id: string; name: string };
const empty: LibraryView = { revision: 0, folders: [], locations: {}, directMembers: {} };
export default function ProjectLibrary({ projects, users, userId, section, onOpen, onCreate, onSettings }: { projects: Project[]; users: User[]; userId: string; section: string; onOpen: (id: string) => void; onCreate: (folder: LibraryView['folders'][number] | null) => void; onSettings: (project: Project, deleting?: boolean, sharing?: boolean) => void }) {
  const media = useEditorStore(s => s.media);
  const liveList = useStore(liveEditors, s => s.list);
  const [library, setLibrary] = useState(empty), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null), [search, setSearch] = useState(''), [sort, setSort] = useState('modified');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [menu, setMenu] = useState<{ item: Item; x: number; y: number } | null>(null);
  const [folderPanel, setFolderPanel] = useState<'name' | 'share'>('name');
  const [editing, setEditing] = useState<ProjectFolder | 'new' | null>(null), [moving, setMoving] = useState<Item | null>(null);
  const [pending, setPending] = useState<{ change: LibraryChange; preview: AccessPreview } | null>(null), [busy, setBusy] = useState(false);
  const reload = useCallback(async () => { const data = await api<LibraryView>('/library'); setLibrary(data); setLoading(false); }, []);
  useEffect(() => {
    let active = true;
    const load = () => { void api<LibraryView>('/library').then(data => { if (active) { setLibrary(data); setLoading(false); } }).catch(e => { if (active) { setError(e.message); setLoading(false); } }); };
    load(); const events = new EventSource('/api/events'); events.addEventListener('change', load);
    const timer = window.setInterval(load, 10000);
    return () => { active = false; events.close(); window.clearInterval(timer); };
  }, []);
  useEffect(() => { setFolderId(null); setSearch(''); }, [section]);
  useEffect(() => { if (!loading && folderId && !library.folders.some(f => f.id === folderId)) setFolderId(null); }, [library, loading, folderId]);
  const current = library.folders.find(f => f.id === folderId) ?? null;
  const ownProject = (p: Project) => p.members.some(m => m.userId === userId && m.role === 'Owner');
  const canEdit = (f: LibraryView['folders'][number]) => f.effectiveMembers.some(m => m.userId === userId && ['Owner', 'Editor'].includes(m.role));
  const crumbs: LibraryView['folders'] = [];
  let ancestor = current;
  while (ancestor && !crumbs.some(f => f.id === ancestor!.id)) { crumbs.unshift(ancestor); ancestor = library.folders.find(f => f.id === ancestor!.parentId) ?? null; }
  const visibleIds = new Set(library.folders.map(f => f.id));
  const isClass = (p: Project) => p.shared || library.folders.some(f => f.id === library.locations[p.id] && f.classShared);
  const folderMatches = (f: LibraryView['folders'][number]) => section === 'Class' ? f.classShared : section === 'Shared with me' ? f.ownerId !== userId && !f.classShared : f.ownerId === userId;
  const projectMatches = (p: Project) => section === 'Class' ? isClass(p) : section === 'Shared with me' ? !ownProject(p) && !isClass(p) : ownProject(p);
  const matchingFolderIds = new Set(library.folders.filter(folderMatches).map(f => f.id));
  const folders = library.folders.filter(f => {
    if (search) return f.name.toLowerCase().includes(search.toLowerCase()) && (folderId ? f.parentId === folderId : folderMatches(f));
    return folderId ? f.parentId === folderId : folderMatches(f) && (!f.parentId || !matchingFolderIds.has(f.parentId));
  }).sort((a, b) => a.name.localeCompare(b.name));
  const shown = projects.filter(p => {
    const parent = library.locations[p.id];
    const scope = folderId ? parent === folderId : projectMatches(p) && (search || !parent || !matchingFolderIds.has(parent) || !visibleIds.has(parent));
    return scope && `${p.name} ${p.description}`.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : b.modifiedAt - a.modifiedAt);
  const recent = useMemo(() => {
    let ids: string[] = []; try { const value = JSON.parse(localStorage.getItem(`sharedcut-recent-${userId}`) || '[]'); if (Array.isArray(value)) ids = value.filter(id => typeof id === 'string'); } catch { /* an unavailable cache does not block the library */ }
    return ids.flatMap(id => { const p = projects.find(p => p.id === id); return p ? [p] : []; }).slice(0, 4);
  }, [projects, userId]);
  const open = (id: string) => onOpen(id);
  const finish = async (change: LibraryChange, revision: number) => {
    await api('/library', { method: 'POST', body: JSON.stringify({ ...change, revision }) });
    await refreshState(); await reload(); setPending(null); setEditing(null); setMoving(null);
  };
  const request = async (change: LibraryChange) => {
    if (busy) return; setBusy(true); setError('');
    try {
      await flushChanges();
      const { preview } = await api<{ preview: AccessPreview }>('/library', { method: 'POST', body: JSON.stringify({ ...change, preview: true }) });
      if (preview.changes.length || preview.classShared && (change.action === 'create' || change.action === 'move') || change.action === 'delete') setPending({ change, preview });
      else await finish(change, preview.revision);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const drop = (event: React.DragEvent, parentId: string | null) => {
    event.preventDefault(); event.currentTarget.classList.remove('drop-target');
    try { const item = JSON.parse(event.dataTransfer.getData('application/x-sharedcut-item')) as Item; if (!['folder', 'project'].includes(item.kind) || typeof item.id !== 'string') return; void request({ action: 'move', kind: item.kind, id: item.id, parentId }); } catch { /* unrelated drag */ }
  };
  const dropProps = (parentId: string | null, enabled = true) => ({ onDragOver: (e: React.DragEvent) => { if (enabled && e.dataTransfer.types.includes('application/x-sharedcut-item')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drop-target'); } }, onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop-target'), onDrop: (e: React.DragEvent) => { if (enabled) drop(e, parentId); } });
  const drag = (e: React.DragEvent, item: Item) => { e.dataTransfer.setData('application/x-sharedcut-item', JSON.stringify(item)); e.dataTransfer.effectAllowed = 'move'; };
  const options = (e: React.MouseEvent, item: Item) => { e.preventDefault(); setMenu({ item, x: Math.min(e.clientX, window.innerWidth - 235), y: e.clientY }); };
  const cover = (p: Project) => projectCover(p, media);
  // A Final Cut import in flight (the server keeps p.fcpImport): an overlay on the cover, then a day of "New from Final Cut".
  const importing = (p: Project) => p.fcpImport && importCard(p.fcpImport, p.fcpImport.by === userId ? '' : users.find(u => u.id === p.fcpImport!.by)?.name ?? 'Someone');
  const incoming = projects.filter(p => ['uploading', 'paused', 'processing'].includes(p.fcpImport?.phase ?? ''));
  // Everyone else with the project open right now: a live pill on the cover, faces beside the name in list view.
  const editorsOf = (p: Project) => liveList.flatMap(e => e.projectId === p.id ? users.filter(u => u.id === e.userId) : []);
  const faces = (people: User[]) => <span className="drive-live-faces">{people.slice(0, 3).map(u => <Avatar key={u.id} user={u} size={18}/>)}</span>;
  const card = (p: Project, suggested = false, fcp = importing(p), live = editorsOf(p)) => <article key={p.id} className={`drive-project${live.length ? ' live' : ''}`} draggable={ownProject(p)} onDragStart={e => drag(e, { kind: 'project', id: p.id, name: p.name })} onContextMenu={e => options(e, { kind: 'project', id: p.id, name: p.name })}>
    <button className="drive-project-open" onClick={() => open(p.id)} aria-label={`${suggested ? 'Resume' : 'Open'} ${p.name}${fcp ? `. ${fcp.label}` : ''}${live.length ? `. ${editingLabel(live)}` : ''}`}><div className="drive-project-title"><Film className="drive-file-icon" size={18}/><strong>{p.name}</strong>{live.length > 0 && faces(live)}</div><div className="drive-thumbnail">{live.length > 0 && <div className="drive-live" title={live.map(u => u.name).join(', ')}><i/>{faces(live)}<b>{editingLabel(live)}</b></div>}{cover(p) ? <img src={cover(p)} alt="" loading="lazy"/> : !(fcp && fcp.phase !== 'ready') && <Film className="drive-thumbnail-empty" size={26}/>}{fcp && fcp.phase !== 'ready' ? <div className={`drive-import ${fcp.phase}`}><b>{fcp.phase === 'paused' && <Pause size={11}/>}{fcp.title.split('**').map((part, i) => i % 2 ? <strong key={i}>{part}</strong> : part)}</b><small>{fcp.detail}</small>{fcp.progress !== undefined && <div className="progress-track"><i style={{ width: `${fcp.progress}%` }}/></div>}</div> : <span>{durationLabel(p.duration)}</span>}</div><div className="drive-project-meta">{fcp?.phase === 'ready' ? <span className="drive-import-chips"><span className="drive-import-chip"><Check size={11}/>{fcp.title}</span>{fcp.detail && <span className="drive-import-chip warn"><AlertTriangle size={11}/>{fcp.detail}</span>}</span> : <span>{suggested ? 'Recently opened' : p.status}</span>}<span>{isClass(p) ? 'Class' : p.members.length > 1 ? 'Shared' : 'Private'}</span></div><span className="drive-list-owner">{users.find(u => p.members.some(m => m.userId === u.id && m.role === 'Owner'))?.name}</span><span className="drive-list-date">{new Date(p.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></button>
    <button className="drive-options" aria-label={`Project options for ${p.name}`} onClick={e => options(e, { kind: 'project', id: p.id, name: p.name })}><MoreHorizontal size={18}/></button>
  </article>;
  const menuProject = menu?.item.kind === 'project' ? projects.find(p => p.id === menu.item.id) : undefined;
  const menuFolder = menu?.item.kind === 'folder' ? library.folders.find(f => f.id === menu.item.id) : undefined;
  const menuOwner = menuProject ? ownProject(menuProject) : menuFolder?.ownerId === userId;
  return <section className="drive-library" aria-label="Project library">
    <div className="drive-search-row"><label className="drive-search"><Search size={20}/><input aria-label="Search projects and folders" placeholder="Search projects and folders" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button onClick={() => setSearch('')} aria-label="Clear search">×</button>}</label><span className="drive-search-hint">Your creative workspace</span></div>
    {error && <div className="drive-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {!folderId && !search && incoming.length > 0 && <section className="drive-recents"><h2><ArrowDownToLine size={16}/> Coming in from Final Cut</h2><div className="drive-grid">{incoming.map(p => card(p))}</div></section>}
    {!folderId && !search && section === 'Projects' && recent.length > 0 && <section className="drive-recents"><h2><Clock3 size={16}/> Pick up where you left off</h2><div className="drive-grid">{recent.map(p => card(p, true))}</div></section>}
    <div className="drive-toolbar"><nav className="drive-crumbs" aria-label="Folder path"><button {...dropProps(null)} onClick={() => { setFolderId(null); setSearch(''); }}>{section}</button>{crumbs.map(f => <span key={f.id}><ChevronRight size={15}/><button {...dropProps(f.id, canEdit(f))} onClick={() => { setFolderId(f.id); setSearch(''); }}>{f.name}</button></span>)}</nav><div className="drive-actions"><Button disabled={busy || !!current && !canEdit(current) || loading} onClick={() => { setFolderPanel('name'); setEditing('new'); }}><FolderPlus size={15}/> New folder</Button><Button variant="primary" disabled={busy || !!current && !canEdit(current) || loading} onClick={() => onCreate(current)}><Plus size={15}/> New project</Button></div></div>
    {current && <div className="drive-folder-access"><Users size={14}/><span>{current.classShared ? 'Shared with the class' : current.effectiveMembers.length > 1 ? `Shared with ${current.effectiveMembers.length} people` : 'Only you'}. Projects inherit this folder’s access.</span><button onClick={() => { setFolderPanel('share'); setEditing(current); }}>{current.ownerId === userId ? 'Manage access' : 'View access'}</button></div>}
    <div className="drive-viewbar"><span>{search ? 'Search results' : 'Folders & projects'} <small>{folders.length + shown.length}</small></span><div><select aria-label="Sort projects" value={sort} onChange={e => setSort(e.target.value)}><option value="modified">Last modified</option><option value="name">Name</option></select><div className="dash-view-toggle"><button aria-label="Grid view" aria-pressed={view === 'grid'} className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}><Grid2X2 size={16}/></button><button aria-label="List view" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={17}/></button></div></div></div>
    {loading ? <p className="drive-empty" role="status">Loading your library…</p> : <>
      {!!folders.length && <div className={`drive-folders ${view === 'list' ? 'as-list' : ''}`}>{folders.map(f => <article key={f.id} className="drive-folder" {...dropProps(f.id, canEdit(f))} draggable={f.ownerId === userId} onDragStart={e => drag(e, { kind: 'folder', id: f.id, name: f.name })} onContextMenu={e => options(e, { kind: 'folder', id: f.id, name: f.name })}><button className="drive-folder-open" onClick={() => { setFolderId(f.id); setSearch(''); }} aria-label={`Open folder ${f.name}`}><Folder size={22} fill="currentColor" strokeWidth={1}/><strong>{f.name}</strong>{f.effectiveMembers.length > 1 ? <Users size={14}/> : <LockKeyhole size={13}/>}</button><button className="drive-options" aria-label={`Folder options for ${f.name}`} onClick={e => options(e, { kind: 'folder', id: f.id, name: f.name })}><MoreHorizontal size={18}/></button></article>)}</div>}
      {view === 'list' && shown.length > 0 && <div className="drive-list-head"><span>Name</span><span>Owner</span><span>Last modified</span></div>}
      <div className={`drive-grid ${view === 'list' ? 'as-list' : ''}`}>{shown.map(p => card(p))}</div>
      {/* With projects coming in from Final Cut above, an empty section is not "room for your next idea". */}
      {!folders.length && !shown.length && !(incoming.length && !folderId && !search) && <div className="drive-empty"><Folder size={38} strokeWidth={1}/><h3>{search ? 'No matching projects or folders' : 'A little room for your next idea'}</h3><p>{search ? 'Try another name.' : current ? 'Add a project or create a folder to get started.' : section === 'Projects' ? 'Create a project or organize your work in folders.' : 'Folders and projects shared here will appear automatically.'}</p></div>}
    </>}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}><span className="menu-heading">{menu.item.name}</span><button role="menuitem" onClick={() => { if (menuProject) open(menuProject.id); else { setFolderId(menu.item.id); setSearch(''); } setMenu(null); }}><Folder/> Open</button><button role="menuitem" onClick={() => { if (menuProject) onSettings({ ...menuProject, members: library.directMembers[menuProject.id] ?? menuProject.members }); else if (menuFolder) { setFolderPanel('name'); setEditing(menuFolder); } setMenu(null); }}><Pencil/> Edit properties</button><button role="menuitem" onClick={() => { if (menuProject) onSettings({ ...menuProject, members: library.directMembers[menuProject.id] ?? menuProject.members }, false, true); else if (menuFolder) { setFolderPanel('share'); setEditing(menuFolder); } setMenu(null); }}><Users/> Sharing & access</button><button role="menuitem" disabled={!menuOwner} onClick={() => { setMoving(menu.item); setMenu(null); }}><MoveRight/> Move to…</button><div className="divider"/><button role="menuitem" className="danger-text" disabled={!menuOwner} onClick={() => { if (menuProject) onSettings(menuProject, true); else void request({ action: 'delete', id: menu.item.id }); setMenu(null); }}><Trash2/> Delete {menu.item.kind}</button></ContextMenu>}
    {editing && <FolderForm initialPanel={folderPanel} folder={editing === 'new' ? null : editing} parent={editing === 'new' ? current : library.folders.find(f => f.id === editing.parentId) ?? null} users={users} userId={userId} busy={busy} error={error} onClose={() => setEditing(null)} onSave={fields => request(editing === 'new' ? { action: 'create', parentId: folderId, ...fields } : { action: 'update', id: editing.id, ...fields })}/>}
    {moving && <Modal title={`Move “${moving.name}”`} onClose={() => setMoving(null)}><div className="drive-move-list"><p>Choose a destination. Any access changes will be shown before moving.</p>{error && <p role="alert" className="drive-error">{error}</p>}<Button disabled={busy} onClick={() => request({ action: 'move', kind: moving.kind, id: moving.id, parentId: null })}><Folder size={17}/> Projects (top level)</Button>{library.folders.filter(canEdit).filter(f => { let id: string | null = f.id; const visited = new Set<string>(); while (id && !visited.has(id)) { if (moving.kind === 'folder' && id === moving.id) return false; visited.add(id); id = library.folders.find(a => a.id === id)?.parentId ?? null; } return true; }).map(f => <Button key={f.id} disabled={busy} onClick={() => request({ action: 'move', kind: moving.kind, id: moving.id, parentId: f.id })}><Folder size={17}/>{folderPath(f, library.folders)}{f.classShared && <small>Class</small>}</Button>)}</div></Modal>}
    {pending && <Modal title={pending.change.action === 'delete' ? 'Delete empty folder?' : 'Review sharing changes'} onClose={() => { if (!busy) setPending(null); }}><div className="drive-confirm"><Users size={28}/><p>{pending.change.action === 'delete' ? 'This empty folder will be permanently deleted.' : pending.preview.classShared ? 'This will share the contents with everyone on the server, including future class members.' : pending.preview.audience.length ? `After this change, access includes: ${pending.preview.audience.join(', ')}.` : 'After this change, only existing direct access will remain.'}</p>{pending.preview.changes.map((c, i) => <div key={i}><strong>{c.name}</strong>{c.added.length > 0 && <p>Gains access: {c.added.join(', ')}</p>}{c.removed.length > 0 && <p>Loses inherited access: {c.removed.join(', ')}</p>}{c.changed.length > 0 && <p>Role changes: {c.changed.join(', ')}</p>}</div>)}{pending.change.action !== 'delete' && <p className="muted">Direct project sharing stays in place. Moving out removes access inherited from the old folder.</p>}{error && <p className="drive-error" role="alert">{error}</p>}<div className="dash-dialog-actions"><Button disabled={busy} onClick={() => setPending(null)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await finish(pending.change, pending.preview.revision); } catch (e) { setError((e as Error).message); setPending(null); } finally { setBusy(false); } }}>{busy ? 'Saving…' : pending.change.action === 'delete' ? 'Delete folder' : 'Confirm changes'}</Button></div></div></Modal>}
  </section>;
}
const firstName = (u: User) => u.name.split(' ')[0] || u.name;
const editingLabel =(people: User[]) => people.length === 1 ? `${firstName(people[0])} is editing` : people.length === 2 ? `${firstName(people[0])} and ${firstName(people[1])} are editing` : `${firstName(people[0])} and ${people.length - 1} others are editing`;
function folderPath(f: ProjectFolder, folders: ProjectFolder[]) { const names = [f.name], seen = new Set([f.id]); let parent = folders.find(a => a.id === f.parentId); while (parent && !seen.has(parent.id)) { names.unshift(parent.name); seen.add(parent.id); parent = folders.find(a => a.id === parent!.parentId); } return names.join(' / '); }
function FolderForm({ folder, parent, initialPanel, users, userId, busy, error, onClose, onSave }: { folder: ProjectFolder | null; parent: LibraryView['folders'][number] | null; initialPanel: 'name' | 'share'; users: User[]; userId: string; busy: boolean; error: string; onClose: () => void; onSave: (fields: Pick<ProjectFolder, 'name' | 'shared' | 'classRole' | 'members'>) => void }) {
  const [name, setName] = useState(folder?.name ?? ''), [panel, setPanel] = useState(initialPanel);
  const [sharing, setSharing] = useState<SharingValue>({ shared: folder?.shared ?? false, classRole: folder?.classRole ?? 'Editor', members: folder?.members ?? [] });
  const owner = !folder || folder.ownerId === userId;
  return <Modal title={panel === 'name' ? folder ? 'Rename folder' : 'New folder' : `Share “${name.trim()}”`} onClose={() => { if (!busy) onClose(); }}><form className="library-dialog-body" onSubmit={e => { e.preventDefault(); if (panel === 'name' && !folder) setPanel('share'); else onSave({ name: name.trim(), ...sharing }); }}>
    {panel === 'name' ? <label className="form-field">Folder name<input autoFocus required maxLength={100} placeholder="Untitled folder" value={name} disabled={!owner || busy} onChange={e => setName(e.target.value)}/></label> : <><SharingFields users={users} userId={userId} ownerId={folder?.ownerId ?? userId} value={sharing} onChange={setSharing} disabled={!owner || busy} inherited={parent?.effectiveMembers}/><p className="sharing-note">Projects inside inherit this folder’s access.</p></>}
    {error && <p role="alert" className="drive-error">{error}</p>}<div className="sharing-actions">{panel === 'share' && !folder && <Button type="button" variant="ghost" disabled={busy} onClick={() => setPanel('name')}>Back</Button>}<span className="spacer"/><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{owner ? 'Cancel' : 'Close'}</Button>{owner && <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : panel === 'name' ? folder ? 'Save name' : 'Next' : folder ? 'Done' : 'Create folder'}</Button>}</div>
  </form></Modal>;
}
