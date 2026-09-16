import { isShape, getShape, validateShape } from './shapes.ts';
import { isComposition, validateCompositions } from './compositions.ts';
import { isTitle, getText, validateText } from './text.ts';
import type { CollaborativeLock, GradeNode, MediaAsset, Operation, Presence, Project, RenderJob, Settings, Snapshot, Timeline, User, ProjectState } from '../state/models.ts';

export const createId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const STORAGE_KEY = 'frameline.project-state.v1';
export const LOCK_TTL = 8_000;
// One definition of which lock fields collide, shared by the editor's gate and the server's
// enforcement. Two copies of this rule is how a control ends up editable on both machines.
export const MOVEMENT_FIELDS = ['manipulation', 'start', 'duration', 'trackId', 'sourceIn'];
export const lockConflict = (a: string, b: string) => a === b || a === '*' || b === '*' || (MOVEMENT_FIELDS.includes(a) && MOVEMENT_FIELDS.includes(b));
export interface PersistedState extends ProjectState {
  projects: Project[]; media: MediaAsset[]; timelines: Timeline[]; operations: Operation[];
  snapshots: Snapshot[]; renderJobs: RenderJob[]; users: User[]; currentUserId: string; settings: Settings;
}
export interface ProjectService { load(): PersistedState | null; save(state: PersistedState): void }
export interface MediaService {
  importFiles(files: File[], projectId: string): MediaAsset[];
  advance(asset: MediaAsset, elapsed: number): MediaAsset;
}
export interface CollaborationService {
  createOperation(operation: Omit<Operation, 'id' | 'timestamp'>): Operation;
  advancePresence(presence: Presence[], now: number, duration: number): Presence[];
  expireLocks(locks: CollaborativeLock[], now: number): CollaborativeLock[];
}
export interface RenderService {
  enqueue(projectId: string, name: string, preset: string, settings: Record<string, string>, busy: boolean): RenderJob;
  advance(job: RenderJob, elapsed: number): RenderJob;
}
export interface GradeProposal { nodes: { name: string; parameters: Record<string, number> }[]; explanation: string }
export interface ColorService { generateGrade(prompt: string): Promise<GradeProposal>; createNode(name: string, projectId: string, clipId: string, parameters?: Record<string, number>): GradeNode }
export interface AuthenticationService { signIn(email: string, name?: string): Promise<User>; updateProfile(user: User, profile: { name: string; email: string }): User }

const requirements: Record<string, Record<string, string>> = {
  projects: { id: 'string', name: 'string', description: 'string', thumbnail: 'string', modifiedAt: 'number', duration: 'number', resolution: 'string', fps: 'number', shared: 'boolean', status: 'string', members: 'array' },
  media: { id: 'string', projectId: 'string', name: 'string', kind: 'string', binId: 'string', thumbnail: 'string', duration: 'number', resolution: 'string', fps: 'number', size: 'string', status: 'string', progress: 'number' },
  timelines: { id: 'string', projectId: 'string', name: 'string', duration: 'number' },
  clips: { id: 'string', projectId: 'string', timelineId: 'string', trackId: 'string', mediaId: 'string', name: 'string', start: 'number', duration: 'number', sourceIn: 'number', color: 'string', disabled: 'boolean', properties: 'object', effects: 'array' },
  tracks: { id: 'string', timelineId: 'string', name: 'string', kind: 'string', number: 'number', muted: 'boolean', solo: 'boolean', locked: 'boolean', hidden: 'boolean', gain: 'number', pan: 'number' },
  nodes: { id: 'string', projectId: 'string', clipId: 'string', name: 'string', kind: 'string', enabled: 'boolean', parameters: 'object' },
  comments: { id: 'string', projectId: 'string', userId: 'string', text: 'string', timestamp: 'number', time: 'number', resolved: 'boolean', replies: 'array' },
  operations: { id: 'string', projectId: 'string', userId: 'string', timestamp: 'number', targetId: 'string', type: 'string', description: 'string', oldState: 'array', newState: 'array' },
  snapshots: { id: 'string', projectId: 'string', name: 'string', note: 'string', userId: 'string', timestamp: 'number', state: 'object' },
  renderJobs: { id: 'string', projectId: 'string', name: 'string', preset: 'string', status: 'string', progress: 'number', remaining: 'string', settings: 'object' },
  users: { id: 'string', name: 'string', email: 'string', initials: 'string', color: 'string' },
};
const hasShape = (value: unknown, shape: Record<string, string>): boolean => !!value && typeof value === 'object' && Object.entries(shape).every(([key, type]) => {
  const field = (value as Record<string, unknown>)[key];
  return type === 'array' ? Array.isArray(field) : type === 'number' ? typeof field === 'number' && Number.isFinite(field) : type === 'object' ? !!field && typeof field === 'object' && !Array.isArray(field) : typeof field === type;
});
const validCollection = (value: unknown, key: string) => Array.isArray(value) && value.every(item => hasShape(item, requirements[key])) && new Set(value.map(item => item.id)).size === value.length;

