import { useState } from 'react';
import { Globe2, LockKeyhole, Search } from 'lucide-react';
import type { ProjectMember, User } from '../state/models';
import { Avatar } from './ui';

export interface SharingValue { shared: boolean; classRole: 'Editor' | 'Viewer'; members: ProjectMember[] }
export default function SharingFields({ users, userId, ownerId, value, onChange, disabled = false, inherited = [], allowCommenter = false }: { users: User[]; userId: string; ownerId: string; value: SharingValue; onChange: (value: SharingValue) => void; disabled?: boolean; inherited?: ProjectMember[]; allowCommenter?: boolean }) {
  const [query, setQuery] = useState('');
  const owner = users.find(u => u.id === ownerId);
  const results = query.trim() ? users.filter(u => !u.guest && u.id !== ownerId && !value.members.some(m => m.userId === u.id) && `${u.name} ${u.email}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 5) : [];
  const add = (id: string) => { onChange({ ...value, members: [...value.members, { userId: id, role: 'Editor' }] }); setQuery(''); };
  const inheritedPeople = inherited.filter(m => m.userId !== ownerId);
  return <div className="sharing-fields">
    {!disabled && <div className="sharing-search"><Search size={17}/><input autoFocus aria-label="Add people" autoComplete="off" placeholder="Add people by name or email" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (results.length === 1) add(results[0].id); } }}/></div>}
    {!!query.trim() && <div className="sharing-results" aria-label="Matching people">{results.length ? results.map(u => <button key={u.id} type="button" onClick={() => add(u.id)}><Avatar user={u} size={32}/><span><strong>{u.name}</strong><small>{u.email}</small></span><span className="sharing-add">Add</span></button>) : <p role="status">No other matching people on this server.</p>}</div>}
    <section><h3>People with access</h3><div className="sharing-people">
      {owner && <div className="sharing-person"><Avatar user={owner} size={32}/><span><strong>{owner.name}{ownerId === userId ? ' (you)' : ''}</strong><small>{owner.email}</small></span><span className="sharing-role">Owner</span></div>}
      {value.members.filter(m => m.userId !== ownerId).map(m => { const u = users.find(u => u.id === m.userId); return u ? <div className="sharing-person" key={u.id}><Avatar user={u} size={32}/><span><strong>{u.name}{u.id === userId ? ' (you)' : ''}</strong><small>{u.email}</small></span><select aria-label={`Access for ${u.name}`} disabled={disabled} value={m.role} onChange={e => onChange({ ...value, members: value.members.flatMap(member => member.userId !== u.id ? [member] : e.target.value === 'remove' ? [] : [{ userId: u.id, role: e.target.value as ProjectMember['role'] }]) })}><option>Viewer</option>{(allowCommenter || m.role === 'Commenter') && <option>Commenter</option>}<option>Editor</option><option value="remove">Remove access</option></select></div> : null; })}
    </div></section>
    <section><h3>General access</h3><div className="sharing-general"><span className="sharing-access-icon">{value.shared ? <Globe2 size={20}/> : <LockKeyhole size={19}/>}</span><div><select aria-label="General access" disabled={disabled} value={value.shared ? 'class' : 'restricted'} onChange={e => onChange({ ...value, shared: e.target.value === 'class' })}><option value="restricted">Restricted</option><option value="class">Entire class</option></select><p>{value.shared ? 'Everyone on this server can access.' : 'Only people with access can open.'}</p></div>{value.shared && <select aria-label="Class access" disabled={disabled} value={value.classRole} onChange={e => onChange({ ...value, classRole: e.target.value as SharingValue['classRole'] })}><option>Viewer</option><option>Editor</option></select>}</div></section>
    {!!inheritedPeople.length && <details className="sharing-inherited"><summary>Access from parent folder · {inheritedPeople.length}</summary><p>Parent folder access still applies when direct access is removed.</p>{inheritedPeople.map(m => <div key={m.userId}><span>{users.find(u => u.id === m.userId)?.name ?? 'Class member'}</span><span>{m.role === 'Owner' ? 'Editor' : m.role}</span></div>)}</details>}
  </div>;
}
