// SharedCut Desktop's link to sharedcut.com (FRAME_LINE_REMOTE). Each project kept on this computer is merged three
// ways every few seconds: the copy both sides last agreed on (its base, data/remote-sync/<id>.json), this computer's and
// sharedcut.com's. While online that keeps the two live within seconds; offline the edits wait in the local copy and go
// up with the first merge back online. When both sides changed the same field, this computer's edit wins. New footage
// goes up (resumable upload) and comes down (ranged download) beside the merge, never inside it. A project made on this
// computer goes up by itself, as the signed-in account's own, and is kept from then on; one made on sharedcut.com comes
// down only when kept (its footage can be hundreds of GB).
// ponytail: undo history, exports and server-side analysis files (motion tracks, masks, depth) stay on the computer that
// made them; carry them when someone misses them.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mergeState } from '../src/services/merge.ts';
import { applyStateDelta, stateDelta, stateEqual as equal } from '../src/services/stateDelta.ts';
import type { PersistedState } from '../src/services/index.ts';
import type { MediaAsset, User } from '../src/state/models.ts';
import type { NormalizeLink } from './colorNormalize.ts';

const LISTS = ['timelines', 'tracks', 'clips', 'nodes', 'comments', 'snapshots', 'scripts', 'scriptBlocks', 'shots', 'boardItems'] as const;
// Each server's own: who may open the project, its offline lock and its Final Cut import card.
const HELD = ['members', 'shared', 'classRole', 'lock', 'fcpImport'];
const CHUNK = 8 * 1024 * 1024, TRANSFERS = 2, ID = /^[a-zA-Z0-9_-]{1,160}$/;
type Item = { id: string; [key: string]: any };
type Slice = { project: Item; media: Item[] } & Record<(typeof LISTS)[number], Item[]>;
const EMPTY = { project: {}, media: [], ...Object.fromEntries(LISTS.map(key => [key, []])) } as unknown as Slice;

export interface SyncHost {
  dataDir: string;
  state(): PersistedState;
  revision(): number;
  /** Saves a workspace the sync built; throws, changing nothing, when it is refused. */
  write(next: PersistedState): void;
  updateAsset(id: string, patch: Partial<MediaAsset>): void;
  /** Prepares an asset whose original just arrived. */
  prepare(id: string): void;
  /** Removes the files of an asset already gone from the workspace. */
  dropFiles(id: string): void;
  originalPath(id: string): string;
}
export type ProjectSync = { id: string; name: string; kept: boolean; here: boolean; status?: 'synced' | 'offline' | 'error'; error?: string; syncedAt?: number; uploading: number; downloading: number };
// linked: every project kept here at any time, so one deleted or unshared on sharedcut.com never goes up again by itself.
// made: projects made here that go up once signed in and online.
type Config = { url: string; cookie?: string; user?: User; localUserId?: string; kept: string[]; linked?: string[]; made?: string[] };
class Offline extends Error {}
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

const omit = (item: Item, keys: string[]) => Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key))) as Item;
const pick = (item: Item | undefined, keys: string[]) => Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => keys.includes(key)));
/** The slice with each list in id order, so a merge and its comparisons ignore where each server keeps an item. */
const canon = (slice: Slice) => Object.fromEntries(Object.entries(slice).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : value])) as Slice;
/** User ids differ per server: this computer's account stands in for the sharedcut.com one and back. */
const swap = <T>(value: T, from: string, to: string): T => from === to ? value : JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(from), JSON.stringify(to)));

export function sliceOf(state: PersistedState, id: string): Slice | undefined {
  const project = state.projects.find(p => p.id === id); if (!project) return undefined;
  const timelines = new Set(state.timelines.filter(t => t.projectId === id).map(t => t.id));
  return canon({ project: omit(project as unknown as Item, HELD), media: state.media.filter(m => m.projectId === id).map(({ id, projectId, name, binId }) => ({ id, projectId, name, binId })),
    ...Object.fromEntries(LISTS.map(key => [key, (state[key] as unknown as Item[]).filter(item => key === 'tracks' ? timelines.has(item.timelineId) : item.projectId === id)])) } as unknown as Slice);
}

