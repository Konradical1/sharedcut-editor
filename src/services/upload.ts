import { api, ApiError } from './api.ts';
import { createStore } from 'zustand/vanilla';
import { connection } from './api.ts';
import { estimateSeconds } from './importer.ts';
import type { MediaAsset } from '../state/models.ts';

const CHUNK = 8 * 1024 * 1024;
const ATTEMPTS = 5;
const requestSignal = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);

// Send a small still before the original so every editor sees the actual footage during upload.
async function uploadThumbnail(assetId: string, file: File, signal?: AbortSignal) {
  const video = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
  if (!video && !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file), element = document.createElement(video ? 'video' : 'img');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Preview decode timed out')), 5000);
      element.onerror = () => reject(new Error('Preview is not supported by this browser'));
      if (element instanceof HTMLVideoElement) { element.muted = true; element.preload = 'auto'; element.onloadeddata = () => resolve(); }
      else element.onload = () => resolve();
      element.src = url;
    });
    const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
    const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
    if (!width || !height) return;
    const canvas = document.createElement('canvas'), scale = Math.min(1, 480 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d')!.drawImage(element, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .8));
    if (blob) await api(`/media/${assetId}/thumbnail`, { method: 'PUT', body: blob, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]) });
  } finally {
    clearTimeout(timeout); element.removeAttribute('src');
    if (element instanceof HTMLVideoElement) element.load();
    URL.revokeObjectURL(url);
  }
}

type UploadState = { offset: number; complete: boolean };
/** How the server tells one copy of a file from another: an upload resumes only into the same name, size and date. */
export const fingerprintOf = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

export async function findUnfinishedUpload(file: File, assets: MediaAsset[], signal?: AbortSignal) {
  for (const asset of assets.filter(asset => asset.name === file.name && asset.status === 'uploading')) {
    const current = await api<UploadState & { metadata?: { fingerprint: string } }>(`/media/${asset.id}/upload`, { signal: requestSignal(signal) });
    if (!current.complete && current.metadata?.fingerprint === fingerprintOf(file)) return asset.id;
  }
}

const checksum = async (data: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).map(byte => byte.toString(16).padStart(2, '0')).join('');

// 409 means the server moved our offset (a retried chunk that actually landed, or a competing writer);
// both are recoverable by re-reading the authoritative offset rather than failing the upload.
export const recoverable = (error: unknown) =>
  !(error instanceof ApiError) || error.status === 409 || error.status === 429 || error.status >= 500;

export async function uploadSource(assetId: string, file: File, onProgress: (percent: number) => void = () => {}, signal?: AbortSignal, onTransfer: (detail: TransferProgress) => void = () => {}) {
  const began = Date.now();
  let initialOffset = 0, accepted = 0, message = 'Connecting', lastBytes = 0, lastActivity = began;
  const report = () => {
    if (accepted !== lastBytes) { lastActivity = Date.now(); lastBytes = accepted; }
    const waiting = (Date.now() - lastActivity) / 1000;
    const elapsed = (Date.now() - began) / 1000, speed = elapsed > 0 ? (accepted - initialOffset) / elapsed : 0;
    onTransfer({ resumedBytes: initialOffset, bytes: accepted, total: file.size, speed, elapsed, remaining: speed > 0 ? (file.size - accepted) / speed : undefined, message: message === 'Uploading' && waiting >= 10 ? `Waiting for server · ${Math.floor(waiting)}s without progress` : message });
  };
  report();
  const heartbeat = setInterval(report, 1000);
  try {
    const fingerprint = fingerprintOf(file);
    const started = await api<UploadState>(`/media/${assetId}/upload`, { method: 'POST', body: JSON.stringify({ size: file.size, fingerprint }), signal: requestSignal(signal) });
    if (started.complete) { accepted = file.size; message = 'Uploaded'; report(); onProgress(100); return; }
    initialOffset = accepted = started.offset || 0; message = 'Uploading'; report();
    // Browser codecs are optional: the server extracts a still before proxy processing as fallback.
    // A camera codec that cannot produce a thumbnail must not delay the original.
    void uploadThumbnail(assetId, file, signal).catch(() => {});

    let offset = started.offset || 0, stalled = 0;
    onProgress(Math.floor(offset / file.size * 100));

    while (offset < file.size) {
      signal?.throwIfAborted();
      const before = offset;
      const data = await file.slice(offset, offset + CHUNK).arrayBuffer();
      const digest = await checksum(data);

      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          ({ offset } = await api<UploadState>(`/media/${assetId}/upload`, { method: 'PUT', headers: { 'Upload-Offset': String(offset), 'Upload-Checksum': digest }, body: data, signal: requestSignal(signal) }));
          break;
        } catch (error) {
          signal?.throwIfAborted();
          if (attempt === ATTEMPTS || !recoverable(error)) throw error;
          message = `Connection interrupted · retry ${attempt}/${ATTEMPTS - 1}`; report();
          await new Promise(resolve => setTimeout(resolve, Math.min(8000, 250 * 2 ** attempt)));
          signal?.throwIfAborted();
          const current = await api<UploadState>(`/media/${assetId}/upload`, { signal: requestSignal(signal) }).catch(() => null);
          if (current?.complete) { accepted = file.size; message = 'Uploaded'; report(); onProgress(100); return; }
          if (current && current.offset !== offset) { offset = current.offset; break; }
        }
      }

      // Guard against a server that keeps accepting retries without advancing; otherwise this loops forever.
      if (offset === before && ++stalled >= ATTEMPTS) throw new Error('Upload stalled: the server stopped accepting new data.');
      if (offset !== before) stalled = 0;
      accepted = offset; message = offset === file.size ? 'Uploaded' : 'Uploading'; report();
      onProgress(Math.floor(offset / file.size * 100));
    }
  } finally { clearInterval(heartbeat); }
}


