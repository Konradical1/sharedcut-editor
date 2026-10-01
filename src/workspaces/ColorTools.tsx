import {memo,useEffect,useRef,useState,type PointerEvent} from 'react';
import {RotateCcw,Trash2} from 'lucide-react';
import {createId} from '../services';
import type {GradeNode,ColorCurve,CurvePoint,ColorCurves} from '../state/models';
import {identityCurve,sampleCurve,curveSlope} from '../services/color';
import {IconButton,NumberInput} from '../components/ui';
import {useEditorStore} from '../state/store';
import {renderScope,SAMPLE_HEIGHT,SAMPLE_WIDTH,SCOPE_HEIGHT,SCOPE_WIDTH,type Scope} from './scopeRender';
export type {Scope};
export const scopes: Scope[] = ['Waveform', 'RGB Parade', 'Vectorscope', 'Histogram'];
const canvas2d=(width:number,height:number)=>{const c=document.createElement('canvas');c.width=width;c.height=height;return c.getContext('2d',{willReadFrequently:true})!;};
export const ScopeDisplay = memo(function ScopeDisplay({ type }: { type: Scope }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const sample=canvas2d(SAMPLE_WIDTH,SAMPLE_HEIGHT),scope=canvas2d(SCOPE_WIDTH,SCOPE_HEIGHT);
    // Newest wins: a plot finishing late on the worker never covers one drawn since.
    let worker:Worker|undefined,busy=false,failed=false,issued=0,shown=0;
    const show=(picture:CanvasImageSource,revision:string,ticket:number)=>{
      const canvas=ref.current,ctx=canvas?.getContext('2d');if(!canvas||!ctx||ticket<shown)return;
      shown=ticket;ctx.drawImage(picture,0,0);
      canvas.dataset.frameRevision=revision;canvas.dataset.updatedAt=String(performance.now());
    };
    const draw = (event: Event) => {
      const source=(event as CustomEvent<HTMLCanvasElement>).detail,revision=source?.dataset.frameRevision||'';
      if(!ref.current||!source?.width)return;
      // Reading the GPU frame back stalls this thread (~13 ms a picture, a third of playback's main thread). Playing, the
      // worker reads and plots it, one picture at a time; paused, it is plotted here at once so the scope matches the picture.
      if(useEditorStore.getState().playing&&!failed){
        if(busy)return;
        busy=true;const ticket=++issued;
        if(!worker){worker=new Worker(new URL('./scopeWorker.ts',import.meta.url),{type:'module'});worker.onmessage=({data}:MessageEvent<{picture:ImageBitmap;revision:string;ticket:number}>)=>{busy=false;show(data.picture,data.revision,data.ticket);data.picture.close();};worker.onerror=()=>{busy=false;failed=true;};}
        const target=worker;
        createImageBitmap(source,{resizeWidth:SAMPLE_WIDTH,resizeHeight:SAMPLE_HEIGHT}).then(frame=>target.postMessage({frame,type,revision,ticket},[frame])).catch(()=>{busy=false;});
        return;
      }
      sample.drawImage(source,0,0,SAMPLE_WIDTH,SAMPLE_HEIGHT);
      renderScope(scope,sample.getImageData(0,0,SAMPLE_WIDTH,SAMPLE_HEIGHT).data,type);
      show(scope.canvas,revision,++issued);
    };
    window.addEventListener('frameline:scope-frame',draw);
    window.dispatchEvent(new Event('frameline:request-scope'));
    // The last plot of playback can trail the picture it stopped on; pausing redraws the picture, and the scope with it.
    const paused=useEditorStore.subscribe((state,previous)=>{if(previous.playing&&!state.playing)window.dispatchEvent(new Event('frameline:request-scope'));});
    return ()=>{window.removeEventListener('frameline:scope-frame',draw);paused();worker?.terminate();};
  },[type]);
  return <div className="scope-display"><canvas ref={ref} width={SCOPE_WIDTH} height={SCOPE_HEIGHT} role="img" aria-label={`${type} of the current SDR preview`} style={{width:'100%',height:'100%',objectFit:'contain'}}/><div className="scope-axis"><span>0</span><span>SDR preview samples</span><span>100%</span></div></div>;
});