// Local adapters deliberately implement the same seams a server client will use.
export const projectService: ProjectService = {
  load() {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.version !== 1) return null;
    const state = saved.state;
    if (!state || Object.keys(requirements).some(key => !validCollection(state[key], key)) || typeof state.currentUserId !== 'string' || !hasShape(state.settings, { uiScale: 'string', timelineDensity: 'string', reducedMotion: 'boolean' })) throw new Error('The local project cache could not be read. The demo has been recovered.');
    const typed = state as PersistedState;
    if (!typed.users.some(user => user.id === typed.currentUserId) || !typed.projects.some(project => project.id === 'city-after-dark') || typed.projects.some(project => project.members.some(member => !hasShape(member, { userId: 'string', role: 'string' }))) || typed.comments.some(comment => comment.replies.some(reply => !hasShape(reply, { id: 'string', userId: 'string', text: 'string', timestamp: 'number' }))) || typed.snapshots.some(snapshot => ['clips', 'tracks', 'nodes', 'comments'].some(key => !validCollection((snapshot.state as unknown as Record<string, unknown>)[key], key)))) throw new Error('The local project cache is incomplete. The demo has been recovered.');
    if (typed.clips.some(clip => clip.start < 0 || clip.duration <= 0 || clip.sourceIn < 0 || !typed.tracks.some(track => track.id === clip.trackId && track.timelineId === clip.timelineId) || (!isTitle(clip) && !isShape(clip) && !isComposition(clip) && !typed.media.some(asset => asset.id === clip.mediaId && asset.projectId === clip.projectId))) || typed.nodes.some(node => !typed.clips.some(clip => clip.id === node.clipId && clip.projectId === node.projectId))) throw new Error('The local timeline cache is damaged. The demo has been recovered.');
    if (typed.operations.some(operation => [...operation.oldState as unknown[], ...operation.newState as unknown[]].some(item => {
      if (!item || typeof item !== 'object') return true;
      const change = item as { collection: string; id: string; value: unknown; replace?: boolean; unset?: unknown };
      if (!['clips', 'tracks', 'nodes', 'comments', 'timelines'].includes(change.collection) || typeof change.id !== 'string' || (change.value !== null && (typeof change.value !== 'object' || Array.isArray(change.value)))) return true;
      if (change.unset !== undefined && (!Array.isArray(change.unset) || change.unset.some(key => typeof key !== 'string'))) return true;
      return [...Object.keys(change.value ?? {}), ...change.unset as string[] ?? []].some(key => key.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part)));
    }))) throw new Error('The local activity cache is damaged. The demo has been recovered.');
    typed.clips.filter(isTitle).forEach(clip => validateText(getText(clip)));
    typed.clips.filter(isShape).forEach(clip=>validateShape(JSON.parse(String(clip.properties.shapeDocument))));
    validateCompositions(typed.clips,typed.timelines);
    return state as PersistedState;
  },
  save(state) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, state }));
  },
};

