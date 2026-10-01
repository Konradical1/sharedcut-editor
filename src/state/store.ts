import { createSmartMask, validateSmartMask, smartMaskSignature, type SmartMaskDocument } from '../services/smartMask.ts';
import { createMotionTracker, MAX_TRACKERS, validateMotionTracker, type MotionTracker, type MotionTrackerLink } from '../services/motionTracker.ts';
import { starterGrade, primaryDefaults, interpretation, validateGradeNode, acesOutputUpgrade } from '../services/color.ts';
import { eligibility, proposedNodes, type AssistantMode, type BalanceValues, type LookOption, type ShotNote } from '../services/colorAssistant.ts';
import { captionDocument, captionPreset, groupCaptionWords, isCaption, restyleCaption, validateCaption, type CaptionJob, type CaptionSet, type CaptionWord } from '../services/captions.ts';
import { isComposition, retimeTitleClip, validateCompositions } from '../services/compositions.ts';
import { defaultShape, getShape, isShape, validateShape, type ShapeDocument } from '../services/shapes.ts';
import { createTitleTemplate } from '../services/titleTemplates.ts';
import { animationProperties, boundedAnimationValue, copyAnimatedNodes, evaluateClip, evaluateNodes, frameTime, retimedDuration, setAnimatedValue, trimAnimation, validateKeyframes } from '../services/animation.ts';
import type { Keyframe, KeyframeValue } from './models.ts';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Clip, CollaborativeLock, Comment, GradeNode, MediaAsset, Notification, Operation, OperationType, Presence, Project, ProjectState, RenderJob, Settings, Snapshot, Timeline, Track, User, Workspace } from './models.ts';
import { createDemoProject, defaultProperties, projects, users } from './demo.ts';
import { authenticationService, collaborationService, colorService, createId, LOCK_TTL, lockConflict, mediaService, projectService, renderService } from '../services/index.ts';
import type { PersistedState } from '../services/index.ts';
import { acceptsEffect, effectDefinitions } from '../services/effects.ts';
import { transitionPresetId, type TransitionPreset, timelineTransitions, trimLeak, leakRange, bestAlign, defaultTransition, leakAudioTrack, leakMediaId, maximumDuration, neighbourAt, transitionAlign, transitionCurve, transitionDefinitions, transitionDuration, transitionFields, transitionName, transitionParams, transitionProperty, type TransitionAlign, type TransitionParams, type TransitionSide } from '../services/transitions.ts';
import { advancePlayhead, playheadMotion, type PlayheadMotion } from '../services/presence.ts';
import { companionAudioTrack, trackGap, trimRoom, uncoveredParts } from '../services/timeline.ts';
import { getText, isTitle, remapTextRuns, presetDocument, styleText, validateText, type TextDocument, type TextStyle, type TextRange } from '../services/text.ts';
import { api, connection } from '../services/api.ts';
import { enqueueUploads } from '../services/upload.ts';
import { forwardSelection } from '../services/selection.ts';

type Collection = 'clips' | 'tracks' | 'nodes' | 'comments' | 'timelines';
type Change = { collection: Collection; id: string; value: Record<string, unknown> | null; replace?: boolean; unset?: string[] };
type SidePanel = 'inspector' | 'people' | 'history' | 'comments' | null;
type LiveMode = 'independent' | 'following' | 'presenting';

export interface EditorStore extends PersistedState {
  session: 'loading' | 'signedOut' | 'ready' | 'error'; serverOnline: boolean; syncConflict: string[]; cursor: Presence['cursor'];
  dragPreview: import('./models.ts').DragPreview | null;
  mediaPresenceTab?: string; inspectorPresenceTab?: string; notifications: Notification[]; presence: Presence[]; locks: CollaborativeLock[];
  projectId: string; timelineId: string; selectedClipId: string | null; selectedNodeId: string | null; revealedMediaId: string | null;
  /** Which transition the Inspector is editing, and the shared overlay pack served by the API. */
  selectedTransition: { clipId: string; side: TransitionSide } | null;
  /** What is being dragged out of the Transitions library, so the timeline can preview its shape. */
  draggingTransition: { name: string; params: TransitionParams } | null;
  leaks: { id: string; name: string; url: string; posterUrl?: string; duration: number; fps: number; hasAudio: boolean; peakAt?: number }[];
  selectTransition(clipId: string, side: TransitionSide): void;
  transitionPresets: TransitionPreset[];
  transitionFavorites: string[];
  saveTransitionPreset(clipId: string, side: TransitionSide): Promise<void>;
  toggleTransitionFavorite(id: string): Promise<void>;
  loadLeaks(): void;
  addLeak(file: File): Promise<void>;
  playhead: number; rangeIn: number; rangeOut: number; playing: boolean; playbackBuffering: boolean; workspace: Workspace; sidePanel: SidePanel; modal: string | null;
  saveStatus: 'Saving…' | 'Saved' | 'Save failed'; liveMode: LiveMode; followUserId: string | null;
  clipboard: Clip | null; clipboardClips: Clip[]; clipboardNodes: GradeNode[]; clipPreview: Clip | null; draggingMediaId: string | null; inspectorTab: string;
  shapeTool: string | null; compositionTrail: {timelineId:string;playhead:number;clipId:string}[]; selectedClipIds: string[];
  addShape(kind:string,box?:Partial<ShapeDocument>,placement?:{start:number;trackId:string}):void;
  updateShape(id:string,doc:ShapeDocument,gesture?:string):void;
  editShapePoint(id:string,index:number,action:'delete'|'corner'):void;
  selectClips(ids:string[]):void; createComposition(name?:string):void; openComposition(id:string):void; leaveComposition(index?:number):void;
  setAnimationChannels(id:string,channels:NonNullable<Clip['keyframes']>,gesture?:string):void;
  /** Select Forward: the clip (or the point in time) and everything after it on unlocked tracks of this timeline; the clicked clip is the primary. */
  selectForward(from:{clipId:string}|{time:number}):void;
  /** Split every clip that runs across `time` on an unlocked track, as one undo step; the right halves join the selection. Returns how many were cut. */
  cutThrough(time:number):number;
  textTool: boolean; selectedTextIds: string[]; textSelection: TextRange | null; textPreview: Clip[];
  installCaptions(job:CaptionJob,wordsPerLine:number,preset:string,replaceSet?:string):void;
  regroupCaptions(setId:string,wordsPerLine:number):void;
  styleCaptions(setId:string,preset:string):void;
  updateCaption(id:string,words:CaptionWord[]):void;
  addTitle(preset?: number, box?: Partial<TextDocument>, placement?: {start:number;trackId:string}, animated?:boolean): void;
  selectText(id: string, additive?: boolean): void;
  updateText(documents: { id: string; doc: TextDocument }[], gesture?: string): void;
  formatText(patch: Partial<TextStyle>, preview?: boolean): void;
  openProject(id: string): void;
  createProject(input: { name: string; description: string; shared: boolean }): string;
  setTimelineFormat(width: number, height: number, fps: number): boolean;
  setWorkspace(workspace: Workspace): void; selectClip(id: string | null, additive?:boolean): void; selectNode(id: string | null): void;
  setPlayhead(time: number): void; setRange(inTime: number, outTime: number): void; setPlaying(playing: boolean): void; setSidePanel(panel: SidePanel): void; setModal(modal: string | null): void;
  updateProperty(clipId: string, key: string, value: number | string | boolean, gesture?: string): void;
  setKeyframes(clipId: string, path: string, keys: Keyframe[], gesture?: string): void;
  keyframeProperty(clipId: string, path: string, value?: KeyframeValue): void;
  unlinkClip(id: string): void; linkClip(id: string): void;
  moveClip(id: string, start: number, trackId?: string): void; trimClip(id: string, start: number, duration: number): void; fitTrim(id: string, start: number, duration: number): {start:number;duration:number}|null;
  deleteGap(trackId:string,start:number,end:number):void; splitClip(id: string): void; deleteClip(id: string): void; duplicateClip(id: string): void; copyClip(id: string): void; pasteClip(): void;
  addMediaToTimeline(mediaId: string | string[], start?: number, trackId?: string): void; updateTrack(id: string, patch: Partial<Track>, gesture?: string): void; moveTrack(id: string, direction: 'up' | 'down'): void; deleteTrack(id: string): void; createTrack(kind: 'video' | 'audio'): void; setTimeline(id: string): void;
  addTransition(clipId: string, side: TransitionSide, name: string, patch?: { duration?: number; align?: TransitionAlign; params?: TransitionParams }): void;
  updateTransition(clipId: string, side: TransitionSide, patch: { name?: string; duration?: number; align?: TransitionAlign; curve?: [number, number, number, number]; params?: TransitionParams }, gesture?: string): void;
  removeTransition(clipId: string, side: TransitionSide): void;
  expandTransitionAudio(clipId: string, side: TransitionSide): void;
  applyTransitionAtPlayhead(name?: string, params?: TransitionParams): void;
  addSmartMask(clipId:string,nodeId?:string):void;
  updateSmartMask(clipId:string,maskId:string,patch:Partial<SmartMaskDocument>,gesture?:string):void;
  attachSmartMask(clipId:string,maskId:string,targetId:string):void;
  addMotionTracker(clipId:string,at?:{x:number;y:number;time:number}):string|undefined;
  updateMotionTracker(clipId:string,trackerId:string,patch:Partial<MotionTracker>,gesture?:string):void;
  deleteMotionTracker(clipId:string,trackerId:string):void;
  /** Write keyframes a track produced onto `targetId` and record the link, as one undoable edit. */
  applyMotionTracker(clipId:string,trackerId:string,targetId:string,channels:Record<string,Keyframe[]>,link:MotionTrackerLink):boolean;
  addEffect(clipId: string, name: string): void; updateEffect(clipId: string, effectId: string, patch: { enabled?: boolean; amount?: number; parameters?: Record<string, number> } | null, gesture?: string): void; reorderEffect(clipId: string, effectId: string, direction: number): void; addNode(name: string, parameters?: Record<string, number>): void;
  removeNode(id: string): void; reorderNode(id: string, direction: number): void;
  gradeClipboard: {clip:Clip;nodes:GradeNode[]} | null; copyGrade(clipId:string):void; pasteGrade(clipId:string):void;
  /** Color Assistant proposal as normal node values on every eligible shot: one snapshot, one undo. Returns the number of shots changed. */
  applyColorAssistant(result:{mode:AssistantMode;looks?:LookOption[];shots?:(ShotNote&{balance:BalanceValues})[]},option?:number,clipIds?:string[]):number;
  useAcesOutput(clipId:string):void;
  restoreResolveGrade(clipId:string):void; initializeColorGrade(clipId:string):void; arrangeColorNodes(clipId:string):void; moveColorNode(id:string,beforeId:string|null,position?:{x:number;y:number}):void;
  updateNode(id: string, patch: Partial<GradeNode>, gesture?: string): void; applyGrade(nodes: { name: string; parameters: Record<string, number> }[]): void;
  undo(): void; saveSnapshot(name: string, note: string): void; restoreSnapshot(id: string): void;
  addComment(text: string, target?: { clipId?: string; range?: [number, number] }): void;
  replyComment(id: string, text: string): void; resolveComment(id: string): void;
  enqueueRender(name: string, preset: string, settings: Record<string, string>): void; updateRender(id: string, patch: Partial<RenderJob>): void;
  uploadMedia(files: File[]): void; renameMedia(id: string, name: string): void; removeMedia(id: string): void; retryMedia(id: string): void; revealMedia(id: string | null): void;
  setUserColor(color: string): void; setUserProfile(profile: { name: string; email: string }): void; setCurrentUser(id: string): void;
  setSettings(patch: Partial<Settings>): void; notify(title: string, kind?: Notification['kind'], detail?: string): void; dismissNotification(id: string): void;
  acquireLock(targetId: string, field: string): boolean; renewLock(targetId: string, field: string): boolean; releaseLock(targetId: string, field: string): void; releaseUserLocks(userId: string): void;
  /** All-or-nothing lock on many items in one set() and one request (a multi-clip drag, also its renewal); false and nothing taken when any is held by someone else. */
  acquireLocks(targetIds: string[], field: string): boolean; releaseLocks(targetIds: string[], field: string): void;
  tick(now: number): void; setLiveMode(mode: LiveMode, userId?: string): void;
}

const demo = createDemoProject();
const initial: PersistedState = {
  projects, users, media: demo.media, timelines: demo.timelines, clips: demo.clips, tracks: demo.tracks,
  nodes: demo.nodes, comments: demo.comments, operations: demo.operations, snapshots: demo.snapshots,
  renderJobs: [
    { id: 'render-demo-1', projectId: 'city-after-dark', name: 'City After Dark · Review', preset: 'YouTube', status: 'rendering', progress: 64, remaining: '0:29 remaining', settings: { resolution: '1920 × 1080', codec: 'H.264', fps: '24', audio: 'AAC · 320 kbps' } },
    { id: 'render-demo-2', projectId: 'city-after-dark', name: 'Class screening', preset: 'Quick Export', status: 'waiting', progress: 0, remaining: 'Waiting', settings: { resolution: '1920 × 1080', codec: 'H.264' } },
    { id: 'render-demo-3', projectId: 'city-after-dark', name: 'City After Dark · Teaser', preset: 'Quick Export', status: 'complete', progress: 100, remaining: 'Complete', settings: { resolution: '1920 × 1080', codec: 'H.264' } },
  ],
  currentUserId: 'kyle', settings: { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false, snapping: true, mediaWidth: 278, inspectorWidth: 292, timelineHeight: 294 },
};
let recoveryMessage = '';
let saved: PersistedState | null = null;
try { saved = projectService.load(); } catch (error) { recoveryMessage = error instanceof Error ? error.message : 'The local project cache could not be read.'; }

const record = (value: object): Record<string, unknown> => structuredClone(value) as Record<string, unknown>;
const readField = (value: object, key: string): unknown => key.split('.').reduce<unknown>((item, part) => (item as Record<string, unknown> | undefined)?.[part], value);
const patchRecord = (value: object, patch: Record<string, unknown>, unset: string[] = []) => {
  const result = record(value);
  for (const [key, next] of Object.entries(patch)) {
    const parts = key.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = structuredClone(next);
  }
  for (const key of unset) {
    const parts = key.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    delete target[parts.at(-1)!];
  }
  return result;
};
const entity = (state: ProjectState, change: Change) => (state[change.collection] ?? []).find(item => item.id === change.id);
function applyChanges(state: ProjectState, changes: Change[]): ProjectState & {timelines:Timeline[]} {
  const next = { timelines: state.timelines ?? [], clips: state.clips, tracks: state.tracks, nodes: state.nodes, comments: state.comments };
  for (const change of changes) {
    const collection = next[change.collection] as unknown as Record<string, unknown>[];
    const index = collection.findIndex(item => item.id === change.id);
    const items = [...collection];
    if (change.value === null) { if (index >= 0) items.splice(index, 1); }
    else if (change.replace) {
      if (index < 0) {
        const output = change.collection === 'nodes' && change.value.name !== 'Output Trim' ? items.findIndex(item => item.clipId === change.value!.clipId && item.name === 'Output Trim') : -1;
        items.splice(output < 0 ? items.length : output, 0, structuredClone(change.value));
      } else items[index] = structuredClone(change.value);
    }
    else if (index >= 0) items[index] = patchRecord(items[index], change.value, change.unset);
    Object.assign(next, { [change.collection]: items });
  }
  return next;
}
const overlap = (a: Change, b: Change) => a.collection === b.collection && a.id === b.id && (a.replace || b.replace || [...Object.keys(a.value ?? {}), ...a.unset ?? []].some(key => [...Object.keys(b.value ?? {}), ...b.unset ?? []].some(other => key === other || key.startsWith(`${other}.`) || other.startsWith(`${key}.`))));
const projectState = (state: EditorStore): ProjectState => ({ timelines: state.timelines.filter(t=>t.projectId===state.projectId), clips: state.clips.filter(item => item.projectId === state.projectId), tracks: state.tracks.filter(item => state.timelines.some(t => t.id === item.timelineId && t.projectId === state.projectId)), nodes: state.nodes.filter(item => item.projectId === state.projectId), comments: state.comments.filter(item => item.projectId === state.projectId) });
const durationOf = (state: EditorStore) => state.timelines.find(t => t.id === state.timelineId)?.duration ?? 180;
// Where playback stops: the end of the last clip on a server timeline. Remembered per clip list: the clock asks every tick.
let endClips: Clip[] | null = null, endTimeline = '', endTime = 0;
const playbackEndOf = (state: EditorStore) => {
  if (!connection.enabled) return durationOf(state);
  if (state.clips !== endClips || state.timelineId !== endTimeline) { endClips = state.clips; endTimeline = state.timelineId; endTime = Math.max(0, ...state.clips.filter(c => c.timelineId === state.timelineId).map(c => c.start + c.duration)); }
  return endTime;
};
// In/Out is kept per timeline for this viewer. Held only in memory, any reload (a server restart reconnects the
// page) turned "In / Out range" into 0 → timeline length, and a 180 s timeline holding 45 s of edit exported 3 min.
const rangeKey = (timelineId: string) => `sharedcut-range-${timelineId}`;
const initialRange = (state: Pick<EditorStore, 'timelines' | 'clips'>, timelineId: string) => {
  const duration = state.timelines.find(t => t.id === timelineId)?.duration ?? 180;
  const content = Math.max(0, ...state.clips.filter(c => c.timelineId === timelineId).map(c => c.start + c.duration));
  try {
    const saved = JSON.parse(localStorage.getItem(rangeKey(timelineId)) || 'null');
    if (Array.isArray(saved) && saved.every(Number.isFinite) && saved[0] >= 0 && saved[0] < saved[1] && saved[1] <= duration) return { rangeIn: saved[0] as number, rangeOut: saved[1] as number };
  } catch { /* Storage can be missing or blocked; the edit's own length is the fallback. */ }
  return { rangeIn: 0, rangeOut: content > 0 ? Math.min(content, duration) : duration };
};
const updatedProjects = (state: EditorStore, clips: Clip[]) => {
  const primaryTimelineId = state.timelines.find(timeline => timeline.projectId === state.projectId)?.id;
  const duration = Math.max(0, ...clips.filter(clip => clip.timelineId === primaryTimelineId).map(clip => clip.start + clip.duration));
  return state.projects.map(project => project.id === state.projectId ? { ...project, duration, modifiedAt: Date.now() } : project);
};
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// Below THUMBNAIL_HEIGHT a lane is too short to read a filmstrip or waveform, so they are hidden.
export const TRACK_MIN_HEIGHT = 24, TRACK_MAX_HEIGHT = 200, TRACK_THUMBNAIL_HEIGHT = 34;
const sealedHistory = new Set<string>();
export function sealHistory(operations: Operation[]) { operations.forEach(operation => sealedHistory.add(operation.id)); }
let followedMotion: PlayheadMotion | null = null;
let followedUser: string | null = null;
let lastTick = Date.now();
let lastProcessingTick = Date.now();
// The playing clock (tick): its exact time, the playhead it last gave the store, and whether it was running then.
let clockTime = 0, clockPublished = NaN, clockRunning = false;

