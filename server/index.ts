import { validateMotionBlur } from '../src/services/motionBlur.ts';
import { workQueue } from './workQueue.ts';
import { stateDelta, applyStateDelta } from '../src/services/stateDelta.ts';
import { parseImportLink, downloadLink, youtubeThumbnail } from './linkImport.ts';
import { soundLibrary } from './sfx.ts';
import { projectLibrary } from './library.ts';
import { captionAvailable, transcribeTimeline } from './captions.ts';
import { captionSignature, captionPresets, validateCaptionSets, isCaption, type CaptionJob } from '../src/services/captions.ts';
import { isShape, getShape, validateShape } from '../src/services/shapes.ts';
import { isComposition, validateCompositions } from '../src/services/compositions.ts';
import { validateKeyframes } from '../src/services/animation.ts';
import { clipSpan, extendClip } from '../src/services/playback.ts';
import { flowChunkSeconds, flowTiming, type FlowPreview } from '../src/services/opticalFlow.ts';
import { flowWorker, flowIdentity, renderOpticalFlow, trimFlowCache } from './opticalFlow.ts';
import { normalizeSettings, pickStabilizeJob, stabilizeCapabilities, stabilizeSolve, trimStabilizeCache } from './stabilize.ts';
import { stabilizeEffect, stabilizeRange, stabilizeSettings, type StabilizePreview } from '../src/services/stabilize.ts';
import { presenceCursor } from '../src/services/presence.ts';
import { fontLibrary } from './fonts.ts';
import { transitionLibrary } from './transitions.ts';
import { transitionPresetId, timelineTransitions, transitionDefinitions, isLeakMedia, leakIdOf, validateTransition } from '../src/services/transitions.ts';
import { isTitle, getText, validateText } from '../src/services/text.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { linkSync, copyFileSync, mkdirSync, existsSync, createReadStream, createWriteStream, statSync, renameSync, rmSync, chmodSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { promisify, isDeepStrictEqual } from 'node:util';
import { LOCK_TTL, MOVEMENT_FIELDS, lockConflict, type PersistedState } from '../src/services/index.ts';
import type { User, Project, MediaAsset, RenderJob, Presence, CollaborativeLock } from '../src/state/models.ts';
import { exportResolveTimeline, importResolve } from './resolve.ts';
import { parseCube, validateGradeNode } from '../src/services/color.ts';
import { smartMaskService, smartMaskCapabilities, resolveSmartMaskArtifact } from './smartMask.ts';
import { validateSmartMask, validateSmartMaskBindings } from '../src/services/smartMask.ts';
import { FILMSTRIP_VERSION, MEDIA_CONCURRENCY, SKIP_COLOR_PROXY, STREAM_VARIANT, getMediaCapabilities, prepareColorProxy, prepareMedia, prepareMediaFilmstrip, prepareMediaThumbnail, probeMedia, preparePreviewVariants, prepareWaveform, renderTimeline, renderSoundEffect } from './media.ts';

const scrypt = promisify(scryptCallback);
const DEFAULT_SETTINGS = { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false, snapping: true, mediaWidth: 278, inspectorWidth: 292, timelineHeight: 294 };
const COLLECTIONS = ['projects', 'media', 'timelines', 'clips', 'tracks', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'] as const;
type Collection = typeof COLLECTIONS[number];
type Asset = MediaAsset & { sourceUrl?: string; proxyUrl?: string; waveform?: unknown; hasAudio?: boolean; error?: string };
type Account = { user: User; hash: string; salt: string; settings: PersistedState['settings'] };
type Entry = Record<string, any>;
const emptyState = (): PersistedState => ({ projects: [], media: [], timelines: [], clips: [], tracks: [], nodes: [], comments: [], operations: [], snapshots: [], renderJobs: [], users: [], currentUserId: '', settings: { ...DEFAULT_SETTINGS } });
const idIsValid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
const jsonValue = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => a === b || isDeepStrictEqual(jsonValue(a), jsonValue(b));
const initials = (name: string) => name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
function object(value: unknown): asserts value is Entry { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object.'); }
function safeJson(value: unknown, depth = 0) {
  if (depth > 30) fail(400, 'The document is too deeply nested.');
  if (typeof value === 'number' && !Number.isFinite(value)) fail(400, 'Numbers must be finite.');
  if (typeof value === 'string' && value.length > 200_000) fail(400, 'A text field is too long.');
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (key.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) fail(400, 'Invalid document field.');
    safeJson(item, depth + 1);
  }
}
const textField = (value: unknown, max: number, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, 'Invalid text field.');
  return value as string;
};
const numberField = (value: unknown, min = -1e6, max = 1e6) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(400, 'Invalid numeric field.'); return value as number; };
const profile = (body: Entry) => {
  const name = textField(body.name, 80, true).trim();
  const email = textField(body.email, 254, true).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  return { name, email, initials: initials(name) };
};
async function jsonBody(req: IncomingMessage) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) fail(415, 'Use application/json.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 20 * 1024 * 1024) fail(413, 'The document exceeds 20 MB.'); chunks.push(chunk); }
  let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON.'); }
  object(body); safeJson(body); return body;
}
async function binaryBody(req: IncomingMessage, max: number, onProgress?: (bytes: number) => void) {
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>max)fail(413,'File or chunk exceeds the size limit.');chunks.push(chunk);onProgress?.(length);}
  if(!length)fail(400,'Empty upload.');return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
function streamFile(req: IncomingMessage, res: ServerResponse, path: string, type?: string, download?: string, immutable?: boolean) {
  let size = 0, modified = 0; try { const file = statSync(path); size = file.size; modified = file.mtimeMs; } catch { fail(404, 'File not found.'); }
  // Prepared media, overlays and hashed bundles are written once under a versioned name and never
  // rewritten, so a viewer reuses its copy instead of re-pulling the file on every page load. The
  // rest still revalidates, which a strong validator below settles in one 304 rather than a refetch.
  const headers: Record<string, string | number> = { 'Content-Type': type ?? contentTypes[extname(path)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache' };
  const look = extname(path) === '.cube';
  const gzip = look && !req.headers.range && (req.headers['accept-encoding'] || '').split(',').some(encoding => {
    const [name, ...parameters] = encoding.trim().split(';'), quality = parameters.find(p => p.trim().startsWith('q='));
    return name.trim().toLowerCase() === 'gzip' && (quality === undefined || Number(quality.trim().slice(2)) > 0);
  });
  if (look) {
    headers.Vary = 'Accept-Encoding'; headers.ETag = `W/"${size}-${modified}"`;
    if (!req.headers.range && req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); res.end(); return; }
  } else {
    // Media is fetched as a long series of ranges. A weak validator cannot satisfy `If-Range`, so
    // every one of those ranges had to come off disk again; a strong one lets the browser resume
    // from its own cache instead.
    headers.ETag = `"${size.toString(36)}-${Math.round(modified).toString(36)}"`;
    headers['Last-Modified'] = new Date(modified).toUTCString();
    if (!req.headers.range && req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); res.end(); return; }
  }
  if (gzip) headers['Content-Encoding'] = 'gzip';
  if (download) headers['Content-Disposition'] = `attachment; filename="${download.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(download)}`;
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2]) || size === 0) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  if (!gzip) headers['Content-Length'] = Math.max(0, end - start + 1); res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const stream = createReadStream(path, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy());
  if (gzip) void pipeline(stream, createGzip(), res).catch(() => res.destroy()); else stream.pipe(res);
}