const defaults:Record<string,number>={exposure:0,temperature:0,tint:0,contrast:1,pivot:.5,saturation:100,lift:0,gamma:0,gain:1,offset:0,curve25:.25,curve50:.5,curve75:.75};
export function Parameter({name,value,onChange,min=-1,max=1,step=.01}:{name:string;value:number;onChange:(v:number)=>void;min?:number;max?:number;step?:number}) {
  return <label className="grade-parameter"><span>{name}</span><input aria-label={name} type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))}/><NumberInput aria-label={`${name} value`} className="input mono" min={min} max={max} step={step} value={value} onCommit={onChange}/></label>;
}
export function ColorWheel({label,node,update}:{label:string;node:GradeNode;update:(p:Record<string,number>)=>void}) {
  const key=label.toLowerCase(), p=node.parameters, channels=['R','G','B'], rgb=channels.map(c=>p[key+c]??0), x=(rgb[0]-rgb[2])/2, y=rgb[1]-(rgb[0]+rgb[2])/2;
  const start=useRef<{x:number;y:number;rgb:number[]} | null>(null);
  const balance=(values:number[],dx:number,dy:number)=>values.map((v,i)=>Math.max(-1,Math.min(1,v+[dx-dy/3,dy*2/3,-dx-dy/3][i])));
  const commit=(values:number[])=>update(Object.fromEntries(channels.map((c,i)=>[key+c,values[i]])));
  const move=(e:PointerEvent<HTMLDivElement>)=>{
    const previous=start.current;if(!previous||!e.currentTarget.hasPointerCapture(e.pointerId))return;
    const scale=e.currentTarget.clientWidth/e.currentTarget.getBoundingClientRect().width,speed=(e.shiftKey?.00012:.0012)*scale;
    const values=balance(previous.rgb,(e.clientX-previous.x)*speed,-(e.clientY-previous.y)*speed);
    start.current={x:e.clientX,y:e.clientY,rgb:values};commit(values);
  };
  const radius=Math.max(.3,Math.hypot(x,y));
  return <div className="color-wheel-control"><div className="wheel-heading"><span>{label}</span><IconButton label={`Reset ${label}`} onClick={()=>update({[key]:defaults[key],...Object.fromEntries(channels.map(c=>[key+c,0]))})}><RotateCcw size={12}/></IconButton></div>
    <div className="color-wheel" role="group" tabIndex={0} aria-label={`${label} color balance; use RGB fields for keyboard control`} title="Drag to balance · Shift for fine adjustment · Arrow keys to nudge · Double-click to reset" onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(e.key))return;e.preventDefault();e.stopPropagation();const step=e.shiftKey?.0001:.001;commit(e.key==='Home'?[0,0,0]:balance(rgb,e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0,e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0));}} onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.focus();start.current={x:e.clientX,y:e.clientY,rgb};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={move} onPointerUp={e=>{start.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{start.current=null;}} onLostPointerCapture={()=>{start.current=null;}} onDoubleClick={()=>update(Object.fromEntries(channels.map(c=>[key+c,0])))}><div className="wheel-cross"/><span className="wheel-position" style={{left:`${50+x/radius*43}%`,top:`${50-y/radius*43}%`}}/></div>
    <input aria-label={`${label} master`} type="range" min={key==='gain'?0:-1} max={key==='gain'?2:1} step=".001" value={p[key]??defaults[key]} onChange={e=>update({[key]:Number(e.target.value)})}/>
    <div className="wheel-rgb">{['Y',...channels].map((c,i)=><label key={c} style={{color:['#aaa','#df8585','#95bd94','#91aede'][i]}}>{c}<NumberInput aria-label={`${label} ${c}`} decimals={4} step={.001} min={i?-1:key==='gain'?0:-1} max={i?1:key==='gain'?2:1} value={p[i?key+c:key]??(i?0:defaults[key])} onCommit={value=>update({[i?key+c:key]:value})}/></label>)}</div>
  </div>;
}
export function Curves({node,update}:{node:GradeNode;update:(curves:ColorCurves)=>void}){
  const [channel,setChannel]=useState<'RGB'|'R'|'G'|'B'>('RGB'),[selected,setSelected]=useState<string|null>(null);
  const svg=useRef<SVGSVGElement>(null),drag=useRef<{id:string;handle:boolean}|null>(null);
  const legacy:ColorCurve={mode:'linear',points:[{id:'black',x:0,y:0},...[.25,.5,.75].map((x,i)=>({id:`legacy${i}`,x,y:node.parameters[['curve25','curve50','curve75'][i]]??x})),{id:'white',x:1,y:1}]};
  const curves=node.curves??(Object.keys(node.parameters).some(k=>k.startsWith('curve'))?{RGB:legacy}:{}),curve=curves[channel]??identityCurve();
  const index=curve.points.findIndex(p=>p.id===selected),point=curve.points[index];
  const commit=(next:ColorCurve)=>update({...curves,[channel]:next});
  const patch=(id:string,value:Partial<CurvePoint>)=>{const i=curve.points.findIndex(p=>p.id===id);if(i<0)return;const p=curve.points[i],x=i===0?0:i===curve.points.length-1?1:Math.max(curve.points[i-1].x+.001,Math.min(curve.points[i+1].x-.001,value.x??p.x));commit({...curve,points:curve.points.map(v=>v.id===id?{...v,...value,x,y:Math.max(0,Math.min(1,value.y??v.y))}:v)});};
  const coords=(e:PointerEvent<SVGSVGElement>)=>{const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,1-(e.clientY-b.top)/b.height))};};
  const remove=()=>{if(index>0&&index<curve.points.length-1){commit({...curve,points:curve.points.filter(p=>p.id!==selected)});setSelected(null);}};
  const color={RGB:'#e2e4e8',R:'#ed9391',G:'#97c9a4',B:'#8baef2'}[channel];
  return <div className="custom-curves" onKeyDown={e=>{if((e.key==='Backspace'||e.key==='Delete')&&!(e.target as HTMLElement).closest('input,select')){e.preventDefault();e.stopPropagation();remove();}}}>
    <div className="curve-toolbar"><div className="color-tabs" aria-label="Curve channel">{(['RGB','R','G','B']as const).map(c=><button key={c} aria-pressed={channel===c} onClick={()=>{setChannel(c);setSelected(null);}}>{c}</button>)}</div><select aria-label="Curve interpolation" value={curve.mode} onChange={e=>commit({...curve,mode:e.target.value as ColorCurve['mode']})}><option value="smooth">Smooth</option><option value="linear">Linear</option></select><span className="spacer"/><IconButton label="Reset current curve" onClick={()=>commit(identityCurve())}><RotateCcw size={14}/></IconButton><button disabled={curve.points.length>=64} onClick={()=>{let i=0;for(let j=1;j<curve.points.length-1;j++)if(curve.points[j+1].x-curve.points[j].x>curve.points[i+1].x-curve.points[i].x)i=j;const x=(curve.points[i].x+curve.points[i+1].x)/2,p={id:createId('point'),x,y:Math.max(0,Math.min(1,sampleCurve(x,curve)))};commit({...curve,points:[...curve.points,p].sort((a,b)=>a.x-b.x)});setSelected(p.id);}}>Add point</button><button onClick={()=>update({})}>Reset all</button></div>
    <svg ref={svg} className="curve-editor" viewBox="0 0 600 240" preserveAspectRatio="none" role="application" aria-label={`${channel} custom curve. Click to add a point; drag to move it.`} tabIndex={0}
      onPointerDown={e=>{
        if(e.button!==0)return;const target=e.target as SVGElement,id=target.dataset.point,handle=target.dataset.handle;e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);
        if(id){setSelected(id);drag.current={id,handle:handle==='true'};return;}
        if(curve.points.length>=64)return;const p=coords(e);if(curve.points.some(v=>Math.abs(v.x-p.x)<.003))return;
        const next={id:createId('point'),...p};commit({...curve,points:[...curve.points,next].sort((a,b)=>a.x-b.x)});setSelected(next.id);drag.current={id:next.id,handle:false};
      }}
      onPointerMove={e=>{if(!drag.current||!e.currentTarget.hasPointerCapture(e.pointerId))return;const pos=coords(e),p=curve.points.find(p=>p.id===drag.current!.id);if(!p)return;
        if(drag.current.handle){if(Math.abs(pos.x-p.x)>.005)patch(p.id,{slope:Math.max(-20,Math.min(20,(pos.y-p.y)/(pos.x-p.x)))});}else patch(p.id,pos);
      }} onPointerUp={e=>{drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}>
      <path d="M0 60H600M0 120H600M0 180H600M150 0V240M300 0V240M450 0V240" stroke="#303238"/><path d="M0 240L600 0" stroke="#535761" strokeDasharray="4 6"/>
      <polyline points={Array.from({length:301},(_,i)=>`${i*2},${240-sampleCurve(i/300,curve)*240}`).join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none"/>
      {point&&curve.mode==='smooth'&&[-1,1].map(sign=>{const dx=sign*.075,dy=dx*curveSlope(curve,index);return <g key={sign}><line x1={point.x*600} y1={(1-point.y)*240} x2={(point.x+dx)*600} y2={(1-point.y-dy)*240} stroke={color} pointerEvents="none"/><circle data-point={point.id} data-handle="true" cx={(point.x+dx)*600} cy={(1-point.y-dy)*240} r="4" fill="#22252b" stroke={color}/></g>;})}
      {curve.points.map((p,i)=><circle key={p.id} data-point={p.id} role="button" tabIndex={0} aria-label={`Curve point ${i+1}`} onFocus={()=>setSelected(p.id)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const step=e.shiftKey?.001:.01;patch(p.id,{x:p.x+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),y:p.y+(e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0)});}} cx={p.x*600} cy={(1-p.y)*240} r={p.id===selected?7:5} fill={p.id===selected?color:'#25272d'} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
    </svg>
    <div className="curve-point-controls">{point?<><span>Point {index+1}</span><label>Input<NumberInput aria-label="Curve point input" value={point.x} min={index===0?0:curve.points[index-1]?.x+.001} max={index===curve.points.length-1?1:curve.points[index+1]?.x-.001} disabled={index===0||index===curve.points.length-1} step={.001} onCommit={x=>patch(point.id,{x})}/></label><label>Output<NumberInput aria-label="Curve point output" value={point.y} min={0} max={1} step={.001} onCommit={y=>patch(point.id,{y})}/></label>{curve.mode==='smooth'&&<><label>Tangent<NumberInput aria-label="Curve tangent" value={curveSlope(curve,index)} min={-20} max={20} step={.05} onCommit={slope=>patch(point.id,{slope})}/></label><button onClick={()=>{const points=curve.points.map(p=>{if(p.id!==point.id)return p;const {slope,...rest}=p;return rest;});commit({...curve,points});}}>Auto tangent</button></>}<IconButton label="Delete curve point" disabled={index===0||index===curve.points.length-1} onClick={remove}><Trash2 size={14}/></IconButton></>:<span>Click to add · Drag points or tangents · Backspace to remove</span>}<span className="spacer"/><small>{curve.points.length} / 64 points</small></div>
  </div>;
}
