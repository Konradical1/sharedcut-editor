// The MCP's connection to a SharedCut server: the signed-in session, the editor store running headless, and the
// save loop. It is src/services/sync.ts without a browser: the store is the same one the editor runs, loaded with the
// server's copy, and every edit goes back as a PATCH delta. Before each tool call it catches up; after, it saves.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { useEditorStore as store, persistentState, sealHistory } from '../src/state/store.ts';
import { connection } from '../src/services/api.ts';
import { stateDelta, applyStateDelta, stateEqual } from '../src/services/stateDelta.ts';
import { mergeState } from '../src/services/merge.ts';
import type { PersistedState } from '../src/services/index.ts';
import type { User } from '../src/state/models.ts';

export const CONFIG_FILE = join(homedir(), 'sharedcut-agent', 'mcp.json');
export const DEFAULT_URL = 'https://sharedcut.com';

/** FRAME_LINE_URL / FRAME_LINE_COOKIE win; else what `npm run mcp:login` saved. */
export function config(): { url: string; cookie: string } {
  let saved: { url?: string; cookie?: string } = {};
  try { if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* A broken file reads as signed out. */ }
  const url = (process.env.FRAME_LINE_URL ?? saved.url ?? DEFAULT_URL).replace(/\/$/, '');
  return { url, cookie: process.env.FRAME_LINE_COOKIE ?? saved.cookie ?? '' };
}

export class ApiFailure extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any, path: string) { super(data?.error ? `${data.error} (${status})` : `${path} -> ${status}`); this.status = status; this.data = data; }
}
export const SIGN_IN = 'Not signed in to SharedCut. Run `npm run login` in the sharedcut-mcp folder (`npm run mcp:login` in the SharedCut repo), then retry.';

// Every request the store makes is a relative /api/... fetch from a browser page. Point those at the server with the
// session cookie, and remember them: an action's fire-and-forget request must land before its result is reported.
const pending = new Set<Promise<unknown>>();
let installed = false;
export function installFetch() {
  if (installed) return;
  installed = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    if (typeof input !== 'string' || !input.startsWith('/')) return real(input, init);
    const { url, cookie } = config(), headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const request = real(url + input, { ...init, headers, credentials: undefined });
    // An upload's 8 MiB chunks are background work: an action must not wait for them to land.
    if ((init.method ?? 'GET') === 'PUT' && /^\/api\/media\/[^/?]+\/upload$/.test(input)) return request;
    const tracked: Promise<unknown> = request.catch(() => {}).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return request;
  }) as typeof fetch;
}

/** Requests in flight right now; settle() can ignore these, since the action being run did not start them. */
export const inFlight = () => new Set(pending);
/** Resolve once nothing an action started is still in flight, including the refresh its reply triggers. */
export async function settle(ignore = new Set<Promise<unknown>>(), timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs, own = () => [...pending].filter(p => !ignore.has(p));
  for (let quiet = 0; quiet < 2 && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const open = own();
    if (open.length) { quiet = 0; await Promise.race([Promise.all(open), new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now())))]); }
    else quiet++;
  }
}

export async function call<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  installFetch();
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`/api${path}`, { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const type = response.headers.get('content-type') ?? '';
  const data = response.status === 204 ? null : type.includes('json') ? await response.json().catch(() => null) : Buffer.from(await response.arrayBuffer());
  // An expired or revoked session: say how to fix it, wherever it shows up.
  if (response.status === 401 && path !== '/auth/me') { user = null; throw new Error(SIGN_IN); }
  if (!response.ok) throw new ApiFailure(response.status, data, path);
  return data as T;
}

type Envelope = { revision: number; baseRevision?: number; delta?: any; state?: PersistedState; locks?: any[]; presence?: any[] };
let baseline: PersistedState | null = null;
let revision = -1;
let user: User | null = null;

export const signedIn = () => user;

