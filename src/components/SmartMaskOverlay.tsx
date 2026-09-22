import {pendingMaskRepairPreview} from '../services/smartMaskRepairPreview';
import {smartMaskPreviewContext} from '../services/smartMaskPreview';
import {useEffect,useRef,useState,type CSSProperties,type PointerEvent} from 'react';
import {Brush,ChevronLeft,ChevronRight,CircleMinus,CirclePlus,Eraser,RotateCcw,Trash2,Undo2,X} from 'lucide-react';
import {useEditorStore} from '../state/store';
import {createId} from '../services';
import {api} from '../services/api';
import {smartMaskFrame,smartMaskSignature,smartMaskSourceTime,type SmartMaskManifest,type SmartMaskPoint} from '../services/smartMask';
import {maskAssetUrl,useMaskEditor,type MaskTool,type MaskView} from '../services/smartMaskClient';
import './smartMask.css';

const colors:Record<MaskTool,string>={include:'#67e4bc',exclude:'#ff7791',foreground:'#85bdff',background:'#ffb879',unknown:'#d3a5ff'};
const tools:{tool:MaskTool;label:string;hint:string;key:string;Icon:typeof Brush}[]=[
  {tool:'include',label:'Include',hint:'Click or scribble on the subject to track it',key:'I',Icon:CirclePlus},
  {tool:'exclude',label:'Exclude',hint:'Click or scribble on areas the subject must not cover',key:'E',Icon:CircleMinus},
  {tool:'foreground',label:'Restore',hint:'Paint this frame back into the subject',key:'B',Icon:Brush},
  {tool:'background',label:'Remove',hint:'Erase this frame out of the subject',key:'X',Icon:Eraser},
  {tool:'unknown',label:'Reset',hint:'Paint this frame back to the analyzed estimate',key:'R',Icon:RotateCcw},
];
export default function SmartMaskOverlay(){
  const editor=useMaskEditor(),s=useEditorStore(),clip=s.clips.find(c=>c.id===editor.clipId&&c.projectId===s.projectId),mask=clip?.smartMasks?.find(m=>m.id===editor.maskId);
  const sourceContext=clip?smartMaskPreviewContext(clip,s.media.find(asset=>asset.id===clip.mediaId)):'';
  const canvas=useRef<HTMLCanvasElement>(null),surface=useRef<HTMLDivElement>(null),[manifest,setManifest]=useState<SmartMaskManifest|null>(null),[sourceTimes,setSourceTimes]=useState<number[]>([]),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[stroke,setStroke]=useState<SmartMaskPoint[]>([]),[cursor,setCursor]=useState({x:.5,y:.5,visible:false}),[size,setSize]=useState({width:1,height:1}),[zoom,setZoom]=useState('Fit');
  const drawing=useRef<{points:SmartMaskPoint[];tool:MaskTool;time:number;radius:number}|null>(null);
  const intent=mask?smartMaskSignature(mask):'',valid=!!mask?.result&&mask.result.signature===intent,key=mask?.result?.key;
  const repairsPreview=mask?pendingMaskRepairPreview(mask):null,canPreview=valid||repairsPreview!==null;
  const [preview,setPreview]=useState<{frame:number;intent:string;url?:string;error?:string}|null>(null);
  useEffect(()=>{setManifest(null);if(!key||!clip)return;let live=true;
    // The workspace save that attaches the result can still be in flight; give it a few tries before reporting.
    const load=async()=>{for(let attempt=0;attempt<8;attempt++){try{const m=await api<SmartMaskManifest>(`/smart-masks/${key}/manifest?projectId=${encodeURIComponent(clip.projectId)}&clipId=${encodeURIComponent(clip.id)}&context=${encodeURIComponent(sourceContext)}`);if(live)setManifest(m);return;}catch(cause){if(!live)return;const status=(cause as {status?:number}).status;if(status!==409&&status!==404||attempt===7){setError(cause instanceof Error?cause.message:'Analyze this mask to refresh its source interpretation.');return;}await new Promise(r=>setTimeout(r,500));}}};
    void load();return()=>{live=false;};},[key,sourceContext]);
  useEffect(()=>{const el=surface.current;if(!el)return;const observer=new ResizeObserver(entries=>setSize({width:entries[0].contentRect.width,height:entries[0].contentRect.height}));observer.observe(el);return()=>observer.disconnect();},[!!mask]);
  useEffect(()=>{setSourceTimes([]);if(!clip)return;let live=true;void api<{sourceTimes:number[]}>(`/smart-masks/source-times?clipId=${encodeURIComponent(clip.id)}`).then(value=>{if(live)setSourceTimes(value.sourceTimes);}).catch(()=>{if(live)setError('Source timing is unavailable. Reconnect the source and reopen this editor.');});return()=>{live=false;};},[clip?.id]);
  useEffect(()=>{const el=surface.current;if(el){el.scrollLeft=(el.scrollWidth-el.clientWidth)/2;el.scrollTop=(el.scrollHeight-el.clientHeight)/2;}},[zoom]);
  const times=manifest?.sourceTimes??(sourceTimes.length?sourceTimes:undefined);
  // The editor walks the clip as it sits on the timeline, not the whole source file.
  const asset=clip?s.media.find(a=>a.id===clip.mediaId):undefined;
  const bounds=(()=>{if(!mask||!clip||!asset)return {first:0,last:0};const fps=mask.source.fps,a=smartMaskSourceTime(clip,clip.start,asset),b=smartMaskSourceTime(clip,clip.start+Math.max(0,clip.duration-1/fps),asset);return {first:smartMaskFrame(Math.min(a,b),mask.source,times),last:smartMaskFrame(Math.max(a,b),mask.source,times)};})();
  const frame=mask?Math.max(bounds.first,Math.min(bounds.last,smartMaskFrame(editor.time,mask.source,times))):0;
  const frameTime=times?.[frame]??(mask?frame/mask.source.fps:0);
  const frameGuides=mask?mask.prompts.filter(p=>smartMaskFrame(p.time,mask.source,times)===frame):[];
  const frameIntent=JSON.stringify(frameGuides.map(p=>[p.kind,p.radius,p.points]));
  const matteReady=canPreview&&!!manifest?.frames.some(f=>f.index===frame);
  const previewReady=!matteReady&&!!preview?.url&&preview.frame===frame&&preview.intent===frameIntent;
  // Every click previews its own frame right away; tracking the whole range stays an explicit step.
  useEffect(()=>{
    if(!mask||!clip||valid||!times||!frameGuides.some(p=>p.kind==='include')){if(!valid&&preview&&!frameGuides.length)setPreview(null);return;}
    if(preview&&preview.frame===frame&&preview.intent===frameIntent)return;
    let live=true;
    const timer=setTimeout(()=>{setPreview({frame,intent:frameIntent});
      void api<{url:string}>('/smart-masks/preview',{method:'POST',body:JSON.stringify({clipId:clip.id,maskId:mask.id,frame,prompts:frameGuides.map(p=>({id:p.id,time:p.time,kind:p.kind,points:p.points,radius:p.radius}))})})
        .then(value=>{if(live)setPreview({frame,intent:frameIntent,url:value.url});})
        .catch(cause=>{if(live)setPreview({frame,intent:frameIntent,error:cause instanceof Error?cause.message:'Frame preview failed.'});});},150);
    return()=>{live=false;clearTimeout(timer);};
  },[clip?.id,mask?.id,frame,frameIntent,valid,!!times]);
  useEffect(()=>{
    if(!mask||!clip||!canvas.current)return;
    let live=true;setLoaded(false);setError('');
    const picture=new Image(),alpha=new Image();
    const draw=()=>{
      if(!live||!canvas.current)return;
      // Fit view composites at display resolution; native pixels only when zoomed in.
      const ratio=mask.source.width/mask.source.height,fitWidth=Math.min(size.width,size.height*ratio),dpr=window.devicePixelRatio||1;
      const target=canvas.current;target.width=zoom==='Fit'?Math.max(1,Math.min(mask.source.width,Math.round(fitWidth*dpr))):mask.source.width;target.height=zoom==='Fit'?Math.max(1,Math.min(mask.source.height,Math.round(fitWidth/ratio*dpr))):mask.source.height;
      const ctx=target.getContext('2d')!;ctx.clearRect(0,0,target.width,target.height);ctx.drawImage(picture,0,0,target.width,target.height);
      if((matteReady||previewReady)&&alpha.complete&&alpha.naturalWidth){
        const matte=document.createElement('canvas');matte.width=target.width;matte.height=target.height;const m=matte.getContext('2d')!;m.drawImage(alpha,0,0,matte.width,matte.height);
        if(matteReady&&!valid&&repairsPreview){
          const pixels=m.getImageData(0,0,matte.width,matte.height),coverage=document.createElement('canvas');coverage.width=matte.width;coverage.height=matte.height;const brush=coverage.getContext('2d')!;
          for(const repair of repairsPreview.filter(r=>smartMaskFrame(r.time,mask.source,times)===frame)){
            brush.clearRect(0,0,coverage.width,coverage.height);brush.fillStyle=brush.strokeStyle='white';brush.lineJoin=brush.lineCap='round';
            const radius=Math.max(1,Math.round(repair.radius*Math.min(matte.width,matte.height))),points=repair.points.map(p=>({x:Math.round(p.x*(matte.width-1)),y:Math.round(p.y*(matte.height-1))}));
            brush.lineWidth=radius*2;brush.beginPath();points.forEach((p,i)=>i?brush.lineTo(p.x,p.y):brush.moveTo(p.x,p.y));brush.stroke();
            for(const point of points){brush.beginPath();brush.arc(point.x,point.y,radius,0,Math.PI*2);brush.fill();}
            const weights=brush.getImageData(0,0,coverage.width,coverage.height).data;
            for(let i=0;i<pixels.data.length;i+=4){const value=pixels.data[i]+((repair.kind==='foreground'?255:0)-pixels.data[i])*weights[i+3]/255;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=value;}
          }
          m.putImageData(pixels,0,0);
        }
        if(editor.view==='alpha'){ctx.drawImage(matte,0,0);}
        else{
          const pixels=ctx.getImageData(0,0,target.width,target.height),a=m.getImageData(0,0,target.width,target.height);
          for(let i=0;i<pixels.data.length;i+=4){const coverage=a.data[i]/255;
            if(editor.view==='overlay'){const tint=coverage*.4;pixels.data[i]*=1-tint;pixels.data[i+1]=pixels.data[i+1]*(1-tint)+228*tint;pixels.data[i+2]=pixels.data[i+2]*(1-tint)+188*tint;}
            else for(let c=0;c<3;c++)pixels.data[i+c]=pixels.data[i+c]*coverage+(editor.view==='white'?255:0)*(1-coverage);
          }
          ctx.putImageData(pixels,0,0);
        }
      }
      setLoaded(true);
    };
    // Scrubbing settles before the frame is fetched, and a transient failure retries before it is reported.
    let attempts=0;const source=`/api/smart-masks/source?clipId=${encodeURIComponent(clip.id)}&frame=${frame}&context=${encodeURIComponent(sourceContext)}`;
    picture.onload=draw;picture.onerror=()=>{if(!live)return;if(attempts++<3)setTimeout(()=>{if(live)picture.src=`${source}&retry=${attempts}`;},400*attempts);else setError('The source frame could not be loaded. Step to another frame to retry.');};
    const settle=setTimeout(()=>{if(live)picture.src=source;},120);
    if(matteReady||previewReady){alpha.onload=()=>{if(picture.complete&&picture.naturalWidth)draw();};alpha.onerror=()=>{if(live)setError(matteReady?'This matte frame is unavailable. Analyze this range again.':'The frame preview image is unavailable.');};alpha.src=matteReady?maskAssetUrl(key!,clip.projectId,`frames/${frame}.png`):preview!.url!;}
    return()=>{live=false;clearTimeout(settle);};
  },[clip?.id,mask?.id,key,frame,editor.view,intent,manifest,sourceContext,previewReady?preview?.url:'',zoom,zoom==='Fit'?Math.round(size.width):0,zoom==='Fit'?Math.round(size.height):0]);
  useEffect(()=>()=>{if(editor.clipId)useEditorStore.getState().releaseLock(editor.clipId,'smartMasks');},[editor.clipId]);
  if(!mask||!clip)return null;
  const locked=s.tracks.find(t=>t.id===clip.trackId)?.locked||s.locks.some(l=>l.targetId===clip.id&&l.userId!==s.currentUserId&&l.expiresAt>Date.now()&&['*','smartMasks'].includes(l.field));
  const ratio=mask.source.width/mask.source.height,fit={width:Math.min(size.width,size.height*ratio),height:Math.min(size.height,size.width/ratio)};
  const display=zoom==='Fit'?fit:{width:mask.source.width*Number(zoom)/100,height:mask.source.height*Number(zoom)/100};
  const guides=[...mask.prompts,...mask.repairs].filter(p=>smartMaskFrame(p.time,mask.source,times)===frame);
  const unit=mask.source.width/Math.max(1,display.width);// source pixels per screen pixel
  const coordinate=(e:PointerEvent<SVGSVGElement>)=>{const box=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(e.clientY-box.top)/box.height))};};
  const end=(cancel=false)=>{const d=drawing.current;drawing.current=null;setStroke([]);if(d&&!cancel){const entry={id:createId('stroke'),time:d.time,kind:d.tool,points:d.points,radius:d.radius};if(d.tool==='include'||d.tool==='exclude')s.updateSmartMask(clip.id,mask.id,{prompts:[...mask.prompts,{...entry,kind:d.tool}]});else s.updateSmartMask(clip.id,mask.id,{repairs:[...mask.repairs,{...entry,kind:d.tool}]});}s.releaseLock(clip.id,'smartMasks');};
  const step=(delta:number)=>{const next=Math.max(bounds.first,Math.min(bounds.last,frame+delta));useMaskEditor.setState({time:times?.[next]??next/mask.source.fps});};
  const marks=(points:SmartMaskPoint[],kind:MaskTool,radius:number,id:string,index?:number)=>{
    const brush=radius*Math.min(mask.source.width,mask.source.height),sx=(p:SmartMaskPoint)=>p.x*mask.source.width,sy=(p:SmartMaskPoint)=>p.y*mask.source.height,last=points.at(-1)!;
    return <g key={id} stroke={colors[kind]} fill={colors[kind]} pointerEvents="none">
      {points.length>1&&<polyline points={points.map(p=>`${sx(p)},${sy(p)}`).join(' ')} fill="none" strokeWidth={Math.max(3*unit,brush*2)} opacity=".55" strokeLinecap="round" strokeLinejoin="round"/>}
      {points.length===1&&brush>4*unit&&<circle cx={sx(last)} cy={sy(last)} r={brush} fill="none" strokeWidth={unit} strokeDasharray={`${3*unit} ${3*unit}`} opacity=".8"/>}
      {(points.length===1?points:[points[0],last]).map((p,i)=><g key={i}><circle cx={sx(p)} cy={sy(p)} r={7*unit} fill="#0b0f12" fillOpacity=".55" stroke="white" strokeWidth={1.5*unit}/><circle cx={sx(p)} cy={sy(p)} r={4.5*unit} stroke="none"/>{kind==='exclude'&&<line x1={sx(p)-2.5*unit} x2={sx(p)+2.5*unit} y1={sy(p)} y2={sy(p)} stroke="#1a0d10" strokeWidth={1.4*unit}/>}{kind==='include'&&<path d={`M${sx(p)-2.5*unit} ${sy(p)}h${5*unit}M${sx(p)} ${sy(p)-2.5*unit}v${5*unit}`} stroke="#05231a" strokeWidth={1.4*unit}/>}</g>)}
      {index!==undefined&&<text x={sx(points[0])+9*unit} y={sy(points[0])-8*unit} fontSize={11*unit} fill="white" stroke="#0b0f12" strokeWidth={3*unit} paintOrder="stroke" fontFamily="system-ui, sans-serif" fontWeight="600">{index}</text>}
    </g>;};
  return <section className="smart-mask-editor" aria-label={`Edit ${mask.name} mask`} onKeyDown={e=>{if((e.target as Element).closest('input,select'))return;if(e.key==='Escape'){useMaskEditor.setState({clipId:null,maskId:null});e.stopPropagation();}if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();step(e.key==='ArrowLeft'?-1:1);}if((e.metaKey||e.ctrlKey)&&e.key==='z'){e.preventDefault();e.stopPropagation();s.undo();}const hot=tools.find(t=>t.key===e.key.toUpperCase());if(hot&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();e.stopPropagation();useMaskEditor.setState({tool:hot.tool});}}}>
    <header><span className="smart-mask-dot"/><strong>{mask.name}</strong><small>Source frame editor</small><span className="spacer"/><select aria-label="Mask zoom" title="Native image detail. Scroll to pan at 100% or 200%." value={zoom} onChange={e=>setZoom(e.target.value)}><option value="Fit">Fit</option><option value="100">100%</option><option value="200">200%</option></select><select aria-label="Mask view" value={editor.view} onChange={e=>useMaskEditor.setState({view:e.target.value as MaskView})}>{['overlay','alpha','black','white'].map(v=><option key={v} value={v}>{v[0].toUpperCase()+v.slice(1)}</option>)}</select><button aria-label="Close mask editor" onClick={()=>useMaskEditor.setState({clipId:null,maskId:null})}><X size={16}/></button></header>
    <div className="smart-mask-tools" role="toolbar" aria-label="Mask drawing tools">
      {[['Subject',tools.slice(0,2)],['Paint frame',tools.slice(2)]].map(([group,items])=><div key={group as string} className="smart-mask-group" aria-label={`${group} tools`}><span>{group as string}</span><div>{(items as typeof tools).map(({tool,label,hint,key,Icon})=><button key={tool} aria-label={label} aria-pressed={editor.tool===tool} title={`${label} (${key}) · ${hint}`} style={{'--tool':colors[tool]} as CSSProperties} onClick={()=>useMaskEditor.setState({tool})}><Icon size={15}/></button>)}</div></div>)}
      <label className="smart-mask-brush" title="Brush size"><span aria-hidden="true" style={{width:Math.max(3,Math.min(18,editor.radius*180)),height:Math.max(3,Math.min(18,editor.radius*180))}}/><input aria-label="Mask brush radius" type="range" min={.002} max={.1} step={.001} value={editor.radius} onChange={e=>useMaskEditor.setState({radius:Number(e.target.value)})}/></label>
      <span className="smart-mask-current">{tools.find(t=>t.tool===editor.tool)?.label}</span>
      <button aria-label="Undo mask edit" title="Undo (⌘Z)" onClick={()=>s.undo()}><Undo2 size={15}/></button>
    </div>
    <div className="smart-mask-stage"><div className="smart-mask-surface" ref={surface} tabIndex={0} aria-label="Mask image viewport. Use scrollbars or arrow keys to pan." onKeyDown={e=>{if(e.target===e.currentTarget&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))e.stopPropagation();}}>
      <div className="smart-mask-scroll-content">
      <div className="smart-mask-picture" style={{width:display.width,height:display.height}}><canvas ref={canvas} aria-label={`Source frame ${frame+1}`}/><svg viewBox={`0 0 ${mask.source.width} ${mask.source.height}`} preserveAspectRatio="none" aria-label="Subject guidance canvas. Shift and arrow keys move the point; Enter adds it. Arrow keys step frames." role="application" tabIndex={0} style={{cursor:loaded&&!locked?'crosshair':'wait',touchAction:'none'}}
        onKeyDown={e=>{if(e.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation();setCursor(c=>({x:Math.max(0,Math.min(1,c.x+(e.key==='ArrowLeft'?-.01:e.key==='ArrowRight'?.01:0))),y:Math.max(0,Math.min(1,c.y+(e.key==='ArrowUp'?-.01:e.key==='ArrowDown'?.01:0))),visible:true}));}else if(e.key==='Enter'&&loaded&&times&&!locked){e.preventDefault();e.stopPropagation();if(!s.acquireLock(clip.id,'smartMasks'))return;drawing.current={points:[{x:cursor.x,y:cursor.y}],tool:editor.tool,time:frameTime,radius:editor.radius};end();}}}
        onPointerDown={e=>{if(e.button!==0||!loaded||!times||locked||!s.acquireLock(clip.id,'smartMasks'))return;e.preventDefault();setCursor(c=>({...c,visible:false}));e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);drawing.current={points:[coordinate(e)],tool:editor.tool,time:frameTime,radius:editor.radius};setStroke([...drawing.current.points]);}}
        onPointerMove={e=>{const d=drawing.current;if(!d)return;const p=coordinate(e),last=d.points.at(-1)!;if(Math.hypot(p.x-last.x,p.y-last.y)>.002&&d.points.length<2048){d.points.push(p);setStroke([...d.points]);s.renewLock(clip.id,'smartMasks');}}}
        onPointerUp={e=>{end();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>end(true)} onLostPointerCapture={()=>{if(drawing.current)end(true);}}>
        {cursor.visible&&<g stroke="white" strokeWidth={2}><circle cx={cursor.x*mask.source.width} cy={cursor.y*mask.source.height} r={6} fill="none"/></g>}{guides.map((g,i)=>marks(g.points,g.kind,g.radius,g.id,i+1))}{stroke.length>0&&marks(stroke,editor.tool,editor.radius,'draft')}
      </svg></div></div></div>
      {(!loaded||!times||error)&&<p className="smart-mask-source-status" role={error?'alert':'status'}>{error||(!times?'Reading source frame timing…':'Loading source frame…')}</p>}
      {loaded&&!valid&&repairsPreview!==null&&matteReady&&<span className="smart-mask-review">Repair preview · analyze to publish</span>}
      {loaded&&!valid&&repairsPreview===null&&preview&&preview.frame===frame&&<span className={`smart-mask-review ${preview.error?'error':preview.url?'':'busy'}`}>{preview.error?`Preview failed · ${preview.error}`:preview.url?`Frame preview · ${frameGuides.length} guide${frameGuides.length===1?'':'s'} · Analyze range to track the shot`:'Previewing subject…'}</span>}
      {loaded&&!valid&&repairsPreview===null&&!(preview&&preview.frame===frame)&&<span className="smart-mask-review">{mask.result?'Corrections changed · analyze to update matte':mask.prompts.some(p=>p.kind==='include')?'Guides saved · click a frame with guides to preview it':'Click your subject to preview a mask'}</span>}
      {loaded&&canPreview&&!matteReady&&<span className="smart-mask-review">{manifest?'Source view · this frame has no analyzed matte':'Loading analyzed matte…'}</span>}
    </div>
    <footer><button aria-label="Previous mask frame" onClick={()=>step(-1)}><ChevronLeft size={15}/></button><input type="range" aria-label="Mask clip frame" min={bounds.first} max={Math.max(bounds.first,bounds.last)} step={1} value={frame} onChange={e=>useMaskEditor.setState({time:times?.[Number(e.target.value)]??Number(e.target.value)/mask.source.fps})}/><button aria-label="Next mask frame" onClick={()=>step(1)}><ChevronRight size={15}/></button><span title={`Source frame ${frame+1} · ${frameTime.toFixed(3)} s`}>Clip frame {frame-bounds.first+1} / {bounds.last-bounds.first+1} · {frameTime.toFixed(3)} s{!times?' · nominal fps':''}</span><button aria-label="Clear guides on this frame" title="Clear all guides and paint on this frame" disabled={!guides.length||locked} onClick={()=>s.updateSmartMask(clip.id,mask.id,{prompts:mask.prompts.filter(p=>!guides.includes(p)),repairs:mask.repairs.filter(p=>!guides.includes(p))})}><Trash2 size={14}/></button></footer>
  </section>;
}
