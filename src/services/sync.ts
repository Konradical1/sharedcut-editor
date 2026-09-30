import { resetUploads, uploadQueue } from './upload.ts';
import { stateDelta, applyStateDelta, shareState, stateEqual, type StateDelta } from './stateDelta.ts';
import { useEditorStore, persistentState, persistedKeys, sealHistory } from '../state/store.ts';
import { createId } from './index.ts';
import type { PersistedState } from './index.ts';
import type { CollaborativeLock, Presence, User, MediaAsset } from '../state/models.ts';
import { api, ApiError, connection } from './api.ts';
import { mergeState } from './merge.ts';
import { presenceDue, receivedPresence } from './presence.ts';

type Envelope = { incremental?: boolean; baseRevision?: number; delta?: StateDelta; revision: number; lockRevision?: number; state?: PersistedState; presence?: Presence[]; locks?: CollaborativeLock[] };
let baseline: PersistedState | null = null;
let incremental = false;
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let revision = -1;
let applying = false;
let saving: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout>;
let stopped: (() => void) | undefined;
let conflicted = false;
let conflictBase: PersistedState | null = null;
let generation = 0;
let mediaRevision = -1;
let storageFull = false;
// What the server last told us it holds. An SSE frame that cannot be acted on right now still
// updates these, so a client always knows it is behind instead of silently waiting for a poll.
let serverRevision = -1;
let serverLockRevision = -1;
let lockRevision = -1;
let refreshQueued = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryAttempt = 0;
let dirtySince = 0;
const draftKey = () => `frameline.unsaved.${useEditorStore.getState().currentUserId}`;
const same = stateEqual;

