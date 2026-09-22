import { api, connection } from './api.ts';
import type { StabilizePreview, StabilizeRange, StabilizeSettings } from './stabilize.ts';
import type { Clip } from '../state/models.ts';

/** One camera-path solve per clip, polled while the analysis runs.
 *  The warp itself happens on the editor's GPU, so there is nothing per section to render, transfer or decode. */
export function createStabilizePreview(changed: () => void) {
  type Entry = { value?: StabilizePreview; timer?: ReturnType<typeof setTimeout>; busy: boolean; controller: AbortController; signature: string; poll: () => void };
  const entries = new Map<string, Entry>();
  let disposed = false;
  const cancel = (id: string, entry: Entry) => { clearTimeout(entry.timer); entry.controller.abort(); entries.delete(id); };
  return {
    /** The solve for this clip, or its progress while the analysis runs. Undefined until the first reply. */
    get(clip: Clip, range: StabilizeRange, settings: StabilizeSettings, fps: number): StabilizePreview | undefined {
      if (disposed || !connection.enabled) return undefined;
      const signature = JSON.stringify([clip.mediaId, settings, range, fps]);
      let entry = entries.get(clip.id);
      // Settings moved or the clip was retrimmed: the solve in flight is for a range nobody is watching.
      if (entry && entry.signature !== signature) { cancel(clip.id, entry); entry = undefined; }
      if (!entry) {
        const controller = new AbortController();
        const created: Entry = { controller, signature, busy: false, poll: () => {} };
        created.poll = async () => {
          created.timer = undefined;
          if (disposed || created.busy || controller.signal.aborted) return;
          created.busy = true;
          try {
            await connection.flush();
            if (controller.signal.aborted) return;
            created.value = await api<StabilizePreview>('/stabilize', { method: 'POST', body: JSON.stringify({ clipId: clip.id, fps, settings }), signal: controller.signal });
            changed();
            if (created.value.status === 'preparing') created.timer = setTimeout(created.poll, 750);
          } catch (error) {
            if (controller.signal.aborted) return;
            created.value = { status: 'failed', key: '', progress: 0, error: (error as Error).message }; changed();
          } finally { created.busy = false; }
        };
        created.timer = setTimeout(created.poll, 0);
        entries.set(clip.id, created); entry = created;
        while (entries.size > 16) { const oldest = entries.entries().next().value!; cancel(...oldest); }
      }
      // A failed solve is worth one retry when the editor comes back to the clip; a ready one is final.
      if (!entry.timer && !entry.busy && entry.value?.status === 'failed') entry.timer = setTimeout(entry.poll, 2000);
      return entry.value;
    },
    retain(ids: Set<string>) { for (const [id, item] of entries) if (!ids.has(id)) cancel(id, item); },
    dispose() { disposed = true; for (const [id, item] of entries) cancel(id, item); },
  };
}
