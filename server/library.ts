import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Project, Role, User } from '../src/state/models.ts';
import type { ProjectFolder, LibraryView, AccessPreview } from '../src/services/library.ts';

type Library = { folders: ProjectFolder[]; locations: Record<string, string> };
const rank = { Viewer: 1, Commenter: 2, Editor: 3, Owner: 4 };
const stronger = (a: Role | undefined, b: Role | undefined) => !a ? b : !b ? a : rank[a] >= rank[b] ? a : b;
const denied = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
// `commit` runs a write together with the workspace save, in one transaction.
export function projectLibrary(db: DatabaseSync, projects: () => Project[], users: () => User[], revision: () => number, commit: (write: () => void) => void) {
  db.exec('CREATE TABLE IF NOT EXISTS library(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
  const saved = db.prepare('SELECT data FROM library WHERE id=1').get() as { data: string } | undefined;
  let library: Library = saved ? JSON.parse(saved.data) : { folders: [], locations: {} };
  const location = (id: string, data = library) => Object.hasOwn(data.locations, id) ? data.locations[id] : undefined;
  const ancestors = (id: string | null | undefined, data = library) => {
    const result: ProjectFolder[] = [], seen = new Set<string>();
    while (id) {
      if (seen.has(id)) denied(400, 'A folder cannot contain itself.');
      seen.add(id); const folder = data.folders.find(f => f.id === id); if (!folder) break;
      result.push(folder); id = folder.parentId;
    }
    return result;
  };
  const folderRole = (id: string | null | undefined, userId: string, data = library): Role | undefined => {
    let role: Role | undefined;
    for (const [index, f] of ancestors(id, data).entries()) {
      const direct = f.ownerId === userId ? (index === 0 ? 'Owner' : 'Editor') : f.members.find(m => m.userId === userId)?.role;
      role = stronger(role, stronger(direct, f.shared ? f.classRole : undefined));
    }
    return role;
  };
  const projectRole = (p: Project, userId: string, data = library) => {
    const direct = p.members.find(m => m.userId === userId)?.role ?? (p.shared ? p.classRole ?? 'Editor' : undefined);
    const inherited = folderRole(location(p.id, data), userId, data);
    return stronger(direct, inherited === 'Owner' ? 'Editor' : inherited);
  };
  const classShared = (id: string | null | undefined, data = library) => ancestors(id, data).some(f => f.shared);
  const view = (userId: string): LibraryView => {
    const visible = projects().filter(p => projectRole(p, userId)), people = users();
    return { revision: revision(), folders: library.folders.filter(f => folderRole(f.id, userId)).map(f => ({ ...f, classShared: classShared(f.id), effectiveMembers: people.flatMap(u => { const role = folderRole(f.id, u.id); return role ? [{ userId: u.id, role }] : []; }) })), locations: Object.fromEntries(visible.filter(p => location(p.id)).map(p => [p.id, location(p.id)!])), directMembers: Object.fromEntries(visible.map(p => [p.id, p.members])) };
  };
  const change = (body: Record<string, any>, userId: string) => {
    const next = structuredClone(library);
    next.locations = Object.assign(Object.create(null), next.locations);
    const people = users();
    const folder = body.id ? next.folders.find(f => f.id === body.id) : undefined;
    const requireOwner = () => { if (!folder || folder.ownerId !== userId) denied(403, 'Only the folder owner can change or move this folder.'); return folder!; };
    const destination = () => {
      if (body.parentId !== null && (typeof body.parentId !== 'string' || !next.folders.some(f => f.id === body.parentId))) denied(404, 'Destination folder not found.');
      if (body.parentId && !['Owner', 'Editor'].includes(folderRole(body.parentId, userId) ?? '')) denied(403, 'You need edit access to the destination folder.');
      return body.parentId as string | null;
    };
    const fields = () => {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) denied(400, 'Enter a folder name of up to 100 characters.');
      if (typeof body.shared !== 'boolean' || !['Editor', 'Viewer'].includes(body.classRole)) denied(400, 'Choose valid class access.');
      if (!Array.isArray(body.members) || body.members.length > 10000) denied(400, 'Invalid folder members.');
      const seen = new Set<string>();
      for (const m of body.members) { if (!m || !people.some(u => u.id === m.userId) || !['Editor', 'Viewer'].includes(m.role) || seen.has(m.userId) || m.userId === userId) denied(400, 'Invalid folder member.'); seen.add(m.userId); }
      return { name: body.name.trim(), shared: body.shared as boolean, classRole: body.classRole as 'Editor' | 'Viewer', members: body.members, modifiedAt: Date.now() };
    };
    let targetId = body.id as string | undefined;
    if (body.action === 'create') {
      if (next.folders.length >= 10000) denied(400, 'The folder limit has been reached.');
      targetId = `folder-${randomUUID()}`;
      next.folders.push({ id: targetId, parentId: destination(), ownerId: userId, ...fields() });
    } else if (body.action === 'update') Object.assign(requireOwner(), fields());
    else if (body.action === 'move') {
      const parentId = destination();
      if (body.kind === 'project') {
        const p = projects().find(p => p.id === body.id);
        if (!p || !p.members.some(m => m.userId === userId && m.role === 'Owner')) denied(403, 'Only the project owner can move this project.');
        if (parentId) next.locations[p!.id] = parentId; else delete next.locations[p!.id];
      } else if (body.kind === 'folder') {
        const f = requireOwner();
        if (ancestors(parentId, next).some(a => a.id === f.id)) denied(400, 'A folder cannot be moved into itself or its subfolders.');
        f.parentId = parentId; f.modifiedAt = Date.now();
      } else denied(400, 'Choose a project or folder.');
    } else if (body.action === 'delete') {
      const f = requireOwner();
      if (next.folders.some(child => child.parentId === f.id) || projects().some(p => location(p.id, next) === f.id)) denied(409, 'Move the contents out before deleting this folder.');
      next.folders = next.folders.filter(item => item.id !== f.id);
      next.locations = Object.fromEntries(Object.entries(next.locations).filter(([, id]) => id !== f.id));
    } else denied(400, 'Invalid library action.');
    const changes: AccessPreview['changes'] = [];
    const audience = new Set<string>();
    const compare = (name: string, before: (id: string) => Role | undefined, after: (id: string) => Role | undefined) => {
      const entry = { name, added: [] as string[], removed: [] as string[], changed: [] as string[] };
      for (const u of people) {
        const a = before(u.id), b = after(u.id); if (u.id === userId) continue; if (b) audience.add(u.name);
        if (!a && b) entry.added.push(u.name); else if (a && !b) entry.removed.push(u.name); else if (a !== b) entry.changed.push(`${u.name}: ${b}`);
      }
      if (entry.added.length || entry.removed.length || entry.changed.length) changes.push(entry);
    };
    for (const p of projects()) {
      const affected = body.kind === 'project' ? p.id === targetId : ancestors(location(p.id, next), next).some(f => f.id === targetId);
      if (affected) compare(p.name, id => projectRole(p, id), id => projectRole(p, id, next));
    }
    if (body.kind !== 'project' && body.action !== 'delete') compare(next.folders.find(f => f.id === targetId)!.name, id => folderRole(targetId, id), id => folderRole(targetId, id, next));
    const preview: AccessPreview = { revision: revision(), changes, audience: [...audience], classShared: classShared(body.kind === 'project' ? next.locations[targetId!] : targetId, next) };
    if (body.preview === true) return { preview };
    // The global revision also covers account and direct project-sharing changes during confirmation.
    if (body.revision !== revision()) denied(409, 'The library changed. Review this action again.');
    const previous = library;
    try { commit(() => { library = next; db.prepare('INSERT INTO library(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next)); }); }
    catch (error) { library = previous; throw error; }
    return { id: targetId, ...view(userId) };
  };
  return { view, change, projectRole, hasLocation: (id: string) => Boolean(location(id)) };
}
