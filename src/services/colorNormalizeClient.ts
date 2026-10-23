import { api, connection } from './api.ts';
import type { NormalizeResult } from './colorGroups.ts';

/** `clean`: the targets are measured as the rebuilt grade normalizeColorGroup applies with clean (send the same value to both). */
export type NormalizeRequest = { clipIds: string[]; contextIds?: string[]; clean?: boolean };
/** Shots the server did not measure: 'not-video', 'missing-media', 'invalid-grade', 'decode-failed', 'not-synced' (SharedCut Desktop: not on sharedcut.com as it is here). */
export type NormalizeSkip = { clipId: string; code: 'not-video' | 'missing-media' | 'invalid-grade' | 'decode-failed' | 'not-synced' | (string & {}); text: string };
/** `remote`: SharedCut Desktop measured it on sharedcut.com. */
export interface NormalizeJob {
  id: string; projectId: string; status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; stage: string; progress: number; error?: string; createdAt: number; remote?: boolean;
  skipped: NormalizeSkip[]; result?: NormalizeResult & { failed?: { clipId: string; error: string }[] };
}
/** Whether Normalize can run for a project now: on its server, on sharedcut.com (`remote`, SharedCut Desktop), or not, with what to do. */
export type NormalizeCapabilities = { available: boolean; remote?: boolean; reason?: string };

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/color-normalize`;
/** The server measures the saved grade, so unsaved edits are flushed first. */
export async function startNormalize(projectId: string, request: NormalizeRequest) {
  await connection.flush();
  return (await api<{ jobId: string }>(base(projectId), { method: 'POST', body: JSON.stringify(request) })).jobId;
}
export const normalizeJob = (projectId: string, jobId: string) => api<NormalizeJob>(`${base(projectId)}/${encodeURIComponent(jobId)}`);
export const latestNormalizeJob = (projectId: string) => api<NormalizeJob | null>(base(projectId));
export const cancelNormalize = (projectId: string, jobId: string) => api(`${base(projectId)}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
/** null when the server cannot be asked; starting then says why. */
export const normalizeCapabilities = (projectId: string) => api<NormalizeCapabilities>(`${base(projectId)}/capabilities`).catch(() => null);
