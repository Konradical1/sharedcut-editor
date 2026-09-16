import { api, ApiError } from './api.ts';

const CHUNK = 8 * 1024 * 1024;
const ATTEMPTS = 5;

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

const checksum = async (data: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).map(byte => byte.toString(16).padStart(2, '0')).join('');

// 409 means the server moved our offset (a retried chunk that actually landed, or a competing writer);
// both are recoverable by re-reading the authoritative offset rather than failing the upload.
const recoverable = (error: unknown) =>
  !(error instanceof ApiError) || error.status === 409 || error.status === 429 || error.status >= 500;

export async function uploadSource(assetId: string, file: File, onProgress: (percent: number) => void = () => {}, signal?: AbortSignal) {
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
  const started = await api<UploadState>(`/media/${assetId}/upload`, { method: 'POST', body: JSON.stringify({ size: file.size, fingerprint }), signal });
  if (started.complete) { onProgress(100); return; }
  // Browser codecs are optional: the server extracts a still before proxy processing as fallback.
  await uploadThumbnail(assetId, file, signal).catch(() => {});

  let offset = started.offset || 0, stalled = 0;
  onProgress(Math.floor(offset / file.size * 100));

  while (offset < file.size) {
    signal?.throwIfAborted();
    const before = offset;
    const data = await file.slice(offset, offset + CHUNK).arrayBuffer();
    const digest = await checksum(data);

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        ({ offset } = await api<UploadState>(`/media/${assetId}/upload`, { method: 'PUT', headers: { 'Upload-Offset': String(offset), 'Upload-Checksum': digest }, body: data, signal }));
        break;
      } catch (error) {
        if (attempt === ATTEMPTS || !recoverable(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(8000, 250 * 2 ** attempt)));
        signal?.throwIfAborted();
        const current = await api<UploadState>(`/media/${assetId}/upload`, { signal }).catch(() => null);
        if (current?.complete) { onProgress(100); return; }
        if (current && current.offset !== offset) { offset = current.offset; break; }
      }
    }

    // Guard against a server that keeps accepting retries without advancing; otherwise this loops forever.
    if (offset === before && ++stalled >= ATTEMPTS) throw new Error('Upload stalled: the server stopped accepting new data.');
    if (offset !== before) stalled = 0;
    onProgress(Math.floor(offset / file.size * 100));
  }
}
