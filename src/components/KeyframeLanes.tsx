import { intersects, selectionRect, shiftKeyframes, type SelectionRect } from '../services/selection';
import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ChevronDown, ChevronRight, Diamond, Spline, Plus, Trash2 } from 'lucide-react';
import type { Clip, Keyframe } from '../state/models';
import { useEditorStore } from '../state/store';
import { animationProperties, evaluateClip, evaluateNodes, frameTime, linearCurve, sampleKeyframes, boundedAnimationValue } from '../services/animation';
import { NumberInput } from './ui';
import { graphScale, graphStep } from '../services/graphScale';

type LaneProps = { inline?:boolean; clips: Clip[]; pixels: number; width: number; visibleStart: number; visibleEnd: number };
// Timeline passes a fresh `clips` array every render; compare its members so an unrelated re-render skips every lane.
const sameLanes = (a: LaneProps, b: LaneProps) => a.inline===b.inline&&a.pixels===b.pixels&&a.width===b.width&&a.visibleStart===b.visibleStart&&a.visibleEnd===b.visibleEnd&&a.clips.length===b.clips.length&&a.clips.every((clip,i)=>clip===b.clips[i]);
export default memo(KeyframeLanes, sameLanes);

function KeyframeLanes({ clips, pixels, width, visibleStart, visibleEnd, inline=false }: LaneProps) {
  const nodes=useEditorStore(s=>s.nodes), selected=useEditorStore(s=>s.selectedClipId);
  const fps=useEditorStore(s=>s.projects.find(p=>p.id===s.projectId)?.fps??24);
  const [choice,setChoice]=useState(''), [expanded,setExpanded]=useState<string[]>([]), [selection,setSelection]=useState<string[]>([]);
  const [draft,setDraft]=useState<{path:string;keys:Keyframe[]}|null>(null);
  const [views,setViews]=useState<Record<string,{mode:'selection'|'visible'|'all';manual?:{low:number;high:number}}>>({});
  const root=useRef<HTMLDivElement>(null),boxStart=useRef<{x:number;y:number;ids:string[]}|null>(null);
  const [box,setBox]=useState<SelectionRect|null>(null),[groupDraft,setGroupDraft]=useState<Clip['keyframes']>();
  const channelDraft=useRef<Clip['keyframes']>(undefined);
  const gesture=useRef<{ids:string[];channels:NonNullable<Clip['keyframes']>;x:number;y:number;keys:Keyframe[];index:number;path:string;kind:'point'|'in'|'out';range:number;low:number;scale:number;lease:ReturnType<typeof setInterval>}|null>(null);
  const draftRef=useRef(draft), actions=useEditorStore.getState;
  const clip=clips.find(c=>c.id===choice)??clips.find(c=>c.id===selected)??clips[0];
  useEffect(()=>{setSelection([]);setDraft(null);setGroupDraft(undefined);channelDraft.current=undefined;return()=>{const g=gesture.current;if(g){clearInterval(g.lease);actions().releaseLock(clip!.id,'*');gesture.current=null;draftRef.current=null;useEditorStore.setState({clipPreview:null});}};},[clip?.id]);
  // Only paths and labels are read here, and they do not change with time: evaluating at the clip start keeps the
  // lanes off the moving playhead (it re-rendered ~60 lanes every playback frame).
  const properties=useMemo(()=>clip?animationProperties(evaluateClip(clip,clip.start),evaluateNodes(nodes,clip,clip.start)):[],[clip,nodes]);
  if(!clip)return <div className="animation-empty">Add a clip to animate this track.</div>;
  const paths=Object.keys(clip.keyframes??{});
  const finish=(commit:boolean)=>{const g=gesture.current;if(!g)return;clearInterval(g.lease);gesture.current=null;if(commit&&channelDraft.current)actions().setAnimationChannels(clip.id,channelDraft.current);actions().releaseLock(clip.id,'*');draftRef.current=null;channelDraft.current=undefined;setGroupDraft(undefined);setDraft(null);useEditorStore.setState({clipPreview:null});};
  const start=(e:PointerEvent<SVGElement|HTMLButtonElement>,path:string,keys:Keyframe[],index:number,kind:'point'|'in'|'out',range=1,low=0)=>{
    e.preventDefault();e.stopPropagation();if(e.shiftKey&&kind==='point'){setSelection(selection.includes(keys[index].id)?selection.filter(id=>id!==keys[index].id):[...selection,keys[index].id]);return;}if(e.button!==0||actions().tracks.find(t=>t.id===clip.trackId)?.locked||!actions().acquireLock(clip.id,'*'))return;
    const lane=e.currentTarget.closest('.animation-lane')!,scale=lane.getBoundingClientRect().width/width;
    actions().selectClip(clip.id);
    const ids=kind==='point'&&selection.includes(keys[index].id)?selection:[keys[index].id];
    gesture.current={ids,channels:structuredClone(clip.keyframes??{}),x:e.clientX,y:e.clientY,keys:structuredClone(keys),index,path,kind,range,low,scale,lease:setInterval(()=>actions().renewLock(clip.id,'*'),3000)};setSelection(ids);e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move=(e:PointerEvent<SVGElement|HTMLButtonElement>)=>{
    const g=gesture.current;if(!g)return;
    const keys=structuredClone(g.keys),key=keys[g.index],dx=(e.clientX-g.x)/g.scale,dy=(e.clientY-g.y)/g.scale;
    if(g.kind==='point') {
      const channels=structuredClone(shiftKeyframes(g.channels,g.ids,dx/pixels,clip.duration,fps));
      if(e.currentTarget instanceof SVGElement)channels[g.path]=channels[g.path].map(k=>g.ids.includes(k.id)&&typeof k.value==='number'?{...k,value:boundedAnimationValue(g.path,Number((k.value-dy/110*g.range).toFixed(4)))}:k);
      channelDraft.current=channels;setGroupDraft(channels);useEditorStore.setState({clipPreview:{...clip,keyframes:channels}});return;
    } else {
      const next=keys[g.index+1];if(!next||typeof key.value!=='number'||typeof next.value!=='number')return;
      const curve=[...(key.curve??linearCurve)] as [number,number,number,number],index=g.kind==='out'?0:2;
      // Time handles only need [0,1] to keep x(t) monotonic; crossing them is how easeInOut/Back curves are drawn.
      curve[index]=Math.max(0,Math.min(1,curve[index]+dx/((next.time-key.time)*pixels)));
      curve[index+1]=Math.max(-10,Math.min(10,curve[index+1]-dy/110*g.range/(next.value-key.value||g.range)));
      key.interpolation='bezier';key.curve=curve;
    }
    keys.sort((a,b)=>a.time-b.time);channelDraft.current={...clip.keyframes,[g.path]:keys};draftRef.current={path:g.path,keys};setDraft(draftRef.current);useEditorStore.setState({clipPreview:{...clip,keyframes:{...clip.keyframes,[g.path]:keys}}});
  };
  const pointer={onPointerMove:move,onPointerUp:()=>finish(true),onPointerCancel:()=>finish(false),onLostPointerCapture:()=>finish(false)};
  const keyboard=(e:React.KeyboardEvent,path:string,keys:Keyframe[],key:Keyframe)=>{
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();e.stopPropagation();const ids=selection.includes(key.id)?selection:[key.id];actions().setAnimationChannels(clip.id,Object.fromEntries(Object.entries(clip.keyframes??{}).map(([p,ks])=>[p,ks.filter(k=>!ids.includes(k.id))])));setSelection([]);}
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();actions().setAnimationChannels(clip.id,shiftKeyframes(clip.keyframes??{},selection.includes(key.id)?selection:[key.id],(e.key==='ArrowLeft'?-1:1)/fps,clip.duration,fps));}
    if(e.key==='Escape')finish(false);
  };
  if(inline) {
    const path=paths[0],keys=(groupDraft?.[path]??(draft?.path===path?draft.keys:clip.keyframes?.[path]))??[];
    return <div className="animation-lane clip-keyframes" style={{width}}>{keys.filter(k=>k.time>=0&&k.time<clip.duration).map(key=><button data-key-id={key.id} key={key.id} className="clip-keyframe-line" style={{left:Math.max(5,(clip.start+key.time)*pixels)-clip.start*pixels}} aria-label={`${properties.find(p=>p.path===path)?.label} keyframe at frame ${Math.round(key.time*fps)}`} title={`Frame ${Math.round(key.time*fps)} · ${key.value} · drag to move`} onPointerDown={e=>start(e,path,keys,keys.indexOf(key),'point')} {...pointer} onKeyDown={e=>keyboard(e,path,keys,key)}><Diamond size={9} fill="currentColor"/></button>)}</div>;
  }
  const endBox=()=>{boxStart.current=null;setBox(null);};
  return <div ref={root} tabIndex={0} className="animation-rows" data-cursor-fallback={`track-label-${clip.trackId}`} onKeyDown={e=>{
    if((e.target as Element).closest('input,select,button,[role="slider"]'))return;
    if(e.key==='Escape'){endBox();setSelection([]);}
    if((e.key==='Delete'||e.key==='Backspace')&&selection.length){e.preventDefault();e.stopPropagation();actions().setAnimationChannels(clip.id,Object.fromEntries(Object.entries(clip.keyframes??{}).map(([path,keys])=>[path,keys.filter(k=>!selection.includes(k.id))])));setSelection([]);}
  }} onPointerDown={e=>{
    if(e.button!==0||(e.target as Element).closest('button,input,select,[role="slider"],.animation-label'))return;
    e.preventDefault();e.stopPropagation();e.currentTarget.focus();boxStart.current={x:e.clientX,y:e.clientY,ids:e.shiftKey?selection:[]};if(!e.shiftKey)setSelection([]);e.currentTarget.setPointerCapture(e.pointerId);
  }} onPointerMove={e=>{
    const start=boxStart.current;if(!start)return;e.stopPropagation();const rect=selectionRect(start.x,start.y,e.clientX,e.clientY),r=e.currentTarget.getBoundingClientRect(),scale=r.width/e.currentTarget.offsetWidth;
    setBox({x:(rect.x-r.left)/scale,y:(rect.y-r.top)/scale,width:rect.width/scale,height:rect.height/scale});
    const ids=Array.from(e.currentTarget.querySelectorAll('[data-key-id]')).filter(el=>{const r=el.getBoundingClientRect();return intersects(rect,{x:r.left,y:r.top,width:r.width,height:r.height});}).map(el=>el.getAttribute('data-key-id')!);setSelection([...new Set([...start.ids,...ids])]);
  }} onPointerUp={endBox} onPointerCancel={endBox} onLostPointerCapture={endBox}>
    {box&&<div className="selection-marquee" style={{left:box.x,top:box.y,width:box.width,height:box.height}}/>}

    <div className="animation-row"><div className="animation-label" data-cursor-anchor={`keyframes-${clip.id}-choice`}><Diamond size={12}/><select aria-label="Clip to animate" value={clip.id} onChange={e=>{setChoice(e.target.value);actions().selectClip(e.target.value);}}>{clips.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div><div className="animation-lane animation-add" data-cursor-anchor={`keyframes-${clip.id}-add`} data-time-span={width/pixels} style={{width}}><select aria-label={`Animate property on ${clip.name}`} value="" onChange={e=>{if(e.target.value)actions().keyframeProperty(clip.id,e.target.value);}}><option value="">＋ Animate property…</option>{properties.filter(p=>!paths.includes(p.path)).map(p=><option key={p.path} value={p.path}>{p.label}</option>)}</select><span>{selection.length?`${selection.length} keyframes selected`:'Shift-click or drag to select keyframes'}</span></div></div>
    {paths.map(path=>{
      const property=properties.find(p=>p.path===path);if(!property)return null;
      const keys=groupDraft?.[path]??(draft?.path===path?draft.keys:clip.keyframes![path]), open=expanded.includes(path), numeric=keys.every(k=>typeof k.value==='number'), active=keys.find(k=>selection.includes(k.id))??keys[0];
      const viewId=`${clip.id}:${path}`,view=views[viewId]??{mode:'selection' as const};
      const bounds=numeric?graphScale(keys,selection,view.mode,[visibleStart/pixels-clip.start,visibleEnd/pixels-clip.start]):{low:0,high:1,first:0,last:keys.length-1};
      const frozen=gesture.current?.path===path&&gesture.current.range!==1?gesture.current:null;
      const low=frozen?.low??view.manual?.low??bounds.low,high=frozen?frozen.low+frozen.range:view.manual?.high??bounds.high,range=high-low,step=graphStep(range);
      const fit=(mode:typeof view.mode)=>setViews({...views,[viewId]:{mode}});
      const zoom=(factor:number)=>{const center=(low+high)/2;setViews({...views,[viewId]:{...view,manual:{low:center-range*factor/2,high:center+range*factor/2}}});};
      const suffix=/properties\.(speed|zoom|opacity)$/.test(path)?'%':/properties\.(x|y|anchorX|anchorY|crop.*)$/.test(path)?'px':path==='properties.rotation'?'°':path==='properties.gain'?'dB':'';
      const y=(v:number)=>130-(v-low)/range*110,x=(time:number)=>(time+clip.start)*pixels;
      const overview=numeric?graphScale(keys,[],'all',[0,clip.duration]):bounds,oy=(v:number)=>28-(v-overview.low)/(overview.high-overview.low)*24;
      const visible=keys.filter(k=>x(k.time)>visibleStart-12&&x(k.time)<visibleEnd+12);
      const update=(patch:Partial<Keyframe>)=>actions().setKeyframes(clip.id,path,keys.map(k=>k.id===active.id?{...k,...patch}:k));
      return <div key={path}>
        <div className="animation-row"><div className="animation-label" data-cursor-anchor={`keyframes-${clip.id}-${path}-label`}><button aria-label={`${open?'Collapse':'Expand'} ${property.label} curve`} aria-expanded={open} onClick={()=>setExpanded(open?expanded.filter(p=>p!==path):[...expanded,path])}>{open?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button><span title={property.label}>{property.label}</span><button aria-label={`Add ${property.label} keyframe`} onClick={()=>actions().keyframeProperty(clip.id,path)}><Plus size={12}/></button></div><div className="animation-lane" data-cursor-anchor={`keyframes-${clip.id}-${path}`} data-time-span={width/pixels} style={{width}} onDoubleClick={e=>{const t=(e.clientX-e.currentTarget.getBoundingClientRect().left)/(pixels*e.currentTarget.getBoundingClientRect().width/width);actions().setPlayhead(t);actions().keyframeProperty(clip.id,path);}}>
          <div className="animation-span" style={{left:x(0),width:clip.duration*pixels}}/>{visible.map(key=><button data-key-id={key.id} key={key.id} className={`animation-diamond ${selection.includes(key.id)?'selected':''}`} aria-label={`${property.label} keyframe at frame ${Math.round(key.time*fps)}`} title={`Frame ${Math.round(key.time*fps)} · ${key.value}`} style={{left:Math.max(5,x(key.time))}} onPointerDown={e=>start(e,path,keys,keys.indexOf(key),'point')} {...pointer} onKeyDown={e=>keyboard(e,path,keys,key)} onDoubleClick={()=>actions().setPlayhead(clip.start+key.time)}><Diamond size={10} fill="currentColor"/></button>)}
        </div></div>
        {open&&<div className="animation-row animation-editor"><div className="animation-label animation-sidebar" data-cursor-anchor={`keyframes-${clip.id}-${path}-controls-${active.id}`}><span>{numeric?'Value curve':'Hold values'} {suffix&&`(${suffix})`}</span><div className="animation-key-controls">
          {numeric&&<><select style={{gridColumn:"1 / -1"}} aria-label={`${property.label} graph scale`} value={view.mode} onChange={e=>fit(e.target.value as typeof view.mode)}><option value="selection">Fit selected ramp</option><option value="visible">Fit visible</option><option value="all">Fit all</option></select><div className="animation-key-actions" style={{gridColumn:"1 / -1"}}><button aria-label={`Zoom in ${property.label} values`} onClick={()=>zoom(.65)}>＋</button><button aria-label={`Zoom out ${property.label} values`} onClick={()=>zoom(1/.65)}>−</button><button aria-label={`Reset ${property.label} scale`} onClick={()=>fit(view.mode)}>Fit</button></div></>}
          <label>Frame <NumberInput aria-label={`${property.label} keyframe frame`} min={0} max={Math.ceil(clip.duration*fps)-1} decimals={0} value={Math.round(active.time*fps)} onCommit={frame=>{const time=Math.round(frame)/fps;if(time>=0&&time<clip.duration&&!keys.some(k=>k.id!==active.id&&Math.abs(k.time-time)<.5/fps))update({time});}}/></label>
          <label>Value {typeof active.value==='boolean'?<input aria-label={`${property.label} keyframe value`} type="checkbox" checked={active.value} onChange={e=>update({value:e.target.checked})}/>:<input aria-label={`${property.label} keyframe value`} type={numeric?'number':/^#[a-f\d]{6}$/i.test(String(active.value))?'color':'text'} value={String(active.value)} step="any" onChange={e=>{if(!numeric||Number.isFinite(e.target.valueAsNumber))update({value:numeric?e.target.valueAsNumber:e.target.value});}}/>}</label>
          <select aria-label={`${property.label} interpolation`} value={active.interpolation} onChange={e=>update({interpolation:e.target.value as Keyframe['interpolation'],...(e.target.value==='bezier'?{curve:active.curve??[.25,.1,.25,1]}:{})})}>{(numeric?['linear','bezier','hold']:['hold','linear']).map(v=><option key={v}>{v}</option>)}</select>
          <div className="animation-key-actions">
            {numeric&&<button aria-label={`Ease in/out ${property.label} keyframe`} title="Ease in/out" onClick={()=>update({interpolation:'bezier',curve:[.42,0,.58,1]})}><Spline size={13}/></button>}
            <button aria-label={`Delete ${property.label} keyframe`} title="Delete keyframe" onClick={()=>actions().setKeyframes(clip.id,path,keys.filter(k=>k.id!==active.id))}><Trash2 size={12}/></button>
          </div>
          <button onClick={()=>actions().setKeyframes(clip.id,path,[])}>Remove animation</button>
        </div></div>
        <div className="animation-lane" data-cursor-anchor={`keyframes-${clip.id}-${path}-curve`} data-time-span={width/pixels} style={{width}}>{numeric&&<><svg className="animation-graph graph-overview" width={Math.max(1,visibleEnd-visibleStart)} height={36} style={{marginLeft:visibleStart}} viewBox={`${visibleStart} 0 ${Math.max(1,visibleEnd-visibleStart)} 36`} aria-label={`${property.label} full curve overview`}>
          <path className="graph-curve" d={Array.from({length:Math.ceil((visibleEnd-visibleStart)/4)+1},(_,i)=>{const px=Math.min(visibleEnd,visibleStart+i*4);return `${i?'L':'M'}${px},${oy(Number(sampleKeyframes(keys,px/pixels-clip.start)))}`;}).join(' ')}/>
          {keys.slice(0,-1).map((key,i)=>{const next=keys[i+1];if(x(next.time)<visibleStart||x(key.time)>visibleEnd)return null;const select=()=>{setSelection([key.id,next.id]);fit('selection');};return <rect key={key.id} x={x(key.time)} y={1} width={Math.max(1,x(next.time)-x(key.time))} height={33} className={`graph-ramp-target ${view.mode==='selection'&&i>=bounds.first&&i<bounds.last?'active':''}`} role="button" tabIndex={0} aria-label={`Focus ${property.label} ramp ${key.value}${suffix} to ${next.value}${suffix}`} onPointerDown={e=>{e.stopPropagation();select();}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}}}/>;})}
          <text x={visibleStart+6} y={11} className="graph-axis">Overview · select a ramp</text>
        </svg><svg className="animation-graph" width={Math.max(1,visibleEnd-visibleStart)} height={154} style={{marginLeft:visibleStart}} viewBox={`${visibleStart} 0 ${Math.max(1,visibleEnd-visibleStart)} 154`} aria-label={`${property.label} graph editor`}>
          {Array.from({length:Math.ceil(range/step)},(_,i)=>Math.ceil(low/step)*step+i*step).filter(v=>v<=high).map(v=><g key={v}><line x1={visibleStart} x2={visibleEnd} y1={y(v)} y2={y(v)} className="graph-grid"/><text x={visibleStart+6} y={y(v)-4} className="graph-axis">{Number(v.toFixed(3))}{suffix}</text></g>)}
          <path className="graph-curve" d={Array.from({length:Math.ceil((visibleEnd-visibleStart)/3)+1},(_,i)=>{const px=Math.min(visibleEnd,visibleStart+i*3);return `${i?'L':'M'}${px},${y(Number(sampleKeyframes(keys,px/pixels-clip.start)))}`;}).join(' ')}/>
          {keys.slice(0,-1).map((key,i)=>{const next=keys[i+1];if(key.interpolation!=='bezier'||x(next.time)<visibleStart||x(key.time)>visibleEnd)return null;const curve=key.curve??linearCurve;return (['out','in'] as const).map((kind,j)=>{const cx=x(key.time+(next.time-key.time)*curve[j*2]),cy=y(Number(key.value)+(Number(next.value)-Number(key.value))*curve[j*2+1]),point=j?next:key;return <g key={`${key.id}-${kind}`}><line className="graph-tangent" x1={x(point.time)} y1={y(Number(point.value))} x2={cx} y2={cy}/><circle className="graph-handle" role="slider" tabIndex={0} aria-label={`${property.label} ${kind} Bézier handle`} aria-valuenow={curve[j*2]} cx={cx} cy={cy} r={5} onPointerDown={e=>start(e,path,keys,i,kind,range,low)} {...pointer} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation();const c=[...curve] as typeof curve;const axis=e.key==='ArrowLeft'||e.key==='ArrowRight'?j*2:j*2+1;c[axis]+=(e.key==='ArrowLeft'||e.key==='ArrowDown'?-.02:.02);if(axis%2===0)c[axis]=Math.max(j?c[0]:0,Math.min(j?1:c[2],c[axis]));actions().setKeyframes(clip.id,path,keys.map(k=>k.id===key.id?{...k,curve:c}:k));}}}/></g>;});})}
          {visible.map(key=><circle data-key-id={key.id} key={key.id} className={`graph-point ${selection.includes(key.id)?'selected':''}`} role="slider" tabIndex={0} aria-label={`${property.label} graph point frame ${Math.round(key.time*fps)}`} aria-valuenow={Number(key.value)} cx={x(key.time)} cy={y(Number(key.value))} r={5} onPointerDown={e=>start(e,path,keys,keys.indexOf(key),'point',range,low)} {...pointer} onKeyDown={e=>keyboard(e,path,keys,key)}/>)}
          {active&&<text x={Math.max(visibleStart+8,Math.min(visibleEnd-80,x(active.time)+10))} y={Math.max(12,y(Number(active.value))-10)} className="graph-axis graph-value">{Number(Number(active.value).toFixed(3))}{suffix}</text>}
        </svg></>}</div></div>}
      </div>;
    })}
  </div>;
}
