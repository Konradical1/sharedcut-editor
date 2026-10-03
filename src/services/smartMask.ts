import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';
import { animatedSourceOffset } from './animation.ts';

export type SmartMaskPoint = { x: number; y: number };
export type SmartMaskSource = { mediaId: string; fps: number; width: number; height: number; duration: number };
/** Source seconds, normalized source coordinates, radius as a fraction of the shorter source dimension. */
export type SmartMaskPrompt = { id: string; time: number; kind: 'include' | 'exclude'; points: SmartMaskPoint[]; radius: number };
export type SmartMaskRepair = Omit<SmartMaskPrompt, 'kind'> & { kind: 'foreground' | 'background' | 'unknown' };
export type SmartMaskBinding = { source?: undefined; id: string; enabled: boolean; invert: boolean; amount: number };
/** A grade node keyed by the clip's own depth analysis instead of a subject: distances 0 (nearest) to 100 (farthest).
 *  The key is 1 inside [near, far] and eases to 0 over `softness` beyond each end (depthKeyAlpha in depth.ts). */
export type DepthKeyBinding = { source: 'depth'; enabled: boolean; invert: boolean; amount: number; near: number; far: number; softness: number };
/** One mask per node: a Smart Mask subject or a depth key. */
export type NodeMask = SmartMaskBinding | DepthKeyBinding;
export type SmartMaskDocument = {
  version: 1; id: string; name: string; source: SmartMaskSource;
  range: { start: number; end: number };
  prompts: SmartMaskPrompt[]; repairs: SmartMaskRepair[];
  settings: { preserveMotionBlur: boolean; edgeRadius: number; quality: 'preview' | 'final' };
  result?: { key: string; signature: string };
};
export type SmartMaskDirection = 'forward' | 'backward' | 'both';
export type SmartMaskRequest = { clipId: string; maskId: string; signature: string; direction: SmartMaskDirection; anchorTime: number };
export type SmartMaskJob = {
  key: string; signature: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';
  progress: number; error?: string; manifestUrl?: string; previewUrl?: string;
};
export type SmartMaskCapabilities = { available: boolean; engine?: string; reason?: string; preserveMotionBlur: boolean; finalQuality: boolean };
export type SmartMaskManifest = {
  version: 1; key: string; signature: string; projectId: string; mediaId: string; sourceFingerprint: string;
  engine: string; modelRevision: string; quality: 'preview' | 'final'; width: number; height: number;
  /** Index in the decoded source PTS table. Values may be sparse for a partial analysis. */
  frames: { index: number; time: number; file: string }[];
  sourceTimes?: number[]; range: { start: number; end: number }; alpha: 'gray16';
  /** Present when `preview/<index>.png` playback-size 8-bit mattes were written alongside the native frames. */
  preview?: 'gray8';
};
export type SmartMaskWorkerInput = {
  input: string; output: string; ffmpeg: string; ffprobe: string; document: SmartMaskDocument;
  direction: SmartMaskDirection; anchorTime: number;
};

const validId=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value);
const number=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validateSmartMask(value: unknown): asserts value is SmartMaskDocument {
  if(!object(value)||value.version!==1||!validId(value.id)||typeof value.name!=='string'||value.name.length>100)throw Error('Invalid smart mask document.');
  const source=value.source;
  if(!object(source)||!validId(source.mediaId)||!number(source.fps,1,1200)||!number(source.duration,.001,21600)||![source.width,source.height].every(v=>number(v,1,16384)&&Number.isInteger(v)))throw Error('Invalid smart mask source.');
  const range=value.range,settings=value.settings;
  if(!object(range)||!number(range.start,0,Number(source.duration))||!number(range.end,0,Number(source.duration))||Number(range.end)<=Number(range.start))throw Error('Invalid smart mask range.');
  if(!object(settings)||typeof settings.preserveMotionBlur!=='boolean'||!number(settings.edgeRadius,1,256)||!['preview','final'].includes(String(settings.quality)))throw Error('Invalid smart mask settings.');
  let count=0;
  for(const [name,kinds] of [['prompts',['include','exclude']],['repairs',['foreground','background','unknown']]] as const){
    const items=value[name];
    if(!Array.isArray(items)||items.length>2000)throw Error('Too many smart mask strokes.');
    const ids=new Set<string>();
    for(const stroke of items){
      if(!object(stroke)||!validId(stroke.id)||ids.has(String(stroke.id))||!(kinds as readonly string[]).includes(String(stroke.kind))||!number(stroke.time,0,Number(source.duration))||Number(stroke.time)>=Number(source.duration)||!number(stroke.radius,.00001,.25)||!Array.isArray(stroke.points)||!stroke.points.length||stroke.points.length>2048)throw Error('Invalid smart mask stroke.');
      ids.add(String(stroke.id));count+=stroke.points.length;
      if(count>100_000||stroke.points.some(p=>!object(p)||!number(p.x,0,1)||!number(p.y,0,1)))throw Error('Invalid smart mask points.');
    }
  }
  if(value.result!==undefined&&(!object(value.result)||typeof value.result.key!=='string'||!/^[a-f0-9]{64}$/.test(value.result.key)||typeof value.result.signature!=='string'||value.result.signature.length>180_000))throw Error('Invalid smart mask result.');
  if(smartMaskSignature(value as SmartMaskDocument).length>180_000)throw Error('Mask strokes exceed document size limit; simplify strokes.');
}