// The server takes up to 2000 ids per lock request; a bigger drag goes out in slices.
const lockRequest = (method: 'POST' | 'DELETE', projectId: string, ids: string[], field: string) => Promise.all(Array.from({ length: Math.ceil(ids.length / 2000) }, (_, i) => api('/locks', { method, body: JSON.stringify({ projectId, targetIds: ids.slice(i * 2000, (i + 1) * 2000), field }) })));
export const useEditorStore = create<EditorStore>((set, get) => {
  const writable = (comment = false) => {
    const state = get();
    const role = state.projects.find(p => p.id === state.projectId)?.members.find(member => member.userId === state.currentUserId)?.role;
    if (role === 'Owner' || role === 'Editor' || (comment && role === 'Commenter')) return true;
    state.notify(comment ? 'This project is read-only' : 'Editing requires an editor role', 'info');
    return false;
  };
  const available = (targetId: string, field: string) => {
    const state = get();
    const lock = state.locks.find(lock => lock.projectId === state.projectId && lock.targetId === targetId && lock.userId !== state.currentUserId && lock.expiresAt > Date.now() && lockConflict(lock.field, field));
    if (lock) { state.notify(`${state.users.find(user => user.id === lock.userId)?.name ?? 'Someone'} is editing this control`, 'info'); return false; }
    return true;
  };
  const editableClip = (id: string, field = 'manipulation') => {
    const state = get();
    const clip = state.clips.find(item => item.id === id && item.projectId === state.projectId);
    if (!clip || !writable() || !available(id, field)) return undefined;
    if (state.tracks.find(track => track.id === clip.trackId)?.locked) { state.notify('Unlock the track to edit this clip', 'info'); return undefined; }
    return clip;
  };
  const linkedClips=(clip:Clip)=>get().settings.linkSelection!==false&&clip.properties.linkGroup?get().clips.filter(c=>c.projectId===clip.projectId&&c.timelineId===clip.timelineId&&c.properties.linkGroup===clip.properties.linkGroup):[clip];
  const editableGroup=(clip:Clip,field='manipulation')=>{const group=linkedClips(clip);return group.every(c=>editableClip(c.id,field))?group:null;};
  let lastGesture: { token: string; operationId: string } | undefined;
  const commit = (type: OperationType, targetId: string, description: string, changes: Change[], gesture?: string) => {
    const state = get();
    // Deleting an entity must retain its whole record so undo can recreate it.
    changes=changes.map(change=>change.value===null?{...change,replace:true}:change);
    // Keep set registration and its last line in the same undoable edit, including overwrites.
    if(changes.some(c=>c.collection==='clips'&&c.value===null)) {
      const next=applyChanges(state,changes),live=new Set(next.clips.map(c=>c.properties.captionSet));
      for(const track of next.tracks)if(state.timelines.some(t=>t.id===track.timelineId&&t.projectId===state.projectId)&&track.captionSets?.some(meta=>!live.has(meta.id))){
        const captionSets=track.captionSets.filter(meta=>live.has(meta.id)),change=[...changes].reverse().find(c=>c.collection==='tracks'&&c.id===track.id);
        if(change)change.value={...change.value,captionSets};else changes.push({collection:'tracks',id:track.id,value:{captionSets}});
      }
    }
    const oldState: Change[] = changes.map(change => {
      const old = entity(state, change);
      const keys = [...new Set([...Object.keys(change.value ?? {}), ...change.unset ?? []])];
      const absent = old && !change.replace ? keys.filter(key => readField(old, key) === undefined) : [];
      return { ...change, value: old ? change.replace ? record(old) : Object.fromEntries(keys.filter(key => !absent.includes(key)).map(key => [key, structuredClone(readField(old, key))])) : null, unset: absent };
    });
    if (JSON.stringify(oldState) === JSON.stringify(changes)) return;
    const operation = collaborationService.createOperation({ projectId: state.projectId, userId: state.currentUserId, type, targetId, description, oldState, newState: changes, ...(gesture ? { gestureId: gesture } : {}) });
    const previous = state.operations[0];
    const coalesce = gesture && !sealedHistory.has(previous?.id) && lastGesture?.token === gesture && lastGesture.operationId === previous?.id && !previous.undone && previous.userId === state.currentUserId && previous.targetId === targetId && JSON.stringify((previous.newState as Change[]).map(c=>Object.keys(c.value??{}))) === JSON.stringify(changes.map(c=>Object.keys(c.value??{})));
    if (coalesce) { operation.id = previous.id; operation.oldState = previous.oldState; }
    lastGesture = gesture ? { token: gesture, operationId: operation.id } : undefined;
    const next = applyChanges(state, changes);
    set({ ...next, operations: [operation, ...state.operations.slice(coalesce ? 1 : 0)], projects: updatedProjects(state, next.clips), ...(connection.enabled ? { timelines: next.timelines.map(t => ({ ...t, duration: Math.max(t.composition ? t.duration : 180, ...next.clips.filter(c => c.timelineId === t.id).map(c => c.start + c.duration)) })) } : {}) });
  };
  // A placement that lands on a neighbour's edge through float arithmetic can overlap it by 1e-14: not an overlap, so it must not trim.
  const overwriteChanges = (placed: Clip, excluded: string[] = [], placements:Clip[]=[placed]): Change[] | null => {
    const state = get();
    const covered = state.clips.filter(clip => !excluded.includes(clip.id) && clip.id !== placed.id && placements.some(p=>clip.trackId===p.trackId&&clip.timelineId===p.timelineId&&clip.start<p.start+p.duration-1e-6&&clip.start+clip.duration>p.start+1e-6));
    if (covered.some(clip => !editableClip(clip.id, '*') || state.nodes.some(node => node.clipId === clip.id && !available(node.id, '*')))) return null;
    return covered.flatMap(clip => {
      const parts=placements.filter(p=>p.trackId===clip.trackId&&p.timelineId===clip.timelineId).sort((a,b)=>a.start-b.start).reduce<Clip[]>((parts,p)=>parts.flatMap(part=>uncoveredParts(part,p.start,p.start+p.duration)),[clip]);
      const changes: Change[] = [{ collection: 'clips', id: clip.id, value: parts[0] ? { start: parts[0].start, duration: parts[0].duration, sourceIn: parts[0].sourceIn,properties:parts[0].properties,keyframes:parts[0].keyframes } : null, ...(!parts.length ? { replace: true } : {}) }];
      if (!parts.length) {
        changes.push(...state.nodes.filter(node => node.clipId === clip.id).map(node => ({ collection: 'nodes' as const, id: node.id, value: null, replace: true })));
        changes.push(...state.comments.filter(comment => comment.clipId === clip.id).map(comment => ({ collection: 'comments' as const, id: comment.id, value: {}, unset: ['clipId'] })));
      }
      for (const part of parts.slice(1)) {
        const right = { ...part, id: createId('clip'), properties: { ...part.properties, ...(clip.properties.linkGroup ? {linkGroup: String(clip.properties.linkGroup)+'-at-'+part.start} : {}) } };
        const nodes=copyAnimatedNodes(right,state.nodes.filter(n=>n.clipId===clip.id),()=>createId('node'));
        changes.push({ collection: 'clips', id: right.id, value: record(right), replace: true });
        changes.push(...nodes.map(copy=>({collection:'nodes' as const,id:copy.id,value:record(copy),replace:true})));
        changes.push(...state.comments.filter(comment => comment.clipId === clip.id && comment.time >= right.start && comment.time < right.start+right.duration).map(comment => ({ collection: 'comments' as const, id: comment.id, value: { clipId: right.id } })));
      }
      return changes;
    });
  };
  // One clip cut at `at`: the left piece shortens in place, the right piece is new. Its source offset honours speed, reverse and freeze;
  // keyframes, grade nodes and the comments from the cut on go with it. Shared by the playhead split and Select Forward's cut.
  const cutClip = (c:Clip, at:number, linkGroup?:string) => {
    const state=get(),offset=at-c.start,speed=Number(c.properties.speed||100),right:Clip={...structuredClone(c),id:createId('clip'),start:at,duration:c.duration-offset,sourceIn:c.properties.freeze||c.properties.reverse?c.sourceIn:c.sourceIn+offset*speed/100,...trimAnimation(c,at,c.duration-offset)};
    if(linkGroup)right.properties.linkGroup=linkGroup;else delete right.properties.linkGroup;
    const nodes=copyAnimatedNodes(right,state.nodes.filter(n=>n.clipId===c.id),()=>createId('node'));
    const changes:Change[]=[{collection:'clips',id:c.id,value:{duration:offset,...(c.properties.reverse?{sourceIn:c.sourceIn+(c.duration-offset)*speed/100}:{}),...trimAnimation(c,c.start,offset)}},{collection:'clips',id:right.id,value:record(right),replace:true}];
    changes.push(...nodes.map(copy=>({collection:'nodes' as const,id:copy.id,value:record(copy),replace:true})));
    changes.push(...state.comments.filter(m=>m.clipId===c.id&&m.time>=at).map(m=>({collection:'comments' as const,id:m.id,value:{clipId:right.id}})));
    return {right,changes};
  };
  const cloneContents = (clip:Clip, changes:Change[], ancestors=new Set<string>()) => {
    if(!isComposition(clip))return;
    const state=get(),oldId=String(clip.properties.compositionId),timeline=state.timelines.find(t=>t.id===oldId);
    if(!timeline||ancestors.has(oldId)||ancestors.size>=16)throw new Error('Invalid composition.');
    const id=createId('composition'),trail=new Set([...ancestors,oldId]);
    changes.push({collection:'timelines',id,value:record({...timeline,id}),replace:true});
    const tracks=new Map<string,string>(),links=new Map<string,string>();
    for(const track of state.tracks.filter(t=>t.timelineId===oldId)) {const next={...track,id:createId('track'),timelineId:id};tracks.set(track.id,next.id);changes.push({collection:'tracks',id:next.id,value:record(next),replace:true});}
    for(const child of state.clips.filter(c=>c.timelineId===oldId)) {
      const next={...structuredClone(child),id:createId('clip'),timelineId:id,trackId:tracks.get(child.trackId)!};
      if(next.properties.linkGroup){const old=String(next.properties.linkGroup);if(!links.has(old))links.set(old,createId('link'));next.properties.linkGroup=links.get(old)!;}
      cloneContents(next,changes,trail);
      const nodes=copyAnimatedNodes(next,state.nodes.filter(n=>n.clipId===child.id),()=>createId('node'));
      changes.push({collection:'clips',id:next.id,value:record(next),replace:true},...nodes.map(n=>({collection:'nodes' as const,id:n.id,value:record(n),replace:true})));
    }
    clip.properties.compositionId=id;
  };
  // One clamp for every trim, so the drag preview stops the clip where the commit would put it
  // instead of letting it stretch past its source or its neighbour and snap back on release.
  const trimmedClip = (c:Clip,s:number,d:number,group:Clip[]) => {
    const state=get(),media=state.media.find(a=>a.id===c.mediaId),rate=Number(c.properties.speed||100)/100;
    const frame=1/(state.projects.find(p=>p.id===state.projectId)?.fps||24);
    const {floor,ceiling}=trimRoom(c,state.clips,group.map(g=>g.id));
    const nextStart=Math.max(Math.max(0,c.start-c.sourceIn/rate),floor,s);
    const sourceIn=c.properties.freeze?c.sourceIn:c.properties.reverse?Math.max(0,c.sourceIn+(c.duration-(nextStart-c.start)-d)*rate):Math.max(0,c.sourceIn+(nextStart-c.start)*rate);
    const max=Math.min(ceiling-nextStart,connection.enabled?Infinity:durationOf(state)-nextStart,media?.kind==='image'||c.properties.freeze?Infinity:((isComposition(c)?state.timelines.find(t=>t.id===c.properties.compositionId)?.duration??0:media?.duration??Infinity)-sourceIn)/rate);
    return max<=0?null:{start:nextStart,duration:clamp(d,frame,max),sourceIn,...trimAnimation(c,nextStart,clamp(d,frame,max))};
  };
  // The shortest handle in a linked group governs the whole group. Each pass only tightens, and a
  // tighter start tightens the duration in turn, so two passes settle it.
  // ponytail: two passes, run it to a fixed point if groups ever grow past video+audio pairs.
  const trimFit = (clip:Clip,start:number,duration:number) => {
    const state=get(),group=linkedClips(clip),frame=1/(state.projects.find(p=>p.id===state.projectId)?.fps||24);
    // A title has no source to run out of, so it resizes on whole frames and only the neighbour and
    // the timeline start bound it. Same branch as the commit takes, so the preview agrees.
    if(clip.sourceIn===0&&Number(clip.properties.animationPresetDuration)===clip.duration) {
      const {floor,ceiling}=trimRoom(clip,state.clips,group.map(g=>g.id));
      const next=Math.max(floor,Math.round(start/frame)*frame);
      return {start:next,duration:Math.max(frame,Math.min(ceiling-next,Math.round(duration/frame)*frame))};
    }
    let fit={start,duration};
    for(const c of [...group,...group]) {
      const next=trimmedClip(c,c.start+fit.start-clip.start,c.duration+fit.duration-clip.duration,group);
      if(!next)return null;
      fit={start:clip.start+next.start-c.start,duration:clip.duration+next.duration-c.duration};
    }
    return fit;
  };
  const selectedGroup = (clip:Clip,field='manipulation') => {
    const state=get(),selected=state.selectedClipIds.includes(clip.id)?state.clips.filter(c=>state.selectedClipIds.includes(c.id)&&c.timelineId===clip.timelineId):[clip];
    const group=[...new Map(selected.flatMap(linkedClips).map(c=>[c.id,c])).values()];
    return group.every(c=>editableClip(c.id,field))?group:null;
  };
  const insertClip = (source: Clip, start: number, name = source.name, copied = false, gesture?: string) => {
    const state = get();
    if (!writable()) return;
    const targetTrack = state.tracks.find(track => track.id === source.trackId && track.timelineId === state.timelineId) ?? state.tracks.find(track => track.timelineId === state.timelineId && track.kind === (state.media.find(m => m.id === source.mediaId)?.kind === 'audio' ? 'audio' : 'video') && !track.locked);
    if(targetTrack&&Boolean(targetTrack.captionSets)!==isCaption(source)){state.notify('Use the Captions track for caption lines only','info');return;}
    if (!targetTrack || targetTrack.locked) { state.notify('Choose an unlocked track first', 'info'); return; }
    const duration = connection.enabled ? source.duration : Math.min(source.duration, durationOf(state));
    const clip: Clip = { ...structuredClone(source), id: createId('clip'), projectId: state.projectId, timelineId: state.timelineId, trackId: targetTrack.id, start: connection.enabled ? Math.max(0, start) : clamp(start, 0, durationOf(state) - duration), duration, name };
    const changes:Change[]=[],group=[clip],link=createId('link'),sourceGroup=copied?state.clipboardClips:[source,...(selectedGroup(source)??[]).filter(c=>c.id!==source.id)];
    delete clip.properties.linkGroup;
    const asset=state.media.find(m=>m.id===source.mediaId);
    if(!source.id&&asset?.kind==='video'&&asset.hasAudio){
      const audioTrack=companionAudioTrack(state.tracks,targetTrack);
      if(audioTrack.id==='pending-audio'){audioTrack.id=createId('track');changes.push({collection:'tracks',id:audioTrack.id,value:record(audioTrack),replace:true});}
      clip.properties.audioDetached=true;
      group.push({...structuredClone(clip),id:createId('clip'),trackId:audioTrack.id,color:'#427A68',properties:{...defaultProperties},effects:[]});
    }else for(const peer of sourceGroup.filter(c=>c.id!==source.id)){
      if(copied ? !state.tracks.some(t=>t.id===peer.trackId&&!t.locked) : !editableClip(peer.id))return;
      const original=state.tracks.find(t=>t.id===peer.trackId);if(!original)return;const target=original.timelineId===state.timelineId?original:state.tracks.find(t=>t.timelineId===state.timelineId&&t.kind===original.kind&&t.number===original.number&&!t.locked);if(!target)return;group.push({...structuredClone(peer),id:createId('clip'),timelineId:state.timelineId,trackId:target.id,start:Math.max(0,clip.start+peer.start-source.start)});
    }
    if(!source.id&&group.length>1)for(const c of group)c.properties.linkGroup=link;
    else {const links=new Map<string,string>();for(let i=0;i<group.length;i++){const old=sourceGroup[i]?.properties.linkGroup;delete group[i].properties.linkGroup;if(old){if(!links.has(String(old)))links.set(String(old),createId('link'));group[i].properties.linkGroup=links.get(String(old))!;}}}
    const nodes=group.flatMap((c,i)=>copyAnimatedNodes(c,(copied?state.clipboardNodes:state.nodes).filter(n=>n.clipId===sourceGroup[i]?.id),()=>createId('node')));
    const overwritten=overwriteChanges(group[0],group.map(c=>c.id),group);if(!overwritten)return;changes.push(...overwritten);
    for(const placed of group){cloneContents(placed,changes);changes.push({collection:'clips',id:placed.id,value:record(placed),replace:true});}
    commit('ClipAdded',clip.id,`added ${name}`, [...changes,...nodes.map(node=>({collection:'nodes' as const,id:node.id,value:record(node),replace:true}))],gesture);
    set({ selectedClipId: clip.id, selectedClipIds:group.map(c=>c.id), selectedTextIds: isTitle(clip) ? [clip.id] : [], textSelection: null, selectedNodeId: nodes[0]?.id ?? null });
  };
  // One asset, one clip. Shared by the single add and the bin's multi-drop, which only differs in
  // laying the next clip down where the last one ended.
  const assetDuration = (media: MediaAsset) => media.kind === 'image' ? parseFloat(String(get().settings.stillDuration)) || 5 : media.duration;
  const insertMedia = (media: MediaAsset, start: number, trackId?: string, gesture?: string) => {
    const state = get(), kind = media.kind === 'audio' ? 'audio' : 'video', fps = state.projects.find(p => p.id === state.projectId)?.fps || 24;
    const track = trackId ? state.tracks.find(track => track.id === trackId && track.timelineId === state.timelineId && !track.locked && track.kind === kind) : state.tracks.find(track => track.timelineId === state.timelineId && track.kind === kind && !track.locked && !track.captionSets && track.number === 1) ?? state.tracks.find(track => track.timelineId === state.timelineId && track.kind === kind && !track.locked && !track.captionSets);
    if (!track) { state.notify('Add an unlocked track first', 'info'); return false; }
    insertClip({ id: '', projectId: state.projectId, timelineId: state.timelineId, trackId: track.id, mediaId: media.id, name: media.name, start: 0, duration: assetDuration(media), sourceIn: 0, color: media.kind === 'audio' ? '#427A68' : '#467879', disabled: false, properties: { ...defaultProperties }, effects: [] }, Math.round(Math.max(0, start) * fps) / fps, media.name, false, gesture);
    return true;
  };
  return {
    shapeTool:null, compositionTrail:[], selectedClipIds:[], textTool: false, selectedTextIds: [], textSelection: null, textPreview: [],
    session: 'loading', serverOnline: false, syncConflict: [], cursor: null,
    ...structuredClone(initial), ...saved, projectId: 'city-after-dark', timelineId: demo.timelineId,
    selectedClipId: saved ? saved.clips.find(clip => clip.id === 'c3')?.id ?? null : 'c3', selectedNodeId: demo.selectedNodeId,
    notifications: recoveryMessage ? [{ id: 'recovery', title: 'Recovered the demo project', detail: recoveryMessage, kind: 'error', timestamp: Date.now() }] : [],
    dragPreview: null, presence: demo.presence, locks: [{ id: 'demo-speed-lock', projectId: 'city-after-dark', targetId: 'c3', field: 'speed', userId: 'ashley', expiresAt: Date.now() + 12_000 }],
    playhead: 42, rangeIn: 0, rangeOut: 180, revealedMediaId: null, playing: false, playbackBuffering: false, workspace: 'edit', sidePanel: 'inspector', modal: null,
    clipPreview: null, draggingMediaId: null, inspectorTab: 'Video', selectedTransition: null, draggingTransition: null, leaks: [], transitionPresets: [], transitionFavorites: [], saveStatus: 'Saved', liveMode: 'independent', followUserId: null, clipboard: null, clipboardClips: [], clipboardNodes: [], gradeClipboard: null,
    addTitle(preset = 0, box = {}, placement, animated = true) {
      const state=get();if(!writable())return;
      const fps=state.projects.find(p=>p.id===state.projectId)?.fps||24;
      const template=createTitleTemplate(preset,animated&&!Object.keys(box).length,fps),start=frameTime(Math.max(0,placement?.start??state.playhead),fps),duration=template.duration;
      if(!Number.isFinite(start))return;
      const tracks=state.tracks.filter(t=>t.timelineId===state.timelineId&&t.kind==='video'&&!t.captionSets);
      let track=placement?tracks.find(t=>t.id===placement.trackId&&!t.locked):tracks.filter(t=>!t.locked&&!t.hidden&&t.name==='Titles'&&!state.clips.some(c=>c.trackId===t.id&&c.start<start+duration&&c.start+c.duration>start)).sort((a,b)=>b.number-a.number)[0];
      if(placement&&!track)return;
      const changes:Change[]=[];
      if(!track){track={id:createId('track'),timelineId:state.timelineId,name:'Titles',kind:'video',number:Math.max(0,...tracks.map(t=>t.number))+1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0};changes.push({collection:'tracks',id:track.id,value:record(track),replace:true});}
      const composition=template.layers.length>1,childId=composition?createId('composition'):state.timelineId;
      if(composition)changes.push({collection:'timelines',id:childId,value:record({id:childId,projectId:state.projectId,name:template.name,duration,composition:true}),replace:true});
      const layers=template.layers.map((layer,i)=>{
        const layerTrack=composition?{...track!,id:createId('track'),timelineId:childId,number:i+1,name:layer.name}:track!;
        if(composition)changes.push({collection:'tracks',id:layerTrack.id,value:record(layerTrack),replace:true});
        const doc=layer.text?{...layer.text,...box}:undefined;if(doc)validateText(doc);if(layer.shape)validateShape(layer.shape);
        const clip:Clip={id:createId('clip'),projectId:state.projectId,timelineId:childId,trackId:layerTrack.id,mediaId:doc?'frameline-title':'frameline-shape',name:doc?doc.runs.map(r=>r.text).join(' ').slice(0,80)||'Text':layer.name,start:composition?0:start,duration,sourceIn:0,color:doc?'#8e75ba':'#b8894f',disabled:false,properties:{animationPresetDuration:duration,...layer.properties,...(doc?{textDocument:JSON.stringify(doc)}:{shapeDocument:JSON.stringify(layer.shape)})},effects:[],keyframes:layer.keyframes};
        return clip;
      });
      const clip:Clip=composition?{id:createId('clip'),projectId:state.projectId,timelineId:state.timelineId,trackId:track.id,mediaId:'frameline-composition',name:template.name,start,duration,sourceIn:0,color:'#7856b9',disabled:false,properties:{compositionId:childId,animationPresetDuration:duration},effects:[]}:layers[0];
      const overwritten=placement?overwriteChanges(clip):[];if(!overwritten)return;
      changes.push(...overwritten,...layers.map(c=>({collection:'clips' as const,id:c.id,value:record(c),replace:true})),...(composition?[{collection:'clips' as const,id:clip.id,value:record(clip),replace:true}]:[]));
      commit('ClipAdded',clip.id,`added ${template.name}`,changes);
      get().selectClip(clip.id);set({textTool:false,shapeTool:null,playing:false});
    },
    addShape(kind,box={},placement) {
      const state=get();if(!writable())return;
      const doc={...defaultShape(kind),...box};try{validateShape(doc);}catch(error){state.notify((error as Error).message,'error');return;}
      const start=frameTime(Math.max(0,placement?.start??state.playhead),state.projects.find(p=>p.id===state.projectId)?.fps||24),duration=5;
      if(!Number.isFinite(start))return;
      const tracks=state.tracks.filter(t=>t.timelineId===state.timelineId&&t.kind==='video'&&!t.captionSets);
      let track=placement?tracks.find(t=>t.id===placement.trackId&&!t.locked):tracks.find(t=>!t.locked&&!t.hidden&&t.name==='Shapes'&&!state.clips.some(c=>c.trackId===t.id&&c.start<start+duration&&c.start+c.duration>start));
      if(placement&&!track)return;
      const changes:Change[]=[];
      if(!track){track={id:createId('track'),timelineId:state.timelineId,name:'Shapes',kind:'video',number:Math.max(0,...tracks.map(t=>t.number))+1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0};changes.push({collection:'tracks',id:track.id,value:record(track),replace:true});}
      const clip:Clip={id:createId('shape'),projectId:state.projectId,timelineId:state.timelineId,trackId:track.id,mediaId:'frameline-shape',name:kind==='pen'?'Custom shape':kind.replace(/^./,s=>s.toUpperCase()),start,duration,sourceIn:0,color:'#b8894f',disabled:false,properties:{shapeDocument:JSON.stringify(doc)},effects:[]};
      const overwritten=placement?overwriteChanges(clip):[];if(!overwritten)return;
      changes.push(...overwritten,{collection:'clips',id:clip.id,value:record(clip),replace:true});
      commit('ClipAdded',clip.id,`added ${clip.name}`,changes);get().selectClip(clip.id);set({shapeTool:null,textTool:false,playing:false});
    },
    updateShape(id,doc,gesture) {
      const clip=editableClip(id,'shapeDocument');if(!clip||!isShape(clip))return;
      try{validateShape(doc);}catch(error){get().notify((error as Error).message,'error');return;}
      const current=animationProperties(evaluateClip(clip,get().playhead)),before=animationProperties(clip),keyframes={...clip.keyframes};
      let base:Clip={...clip,properties:{...clip.properties,shapeDocument:JSON.stringify(doc)}};
      const fps=get().projects.find(p=>p.id===clip.projectId)?.fps||24,time=frameTime(clamp(get().playhead-clip.start,0,clip.duration-1/fps),fps);
      for(const p of animationProperties(base).filter(p=>p.path.startsWith('shape.')&&keyframes[p.path])) {
        if(p.value!==current.find(q=>q.path===p.path)?.value)keyframes[p.path]=[...keyframes[p.path].filter(k=>Math.abs(k.time-time)>.5/fps),{id:createId('key'),time,value:p.value,interpolation:typeof p.value==='number'?'linear' as const:'hold' as const}].sort((a,b)=>a.time-b.time);
        const original=before.find(q=>q.path===p.path);if(original)base=setAnimatedValue(base,p.path,original.value);
      }
      // Removing path points also removes animation channels that no longer address a point.
      for(const path of Object.keys(keyframes))if(path.startsWith('shape.points.')&&Number(path.split('.')[2])>=doc.points.length)delete keyframes[path];
      commit('PropertyChanged',id,`edited ${clip.name}`, [{collection:'clips',id,value:{'properties.shapeDocument':base.properties.shapeDocument,keyframes}}],gesture);
    },
    editShapePoint(id,index,action) {
      const clip=editableClip(id,'shapeDocument');if(!clip||!isShape(clip))return;
      const doc=getShape(clip);
      if(doc.kind!=='pen'||!Number.isInteger(index)||index<0||index>=doc.points.length||!['delete','corner'].includes(action)||action==='delete'&&doc.points.length<=(doc.closed?3:2))return;
      const points=action==='delete'?doc.points.filter((_,i)=>i!==index):doc.points.map((p,i)=>i===index?{x:p.x,y:p.y}:p);
      const keyframes=Object.fromEntries(Object.entries(clip.keyframes??{}).flatMap(([path,keys])=>{
        const match=/^shape\.points\.(\d+)\.(.+)$/.exec(path);if(!match)return [[path,keys]];
        const point=Number(match[1]);
        if(point===index&&(action==='delete'||/^(in|out)[XY]$/.test(match[2])))return [];
        return [[action==='delete'&&point>index?`shape.points.${point-1}.${match[2]}`:path,keys]];
      }));
      commit('PropertyChanged',id,action==='delete'?'deleted shape point':'converted shape point to corner',[{collection:'clips',id,value:{'properties.shapeDocument':JSON.stringify({...doc,points}),keyframes}}]);
    },
    createComposition(name='Composition') {
      const state=get(),selected=state.clips.find(c=>c.id===state.selectedClipId);if(!selected)return;
      const group=selectedGroup(selected,'*');if(!group?.length||!writable())return;
      const ids=new Set(group.map(c=>c.id)),start=Math.min(...group.map(c=>c.start)),end=Math.max(...group.map(c=>c.start+c.duration));
      const sourceTracks=state.tracks.filter(t=>group.some(c=>c.trackId===t.id));
      // Grouping cannot change the visual stacking of an unselected overlapping layer.
      const video=sourceTracks.filter(t=>t.kind==='video'),high=Math.max(...video.map(t=>t.number));
      if(state.clips.some(c=>c.timelineId===state.timelineId&&!ids.has(c.id)&&state.tracks.some(t=>t.id===c.trackId&&t.kind==='video'&&t.number<=high&&group.some(selected=>{const track=sourceTracks.find(track=>track.id===selected.trackId)!;return track.kind==='video'&&(track.number<t.number||track.number===t.number&&selected.start<c.start)&&selected.start<c.start+c.duration&&selected.start+selected.duration>c.start;})))){state.notify('Include the overlapping layers between these clips','info','Grouping them alone would change the layer order.');return;}
      if(sourceTracks.some(t=>!available(t.id,'*'))||state.nodes.some(n=>ids.has(n.clipId)&&!available(n.id,'*')))return;
      const id=createId('composition'),title=name.trim().slice(0,80)||'Composition',changes:Change[]=[{collection:'timelines',id,value:record({id,projectId:state.projectId,name:title,duration:end-start,composition:true}),replace:true}];
      const videoTracks=state.tracks.filter(t=>t.timelineId===state.timelineId&&t.kind==='video'&&!t.captionSets);
      const number=video.length?high+1:Math.max(0,...videoTracks.map(t=>t.number))+1;
      for(const t of videoTracks.filter(t=>t.number>=number)){if(!available(t.id,'*'))return;changes.push({collection:'tracks',id:t.id,value:{number:t.number+1}});}
      const parentTrack:Track={id:createId('track'),timelineId:state.timelineId,name:'Compositions',kind:'video',number,muted:false,solo:sourceTracks.some(t=>t.solo&&!t.muted),locked:false,hidden:false,gain:0,pan:0};
      changes.push({collection:'tracks',id:parentTrack.id,value:record(parentTrack),replace:true});
      // Preserve legacy embedded-audio separation when its matching clip moves across the boundary.
      for(const video of state.clips.filter(c=>c.timelineId===state.timelineId&&state.media.some(m=>m.id===c.mediaId&&m.hasAudio)&&state.tracks.some(t=>t.id===c.trackId&&t.kind==='video')&&!c.properties.audioDetached)){
        const separated=state.clips.some(audio=>audio.timelineId===state.timelineId&&audio.mediaId===video.mediaId&&audio.start===video.start&&audio.sourceIn===video.sourceIn&&audio.duration===video.duration&&state.tracks.some(t=>t.id===audio.trackId&&t.kind==='audio')&&ids.has(audio.id)!==ids.has(video.id));
        if(separated){if(!editableClip(video.id,'*'))return;changes.push({collection:'clips',id:video.id,value:{'properties.audioDetached':true}});}
      }
      const trackIds=new Map(sourceTracks.map(t=>[t.id,createId('track')]));
      for(const t of sourceTracks)changes.push({collection:'tracks',id:trackIds.get(t.id)!,value:record({...t,id:trackIds.get(t.id),timelineId:id,number:sourceTracks.filter(q=>q.kind===t.kind).sort((a,b)=>a.number-b.number).indexOf(t)+1}),replace:true});
      for(const c of group)changes.push({collection:'clips',id:c.id,value:{timelineId:id,trackId:trackIds.get(c.trackId),start:c.start-start}});
      for(const c of state.comments.filter(c=>c.clipId&&ids.has(c.clipId)))changes.push({collection:'comments',id:c.id,value:{time:Math.max(0,c.time-start)}});
      const parent:Clip={id:createId('clip'),projectId:state.projectId,timelineId:state.timelineId,trackId:parentTrack.id,mediaId:'frameline-composition',name:title,start,duration:end-start,sourceIn:0,color:'#7856b9',disabled:false,properties:{compositionId:id},effects:[]};
      changes.push({collection:'clips',id:parent.id,value:record(parent),replace:true});
      commit('ClipAdded',parent.id,`created ${title}`,changes);get().selectClip(parent.id);
    },
    openComposition(id) {
      const state=get(),clip=state.clips.find(c=>c.id===id&&c.timelineId===state.timelineId);
      if(!clip||!isComposition(clip))return;
      const next=String(clip.properties.compositionId);if(!state.timelines.some(t=>t.id===next&&t.projectId===state.projectId))return;
      const trail=[...state.compositionTrail,{timelineId:state.timelineId,playhead:state.playhead,clipId:id}];
      state.setTimeline(next);set({compositionTrail:trail});
    },
    leaveComposition(index) {
      const state=get(),at=index??state.compositionTrail.length-1,previous=state.compositionTrail[at];if(!previous)return;
      state.setTimeline(previous.timelineId);get().setPlayhead(previous.playhead);get().selectClip(previous.clipId);set({compositionTrail:state.compositionTrail.slice(0,at)});
    },
    setAnimationChannels(id,channels,gesture) {
      const clip=editableClip(id,'*');if(!clip)return;
      const properties=animationProperties(clip,get().nodes),keyframes:NonNullable<Clip['keyframes']>={};
      for(const [path,keys] of Object.entries(channels)) {
        const p=properties.find(p=>p.path===path);if(!p||keys.some(k=>typeof k.value!==typeof p.value))return;
        const node=get().nodes.find(n=>path.startsWith(`nodes.${n.id}.`));if(node&&!available(node.id,'*'))return;
        if(keys.length)keyframes[path]=keys.map(k=>({...k,value:boundedAnimationValue(path,k.value)})).sort((a,b)=>a.time-b.time);
      }
      try{validateKeyframes(keyframes);}catch{return;}
      const timing=['properties.speed','properties.reverse','properties.freeze'].filter(path=>JSON.stringify(clip.keyframes?.[path])!==JSON.stringify(keyframes[path]));
      const group=timing.length?editableGroup(clip,'*'):[clip];if(!group)return;
      commit('PropertyChanged',id,`edited keyframes on ${clip.name}`,group.map(c=>{
        const channels=c.id===id?keyframes:{...c.keyframes};if(c.id!==id)for(const path of timing){if(keyframes[path])channels[path]=keyframes[path].map(k=>({...k,time:k.time+clip.start-c.start}));else delete channels[path];}
        return {collection:'clips' as const,id:c.id,value:{keyframes:channels,...(timing.length?{duration:retimedDuration(c,{...c,keyframes:channels},get().clips)}:{})}};
      }),gesture);
    },
    installCaptions(job,wordsPerLine,preset,replaceSet) {
      const state=get();if(!writable()||job.projectId!==state.projectId||job.timelineId!==state.timelineId||job.status!=='complete'||!job.words?.length)return;
      if(state.tracks.some(t=>t.captionSets?.some(s=>s.jobId===job.id))){state.notify('These captions are already on the timeline','info');return;}
      let track=state.tracks.find(t=>t.timelineId===state.timelineId&&t.captionSets);
      if(track?.locked||track&&!available(track.id,'*')){state.notify('Unlock the captions track first','info');return;}
      const removing=new Set([...(job.removeSets??[]),...(replaceSet?[replaceSet]:[])]);
      const old=state.clips.filter(c=>c.timelineId===state.timelineId&&removing.has(String(c.properties.captionSet)));
      if(old.some(c=>!editableClip(c.id,'*'))||state.nodes.some(n=>old.some(c=>c.id===n.clipId)&&!available(n.id,'*')))return;
      const id=replaceSet??createId('caption-set');
      const meta:CaptionSet={id,jobId:job.id.startsWith('regroup-')?(track?.captionSets?.find(s=>s.id===replaceSet)?.jobId??job.id):job.id,start:job.start,end:job.end,trackIds:job.trackIds,signature:job.signature,wordsPerLine,preset:captionPreset(preset).id};
      track=track??{id:createId('track'),timelineId:state.timelineId,name:'Captions',kind:'video',number:Math.max(0,...state.tracks.filter(t=>t.timelineId===state.timelineId&&t.kind==='video').map(t=>t.number))+1,hidden:false,muted:true,solo:false,locked:false,gain:0,pan:0,captionSets:[]};
      const nextTrack={...track,captionSets:[...track.captionSets!.filter(s=>s.id!==id),meta]};
      let grouped:CaptionWord[][];try{grouped=groupCaptionWords(job.words,wordsPerLine);}catch(error){state.notify((error as Error).message,'error');return;}
      const lines=grouped.map((words,index,groups)=>{
        const start=words[0].start,end=Math.min(job.end,groups[index+1]?.[0].start??job.end,words.at(-1)!.end+.12),duration=Math.max(.01,end-start);
        const doc=captionDocument(words.map(w=>({...w,start:w.start-start,end:w.end-start})),preset,duration);
        return {id:createId('caption'),projectId:state.projectId,timelineId:state.timelineId,trackId:track!.id,mediaId:'frameline-title',name:words.map(w=>w.text).join(' ').slice(0,255),start,duration,sourceIn:0,color:'#8970b6',disabled:false,properties:{captionSet:id,textDocument:JSON.stringify(doc)},effects:[]} as Clip;
      });
      const deleted=new Set(old.map(c=>c.id));
      const changes:Change[]=[{collection:'tracks',id:track.id,value:record(nextTrack),replace:true},...old.map(c=>({collection:'clips' as const,id:c.id,value:null,replace:true})),...lines.map(c=>({collection:'clips' as const,id:c.id,value:record(c),replace:true})),...state.nodes.filter(n=>deleted.has(n.clipId)).map(n=>({collection:'nodes' as const,id:n.id,value:null,replace:true})),...state.comments.filter(c=>c.clipId&&deleted.has(c.clipId)).map(c=>({collection:'comments' as const,id:c.id,value:{},unset:['clipId']}))];
      commit('ClipAdded',track.id,replaceSet?'regenerated captions':'generated captions',changes);
      get().selectClip(lines[0].id);get().setPlayhead(lines[0].start+.2);
    },
    regroupCaptions(setId,wordsPerLine) {
      const state=get(),track=state.tracks.find(t=>t.timelineId===state.timelineId&&t.captionSets?.some(s=>s.id===setId)),meta=track?.captionSets?.find(s=>s.id===setId);if(!meta)return;
      const words=state.clips.filter(c=>c.timelineId===state.timelineId&&c.properties.captionSet===setId).sort((a,b)=>a.start-b.start).flatMap(c=>getText(c).caption!.words.filter(w=>w.end>c.sourceIn&&w.start<c.sourceIn+c.duration).map(w=>({...w,start:Math.max(c.start,w.start+c.start-c.sourceIn),end:Math.min(c.start+c.duration,w.end+c.start-c.sourceIn)}))).filter(w=>w.end>w.start).sort((a,b)=>a.start-b.start);
      get().installCaptions({id:createId('regroup'),projectId:state.projectId,timelineId:state.timelineId,status:'complete',stage:'Ready',progress:100,start:Math.min(meta.start,words[0]?.start??meta.start),end:Math.max(meta.end,words.at(-1)?.end??meta.end),trackIds:meta.trackIds,signature:meta.signature,words},wordsPerLine,meta.preset,setId);
    },
    styleCaptions(setId,preset) {
      preset=captionPreset(preset).id;
      const state=get(),track=state.tracks.find(t=>t.timelineId===state.timelineId&&t.captionSets?.some(s=>s.id===setId));if(!track||track.locked||!writable()||!available(track.id,'*'))return;
      const clips=state.clips.filter(c=>c.timelineId===state.timelineId&&c.properties.captionSet===setId);if(clips.some(c=>!editableClip(c.id,'textDocument')))return;
      const changes:Change[]=clips.map(c=>({collection:'clips',id:c.id,value:{'properties.textDocument':JSON.stringify(restyleCaption(getText(c),preset))}}));
      changes.push({collection:'tracks',id:track.id,value:{captionSets:track.captionSets!.map(s=>s.id===setId?{...s,preset}:s)}});commit('PropertyChanged',track.id,'changed caption preset',changes);
    },
    updateCaption(id,words) {
      const clip=editableClip(id,'textDocument');if(!clip||!isCaption(clip))return;
      const doc=getText(clip),caption={...doc.caption!,words};
      try{validateCaption(caption);}catch(error){get().notify((error as Error).message,'error');return;}
      doc.caption=caption;doc.runs=[{...doc.runs[0],text:words.map(w=>w.text).join(' ')}];
      commit('PropertyChanged',id,'edited caption words',[{collection:'clips',id,value:{name:doc.runs[0].text.slice(0,255)||'Caption','properties.textDocument':JSON.stringify(doc)}}]);
    },
    selectText(id, additive = false) {
      const state = get(); const clip = state.clips.find(c => c.id === id && c.timelineId === state.timelineId);
      if (!clip || !isTitle(clip)) return;
      const ids = additive ? [...new Set([...state.selectedTextIds, id])] : [id];
      set({ selectedClipId: id, selectedClipIds:ids, selectedTextIds: ids, textSelection: null, selectedNodeId: null, sidePanel: 'inspector', inspectorTab: 'Text', playing: false });
    },
    updateText(documents, gesture) {
      if (!documents.length || documents.some(({id}) => !editableClip(id, 'textDocument'))) return;
      try { documents.forEach(({doc}) => validateText(doc)); } catch (error) { get().notify((error as Error).message, 'error'); return; }
      const changes = documents.map(({id,doc}) => {
        const clip=get().clips.find(c=>c.id===id)!,evaluated=evaluateClip(clip,get().playhead);
        const remapped=remapTextRuns(getText(clip),getText(evaluated),doc,clip.keyframes??{},()=>createId('key'));
        const withDoc=(document:TextDocument):Clip=>({...clip,properties:{...clip.properties,textDocument:JSON.stringify(document)}});
        let base=withDoc(remapped.next);const keyframes={...remapped.keyframes};
        const before=animationProperties(withDoc(remapped.current)),original=animationProperties(withDoc(remapped.base));
        for(const p of animationProperties(base).filter(p=>p.path.startsWith('text.')&&keyframes[p.path])) {
          if(p.value!==before.find(q=>q.path===p.path)?.value) {
            const fps=get().projects.find(p=>p.id===clip.projectId)?.fps||24,time=frameTime(clamp(get().playhead-clip.start,0,Math.max(0,clip.duration-1/fps)),fps),existing=keyframes[p.path].find(k=>Math.abs(k.time-time)<.5/fps);
            keyframes[p.path]=[...keyframes[p.path].filter(k=>k!==existing),{id:existing?.id??createId('key'),time,value:p.value,interpolation:existing?.interpolation??(typeof p.value==='number'?'linear' as const:'hold' as const),...(existing?.curve?{curve:existing.curve}:{})}].sort((a,b)=>a.time-b.time);
          }
          const value=original.find(q=>q.path===p.path);if(value)base=setAnimatedValue(base,p.path,value.value);
        }
        return {collection:'clips' as const,id,value:{'properties.textDocument':base.properties.textDocument,...(clip.keyframes?{keyframes}:{})}};
      });
      commit('PropertyChanged',documents[0].id,`edited ${documents.length>1?documents.length+' text layers':'text'}`,changes,gesture);
    },
    formatText(patch, preview = false) {
      const state = get(); const ids = state.selectedTextIds.length ? state.selectedTextIds : [state.selectedClipId];
      const clips = state.clips.filter(c => c.timelineId === state.timelineId && ids.includes(c.id) && isTitle(c));
      const documents = clips.map(clip => ({ id: clip.id, doc: styleText(getText(evaluateClip(clip,state.playhead)), patch, clips.length === 1 && state.textSelection?.clipId === clip.id ? state.textSelection : undefined) }));
      if (preview) set({ textPreview: clips.map((clip,i) => ({ ...evaluateClip(clip,state.playhead), keyframes:undefined, properties: { ...evaluateClip(clip,state.playhead).properties, textDocument: JSON.stringify(documents[i].doc) } })) });
      else { set({ textPreview: [] }); get().updateText(documents); }
    },
    openProject(id) {
      const state = get();
      if (!state.projects.some(p => p.id === id)) { state.notify('Project not found', 'error'); return; }
      try { const key = `sharedcut-recent-${state.currentUserId}`; const saved = JSON.parse(localStorage.getItem(key) || '[]'); const recent = Array.isArray(saved) ? saved.filter(item => typeof item === 'string' && item !== id) : []; localStorage.setItem(key, JSON.stringify([id, ...recent].slice(0, 20))); } catch { /* Recents are optional when browser storage is unavailable. */ }
      if (!state.timelines.some(t => t.projectId === id) && !connection.enabled) {
        const added = createDemoProject(id);
        set({ media: [...state.media, ...added.media], timelines: [...state.timelines, ...added.timelines], clips: [...state.clips, ...added.clips], tracks: [...state.tracks, ...added.tracks], nodes: [...state.nodes, ...added.nodes], comments: [...state.comments, ...added.comments], operations: [...added.operations, ...state.operations], snapshots: [...added.snapshots, ...state.snapshots] });
      }
      const next = get();
      const timeline = next.timelines.find(t => t.projectId === id);
      if (!timeline) return;
      const selected = next.clips.find(c => c.projectId === id && c.name === 'Neon crossing') ?? next.clips.find(c => c.timelineId === timeline.id);
      const memberIds = next.projects.find(p => p.id === id)!.members.map(member => member.userId);
      set({ selectedClipIds:[],compositionTrail:[],shapeTool:null, projectId: id, timelineId: timeline.id, selectedClipId: selected?.id ?? null, selectedNodeId: next.nodes.find(node => node.clipId === selected?.id && node.name === 'Balance')?.id ?? null, workspace: 'edit', selectedTextIds: selected && isTitle(selected) ? [selected.id] : [], textSelection: null, textTool: false, textPreview: [], playhead: selected?.start ?? 0, ...initialRange(next, timeline.id), revealedMediaId: null, playing: false, liveMode: 'independent', followUserId: null, modal: null, presence: connection.enabled ? [] : createDemoProject(id).presence.filter(p => memberIds.includes(p.userId) && p.userId !== next.currentUserId), locks: !connection.enabled && id === 'city-after-dark' ? [{ id: createId('lock'), projectId: id, targetId: 'c3', field: 'speed', userId: 'ashley', expiresAt: Date.now() + 12_000 }] : [] });
    },
    createProject(input) {
      const state = get();
      const name = input.name.trim().slice(0, 100);
      if (!name) { state.notify('Give your project a name', 'error'); return ''; }
      const id = createId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project');
      const template = createDemoProject(id);
      const project: Project = { id, name, description: input.description.trim().slice(0, 500), shared: input.shared, thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution: String(state.settings.timelineResolution || '1920 × 1080'), fps: parseFloat(String(state.settings.timelineFrameRate)) || 24, status: 'In progress', members: [{ userId: state.currentUserId, role: 'Owner' }, ...(!connection.enabled && input.shared ? state.users.filter(user => user.id !== state.currentUserId).map(user => ({ userId: user.id, role: 'Editor' as const })) : [])] };
      set({ projects: [project, ...state.projects], timelines: [...state.timelines, template.timelines[0]], tracks: [...state.tracks, ...template.tracks.filter(t => t.timelineId === template.timelineId)] });
      state.notify(`${name} created`, 'success');
      return id;
    },
    setTimelineFormat(width, height, fps) {
      const state = get();
      if (!writable() || !available(state.projectId, '*')) return false;
      if (![width, height].every(value => Number.isInteger(value) && value >= 16 && value <= 8192) || !Number.isFinite(fps) || fps < 1 || fps > 240) {
        state.notify('Use dimensions from 16 to 8192 pixels and a frame rate from 1 to 240', 'error');
        return false;
      }
      set({ playing: false, projects: state.projects.map(project => project.id === state.projectId ? { ...project, resolution: `${width} × ${height}`, fps, modifiedAt: Date.now() } : project) });
      return true;
    },
    setWorkspace(workspace) { set({ workspace, ...(get().settings.pauseOnWorkspace !== false ? { playing: false } : {}) }); },
    selectClips(ids) {
      const state=get(),clips=state.clips.filter(c=>c.timelineId===state.timelineId&&ids.includes(c.id));
      const id=ids.filter(id=>clips.some(c=>c.id===id)).at(-1)??null;
      set({selectedTransition:null,selectedClipIds:clips.map(c=>c.id),selectedClipId:id,selectedTextIds:clips.filter(isTitle).map(c=>c.id),textSelection:null,textPreview:[],selectedNodeId:state.nodes.find(n=>n.clipId===id)?.id??null, ...(id?{sidePanel:'inspector' as const,inspectorTab:isTitle(clips.find(c=>c.id===id)!)?'Text':isShape(clips.find(c=>c.id===id)!)?'Shape':'Video'}:{})});
    },
    selectClip(id,additive=false) {
      const state=get();
      state.selectClips(id?(additive?(state.selectedClipIds.includes(id)?state.selectedClipIds.filter(c=>c!==id):[...state.selectedClipIds,id]):[id]):[]);
    },
    selectForward(from) {
      const state=get(),fps=state.projects.find(p=>p.id===state.projectId)?.fps||24;
      const anchor='clipId' in from?state.clips.find(c=>c.id===from.clipId&&c.projectId===state.projectId&&c.timelineId===state.timelineId):undefined;
      const at=anchor?anchor.start:'time' in from&&Number.isFinite(from.time)?Math.max(0,from.time):NaN;
      if(Number.isNaN(at))return;
      const {ids}=forwardSelection(state.clips,state.tracks,state.timelineId,at,fps,state.settings.linkSelection!==false);
      // The clicked clip goes last so it is the primary the Inspector shows.
      state.selectClips(anchor&&ids.includes(anchor.id)?[...ids.filter(id=>id!==anchor.id),anchor.id]:ids);
    },
    selectNode(id) { if (!id || get().nodes.some(node => node.id === id && node.projectId === get().projectId)) set({ selectedNodeId: id }); },
    setPlayhead(time) { if (Number.isFinite(time)) set({ playhead: clamp(time, 0, durationOf(get())), liveMode: get().liveMode === 'following' ? 'independent' : get().liveMode, followUserId: null }); },
    setRange(inTime, outTime) {
      if (!Number.isFinite(inTime) || !Number.isFinite(outTime)) return;
      const range = { rangeIn: clamp(Math.min(inTime, outTime), 0, durationOf(get())), rangeOut: clamp(Math.max(inTime, outTime), 0, durationOf(get())) };
      set(range);
      try { localStorage.setItem(rangeKey(get().timelineId), JSON.stringify([range.rangeIn, range.rangeOut])); } catch { /* In-memory only when storage is unavailable. */ }
    },
    setPlaying(playing) { const state = get(); set({ playing, ...(playing && state.playhead >= playbackEndOf(state) ? { playhead: 0 } : {}) }); },
    setSidePanel(sidePanel) { set({ sidePanel }); }, setModal(modal) { set({ modal }); },
    setKeyframes(clipId, path, keys, gesture) {
      const clip = editableClip(clipId, '*'); if (!clip) return;
      const property = animationProperties(clip, get().nodes).find(p=>p.path===path);
      if (!property) return;
      const node=get().nodes.find(n=>path.startsWith(`nodes.${n.id}.`));if(node&&!available(node.id,'*'))return;
      const sorted = keys.map(k=>({...k,value:boundedAnimationValue(path,k.value)})).sort((a,b)=>a.time-b.time);
      if (sorted.some(k=>typeof k.value!==typeof property.value)) return;
      const keyframes = {...clip.keyframes};
      if (sorted.length) keyframes[path] = sorted; else delete keyframes[path];
      try { validateKeyframes(keyframes); } catch { return; }
      const timing=['properties.speed','properties.reverse','properties.freeze'].includes(path),group=timing?editableGroup(clip,'*'):[clip];if(!group)return;
      commit('PropertyChanged', clipId, `edited ${property.label} keyframes on ${clip.name}`, group.map(c=>{const channels={...c.keyframes};if(sorted.length)channels[path]=sorted.map(k=>({...k,time:k.time+clip.start-c.start}));else delete channels[path];return {collection:'clips',id:c.id,value:{keyframes:channels,...(timing?{duration:retimedDuration(c,{...c,keyframes:channels},get().clips)}:{})}};}), gesture);
    },
    keyframeProperty(clipId, path, value) {
      const clip = editableClip(clipId, '*'); if (!clip) return;
      const state=get(), property=animationProperties(evaluateClip(clip,state.playhead),evaluateNodes(state.nodes,clip,state.playhead)).find(p=>p.path===path);
      if (!property) return;
      const fps=state.projects.find(p=>p.id===clip.projectId)?.fps || 24;
      const time=frameTime(clamp(state.playhead-clip.start,0,Math.max(0,clip.duration-1/fps)),fps);
      const keys=clip.keyframes?.[path] ?? [], existing=keys.find(k=>Math.abs(k.time-time)<.5/fps);
      state.setKeyframes(clipId,path,[...keys.filter(k=>k!==existing),{id:existing?.id??createId('key'),time,value:value??property.value,interpolation:existing?.interpolation??(typeof property.value==='number'?'linear':'hold'),...(existing?.curve?{curve:existing.curve}:{})}]);
    },
    updateProperty(clipId, key, value, gesture) {
      if (key === 'shapeDocument') {try{validateShape(JSON.parse(String(value)));}catch{return;}}
      if (key === 'textDocument') { try { validateText(JSON.parse(String(value))); } catch { return; } }
      if (['__proto__', 'prototype', 'constructor'].includes(key) || key.includes('.')) return;
      const clip = editableClip(clipId, key);
      if (!clip || (typeof value === 'number' && !Number.isFinite(value))) return;
      let next = value;
      if (typeof value === 'number') {
        if (['fadeIn','fadeOut','audioFadeIn','audioFadeOut'].includes(key)) next = clamp(value,0,clip.duration);
        if (key === 'opacity') next = clamp(value, 0, 100);
        if (['cropLeft', 'cropRight', 'cropTop', 'cropBottom'].includes(key)) {
          const resolution = get().media.find(asset => asset.id === clip.mediaId)?.resolution.match(/\d+/g)?.map(Number) ?? [3840, 2160];
          next = clamp(value, 0, resolution[key === 'cropTop' || key === 'cropBottom' ? 1 : 0] ?? 3840);
        }
        if (key === 'speed') next = clamp(value, 1, 800);
        if (key === 'zoom') next = clamp(value, 1, 800);
        if (key === 'gain') next = clamp(value, -60, 24);
        if (key === 'pan') next = clamp(value, -100, 100);
      }
      if (clip.keyframes?.[`properties.${key}`]) { get().keyframeProperty(clipId,`properties.${key}`,next); return; }
      const field = key === 'disabled' ? 'disabled' : `properties.${key}`;
      const group=['speed','reverse','freeze'].includes(key)?editableGroup(clip,key):[clip];if(!group)return;
      commit('PropertyChanged', clipId, `changed ${key} on ${clip.name}`, group.map(c=>({ collection: 'clips', id: c.id, value: { [field]: next, ...(['fadeIn','fadeOut','audioFadeIn','audioFadeOut'].includes(key)?{'properties.fadeOrigin':0,'properties.fadeDuration':c.duration}:{}), ...(key === 'speed' ? { duration: retimedDuration(c, { ...c, properties: { ...c.properties, speed: next } }, get().clips) } : {}) } })), gesture);
    },
    unlinkClip(id) {
      const state=get(),clip=editableClip(id);if(!clip||!clip.properties.linkGroup)return;
      const group=state.clips.filter(c=>c.timelineId===clip.timelineId&&c.properties.linkGroup===clip.properties.linkGroup);
      if(!group.every(c=>editableClip(c.id)))return;
      commit('PropertyChanged',id,`unlinked ${clip.name}`,group.map(c=>({collection:'clips',id:c.id,value:{},unset:['properties.linkGroup']})));
    },
    linkClip(id) {
      const state=get(),clip=editableClip(id);if(!clip)return;
      const kind=state.tracks.find(t=>t.id===clip.trackId)?.kind;
      const peers=state.clips.filter(c=>c.id!==id&&c.timelineId===clip.timelineId&&c.mediaId===clip.mediaId&&!c.properties.linkGroup&&state.tracks.find(t=>t.id===c.trackId)?.kind!==kind&&Math.abs(c.start-clip.start)<1e-6&&Math.abs(c.sourceIn-clip.sourceIn)<1e-6&&Math.abs(c.duration-clip.duration)<1e-6);
      if(peers.length!==1){state.notify('Relink needs one matching audio/video clip at the same position','info');return;}
      if(!editableClip(peers[0].id))return;
      const linkGroup=createId('link');commit('PropertyChanged',id,`linked ${clip.name}`,[clip,peers[0]].map(c=>({collection:'clips',id:c.id,value:{'properties.linkGroup':linkGroup,...(state.tracks.find(t=>t.id===c.trackId)?.kind==='video'?{'properties.audioDetached':true}:{})}})));
    },
    moveClip(id, start, trackId) {
      const clip=editableClip(id);if(!clip||!Number.isFinite(start))return;
      const state=get(),group=selectedGroup(clip);if(!group)return;
      const track=state.tracks.find(t=>t.id===(trackId??clip.trackId)&&t.timelineId===clip.timelineId),previousTrack=state.tracks.find(t=>t.id===clip.trackId);
      if(!track||track.locked||track.kind!==previousTrack?.kind||Boolean(track.captionSets)!==isCaption(clip))return;
      const desired=connection.enabled?Math.max(0,start):clamp(start,0,durationOf(state)-clip.duration);
      const delta=Math.max(-Math.min(...group.map(c=>c.start)),desired-clip.start);
      if(!delta&&track.id===clip.trackId)return;
      const placements:Clip[]=[];
      for(const c of group){const original=state.tracks.find(t=>t.id===c.trackId)!;const target=track.id===clip.trackId?original:group.length>1&&original.kind===track.kind?state.tracks.find(t=>t.timelineId===clip.timelineId&&t.kind===original.kind&&t.number===original.number+track.number-previousTrack!.number):c.id===id?track:original;if(!target||target.locked)return;placements.push({...c,start:c.start+delta,trackId:target.id});}
      const changes=overwriteChanges(placements[0],group.map(c=>c.id),placements);if(!changes)return;
      changes.push(...placements.map(c=>({collection:'clips' as const,id:c.id,value:{start:c.start,trackId:c.trackId}})));
      commit('ClipMoved',id,`moved ${clip.name}`,changes);
    },
    fitTrim(id, start, duration) {
      const state=get(),clip=state.clips.find(c=>c.id===id&&c.projectId===state.projectId);
      return clip&&Number.isFinite(start)&&Number.isFinite(duration)?trimFit(clip,start,duration):null;
    },
    trimClip(id, start, duration) {
      const clip=editableClip(id);if(!clip||!Number.isFinite(start)||!Number.isFinite(duration)||duration<=0)return;
      const state=get(),group=editableGroup(clip);if(!group)return;
      const frame=1/(state.projects.find(p=>p.id===state.projectId)?.fps||24);
      if(clip.sourceIn===0&&Number(clip.properties.animationPresetDuration)===clip.duration) {
        const fit=trimFit(clip,start,duration);if(!fit)return;
        const nextDuration=fit.duration,next={...retimeTitleClip(clip,nextDuration,1/frame),start:fit.start},changes:Change[]=[];
        const overwritten=overwriteChanges(next);if(!overwritten)return;changes.push(...overwritten);
        const retimeContents=(parent:Clip,d:number,seen=new Set<string>()):boolean=>{
          if(!isComposition(parent))return true;const id=String(parent.properties.compositionId);if(seen.has(id)||!available(id,'*'))return false;seen.add(id);
          const timeline=state.timelines.find(t=>t.id===id);if(!timeline)return false;
          for(const child of state.clips.filter(c=>c.timelineId===id)) {
            if(child.start!==0||child.sourceIn!==0||Number(child.properties.animationPresetDuration)!==child.duration)continue;
            if(!editableClip(child.id,'*')||!retimeContents(child,d,seen))return false;
            const value=retimeTitleClip(child,d,1/frame);changes.push({collection:'clips',id:child.id,value:{duration:value.duration,properties:value.properties,keyframes:value.keyframes}});
          }
          changes.push({collection:'timelines',id,value:{duration:d}});return true;
        };
        if(!retimeContents(clip,nextDuration))return;
        changes.push({collection:'clips',id,value:{start:next.start,duration:next.duration,properties:next.properties,keyframes:next.keyframes}});
        commit('ClipTrimmed',id,`resized ${clip.name}`,changes);return;
      }
      const fit=trimFit(clip,start,duration);if(!fit)return;
      const target=trimmedClip(clip,fit.start,fit.duration,group);if(!target)return;
      const changes:Change[]=[];
      for(const c of group){const s=c.start+target.start-clip.start,d=c.duration+target.duration-clip.duration,value=c.id===id?target:trimmedClip(c,s,d,group);if(!value||Math.abs(value.start-s)>1e-6||Math.abs(value.duration-d)>1e-6){state.notify('Linked media has reached its source boundary','info');return;}const overwritten=overwriteChanges({...c,...value},group.map(c=>c.id));if(!overwritten)return;changes.push(...overwritten,{collection:'clips',id:c.id,value});}
      commit('ClipTrimmed',id,`trimmed ${clip.name}`,changes);
    },
    splitClip(id) {
      const clip=editableClip(id);if(!clip)return;
      const state=get(),group=editableGroup(clip);if(!group)return;
      const frame=1/(state.projects.find(p=>p.id===state.projectId)?.fps||24);
      if(group.some(c=>state.playhead-c.start<frame||c.start+c.duration-state.playhead<frame)){state.notify('Place the playhead inside the linked clips to split them','info');return;}
      const changes:Change[]=[],linkGroup=createId('link');let selected='';
      for(const c of group){const cut=cutClip(c,state.playhead,group.length>1?linkGroup:undefined);if(c.id===id)selected=cut.right.id;changes.push(...cut.changes);}
      commit('ClipTrimmed',id,`split ${clip.name} at the playhead`,changes);
      set({selectedClipId:selected,selectedTextIds:isTitle(clip)?[selected]:[],textSelection:null,selectedNodeId:get().nodes.find(n=>n.clipId===selected)?.id??null});
    },
    cutThrough(time) {
      const state=get();if(!Number.isFinite(time)||!writable())return 0;
      const fps=state.projects.find(p=>p.id===state.projectId)?.fps||24,at=Math.max(0,time),linked=state.settings.linkSelection!==false,{ids,crossing}=forwardSelection(state.clips,state.tracks,state.timelineId,at,fps,linked);
      const crossed=state.clips.filter(c=>crossing.includes(c.id)),cut=crossed.filter(c=>Math.min(at-c.start,c.start+c.duration-at)>=1/fps-1e-6),whole=crossed.length-cut.length;
      const reportWhole=()=>{if(whole)state.notify(`${whole} clip${whole>1?'s':''} within a frame of the line left whole`,'info');};
      if(!cut.length){reportWhole();return 0;}
      // A linked peer that moves with the selection follows the right halves into their new group; peers before the line stay with the left halves.
      const old=new Set(linked?cut.flatMap(c=>c.properties.linkGroup?[String(c.properties.linkGroup)]:[]):[]);
      const peers=old.size?state.clips.filter(c=>ids.includes(c.id)&&old.has(String(c.properties.linkGroup))):[];
      if(![...cut,...peers].every(c=>editableClip(c.id))||state.nodes.some(n=>cut.some(c=>c.id===n.clipId)&&!available(n.id,'*')))return 0;
      const groups=new Map<string,string>();
      for(const g of old)if([...cut,...peers].filter(c=>c.properties.linkGroup===g).length>1)groups.set(g,createId('link'));
      const changes:Change[]=[],rights:string[]=[];
      for(const c of cut){const part=cutClip(c,at,groups.get(String(c.properties.linkGroup)));rights.push(part.right.id);changes.push(...part.changes);}
      for(const c of peers){const group=groups.get(String(c.properties.linkGroup));if(group)changes.push({collection:'clips',id:c.id,value:{'properties.linkGroup':group}});}
      commit('ClipTrimmed',cut[0].id,`cut ${cut.length} clip${cut.length>1?'s':''} at ${Math.floor(at/60)}:${String(Math.floor(at%60)).padStart(2,'0')}`,changes);
      const now=get(),primary=now.selectedClipId;
      now.selectClips([...now.selectedClipIds.filter(id=>id!==primary),...rights,...(primary?[primary]:[])]);
      reportWhole();
      return cut.length;
    },
    deleteGap(trackId,start,end) {
      const state=get(),track=state.tracks.find(t=>t.id===trackId&&t.timelineId===state.timelineId);
      if(!track||track.locked||!writable())return;
      const clips=state.clips.filter(c=>c.trackId===trackId&&c.timelineId===state.timelineId),gap=trackGap(clips,start);
      if(!gap||gap.start!==start||gap.end!==end)return;
      // Linked audio rides along: closing a gap that shifts the video and leaves its peer behind
      // breaks sync, which is the one thing the link exists to prevent. Peers land on other tracks,
      // so the shift can now collide and goes through the same overwrite as a drag.
      const following=[...new Map(clips.filter(c=>c.start>=end).flatMap(linkedClips).filter(c=>c.start>=end).map(c=>[c.id,c])).values()];
      if(!following.length||!following.every(c=>editableClip(c.id)))return;
      const placements=following.map(c=>({...c,start:c.start-(end-start)}));
      const overwritten=overwriteChanges(placements[0],following.map(c=>c.id),placements);if(!overwritten)return;
      commit('PropertyChanged',trackId,'closed gap on '+track.name,[...overwritten,...placements.map(c=>({collection:'clips' as const,id:c.id,value:{start:c.start}}))]);
    },
    deleteClip(id) {
      const clip=editableClip(id,'*');if(!clip)return;
      const state=get(),group=selectedGroup(clip,'*');if(!group)return;const ids=new Set(group.map(c=>c.id));
      const nodes=state.nodes.filter(n=>ids.has(n.clipId));if(nodes.some(n=>!available(n.id,'*')))return;
      commit('ClipDeleted',id,`deleted ${clip.name}`,[...group.map(c=>({collection:'clips' as const,id:c.id,value:null,replace:true})),...state.comments.filter(c=>c.clipId&&ids.has(c.clipId)).map(c=>({collection:'comments' as const,id:c.id,value:{},unset:['clipId']})),...nodes.map(n=>({collection:'nodes' as const,id:n.id,value:null,replace:true}))]);
      if(state.selectedTransition&&ids.has(state.selectedTransition.clipId))set({selectedTransition:null});
      if(state.selectedClipId&&ids.has(state.selectedClipId))set({selectedClipId:null,selectedClipIds:[],selectedTextIds:[],textSelection:null,textPreview:[],selectedNodeId:null});
    },
    duplicateClip(id) { const clip = get().clips.find(item => item.id === id && item.projectId === get().projectId); if (clip) {const group=selectedGroup(clip)??[clip];insertClip(clip,clip.start+Math.max(...group.map(c=>c.start+c.duration))-Math.min(...group.map(c=>c.start)),`${clip.name} copy`);} },
    copyClip(id) { const clip = get().clips.find(item => item.id === id && item.projectId === get().projectId); if (clip) { const group=selectedGroup(clip)??[clip],ids=new Set(group.map(c=>c.id));set({ clipboard: structuredClone(clip),clipboardClips:structuredClone([clip,...group.filter(c=>c.id!==clip.id)]),clipboardNodes:structuredClone(get().nodes.filter(n=>ids.has(n.clipId))) }); get().notify('Clip copied'); } },
    pasteClip() { const state = get(); if (!state.clipboard) return; if (state.clipboard.projectId !== state.projectId || (!isTitle(state.clipboard) && !isShape(state.clipboard) && !isComposition(state.clipboard) && !state.media.some(media => media.id === state.clipboard!.mediaId && media.projectId === state.projectId))) { state.notify('Copy a clip from this project first', 'info'); return; } insertClip(state.clipboard, state.playhead,state.clipboard.name,true); },
    // A drop can carry the whole bin. Ready clips land end to end from the drop point, sharing one
    // gesture id so the hundred-clip drop is a single undo.
    addMediaToTimeline(mediaId, start, trackId) {
      const state = get();
      if (start !== undefined && !Number.isFinite(start)) return;
      const ids = Array.isArray(mediaId) ? mediaId : [mediaId];
      const assets = ids.map(id => state.media.find(asset => asset.id === id && asset.projectId === state.projectId)).filter((asset): asset is MediaAsset => asset?.status === 'ready');
      if (!assets.length) { state.notify('Media is still being prepared', 'info'); return; }
      if (assets.length < ids.length) state.notify(`Skipped ${ids.length - assets.length} clip${ids.length - assets.length === 1 ? '' : 's'} still being prepared`, 'info');
      const gesture = assets.length > 1 ? createId('gesture') : undefined;
      let at = Math.max(0, start ?? state.playhead);
      for (const asset of assets) {
        // A single drop on the wrong kind of track still refuses; only a mixed batch sends the odd
        // ones to their own lane rather than failing the whole drop.
        const lane = assets.length === 1 || state.tracks.find(track => track.id === trackId)?.kind === (asset.kind === 'audio' ? 'audio' : 'video') ? trackId : undefined;
        if (!insertMedia(asset, at, lane, gesture)) return;
        at += assetDuration(asset);
      }
    },
    updateTrack(id, patch, gesture) {
      const state = get(); const track = state.tracks.find(t => t.id === id && t.timelineId === state.timelineId);
      if (!track || !writable() || !available(id, '*')) return;
      const value: Record<string, unknown> = {};
      for (const key of ['muted', 'solo', 'locked', 'hidden'] as const) if (typeof patch[key] === 'boolean') value[key] = patch[key];
      if (typeof patch.name === 'string' && patch.name.trim()) value.name = patch.name.trim().slice(0, 80);
      if (Number.isFinite(patch.gain)) value.gain = clamp(patch.gain!, -60, 24);
      if (Number.isFinite(patch.pan)) value.pan = clamp(patch.pan!, -100, 100);
      if (Number.isFinite(patch.height)) value.height = Math.round(clamp(patch.height!, TRACK_MIN_HEIGHT, TRACK_MAX_HEIGHT));
      if (Object.keys(value).length) commit('TrackChanged', id, `updated ${track.name}`, [{ collection: 'tracks', id, value }], gesture);
    },
    // Order is derived from `number`, so a move is a swap with the neighbour: the clips stay with
    // their track and the V1/A1 labels renumber themselves.
    moveTrack(id, direction) {
      const state = get(); const track = state.tracks.find(t => t.id === id && t.timelineId === state.timelineId);
      if (!track || !writable() || !available(id, '*')) return;
      // Video lanes render highest number first, audio lowest first, so "up" steps opposite ways.
      const step = (direction === 'up' ? 1 : -1) * (track.kind === 'video' ? 1 : -1);
      const neighbour = state.tracks
        .filter(t => t.timelineId === state.timelineId && t.kind === track.kind && Boolean(t.captionSets) === Boolean(track.captionSets) && (t.number - track.number) * step > 0)
        .sort((a, b) => (a.number - b.number) * step)[0];
      if (!neighbour || !available(neighbour.id, '*')) return;
      commit('TrackChanged', id, `moved ${track.name} ${direction}`, [
        { collection: 'tracks', id, value: { number: neighbour.number } },
        { collection: 'tracks', id: neighbour.id, value: { number: track.number } },
      ]);
    },
    // Removing a lane takes its clips with it and closes the numbering gap, all in one undoable edit.
    deleteTrack(id) {
      const state = get(); const track = state.tracks.find(t => t.id === id && t.timelineId === state.timelineId);
      if (!track || !writable() || !available(id, '*')) return;
      if (track.locked) { state.notify('Track is locked', 'info', 'Unlock the track before deleting it.'); return; }
      const siblings = state.tracks.filter(t => t.timelineId === state.timelineId && t.kind === track.kind);
      if (siblings.length < 2) { state.notify('Keep at least one track', 'info', `A timeline needs one ${track.kind} track.`); return; }
      const doomed = state.clips.filter(c => c.trackId === id);
      const changes: Change[] = [
        // `replace` is what makes a deletion undoable: it snapshots the whole record, not just keys.
        ...doomed.map(c => ({ collection: 'clips' as const, id: c.id, value: null, replace: true })),
        ...state.nodes.filter(n => doomed.some(c => c.id === n.clipId)).map(n => ({ collection: 'nodes' as const, id: n.id, value: null, replace: true })),
        { collection: 'tracks', id, value: null, replace: true },
        ...siblings.filter(t => t.number > track.number).map(t => ({ collection: 'tracks' as const, id: t.id, value: { number: t.number - 1 } })),
      ];
      commit('TrackChanged', id, `deleted ${track.name}`, changes);
      if (doomed.some(c => c.id === state.selectedClipId)) set({ selectedClipId: null, selectedClipIds: [], selectedTextIds: [], textSelection: null, textPreview: [], selectedNodeId: null });
    },
    createTrack(kind) {
      const state = get(); if (!writable()) return;
      const number = Math.max(0, ...state.tracks.filter(t => t.timelineId === state.timelineId && t.kind === kind).map(t => t.number)) + 1;
      const track: Track = { id: createId('track'), timelineId: state.timelineId, name: `${kind === 'video' ? 'Video' : 'Audio'} ${number}`, kind, number, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 };
      commit('TrackCreated', track.id, `added ${track.name}`, [{ collection: 'tracks', id: track.id, value: record(track), replace: true }]);
    },
    setTimeline(id) { const state = get(); const timeline = state.timelines.find(t => t.id === id && t.projectId === state.projectId); if (!timeline) return; const clip = state.clips.find(c => c.timelineId === id); set({ selectedTransition:null,compositionTrail:[],selectedClipIds:clip?[clip.id]:[],shapeTool:null, timelineId: id, selectedTextIds: clip && isTitle(clip) ? [clip.id] : [], textSelection: null, textTool: false, textPreview: [], selectedClipId: clip?.id ?? null, selectedNodeId: null, playhead: 0, ...initialRange(state, id), revealedMediaId: null, playing: false, liveMode: 'independent', followUserId: null, locks: state.locks.filter(lock => lock.userId !== state.currentUserId) }); },
    selectTransition(clipId, side) {
      // Deliberately no clip selection: a transition is stored on the incoming clip, and selecting
      // that clip alongside it lit up the whole second shot on the timeline. The inspector reads
      // `selectedTransition` for its subject, so it does not need one.
      set({ selectedTransition: { clipId, side }, selectedClipId: null, selectedClipIds: [], selectedTextIds: [], textSelection: null, selectedNodeId: null, sidePanel: 'inspector', inspectorTab: 'Transition' });
    },
    loadLeaks() {
      if (!connection.enabled) return;
      const userId = get().currentUserId;
      void api<{ leaks: EditorStore['leaks']; presets: TransitionPreset[]; favorites: string[] }>('/transitions')
        .then(result => { if (get().currentUserId === userId) set({ leaks: result.leaks ?? [], transitionPresets: result.presets ?? [], transitionFavorites: result.favorites ?? [] }); })
        .catch(() => { /* The pack is optional; the rest of the library still works without it. */ });
    },
    async saveTransitionPreset(clipId, side) {
      if (!connection.enabled) { get().notify('Sign in to save shared presets', 'info'); return; }
      try {
        const userId = get().currentUserId;
        await (await import('../services/sync')).flushChanges();
        if (get().currentUserId !== userId || get().saveStatus !== 'Saved') throw new Error('Save the timeline before saving its preset.');
        const { preset } = await api<{ preset: TransitionPreset }>('/transitions/presets', { method: 'PUT', body: JSON.stringify({ clipId, side }) });
        if (get().currentUserId !== userId) return;
        set({ transitionPresets: [...get().transitionPresets.filter(item => item.id !== preset.id), preset] });
        get().notify('Transition preset saved for everyone', 'success');
      } catch (error) { get().notify('Could not save transition preset', 'error', error instanceof Error ? error.message : undefined); }
    },
    async toggleTransitionFavorite(id) {
      if (!connection.enabled) { get().notify('Sign in to save favorites', 'info'); return; }
      const userId = get().currentUserId, favorite = !get().transitionFavorites.includes(id);
      try {
        const result = await api<{ favorites: string[] }>('/transitions/favorites', { method: 'PUT', body: JSON.stringify({ id, favorite }) });
        if (get().currentUserId === userId) set({ transitionFavorites: result.favorites });
      } catch (error) { get().notify('Could not save favorite', 'error', error instanceof Error ? error.message : undefined); }
    },
    async addLeak(file) {
      const state = get();
      if (!connection.enabled) { state.notify('Sign in to add shared overlays', 'info'); return; }
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
      try {
        const { leak } = await api<{ leak: EditorStore['leaks'][number] }>(`/transitions?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        set({ leaks: [...get().leaks, leak] });
        state.notify(`${leak.name} added to the overlay pack`, 'success');
      } catch (error) { state.notify('That overlay could not be added', 'error', error instanceof Error ? error.message : undefined); }
    },
    addTransition(clipId, side, name, patch) {
      const clip = editableClip(clipId, 'transition');
      const definition = transitionDefinitions[name];
      if (!clip || !definition) return;
      if(isCaption(clip)){get().notify('Choose an animation preset in Captions','info');return;}
      const state = get();
      const track = state.tracks.find(item => item.id === clip.trackId);
      if (track?.kind !== 'video') { state.notify('Transitions apply to video clips', 'info'); return; }
      // A shared cut belongs to the incoming clip, so a tail transition needs an empty tail.
      if (side === 'out' && neighbourAt(state.clips, clip, 'out')) { state.notify('That cut already has a following clip', 'info'); return; }
      const preferred = Number(String(state.settings.defaultTransitionDuration ?? '').match(/[\d.]+/)?.[0]);
      const preset = state.transitionPresets.find(item => item.id === transitionPresetId(name, patch?.params ?? {}));
      const wanted = patch?.duration ?? preset?.duration ?? (Number.isFinite(preferred) && preferred > 0 ? preferred : definition.defaultDuration ?? 1);
      // Handles are routinely one-sided. Rather than refuse a cut where one clip has a second to
      // spare, sit the window on the side that has the frames — Premiere's "start/end at cut".
      const params = { ...preset?.params, ...patch?.params };
      if (definition.overlay && params.blendPoint === undefined) params.blendPoint = Math.round((state.leaks.find(item => item.id === params.leak)?.peakAt ?? .5) * 100);
      const candidate = { ...clip, ...(side === 'in' ? { transition: name } : {}), properties: { ...clip.properties, ...(side === 'out' ? { transitionOut: name } : {}), [transitionProperty(side, 'Params')]: JSON.stringify(params) } };
      const align = patch?.align ?? preset?.align ?? bestAlign(state.clips, candidate, side, state.media, wanted);
      // Two clips dropped in whole have no handles at all. That is the common way to build a
      // timeline, so the cut takes the transition anyway with the outgoing clip holding its last
      // frame, and the editor is told rather than refused.
      const handles = maximumDuration(state.clips, candidate, side, align, state.media);
      const room = maximumDuration(state.clips, candidate, side, align, state.media, true);
      if (room < 1 / 48) {
        const outgoing = side === 'in' ? neighbourAt(state.clips, clip, 'in') : clip;
        state.notify(`${outgoing ? 'That cut has less than a frame of clip beside it' : 'That cut has no clip beside it'} — there is nothing for a transition to read`, 'error');
        return;
      }
      const duration = Math.min(wanted, room);
      const value: Record<string, unknown> = {
        ...(side === 'in' ? { transition: name } : {}),
        properties: {
          ...clip.properties,
          ...(side === 'out' ? { transitionOut: name } : {}),
          [transitionProperty(side, 'Duration')]: duration,
          [transitionProperty(side, 'Align')]: align,
          [transitionProperty(side, 'Curve')]: (preset?.curve ?? definition.defaultCurve ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3]).join(','),
          [transitionProperty(side, 'Params')]: JSON.stringify(params),
        },
      };
      commit('PropertyChanged', clipId, `added ${name} to ${clip.name}`, [{ collection: 'clips', id: clipId, value }]);
      if (duration > handles + 1e-6) state.notify(`${name} added, holding ${(duration - handles).toFixed(2)}s of frozen frame`, 'info', 'Neither clip has trim handles left. Trim a frame off either side of the cut for a transition that reads real footage.');
      else if (duration < wanted - 1e-6) state.notify(`${name} shortened to ${duration.toFixed(2)}s — that is all the handles allow`, 'info');
      get().selectTransition(clipId, side);
    },
    updateTransition(clipId, side, patch, gesture) {
      const clip = editableClip(clipId, 'transition');
      if (!clip || !transitionName(clip, side)) return;
      const state = get();
      const name = patch.name && transitionDefinitions[patch.name] ? patch.name : transitionName(clip, side);
      const align = patch.align ?? transitionAlign(clip, side);
      const params = patch.params ? { ...transitionParams(clip, side), ...patch.params } : undefined;
      if (params && patch.params?.leak !== undefined && patch.params.leak !== transitionParams(clip, side).leak && patch.params.blendPoint === undefined) {
        params.leakIn = patch.params.leakIn ?? 0;
        params.leakOut = patch.params.leakOut ?? 0;
        params.blendPoint = Math.round((state.leaks.find(item => item.id === params.leak)?.peakAt ?? .5) * 100);
      }
      let trimmedDuration: number | undefined;
      if (params && (patch.params?.leakIn !== undefined || patch.params?.leakOut !== undefined)) {
        const asset = state.leaks.find(item => item.id === params.leak);
        if (asset) {
          const current = timelineTransitions(state.clips, clip.timelineId, state.media).find(item => item.clipId === clipId && item.side === side);
          if (current) {
            const trimmed = trimLeak(current, asset.duration, patch.params);
            Object.assign(params, trimmed.params);
            trimmedDuration = trimmed.duration;
          }
        }
      }
      const candidate = { ...clip, ...(side === 'in' ? { transition: name } : {}), properties: { ...clip.properties, ...(side === 'out' ? { transitionOut: name } : {}), ...(params ? { [transitionProperty(side, 'Params')]: JSON.stringify(params) } : {}) } };
      const room = maximumDuration(state.clips, candidate, side, align, state.media, true);
      const wanted = patch.duration ?? trimmedDuration ?? transitionDuration(clip, side);
      if (trimmedDuration !== undefined && (wanted > room + 1e-6 || wanted < 1 / 240)) return;
      if (patch.duration !== undefined && !Number.isFinite(patch.duration)) return;
      const duration = Math.max(1 / 240, Math.min(wanted, room > 0 ? room : wanted));
      const value: Record<string, unknown> = {
        ...(side === 'in' && patch.name ? { transition: name } : {}),
        properties: {
          ...clip.properties,
          ...(side === 'out' && patch.name ? { transitionOut: name } : {}),
          [transitionProperty(side, 'Duration')]: duration,
          [transitionProperty(side, 'Align')]: align,
          ...(patch.curve ? { [transitionProperty(side, 'Curve')]: patch.curve.join(',') } : {}),
          ...(params ? { [transitionProperty(side, 'Params')]: JSON.stringify(params) } : {}),
        },
      };
      commit('PropertyChanged', clipId, `changed ${name} on ${clip.name}`, [{ collection: 'clips', id: clipId, value }], gesture);
    },
    removeTransition(clipId, side) {
      const clip = editableClip(clipId, 'transition');
      if (!clip) return;
      const name = transitionName(clip, side);
      if (!name) return;
      const properties = { ...clip.properties };
      for (const key of transitionFields(side)) delete properties[key];
      if (side === 'out') delete properties.transitionOut;
      commit('PropertyChanged', clipId, `removed ${name} from ${clip.name}`, [{
        collection: 'clips', id: clipId,
        value: { ...(side === 'in' ? { transition: '' } : {}), properties },
        unset: [...transitionFields(side), ...(side === 'out' ? ['transitionOut'] : [])],
      }]);
      if (get().selectedTransition?.clipId === clipId) set({ selectedTransition: null });
    },
    expandTransitionAudio(clipId, side) {
      const clip = editableClip(clipId, 'transition');
      if (!clip) return;
      const state = get();
      const params = transitionParams(clip, side);
      const leak = String(params.leak ?? '');
      const asset = state.leaks.find(item => item.id === leak);
      if (!transitionDefinitions[transitionName(clip, side)]?.overlay || !leak) { state.notify('Only overlay transitions carry sound', 'info'); return; }
      // A pointer to a clip the user has since deleted is stale, not a reason to refuse.
      const existing = String(clip.properties[transitionProperty(side, 'AudioId')] ?? '');
      if (existing && state.clips.some(item => item.id === existing)) { state.notify('That sound is already on a track', 'info'); return; }
      const videoTrack = state.tracks.find(item => item.id === clip.trackId);
      if (!videoTrack) return;
      const changes: Change[] = [];
      const window = timelineTransitions(state.clips, clip.timelineId, state.media).find(item => item.clipId === clipId && item.side === side);
      if (!window) return;
      const { duration, start } = window;
      let track = leakAudioTrack(state.tracks, videoTrack, state.clips, start, start + duration);
      if (!track) {
        const number = Math.max(0, ...state.tracks.filter(item => item.timelineId === videoTrack.timelineId && item.kind === 'audio').map(item => item.number)) + 1;
        track = { id: createId('track'), timelineId: videoTrack.timelineId, name: `Audio ${number}`, kind: 'audio', number, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 };
        changes.push({ collection: 'tracks', id: track.id, value: record(track), replace: true });
      }
      const audioClip: Clip = {
        id: createId('clip'), projectId: clip.projectId, timelineId: clip.timelineId, trackId: track.id,
        mediaId: leakMediaId(leak), name: `${asset?.name ?? 'Light leak'} sound`,
        start, duration, sourceIn: leakRange(params, asset?.duration ?? duration).start, color: '#c7a2e8', disabled: false,
        properties: { gain: Number(params.leakGain ?? -6), speed: leakRange(params, asset?.duration ?? duration).duration / duration * 100 }, effects: [],
      };
      changes.push({ collection: 'clips', id: audioClip.id, value: record(audioClip), replace: true });
      changes.push({ collection: 'clips', id: clipId, value: { properties: { ...clip.properties, [transitionProperty(side, 'AudioId')]: audioClip.id } } });
      commit('ClipAdded', audioClip.id, `expanded ${clip.name} transition sound`, changes);
      state.notify(`Transition sound moved to ${track.name}`, 'success');
    },
    applyTransitionAtPlayhead(name, params) {
      const state = get();
      const chosen = name && transitionDefinitions[name] ? name : String(state.settings.defaultTransition ?? defaultTransition);
      const clip = state.clips.find(item => item.id === state.selectedClipId) ?? null;
      const lane = state.clips.filter(item => item.timelineId === state.timelineId && !item.disabled
        && (clip ? item.trackId === clip.trackId : state.tracks.find(track => track.id === item.trackId)?.kind === 'video'));
      let best: { id: string; side: TransitionSide; distance: number } | null = null;
      for (const item of lane) for (const side of ['in', 'out'] as TransitionSide[]) {
        if (side === 'out' && neighbourAt(lane, item, 'out')) continue;
        const distance = Math.abs((side === 'in' ? item.start : item.start + item.duration) - state.playhead);
        if (!best || distance < best.distance) best = { id: item.id, side, distance };
      }
      if (!best) { state.notify('No cut near the playhead', 'info'); return; }
      get().addTransition(best.id, best.side, chosen, params ? { params } : undefined);
    },
    addSmartMask(clipId,nodeId) {
      const state=get(),clip=editableClip(clipId,'smartMasks'),asset=state.media.find(m=>m.id===clip?.mediaId);
      if(!clip||!asset||asset.kind!=='video')return;
      const node=nodeId?state.nodes.find(n=>n.id===nodeId&&n.clipId===clipId):undefined;
      if(nodeId&&(!node||!editableClip(clipId,'grade')||!available(nodeId,'*')))return;
      if(!nodeId&&!editableClip(clipId,'effects'))return;
      if((clip.smartMasks?.length??0)>=32){state.notify('A clip supports up to 32 subject masks','info');return;}
      if(node?.effects?.some(e=>e.enabled&&e.type==='cst')){state.notify('Use a correction node without color-space transforms for a mask','info');return;}
      const mask=createSmartMask(clip,asset,createId('mask'));
      const changes:Change[]=[{collection:'clips',id:clipId,value:{smartMasks:[...(clip.smartMasks??[]),mask],...(!nodeId?{effects:[...clip.effects,{id:createId('effect'),name:'Smart Mask',enabled:true,amount:100,maskId:mask.id}]}:{})}}];
      if(node)changes.push({collection:'nodes',id:node.id,value:{mask:{id:mask.id,enabled:true,invert:false,amount:100}}});
      commit('EffectAdded',clipId,`added Smart Mask to ${node?.name??clip.name}`,changes);
      set({selectedClipId:clipId,...(node?{selectedNodeId:node.id}:{sidePanel:'inspector' as const,inspectorTab:'Effects'})});
    },
    updateSmartMask(clipId,maskId,patch,gesture) {
      const clip=editableClip(clipId,'smartMasks'),original=clip?.smartMasks?.find(m=>m.id===maskId);if(!clip||!original)return;
      const mask={...structuredClone(original),...structuredClone(patch),id:original.id,source:original.source};
      try{validateSmartMask(mask);}catch(error){get().notify((error as Error).message,'error');return;}
      // Keep the prior cache as a source-frame reference; signature checks prevent stale matte use.
      if(mask.result&&patch.result&&mask.result.signature!==smartMaskSignature(mask))return;
      commit('PropertyChanged',clipId,`updated ${mask.name}`,[{collection:'clips',id:clipId,value:{smartMasks:clip.smartMasks!.map(m=>m.id===maskId?mask:m)}}],gesture);
    },
    attachSmartMask(clipId,maskId,targetId) {
      const clip=editableClip(clipId,'smartMasks');if(!clip?.smartMasks?.some(m=>m.id===maskId))return;
      const node=get().nodes.find(n=>n.id===targetId&&n.clipId===clipId);
      if(node?.effects?.some(e=>e.enabled&&e.type==='cst')){get().notify('Use a correction node without color-space transforms for a mask','info');return;}
      if(node){if(!editableClip(clipId,'grade')||!available(node.id,'*'))return;commit('GradeNodeChanged',node.id,'changed node mask',[{collection:'nodes',id:node.id,value:{mask:{id:maskId,enabled:true,invert:false,amount:100}}}]);}
      else if(clip.effects.some(e=>e.id===targetId&&e.name==='Smart Mask')&&editableClip(clipId,'effects'))commit('PropertyChanged',clipId,'changed clip mask',[{collection:'clips',id:clipId,value:{effects:clip.effects.map(e=>e.id===targetId?{...e,maskId}:e)}}]);
    },
    addMotionTracker(clipId,at) {
      const state=get(),clip=editableClip(clipId,'motionTrackers'),asset=state.media.find(m=>m.id===clip?.mediaId);
      if(!clip||!asset||asset.kind!=='video'||isTitle(clip)||isShape(clip)||isComposition(clip))return;
      const existing=clip.motionTrackers??[];
      if(existing.length>=MAX_TRACKERS){state.notify(`A clip supports up to ${MAX_TRACKERS} trackers`,'info');return;}
      // Names and colours carry on from the highest one in use, so a deleted tracker never leaves a duplicate.
      const index=Math.max(existing.length,...existing.map(t=>Number(/^Track (\d+)$/.exec(t.name)?.[1]??0)));
      const tracker=createMotionTracker(asset,createId('tracker'),index,at);
      commit('PropertyChanged',clipId,`added ${tracker.name} to ${clip.name}`,[{collection:'clips',id:clipId,value:{motionTrackers:[...existing,tracker]}}]);
      return tracker.id;
    },
    updateMotionTracker(clipId,trackerId,patch,gesture) {
      const clip=editableClip(clipId,'motionTrackers'),original=clip?.motionTrackers?.find(t=>t.id===trackerId);if(!clip||!original)return;
      const tracker:MotionTracker={...structuredClone(original),...structuredClone(patch),id:original.id,source:original.source};
      for(const key of ['result','links'] as const)if(key in patch&&patch[key]===undefined)delete tracker[key];
      try{validateMotionTracker(tracker);}catch(error){get().notify((error as Error).message,'error');return;}
      commit('PropertyChanged',clipId,`updated ${tracker.name}`,[{collection:'clips',id:clipId,value:{motionTrackers:clip.motionTrackers!.map(t=>t.id===trackerId?tracker:t)}}],gesture);
    },
    deleteMotionTracker(clipId,trackerId) {
      const clip=editableClip(clipId,'motionTrackers'),tracker=clip?.motionTrackers?.find(t=>t.id===trackerId);if(!clip||!tracker)return;
      const rest=clip.motionTrackers!.filter(t=>t.id!==trackerId);
      commit('PropertyChanged',clipId,`removed ${tracker.name}`,[{collection:'clips',id:clipId,value:rest.length?{motionTrackers:rest}:{},...(rest.length?{}:{unset:['motionTrackers']})}]);
    },
    applyMotionTracker(clipId,trackerId,targetId,channels,link) {
      const clip=editableClip(clipId,'motionTrackers'),tracker=clip?.motionTrackers?.find(t=>t.id===trackerId);if(!clip||!tracker)return false;
      const target=targetId===clipId?clip:editableClip(targetId,'*');if(!target)return false;
      if(targetId===clipId&&!available(clipId,'*'))return false;
      const keyframes={...target.keyframes,...channels};
      try{validateKeyframes(keyframes);}catch(error){get().notify(`The track could not be applied: ${(error as Error).message}`,'error');return false;}
      const updated:MotionTracker={...structuredClone(tracker),links:[...(tracker.links??[]).filter(l=>l.clipId!==targetId),link]};
      try{validateMotionTracker(updated);}catch(error){get().notify((error as Error).message,'error');return false;}
      const trackers=clip.motionTrackers!.map(t=>t.id===trackerId?updated:t);
      const changes:Change[]=targetId===clipId?[{collection:'clips',id:clipId,value:{keyframes,motionTrackers:trackers}}]:[{collection:'clips',id:targetId,value:{keyframes}},{collection:'clips',id:clipId,value:{motionTrackers:trackers}}];
      commit('PropertyChanged',targetId,link.target==='camera'?`made ${clip.name} follow ${tracker.name}`:`attached ${target.name} to ${tracker.name}`,changes);
      return true;
    },
    addEffect(clipId, name) {
      if(name==='Smart Mask'){get().addSmartMask(clipId);return;}
      const clip = editableClip(clipId, 'effects');
      if (!clip || !acceptsEffect(clip, get().media.find(m => m.id === clip.mediaId)?.kind, name)) return;
      commit('EffectAdded', clipId, `added ${name} to ${clip.name}`, [{ collection: 'clips', id: clipId, value: { effects: [...clip.effects, { id: createId('effect'), name, enabled: true, amount: 50 }] } }]);
      set({ selectedClipId: clipId, selectedTextIds: [], textSelection: null, sidePanel: 'inspector', inspectorTab: 'Effects' });
    },
    updateEffect(clipId, effectId, patch, gesture) {
      const clip = editableClip(clipId, 'effects');
      const effect = clip?.effects.find(effect => effect.id === effectId);
      if (!clip || !effect || patch?.amount !== undefined && !Number.isFinite(patch.amount)) return;
      const parameters: Record<string, number> = {};
      for (const [key, value] of Object.entries(patch?.parameters ?? {})) {
        const definition = effectDefinitions[effect.name]?.parameters.find(p => p.key === key && key !== 'amount');
        if (!definition || !Number.isFinite(value)) return;
        parameters[key] = clamp(value, definition.min, definition.max);
      }
      const effects = patch === null ? clip.effects.filter(e => e.id !== effectId) : clip.effects.map(e => e.id === effectId ? { ...e, ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}), ...(patch.amount !== undefined ? { amount: clamp(patch.amount, 0, 100) } : {}), ...(patch.parameters ? { parameters: { ...e.parameters, ...parameters } } : {}) } : e);
      const keyframes={...clip.keyframes};
      if(patch) for(const property of animationProperties({...clip,effects}).filter(p=>p.path.startsWith(`effects.${effectId}.`)&&keyframes[p.path])) {
        const before=animationProperties(clip).find(p=>p.path===property.path); if(before?.value===property.value)continue;
        const fps=get().projects.find(p=>p.id===clip.projectId)?.fps||24,time=frameTime(clamp(get().playhead-clip.start,0,clip.duration-1/fps),fps);
        keyframes[property.path]=[...keyframes[property.path].filter(k=>Math.abs(k.time-time)>.5/fps),{id:createId('key'),time,value:property.value,interpolation:typeof property.value==='number'?'linear' as const:'hold' as const}].sort((a,b)=>a.time-b.time);
      } else for(const path of Object.keys(keyframes))if(path.startsWith(`effects.${effectId}.`))delete keyframes[path];
      commit('PropertyChanged', clipId, `${patch === null ? 'removed' : 'changed'} ${effect.name} on ${clip.name}`, [{ collection: 'clips', id: clipId, value: { effects, ...(clip.keyframes?{keyframes}:{}), ...(patch?.enabled && clip.properties[`${effect.name}_enabled`] === false ? { [`properties.${effect.name}_enabled`]: true } : {}) } }], gesture);
    },
    reorderEffect(clipId, effectId, direction) {
      const clip = editableClip(clipId, 'effects'); if (!clip || ![-1, 1].includes(direction)) return;
      const index = clip.effects.findIndex(effect => effect.id === effectId), next = index + direction;
      if (index < 0 || next < 0 || next >= clip.effects.length) return;
      const effects = [...clip.effects]; [effects[index], effects[next]] = [effects[next], effects[index]];
      commit('PropertyChanged', clipId, `reordered effects on ${clip.name}`, [{ collection: 'clips', id: clipId, value: { effects } }]);
    },
    addNode(name, parameters) {
      const state = get(); if (!state.selectedClipId || !editableClip(state.selectedClipId, 'grade')) { if (!state.selectedClipId) state.notify('Select a clip to add a color node', 'info'); return; }
      const node = colorService.createNode(name, state.projectId, state.selectedClipId, parameters);
      const nodes=state.nodes.filter(n=>n.clipId===state.selectedClipId).sort((a,b)=>(a.order??0)-(b.order??0));
      const selected=nodes.findIndex(n=>n.id===state.selectedNodeId),output=nodes.findIndex(n=>n.effects?.some(e=>e.type==='cst'&&e.outputGamut==='Rec.709'));
      const index=selected>=0?(selected===output?selected:selected+1):output>=0?output:nodes.length;
      if(nodes.some(n=>!available(n.id,'*')))return;
      node.position={x:(nodes[index-1]?.position?.x??-110)+170,y:nodes[index-1]?.position?.y??80};node.order=index+1;
      nodes.splice(index,0,node);
      commit('GradeNodeAdded', node.id, `added ${node.name} color node`, nodes.map((n,i)=>({collection:'nodes' as const,id:n.id,value:n.id===node.id?{...record(n),order:i+1}:{order:i+1},...(n.id===node.id?{replace:true}:{})}))); set({ selectedNodeId: node.id });
    },
    removeNode(id) {
      const node=get().nodes.find(n=>n.id===id); if(!node || !editableClip(node.clipId,'grade') || !available(id,'*'))return;
      const clip=get().clips.find(c=>c.id===node.clipId)!;
      const keyframes=Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>!path.startsWith(`nodes.${id}.`)));
      commit('GradeNodeChanged',id,`removed ${node.name}`,[{collection:'nodes',id,value:null},...(clip.keyframes?[{collection:'clips' as const,id:clip.id,value:{keyframes}}]:[])]);
      set({selectedNodeId:get().nodes.filter(n=>n.clipId===node.clipId).sort((a,b)=>(a.order??0)-(b.order??0))[0]?.id??null});
    },
    reorderNode(id,direction) {
      const node=get().nodes.find(n=>n.id===id); if(!node || !editableClip(node.clipId,'grade') || ![-1,1].includes(direction))return;
      const nodes=get().nodes.filter(n=>n.clipId===node.clipId).sort((a,b)=>(a.order??0)-(b.order??0)), index=nodes.findIndex(n=>n.id===id), next=index+direction;
      if(next<0 || next>=nodes.length || nodes.some(n=>!available(n.id,'*')))return;
      [nodes[index],nodes[next]]=[nodes[next],nodes[index]];
      commit('GradeNodeChanged',id,'reordered grade nodes',nodes.map((n,i)=>({collection:'nodes' as const,id:n.id,value:{order:i+1}})));
    },
    copyGrade(clipId) {
      const state=get(),clip=state.clips.find(c=>c.id===clipId&&c.projectId===state.projectId);
      if(!clip)return;
      set({gradeClipboard:structuredClone({clip,nodes:state.nodes.filter(n=>n.clipId===clipId)})});
      state.notify('Grade copied','success');
    },
    pasteGrade(clipId) {
      const state=get(),source=state.gradeClipboard,clip=editableClip(clipId,'*');if(!source||!clip)return;
      if(source.clip.projectId!==clip.projectId){state.notify('Copy a grade from this project first','info');return;}
      const old=state.nodes.filter(n=>n.clipId===clipId);if(old.some(n=>!available(n.id,'*')))return;
      const fields=['colorPipeline','inputProfile','inputGamut','dataLevels','inputExposure','inputTemperature','resolveLookUrl','bypassResolveLook','resolveNodeNames'];
      const isGrade=(path:string)=>path.startsWith('nodes.')||fields.some(key=>path===`properties.${key}`);
      const copy={...clip,keyframes:structuredClone(Object.fromEntries(Object.entries(source.clip.keyframes??{}).filter(([path])=>isGrade(path))))};
      const nodes=copyAnimatedNodes(copy,source.nodes,()=>createId('grade'));
      const sameSource=source.clip.mediaId===clip.mediaId;
      const masks=sameSource?structuredClone(source.clip.smartMasks??[]):[];
      const maskIds=new Map(masks.map(mask=>[mask.id,createId('mask')]));
      for(const mask of masks)mask.id=maskIds.get(mask.id)!;
      for(const node of nodes)if(node.mask){const id=maskIds.get(node.mask.id);if(id)node.mask={...node.mask,id};else delete node.mask;}
      const value:Record<string,unknown>={...(masks.length?{smartMasks:[...(clip.smartMasks??[]),...masks]}:{}),keyframes:{...Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>!isGrade(path))),...copy.keyframes}};
      const unset:string[]=[];
      for(const key of fields){if(source.clip.properties[key]===undefined)unset.push(`properties.${key}`);else value[`properties.${key}`]=source.clip.properties[key];}
      commit('GradeNodeChanged',clipId,`replaced grade on ${clip.name}`, [
        ...old.map(n=>({collection:'nodes' as const,id:n.id,value:null})),
        {collection:'clips',id:clipId,value,unset},
        ...nodes.map(n=>({collection:'nodes' as const,id:n.id,value:record(n),replace:true})),
      ]);set({selectedNodeId:nodes[0]?.id??null});
    },
    restoreResolveGrade(clipId) {
      const state=get(),clip=editableClip(clipId,'*');if(!clip?.properties.resolveLookUrl)return;
      const old=state.nodes.filter(n=>n.clipId===clipId);if(old.some(n=>!available(n.id,'*')))return;
      state.saveSnapshot(`Before restoring DaVinci grade: ${clip.name}`,'Preserved the editable grade.');
      const keyframes=Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>!path.startsWith('nodes.')));
      commit('GradeNodeChanged',clipId,'restored imported DaVinci grade',[
        ...old.map(n=>({collection:'nodes' as const,id:n.id,value:null})),
        {collection:'clips',id:clipId,value:{'properties.colorPipeline':'legacy','properties.bypassResolveLook':false,'properties.inputExposure':0,'properties.inputTemperature':0,keyframes}},
      ]);set({selectedNodeId:null});
    },
    initializeColorGrade(clipId) {
      const state=get(),clip=editableClip(clipId,'grade');if(!clip)return;
      const old=state.nodes.filter(n=>n.clipId===clipId);if(old.some(n=>!available(n.id,'*')))return;
      const asset=state.media.find(m=>m.id===clip.mediaId),source=interpretation(clip,asset),nodes=starterGrade(clip,asset,()=>createId('grade'));
      const output=nodes[3].effects![0];if(output.type==='cst'){output.toneMapping=['Rec.709','Gamma 2.4'].includes(source.profile)?'none':'aces2';output.gamutMapping='none';}
      state.saveSnapshot(`Before new grade: ${clip.name}`,'Preserved before starting the wide-gamut grade.');
      const keyframes=Object.fromEntries(Object.entries(clip.keyframes??{}).filter(([path])=>!path.startsWith('nodes.')));
      commit('GradeNodeAdded',clipId,'started a wide-gamut grade',[
        ...old.map(n=>({collection:'nodes' as const,id:n.id,value:null})),
        {collection:'clips',id:clipId,value:{'properties.colorPipeline':'nodes-v2','properties.inputProfile':source.profile,'properties.inputGamut':source.gamut,keyframes}},
        ...nodes.map(n=>({collection:'nodes' as const,id:n.id,value:record(n),replace:true})),
      ]);set({selectedNodeId:nodes[1].id,selectedClipId:clipId});
    },
    applyColorAssistant(result,option,clipIds=[]) {
      const state=get();if(!writable())return 0;
      const choice=result.mode==='looks'?result.looks?.[option??-1]:undefined;
      const targets=new Map<string,Parameters<typeof proposedNodes>[2]>(result.mode==='looks'?choice?clipIds.map(id=>[id,{look:{look:choice.look,extraNodes:choice.extraNodes}}]):[]:(result.shots??[]).map(shot=>[shot.clipId,{balance:shot.balance}]));
      const changes:Change[]=[],applied:string[]=[],skipped:string[]=[];
      try{
        for(const [id,change] of targets){
          const clip=state.clips.find(c=>c.id===id&&c.projectId===state.projectId);
          if(!clip||!eligibility(clip,state.media.find(m=>m.id===clip.mediaId),state.nodes).ok||!editableClip(id,'grade')){skipped.push(clip?.name??id);continue;}
          const proposal=proposedNodes(clip,state.nodes,change,prefix=>createId(prefix)).changes,existing=(id:string)=>state.nodes.some(n=>n.id===id);
          if(proposal.some(c=>existing(c.id)&&!available(c.id,'*'))){skipped.push(clip.name);continue;}
          for(const {id,value} of proposal){if(value)validateGradeNode(value);changes.push(value&&existing(id)?{collection:'nodes',id,value:{parameters:value.parameters,...(value.curves?{curves:value.curves}:{})}}:{collection:'nodes',id,value:value&&record(value),replace:true});}
          applied.push(clip.name);
        }
      }catch(error){state.notify((error as Error).message,'error');return 0;}
      if(!applied.length){state.notify('No shot could take this Color Assistant result','info',skipped.join(', ')||undefined);return 0;}
      const label=choice?.name??(result.mode==='balance'?'Balance shots':'Match to reference'),count=`${applied.length} shot${applied.length===1?'':'s'}`;
      state.saveSnapshot(`Before Color Assistant: ${label}`,'Preserved before applying a Color Assistant proposal.');
      commit('GradeNodeChanged',[...targets.keys()][0],`applied Color Assistant “${label}” to ${count}`,changes);
      state.notify(`Applied ${label} to ${count}`,'success',skipped.length?`Skipped: ${skipped.join(', ')}`:undefined);
      return applied.length;
    },
    useAcesOutput(clipId) {
      const state=get(),clip=state.clips.find(c=>c.id===clipId&&c.projectId===state.projectId);if(!clip)return;
      const upgrade=acesOutputUpgrade(clip,state.nodes);if(!upgrade)return;
      state.saveSnapshot(`Before ACES output: ${clip.name}`,'Preserved the existing grade before replacing its display rendering.');state.updateNode(upgrade.node.id,{effects:upgrade.effects});
    },
    arrangeColorNodes(clipId) {
      if(!editableClip(clipId,'grade'))return;
      const nodes=get().nodes.filter(n=>n.clipId===clipId).sort((a,b)=>(a.order??0)-(b.order??0));if(nodes.some(n=>!available(n.id,'*')))return;
      commit('GradeNodeChanged',clipId,'arranged color nodes',nodes.map((n,i)=>({collection:'nodes' as const,id:n.id,value:{position:{x:60+i*170,y:80}}})));
    },
    moveColorNode(id,beforeId,position) {
      if(position){try{validateGradeNode({position});}catch{return;}}
      const node=get().nodes.find(n=>n.id===id);if(!node||id===beforeId||!editableClip(node.clipId,'grade'))return;
      const nodes=get().nodes.filter(n=>n.clipId===node.clipId).sort((a,b)=>(a.order??0)-(b.order??0));if(nodes.some(n=>!available(n.id,'*')))return;
      const remaining=nodes.filter(n=>n.id!==id),index=beforeId===null?remaining.length:remaining.findIndex(n=>n.id===beforeId);if(index<0)return;
      remaining.splice(index,0,node);commit('GradeNodeChanged',id,'changed color processing order',remaining.map((n,i)=>({collection:'nodes' as const,id:n.id,value:{order:i+1,...(n.id===id&&position?{position}:{})}})));
    },
    updateNode(id, patch, gesture) {
      const node = get().nodes.find(node => node.id === id && node.projectId === get().projectId);
      if (!node || !editableClip(node.clipId, 'grade') || !available(id, '*')) return;
      if(('mask' in patch?patch.mask:node.mask)?.enabled&&(patch.effects??node.effects)?.some(e=>e.enabled&&e.type==='cst')){get().notify('Keep color-space transforms on an unmasked node','info');return;}
      try{validateGradeNode({...node,...patch});}catch(error){get().notify((error as Error).message,'error');return;}
      const value: Record<string, unknown> = {};
      const unset='mask' in patch&&!patch.mask?['mask']:[];
      if(patch.mask){if(!get().clips.find(c=>c.id===node.clipId)?.smartMasks?.some(m=>m.id===patch.mask!.id))return;value.mask=patch.mask;}
      if(patch.position)value.position=patch.position;
      if(patch.curves)value.curves=patch.curves;
      if(patch.effects)value.effects=patch.effects;
      if (typeof patch.enabled === 'boolean') value.enabled = patch.enabled;
      if (patch.name?.trim()) value.name = patch.name.trim().slice(0, 80);
      if (patch.parameters) for (const [key, number] of Object.entries(patch.parameters)) if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) && !['constructor', 'prototype'].includes(key) && Number.isFinite(number)) value[`parameters.${key}`] = number;
      const clip=get().clips.find(c=>c.id===node.clipId)!;
      const keyframes={...clip.keyframes};
      for(const [field,next] of Object.entries(value))if(keyframes[`nodes.${id}.${field}`]) { const fps=get().projects.find(p=>p.id===clip.projectId)?.fps||24,time=frameTime(clamp(get().playhead-clip.start,0,clip.duration-1/fps),fps),path=`nodes.${id}.${field}`;keyframes[path]=[...keyframes[path].filter(k=>Math.abs(k.time-time)>.5/fps),{id:createId('key'),time,value:next as KeyframeValue,interpolation:typeof next==='number'?'linear' as const:'hold' as const}].sort((a,b)=>a.time-b.time);delete value[field]; }
      if (Object.keys(value).length || unset.length || JSON.stringify(keyframes)!==JSON.stringify(clip.keyframes??{})) commit('GradeNodeChanged', id, `adjusted ${node.name}`, [{ collection: 'nodes', id, value,unset },...(clip.keyframes?[{collection:'clips' as const,id:clip.id,value:{keyframes}}]:[])], gesture);
    },
    applyGrade(proposal) {
      const state = get(); if (!state.selectedClipId || !editableClip(state.selectedClipId, 'grade')) return;
      const start = Math.max(0,...state.nodes.filter(n=>n.clipId===state.selectedClipId).map(n=>n.order??0));
      const nodes = proposal.slice(0, 20).map((node,i) => ({...colorService.createNode(node.name, state.projectId, state.selectedClipId!, node.parameters), order:start+i+1}));
      if (!nodes.length) return;
      commit('GradeNodeAdded', state.selectedClipId, 'applied an editable grade', nodes.map(node => ({ collection: 'nodes' as const, id: node.id, value: record(node), replace: true })));
      set({ selectedNodeId: nodes[0].id }); state.notify('Grade applied as editable nodes', 'success');
    },
    undo() {
      const state = get();
      if (!writable(true)) return;
      let blocked = false;
      let group: Operation[] = [], changes: Change[] = [];
      const operation = state.operations.find((op) => {
        if (op.userId !== state.currentUserId || op.projectId !== state.projectId || op.undone || !Array.isArray(op.newState) || !op.newState.length) return false;
        // A save seals history entries, but never divides one pointer gesture into multiple undos.
        const candidates=op.gestureId?state.operations.filter(other=>other.gestureId===op.gestureId&&other.userId===op.userId&&other.projectId===op.projectId&&!other.undone):[op];
        const ids=new Set(candidates.map(o=>o.id));let restored:ProjectState=state;
        for(const candidate of candidates){
          const forward=candidate.newState as Change[];
          const index=state.operations.findIndex(o=>o.id===candidate.id);
          if(state.operations.slice(0,index).some(later=>!ids.has(later.id)&&!later.undone&&Array.isArray(later.newState)&&(later.newState as Change[]).some(b=>forward.some(a=>overlap(a,b))))){blocked=true;return false;}
          const unchanged=forward.every(change=>{
            const current=entity(restored,change);
            if(change.value===null)return !current;if(!current)return false;
            return change.replace?JSON.stringify(record(current))===JSON.stringify(change.value):Object.entries(change.value).every(([key,value])=>JSON.stringify(readField(current,key))===JSON.stringify(value))&&(change.unset??[]).every(key=>readField(current,key)===undefined);
          });
          if(!unchanged){blocked=true;return false;}
          restored=applyChanges(restored,candidate.oldState as Change[]);
        }
        const intact=restored.clips.every(clip=>(restored.timelines??state.timelines).some(t=>t.id===clip.timelineId)&&restored.tracks.some(track=>track.id===clip.trackId&&track.timelineId===clip.timelineId))&&restored.nodes.every(node=>restored.clips.some(clip=>clip.id===node.clipId));
        if(!intact){blocked=true;return false;}
        try{validateCompositions(restored.clips,restored.timelines??state.timelines);}catch{blocked=true;return false;}
        group=candidates;changes=candidates.flatMap(o=>o.oldState as Change[]);return true;
      });
      if (!operation) { state.notify(blocked ? 'Cannot undo without overwriting a newer change' : 'No personal actions to undo', 'info'); return; }
      if (changes.some(change => change.collection !== 'comments') && !writable()) return;
      if (changes.some(change => !available(change.id, '*'))) return;
      const undo = collaborationService.createOperation({ ...operation, gestureId: undefined, description: `undid: ${operation.description}`, oldState: [...group].reverse().flatMap(o=>o.newState as Change[]), newState: changes, undone: true });
      const restored = applyChanges(state, changes), ids=new Set(group.map(o=>o.id));
      set({ ...restored, selectedClipIds:state.selectedClipIds.filter(id=>restored.clips.some(c=>c.id===id)), textSelection: null, textPreview: [], selectedTextIds: state.selectedTextIds.filter(id => restored.clips.some(c => c.id === id)), projects: updatedProjects(state, restored.clips), operations: [undo, ...state.operations.map(op => ids.has(op.id) ? { ...op, undone: true } : op)], selectedClipId: state.selectedClipId && restored.clips.some(c => c.id === state.selectedClipId) ? state.selectedClipId : null, selectedNodeId: state.selectedNodeId && restored.nodes.some(n => n.id === state.selectedNodeId) ? state.selectedNodeId : null });
      if(!get().timelines.some(t=>t.id===state.timelineId)){
        const parent=[...state.compositionTrail].reverse().find(entry=>get().timelines.some(t=>t.id===entry.timelineId));
        const timeline=parent?.timelineId??get().timelines.find(t=>t.projectId===state.projectId&&!t.composition)?.id;
        if(timeline){get().setTimeline(timeline);if(parent)get().setPlayhead(parent.playhead);}
      }
      state.notify(`Undone: ${operation.description}`);
    },
    saveSnapshot(name, note) {
      const state = get(); if (!writable() || !name.trim()) return;
      const snapshot: Snapshot = { id: createId('snapshot'), projectId: state.projectId, name: name.trim().slice(0, 100), note: note.trim().slice(0, 1000), userId: state.currentUserId, timestamp: Date.now(), state: structuredClone(projectState(state)) };
      set({ snapshots: [snapshot, ...state.snapshots] }); state.notify(`Snapshot saved: ${snapshot.name}`, 'success');
    },
    restoreSnapshot(id) {
      const state = get(); const snapshot = state.snapshots.find(snapshot => snapshot.id === id && snapshot.projectId === state.projectId);
      if (!snapshot || !writable()) return;
      if (state.locks.some(lock => lock.projectId === state.projectId && lock.userId !== state.currentUserId && lock.expiresAt > Date.now())) { state.notify('Wait for active collaborators to finish before restoring', 'info'); return; }
      const backup: Snapshot = { id: createId('snapshot'), projectId: state.projectId, name: `Before restoring ${snapshot.name}`, note: 'Automatically preserved before snapshot restore.', userId: state.currentUserId, timestamp: Date.now(), state: structuredClone(projectState(state)) };
      const changes: Change[] = [];
      const current = projectState(state);
      for (const collection of ['clips', 'tracks', 'nodes', 'comments', ...(snapshot.state.timelines?['timelines' as const]:[])] as const) {
        for (const item of current[collection] ?? []) if (!(snapshot.state[collection] ?? []).some(saved => saved.id === item.id)) changes.push({ collection, id: item.id, value: null, replace: true });
        for (const item of snapshot.state[collection] ?? []) changes.push({ collection, id: item.id, value: record(item), replace: true });
      }
      set({ snapshots: [backup, ...state.snapshots] });
      commit('SnapshotRestored', id, `restored snapshot “${snapshot.name}”`, changes);
      set({ selectedClipId: null, selectedClipIds:[], selectedTextIds: [], textSelection: null, textPreview: [], selectedNodeId: null, playing: false, modal: null, locks: [] });
      if(!get().timelines.some(t=>t.id===get().timelineId)){const timeline=get().timelines.find(t=>t.projectId===state.projectId&&!t.composition);if(timeline)get().setTimeline(timeline.id);}
      state.notify(`Restored ${snapshot.name}`, 'success', 'Your previous state was saved as a snapshot.');
    },
    addComment(text, target) {
      const state = get(); if (!text.trim() || !writable(true)) return;
      const clipId = target?.clipId && state.clips.some(c => c.id === target.clipId && c.projectId === state.projectId) ? target.clipId : undefined;
      const range = target?.range?.every(Number.isFinite) ? [clamp(Math.min(...target.range), 0, durationOf(state)), clamp(Math.max(...target.range), 0, durationOf(state))] as [number, number] : undefined;
      const comment: Comment = { id: createId('comment'), projectId: state.projectId, userId: state.currentUserId, text: text.trim().slice(0, 5000), timestamp: Date.now(), time: state.playhead, clipId, range, resolved: false, replies: [] };
      commit('CommentAdded', comment.id, `commented at ${Math.floor(state.playhead / 60)}:${String(Math.floor(state.playhead % 60)).padStart(2, '0')}`, [{ collection: 'comments', id: comment.id, value: record(comment), replace: true }]);
    },
    replyComment(id, text) { const state = get(); const comment = state.comments.find(c => c.id === id && c.projectId === state.projectId); if (comment && text.trim() && writable(true)) commit('CommentChanged', id, 'replied to a review comment', [{ collection: 'comments', id, value: { replies: [...comment.replies, { id: createId('reply'), userId: state.currentUserId, text: text.trim().slice(0, 5000), timestamp: Date.now() }] } }]); },
    resolveComment(id) { const comment = get().comments.find(c => c.id === id && c.projectId === get().projectId); if (comment && writable(true)) commit('CommentChanged', id, `${comment.resolved ? 'reopened' : 'resolved'} a review comment`, [{ collection: 'comments', id, value: { resolved: !comment.resolved } }]); },
    enqueueRender(name, preset, settings) { const state = get(); if (!writable()) return; if (connection.enabled) { void connection.flush().then(() => api('/renders', { method: 'POST', body: JSON.stringify({ projectId: state.projectId, name, preset, settings }) })).then(() => { state.notify('Render queued on your server', 'success'); return connection.refresh(); }).catch(error => state.notify(error.message, 'error')); return; } const job = renderService.enqueue(state.projectId, name, preset, settings, state.renderJobs.some(job => job.status === 'rendering')); set({ renderJobs: [job, ...state.renderJobs] }); state.notify('Added to the demo render queue', 'success', 'Processing is simulated locally.'); },
    updateRender(id, patch) { const state = get(); if (!writable()) return; if (connection.enabled) { const job = state.renderJobs.find(j => j.id === id); if (!job) return; void (patch.status === 'waiting' ? api('/renders', { method: 'POST', body: JSON.stringify({ projectId: job.projectId, name: job.name, preset: job.preset, settings: job.settings }) }) : api(`/renders/${encodeURIComponent(id)}`, { method: 'DELETE' })).then(() => connection.refresh()).catch(error => state.notify(error.message, 'error')); return; } set({ renderJobs: state.renderJobs.map(job => job.id === id && job.projectId === state.projectId ? { ...job, ...(patch.status && ['rendering', 'waiting', 'complete', 'failed'].includes(patch.status) ? { status: patch.status } : {}), ...(typeof patch.remaining === 'string' ? { remaining: patch.remaining } : {}), ...(Number.isFinite(patch.progress) ? { progress: clamp(patch.progress!, 0, 100) } : {}) } : job) }); },
    uploadMedia(files) { const state = get(); if (!writable() || !files.length) return; if (connection.enabled) { enqueueUploads(state.projectId, files, state.media); return; } const assets = mediaService.importFiles(files, state.projectId); set({ media: [...assets, ...state.media] }); state.notify(`${assets.length} files added to demo upload queue`, 'info', 'File processing is simulated; originals stay on your computer.'); },
    renameMedia(id, name) { const state = get(); if (!writable() || !name.trim()) return; if (connection.enabled) { void api(`/media/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }).then(() => connection.refresh()).catch(error => state.notify(error.message,'error')); return; } set({ media: state.media.map(asset => asset.id === id && asset.projectId === state.projectId ? { ...asset, name: name.trim().slice(0, 255) } : asset) }); },
    removeMedia(id) {
      const state = get(); if (!writable()) return;
      if (state.clips.some(clip => clip.mediaId === id) || state.snapshots.some(snapshot => snapshot.state.clips.some(clip => clip.mediaId === id))) { state.notify('This media is used in a timeline or snapshot', 'info', 'Keeping it prevents missing media when a snapshot is restored.'); return; }
      if (connection.enabled) { void connection.flush().then(() => api(`/media/${encodeURIComponent(id)}`, { method: 'DELETE' })).then(() => connection.refresh()).catch(error => state.notify(error.message,'error')); return; }
      set({ media: state.media.filter(asset => asset.id !== id || asset.projectId !== state.projectId) });
    },
    retryMedia(id) { const state = get(); if (!writable()) return; if (connection.enabled) { void api(`/media/${encodeURIComponent(id)}/retry`, { method: 'POST' }).then(() => connection.refresh()).catch(error => state.notify(error.message, 'error')); return; } set({ media: state.media.map(asset => asset.id === id && asset.projectId === state.projectId ? { ...asset, status: 'proxy', progress: 0 } : asset) }); state.notify('Demo proxy generation queued'); },
    revealMedia(id) { if (id === null) set({ revealedMediaId: null }); else if (get().media.some(asset => asset.id === id && asset.projectId === get().projectId)) set({ revealedMediaId: id, workspace: 'edit' }); },
    setUserColor(color) { const state = get(); if (connection.enabled) { if (/^#[0-9a-f]{6}$/i.test(color)) void api('/auth/profile', { method: 'PATCH', body: JSON.stringify({ color }) }).then(() => connection.refresh()).catch(error => state.notify(error.message, 'error')); return; } if (/^#[0-9a-f]{6}$/i.test(color)) set({ users: state.users.map(user => user.id === state.currentUserId ? { ...user, color } : user) }); },
    setUserProfile(profile) { const state = get(); if (connection.enabled) { void api('/auth/profile', { method: 'PATCH', body: JSON.stringify(profile) }).then(() => { state.notify('Profile updated', 'success'); return connection.refresh(); }).catch(error => state.notify(error.message, 'error')); return; } try { const user = state.users.find(user => user.id === state.currentUserId); if (!user) return; const updated = authenticationService.updateProfile(user, profile); set({ users: state.users.map(item => item.id === user.id ? updated : item) }); state.notify('Profile updated', 'success'); } catch (error) { state.notify(error instanceof Error ? error.message : 'Could not update profile', 'error'); } },
    setCurrentUser(id) { if (connection.enabled) return; const state = get(); if (!state.users.some(user => user.id === id)) return; state.releaseUserLocks(state.currentUserId); set({ currentUserId: id, liveMode: 'independent', followUserId: null, playing: false, presence: createDemoProject(state.projectId).presence.filter(person => person.userId !== id) }); },
    setSettings(patch) { const safe = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !['__proto__', 'constructor', 'prototype'].includes(key) && (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))))) as Settings; set({ settings: { ...get().settings, ...safe } }); },
    notify(title, kind = 'info', detail) {
      const notifications = get().notifications;
      // A retrying save reports the same failure on every attempt. Refresh the existing toast rather
      // than stacking duplicates that bury everything else in the tray.
      const repeat = notifications.find(item => item.title === title && item.kind === kind && item.detail === detail);
      if (repeat) { set({ notifications: notifications.map(item => item === repeat ? { ...item, timestamp: Date.now() } : item) }); return; }
      set({ notifications: [...notifications, { id: createId('notification'), title, kind, detail, timestamp: Date.now() }].slice(-5) });
    },
    dismissNotification(id) { set({ notifications: get().notifications.filter(item => item.id !== id) }); },
    acquireLock(targetId, field) {
      const state = get(); if (!writable() || !available(targetId, field)) return false;
      const existing = state.locks.find(lock => lock.projectId === state.projectId && lock.targetId === targetId && lock.field === field && lock.userId === state.currentUserId && lock.expiresAt > Date.now());
      const lock: CollaborativeLock = { id: existing?.id ?? createId('lock'), projectId: state.projectId, targetId, field, userId: state.currentUserId, expiresAt: Date.now() + LOCK_TTL };
      set({ locks: [...state.locks.filter(item => item.id !== lock.id && item.expiresAt > Date.now()), lock] }); if (connection.enabled) void api('/locks', { method: 'POST', body: JSON.stringify({ projectId: state.projectId, targetId, field }) }).catch(error => { state.releaseLock(targetId, field); state.notify(error.message, 'error'); void connection.refresh(); }); return true;
    },
    acquireLocks(targetIds, field) {
      const state = get(), ids = [...new Set(targetIds)]; if (!ids.length) return true;
      if (!writable() || !ids.every(id => available(id, field))) return false;
      const now = Date.now(), wanted = new Set(ids), mine = new Map(state.locks.filter(lock => lock.projectId === state.projectId && lock.field === field && lock.userId === state.currentUserId && lock.expiresAt > now && wanted.has(lock.targetId)).map(lock => [lock.targetId, lock.id]));
      const taken = ids.map((targetId): CollaborativeLock => ({ id: mine.get(targetId) ?? createId('lock'), projectId: state.projectId, targetId, field, userId: state.currentUserId, expiresAt: now + LOCK_TTL })), replaced = new Set(taken.map(lock => lock.id));
      set({ locks: [...state.locks.filter(item => !replaced.has(item.id) && item.expiresAt > now), ...taken] });
      if (connection.enabled) void lockRequest('POST', state.projectId, ids, field).catch(error => { state.releaseLocks(ids, field); state.notify(error.message, 'error'); void connection.refresh(); });
      return true;
    },
    renewLock(targetId, field) {
      const state = get();
      if (!state.locks.some(lock => lock.projectId === state.projectId && lock.targetId === targetId && lock.field === field && lock.userId === state.currentUserId && lock.expiresAt > Date.now())) return false;
      return state.acquireLock(targetId, field);
    },
    releaseLock(targetId, field) { const state = get(); if (connection.enabled && state.locks.some(lock => lock.targetId === targetId && lock.field === field && lock.userId === state.currentUserId)) void api('/locks', { method: 'DELETE', body: JSON.stringify({ projectId: state.projectId, targetId, field }) }).catch(() => {}); set({ locks: state.locks.filter(lock => !(lock.targetId === targetId && lock.field === field && lock.userId === state.currentUserId)) }); },
    releaseLocks(targetIds, field) {
      const state = get(), wanted = new Set(targetIds), held = state.locks.filter(lock => lock.field === field && lock.userId === state.currentUserId && wanted.has(lock.targetId));
      if (!held.length) return;
      if (connection.enabled) void lockRequest('DELETE', state.projectId, held.map(lock => lock.targetId), field).catch(() => {});
      set({ locks: state.locks.filter(lock => !held.includes(lock)) });
    },
    releaseUserLocks(userId) { set({ locks: get().locks.filter(lock => lock.userId !== userId) }); },
    tick(now) {
      if (!Number.isFinite(now)) return;
      const state = get(); const elapsed = clamp((now - lastTick) / 1000, 0, 1); lastTick = now;
      const presence = connection.enabled ? state.presence : collaborationService.advancePresence(state.presence, now, durationOf(state));
      const follow = state.liveMode === 'following' ? presence.find(person => person.userId === state.followUserId && person.online) : null;
      const playbackEnd = playbackEndOf(state);
      if (!follow) { followedMotion = null; followedUser = null; }
      if (follow && (!followedMotion || followedUser !== follow.userId)) { followedMotion = playheadMotion(follow, now); followedUser = follow.userId; }
      const remoteTime = follow && connection.enabled ? advancePlayhead(followedMotion!, follow, now) : follow?.playhead;
      // The playing clock runs here at full precision; a playhead set from outside (a seek, a loop, pausing) restarts it. A
      // buffering stall only holds it: restarting from the store's playhead lost up to a picture of progress each stall.
      const clocked = !follow && state.playing;
      const from = clocked && clockRunning && state.playhead === clockPublished ? clockTime : state.playhead;
      const time = follow ? Math.min(durationOf(state), remoteTime!) : clocked ? Math.min(playbackEnd, from + (state.playbackBuffering ? 0 : elapsed)) : state.playhead;
      const playing = time >= playbackEnd ? false : follow ? !!follow.playing : state.playing;
      // Every store change re-runs every subscriber's selector (~3 ms a tick at 4x CPU slowdown on a real timeline) and the
      // display ticks two to five times per picture. The picture changes only on a frame boundary (playback.ts steps at this
      // rate), so while playing the store's playhead moves once per picture: everything reading it sees the picture shown.
      const rate = parseFloat(String(state.settings.playbackFrameRate)) || state.projects.find(p => p.id === state.projectId)?.fps || 24;
      const playhead = playing && Math.floor(time * rate + 1e-6) === Math.floor(state.playhead * rate + 1e-6) ? state.playhead : time;
      clockTime = time; clockPublished = playhead; clockRunning = clocked;
      const locks = collaborationService.expireLocks(state.locks, now);
      // A tick that changes nothing notifies nobody: paused, it ran every selector 30 times a second for nothing.
      const patch: Partial<EditorStore> = {};
      if (presence !== state.presence) patch.presence = presence;
      if (locks !== state.locks) patch.locks = locks;
      if (playhead !== state.playhead) patch.playhead = playhead;
      if (playing !== state.playing) patch.playing = playing;
      if (state.liveMode === 'following' && !follow) { patch.liveMode = 'independent'; patch.followUserId = null; }
      if (now - lastProcessingTick >= 1000) {
        const processingElapsed = clamp((now - lastProcessingTick) / 1000, 0, 2); lastProcessingTick = now;
        if (!connection.enabled && state.media.some(asset => asset.status !== 'ready' && asset.status !== 'failed')) {
          patch.media = state.media.map(asset => mediaService.advance(asset, processingElapsed));
          patch.media.forEach((asset, index) => { if (asset.status === 'ready' && state.media[index].status !== 'ready') state.notify(`Proxy ready: ${asset.name}`, 'success'); });
        }
        if (!connection.enabled && state.renderJobs.some(job => job.status === 'rendering' || job.status === 'waiting')) {
          patch.renderJobs = state.renderJobs.map(job => renderService.advance(job, processingElapsed));
          patch.renderJobs.forEach((job, index) => { if (job.status === 'complete' && state.renderJobs[index].status !== 'complete') state.notify(`Demo render complete: ${job.name}`, 'success'); });
          if (!patch.renderJobs.some(job => job.status === 'rendering')) { const next = [...patch.renderJobs].reverse().find(job => job.status === 'waiting'); if (next) patch.renderJobs = patch.renderJobs.map(job => job.id === next.id ? { ...job, status: 'rendering', remaining: '1:20 remaining' } : job); }
        }
        // Only when one expires: a new array every second re-rendered every panel that reads the whole store.
        const notifications = get().notifications, kept = notifications.filter(item => now - item.timestamp < 7_000);
        if (kept.length !== notifications.length) patch.notifications = kept;
      }
      if (Object.keys(patch).length) set(patch);
    },
    setLiveMode(mode, userId) {
      const state = get();
      if (mode === 'following') { followedMotion = null; followedUser = null; const person = state.presence.find(person => person.userId === userId && person.online); if (!person) { state.notify('This collaborator is not online', 'info'); return; } set({ liveMode: mode, followUserId: person.userId, playhead: person.playhead, playing: false }); }
      else { set({ liveMode: mode, followUserId: null }); if (mode === 'presenting') state.notify('You’re presenting to the class', 'success', 'Collaborators can now follow your playhead.'); }
    },
  };
});

