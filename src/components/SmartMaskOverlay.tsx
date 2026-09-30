import {memo,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type PointerEvent} from 'react';
import {Brush,Check,ChevronLeft,ChevronRight,CircleMinus,CirclePlus,Eraser,RotateCcw,ScanLine,Square,Trash2,Undo2} from 'lucide-react';
import {useEditorStore} from '../state/store';
import {createId} from '../services';
import {api} from '../services/api';
import {fieldOwnsKey} from '../services/focus';
import {pendingMaskRepairPreview} from '../services/smartMaskRepairPreview';
import {createSmartMaskPreview,lumaAlphaFilter,smartMaskPreviewContext,SmartMaskPending} from '../services/smartMaskPreview';
import {smartMaskFrame,smartMaskSignature,smartMaskSourceTime,type SmartMaskDocument,type SmartMaskManifest,type SmartMaskPoint} from '../services/smartMask';
import {analyzeMask,cancelMask,useMaskEditor,type MaskCapabilities,type MaskTool,type MaskView} from '../services/smartMaskClient';
import {loadSourceTimes} from '../services/motionTrackerClient';
import {registerFocusStep,showFocusFrame,useFocusZoom} from '../services/sourceFocus';
import {frameImage} from '../services/sourceFrames';
import {FrameStrip,Slot,SourceStill,useWidth,variableRate,type FocusSlots} from './FocusParts';
import './smartMask.css';

const colors:Record<MaskTool,string>={include:'#67e4bc',exclude:'#ff7791',foreground:'#85bdff',background:'#ffb879',unknown:'#d3a5ff'};
const tools:{tool:MaskTool;label:string;hint:string;key:string;Icon:typeof Brush}[]=[
  {tool:'include',label:'Include',hint:'Click or scribble on the subject to track it',key:'I',Icon:CirclePlus},
  {tool:'exclude',label:'Exclude',hint:'Click or scribble on areas the subject must not cover',key:'E',Icon:CircleMinus},
  {tool:'foreground',label:'Restore',hint:'Paint this frame back into the subject',key:'B',Icon:Brush},
  {tool:'background',label:'Remove',hint:'Erase this frame out of the subject',key:'X',Icon:Eraser},
  {tool:'unknown',label:'Reset',hint:'Paint this frame back to the analyzed estimate',key:'R',Icon:RotateCcw},
];
const views:{view:MaskView;label:string;hint:string}[]=[
  {view:'overlay',label:'Overlay',hint:'The subject tinted over the picture'},
  {view:'alpha',label:'Matte',hint:'The matte itself: white is the subject'},
  {view:'black',label:'Black',hint:'The subject over black'},
  {view:'white',label:'White',hint:'The subject over white'},
];

let capabilities:Promise<MaskCapabilities>|undefined;
const maskCapabilities=()=>capabilities??=api<MaskCapabilities>('/smart-masks/capabilities').catch(()=>{capabilities=undefined;return {available:false,preserveMotionBlur:false,finalQuality:false,reason:'Connect to the analysis server to track this mask.'};});

/**
 * The matte in `view`, drawn over the picture beneath rather than into it: a tint where the subject is (overlay), the
 * grey matte itself (alpha), or black or white everywhere it is not. The GPU turns grey into alpha; nothing per pixel
 * runs in JavaScript unless the browser has no canvas filters.
 */
function paintMatte(target:HTMLCanvasElement,matte:CanvasImageSource&{width:number;height:number},view:MaskView){
  const {width,height}=matte;
  if(target.width!==width||target.height!==height){target.width=width;target.height=height;}
  const ctx=target.getContext('2d')!;ctx.save();ctx.globalCompositeOperation='copy';
  if(view==='alpha'){ctx.drawImage(matte,0,0);ctx.restore();return;}
  const outside=view!=='overlay',fill=view==='overlay'?'rgba(0,228,188,.45)':view==='white'?'#fff':'#000',filter=lumaAlphaFilter(100,outside);
  if(filter){ctx.filter=filter;ctx.drawImage(matte,0,0);ctx.filter='none';ctx.globalCompositeOperation='source-in';ctx.fillStyle=fill;ctx.fillRect(0,0,width,height);ctx.restore();return;}
  // ponytail: browsers without canvas filters (older Safari) build the alpha on the CPU; drop once they all have them.
  ctx.drawImage(matte,0,0);const pixels=ctx.getImageData(0,0,width,height),rgb=view==='white'?255:view==='black'?0:-1;
  for(let i=0;i<pixels.data.length;i+=4){const g=pixels.data[i];if(rgb<0){pixels.data[i]=0;pixels.data[i+1]=228;pixels.data[i+2]=188;pixels.data[i+3]=g*.45;}else{pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=rgb;pixels.data[i+3]=255-g;}}
  ctx.putImageData(pixels,0,0);ctx.restore();
}

