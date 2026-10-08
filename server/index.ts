import { createPreviewCache, createStillCache, mediaStill, stillSettings, StillSkipped, PreviewBusyError, type PreviewAdmission } from './previewCache.ts';
import { createHostGuard, JOB_COST_BYTES, VICTIM_ORDER, type HostGuard } from './hostGuard.ts';
import { createHostHealthLog } from './hostHealthLog.ts';
import { canSeeHealth, createPlaybackReports, type Identity } from './playbackReports.ts';
import { liveChildren, setStartGate } from './processTree.ts';
import type { HostHealth } from '../src/services/playbackReportTypes.ts';
import { validateMotionBlur } from '../src/services/motionBlur.ts';
import { workQueue, heavyJob } from './workQueue.ts';
import { stateDelta, applyStateDelta, stateEqual, shareState } from '../src/services/stateDelta.ts';
import { COLLECTIONS, holdDataLock, workspaceStore } from './workspaceStore.ts';
import { parseImportLink, downloadLink, youtubeThumbnail } from './linkImport.ts';
import { soundLibrary } from './sfx.ts';
import { projectLibrary } from './library.ts';
import { captionAvailable, transcribeTimeline } from './captions.ts';
import { captionSignature, captionPresets, validateCaptionSets, isCaption, type CaptionJob } from '../src/services/captions.ts';
import { isShape, getShape, validateShape } from '../src/services/shapes.ts';
import { isComposition, validateCompositions } from '../src/services/compositions.ts';
import { isAdjustment } from '../src/services/adjustment.ts';
import { validateKeyframes } from '../src/services/animation.ts';
import { clipSpan, extendClip } from '../src/services/playback.ts';
import { flowChunkSeconds, flowTiming, type FlowPreview } from '../src/services/opticalFlow.ts';
import { flowWorker, flowEngineLabel, flowIdentity, renderOpticalFlow, trimFlowCache } from './opticalFlow.ts';
import { normalizeSettings, pickStabilizeJob, stabilizeCapabilities, stabilizeSolve, trimStabilizeCache } from './stabilize.ts';
import { stabilizeEffect, stabilizeRange, stabilizeSettings, type StabilizePreview } from '../src/services/stabilize.ts';
import { presenceCursor } from '../src/services/presence.ts';
import { fontLibrary } from './fonts.ts';
import { transitionLibrary } from './transitions.ts';
import { transitionPresetId, timelineTransitions, transitionDefinitions, isLeakMedia, leakIdOf, validateTransition } from '../src/services/transitions.ts';
import { canvasFont, isTitle, getText, validateText, type TextStyle } from '../src/services/text.ts';
import { createCanvas } from '@napi-rs/canvas';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { linkSync, copyFileSync, mkdirSync, existsSync, createReadStream, createWriteStream, statSync, statfsSync, renameSync, rmSync, chmodSync, readFileSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { resolve, join, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { promisify, isDeepStrictEqual } from 'node:util';
import { LOCK_TTL, MOVEMENT_FIELDS, lockConflict, type PersistedState } from '../src/services/index.ts';
import type { User, Project, MediaAsset, RenderJob, Presence, CollaborativeLock } from '../src/state/models.ts';
import { exportResolveTimeline, importResolve } from './resolve.ts';
import { importFcpxml } from './fcpxml.ts';
import { parseCube, validateGradeNode } from '../src/services/color.ts';
import { smartMaskService, smartMaskCapabilities, resolveSmartMaskArtifact } from './smartMask.ts';
import { depthCapabilities, depthService } from './depth.ts';
import { validateSmartMask, validateSmartMaskBindings } from '../src/services/smartMask.ts';
import { motionTrackerCapabilities, motionTrackerService } from './motionTracker.ts';
import { aiColorAllowed, colorAssistantCapabilities, colorAssistantService } from './colorAssistant.ts';
import { validateMotionTrackers } from '../src/services/motionTracker.ts';
import { readCameraColor } from './cameraMetadata.ts';
import { FILMSTRIP_VERSION, FULL_VARIANT, MEDIA_CONCURRENCY, STREAM_VARIANT, STREAM_LOW_VARIANT, getMediaCapabilities, exportAspect, PROBE_VERSION, prepareMedia, prepareMediaFilmstrip, prepareMediaThumbnail, probeMedia, prepareWaveform, renderTimeline, renderSoundEffect, depthRuns, depthSpan } from './media.ts';
import { migrateAsset, needsMigration, removeLeftovers, sweepPreparedTemp } from './mediaMigration.ts';

const scrypt = promisify(scryptCallback);
const DEFAULT_SETTINGS = { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false, snapping: true, mediaWidth: 278, inspectorWidth: 292, timelineHeight: 294 };
type Collection = typeof COLLECTIONS[number];
type Asset = MediaAsset & { sourceUrl?: string; proxyUrl?: string; waveform?: unknown; hasAudio?: boolean; error?: string };
type Account = { user: User; hash: string; salt: string; settings: PersistedState['settings'] };
type Entry = Record<string, any>;
const emptyState = (): PersistedState => ({ projects: [], media: [], timelines: [], clips: [], tracks: [], nodes: [], comments: [], operations: [], snapshots: [], renderJobs: [], users: [], currentUserId: '', settings: { ...DEFAULT_SETTINGS } });
const idIsValid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
const BIN_ID = /^[A-Za-z0-9 _-]{1,64}$/;
const mediaKind = (name: string): MediaAsset['kind'] => /\.(wav|mp3|aac|aiff?|flac|m4a|ogg)$/i.test(name) ? 'audio' : /\.(png|jpe?g|webp|gif|tiff?|bmp|heic)$/i.test(name) ? 'image' : 'video';
const jsonValue = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// Structural first: saved entities are shared by reference, so a 10 MB media list compares in
// microseconds instead of two JSON round trips. The JSON pass keeps the old answer for the rest.
const same = (a: unknown, b: unknown) => a === b || stateEqual(a, b) || isDeepStrictEqual(jsonValue(a), jsonValue(b));
/**
 * A list rebuilt from one caller's save of the entries they can see. Hidden entries keep their slots, so
 * one user's save never moves another's rows. New entries at either end of the caller's list go to that
 * end of the whole list, where the store has room: put next to the first hidden entry instead, history
 * halved one gap until the store had to renumber every row.
 */
export function mergeVisible<T extends { id?: unknown }>(old: readonly T[], hidden: (item: T) => boolean, sent: readonly T[]) {
  let merged: T[] = [], next = 0;
  const emit = (to: number) => { while (next < to) merged.push(sent[next++]); };
  // Usually the caller kept every entry they could see, in order, and added only at the ends; then each
  // kept entry takes its old slot without indexing every id (10,000 history entries on each save).
  const seen = old.find(item => !hidden(item)), lead = seen ? sent.findIndex(item => item.id === seen.id) : sent.length;
  if (lead >= 0) {
    emit(lead);
    let inOrder = true;
    for (const item of old) {
      if (hidden(item)) merged.push(item);
      else if (next < sent.length && sent[next].id === item.id) merged.push(sent[next++]);
      else { inOrder = false; break; }
    }
    if (inOrder) { emit(sent.length); return merged; }
    merged = []; next = 0;
  }
  const rank = new Map<unknown, number>();
  for (let i = 0; i < sent.length; i++) rank.set(sent[i].id, i);
  let first = sent.length;
  for (const item of old) if (!hidden(item)) first = Math.min(first, rank.get(item.id) ?? first);
  emit(first);
  // Each kept entry takes its old slot, preceded by the new ones the caller put before it; one the caller
  // moved earlier has already been placed.
  for (const item of old) if (hidden(item)) merged.push(item); else emit((rank.get(item.id) ?? -1) + 1);
  emit(sent.length);
  return merged;
}
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
async function jsonBody(req: IncomingMessage, max = 20 * 1024 * 1024) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) fail(415, 'Use application/json.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > max) fail(413, max < 1024 ** 2 ? 'The request is too large.' : `The document exceeds ${max / 1024 ** 2} MB.`); chunks.push(chunk); }
  let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON.'); }
  object(body); safeJson(body); return body;
}
async function binaryBody(req: IncomingMessage, max: number, onProgress?: (bytes: number) => void) {
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>max)fail(413,'File or chunk exceeds the size limit.');chunks.push(chunk);onProgress?.(length);}
  if(!length)fail(400,'Empty upload.');return Buffer.concat(chunks);
}

// Behind cloudflared every request comes from loopback; the client is then the address Cloudflare saw.
const clientAddress = (req: IncomingMessage) => {
  const peer = req.socket.remoteAddress ?? 'local';
  if (process.env.FRAME_LINE_TRUST_PROXY !== '1' || !/^(?:127\.|::ffff:127\.|::1$)/.test(peer)) return peer;
  // X-Forwarded-For's last entry is the one the local proxy appended; earlier ones are whatever the client sent.
  const forwarded = String(req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)).trim();
  return forwarded && forwarded.length <= 64 ? forwarded : peer;
};
const acceptsGzip = (req: IncomingMessage) => (req.headers['accept-encoding'] ?? '').split(',').some(item => {
  const [name, ...params] = item.trim().split(';');
  return name === 'gzip' && !params.some(p => /^q=0(?:\.0*)?$/.test(p.trim()));
});
function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  const gzip = json.length >= 4096 && acceptsGzip(res.req);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  if (!gzip) { res.end(json); return; }
  const stream = createGzip({ level: 1 });
  res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res); stream.end(json);
}
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
export function streamFile(req: IncomingMessage, res: ServerResponse, path: string, type?: string, download?: string, immutable?: boolean) {
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
  // A route that awaited (a shared frame render) can get here after its viewer left: 'close' has already fired, so a
  // stream piped into the dead response would pause forever and hold its file open. pipeline destroys the read stream
  // when the response closes mid-transfer, and the response when the read fails.
  if (res.destroyed) return;
  const stream = createReadStream(path, { start, end });
  void (gzip ? pipeline(stream, createGzip(), res) : pipeline(stream, res)).catch(() => res.destroy());
}