const stages = ['uploading', 'processing', 'proxy', 'waveform', 'thumbnails', 'ready'] as const;
export const mediaService: MediaService = {
  importFiles(files, projectId) {
    return files.map(file => {
      const audio = file.type.startsWith('audio/') || /\.(wav|mp3|aiff|aif|flac|m4a)$/i.test(file.name);
      const image = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?)$/i.test(file.name);
      const supported = audio || image || file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mxf|braw|avi)$/i.test(file.name);
      return { id: createId('media'), projectId, name: file.name.slice(0, 255), kind: audio ? 'audio' : image ? 'image' : 'video', binId: audio ? 'audio' : 'broll', thumbnail: '', duration: audio ? 180 : image ? 6 : 60, resolution: audio ? '48 kHz · Stereo' : '1920 × 1080', fps: audio ? 0 : 24, size: file.size >= 1e9 ? `${(file.size / 1e9).toFixed(1)} GB` : `${(file.size / 1e6).toFixed(1)} MB`, status: !supported || file.size === 0 ? 'failed' : 'uploading', progress: 0 };
    });
  },
  advance(asset, elapsed) {
    if (asset.status === 'ready' || asset.status === 'failed' || asset.status === 'downloading') return asset;
    const progress = Math.min(100, asset.progress + elapsed * (asset.status === 'uploading' ? 16 : 44));
    if (progress < 100) return { ...asset, progress };
    const status = stages[stages.indexOf(asset.status) + 1] ?? 'ready';
    return { ...asset, status, progress: status === 'ready' ? 100 : 0 };
  },
};

export const collaborationService: CollaborationService = {
  createOperation(operation) { return { ...operation, id: createId('operation'), timestamp: Date.now() }; },
  advancePresence(presence, now, duration) {
    return presence.map((person, index) => person.online ? { ...person, cursor: { x: 42 + index * 13 + Math.sin(now / 4_000 + index * 2) * 10, y: 27 + index * 17 + Math.cos(now / 5_500 + index) * 10 }, playhead: Math.max(0, Math.min(duration, [73, 28, 114][index % 3] + Math.sin(now / 17_000 + index) * 7)), updatedAt: now } : person);
  },
  expireLocks(locks, now) { return locks.some(lock => lock.expiresAt <= now) ? locks.filter(lock => lock.expiresAt > now) : locks; },
};

export const renderService: RenderService = {
  enqueue(projectId, name, preset, settings, busy) {
    return { id: createId('render'), projectId, name: name.trim().slice(0, 160) || 'Untitled export', preset, settings, status: busy ? 'waiting' : 'rendering', progress: 0, remaining: busy ? 'Waiting' : '1:20 remaining' };
  },
  advance(job, elapsed) {
    if (job.status !== 'rendering') return job;
    const progress = Math.min(100, job.progress + elapsed * 1.25);
    const seconds = Math.ceil((100 - progress) / 1.25);
    return { ...job, progress, status: progress === 100 ? 'complete' : 'rendering', remaining: progress === 100 ? 'Complete' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining` };
  },
};

export const colorService: ColorService = {
  async generateGrade(prompt): Promise<GradeProposal> {
    const cool = /cool|blue|cold/i.test(prompt);
    const neutral = /neutral|balance/i.test(prompt);
    const monochrome = /black.*white|monochrome/i.test(prompt);
    return {
      nodes: [{ name: 'Balance', parameters: { temperature: neutral ? 0 : cool ? -350 : 350, tint: 0, exposure: 0 } }, { name: 'Contrast', parameters: { contrast: neutral ? 1 : 1.12, pivot: 0.5, saturation: monochrome ? 0 : 100 } }],
      explanation: 'This is a rule-based SDR preset, not an AI analysis of your footage. It adjusts temperature and contrast from your description. It does not detect skin, match shots, decode camera log, or apply a display transform. Review the result and adjust each node.',
    };
  },
  createNode(name, projectId, clipId, parameters = { exposure: 0, contrast: 1, saturation: 100 }) {
    return { id: createId('node'), projectId, clipId, name: name.trim().slice(0, 80) || 'Correction', kind: name.toLowerCase().replaceAll(' ', '-'), enabled: true, parameters };
  },
};

export const authenticationService: AuthenticationService = {
  async signIn(email, name) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('Enter a valid email address.');
    const displayName = name?.trim() || email.split('@')[0];
    return { id: createId('user'), name: displayName, email: email.trim(), initials: displayName.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase(), color: '#F06A70' };
  },
  updateProfile(user, profile) {
    const name = profile.name.trim().slice(0, 80);
    const email = profile.email.trim().slice(0, 254);
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Add a name and a valid email address.');
    return { ...user, name, email, initials: name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() };
  },
};
