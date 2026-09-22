import { api, ApiError } from './api.ts';
import { createStore } from 'zustand/vanilla';
import { connection } from './api.ts';
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
const fingerprintOf = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

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
const recoverable = (error: unknown) =>
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


export type TransferProgress = { resumedBytes?: number; bytes: number; total: number; speed: number; elapsed: number; remaining?: number; message: string };
export type UploadJob = { key: string; projectId: string; name: string; file?: File; assetId?: string; status: 'queued' | 'uploading' | 'paused' | 'failed' | 'uploaded'; progress: TransferProgress; error?: string; candidates: MediaAsset[] };
// Files and per-chunk progress belong to this browser, never the collaborative project snapshot.
export const uploadQueue = createStore<{ jobs: UploadJob[] }>(() => ({ jobs: [] }));
const controllers = new Map<string, AbortController>();
let queueEpoch = 0;
const patchJob = (key: string, patch: Partial<UploadJob>) => uploadQueue.setState(state => ({ jobs: state.jobs.map(job => job.key === key ? { ...job, ...patch } : job) }));

export function enqueueUploads(projectId: string, files: File[], candidates: MediaAsset[]) {
  const jobs = [...uploadQueue.getState().jobs];
  for (const file of files) {
    const key = `${projectId}:${fingerprintOf(file)}`;
    const existing = jobs.find(job => job.key === key);
    if (existing) { if (['paused', 'failed'].includes(existing.status)) { existing.status = 'queued'; existing.error = undefined; existing.file = file; } continue; }
    jobs.push({ key, projectId, name: file.name, file, candidates, status: 'queued', progress: { bytes: 0, total: file.size, speed: 0, elapsed: 0, message: 'Queued' } });
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
