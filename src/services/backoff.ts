/**
 * How long to wait before retry number `attempt` (0 is the first): the wait doubles from `baseMs` and stops at `maxMs`.
 * Jitter only shortens it, by up to `jitter` of itself, so many tabs that lost the server together do not all come
 * back in the same instant and `maxMs` stays a hard ceiling.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, jitter = 0.25, random: () => number = Math.random): number {
  const steps = attempt > 0 ? attempt : 0;
  return Math.round(Math.min(maxMs, baseMs * 2 ** steps) * (1 - jitter * random()));
}