export function createFrameLineServer(options: { dataDir?: string; distDir?: string; maxUploadBytes?: number } = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.FRAME_LINE_DATA ?? 'data');
  const distDir = resolve(options.distDir ?? 'dist');
  const maxUploadBytes = options.maxUploadBytes ?? Number(process.env.FRAME_LINE_MAX_UPLOAD_BYTES ?? 10 * 1024 ** 3);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) throw new Error('FRAME_LINE_MAX_UPLOAD_BYTES must be a positive integer.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'frameline.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES accounts(id),expiresAt INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deleted_projects(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL,expiresAt INTEGER NOT NULL,data TEXT NOT NULL);');
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(dataDir, `frameline.sqlite${suffix}`))) chmodSync(join(dataDir, `frameline.sqlite${suffix}`), 0o600);
  db.exec('CREATE TABLE IF NOT EXISTS caption_jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL)');
  const captionJobs=()=> (db.prepare("SELECT json_remove(data, '$.words') AS data FROM caption_jobs ORDER BY rowid DESC").all() as {data:string}[]).map(row=>JSON.parse(row.data) as CaptionJob);
  const saveCaptionJob=(job:CaptionJob)=>db.prepare('INSERT INTO caption_jobs(id,projectId,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id,job.projectId,JSON.stringify(job));
  for(const job of captionJobs())if(['waiting','running'].includes(job.status))saveCaptionJob({...job,status:'failed',stage:'Interrupted',error:'The server restarted. Retry transcription.'});
  const fonts = fontLibrary(db);
  const overlays = transitionLibrary(dataDir);
  db.exec('CREATE TABLE IF NOT EXISTS transition_presets(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS transition_favorites(userId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,id TEXT NOT NULL,PRIMARY KEY(userId,id));');
  const transitionPresets = () => db.prepare('SELECT data FROM transition_presets').all().map(row => JSON.parse(String(row.data)));
  const transitionFavorites = (userId: string) => db.prepare('SELECT id FROM transition_favorites WHERE userId=?').all(userId).map(row => String(row.id));

  db.exec('CREATE TABLE IF NOT EXISTS render_snapshots(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const saved = db.prepare('SELECT revision,state FROM workspace WHERE id=1').get() as { revision: number; state: string } | undefined;
  let state: PersistedState = saved ? JSON.parse(saved.state) : emptyState();
  let revision = saved?.revision ?? 0;
  const presence = new Map<string, { person: Presence; session: string; active: boolean }>(); const locks = new Map<string, CollaborativeLock>();
  // Keep insertion order stable: simultaneous active devices must not trade ownership on every heartbeat.
  const visiblePresence = () => {
    const people = new Map<string, { person: Presence; active: boolean }>();
    for (const entry of presence.values()) {
      const key = JSON.stringify([entry.person.projectId, entry.person.userId]);
      const previous = people.get(key);
      if (!previous || (!previous.active && entry.active)) people.set(key, entry);
    }
    return [...people.values()].map(entry => entry.person);
  };
  const subscribers = new Map<ServerResponse, { userId: string; session: string; clientId: string; projectId?: string }>();
  const aborters = new Map<string, AbortController>();
  const authAttempts = new Map<string, { count: number; reset: number }>();
  // Admission cap on the *waiting list*, not on concurrency — MEDIA_CONCURRENCY bounds what runs.
  // Sized for a whole shoot dropped at once: 32 was the old serial queue's concurrency guard and
  // rejected a 253-clip import after the first 32 files.
  const QUEUE_LIMIT = Math.max(32, Number(process.env.FRAME_LINE_QUEUE_LIMIT) || 512);
  // Import mode: accept footage as fast as the disk allows and do no preparation at all. Transcoding
  // competes with the upload for CPU and I/O, and a bulk ingest finishes far sooner if the two are
  // sequential. Assets land as 'processing'; the next restart marks them interrupted and a retry
  // (the importer issues them automatically) prepares them from the originals already on disk.
  const DEFER_PREP = process.env.FRAME_LINE_DEFER_PREP === '1';
  const queue = workQueue(MEDIA_CONCURRENCY); let closed = false;
  const flowDirectory = join(dataDir, 'optical-flow');
  const masks = smartMaskService(join(dataDir, 'smart-masks'));
  const flowJobs = new Map<string, FlowPreview & { projectId: string; clipId: string; generation: string; controller: AbortController }>();
  let flowQueue = Promise.resolve();
  const stabilizeDirectory = join(dataDir, 'stabilize');
  type StabilizeJob = StabilizePreview & { projectId: string; clipId: string; generation: string; controller: AbortController; created: number; polled: number; started: boolean; run: () => Promise<void> };
  const stabilizeJobs = new Map<string, StabilizeJob>();
  let stabilizeBusy = false;
  // One analysis at a time; it saturates every core on its own. The clip asked about most recently goes first.
  const pumpStabilize = () => {
    if (stabilizeBusy || closed) return;
    const next = pickStabilizeJob([...stabilizeJobs.values()].filter(j => j.status === 'preparing' && !j.started && !j.controller.signal.aborted));
    if (!next) return;
    next.started = true; stabilizeBusy = true;
    void next.run().finally(() => { stabilizeBusy = false; pumpStabilize(); });
  };
  const accounts = () => (db.prepare('SELECT data FROM accounts').all() as { data: string }[]).map(row => JSON.parse(row.data) as Account);
  const accountById = (id: string) => { const row = db.prepare('SELECT data FROM accounts WHERE id=?').get(id) as { data: string } | undefined; return row ? JSON.parse(row.data) as Account : undefined; };
  const saveAccount = (account: Account) => db.prepare('INSERT INTO accounts(id,email,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,data=excluded.data').run(account.user.id, account.user.email, JSON.stringify(account));
  const expired = () => { const now = Date.now(); for (const [key, entry] of presence) if (now - entry.person.updatedAt > 15_000) presence.delete(key); for (const [key, lock] of locks) if (lock.expiresAt <= now) locks.delete(key); };
  const sessionHash = (req: IncomingMessage) => { const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('frameline_session='))?.slice(18); return token ? createHash('sha256').update(token).digest('hex') : ''; };
  const authenticated = (req: IncomingMessage) => { const row = db.prepare('SELECT userId FROM sessions WHERE token=? AND expiresAt>?').get(sessionHash(req), Date.now()) as { userId: string } | undefined; return row ? accountById(row.userId) : undefined; };
  const requireAccount = (req: IncomingMessage) => authenticated(req) ?? fail(401, 'Sign in to continue.');
  const requireProject = (id: string, userId: string, write = false) => { const project = state.projects.find(project => project.id === id && visibleTo(project, userId)) ?? fail(404, 'Project not found.'); if (write && !['Owner', 'Editor'].includes(roleFor(project, userId) ?? '')) fail(403, 'An editor role is required.'); return project; };
  // Every item a collaborator can edit is lockable, not just clips and grades. A lock that cannot be
  // taken on a track, timeline, comment or project is a control two machines can edit at once.
  const lockable = (targetId: string, projectId: string) =>
    state.projects.some(item => item.id === targetId && item.id === projectId) ||
    state.tracks.some(item => item.id === targetId && state.timelines.some(timeline => timeline.id === item.timelineId && timeline.projectId === projectId)) ||
    (['timelines', 'clips', 'nodes', 'comments', 'media'] as const).some(key => (state[key] as Entry[]).some(item => item.id === targetId && item.projectId === projectId));
  const view = (account: Account) => {
    expired(); const userId = account.user.id; const allUsers = accounts().map(item => item.user);
    const projects = state.projects.filter(project => visibleTo(project, userId)).map(project => ({ ...project, members: allUsers.flatMap(user => { const role = roleFor(project, user.id); return role ? [{ userId: user.id, role }] : []; }) }));
    const ids = new Set(projects.map(project => project.id)); const timelines = state.timelines.filter(item => ids.has(item.projectId)); const timelineIds = new Set(timelines.map(item => item.id));
    return { revision, lockRevision, state: { ...state, projects, timelines, tracks: state.tracks.filter(item => timelineIds.has(item.timelineId)), ...Object.fromEntries(['media', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'].map(key => [key, (state[key as Collection] as Entry[]).filter(item => ids.has(item.projectId))])), users: allUsers, currentUserId: userId, settings: account.settings }, presence: visiblePresence().filter(item => ids.has(item.projectId)), locks: [...locks.values()].filter(item => ids.has(item.projectId)) };
  };
  // ponytail: four recent views per account, 32 accounts; older clients recover with a full snapshot.
  const recentViews = new Map<string, { revision: number; state: PersistedState }[]>();
  const stateView = (account: Account, since?: number) => {
    const envelope = view(account), history = recentViews.get(account.user.id) ?? [];
    const previous = history.find(item => item.revision === since);
    recentViews.delete(account.user.id);
    recentViews.set(account.user.id, [...history.filter(item => item.revision !== revision), { revision, state: envelope.state }].slice(-4));
    if (recentViews.size > 32) recentViews.delete(recentViews.keys().next().value!);
    if (!previous) return { ...envelope, incremental: true };
    const { state: current, ...ephemeral } = envelope;
    return { ...ephemeral, incremental: true, baseRevision: previous.revision, delta: stateDelta(previous.state, current) };
  };
  const presenceProjects = new Set<string>();
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const broadcastPresence = (projectId: string) => {
    presenceProjects.add(projectId);
    if (presenceTimer || closed) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      if (closed) return;
      expired();
      const people = visiblePresence(), frames = new Map<string, string>();
      for (const [res, subscriber] of subscribers) {
        const id = subscriber.projectId;
        if (!id || !presenceProjects.has(id)) continue;
        const project = state.projects.find(p => p.id === id);
        if (!project || !visibleTo(project, subscriber.userId)) continue;
        if (!frames.has(id)) frames.set(id, `event: presence\ndata: ${JSON.stringify({ projectId: id, presence: people.filter(p => p.projectId === id), serverTime: Date.now() })}\n\n`);
        // A slow receiver reconnects for current state instead of buffering stale pointer positions.
        if (res.writableLength > 256_000) { res.destroy(); subscribers.delete(res); continue; }
        res.write(frames.get(id)!);
      }
      presenceProjects.clear();
    }, 20);
    presenceTimer.unref?.();
  };
  // Polling clients that are already current still need locks and presence. Answering them without
  // rebuilding and serialising the whole workspace is what keeps the 1s poll cheap at scale.
  const ephemeralView = (account: Account) => {
    expired(); const userId = account.user.id;
    const ids = new Set(state.projects.filter(project => visibleTo(project, userId)).map(project => project.id));
    return { revision, lockRevision, presence: visiblePresence().filter(item => ids.has(item.projectId)), locks: [...locks.values()].filter(item => ids.has(item.projectId)) };
  };
  // Locks and presence carry no workspace revision, so clients need their own change counter to
  // learn that a short-circuited poll still owes them a lock update.
  let lockRevision = 0;
  // A burst of writes (bulk edits, media progress) wakes every client once at the final revision
  // instead of once per change, which otherwise storms each client with full-state fetches.
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const broadcast = () => {
    if (closed || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined; if (closed) return;
      const frame = `event: change\ndata: ${JSON.stringify({ revision, locks: lockRevision })}\n\n`;
      for (const res of [...subscribers.keys()]) { try { res.write(frame); } catch { subscribers.delete(res); } }
    }, 20);
    broadcastTimer.unref?.();
  };
  const lockChanged = () => { lockRevision++; broadcast(); };
  const persist = () => { const nextRevision = revision + 1; db.prepare('INSERT INTO workspace(id,revision,state) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state').run(nextRevision, JSON.stringify(state)); revision = nextRevision; broadcast(); };
  const sounds = soundLibrary(dataDir); sounds.recover();
  const library = projectLibrary(db, () => state.projects, () => accounts().map(a => a.user), () => revision, persist);
  const roleFor = library.projectRole;
  const visibleTo = (project: Project, userId: string) => Boolean(roleFor(project, userId));
  const uploadLocks = new Set<string>();
  // Last time an asset's transient progress was written. persist() serialises the WHOLE workspace
  // (every asset, including 32k-sample waveforms) and writes it to SQLite, so progress updates must
  // be rationed: at two per 8MB chunk this import would have done ~23,000 full-state writes, each
  // one costlier than the last as assets completed. That is what made the upload decay.
  const progressAt = new Map<string, number>();
  const resolveDir = (id:string) => join(dataDir,'resolve',id);
  const mediaDir = (id: string) => join(dataDir, 'media', id);
  const originalPath = (id: string) => join(mediaDir(id), 'original');
  const projectBundle = (project: Project) => {
    const timelines = state.timelines.filter(item => item.projectId === project.id), timelineIds = new Set(timelines.map(item => item.id));
    return { projects: [project], timelines, tracks: state.tracks.filter(item => timelineIds.has(item.timelineId)), ...Object.fromEntries(['media', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'].map(key => [key, (state[key as Collection] as Entry[]).filter(item => item.projectId === project.id)])) } as unknown as Record<Collection, Entry[]>;
  };
  const removeProject = (projectId: string) => {
    const timelineIds = new Set(state.timelines.filter(item => item.projectId === projectId).map(item => item.id));
    state = { ...state, projects: state.projects.filter(item => item.id !== projectId), timelines: state.timelines.filter(item => item.projectId !== projectId), tracks: state.tracks.filter(item => !timelineIds.has(item.timelineId)), ...Object.fromEntries(['media', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'].map(key => [key, (state[key as Collection] as Entry[]).filter(item => item.projectId !== projectId)])) };
  };
  const purgeExpiredProjects = () => {
    const rows = db.prepare('SELECT id,data FROM deleted_projects WHERE expiresAt<=?').all(Date.now()) as { id: string; data: string }[];
    for (const row of rows) {
      const bundle = JSON.parse(row.data) as Record<Collection, Entry[]>;
      for (const asset of bundle.media ?? []) rmSync(mediaDir(asset.id), { recursive: true, force: true });
      for (const job of bundle.renderJobs ?? []) for (const extension of ['.mp4', '.mov']) rmSync(join(dataDir, 'renders', `${job.id}${extension}`), { force: true });
      db.prepare('DELETE FROM caption_jobs WHERE projectId=?').run(row.id);
      db.prepare('DELETE FROM deleted_projects WHERE id=?').run(row.id);
    }
  };
  const updateAsset = (id: string, patch: Partial<Asset>) => { if (!state.media.some(asset => asset.id === id)) return; const previous = state.media; state.media = state.media.map(asset => asset.id === id ? { ...asset, ...patch } : asset); try { persist(); } catch (error) { state.media = previous; throw error; } };
  const updateJob = (id: string, patch: Partial<RenderJob>) => { if (!state.renderJobs.some(job => job.id === id)) return; const previous = state.renderJobs; state.renderJobs = state.renderJobs.map(job => job.id === id ? { ...job, ...patch } : job); try { persist(); } catch (error) { state.renderJobs = previous; throw error; } };
  const addWork = (id: string, work: (signal: AbortSignal) => Promise<void>, render = false) => {
    const controller = new AbortController(); aborters.set(id, controller);
    queue.add(async () => { try { if (!closed && !controller.signal.aborted) await work(controller.signal); }
      finally { if (aborters.get(id) === controller) aborters.delete(id); } }, render);
  };
  const startRender = (job: RenderJob, snapshot: Omit<Parameters<typeof renderTimeline>[0], 'outputPath'>) => {
    db.prepare('INSERT OR REPLACE INTO render_snapshots(id,data) VALUES(?,?)').run(job.id, JSON.stringify(snapshot));
    addWork(job.id, async signal => {
            updateJob(job.id, { status: 'rendering', progress: 0, remaining: 'Preparing export · 0s elapsed' }); const extension = job.settings.codec?.includes('ProRes') ? '.mov' : '.mp4'; const outputPath = join(dataDir, 'renders', `${job.id}${extension}`);
            const started = Date.now(); let progressValue = 0;
            const report = () => { if (closed || signal.aborted) return; const elapsed = Math.floor((Date.now() - started) / 1000);
              const eta = progressValue > 0 && progressValue < 100 ? ` · ~${Math.ceil(elapsed * (100 - progressValue) / progressValue)}s remaining` : '';
              updateJob(job.id, { progress: progressValue, remaining: `${progressValue === 0 ? 'Preparing export' : progressValue >= 100 ? 'Finalizing file' : 'Rendering'} · ${elapsed}s elapsed${eta}` }); };
            const heartbeat = setInterval(report, 1000);
            try { let previous = -1; await renderTimeline({ ...snapshot, smartMaskDir:join(dataDir, 'smart-masks'), stabilizeDir:stabilizeDirectory, resolveDir:resolveDir(job.projectId), overlayPath: id => overlays.path(id), outputPath, signal, onProgress: progress => { const next = Math.floor(progress); if (next !== previous) { previous = next; progressValue = Math.max(progressValue, Math.min(100, next)); report(); } } }); if (!signal.aborted) updateJob(job.id, { status: 'complete', progress: 100, remaining: 'Complete', outputUrl: `/api/renders/${job.id}/download` }); }
            catch (error) { rmSync(outputPath, { force: true }); if (!closed) updateJob(job.id, { status: 'failed', remaining: signal.aborted ? 'Cancelled' : 'Export failed', error: signal.aborted ? 'Cancelled by user.' : error instanceof Error ? error.message : 'Export failed.' }); }
            finally { clearInterval(heartbeat); if (!closed) db.prepare('DELETE FROM render_snapshots WHERE id=?').run(job.id); }
    }, true);
  };

  const processAsset = (id: string) => addWork(id, async signal => {
    try {
      const asset = state.media.find(item => item.id === id);
      if (!asset) return;
      if (asset.importLink && !existsSync(originalPath(id))) {
        updateAsset(id, { status: 'downloading', progress: 0, error: undefined });
        const result = await downloadLink(asset.importLink, mediaDir(id), maxUploadBytes, signal, patch => updateAsset(id, patch));
        updateAsset(id, result);
      }
      if (signal.aborted) throw new Error('Import cancelled.');
      updateAsset(id, { status: 'processing', progress: 0, error: undefined });
      let previous = -1;
      const publish = (result: Awaited<ReturnType<typeof probeMedia>> & Partial<Omit<Asset, 'size'>>) => {
        const { size, ...metadata } = result;
        updateAsset(id, { ...metadata, ...(asset.importLink ? { thumbnail: state.media.find(item => item.id === id)?.thumbnail || metadata.thumbnail } : {}), size: size >= 1e9 ? `${(size / 1e9).toFixed(1)} GB` : `${(size / 1e6).toFixed(1)} MB`, sourceUrl: `/api/media/${id}/original`, status: 'ready', progress: 100 });
      };
      const result = await prepareMedia({ inputPath: originalPath(id), outputDir: join(mediaDir(id), 'prepared'), baseUrl: `/api/media/${id}/files`, signal,
        onStage: preparationStage => { if (!signal.aborted) updateAsset(id, { preparationStage }); },
        onPlayable: result => { if (!signal.aborted) publish(result); },
        onThumbnail: thumbnail => { if (!asset.importLink) updateAsset(id, { thumbnail }); },
        onProgress: progress => { const next = Math.floor(progress); if (state.media.find(item => item.id === id)?.status !== 'ready' && next !== previous && Date.now() - (progressAt.get(id) ?? 0) >= 5000) { previous = next; progressAt.set(id, Date.now()); updateAsset(id, { progress: next }); } }
      });
      if (!signal.aborted) { publish(result); updateAsset(id, { preparationStage: undefined, error: undefined }); }
    } catch (error) {
      if (!closed) {
        const playable = state.media.find(asset => asset.id === id)?.status === 'ready';
        updateAsset(id, { status: playable ? 'ready' : 'failed', preparationStage: playable ? 'Additional previews failed · original and playable preview are safe' : undefined, error: signal.aborted ? 'Processing cancelled.' : error instanceof Error ? error.message : 'Media processing failed.', progress: playable ? 100 : 0 });
      }
    }
  });

  const schemas: Record<string, Record<string, string>> = {
    projects: { id: 'string', name: 'string', description: 'string', thumbnail: 'string', modifiedAt: 'number', duration: 'number', resolution: 'string', fps: 'number', shared: 'boolean', status: 'string', members: 'array' },
    timelines: { id: 'string', projectId: 'string', name: 'string', duration: 'number' },
    clips: { id: 'string', projectId: 'string', timelineId: 'string', trackId: 'string', mediaId: 'string', name: 'string', start: 'number', duration: 'number', sourceIn: 'number', color: 'string', disabled: 'boolean', properties: 'object', effects: 'array' },
    tracks: { id: 'string', timelineId: 'string', name: 'string', kind: 'string', number: 'number', muted: 'boolean', solo: 'boolean', locked: 'boolean', hidden: 'boolean', gain: 'number', pan: 'number' },
    nodes: { id: 'string', projectId: 'string', clipId: 'string', name: 'string', kind: 'string', enabled: 'boolean', parameters: 'object' },
    comments: { id: 'string', projectId: 'string', userId: 'string', text: 'string', timestamp: 'number', time: 'number', resolved: 'boolean', replies: 'array' },
    operations: { id: 'string', projectId: 'string', userId: 'string', timestamp: 'number', targetId: 'string', type: 'string', description: 'string', oldState: 'array', newState: 'array' },
    snapshots: { id: 'string', projectId: 'string', name: 'string', note: 'string', userId: 'string', timestamp: 'number', state: 'object' },
  };
  function validateCollection(items: unknown, key: string) {
    if (!Array.isArray(items) || items.length > 100_000) fail(400, `Invalid ${key} collection.`);
    const ids = new Set<string>();
    for (const item of items as Entry[]) {
      object(item); if (!idIsValid(item.id) || ids.has(item.id)) fail(400, `Invalid or duplicate ${key} ID.`); ids.add(item.id);
      for (const [field, type] of Object.entries(schemas[key])) {
        if (type === 'array' ? !Array.isArray(item[field]) : type === 'object' ? !item[field] || typeof item[field] !== 'object' || Array.isArray(item[field]) : typeof item[field] !== type) fail(400, `Invalid ${key}.${field}.`);
        if (type === 'number') numberField(item[field], -1e15, 1e15);
      }
      if (key === 'projects' && item.classRole !== undefined && !['Viewer', 'Editor'].includes(item.classRole)) fail(400, 'Invalid class role.');
      if (item.name !== undefined) textField(item.name, 255, true);
      for (const field of ['duration', 'start', 'sourceIn', 'time']) if (item[field] !== undefined) numberField(item[field], 0, 86400 * 7);
      if (key === 'tracks' && item.captionSets!==undefined) {try{validateCaptionSets(item.captionSets);}catch(error){fail(400,(error as Error).message);}}
      if (key === 'timelines' && item.composition!==undefined && typeof item.composition!=='boolean') fail(400,'Invalid composition timeline.');
      if (key === 'clips') { try { validateTransition(item as any); validateMotionBlur(item as any); } catch (error) { fail(400, (error as Error).message); } if (isLeakMedia(String(item.mediaId)) && !leakIdOf(String(item.mediaId))) fail(400, 'Invalid overlay reference.'); if(isShape(item as any)){try{validateShape(JSON.parse(String(item.properties.shapeDocument)));}catch{fail(400,'Invalid shape document.');}} if(item.keyframes!==undefined) {try {validateKeyframes(item.keyframes);} catch(error){fail(400,(error as Error).message);}} if (isTitle(item as any)) { try { if(isCaption(item as any)&&!getText(item as any).caption)throw new Error('Missing caption data');validateText(getText(item as any)); } catch { fail(400, 'Invalid text document.'); } } if (!item.duration) fail(400, 'Clips must have a positive duration.'); for (const value of Object.values(item.properties)) if (!['string', 'number', 'boolean'].includes(typeof value)) fail(400, 'Invalid clip property.'); for (const effect of item.effects) { object(effect); if (!idIsValid(effect.id) || typeof effect.enabled !== 'boolean') fail(400, 'Invalid effect.'); textField(effect.name, 80, true); numberField(effect.amount, 0, 100); if (effect.parameters !== undefined) { object(effect.parameters); for (const value of Object.values(effect.parameters)) numberField(value); } } }
      if (key === 'tracks') { if (!['video', 'audio'].includes(item.kind)) fail(400, 'Invalid track kind.'); numberField(item.number, 0, 1024); numberField(item.gain, -120, 60); numberField(item.pan, -100, 100); if (item.height !== undefined) numberField(item.height, 24, 200); }
      if (key === 'nodes') {for (const value of Object.values(item.parameters)) numberField(value);try{validateGradeNode(item);}catch(error){fail(400,(error as Error).message);}}
      if (key === 'comments') { textField(item.text, 5000, true); if (item.range !== undefined && (!Array.isArray(item.range) || item.range.length !== 2 || item.range.some((value: unknown) => typeof value !== 'number' || value < 0))) fail(400, 'Invalid comment range.'); for (const reply of item.replies) { object(reply); if (!idIsValid(reply.id) || !idIsValid(reply.userId)) fail(400, 'Invalid reply.'); textField(reply.text, 5000, true); numberField(reply.timestamp, 0, 1e15); } }
      if (key === 'operations' && item.gestureId !== undefined) textField(item.gestureId, 128, true);
      if (key === 'operations') for (const change of [...item.oldState, ...item.newState]) { object(change); if (!['clips', 'tracks', 'nodes', 'comments', 'timelines'].includes(change.collection) || !idIsValid(change.id) || (change.value !== null && (!change.value || typeof change.value !== 'object' || Array.isArray(change.value)))) fail(400, 'Invalid history change.'); if (change.unset !== undefined && (!Array.isArray(change.unset) || change.unset.some((value: unknown) => typeof value !== 'string'))) fail(400, 'Invalid history field.'); }
      if (key === 'snapshots') for (const collection of ['clips', 'tracks', 'nodes', 'comments', ...(item.state.timelines?['timelines']:[])]) validateCollection(item.state[collection], collection);
    }
  }
  function validateRelations(next: PersistedState) {
    const projects = new Set(next.projects.map(project => project.id)); const timelines = new Map(next.timelines.map(item => [item.id, item.projectId])); const tracks = new Map(next.tracks.map(item => [item.id, item.timelineId])); const media = new Map(next.media.map(item => [item.id, item.projectId]));
    for (const key of ['media', 'timelines', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'] as const) for (const item of next[key]) if (!projects.has(item.projectId)) fail(400, 'An item references a missing project.');
    for (const track of next.tracks) if (!timelines.has(track.timelineId)) fail(400, 'A track references a missing timeline.');
    const check = (document: PersistedState | PersistedState['snapshots'][number]['state'], projectId?: string) => {
      const localTimelines=new Map((document.timelines??next.timelines).map(t=>[t.id,t.projectId]));
      const localTracks = new Map(document.tracks.map(item => [item.id, item.timelineId])); const clips = new Map(document.clips.map(item => [item.id, item.projectId]));
      for (const clip of document.clips) if ((projectId && clip.projectId !== projectId) || localTimelines.get(clip.timelineId) !== clip.projectId || localTracks.get(clip.trackId) !== clip.timelineId || (!isTitle(clip) && !isShape(clip) && !isComposition(clip) && !isLeakMedia(clip.mediaId) && media.get(clip.mediaId) !== clip.projectId)) fail(400, 'A clip references missing or inaccessible media, track, or timeline.');
      for (const node of document.nodes) if ((projectId && node.projectId !== projectId) || clips.get(node.clipId) !== node.projectId) fail(400, 'A grade references a missing clip.');
      try { for (const clip of document.clips) validateSmartMaskBindings(clip, document.nodes); } catch (error) { fail(400, (error as Error).message); }
      for (const comment of document.comments) if ((projectId && comment.projectId !== projectId) || (comment.clipId && clips.get(comment.clipId) !== comment.projectId)) fail(400, 'A comment references a missing clip.');
      try{validateCompositions(document.clips,document.timelines??next.timelines);}catch(error){fail(400,(error as Error).message);}
      if(projectId&&document.timelines?.some(t=>t.projectId!==projectId))fail(400,'A snapshot references another project.');
      if (projectId) for (const track of document.tracks) if (localTimelines.get(track.timelineId) !== projectId) fail(400, 'A snapshot references another project.');
    };
    check(next); for (const snapshot of next.snapshots) check(snapshot.state, snapshot.projectId);
  }
  function putState(body: Entry, account: Account) {
    if (!Number.isSafeInteger(body.revision)) fail(400, 'A revision is required.');
    if (body.revision !== revision) return false;
    object(body.state); const incoming = body.state as PersistedState; const currentView = view(account).state; const userId = account.user.id;
    if (incoming.currentUserId !== userId || !same(incoming.users, currentView.users)) fail(403, 'Account identities cannot be changed through project state.');
    for (const key of Object.keys(schemas)) validateCollection((incoming as unknown as Entry)[key], key);
    if (!same(incoming.media, currentView.media) || !same(incoming.renderJobs, currentView.renderJobs)) fail(400, 'Use the media and render endpoints to change files and jobs.');
    object(incoming.settings); for (const value of Object.values(incoming.settings)) if (!['string', 'number', 'boolean'].includes(typeof value)) fail(400, 'Invalid setting.');
    const existing = new Map(state.projects.map(project => [project.id, project])); const allowed = new Set(currentView.projects.map(project => project.id)); const nextProjectIds = new Set(incoming.projects.map(project => project.id));
    for (const project of incoming.projects) {
      const old = existing.get(project.id);
      if (!old && library.hasLocation(project.id)) fail(400, 'This project ID is reserved by a deleted project. Create a new project instead.');
      if (old && !allowed.has(project.id)) fail(403, 'Project is inaccessible.');
      if (old && !same(project.members, currentView.projects.find(item => item.id === project.id)?.members)) fail(403, 'Project roles cannot be changed through project state.');
      if (old) {
        const role = roleFor(old, userId); const before = { ...old, members: [], ...(role === 'Commenter' ? { modifiedAt: 0 } : {}) }; const after = { ...project, members: [], ...(role === 'Commenter' ? { modifiedAt: 0 } : {}) };
        if (role !== 'Owner' && (old.shared !== project.shared || old.classRole !== project.classRole || !same(before, after) && role !== 'Editor')) fail(403, 'Your role does not allow this project change.');
      }
      if (old && !same({ ...old, members: [], modifiedAt: 0 }, { ...project, members: [], modifiedAt: 0 })) for (const lock of locks.values()) if (lock.projectId === project.id && lock.targetId === project.id && lock.userId !== userId && lock.expiresAt > Date.now()) fail(423, 'A collaborator is editing this project.');
      textField(project.description, 5000); numberField(project.fps, 1, 240); if (!['In progress', 'In review', 'Complete'].includes(project.status)) fail(400, 'Invalid project status.');
      project.members = old?.members ?? [{ userId, role: 'Owner' }];
    }
    for (const project of currentView.projects) if (!nextProjectIds.has(project.id) && roleFor(existing.get(project.id)!, userId) !== 'Owner') fail(403, 'Only the owner can delete a project.');
    const next = { ...state }; next.projects = [...state.projects.filter(project => !allowed.has(project.id)), ...incoming.projects];
    const oldTimelines = new Map(state.timelines.map(item => [item.id, item.projectId])); const newTimelines = new Map(incoming.timelines.map(item => [item.id, item.projectId]));
    for (const key of ['timelines', 'clips', 'tracks', 'nodes', 'comments', 'operations', 'snapshots'] as const) {
      const oldItems = state[key] as unknown as Entry[]; const newItems = incoming[key] as unknown as Entry[];
      const oldById = new Map(oldItems.map(item => [item.id, item])), newIds = new Set(newItems.map(item => item.id));
      const itemProject = (item: Entry, fresh: boolean) => key === 'tracks' ? (fresh ? newTimelines : oldTimelines).get(item.timelineId) : item.projectId;
      for (const item of newItems) {
        const projectId = itemProject(item, true); if (!projectId || !nextProjectIds.has(projectId)) fail(403, 'An item references an inaccessible project.');
        const oldItem = oldById.get(item.id); if (oldItem && itemProject(oldItem, false) !== projectId) fail(403, 'Items cannot be moved between projects.');
        const project = existing.get(projectId); const role = project ? roleFor(project, userId) : 'Owner';
        if (!same(oldItem, item)) {
          if (!['Owner', 'Editor'].includes(role ?? '') && !(role === 'Commenter' && ['comments', 'operations'].includes(key))) fail(403, 'Editing this project is not allowed.');
          const restoredComment = key === 'comments' && state.snapshots.some(snapshot => snapshot.projectId === projectId && snapshot.state.comments.some(comment => same(comment, item)));
          if (['comments', 'operations', 'snapshots'].includes(key) && !restoredComment && (!oldItem ? item.userId !== userId : item.userId !== oldItem.userId)) fail(403, 'The author cannot be impersonated.');
          if (key === 'comments' && !restoredComment) {
            if (oldItem && oldItem.text !== item.text && oldItem.userId !== userId) fail(403, 'Only the author may edit comment text.');
            for (const reply of item.replies) { const oldReply = oldItem?.replies.find((r: Entry) => r.id === reply.id); if (!oldReply && reply.userId !== userId || oldReply && (reply.userId !== oldReply.userId || !same(oldReply, reply) && oldReply.userId !== userId)) fail(403, 'A reply author cannot be impersonated.'); }
          }
          if (key === 'snapshots') {
            if (oldItem) fail(403, 'Saved snapshots are immutable.');
            for (const comment of item.state.comments) if (![...state.comments, ...incoming.comments, ...state.snapshots.filter(snapshot => snapshot.projectId === projectId).flatMap(snapshot => snapshot.state.comments)].some(known => same(known, comment))) fail(403, 'Snapshot comments must preserve their original authors and content.');
          }
          if (key === 'operations' && oldItem && !(oldItem.userId === userId && oldItem.undone !== true && same({ ...oldItem, undone: true }, item))) fail(403, 'History is immutable; only the author may mark their operation undone.');
          // Every collection is enforced, not only clips and grades: a lock that the save path ignores
          // is a lock two machines can both walk through.
          if (oldItem) for (const lock of locks.values()) if (lock.projectId === projectId && lock.targetId === item.id && lock.userId !== userId && lock.expiresAt > Date.now()) {
            if (!['clips', 'nodes'].includes(key)) fail(423, 'A collaborator is editing this item.');
            const fields = MOVEMENT_FIELDS.includes(lock.field) ? ['start', 'duration', 'trackId', 'sourceIn'] : [lock.field];
            if (lock.field === '*' || !same(oldItem.keyframes,item.keyframes) || fields.some(field => !same(oldItem[field] ?? oldItem.properties?.[field], item[field] ?? item.properties?.[field]))) fail(423, 'A collaborator has locked a control changed by this save.');
          }
        }
      }
      for (const oldItem of oldItems) if (allowed.has(itemProject(oldItem, false)) && nextProjectIds.has(itemProject(oldItem, false)) && !newIds.has(oldItem.id)) {
        if (key === 'operations') fail(403, 'History cannot be deleted.');
        const role = roleFor(existing.get(itemProject(oldItem, false))!, userId); if (!['Owner', 'Editor'].includes(role ?? '') && !(role === 'Commenter' && key === 'comments' && oldItem.userId === userId)) fail(403, 'Deleting this item is not allowed.');
        if ([...locks.values()].some(lock => lock.targetId === oldItem.id && lock.projectId === itemProject(oldItem, false) && lock.userId !== userId && lock.expiresAt > Date.now())) fail(423, 'A collaborator has locked this item.');
      }
      (next as unknown as Entry)[key] = [...oldItems.filter(item => !allowed.has(itemProject(item, false))), ...newItems];
    }
    const deleted = new Set([...allowed].filter(id => !nextProjectIds.has(id))); next.media = state.media.filter(item => !deleted.has(item.projectId)); next.renderJobs = state.renderJobs.filter(item => !deleted.has(item.projectId));
    validateRelations(next);
    const previousState = state; const previousRevision = revision; const previousSettings = account.settings;
    db.exec('BEGIN IMMEDIATE');
    try { account.settings = { ...DEFAULT_SETTINGS, ...incoming.settings }; saveAccount(account); state = next; persist(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); state = previousState; revision = previousRevision; account.settings = previousSettings; throw error; }
    const removedMedia = previousState.media.filter(asset => deleted.has(asset.projectId)); const removedJobs = previousState.renderJobs.filter(job => deleted.has(job.projectId));
    for (const item of [...removedMedia, ...removedJobs]) aborters.get(item.id)?.abort();
    if (deleted.size) void queue.drain().then(() => { for (const asset of removedMedia) rmSync(mediaDir(asset.id), { recursive: true, force: true }); for (const job of removedJobs) for (const extension of ['.mp4', '.mov']) rmSync(join(dataDir, 'renders', `${job.id}${extension}`), { force: true }); }).catch(error => console.error('File cleanup failed:', error));
    return true;
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); const path = url.pathname; const method = req.method ?? 'GET';
      if (process.env.FRAME_LINE_TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'http' && /^[a-z0-9.-]+(:\d+)?$/i.test(req.headers.host ?? '')) { res.writeHead(301, { Location: `https://${req.headers.host}${url.pathname}${url.search}` }); res.end(); return; }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
        if (req.headers.origin) { let origin: URL; try { origin = new URL(req.headers.origin); } catch { fail(403, 'Invalid request origin.'); } if (origin!.host !== req.headers.host) fail(403, 'Cross-site requests are not allowed.'); }
      }
      if (path === '/api/health' && method === 'GET') { const capabilities = await getMediaCapabilities(); send(res, 200, { status: 'ok', ffmpeg: capabilities.available, captions: captionAvailable() }); return; }
      if (path === '/api/uploads/info' && method === 'GET') { requireAccount(req); const address = server.address(); send(res, 200, { localUrl: `http://localhost:${typeof address === 'object' && address ? address.port : 4310}`, maxUploadBytes }); return; }
      if (path === '/api/auth/me' && method === 'GET') { send(res, 200, { user: authenticated(req)?.user ?? null, registrationRequiresCode: Boolean(process.env.FRAME_LINE_SIGNUP_CODE) }); return; }
      if (['/api/auth/signup', '/api/auth/login'].includes(path) && method === 'POST') {
        const body = await jsonBody(req); const email = textField(body.email, 254, true).trim().toLowerCase(); const password = textField(body.password, 1024, true);
        const address = req.socket.remoteAddress ?? 'local'; const now = Date.now(); const networkKey = `network:${address}`; let networkAttempts = authAttempts.get(networkKey);
        if (!networkAttempts || networkAttempts.reset < now) { networkAttempts = { count: 0, reset: now + 60_000 }; authAttempts.set(networkKey, networkAttempts); }
        if (++networkAttempts.count > 120) fail(429, 'Too many sign-in requests. Try again in a minute.');
        const attemptKey = `account:${address}:${email}`; let attempts = authAttempts.get(attemptKey);
        if (!attempts || attempts.reset < now) { attempts = { count: 0, reset: now + 15 * 60_000 }; authAttempts.set(attemptKey, attempts); }
        if (++attempts.count > 20) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
        let account: Account;
        if (path.endsWith('/signup')) {
          const signupCode = process.env.FRAME_LINE_SIGNUP_CODE;
          if (signupCode && (typeof body.inviteCode !== 'string' || !timingSafeEqual(createHash('sha256').update(body.inviteCode).digest(), createHash('sha256').update(signupCode).digest()))) fail(403, 'Enter the installation access code to create an account.');
          if (password.length < 8) fail(400, 'Use a password with at least 8 characters.');
          const fields = profile(body); if (db.prepare('SELECT id FROM accounts WHERE email=?').get(fields.email)) fail(409, 'An account already uses that email.');
          const salt = randomBytes(16).toString('hex'); const hash = (await scrypt(password, salt, 64) as Buffer).toString('hex');
          account = { user: { id: `user-${randomUUID()}`, ...fields, color: '#F06A70' }, salt, hash, settings: { ...DEFAULT_SETTINGS } };
          try { saveAccount(account); } catch (error) { if (String(error).includes('UNIQUE')) fail(409, 'An account already uses that email.'); throw error; }
          persist();
        } else {
          const row = db.prepare('SELECT data FROM accounts WHERE email=?').get(email) as { data: string } | undefined; const candidate = row ? JSON.parse(row.data) as Account : undefined;
          const hash = await scrypt(password, candidate?.salt ?? 'frameline-missing-user-salt', 64) as Buffer;
          if (!candidate || !timingSafeEqual(Buffer.from(candidate.hash, 'hex'), hash)) fail(401, 'Email or password is incorrect.'); account = candidate!;
        }
        authAttempts.delete(attemptKey); db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(now);
        const token = randomBytes(32).toString('base64url'); db.prepare('INSERT INTO sessions(token,userId,expiresAt) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'), account.user.id, now + 30 * 86400_000);
        const secure = !!(req.socket as unknown as { encrypted?: boolean }).encrypted || (process.env.FRAME_LINE_TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
        res.setHeader('Set-Cookie', `frameline_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`); send(res, path.endsWith('/signup') ? 201 : 200, { user: account.user }); return;
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        const hash = sessionHash(req); const account = authenticated(req); db.prepare('DELETE FROM sessions WHERE token=?').run(hash);
        if (account) { for (const [key, entry] of presence) if (entry.session === hash) presence.delete(key); for (const [key, lock] of locks) if (lock.userId === account.user.id) { locks.delete(key); lockChanged(); } }
        for (const [client, subscriber] of subscribers) if (subscriber.session === hash) { client.end(); subscribers.delete(client); }
        res.setHeader('Set-Cookie', 'frameline_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); send(res, 200, { ok: true }); return;
      }
      if (path.startsWith('/api/')) {
        const account = requireAccount(req); const userId = account.user.id;
        if (path === '/api/sfx' && method === 'GET') {
          const query = textField(url.searchParams.get('q') ?? '', 200), category = textField(url.searchParams.get('category') ?? '', 50);
          send(res, 200, await sounds.search(query, category)); return;
        }
        if (path === '/api/sfx' && method === 'POST') {
          if (aborters.size >= QUEUE_LIMIT) fail(429, 'The processing queue is full. Try again shortly.');
          const body = await jsonBody(req), project = requireProject(textField(body.projectId, 160, true), userId, true);
          const clip = state.clips.find(c => c.id === body.clipId && c.projectId === project.id) ?? fail(404, 'Clip not found.');
          const track = state.tracks.find(t => t.id === clip.trackId && t.kind === 'audio') ?? fail(400, 'Choose a clip on an audio track.');
          const asset = state.media.find(a => a.id === clip.mediaId && a.projectId === project.id && a.status === 'ready' && a.hasAudio) ?? fail(400, 'The audio source is not ready.');
          if (clip.duration > 600) fail(400, 'Sound effects can be up to 10 minutes long.');
          const sound = sounds.reserve(body, { addedBy: userId, originalName: asset.name, source: 'Saved timeline clip' });
          const snapshot = structuredClone({ project, clip, track, asset });
          // Pin source bytes immediately: deleting the source project must not break a queued save.
          const folder = join(dataDir, 'sfx', sound.id), source = join(folder, 'source'), output = join(folder, 'baked.wav');
          try {
            try { linkSync(originalPath(asset.id), source); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; copyFileSync(originalPath(asset.id), source); }
          }
          catch (error) { sounds.fail(sound.id, error); throw error; }
          addWork(sound.id, async signal => {
            try { await renderSoundEffect({ ...snapshot, inputPath: source, outputPath: output, signal }); await sounds.complete(sound.id, output, signal); }
            catch (error) { sounds.fail(sound.id, error); }
            finally { rmSync(source, { force: true }); rmSync(output, { force: true }); }
          });
          send(res, 202, { sound }); return;
        }
        const sfxRoute = /^\/api\/sfx\/(sfx-[a-zA-Z0-9-]+)\/(preview|import)$/.exec(path);
        if (sfxRoute) {
          const [, id, action] = sfxRoute;
          if (action === 'preview' && ['GET', 'HEAD'].includes(method)) { const file = sounds.file(id, true) ?? fail(404, 'Sound not found.'); streamFile(req, res, file, 'audio/mp4', undefined, true); return; }
          if (action === 'import' && method === 'POST') {
            const body = await jsonBody(req), project = requireProject(textField(body.projectId, 160, true), userId, true);
            const mediaId = `media-sfx-${createHash('sha256').update(`${project.id}:${id}`).digest('hex').slice(0, 32)}`;
            let asset = state.media.find(a => a.id === mediaId);
            if (!asset) {
              try { asset = sounds.importAsset(id, project.id, mediaId, mediaDir(mediaId)); state.media.unshift(asset); persist(); }
              catch (error) { state.media = state.media.filter(a => a.id !== mediaId); rmSync(mediaDir(mediaId), { recursive: true, force: true }); throw error; }
            }
            send(res, 200, { asset, revision }); return;
          }
        }
        if (path === '/api/library' && method === 'GET') { send(res, 200, library.view(userId)); return; }
        if (path === '/api/library' && method === 'POST') { const body = await jsonBody(req); send(res, 200, library.change(body, userId)); return; }
        if (path === '/api/fonts' && method === 'GET') { send(res, 200, { fonts: fonts.list() }); return; }
        if (path === '/api/fonts' && method === 'POST') {
          const name = textField(new URL(req.url!, 'http://localhost').searchParams.get('name'), 100, true).trim();
          const data = await binaryBody(req, 15 * 1024 * 1024);
          if (fonts.list().length >= 1000) fail(409, 'The shared font library is full.');
          try { send(res, 201, { font: fonts.add(data, name, userId) }); } catch (error) { fail(400, (error as Error).message); } return;
        }
        const fontRoute = /^\/api\/fonts\/(FL-[a-f0-9]{32})$/.exec(path);
        if (fontRoute && (method === 'GET' || method === 'HEAD')) {
          const font = fonts.get(fontRoute[1]) ?? fail(404, 'Font not found.');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': font.data.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); res.end(method === 'HEAD' ? undefined : Buffer.from(font.data)); return;
        }

        if (path === '/api/transitions' && method === 'GET') { send(res, 200, { leaks: overlays.list(), presets: transitionPresets(), favorites: transitionFavorites(userId) }); return; }
        if (path === '/api/transitions' && method === 'POST') {
          const name = textField(new URL(req.url!, 'http://localhost').searchParams.get('name'), 80, true).trim();
          const data = await binaryBody(req, 64 * 1024 * 1024);
          try { send(res, 201, { leak: await overlays.add(data, name, userId) }); } catch (error) { fail(400, (error as Error).message); } return;
        }
        if (path === '/api/transitions/presets' && method === 'PUT') {
          const body = await jsonBody(req);
          const clip = state.clips.find(item => item.id === body.clipId) ?? fail(404, 'Clip not found.');
          requireProject(clip.projectId, userId, true);
          if (!['in', 'out'].includes(String(body.side))) fail(400, 'Invalid transition side.');
          const record = timelineTransitions(state.clips, clip.timelineId, state.media).find(item => item.clipId === clip.id && item.side === body.side) ?? fail(400, 'Select a transition first.');
          if (transitionDefinitions[record.name].overlay && !overlays.path(String(record.params.leak))) fail(400, 'Choose an overlay first.');
          const { name, duration, align, curve } = record;
          const params = Object.fromEntries(transitionDefinitions[name].parameters.map(parameter => [parameter.key, record.params[parameter.key] ?? parameter.initial]));
          const preset = { id: transitionPresetId(name, params), name, duration, align, curve, params };
          db.prepare('INSERT INTO transition_presets(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(preset.id, JSON.stringify(preset));
          for (const res of subscribers.keys()) res.write('event: transitions\ndata: {}\n\n');
          send(res, 200, { preset }); return;
        }
        if (path === '/api/transitions/favorites' && method === 'PUT') {
          const body = await jsonBody(req), id = textField(body.id, 160, true);
          const valid = Object.keys(transitionDefinitions).some(name => id === `transition:${name}` && !transitionDefinitions[name].overlay)
            || overlays.list().some(leak => id === `overlay:${leak.id}`);
          if (!valid || typeof body.favorite !== 'boolean') fail(400, 'Invalid transition favorite.');
          if (body.favorite) db.prepare('INSERT OR IGNORE INTO transition_favorites(userId,id) VALUES(?,?)').run(userId, id);
          else db.prepare('DELETE FROM transition_favorites WHERE userId=? AND id=?').run(userId, id);
          for (const [res, subscriber] of subscribers) if (subscriber.userId === userId) res.write('event: transitions\ndata: {}\n\n');
          send(res, 200, { favorites: transitionFavorites(userId) }); return;
        }
        const overlayRoute = /^\/api\/transitions\/([a-z0-9][a-z0-9-]{0,78}[a-z0-9])\.(mp4|jpg)$/.exec(path);
        if (overlayRoute && (method === 'GET' || method === 'HEAD')) {
          const kind = overlayRoute[2] as 'mp4' | 'jpg';
          streamFile(req, res, overlays.path(overlayRoute[1], kind) ?? fail(404, 'Overlay not found.'), kind === 'jpg' ? 'image/jpeg' : 'video/mp4', undefined, true); return;
        }
        if (overlayRoute && method === 'DELETE') {
          if (!overlays.remove(overlayRoute[1])) fail(404, 'Overlay not found.');
          send(res, 200, { ok: true }); return;
        }

        if (path === '/api/auth/profile' && method === 'PATCH') {
          const body = await jsonBody(req); const fields = profile({ ...account.user, ...body });
          const taken = db.prepare('SELECT id FROM accounts WHERE email=? AND id<>?').get(fields.email, userId); if (taken) fail(409, 'An account already uses that email.');
          const color = body.color ?? account.user.color; if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) fail(400, 'Choose a valid profile color.');
          account.user = { ...account.user, ...fields, color }; saveAccount(account); persist(); send(res, 200, { user: account.user }); return;
        }
        if (path === '/api/state' && method === 'GET') {
          // A client that already holds this revision only needs the ephemeral half of the envelope.
          if (url.searchParams.get('since') === String(revision)) { send(res, 200, ephemeralView(account)); return; }
          send(res, 200, stateView(account, url.searchParams.get('delta') === '1' ? Number(url.searchParams.get('since')) : undefined)); return;
        }
        if (path === '/api/state' && method === 'PATCH') {
          const body = await jsonBody(req);
          if (!Number.isSafeInteger(body.revision)) fail(400, 'A revision is required.');
          if (body.revision !== revision) { send(res, 409, stateView(account, body.revision)); return; }
          let incoming: PersistedState;
          try { incoming = applyStateDelta(view(account).state, body.delta); } catch { fail(400, 'Invalid state delta.'); }
          putState({ revision: body.revision, state: incoming! }, account);
          stateView(account);
          const { state: current, ...ephemeral } = view(account);
          send(res, 200, { ...ephemeral, baseRevision: body.revision, delta: stateDelta(incoming!, current!) }); return;
        }
        if (path === '/api/state' && method === 'PUT') { const saved = putState(await jsonBody(req), account); send(res, saved ? 200 : 409, view(account)); return; }
        const restoreProjectRoute = /^\/api\/projects\/([a-zA-Z0-9_-]+)\/restore$/.exec(path);
        if (restoreProjectRoute && method === 'POST') {
          const row = db.prepare('SELECT ownerId,expiresAt,data FROM deleted_projects WHERE id=?').get(restoreProjectRoute[1]) as { ownerId: string; expiresAt: number; data: string } | undefined;
          if (!row || row.ownerId !== userId || row.expiresAt <= Date.now()) fail(404, 'That project backup has expired.');
          const bundle = JSON.parse(row!.data) as Record<Collection, Entry[]>;
          if (state.projects.some(project => project.id === restoreProjectRoute[1])) fail(409, 'A project with that ID already exists.');
          const previous = state, previousRevision = revision;
          db.exec('BEGIN IMMEDIATE');
          try {
            state = { ...state, ...Object.fromEntries(COLLECTIONS.map(key => [key, [...state[key], ...bundle[key]]])) };
            validateRelations(state); persist(); db.prepare('DELETE FROM deleted_projects WHERE id=?').run(restoreProjectRoute[1]); db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); state = previous; revision = previousRevision; throw error; }
          send(res, 200, { projectId: restoreProjectRoute[1] }); return;
        }
        const projectRoute = /^\/api\/projects\/([a-zA-Z0-9_-]+)$/.exec(path);
        if (projectRoute && method === 'PATCH') {
          const body = await jsonBody(req);
          const project = requireProject(projectRoute[1], userId); if (roleFor(project, userId) !== 'Owner') fail(403, 'Only the project owner can change project access.');
          const access = body.access ?? (project.shared ? 'class' : project.members.length > 1 ? 'people' : 'private');
          if (!['private', 'people', 'class'].includes(access)) fail(400, 'Choose private, specific people, or the entire class.');
          let members = project.members.filter(m => m.role !== 'Owner');
          if (body.members !== undefined) {
            if (!Array.isArray(body.members) || body.members.length > 10000) fail(400, 'Invalid project members.');
            const seen = new Set<string>();
            for (const m of body.members) { if (!m || !idIsValid(m.userId) || m.userId === userId || seen.has(m.userId) || !['Viewer', 'Commenter', 'Editor'].includes(m.role)) fail(400, 'Invalid project member role.'); if (!accountById(m.userId)) fail(404, 'A selected class member no longer exists.'); seen.add(m.userId); }
            members = body.members.map((m: { userId: string; role: 'Viewer' | 'Commenter' | 'Editor' }) => ({ userId: m.userId, role: m.role }));
          } else if (body.memberIds !== undefined) {
            if (!Array.isArray(body.memberIds) || body.memberIds.length > 10000 || body.memberIds.some((id: unknown) => !idIsValid(id))) fail(400, 'Invalid project member list.');
            const ids = [...new Set(body.memberIds as string[])].filter(id => id !== userId);
            if (ids.some(id => !accountById(id))) fail(404, 'A selected class member no longer exists.');
            members = access === 'people' ? ids.map(userId => ({ userId, role: 'Editor' as const })) : [];
          }
          if (access === 'private') members = [];
          const classRole = body.classRole ?? project.classRole ?? 'Editor';
          if (!['Viewer', 'Editor'].includes(classRole)) fail(400, 'Choose Viewer or Editor for class access.');
          const updated: Project = { ...project, name: textField(body.name ?? project.name, 100, true).trim(), description: textField(body.description ?? project.description, 5000).trim(), status: ['In progress', 'In review', 'Complete'].includes(body.status ?? project.status) ? body.status ?? project.status : fail(400, 'Invalid project status.'), resolution: textField(body.resolution ?? project.resolution, 80, true).trim(), fps: numberField(body.fps ?? project.fps, 1, 240), shared: access === 'class', classRole, members: [{ userId, role: 'Owner' }, ...members], modifiedAt: Date.now() };
          const previous = state.projects; state.projects = state.projects.map(item => item.id === updated.id ? updated : item);
          try { persist(); } catch (error) { state.projects = previous; throw error; }
          send(res, 200, { project: updated }); return;
        }
        if (projectRoute && method === 'DELETE') {
          const project = requireProject(projectRoute[1], userId); if (roleFor(project, userId) !== 'Owner') fail(403, 'Only the project owner can delete this project.');
          const backup = projectBundle(project), expiresAt = Date.now() + 60_000, previous = state, previousRevision = revision;
          for (const item of [...backup.media, ...backup.renderJobs]) aborters.get(item.id)?.abort();
          db.exec('BEGIN IMMEDIATE');
          try { db.prepare('INSERT INTO deleted_projects(id,ownerId,expiresAt,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ownerId=excluded.ownerId,expiresAt=excluded.expiresAt,data=excluded.data').run(project.id, userId, expiresAt, JSON.stringify(backup)); removeProject(project.id); persist(); db.exec('COMMIT'); }
          catch (error) { db.exec('ROLLBACK'); state = previous; revision = previousRevision; throw error; }
          send(res, 200, { projectId: project.id, expiresAt }); return;
        }
        const memberRoute = /^\/api\/projects\/([a-zA-Z0-9_-]+)\/members\/([a-zA-Z0-9_-]+)$/.exec(path);
        if (memberRoute && method === 'PATCH') {
          const project = requireProject(memberRoute[1], userId); if (roleFor(project, userId) !== 'Owner') fail(403, 'Only the project owner can assign roles.');
          if (!project.shared) fail(400, 'Only Class projects have collaborator roles.');
          const targetId = memberRoute[2]; if (!accountById(targetId)) fail(404, 'Account not found.'); if (roleFor(project, targetId) === 'Owner') fail(403, 'The owner role cannot be changed.');
          const body = await jsonBody(req); if (!['Editor', 'Commenter', 'Viewer'].includes(body.role)) fail(400, 'Choose Editor, Commenter, or Viewer.');
          const previous = state.projects; state.projects = state.projects.map(item => item.id === project.id ? { ...item, members: [...item.members.filter(member => member.userId !== targetId), { userId: targetId, role: body.role }] } : item);
          try { persist(); } catch (error) { state.projects = previous; throw error; }
          if (body.role !== 'Editor') for (const [key, lock] of locks) if (lock.projectId === project.id && lock.userId === targetId) { locks.delete(key); lockChanged(); }
          send(res, 200, { project: view(account).state.projects.find(item => item.id === project.id) }); return;
        }
        if (path === '/api/events' && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write(`event: change\ndata: ${JSON.stringify({ revision, locks: lockRevision })}\n\n`);
          const session = sessionHash(req), clientId = url.searchParams.get('clientId') ?? 'legacy';
          const projectId = [...presence.entries()].find(([key, entry]) => entry.session === session && JSON.parse(key)[3] === clientId)?.[1].person.projectId;
          subscribers.set(res, { userId, session, clientId, projectId }); req.on('close', () => subscribers.delete(res)); return;
        }
        if (path === '/api/presence' && method === 'POST') {
          const body = await jsonBody(req); const project = requireProject(textField(body.projectId, 160, true), userId);
          const session = sessionHash(req), clientId = body.clientId === undefined ? 'legacy' : textField(body.clientId, 160, true);
          if (body.active !== undefined && typeof body.active !== 'boolean') fail(400, 'Invalid presence activity.');
          const key = JSON.stringify([project.id, userId, session, clientId]);
          if (body.online === false) presence.delete(key);
          else {
            const cursor = presenceCursor(body.cursor);
            let preview: Presence['preview'] = null;
            if (body.preview && body.active !== false) {
              requireProject(project.id, userId, true); object(body.preview);
              const validateItems = (items: unknown, kind: 'tracks' | 'clips') => {
                if (items === undefined) return undefined;
                if (!Array.isArray(items) || items.length > 1000) fail(400, 'Invalid drag preview.');
                return (items as Entry[]).map((item: Entry) => {
                  object(item);
                  const id = textField(item.id, 160, true);
                  if ([...locks.values()].some(lock => lock.targetId === id && lock.userId !== userId && lock.expiresAt > Date.now())) fail(423, 'A collaborator is editing this item.');
                  if (kind === 'tracks') {
                    if (!state.tracks.some(track => track.id === id && track.timelineId === body.timelineId && state.timelines.some(t => t.id === track.timelineId && t.projectId === project.id))) fail(400, 'Invalid preview track.');
                    return { id, height: numberField(item.height, 24, 200) };
                  }
                  const clip = state.clips.find(c => c.id === id && c.projectId === project.id && c.timelineId === body.timelineId);
                  const track = state.tracks.find(t => t.id === item.trackId && t.timelineId === body.timelineId && !t.locked);
                  if (!clip || !track || state.tracks.find(t => t.id === clip.trackId)?.locked || state.tracks.find(t => t.id === clip.trackId)?.kind !== track.kind) fail(400, 'Invalid preview clip.');
                  return { id, trackId: track!.id, start: numberField(item.start, 0, 86400 * 7), duration: numberField(item.duration, 0.00001, 86400 * 7) };
                });
              };
              preview = { tracks: validateItems(body.preview.tracks, 'tracks'), clips: validateItems(body.preview.clips, 'clips') } as Presence['preview'];
            }

            const selectedClipId = typeof body.selectedClipId === 'string' && state.clips.some(clip => clip.id === body.selectedClipId && clip.projectId === project.id) ? body.selectedClipId : undefined;
            presence.set(key, { session, active: body.active ?? !!cursor, person: { preview, userId, projectId: project.id, cursor: body.active === false ? null : cursor, playhead: numberField(body.playhead ?? 0, 0, 86400 * 7), selectedClipId, mediaTab: ['Media','SFX','Captions','Effects','Transitions','Titles','Shapes'].includes(body.mediaTab) ? body.mediaTab : undefined, inspectorTab: selectedClipId && ['Video','Audio','Effects','Info','Caption','Text','Shape','Transition'].includes(body.inspectorTab) ? body.inspectorTab : undefined, focusedField: typeof body.focusedField === 'string' ? body.focusedField.slice(0, 100) : undefined, activity: typeof body.activity === 'string' ? body.activity.slice(0, 160) : 'Editing', online: true, updatedAt: Date.now(), ...(body.timelineId && state.timelines.some(timeline => timeline.id === body.timelineId && timeline.projectId === project.id) ? { timelineId: body.timelineId } : {}), presenting: body.presenting === true, playing: body.playing === true } });
          }
          for (const subscriber of subscribers.values()) if (subscriber.session === session && subscriber.clientId === clientId) subscriber.projectId = body.online === false ? undefined : project.id;
          broadcastPresence(project.id);
          expired(); send(res, 200, { presence: visiblePresence().filter(person => person.projectId === project.id), serverTime: Date.now() }); return;
        }
        if (path === '/api/locks' && ['POST', 'DELETE'].includes(method)) {
          const body = await jsonBody(req); const project = requireProject(textField(body.projectId, 160, true), userId, true); const targetId = textField(body.targetId, 160, true); const field = textField(body.field, 100, true);
          if (!idIsValid(targetId) || !lockable(targetId, project.id)) fail(404, 'Lock target not found.');
          expired(); const key = `${project.id}:${targetId}:${field}`;
          if (method === 'DELETE') { if (locks.get(key)?.userId === userId) { locks.delete(key); lockChanged(); } send(res, 200, { ok: true }); return; }
          const conflict = [...locks.values()].find(lock => lock.projectId === project.id && lock.targetId === targetId && lock.userId !== userId && lockConflict(lock.field, field));
          if (conflict) { send(res, 409, { error: 'This control is being edited by a collaborator.', lock: conflict }); return; }
          const lock = { id: key, projectId: project.id, targetId, field, userId, expiresAt: Date.now() + LOCK_TTL }; const held = locks.get(key);
          locks.set(key, lock); if (held?.userId !== userId) lockChanged(); send(res, 200, { lock }); return;
        }
        if(path === '/api/resolve/bridge' && method === 'GET'){streamFile(req,res,fileURLToPath(new URL('../scripts/resolve-export.lua',import.meta.url)),'text/plain','resolve-export.lua');return;}
        if (path === '/api/resolve/import' && method === 'POST') {
          const body=await jsonBody(req), id=body.projectId;
          if(!idIsValid(id)||id.length>64)fail(400,'Invalid import project ID.');
          object(body.manifest);
          let imported: ReturnType<typeof importResolve>;try{imported=importResolve(body.manifest,id,userId,body.otios);}catch(error){fail(400,(error as Error).message);}
          if(state.projects.some(p=>p.id===id)) {
            const existing=requireProject(id,userId,true) as Project & {resolveImportHash?:string};
            if(existing.resolveImportHash!==(imported!.project as Project & {resolveImportHash?:string}).resolveImportHash)fail(409,'That project ID already exists with different content.');
            send(res,200,{projectId:id,files:imported!.files,warnings:imported!.warnings,media:state.media.filter(m=>m.projectId===id)});return;
          }
          const next={...state,projects:[...state.projects,imported!.project],...Object.fromEntries(['media','timelines','tracks','clips','nodes'].map(k=>[k,[...(state as any)[k],...(imported as any)[k]]]))} as PersistedState;
          for(const key of ['projects','timelines','tracks','clips','nodes'])validateCollection((next as any)[key],key);
          validateRelations(next);
          mkdirSync(resolveDir(id),{recursive:true,mode:0o700});writeFileSync(join(resolveDir(id),'project.frameline.json'),JSON.stringify(body.manifest),{mode:0o600});
          const previous=state;state=next;try{persist();}catch(error){state=previous;throw error;}
          send(res,201,{projectId:id,files:imported!.files,warnings:imported!.warnings,media:imported!.media});return;
        }
        const exchange=/^\/api\/projects\/([a-zA-Z0-9_-]+)\/resolve-export$/.exec(path);
        if(exchange&&method==='GET') {
          const project=requireProject(exchange[1],userId),timeline=state.timelines.find(t=>t.projectId===project.id&&t.id===url.searchParams.get('timelineId'));
          if(!timeline)fail(404,'Timeline not found.');
          const templates:Record<string,any>={};
          const manifestPath=join(resolveDir(project.id),'project.frameline.json');
          if(existsSync(manifestPath)) {
            const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
            for(const [i,t] of manifest.timelines.entries()) {const source=join(resolveDir(project.id),`timeline-${i+1}.otio`);if(!existsSync(source))continue;const otio=JSON.parse(readFileSync(source,'utf8'));
              for(const tr of t.tracks) {const items=otio.tracks.children.filter((o:any)=>o.kind===(tr.kind==='video'?'Video':'Audio'))[tr.number-1]?.children.filter((c:any)=>c.OTIO_SCHEMA?.startsWith('Clip.'))??[];tr.items.forEach((item:any,index:number)=>{if(items[index])templates[item.id]=items[index];});}
            }
          }
          try {send(res,200,exportResolveTimeline(project,timeline!,state.tracks,state.clips,state.media,templates));}catch(error){fail(400,(error as Error).message);}return;
        }
        const resolveRoute=/^\/api\/projects\/([a-zA-Z0-9_-]+)\/resolve\/([a-zA-Z0-9_.-]+)$/.exec(path);
        if(resolveRoute) {
          const [,projectId,filename]=resolveRoute,project=requireProject(projectId,userId,!['GET','HEAD'].includes(method)) as Project & {resolveFiles?:string[]};
          if(!project.resolveFiles?.includes(filename)||!(/^[a-zA-Z0-9_-]+\.(cube|png|otio|drp)$/.test(filename)||filename==='project.frameline.json'))fail(404,'Resolve file not found.');
          const target=join(resolveDir(projectId),filename);
          if(['GET','HEAD'].includes(method)){streamFile(req,res,target,undefined,url.searchParams.has('download')?filename:undefined);return;}
          if(method==='PUT') {
            const data=await binaryBody(req,32*1024*1024);
            if(filename.endsWith('.cube')){try{parseCube(data.toString());}catch(e){fail(400,(e as Error).message);}}
            if(filename.endsWith('.png')&&!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail(400,'Invalid reference image.');
            if(existsSync(target)){if(!readFileSync(target).equals(data))fail(409,'This Resolve asset is immutable. Import a new revision.');}
            else {mkdirSync(resolveDir(projectId),{recursive:true,mode:0o700});writeFileSync(target,data,{mode:0o600,flag:'wx'});}
            send(res,200,{ok:true});return;
          }
        }
        if (path === '/api/media/import-link' && method === 'POST') {
          const body = await jsonBody(req);
          const project = requireProject(textField(body.projectId, 160, true), userId, true);
          let link; try { link = parseImportLink(body.url, body.mode, body.quality); } catch (error) { fail(400, (error as Error).message); }
          if (aborters.size + state.media.filter(asset => asset.status === 'uploading').length >= QUEUE_LIMIT) fail(429, 'The processing queue is full. Wait for current jobs to finish.');
          const id = `media-${randomUUID()}`, spotify = link!.url.includes('open.spotify.com');
          const asset: Asset = { id, projectId: project.id, name: spotify ? 'Spotify track · matching audio' : 'YouTube · waiting to download', kind: link!.mode === 'audio' ? 'audio' : 'video', binId: link!.mode === 'audio' ? 'audio' : 'broll', thumbnail: youtubeThumbnail(link!.url), duration: 0, resolution: '', fps: 0, size: '', status: 'downloading', progress: 0, importLink: link! };
          mkdirSync(mediaDir(id), { recursive: true, mode: 0o700 }); state.media.unshift(asset); persist();
          processAsset(id); send(res, 202, { asset }); return;
        }
        if (path === '/api/media' && method === 'POST') {
          if (aborters.size + state.media.filter(asset => asset.status === 'uploading').length >= QUEUE_LIMIT) fail(429, 'The processing queue is full. Wait for current uploads and exports to finish.');
          const project = requireProject(url.searchParams.get('projectId') ?? '', userId, true); const id = url.searchParams.get('id') ?? `media-${randomUUID()}`;
          if (!idIsValid(id)) fail(400, 'Invalid media ID.'); if (state.media.some(asset => asset.id === id) || existsSync(mediaDir(id))) fail(409, 'That media ID already exists.');
          const name = textField(url.searchParams.get('name'), 255, true); if (/[\x00-\x1f]/.test(name) || basename(name.replaceAll('\\', '/')) !== name) fail(400, 'Invalid filename.');
          const length = Number(req.headers['content-length']); if (length > maxUploadBytes) fail(413, `Files must be smaller than ${Math.floor(maxUploadBytes / 1024 ** 3)} GB.`);
          const audio = /\.(wav|mp3|aac|aiff?|flac|m4a|ogg)$/i.test(name); const image = /\.(png|jpe?g|webp|gif|tiff?|bmp|heic)$/i.test(name);
          const asset: Asset = { id, projectId: project.id, name, kind: audio ? 'audio' : image ? 'image' : 'video', binId: audio ? 'audio' : 'broll', thumbnail: '', duration: 0, resolution: '', fps: 0, size: '', status: 'uploading', progress: 0 };
          mkdirSync(mediaDir(id), { recursive: true, mode: 0o700 }); state.media.unshift(asset); persist();
          if (url.searchParams.get('placeholder') === '1') { send(res, 201, { asset }); return; }
          const temporary = join(mediaDir(id), 'upload.part'); let bytes = 0, lastProgress = 0;
          try {
            const limit = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > maxUploadBytes) callback(new HttpError(413, 'The upload exceeds the configured size limit.')); else { if (length > 0 && Date.now() - lastProgress >= 200) { lastProgress = Date.now(); updateAsset(id, { progress: Math.min(99, Math.floor(bytes / length * 100)) }); } callback(null, chunk); } } });
            await pipeline(req, limit, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })); if (!bytes) fail(400, 'The uploaded file is empty.');
            renameSync(temporary, originalPath(id)); updateAsset(id, { size: bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`, status: 'processing' });
            processAsset(id); send(res, 202, { asset: state.media.find(item => item.id === id) }); return;
          } catch (error) { rmSync(temporary, { force: true }); updateAsset(id, { status: 'failed', error: error instanceof Error ? error.message : 'Upload failed.' }); throw error; }
        }
        const mediaRoute = /^\/api\/media\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/.exec(path);
        if (mediaRoute) {
          const id = mediaRoute[1]; const suffix = mediaRoute[2]; const asset = state.media.find(item => item.id === id) ?? fail(404, 'Media not found.'); requireProject(asset.projectId, userId, !['GET', 'HEAD'].includes(method));
          if (suffix === 'thumbnail' && method === 'PUT') {
            if (asset.status !== 'uploading' || asset.importLink) fail(409, 'Upload previews are only accepted while uploading a local file.');
            const bytes = await binaryBody(req, 512 * 1024);
            if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail(400, 'Upload a JPEG preview.');
            const temporary = join(mediaDir(id), `preview-${randomUUID()}.jpg`);
            writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
            try {
              const metadata = await probeMedia(temporary);
              if (metadata.kind !== 'image' || metadata.width! > 1024 || metadata.height! > 1024) fail(400, 'Preview must be an image up to 1024 × 1024.');
              await prepareMediaThumbnail(temporary, join(mediaDir(id), 'prepared'));
              updateAsset(id, { thumbnail: `/api/media/${id}/files/thumbnail.jpg` });
              send(res, 200, { ok: true }); return;
            } finally { rmSync(temporary, { force: true }); }
          }
          if(suffix==='upload') {
            const partial=join(mediaDir(id),'upload.part'), metadataPath=join(mediaDir(id),'upload.json');
            if(method==='GET'){send(res,200,{offset:existsSync(partial)?statSync(partial).size:0,complete:existsSync(originalPath(id)),metadata:existsSync(metadataPath)?JSON.parse(readFileSync(metadataPath,'utf8')):null});return;}
            if(method==='POST') {
              const body=await jsonBody(req);numberField(body.size,1,maxUploadBytes);if(!Number.isSafeInteger(body.size))fail(400,'Invalid file size.');textField(body.fingerprint,300,true);
              if(existsSync(originalPath(id))){send(res,200,{complete:true});return;}
              if(uploadLocks.has(id))fail(409,'Upload is busy.');
              const metadata={size:body.size,fingerprint:body.fingerprint};
              if(existsSync(metadataPath)&&!same(JSON.parse(readFileSync(metadataPath,'utf8')),metadata))fail(409,'The selected file differs from the unfinished upload. Choose the original file.');
              mkdirSync(mediaDir(id),{recursive:true,mode:0o700});writeFileSync(metadataPath,JSON.stringify(metadata),{mode:0o600});
              updateAsset(id,{status:'uploading',error:undefined});send(res,200,{offset:existsSync(partial)?statSync(partial).size:0,complete:false});return;
            }
            if(method==='PUT') {
              if(uploadLocks.has(id))fail(409,'Upload is busy.');
              if(existsSync(originalPath(id)))fail(409,'Original media is immutable.');
              if(!existsSync(metadataPath))fail(409,'Initialize this upload first.');
              const metadata=JSON.parse(readFileSync(metadataPath,'utf8')), offset=Number(req.headers['upload-offset']);
              const current=existsSync(partial)?statSync(partial).size:0;
              if(!Number.isSafeInteger(offset)||offset!==current)fail(409,'Upload offset changed. Resume from the server offset.');
              uploadLocks.add(id);
              try {
                const chunk=await binaryBody(req,8*1024*1024);
                const digest=createHash('sha256').update(chunk).digest('hex');if(req.headers['upload-checksum']!==digest)fail(400,'Chunk checksum mismatch.');
                if(offset+chunk.length>metadata.size)fail(400,'Upload exceeds its declared size.');
                appendFileSync(partial,chunk,{mode:0o600,flush:true});const complete=offset+chunk.length===metadata.size;
                if(complete){progressAt.delete(id);renameSync(partial,originalPath(id));updateAsset(id,{status:'processing',progress:0,preparationStage:'Queued for media processing'});if(!DEFER_PREP)processAsset(id);}
                // Keep collaborators informed without persisting the workspace for every chunk.
                else if (Date.now() - (progressAt.get(id) ?? 0) >= 5000) {
                  progressAt.set(id, Date.now());
                  updateAsset(id, { progress: Math.min(99, Math.floor((offset + chunk.length) / metadata.size * 100)) });
                }
                send(res,complete?202:200,{offset:offset+chunk.length,complete});return;
              } finally {uploadLocks.delete(id);}
            }
          }
          if (['GET', 'HEAD'].includes(method) && suffix === 'original') {
            const extension = extname(asset.name).toLowerCase(); const allowed = asset.kind === 'image' ? ['.jpg', '.jpeg', '.png', '.webp'] : asset.kind === 'audio' ? ['.mp3', '.m4a', '.wav'] : ['.mp4', '.mov', '.webm'];
            const type = allowed.includes(extension) ? contentTypes[extension] : 'application/octet-stream';
            streamFile(req, res, originalPath(id), type, url.searchParams.has('download') || type === 'application/octet-stream' ? asset.name : undefined); return;
          }
          if (['GET', 'HEAD'].includes(method) && suffix?.startsWith('files/')) {
            const filename = suffix.slice(6); if (!/^[a-zA-Z0-9_-]+\.(mp4|m4a|jpg|jpeg|png|json|webp)$/.test(filename)) fail(404, 'File not found.');
            streamFile(req, res, join(mediaDir(id), 'prepared', filename), undefined, undefined, true); return;
          }
          if (method === 'PATCH' && !suffix) {
            const body = await jsonBody(req); const patch: Partial<Asset> = {};
            if (body.name !== undefined) patch.name = textField(body.name, 255, true).trim();
            // A bin is a folder in the media panel. A bulk import assigns one per camera, so this
            // takes a free-form id rather than a fixed list; the panel shows whatever is in use.
            if (body.binId !== undefined) { const binId = textField(body.binId, 64, true).trim(); if (!/^[A-Za-z0-9 _-]{1,64}$/.test(binId)) fail(400, 'A bin name uses letters, numbers, spaces, hyphens or underscores.'); patch.binId = binId; }
            if (!Object.keys(patch).length) fail(400, 'Nothing to change.');
            updateAsset(id, patch); send(res, 200, { asset: state.media.find(item => item.id === id) }); return;
          }
          if (method === 'POST' && suffix === 'retry') { if (!existsSync(originalPath(id)) && !asset.importLink) fail(409, 'The original upload is missing. Upload the file again.'); if (aborters.has(id)) fail(409, 'This file is already processing.'); updateAsset(id, { status: 'processing', progress: 0, error: undefined }); processAsset(id); send(res, 202, { asset: state.media.find(item => item.id === id) }); return; }
          if (method === 'POST' && suffix === 'cancel' && asset.importLink) {
            aborters.get(id)?.abort();
            if (!['ready', 'failed'].includes(asset.status)) updateAsset(id, { status: 'failed', error: 'Import cancelled.', progress: 0 });
            send(res, 200, { ok: true }); return;
          }
          if (method === 'DELETE' && !suffix) {
            if (state.clips.some(clip => clip.mediaId === id) || state.snapshots.some(snapshot => snapshot.state.clips.some(clip => clip.mediaId === id)) || state.renderJobs.some(job => job.projectId === asset.projectId && ['waiting', 'rendering'].includes(job.status)) || captionJobs().some(job=>job.projectId===asset.projectId&&['waiting','running'].includes(job.status))) fail(409, 'This media is used by a timeline, snapshot, or pending export.');
            aborters.get(id)?.abort(); state.media = state.media.filter(item => item.id !== id); persist();
            // Worker cleanup follows cancellation so an encoder cannot recreate deleted files.
            void queue.drain().then(() => rmSync(mediaDir(id), { recursive: true, force: true })).catch(error => console.error('File cleanup failed:', error)); send(res, 200, { ok: true }); return;
          }
        }
        if(path==='/api/captions'&&method==='GET') {
          const project=requireProject(url.searchParams.get('projectId')||'',userId);
          send(res,200,{available:captionAvailable(),jobs:captionJobs().filter(j=>j.projectId===project.id).slice(0,50).map(({words,...job})=>({...job,wordCount:words?.length}))});return;
        }
        if(path==='/api/captions'&&method==='POST') {
          const body=await jsonBody(req),project=requireProject(textField(body.projectId,160,true),userId,true);
          const timeline=state.timelines.find(t=>t.id===body.timelineId&&t.projectId===project.id)??fail(400,'Timeline not found.');
          const start=numberField(body.start,0,timeline.duration),end=numberField(body.end,start+1/project.fps,Math.min(21600,timeline.duration));
          if(!Array.isArray(body.trackIds)||body.trackIds.length>1000||body.trackIds.some((id:unknown)=>!state.tracks.some(t=>t.id===id&&t.timelineId===timeline.id&&!t.captionSets)))fail(400,'Choose audio source tracks on this timeline.');
          if(!captionAvailable())fail(503,'Local speech models are not installed. Run npm run setup:captions on the server.');
          if(captionJobs().filter(j=>['waiting','running'].includes(j.status)).length>=4)fail(429,'The transcription queue is full.');
          const wordsPerLine=numberField(body.wordsPerLine??5,1,15);if(!Number.isInteger(wordsPerLine)||!captionPresets.some(p=>p.id===(body.preset??'highlight')))fail(400,'Choose a valid caption preset and line length.');
          const removeSets=body.removeSets??[];
          if(!Array.isArray(removeSets)||removeSets.length>200||removeSets.some((id:unknown)=>typeof id!=='string'||!state.tracks.some(t=>t.timelineId===timeline.id&&t.captionSets?.some(meta=>meta.id===id))))fail(400,'Choose existing caption sets on this timeline to replace.');
          const job:CaptionJob={wordsPerLine,removeSets,preset:body.preset??'highlight',...(body.replaceSet?{replaceSet:textField(body.replaceSet,160,true)}:{}),id:`caption-${randomUUID()}`,projectId:project.id,timelineId:timeline.id,start,end,trackIds:body.trackIds,signature:body.signature===undefined?captionSignature(state.clips,state.tracks,timeline.id,start,end,body.trackIds):textField(body.signature,100,true),status:'waiting',stage:'Queued',progress:0};
          const snapshot=structuredClone({project,timeline,timelines:state.timelines.filter(t=>t.projectId===project.id),clips:state.clips.filter(c=>c.projectId===project.id),tracks:state.tracks.filter(t=>state.timelines.some(tl=>tl.id===t.timelineId&&tl.projectId===project.id)),nodes:[],assets:state.media.filter(a=>a.projectId===project.id).map(asset=>({asset,path:originalPath(asset.id)})),settings:{rangeIn:String(start),rangeOut:String(end)}});
          saveCaptionJob(job);
          addWork(job.id,async signal=>{
            try {
              job.status='running';saveCaptionJob(job);
              job.words=await transcribeTimeline({...snapshot,outputPath:'',signal},job.trackIds,(stage,progress)=>{if(!closed&&!signal.aborted){job.stage=stage;job.progress=progress;saveCaptionJob(job);}});
              if(signal.aborted)throw new Error('Cancelled');
              job.status='complete';job.stage=job.words.length?'Ready':'No speech detected';job.progress=100;
            }catch(error){job.status=signal.aborted?'cancelled':'failed';job.stage=signal.aborted?'Cancelled':'Transcription failed';job.error=(error as Error).message;}
            if(!closed)saveCaptionJob(job);
          });
          send(res,202,{job});return;
        }
        const captionRoute=/^\/api\/captions\/([a-zA-Z0-9_-]+)$/.exec(path);
        if(captionRoute){
          const row=db.prepare('SELECT data FROM caption_jobs WHERE id=?').get(captionRoute[1]) as {data:string}|undefined;
          if(!row)fail(404,'Transcription not found.');const job=JSON.parse(row!.data) as CaptionJob;
          requireProject(job.projectId,userId,method!=='GET');
          if(method==='GET'){send(res,200,{job});return;}
          if(method==='DELETE'){aborters.get(job.id)?.abort();saveCaptionJob({...job,status:'cancelled',stage:'Cancelled'});send(res,200,{ok:true});return;}
        }
        if (path === '/api/smart-masks/capabilities' && method === 'GET') { send(res, 200, await smartMaskCapabilities()); return; }
        if (['/api/smart-masks/source', '/api/smart-masks/source-times'].includes(path) && ['GET', 'HEAD'].includes(method)) {
          const clip = state.clips.find(item => item.id === url.searchParams.get('clipId')) ?? fail(404, 'Clip not found.');
          requireProject(clip.projectId, userId);
          const asset = state.media.find(item => item.id === clip.mediaId && item.projectId === clip.projectId) ?? fail(404, 'Media not found.');
          if (asset.kind !== 'video' || !existsSync(originalPath(asset.id))) fail(409, 'Original video is unavailable.');
          const sourceTimes = await masks.sourceTimes(clip, asset, originalPath(asset.id));
          if (path.endsWith('source-times')) { send(res, 200, { sourceTimes }); return; }
          const frame = Number(url.searchParams.get('frame'));
          if (!Number.isSafeInteger(frame) || frame < 0 || frame >= sourceTimes.length) fail(400, 'Invalid source frame.');
          res.setHeader('X-Smart-Mask-Time', String(sourceTimes[frame])); res.setHeader('X-Smart-Mask-Frame', String(frame));
          const image = await masks.source(clip, asset, originalPath(asset.id), frame);
          streamFile(req, res, image, 'image/jpeg'); return;
        }
        if (path === '/api/smart-masks/preview' && method === 'POST') {
          const body = await jsonBody(req), clip = state.clips.find(item => item.id === textField(body.clipId, 160, true)) ?? fail(404, 'Clip not found.');
          requireProject(clip.projectId, userId, true);
          const asset = state.media.find(item => item.id === clip.mediaId && item.projectId === clip.projectId) ?? fail(404, 'Media not found.');
          if (asset.kind !== 'video' || !existsSync(originalPath(asset.id))) fail(409, 'Original video is unavailable.');
          const mask = clip.smartMasks?.find(item => item.id === textField(body.maskId, 160, true)) ?? fail(404, 'Mask not found.');
          // Guides come from the request so a click previews before the workspace save lands.
          const candidate = { ...structuredClone(mask), prompts: body.prompts, repairs: [] }; validateSmartMask(candidate);
          if (!candidate.prompts.length || candidate.prompts.length > 64) fail(400, 'Preview one frame of guides at a time.');
          const frame = Number(body.frame); if (!Number.isSafeInteger(frame) || frame < 0) fail(400, 'Invalid source frame.');
          const image = await masks.preview(structuredClone(clip), asset, originalPath(asset.id), candidate, frame, candidate.prompts);
          send(res, 200, { url: `/api/smart-masks/preview/${basename(image, '.png')}.png?projectId=${encodeURIComponent(clip.projectId)}` }); return;
        }
        const previewRoute = /^\/api\/smart-masks\/preview\/([a-f0-9]{64})\.png$/.exec(path);
        if (previewRoute && ['GET', 'HEAD'].includes(method)) {
          requireProject(textField(url.searchParams.get('projectId'), 160, true), userId);
          streamFile(req, res, masks.previewFile(previewRoute[1]), 'image/png', undefined, true); return;
        }
        if (path === '/api/smart-masks' && method === 'POST') {
          const body = await jsonBody(req), clip = state.clips.find(item => item.id === textField(body.clipId, 160, true)) ?? fail(404, 'Clip not found.');
          requireProject(clip.projectId, userId, true);
          const asset = state.media.find(item => item.id === clip.mediaId && item.projectId === clip.projectId) ?? fail(404, 'Media not found.');
          if (asset.kind !== 'video' || !existsSync(originalPath(asset.id))) fail(409, 'Original video is unavailable.');
          const mask = clip.smartMasks?.find(item => item.id === textField(body.maskId, 160, true)) ?? fail(404, 'Mask not found.');
          const job = await masks.enqueue({ clip: structuredClone(clip), asset, mask: structuredClone(mask), sourcePath: originalPath(asset.id), signature: textField(body.signature, 8_000_000, true), direction: body.direction, anchorTime: body.anchorTime });
          send(res, job.status === 'ready' ? 200 : 202, job); return;
        }
        const maskRoute = /^\/api\/smart-masks\/([a-f0-9]{64})(?:\/(manifest|frames|preview|source)(?:\/(\d+)\.(png|jpg))?)?$/.exec(path);
        if (maskRoute) {
          const projectId = textField(url.searchParams.get('projectId'), 160, true); requireProject(projectId, userId, method === 'DELETE');
          const [_, key, kind, frame, extension] = maskRoute;
          if (!kind && method === 'GET') { send(res, 200, masks.get(projectId, key)); return; }
          if (!kind && method === 'DELETE') { masks.cancel(projectId, key); send(res, 200, { ok: true }); return; }
          if (['GET', 'HEAD'].includes(method) && (kind === 'manifest' && !frame || (kind === 'frames' || kind === 'preview') && extension === 'png' || kind === 'source' && extension === 'jpg')) {
            const currentClip = kind === 'manifest' && url.searchParams.has('clipId');
            if (currentClip) {
              const clip = state.clips.find(item => item.id === url.searchParams.get('clipId') && item.projectId === projectId) ?? fail(404, 'Clip not found.');
              const mask = clip.smartMasks?.find(item => item.result?.key === key) ?? fail(409, 'This mask is no longer attached to the clip.');
              const asset = state.media.find(item => item.id === clip.mediaId && item.projectId === projectId) ?? fail(404, 'Media not found.');
              if (!existsSync(originalPath(asset.id))) fail(409, 'Original video is unavailable.');
              resolveSmartMaskArtifact(join(dataDir, 'smart-masks'), clip, mask, originalPath(asset.id), asset);
            }
            streamFile(req, res, masks.file(projectId, key, kind as 'manifest' | 'frames' | 'preview' | 'source', frame === undefined ? undefined : Number(frame)), undefined, undefined, !currentClip); return;
          }
        }
        if (path === '/api/optical-flow/capabilities' && method === 'GET') {
          try { await flowWorker(); send(res,200,{available:true,engine:'Apple VideoToolbox · quality priority'}); }
          catch(error) { send(res,200,{available:false,error:(error as Error).message}); } return;
        }
        if (path === '/api/optical-flow' && method === 'POST') {
          const body = await jsonBody(req), clip = state.clips.find(c => c.id === textField(body.clipId,160,true)) ?? fail(404,'Clip not found.');
          const project = requireProject(clip.projectId,userId);
          const asset = state.media.find(a => a.id === clip.mediaId && a.projectId === project.id);
          if (!asset || asset.kind !== 'video' || !clip.properties.opticalFlow) fail(400,'Enable optical flow on a video clip first.');
          const quality = textField(body.quality,20,true);
          if (!['Full','1/2','1/4','Stream','Original','Color'].includes(quality)) fail(400,'Invalid preview quality.');
          const fps = numberField(body.fps,1,120);
          const records = timelineTransitions(state.clips.filter(c=>c.projectId===project.id),clip.timelineId,state.media);
          const span = clipSpan(clip,records), geometry = extendClip(clip,Math.max(0,span.start),span.end-Math.max(0,span.start));
          if (!same(body.timing,flowTiming(geometry))) fail(409,'The speed edit is still saving. Retry optical flow after saving.');
          const chunk = numberField(body.chunk,0,Math.ceil(geometry.duration/flowChunkSeconds)-1);
          if (!Number.isInteger(chunk)) fail(400,'Invalid preview chunk.');
          const from = chunk * flowChunkSeconds, duration = Math.min(flowChunkSeconds,geometry.duration-from);
          const previewName = quality === 'Color' || quality === 'Full' && asset!.colorProxyUrl ? 'color-v1.mp4' : quality === '1/4' ? 'proxy-quarter-v1.mp4' : quality === '1/2' || quality === 'Stream' ? 'proxy-half-v1.mp4' : 'proxy.mp4';
          const proxy = join(mediaDir(asset!.id),'prepared',previewName);
          const input = quality==='Original'||quality==='Color'&&!existsSync(proxy)?originalPath(asset!.id):existsSync(proxy) ? proxy : join(mediaDir(asset!.id),'prepared','proxy.mp4');
          if (!existsSync(input)) fail(409,'The source preview is still being prepared.');
          const generation=JSON.stringify([flowTiming(geometry),fps,quality]);
          const key = await flowIdentity(geometry,input,fps,from,duration,true);
          const file = join(flowDirectory,`${key}.mp4`);
          let job = flowJobs.get(key);
          if (existsSync(file)) {
            if (!job) flowJobs.set(key,{status:'ready',key,progress:100,from,duration,fps,projectId:project.id,clipId:clip.id,generation,controller:new AbortController()});
            send(res,200,{status:'ready',key,url:`/api/optical-flow/${key}/video?projectId=${project.id}`,progress:100,from,duration,fps}); return;
          }
          if (!job || job.controller.signal.aborted) {
            for (const old of flowJobs.values()) if (old.clipId === clip.id && old.status === 'preparing' && old.key !== key && old.generation !== generation) old.controller.abort();
            if ([...flowJobs.values()].filter(j=>j.status==='preparing'&&!j.controller.signal.aborted).length >= 8) fail(429,'Optical-flow preview queue is full.');
            job = {status:'preparing',key,progress:0,from,duration,fps,projectId:project.id,clipId:clip.id,generation,controller:new AbortController()};
            flowJobs.set(key,job); const current = job, snapshot = structuredClone({clip:geometry,asset:asset!});
            flowQueue = flowQueue.then(async () => {
              if (closed || current.controller.signal.aborted) return;
              try {
                await renderOpticalFlow({...snapshot,input,directory:flowDirectory,fps,from,duration,preview:true,signal:current.controller.signal,onProgress:p=>{current.progress=Math.round(p);}});
                current.status='ready'; current.url=`/api/optical-flow/${key}/video?projectId=${project.id}`;
                await trimFlowCache(flowDirectory,new Set([key]));
              } catch(error) { current.status='failed';current.error=(error as Error).message; }
            });
          }
          const {controller,projectId,clipId,generation:jobGeneration,...result}=job;
          send(res,200,result); return;
        }
        const flowRoute = /^\/api\/optical-flow\/([a-f0-9]{64})(?:\/(video))?$/.exec(path);
        if (flowRoute) {
          const projectId = textField(url.searchParams.get('projectId'),160,true); requireProject(projectId,userId);
          const job = flowJobs.get(flowRoute[1]);
          // The project binding is retained for downloads; never authorize a cache hash on its own.
          if (!job || job.projectId !== projectId) fail(404,'Optical-flow preview not found. Prepare it again.');
          if (method==='DELETE'&&!flowRoute[2]) { job!.controller.abort(); flowJobs.delete(flowRoute[1]); send(res,200,{ok:true});return; }
          if (['GET','HEAD'].includes(method)&&flowRoute[2]) { streamFile(req,res,join(flowDirectory,`${flowRoute[1]}.mp4`),'video/mp4',undefined,true);return; }
        }
        if (path === '/api/stabilize/capabilities' && method === 'GET') { send(res,200,await stabilizeCapabilities()); return; }
        if (path === '/api/stabilize' && method === 'POST') {
          const body = await jsonBody(req), clip = state.clips.find(c => c.id === textField(body.clipId,160,true)) ?? fail(404,'Clip not found.');
          const project = requireProject(clip.projectId,userId);
          const asset = state.media.find(a => a.id === clip.mediaId && a.projectId === project.id);
          const effect = stabilizeEffect(clip);
          if (!asset || asset.kind !== 'video' || !effect) fail(400,'Add Stabilize to a video clip first.');
          const settings = stabilizeSettings(clip,effect!);
          if (!same(normalizeSettings(body.settings),normalizeSettings(settings))) fail(409,'The Stabilize settings are still saving. Retry shortly.');
          const records = timelineTransitions(state.clips.filter(c=>c.projectId===project.id),clip.timelineId,state.media);
          const span = clipSpan(clip,records), geometry = extendClip(clip,Math.max(0,span.start),span.end-Math.max(0,span.start));
          const sourceFps = asset!.fps || numberField(body.fps,1,120), range = stabilizeRange(geometry,sourceFps,asset!.duration);
          const original = originalPath(asset!.id);
          if (!existsSync(original)) fail(409,'Original media is missing.');
          // The editor warps the picture it already decodes, so one solve serves every frame, quality and section.
          const generation = JSON.stringify([clip.mediaId,settings,range]), key = createHash('sha256').update(`${clip.id}:${generation}`).digest('hex');
          let job = stabilizeJobs.get(key);
          if (!job || job.controller.signal.aborted || job.status === 'failed' && Date.now() - job.polled > 10_000) {
            for (const old of stabilizeJobs.values()) if (old.clipId === clip.id && old.key !== key) { old.controller.abort(); stabilizeJobs.delete(old.key); }
            const pending = [...stabilizeJobs.values()].filter(j=>j.status==='preparing'&&!j.started&&!j.controller.signal.aborted);
            if (pending.length >= 8) { const stale = pending.sort((a,b)=>a.polled-b.polled)[0]; stale.controller.abort(); stabilizeJobs.delete(stale.key); }
            const current: StabilizeJob = {status:'preparing',key,progress:0,projectId:project.id,clipId:clip.id,generation,controller:new AbortController(),created:Date.now(),polled:Date.now(),started:false,run:async()=>{
              try {
                const solved = await stabilizeSolve({input:original,directory:stabilizeDirectory,range,settings,signal:current.controller.signal,onProgress:p=>{current.progress=Math.round(p);}});
                current.solve=solved.solve; current.zoom=solved.solve.zoom; current.zoomMin=solved.solve.zoomMin; current.status='ready'; current.progress=100;
                await trimStabilizeCache(stabilizeDirectory,new Set());
              } catch(error) { current.status='failed';current.error=(error as Error).message; }
            }};
            stabilizeJobs.set(key,current); job = current; pumpStabilize();
          }
          job!.polled = Date.now();
          const {controller,projectId,clipId,generation:jobGeneration,created,polled,started,run,...view}=job!;
          send(res,200,view); return;
        }
        const stabilizeRoute = /^\/api\/stabilize\/([a-f0-9]{64})$/.exec(path);
        if (stabilizeRoute && method === 'DELETE') {
          const projectId = textField(url.searchParams.get('projectId'),160,true); requireProject(projectId,userId);
          const job = stabilizeJobs.get(stabilizeRoute[1]);
          // The project binding is retained; never authorize a cache hash on its own.
          if (!job || job.projectId !== projectId) fail(404,'Stabilize analysis not found. Prepare it again.');
          job!.controller.abort(); stabilizeJobs.delete(stabilizeRoute[1]); send(res,200,{ok:true});return;
        }
        if (path === '/api/renders' && method === 'GET') { send(res, 200, { jobs: view(account).state.renderJobs }); return; }
        if (path === '/api/renders' && method === 'POST') {
          const body = await jsonBody(req); const project = requireProject(textField(body.projectId, 160, true), userId, true); object(body.settings);
          for (const value of Object.values(body.settings)) textField(value, 255);
          const settings = body.settings as Record<string, string>; const timeline = state.timelines.find(item => item.projectId === project.id && (!settings.timelineId || item.id === settings.timelineId)) ?? fail(400, 'Create a timeline before exporting.');
          const clips = state.clips.filter(clip => clip.timelineId === timeline.id); if (!clips.some(clip => !clip.disabled)) fail(400, 'Add a clip to the timeline before exporting.');
          if (state.renderJobs.filter(job => ['waiting', 'rendering'].includes(job.status)).length >= 20) fail(429, 'The render queue is full.');
          const job: RenderJob = { id: `render-${randomUUID()}`, projectId: project.id, name: textField(body.name, 160, true).trim(), preset: textField(body.preset, 80, true), status: 'waiting', progress: 0, remaining: 'Waiting', settings };
          const snapshot = structuredClone({ project, timeline, timelines:state.timelines.filter(t=>t.projectId===project.id), clips:state.clips.filter(c=>c.projectId===project.id), tracks: state.tracks.filter(track => state.timelines.some(t=>t.id===track.timelineId&&t.projectId===project.id)), nodes: state.nodes.filter(node => node.projectId === project.id), assets: state.media.filter(asset => asset.projectId === project.id).map(asset => ({ asset, path: originalPath(asset.id) })), settings });
          mkdirSync(join(dataDir, 'renders'), { recursive: true, mode: 0o700 }); state.renderJobs.unshift(job); persist();
          startRender(job, snapshot);
          send(res, 202, { job }); return;
        }
        const renderRoute = /^\/api\/renders\/([a-zA-Z0-9_-]+)(?:\/(download))?$/.exec(path);
        if (renderRoute) {
          const job = state.renderJobs.find(job => job.id === renderRoute[1]) ?? fail(404, 'Export not found.'); requireProject(job.projectId, userId, method === 'DELETE');
          if (['GET', 'HEAD'].includes(method) && renderRoute[2] === 'download') { if (job.status !== 'complete') fail(409, 'The export is not complete.'); const extension = job.settings.codec?.includes('ProRes') ? '.mov' : '.mp4'; streamFile(req, res, join(dataDir, 'renders', `${job.id}${extension}`), contentTypes[extension], job.name.toLowerCase().endsWith(extension) ? job.name : `${job.name}${extension}`, true); return; }
          if (method === 'DELETE' && !renderRoute[2]) { aborters.get(job.id)?.abort(); updateJob(job.id, { status: 'failed', remaining: 'Cancelled', error: 'Cancelled by user.' }); send(res, 200, { ok: true }); return; }
        }
        fail(404, 'API endpoint not found.');
      }
      if (!['GET', 'HEAD'].includes(method)) fail(405, 'Method not allowed.');
      let decoded: string; try { decoded = decodeURIComponent(path); } catch { fail(400, 'Invalid URL.'); }
      const requested = resolve(distDir, `.${decoded!}`); if (!requested.startsWith(`${distDir}${sep}`) && requested !== distDir) fail(404, 'File not found.');
      const file = existsSync(requested) && statSync(requested).isFile() ? requested : extname(decoded!) ? fail(404, 'File not found.') : join(distDir, 'index.html');
      if (!existsSync(file)) { send(res, 503, { error: 'The application has not been built. Run npm run build, or use the Vite development server.' }); return; }
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      streamFile(req, res, file, undefined, undefined, decoded!.startsWith('/assets/'));
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error instanceof HttpError || (error instanceof Error && 'status' in error) ? (error as HttpError).status : 500, { error: error instanceof Error && 'status' in error ? error.message : 'The server could not complete the request.' });
      else if (!res.writableEnded) res.destroy();
      if (!(error instanceof Error && 'status' in error)) console.error('Request failed:', error);
    }
  });
  server.requestTimeout = 60 * 60_000; server.headersTimeout = 30_000;
  const housekeeping = setInterval(() => { expired(); purgeExpiredProjects(); const now = Date.now(); for (const [key, value] of authAttempts) if (value.reset < now) authAttempts.delete(key); for (const [res, subscriber] of subscribers) { if (!db.prepare('SELECT token FROM sessions WHERE token=? AND expiresAt>?').get(subscriber.session, now)) { res.end(); subscribers.delete(res); } else res.write(': heartbeat\n\n'); } }, 10_000); housekeeping.unref();
  purgeExpiredProjects();
  for (const job of state.renderJobs) if (job.status === 'rendering' || job.status === 'waiting') {
    const savedSnapshot = db.prepare('SELECT data FROM render_snapshots WHERE id=?').get(job.id);
    const project = state.projects.find(p => p.id === job.projectId);
    const timeline = state.timelines.find(t => t.projectId === job.projectId && (!job.settings.timelineId || t.id === job.settings.timelineId));
    if (savedSnapshot || (job.status === 'waiting' && project && timeline)) {
      job.status = 'waiting'; job.progress = 0; job.remaining = 'Queued for export';
      startRender(job, savedSnapshot ? JSON.parse(String(savedSnapshot.data)) : structuredClone({ project: project!, timeline: timeline!, timelines: state.timelines.filter(t => t.projectId === job.projectId), clips: state.clips.filter(c => c.projectId === job.projectId), tracks: state.tracks.filter(t => state.timelines.some(tl => tl.id === t.timelineId && tl.projectId === job.projectId)), nodes: state.nodes.filter(n => n.projectId === job.projectId), assets: state.media.filter(a => a.projectId === job.projectId).map(asset => ({ asset, path: originalPath(asset.id) })), settings: job.settings }));
    } else { job.status = 'failed'; job.remaining = 'Interrupted by server restart'; job.error = 'The server restarted. Submit the export again.'; }
  }
  for (const asset of state.media as Asset[]) if (!['ready', 'failed', 'uploading'].includes(asset.status)) { asset.status = 'failed'; asset.error = 'Processing was interrupted. Retry to continue from the saved original.'; }
  for (const asset of state.media) if (asset.status === 'ready') asset.preparationStage = undefined;
  if (saved) persist();
  // Upgrade existing imports in the same bounded worker queue; their current preview stays usable.
  for (const asset of state.media) if (asset.kind === 'video' && asset.status === 'ready' && !asset.proxyVariants?.Stream?.endsWith(`/${STREAM_VARIANT}`) && asset.proxyUrl) {
    const filename = asset.proxyUrl.split('/').at(-1)!;
    if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(filename)) continue;
    const inputPath = join(mediaDir(asset.id), 'prepared', filename);
    if (!existsSync(inputPath)) continue;
    addWork(`preview-${asset.id}`, async signal => {
      try {
        const previews = await preparePreviewVariants({ inputPath, outputDir: join(mediaDir(asset.id), 'prepared'), baseUrl: `/api/media/${asset.id}/files`, signal });
        if (!signal.aborted && !closed) updateAsset(asset.id, previews);
      } catch (error) { if (!signal.aborted) console.error(`Preview upgrade failed for ${asset.name}:`, error); }
    });
  }
  for(const asset of state.media) if(!SKIP_COLOR_PROXY&&asset.kind==='video'&&asset.status==='ready'&&!asset.colorProxyUrl&&existsSync(originalPath(asset.id))) {
    if(existsSync(join(mediaDir(asset.id),'prepared','color-v1.mp4'))){updateAsset(asset.id,{colorProxyUrl:`/api/media/${asset.id}/files/color-v1.mp4`});continue;}
    addWork(`color-${asset.id}`,async signal=>{
      try{const preview=await prepareColorProxy({inputPath:originalPath(asset.id),outputDir:join(mediaDir(asset.id),'prepared'),baseUrl:`/api/media/${asset.id}/files`,signal});if(!signal.aborted&&!closed)updateAsset(asset.id,preview);}
      catch(error){if(!signal.aborted)console.error(`Color preview failed for ${asset.name}:`,error);}
    });
  }
  // Media imported before filmstrips existed still shows one repeated still until this lands.
  for (const asset of state.media) if (asset.kind === 'video' && asset.status === 'ready' && asset.filmstripVersion !== FILMSTRIP_VERSION && existsSync(originalPath(asset.id))) {
    addWork(`filmstrip-${asset.id}`, async signal => {
      try {
        const frames = await prepareMediaFilmstrip(originalPath(asset.id), join(mediaDir(asset.id), 'prepared'), asset.duration, signal);
        if (!signal.aborted && !closed) updateAsset(asset.id, { filmstrip: `/api/media/${asset.id}/files/filmstrip.jpg`, filmstripFrames: frames, filmstripVersion: FILMSTRIP_VERSION });
      } catch (error) { if (!signal.aborted) console.error(`Filmstrip build failed for ${asset.name}:`, error); }
    });
  }
  for (const asset of state.media) if (asset.status === 'ready' && asset.hasAudio && asset.waveformVersion !== 2 && existsSync(originalPath(asset.id))) {
    addWork(`waveform-${asset.id}`, async signal => {
      try { const peaks = await prepareWaveform(originalPath(asset.id), asset.duration, signal); if (!signal.aborted && !closed) updateAsset(asset.id, peaks); }
      catch (error) { if (!signal.aborted) console.error(`Waveform upgrade failed for ${asset.name}:`, error); }
    });
  }
  for (const sound of sounds.list()) if (sound.status === 'ready' && sound.waveformVersion !== 2) addWork(`waveform-${sound.id}`, async signal => {
    try { await sounds.upgradeWaveform(sound.id, signal); } catch (error) { if (!signal.aborted) console.error(`Waveform upgrade failed for ${sound.name}:`, error); }
  });
  return { server, dataDir, async close() { closed = true; await masks.close(); for(const job of flowJobs.values())job.controller.abort(); await flowQueue; clearInterval(housekeeping); clearTimeout(presenceTimer); clearTimeout(broadcastTimer); for (const controller of aborters.values()) controller.abort(); for (const response of subscribers.keys()) response.end(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await queue.drain(); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createFrameLineServer(); const port = Number(process.env.PORT ?? 4310); const host = process.env.HOST ?? '127.0.0.1';
  app.server.listen(port, host, () => console.log(`SharedCut server listening at http://${host}:${port}`));
  let stopping = false; for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!stopping) { stopping = true; void app.close().then(() => process.exit(0)); } });
}