function apply(state: PersistedState) {
  applying = true;
  try {
    useEditorStore.setState(state);
    const local=useEditorStore.getState();
    if(local.projectId&&local.timelineId&&!state.timelines.some(t=>t.id===local.timelineId)){
      const parent=[...local.compositionTrail].reverse().find(entry=>state.timelines.some(t=>t.id===entry.timelineId));
      const next=parent?.timelineId??state.timelines.find(t=>t.projectId===local.projectId&&!t.composition)?.id;
      if(next)local.setTimeline(next);
    }
  } finally { applying = false; }
}
// Recovery only needs what the server does not already hold. An entry identical in both copies
// contributes nothing to the three-way merge, which takes the server's value for it either way.
function unsavedOnly(base: PersistedState, draft: PersistedState) {
  const trimmed = { base: { ...base }, draft: { ...draft } };
  for (const key of persistedKeys) {
    const saved = base[key], local = draft[key];
    if (!Array.isArray(saved) || !Array.isArray(local)) continue;
    if (saved === local) { Object.assign(trimmed.base, { [key]: [] }); Object.assign(trimmed.draft, { [key]: [] }); continue; }
    const before = new Map<string, unknown>(saved.map(item => [item.id, item])), after = new Map<string, unknown>(local.map(item => [item.id, item]));
    const changed = new Set([...before.keys(), ...after.keys()].filter(id => !same(before.get(id), after.get(id))));
    Object.assign(trimmed.base, { [key]: saved.filter(item => changed.has(item.id)) });
    Object.assign(trimmed.draft, { [key]: local.filter(item => changed.has(item.id)) });
  }
  return trimmed;
}
function cacheDraft() {
  if (!baseline) return;
  const payload = JSON.stringify(unsavedOnly(conflictBase ?? baseline, persistentState(useEditorStore.getState())));
  for (let attempt = 0; attempt < 2; attempt++) {
    try { localStorage.setItem(draftKey(), payload); storageFull = false; return; }
    // Another account's abandoned draft can never be recovered in this session. Reclaim it and retry.
    catch { for (const key of Object.keys(localStorage)) if (key.startsWith('frameline.unsaved.') && key !== draftKey()) localStorage.removeItem(key); }
  }
  // Every edit caches a draft, so report a full disk once per episode rather than on each keystroke.
  if (!storageFull) { storageFull = true; useEditorStore.getState().notify('Local recovery storage is full', 'error', 'Keep this window open until the server confirms Saved.'); }
}
function resetSession(session: 'loading' | 'signedOut' = 'signedOut') {
  resetUploads();
  if (baseline && !same(baseline, persistentState(useEditorStore.getState()))) cacheDraft();
  generation++;
  stopped?.(); stopped = undefined; clearTimeout(timer);
  baseline = null; incremental = false; refreshing = null; refreshAgain = false; revision = -1; mediaRevision = -1; conflicted = false; conflictBase = null; saving = null;
  serverRevision = -1; serverLockRevision = -1; lockRevision = -1; refreshQueued = false; dirtySince = 0;
  clearTimeout(retryTimer); retryTimer = undefined; retryAttempt = 0;
  // Clear server data while the demo persistence subscriber is still disabled.
  connection.enabled = true;
  apply(Object.fromEntries(persistedKeys.map(key => [key, key === 'settings' ? { ...useEditorStore.getInitialState().settings } : key === 'currentUserId' ? '' : []])) as unknown as PersistedState);
  useEditorStore.setState({ transitionPresets: [], transitionFavorites: [], leaks: [], session, cursor: null, dragPreview: null, playing: false, playbackBuffering: false, presence: [], locks: [], modal: null, syncConflict: [], notifications: [], clipboard: null, clipboardClips: [], clipboardNodes: [], projectId: '', timelineId: '', selectedClipId: null, selectedClipIds:[], shapeTool:null,compositionTrail:[], selectedTextIds: [], textSelection: null, textPreview: [], textTool: false, selectedNodeId: null, revealedMediaId: null, liveMode: 'independent', followUserId: null });
  connection.enabled = false;
}
// Media is server-owned. Progress must keep moving even while an edit is saving or conflicted.
function receiveMedia(envelope: Envelope) {
  if (!envelope.state || !baseline || envelope.state.currentUserId !== baseline.currentUserId || envelope.revision < mediaRevision) return;
  mediaRevision = envelope.revision;
  baseline = { ...baseline, media: envelope.state.media };
  applying = true;
  try { useEditorStore.setState({ media: envelope.state.media }); } finally { applying = false; }
}
// Import responses already contain authoritative media; insertion need not wait for another poll.
export function receiveImportedMedia(asset: MediaAsset, version: number) {
  if (!baseline || !connection.enabled || !Number.isSafeInteger(version) || version < mediaRevision || !baseline.projects.some(p => p.id === asset.projectId)) return;
  receiveMedia({ revision: version, state: { ...baseline, media: baseline.media.some(m => m.id === asset.id) ? baseline.media.map(m => m.id === asset.id ? asset : m) : [asset, ...baseline.media] } });
}
function receive(envelope: Envelope, base = baseline) {
  if (envelope.revision < revision) return;
  if (envelope.lockRevision !== undefined) {
    if (envelope.lockRevision < lockRevision) envelope = { ...envelope, locks: undefined };
    serverLockRevision = Math.max(serverLockRevision, envelope.lockRevision!);
  }
  if (envelope.revision > serverRevision) serverRevision = envelope.revision;
  // A reply to an already-current poll carries locks and presence but no workspace copy.
  if (!envelope.state) {
    lockRevision = Math.max(lockRevision, envelope.lockRevision ?? -1);
    const held = useEditorStore.getState().locks;
    useEditorStore.setState({ serverOnline: true, ...(envelope.locks && !same(envelope.locks, held) ? { locks: envelope.locks } : {}) });
    return;
  }
  if (baseline && envelope.state.currentUserId !== baseline.currentUserId) { resetSession(); return; }
  const local = persistentState(useEditorStore.getState());
  // A late project snapshot must not regress a newer media progress update.
  const remote = shareState(local, { ...envelope.state, media: envelope.revision < mediaRevision ? local.media : envelope.state.media });
  mediaRevision = Math.max(mediaRevision, envelope.revision);
  const result = base ? mergeState(base, { ...local, media: remote.media }, remote) : { value: remote, conflicts: [] };
  sealHistory(remote.operations);
  baseline = remote;
  revision = envelope.revision;
  lockRevision = Math.max(lockRevision, envelope.lockRevision ?? -1);
  apply(result.value);
  const state = useEditorStore.getState();
  useEditorStore.setState({ serverOnline: true, locks: envelope.locks && !same(envelope.locks, state.locks) ? envelope.locks : state.locks });
  if (result.conflicts.length) {
    conflicted = true;
    conflictBase = base;
    cacheDraft();
    useEditorStore.setState({ syncConflict: result.conflicts, saveStatus: 'Save failed' });
  }
}