export const bytes = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.ceil(value / 1e3)} KB`;

export type TransferProgress = { resumedBytes?: number; bytes: number; total: number; speed: number; elapsed: number; remaining?: number; message: string };
export type UploadJob = { key: string; projectId: string; name: string; file?: File; assetId?: string; status: 'queued' | 'uploading' | 'paused' | 'failed' | 'uploaded'; progress: TransferProgress; error?: string; candidates: MediaAsset[] };
// Files and per-chunk progress belong to this browser, never the collaborative project snapshot.
export const uploadQueue = createStore<{ jobs: UploadJob[] }>(() => ({ jobs: [] }));
const controllers = new Map<string, AbortController>();
let queueEpoch = 0;
const patchJob = (key: string, patch: Partial<UploadJob>) => uploadQueue.setState(state => ({ jobs: state.jobs.map(job => job.key === key ? { ...job, ...patch } : job) }));

/** `assetId` uploads into that existing media (a replacement) instead of creating one. */
export function enqueueUploads(projectId: string, files: File[], candidates: MediaAsset[], assetId?: string) {
  const jobs = [...uploadQueue.getState().jobs];
  for (const file of files) {
    const key = `${projectId}:${fingerprintOf(file)}${assetId ? `:${assetId}` : ''}`;
    const existing = jobs.find(job => job.key === key);
    if (existing && !(assetId && existing.status === 'uploaded')) { if (['paused', 'failed'].includes(existing.status)) { existing.status = 'queued'; existing.error = undefined; existing.file = file; } continue; }
    if (existing) jobs.splice(jobs.indexOf(existing), 1);
    jobs.push({ key, projectId, name: file.name, file, candidates, assetId, status: 'queued', progress: { bytes: 0, total: file.size, speed: 0, elapsed: 0, message: 'Queued' } });
  }
  uploadQueue.setState({ jobs: [...jobs] });
  pumpUploads();
}

export function resetUploads() {
  queueEpoch++;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  uploadQueue.setState({ jobs: [] });
}
export function pauseUpload(key: string) {
  patchJob(key, { status: 'paused' });
  controllers.get(key)?.abort();
}
export function resumeUpload(key: string) {
  if (controllers.has(key)) {
    const controller = controllers.get(key)!;
    if (controller.signal.aborted) patchJob(key, { status: 'queued', error: undefined });
    return;
  }
  patchJob(key, { status: 'queued', error: undefined }); pumpUploads();
}
export function dismissUpload(key: string) {
  const job = uploadQueue.getState().jobs.find(job => job.key === key);
  if (!job || controllers.has(key) || !['uploaded', 'paused', 'failed'].includes(job.status)) return;
  uploadQueue.setState(state => ({ jobs: state.jobs.filter(job => job.key !== key) }));
}
function pumpUploads() {
  // Two independent files keep a stalled request from blocking an entire selection; chunks stay ordered.
  for (const job of uploadQueue.getState().jobs) {
    if (controllers.size >= 2) break;
    if (job.status !== 'queued' || !job.file || controllers.has(job.key)) continue;
    const epoch = queueEpoch;
    const update = (patch: Partial<UploadJob>) => { if (epoch === queueEpoch) patchJob(job.key, patch); };
    const controller = new AbortController(); controllers.set(job.key, controller);
    update({ status: 'uploading' });
    void (async () => {
      try {
        await connection.flush(); controller.signal.throwIfAborted();
        let id = job.assetId ?? await findUnfinishedUpload(job.file!, job.candidates.filter(asset => asset.projectId === job.projectId), controller.signal);
        controller.signal.throwIfAborted();
        let create = !id;
        if (job.assetId) {
          try { await api(`/media/${job.assetId}/upload`, { signal: requestSignal(controller.signal) }); }
          catch (error) { if (error instanceof ApiError && error.status === 404) create = true; else throw error; }
        }
        id ??= `media-${crypto.randomUUID()}`;
        update({ assetId: id });
        if (create) {
          await api(`/media?${new URLSearchParams({ projectId: job.projectId, id, name: job.name, placeholder: '1' })}`, { method: 'POST', signal: requestSignal(controller.signal) });
        }
        update({ assetId: id });
        await connection.refresh(); controller.signal.throwIfAborted();
        await uploadSource(id, job.file!, () => {}, controller.signal, progress => update({ progress }));
        update({ status: 'uploaded', file: undefined, candidates: [] });
        await connection.refresh().catch(() => {});
      } catch (error) {
        update({ status: controller.signal.aborted ? (uploadQueue.getState().jobs.find(item => item.key === job.key)?.status === 'queued' ? 'queued' : 'paused') : 'failed', error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : 'Upload failed' });
      } finally { if (controllers.get(job.key) === controller) controllers.delete(job.key); pumpUploads(); }
    })();
  }
}

/**
 * A Final Cut import's upload as it stands. `bytes` counts what the server has (resumed bytes too); `rate` is the
 * rolling 20 s rate of newly acknowledged bytes and `eta` the seconds left at it. `sending` holds each lane's file id,
 * `received` each planned file's bytes. `waiting`: for the network, for the server to answer, or for room on its disk.
 */
export type ImportProgress = {
  bytes: number; total: number; rate: number; eta?: number; files: number; sent: number; lanes: number;
  waiting?: 'offline' | 'server' | 'full'; failed: { id: string; reason: string }[]; sending: (string | undefined)[]; received: Record<string, number>;
};
// A wait that ends early, rejecting, when the import stops.
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
});
const unreadable = (error: unknown) => error instanceof DOMException && (error.name === 'NotReadableError' || error.name === 'NotFoundError');

/**
 * Plans a Final Cut import's files, then uploads them `lanes` at a time, largest first; the server keeps the project's
 * import card current. The plan's refusal (507 no room, 403, 400) throws before a byte moves. Network drops, timeouts and
 * server errors wait for the connection and retry without limit; a 507 holds every lane until the server has room; a
 * file the server refuses or that can no longer be read ('unreadable') is left out and the rest go on; a 401 stops
 * everything and throws. Aborting `signal` stops it (it throws the abort); calling it again continues from the server.
 */
export async function uploadImport(projectId: string, items: { assetId: string; file: File }[],
  { lanes = 4, signal, onProgress = () => {} }: { lanes?: number; signal?: AbortSignal; onProgress?: (p: ImportProgress) => void } = {}): Promise<ImportProgress> {
  const stop = new AbortController(), abort = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
  const failed: ImportProgress['failed'] = items.filter(i => !i.file.size).map(i => ({ id: i.assetId, reason: 'The file is empty.' }));
  const files = items.filter(i => i.file.size > 0), received = new Map(files.map(i => [i.assetId, 0]));
  let width = Math.max(1, lanes), reaching: Promise<void> | undefined, offline: 'offline' | 'server' | undefined, full: Promise<void> | undefined, fatal: unknown;
  const sending: (string | undefined)[] = [], fresh = Array<number>(width).fill(0), samples: { at: number; fresh: number[] }[] = [];
  const progress = (): ImportProgress => {
    const sum = (values: Iterable<number>) => { let total = 0; for (const v of values) total += v; return total; };
    const first = samples[0], span = first ? (samples.at(-1)!.at - first.at) / 1000 : 0;
    const rate = span > 0 ? (sum(fresh) - sum(first.fresh)) / span : 0, single = span > 0 ? Math.max(...fresh.map((f, i) => (f - first.fresh[i]) / span)) : 0;
    const left = files.filter(i => !failed.some(f => f.id === i.assetId)).map(i => i.file.size - received.get(i.assetId)!);
    // waiting: the browser knows the Wi-Fi is gone before a chunk's own retries give up, so that shows at once.
    return { bytes: sum(received.values()), total: sum(files.map(i => i.file.size)), rate, eta: rate > 0 ? estimateSeconds(left, single || rate, rate, width) : undefined, files: files.length,
      sent: files.filter(i => received.get(i.assetId) === i.file.size).length, lanes: width, waiting: offline ?? (globalThis.navigator?.onLine === false ? 'offline' : full ? 'full' : undefined), failed: [...failed], sending: [...sending], received: Object.fromEntries(received) };
  };
  if (!files.length) return progress();

  // One gate for every lane: wait for the network, then for any answer from the server (a 503 for low disk is one).
  const reachable = () => reaching ??= (async () => {
    try {
      if (globalThis.navigator?.onLine === false) {
        offline = 'offline';
        await new Promise((resolve, reject) => { addEventListener('online', resolve, { once: true }); abort.addEventListener('abort', () => reject(abort.reason), { once: true }); });
      }
      offline = 'server';
      while (!await fetch('/api/health', { signal: AbortSignal.any([abort, AbortSignal.timeout(10_000)]) }).then(() => true, () => false)) await wait(5000, abort);
    } finally { reaching = offline = undefined; }
  })();
  // Network errors, timeouts, 408, 429 and 5xx other than 507 (and 409 for a file, whose next POST re-syncs the offset):
  // back off 1 s doubling to 30 s, ±20%, starting over whenever the file moved. No limit: Pause, or the job, stops it.
  const retry = async <T>(attempt: () => Promise<T>, conflict: boolean, moved = () => false): Promise<T> => {
    for (let n = 0; ; n++) {
      try { return await attempt(); }
      catch (error) {
        if (abort.aborted || unreadable(error) || (error instanceof ApiError && !([408, 429].includes(error.status) || (conflict && error.status === 409) || (error.status >= 500 && error.status !== 507)))) throw error;
        // A request that ran out of time: the link is carrying too many at once.
        if (error instanceof DOMException && error.name === 'TimeoutError') width = Math.max(1, width - 1);
        if (moved()) n = 0;
        await reachable();
        await wait(Math.min(30_000, 1000 * 2 ** n) * (.8 + .4 * Math.random()), abort);
      }
    }
  };
  // 507: the server is out of room. Every lane waits while one init POST a minute asks again.
  const roomGate = ({ assetId, file }: typeof files[number]) => (async () => {
    try {
      for (;;) {
        await wait(60_000, abort);
        try { await api(`/media/${assetId}/upload`, { method: 'POST', body: JSON.stringify({ size: file.size, fingerprint: fingerprintOf(file) }), signal: requestSignal(abort) }); return; }
        catch (error) { if (!(error instanceof ApiError && error.status === 507)) return; }
      }
    } finally { full = undefined; }
  })();

  const plan = await retry(() => api<{ files: { id: string; received: number; complete: boolean }[] }>(`/fcp/import/${encodeURIComponent(projectId)}`,
    { method: 'PUT', body: JSON.stringify({ files: files.map(({ assetId, file }) => ({ id: assetId, size: file.size, fingerprint: fingerprintOf(file) })) }), signal: requestSignal(abort) }), false);
  for (const f of plan.files) if (received.has(f.id)) received.set(f.id, f.complete ? files.find(i => i.assetId === f.id)!.file.size : f.received);
  // Largest first, so one giant clip never runs alone at the end.
  const queue = files.filter(i => received.get(i.assetId)! < i.file.size).sort((a, b) => (b.file.size - received.get(b.assetId)!) - (a.file.size - received.get(a.assetId)!));

  const send = async (item: typeof files[number], lane: number) => {
    const id = item.assetId;
    let mark = received.get(id)!;
    const moved = () => { const now = received.get(id)!, yes = now > mark; mark = now; return yes; };
    try {
      await retry(async () => {
        for (;;) {
          await full;
          try {
            return await uploadSource(id, item.file, undefined, abort, transfer => {
              // Only newly acknowledged bytes count toward the rate: a resumed 4 GB offset is not speed.
              const seen = Math.max(received.get(id)!, transfer.resumedBytes ?? 0);
              if (transfer.bytes > seen) fresh[lane] += transfer.bytes - seen;
              received.set(id, Math.max(received.get(id)!, transfer.bytes));
            });
          } catch (error) { if (abort.aborted || !(error instanceof ApiError && error.status === 507)) throw error; full ??= roomGate(item); }
        }
      }, true, moved);
    } catch (error) {
      if (abort.aborted) return;
      if (error instanceof ApiError && error.status === 401) { fatal = error; stop.abort(error); return; }
      failed.push({ id, reason: unreadable(error) ? 'unreadable' : error instanceof Error ? error.message : 'Upload failed' });
    }
  };
  const lane = async (index: number) => {
    // A lane past `width` (lowered after a timeout) ends once its file is done.
    for (let item; index < width && !abort.aborted && (item = queue.shift());) { sending[index] = item.assetId; await send(item, index); sending[index] = undefined; }
  };

  const tick = () => { samples.push({ at: Date.now(), fresh: [...fresh] }); if (samples.length > 21) samples.shift(); onProgress(progress()); };
  tick();
  const ticker = setInterval(tick, 1000);
  try { await Promise.all(Array.from({ length: Math.min(width, queue.length) }, (_, i) => lane(i))); }
  finally { clearInterval(ticker); }
  tick();
  if (fatal) throw fatal;
  signal?.throwIfAborted();
  return progress();
}