/** The workspace with one project's entities swapped for the slice's, each kept where it was and new ones first. */
function withSlice(state: PersistedState, id: string, slice: Slice, project: Item, media?: MediaAsset[]): PersistedState {
  const timelines = new Set(state.timelines.filter(t => t.projectId === id).map(t => t.id));
  const place = (list: readonly Item[], mine: (item: Item) => boolean, items: readonly Item[]) => {
    const byId = new Map(items.map(item => [item.id, item])), had = new Set<string>();
    const kept = list.flatMap(item => { if (!mine(item)) return [item]; had.add(item.id); return byId.has(item.id) ? [byId.get(item.id)!] : []; });
    return [...items.filter(item => !had.has(item.id)), ...kept];
  };
  return { ...state, projects: place(state.projects as unknown as Item[], p => p.id === id, [project]), ...(media ? { media: place(state.media as unknown as Item[], m => m.projectId === id, media as unknown as Item[]) } : {}),
    ...Object.fromEntries(LISTS.map(key => [key, place(state[key] as unknown as Item[], item => key === 'tracks' ? timelines.has(item.timelineId) : item.projectId === id, slice[key])])) } as unknown as PersistedState;
}

export function remoteSync(host: SyncHost, options: { url: string; everyMs?: number }) {
  const configPath = join(host.dataDir, 'remote-sync.json'), basesDir = join(host.dataDir, 'remote-sync');
  let config: Config = { url: options.url, kept: [] };
  try { config = { ...config, ...JSON.parse(readFileSync(configPath, 'utf8')), url: options.url }; } catch { /* never linked */ }
  const save = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const basePath = (id: string) => join(basesDir, `${id}.json`);
  const readBase = (id: string): Slice | undefined => { try { return JSON.parse(readFileSync(basePath(id), 'utf8')); } catch { return undefined; } };
  const writeBase = (id: string, slice: Slice) => { mkdirSync(basesDir, { recursive: true, mode: 0o700 }); writeFileSync(`${basePath(id)}.tmp`, JSON.stringify(slice), { mode: 0o600 }); renameSync(`${basePath(id)}.tmp`, basePath(id)); };

  async function call(path: string, init: RequestInit & { json?: unknown } = {}, ms = 60_000) {
    const { json, ...rest } = init; let response: Response;
    try { response = await fetch(config.url + path, { ...rest, body: json !== undefined ? JSON.stringify(json) : rest.body, headers: { ...(config.cookie ? { cookie: config.cookie } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...rest.headers as Record<string, string> }, signal: AbortSignal.timeout(ms) }); }
    catch (error) { throw new Offline(`sharedcut.com can't be reached (${(error as Error).message}).`); }
    // The tunnel answers 502/530 while the server restarts: that is offline for a moment, not a refusal.
    if ([502, 503, 504, 530].includes(response.status)) throw new Offline(`sharedcut.com is restarting (${response.status}).`);
    if (response.status === 401 && path !== '/api/auth/login') { config = { ...config, cookie: undefined }; save(); }
    return response;
  }
  async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}, ms?: number): Promise<T> {
    const response = await call(path, init, ms), body = await response.json().catch(() => ({}));
    if (!response.ok) throw httpError(body.error ?? `sharedcut.com answered ${response.status}.`, response.status);
    return body;
  }

  // sharedcut.com's workspace as this account sees it, kept current with the same deltas a browser tab uses.
  let remote: { revision: number; state: PersistedState } | undefined;
  async function pull(): Promise<{ revision: number; state: PersistedState }> {
    const body = await api(`/api/state${remote ? `?since=${remote.revision}&delta=1` : ''}`);
    if (body.state) remote = { revision: body.revision, state: body.state };
    else if (body.delta && remote && body.baseRevision === remote.revision) remote = { revision: body.revision, state: applyStateDelta(remote.state, body.delta) };
    else if (body.revision !== remote?.revision) { remote = undefined; return pull(); }
    return remote!;
  }

  const status = new Map<string, Pick<ProjectSync, 'status' | 'error' | 'syncedAt'>>(), flight = new Map<string, 'up' | 'down'>();
  let online = false, seen = '';
  /** Saves `next` on sharedcut.com as one delta against the revision it was read at; false when that revision moved on (409). */
  async function patch(next: PersistedState) {
    const delta = stateDelta(remote!.state, next); if (!Object.keys(delta).length) return true;
    try { const body = await api('/api/state', { method: 'PATCH', json: { revision: remote!.revision, delta } }); remote = { revision: body.revision, state: applyStateDelta(next, body.delta) }; return true; }
    catch (error) { if ((error as { status?: number }).status === 409) return false; throw error; }
  }
  const moved = () => httpError('sharedcut.com changed meanwhile; this syncs on the next pass.', 409);

  /** One project's merge; `again` allows one fresh look at sharedcut.com after changing its media or losing a race. */
  async function syncOne(id: string, again = true): Promise<void> {
    const me = config.user!.id, localUser = config.localUserId!;
    const view = remote!.state, there = view.projects.find(p => p.id === id), now = host.state(), L = sliceOf(now, id), B = readBase(id);
    // Deleted on this computer after it was kept, or before it went up: it stops syncing; sharedcut.com keeps any copy.
    if (!L && (B || !there)) { keep(id, false); return; }
    if (!there) {
      // Made here and not up yet: it goes up as this account's private project, made the way a browser makes one (the
      // project with its timelines and tracks); its media, then the rest, follow below. Anything else missing there was
      // deleted on sharedcut.com or unshared: never brought back, and this computer keeps its copy.
      if (!config.made?.includes(id)) throw new Error('Not on sharedcut.com any more (deleted there, or no longer shared with you). Your copy here stays.');
      const up = swap({ ...EMPTY, project: L!.project, timelines: L!.timelines, tracks: L!.tracks }, localUser, me);
      const made = await patch(withSlice(view, id, up, { ...up.project, members: [{ userId: me, role: 'Owner' }], shared: false }))
        .catch((error: { status?: number }) => { throw error.status === 403 ? httpError('sharedcut.com has a project with this id that your account cannot open, so this one stays on this computer.', 403) : error; });
      if (made) return syncOne(id, again);
      if (!again) throw moved();
      remote = undefined; await pull(); return syncOne(id, false);
    }
    if (config.made?.includes(id)) { config = { ...config, made: config.made.filter(item => item !== id) }; save(); }
    // Locked there (an offline copy being put back by hand): its copy is not the one to merge with until it is unlocked.
    if (there.lock) throw new Error(`Locked on sharedcut.com${there.lock.note ? ` (${there.lock.note})` : ''}. It syncs once its owner unlocks it.`);
    const theirs = sliceOf(view, id)!, R = canon(swap(theirs, me, localUser));
    let M = L ? canon(mergeState(B ?? EMPTY, L, R).value) : R;
    // An asset a clip still uses stays, whichever side deleted it: a clip without its media is refused.
    const used = new Set([...M.clips.map(c => c.mediaId), ...M.boardItems.map(b => b.mediaId), ...M.shots.flatMap(s => s.mediaIds ?? []), ...M.snapshots.flatMap(s => s.state.clips.map((c: Item) => c.mediaId))]);
    const back = [...(L?.media ?? []), ...R.media].filter((asset, i, all) => used.has(asset.id) && !M.media.some(m => m.id === asset.id) && all.findIndex(a => a.id === asset.id) === i);
    if (back.length) M = canon({ ...M, media: [...M.media, ...back] });

    // Media first, through its own endpoints: the state save refuses media changes, and a clip needs its asset to exist.
    const remoteMedia = new Map(view.media.filter(m => m.projectId === id).map(m => [m.id, m])), localMedia = new Map(now.media.filter(m => m.projectId === id).map(m => [m.id, m]));
    let touched = false;
    for (const asset of M.media) {
      let up = remoteMedia.get(asset.id); const here = localMedia.get(asset.id);
      // A placeholder takes its bin from its kind there; a file in another bin here moves at once, not on a second pass.
      if (!up && here) { up = (await api(`/api/media?${new URLSearchParams({ projectId: id, id: asset.id, name: here.name, placeholder: '1' })}`, { method: 'POST' })).asset; sent.delete(asset.id); touched = true; }
      if (up && (up.name !== asset.name || up.binId !== asset.binId)) { await api(`/api/media/${asset.id}`, { method: 'PATCH', json: { name: asset.name, binId: asset.binId } }); touched = true; }
    }
    if (touched && again) { await pull(); return syncOne(id, false); }

    // This computer: written at once, before any wait, so an edit made here meanwhile is never overwritten.
    const held = now.projects.find(p => p.id === id) as unknown as Item | undefined;
    if (!L || !equal(L, M)) {
      const media = M.media.map(asset => {
        const here = localMedia.get(asset.id);
        if (here) return here.name === asset.name && here.binId === asset.binId ? here : { ...here, name: asset.name, binId: asset.binId };
        const up = remoteMedia.get(asset.id)!;
        return { id: up.id, projectId: id, name: asset.name, kind: up.kind, binId: asset.binId, thumbnail: '', duration: up.duration, resolution: up.resolution, fps: up.fps, size: up.size, status: 'downloading', progress: 0 } as MediaAsset;
      });
      host.write(withSlice(now, id, M, { ...M.project, ...(held ? pick(held, HELD) : { members: [{ userId: localUser, role: 'Owner' }], shared: false }) }, media));
      for (const asset of localMedia.values()) if (!M.media.some(m => m.id === asset.id)) host.dropFiles(asset.id);
    }

    // sharedcut.com: the same merge in its account's ids, as one delta against the revision it was read at.
    const Mr = swap(M, localUser, me);
    if (!equal({ ...Mr, media: [] }, { ...theirs, media: [] }) && !(await patch(withSlice(view, id, Mr, { ...Mr.project, ...pick(there as unknown as Item, HELD) })))) {
      if (!again) throw moved();
      remote = undefined; await pull(); return syncOne(id, false);
    }
    writeBase(id, M);
    // Removed on this computer and unused: removed there too. Refused (a snapshot there still uses it) means it comes back.
    for (const asset of remoteMedia.values()) if (!M.media.some(m => m.id === asset.id)) await api(`/api/media/${asset.id}`, { method: 'DELETE' }).catch(() => {});
    status.set(id, { status: 'synced', syncedAt: Date.now() });
  }

  async function download(id: string) {
    const part = join(dirname(host.originalPath(id)), 'download.part');
    mkdirSync(dirname(part), { recursive: true, mode: 0o700 });
    const offset = existsSync(part) ? statSync(part).size : 0;
    const response = await call(`/api/media/${id}/original`, { headers: offset ? { range: `bytes=${offset}-` } : {} }, 6 * 3600_000);
    const total = Number(response.headers.get('content-range')?.split('/')[1] ?? response.headers.get('content-length'));
    if (response.status !== 416) {
      if (![200, 206].includes(response.status) || !response.body) throw new Error(`Download answered ${response.status}.`);
      let got = response.status === 206 ? offset : 0, reported = 0;
      const count = new Transform({ transform(chunk, _encoding, done) { got += chunk.length; if (Date.now() - reported > 5000 && total) { reported = Date.now(); host.updateAsset(id, { progress: Math.min(99, Math.floor(got / total * 100)) }); } done(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), count, createWriteStream(part, { flags: response.status === 206 ? 'a' : 'w', mode: 0o600 }));
    }
    if (!total || statSync(part).size !== total) throw new Error('The download stopped early; it resumes next time.');
    renameSync(part, host.originalPath(id));
    host.updateAsset(id, { status: 'processing', progress: 0, error: undefined }); host.prepare(id);
  }
  async function upload(id: string) {
    const file = host.originalPath(id), size = statSync(file).size;
    let { offset = 0, complete } = await api(`/api/media/${id}/upload`, { method: 'POST', json: { size, fingerprint: `sync:${size}` } });
    const handle = await open(file, 'r'), buffer = Buffer.allocUnsafe(CHUNK);
    try {
      while (!complete && offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - offset), offset), chunk = buffer.subarray(0, bytesRead);
        ({ offset, complete } = await api(`/api/media/${id}/upload`, { method: 'PUT', headers: { 'Upload-Offset': String(offset), 'Upload-Checksum': createHash('sha256').update(chunk).digest('hex') }, body: chunk }, 300_000));
      }
    } finally { await handle.close(); }
    sent.add(id);
  }
  // sent: uploaded this run (sharedcut.com's status catches up on the next look); resting: failed, tried again after a while.
  const sent = new Set<string>(), resting = new Map<string, number>();
  /** Which way an asset's original still has to go. Down when only sharedcut.com has it. Up when sharedcut.com waits for it
   *  (or dropped an upload untouched for a day) and this computer has all of it: one still arriving here, from a browser
   *  ('uploading') or a download ('downloading'), waits; any other status here means its original is whole. */
  function way(asset: MediaAsset, there: MediaAsset | undefined): 'up' | 'down' | undefined {
    if (!there || !config.kept.includes(asset.projectId)) return undefined;
    if (!existsSync(host.originalPath(asset.id))) return there.status === 'ready' && !asset.importLink ? 'down' : undefined;
    return ['uploading', 'failed'].includes(there.status) && !['uploading', 'downloading'].includes(asset.status) && !sent.has(asset.id) ? 'up' : undefined;
  }
  /** Footage either side still lacks, two files at a time; a failed one resumes from its last byte on a later pass. */
  function transfers() {
    if (!remote || closed) return;
    const local = host.state(), up = new Map(remote.state.media.map(m => [m.id, m]));
    for (const asset of local.media) {
      if (flight.size >= TRANSFERS) return;
      const to = flight.has(asset.id) || (resting.get(asset.id) ?? 0) > Date.now() ? undefined : way(asset, up.get(asset.id));
      if (!to) continue;
      flight.set(asset.id, to);
      // Offline, the next file would fail the same way: the next pass online picks them up again.
      void (to === 'down' ? download(asset.id) : upload(asset.id)).then(() => true, error => { if (!(error instanceof Offline)) resting.set(asset.id, Date.now() + 60_000); console.warn(`SharedCut sync: ${asset.name} ${to === 'down' ? 'download' : 'upload'} paused: ${(error as Error).message}`); return !(error instanceof Offline); })
        .then(more => { flight.delete(asset.id); if (more) transfers(); });
    }
  }

  let running: Promise<void> | undefined, closed = false;
  function tick() {
    running ??= (async () => {
      if (closed || !config.cookie || !config.user) return;
      try { await pull(); online = true; } catch (error) { online = error instanceof Offline ? false : online; for (const id of config.kept) status.set(id, { ...status.get(id), status: error instanceof Offline ? 'offline' : 'error', error: (error as Error).message }); return; }
      // Nothing moved on either side since the last clean pass: nothing to merge.
      const key = `${remote!.revision}:${host.revision()}`;
      if (key !== seen) {
        let clean = true;
        // Made here by this computer's account, never kept and not on sharedcut.com: kept, so it goes up below. One this
        // account deleted there (a bundle's copy, still in its Recently deleted) is kept without going up: restored there, it syncs.
        const linked = new Set([...config.kept, ...config.linked ?? []]), made = host.state().projects.filter(p => !linked.has(p.id) && !remote!.state.projects.some(r => r.id === p.id)
          && p.members.some(m => m.userId === config.localUserId && m.role === 'Owner') && !existsSync(basePath(p.id))).map(p => p.id);
        if (made.length) try {
          const deleted = new Set((await api<{ projects: { id: string }[] }>('/api/projects/deleted')).projects.map(p => p.id));
          config = { ...config, kept: [...config.kept, ...made], linked: [...linked, ...made], made: [...config.made ?? [], ...made.filter(id => !deleted.has(id))] }; save();
        } catch { clean = false; }
        for (const id of [...config.kept]) try { await syncOne(id); } catch (error) { clean = false; status.set(id, { ...status.get(id), status: error instanceof Offline ? 'offline' : 'error', error: (error as Error).message }); }
        seen = clean && remote ? `${remote.revision}:${host.revision()}` : '';
      }
      transfers();
    })().finally(() => { running = undefined; });
    return running;
  }
  const timer = setInterval(() => void tick(), options.everyMs ?? 3000); timer.unref();

  function keep(id: string, on: boolean) {
    if (!ID.test(id)) throw httpError('Invalid project.', 400);
    // Stopped before it went up, a project made here stays here: it is linked, so it never goes up by itself again.
    config = on ? { ...config, kept: [...new Set([...config.kept, id])], linked: [...new Set([...config.linked ?? [], id])] } : { ...config, kept: config.kept.filter(item => item !== id), made: config.made?.filter(item => item !== id) };
    if (!on) { rmSync(basePath(id), { force: true }); status.delete(id); }
    save(); seen = '';
  }

  // Auto balance on a computer without the colour worker (colorNormalize.ts): a kept project's copy on sharedcut.com after a fresh
  // sync, and that project's normalize route there through this link's session. Nothing else is reachable, and the cookie stays here.
  const copyOf = (state: PersistedState, id: string) => ({ clips: state.clips.filter(c => c.projectId === id), nodes: state.nodes.filter(n => n.projectId === id), media: state.media.filter(m => m.projectId === id) });
  const normalize: NormalizeLink = {
    blocked(id: string) {
      if (!config.cookie || !config.user) return `Auto balance runs on sharedcut.com: sign in to sharedcut.com${config.user ? ' again' : ''} on the Projects page.`;
      if (!config.kept.includes(id)) return 'Auto balance runs on sharedcut.com: sync this project with sharedcut.com on the Projects page.';
      if (!online && status.get(id)?.status === 'offline') return "You're offline: Auto balance needs sharedcut.com.";
    },
    async synced(id: string) {
      // A pass already under way may have read this computer before the last edit: let it finish, then merge this project afresh.
      await tick(); seen = ''; await tick();
      const why = normalize.blocked(id), now = status.get(id);
      if (why) throw new Error(why);
      if (!online || !remote) throw new Error("You're offline: Auto balance needs sharedcut.com.");
      if (now?.status === 'error') throw new Error(`Could not sync with sharedcut.com: ${now.error}`);
      return { here: copyOf(host.state(), id), there: swap(copyOf(remote.state, id), config.user!.id, config.localUserId!) };
    },
    async call(id: string, method: 'GET' | 'POST' | 'DELETE', jobId?: string, body?: unknown) {
      if (!ID.test(id) || (jobId !== undefined && !/^[a-f0-9-]{36}$/.test(jobId))) throw httpError('Invalid Normalize job.', 400);
      try { return await api(`/api/projects/${id}/color-normalize${jobId ? `/${jobId}` : ''}`, { method, ...(body !== undefined && { json: body }) }, 30_000); }
      catch (error) { throw error instanceof Offline ? Object.assign(error, { offline: true }) : error; }
    },
  };
  return {
    tick,
    /** expired: the account whose session sharedcut.com ended (a sign-out forgets it). uploading/downloading: files still to go. */
    status() {
      const local = host.state(), there = new Map((remote?.state.media ?? []).map(m => [m.id, m])), left = new Map<string, Record<'up' | 'down', number>>();
      for (const asset of local.media) { const to = flight.get(asset.id) ?? way(asset, there.get(asset.id)); if (to) { const n = left.get(asset.projectId) ?? { up: 0, down: 0 }; n[to]++; left.set(asset.projectId, n); } }
      const listed = new Map<string, string>([...(remote?.state.projects ?? []).map(p => [p.id, p.name] as const), ...config.kept.filter(id => !remote?.state.projects.some(p => p.id === id)).map(id => [id, local.projects.find(p => p.id === id)?.name ?? id] as const)]);
      return { url: config.url, user: config.cookie ? config.user ?? null : null, expired: !config.cookie && config.user ? config.user.email : null, online, projects: [...listed].map(([id, name]): ProjectSync => ({ id, name, kept: config.kept.includes(id), here: local.projects.some(p => p.id === id), ...status.get(id), uploading: left.get(id)?.up ?? 0, downloading: left.get(id)?.down ?? 0 })) };
    },
    async login(localUserId: string, email: string, password: string) {
      const response = await call('/api/auth/login', { method: 'POST', json: { email, password } }), body = await response.json().catch(() => ({}));
      if (!response.ok) throw httpError(body.error ?? 'sharedcut.com refused the sign-in.', response.status === 401 ? 401 : 400);
      const cookie = response.headers.getSetCookie().find(item => item.startsWith('frameline_session='))?.split(';')[0];
      if (!cookie) throw httpError('sharedcut.com did not start a session.', 502);
      config = { ...config, cookie, user: body.user, localUserId }; save(); remote = undefined; seen = '';
      // The project list comes with the first look at sharedcut.com, kept projects or not.
      await pull().then(() => { online = true; }, () => {});
    },
    logout() { config = { ...config, cookie: undefined, user: undefined }; save(); remote = undefined; online = false; },
    keep(id: string, on: boolean) { keep(id, on); void tick(); },
    close() { closed = true; clearInterval(timer); return running; },
    normalize,
  };
}
