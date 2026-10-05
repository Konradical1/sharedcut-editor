import { ApiError, api, connection } from './api.ts';
import { backoffDelay } from './backoff.ts';
import { createVideoFrames } from './videoFrames.ts';
import type { Clip, GradeNode, MediaAsset, Project, Timeline, Track, Settings } from '../state/models.ts';
import type { TimelinePreview } from '../../server/previewCache.ts';

type State = { projectId: string; timelineId: string; projects: Project[]; timelines?: Timeline[]; clips: Clip[]; tracks: Track[]; media: MediaAsset[]; nodes: GradeNode[]; settings: Settings };
/** A busy server is asked again after 2 s, then 4, 8 and 15 s at most (shortened by jitter), not every 2 s for as long as it stays busy. */
export const PREVIEW_BUSY_BASE_MS = 2000, PREVIEW_BUSY_MAX_MS = 15000;
const HOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** True in a browser running on the server's own computer, which must never ask that computer to render for it. */
export const isHostBrowser = (hostname?: string) => HOST_NAMES.has((hostname ?? '').toLowerCase());
const isQueueBusy = (error: unknown) => error instanceof ApiError && error.status === 429 || String(error).includes('Preview queue busy');
/** A dropped connection or a server error (a restart, a tunnel 502) can pass; any other answer from the server is final. */
const isTransient = (error: unknown) => !(error instanceof ApiError) || error.status >= 500;
/** How many times a chunk is asked again after such a failure before it is left to the live compositor. */
const PREVIEW_MAX_RETRIES = 6;
/** Background render cache for sections that exceed the browser's frame budget. */
export function createTimelinePreview(changed: () => void) {
  type Entry = { value?: TimelinePreview; frames?: ReturnType<typeof createVideoFrames>; controller: AbortController; timer?: ReturnType<typeof setTimeout>; busy: number; failures: number };
  const entries = new Map<number,Entry>();
  let dependencies: unknown[] = [], version = '', disposed = false;
  const clear = () => { for(const entry of entries.values()){clearTimeout(entry.timer);entry.controller.abort();entry.frames?.dispose();}entries.clear(); };
  return {
    get(state: State, time: number, width: number, height: number, enable: boolean) {
      if(disposed||!connection.enabled||typeof VideoDecoder==='undefined')return undefined;
      const next=[state.projectId,state.timelineId,state.projects,state.timelines,state.clips,state.tracks,state.media,state.nodes,state.settings.footageCache,width,height];
      if(!next.every((value,index)=>value===dependencies[index])){
        dependencies=next;
        const signature=JSON.stringify([state.projectId,state.timelineId,state.projects.find(p=>p.id===state.projectId),state.timelines?.filter(t=>t.projectId===state.projectId),state.clips.filter(c=>c.projectId===state.projectId),state.tracks.filter(t=>state.timelines?.some(tl=>tl.id===t.timelineId&&tl.projectId===state.projectId)),state.nodes.filter(n=>n.projectId===state.projectId),state.media.filter(m=>m.projectId===state.projectId).map(({waveform,filmstrip,...media})=>media),state.settings.footageCache,width,height]);
        if(signature!==version){version=signature;clear();}
      }
      const fps=state.projects.find(p=>p.id===state.projectId)?.fps||24, span=Math.round(fps*4)/fps, chunk=Math.floor((time+1e-7)/span);
      for(const [id,entry] of entries)if(id<chunk-1||id>chunk+2){clearTimeout(entry.timer);entry.controller.abort();entry.frames?.dispose();entries.delete(id);}
      const request=(id:number)=>{
        if(entries.has(id))return;
        const entry:Entry={controller:new AbortController(),busy:0,failures:0};entries.set(id,entry);
        const poll=async()=>{
          if(disposed||entry.controller.signal.aborted)return;
          try{
            await connection.flush();
            if(entry.controller.signal.aborted)return;
            entry.value=await api<TimelinePreview>('/timeline-previews',{method:'POST',body:JSON.stringify({projectId:state.projectId,timelineId:state.timelineId,chunk:id,width:Math.max(160,width-width%2),height:Math.max(90,height-height%2)}),signal:entry.controller.signal});
            if(entry.controller.signal.aborted)return;
            entry.busy=0;entry.failures=0;
            if(entry.value.status==='ready'&&entry.value.url){entry.frames=createVideoFrames(entry.value.url,fps,changed,state.settings.footageCache!==false);entry.frames.update(Math.max(0,time-entry.value.from));}
            else if(entry.value.status==='preparing')entry.timer=setTimeout(poll,1000);
            // 'skipped' (the server will not render this range) and 'failed' are final for the chunk: nothing polls it and the live compositor keeps drawing.
            changed();
          }catch(error){
            if(entry.controller.signal.aborted)return;
            // The interactive renderer stays available while the bounded server queue is busy, or until a few retries after a drop have failed.
            if(isQueueBusy(error)||isTransient(error)&&entry.failures++<PREVIEW_MAX_RETRIES)entry.timer=setTimeout(poll,backoffDelay(entry.busy++,PREVIEW_BUSY_BASE_MS,PREVIEW_BUSY_MAX_MS));
          }
        };
        entry.timer=setTimeout(poll,750);
      };
      // The host's own browser plays live: a render it asked for would take the memory and processor its own playback needs.
      if(enable&&!(typeof location!=='undefined'&&isHostBrowser(location.hostname))){request(chunk);const end=state.timelines?.find(t=>t.id===state.timelineId)?.duration??0;if((chunk+1)*span<end)request(chunk+1);}
      const entry=entries.get(chunk);
      if(entry?.value&&entry.frames){
        entry.frames.update(Math.max(0,time-entry.value.from));
        const frame=entry.frames.frame(Math.max(0,time-entry.value.from));
        if(frame)return {frame,key:entry.value.key};
      }
      return undefined;
    },
    dispose(){disposed=true;clear();},
  };
}