export function validateSmartMaskBinding(value:unknown): asserts value is SmartMaskBinding {
  if(!object(value)||!validId(value.id)||typeof value.enabled!=='boolean'||typeof value.invert!=='boolean'||!number(value.amount,0,100))throw Error('Invalid node mask binding.');
}
export const isDepthKey=(mask:NodeMask|undefined):mask is DepthKeyBinding=>mask?.source==='depth';
export function validateNodeMask(value:unknown): asserts value is NodeMask {
  if(!object(value)||value.source!=='depth'){validateSmartMaskBinding(value);return;}
  if(Object.keys(value).some(k=>!['source','enabled','invert','amount','near','far','softness'].includes(k))||typeof value.enabled!=='boolean'||typeof value.invert!=='boolean'||!number(value.amount,0,100)||!number(value.near,0,100)||!number(value.far,Number(value.near),100)||!number(value.softness,0,100))throw Error('Invalid depth key.');
}
/** The key a node's matte goes by in preview and export: the subject's id, or `depth:<node>` (a subject id has no colon). */
export const nodeMaskId=(node:Pick<GradeNode,'id'|'mask'>)=>isDepthKey(node.mask)?`depth:${node.id}`:node.mask?.id;
/** The clip's enabled nodes whose depth key changes the picture: these need its depth analysis. */
export const activeDepthKeys=(clip:Pick<Clip,'id'>,nodes:GradeNode[])=>nodes.filter((n):n is GradeNode&{mask:DepthKeyBinding}=>n.clipId===clip.id&&n.enabled&&isDepthKey(n.mask)&&n.mask.enabled&&n.mask.amount>0);
export function validateSmartMaskBindings(clip:Clip,nodes:GradeNode[]) {
  if(clip.smartMasks!==undefined&&(!Array.isArray(clip.smartMasks)||clip.smartMasks.length>32))throw Error('Too many smart masks on a clip.');
  const ids=new Set<string>();
  for(const mask of clip.smartMasks??[]){validateSmartMask(mask);if(mask.source.mediaId!==clip.mediaId||ids.has(mask.id))throw Error('Smart mask source does not match its clip.');ids.add(mask.id);}
  // A Smart Mask effect cuts its matte; a Depth effect protects and follows it (its Subject). Both only from their own clip.
  for(const effect of clip.effects)if(effect.maskId!==undefined){if(!['Smart Mask','Depth'].includes(effect.name)||!ids.has(effect.maskId))throw Error('Effect references a missing smart mask.');}
  for(const node of nodes.filter(n=>n.clipId===clip.id))if(node.mask!==undefined){
    validateNodeMask(node.mask);
    if(!isDepthKey(node.mask)&&!ids.has(node.mask.id))throw Error('Node references a missing smart mask.');
    if(node.mask.enabled&&node.effects?.some(e=>e.enabled&&e.type==='cst'))throw Error('Keep color-space transforms on an unmasked node.');
  }
}

/** Exact canonical intent, not a cache hash. The server hashes this together with source/model identity. */
export function smartMaskSignature(doc:SmartMaskDocument):string {
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>[k,canonical(value[k])])):value;
  const {id:_,name:__,result:___,...intent}=doc;
  return JSON.stringify(canonical(intent));
}

/** Use decoded PTS when supplied. Nominal-fps fallback does not establish native VFR frame accuracy. */
export function smartMaskFrame(time:number,source:Pick<SmartMaskSource,'fps'|'duration'>,sourceTimes?:number[]):number {
  if(!Number.isFinite(time))throw Error('Invalid smart mask time.');
  if(sourceTimes?.length){
    let lo=0,hi=sourceTimes.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(sourceTimes[mid]<=time+1e-7)lo=mid+1;else hi=mid;}
    return Math.max(0,lo-1);
  }
  return Math.max(0,Math.min(Math.ceil(source.duration*source.fps)-1,Math.floor(time*source.fps+1e-7)));
}
export function smartMaskSourceTime(clip:Clip,timelineTime:number,asset:Pick<MediaAsset,'fps'|'duration'>):number {
  const fps=asset.fps||24;
  return Math.max(0,Math.min(Math.max(0,asset.duration-1/fps),clip.sourceIn+animatedSourceOffset(clip,Math.max(0,timelineTime-clip.start),fps)));
}

export function createSmartMask(clip:Clip,asset:MediaAsset,id:string):SmartMaskDocument {
  const dimensions=asset.resolution.match(/(\d+)\s*[×x]\s*(\d+)/i),fps=asset.fps||24;
  const start=smartMaskSourceTime(clip,clip.start,asset),last=smartMaskSourceTime(clip,clip.start+Math.max(0,clip.duration-1/fps),asset);
  const doc:SmartMaskDocument={version:1,id,name:'Subject',source:{mediaId:asset.id,fps,width:Number(dimensions?.[1]??1920),height:Number(dimensions?.[2]??1080),duration:asset.duration},range:{start:Math.min(start,last),end:Math.min(asset.duration,Math.max(start,last)+1/fps)},prompts:[],repairs:[],settings:{preserveMotionBlur:false,edgeRadius:16,quality:'preview'}};
  validateSmartMask(doc);return doc;
}

/** Unknown repairs restore the underlying estimated alpha; foreground/background repairs stay fractional at their brush edge. */
export function smartMaskRepairAlpha(base:number,kind:SmartMaskRepair['kind'],coverage:number):number {
  return kind==='unknown'?base:base+((kind==='foreground'?1:0)-base)*Math.max(0,Math.min(1,coverage));
}
