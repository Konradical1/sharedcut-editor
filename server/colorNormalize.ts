import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { interpretation, isHdrTransfer, makeCube } from '../src/services/color.ts';
import { AUTO_LIMITS, MIDTONE_LIMITS, normalizeStages, validAutoBalance, type NormalizeResult, type NormalizeShot, type NormalizeWarningCode } from '../src/services/colorGroups.ts';
import { stateEqual } from '../src/services/stateDelta.ts';
import type { Clip, GradeNode, MediaAsset } from '../src/state/models.ts';
import { ColorAssistantError, colorPython, lastLine, pruneCache, shotSource, WIDTH } from './colorAssistant.ts';
import { hdrTransform, run as runProcess } from './media.ts';
import { GIB } from './hostGuard.ts';

/** Normalize jobs: measure shots with scripts/color-normalize.py and answer each target shot with an automatic Balance. No AI involved. */
const worker = fileURLToPath(new URL('../scripts/color-normalize.py', import.meta.url));
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_SHOTS = 200, MAX_TOTAL = 300, MAX_ACTIVE = 4, KEEP_JOBS = 20, TEXT = 300;
const UNAVAILABLE = 'OpenColorIO is not installed on this server. Run npm run setup:color.';
const WARNINGS = new Set<string>(['display-referred', 'low-confidence', 'clipping', 'lighting-change', 'highlight-guard', 'large-change'] satisfies NormalizeWarningCode[]);
const fail = (status: number, message: string): never => { throw new ColorAssistantError(status, message); };
const available = () => existsSync(colorPython()) && existsSync(worker);

/** 'not-synced': SharedCut Desktop, the shot is not on sharedcut.com as it is here (original still uploading, edit not arrived, other source settings). */
type SkipCode = 'not-video' | 'missing-media' | 'invalid-grade' | 'decode-failed' | 'not-synced';
/** `remote`: measured on sharedcut.com (see NormalizeLink). */
export type NormalizeJob = {
  id: string; projectId: string; status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; stage: string; progress: number; error?: string; createdAt: number; remote?: true;
  skipped: { clipId: string; code: SkipCode; text: string }[];
  result?: NormalizeResult & { failed?: { clipId: string; error: string }[] };
};
type Copy = { clips: Clip[]; nodes: GradeNode[]; media: MediaAsset[] };
/** SharedCut Desktop has no colour worker: Normalize runs on sharedcut.com through its sync link (remoteSync.ts `normalize`). call() errors carry `status` (HTTP) or `offline`. */
export type NormalizeLink = {
  /** Why it cannot run there for this project now (signed out, not synced, offline), as what to do. */
  blocked(projectId: string): string | undefined;
  /** Syncs now; the project as this computer and sharedcut.com then hold it, in this computer's user ids. Throws what to do. */
  synced(projectId: string): Promise<{ here: Copy; there: Copy }>;
  /** The project's color-normalize route there: POST starts one (body), GET and DELETE a job. */
  call(projectId: string, method: 'GET' | 'POST' | 'DELETE', jobId?: string, body?: unknown): Promise<any>;
};
const LATE = 'Its latest edit has not reached sharedcut.com yet. Try again in a moment.', RESTART = 'Interrupted by a server restart. Run it again.', BUSY_TRIES = 12;
type HdrCube = { size: number; data: number[]; min: number[]; max: number[] };
type HdrTable = { cube: HdrCube; hash: string };
/** `interpretation`: the source profile/gamut it is measured through, returned with its balance (NormalizeShot.input). */
type WorkerShot = ReturnType<typeof shotSource> & { clipId: string; input: string; preStages: unknown[]; postStages: unknown[]; setup: string; sdr: boolean; hdrCube?: HdrCube; interpretation: { profile: string; gamut: string } };
type Raw = { shots?: { clipId?: unknown; balance?: Record<string, unknown>; confidence?: unknown; key?: unknown; warnings?: { code?: unknown; text?: unknown }[] }[]; level?: { group?: unknown; target?: unknown } | null; failed?: { clipId?: unknown; error?: unknown }[] };

