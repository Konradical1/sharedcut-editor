import {memo,useEffect,useId,useRef,useState,type CSSProperties,type PointerEvent} from 'react';
import {RotateCcw,Trash2} from 'lucide-react';
import {createId} from '../services';
import type {GradeNode,ColorCurve,CurvePoint,ColorCurves} from '../state/models';
import {identityCurve,sampleCurve,curveSlope} from '../services/color';
import {PARAM,HSL_CURVES,HUE_CURVES,flatCurve,fromOpponent,hueOf,opponent,sampleHueCurve} from '../services/grading';
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

export function Parameter({name,value,onChange,min=-1,max=1,step=.01}:{name:string;value:number;onChange:(v:number)=>void;min?:number;max?:number;step?:number}) {
  return <label className="grade-parameter"><span>{name}</span><input aria-label={name} type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))}/><NumberInput aria-label={`${name} value`} className="input mono" min={min} max={max} step={step} value={value} onCommit={onChange}/></label>;
}
/** Rec.709 luma weights: what the wheels, hue strips and HSL curve backgrounds are drawn with (grading.ts opponent space). */
const W=[.2126,.7152,.0722],RED=Math.atan2(.5,-W[0]/(2*(1-W[2]))),turn=(a:number)=>((a/(2*Math.PI))%1+1)%1;
/** The most saturated display colour of hue `h` in turns, as grading.ts hueOf counts it: red 0 → yellow → green → cyan → blue → magenta. */
export function hueColor(h:number){
  const a=RED+h*2*Math.PI,rgb=fromOpponent(0,Math.cos(a),Math.sin(a),W),lo=Math.min(...rgb),hi=Math.max(...rgb);
  return `rgb(${rgb.map(v=>Math.round((v-lo)/(hi-lo)*255)).join(' ')})`;
}
/** The wheels' hue ring, laid out as the vectorscope draws colour: red upper left, yellow left, green lower left, cyan down, blue right, magenta upper right. */
export const WHEEL_RING=`conic-gradient(${Array.from({length:37},(_,i)=>{const t=i*Math.PI/18;return `${hueColor(turn(Math.atan2(Math.cos(t),Math.sin(t))-RED))} ${i*10}deg`;}).join(',')})`;
const places=(step:number)=>Math.max(0,Math.ceil(-Math.log10(step)-1e-9));
/** A slider for one grade parameter (grading.ts GRADE_PARAMS: label, range, step and doc come from the registry). The fill runs from
 *  the neutral value to the current one; double-click resets. `name` is a shorter visible label; aria labels keep the registry's. */
export function GradeSlider({k,value,onChange,initial,name,className=''}:{k:string;value:number|undefined;onChange:(v:number)=>void;initial?:number;name?:string;className?:string}){
  const p=PARAM[k],init=initial??p.initial,v=value??init,at=(x:number)=>`${(Math.max(p.min,Math.min(p.max,x))-p.min)/(p.max-p.min)*100}%`;
  return <div className={`grade-slider ${className}${Math.abs(v-init)>1e-9?' changed':''}`} title={`${p.label}: ${p.doc}${p.unit&&p.unit.length>1?` (${p.unit})`:''} Double-click to reset.`} style={{'--from':at(Math.min(v,init)),'--to':at(Math.max(v,init))} as CSSProperties}
    onDoubleClick={e=>{if(!(e.target as Element).matches('input[inputmode=decimal]'))onChange(init);}}>
    <span>{name??p.label}</span>
    <NumberInput aria-label={`${p.label} value`} min={p.min} max={p.max} step={p.step} decimals={places(p.step)} value={v} onCommit={onChange}/>
    <input aria-label={p.label} type="range" min={p.min} max={p.max} step={p.step} value={v} onChange={e=>onChange(Number(e.target.value))}/>
  </div>;
}
/** An on/off grade parameter (stored as 1/0). */
export function GradeToggle({k,value,onChange,name}:{k:string;value:number|undefined;onChange:(v:number)=>void;name?:string}){
  const p=PARAM[k];
  return <label className="grade-toggle" title={p.doc}><input type="checkbox" role="switch" aria-label={p.label} checked={(value??0)>=.5} onChange={e=>onChange(e.target.checked?1:0)}/><i aria-hidden="true"/><span>{name??p.label}</span></label>;
}
/** Chroma at the rim of a wheel (cb/cr units); a larger balance pins the puck to the rim. */
const RIM=.12;
/** A balance wheel over `base`R/G/B (lift, gamma, gain, offset or a log range) and its master `base`. The puck sits where the offsets
 *  point on the vectorscope; dragging moves along it with luma unchanged. */