function apply(state: Record<string, unknown>) { store.setState(state as never); }
function ephemeral(envelope: Envelope) {
  const patch: Record<string, unknown> = {};
  if (envelope.locks) patch.locks = envelope.locks;
  if (envelope.presence) patch.presence = envelope.presence;
  if (Object.keys(patch).length) apply(patch);
}

// Catching up and saving never interleave: two at once would each move the baseline under the other, and a
// mismatch there used to mean reconnecting, which dropped unsaved edits.
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = lock.then(work);
  lock = run.catch(() => {});
  return run;
}

/** While a batch runs, a save asked for from outside it (a depth retry, the next upload, a loop an earlier step left
 *  running) waits for the batch, whose single save covers it; a save the batch's own code asks for goes through. */
let batch: { owns: () => boolean; done: Promise<unknown> } | null = null;
export function holdBackgroundSaves(running: typeof batch) { batch = running; }

/** Sign in and load the workspace into the store. Safe to call again: it reconnects from scratch. */
export async function connect() {
  installFetch();
  if (!config().cookie) throw new Error(SIGN_IN);
  const me = await call<{ user: User | null }>('/auth/me');
  if (!me.user) throw new Error(SIGN_IN);
  const envelope = await call<Envelope>('/state');
  if (!envelope.state) throw new Error('The server did not return the workspace.');
  user = me.user; baseline = envelope.state; revision = envelope.revision; conflicts = [];
  connection.enabled = true;
  connection.flush = () => batch && !batch.owns() ? batch.done.then(() => {}) : flush();
  connection.refresh = refresh;
  // An import's answer already holds the new media row (sync.ts receiveImportedMedia).
  connection.receiveMedia = asset => {
    const upsert = (list: PersistedState['media']) => list.some(m => m.id === asset.id) ? list.map(m => m.id === asset.id ? asset : m) : [asset, ...list];
    if (baseline) baseline = { ...baseline, media: upsert(baseline.media) };
    apply({ media: upsert(store.getState().media) });
  };
  sealHistory(envelope.state.operations);
  // The store boots holding the demo project and its selection; none of that belongs to this account.
  apply({ ...envelope.state, session: 'ready', serverOnline: true, saveStatus: 'Saved', notifications: [], syncConflict: [], presence: [], locks: [],
    projectId: '', timelineId: '', selectedClipId: null, selectedClipIds: [], selectedNodeId: null, selectedTextIds: [], textSelection: null, textPreview: [], textTool: false,
    selectedTransition: null, selectedMarkerIds: [], selectedMediaIds: [], compositionTrail: [], clipboard: null, clipboardClips: [], clipboardNodes: [], playing: false, liveMode: 'independent', followUserId: null, modal: null });
  ephemeral(envelope);
  // The shared transition library (overlays, saved presets, favorites): addTransition reads it, as loadLeaks does in the browser.
  try {
    const library = await call<{ leaks?: unknown[]; presets?: unknown[]; favorites?: string[] }>('/transitions');
    apply({ leaks: library.leaks ?? [], transitionPresets: library.presets ?? [], transitionFavorites: library.favorites ?? [] });
  } catch { /* Optional, as in the browser: transitions still work without the shared pack. */ }
}