// Panels that only display playhead-dependent values (animated properties, a comment's time) would otherwise
// re-render on every playback frame; while playing they follow the playhead in quarter-second steps.
export const PANEL_PLAYHEAD_STEP = .25;
export const panelPlayhead = (s: Pick<EditorStore, 'playing' | 'playhead'>) => s.playing ? Math.floor(s.playhead / PANEL_PLAYHEAD_STEP) * PANEL_PLAYHEAD_STEP : s.playhead;
/** `needed` false (nothing keyframed) subscribes to nothing that moves. */
export const usePanelPlayhead = (needed = true) => useEditorStore(s => needed ? panelPlayhead(s) : 0);
/** Editing overlays hide while playing, so they never need the moving playhead. */
export const usePausedPlayhead = () => useEditorStore(s => s.playing ? -1 : s.playhead);
/** The whole store minus the playhead, for broad panels written against `useEditorStore()`: they skip every playback frame. */
export const useStoreWithoutPlayhead = (): Omit<EditorStore, 'playhead'> => useEditorStore(useShallow(({ playhead: _, ...rest }: EditorStore) => rest));

// ponytail: localStorage has a small size ceiling; use the server database for large projects.
export const persistedKeys = ['projects', 'media', 'timelines', 'clips', 'tracks', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs', 'users', 'currentUserId', 'settings'] as const;
export const persistentState = (state: EditorStore): PersistedState => Object.fromEntries(persistedKeys.map(key => [key, state[key]])) as unknown as PersistedState;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (connection.enabled || typeof window !== 'undefined') return;
  try { projectService.save(persistentState(useEditorStore.getState())); useEditorStore.setState({ saveStatus: 'Saved' }); }
  catch { useEditorStore.setState({ saveStatus: 'Save failed' }); }
};
useEditorStore.subscribe((state, previous) => {
  if (connection.enabled || typeof window !== 'undefined') return;
  if (!persistedKeys.some(key => state[key] !== previous[key])) return;
  if (saveTimer) clearTimeout(saveTimer);
  useEditorStore.setState({ saveStatus: 'Saving…' });
  saveTimer = setTimeout(persist, 450);
});