export function ColorWheel({name,base,node,update,title}:{name:string;base:string;node:GradeNode;update:(p:Record<string,number>)=>void;title?:string}){
  const p=node.parameters,keys=['R','G','B'].map(c=>base+c),rgb=keys.map(k=>p[k]??0),master=PARAM[base],[,cb,cr]=opponent(rgb,W);
  const drag=useRef<{x:number;y:number;c:number[]}|null>(null);
  const balance=(c:number[])=>update(Object.fromEntries(fromOpponent(c[0],c[1],c[2],W).map((v,i)=>[keys[i],+Math.max(-1,Math.min(1,v)).toFixed(5)])));
  const nudge=(dx:number,dy:number,c=opponent(rgb,W))=>{const next=[c[0],c[1]+dx,c[2]+dy];balance(next);return next;};
  const neutral=()=>update(Object.fromEntries(keys.map(k=>[k,0])));
  const r=Math.hypot(cb,cr)/RIM,k=r>1?.84/r:.84,px=cb/RIM*k,py=-cr/RIM*k;
  return <div className="color-wheel-control">
    <div className="wheel-heading"><span title={title}>{name}</span><IconButton label={`Reset ${name}`} onClick={()=>update({[base]:master.initial,...Object.fromEntries(keys.map(k=>[k,0]))})}><RotateCcw size={11}/></IconButton></div>
    <div className="color-wheel" role="group" tabIndex={0} aria-label={`${name} color balance; use RGB fields for keyboard control`} title={`${title?`${title}. `:''}Drag to balance · Shift for fine · Arrow keys nudge · Double-click resets`}
      onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(e.key))return;e.preventDefault();e.stopPropagation();const step=e.shiftKey?.0001:.001;if(e.key==='Home')neutral();else nudge(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0,e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0);}}
      onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.focus();drag.current={x:e.clientX,y:e.clientY,c:opponent(rgb,W)};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{const d=drag.current;if(!d||!e.currentTarget.hasPointerCapture(e.pointerId))return;const speed=(e.shiftKey?.0001:.001)*e.currentTarget.clientWidth/e.currentTarget.getBoundingClientRect().width;drag.current={x:e.clientX,y:e.clientY,c:nudge((e.clientX-d.x)*speed,-(e.clientY-d.y)*speed,d.c)};}}
      onPointerUp={e=>{drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}} onDoubleClick={neutral}>
      <svg viewBox="-1 -1 2 2" aria-hidden="true"><circle r=".42" className="wheel-guide"/><path d="M-.8 0H.8M0-.8V.8" className="wheel-cross"/>{r>.01&&<line x2={px} y2={py} className="wheel-vector"/>}<circle cx={px} cy={py} r=".07" className="wheel-puck"/></svg>
    </div>
    <div className="wheel-master" title={`${name} master (Y): ${master.doc} Double-click the slider to reset.`}><input aria-label={`${name} master`} type="range" min={master.min} max={master.max} step=".001" value={p[base]??master.initial} onChange={e=>update({[base]:Number(e.target.value)})} onDoubleClick={()=>update({[base]:master.initial})}/><NumberInput aria-label={`${name} Y`} decimals={3} step={.001} min={master.min} max={master.max} value={p[base]??master.initial} onCommit={value=>update({[base]:value})}/></div>
    <div className="wheel-rgb">{keys.map((key,i)=>{const q=PARAM[key],c='RGB'[i];return <NumberInput key={key} aria-label={`${name} ${c}`} title={`${name} ${c}: ${q.doc}`} className={`channel-${c}`} decimals={3} step={.001} min={q.min} max={q.max} value={p[key]??q.initial} onCommit={value=>update({[key]:value})}/>;})}</div>
  </div>;
}
/** Inset of a curve editor's plot, so points on its edges stay whole. */
const PAD=6;
/** The element's CSS size, so an SVG draws in pixels (round points, true slopes) rather than stretching a fixed viewBox. */
function useSize<T extends Element>(w:number,h:number){
  const ref=useRef<T>(null),[size,setSize]=useState({w,h});
  useEffect(()=>{const el=ref.current;if(!el)return;const o=new ResizeObserver(([e])=>{const r=e.contentRect;if(r.width&&r.height)setSize({w:r.width,h:r.height});});o.observe(el);return()=>o.disconnect();},[]);
  return [ref,size] as const;
}
export function Curves({node,update}:{node:GradeNode;update:(curves:ColorCurves)=>void}){
  const [channel,setChannel]=useState<'RGB'|'R'|'G'|'B'>('RGB'),[selected,setSelected]=useState<string|null>(null);
  const [svg,{w:sw,h:sh}]=useSize<SVGSVGElement>(600,240),w=sw-2*PAD,h=sh-2*PAD,X=(x:number)=>PAD+x*w,Y=(y:number)=>PAD+(1-y)*h,drag=useRef<{id:string;handle:boolean}|null>(null);
  const curves=nodeCurves(node),curve=curves[channel]??identityCurve();
  const index=curve.points.findIndex(p=>p.id===selected),point=curve.points[index];
  const commit=(next:ColorCurve)=>update({...curves,[channel]:next});
  const patch=(id:string,value:Partial<CurvePoint>)=>{const i=curve.points.findIndex(p=>p.id===id);if(i<0)return;const p=curve.points[i],x=i===0?0:i===curve.points.length-1?1:Math.max(curve.points[i-1].x+.001,Math.min(curve.points[i+1].x-.001,value.x??p.x));commit({...curve,points:curve.points.map(v=>v.id===id?{...v,...value,x,y:Math.max(0,Math.min(1,value.y??v.y))}:v)});};
  const coords=(e:PointerEvent<SVGSVGElement>)=>{const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left-PAD)/(b.width-2*PAD))),y:Math.max(0,Math.min(1,1-(e.clientY-b.top-PAD)/(b.height-2*PAD)))};};
  const remove=()=>{if(index>0&&index<curve.points.length-1){commit({...curve,points:curve.points.filter(p=>p.id!==selected)});setSelected(null);}};
  const color={RGB:'#e2e4e8',R:'#ed9391',G:'#97c9a4',B:'#8baef2'}[channel];
  return <div className="custom-curves" onKeyDown={e=>{if((e.key==='Backspace'||e.key==='Delete')&&!(e.target as HTMLElement).closest('input,select')){e.preventDefault();e.stopPropagation();remove();}}}>
    <div className="curve-toolbar"><div className="color-tabs" aria-label="Curve channel">{(['RGB','R','G','B']as const).map(c=><button key={c} aria-pressed={channel===c} onClick={()=>{setChannel(c);setSelected(null);}}>{c}</button>)}</div><select aria-label="Curve interpolation" value={curve.mode} onChange={e=>commit({...curve,mode:e.target.value as ColorCurve['mode']})}><option value="smooth">Smooth</option><option value="linear">Linear</option></select><span className="spacer"/><IconButton label="Reset current curve" onClick={()=>commit(identityCurve())}><RotateCcw size={14}/></IconButton><button disabled={curve.points.length>=64} onClick={()=>{let i=0;for(let j=1;j<curve.points.length-1;j++)if(curve.points[j+1].x-curve.points[j].x>curve.points[i+1].x-curve.points[i].x)i=j;const x=(curve.points[i].x+curve.points[i+1].x)/2,p={id:createId('point'),x,y:Math.max(0,Math.min(1,sampleCurve(x,curve)))};commit({...curve,points:[...curve.points,p].sort((a,b)=>a.x-b.x)});setSelected(p.id);}}>Add point</button><button onClick={()=>update(Object.fromEntries(Object.entries(curves).filter(([k])=>!['RGB','R','G','B'].includes(k))))}>Reset all</button></div>
    <svg ref={svg} className="curve-editor" viewBox={`0 0 ${sw} ${sh}`} role="application" aria-label={`${channel} custom curve. Click to add a point; drag to move it.`} tabIndex={0}
      onPointerDown={e=>{
        if(e.button!==0)return;const target=e.target as SVGElement,id=target.dataset.point,handle=target.dataset.handle;e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);
        if(id){setSelected(id);drag.current={id,handle:handle==='true'};return;}
        if(curve.points.length>=64)return;const p=coords(e);if(curve.points.some(v=>Math.abs(v.x-p.x)<.003))return;
        const next={id:createId('point'),...p};commit({...curve,points:[...curve.points,next].sort((a,b)=>a.x-b.x)});setSelected(next.id);drag.current={id:next.id,handle:false};
      }}
      onPointerMove={e=>{if(!drag.current||!e.currentTarget.hasPointerCapture(e.pointerId))return;const pos=coords(e),p=curve.points.find(p=>p.id===drag.current!.id);if(!p)return;
        if(drag.current.handle){if(Math.abs(pos.x-p.x)>.005)patch(p.id,{slope:Math.max(-20,Math.min(20,(pos.y-p.y)/(pos.x-p.x)))});}else patch(p.id,pos);
      }} onPointerUp={e=>{drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}>
      <path d={[.25,.5,.75].map(v=>`M${X(0)} ${Y(v)}H${X(1)}M${X(v)} ${Y(0)}V${Y(1)}`).join('')} className="curve-grid"/><path d={`M${X(0)} ${Y(0)}L${X(1)} ${Y(1)}`} className="curve-diagonal"/>
      <polyline points={Array.from({length:301},(_,i)=>`${X(i/300)},${Y(sampleCurve(i/300,curve))}`).join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none"/>
      {point&&curve.mode==='smooth'&&[-1,1].map(sign=>{const dx=sign*.075,dy=dx*curveSlope(curve,index);return <g key={sign}><line x1={X(point.x)} y1={Y(point.y)} x2={X(point.x+dx)} y2={Y(point.y+dy)} stroke={color} pointerEvents="none"/><circle data-point={point.id} data-handle="true" cx={X(point.x+dx)} cy={Y(point.y+dy)} r="4" fill="#22252b" stroke={color}/></g>;})}
      {curve.points.map((p,i)=><circle key={p.id} data-point={p.id} role="button" tabIndex={0} aria-label={`Curve point ${i+1}`} onFocus={()=>setSelected(p.id)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const step=e.shiftKey?.001:.01;patch(p.id,{x:p.x+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),y:p.y+(e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0)});}} cx={X(p.x)} cy={Y(p.y)} r={p.id===selected?7:5} fill={p.id===selected?color:'#25272d'} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
    </svg>
    <div className="curve-point-controls">{point?<><span>Point {index+1}</span><label>Input<NumberInput aria-label="Curve point input" value={point.x} min={index===0?0:curve.points[index-1]?.x+.001} max={index===curve.points.length-1?1:curve.points[index+1]?.x-.001} disabled={index===0||index===curve.points.length-1} step={.001} onCommit={x=>patch(point.id,{x})}/></label><label>Output<NumberInput aria-label="Curve point output" value={point.y} min={0} max={1} step={.001} onCommit={y=>patch(point.id,{y})}/></label>{curve.mode==='smooth'&&<><label>Tangent<NumberInput aria-label="Curve tangent" value={curveSlope(curve,index)} min={-20} max={20} step={.05} onCommit={slope=>patch(point.id,{slope})}/></label><button onClick={()=>{const points=curve.points.map(p=>{if(p.id!==point.id)return p;const {slope,...rest}=p;return rest;});commit({...curve,points});}}>Auto tangent</button></>}<IconButton label="Delete curve point" disabled={index===0||index===curve.points.length-1} onClick={remove}><Trash2 size={14}/></IconButton></>:<span>Click to add · Drag points or tangents · Backspace to remove</span>}<span className="spacer"/><small>{curve.points.length} / 64 points</small></div>
  </div>;
}
export type HslKind=typeof HSL_CURVES[number];
type Axis='hue'|'sat'|'lum';
/** What each HSL curve reads (x) and changes (y), as grading.ts hslCurves applies it. */
export const HSL_INFO:Record<HslKind,{label:string;x:Axis;y:Axis}>={HueHue:{label:'Hue vs Hue',x:'hue',y:'hue'},HueSat:{label:'Hue vs Sat',x:'hue',y:'sat'},HueLum:{label:'Hue vs Lum',x:'hue',y:'lum'},LumSat:{label:'Lum vs Sat',x:'lum',y:'sat'},SatSat:{label:'Sat vs Sat',x:'sat',y:'sat'},SatLum:{label:'Sat vs Lum',x:'sat',y:'lum'}};
/** Hues of the primaries and secondaries (R Y G C B M): where a new hue curve puts its points, so "the greens" are one grab. */
const HUES=[[1,0,0],[1,1,0],[0,1,0],[0,1,1],[0,0,1],[1,0,1]].map(c=>{const [,cb,cr]=opponent(c,W);return +hueOf(cb,cr,W).toFixed(4);}),HUE_NAMES=['Red','Yellow','Green','Cyan','Blue','Magenta'];
/** y (.5 = no change) in the unit a colourist reads: degrees of hue, a saturation factor, or a luma offset. */
const toUnit=(y:number,a:Axis)=>a==='hue'?(y-.5)*360:a==='sat'?2*y:(y-.5)/2,fromUnit=(v:number,a:Axis)=>a==='hue'?v/360+.5:a==='sat'?v/2:v*2+.5;
const signed=(v:number,d:number)=>`${v<-1e-9?'−':'+'}${Math.abs(v).toFixed(d)}`;
export const curveEffect=(y:number,a:Axis)=>{const v=toUnit(y,a);return a==='hue'?`${signed(v,0)}° hue`:a==='sat'?`×${v.toFixed(2)} sat`:`${signed(v,3)} lum`;};
const curveInput=(x:number,a:Axis)=>{if(a!=='hue')return `${a==='lum'?'Luma':'Saturation'} ${Math.round(x*100)}%`;const i=HUES.findIndex(h=>Math.min(Math.abs(h-x),1-Math.abs(h-x))<.02);return `${i<0?'Hue':HUE_NAMES[i]} ${Math.round(x*360)%360}°`;};
const STRIP:Record<Axis,string[]>={hue:Array.from({length:37},(_,i)=>hueColor(i/36)),lum:['#000','#fff'],sat:['#8a8a8a',hueColor(.06)]};
/** Hue vs Hue/Sat/Lum, Lum vs Sat, Sat vs Sat and Sat vs Lum (grading.ts hslCurves). The centre line is no change; hue curves wrap at red. */
/** A node's curves, an old three-point tone curve (curve25/50/75) standing in as its RGB curve, so saving any curve keeps it. */
function nodeCurves(node:GradeNode):ColorCurves{
  if(node.curves||!Object.keys(node.parameters).some(k=>/^curve(25|50|75)$/.test(k)))return node.curves??{};
  return {RGB:{mode:'linear',points:[{id:'black',x:0,y:0},...[.25,.5,.75].map((x,i)=>({id:`legacy${i}`,x,y:node.parameters[['curve25','curve50','curve75'][i]]??x})),{id:'white',x:1,y:1}]}};
}
export function HslCurve({kind,node,update}:{kind:HslKind;node:GradeNode;update:(curves:ColorCurves)=>void}){
  const info=HSL_INFO[kind],hue=HUE_CURVES.includes(kind),curves=nodeCurves(node),stored=curves[kind];
  const curve:ColorCurve=stored??(hue?{mode:'smooth',points:[...HUES.map((x,i)=>({id:`hue${i}`,x,y:.5})),{id:'hue6',x:1,y:.5}]}:flatCurve());
  const [selected,setSelected]=useState<string|null>(null),[svg,{w:sw,h:sh}]=useSize<SVGSVGElement>(600,200),drag=useRef<{id:string;x:number;y:number;px:number;py:number}|null>(null),gradient=`hsl-${kind}-${useId().replace(/\W/g,'')}`;
  const w=sw-2*PAD,h=sh-2*PAD,X=(x:number)=>PAD+x*w,Y=(y:number)=>PAD+(1-y)*h,index=curve.points.findIndex(p=>p.id===selected),point=curve.points[index],last=curve.points.length-1;
  const at=(x:number)=>Math.max(0,Math.min(1,hue?sampleHueCurve(x,curve):sampleCurve(x,curve)));
  const commit=(next:ColorCurve)=>update({...curves,[kind]:next});
  // Ends stay at 0 and 1; a hue curve's ends are the same red, so they move together.
  const patch=(id:string,x:number,y:number)=>{const i=curve.points.findIndex(p=>p.id===id);if(i<0)return;const cx=i===0?0:i===last?1:+Math.max(curve.points[i-1].x+.002,Math.min(curve.points[i+1].x-.002,x)).toFixed(4),cy=+Math.max(0,Math.min(1,y)).toFixed(4);commit({...curve,points:curve.points.map((p,j)=>j===i?{...p,x:cx,y:cy}:hue&&(i===0&&j===last||i===last&&j===0)?{...p,y:cy}:p)});};
  const remove=()=>{if(index>0&&index<last){commit({...curve,points:curve.points.filter(p=>p.id!==selected)});setSelected(null);}};
  const coords=(e:PointerEvent<SVGSVGElement>)=>{const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left-PAD)/(b.width-2*PAD))),y:Math.max(0,Math.min(1,1-(e.clientY-b.top-PAD)/(b.height-2*PAD)))};};
  const grab=(id:string,pos:{x:number;y:number},p:{x:number;y:number})=>{setSelected(id);drag.current={id,x:pos.x,y:pos.y,px:p.x,py:p.y};};
  const ink=(x:number)=>hue?hueColor(x):info.x==='lum'?`hsl(0 0% ${30+x*60}%)`:'#e6e8ec';
  return <div className="custom-curves hsl-curves" onKeyDown={e=>{if((e.key==='Backspace'||e.key==='Delete')&&!(e.target as HTMLElement).closest('input,select')){e.preventDefault();e.stopPropagation();remove();}}}>
    <svg ref={svg} className="curve-editor hsl-editor" viewBox={`0 0 ${sw} ${sh}`} role="application" tabIndex={0} aria-label={`${info.label} curve. Click to add a point; drag it up or down.`}
      onPointerDown={e=>{
        if(e.button!==0)return;e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);
        const pos=coords(e),id=(e.target as SVGElement).dataset.point,hit=id?curve.points.find(p=>p.id===id):curve.points.find(p=>Math.abs(p.x-pos.x)*w<7&&Math.abs(p.y-pos.y)*h<14);
        if(hit)return grab(hit.id,pos,hit);
        if(curve.points.length>=64||curve.points.some(p=>Math.abs(p.x-pos.x)<.004))return;
        // A new point lands on the curve, so a click alone changes nothing; dragging moves it from there.
        const next={id:createId('point'),x:+pos.x.toFixed(4),y:+at(pos.x).toFixed(4)};commit({...curve,points:[...curve.points,next].sort((a,b)=>a.x-b.x)});grab(next.id,pos,next);
      }}
      onPointerMove={e=>{const d=drag.current;if(!d||!e.currentTarget.hasPointerCapture(e.pointerId))return;const pos=coords(e),s=e.shiftKey?.2:1;patch(d.id,d.px+(pos.x-d.x)*s,d.py+(pos.y-d.y)*s);}}
      onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}>
      <defs><linearGradient id={gradient}>{STRIP[info.x].map((c,i,all)=><stop key={i} offset={i/(all.length-1)} stopColor={c}/>)}</linearGradient></defs>
      <rect width={sw} height={sh} fill={`url(#${gradient})`} className="curve-wash"/><rect x={PAD} y={sh-PAD-8} width={w} height={8} rx={1.5} fill={`url(#${gradient})`}/>
      <path d={(hue?HUES.slice(1):[.25,.5,.75]).map(x=>`M${X(x)} ${PAD}V${sh-PAD-8}`).join('')+`M${PAD} ${Y(.75)}H${X(1)}M${PAD} ${Y(.25)}H${X(1)}`} className="curve-grid"/>
      <path d={`M${PAD} ${Y(.5)}H${X(1)}`} className="curve-neutral"/>
      <polyline points={Array.from({length:241},(_,i)=>`${X(i/240)},${Y(at(i/240))}`).join(' ')} className="curve-line" pointerEvents="none"/>
      {curve.points.map((p,i)=><circle key={p.id} data-point={p.id} role="button" tabIndex={0} aria-label={`${info.label} point ${i+1}`} className={stored?undefined:'suggested'} onFocus={()=>setSelected(p.id)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const step=e.shiftKey?.002:.01;patch(p.id,p.x+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),p.y+(e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0));}} cx={X(p.x)} cy={Y(p.y)} r={p.id===selected?6.5:4.5} fill={p.id===selected?ink(p.x):'#1d1f24'} stroke={ink(p.x)}/>)}
    </svg>
    <div className="curve-point-controls">{point?<><strong>{curveInput(point.x,info.x)}</strong><span className={`curve-effect${Math.abs(point.y-.5)>1e-4?' active':''}`}>{curveEffect(point.y,info.y)}</span><label>{info.y==='hue'?'Shift °':info.y==='sat'?'Saturation ×':'Luma ±'}<NumberInput aria-label={`${info.label} point change`} value={+toUnit(point.y,info.y).toFixed(4)} min={toUnit(0,info.y)} max={toUnit(1,info.y)} step={info.y==='hue'?1:.01} decimals={info.y==='hue'?1:3} onCommit={v=>patch(point.id,point.x,fromUnit(v,info.y))}/></label><IconButton label="Delete curve point" disabled={index===0||index===last} onClick={remove}><Trash2 size={13}/></IconButton></>
      :<span>{hue?'Drag a colour up or down · Click the curve to add a point · Backspace removes':'Click the curve to add a point · Drag it up or down · Backspace removes'}</span>}
      <span className="spacer"/><button disabled={!stored} onClick={()=>{update(Object.fromEntries(Object.entries(curves).filter(([k])=>k!==kind)));setSelected(null);}}>Reset curve</button></div>
  </div>;
}