export async function flushChanges(): Promise<void> {
  const session = generation;
  clearTimeout(timer); dirtySince = 0;
  if (saving) { await saving; if (session === generation) return flushChanges(); return; }
  if (!baseline || !connection.enabled) return;
  if (conflicted) throw new Error('Resolve the competing edits before saving.');
  if (same(persistentState(useEditorStore.getState()), baseline)) { useEditorStore.setState({saveStatus:'Saved'}); localStorage.removeItem(draftKey()); return; }
  const pendingSave = (async () => {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const sent = persistentState(useEditorStore.getState()), sentBase = baseline, sentRevision = revision;
        if (same(sent, baseline)) break;
        useEditorStore.setState({ saveStatus: 'Saving…' });
        try {
          sealHistory(sent.operations);
          const response = await api<Envelope>('/state', incremental
            ? { method: 'PATCH', body: JSON.stringify({ revision: sentRevision, delta: stateDelta(sentBase!, sent) }) }
            : { method: 'PUT', body: JSON.stringify({ revision, state: sent }) });
          if (response.delta) response.state = applyStateDelta(sent, response.delta);
          if (session !== generation) return;
          // Changes made during this request remain pending against the acknowledged version.
          receive(response, sent);
          if (session !== generation) return;
          if (conflicted) throw new Error('Another editor changed the same field. Choose which edit to keep.');
        } catch (error) {
          if (session !== generation) return;
          // A collaborator holds something this save touched. Give up our copy of just those items so
          // the next attempt converges, instead of resending a payload the server will never accept.
          if (error instanceof ApiError && error.status === 423 && surrenderLocked()) {
            useEditorStore.getState().notify('A collaborator is editing that', 'info', 'Your other changes were kept.');
            continue;
          }
          if (error instanceof ApiError && error.status === 409 && error.data.delta && sentBase && error.data.baseRevision === sentRevision) error.data.state = applyStateDelta(sentBase, error.data.delta);
          if (!(error instanceof ApiError) || error.status !== 409 || !error.data.state) throw error;
          receive(error.data);
          if (conflicted) throw new Error('Another editor changed the same field. Choose which edit to keep.');
        }
      }
      // Losing the race against your own typing is not an error: keep the pending edits and retry
      // quietly rather than interrupting a bulk edit with a toast.
      if (!same(persistentState(useEditorStore.getState()), baseline)) { scheduleRetry(); return; }
      clearTimeout(retryTimer); retryTimer = undefined; retryAttempt = 0;
      localStorage.removeItem(draftKey());
      useEditorStore.setState({ saveStatus: 'Saved', serverOnline: true });
    } catch (error) {
      if (session !== generation) return;
      cacheDraft();
      // Only a transport failure means the server is unreachable. A 403/409/423 is the server
      // answering us, and flagging it as offline made the status bar lie during normal contention.
      useEditorStore.setState({ saveStatus: 'Save failed', ...(error instanceof TypeError ? { serverOnline: false } : {}) });
      if (error instanceof ApiError && error.status === 401) resetSession();
      else if (!conflicted) scheduleRetry();
      throw error;
    }
  })();
  saving = pendingSave;
  try { await pendingSave; } finally { if (saving === pendingSave) saving = null; drainRefresh(); }
}

