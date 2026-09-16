import {pendingMaskRepairPreview} from '../services/smartMaskRepairPreview';
import {smartMaskPreviewContext} from '../services/smartMaskPreview';
import {useEffect,useRef,useState,type PointerEvent} from 'react';
import {ChevronLeft,ChevronRight,Minus,Plus,Paintbrush,Undo2,X} from 'lucide-react';
import {useEditorStore} from '../state/store';
import {createId} from '../services';
import {api} from '../services/api';
import {smartMaskFrame,smartMaskSignature,type SmartMaskManifest,type SmartMaskPoint} from '../services/smartMask';
import {maskAssetUrl,useMaskEditor,type MaskTool,type MaskView} from '../services/smartMaskClient';
import './smartMask.css';

const colors:Record<MaskTool,string>={include:'#67e4bc',exclude:'#ff7791',foreground:'#85bdff',background:'#ffb879',unknown:'#d3a5ff'};
export default function SmartMaskOverlay(){
  const editor=useMaskEditor(),s=useEditorStore(),clip=s.clips.find(c=>c.id===editor.clipId&&c.projectId===s.projectId),mask=clip?.smartMasks?.find(m=>m.id===editor.maskId);
  const sourceContext=clip?smartMaskPreviewContext(clip,s.media.find(asset=>asset.id===clip.mediaId)):'';
  const canvas=useRef<HTMLCanvasElement>(null),surface=useRef<HTMLDivElement>(null),[manifest,setManifest]=useState<SmartMaskManifest|null>(null),[sourceTimes,setSourceTimes]=useState<number[]>([]),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[stroke,setStroke]=useState<SmartMaskPoint[]>([]),[cursor,setCursor]=useState({x:.5,y:.5,visible:false}),[size,setSize]=useState({width:1,height:1}),[zoom,setZoom]=useState('Fit');
  const drawing=useRef<{points:SmartMaskPoint[];tool:MaskTool;time:number;radius:number}|null>(null);
  const intent=mask?smartMaskSignature(mask):'',valid=!!mask?.result&&mask.result.signature===intent,key=mask?.result?.key;
  const repairsPreview=mask?pendingMaskRepairPreview(mask):null,canPreview=valid||repairsPreview!==null;
  useEffect(()=>{setManifest(null);if(!key||!clip)return;let live=true;void api<SmartMaskManifest>(`/smart-masks/${key}/manifest?projectId=${encodeURIComponent(clip.projectId)}&clipId=${encodeURIComponent(clip.id)}&context=${encodeURIComponent(sourceContext)}`).then(m=>{if(live)setManifest(m);}).catch(cause=>{if(live)setError(cause instanceof Error?cause.message:'Analyze this mask to refresh its source interpretation.');});return()=>{live=false;};},[key,sourceContext]);
  useEffect(()=>{const el=surface.current;if(!el)return;const observer=new ResizeObserver(entries=>setSize({width:entries[0].contentRect.width,height:entries[0].contentRect.height}));observer.observe(el);return()=>observer.disconnect();},[!!mask]);
  useEffect(()=>{setSourceTimes([]);if(!clip)return;let live=true;void api<{sourceTimes:number[]}>(`/smart-masks/source-times?clipId=${encodeURIComponent(clip.id)}`).then(value=>{if(live)setSourceTimes(value.sourceTimes);}).catch(()=>{if(live)setError('Source timing is unavailable. Reconnect the source and reopen this editor.');});return()=>{live=false;};},[clip?.id]);
  useEffect(()=>{const el=surface.current;if(el){el.scrollLeft=(el.scrollWidth-el.clientWidth)/2;el.scrollTop=(el.scrollHeight-el.clientHeight)/2;}},[zoom]);
  const times=manifest?.sourceTimes??(sourceTimes.length?sourceTimes:undefined);
  const frame=mask?smartMaskFrame(editor.time,mask.source,times):0;
  const frameTime=times?.[frame]??(mask?frame/mask.source.fps:0);
  useEffect(()=>{
    if(!mask||!clip||!canvas.current)return;
    let live=true;setLoaded(false);setError('');
    const picture=new Image(),alpha=new Image();
    const draw=()=>{
      if(!live||!canvas.current)return;
      const target=canvas.current;target.width=mask.source.width;target.height=mask.source.height;
      const ctx=target.getContext('2d')!;ctx.clearRect(0,0,target.width,target.height);ctx.drawImage(picture,0,0,target.width,target.height);
      if(canPreview&&alpha.complete&&alpha.naturalWidth){
        const matte=document.createElement('canvas');matte.width=target.width;matte.height=target.height;const m=matte.getContext('2d')!;m.drawImage(alpha,0,0,matte.width,matte.height);
        if(!valid&&repairsPreview){
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
    picture.onload=draw;picture.onerror=()=>{if(live)setError('Source frame is unavailable. Reconnect the source before drawing.');};
    picture.src=`/api/smart-masks/source?clipId=${encodeURIComponent(clip.id)}&frame=${frame}&context=${encodeURIComponent(sourceContext)}`;
    if(canPreview&&manifest?.frames.some(f=>f.index===frame)){alpha.onload=()=>{if(picture.complete&&picture.naturalWidth)draw();};alpha.onerror=()=>{if(live)setError('This matte frame is unavailable. Analyze this range again.');};alpha.src=maskAssetUrl(key!,clip.projectId,`frames/${frame}.png`);}
    return()=>{live=false;};
  },[clip?.id,mask?.id,key,frame,editor.view,intent,manifest,sourceContext]);
  useEffect(()=>()=>{if(editor.clipId)useEditorStore.getState().releaseLock(editor.clipId,'smartMasks');},[editor.clipId]);
  if(!mask||!clip)return null;
  const locked=s.tracks.find(t=>t.id===clip.trackId)?.locked||s.locks.some(l=>l.targetId===clip.id&&l.userId!==s.currentUserId&&l.expiresAt>Date.now()&&['*','smartMasks'].includes(l.field));
  const ratio=mask.source.width/mask.source.height,fit={width:Math.min(size.width,size.height*ratio),height:Math.min(size.height,size.width/ratio)};
  const display=zoom==='Fit'?fit:{width:mask.source.width*Number(zoom)/100,height:mask.source.height*Number(zoom)/100};
  const guides=[...mask.prompts,...mask.repairs].filter(p=>smartMaskFrame(p.time,mask.source,times)===frame);
  const coordinate=(e:PointerEvent<SVGSVGElement>)=>{const box=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(e.clientY-box.top)/box.height))};};
  const end=(cancel=false)=>{const d=drawing.current;drawing.current=null;setStroke([]);if(d&&!cancel){const entry={id:createId('stroke'),time:d.time,kind:d.tool,points:d.points,radius:d.radius};if(d.tool==='include'||d.tool==='exclude')s.updateSmartMask(clip.id,mask.id,{prompts:[...mask.prompts,{...entry,kind:d.tool}]});else s.updateSmartMask(clip.id,mask.id,{repairs:[...mask.repairs,{...entry,kind:d.tool}]});}s.releaseLock(clip.id,'smartMasks');};
  const step=(delta:number)=>{const next=Math.max(0,Math.min((times?.length??Math.ceil(mask.source.duration*mask.source.fps))-1,frame+delta));useMaskEditor.setState({time:times?.[next]??next/mask.source.fps});};
  const marks=(points:SmartMaskPoint[],kind:MaskTool,radius:number,id:string)=><g key={id} stroke={colors[kind]} fill={colors[kind]}>{points.length===1?<circle cx={points[0].x*mask.source.width} cy={points[0].y*mask.source.height} r={Math.max(4,radius*Math.min(mask.source.width,mask.source.height))} fillOpacity=".25" strokeWidth="2"/>:<polyline points={points.map(p=>`${p.x*mask.source.width},${p.y*mask.source.height}`).join(' ')} fill="none" strokeWidth={Math.max(3,radius*Math.min(mask.source.width,mask.source.height)*2)} opacity=".7" strokeLinecap="round" strokeLinejoin="round"/>}</g>;
  return <section className="smart-mask-editor" aria-label={`Edit ${mask.name} mask`} onKeyDown={e=>{if((e.target as Element).closest('input,select'))return;if(e.key==='Escape'){useMaskEditor.setState({clipId:null,maskId:null});e.stopPropagation();}if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();step(e.key==='ArrowLeft'?-1:1);}if((e.metaKey||e.ctrlKey)&&e.key==='z'){e.preventDefault();e.stopPropagation();s.undo();}}}>
    <header><span className="smart-mask-dot"/><strong>{mask.name}</strong><small>Source frame editor</small><span className="spacer"/><select aria-label="Mask zoom" title="Native image detail. Scroll to pan at 100% or 200%." value={zoom} onChange={e=>setZoom(e.target.value)}><option value="Fit">Fit</option><option value="100">100%</option><option value="200">200%</option></select><select aria-label="Mask view" value={editor.view} onChange={e=>useMaskEditor.setState({view:e.target.value as MaskView})}>{['overlay','alpha','black','white'].map(v=><option key={v} value={v}>{v[0].toUpperCase()+v.slice(1)}</option>)}</select><button aria-label="Close mask editor" onClick={()=>useMaskEditor.setState({clipId:null,maskId:null})}><X size={16}/></button></header>
    <div className="smart-mask-tools" role="toolbar" aria-label="Mask drawing tools"><div>{(['include','exclude'] as const).map(tool=><button key={tool} aria-pressed={editor.tool===tool} onClick={()=>useMaskEditor.setState({tool})}>{tool==='include'?<Plus size={13}/>:<Minus size={13}/>} {tool==='include'?'Include':'Exclude'}</button>)}</div><span>Paint this frame</span><div>{(['foreground','background','unknown'] as const).map(tool=><button key={tool} aria-pressed={editor.tool===tool} onClick={()=>useMaskEditor.setState({tool})}><Paintbrush size={12}/>{tool==='foreground'?'Restore':tool==='background'?'Remove':'Reset'}</button>)}</div><label>Size<input aria-label="Mask brush radius" type="range" min={.002} max={.1} step={.001} value={editor.radius} onChange={e=>useMaskEditor.setState({radius:Number(e.target.value)})}/></label><button aria-label="Undo mask edit" onClick={()=>s.undo()}><Undo2 size={14}/></button></div>
    <div className="smart-mask-stage"><div className="smart-mask-surface" ref={surface} tabIndex={0} aria-label="Mask image viewport. Use scrollbars or arrow keys to pan." onKeyDown={e=>{if(e.target===e.currentTarget&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))e.stopPropagation();}}>
      <div className="smart-mask-scroll-content">
      <div className="smart-mask-picture" style={{width:display.width,height:display.height}}><canvas ref={canvas} aria-label={`Source frame ${frame+1}`}/><svg viewBox={`0 0 ${mask.source.width} ${mask.source.height}`} preserveAspectRatio="none" aria-label="Subject guidance canvas. Shift and arrow keys move the point; Enter adds it. Arrow keys step frames." role="application" tabIndex={0} style={{cursor:loaded&&!locked?'crosshair':'wait',touchAction:'none'}}
        onKeyDown={e=>{if(e.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation();setCursor(c=>({x:Math.max(0,Math.min(1,c.x+(e.key==='ArrowLeft'?-.01:e.key==='ArrowRight'?.01:0))),y:Math.max(0,Math.min(1,c.y+(e.key==='ArrowUp'?-.01:e.key==='ArrowDown'?.01:0))),visible:true}));}else if(e.key==='Enter'&&loaded&&times&&!locked){e.preventDefault();e.stopPropagation();if(!s.acquireLock(clip.id,'smartMasks'))return;drawing.current={points:[{x:cursor.x,y:cursor.y}],tool:editor.tool,time:frameTime,radius:editor.radius};end();}}}
        onPointerDown={e=>{if(e.button!==0||!loaded||!times||locked||!s.acquireLock(clip.id,'smartMasks'))return;e.preventDefault();setCursor(c=>({...c,visible:false}));e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);drawing.current={points:[coordinate(e)],tool:editor.tool,time:frameTime,radius:editor.radius};setStroke([...drawing.current.points]);}}
        onPointerMove={e=>{const d=drawing.current;if(!d)return;const p=coordinate(e),last=d.points.at(-1)!;if(Math.hypot(p.x-last.x,p.y-last.y)>.002&&d.points.length<2048){d.points.push(p);setStroke([...d.points]);s.renewLock(clip.id,'smartMasks');}}}
        onPointerUp={e=>{end();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>end(true)} onLostPointerCapture={()=>{if(drawing.current)end(true);}}>
        {cursor.visible&&<g stroke="white" strokeWidth={2}><circle cx={cursor.x*mask.source.width} cy={cursor.y*mask.source.height} r={6} fill="none"/></g>}{guides.map(g=>marks(g.points,g.kind,g.radius,g.id))}{stroke.length>0&&marks(stroke,editor.tool,editor.radius,'draft')}
      </svg></div></div></div>
      {(!loaded||!times||error)&&<p className="smart-mask-source-status" role={error?'alert':'status'}>{error||(!times?'Reading source frame timing…':'Loading source frame…')}</p>}
      {loaded&&!valid&&repairsPreview!==null&&manifest?.frames.some(f=>f.index===frame)&&<span className="smart-mask-review">Repair preview · analyze to publish</span>}
      {loaded&&!valid&&repairsPreview===null&&<span className="smart-mask-review">{mask.result?'Corrections changed · analyze to update matte':mask.prompts.some(p=>p.kind==='include')?'Guides saved · analyze the range in the inspector':'Source view · add an Include guide to begin'}</span>}
      {loaded&&canPreview&&!manifest?.frames.some(f=>f.index===frame)&&<span className="smart-mask-review">{manifest?'Source view · this frame has no analyzed matte':'Loading analyzed matte…'}</span>}
    </div>
    <footer><button aria-label="Previous mask frame" onClick={()=>step(-1)}><ChevronLeft size={15}/></button><input type="range" aria-label="Mask source frame" min={0} max={Math.max(0,(times?.length??Math.ceil(mask.source.duration*mask.source.fps))-1)} step={1} value={frame} onChange={e=>useMaskEditor.setState({time:times?.[Number(e.target.value)]??Number(e.target.value)/mask.source.fps})}/><button aria-label="Next mask frame" onClick={()=>step(1)}><ChevronRight size={15}/></button><span>Frame {frame+1} · {frameTime.toFixed(3)} s{!times?' · nominal fps':''}</span><button disabled={!guides.length||locked} onClick={()=>s.updateSmartMask(clip.id,mask.id,{prompts:mask.prompts.filter(p=>!guides.includes(p)),repairs:mask.repairs.filter(p=>!guides.includes(p))})}>Clear frame</button></footer>
  </section>;
}
