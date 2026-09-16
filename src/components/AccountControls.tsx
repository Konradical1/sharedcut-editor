import { useEffect, useState } from 'react';
import { Settings, LogOut, Server, Cpu, Users, Check, ChevronDown } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { Avatar, Badge } from './ui';
import { api } from '../services/api';

export function AccountControl({ onSignOut }: { onSignOut: () => void }) {
  const users = useEditorStore(s => s.users);
  const currentUserId = useEditorStore(s => s.currentUserId);
  const [open, setOpen] = useState(false);
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
  const user = users.find(u => u.id === currentUserId);
  const s = useEditorStore.getState;
  if (!user) return null;
  return <div className="account-control"><button className="account-trigger" aria-label="Open account menu" aria-expanded={open} onClick={() => setOpen(!open)}><Avatar user={user} size={29}/><ChevronDown size={11}/></button>{open && <><button aria-label="Close account menu" className="popover-dismiss" onClick={() => setOpen(false)}/><div className="account-popover popover"><div className="row"><Avatar user={user} size={38}/><div><b>{user.name}</b><span className="account-email muted">{user.email}</span></div></div><div className="divider"/><span className="eyebrow">YOUR COLLABORATION COLOR</span><div className="color-swatches">{['#F06A70','#B298F5','#78AAEF','#EBC876','#79BDA4','#ED99C4'].map(color => <button key={color} aria-label={`Collaboration color ${color}`} style={{background:color}} onClick={() => s().setUserColor(color)}>{user.color===color&&<Check size={15}/>}</button>)}</div><p className="muted">Your cursor, playhead, and selections.</p><div className="divider"/><button className="popover-item" onClick={() => {s().setModal('settings');setOpen(false);}}><Settings size={15}/>Account & settings</button><button className="popover-item" onClick={() => {setOpen(false);onSignOut();}}><LogOut size={15}/>Sign out</button></div></>}</div>;
}
export function ServerControl() {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<Record<string, any> | null>(null);
  const online = useEditorStore(s => s.serverOnline);
  const jobs = useEditorStore(s => s.renderJobs);
  const media = useEditorStore(s => s.media);
  const presence = useEditorStore(s => s.presence);
  useEffect(() => { if (open) void api('/health').then(setHealth).catch(() => setHealth(null)); }, [open]);
  return <div className="server-control"><button className="server-trigger" aria-label="Server status" aria-expanded={open} onClick={() => setOpen(!open)}><i className="status-dot" style={{background:online?undefined:'#e09b72'}}/><span>{online?'Server connected':'Reconnecting'}</span><ChevronDown size={11}/></button>{open&&<><button aria-label="Close server status" className="popover-dismiss" onClick={() => setOpen(false)}/><div className="server-popover popover"><div className="row"><span className="server-icon"><Server size={21}/></span><div><h3>Studio server</h3><span className="muted">Media and project storage</span></div><Badge>{online?'Online':'Offline'}</Badge></div><dl className="server-metrics"><div><dt><Cpu size={14}/>Preparing media</dt><dd>{media.filter(m=>!['ready','failed'].includes(m.status)).length}</dd></div><div><dt><Server size={14}/>Active renders</dt><dd>{jobs.filter(j=>j.status==='rendering').length}</dd></div><div><dt><Users size={14}/>Other sessions in project</dt><dd>{presence.filter(p=>p.online).length}</dd></div></dl><div className="server-footnote">{health?'Server health checked just now.':'Checking server health…'} Originals and exports are stored on the server.</div></div></>}</div>;
}