// hostMonitor: write data/host-health.log. Only the real server asks for it; a test server would launch PowerShell and nvidia-smi for nothing.
// hostGuard: a test hands in a guard with a made-up memory reading.
export function createFrameLineServer(options: { dataDir?: string; distDir?: string; maxUploadBytes?: number; legacyEveryMs?: number; hostMonitor?: boolean; hostGuard?: HostGuard } = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.FRAME_LINE_DATA ?? 'data');
  const distDir = resolve(options.distDir ?? 'dist');
  const maxUploadBytes = options.maxUploadBytes ?? Number(process.env.FRAME_LINE_MAX_UPLOAD_BYTES ?? 10 * 1024 ** 3);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) throw new Error('FRAME_LINE_MAX_UPLOAD_BYTES must be a positive integer.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Before anything is read or written: a second server (a double start, `npm start` beside the live
  // one) stops here instead of saving its view of the workspace over the running server's.
  const lock = holdDataLock(dataDir);
  // The timeout waits out the backup worker's write lock instead of failing a save.
  const db = new DatabaseSync(join(dataDir, 'frameline.sqlite'), { timeout: 5000 });
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
  // Progress ticks bump the revision without saving the workspace; this keeps the counter from going backwards on restart.
  db.exec('CREATE TABLE IF NOT EXISTS workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL)');
  const tickRevision = (db.prepare('SELECT revision FROM workspace_revision WHERE id=1').get() as { revision: number } | undefined)?.revision ?? 0;
  const store = workspaceStore(db, join(dataDir, 'frameline.sqlite'), { legacyEveryMs: options.legacyEveryMs });
  let state: PersistedState, revision: number;
  // +1: a client may already hold the last tick, and an offline project import must still look new to it.
  if (store.current()) { const loaded = store.load(); state = { ...emptyState(), ...loaded.state }; revision = Math.max(loaded.revision, tickRevision) + 1; }
  else {
    // First start on the item tables, or the legacy row was written by an older build or project-bundle.mjs.
    const saved = db.prepare('SELECT revision,state FROM workspace WHERE id=1').get() as { revision: number; state: string } | undefined;
    state = { ...emptyState(), ...(saved ? JSON.parse(saved.state) : {}) };
    revision = Math.max(store.revision(), saved?.revision ?? 0, tickRevision) + 1;
    // An older build started after a hard kill without scripts/sync-legacy-row.mjs read a row that
    // lacked the last saves. As the latest writer its row wins, but the rows it replaces are kept.
    const replaced = store.unsynced();
    if (replaced) {
      const file = join(dataDir, `workspace-replaced-${Date.now()}.json`); writeFileSync(file, replaced, { mode: 0o600 });
      console.error(`Another program saved the workspace from a copy that lacked the latest saves. The workspace it replaced is in ${file}.`);
    }
    store.replace(state, revision);
  }
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
  // Host guard: heavy starts (render passes, media encodes, Python workers) ask it before they spawn, and previews are refused
  // while memory is short. data/host-guard.mode holds off, observe (the default: log what it would do) or enforce, and is re-read
  // every second, so the mode changes without a restart. See docs/WINDOWS_NATIVE.md.
  const guard = options.hostGuard ?? createHostGuard({ modePath: join(dataDir, 'host-guard.mode'), log: message => console.warn(message) });
  const removeStartGate = setStartGate(guard); guard.start();
  const flowDirectory = join(dataDir, 'optical-flow');
  const masks = smartMaskService(join(dataDir, 'smart-masks'));
  const motionTrackers = motionTrackerService(join(dataDir, 'motion-trackers'));
  const depth = depthService(join(dataDir, 'depth'), { sourceTimes: masks.sourceTimes, freeGpu: () => masks.stopIdlePreview() });
  const colorAssistant = colorAssistantService(dataDir);
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
    void heavyJob(next.run).finally(() => { stabilizeBusy = false; pumpStabilize(); });
  };
  // Accounts are read by every request and every view but rarely change. `data_version` moves when
  // another connection commits (a script adding a session or account), which reloads them.
  const dataVersion = db.prepare('PRAGMA data_version');
  let accountCache: { version: number; byId: Map<string, Account>; users: User[] } | undefined;
  const accountMap = () => {
    const version = Number((dataVersion.get() as { data_version: number }).data_version);
    if (accountCache?.version !== version) {
      const byId = new Map((db.prepare('SELECT data FROM accounts').all() as { data: string }[]).map(row => { const account = JSON.parse(row.data) as Account; return [account.user.id, account] as const; }));
      accountCache = { version, byId, users: Object.freeze([...byId.values()].map(item => item.user)) as User[] };
    }
    return accountCache;
  };
  const users = () => accountMap().users;
  // A copy: handlers change their account and publish it with saveAccount().
  const accountById = (id: string) => { const account = accountMap().byId.get(id); return account && { ...account }; };
  const saveAccount = (account: Account) => {
    db.prepare('INSERT INTO accounts(id,email,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,data=excluded.data').run(account.user.id, account.user.email, JSON.stringify(account));
    const cache = accountMap(); cache.byId.set(account.user.id, { ...account }); cache.users = Object.freeze([...cache.byId.values()].map(item => item.user)) as User[];
  };
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
  // An account's view keeps its filtered lists while the list and the visible projects are unchanged,
  // so views share arrays with the state and a delta skips every collection nobody touched.
  const viewLists = new Map<string, { scope: string; lists: Map<string, { source: readonly Entry[]; dependency?: unknown; list: readonly Entry[] }> }>();
  const view = (account: Account) => {
    expired(); const userId = account.user.id; const allUsers = users();
    const visible = state.projects.filter(project => visibleTo(project, userId));
    const projects = visible.map(project => ({ ...project, members: allUsers.flatMap(user => { const role = roleFor(project, user.id); return role ? [{ userId: user.id, role }] : []; }) }));
    const ids = new Set(visible.map(project => project.id)), scope = [...ids].join('\n');
    let memo = viewLists.get(userId); if (memo?.scope !== scope) viewLists.set(userId, memo = { scope, lists: new Map() });
    const pick = <T extends Entry>(key: string, source: readonly T[], keep: (item: T) => boolean, dependency?: unknown) => {
      const cached = memo!.lists.get(key); if (cached?.source === source && cached.dependency === dependency) return cached.list as T[];
      const kept = source.filter(keep), list = kept.length === source.length ? source : kept;
      memo!.lists.set(key, { source, dependency, list }); return list as T[];
    };
    const timelines = pick('timelines', state.timelines, item => ids.has(item.projectId)), timelineIds = new Set(timelines.map(item => item.id));
    // Email addresses only for the viewer and people who share a project with them. Everyone else keeps a
    // name and avatar, which is all the people picker in SharingFields needs to add them.
    const known = [...new Set([userId, ...projects.flatMap(project => project.members.map(member => member.userId))])].sort().join('\n');
    let shown = memo!.lists.get('users');
    if (shown?.source !== allUsers || shown.dependency !== known) { const keep = new Set(known.split('\n')); memo!.lists.set('users', shown = { source: allUsers, dependency: known, list: allUsers.map(user => keep.has(user.id) ? user : { ...user, email: '' }) }); }
    return { revision, lockRevision, serverStartedAt, state: { ...state, projects, timelines, tracks: pick('tracks', state.tracks, item => timelineIds.has(item.timelineId), timelines), ...Object.fromEntries(['media', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'].map(key => [key, pick(key, state[key as Collection] as Entry[], item => ids.has(item.projectId))])), users: shown.list as User[], currentUserId: userId, settings: account.settings }, presence: visiblePresence().filter(item => ids.has(item.projectId)), locks: [...locks.values()].filter(item => ids.has(item.projectId)) };
  };
  // ponytail: sixteen recent views per account, 32 accounts; older clients recover with a full snapshot.
  // The views share their entities with the state, so each costs a few arrays of references.
  const recentViews = new Map<string, { revision: number; state: PersistedState }[]>();
  const rememberView = (account: Account) => {
    const envelope = view(account), history = recentViews.get(account.user.id) ?? [];
    recentViews.delete(account.user.id);
    recentViews.set(account.user.id, [...history.filter(item => item.revision !== revision), { revision, state: envelope.state }].slice(-16));
    if (recentViews.size > 32) recentViews.delete(recentViews.keys().next().value!);
    return envelope;
  };
  const stateView = (account: Account, since?: number) => {
    const previous = recentViews.get(account.user.id)?.find(item => item.revision === since), envelope = rememberView(account);
    if (!previous) return { ...envelope, incremental: true };
    const { state: current, ...ephemeral } = envelope;
    return { ...ephemeral, incremental: true, baseRevision: previous.revision, delta: stateDelta(previous.state, current) };
  };
  // A full download is spliced from each entity's stored JSON and streamed in pieces behind the
  // compressor, so the whole workspace is never serialised, encoded or compressed in one go.
  const sendState = (res: ServerResponse, status: number, envelope: Entry) => {
    const { state: body, ...rest } = envelope;
    if (!body) { send(res, status, rest); return; }
    const head = JSON.stringify(rest), gzip = acceptsGzip(res.req);
    function* pieces() {
      yield `${head.slice(0, -1)}${head.length > 2 ? ',' : ''}"state":{`;
      let separator = '';
      for (const [key, value] of Object.entries(body as Entry)) {
        if (value === undefined) continue;
        if (!Array.isArray(value)) { yield `${separator}${JSON.stringify(key)}:${JSON.stringify(value)}`; separator = ','; continue; }
        let batch = `${separator}${JSON.stringify(key)}:[`; separator = ',';
        for (let i = 0; i < value.length; i++) {
          batch += `${i ? ',' : ''}${store.json(value[i]) ?? JSON.stringify(value[i]) ?? 'null'}`;
          if (batch.length > 262_144) { yield batch; batch = ''; }
        }
        yield `${batch}]`;
      }
      yield '}}';
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    const source = Readable.from(pieces());
    void (gzip ? pipeline(source, createGzip({ level: 1 }), res) : pipeline(source, res)).catch(() => res.destroy());
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
    return { revision, lockRevision, serverStartedAt, presence: visiblePresence().filter(item => ids.has(item.projectId)), locks: [...locks.values()].filter(item => ids.has(item.projectId)) };
  };
  // Locks and presence carry no workspace revision, so clients need their own change counter to
  // learn that a short-circuited poll still owes them a lock update. It starts at the server's start time, never at 0: a tab
  // keeps the highest number it has seen and ignores lower ones, so after a restart every open tab would have shown no
  // collaborator's lock until it reloaded. `serverStartedAt` rides on every state answer so a tab can also tell a restart
  // (even a rollback to a build that counts from 0) and forget the old number.
  const serverStartedAt = Date.now();
  let lockRevision = serverStartedAt;
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
  // Re-serialising the 31 MB workspace on every render tick starved the event loop, so ticks stay in memory.
  const touch = () => { revision++; db.prepare('INSERT INTO workspace_revision(id,revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').run(revision); broadcast(); };
  // Writes only the entities that changed since the last save; see workspaceStore.ts.
  const persist = () => { const nextRevision = revision + 1; store.save(state, nextRevision); revision = nextRevision; broadcast(); };
  // Other writes and a persist() in one SQLite transaction. A rollback leaves the account cache stale, so it is dropped.
  const transaction = (work: () => void) => { try { store.transaction(work); } catch (error) { accountCache = undefined; throw error; } };
  const sounds = soundLibrary(dataDir); sounds.recover();
  const library = projectLibrary(db, () => state.projects, users, () => revision, write => transaction(() => { write(); persist(); }));
  const roleFor = library.projectRole;
  const visibleTo = (project: Project, userId: string) => Boolean(roleFor(project, userId));
  const uploadLocks = new Set<string>();
  // Last time an asset's transient progress was written. Each write once serialised the whole
  // workspace, which is what made a 253-clip upload decay; saves are per entity now, but every one
  // still sends every client to fetch state, so these callers keep their own five-second ration.
  const progressAt = new Map<string, number>();
  const resolveDir = (id:string) => join(dataDir,'resolve',id);
  const fcpDir = (id: string) => join(dataDir, 'fcp', id);
  const mediaDir = (id: string) => join(dataDir, 'media', id);
  const originalPath = (id: string) => join(mediaDir(id), 'original');
  const replacedVersion = (id: string) => { try { return readFileSync(join(mediaDir(id), 'replaced'), 'utf8'); } catch { return ''; } };
  // A deleted project, media included, stays restorable for a week before purgeExpiredProjects removes its files.
  const PROJECT_RECOVERY_MS = 7 * 86400_000;
  const minFreeGb = Number(process.env.FRAME_LINE_MIN_FREE_GB ?? 5), minFreeBytes = (Number.isFinite(minFreeGb) && minFreeGb >= 0 ? minFreeGb : 5) * 1024 ** 3;
  const freeBytes = () => { const disk = statfsSync(dataDir); return disk.bavail * disk.bsize; };
  const requireSpace = (bytes: number) => { const free = freeBytes(); if (free < bytes + minFreeBytes) fail(507, `The server is almost out of disk space (${(free / 1e9).toFixed(1)} GB free, ${(minFreeBytes / 1e9).toFixed(0)} GB kept in reserve). Free space on the server before uploading.`); };
  // Which project asked for each Smart Mask frame preview; the file name alone authorizes nothing.
  const maskPreviews = new Set<string>();
  const projectBundle = (project: Project) => {
    const timelines = state.timelines.filter(item => item.projectId === project.id), timelineIds = new Set(timelines.map(item => item.id));
    return { projects: [project], timelines, tracks: state.tracks.filter(item => timelineIds.has(item.timelineId)), ...Object.fromEntries(['media', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'].map(key => [key, (state[key as Collection] as Entry[]).filter(item => item.projectId === project.id)])) } as unknown as Record<Collection, Entry[]>;
  };
  const removeProject = (projectId: string) => {
    const timelineIds = new Set(state.timelines.filter(item => item.projectId === projectId).map(item => item.id));
    state = { ...state, projects: state.projects.filter(item => item.id !== projectId), timelines: state.timelines.filter(item => item.projectId !== projectId), tracks: state.tracks.filter(item => !timelineIds.has(item.timelineId)), ...Object.fromEntries(['media', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'].map(key => [key, (state[key as Collection] as Entry[]).filter(item => item.projectId !== projectId)])) };
  };
  const backupProject = (id: string, ownerId: string, expiresAt: number, backup: Record<Collection, Entry[]>) => db.prepare('INSERT INTO deleted_projects(id,ownerId,expiresAt,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ownerId=excluded.ownerId,expiresAt=excluded.expiresAt,data=excluded.data').run(id, ownerId, expiresAt, JSON.stringify(backup));
  const purgeExpiredProjects = () => {
    const rows = db.prepare('SELECT id,data FROM deleted_projects WHERE expiresAt<=?').all(Date.now()) as { id: string; data: string }[];
    // A file Windows holds open (antivirus, an indexer) must not crash the housekeeping timer or block startup; the row stays and is retried.
    for (const row of rows) try {
      const bundle = JSON.parse(row.data) as Record<Collection, Entry[]>;
      for (const asset of bundle.media ?? []) rmSync(mediaDir(asset.id), { recursive: true, force: true });
      for (const job of bundle.renderJobs ?? []) for (const extension of ['.mp4', '.mov']) rmSync(join(dataDir, 'renders', `${job.id}${extension}`), { force: true });
      db.prepare('DELETE FROM caption_jobs WHERE projectId=?').run(row.id);
      try { colorAssistant.purge(row.id); } catch { /* A still being served; its folder outlives the purge. */ }
      db.prepare('DELETE FROM deleted_projects WHERE id=?').run(row.id);
    } catch (error) { console.error(`Purging deleted project ${row.id} failed:`, error); }
  };
  // Every revision wakes every client into fetching state, so progress alone saves at most once a second
  // per asset; the latest value lands when the second is up, or sooner with any other change.
  const progressSaves = new Map<string, { at: number; patch?: Partial<Asset>; timer?: ReturnType<typeof setTimeout> }>();
  const updateAsset = (id: string, patch: Partial<Asset>) => {
    if (!state.media.some(asset => asset.id === id)) { clearTimeout(progressSaves.get(id)?.timer); progressSaves.delete(id); return; }
    const saved = progressSaves.get(id) ?? { at: 0 }; progressSaves.set(id, saved);
    if (!closed && Object.keys(patch).every(key => key === 'progress') && Date.now() - saved.at < 1000) {
      saved.patch = { ...saved.patch, ...patch };
      saved.timer ??= setTimeout(() => { saved.timer = undefined; if (saved.patch) try { updateAsset(id, {}); } catch (error) { console.error('Progress save failed:', error); } }, saved.at + 1000 - Date.now());
      return;
    }
    clearTimeout(saved.timer); saved.timer = undefined;
    const merged = { ...saved.patch, ...patch }; saved.patch = undefined; if ('progress' in merged) saved.at = Date.now();
    const previous = state.media; state.media = state.media.map(asset => asset.id === id ? { ...asset, ...merged } : asset);
    try { persist(); } catch (error) { state.media = previous; throw error; }
  };
  const flushProgress = () => { for (const [id, saved] of progressSaves) if (saved.patch) updateAsset(id, {}); };
  const updateJob = (id: string, patch: Partial<RenderJob>, save = true) => { if (!state.renderJobs.some(job => job.id === id)) return; const previous = state.renderJobs; state.renderJobs = state.renderJobs.map(job => job.id === id ? { ...job, ...patch } : job); try { if (save) persist(); else touch(); } catch (error) { state.renderJobs = previous; throw error; } };
  // Each queued or running job and its id (`camera-<asset>`, `filmstrip-<asset>`… for an asset's side jobs).
  const queued = new Map<Promise<void>, string>();
  /** Settles once every job of this asset has ended; the startup migration's chain never holds it up, unlike queue.drain. */
  const assetJobs = (id: string) => Promise.all([...queued].filter(([, key]) => key === id || key.endsWith(`-${id}`)).map(([job]) => job));
  // `done` runs however the job ends, including cancelled before it started. `prepare` waits outside the queue first.
  // Previews, filmstrips and waveforms are the work the host guard stops first when memory runs out: while one of them runs,
  // its abort is on the guard's list (the abort reaches its FFmpeg tree through the job's signal).
  const victimKind = (id: string) => VICTIM_ORDER.find(kind => id.startsWith(`${kind}-`));
  const addWork = (id: string, work: (signal: AbortSignal) => Promise<void>, render = false, done?: () => void, prepare?: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController(); aborters.set(id, controller);
    let ended!: () => void; const job = new Promise<void>(resolve => { ended = resolve; }); queued.set(job, id);
    const kind = victimKind(id);
    queue.add(async () => { let forget: (() => void) | undefined;
      try { if (!closed && !controller.signal.aborted) { forget = kind ? guard.registerVictim(kind, () => controller.abort()) : undefined; await work(controller.signal); } }
      finally { forget?.(); if (aborters.get(id) === controller) aborters.delete(id); queued.delete(job); ended(); done?.(); } }, render, prepare && (() => prepare(controller.signal)));
  };
  // Playback reports ride on presence posts: one browser's allowance is a report every 5 s, and nothing here may break editing.
  const reports = createPlaybackReports({ dir: join(dataDir, 'playback-reports'), onError: (message, error) => console.error(message, error) });
  const REPORT_GAP_MS = 5_000, REPORT_KEPT_MS = 60_000, MAX_REPORT_CLIENTS = 256, REPORT_FLUSH_MS = 60_000, REPORT_PRUNE_MS = 3_600_000;
  const lastReportAt = new Map<string, number>();
  const takeReport = (identity: Identity, block: unknown) => {
    if (block === undefined) return;
    try {
      const now = Date.now(), key = `${identity.userId}\u0000${identity.clientId}`, last = lastReportAt.get(key);
      if (last !== undefined && now - last < REPORT_GAP_MS) return;
      lastReportAt.delete(key); lastReportAt.set(key, now);
      if (lastReportAt.size > MAX_REPORT_CLIENTS) lastReportAt.delete(lastReportAt.keys().next().value!);
      reports.ingest(identity, block, now);
    } catch (error) { console.warn('A playback report was dropped:', error); }
  };
  // Once a minute the finished minutes go to today's file and silent browsers' allowances are forgotten; once an hour files
  // older than 14 days go. Neither can throw.
  let reportsFlushedAt = 0, reportsPrunedAt = 0;
  const reportsTick = (now: number) => {
    for (const [key, at] of lastReportAt) if (now - at > REPORT_KEPT_MS) lastReportAt.delete(key);
    if (now - reportsFlushedAt >= REPORT_FLUSH_MS) { reportsFlushedAt = now; void reports.flushMinute(now); }
    if (now - reportsPrunedAt >= REPORT_PRUNE_MS) { reportsPrunedAt = now; void reports.prune(now); }
  };
  // One line every 30 s in data/host-health.log: memory, commit headroom, power, GPU, event-loop lag, queues, live children.
  const hostHealth = createHostHealthLog({
    path: join(dataDir, 'host-health.log'), sample: () => guard.sample(), children: liveChildren,
    queues: () => { const held = guard.snapshot(); return { jobs: aborters.size, exportsWaiting: state.renderJobs.filter(job => job.status === 'waiting').length, exportsRendering: state.renderJobs.filter(job => job.status === 'rendering').length, guardWaiting: held.queued, guardRunning: held.running, previews: held.previewsRunning }; },
    onError: error => console.error('Host health log failed:', error),
  });
  if (options.hostMonitor) hostHealth.start();
  /** What the Health page shows of the host: the guard's own counts plus the last health-log line, with waiting exports counted as queued. */
  const hostSnapshot = (): HostHealth => {
    const held = guard.snapshot(), line = hostHealth.latest();
    return { ...held, at: Date.now(), queued: held.queued + state.renderJobs.filter(job => job.status === 'waiting').length, pagesPerSec: line?.pagesPerSec ?? null, eventLoopLagMs: line?.eventLoopLagMs ?? null, onBattery: line?.onBattery ?? null, gpuMemUsedGB: line?.gpuMemUsedGB ?? null, gpuTempC: line?.gpuTempC ?? null };
  };
  const onlineIdentities = (): Identity[] => [...presence.keys()].flatMap(key => {
    const [projectId, userId, , clientId] = JSON.parse(key) as string[];
    return [{ userId, name: accountById(userId)?.user.name ?? '', clientId, projectId }];
  });
  // A preview never waits for memory: it is refused, and the browser backs off. One log line a minute says why.
  const REFUSAL_LOG_MS = 60_000;
  let refusalLoggedAt = 0;
  const admitPreview = (): PreviewAdmission => {
    const admission = guard.tryAdmit({ kind: 'preview', costBytes: JOB_COST_BYTES.previewPass, label: 'timeline preview' });
    if (!admission.ok && Date.now() - refusalLoggedAt >= REFUSAL_LOG_MS) { refusalLoggedAt = Date.now(); console.warn(`Timeline preview refused: ${admission.reason}`); }
    return admission;
  };
  /** An export's depth runs (Depth clips' and depth keys'), awaited (and held, until `releases` run) before the export joins the render queue:
   *  waiting there for minutes would hold every other export and all media preparation. A run that fails fails the export here,
   *  at once: the render would only start the whole analysis again inside the queue. */
  const awaitDepth = async (job: RenderJob, snapshot: Omit<Parameters<typeof renderTimeline>[0], 'outputPath'>, signal: AbortSignal, releases: (() => void)[]) => {
    const requests = depthRuns(snapshot);
    if (!requests.length) return;
    const percents = requests.map(() => 0); let shown = -1;
    const show = () => { const value = Math.floor(percents.reduce((a, b) => a + b, 0) / percents.length); if (value !== shown && !closed && !signal.aborted) { shown = value; updateJob(job.id, { remaining: `Waiting for depth analysis · ${value}%` }, false); } };
    show();
    const results = await Promise.allSettled(requests.map((request, i) => depth.ready(request, signal, p => { percents[i] = p; show(); })));
    for (const result of results) if (result.status === 'fulfilled') releases.push(result.value.release);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (!failure || signal.aborted || closed) return;
    updateJob(job.id, { status: 'failed', remaining: 'Export failed', error: (failure.reason as Error)?.message || 'Depth analysis failed.' });
    db.prepare('DELETE FROM render_snapshots WHERE id=?').run(job.id);
    aborters.get(job.id)?.abort();
  };
  // No depth service: a preview never reads depth (readsDepth skips those ranges), and must never start a run for a viewer.
  // One log line per new preview job names who asked. The host guard refuses a preview while memory is short (429, the browser backs off).
  // Live state, not a copy: the caches keep only what can reach the range and copy just that (the media rows alone
  // were 6.6 MB a poll), then ask for it again every second per chunk.
  const previewSnapshot=(project:Project,timeline:typeof state.timelines[number],settings:Record<string,string>)=>{
    const clips=state.clips.filter(c=>c.projectId===project.id),ids=new Set(clips.map(c=>c.mediaId));
    return {project,timeline,timelines:state.timelines.filter(t=>t.projectId===project.id),clips,tracks:state.tracks.filter(t=>state.timelines.some(tl=>tl.id===t.timelineId&&tl.projectId===project.id)),nodes:state.nodes.filter(n=>n.projectId===project.id),assets:state.media.filter(m=>m.projectId===project.id&&ids.has(m.id)).map(asset=>({asset,path:originalPath(asset.id)})),settings,smartMaskDir:join(dataDir,'smart-masks'),stabilizeDir:stabilizeDirectory,resolveDir:resolveDir(project.id)};
  };
  const stills=createStillCache(join(dataDir,'frames'),request=>renderTimeline({...request,overlayPath:id=>overlays.path(id)}),{log:line=>console.warn(line),admit:admitPreview});
  const timelinePreviews=createPreviewCache(join(dataDir,'timeline-previews'),(id,work)=>addWork(id,work),request=>renderTimeline({...request,overlayPath:id=>overlays.path(id)} ),{log:line=>console.warn(line),admit:admitPreview});
  /** Seconds an export spends in each stage ("Stabilizing", "Optical flow", "Rendering video"...), logged when it ends,
   *  so a slow export says where its time went. The 78-minute Girls Soccer export could only be explained afterwards. */
  const stageClock = (started: number) => {
    const spent = new Map<string, number>(); let current = 'Preparing export', since = started;
    const close = () => { const key = current.split(' · ')[0]; spent.set(key, (spent.get(key) ?? 0) + Date.now() - since); since = Date.now(); };
    return { enter: (next: string) => { close(); current = next; }, summary: () => { close(); return [...spent].map(([key, ms]) => `${key} ${Math.round(ms / 1000)} s`).join(', '); } };
  };
  const startRender = (job: RenderJob, snapshot: Omit<Parameters<typeof renderTimeline>[0], 'outputPath'>) => {
    db.prepare('INSERT OR REPLACE INTO render_snapshots(id,data) VALUES(?,?)').run(job.id, JSON.stringify(snapshot));
    const releases: (() => void)[] = [];
    addWork(job.id, async signal => {
            updateJob(job.id, { status: 'rendering', progress: 0, remaining: 'Preparing export · 0s elapsed' }); const extension = job.settings.codec?.includes('ProRes') ? '.mov' : '.mp4'; const outputPath = join(dataDir, 'renders', `${job.id}${extension}`);
            const started = Date.now(), clock = stageClock(started); let progressValue = 0, stage = 'Preparing export', advancedAt = started, reportedAt = 0;
            const logTimes = (outcome: string) => console.log(`Export ${job.id} (${job.name}) ${outcome} after ${Math.round((Date.now() - started) / 1000)} s: ${clock.summary()}`);
            // At most one progress revision a second: each one sends every client to fetch state.
            const report = () => { if (closed || signal.aborted || Date.now() - reportedAt < 1000) return; const elapsed = Math.floor((Date.now() - started) / 1000);
              reportedAt = Date.now();
              const quiet = Math.floor((Date.now() - advancedAt) / 1000);
              updateJob(job.id, { progress: progressValue, remaining: `${stage} · ${elapsed}s elapsed${quiet >= 30 ? ` · No new frames for ${quiet}s` : ''}` }, false); };
            const heartbeat = setInterval(report, 250);
            try { let previous = -1; await renderTimeline({ ...snapshot, depth, smartMaskDir:join(dataDir, 'smart-masks'), stabilizeDir:stabilizeDirectory, resolveDir:resolveDir(job.projectId), overlayPath: id => overlays.path(id), outputPath, signal, onStage: next => { if (stage !== next) { clock.enter(next); stage = next; advancedAt = Date.now(); report(); } }, onProgress: progress => { if (progress > previous) advancedAt = Date.now(); previous = progress; progressValue = Math.max(progressValue, Math.min(99, Math.floor(progress))); report(); } }); if (!signal.aborted) updateJob(job.id, { status: 'complete', progress: 100, remaining: 'Complete', outputUrl: `/api/renders/${job.id}/download` }); logTimes('finished'); }
            catch (error) { logTimes(signal.aborted ? 'cancelled' : 'failed'); rmSync(outputPath, { force: true }); if (!closed) updateJob(job.id, { status: 'failed', remaining: signal.aborted ? 'Cancelled' : 'Export failed', error: signal.aborted ? 'Cancelled by user.' : error instanceof Error ? error.message : 'Export failed.' }); }
            finally { clearInterval(heartbeat); if (!closed) db.prepare('DELETE FROM render_snapshots WHERE id=?').run(job.id); }
    }, true, () => { for (const release of releases) release(); }, signal => awaitDepth(job, snapshot, signal, releases));
  };

  const processAsset = (id: string, refresh = false) => addWork(id, async signal => {
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
      // Prepared files are served immutable and footage caches key on the URL, so any re-prepare (a refresh, a Retry: an
      // encoder upgrade or another host changes the bytes) needs new URLs or browsers mix old pieces with new ones.
      // A replaced original keeps its replacement's version on its own URL from then on.
      const replaced = replacedVersion(id), version = refresh || asset.proxyUrl ? `?v=${Date.now().toString(36)}` : replaced, bust = (url?: string) => url && version ? url + version : url;
      const publish = (result: Awaited<ReturnType<typeof probeMedia>> & Partial<Omit<Asset, 'size'>>) => {
        const { size, ...fresh } = result;
        const metadata: typeof fresh = { ...fresh };
        if (version) {
          for (const key of ['proxyUrl', 'thumbnail', 'audioProxyUrl', 'colorProxyUrl', 'filmstrip'] as const) if (metadata[key]) metadata[key] = bust(metadata[key])!;
          if (metadata.proxyVariants) metadata.proxyVariants = Object.fromEntries(Object.entries(metadata.proxyVariants).map(([k, url]) => [k, bust(url)!]));
        }
        updateAsset(id, { ...metadata, ...(asset.importLink ? { thumbnail: state.media.find(item => item.id === id)?.thumbnail || metadata.thumbnail } : {}), size: size >= 1e9 ? `${(size / 1e9).toFixed(1)} GB` : `${(size / 1e6).toFixed(1)} MB`, sourceUrl: `/api/media/${id}/original${replaced}`, status: 'ready', progress: 100 });
      };
      const result = await prepareMedia({ inputPath: originalPath(id), outputDir: join(mediaDir(id), 'prepared'), baseUrl: `/api/media/${id}/files`, signal, refresh,
        onStage: preparationStage => { if (!signal.aborted) updateAsset(id, { preparationStage }); },
        onPlayable: result => { if (!signal.aborted) publish(result); },
        onThumbnail: thumbnail => { if (!asset.importLink) updateAsset(id, { thumbnail: bust(thumbnail) }); },
        onProgress: progress => { const next = Math.floor(progress); if (state.media.find(item => item.id === id)?.status !== 'ready' && next !== previous && Date.now() - (progressAt.get(id) ?? 0) >= 5000) { previous = next; progressAt.set(id, Date.now()); updateAsset(id, { progress: next }); } }
      });
      if (!signal.aborted) {
        publish(result); updateAsset(id, { preparationStage: undefined, error: undefined });
        // A re-prepared older import writes the v3 set; what it replaces goes now rather than at the next start.
        const prepared = state.media.find(item => item.id === id);
        if (prepared) await removeLeftovers(prepared, join(mediaDir(id), 'prepared'));
      }
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
  // Entities the server already holds arrive as its own frozen objects (a delta leaves them alone; a PUT
  // gets them back through shareState). They were validated when accepted, so only new ones are checked.
  const holds = (key: string) => (item: unknown) => store.holds(key, item);
  function validateCollection(items: unknown, key: string, known?: (item: Entry) => boolean) {
    if (!Array.isArray(items) || items.length > 100_000) fail(400, `Invalid ${key} collection.`);
    const ids = new Set<string>();
    for (const item of items as Entry[]) {
      if (known?.(item)) { if (ids.has(item.id)) fail(400, `Invalid or duplicate ${key} ID.`); ids.add(item.id); continue; }
      object(item); if (!idIsValid(item.id) || ids.has(item.id)) fail(400, `Invalid or duplicate ${key} ID.`); ids.add(item.id);
      for (const [field, type] of Object.entries(schemas[key])) {
        if (type === 'array' ? !Array.isArray(item[field]) : type === 'object' ? !item[field] || typeof item[field] !== 'object' || Array.isArray(item[field]) : typeof item[field] !== type) fail(400, `Invalid ${key}.${field}.`);
        if (type === 'number') numberField(item[field], -1e15, 1e15);
      }
      if (key === 'projects' && item.classRole !== undefined && !['Viewer', 'Editor'].includes(item.classRole)) fail(400, 'Invalid class role.');
      // Bin ids are what media binId holds, so they follow the media endpoint's rule for one.
      if (key === 'projects' && item.bins !== undefined) { if (!Array.isArray(item.bins) || item.bins.length > 500) fail(400, 'Invalid bins.'); const seen = new Set(); for (const bin of item.bins) { object(bin); if (typeof bin.id !== 'string' || !BIN_ID.test(bin.id) || seen.has(bin.id)) fail(400, 'Invalid bin ID.'); seen.add(bin.id); textField(bin.name, 80, true); } }
      if (item.name !== undefined) textField(item.name, 255, true);
      for (const field of ['duration', 'start', 'sourceIn', 'time']) if (item[field] !== undefined) numberField(item[field], 0, 86400 * 7);
      if (key === 'tracks' && item.captionSets!==undefined) {try{validateCaptionSets(item.captionSets);}catch(error){fail(400,(error as Error).message);}}
      if (key === 'timelines' && item.composition!==undefined && typeof item.composition!=='boolean') fail(400,'Invalid composition timeline.');
      if (key === 'timelines' && item.markers !== undefined) {
        if (!Array.isArray(item.markers) || item.markers.length > 10_000) fail(400, 'Invalid timeline markers.');
        for (const marker of item.markers) { object(marker); if (marker.id !== undefined && !idIsValid(marker.id)) fail(400, 'Invalid marker ID.'); numberField(marker.time, 0, 86400 * 7); textField(marker.name, 255); textField(marker.color, 64); if (marker.note !== undefined) textField(marker.note, 5000); }
      }
      if (key === 'comments' && item.timelineId !== undefined && !idIsValid(item.timelineId)) fail(400, 'Invalid comment timeline.');
      if (key === 'clips') { try { validateTransition(item as any); validateMotionBlur(item as any); } catch (error) { fail(400, (error as Error).message); } if (isLeakMedia(String(item.mediaId)) && !leakIdOf(String(item.mediaId))) fail(400, 'Invalid overlay reference.'); if(isShape(item as any)){try{validateShape(JSON.parse(String(item.properties.shapeDocument)));}catch{fail(400,'Invalid shape document.');}} if(item.keyframes!==undefined) {try {validateKeyframes(item.keyframes);} catch(error){fail(400,(error as Error).message);}} if(item.motionTrackers!==undefined){try{validateMotionTrackers(item as any);}catch(error){fail(400,(error as Error).message);}} if (isTitle(item as any)) { try { if(isCaption(item as any)&&!getText(item as any).caption)throw new Error('Missing caption data');validateText(getText(item as any)); } catch { fail(400, 'Invalid text document.'); } } if (!item.duration) fail(400, 'Clips must have a positive duration.'); for (const value of Object.values(item.properties)) if (!['string', 'number', 'boolean'].includes(typeof value)) fail(400, 'Invalid clip property.'); for (const effect of item.effects) { object(effect); if (!idIsValid(effect.id) || typeof effect.enabled !== 'boolean') fail(400, 'Invalid effect.'); textField(effect.name, 80, true); numberField(effect.amount, 0, 100); if (effect.parameters !== undefined) { object(effect.parameters); for (const value of Object.values(effect.parameters)) numberField(value); } } }
      if (key === 'tracks') { if (!['video', 'audio'].includes(item.kind)) fail(400, 'Invalid track kind.'); numberField(item.number, 0, 1024); numberField(item.gain, -120, 60); numberField(item.pan, -100, 100); if (item.height !== undefined) numberField(item.height, 24, 200); }
      if (key === 'nodes') {for (const value of Object.values(item.parameters)) numberField(value);try{validateGradeNode(item);}catch(error){fail(400,(error as Error).message);}}
      if (key === 'comments') { textField(item.text, 5000, true); if (item.range !== undefined && (!Array.isArray(item.range) || item.range.length !== 2 || item.range.some((value: unknown) => typeof value !== 'number' || value < 0))) fail(400, 'Invalid comment range.'); for (const reply of item.replies) { object(reply); if (!idIsValid(reply.id) || !idIsValid(reply.userId)) fail(400, 'Invalid reply.'); textField(reply.text, 5000, true); numberField(reply.timestamp, 0, 1e15); } }
      if (key === 'operations' && item.gestureId !== undefined) textField(item.gestureId, 128, true);
      if (key === 'operations') for (const change of [...item.oldState, ...item.newState]) { object(change); if (!['clips', 'tracks', 'nodes', 'comments', 'timelines'].includes(change.collection) || !idIsValid(change.id) || (change.value !== null && (!change.value || typeof change.value !== 'object' || Array.isArray(change.value)))) fail(400, 'Invalid history change.'); if (change.unset !== undefined && (!Array.isArray(change.unset) || change.unset.some((value: unknown) => typeof value !== 'string'))) fail(400, 'Invalid history field.'); }
      if (key === 'snapshots') for (const collection of ['clips', 'tracks', 'nodes', 'comments', ...(item.state.timelines?['timelines']:[])]) validateCollection(item.state[collection], collection);
    }
  }
  // A saved snapshot's relations depend on its own frozen content plus the timelines' and media's ids,
  // projects and composition flags; one that passed against the same of those still passes.
  let snapshotsChecked = { against: '', valid: new WeakSet<object>() };
  function validateRelations(next: PersistedState) {
    const projects = new Set(next.projects.map(project => project.id)); const timelines = new Map(next.timelines.map(item => [item.id, item.projectId])); const tracks = new Map(next.tracks.map(item => [item.id, item.timelineId])); const media = new Map(next.media.map(item => [item.id, item.projectId]));
    // While no stored project is removed, an entity the server already holds still has its project.
    const shrunk = (store.stored('projects') as Project[]).some(project => !projects.has(project.id));
    for (const key of ['media', 'timelines', 'clips', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'] as const) {
      if (!shrunk && next[key] === store.stored(key)) continue;
      for (const item of next[key]) if ((shrunk || !store.holds(key, item)) && !projects.has(item.projectId)) fail(400, 'An item references a missing project.');
    }
    for (const track of next.tracks) if (!timelines.has(track.timelineId)) fail(400, 'A track references a missing timeline.');
    const check = (document: PersistedState | PersistedState['snapshots'][number]['state'], projectId?: string, bound?: Set<string>) => {
      const localTimelines=new Map((document.timelines??next.timelines).map(t=>[t.id,t.projectId]));
      const localTracks = new Map(document.tracks.map(item => [item.id, item.timelineId])); const clips = new Map(document.clips.map(item => [item.id, item.projectId]));
      for (const clip of document.clips) if ((projectId && clip.projectId !== projectId) || localTimelines.get(clip.timelineId) !== clip.projectId || localTracks.get(clip.trackId) !== clip.timelineId || (!isTitle(clip) && !isShape(clip) && !isComposition(clip) && !isAdjustment(clip) && !isLeakMedia(clip.mediaId) && media.get(clip.mediaId) !== clip.projectId)) fail(400, 'A clip references missing or inaccessible media, track, or timeline.');
      for (const node of document.nodes) if ((projectId && node.projectId !== projectId) || clips.get(node.clipId) !== node.projectId) fail(400, 'A grade references a missing clip.');
      // A mask binding involves one clip and its own grades; `bound` limits the check to clips whose side changed.
      const grades = new Map<string, typeof document.nodes>(); for (const node of document.nodes) { let list = grades.get(node.clipId); if (!list) grades.set(node.clipId, list = []); list.push(node); }
      try { for (const clip of document.clips) if (!bound || bound.has(clip.id)) validateSmartMaskBindings(clip, grades.get(clip.id) ?? []); } catch (error) { fail(400, (error as Error).message); }
      for (const comment of document.comments) if ((projectId && comment.projectId !== projectId) || (comment.clipId && clips.get(comment.clipId) !== comment.projectId)) fail(400, 'A comment references a missing clip.');
      try{validateCompositions(document.clips,document.timelines??next.timelines);}catch(error){fail(400,(error as Error).message);}
      if(projectId&&document.timelines?.some(t=>t.projectId!==projectId))fail(400,'A snapshot references another project.');
      if (projectId) for (const track of document.tracks) if (localTimelines.get(track.timelineId) !== projectId) fail(400, 'A snapshot references another project.');
    };
    check(next, undefined, new Set([...next.clips.filter(clip => !store.holds('clips', clip)).map(clip => clip.id), ...next.nodes.filter(node => !store.holds('nodes', node)).map(node => node.clipId)]));
    const against = JSON.stringify([next.timelines.map(t => [t.id, t.projectId, t.composition ?? null]), next.media.map(m => [m.id, m.projectId])]);
    if (snapshotsChecked.against !== against) snapshotsChecked = { against, valid: new WeakSet() };
    for (const snapshot of next.snapshots) if (!snapshotsChecked.valid.has(snapshot)) { check(snapshot.state, snapshot.projectId); snapshotsChecked.valid.add(snapshot); }
  }
  function putState(body: Entry, account: Account, delta?: { base: PersistedState }) {
    if (!Number.isSafeInteger(body.revision)) fail(400, 'A revision is required.');
    if (body.revision !== revision) return false;
    object(body.state); const userId = account.user.id, currentView = delta?.base ?? view(account).state;
    // A PATCH already carries the server's own objects for everything its delta left alone.
    let incoming = body.state as PersistedState; if (!delta) try { incoming = shareState(currentView, incoming); } catch { /* malformed; validation below rejects it */ }
    const untouched = (key: keyof PersistedState) => incoming[key] === currentView[key];
    if (incoming.currentUserId !== userId || !same(incoming.users, currentView.users)) fail(403, 'Account identities cannot be changed through project state.');
    for (const key of Object.keys(schemas) as Collection[]) if (!untouched(key)) validateCollection(incoming[key], key, holds(key));
    if (!same(incoming.media, currentView.media) || !same(incoming.renderJobs, currentView.renderJobs)) fail(400, 'Use the media and render endpoints to change files and jobs.');
    object(incoming.settings); for (const value of Object.values(incoming.settings)) if (!['string', 'number', 'boolean'].includes(typeof value)) fail(400, 'Invalid setting.');
    const existing = new Map(state.projects.map(project => [project.id, project])); const allowed = new Set(currentView.projects.map(project => project.id)); const nextProjectIds = new Set(incoming.projects.map(project => project.id));
    const projects = incoming.projects.map(project => {
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
      // The view's copy carries every account's effective role; the stored project keeps its own list.
      const kept = { ...project, members: old?.members ?? [{ userId, role: 'Owner' as const }] };
      return old && same(kept, old) ? old : kept;
    });
    for (const project of currentView.projects) if (!nextProjectIds.has(project.id) && roleFor(existing.get(project.id)!, userId) !== 'Owner') fail(403, 'Only the owner can delete a project.');
    const removedProject = currentView.projects.some(project => !nextProjectIds.has(project.id));
    const next = { ...state }; next.projects = mergeVisible(state.projects, project => !allowed.has(project.id), projects);
    const oldTimelines = new Map(state.timelines.map(item => [item.id, item.projectId])); const newTimelines = new Map(incoming.timelines.map(item => [item.id, item.projectId]));
    for (const key of ['timelines', 'clips', 'tracks', 'nodes', 'comments', 'operations', 'snapshots'] as const) {
      const oldItems = state[key] as unknown as Entry[]; const newItems = incoming[key] as unknown as Entry[];
      // A list the save left alone is the server's own: nothing to check, nothing to merge.
      if (untouched(key) && !removedProject) continue;
      const itemProject = (item: Entry, fresh: boolean) => key === 'tracks' ? (fresh ? newTimelines : oldTimelines).get(item.timelineId) : item.projectId;
      // A held entity is the server's unchanged object; only its project still needs to exist. Tracks are
      // excluded: a held track changes project when its timeline does.
      const known = key === 'tracks' ? undefined : holds(key);
      let oldById: Map<unknown, Entry> | undefined, held = 0;
      for (const item of newItems) {
        const projectId = itemProject(item, true); if (!projectId || !nextProjectIds.has(projectId)) fail(403, 'An item references an inaccessible project.');
        if (known?.(item)) { held++; continue; }
        const oldItem = (oldById ??= new Map(oldItems.map(entry => [entry.id, entry]))).get(item.id); if (oldItem && itemProject(oldItem, false) !== projectId) fail(403, 'Items cannot be moved between projects.');
        if (!same(oldItem, item)) {
          const project = existing.get(projectId); const role = project ? roleFor(project, userId) : 'Owner';
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
      const hidden = (item: Entry) => !allowed.has(itemProject(item, false));
      let visible = 0, hiddenCount = 0;
      for (const oldItem of oldItems) { const projectId = itemProject(oldItem, false); if (!allowed.has(projectId)) hiddenCount++; else if (nextProjectIds.has(projectId)) visible++; }
      // Nothing was deleted when every entity the caller could see came back as the same object.
      if (held !== visible) {
        const newIds = new Set(newItems.map(item => item.id));
        for (const oldItem of oldItems) if (allowed.has(itemProject(oldItem, false)) && nextProjectIds.has(itemProject(oldItem, false)) && !newIds.has(oldItem.id)) {
          if (key === 'operations') fail(403, 'History cannot be deleted.');
          const role = roleFor(existing.get(itemProject(oldItem, false))!, userId); if (!['Owner', 'Editor'].includes(role ?? '') && !(role === 'Commenter' && key === 'comments' && oldItem.userId === userId)) fail(403, 'Deleting this item is not allowed.');
          if ([...locks.values()].some(lock => lock.targetId === oldItem.id && lock.projectId === itemProject(oldItem, false) && lock.userId !== userId && lock.expiresAt > Date.now())) fail(423, 'A collaborator has locked this item.');
        }
      }
      (next as unknown as Entry)[key] = hiddenCount ? mergeVisible(oldItems, hidden, newItems) : newItems;
    }
    const deleted = new Set([...allowed].filter(id => !nextProjectIds.has(id)));
    if (deleted.size) { next.media = state.media.filter(item => !deleted.has(item.projectId)); next.renderJobs = state.renderJobs.filter(item => !deleted.has(item.projectId)); }
    validateRelations(next);
    // A project deleted by a save is restorable like one deleted through DELETE /api/projects/:id; its files go when the backup expires.
    const backups = [...deleted].map(id => [id, projectBundle(existing.get(id)!)] as const), expiresAt = Date.now() + PROJECT_RECOVERY_MS;
    const previousState = state; const previousRevision = revision; const previousSettings = account.settings;
    const settings = { ...DEFAULT_SETTINGS, ...incoming.settings };
    try { transaction(() => { if (!same(settings, account.settings)) { account.settings = settings; saveAccount(account); } for (const [id, backup] of backups) backupProject(id, userId, expiresAt, backup); state = next; persist(); }); }
    catch (error) { state = previousState; revision = previousRevision; account.settings = previousSettings; throw error; }
    for (const [id, backup] of backups) { timelinePreviews.cancelProject(id); for (const item of [...backup.media, ...backup.renderJobs]) aborters.get(item.id)?.abort(); }
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
      if (path === '/api/health' && method === 'GET') {
        let database = true, free = -1; try { db.prepare('SELECT 1').get(); } catch { database = false; } try { free = freeBytes(); } catch { /* Unknown disk: report it, do not fail on it. */ }
        const status = !database ? 'database unavailable' : free >= 0 && free < minFreeBytes ? 'low disk space' : 'ok';
        const capabilities = await getMediaCapabilities(); send(res, status === 'ok' ? 200 : 503, { status, ffmpeg: capabilities.available, captions: captionAvailable(), freeBytes: free, minFreeBytes }); return;
      }
      if (path === '/api/uploads/info' && method === 'GET') { requireAccount(req); const address = server.address(); send(res, 200, { localUrl: `http://localhost:${typeof address === 'object' && address ? address.port : 4310}`, maxUploadBytes }); return; }
      if (path === '/api/auth/me' && method === 'GET') { send(res, 200, { user: authenticated(req)?.user ?? null, registrationRequiresCode: Boolean(process.env.FRAME_LINE_SIGNUP_CODE) }); return; }
      if (['/api/auth/signup', '/api/auth/login'].includes(path) && method === 'POST') {
        const body = await jsonBody(req, 16 * 1024); const email = textField(body.email, 254, true).trim().toLowerCase(); const password = textField(body.password, 1024, true);
        // Keyed by the real client and the email: a stranger hammering an account only locks themselves out.
        const address = clientAddress(req); const now = Date.now(); const networkKey = `network:${address}`; let networkAttempts = authAttempts.get(networkKey);
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
              try { asset = sounds.importAsset(id, project.id, mediaId, mediaDir(mediaId)); state.media = [asset, ...state.media]; persist(); }
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
          const id = overlayRoute[1], leak = overlays.list().find(item => item.id === id) ?? fail(404, 'Overlay not found.');
          // Only the uploader removes an overlay; the original pack has no uploader. Neither goes while any clip, saved or in a snapshot, uses it.
          if (leak.addedBy && leak.addedBy !== userId) fail(403, 'Only the person who uploaded this overlay can delete it.');
          const uses = (clip: Entry) => leakIdOf(String(clip.mediaId)) === id || Object.values(clip.properties ?? {}).some(value => typeof value === 'string' && value.includes(`"leak":${JSON.stringify(id)}`));
          // Projects in Recently deleted count too: a restore must find its overlays.
          const restorable = (db.prepare('SELECT data FROM deleted_projects WHERE expiresAt>?').all(Date.now()) as { data: string }[]).map(row => JSON.parse(row.data) as { clips?: Entry[]; snapshots?: Entry[] });
          const usedBy = (bundle: { clips?: Entry[]; snapshots?: Entry[] }) => (bundle.clips ?? []).some(uses) || (bundle.snapshots ?? []).some(snapshot => snapshot.state.clips.some(uses));
          if (usedBy(state as unknown as Entry) || restorable.some(usedBy)) fail(409, 'A project still uses this overlay (one in Recently deleted included). Remove it from those clips first.');
          if (!overlays.remove(id)) fail(404, 'Overlay not found.');
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
          sendState(res, 200, stateView(account, url.searchParams.get('delta') === '1' ? Number(url.searchParams.get('since')) : undefined)); return;
        }
        if (path === '/api/state' && method === 'PATCH') {
          const body = await jsonBody(req);
          if (!Number.isSafeInteger(body.revision)) fail(400, 'A revision is required.');
          if (body.revision !== revision) { sendState(res, 409, stateView(account, body.revision)); return; }
          // One view before and one after: each is a full pass over the workspace.
          const before = view(account).state;
          let incoming: PersistedState;
          try { incoming = applyStateDelta(before, body.delta); } catch { fail(400, 'Invalid state delta.'); }
          putState({ revision: body.revision, state: incoming! }, account, { base: before });
          const { state: current, ...ephemeral } = rememberView(account);
          // A list saved exactly as sent is the same entities in a new array; hand the delta the sent array so it skips it.
          const aligned = Object.fromEntries(Object.entries(current).map(([key, list]) => { const sent = (incoming! as unknown as Entry)[key]; return [key, Array.isArray(list) && Array.isArray(sent) && list.length === sent.length && list.every((item, i) => item === sent[i]) ? sent : list]; })) as unknown as PersistedState;
          send(res, 200, { ...ephemeral, baseRevision: body.revision, delta: stateDelta(incoming!, aligned) }); return;
        }
        if (path === '/api/state' && method === 'PUT') { const saved = putState(await jsonBody(req), account); sendState(res, saved ? 200 : 409, view(account)); return; }
        // The owner's own deleted projects that can still be restored, newest first.
        if (path === '/api/projects/deleted' && method === 'GET') {
          const rows = db.prepare('SELECT id,expiresAt,data FROM deleted_projects WHERE ownerId=? AND expiresAt>? ORDER BY expiresAt DESC').all(userId, Date.now()) as { id: string; expiresAt: number; data: string }[];
          send(res, 200, { projects: rows.map(row => ({ id: row.id, name: (JSON.parse(row.data) as { projects?: Project[] }).projects?.[0]?.name ?? row.id, expiresAt: row.expiresAt })) }); return;
        }
        const restoreProjectRoute = /^\/api\/projects\/([a-zA-Z0-9_-]+)\/restore$/.exec(path);
        if (restoreProjectRoute && method === 'POST') {
          const row = db.prepare('SELECT ownerId,expiresAt,data FROM deleted_projects WHERE id=?').get(restoreProjectRoute[1]) as { ownerId: string; expiresAt: number; data: string } | undefined;
          if (!row || row.ownerId !== userId || row.expiresAt <= Date.now()) fail(404, 'That project backup has expired.');
          const bundle = JSON.parse(row!.data) as Record<Collection, Entry[]>;
          if (state.projects.some(project => project.id === restoreProjectRoute[1])) fail(409, 'A project with that ID already exists.');
          // Deleting cancelled whatever was still processing or exporting; it comes back retryable, not stuck.
          bundle.media = (bundle.media ?? []).map(asset => ['ready', 'failed', 'uploading'].includes(asset.status) ? asset : { ...asset, status: 'failed', error: 'Processing was interrupted. Retry to continue from the saved original.' });
          bundle.renderJobs = (bundle.renderJobs ?? []).map(job => ['waiting', 'rendering'].includes(job.status) ? { ...job, status: 'failed', remaining: 'Cancelled', error: 'The project was deleted during this export. Submit it again.' } : job);
          const previous = state, previousRevision = revision;
          try {
            transaction(() => {
              state = { ...state, ...Object.fromEntries(COLLECTIONS.map(key => [key, [...state[key], ...bundle[key]]])) };
              validateRelations(state); persist(); db.prepare('DELETE FROM deleted_projects WHERE id=?').run(restoreProjectRoute[1]);
            });
          } catch (error) { state = previous; revision = previousRevision; throw error; }
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
          const backup = projectBundle(project), expiresAt = Date.now() + PROJECT_RECOVERY_MS, previous = state, previousRevision = revision;
          timelinePreviews.cancelProject(project.id);
          for (const item of [...backup.media, ...backup.renderJobs]) aborters.get(item.id)?.abort();
          try { transaction(() => { backupProject(project.id, userId, expiresAt, backup); removeProject(project.id); persist(); }); }
          catch (error) { state = previous; revision = previousRevision; throw error; }
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
        if (path === '/api/health/report' && method === 'GET') {
          // Only accounts named in FRAME_LINE_HEALTH_USERS; everyone else gets exactly what an unknown route gets.
          if (!canSeeHealth(userId, process.env)) fail(404, 'API endpoint not found.');
          expired(); send(res, 200, reports.summary({ now: Date.now(), host: hostSnapshot(), onlineIdentities: onlineIdentities() })); return;
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
            takeReport({ userId, name: account.user.name, clientId, projectId: project.id }, body.health);
          }
          for (const subscriber of subscribers.values()) if (subscriber.session === session && subscriber.clientId === clientId) subscriber.projectId = body.online === false ? undefined : project.id;
          broadcastPresence(project.id);
          expired(); send(res, 200, { presence: visiblePresence().filter(person => person.projectId === project.id), serverTime: Date.now() }); return;
        }
        if (path === '/api/locks' && ['POST', 'DELETE'].includes(method)) {
          // One id (targetId) or a batch (targetIds, up to 2000: a multi-clip drag takes and renews them in one request). A batch is all or nothing.
          const body = await jsonBody(req); const project = requireProject(textField(body.projectId, 160, true), userId, true); const field = textField(body.field, 100, true);
          const many = body.targetIds !== undefined;
          if (many && (!Array.isArray(body.targetIds) || !body.targetIds.length || body.targetIds.length > 2000)) fail(400, 'Lock between 1 and 2000 items at a time.');
          const targetIds = [...new Set<string>(many ? (body.targetIds as unknown[]).map(id => textField(id, 160, true)) : [textField(body.targetId, 160, true)])];
          if (!targetIds.every(id => idIsValid(id) && lockable(id, project.id))) fail(404, 'Lock target not found.');
          expired(); const keyOf = (id: string) => `${project.id}:${id}:${field}`;
          if (method === 'DELETE') { let changed = false; for (const id of targetIds) if (locks.get(keyOf(id))?.userId === userId) { locks.delete(keyOf(id)); changed = true; } if (changed) lockChanged(); send(res, 200, { ok: true }); return; }
          const wanted = new Set(targetIds);
          const conflict = [...locks.values()].find(lock => lock.projectId === project.id && wanted.has(lock.targetId) && lock.userId !== userId && lockConflict(lock.field, field));
          if (conflict) { send(res, 409, { error: 'This control is being edited by a collaborator.', lock: conflict }); return; }
          let changed = false; const taken = targetIds.map(targetId => { const key = keyOf(targetId), held = locks.get(key), lock = { id: key, projectId: project.id, targetId, field, userId, expiresAt: Date.now() + LOCK_TTL }; locks.set(key, lock); if (held?.userId !== userId) changed = true; return lock; });
          if (changed) lockChanged(); send(res, 200, many ? { locks: taken } : { lock: taken[0] }); return;
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
          for(const key of ['projects','timelines','tracks','clips','nodes'])validateCollection((next as any)[key],key,holds(key));
          validateRelations(next);
          mkdirSync(resolveDir(id),{recursive:true,mode:0o700});writeFileSync(join(resolveDir(id),'project.frameline.json'),JSON.stringify(body.manifest),{mode:0o600});
          const previous=state;state=next;try{persist();}catch(error){state=previous;throw error;}
          send(res,201,{projectId:id,files:imported!.files,warnings:imported!.warnings,media:imported!.media});return;
        }
        if (path === '/api/fcp/import' && method === 'POST') {
          // The body is the raw FCPXML (JSON would escape a 50 MB XML). The same XML maps to the same project id, so a
          // rerun resumes its uploads; rebuild=1 re-converts an imported project's edit, keeping its uploaded media.
          const id = url.searchParams.get('projectId') ?? '', rebuild = url.searchParams.get('rebuild') === '1';
          if (!idIsValid(id) || !id.startsWith('fcp-') || id.length > 64) fail(400, 'Invalid import project ID.');
          const xml = (await binaryBody(req, 128 * 1024 * 1024)).toString('utf8');
          // Titles are measured with the fonts and canvas the export renders them with, so they can be shrunk to fit.
          const ruler = createCanvas(8, 8).getContext('2d'), measure = (text: string, style: TextStyle) => { ruler.font = canvasFont(style); return style.letterSpacing ? [...new Intl.Segmenter().segment(text)].reduce((sum, g) => sum + ruler.measureText(g.segment).width + style.letterSpacing, 0) : ruler.measureText(text).width; };
          let imported: ReturnType<typeof importFcpxml>; try { imported = importFcpxml(xml, id, userId, fonts.list(), measure); } catch (error) { fail(400, (error as Error).message); }
          const existing = state.projects.find(p => p.id === id) as (Project & { fcpImportHash?: string }) | undefined;
          const { fcpImportHash, fcpWarnings } = imported!.project as Project & { fcpImportHash: string; fcpWarnings: string[] };
          if (existing) {
            requireProject(id, userId, true);
            if (!existing.fcpImportHash) fail(409, 'That project was not imported from Final Cut.');
            if (!rebuild) {
              if (existing.fcpImportHash !== fcpImportHash) fail(409, 'That project already exists with a different Final Cut XML. Import it with rebuild to replace its edit.');
              send(res, 200, { projectId: id, warnings: imported!.warnings, media: state.media.filter(m => m.projectId === id) }); return;
            }
          }
          let next: PersistedState;
          if (existing) {
            // The edit it replaces stays restorable as a snapshot; comments on clips that no longer exist move to the timeline.
            const mine = <T extends { projectId: string }>(items: T[]) => items.filter(item => item.projectId === id), others = <T extends { projectId: string }>(items: T[]) => items.filter(item => item.projectId !== id);
            const oldTimelines = new Set(mine(state.timelines).map(t => t.id)), known = new Set(state.media.map(m => m.id)), clipIds = new Set(imported!.clips.map(c => c.id));
            const snapshot = { id: `${id}-rebuild-${Date.now().toString(36)}`, projectId: id, name: 'Before Final Cut rebuild', note: 'The edit as it was before the Final Cut XML was imported again.', userId, timestamp: Date.now(),
              state: { timelines: mine(state.timelines), clips: mine(state.clips), tracks: state.tracks.filter(t => oldTimelines.has(t.timelineId)), nodes: mine(state.nodes), comments: mine(state.comments) } };
            next = { ...state, projects: state.projects.map(p => p.id === id ? { ...p, fcpImportHash, fcpWarnings, modifiedAt: Date.now() } : p),
              media: [...state.media, ...imported!.media.filter(m => !known.has(m.id))], timelines: [...others(state.timelines), ...imported!.timelines],
              tracks: [...state.tracks.filter(t => !oldTimelines.has(t.timelineId)), ...imported!.tracks], clips: [...others(state.clips), ...imported!.clips], nodes: [...others(state.nodes), ...imported!.nodes],
              comments: state.comments.map(c => c.projectId === id && c.clipId && !clipIds.has(c.clipId) ? (({ clipId: _, ...rest }) => rest)(c) : c), snapshots: [...state.snapshots, snapshot] } as PersistedState;
          } else next = { ...state, projects: [...state.projects, imported!.project], ...Object.fromEntries(['media', 'timelines', 'tracks', 'clips', 'nodes'].map(k => [k, [...(state as any)[k], ...(imported as any)[k]]])) } as PersistedState;
          for (const key of ['projects', 'timelines', 'tracks', 'clips', 'nodes', 'comments', 'snapshots']) validateCollection((next as any)[key], key, holds(key));
          validateRelations(next);
          mkdirSync(fcpDir(id), { recursive: true, mode: 0o700 }); writeFileSync(join(fcpDir(id), 'project.fcpxml'), xml, { mode: 0o600 });
          const previous = state; state = next; try { persist(); } catch (error) { state = previous; throw error; }
          send(res, existing ? 200 : 201, { projectId: id, warnings: imported!.warnings, media: state.media.filter(m => m.projectId === id) }); return;
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
          requireSpace(0);
          const id = `media-${randomUUID()}`, spotify = link!.url.includes('open.spotify.com');
          const asset: Asset = { id, projectId: project.id, name: spotify ? 'Spotify track · matching audio' : 'YouTube · waiting to download', kind: link!.mode === 'audio' ? 'audio' : 'video', binId: link!.mode === 'audio' ? 'audio' : 'broll', thumbnail: youtubeThumbnail(link!.url), duration: 0, resolution: '', fps: 0, size: '', status: 'downloading', progress: 0, importLink: link! };
          mkdirSync(mediaDir(id), { recursive: true, mode: 0o700 }); state.media = [asset, ...state.media]; persist();
          processAsset(id); send(res, 202, { asset }); return;
        }
        if (path === '/api/media' && method === 'POST') {
          if (aborters.size + state.media.filter(asset => asset.status === 'uploading').length >= QUEUE_LIMIT) fail(429, 'The processing queue is full. Wait for current uploads and exports to finish.');
          const project = requireProject(url.searchParams.get('projectId') ?? '', userId, true); const id = url.searchParams.get('id') ?? `media-${randomUUID()}`;
          if (!idIsValid(id)) fail(400, 'Invalid media ID.'); if (state.media.some(asset => asset.id === id) || existsSync(mediaDir(id))) fail(409, 'That media ID already exists.');
          const name = textField(url.searchParams.get('name'), 255, true); if (/[\x00-\x1f]/.test(name) || basename(name.replaceAll('\\', '/')) !== name) fail(400, 'Invalid filename.');
          const length = Number(req.headers['content-length']); if (length > maxUploadBytes) fail(413, `Files must be smaller than ${Math.floor(maxUploadBytes / 1024 ** 3)} GB.`);
          requireSpace(length > 0 ? length : 0);
          const kind = mediaKind(name);
          const asset: Asset = { id, projectId: project.id, name, kind, binId: kind === 'audio' ? 'audio' : 'broll', thumbnail: '', duration: 0, resolution: '', fps: 0, size: '', status: 'uploading', progress: 0 };
          mkdirSync(mediaDir(id), { recursive: true, mode: 0o700 }); state.media = [asset, ...state.media]; persist();
          if (url.searchParams.get('placeholder') === '1') { send(res, 201, { asset }); return; }
          const temporary = join(mediaDir(id), 'upload.part'); let bytes = 0, lastProgress = 0;
          try {
            const limit = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > maxUploadBytes) callback(new HttpError(413, 'The upload exceeds the configured size limit.')); else { if (length > 0 && Date.now() - lastProgress >= 200) { lastProgress = Date.now(); updateAsset(id, { progress: Math.min(99, Math.floor(bytes / length * 100)) }); } callback(null, chunk); } } });
            await pipeline(req, limit, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })); if (!bytes) fail(400, 'The uploaded file is empty.');
            renameSync(temporary, originalPath(id)); updateAsset(id, { size: bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`, status: 'processing' });
            processAsset(id); send(res, 202, { asset: state.media.find(item => item.id === id) }); return;
          } catch (error) { rmSync(temporary, { force: true }); updateAsset(id, { status: 'failed', error: error instanceof Error ? error.message : 'Upload failed.' }); throw error; }
        }
        // Moving a selection between bins is one save, not one per file.
        if (path === '/api/media/move' && method === 'POST') {
          const body = await jsonBody(req); const project = requireProject(textField(body.projectId, 160, true), userId, true);
          const binId = textField(body.binId, 64, true); if (!BIN_ID.test(binId)) fail(400, 'Invalid bin ID.');
          if (!Array.isArray(body.mediaIds) || !body.mediaIds.length || body.mediaIds.length > 10_000) fail(400, 'Choose media to move.');
          const ids = new Set<string>(body.mediaIds); if (![...ids].every(id => state.media.some(asset => asset.id === id && asset.projectId === project.id))) fail(404, 'Media not found.');
          const previous = state.media; state.media = state.media.map(asset => ids.has(asset.id) && asset.binId !== binId ? { ...asset, binId } : asset);
          try { persist(); } catch (error) { state.media = previous; throw error; }
          send(res, 200, { ok: true }); return;
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
              updateAsset(id, { thumbnail: `/api/media/${id}/files/thumbnail.jpg${replacedVersion(id)}` });
              send(res, 200, { ok: true }); return;
            } finally { rmSync(temporary, { force: true }); }
          }
          // Replace Media swaps a file in only while nothing reads the old original (Windows cannot replace an open file).
          const replaceBusy = () => aborters.has(id) || state.renderJobs.some(job => job.projectId === asset.projectId && ['waiting', 'rendering'].includes(job.status)) || captionJobs().some(job => job.projectId === asset.projectId && ['waiting', 'running'].includes(job.status));
          if(suffix==='upload') {
            // A pending Replace Media uploads beside the original, which stays in use until the last byte is accepted.
            const replacement=join(mediaDir(id),'replacement.json'), staging=existsSync(replacement);
            const partial=join(mediaDir(id),staging?'replacement.part':'upload.part'), metadataPath=join(mediaDir(id),staging?'replacement.upload.json':'upload.json');
            if(method==='GET'){send(res,200,{offset:existsSync(partial)?statSync(partial).size:0,complete:!staging&&existsSync(originalPath(id)),metadata:existsSync(metadataPath)?JSON.parse(readFileSync(metadataPath,'utf8')):null});return;}
            if(method==='POST') {
              const body=await jsonBody(req);numberField(body.size,1,maxUploadBytes);if(!Number.isSafeInteger(body.size))fail(400,'Invalid file size.');textField(body.fingerprint,300,true);
              if(!staging&&existsSync(originalPath(id))){send(res,200,{complete:true});return;}
              if(staging&&body.size!==JSON.parse(readFileSync(replacement,'utf8')).size)fail(409,'The selected file differs from the replacement. Choose Replace Media again.');
              if(uploadLocks.has(id))fail(409,'Upload is busy.');
              requireSpace(body.size-(existsSync(partial)?statSync(partial).size:0));
              const metadata={size:body.size,fingerprint:body.fingerprint};
              if(existsSync(metadataPath)&&!same(JSON.parse(readFileSync(metadataPath,'utf8')),metadata))fail(409,'The selected file differs from the unfinished upload. Choose the original file.');
              mkdirSync(mediaDir(id),{recursive:true,mode:0o700});writeFileSync(metadataPath,JSON.stringify(metadata),{mode:0o600});
              if(!staging)updateAsset(id,{status:'uploading',error:undefined});send(res,200,{offset:existsSync(partial)?statSync(partial).size:0,complete:false});return;
            }
            if(method==='PUT') {
              if(uploadLocks.has(id))fail(409,'Upload is busy.');
              if(!staging&&existsSync(originalPath(id)))fail(409,'Original media is immutable.');
              if(!existsSync(metadataPath))fail(409,'Initialize this upload first.');
              const metadata=JSON.parse(readFileSync(metadataPath,'utf8')), offset=Number(req.headers['upload-offset']);
              const current=existsSync(partial)?statSync(partial).size:0;
              if(!Number.isSafeInteger(offset)||offset!==current)fail(409,'Upload offset changed. Resume from the server offset.');
              requireSpace(Number(req.headers['content-length'])||0);
              uploadLocks.add(id);
              try {
                const chunk=await binaryBody(req,8*1024*1024);
                const digest=createHash('sha256').update(chunk).digest('hex');if(req.headers['upload-checksum']!==digest)fail(400,'Chunk checksum mismatch.');
                if(offset+chunk.length>metadata.size)fail(400,'Upload exceeds its declared size.');
                // Refused before the last chunk lands, so the client resumes it later with nothing half-swapped.
                if(staging&&offset+chunk.length===metadata.size&&replaceBusy())fail(409,'Wait for this media’s processing and the project’s exports to finish; the replacement then completes.');
                appendFileSync(partial,chunk,{mode:0o600,flush:true});const complete=offset+chunk.length===metadata.size;
                if(complete&&staging){
                  // The swap is one rename over the original; a refused rename puts the chunk back so it can be resent.
                  try{renameSync(partial,originalPath(id));}catch(error){truncateSync(partial,offset);throw error;}
                  const name=String(JSON.parse(readFileSync(replacement,'utf8')).name);progressAt.delete(id);
                  writeFileSync(join(mediaDir(id),'replaced'),`?v=${Date.now().toString(36)}`,{mode:0o600});
                  const previous=state.media;state.media=state.media.map(item=>item.id===id?{id,projectId:item.projectId,name,kind:item.kind,binId:item.binId,thumbnail:'',duration:0,resolution:'',fps:0,size:'',status:'processing',progress:0,preparationStage:'Queued for media processing'}:item);
                  try{persist();}catch(error){state.media=previous;throw error;}
                  for(const file of ['replacement.json','replacement.upload.json'])rmSync(join(mediaDir(id),file),{force:true});
                  // Processing rewrites the previews under new URLs either way; one Windows still holds open is only a log line.
                  try{rmSync(join(mediaDir(id),'prepared'),{recursive:true,force:true});}catch(error){console.error('Old previews not removed:',error);}
                  if(!DEFER_PREP)processAsset(id);
                }
                else if(complete){progressAt.delete(id);renameSync(partial,originalPath(id));updateAsset(id,{status:'processing',progress:0,preparationStage:'Queued for media processing'});if(!DEFER_PREP)processAsset(id);}
                // Keep collaborators informed without persisting the workspace for every chunk.
                else if (!staging && Date.now() - (progressAt.get(id) ?? 0) >= 5000) {
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
            const filename = suffix.slice(6); if (!/^[a-zA-Z0-9_-]+\.(mp4|webm|m4a|jpg|jpeg|png|json|webp)$/.test(filename)) fail(404, 'File not found.');
            streamFile(req, res, join(mediaDir(id), 'prepared', filename), undefined, undefined, true); return;
          }
          if (method === 'PATCH' && !suffix) {
            const body = await jsonBody(req); const patch: Partial<Asset> = {};
            if (body.name !== undefined) patch.name = textField(body.name, 255, true).trim();
            // A bin is a folder in the media panel. A bulk import assigns one per camera, so this
            // takes a free-form id rather than a fixed list; the panel shows whatever is in use.
            if (body.binId !== undefined) { const binId = textField(body.binId, 64, true).trim(); if (!BIN_ID.test(binId)) fail(400, 'A bin name uses letters, numbers, spaces, hyphens or underscores.'); patch.binId = binId; }
            if (!Object.keys(patch).length) fail(400, 'Nothing to change.');
            updateAsset(id, patch); send(res, 200, { asset: state.media.find(item => item.id === id) }); return;
          }
          if (method === 'POST' && suffix === 'retry') { if (!existsSync(originalPath(id)) && !asset.importLink) fail(409, 'The original upload is missing. Upload the file again.'); if (aborters.has(id)) fail(409, 'This file is already processing.'); updateAsset(id, { status: 'processing', progress: 0, error: undefined }); processAsset(id); send(res, 202, { asset: state.media.find(item => item.id === id) }); return; }
          // Relink: the asset keeps its id, binId and every clip on it. This only stages the replacement; the upload routes
          // swap it in once its last byte is accepted. Until then, and if it never arrives, the original stays in use.
          if (method === 'POST' && suffix === 'replace') {
            const body = await jsonBody(req); const name = textField(body.name, 255, true); if (/[\x00-\x1f]/.test(name) || basename(name.replaceAll('\\', '/')) !== name) fail(400, 'Invalid filename.');
            if (mediaKind(name) !== asset.kind) fail(400, `Choose ${asset.kind === 'image' ? 'an image' : `a ${asset.kind}`} file to replace this media.`);
            if (!Number.isSafeInteger(body.size) || body.size < 1) fail(400, 'Invalid file size.');
            if (body.size > maxUploadBytes) fail(413, `Files must be smaller than ${Math.floor(maxUploadBytes / 1024 ** 3)} GB.`);
            requireSpace(body.size);
            if (uploadLocks.has(id) || replaceBusy()) fail(409, 'Wait for this media’s processing and the project’s exports to finish, then replace it.');
            // A new replacement starts over; any earlier staged one goes.
            for (const file of ['replacement.part', 'replacement.upload.json']) rmSync(join(mediaDir(id), file), { force: true });
            mkdirSync(mediaDir(id), { recursive: true, mode: 0o700 }); writeFileSync(join(mediaDir(id), 'replacement.json'), JSON.stringify({ name, size: body.size }), { mode: 0o600 });
            send(res, 200, { asset }); return;
          }
          if (method === 'POST' && suffix === 'cancel' && asset.importLink) {
            aborters.get(id)?.abort();
            if (!['ready', 'failed'].includes(asset.status)) updateAsset(id, { status: 'failed', error: 'Import cancelled.', progress: 0 });
            send(res, 200, { ok: true }); return;
          }
          if (method === 'DELETE' && !suffix) {
            if (state.clips.some(clip => clip.mediaId === id) || state.snapshots.some(snapshot => snapshot.state.clips.some(clip => clip.mediaId === id)) || state.renderJobs.some(job => job.projectId === asset.projectId && ['waiting', 'rendering'].includes(job.status)) || captionJobs().some(job=>job.projectId===asset.projectId&&['waiting','running'].includes(job.status))) fail(409, 'This media is used by a timeline, snapshot, or pending export.');
            aborters.get(id)?.abort(); state.media = state.media.filter(item => item.id !== id); persist();
            // Worker cleanup follows cancellation so an encoder cannot recreate deleted files.
            void assetJobs(id).then(() => rmSync(mediaDir(id), { recursive: true, force: true })).catch(error => console.error('File cleanup failed:', error)); send(res, 200, { ok: true }); return;
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
          // The media slot is held only while the audio renders: the transcription then waits for the GPU (behind a depth run
          // or a Smart Mask) outside the queue, still cancellable under the job's id.
          addWork(job.id,queueSignal=>new Promise<void>(leave=>{
            const controller=new AbortController(),signal=controller.signal;
            if(queueSignal.aborted)controller.abort();else queueSignal.addEventListener('abort',()=>controller.abort(),{once:true});
            void (async()=>{
              try {
                job.status='running';saveCaptionJob(job);
                job.words=await transcribeTimeline({...snapshot,outputPath:'',signal},job.trackIds,(stage,progress)=>{if(!closed&&!signal.aborted){job.stage=stage;job.progress=progress;saveCaptionJob(job);}},()=>{aborters.set(job.id,controller);leave();});
                if(signal.aborted)throw new Error('Cancelled');
                job.status='complete';job.stage=job.words.length?'Ready':'No speech detected';job.progress=100;
              }catch(error){job.status=signal.aborted?'cancelled':'failed';job.stage=signal.aborted?'Cancelled':'Transcription failed';job.error=(error as Error).message;}
              finally{leave();if(aborters.get(job.id)===controller)aborters.delete(job.id);}
              if(!closed)saveCaptionJob(job);
            })();
          }));
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
          // The editor asks for timing as it opens; start the preview model now so the first click is quick.
          if (path.endsWith('source-times')) masks.warm();
          const sourceTimes = await masks.sourceTimes(clip, asset, originalPath(asset.id));
          if (path.endsWith('source-times')) { send(res, 200, { sourceTimes }); return; }
          const frame = Number(url.searchParams.get('frame'));
          if (!Number.isSafeInteger(frame) || frame < 0 || frame >= sourceTimes.length) fail(400, 'Invalid source frame.');
          res.setHeader('X-Smart-Mask-Time', String(sourceTimes[frame])); res.setHeader('X-Smart-Mask-Frame', String(frame));
          const image = await masks.source(clip, asset, originalPath(asset.id), frame, url.searchParams.get('size') === 'display' ? 'display' : 'native');
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
          maskPreviews.add(`${clip.projectId}:${basename(image, '.png')}`); if (maskPreviews.size > 10_000) maskPreviews.delete(maskPreviews.values().next().value!);
          send(res, 200, { url: `/api/smart-masks/preview/${basename(image, '.png')}.png?projectId=${encodeURIComponent(clip.projectId)}` }); return;
        }
        const previewRoute = /^\/api\/smart-masks\/preview\/([a-f0-9]{64})\.png$/.exec(path);
        if (previewRoute && ['GET', 'HEAD'].includes(method)) {
          const projectId = textField(url.searchParams.get('projectId'), 160, true); requireProject(projectId, userId);
          if (!maskPreviews.has(`${projectId}:${previewRoute[1]}`)) fail(404, 'Preview not found.');
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
        if (path === '/api/depth/capabilities' && method === 'GET') { const { workerIdentity, ...capabilities } = await depthCapabilities(); send(res, 200, capabilities); return; }
        if (path === '/api/depth' && method === 'POST') {
          const body = await jsonBody(req), clip = state.clips.find(item => item.id === textField(body.clipId, 160, true) && (body.projectId === undefined || item.projectId === body.projectId)) ?? fail(404, 'Clip not found.');
          // Every member's viewer asks; only an editor's request may start a run, the rest join one.
          const editor = ['Owner', 'Editor'].includes(roleFor(requireProject(clip.projectId, userId), userId) ?? '');
          const asset = state.media.find(item => item.id === clip.mediaId && item.projectId === clip.projectId);
          if (!asset || !['video', 'image'].includes(asset.kind)) fail(400, 'Depth works on video and image clips.');
          if (!existsSync(originalPath(asset!.id))) fail(409, 'Depth reads the original media, which is not on this server.');
          let range = { from: 0, to: 1 };
          try { range = depthSpan(clip, asset!, state.clips, state.media); } catch (error) { fail(400, (error as Error).message); }
          const run = await depth.enqueue({ clip: structuredClone(clip), asset: asset!, sourcePath: originalPath(asset!.id), ...range, joinOnly: !editor, bind: editor });
          send(res, run.status === 'ready' ? 200 : 202, run); return;
        }
        const depthRoute = /^\/api\/depth\/([a-f0-9]{64})(?:\/preview\/(\d+)\.mp4|\/(focus))?$/.exec(path);
        if (depthRoute) {
          const projectId = textField(url.searchParams.get('projectId'), 160, true); requireProject(projectId, userId, method === 'DELETE');
          if (depthRoute[3] && method === 'GET') {
            // Focus follows subject for one clip: the analysis the editor names (maskKey) of one of the clip's masks, resolved as
            // the export resolves it. Named, not "the current subject": a poll for subject A must never come back with B's track.
            const clip = state.clips.find(item => item.id === url.searchParams.get('clipId') && item.projectId === projectId) ?? fail(404, 'Clip not found.');
            const maskKey = textField(url.searchParams.get('maskKey'), 64, true);
            const mask = clip.smartMasks?.find(item => item.result?.key === maskKey) ?? fail(409, 'This subject mask is no longer on the clip, or was analyzed again.');
            const asset = state.media.find(item => item.id === clip.mediaId && item.projectId === projectId) ?? fail(404, 'Media not found.');
            if (!existsSync(originalPath(asset.id))) fail(409, 'Original video is unavailable.');
            const subject = resolveSmartMaskArtifact(join(dataDir, 'smart-masks'), clip, mask, originalPath(asset.id), asset);
            if (depth.get(projectId, depthRoute[1], 0, false).mediaId !== asset.id) fail(409, 'This depth analysis belongs to other media.');
            // A long run takes a while to measure: answer 202 and let the editor ask again rather than hold the tunnel.
            const task = depth.focus(projectId, depthRoute[1], subject); task.catch(() => {});
            const track = await Promise.race([task, new Promise<undefined>(resolve => setTimeout(resolve, 1000))]);
            send(res, track ? 200 : 202, track ?? { status: 'processing' }); return;
          }
          if (!depthRoute[2] && method === 'GET') { send(res, 200, depth.get(projectId, depthRoute[1], Number(url.searchParams.get('after') ?? 0), url.searchParams.get('times') !== '0')); return; }
          if (!depthRoute[2] && method === 'DELETE') { depth.cancel(projectId, depthRoute[1]); send(res, 200, { ok: true }); return; }
          if (depthRoute[2] && ['GET', 'HEAD'].includes(method)) { streamFile(req, res, depth.preview(projectId, depthRoute[1], Number(depthRoute[2])), 'video/mp4', undefined, true); return; }
        }
        if (path === '/api/optical-flow/capabilities' && method === 'GET') {
          try { await flowWorker(); send(res,200,{available:true,engine:flowEngineLabel()}); }
          catch(error) { send(res,200,{available:false,error:(error as Error).message}); } return;
        }
        if (path === '/api/optical-flow' && method === 'POST') {
          const body = await jsonBody(req), clip = state.clips.find(c => c.id === textField(body.clipId,160,true)) ?? fail(404,'Clip not found.');
          // Playback asks for this for every viewer, reviewers included; heavyJob and the queue cap bound the work.
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
          // The file that quality plays. A graphic's previews carry alpha, so it reads its original, never an opaque proxy;
          // an older import not yet migrated (or a missing file) reads the original too.
          const previewName = asset!.hasAlpha || quality === 'Original' ? undefined : quality === '1/4' ? STREAM_LOW_VARIANT : quality === '1/2' || quality === 'Stream' ? STREAM_VARIANT : FULL_VARIANT;
          const proxy = previewName && join(mediaDir(asset!.id),'prepared',previewName);
          const input = proxy && existsSync(proxy) ? proxy : originalPath(asset!.id);
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
            flowQueue = flowQueue.then(() => heavyJob(async () => {
              if (closed || current.controller.signal.aborted) return;
              try {
                await renderOpticalFlow({...snapshot,input,directory:flowDirectory,fps,from,duration,preview:true,signal:current.controller.signal,onProgress:p=>{current.progress=Math.round(p);}});
                current.status='ready'; current.url=`/api/optical-flow/${key}/video?projectId=${project.id}`;
              } catch(error) { current.status='failed';current.error=(error as Error).message; return; }
              // The preview is ready either way; a cache that could not be trimmed is only a log line.
              try { await trimFlowCache(flowDirectory,new Set([key])); } catch(error) { console.error('Optical-flow cache trim failed:',error); }
            }));
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
        if(path==='/api/timeline-previews'&&method==='POST') {
          const body=await jsonBody(req);object(body);
          // A playback cache for every viewer, reviewers included; the preview queue is bounded.
          const project=requireProject(textField(body.projectId,160,true),userId);
          const timeline=state.timelines.find(t=>t.id===body.timelineId&&t.projectId===project.id)??fail(404,'Timeline not found.');
          const chunk=numberField(body.chunk,0,5400);if(!Number.isInteger(chunk))fail(400,'Invalid preview chunk.');
          const fps=project.fps, frameStart=chunk*Math.round(fps*4), from=frameStart/fps;
          const end=Math.min(timeline.duration,(frameStart+Math.round(fps*4))/fps);
          if(from>=end)fail(400,'Preview is outside the timeline.');
          const width=numberField(body.width,160,1920),height=numberField(body.height,90,1920);
          if(!Number.isInteger(width)||!Number.isInteger(height)||width%2||height%2)fail(400,'Invalid preview dimensions.');
          const settings={resolution:`${width} × ${height}`,fps:String(fps),codec:'H.264',quality:'Automatic',audio:'Disabled',rangeIn:String(from),rangeOut:String(end)};
          try { const result=timelinePreviews.request(previewSnapshot(project,timeline,settings),{userId,chunk});send(res,200,result); }
          catch(error){if(error instanceof PreviewBusyError){res.setHeader('Retry-After',String(error.retryAfterSeconds));fail(429,'Preview queue busy');}throw error;}
          return;
        }
        if(path==='/api/frames'&&method==='GET'){
          // One composited frame as a small JPEG for viewers and agents (the MCP's frame tool); mediaId shows a file's own picture.
          const q=url.searchParams,project=requireProject(textField(q.get('projectId'),160,true),userId);
          const mediaId=q.get('mediaId'),asset=mediaId?state.media.find(m=>m.id===mediaId&&m.projectId===project.id)??fail(404,'Media not found.'):undefined;
          if(asset?.kind==='audio')fail(409,'Audio has no picture.');
          const timeline=asset?undefined:state.timelines.find(t=>t.id===q.get('timelineId')&&t.projectId===project.id)??fail(404,'Timeline not found.');
          const base=asset?mediaStill(project,asset,originalPath(asset.id)):previewSnapshot(project,timeline!,{});
          const still=stillSettings(project,base.timeline.duration,numberField(Number(q.get('t')??0),0,86400),numberField(Number(q.get('w')??512),64,1920));
          const aborted=new AbortController();res.on('close',()=>{if(!res.writableFinished)aborted.abort();});
          try{
            const file=await stills.still({...base,settings:still.settings},aborted.signal);
            res.setHeader('X-Frame-Time',String(still.time));res.setHeader('X-Frame-Index',String(still.frame));
            streamFile(req,res,file,'image/jpeg');
          }catch(error){
            if(error instanceof StillSkipped){send(res,409,{error:error.message,live:error.live});return;}
            if(error instanceof PreviewBusyError){res.setHeader('Retry-After',String(error.retryAfterSeconds));fail(429,'Frame queue busy');}
            throw error;
          }
          return;
        }
        const timelinePreviewRoute=/^\/api\/timeline-previews\/([a-f0-9]{64})\/video\.mp4$/.exec(path);
        if(timelinePreviewRoute&&['GET','HEAD'].includes(method)){
          const projectId=textField(url.searchParams.get('projectId'),160,true);requireProject(projectId,userId);
          const file=timelinePreviews.file(timelinePreviewRoute[1],projectId)??fail(404,'Preview not found.');
          streamFile(req,res,file,'video/mp4',undefined,true);return;
        }
        if (path === '/api/motion-trackers/capabilities' && method === 'GET') { send(res, 200, await motionTrackerCapabilities()); return; }
        if (path.startsWith('/api/motion-trackers/')) {
          // Every tracker call names a clip or a project it belongs to; nothing is authorized by a key on its own.
          const trackedClip = (id: unknown, write: boolean) => {
            const clip = state.clips.find(item => item.id === textField(id, 160, true)) ?? fail(404, 'Clip not found.');
            requireProject(clip.projectId, userId, write);
            const asset = state.media.find(item => item.id === clip.mediaId && item.projectId === clip.projectId) ?? fail(404, 'Media not found.');
            if (asset.kind !== 'video' || !existsSync(originalPath(asset.id))) fail(409, 'Tracking reads the original video, which is not on this server.');
            return { clip, asset };
          };
          const tracker = (clip: typeof state.clips[number], id: unknown) => clip.motionTrackers?.find(item => item.id === textField(id, 160, true)) ?? fail(409, 'This tracker is still saving. Try again in a moment.');
          if (path === '/api/motion-trackers/source-times' && method === 'GET') {
            const { clip, asset } = trackedClip(url.searchParams.get('clipId'), false);
            send(res, 200, { sourceTimes: await masks.sourceTimes(clip, asset, originalPath(asset.id)) }); return;
          }
          if (path === '/api/motion-trackers/track' && method === 'POST') {
            const body = await jsonBody(req), { clip, asset } = trackedClip(body.clipId, true);
            if (!Array.isArray(body.trackerIds) || !body.trackerIds.length || body.trackerIds.length > 16) fail(400, 'Choose which trackers to track.');
            if (body.direction !== 'forward' && body.direction !== 'backward') fail(400, 'Track forward or backward.');
            const frames = body.frames === undefined ? undefined : numberField(body.frames, 1, 1_000_000);
            const job = await motionTrackers.start({ projectId: clip.projectId, clip: structuredClone(clip), asset, sourcePath: originalPath(asset.id), times: await masks.sourceTimes(clip, asset, originalPath(asset.id)), trackers: body.trackerIds.map((id: unknown) => structuredClone(tracker(clip, id))), time: numberField(body.time, 0, 86400), direction: body.direction === 'forward' ? 1 : -1, frames });
            send(res, 202, job); return;
          }
          if (path === '/api/motion-trackers/clear' && method === 'POST') {
            const body = await jsonBody(req), { clip, asset } = trackedClip(body.clipId, true);
            const key = await motionTrackers.clear(tracker(clip, body.trackerId), await masks.sourceTimes(clip, asset, originalPath(asset.id)), numberField(body.from, 0, 86400), numberField(body.to, 0, 86400));
            send(res, 200, { key }); return;
          }
          const jobRoute = /^\/api\/motion-trackers\/jobs\/([a-f0-9-]{36})$/.exec(path);
          if (jobRoute && ['GET', 'DELETE'].includes(method)) {
            const projectId = textField(url.searchParams.get('projectId'), 160, true); requireProject(projectId, userId, method === 'DELETE');
            if (method === 'DELETE') { motionTrackers.cancel(projectId, jobRoute[1]); send(res, 200, { ok: true }); return; }
            send(res, 200, motionTrackers.get(projectId, jobRoute[1], Number(url.searchParams.get('after') ?? 0))); return;
          }
          const samplesRoute = /^\/api\/motion-trackers\/samples\/([a-f0-9]{64})$/.exec(path);
          if (samplesRoute && method === 'GET') {
            const projectId = textField(url.searchParams.get('projectId'), 160, true); requireProject(projectId, userId);
            const samples = await motionTrackers.read(samplesRoute[1]);
            if (!state.media.some(item => item.id === samples.mediaId && item.projectId === projectId)) fail(404, 'Tracking result not found.');
            send(res, 200, samples); return;
          }
        }
        if (path === '/api/color-assistant/capabilities' && method === 'GET') { send(res, 200, colorAssistantCapabilities(account.user.id)); return; }
        const assistantRoute = /^\/api\/projects\/([a-zA-Z0-9_-]+)\/color-assistant(?:\/([a-f0-9-]{36})(?:\/stills\/([^/]+))?)?$/.exec(path);
        if (assistantRoute) {
          // Every call can spend the allow-listed owner's Codex quota or show its results: allow-list first, then an editor role.
          if (!aiColorAllowed(account.user.id)) fail(403, 'The Color Assistant is not enabled for this account.');
          const [, projectId, jobId, file] = assistantRoute; requireProject(projectId, userId, true);
          if (file !== undefined && ['GET', 'HEAD'].includes(method)) { streamFile(req, res, colorAssistant.still(projectId, jobId!, file), 'image/jpeg', undefined, true); return; }
          if (file === undefined && jobId && method === 'GET') { send(res, 200, colorAssistant.get(projectId, jobId)); return; }
          if (file === undefined && jobId && method === 'DELETE') { colorAssistant.cancel(projectId, jobId); send(res, 200, { ok: true }); return; }
          if (!jobId && method === 'GET') { send(res, 200, colorAssistant.latest(projectId)); return; }
          if (!jobId && method === 'POST') { const body = await jsonBody(req); send(res, 202, colorAssistant.start({ projectId, body, clips: state.clips, media: state.media, nodes: state.nodes, source: originalPath })); return; }
          fail(405, 'Method not allowed.');
        }
        if (path === '/api/stabilize/capabilities' && method === 'GET') { send(res,200,await stabilizeCapabilities()); return; }
        if (path === '/api/stabilize' && method === 'POST') {
          const body = await jsonBody(req), clip = state.clips.find(c => c.id === textField(body.clipId,160,true)) ?? fail(404,'Clip not found.');
          // The preview warps with this solve for every viewer; without it a reviewer sees the unstabilized picture.
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
          // A replaced original (Replace Media keeps the id) is a new source: its version keeps the old solve from being served.
          const generation = JSON.stringify([clip.mediaId,settings,range]), key = createHash('sha256').update(`${clip.id}:${generation}${replacedVersion(clip.mediaId)}`).digest('hex');
          let job = stabilizeJobs.get(key);
          if (!job || job.controller.signal.aborted || job.status === 'failed' && Date.now() - job.polled > 10_000) {
            for (const old of stabilizeJobs.values()) if (old.clipId === clip.id && old.key !== key) { old.controller.abort(); stabilizeJobs.delete(old.key); }
            // A full queue turns the newcomer away; it never cancels someone else's waiting analysis.
            if ([...stabilizeJobs.values()].filter(j=>j.status==='preparing'&&!j.started&&!j.controller.signal.aborted).length >= 8) fail(429,'The Stabilize queue is full. Retry shortly.');
            const current: StabilizeJob = {status:'preparing',key,progress:0,projectId:project.id,clipId:clip.id,generation,controller:new AbortController(),created:Date.now(),polled:Date.now(),started:false,run:async()=>{
              try {
                const solved = await stabilizeSolve({input:original,directory:stabilizeDirectory,range,settings,signal:current.controller.signal,onProgress:p=>{current.progress=Math.round(p);}});
                current.solve=solved.solve; current.zoom=solved.solve.zoom; current.zoomMin=solved.solve.zoomMin; current.status='ready'; current.progress=100;
              } catch(error) { current.status='failed';current.error=(error as Error).message; return; }
              try { await trimStabilizeCache(stabilizeDirectory,new Set()); } catch(error) { console.error('Stabilize cache trim failed:',error); }
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
          const settings = body.settings as Record<string, string>; try { exportAspect(settings.resolution, project.resolution); } catch (error) { fail(400, (error as Error).message); } const timeline = state.timelines.find(item => item.projectId === project.id && (!settings.timelineId || item.id === settings.timelineId)) ?? fail(400, 'Create a timeline before exporting.');
          const clips = state.clips.filter(clip => clip.timelineId === timeline.id); if (!clips.some(clip => !clip.disabled)) fail(400, 'Add a clip to the timeline before exporting.');
          if (state.renderJobs.filter(job => ['waiting', 'rendering'].includes(job.status)).length >= 20) fail(429, 'The render queue is full.');
          const job: RenderJob = { id: `render-${randomUUID()}`, projectId: project.id, name: textField(body.name, 160, true).trim(), preset: textField(body.preset, 80, true), status: 'waiting', progress: 0, remaining: 'Waiting', settings };
          const snapshot = structuredClone({ project, timeline, timelines:state.timelines.filter(t=>t.projectId===project.id), clips:state.clips.filter(c=>c.projectId===project.id), tracks: state.tracks.filter(track => state.timelines.some(t=>t.id===track.timelineId&&t.projectId===project.id)), nodes: state.nodes.filter(node => node.projectId === project.id), assets: state.media.filter(asset => asset.projectId === project.id).map(asset => ({ asset, path: originalPath(asset.id) })), settings });
          mkdirSync(join(dataDir, 'renders'), { recursive: true, mode: 0o700 }); state.renderJobs = [job, ...state.renderJobs]; persist();
          startRender(job, snapshot);
          send(res, 202, { job }); return;
        }
        const renderRoute = /^\/api\/renders\/([a-zA-Z0-9_-]+)(?:\/(download))?$/.exec(path);
        if (renderRoute) {
          const job = state.renderJobs.find(job => job.id === renderRoute[1]) ?? fail(404, 'Export not found.'); requireProject(job.projectId, userId, method === 'DELETE');
          if (['GET', 'HEAD'].includes(method) && renderRoute[2] === 'download') { if (job.status !== 'complete') fail(409, 'The export is not complete.'); const extension = job.settings.codec?.includes('ProRes') ? '.mov' : '.mp4'; streamFile(req, res, join(dataDir, 'renders', `${job.id}${extension}`), contentTypes[extension], job.name.toLowerCase().endsWith(extension) ? job.name : `${job.name}${extension}`, true); return; }
          if (method === 'DELETE' && !renderRoute[2]) {
            aborters.get(job.id)?.abort(); updateJob(job.id, { status: 'failed', remaining: 'Cancelled', error: 'Cancelled by user.' });
            // A file Windows still holds open (a download in progress) is left for the next delete.
            for (const extension of ['.mp4', '.mov']) try { rmSync(join(dataDir, 'renders', `${job.id}${extension}`), { force: true }); } catch (error) { console.error('Export file removal failed:', error); }
            send(res, 200, { ok: true }); return;
          }
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
  // cloudflared pools idle origin connections for 90 s. Node's 5 s default closed them under it and reset requests.
  server.requestTimeout = 60 * 60_000; server.keepAliveTimeout = 120_000; server.headersTimeout = 121_000;
  const housekeeping = setInterval(() => { expired(); purgeExpiredProjects(); timelinePreviews.sweep(); const now = Date.now(); reportsTick(now); for (const [key, value] of authAttempts) if (value.reset < now) authAttempts.delete(key); for (const [res, subscriber] of subscribers) { if (!db.prepare('SELECT token FROM sessions WHERE token=? AND expiresAt>?').get(subscriber.session, now)) { res.end(); subscribers.delete(res); } else res.write(': heartbeat\n\n'); } }, 10_000); housekeeping.unref();
  purgeExpiredProjects();
  // Settle what the restart interrupted. Saved entities are frozen, so every change is a new object,
  // and a list is replaced only when something in it changed.
  const restarts: [RenderJob, Parameters<typeof startRender>[1]][] = [];
  const jobs = state.renderJobs.map((job): RenderJob => {
    if (job.status !== 'rendering' && job.status !== 'waiting') return job;
    const savedSnapshot = db.prepare('SELECT data FROM render_snapshots WHERE id=?').get(job.id);
    const project = state.projects.find(p => p.id === job.projectId);
    const timeline = state.timelines.find(t => t.projectId === job.projectId && (!job.settings.timelineId || t.id === job.settings.timelineId));
    if (!savedSnapshot && !(job.status === 'waiting' && project && timeline)) return { ...job, status: 'failed', remaining: 'Interrupted by server restart', error: 'The server restarted. Submit the export again.' };
    const queued: RenderJob = { ...job, status: 'waiting', progress: 0, remaining: 'Queued for export' };
    restarts.push([queued, savedSnapshot ? JSON.parse(String(savedSnapshot.data)) : structuredClone({ project: project!, timeline: timeline!, timelines: state.timelines.filter(t => t.projectId === job.projectId), clips: state.clips.filter(c => c.projectId === job.projectId), tracks: state.tracks.filter(t => state.timelines.some(tl => tl.id === t.timelineId && tl.projectId === job.projectId)), nodes: state.nodes.filter(n => n.projectId === job.projectId), assets: state.media.filter(a => a.projectId === job.projectId).map(asset => ({ asset, path: originalPath(asset.id) })), settings: job.settings })]);
    return queued;
  });
  if (jobs.some((job, i) => job !== state.renderJobs[i])) state.renderJobs = jobs;
  for (const [job, snapshot] of restarts) startRender(job, snapshot);
  const media = (state.media as Asset[]).map((asset): Asset => !['ready', 'failed', 'uploading'].includes(asset.status) ? { ...asset, status: 'failed', error: 'Processing was interrupted. Retry to continue from the saved original.' } : asset.status === 'ready' && asset.preparationStage !== undefined ? { ...asset, preparationStage: undefined } : asset);
  if (media.some((asset, i) => asset !== state.media[i])) state.media = media;
  if (store.dirty(state)) persist();
  // An upload nobody has sent a chunk to for a day is abandoned: it stops holding a queue slot and its partial file goes.
  const expireUploads = () => {
    const cutoff = Date.now() - 86400_000, staged = ['replacement.json', 'replacement.upload.json', 'replacement.part'];
    const lastTouched = (id: string, names: string[]) => Math.max(0, ...names.map(name => { try { return statSync(join(mediaDir(id), name)).mtimeMs; } catch { return 0; } }));
    for (const asset of state.media) if (!uploadLocks.has(asset.id)) {
      // An abandoned Replace Media drops only its staged file: the media keeps its original and its state.
      if (existsSync(join(mediaDir(asset.id), 'replacement.json')) && lastTouched(asset.id, staged) < cutoff) for (const name of staged) rmSync(join(mediaDir(asset.id), name), { force: true });
      if (asset.status !== 'uploading' || lastTouched(asset.id, ['upload.part', 'upload.json', '']) >= cutoff) continue;
      rmSync(join(mediaDir(asset.id), 'upload.part'), { force: true }); rmSync(join(mediaDir(asset.id), 'upload.json'), { force: true });
      updateAsset(asset.id, { status: 'failed', progress: 0, error: 'This upload stopped for a day and was discarded. Upload the file again.' });
    }
  };
  // An encode killed by a hard restart leaves its temp folder in prepared/. The one the last restart left is under an hour
  // old at startup, so the hourly pass takes it; a live encode keeps its folder fresh.
  const sweepPrepared = () => { try { const swept = sweepPreparedTemp(join(dataDir, 'media')); if (swept) console.log(`Removed ${swept} interrupted preview folder(s).`); } catch (error) { console.error('Interrupted preview cleanup failed:', error); } };
  const sweepUploads = () => { try { expireUploads(); } catch (error) { console.error('Abandoned upload cleanup failed:', error); } sweepPrepared(); };
  sweepUploads(); const uploadSweep = setInterval(sweepUploads, 3600_000); uploadSweep.unref();
  // A fresh install gets its legacy row now, so `project-bundle.mjs import` has one to merge into;
  // after a migration or a crash the row is brought up to date before anything reads it.
  if (!store.legacyCurrent()) store.writeLegacy();
  // Media storage v3: older imports move to full-v3 + stream-v2 + stream-low-v2 and their old previews are deleted.
  // One asset at a time on the media queue, each queued only when the last finishes, so exports and new uploads go
  // first and the waiting list never fills. Resumable: a killed run is picked up again at the next start.
  const migrations: string[] = [];
  let migrating = false, migrated = 0, freedBytes = 0;
  const migrateNext = () => {
    for (let id = migrations.shift(); id !== undefined && !closed; id = migrations.shift()) {
      const asset = state.media.find(item => item.id === id);
      // Busy (re-preparing, being replaced or deleted) means it ends up on the v3 set without this pass.
      if (!asset || aborters.has(id) || !needsMigration(asset, join(mediaDir(id), 'prepared'))) continue;
      migrating = true;
      addWork(id, async signal => {
        // The row as it is now: the job may have waited behind uploads and exports.
        const current = state.media.find(item => item.id === id);
        if (!current || !needsMigration(current, join(mediaDir(id), 'prepared'))) return;
        try {
          // updateAsset skips a row that is gone (its project deleted meanwhile); the old files must then stay for the backup.
          const update = (patch: Partial<Asset>) => { if (!state.media.some(item => item.id === id)) throw new Error('The asset was deleted.'); updateAsset(id, patch); };
          const { status, freed } = await migrateAsset(current, { mediaDir: mediaDir(id), baseUrl: `/api/media/${id}/files`, version: replacedVersion(id), freeBytes, reserve: Math.max(2 ** 30, minFreeBytes), signal, update });
          freedBytes += freed; if (status === 'migrated') migrated++;
          if (status === 'low-disk' || status === 'no-source') console.warn(`Media storage v3: ${asset.name} skipped (${status === 'low-disk' ? 'not enough free disk space' : 'no original or grading proxy to encode from'}); it is tried again at the next start.`);
          else console.log(`Media storage v3: ${asset.name} ${status}${freed ? `, ${(freed / 1e9).toFixed(2)} GB freed` : ''} (${migrated} migrated, ${(freedBytes / 1e9).toFixed(1)} GB freed so far, ${migrations.length} left).`);
        } catch (error) { if (!signal.aborted) console.error(`Media storage v3: ${asset.name} failed and keeps its current previews:`, error); }
      }, false, () => { migrating = false; migrateNext(); });
      return;
    }
  };
  const queueMigration = (id: string) => { if (!migrations.includes(id)) migrations.push(id); if (!migrating) migrateNext(); };
  const cameraDue = (asset: Asset) => asset.kind === 'video' && asset.status === 'ready' && asset.cameraMetadataVersion !== 2 && existsSync(originalPath(asset.id));
  // Imports before version 2 read only the file's first 2 MB (Sony can write its profile at the end) and guessed Canon Log 3.
  // An untagged stream then fell back to a BT.601 matrix, which the grading proxy baked in. The files that carry it go
  // before the correction is saved, so the migration rebuilds full-v3 from the original whenever it gets there, even
  // after restarts; only then is the check marked done.
  for (const asset of state.media) if (cameraDue(asset)) addWork(`camera-${asset.id}`, async signal => {
    try {
      const found = await readCameraColor(originalPath(asset.id), statSync(originalPath(asset.id)).size), current = state.media.find(m => m.id === asset.id);
      if (!current || signal.aborted || closed) return;
      const stale = current.colorMatrix === 'auto' ? found?.colorMatrix : undefined;
      let matrix = stale;
      // Windows refuses to delete a file FFmpeg or a player still holds: keep the old matrix and retry on the next start.
      if (matrix) try { for (const name of ['color-v1.mp4', FULL_VARIANT]) rmSync(join(mediaDir(asset.id), 'prepared', name), { force: true, maxRetries: 3 }); } catch (error) { matrix = undefined; console.error(`${asset.name}: stale grading picture in use, corrected on the next start.`, error); }
      // Positive camera metadata corrects a label. A missing tag never removes one, but says so when import only assumed it.
      const assumed = !found?.inputProfile && current.inputProfile && current.colorEvidence?.startsWith('Canon container (CAEP)') ? `; ${current.inputProfile} was assumed at import, not verified` : '';
      updateAsset(asset.id, { ...(stale === matrix && { cameraMetadataVersion: 2 }), ...(found && { colorEvidence: found.colorEvidence + assumed }), ...(found?.inputProfile && { inputProfile: found.inputProfile, inputGamut: found.inputGamut ?? current.inputGamut }), ...(matrix && { colorMatrix: matrix, colorProxyUrl: undefined }) });
    } catch (error) { if (!signal.aborted) console.error(`Camera metadata check failed for ${asset.name}:`, error); }
    finally { if (!signal.aborted && !closed) queueMigration(asset.id); }
  });
  // Assets still due a camera check join the migration from that check, after any matrix correction.
  const due = state.media.filter(asset => !cameraDue(asset) && needsMigration(asset, join(mediaDir(asset.id), 'prepared')));
  if (due.length) console.log(`Media storage v3: ${due.length} asset(s) to migrate.`);
  for (const asset of due) queueMigration(asset.id);
  // Older probes missed display rotation (portrait phone clips read as landscape) and HDR transfer.
  // Re-probing is cheap; an HDR clip then prepares again so its previews are tone-mapped.
  for (const asset of state.media) if (asset.kind === 'video' && asset.status === 'ready' && asset.probeVersion !== PROBE_VERSION && existsSync(originalPath(asset.id))) {
    addWork(`probe-${asset.id}`, async signal => {
      try {
        const { resolution, width, height, colorTransfer, colorMatrix, probeVersion, hasAlpha } = await probeMedia(originalPath(asset.id), signal);
        if (signal.aborted || closed) return;
        updateAsset(asset.id, { resolution, width, height, colorTransfer, colorMatrix, probeVersion, hasAlpha } as Partial<Asset>);
        // Graphics with alpha were proxied to opaque H.264 (a black backdrop); they prepare again as alpha WebM. The refresh
        // replaces whatever holds the asset (its storage migration), which would otherwise rename its files over this one's.
        if (colorTransfer === 'arib-std-b67' || colorTransfer === 'smpte2084' || hasAlpha) { aborters.get(asset.id)?.abort(); processAsset(asset.id, true); }
      } catch (error) { if (!signal.aborted) console.error(`Re-probe failed for ${asset.name}:`, error); }
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
  // What changed only in memory (render progress, a held-back progress value) is saved on the way out,
  // first thing, in case Windows ends the process before the slower shutdown steps finish.
  const saveBeforeExit = () => { try { flushProgress(); if (store.dirty(state)) persist(); } catch (error) { console.error('Could not save the workspace on shutdown:', error); } };
  return { server, dataDir, async close() {
    closed = true; saveBeforeExit();
    // Abort everything before awaiting anything: a job queued for the GPU or a heavy slot behind work that is only
    // aborted later would otherwise hold the shutdown (and frameline.lock) for the rest of a long depth run.
    const services = [masks.close(), depth.close(), motionTrackers.close(), colorAssistant.close()];
    for (const job of flowJobs.values()) job.controller.abort();
    for (const job of stabilizeJobs.values()) job.controller.abort();
    for (const controller of aborters.values()) controller.abort();
    await Promise.all([...services, flowQueue]);
    // The guard and the health log stop with the server; the minute of reports still open is written, since a restart is exactly when the next one is wanted.
    guard.stop(); hostHealth.stop(); removeStartGate(); await reports.flushMinute(Date.now() + REPORT_FLUSH_MS);
    clearInterval(housekeeping); clearInterval(uploadSweep); clearTimeout(presenceTimer); clearTimeout(broadcastTimer); for (const response of subscribers.keys()) response.end(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await queue.drain(); saveBeforeExit(); await store.close(); db.close(); lock.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createFrameLineServer({ hostMonitor: true }); const port = Number(process.env.PORT ?? 4310); const host = process.env.HOST ?? '127.0.0.1';
  app.server.listen(port, host, () => console.log(`SharedCut server listening at http://${host}:${port}`));
  // SIGBREAK is Ctrl+Break and SIGHUP a closed console window on Windows; both still get a clean close.
  let stopping = false; for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, () => { if (!stopping) { stopping = true; void app.close().then(() => process.exit(0), error => { console.error('Shutdown failed:', error); process.exit(1); }); } });
}
