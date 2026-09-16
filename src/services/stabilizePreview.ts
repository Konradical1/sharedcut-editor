import { api, connection } from './api.ts';
import { stabilizeChunkRange, type StabilizePreview, type StabilizeRange, type StabilizeSettings } from './stabilize.ts';
import type { Clip } from '../state/models.ts';

/** Source-time stabilized proxy chunks, requested and polled like optical-flow previews. */
export function createStabilizePreview(changed: () => void) {
  type Entry = { value?: StabilizePreview; timer?: ReturnType<typeof setTimeout>; controller: AbortController; projectId: string };
  const entries = new Map<string,Entry>(), signatures = new Map<string,string>();
  let disposed = false;
  const cancel = (id: string, entry: Entry) => {
    clearTimeout(entry.timer);entry.controller.abort();entries.delete(id);
    if (entry.value?.status === 'preparing') void api(`/stabilize/${entry.value.key}?projectId=${entry.projectId}`,{method:'DELETE'}).catch(()=>{});
  };
  return {
    get(clip: Clip, chunk: number, range: StabilizeRange, settings: StabilizeSettings, fps: number, quality: string) {
      if (disposed || !connection.enabled) return undefined;
      const signature = JSON.stringify([clip.mediaId,settings,range,fps,quality]);
      if (signatures.get(clip.id) !== signature) {
        for (const [id,entry] of entries) if (id.startsWith(`${clip.id}:`)) cancel(id,entry);
        signatures.set(clip.id,signature);
      }
      const id = `${clip.id}:${chunk}`;
      let entry = entries.get(id);
      if (!entry) {
        entry = {controller:new AbortController(),projectId:clip.projectId}; entries.set(id,entry);
        const current = entry, window = stabilizeChunkRange(chunk,range,fps);
        const request = async () => {
          if (disposed || current.controller.signal.aborted) return;
          try {
            await connection.flush();
            if (current.controller.signal.aborted) return;
            current.value = await api<StabilizePreview>('/stabilize',{method:'POST',body:JSON.stringify({clipId:clip.id,chunk,quality,fps,settings}),signal:current.controller.signal});
            changed();
            if (current.value.status === 'preparing') current.timer = setTimeout(request,750);
          } catch(error) {
            if (current.controller.signal.aborted) return;
            current.value={status:'failed',key:'',progress:0,from:window.from,duration:window.to-window.from,fps,error:(error as Error).message};changed();
          }
        };
        current.timer=setTimeout(request,300);
        while(entries.size>32){const oldest=entries.entries().next().value!;cancel(...oldest);}
      }
      return entry.value;
    },
    retain(ids: Set<string>) { for(const [id,entry] of entries) if(![...ids].some(clipId=>id.startsWith(`${clipId}:`)))cancel(id,entry); },
    dispose() {disposed=true;for(const [id,entry] of entries)cancel(id,entry);signatures.clear();},
  };
}
