// Whether this account may open the Health page. The server answers GET /api/health/report only for accounts the owner
// listed and gives everyone else 404, so the answer to one request decides if the entry is shown.
import { api, ApiError } from './api.ts';

/** "Not for you" answers: remembered for the session. Anything else (an outage, a restart, a signed-out tab) is asked again. */
const FINAL_REFUSALS = [403, 404];
let cache: { userId: string; answer: Promise<boolean> } | null = null;

/** True when the account can read the Health summary. Asked once per account per session; a failure that says nothing is not remembered. */
export function healthAvailable(userId: string, ask: () => Promise<unknown> = () => api('/health/report')): Promise<boolean> {
  if (cache?.userId === userId) return cache.answer;
  // Started from a promise so an ask that throws at once is an answer of no, and `entry` exists before any answer arrives.
  const entry = { userId, answer: Promise.resolve().then(ask).then(() => true, (error: unknown) => {
    if (!(error instanceof ApiError && FINAL_REFUSALS.includes(error.status)) && cache === entry) cache = null;
    return false;
  }) };
  cache = entry;
  return entry.answer;
}

/** Forgets the remembered answer (a test, or a sign-in on the same tab). */
export function forgetHealthAccess(): void { cache = null; }