/** Take whatever changed on the server since the last look; unsaved local edits merge on top. */
export const refresh = () => exclusive(refreshNow);
async function refreshNow() {
  if (!baseline) return connect();
  let envelope = await call<Envelope>(`/state?since=${revision}&delta=1`);
  if (envelope.delta) {
    // The server no longer holds our revision: take its whole copy, still merging, never reconnecting.
    if (envelope.baseRevision !== revision) envelope = await call<Envelope>('/state');
    else envelope.state = applyStateDelta(baseline, envelope.delta);
  }
  ephemeral(envelope);
  if (!envelope.state || envelope.revision < revision) return;
  conflicts.push(...receive(envelope.state, envelope.revision));
}
// A refresh mid-batch (an API-backed step, the upload pump) can find a collaborator's change to something the batch also
// changed. mergeState keeps ours, so remember it, and let the batch's save refuse instead of overwriting their edit.
let conflicts: string[] = [];
function receive(remote: PersistedState, nextRevision: number, base = baseline!) {
  const local = persistentState(store.getState());
  const merged = stateEqual(local, base) ? { value: remote, conflicts: [] as string[] } : mergeState(base, local, remote);
  // Media, exports and accounts are the server's alone: a save that changes them is refused outright.
  const value = { ...merged.value, media: remote.media, renderJobs: remote.renderJobs, users: remote.users, currentUserId: remote.currentUserId };
  sealHistory(remote.operations);
  baseline = remote; revision = nextRevision;
  apply(value as never);
  return merged.conflicts;
}

/** Drop unsaved local edits: back to what the server holds. */
export function revert() { if (baseline) apply(baseline as never); }
export const unsaved = () => !!baseline && !stateEqual(persistentState(store.getState()), baseline);

/** Save local edits. A refused save is reverted so the store never drifts from the server; the reason is thrown. */
export const flush = () => exclusive(flushNow);
const collaborator = (paths: string[]) => new Error(`A collaborator changed the same thing (${paths.slice(0, 3).join(', ')}). Their version was kept; look again and redo.`);
async function flushNow(): Promise<void> {
  if (!baseline) return;
  if (conflicts.length) { const paths = conflicts; conflicts = []; if (unsaved()) { revert(); throw collaborator(paths); } }
  let lost = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const sent = persistentState(store.getState()), sentBase = baseline, sentRevision = revision;
    if (stateEqual(sent, sentBase)) { apply({ saveStatus: 'Saved' }); return; }
    sealHistory(sent.operations);
    try {
      const response = await call<Envelope>('/state', { method: 'PATCH', json: { revision: sentRevision, delta: stateDelta(sentBase, sent) } });
      receive(response.delta ? applyStateDelta(sent, response.delta) : response.state ?? sent, response.revision, sent);
      ephemeral(response);
      if (unsaved()) continue; // edits made while the request was out go in the next round
      apply({ saveStatus: 'Saved' });
      return;
    } catch (error) {
      // The reply was lost (a dropped connection, a tunnel 5xx) but the server may have saved it. Look before redoing:
      // if it did, our edits equal its copy and the next round finds nothing to send; if not, the same ids go again.
      if (!(error instanceof ApiFailure) || error.status >= 500) {
        if (error instanceof Error && error.message === SIGN_IN) { revert(); throw error; }
        if (++lost > 2) { revert(); throw new Error('The connection to SharedCut kept failing during the save, so whether it saved is unknown. Look at the timeline before redoing anything.'); }
        try { await refreshNow(); } catch { revert(); throw new Error('Lost the connection to SharedCut during the save; whether it saved is unknown. Look at the timeline before redoing anything.'); }
        if (conflicts.length) { const paths = conflicts; conflicts = []; revert(); throw collaborator(paths); }
        continue;
      }
      // Someone saved first: take their copy, keep ours on top, and try again.
      if (error.status === 409 && error.data?.revision !== undefined) {
        const remote = error.data.delta && error.data.baseRevision === sentRevision ? applyStateDelta(sentBase, error.data.delta) : error.data.state;
        if (!remote) { await refreshNow(); continue; }
        const clash = receive(remote, error.data.revision, sentBase);
        if (clash.length) { revert(); throw collaborator(clash); }
        continue;
      }
      revert();
      if (error.status === 423) throw new Error(`A collaborator is editing that right now: ${error.data?.error ?? 'locked'}. Nothing was saved; try again in a few seconds.`);
      throw new Error(`The server refused the change: ${error.data?.error ?? error.message}`);
    }
  }
  revert();
  throw new Error('The server kept changing during the save. Nothing was saved; try again.');
}