/** Repairs painted since the last analysis, laid over its matte: white paint restores, black removes. */
function withRepairs(matte:CanvasImageSource&{width:number;height:number},repairs:SmartMaskDocument['repairs']){
  const out=document.createElement('canvas');out.width=matte.width;out.height=matte.height;
  const ctx=out.getContext('2d')!;ctx.drawImage(matte,0,0);ctx.lineJoin=ctx.lineCap='round';
  for(const repair of repairs){
    if(repair.kind==='unknown')continue;
    const radius=Math.max(1,repair.radius*Math.min(out.width,out.height)),points=repair.points.map(p=>({x:p.x*(out.width-1),y:p.y*(out.height-1)}));
    ctx.strokeStyle=ctx.fillStyle=repair.kind==='foreground'?'#fff':'#000';ctx.lineWidth=radius*2;
    ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
    for(const p of points){ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fill();}
  }
  return out;
}

/**
 * The Smart Mask editor, drawn over the viewer's own streaming picture of the clip's source. The matte plays with the
 * picture, frame for frame, in any view; guides and paint go on the frame on screen once playback stops.
 */
function SmartMaskEditor({bar,strip}:FocusSlots){
  const editor=useMaskEditor();
  const clip=useEditorStore(s=>s.clips.find(c=>c.id===editor.clipId&&c.projectId===s.projectId&&c.timelineId===s.timelineId));
  const asset=useEditorStore(s=>clip&&s.media.find(a=>a.id===clip.mediaId));
  const playing=useEditorStore(s=>s.playing);
  const locked=useEditorStore(s=>!!clip&&(!!s.tracks.find(t=>t.id===clip.trackId)?.locked||s.locks.some(l=>l.targetId===clip.id&&l.userId!==s.currentUserId&&l.expiresAt>Date.now()&&['*','smartMasks'].includes(l.field))));
  const zoom=useFocusZoom(s=>s.zoom);
  const mask=clip?.smartMasks?.find(m=>m.id===editor.maskId);
  const sourceContext=clip?smartMaskPreviewContext(clip,asset):'';
  const [manifest,setManifest]=useState<SmartMaskManifest|null>(null),[loadedTimes,setLoadedTimes]=useState<number[]|null>(null),[error,setError]=useState(''),[stroke,setStroke]=useState<SmartMaskPoint[]>([]),[cursor,setCursor]=useState({x:.5,y:.5,visible:false}),[capability,setCapability]=useState<MaskCapabilities|null>(null),[starting,setStarting]=useState(false);
  const [preview,setPreview]=useState<{frame:number;intent:string;url?:string;error?:string}|null>(null);
  const drawing=useRef<{points:SmartMaskPoint[];tool:MaskTool;time:number;radius:number}|null>(null),previewImage=useRef<{url:string;image:HTMLImageElement}|null>(null);
  const svg=useRef<SVGSVGElement>(null),matteCanvas=useRef<HTMLCanvasElement>(null),shownWidth=useWidth(svg,!!(mask&&clip));
  const draw=useRef<()=>void>(()=>{});
  // Its own matte reader: the same streamed, prefetched playback mattes the timeline composites.
  const reader=useRef<ReturnType<typeof createSmartMaskPreview>|null>(null),matteError=useRef(''),renewed=useRef(0);
  const [matteProblem,setMatteProblem]=useState('');
  useEffect(()=>{const made=createSmartMaskPreview(()=>draw.current());reader.current=made;draw.current();return()=>{made.dispose();if(reader.current===made)reader.current=null;};},[]);
  useEffect(()=>{let live=true;void maskCapabilities().then(value=>{if(live)setCapability(value);});return()=>{live=false;};},[]);
  const key=mask?.result?.key;
  useEffect(()=>{setManifest(null);if(!key||!clip)return;let live=true;
    // The workspace save that attaches the result can still be in flight; give it a few tries before reporting.
    const load=async()=>{for(let attempt=0;attempt<8;attempt++){try{const m=await api<SmartMaskManifest>(`/smart-masks/${key}/manifest?projectId=${encodeURIComponent(clip.projectId)}&clipId=${encodeURIComponent(clip.id)}&context=${encodeURIComponent(sourceContext)}`);if(live)setManifest(m);return;}catch(cause){if(!live)return;const status=(cause as {status?:number}).status;if(status!==409&&status!==404||attempt===7)return;await new Promise(r=>setTimeout(r,500));}}};
    void load();return()=>{live=false;};},[key,sourceContext]);
  useEffect(()=>{setLoadedTimes(null);setError('');if(!clip)return;let live=true;void loadSourceTimes(clip).then(value=>{if(live)setLoadedTimes(value);}).catch(()=>{if(live)setError('Source timing is unavailable. Reconnect the source and reopen this editor.');});return()=>{live=false;};},[clip?.id,clip?.mediaId]);
  useEffect(()=>()=>{if(editor.clipId)useEditorStore.getState().releaseLock(editor.clipId,'smartMasks');},[editor.clipId]);
  useEffect(()=>{if(editor.clipId&&(!clip||!mask))useMaskEditor.setState({clipId:null,maskId:null});},[editor.clipId,!!clip,!!mask]);
  const analyzed=useMemo(()=>new Set(manifest?.frames.map(f=>f.index)),[manifest]);
  const times=manifest?.sourceTimes??loadedTimes??undefined;
  const variable=useMemo(()=>variableRate(times),[times]);
  const intent=useMemo(()=>mask?smartMaskSignature(mask):'',[mask]),valid=!!mask?.result&&mask.result.signature===intent;
  const repairs=useMemo(()=>mask&&!valid?pendingMaskRepairPreview(mask):null,[mask,valid]);
  // The editor walks the clip as it sits on the timeline, not the whole source file.
  const bounds=(()=>{if(!mask||!clip||!asset)return {first:0,last:0};const fps=mask.source.fps,a=smartMaskSourceTime(clip,clip.start,asset),b=smartMaskSourceTime(clip,clip.start+Math.max(0,clip.duration-1/fps),asset);return {first:smartMaskFrame(Math.min(a,b),mask.source,times),last:smartMaskFrame(Math.max(a,b),mask.source,times)};})();
  const frame=mask?Math.max(bounds.first,Math.min(bounds.last,smartMaskFrame(editor.time,mask.source,times))):0;
  const frameTime=times?.[frame]??(mask?frame/mask.source.fps:0);
  const frameGuides=mask?mask.prompts.filter(p=>smartMaskFrame(p.time,mask.source,times)===frame):[];
  const frameIntent=JSON.stringify(frameGuides.map(p=>[p.kind,p.radius,p.points]));
  const previewReady=!playing&&!valid&&repairs===null&&!!preview?.url&&preview.frame===frame&&preview.intent===frameIntent;
  // Every click previews its own frame right away; tracking the whole range stays an explicit step.
  useEffect(()=>{
    if(!mask||!clip||valid||repairs!==null||playing||!times||!frameGuides.some(p=>p.kind==='include')){if(!valid&&preview&&!frameGuides.length)setPreview(null);return;}
    if(preview&&preview.frame===frame&&preview.intent===frameIntent&&(preview.url||preview.error))return;
    let live=true;
    const timer=setTimeout(()=>{setPreview({frame,intent:frameIntent});
      void api<{url:string}>('/smart-masks/preview',{method:'POST',body:JSON.stringify({clipId:clip.id,maskId:mask.id,frame,prompts:frameGuides.map(p=>({id:p.id,time:p.time,kind:p.kind,points:p.points,radius:p.radius}))})})
        .then(value=>{if(live)setPreview({frame,intent:frameIntent,url:value.url});})
        .catch(cause=>{if(live)setPreview({frame,intent:frameIntent,error:cause instanceof Error?cause.message:'Frame preview failed.'});});},150);
    return()=>{live=false;clearTimeout(timer);};
  },[clip?.id,mask?.id,frame,frameIntent,valid,repairs===null,playing,!!times]);
  // The matte for the frame on screen. Called straight from the editor's time changes, which playback sets from the
  // picture it has just drawn, so matte and picture change in the same frame.
  draw.current=()=>{
    const el=matteCanvas.current;if(!el||!mask||!clip)return;
    const clear=()=>{el.width=el.width;};
    const now=useMaskEditor.getState(),paused=!useEditorStore.getState().playing;
    const index=Math.max(bounds.first,Math.min(bounds.last,smartMaskFrame(now.time,mask.source,times)));
    if(paused&&previewReady&&index===frame){
      const url=preview!.url!,held=previewImage.current;
      // A detached image reports its intrinsic size as width and height.
      if(held?.url===url){paintMatte(el,held.image,now.view);return;}
      void frameImage(url).then(image=>{previewImage.current={url,image};draw.current();}).catch(()=>{});return;
    }
    const read=reader.current;if(!read)return;
    const problem=(message:string)=>{if(matteError.current!==message){matteError.current=message;setMatteProblem(message);}};
    let pixels;
    try{pixels=read.readDoc(clip,mask,times?.[index]??now.time,asset);}
    catch(cause){if(!(cause instanceof SmartMaskPending)){clear();problem(cause instanceof Error?cause.message:'The matte could not be loaded.');}return;}
    problem('');
    if(!pixels.canvas){clear();return;}
    const pending=paused&&repairs?repairs.filter(r=>smartMaskFrame(r.time,mask.source,times)===index):[];
    paintMatte(el,pending.length?withRepairs(pixels.canvas,pending):pixels.canvas,now.view);
  };
  useEffect(()=>useMaskEditor.subscribe((state,previous)=>{if(state.time!==previous.time||state.view!==previous.view)draw.current();}),[]);
  useLayoutEffect(()=>{draw.current();},[mask?.id,key,valid,manifest,previewReady,preview?.url,mask?.repairs,playing,!!times,editor.view]);
  const go=(index:number)=>{if(!mask)return;useEditorStore.getState().setPlaying(false);const next=Math.max(bounds.first,Math.min(bounds.last,index));showFocusFrame(times?.[next]??next/mask.source.fps);};
  const stepTo=useRef(go);stepTo.current=go;
  useEffect(()=>registerFocusStep(delta=>{const m=useEditorStore.getState().clips.find(c=>c.id===useMaskEditor.getState().clipId)?.smartMasks?.find(x=>x.id===useMaskEditor.getState().maskId);if(m)stepTo.current(smartMaskFrame(useMaskEditor.getState().time,m.source,times)+delta);}),[times]);
  const keys=useRef<(e:KeyboardEvent)=>boolean>(()=>false);
  useEffect(()=>{
    // Capture: while the mask editor is open, its tool letters beat the timeline's (B is the blade there, I marks in).
    const key=(e:KeyboardEvent)=>{
      if(e.defaultPrevented||fieldOwnsKey(e.target as Element,e.key))return;
      // Delete and Backspace never reach the timeline, with or without a modifier: there they delete the clip.
      if((e.metaKey||e.ctrlKey)&&e.key!=='Delete'&&e.key!=='Backspace')return;
      if(keys.current(e)){e.preventDefault();e.stopImmediatePropagation();}
    };
    window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  },[]);
  if(!mask||!clip){keys.current=()=>false;return null;}
  const s=useEditorStore.getState;
  const guides=[...mask.prompts,...mask.repairs].filter(p=>smartMaskFrame(p.time,mask.source,times)===frame);
  const unit=mask.source.width/shownWidth;// source pixels per screen pixel
  const ready=!!times&&!locked;
  const coordinate=(e:PointerEvent<SVGSVGElement>)=>{const box=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(e.clientY-box.top)/box.height))};};
  const end=(cancel=false)=>{const d=drawing.current;drawing.current=null;setStroke([]);if(d&&!cancel){const entry={id:createId('stroke'),time:d.time,kind:d.tool,points:d.points,radius:d.radius};if(d.tool==='include'||d.tool==='exclude')s().updateSmartMask(clip.id,mask.id,{prompts:[...mask.prompts,{...entry,kind:d.tool}]});else s().updateSmartMask(clip.id,mask.id,{repairs:[...mask.repairs,{...entry,kind:d.tool}]});}s().releaseLock(clip.id,'smartMasks');};
  const clearFrame=()=>{if(guides.length&&!locked)s().updateSmartMask(clip.id,mask.id,{prompts:mask.prompts.filter(p=>!guides.includes(p)),repairs:mask.repairs.filter(p=>!guides.includes(p))});};
  const removeLast=()=>{const last=guides.at(-1);if(last&&!locked)s().updateSmartMask(clip.id,mask.id,{prompts:mask.prompts.filter(p=>p!==last),repairs:mask.repairs.filter(p=>p!==last)});};
  keys.current=e=>{
    if(e.key==='Escape'){
      // Escape belongs to the mask editor only from the viewer or nowhere in particular; a menu elsewhere keeps its own.
      const target=e.target as Element;if(target!==document.body&&!target.closest?.('.viewer'))return false;
      if(drawing.current)end(true);else useMaskEditor.setState({clipId:null,maskId:null});
      return true;
    }
    if(e.shiftKey&&e.key.startsWith('Arrow')){setCursor(c=>({x:Math.max(0,Math.min(1,c.x+(e.key==='ArrowLeft'?-.01:e.key==='ArrowRight'?.01:0))),y:Math.max(0,Math.min(1,c.y+(e.key==='ArrowUp'?-.01:e.key==='ArrowDown'?.01:0))),visible:true}));return true;}
    if(e.key==='Enter'&&cursor.visible&&e.target===svg.current){if(ready&&s().acquireLock(clip.id,'smartMasks')){s().setPlaying(false);drawing.current={points:[{x:cursor.x,y:cursor.y}],tool:editor.tool,time:frameTime,radius:editor.radius};end();}return true;}
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){go(frame+(e.key==='ArrowRight'?1:-1));return true;}
    if(e.key==='Home'||e.key==='End'){go(e.key==='Home'?bounds.first:bounds.last);return true;}
    // Delete takes back the last guide or paint on this frame and never falls through to deleting the clip.
    if(e.key==='Delete'||e.key==='Backspace'){removeLast();return true;}
    const hot=!e.altKey&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey&&tools.find(t=>t.key===e.key.toUpperCase());
    if(hot){useMaskEditor.setState({tool:hot.tool});return true;}
    return false;
  };
  const job=editor.jobs[`${clip.id}:${mask.id}`],busy=starting||job?.status==='queued'||job?.status==='processing';
  const cannotAnalyze=busy||locked||!capability?.available||(mask.settings.quality==='final'&&!capability.finalQuality)||(mask.settings.preserveMotionBlur&&!capability.preserveMotionBlur)||!mask.prompts.some(p=>p.kind==='include');
  const analyze=async(direction:'forward'|'backward'|'both')=>{setStarting(true);try{await analyzeMask(clip.id,mask.id,direction,frameTime);}finally{setStarting(false);}};
  const marked=new Map<number,string>();
  for(const p of [...mask.prompts,...mask.repairs])marked.set(smartMaskFrame(p.time,mask.source,times),colors[p.kind]);
  const count=bounds.last-bounds.first+1;
  const matteShown=previewReady||!!mask.result&&analyzed.has(frame);
  const status=error||(!times?'Reading source frame timing…':busy?`Analyzing the shot · ${Math.round(job?.progress??0)}%`:playing?(!mask.result?'Not analyzed yet · analyze to see the mask play':''):
    preview&&preview.frame===frame&&!valid&&repairs===null?(preview.error?`Preview failed · ${preview.error}`:preview.url?'Frame preview · Analyze to track it through the shot':'Previewing subject…'):
    !mask.prompts.some(p=>p.kind==='include')?'Click your subject to select it':
    !valid&&mask.result?(repairs!==null?'Paint preview · analyze to publish it':'Showing the last analysis · analyze to update it'):
    !mask.result?'Guides saved · click a frame with guides to preview it, or analyze':matteProblem?`Matte unavailable · ${matteProblem}`:!matteShown?'This frame has no analyzed matte':'');
  const marks=(points:SmartMaskPoint[],kind:MaskTool,radius:number,id:string,index?:number)=>{
    const brush=radius*Math.min(mask.source.width,mask.source.height),sx=(p:SmartMaskPoint)=>p.x*mask.source.width,sy=(p:SmartMaskPoint)=>p.y*mask.source.height,last=points.at(-1)!;
    return <g key={id} stroke={colors[kind]} fill={colors[kind]} pointerEvents="none">
      {points.length>1&&<polyline points={points.map(p=>`${sx(p)},${sy(p)}`).join(' ')} fill="none" strokeWidth={Math.max(3*unit,brush*2)} opacity=".55" strokeLinecap="round" strokeLinejoin="round"/>}
      {points.length===1&&brush>4*unit&&<circle cx={sx(last)} cy={sy(last)} r={brush} fill="none" strokeWidth={unit} strokeDasharray={`${3*unit} ${3*unit}`} opacity=".8"/>}
      {(points.length===1?points:[points[0],last]).map((p,i)=><g key={i}><circle cx={sx(p)} cy={sy(p)} r={7*unit} fill="#0b0f12" fillOpacity=".55" stroke="white" strokeWidth={1.5*unit}/><circle cx={sx(p)} cy={sy(p)} r={4.5*unit} stroke="none"/>{kind==='exclude'&&<line x1={sx(p)-2.5*unit} x2={sx(p)+2.5*unit} y1={sy(p)} y2={sy(p)} stroke="#1a0d10" strokeWidth={1.4*unit}/>}{kind==='include'&&<path d={`M${sx(p)-2.5*unit} ${sy(p)}h${5*unit}M${sx(p)} ${sy(p)-2.5*unit}v${5*unit}`} stroke="#05231a" strokeWidth={1.4*unit}/>}</g>)}
      {index!==undefined&&<text x={sx(points[0])+9*unit} y={sy(points[0])-8*unit} fontSize={11*unit} fill="white" stroke="#0b0f12" strokeWidth={3*unit} paintOrder="stroke" fontFamily="system-ui, sans-serif" fontWeight="600">{index}</text>}
    </g>;};
  const toolButtons=(items:typeof tools)=>items.map(({tool,label,hint,key,Icon})=><button key={tool} aria-label={label} aria-pressed={editor.tool===tool} title={`${label} (${key}) · ${hint}`} style={{'--tool':colors[tool]} as CSSProperties} onClick={()=>useMaskEditor.setState({tool})}><Icon size={15}/></button>);
  return <>
    <Slot into={bar}><div className="focus-bar smart-mask-bar" role="toolbar" aria-label={`Edit ${mask.name} mask`}>
      <span className="focus-title"><span className="smart-mask-dot"/><strong title={mask.name}>{mask.name}</strong></span>
      <span className="focus-group" role="group" aria-label="Subject tools">{toolButtons(tools.slice(0,2))}</span>
      <span className="focus-group" role="group" aria-label="Paint frame tools">{toolButtons(tools.slice(2))}</span>
      <label className="smart-mask-brush" title="Brush size"><span aria-hidden="true" style={{width:Math.max(3,Math.min(16,editor.radius*160)),height:Math.max(3,Math.min(16,editor.radius*160))}}/><input aria-label="Mask brush radius" type="range" min={.002} max={.1} step={.001} value={editor.radius} onChange={e=>useMaskEditor.setState({radius:Number(e.target.value)})} onPointerUp={e=>e.currentTarget.blur()}/></label>
      <span className="focus-group focus-segments" role="group" aria-label="Mask view">{views.map(v=><button key={v.view} aria-pressed={editor.view===v.view} title={v.hint} onClick={()=>useMaskEditor.setState({view:v.view})}>{v.label}</button>)}</span>
      <span className="focus-group smart-mask-analyze" role="group" aria-label="Analyze">
        <button aria-label="Analyze mask backward" title="Analyze backward from this frame" disabled={cannotAnalyze} onClick={()=>void analyze('backward')}><ChevronLeft size={14}/></button>
        <button className="smart-mask-go" title={capability&&!capability.available?capability.reason:'Track the subject through the clip from this frame'} disabled={cannotAnalyze} onClick={()=>void analyze('both')}><ScanLine size={14}/>Analyze</button>
        <button aria-label="Analyze mask forward" title="Analyze forward from this frame" disabled={cannotAnalyze} onClick={()=>void analyze('forward')}><ChevronRight size={14}/></button>
      </span>
      {busy&&<><progress aria-label="Mask analysis progress" max={100} value={job?.progress??0}/><button aria-label="Cancel mask analysis" title="Cancel analysis" disabled={!job?.key} onClick={()=>void cancelMask(job!.key,clip.projectId)}><Square size={11}/></button></>}
      <span className="spacer"/>
      <button aria-label="Undo mask edit" title="Undo (Ctrl+Z)" onClick={()=>s().undo()}><Undo2 size={14}/></button>
      <button className="focus-done" aria-label="Close mask editor" title="Done (Esc)" onClick={()=>useMaskEditor.setState({clipId:null,maskId:null})}><Check size={14}/>Done</button>
    </div></Slot>
    <Slot into={strip}><div className="focus-strip-row smart-mask-strip">
      {status&&<p className={`focus-status ${busy||status==='Previewing subject…'?'busy':''} ${status===error||status.startsWith('Preview failed')||status.startsWith('Matte unavailable')?'warning':''}`} role={error?'alert':'status'}>{status}</p>}
      <FrameStrip count={count} current={frame-bounds.first} version={[analyzed,mask.prompts,mask.repairs]} label="Mask frames. Teal frames have an analyzed matte; tall marks are frames with guides or paint. Click or drag to move through the clip."
        cell={i=>{const mark=marked.get(bounds.first+i);return mark?[mark,1] as const:analyzed.has(bounds.first+i)?['#3f9f86',.6] as const:undefined;}} seek={i=>go(bounds.first+i)}/>
      <span className="focus-frame" title={`Source frame ${frame+1} · ${frameTime.toFixed(3)} s`}>Frame {frame-bounds.first+1}/{count} · {frameTime.toFixed(3)} s{!times?' · nominal fps':''}</span>
      <button aria-label="Clear guides on this frame" title="Clear all guides and paint on this frame" disabled={!guides.length||locked} onClick={clearFrame}><Trash2 size={13}/></button>
    </div></Slot>
    <SourceStill url={`/api/smart-masks/source?clipId=${encodeURIComponent(clip.id)}&frame=${frame}&context=${encodeURIComponent(sourceContext)}${zoom==='Fit'?'&size=display':''}`} show={(zoom!=='Fit'||variable)&&!playing&&!!times}/>
    <canvas ref={matteCanvas} className="focus-matte" aria-hidden="true"/>
    <svg ref={svg} className="focus-marks smart-mask-marks" viewBox={`0 0 ${mask.source.width} ${mask.source.height}`} preserveAspectRatio="none" role="application" tabIndex={0} style={{cursor:ready?'crosshair':'default',touchAction:'none'}}
      aria-label="Subject guidance canvas. Shift and arrow keys move the point; Enter adds it. Arrow keys step frames."
      onPointerDown={e=>{
        if(e.button!==0)return;
        // Playing, a click stops on the frame on screen; the next one draws on it.
        if(s().playing){e.preventDefault();s().setPlaying(false);return;}
        if(!ready||!s().acquireLock(clip.id,'smartMasks'))return;
        e.preventDefault();setCursor(c=>({...c,visible:false}));e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current={points:[coordinate(e)],tool:editor.tool,time:frameTime,radius:editor.radius};setStroke([...drawing.current.points]);
      }}
      onPointerMove={e=>{const d=drawing.current;if(!d)return;const p=coordinate(e),last=d.points.at(-1)!;if(Math.hypot(p.x-last.x,p.y-last.y)>.002&&d.points.length<2048){d.points.push(p);setStroke([...d.points]);if(Date.now()-renewed.current>2000){renewed.current=Date.now();s().renewLock(clip.id,'smartMasks');}}}}
      onPointerUp={e=>{end();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>end(true)} onLostPointerCapture={()=>{if(drawing.current)end(true);}}>
      {cursor.visible&&<circle cx={cursor.x*mask.source.width} cy={cursor.y*mask.source.height} r={6*unit} fill="none" stroke="white" strokeWidth={2*unit}/>}
      {!playing&&guides.map((g,i)=>marks(g.points,g.kind,g.radius,g.id,i+1))}{stroke.length>0&&marks(stroke,editor.tool,editor.radius,'draft')}
    </svg>
  </>;
}
export default memo(SmartMaskEditor);