function parseRequest(body: Record<string, unknown>, projectClipIds: Set<string>) {
  const { clipIds } = body, contextIds = body.contextIds ?? [];
  if (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > MAX_SHOTS) fail(400, `Choose 1 to ${MAX_SHOTS} shots.`);
  if (!Array.isArray(contextIds) || (clipIds as unknown[]).length + contextIds.length > MAX_TOTAL) fail(400, `Normalize reads at most ${MAX_TOTAL} shots at once.`);
  const ids = [...clipIds as unknown[], ...contextIds as unknown[]];
  if (ids.some(id => typeof id !== 'string' || !projectClipIds.has(id))) fail(400, 'A chosen shot is not in this project.');
  if (new Set(ids).size !== ids.length) fail(400, 'A shot is listed twice.');
  if (body.clean !== undefined && typeof body.clean !== 'boolean') fail(400, 'clean must be true or false.');
  return { clipIds: clipIds as string[], contextIds: contextIds as string[], clean: body.clean === true };
}

// ponytail: the 33³ table rides in every HDR shot (~0.8 MB of job JSON each); send one per transfer if HDR-heavy jobs get slow to load.
// The table's own hash goes into the cache key: a change to the tone map (hdrToSdr, not in ENGINE) must not reuse frames mapped by the old one.
const hdrCube = (transfer: string): HdrTable => { const c = makeCube(hdrTransform(transfer)!, 33), cube = { size: c.size, data: Array.from(c.data, v => +v.toFixed(5)), min: c.min, max: c.max }; return { cube, hash: createHash('sha256').update(JSON.stringify(cube)).digest('hex').slice(0, 16) }; };
/** One shot as the worker reads it. Shots of one camera body with the same source settings share a `setup` (white balance and level are pooled per setup). `clean`: measured as the rebuilt grade. */
function workerShot(clip: Clip, asset: MediaAsset, nodes: GradeNode[], input: string, cube: (transfer: string) => HdrTable, clean: boolean): WorkerShot {
  const { pre, post, sdr } = normalizeStages(clip, asset, nodes, { clean }), { profile, gamut } = interpretation(clip, asset), table = isHdrTransfer(asset.colorTransfer) ? cube(asset.colorTransfer!) : undefined;
  const body = asset.colorEvidence?.match(/(?:metadata|notes) \(([^)]+)\)/)?.[1] ?? asset.camera ?? '';
  return { clipId: clip.id, ...shotSource(clip, asset, pre, table && [asset.colorTransfer, table.hash]), input, preStages: pre, postStages: post, setup: JSON.stringify([body, profile, gamut, asset.colorTransfer ?? '']), sdr, ...(table && { hdrCube: table.cube }), interpretation: { profile, gamut } };
}

