import { useEffect, useState } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { api } from '../services/api';
import { refreshState } from '../services/sync';
import { Button } from './ui';

type Kept = { id: string; name: string; kept: boolean; here: boolean; status?: 'synced' | 'offline' | 'error'; error?: string; uploading: number; downloading: number };
type Link = { url: string; user: { name: string; email: string } | null; online: boolean; projects: Kept[] };

const progress = (p: Kept) => p.status === 'error' ? p.error : p.status === 'offline' ? 'Offline · edits here sync when you are back online'
  : p.downloading ? `Downloading ${p.downloading} file${p.downloading === 1 ? '' : 's'}` : p.uploading ? `Uploading ${p.uploading} file${p.uploading === 1 ? '' : 's'}` : p.status === 'synced' ? 'Synced with sharedcut.com' : 'Syncing…';

/** SharedCut Desktop only (its server has /api/remote, see server/remoteSync.ts): sign in to sharedcut.com once, then keep
 *  projects on this computer. A kept project stays live with sharedcut.com while online and merges back after offline work. */
export default function RemoteSync() {
  const [link, setLink] = useState<Link | null>(null), [all, setAll] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => void api<Link>('/remote').then(data => { if (alive) setLink(data); }).catch(() => {});
    load(); const timer = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  if (!link) return null;
  const run = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try { setLink(await api<Link>(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })); setPassword(''); await refreshState(); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const kept = link.projects.filter(p => p.kept), others = link.projects.filter(p => !p.kept);
  return <section className="dash-deleted dash-remote" aria-label="sharedcut.com">
    <h2>sharedcut.com{link.user ? ` · ${link.user.email}${link.online ? '' : ' · offline'}` : ''}</h2>
    {!link.user && <form onSubmit={event => { event.preventDefault(); void run('/remote/login', 'POST', { email, password }); }}>
      <Cloud size={14}/><span><strong>Sync with sharedcut.com</strong><small>Sign in to keep your online projects on this computer.</small></span>
      <input className="input" type="email" required placeholder="Email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)}/>
      <input className="input" type="password" required placeholder="Password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/>
      <Button type="submit" variant="secondary" disabled={busy}>Sign in</Button>
    </form>}
    {link.user && [...kept, ...(all ? others : [])].map(p => <div key={p.id}>
      {p.kept && p.status !== 'offline' ? <Cloud size={14}/> : <CloudOff size={14}/>}
      <span><strong>{p.name}</strong><small>{p.kept ? progress(p) : 'Only on sharedcut.com'}</small></span>
      <Button variant="secondary" disabled={busy} onClick={() => void run(`/remote/projects/${p.id}`, p.kept ? 'DELETE' : 'PUT')}>{p.kept ? 'Stop syncing' : 'Keep on this computer'}</Button>
    </div>)}
    {link.user && <p className="dash-remote-actions">{others.length > 0 && <Button variant="ghost" onClick={() => setAll(!all)}>{all ? 'Hide other projects' : `Projects on sharedcut.com (${others.length})`}</Button>}<Button variant="ghost" disabled={busy} onClick={() => void run('/remote/logout', 'POST')}>Sign out of sharedcut.com</Button></p>}
    {error && <p className="dash-form-error" role="alert">{error}</p>}
  </section>;
}
