import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';
import { effectEnabled } from './effects.ts';
import { isDepthKey, nodeMaskId, smartMaskFrame, smartMaskSignature, type SmartMaskDocument, type SmartMaskManifest } from './smartMask.ts';

export class SmartMaskPending extends Error {}
export type SmartMaskPixels = { width:number; height:number; data:Uint8Array; key:string; canvas?:HTMLCanvasElement };
const PREFETCH=[1,2,3,4,5,6,7,8,9,10,11,12,-1,-2];
/** During playback a matte a few frames old beats a dropped frame; the exact frame keeps loading behind it. */
const NEARBY=[-1,-2,-3,-4,-5,-6,1,2,3];

/** Pixels whose red channel is lifted into `data` only when a WebGL node mask asks for it. */
function lazyPixels(canvas:HTMLCanvasElement,key:string):SmartMaskPixels{
  let data:Uint8Array|undefined;
  return {width:canvas.width,height:canvas.height,key,canvas,get data(){
    if(!data){const rgba=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height).data;data=new Uint8Array(canvas.width*canvas.height);for(let i=0;i<data.length;i++)data[i]=rgba[i*4];}
    return data;
  }};
}

/** Canvas 2D filter that turns a gray matte into alpha = keep + scale·(gray or 1-gray); built once per amount/invert pair. */
export function lumaAlphaFilter(amount:number,invert:boolean):string|null{
  if(typeof document==='undefined'||!('filter' in CanvasRenderingContext2D.prototype))return null;
  const id=`frameline-luma-alpha-${Math.round(amount)}-${invert?1:0}`;
  if(!document.getElementById(id)){
    let host=document.getElementById('frameline-mask-filters') as SVGSVGElement|null;
    if(!host){host=document.createElementNS('http://www.w3.org/2000/svg','svg');host.id='frameline-mask-filters';host.setAttribute('aria-hidden','true');host.style.cssText='position:absolute;width:0;height:0;overflow:hidden';document.body.appendChild(host);}
    const scale=amount/100*(invert?-1:1),keep=1-amount/100+(invert?amount/100:0);
    const filter=document.createElementNS('http://www.w3.org/2000/svg','filter');filter.id=id;filter.setAttribute('color-interpolation-filters','sRGB');
    const matrix=document.createElementNS('http://www.w3.org/2000/svg','feColorMatrix');matrix.setAttribute('type','matrix');matrix.setAttribute('values',`0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${scale} 0 0 0 ${keep}`);
    filter.appendChild(matrix);host.appendChild(filter);
  }
  return `url(#${id})`;
}
const empty:SmartMaskPixels={width:1,height:1,data:new Uint8Array([0]),key:'empty'};
/** A mask with no analysis for this frame yet. The picture plays unmasked instead of blanking the clip and
 *  stalling playback on a load that can never finish; export still requires the analysis. */
export const unanalyzedSmartMask:SmartMaskPixels={width:1,height:1,data:new Uint8Array([255]),key:'unanalyzed'};

/** Technical interpretation lives outside prompt intent and must revalidate a completed analysis. */
export function smartMaskPreviewContext(clip:Clip,asset?:Pick<MediaAsset,'inputProfile'|'inputGamut'|'colorMatrix'>):string{
  const p=clip.properties;
  return JSON.stringify([clip.projectId,clip.id,p.inputProfile??null,p.inputGamut??null,p.dataLevels??null,p.yuvMatrix??null,asset?.inputProfile??null,asset?.inputGamut??null,asset?.colorMatrix??null]);
}

export function activeSmartMasks(clip:Clip,nodes:GradeNode[]):SmartMaskDocument[]{
  const ids=new Set([...clip.effects.filter(e=>e.name==='Smart Mask'&&effectEnabled(clip,e)&&e.amount>0).map(e=>e.maskId),...nodes.filter(n=>n.clipId===clip.id&&n.enabled&&n.mask?.enabled&&n.mask.amount>0&&!isDepthKey(n.mask)).map(n=>nodeMaskId(n)!)]);
  return [...ids].map(id=>{const doc=clip.smartMasks?.find(m=>m.id===id);if(!doc)throw Error('Smart Mask references a missing subject.');return doc;});
}

