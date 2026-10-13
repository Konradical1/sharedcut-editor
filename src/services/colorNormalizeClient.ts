import { api, connection } from './api.ts';
import type { NormalizeResult } from './colorGroups.ts';

/** `clean`: the targets are measured as the rebuilt grade normalizeColorGroup applies with clean (send the same value to both). */
export type NormalizeRequest = { clipIds: string[]; contextIds?: string[]; clean?: boolean };
/** Shots the server did not measure: 'not-video', 'missing-media', 'invalid-grade', 'decode-failed'. */
export type NormalizeSkip = { clipId: string; code: 'not-video' | 'missing-media' | 'invalid-grade' | 'decode-failed' | (string & {}); text: string };
export interface NormalizeJob {
  id: string; projectId: string; status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; stage: string; progress: number; error?: string; createdAt: number;
  skipped: NormalizeSkip[]; result?: NormalizeResult & { failed?: { clipId: string; error: string }[] };
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/color-normalize`;
/** The server measures the saved grade, so unsaved edits are flushed first. */
export async function startNormalize(projectId: string, request: NormalizeRequest) {
  await connection.flush();
  return (await api<{ jobId: string }>(base(projectId), { method: 'POST', body: JSON.stringify(request) })).jobId;
}
export const normalizeJob = (projectId: string, jobId: string) => api<NormalizeJob>(`${base(projectId)}/${encodeURIComponent(jobId)}`);
export const latestNormalizeJob = (projectId: string) => api<NormalizeJob | null>(base(projectId));
export const cancelNormalize = (projectId: string, jobId: string) => api(`${base(projectId)}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
