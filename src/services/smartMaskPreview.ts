import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';
import { effectEnabled } from './effects.ts';
import { smartMaskFrame, smartMaskSignature, type SmartMaskDocument, type SmartMaskManifest } from './smartMask.ts';

export class SmartMaskPending extends Error {}
export type SmartMaskPixels = { width:number; height:number; data:Uint8Array; key:string };
const empty:SmartMaskPixels={width:1,height:1,data:new Uint8Array([0]),key:'empty'};

/** Technical interpretation lives outside prompt intent and must revalidate a completed analysis. */
export function smartMaskPreviewContext(clip:Clip,asset?:Pick<MediaAsset,'inputProfile'|'inputGamut'|'colorMatrix'>):string{
  const p=clip.properties;
  return JSON.stringify([clip.projectId,clip.id,p.inputProfile??null,p.inputGamut??null,p.dataLevels??null,p.yuvMatrix??null,asset?.inputProfile??null,asset?.inputGamut??null,asset?.colorMatrix??null]);
}

export function activeSmartMasks(clip:Clip,nodes:GradeNode[]):SmartMaskDocument[]{
  const ids=new Set([...clip.effects.filter(e=>e.name==='Smart Mask'&&effectEnabled(clip,e)&&e.amount>0).map(e=>e.maskId),...nodes.filter(n=>n.clipId===clip.id&&n.enabled&&n.mask?.enabled&&n.mask.amount>0).map(n=>n.mask!.id)]);
  return [...ids].map(id=>{const doc=clip.smartMasks?.find(m=>m.id===id);if(!doc)throw Error('Smart Mask references a missing subject.');return doc;});
}

/** Bounded source-alpha cache; errors are retried so a temporary download failure cannot poison a revision. */
export function createSmartMaskPreview(onReady:()=>void){
  type Entry<T>={value?:T;error?:Error;retryAt?:number;controller:AbortController};
  const manifests=new Map<string,Entry<SmartMaskManifest>>(),frames=new Map<string,Entry<SmartMaskPixels>>();
  let disposed=false;
  const get=<T>(cache:Map<string,Entry<T>>,key:string,load:(signal:AbortSignal)=>Promise<T>,limit:number):T=>{
    let entry=cache.get(key);
    if(entry?.error&&Date.now()>entry.retryAt!){cache.delete(key);entry=undefined;}
    if(!entry){
      while(cache.size>=limit){const oldest=cache.keys().next().value!;cache.get(oldest)?.controller.abort();cache.delete(oldest);}
      entry={controller:new AbortController()};cache.set(key,entry);const current=entry;
      void load(current.controller.signal).then(value=>{current.value=value;}).catch(error=>{if(!current.controller.signal.aborted){current.error=error instanceof Error?error:Error(String(error));current.retryAt=Date.now()+2000;}}).finally(()=>{if(!disposed&&!current.controller.signal.aborted)onReady();});
    }else{cache.delete(key);cache.set(key,entry);}
    if(entry.error)throw entry.error;if(!entry.value)throw new SmartMaskPending('Loading Smart Mask…');return entry.value;
  };
  const response=async(url:string,signal:AbortSignal)=>{
    const r=await fetch(url,{signal,credentials:'same-origin'});
    if(!r.ok){const body=await r.json().catch(()=>null);throw Error(typeof body?.error==='string'?body.error:`Smart Mask download failed (${r.status}).`);}return r;
  };
  return {
    read(clip:Clip,nodes:GradeNode[],time:number,asset?:Pick<MediaAsset,'inputProfile'|'inputGamut'|'colorMatrix'>):Map<string,SmartMaskPixels>{
      const result=new Map<string,SmartMaskPixels>();
      for(const doc of activeSmartMasks(clip,nodes)){
        if(time<doc.range.start-1e-7||time>=doc.range.end-1e-7){result.set(doc.id,empty);continue;}
        if(!doc.result||doc.result.signature!==smartMaskSignature(doc))throw new SmartMaskPending('Analyze Smart Mask to update this frame.');
        const key=doc.result.key,query=`?projectId=${encodeURIComponent(clip.projectId)}`,base=`/api/smart-masks/${key}`;
        const context=smartMaskPreviewContext(clip,asset);
        const manifest=get(manifests,`${key}:${context}`,async signal=>{
          const value=await(await response(`${base}/manifest${query}&clipId=${encodeURIComponent(clip.id)}&context=${encodeURIComponent(context)}`,signal)).json() as SmartMaskManifest;
          if(value.key!==key||value.signature!==doc.result!.signature||value.mediaId!==clip.mediaId||!Array.isArray(value.frames))throw Error('Smart Mask revision does not match this clip.');return value;
        },32);
        const index=smartMaskFrame(time,doc.source,manifest.sourceTimes),frame=manifest.frames.find(f=>f.index===index);
        if(!frame)throw new SmartMaskPending('This Smart Mask frame needs analysis.');
        const pixels=get(frames,`${key}:${index}`,async signal=>{
          const blob=await(await response(`${base}/frames/${index}.png${query}`,signal)).blob(),bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none'});
          try{
            // Preview sampling is 8-bit browser alpha; the lossless 16-bit PNG remains authoritative for export.
            const scale=Math.min(1,1920/bitmap.width,1080/bitmap.height),width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
            const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
            const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(bitmap,0,0,width,height);
            const rgba=context.getImageData(0,0,width,height).data,data=new Uint8Array(width*height);
            for(let i=0;i<data.length;i++)data[i]=rgba[i*4];return {width,height,data,key:`${key}:${index}`};
          }finally{bitmap.close();}
        },24);
        result.set(doc.id,pixels);
      }
      return result;
    },
    dispose(){disposed=true;for(const cache of [manifests,frames]){for(const entry of cache.values())entry.controller.abort();cache.clear();}},
  };
}

/** Fit source alpha into the same letterboxed canvas as the source RGB. */
export function fittedSmartMask(mask:SmartMaskPixels,width:number,height:number,sourceWidth:number,sourceHeight:number):Uint8Array{
  const output=new Uint8Array(width*height),fit=Math.min(width/sourceWidth,height/sourceHeight),w=sourceWidth*fit,h=sourceHeight*fit,left=(width-w)/2,top=(height-h)/2;
  for(let y=Math.max(0,Math.ceil(top-.5));y<Math.min(height,Math.ceil(top+h-.5));y++)for(let x=Math.max(0,Math.ceil(left-.5));x<Math.min(width,Math.ceil(left+w-.5));x++){
    const u=(x+.5-left)/w*mask.width-.5,v=(y+.5-top)/h*mask.height-.5,x0=Math.floor(u),y0=Math.floor(v),fx=u-x0,fy=v-y0;
    const at=(a:number,b:number)=>mask.data[Math.max(0,Math.min(mask.height-1,b))*mask.width+Math.max(0,Math.min(mask.width-1,a))];
    output[y*width+x]=(at(x0,y0)*(1-fx)+at(x0+1,y0)*fx)*(1-fy)+(at(x0,y0+1)*(1-fx)+at(x0+1,y0+1)*fx)*fy;
  }
  return output;
}