// Revert only the items a collaborator holds back to the server's copy, keeping every other pending
// edit. Returns false when there is nothing to surrender, so the caller reports the error instead.
function surrenderLocked() {
  if (!baseline) return false;
  const store = useEditorStore.getState();
  const held = new Set(store.locks.filter(lock => lock.userId !== store.currentUserId && lock.expiresAt > Date.now()).map(lock => lock.targetId));
  if (!held.size) return false;
  const patch: Record<string, unknown> = {};
  for (const key of persistedKeys) {
    const local = store[key], saved = baseline[key];
    if (!Array.isArray(local) || !Array.isArray(saved)) continue;
    const server = new Map(saved.map(item => [item.id, item]));
    if (!local.some(item => held.has(item.id) && !same(item, server.get(item.id)))) continue;
    patch[key] = local.map(item => held.has(item.id) ? server.get(item.id) ?? item : item);
  }
  if (!Object.keys(patch).length) return false;
  applying = true;
  try { useEditorStore.setState(patch as never); } finally { applying = false; }
  return true;
}

// A save that failed or was outrun by fresh edits retries on its own, with a widening gap so a
// server that keeps rejecting us is not hammered once per second.
function scheduleRetry() {
  if (retryTimer || !connection.enabled) return;
  const delay = Math.min(15_000, 400 * 2 ** retryAttempt++);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (!connection.enabled || conflicted) return;
    void flushChanges().catch(() => {});
  }, delay);
}
// A change that arrived while we were busy is replayed the moment we are free again.
function drainRefresh() {
  if (!refreshQueued || saving || conflicted || !connection.enabled) return;
  refreshQueued = false;
  void refreshState();
}

export function resolveSyncConflict(keepLocal: boolean) {
  conflicted = false;
  useEditorStore.setState({ syncConflict: [] });
  if (!keepLocal && baseline && conflictBase) apply(mergeState(conflictBase, baseline, persistentState(useEditorStore.getState())).value);
  conflictBase = null;
  void flushChanges().catch(error => useEditorStore.getState().notify(error.message, 'error'));
  drainRefresh();
}

export function refreshState(): Promise<void> {
  if (refreshing) { refreshAgain = true; return refreshing; }
  const session = generation;
  const pending = (async () => {
    do { refreshAgain = false; await fetchState(); } while (refreshAgain && session === generation && connection.enabled);
  })();
  refreshing = pending;
  void pending.finally(() => { if (refreshing === pending) refreshing = null; });
  return pending;
}
async function fetchState() {
  if (!connection.enabled) return;
  const session = generation;
  try {
    // Ask only for what we do not already hold; an up-to-date client gets locks and presence back
    // instead of a full copy of the workspace.
    const requestedBase = baseline, requestedRevision = revision;
    const envelope = await api<Envelope>(`/state?since=${revision}${incremental ? '&delta=1' : ''}`, { signal: AbortSignal.timeout(15000) });
    if (envelope.delta) {
      if (!requestedBase || envelope.baseRevision !== requestedRevision) throw new Error('Invalid delta baseline.');
      envelope.state = applyStateDelta(requestedBase, envelope.delta);
    }
    if (session !== generation || !connection.enabled) return;
    if (envelope.state && baseline && envelope.state.currentUserId !== baseline.currentUserId) { resetSession(); return; }
    if (saving || conflicted) { receiveMedia(envelope); refreshQueued = true; return; }
    receive(envelope);
    if (!conflicted && baseline && !same(baseline, persistentState(useEditorStore.getState()))) await flushChanges();
  } catch (error) {
    if (session !== generation) return;
    if (error instanceof TypeError) useEditorStore.setState({ serverOnline: false });
    if (error instanceof ApiError && error.status === 401) resetSession();
  }
}
// True when the server has told us about work we have not taken yet.
const behind = () => serverRevision > revision || serverLockRevision > lockRevision;

