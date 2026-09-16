import type { ProjectMember } from '../state/models';
export interface ProjectFolder { id: string; name: string; parentId: string | null; ownerId: string; shared: boolean; classRole: 'Editor' | 'Viewer'; members: ProjectMember[]; modifiedAt: number }
export interface LibraryView { revision: number; folders: (ProjectFolder & { effectiveMembers: ProjectMember[]; classShared: boolean })[]; locations: Record<string, string>; directMembers: Record<string, ProjectMember[]> }
export interface LibraryChange { action: 'create' | 'update' | 'move' | 'delete'; kind?: 'project' | 'folder'; id?: string; parentId?: string | null; name?: string; shared?: boolean; classRole?: 'Editor' | 'Viewer'; members?: ProjectMember[] }
export interface AccessPreview { revision: number; changes: { name: string; added: string[]; removed: string[]; changed: string[] }[]; audience: string[]; classShared: boolean }
