import SharingFields, { type SharingValue } from './SharingFields';
import ProjectLibrary from './ProjectLibrary';
import type { LibraryView, AccessPreview } from '../services/library';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bell, ChevronDown, Film, FolderOpen, Globe2, LockKeyhole, MoreHorizontal, Settings, Trash2, Users, X } from 'lucide-react';
import { useEditorStore } from '../state/store';
import type { Project, ProjectMember, User } from '../state/models';
import { api, connection } from '../services/api';
import { flushChanges, refreshState } from '../services/sync';
import { Avatar, Brand, Button, IconButton, Modal, NumberInput } from './ui';
import SettingsDialog from './SettingsDialog';
import './dashboard.css';
import ResolveImport from './ResolveImport';
import { ServerControl } from './AccountControls';

function modified(timestamp: number) {
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? '' : 's'} ago`;
  if (minutes < 2880) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function ProjectSettings({ project, users, currentUserId, deleting = false, sharing = false, onClose, onDeleted }: { project: Project; users: User[]; currentUserId: string; deleting?: boolean; sharing?: boolean; onClose: () => void; onDeleted: (backup: { projectId: string; expiresAt: number }) => void }) {
  const ownerId = project.members.find(m => m.role === 'Owner')?.userId ?? '';
  const owner = ownerId === currentUserId;
  const [panel, setPanel] = useState<'properties' | 'share' | 'delete'>(deleting ? 'delete' : sharing ? 'share' : 'properties');
  const [name, setName] = useState(project.name), [description, setDescription] = useState(project.description), [status, setStatus] = useState(project.status), [resolution, setResolution] = useState(project.resolution), [fps, setFps] = useState(project.fps);
  const [access, setAccess] = useState<SharingValue>({ shared: project.shared, classRole: project.classRole ?? 'Editor', members: project.members.filter(m => m.role !== 'Owner') });
  const [savedAccess, setSavedAccess] = useState(access);
  const [inherited, setInherited] = useState<ProjectMember[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let active = true; void api<LibraryView>('/library').then(data => { if (active) setInherited(data.folders.find(f => f.id === data.locations[project.id])?.effectiveMembers ?? []); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [project.id]);
  const save = async () => {
    if (!owner || busy) return;
    setBusy(true); setError('');
    try { await flushChanges(); await api(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify(panel === 'share' ? { access: access.shared ? 'class' : access.members.length ? 'people' : 'private', members: access.members, classRole: access.classRole } : { name, description, status, resolution, fps }) }); await refreshState(); if (panel === 'share' && !sharing) { setSavedAccess(access); setPanel('properties'); } else onClose(); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await flushChanges(); const backup = await api<{ projectId: string; expiresAt: number }>(`/projects/${project.id}`, { method: 'DELETE' }); await refreshState(); onDeleted(backup); onClose(); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  return <Modal title={panel === 'share' ? `Share “${project.name}”` : panel === 'delete' ? 'Delete project?' : 'Project settings'} onClose={() => { if (!busy) onClose(); }}><div className="library-dialog-body project-properties">
    {panel === 'properties' && <><label className="form-field">Project name<input required maxLength={100} value={name} disabled={!owner || busy} onChange={e => setName(e.target.value)}/></label><label className="form-field">Description<textarea rows={2} maxLength={5000} value={description} disabled={!owner || busy} onChange={e => setDescription(e.target.value)}/></label><label className="form-field">Status<select value={status} disabled={!owner || busy} onChange={e => setStatus(e.target.value as Project['status'])}><option>In progress</option><option>In review</option><option>Complete</option></select></label><div className="project-format-row"><label className="form-field">Resolution<input maxLength={80} value={resolution} disabled={!owner || busy} onChange={e => setResolution(e.target.value)}/></label><label className="form-field">Frame rate<NumberInput aria-label="Frame rate" min={1} max={240} value={fps} disabled={!owner || busy} onCommit={setFps}/></label></div><button className="project-sharing-link" disabled={busy} onClick={() => setPanel('share')}><Users size={18}/><span><strong>Sharing & access</strong><small>{access.shared ? 'Entire class' : access.members.length ? `${access.members.length + 1} people` : inherited.length ? 'Includes folder access' : 'Restricted'}</small></span><ArrowRight size={16}/></button></>}
    {panel === 'share' && <SharingFields users={users} userId={currentUserId} ownerId={ownerId} value={access} onChange={setAccess} disabled={!owner || busy} inherited={inherited} allowCommenter/>}
    {panel === 'delete' && <p className="sharing-note">Delete “{project.name}”? You can restore it, media included, for 7 days.</p>}
    {error && <p className="dash-form-error" role="alert">{error}</p>}<div className="sharing-actions">{owner && panel === 'properties' && <Button variant="ghost" disabled={busy} onClick={() => setPanel('delete')}><Trash2 size={14}/> Delete</Button>}{panel !== 'properties' && !sharing && !deleting && <Button variant="ghost" disabled={busy} onClick={() => { setAccess(savedAccess); setPanel('properties'); }}>Back</Button>}<span className="spacer"/><Button variant="ghost" disabled={busy} onClick={onClose}>{owner ? 'Cancel' : 'Close'}</Button>{owner && <Button variant={panel === 'delete' ? 'danger' : 'primary'} disabled={busy || panel === 'properties' && (!name.trim() || !resolution.trim() || !Number.isFinite(fps))} onClick={panel === 'delete' ? remove : save}>{busy ? 'Saving…' : panel === 'share' ? 'Done' : panel === 'delete' ? 'Delete project' : 'Save changes'}</Button>}</div>
  </div></Modal>;
}

export default function Dashboard({ onOpenProject, onOpenAuth }: { onOpenProject: (id: string) => void; onOpenAuth: () => void }) {
  const { projects, users, currentUserId, createProject, operations, settings: preferences } = useEditorStore();
  const [section, setSection] = useState('Projects');
  const [resolveImport,setResolveImport]=useState(false);
  const [newProject, setNewProject] = useState(false);
  const [createFolder, setCreateFolder] = useState<LibraryView['folders'][number] | null>(null);
  const [creating, setCreating] = useState(false), [createError, setCreateError] = useState('');
  const [settings, setSettings] = useState(false);
  const [account, setAccount] = useState(false);
  const [server, setServer] = useState(false);
  const [activity, setActivity] = useState(false);
  const [projectSettings, setProjectSettings] = useState<{ project: Project; deleting?: boolean; sharing?: boolean } | null>(null);
  const [deletedProject, setDeletedProject] = useState<{ id: string; name: string; expiresAt: number } | null>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const serverRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [shared, setShared] = useState(preferences.defaultSharing !== 'Private');
  useEffect(() => {
    if (!account) return;
    const trigger = document.activeElement as HTMLElement | null;
    accountRef.current?.querySelector('button')?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setAccount(false); };
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('keydown', close); trigger?.focus(); };
  }, [account]);
  useEffect(() => {
    if (!server) return;
    const close = (event: PointerEvent) => { if (!serverRef.current?.contains(event.target as Node)) setServer(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setServer(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [server]);
  const user = users.find(item => item.id === currentUserId) ?? users[0];
  const changeSection = (value: string) => setSection(value);
  const closeCreate = () => { setNewProject(false); setName(''); setDescription(''); setShared(preferences.defaultSharing !== 'Private'); };
  // "N minutes ago" moves on with time alone: nothing in the store changes for it.
  const [, setNow] = useState(0);
  useEffect(() => { if (!activity) return; const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, [activity]);
  // Deleted projects stay restorable for 7 days, so the way back is a list that outlives the toast and a reload.
  const [recentlyDeleted, setRecentlyDeleted] = useState<{ id: string; name: string; expiresAt: number }[]>([]);
  const loadDeleted = () => { if (connection.enabled) void api<{ projects: typeof recentlyDeleted }>('/projects/deleted').then(data => setRecentlyDeleted(data.projects)).catch(() => {}); };
  useEffect(loadDeleted, [projects.length]);
  const restore = async (id: string) => { try { await api(`/projects/${id}/restore`, { method: 'POST', body: '{}' }); await refreshState(); setDeletedProject(null); loadDeleted(); } catch (error) { useEditorStore.getState().notify((error as Error).message, 'error'); } };

  return <div className="dashboard">
    {resolveImport&&<ResolveImport onClose={()=>setResolveImport(false)} onOpen={onOpenProject}/>}
    <aside className="dash-sidebar">
      <a href="/" className="dash-brand" onClick={event => event.preventDefault()} aria-label="SharedCut home"><Brand /><span className="dash-beta">BETA</span></a>
      <button className="dash-workspace" onClick={() => changeSection('Class')}><span className="dash-workspace-icon"><Film size={18} /></span><span><strong>Class workspace</strong><small>Shared projects</small></span><ChevronDown size={13} /></button>
      <div className="dash-nav-label">WORKSPACE</div>
      <nav className="dash-nav" aria-label="Project navigation">
        {[{ label: 'Projects', icon: FolderOpen, count: undefined }, { label: 'Shared with me', icon: Users, count: undefined }, { label: 'Class', icon: Globe2, count: undefined }].map(({ label, icon: Icon, count }) => <button key={label} className={section === label ? 'active' : ''} onClick={() => changeSection(label)}><Icon size={17} /><span>{label}</span>{count !== undefined && <small>{count}</small>}</button>)}
      </nav>
      <div className="dash-sidebar-bottom">
        <button className="dash-settings-button" onClick={() => setSettings(true)}><Settings size={16} /> Settings</button>
        <ServerControl/>
        <button className="dash-user" aria-label="Open account menu" onClick={() => setAccount(!account)} aria-expanded={account}>{user && <Avatar user={user} size={34} />}<span><strong>{user?.name ?? 'Kyle'}</strong><small>Personal account</small></span><MoreHorizontal size={17} /></button>
      </div>
    </aside>

    <main className="dash-main">
      <header className="dash-heading"><h1>Your workspace</h1><div className="dash-top-actions"><IconButton label="Recent activity" onClick={() => setActivity(!activity)}><Bell size={17}/></IconButton><Button variant="secondary" onClick={() => setResolveImport(true)}>Import Resolve</Button><a className="button button-secondary" href="/importer">Import from Final Cut</a><span className="dash-mobile-account"><IconButton label="Open account menu" onClick={() => setAccount(!account)}>{user && <Avatar user={user} size={28}/>}</IconButton></span></div></header>
      <ProjectLibrary projects={projects} users={users} userId={currentUserId} section={section} onOpen={onOpenProject} onCreate={folder => { setCreateFolder(folder); setShared(folder ? false : preferences.defaultSharing !== 'Private'); setCreateError(''); setNewProject(true); }} onSettings={(project, deleting, sharing) => setProjectSettings({ project, deleting, sharing })}/>
      {section === 'Projects' && recentlyDeleted.length > 0 && <section className="dash-deleted" aria-label="Recently deleted"><h2>Recently deleted</h2>{recentlyDeleted.map(item => <div key={item.id}><Trash2 size={14}/><span><strong>{item.name}</strong><small>Restorable until {new Date(item.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small></span><Button variant="secondary" onClick={() => void restore(item.id)}>Restore</Button></div>)}</section>}
    </main>
    {projectSettings && <ProjectSettings project={projectSettings.project} users={users} currentUserId={currentUserId} deleting={projectSettings.deleting} sharing={projectSettings.sharing} onClose={() => setProjectSettings(null)} onDeleted={backup => setDeletedProject({ id: backup.projectId, name: projectSettings.project.name, expiresAt: backup.expiresAt })}/>} 
    {deletedProject && <div className="dash-undo-delete" role="status"><span><strong>{deletedProject.name}</strong> was deleted. You can restore it for 7 days.</span><Button variant="secondary" onClick={() => void restore(deletedProject.id)}>Undo delete</Button><IconButton label="Dismiss" onClick={() => setDeletedProject(null)}><X size={14}/></IconButton></div>}
    {account && <><button className="dash-popover-dismiss" aria-label="Close account menu" onClick={() => setAccount(false)} /><div className="dash-account-popover dash-popover" ref={accountRef}><div className="dash-account-head">{user && <Avatar user={user} size={38} />}<div><strong>{user?.name}</strong><small>{user?.email}</small></div></div><button onClick={() => { setAccount(false); setSettings(true); }}><Settings size={15} />Account & preferences</button><button onClick={() => { setAccount(false); onOpenAuth(); }}><ArrowRight size={15} />Sign out</button><div className="dash-account-note">Your projects are stored on your studio server.</div></div></>}
    {activity && <Modal title="Recent activity" onClose={() => setActivity(false)}><div className="dash-activity-list">{operations.slice(0, 6).map(operation => { const author = users.find(item => item.id === operation.userId); return <div key={operation.id}>{author && <Avatar user={author} size={30} />}<div><strong>{author?.name} <span>{operation.description}</span></strong><small>{modified(operation.timestamp)}</small></div></div>; })}{!operations.length && <p className="muted">Your project activity will appear here.</p>}</div></Modal>}
    {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    {newProject && <Modal title="New project" onClose={closeCreate}><form className="dash-create-form" onSubmit={async event => { event.preventDefault(); if (!name.trim() || creating) return; setCreating(true); setCreateError(''); try { const id = createProject({ name: name.trim(), description: description.trim(), shared }); await flushChanges(); if (createFolder) { const change = { action: 'move', kind: 'project', id, parentId: createFolder.id }; const { preview } = await api<{ preview: AccessPreview }>('/library', { method: 'POST', body: JSON.stringify({ ...change, preview: true }) }); await api('/library', { method: 'POST', body: JSON.stringify({ ...change, revision: preview.revision }) }); await refreshState(); } closeCreate(); onOpenProject(id); } catch (e) { setCreateError(`Project may have been created at the top level. ${(e as Error).message}`); } finally { setCreating(false); } }}><label className="form-field">Project name<input className="input" required maxLength={80} autoFocus placeholder="Project name" value={name} onChange={event => setName(event.target.value)} /></label><label className="form-field"><span>Description <span className="muted">(optional)</span></span><textarea className="input" rows={3} maxLength={500} placeholder="Project description" value={description} onChange={event => setDescription(event.target.value)} /></label>{createFolder && <p className="drive-inherited-note" role="note">Creating in “{createFolder.name}” shares this project with {createFolder.classShared ? 'everyone on the server, including future class members' : createFolder.effectiveMembers.filter(m => m.userId !== currentUserId).map(m => users.find(u => u.id === m.userId)?.name).filter(Boolean).join(', ') || 'only you'}. It inherits the folder’s access.</p>}{createError && <p role="alert" className="drive-error">{createError}</p>}<label className="dash-share-switch"><span className="dash-share-icon"><Users size={20} /></span><span><strong>Share with class</strong><small>Allow class members to access this project.</small></span><input type="checkbox" className="dash-switch" checked={shared} onChange={event => setShared(event.target.checked)} /></label><div className="dash-create-format"><Film size={15} /><span>{String(preferences.timelineResolution||'1920 × 1080')} <i>·</i> {String(preferences.timelineFrameRate||'24 fps')}</span></div><div className="dash-dialog-actions"><Button type="button" variant="ghost" onClick={closeCreate}>Cancel</Button><Button type="submit" variant="primary" disabled={!name.trim() || creating}>Create project <ArrowRight size={15} /></Button></div></form></Modal>}
  </div>;
}