export async function connectSession() {
  resetSession('loading');
  const session = generation;
  let envelope: Envelope & { state: PersistedState };
  try {
    const { user } = await api<{ user: User | null }>('/auth/me');
    if (session !== generation) return;
    if (!user) { useEditorStore.setState({ session: 'signedOut', serverOnline: true }); return; }
    envelope = await api<Envelope & { state: PersistedState }>('/state');
    if (session !== generation) return;
    if (!envelope.state) throw new Error('The server did not return the project.');
    if (envelope.state.currentUserId !== user.id) { resetSession(); throw new Error('Your account changed in another tab. Sign in again.'); }
  } catch (error) { if (session !== generation) return; throw error; }
  connection.enabled = true;
  sealHistory(envelope.state.operations);
  baseline = envelope.state; incremental = envelope.incremental === true;
  revision = envelope.revision;
  serverRevision = envelope.revision; serverLockRevision = envelope.lockRevision ?? -1; lockRevision = serverLockRevision;
  refreshQueued = false; retryAttempt = 0; clearTimeout(retryTimer); retryTimer = undefined;
  conflicted = false;
  apply(envelope.state);
  useEditorStore.setState({ session: 'ready', serverOnline: true, syncConflict: [], presence: [], locks: [], playing: false, notifications: [], selectedClipId: null, selectedClipIds:[], shapeTool:null,compositionTrail:[], selectedTextIds: [], textSelection: null, textPreview: [], textTool: false });
  const draft = localStorage.getItem(draftKey());
  if (draft) {
    try {
      const cached = JSON.parse(draft);
      if (cached.base?.currentUserId !== envelope.state.currentUserId || cached.draft?.currentUserId !== envelope.state.currentUserId) throw new Error('Recovery account mismatch.');
      const result = mergeState(cached.base, cached.draft, envelope.state);
      // Older clients rewrote already-saved drag operations. Retain their edits as a new entry.
      const recovered = [];
      for (const operation of result.value.operations) {
        const saved = envelope.state.operations.find(item => item.id === operation.id);
        if (saved && operation.userId === envelope.state.currentUserId && !operation.undone && !same(saved, operation)) {
          recovered.push({ ...operation, id: createId('operation'), timestamp: Date.now(), oldState: saved.newState });
          Object.assign(operation, saved);
        }
      }
      result.value.operations = [...recovered, ...result.value.operations];
      apply(result.value);
      conflicted = result.conflicts.length > 0;
      conflictBase = conflicted ? cached.base : null;
      useEditorStore.setState({ syncConflict: result.conflicts, saveStatus: 'Save failed' });
      useEditorStore.getState().notify('Recovered your unsaved edits', 'info', conflicted ? 'Review the competing changes before saving.' : 'Reconnecting them to the server.');
    } catch { useEditorStore.getState().notify('Could not read the recovery draft', 'error', 'The server copy is open. The recovery file has been retained.'); }
  }
  connection.flush = flushChanges;
  connection.refresh = refreshState;
  connection.receiveMedia = receiveImportedMedia;
  const unsubscribe = useEditorStore.subscribe((state, previous) => {
    if (applying || !persistedKeys.some(key => state[key] !== previous[key])) return;
    cacheDraft();
    if (conflicted) return;
    const now = Date.now();
    if (!dirtySince) dirtySince = now;
    clearTimeout(timer);
    useEditorStore.setState({ saveStatus: 'Saving…' });
    // Re-arming the debounce on every keystroke meant a long drag or a bulk edit published nothing
    // until the user paused. Cap the wait so the other machine sees the work in progress.
    timer = setTimeout(() => void flushChanges().catch(error => useEditorStore.getState().notify(error.message, 'error')), Math.max(0, Math.min(120, dirtySince + 300 - now)));
  });
  // Exchange only ephemeral presence at 20Hz; project persistence has its own slower poll.
  const clientId = createId('presence'), presenceAbort = new AbortController();
  let pollingPresence = false, lastPresence = 0, presenceRetryAt = 0, presenceFailures = 0, lastPublished = 0;
  let publishedProject: string | null = null, publishedCursor = false, presenceRefreshPending = false, publishedPlaying = false;
  let publishedSignature = '';
  const pollPresence = async () => {
    if (pollingPresence || session !== generation || Date.now() < presenceRetryAt || (typeof document !== 'undefined' && document.hidden && !publishedCursor && Date.now() - lastPresence < 1000)) return;
    const s = useEditorStore.getState();
    const inProject = window.location.pathname === `/project/${encodeURIComponent(s.projectId)}` && s.projects.some(project => project.id === s.projectId);
    const leavingProject = publishedProject && (!inProject || publishedProject !== s.projectId);
    if (!inProject && !publishedProject) return;
    pollingPresence = true; lastPresence = Date.now();
    try {
      if (leavingProject) {
        await api('/presence', { method: 'POST', signal: AbortSignal.any([presenceAbort.signal, AbortSignal.timeout(5000)]), body: JSON.stringify({ clientId, projectId: publishedProject, online: false }) });
        publishedProject = null; publishedCursor = false;
        return;
      }
      const active = typeof document === 'undefined' || (!document.hidden && document.hasFocus());
      const cursor = active ? s.cursor : null;
      // Anything a collaborator can see goes in the signature, so a moving cursor still publishes every
      // tick; only genuinely idle repeats are held back, and a running playhead is sent at 4 Hz.
      const signature = JSON.stringify([active, s.projectId, s.timelineId, cursor, s.playhead, s.selectedClipId, s.mediaPresenceTab, s.inspectorPresenceTab, s.workspace, s.liveMode === 'presenting', s.playing && !s.playbackBuffering, s.dragPreview]);
      // Starting and stopping go out at once; only a playhead already known to be running is held to 4 Hz.
      if (!presenceDue(signature, publishedSignature, Date.now() - lastPublished, s.playing && publishedPlaying) && (incremental && events?.readyState === 1 || Date.now() - lastPublished < 100)) return;
      const response = await api<{ presence: Presence[]; serverTime?: number }>('/presence', { method: 'POST', signal: AbortSignal.any([presenceAbort.signal, AbortSignal.timeout(5000)]), body: JSON.stringify({ clientId, active, projectId: s.projectId, timelineId: s.timelineId, cursor, playhead: s.playhead, selectedClipId: s.selectedClipId, mediaTab: s.mediaPresenceTab, inspectorTab: s.inspectorPresenceTab, activity: s.workspace, online: true, presenting: s.liveMode === 'presenting', playing: s.playing && !s.playbackBuffering, preview: active ? s.dragPreview : null }) });
      publishedProject = s.projectId; publishedCursor = !!cursor;
      publishedSignature = signature; lastPublished = Date.now(); publishedPlaying = s.playing;
      presenceFailures = 0; presenceRetryAt = 0;
      receivePresence({ ...response, projectId: s.projectId });
    } catch (error) { presenceRetryAt = Date.now() + Math.min(3000, 250 * 2 ** presenceFailures++); if (session === generation) { useEditorStore.setState({ serverOnline: false }); if (error instanceof ApiError && error.status === 401) resetSession(); } }
    finally { pollingPresence = false; if (presenceRefreshPending) { presenceRefreshPending = false; void pollPresence(); } }
  };
  const refreshPresence = () => { if (pollingPresence) presenceRefreshPending = true; else void pollPresence(); };
  const presencePoll = setInterval(pollPresence, 50);
  window.addEventListener('blur', refreshPresence);
  window.addEventListener('focus', refreshPresence);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refreshPresence);
  const events = typeof EventSource === 'undefined' ? undefined : new EventSource(`/api/events?clientId=${encodeURIComponent(clientId)}`);
  const changed = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      if (typeof data.revision === 'number' && data.revision > serverRevision) serverRevision = data.revision;
      if (typeof data.locks === 'number' && data.locks > serverLockRevision) serverLockRevision = data.locks;
    } catch { /* a frame we cannot parse still means something changed */ }
    void refreshState();
  };
  events?.addEventListener('change', changed as EventListener);
  events?.addEventListener('transitions', () => { if (session === generation) useEditorStore.getState().loadLeaks(); });
  events?.addEventListener('open', () => { if (session === generation) { useEditorStore.getState().loadLeaks(); void refreshState(); } });
  events?.addEventListener('error', () => { if (session === generation) useEditorStore.setState({ serverOnline: false }); });
  let presenceServerTime = 0;
  const receivePresence = (data: { projectId?: string; presence: Presence[]; serverTime?: number }) => {
    const state = useEditorStore.getState();
    if (session !== generation || data.projectId && data.projectId !== state.projectId || (data.serverTime ?? 0) < presenceServerTime) return;
    presenceServerTime = data.serverTime ?? 0;
    const presence = receivedPresence(data.presence.filter(person => person.userId !== state.currentUserId && person.projectId === state.projectId), data.serverTime, performance.now(), state.presence);
    // Every setState runs every store selector; an unchanged reply (alone in the project) skips that.
    if (presence !== state.presence || !state.serverOnline) useEditorStore.setState({ presence, serverOnline: true });
  };
  events?.addEventListener('presence', ((event: MessageEvent) => {
    try { receivePresence(JSON.parse(event.data)); } catch { /* the next heartbeat recovers */ }
  }) as EventListener);
  let polling = false;
  const poll = setInterval(async () => {
    if (polling || session !== generation) return;
    polling = true;
    try { await refreshState(); } finally { polling = false; }
  }, 1000);
  // The event stream is the fast path; this only covers frames that arrived while we were busy.
  const catchUp = setInterval(() => { if (session === generation && behind()) drainRefresh(); }, 200);
  const leave = (event: BeforeUnloadEvent) => {
    if (uploadQueue.getState().jobs.some(job => ['queued', 'uploading'].includes(job.status))) { event.preventDefault(); event.returnValue = ''; }
    if (baseline && !same(baseline, persistentState(useEditorStore.getState()))) {
      cacheDraft(); event.preventDefault(); event.returnValue = '';
    }
  };
  const closePresence = () => { if (publishedProject) void api('/presence', { method: 'POST', keepalive: true, body: JSON.stringify({ clientId, projectId: publishedProject, online: false }) }).catch(() => {}); };
  const finishGesture = () => { if (dirtySince && !conflicted) void flushChanges().catch(() => {}); };
  window.addEventListener('pointerup', finishGesture);
  window.addEventListener('pagehide', closePresence);
  window.addEventListener('beforeunload', leave);
  stopped = () => { presenceAbort.abort(); window.removeEventListener('pointerup', finishGesture); closePresence(); events?.close(); clearInterval(presencePoll); clearInterval(poll); clearInterval(catchUp); clearTimeout(timer); unsubscribe(); window.removeEventListener('beforeunload', leave); window.removeEventListener('pagehide', closePresence); window.removeEventListener('blur', refreshPresence); window.removeEventListener('focus', refreshPresence); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refreshPresence); };
  if (!conflicted) await flushChanges().catch(error => {
    // Loading succeeded; retain the recovered editor and show a save error in place.
    if (session === generation) useEditorStore.getState().notify(error.message, 'error');
  });
}

export async function signOut() {
  const session = generation;
  await flushChanges();
  if (session !== generation) return;
  await api('/auth/logout', { method: 'POST' });
  if (session === generation) resetSession();
}