let serviceUsers = 0;
let serviceTimer: ReturnType<typeof setInterval> | undefined;
let playbackFrame: number | undefined;
export function initializeEditorServices() {
  serviceUsers++;
  const disconnect = () => { const state = useEditorStore.getState(); state.releaseUserLocks(state.currentUserId); persist(); };
  if (!serviceTimer) {
    lastTick = Date.now(); lastProcessingTick = Date.now();
    const visible = () => typeof document !== 'undefined' && document.visibilityState !== 'hidden';
    const moving = () => { const s=useEditorStore.getState();return s.playing||s.liveMode==='following'; };
    // Drive visible playback from the display clock. A separate 30 Hz clock aliases 24/25 fps
    // pictures into repeated/skipped frames even when every source frame is already in memory.
    if(typeof requestAnimationFrame==='function'){
      const advance=()=>{if(useEditorStore.getState().session==='ready'&&visible()&&moving())useEditorStore.getState().tick(Date.now());playbackFrame=requestAnimationFrame(advance);};
      playbackFrame=requestAnimationFrame(advance);
    }
    serviceTimer=setInterval(()=>{if(useEditorStore.getState().session==='ready'&&(playbackFrame===undefined||!visible()||!moving()))useEditorStore.getState().tick(Date.now());},1000/30);
  }
  if (typeof window !== 'undefined') { window.addEventListener('pagehide', disconnect); window.addEventListener('offline', disconnect); }
  let closed = false;
  return () => {
    if (closed) return; closed = true; serviceUsers--;
    if (typeof window !== 'undefined') { window.removeEventListener('pagehide', disconnect); window.removeEventListener('offline', disconnect); }
    if (serviceUsers === 0) { clearInterval(serviceTimer); serviceTimer = undefined; if(playbackFrame!==undefined){cancelAnimationFrame(playbackFrame);playbackFrame=undefined;} disconnect(); }
  };
}
