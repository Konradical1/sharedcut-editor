import { create } from 'zustand';
import { api, connection } from './api';
import { useEditorStore } from '../state/store';
import { smartMaskSignature, smartMaskSourceTime, type SmartMaskJob as MaskJob } from './smartMask';
export type { SmartMaskJob as MaskJob, SmartMaskCapabilities as MaskCapabilities } from './smartMask';

export type MaskTool = 'include' | 'exclude' | 'foreground' | 'background' | 'unknown';
export type MaskView = 'overlay' | 'alpha' | 'black' | 'white';
export const useMaskEditor=create<{clipId:string|null;maskId:string|null;time:number;tool:MaskTool;view:MaskView;radius:number;jobs:Record<string,MaskJob>}>()(()=>({clipId:null,maskId:null,time:0,tool:'include',view:'overlay',radius:.012,jobs:{}}));
export function openMaskEditor(clipId:string,maskId:string){
  const state=useEditorStore.getState(),clip=state.clips.find(c=>c.id===clipId),asset=state.media.find(m=>m.id===clip?.mediaId),mask=clip?.smartMasks?.find(m=>m.id===maskId);if(!clip||!asset||!mask)return;
  state.setPlaying(false);
  useMaskEditor.setState({clipId,maskId,time:Math.max(mask.range.start,Math.min(mask.range.end-1/mask.source.fps,smartMaskSourceTime(clip,state.playhead,asset)))});
}
export function maskAssetUrl(key:string,projectId:string,suffix:string){return `/api/smart-masks/${encodeURIComponent(key)}/${suffix}?projectId=${encodeURIComponent(projectId)}`;}
export async function analyzeMask(clipId:string,maskId:string,direction:'forward'|'backward'|'both',anchorTime:number){
  const state=useEditorStore.getState(),clip=state.clips.find(c=>c.id===clipId),mask=clip?.smartMasks?.find(m=>m.id===maskId);if(!clip||!mask)return;
  const signature=smartMaskSignature(mask),id=`${clipId}:${maskId}`;
  try{
    await connection.flush();
    let job=await api<MaskJob>('/smart-masks',{method:'POST',body:JSON.stringify({projectId:clip.projectId,clipId,maskId,signature,direction,anchorTime})});
    const publish=()=>useMaskEditor.setState(s=>({jobs:{...s.jobs,[id]:job}}));publish();
    while(job.status==='queued'||job.status==='processing'){
      await new Promise(resolve=>setTimeout(resolve,800));
      job=await api<MaskJob>(`/smart-masks/${encodeURIComponent(job.key)}?projectId=${encodeURIComponent(clip.projectId)}`);publish();
    }
    if(job.status==='failed')throw Error(job.error||'Mask analysis failed. Your corrections are saved.');
    if(job.status==='ready'){
      const latest=useEditorStore.getState().clips.find(c=>c.id===clipId)?.smartMasks?.find(m=>m.id===maskId);
      if(latest&&smartMaskSignature(latest)===signature){useEditorStore.getState().updateSmartMask(clipId,maskId,{result:{key:job.key,signature}});await connection.flush();}
    }
  }catch(error){useEditorStore.getState().notify((error as Error).message,'error');useMaskEditor.setState(s=>({jobs:{...s.jobs,[id]:{key:s.jobs[id]?.key??'',signature,status:'failed',progress:0,error:(error as Error).message}}}));}
}
export async function cancelMask(key:string,projectId:string){try{await api(`/smart-masks/${encodeURIComponent(key)}?projectId=${encodeURIComponent(projectId)}`,{method:'DELETE'});}catch(error){useEditorStore.getState().notify((error as Error).message,'error');}}
