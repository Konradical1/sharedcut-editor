import { useSyncExternalStore } from 'react';

/** Per-clip background work (Stabilize, optical flow, Smart Mask) so the timeline can show it on the clip itself. */
export type ClipActivity = { kind: string; status: 'preparing' | 'ready' | 'failed'; progress: number; error?: string };
const activities = new Map<string, Map<string, ClipActivity>>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };

export function setClipActivity(clipId: string, kind: string, activity: ClipActivity | undefined) {
  const current = activities.get(clipId) ?? new Map<string, ClipActivity>();
  const previous = current.get(kind);
  if (JSON.stringify(previous) === JSON.stringify(activity)) return;
  if (activity) current.set(kind, activity); else current.delete(kind);
  if (current.size) activities.set(clipId, current); else activities.delete(clipId);
  notify();
}
/** The activity worth showing: anything preparing first, then a failure. Ready work stays quiet. */
export function clipActivity(clipId: string): ClipActivity | undefined {
  const current = activities.get(clipId);
  if (!current) return undefined;
  const list = [...current.values()];
  return list.find(a => a.status === 'preparing') ?? list.find(a => a.status === 'failed');
}
export function useClipActivity(clipId: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => { void version; return clipActivity(clipId); }, () => undefined);
}

if (typeof window !== 'undefined') {
  const fromEvent = (kind: string) => (event: Event) => {
    const detail = (event as CustomEvent).detail as { clipId: string; status?: string; progress?: number; error?: string };
    if (!detail?.clipId) return;
    const status = detail.status === 'ready' ? 'ready' : detail.status === 'failed' ? 'failed' : 'preparing';
    setClipActivity(detail.clipId, kind, { kind, status, progress: Math.round(detail.progress ?? 0), error: detail.error });
  };
  window.addEventListener('frameline:stabilize', fromEvent('Stabilize'));
  window.addEventListener('frameline:optical-flow', fromEvent('Optical flow'));
}

type MaskJobs = Record<string, { status: string; progress?: number; error?: string }>;
let watchingMasks = false;
/** Called once from the timeline (browser only): Smart Mask jobs live in their own zustand store. */
export function watchSmartMaskJobs(store: { subscribe: (listener: (state: { jobs: MaskJobs }) => void) => unknown }) {
  if (watchingMasks) return; watchingMasks = true;
  store.subscribe(state => {
    for (const [id, job] of Object.entries(state.jobs)) {
      const clipId = id.split(':')[0];
      const status = job.status === 'ready' || job.status === 'cancelled' ? 'ready' : job.status === 'failed' ? 'failed' : 'preparing';
      setClipActivity(clipId, 'Smart Mask', { kind: 'Smart Mask', status, progress: Math.round(job.progress ?? 0), error: job.error });
    }
  });
}
