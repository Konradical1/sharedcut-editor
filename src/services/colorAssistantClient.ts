import { api, connection } from './api.ts';
import type { AssistantMode, BalanceValues, Eligibility, LookOption, ShotNote } from './colorAssistant.ts';

export type AssistantCapabilities = { available: boolean; reason?: string; model?: string; provider?: string };
export type AssistantRequest = { mode: AssistantMode; clipIds: string[]; referenceClipId?: string; prompt?: string };
/** Eligibility codes, plus the server's own ('missing-media', 'invalid-grade'). */
export type AssistantSkip = { clipId: string; code: Extract<Eligibility, { ok: false }>['code'] | (string & {}); text: string };
export interface AssistantJob {
  id: string; projectId: string; mode: AssistantMode; status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; stage: string; progress: number; error?: string; createdAt: number;
  request: AssistantRequest; skipped: AssistantSkip[];
  /** shots: per-shot notes; balance = the Balance node it sets (Three looks: absent = the shot keeps its own). */
  result?: { looks?: LookOption[]; shots?: (ShotNote & { balance?: BalanceValues })[]; stills: { clipId: string; frame: number; before: string; after: (string | null)[] }[] };
}

/** Not cached: the answer depends on the signed-in account, and signing out does not reload the page. */
export const assistantCapabilities = () => api<AssistantCapabilities>('/color-assistant/capabilities').catch(error => ({ available: false, reason: (error as Error).message }) as AssistantCapabilities);
const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/color-assistant`;
/** The server reads the saved grade, so unsaved edits are flushed first. */
export async function startAssistant(projectId: string, request: AssistantRequest) {
  await connection.flush();
  return (await api<{ jobId: string }>(base(projectId), { method: 'POST', body: JSON.stringify(request) })).jobId;
}
export const assistantJob = (projectId: string, jobId: string) => api<AssistantJob>(`${base(projectId)}/${encodeURIComponent(jobId)}`);
export const latestAssistantJob = (projectId: string) => api<AssistantJob | null>(base(projectId));
export const cancelAssistant = (projectId: string, jobId: string) => api(`${base(projectId)}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