const clamp = (value: unknown, lo: number, hi: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : undefined;
/** The worker's answer kept to the target shots and to what a Balance node accepts; a target without a usable balance is reported as failed. */
export function cleanResult(raw: Raw, targets: string[]): NonNullable<NormalizeJob['result']> {
  const shots: NormalizeShot[] = [];
  for (const s of Array.isArray(raw?.shots) ? raw.shots : []) {
    const balance = Object.fromEntries([...Object.entries(AUTO_LIMITS), ...Object.entries(MIDTONE_LIMITS).filter(([k]) => s?.balance?.[k] !== undefined)].map(([k, [lo, hi]]) => [k, clamp(s?.balance?.[k], lo, hi)])), key = clamp(s?.key, -20, 20);
    if (typeof s?.clipId !== 'string' || !targets.includes(s.clipId) || shots.some(x => x.clipId === s.clipId) || !validAutoBalance(balance)) continue;
    const warnings = (Array.isArray(s.warnings) ? s.warnings : []).filter(w => WARNINGS.has(w?.code as string) && typeof w.text === 'string').slice(0, 6).map(w => ({ code: w.code as NormalizeWarningCode, text: (w.text as string).slice(0, TEXT) }));
    shots.push({ clipId: s.clipId, balance, confidence: clamp(s.confidence, 0, 1) ?? 0, ...(key !== undefined && { key }), warnings });
  }
  const group = clamp(raw?.level?.group, -20, 20), target = clamp(raw?.level?.target, -20, 20), errors = Array.isArray(raw?.failed) ? raw.failed : [];
  const failed = targets.filter(id => !shots.some(s => s.clipId === id)).map(clipId => ({ clipId, error: String(errors.find(f => f?.clipId === clipId)?.error ?? 'No usable balance came back.').slice(0, TEXT) }));
  return { shots, level: group === undefined || target === undefined ? null : { group, target }, ...(failed.length > 0 && { failed }) };
}

/** The targets sharedcut.com can measure as this computer has them; the rest are skipped with why. `inputs`: the interpretation each is applied through here. */
function remotePlan({ here, there }: { here: Copy; there: Copy }, clipIds: string[], contextIds: string[]) {
  const skipped: NormalizeJob['skipped'] = [], inputs = new Map<string, { profile: string; gamut: string }>();
  const own = (copy: Copy, id: string) => copy.nodes.filter(n => n.clipId === id).sort((a, b) => a.id < b.id ? -1 : 1);
  const targets = clipIds.filter(id => {
    const a = here.clips.find(c => c.id === id), b = there.clips.find(c => c.id === id), local = here.media.find(m => m.id === a?.mediaId), up = there.media.find(m => m.id === b?.mediaId);
    const skip = (text: string) => { skipped.push({ clipId: id, code: 'not-synced', text }); return false; };
    if (!b) return skip('Not on sharedcut.com yet.');
    if (!a || !stateEqual(a, b) || !stateEqual(own(here, id), own(there, id))) return skip(LATE);
    // Stills, titles and adjustment clips: sharedcut.com says so itself.
    if (local?.kind !== 'video') return true;
    if (up?.status !== 'ready') return skip(!up || up.status === 'uploading' ? 'Still uploading to sharedcut.com.' : up.status === 'failed' ? 'sharedcut.com could not prepare this video.' : 'Still being prepared on sharedcut.com.');
    // A balance solved for footage read another way would build the wrong grade here (the store would skip it as changed).
    try { const x = interpretation(a, local), y = interpretation(b, up); if (x.profile !== y.profile || x.gamut !== y.gamut) return skip(local.status !== 'ready' ? 'Still being prepared on this computer.' : `sharedcut.com reads it as ${y.profile} / ${y.gamut}, this computer as ${x.profile} / ${x.gamut}.`); inputs.set(id, x); }
    catch { /* an unreadable setting: sharedcut.com reports it */ }
    return true;
  });
  return { targets, contextIds: contextIds.filter(id => there.clips.some(c => c.id === id)), skipped, inputs };
}
/** What to do about a failed run on sharedcut.com; `started`: its job was already running there. */
function remoteFailure(error: unknown, started: boolean) {
  const { status, offline } = error as { status?: number; offline?: boolean };
  if (offline) return started ? 'Lost the connection to sharedcut.com during Auto balance. Run it again once you are back online.' : "You're offline: Auto balance needs sharedcut.com.";
  if (status === 401) return 'sharedcut.com signed you out: sign in to sharedcut.com again on the Projects page.';
  if (status === 429) return 'sharedcut.com is busy with other Auto balance runs. Try again in a few minutes.';
  if (status === 404 && started) return 'sharedcut.com restarted during Auto balance. Run it again.';
  const text = lastLine(error, 'Auto balance failed on sharedcut.com.');
  return text.includes('sharedcut.com') ? text : `sharedcut.com: ${text}`;
}
/** `work`, given up on once `signal` aborts. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal) => { signal.throwIfAborted(); return Promise.race([work, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]); };

/** `run` is replaceable for tests; the server always uses media.ts run (stderr progress, Windows-safe process-tree cancel). `link`: sharedcut.com, used only while this server has no colour worker. */
export function colorNormalizeService(dataDir: string, run: typeof runProcess = runProcess, link?: () => NormalizeLink | undefined, timing = { everyMs: 1000, graceMs: 60_000, busyMs: 5000 }) {
  const cache = join(dataDir, 'cache', 'color-assistant'), jobs = new Map<string, { job: NormalizeJob; controller: AbortController }>(), remoteRuns = new Set<Promise<void>>();
  // ponytail: one serial queue for the whole server (the worker already uses every core); per-project queues if many people normalize at once.
  let queue = Promise.resolve(), closed = false;
  function finish(job: NormalizeJob, status: 'done' | 'failed' | 'cancelled', error?: string, result?: NormalizeJob['result']) {
    // Results land before the status: the panel stops polling on it.
    Object.assign(job, { result, error, progress: status === 'done' ? 100 : job.progress, stage: { done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }[status] });
    job.status = status;
  }
  function get(projectId: string, id: string): NormalizeJob { const job = jobs.get(id)?.job; return job?.projectId === projectId ? job : fail(404, 'Normalize result not found.'); }
  function create(projectId: string, skipped: NormalizeJob['skipped'], remote?: true) {
    const job: NormalizeJob = { id: randomUUID(), projectId, status: 'waiting', stage: 'Waiting', progress: 0, createdAt: Date.now(), skipped, ...(remote && { remote }) }, controller = new AbortController();
    jobs.set(job.id, { job, controller });
    for (const [id, { job: old }] of jobs) if (jobs.size > KEEP_JOBS && old.status !== 'waiting' && old.status !== 'running') jobs.delete(id);
    return { job, controller };
  }

  // On sharedcut.com: the edit goes up first, targets it cannot measure as they are here are skipped, then its job is followed
  // (this job maps to that one; polling and cancel come here). sharedcut.com keeps its own queue, so this skips the one here.
  async function executeRemote(link: NormalizeLink, job: NormalizeJob, request: ReturnType<typeof parseRequest>, controller: AbortController) {
    const { signal } = controller, { projectId } = job;
    let remoteId: string | undefined;
    try {
      Object.assign(job, { status: 'running', stage: 'Sending the edit to sharedcut.com', progress: 1 });
      let plan = remotePlan(await abortable(link.synced(projectId), signal), request.clipIds, request.contextIds);
      // An edit made while that sync ran goes up with one more.
      if (plan.skipped.some(item => item.text === LATE)) plan = remotePlan(await abortable(link.synced(projectId), signal), request.clipIds, request.contextIds);
      job.skipped = plan.skipped;
      if (!plan.targets.length) throw Error(`None of the chosen shots can be normalized. ${[...new Set(plan.skipped.map(item => item.text))].join(' ')}`);
      const body = { clipIds: plan.targets, ...(plan.contextIds.length > 0 && { contextIds: plan.contextIds }), ...(request.clean && { clean: true }) };
      // Busy there (four runs at once for every account): wait for a place, a minute at most.
      for (let tries = 1; !remoteId; tries++) {
        try { remoteId = String((await link.call(projectId, 'POST', undefined, body)).jobId); }
        catch (error) { if ((error as { status?: number }).status !== 429 || tries >= BUSY_TRIES) throw error; job.stage = 'Waiting for sharedcut.com'; await sleep(timing.busyMs, undefined, { signal }); }
      }
      signal.throwIfAborted();
      for (let heard = Date.now(); ;) {
        await sleep(timing.everyMs, undefined, { signal });
        let there;
        // A dropped connection or the tunnel restarting is waited out for a while; an answer that will not change ends it.
        try { there = await abortable(link.call(projectId, 'GET', remoteId), signal); heard = Date.now(); }
        catch (error) { const { status = 500, offline } = error as { status?: number; offline?: boolean }; if (signal.aborted || !(offline || status >= 500) || Date.now() - heard > timing.graceMs) throw error; continue; }
        job.skipped = [...plan.skipped, ...(Array.isArray(there.skipped) ? there.skipped as NormalizeJob['skipped'] : []).filter(k => plan.targets.includes(k?.clipId) && typeof k.text === 'string').map(k => ({ clipId: k.clipId, code: k.code, text: k.text.replace(/this server/g, 'sharedcut.com').slice(0, TEXT) }))];
        if (there.status === 'waiting' || there.status === 'running') { Object.assign(job, { progress: Math.min(99, Math.max(job.progress, Number(there.progress) || 0)), stage: there.status === 'waiting' ? 'Waiting for sharedcut.com' : `${String(there.stage || 'Measuring shots').slice(0, 60)} on sharedcut.com` }); continue; }
        if (there.status === 'cancelled') { finish(job, 'cancelled'); return; }
        if (there.status !== 'done') throw Error(`sharedcut.com: ${there.error ?? 'Auto balance failed.'}`);
        // As a run here answers: kept to the targets and the Balance limits, each with the interpretation it was measured through.
        const { failed: _, ...result } = cleanResult(there.result ?? {}, plan.targets), sent: { clipId?: string; input?: { profile?: unknown; gamut?: unknown } }[] = Array.isArray(there.result?.shots) ? there.result.shots : [];
        for (const s of result.shots) { const input = sent.find(x => x?.clipId === s.clipId)?.input; s.input = typeof input?.profile === 'string' && typeof input.gamut === 'string' ? { profile: input.profile, gamut: input.gamut } : plan.inputs.get(s.clipId); }
        if (!result.shots.length) throw Error('sharedcut.com could not balance any of the chosen shots.');
        finish(job, 'done', undefined, result); return;
      }
    } catch (error) {
      if (closed) finish(job, 'failed', RESTART);
      else if (signal.aborted) finish(job, 'cancelled');
      else finish(job, 'failed', remoteFailure(error, Boolean(remoteId)));
    } finally {
      // Stopped here: stopped there too, so it does not hold sharedcut.com's queue. A stopping server waits two seconds at most.
      if (remoteId && signal.aborted) await Promise.race([link.call(projectId, 'DELETE', remoteId).catch(() => {}), sleep(2000, undefined, { ref: false })]);
    }
  }

  async function execute(job: NormalizeJob, shots: WorkerShot[], targets: string[], controller: AbortController) {
    const { signal } = controller;
    if (signal.aborted || closed) { if (job.status === 'waiting') finish(job, closed ? 'failed' : 'cancelled', closed ? RESTART : undefined); return; }
    let temporary: string | undefined;
    try {
      if (!available()) throw Error(UNAVAILABLE);
      Object.assign(job, { status: 'running', stage: 'Measuring shots', progress: 1 });
      await pruneCache(cache);
      temporary = await mkdtemp(join(tmpdir(), 'frameline-color-normalize-'));
      const file = join(temporary, 'job.json');
      // One HDR table per transfer, not one per shot: a 300-shot phone timeline would otherwise send hundreds of copies.
      const hdrCubes: Record<string, HdrCube> = {}, sent = shots.map(({ interpretation: _, ...shot }) => { if (!shot.hdrCube) return shot; const name = createHash('sha256').update(JSON.stringify(shot.hdrCube)).digest('hex').slice(0, 16); hdrCubes[name] = shot.hdrCube; return { ...shot, hdrCube: name }; });
      await writeFile(file, JSON.stringify({ ffmpeg: ffmpeg(), cacheDir: cache, width: WIDTH, shots: sent, targets, hdrCubes }));
      // The worker reports 0-60 while measuring and 60-99 while solving, on stderr.
      // The host guard holds the run while memory is short (it keeps about 15 MB of frames per shot, plus the decoders).
      const output = await run(colorPython(), [worker, 'normalize', file], { signal, guard: { kind: 'ai', costBytes: GIB + shots.length * 20 * 1024 ** 2, label: 'Normalize' }, jsonProgress: 'stderr', onProgress: p => { if (!signal.aborted && p > job.progress) Object.assign(job, { progress: Math.min(99, p), stage: p < 60 ? 'Measuring shots' : 'Balancing shots' }); } });
      const result = cleanResult(JSON.parse(output.toString().trim().split('\n').at(-1)!), targets);
      // The store skips a shot whose source interpretation changed while it was measured.
      for (const s of result.shots) s.input = shots.find(x => x.clipId === s.clipId)!.interpretation;
      job.skipped.push(...(result.failed ?? []).map(item => ({ clipId: item.clipId, code: 'decode-failed' as const, text: `Could not read this shot: ${item.error}`.slice(0, TEXT) })));
      if (!result.shots.length) throw Error(`None of the chosen shots could be read. ${result.failed?.[0]?.error ?? ''}`.trim());
      finish(job, 'done', undefined, result);
    } catch (error) {
      if (closed) finish(job, 'failed', RESTART);
      else if (signal.aborted) finish(job, 'cancelled');
      else finish(job, 'failed', lastLine(Error((error as Error).message.replace(/^Media processing failed: /, '')), 'Normalize failed.'));
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
  }

  return {
    /** Validates and snapshots the request (the job never sees later edits; on sharedcut.com, the edit as the sync just took it up); shots that cannot be measured are reported, never guessed at. */
    start(input: { projectId: string; body: Record<string, unknown>; clips: Clip[]; media: MediaAsset[]; nodes: GradeNode[]; source: (assetId: string) => string }) {
      const request = parseRequest(input.body, new Set(input.clips.filter(clip => clip.projectId === input.projectId).map(clip => clip.id)));
      // No colour worker here (SharedCut Desktop): sharedcut.com measures, when this computer is linked to it; if not, say what to do at once.
      const local = available(), there = local ? undefined : link?.(), why = local ? undefined : there ? there.blocked(input.projectId) : UNAVAILABLE;
      if (why) fail(503, why);
      if ([...jobs.values()].filter(({ job }) => job.status === 'waiting' || job.status === 'running').length >= MAX_ACTIVE) fail(429, 'Normalize is busy. Try again when the current run finishes.');
      if (there) { const { job, controller } = create(input.projectId, [], true), task: Promise<void> = executeRemote(there, job, request, controller).finally(() => remoteRuns.delete(task)); remoteRuns.add(task); return { jobId: job.id }; }
      const skipped: NormalizeJob['skipped'] = [], shots: WorkerShot[] = [], cubes = new Map<string, HdrTable>();
      const cube = (transfer: string) => cubes.get(transfer) ?? cubes.set(transfer, hdrCube(transfer)).get(transfer)!;
      for (const id of [...request.clipIds, ...request.contextIds]) {
        // Context shots only steady the group's level and white balance: one that cannot be measured is left out quietly. Only targets are rebuilt, so only they are measured clean.
        const skip = (code: SkipCode, text: string) => { if (request.clipIds.includes(id)) skipped.push({ clipId: id, code, text }); };
        const clip = structuredClone(input.clips.find(item => item.id === id)!), asset = input.media.find(item => item.id === clip.mediaId && item.projectId === clip.projectId);
        // Stills, titles, adjustment clips and compositions have no video asset.
        if (asset?.kind !== 'video') { skip('not-video', 'Only video shots can be normalized.'); continue; }
        if (!existsSync(input.source(asset.id))) { skip('missing-media', 'The original video is not on this server.'); continue; }
        try { shots.push(workerShot(clip, structuredClone(asset), structuredClone(input.nodes.filter(node => node.clipId === id && node.projectId === clip.projectId)), input.source(asset.id), cube, request.clean && request.clipIds.includes(id))); }
        catch (error) { skip('invalid-grade', lastLine(error, 'This grade cannot be read.').slice(0, TEXT)); }
      }
      const { job, controller } = create(input.projectId, skipped), targets = shots.map(shot => shot.clipId).filter(id => request.clipIds.includes(id));
      if (!targets.length) { finish(job, 'failed', `None of the chosen shots can be normalized. ${[...new Set(skipped.map(item => item.text))].join(' ')}`); return { jobId: job.id }; }
      const task = queue.then(() => execute(job, shots, targets, controller));
      queue = task.then(() => {}, () => {});
      return { jobId: job.id };
    },
    get,
    /** Whether Normalize can run for this project now: here, on sharedcut.com (`remote`), or not, with what to do. */
    capabilities(projectId: string): { available: boolean; remote?: true; reason?: string } {
      if (available()) return { available: true };
      const there = link?.(), reason = there ? there.blocked(projectId) : UNAVAILABLE;
      return reason ? { available: false, reason } : { available: true, remote: true };
    },
    latest(projectId: string) { return [...jobs.values()].reverse().find(({ job }) => job.projectId === projectId)?.job ?? null; },
    cancel(projectId: string, id: string) { const job = get(projectId, id); jobs.get(id)!.controller.abort(); if (job.status === 'waiting') finish(job, 'cancelled'); },
    /** Drops a purged project's jobs; one in flight is aborted first. */
    purge(projectId: string) { for (const [id, { job, controller }] of jobs) if (job.projectId === projectId) { controller.abort(); jobs.delete(id); } },
    /** Stops every job; resolves once the one in flight has let go of its worker and runs on sharedcut.com were told to stop. */
    close() { closed = true; for (const { controller } of jobs.values()) controller.abort(); return Promise.all([queue, ...remoteRuns]).then(() => {}); },
  };
}
