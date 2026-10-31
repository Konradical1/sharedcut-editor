import type { MediaAsset, Project, ProjectMember } from '../state/models';
export interface ProjectFolder { id: string; name: string; parentId: string | null; ownerId: string; shared: boolean; classRole: 'Editor' | 'Viewer'; members: ProjectMember[]; modifiedAt: number }
export interface ProjectActivity { userId: string; kind: 'edited' | 'viewed'; timestamp: number }
export interface LibraryView { activity?: Record<string, ProjectActivity>; revision: number; folders: (ProjectFolder & { effectiveMembers: ProjectMember[]; classShared: boolean })[]; locations: Record<string, string>; directMembers: Record<string, ProjectMember[]> }
export interface LibraryChange { action: 'create' | 'update' | 'move' | 'delete'; kind?: 'project' | 'folder'; id?: string; parentId?: string | null; name?: string; shared?: boolean; classRole?: 'Editor' | 'Viewer'; members?: ProjectMember[] }
export interface AccessPreview { revision: number; changes: { name: string; added: string[]; removed: string[]; changed: string[] }[]; audience: string[]; classShared: boolean }

/** A card shows the project's own footage: a stock /media/ placeholder only survives when nothing real exists. */
export const projectCover = (project: Project, media: MediaAsset[]) =>
  (project.thumbnail.startsWith('/media/') ? '' : project.thumbnail)
  || media.find(m => m.projectId === project.id && m.kind === 'video' && m.thumbnail)?.thumbnail
  || project.thumbnail;

/** Relative label only for a real interaction in the past 24 hours. */
export function projectActivityLabel(activity: ProjectActivity | undefined, users: Pick<import('../state/models').User, 'id' | 'name'>[], now = Date.now()) {
  if (!activity || activity.timestamp > now || now - activity.timestamp >= 86_400_000) return '';
  const person = users.find(user => user.id === activity.userId);
  if (!person) return '';
  const minutes = Math.floor((now - activity.timestamp) / 60_000);
  const hours = Math.floor(minutes / 60);
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${person.name} ${activity.kind} this ${ago}`;
}