/** Bounded source-alpha cache; errors are retried so a temporary download failure cannot poison a revision. */
export function createSmartMaskPreview(onReady:()=>void){
  type Entry<T>={value?:T;error?:Error;retryAt?:number;controller:AbortController};
  const manifests=new Map<string,Entry<SmartMaskManifest>>(),frames=new Map<string,Entry<SmartMaskPixels>>(),indexSets=new WeakMap<SmartMaskManifest,Set<number>>();
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
  /** One mask's matte at source second `time`: `empty` outside its range, `unanalyzedSmartMask` where it has none yet. */
  const readDoc=(clip:Clip,doc:SmartMaskDocument,time:number,asset?:Pick<MediaAsset,'inputProfile'|'inputGamut'|'colorMatrix'>):SmartMaskPixels=>{
    // The frame showing at range.start carries a timestamp up to one frame earlier; the manifest decides.
    if(time<doc.range.start-1/doc.source.fps||time>=doc.range.end-1e-7)return empty;
    if(!doc.result)return unanalyzedSmartMask;
    // Edited since its analysis: keep showing that analysis until the new one lands. Its pixels are immutable,
    // so the historical manifest is served without the current-intent check.
    const current=doc.result.signature===smartMaskSignature(doc);
    const key=doc.result.key,query=`?projectId=${encodeURIComponent(clip.projectId)}`,base=`/api/smart-masks/${key}`;
    const context=current?smartMaskPreviewContext(clip,asset):'historical';
    const manifest=get(manifests,`${key}:${context}`,async signal=>{
      const value=await(await response(current?`${base}/manifest${query}&clipId=${encodeURIComponent(clip.id)}&context=${encodeURIComponent(context)}`:`${base}/manifest${query}`,signal)).json() as SmartMaskManifest;
      if(value.key!==key||value.signature!==doc.result!.signature||value.mediaId!==clip.mediaId||!Array.isArray(value.frames))throw Error('Smart Mask revision does not match this clip.');return value;
    },32);
    const index=smartMaskFrame(time,doc.source,manifest.sourceTimes);
    let indices=indexSets.get(manifest);if(!indices){indices=new Set(manifest.frames.map(f=>f.index));indexSets.set(manifest,indices);}
    if(!indices.has(index))return time<doc.range.start-1e-7?empty:unanalyzedSmartMask;
    const load=(frameIndex:number)=>async(signal:AbortSignal)=>{
      // Playback reads the 8-bit playback-size matte when the analysis wrote one; the lossless 16-bit PNG remains authoritative for export.
      const blob=await(await response(`${base}/${manifest.preview?'preview':'frames'}/${frameIndex}.png${query}`,signal)).blob(),bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none'});
      try{
        const scale=Math.min(1,1920/bitmap.width,1080/bitmap.height),width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(bitmap,0,0,width,height);
        return lazyPixels(canvas,`${key}:${frameIndex}`);
      }finally{bitmap.close();}
    };
    // Keep the next frames in flight so 60 fps playback is not a network round trip per frame.
    for(const ahead of PREFETCH){const next=index+ahead;if(indices.has(next)&&!frames.has(`${key}:${next}`))try{get(frames,`${key}:${next}`,load(next),64);}catch{/* Pending, by design. */}}
    let pixels:SmartMaskPixels|undefined;
    try{pixels=get(frames,`${key}:${index}`,load(index),64);}
    catch(pending){
      if(!(pending instanceof SmartMaskPending))throw pending;
      for(const near of NEARBY){const value=frames.get(`${key}:${index+near}`)?.value;if(value){pixels=value;break;}}
      if(!pixels)throw pending;
    }
    return pixels;
  };
  return {
    read(clip:Clip,nodes:GradeNode[],time:number,asset?:Pick<MediaAsset,'inputProfile'|'inputGamut'|'colorMatrix'>):Map<string,SmartMaskPixels>{
      return new Map(activeSmartMasks(clip,nodes).map(doc=>[doc.id,readDoc(clip,doc,time,asset)] as const));
    },
    readDoc,
    dispose(){disposed=true;for(const cache of [manifests,frames]){for(const entry of cache.values())entry.controller.abort();cache.clear();}},
  };
}

/** Fit source alpha into the same letterboxed canvas as the source RGB. */
export function fittedSmartMask(mask:SmartMaskPixels,width:number,height:number,sourceWidth:number,sourceHeight:number):Uint8Array{
  const output=new Uint8Array(width*height),fit=Math.min(width/sourceWidth,height/sourceHeight),w=sourceWidth*fit,h=sourceHeight*fit,left=(width-w)/2,top=(height-h)/2;
  if(mask.canvas){
    // The GPU resamples; JavaScript only lifts the red channel out.
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{willReadFrequently:true})!;context.imageSmoothingEnabled=true;context.drawImage(mask.canvas,left,top,w,h);
    const rgba=context.getImageData(0,0,width,height).data;for(let i=0;i<output.length;i++)output[i]=rgba[i*4];return output;
  }
  for(let y=Math.max(0,Math.ceil(top-.5));y<Math.min(height,Math.ceil(top+h-.5));y++)for(let x=Math.max(0,Math.ceil(left-.5));x<Math.min(width,Math.ceil(left+w-.5));x++){
    const u=(x+.5-left)/w*mask.width-.5,v=(y+.5-top)/h*mask.height-.5,x0=Math.floor(u),y0=Math.floor(v),fx=u-x0,fy=v-y0;
    const at=(a:number,b:number)=>mask.data[Math.max(0,Math.min(mask.height-1,b))*mask.width+Math.max(0,Math.min(mask.width-1,a))];
    output[y*width+x]=(at(x0,y0)*(1-fx)+at(x0+1,y0)*fx)*(1-fy)+(at(x0,y0+1)*(1-fx)+at(x0+1,y0+1)*fx)*fy;
  }
  return output;
}
