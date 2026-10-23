import { useEffect, useState } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { api, ApiError } from '../services/api';
import { refreshState } from '../services/sync';
import { Button } from './ui';

type Kept = { id: string; name: string; kept: boolean; here: boolean; status?: 'synced' | 'offline' | 'error'; error?: string; uploading: number; downloading: number };
// expired: the account whose sharedcut.com session ended; uploading/downloading: files still to go.
type Link = { url: string; user: { name: string; email: string } | null; expired: string | null; online: boolean; projects: Kept[] };

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
const progress = (p: Kept) => p.status === 'error' ? p.error : p.status === 'offline' ? 'Offline · edits here sync when you are back online'
  : p.downloading ? `Downloading ${files(p.downloading)}` : p.uploading ? `Uploading ${files(p.uploading)}` : p.status === 'synced' ? 'Synced with sharedcut.com' : 'Syncing…';

/** /api/remote every 5 s; null on a server without the link (the website), which then stops asking. */
export function useRemoteLink() {
  const [link, setLink] = useState<Link | null>(null);
  useEffect(() => {
    let alive = true, timer = 0;
    const load = () => void api<Link>('/remote').then(data => { if (alive) setLink(data); }, error => { if (error instanceof ApiError && error.status === 404) window.clearInterval(timer); });
    load(); timer = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return [link, setLink] as const;
}

/** The sidebar line under the local server's ("Server connected" is this computer's own server): whether the app is
 *  signed in to sharedcut.com and what the sync is doing. It leads to the sign-in form. */
export function RemoteStatus({ link, onOpen }: { link: Link | null; onOpen: () => void }) {
  if (!link) return null;
  const kept = link.projects.filter(p => p.kept), up = kept.reduce((n, p) => n + p.uploading, 0), down = kept.reduce((n, p) => n + p.downloading, 0), failing = kept.some(p => p.status === 'error');
  const [text, ok]: [string, boolean] = !link.user ? [link.expired ? 'sharedcut.com session ended' : 'Not signed in to sharedcut.com', false] : !link.online ? ['sharedcut.com offline', false]
    : failing ? ['sharedcut.com · a project is not syncing', false] : up ? [`Uploading ${files(up)}`, true] : down ? [`Downloading ${files(down)}`, true] : ['Synced with sharedcut.com', true];
  const open = () => { onOpen(); requestAnimationFrame(() => { const section = document.getElementById('sharedcut-link'); section?.scrollIntoView({ behavior: 'smooth', block: 'center' }); section?.querySelector<HTMLInputElement>('input:placeholder-shown')?.focus({ preventScroll: true }); }); };
  return <button className="server-trigger dash-remote-status" onClick={open}><i className="status-dot" style={{ background: ok ? undefined : '#e09b72' }}/><span>{text}</span></button>;
}

/** SharedCut Desktop only (its server has /api/remote, see server/remoteSync.ts): sign in to sharedcut.com once. Projects
 *  made here then go up by themselves and stay live; ones from sharedcut.com come down when kept on this computer. */
export default function RemoteSync({ link, onLink }: { link: Link | null; onLink: (link: Link) => void }) {
  const [all, setAll] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const expired = link?.expired;
  useEffect(() => { if (expired) setEmail(current => current || expired); }, [expired]);
  if (!link) return null;
  const run = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try { onLink(await api<Link>(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })); setPassword(''); await refreshState(); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const kept = link.projects.filter(p => p.kept), others = link.projects.filter(p => !p.kept);
  return <section id="sharedcut-link" className="dash-deleted dash-remote" aria-label="sharedcut.com">
    <h2>sharedcut.com{link.user ? ` · ${link.user.email}${link.online ? '' : ' · offline'}` : ' · not signed in'}</h2>
    {!link.user && <form onSubmit={event => { event.preventDefault(); void run('/remote/login', 'POST', { email, password }); }}>
      <CloudOff size={14}/><span><strong>{link.expired ? 'Your sharedcut.com session ended' : 'Sign in to sharedcut.com'}</strong><small>{link.expired ? 'Sign in again to keep syncing. Edits wait on this computer meanwhile.' : 'Projects made here then go up to sharedcut.com with their footage and stay live there.'}</small></span>
      <input className="input" type="email" required placeholder="Email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)}/>
      <input className="input" type="password" required placeholder="Password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/>
      <Button type="submit" variant="secondary" disabled={busy}>Sign in</Button>
    </form>}
    {link.user && [...kept, ...(all ? others : [])].map(p => <div key={p.id}>
      {p.kept && p.status !== 'offline' ? <Cloud size={14}/> : <CloudOff size={14}/>}
      <span><strong>{p.name}</strong><small>{p.kept ? progress(p) : p.here ? 'Also on this computer, not syncing' : 'Only on sharedcut.com'}</small></span>
      <Button variant="secondary" disabled={busy} onClick={() => void run(`/remote/projects/${p.id}`, p.kept ? 'DELETE' : 'PUT')}>{p.kept ? 'Stop syncing' : 'Keep on this computer'}</Button>
    </div>)}
    {link.user && <p className="dash-remote-actions">{others.length > 0 && <Button variant="ghost" onClick={() => setAll(!all)}>{all ? 'Hide other projects' : `Projects on sharedcut.com (${others.length})`}</Button>}<Button variant="ghost" disabled={busy} onClick={() => void run('/remote/logout', 'POST')}>Sign out of sharedcut.com</Button></p>}
    {error && <p className="dash-form-error" role="alert">{error}</p>}
  </section>;
}
