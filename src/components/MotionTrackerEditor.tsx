import {memo,useEffect,useMemo,useRef,useState,type CSSProperties,type PointerEvent,type ReactNode} from 'react';
import {Check,ChevronsLeft,ChevronsRight,Crosshair,Plus,Settings2,Square,StepBack,StepForward,Trash2,Undo2} from 'lucide-react';
import {useEditorStore} from '../state/store';
import {smartMaskPreviewContext} from '../services/smartMaskPreview';
import {fieldOwnsKey} from '../services/focus';
import {clipFrames,frameAt,placeKey,trackerPath,type MotionTracker,type TrackPoint} from '../services/motionTracker';
import {clearTrack,loadSourceTimes,runTracker,stopTracker,useTrackerEditor,useTrackerSamples,type TrackerRow} from '../services/motionTrackerClient';
import {registerFocusStep,showFocusFrame,useFocusZoom} from '../services/sourceFocus';
import {FrameStrip,Slot,SourceStill,useWidth,variableRate,type FocusSlots} from './FocusParts';
import {timecode} from './ui';
import './motionTracker.css';

/** Colour of a tracked frame: confident, doubtful, below the floor, bridged across an occlusion, or placed by hand. */
export function confidenceColor(point:TrackPoint|undefined,floor:number,color:string){
  if(!point)return '#2a3136';
  if(point.flag===1)return color;
  if(point.flag===2)return '#ff9f43';
  return point.confidence>=.8?'#5fe3a1':point.confidence>=floor?'#ffd166':'#ff6b6b';
}
const reasons:Record<string,string>={
  lost:'Lost the subject here. Drag the point back onto it, then track again.',
  'left-frame':'The point left the picture.',
  key:'Stopped at a point you placed.',
  end:'Reached the end of the clip.',
  start:'Reached the start of the clip.',
};

/** The track with a run's rows laid over it as they arrive, so the path grows on screen while it is tracked. */
function livePath(tracker:MotionTracker,base:TrackPoint[],rows:TrackerRow[]){
  const own=rows.filter(row=>row[0]===tracker.id);
  if(!own.length)return base;
  const byFrame=new Map(base.filter(p=>p.frame!==undefined&&p.flag!==1).map(p=>[p.frame!,p]));
  for(const row of own)byFrame.set(row[1],{frame:row[1],time:row[2],x:row[3],y:row[4],confidence:row[5],scale:row[6],rotation:row[7],flag:row[8] as 0|2});
  const sorted=[...byFrame.values()].sort((a,b)=>a.frame!-b.frame!);
  return trackerPath(tracker,{version:1,mediaId:tracker.source.mediaId,frames:sorted.map(p=>p.frame!),times:sorted.map(p=>p.time),x:sorted.map(p=>p.x),y:sorted.map(p=>p.y),confidence:sorted.map(p=>p.confidence),scale:sorted.map(p=>p.scale),rotation:sorted.map(p=>p.rotation),flags:sorted.map(p=>p.flag)});
}

const NO_ROWS:TrackerRow[]=[];
/** A select keeps focus after a pick, and would then take the arrow keys that step frames. */
const release=(e:{currentTarget:HTMLElement})=>e.currentTarget.blur();

/** move: the point; feature/search: a box resized about the point; draw: a new feature box dragged out corner to corner. */
type Drag={mode:'move'|'feature'|'search'|'draw';pointerId:number;x:number;y:number;width:number;height:number;anchor?:{x:number;y:number};grab?:{x:number;y:number};moved?:boolean};

/**
 * The motion tracker, drawn over the viewer's own streaming picture of the clip's source. It plays, scrubs and steps
 * like the timeline; the point, its boxes and the path ride the frame on screen. Its tools sit in one bar above the
 * picture and its tracked frames in one strip below it.
 */
function MotionTrackerEditor({bar,strip}:FocusSlots){
  const editor=useTrackerEditor();
  const clip=useEditorStore(s=>s.clips.find(c=>c.id===editor.clipId&&c.projectId===s.projectId&&c.timelineId===s.timelineId));
  const asset=useEditorStore(s=>clip&&s.media.find(a=>a.id===clip.mediaId));
  const playing=useEditorStore(s=>s.playing);
  const locked=useEditorStore(s=>!!clip&&(!!s.tracks.find(t=>t.id===clip.trackId)?.locked||s.locks.some(l=>l.targetId===clip.id&&l.userId!==s.currentUserId&&l.expiresAt>Date.now()&&['*','motionTrackers'].includes(l.field))));
  const zoom=useFocusZoom(s=>s.zoom);
  const tracker=clip?.motionTrackers?.find(t=>t.id===editor.trackerId);
  const [times,setTimes]=useState<number[]|null>(null),[error,setError]=useState(''),[all,setAll]=useState(false),[drag,setDrag]=useState<Drag|null>(null);
  const svg=useRef<SVGSVGElement>(null),renewed=useRef(0),slider=useRef<string|undefined>(undefined),shownWidth=useWidth(svg,!!(clip&&tracker&&asset));
  const samples=useTrackerSamples(clip?.projectId,tracker?.result?.key);
  const context=clip&&asset?smartMaskPreviewContext(clip,asset):'';
  useEffect(()=>{setTimes(null);setError('');if(!clip)return;let live=true;void loadSourceTimes(clip).then(value=>{if(live)setTimes(value);}).catch(cause=>{if(live)setError((cause as Error).message||'Source timing is unavailable.');});return()=>{live=false;};},[clip?.id,clip?.mediaId]);
  useEffect(()=>()=>{if(editor.clipId)useEditorStore.getState().releaseLock(editor.clipId,'motionTrackers');},[editor.clipId]);
  // A tracker deleted, or its clip gone, closes the editor rather than leaving it on nothing.
  useEffect(()=>{if(editor.clipId&&(!clip||!tracker))useTrackerEditor.setState({clipId:null,trackerId:null});},[editor.clipId,!!clip,!!tracker]);
  const job=editor.job?.clipId===clip?.id?editor.job:null,running=!!job&&['starting','queued','running'].includes(job.status);
  // A run's rows are laid over the track while it runs, and until the track it saved has downloaded; then the saved
  // track is the truth.
  const settling=!!job&&!running&&!!tracker?.result&&job.results?.[tracker.id]===tracker.result.key&&!samples;
  const liveRows=running||settling?job!.rows:undefined;
  const path=useMemo(()=>tracker?livePath(tracker,trackerPath(tracker,samples),liveRows??[]):[],[tracker,samples,liveRows]);
  const variable=useMemo(()=>variableRate(times),[times]);
  const byFrame=useMemo(()=>times?new Map(path.map(p=>[frameAt(times,p.time),p])):new Map<number,TrackPoint>(),[path,times]);
  const bounds=clip&&asset&&times?clipFrames(clip,asset,times):{first:0,last:0};
  const frame=times?Math.max(bounds.first,Math.min(bounds.last,frameAt(times,editor.time))):0;
  const frameTime=times?.[frame]??editor.time;
  const fps=tracker?.source.fps??asset?.fps??24,half=.5/fps;
  const here=byFrame.get(frame);
  const W=tracker?.source.width??1,H=tracker?.source.height??1,unit=W/shownWidth;// source pixels per screen pixel
  const go=(index:number)=>{if(!times)return;useEditorStore.getState().setPlaying(false);showFocusFrame(times[Math.max(bounds.first,Math.min(bounds.last,index))]);};
  const stepTo=useRef(go);stepTo.current=go;
  useEffect(()=>registerFocusStep(delta=>stepTo.current(frameAt(times??[],useTrackerEditor.getState().time)+delta)),[times]);
  // Zoomed in, keep the point in view as the frames go by.
  useEffect(()=>{
    const el=svg.current,stage=el?.closest('.viewer-stage') as HTMLElement|null;if(!el||!stage||zoom==='Fit'||!here)return;
    const box=el.getBoundingClientRect(),view=stage.getBoundingClientRect(),x=box.left+here.x*box.width-view.left,y=box.top+here.y*box.height-view.top;
    if(x<40||x>view.width-40||y<40||y>view.height-40){stage.scrollLeft+=x-view.width/2;stage.scrollTop+=y-view.height/2;}
  },[frame,zoom,here?.x,here?.y]);
  const keys=useRef<(e:KeyboardEvent)=>boolean>(()=>false);
  useEffect(()=>{
    // Capture: while the tracker is open its keys beat the timeline's (Delete would otherwise delete the clip).
    const key=(e:KeyboardEvent)=>{
      if(e.defaultPrevented||fieldOwnsKey(e.target as Element,e.key))return;
      // Delete and Backspace never reach the timeline, with or without a modifier: there they delete the clip.
      if((e.metaKey||e.ctrlKey)&&e.key!=='Delete'&&e.key!=='Backspace')return;
      if(keys.current(e)){e.preventDefault();e.stopImmediatePropagation();}
    };
    window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  },[]);
  if(!clip||!tracker||!asset){keys.current=()=>false;return null;}
  const s=useEditorStore.getState;
  const update=(patch:Partial<MotionTracker>)=>s().updateMotionTracker(clip.id,tracker.id,patch);
  const place=(x:number,y:number)=>{if(times)update({keys:placeKey(tracker,frameTime,x/W,y/H)});};
  const manual=here?.flag===1;
  const removeKey=()=>{if(manual&&!locked&&!running)update({keys:tracker.keys.filter(k=>Math.abs(k.time-frameTime)>=half)});};
  const toSource=(e:{clientX:number;clientY:number})=>{const el=svg.current!,point=el.createSVGPoint();point.x=e.clientX;point.y=e.clientY;const p=point.matrixTransform(el.getScreenCTM()!.inverse());return {x:Math.max(0,Math.min(W,p.x)),y:Math.max(0,Math.min(H,p.y))};};
  // Where the point and boxes stand on this frame, with a drag in progress drawn live and committed on release.
  const shown=drag?{x:drag.x,y:drag.y}:here?{x:here.x*W,y:here.y*H}:null;
  const drawing=drag?.mode==='draw',sized=drag&&(drag.mode==='feature'||drawing);
  const scale=tracker.model==='similarity'&&!drawing?here?.scale??1:1,rotation=tracker.model==='similarity'&&!drawing?here?.rotation??0:0;
  const feature={width:(sized?drag!.width:tracker.feature.width*W)*scale,height:(sized?drag!.height:tracker.feature.height*H)*scale};
  // A new feature box keeps the tracker's search-to-feature proportion.
  const reach={x:tracker.search.width/tracker.feature.width,y:tracker.search.height/tracker.feature.height};
  const search={width:(drag?.mode==='search'?drag.width:drawing?Math.min(W,drag!.width*reach.x):tracker.search.width*W)*scale,height:(drag?.mode==='search'?drag.height:drawing?Math.min(H,drag!.height*reach.y):tracker.search.height*H)*scale};
  const begin=(mode:Drag['mode'],e:PointerEvent<SVGElement>)=>{
    if(e.button!==0)return;
    const onPoint=mode!=='move'||!!here&&(e.target as Element).classList.contains('motion-tracker-feature');
    // Playing, a click stops on the frame on screen; grabbing the point also starts moving it there.
    if(s().playing){s().setPlaying(false);if(!onPoint){e.preventDefault();e.stopPropagation();return;}}
    if(locked||running||!times||!s().acquireLock(clip.id,'motionTrackers'))return;
    e.preventDefault();e.stopPropagation();svg.current?.focus();svg.current?.setPointerCapture(e.pointerId);
    // Grabbing the feature box moves the point. Anywhere else, a click places the point there and a drag draws the
    // feature box around the subject, the way a region is drawn in any tracker.
    const pointer=toSource(e),at=onPoint&&shown?shown:pointer;
    const box=mode==='search'?{width:tracker.search.width*W,height:tracker.search.height*H}:{width:tracker.feature.width*W,height:tracker.feature.height*H};
    setDrag({mode:onPoint?mode:'draw',pointerId:e.pointerId,x:at.x,y:at.y,...box,...(onPoint?{grab:{x:pointer.x-at.x,y:pointer.y-at.y}}:{anchor:pointer})});
  };
  const moveDrag=(e:PointerEvent<SVGSVGElement>)=>{
    if(!drag||e.pointerId!==drag.pointerId)return;const p=toSource(e);
    if(drag.mode==='move'){const x=p.x-(drag.grab?.x??0),y=p.y-(drag.grab?.y??0);if(drag.moved||Math.hypot(x-drag.x,y-drag.y)>2*unit)setDrag({...drag,x,y,moved:true});}
    else if(drag.mode==='draw'&&drag.anchor){
      const width=Math.abs(p.x-drag.anchor.x),height=Math.abs(p.y-drag.anchor.y);
      // Until the pointer has really moved this is still a click, shown at the tracker's own box size.
      if(Math.max(width,height)>6*unit)setDrag({...drag,x:(p.x+drag.anchor.x)/2,y:(p.y+drag.anchor.y)/2,width:Math.max(8,width),height:Math.max(8,height)});
    }
    else{
      // Boxes resize about the point; the search box never shrinks inside the feature box.
      const least=drag.mode==='feature'?{width:8,height:8}:{width:tracker.feature.width*W*1.2,height:tracker.feature.height*H*1.2};
      setDrag({...drag,width:Math.max(least.width,2*Math.abs(p.x-drag.x)/scale),height:Math.max(least.height,2*Math.abs(p.y-drag.y)/scale)});
    }
    // The lock lasts eight seconds; renewing it every two keeps it without a request per pointer event.
    if(Date.now()-renewed.current>2000){renewed.current=Date.now();s().renewLock(clip.id,'motionTrackers');}
  };
  const endDrag=(cancel=false)=>{
    const d=drag;setDrag(null);if(!d)return;
    if(!cancel){
      if(d.mode==='move'){if(d.moved)place(d.x,d.y);}
      else if(d.mode==='draw'&&times){
        const drawn=d.width!==tracker.feature.width*W||d.height!==tracker.feature.height*H;
        const placed=placeKey(tracker,frameTime,d.x/W,d.y/H);
        if(!drawn)update({keys:placed});
        else{const width=Math.min(1,d.width/W),height=Math.min(1,d.height/H);update({keys:placed,feature:{width,height},search:{width:Math.min(1,Math.max(width*1.2,width*reach.x)),height:Math.min(1,Math.max(height*1.2,height*reach.y))}});}
      }
      else if(d.mode==='feature'){const width=Math.min(1,d.width/W),height=Math.min(1,d.height/H);update({feature:{width,height},search:{width:Math.min(1,Math.max(tracker.search.width,width*1.2)),height:Math.min(1,Math.max(tracker.search.height,height*1.2))}});}
      else update({search:{width:Math.min(1,Math.max(tracker.feature.width,d.width/W)),height:Math.min(1,Math.max(tracker.feature.height,d.height/H))}});
    }
    s().releaseLock(clip.id,'motionTrackers');
  };
  keys.current=e=>{
    if(e.key==='Escape'){
      // Escape belongs to the tracker only from the viewer or nowhere in particular; a menu elsewhere keeps its own.
      const target=e.target as Element;if(target!==document.body&&!target.closest?.('.viewer'))return false;
      const menu=document.querySelector('.focus-more[open]');
      if(drag)endDrag(true);else if(menu)menu.removeAttribute('open');else useTrackerEditor.setState({clipId:null,trackerId:null});
      return true;
    }
    if(e.key.startsWith('Arrow')&&e.shiftKey){
      // Nudge the point one source pixel, ten with Alt, and place it here.
      if(here&&!locked&&!running){const d=e.altKey?10:1;place(here.x*W+(e.key==='ArrowLeft'?-d:e.key==='ArrowRight'?d:0),here.y*H+(e.key==='ArrowUp'?-d:e.key==='ArrowDown'?d:0));}
      return true;
    }
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){go(frame+(e.key==='ArrowRight'?1:-1));return true;}
    if(e.key==='Home'||e.key==='End'){go(e.key==='Home'?bounds.first:bounds.last);return true;}
    // Delete removes a point placed here and never falls through to deleting the clip.
    if(e.key==='Delete'||e.key==='Backspace'){removeKey();return true;}
    return false;
  };
  const others=(clip.motionTrackers??[]).filter(t=>t.id!==tracker.id);
  // With "All trackers", the others join the run where they have a point on this frame; the server skips the rest.
  const track=(direction:1|-1,frames?:number)=>void runTracker(all?[tracker.id,...others.map(t=>t.id)]:[tracker.id],direction,frames);
  const stop=job&&!running?job.stops[tracker.id]:undefined;
  const stoppedHere=!!stop&&!!times&&Math.abs((times[stop.frame]??-1)-frameTime)<half&&!!reasons[stop.reason];
  const failed=job&&job.status==='failed'&&job.trackerIds.includes(tracker.id)?`Tracking stopped: ${job.error||'the analysis failed'}. Frames tracked before it are kept.`:'';
  const count=bounds.last-bounds.first+1;
  const status=error||(!times?'Reading source frame timing…':running?`Tracking ${job!.direction>0?'forward':'backward'} · ${job!.rows.filter(r=>r[0]===tracker.id).length} frames`:playing?'':!here?(path.length?`No point on this frame. Click the subject to place ${tracker.name}, or drag a box around it.`:`Click the subject to place ${tracker.name}, or drag a box around it to size the pattern.`):stoppedHere?reasons[stop!.reason==='end'&&job!.direction<0?'start':stop!.reason]:failed);
  const button=(label:string,title:string,icon:ReactNode,action:()=>void,disabled=false)=><button aria-label={label} title={title} disabled={disabled} onClick={action}>{icon}</button>;
  const canTrack=!running&&!locked&&!!here&&!!times;
  const style={'--tracker':tracker.color} as CSSProperties;
  return <>
    <Slot into={bar}><div className="focus-bar motion-tracker-bar" role="toolbar" aria-label={`Edit ${tracker.name}`} style={style}>
      <span className="focus-title"><Crosshair size={14} className="motion-tracker-icon"/><select aria-label="Tracker" value={tracker.id} onChange={e=>{useTrackerEditor.setState({trackerId:e.target.value});release(e);}}>{(clip.motionTrackers??[]).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {button('Add tracker','Add another tracker on this clip',<Plus size={13}/>,()=>{const id=s().addMotionTracker(clip.id);if(id)useTrackerEditor.setState({trackerId:id});},locked||running)}</span>
      <span className="focus-group" role="group" aria-label="Track">
        {button('Track backward','Track backward to the clip start or your previous placed point',<ChevronsLeft size={15}/>,()=>track(-1),!canTrack)}
        {button('Track one frame backward','Track one frame backward',<StepBack size={14}/>,()=>track(-1,1),!canTrack)}
        {button('Stop tracking','Stop tracking; frames already tracked are kept',<Square size={11}/>,()=>void stopTracker(),!running||!job?.id)}
        {button('Track one frame forward','Track one frame forward',<StepForward size={14}/>,()=>track(1,1),!canTrack)}
        {button('Track forward','Track forward to the clip end or your next placed point',<ChevronsRight size={15}/>,()=>track(1),!canTrack)}
      </span>
      {running&&<progress aria-label="Tracking progress" max={100} value={job?.progress??0}/>}
      <select aria-label="Tracking model" title="Position follows a point. Scale & rotation also measures how the pattern grows and turns." value={tracker.model} disabled={locked||running} onChange={e=>{update({model:e.target.value as MotionTracker['model']});release(e);}}><option value="position">Position</option><option value="similarity">Position, scale & rotation</option></select>
      <details className="focus-more"><summary aria-label="Tracker settings" title="If lost, minimum match, all trackers"><Settings2 size={14}/></summary><div className="focus-popover">
        <label title="Search: coast through a short occlusion and pick the subject up again. Stop: stop at the first frame it is not sure of.">If lost<select aria-label="When the subject is lost" value={tracker.whenLost} disabled={locked||running} onChange={e=>{update({whenLost:e.target.value as MotionTracker['whenLost']});release(e);}}><option value="search">Search</option><option value="stop">Stop</option></select></label>
        <label title="How well the pattern must match to count as found">Min match<input type="range" aria-label="Minimum match" min={.3} max={.95} step={.01} value={tracker.minConfidence} disabled={locked||running} onPointerDown={()=>{slider.current=`floor-${tracker.id}-${Date.now()}`;}} onChange={e=>s().updateMotionTracker(clip.id,tracker.id,{minConfidence:Number(e.target.value)},slider.current)} onPointerUp={release}/><output>{Math.round(tracker.minConfidence*100)}%</output></label>
        {others.length>0&&<label title="Track every tracker that has a point on this frame, in one pass"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>Track all trackers together</label>}
      </div></details>
      <span className="spacer"/>
      {button('Undo tracker edit','Undo (Ctrl+Z)',<Undo2 size={14}/>,()=>s().undo())}
      <button className="focus-done" aria-label="Close tracker editor" title="Done (Esc)" onClick={()=>useTrackerEditor.setState({clipId:null,trackerId:null})}><Check size={14}/>Done</button>
    </div></Slot>
    <Slot into={strip}><div className="focus-strip-row" style={style}>
      {status&&<p className={`focus-status ${running?'busy':''} ${status===error||status===failed||status===reasons.lost?'warning':''}`} role={status===error||status===failed?'alert':'status'}>{status}</p>}
      <FrameStrip count={count} current={frame-bounds.first} version={byFrame} label="Tracked frames. Green is a confident match, yellow doubtful, red below the floor, orange bridged across an occlusion; tall marks are points you placed. Click or drag to move through the clip."
        cell={i=>{const p=byFrame.get(bounds.first+i);return p?[confidenceColor(p,tracker.minConfidence,tracker.color),p.flag===1?1:.7] as const:undefined;}} seek={i=>go(bounds.first+i)}/>
      <span className="focus-frame" title={`Source frame ${frame+1} · ${frameTime.toFixed(3)} s`}>Frame {frame-bounds.first+1}/{count} · {timecode(frameTime,fps)}</span>
      {button('Delete the point placed on this frame','Delete the point you placed on this frame (Delete)',<Trash2 size={13}/>,removeKey,!manual||locked||running)}
      <button title="Clear the tracked frames before this one; placed points stay" disabled={!tracker.result||locked||running||!times||frame<=bounds.first} onClick={()=>{if(times)void clearTrack(clip.id,tracker.id,times[bounds.first],times[frame-1]);}}>Clear before</button>
      <button title="Clear the tracked frames after this one; placed points stay" disabled={!tracker.result||locked||running||!times||frame>=bounds.last} onClick={()=>{if(times)void clearTrack(clip.id,tracker.id,times[frame+1],times[bounds.last]);}}>Clear after</button>
    </div></Slot>
    <SourceStill url={`/api/smart-masks/source?clipId=${encodeURIComponent(clip.id)}&frame=${frame}&context=${encodeURIComponent(context)}${zoom==='Fit'?'&size=display':''}`} show={(zoom!=='Fit'||variable)&&!playing&&!!times}/>
    <svg ref={svg} className="focus-marks motion-tracker-marks" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" tabIndex={0} role="application" style={{...style,cursor:locked||running?'default':'crosshair',touchAction:'none'}}
      aria-label={`${tracker.name} on this frame. Click to place the point; drag the boxes to move or resize them. Arrow keys step frames; Shift+Arrow nudges the point.`}
      onPointerDown={e=>begin('move',e)} onPointerMove={moveDrag} onPointerUp={()=>endDrag()} onPointerCancel={()=>endDrag(true)} onLostPointerCapture={()=>{if(drag)endDrag(true);}}>
      <Trail path={path} frameTime={frameTime} fps={fps} unit={unit} tracker={tracker} W={W} H={H}/>
      {others.map(other=><OtherTracker key={other.id} tracker={other} projectId={clip.projectId} time={frameTime} unit={unit} rows={running?job!.rows:NO_ROWS} select={()=>useTrackerEditor.setState({trackerId:other.id})}/>)}
      {shown&&<g transform={`translate(${shown.x} ${shown.y}) rotate(${rotation})`}>
        {!playing&&<rect x={-search.width/2} y={-search.height/2} width={search.width} height={search.height} fill="none" stroke="var(--tracker)" strokeOpacity=".75" strokeWidth={unit} strokeDasharray={`${5*unit} ${4*unit}`} pointerEvents="none"/>}
        <rect className="motion-tracker-feature" x={-feature.width/2} y={-feature.height/2} width={feature.width} height={feature.height} fill="var(--tracker)" fillOpacity=".06" stroke="var(--tracker)" strokeWidth={1.5*unit} onPointerDown={e=>begin('move',e)}/>
        <path d={`M${-9*unit} 0h${6*unit}M${3*unit} 0h${6*unit}M0 ${-9*unit}v${6*unit}M0 ${3*unit}v${6*unit}`} stroke="white" strokeWidth={1.5*unit} pointerEvents="none"/>
        <circle r={1.6*unit} fill={manual?'var(--tracker)':'white'} pointerEvents="none"/>
        {!playing&&[[-1,-1],[1,-1],[-1,1],[1,1]].map(([sx,sy])=><rect key={`f${sx}${sy}`} className="motion-tracker-handle" x={sx*feature.width/2-4*unit} y={sy*feature.height/2-4*unit} width={8*unit} height={8*unit} fill="var(--tracker)" stroke="#0b0f12" strokeWidth={unit} onPointerDown={e=>begin('feature',e)}><title>Resize the feature box: the pattern that is followed</title></rect>)}
        {!playing&&[[-1,-1],[1,-1],[-1,1],[1,1]].map(([sx,sy])=><rect key={`s${sx}${sy}`} className="motion-tracker-handle" x={sx*search.width/2-3.5*unit} y={sy*search.height/2-3.5*unit} width={7*unit} height={7*unit} fill="#0b0f12" stroke="var(--tracker)" strokeWidth={unit} onPointerDown={e=>begin('search',e)}><title>Resize the search box: how far the pattern may move between frames</title></rect>)}
        <text x={feature.width/2+6*unit} y={-feature.height/2-4*unit} fontSize={11*unit} fill="white" stroke="#0b0f12" strokeWidth={3*unit} paintOrder="stroke" fontFamily="system-ui, sans-serif" fontWeight="600" pointerEvents="none" transform={`rotate(${-rotation} ${feature.width/2+6*unit} ${-feature.height/2-4*unit})`}>{tracker.name}{here&&here.flag!==1?` · ${Math.round(here.confidence*100)}%`:here?.flag===1?' · placed':''}</text>
      </g>}
    </svg>
  </>;
}
export default memo(MotionTrackerEditor);

/** The path over the whole clip, with the frames around this one marked by how sure the tracker was of them. */
function Trail({path,frameTime,fps,unit,tracker,W,H}:{path:TrackPoint[];frameTime:number;fps:number;unit:number;tracker:MotionTracker;W:number;H:number}){
  // Break the line wherever frames are missing, so a gap never reads as a straight jump.
  const runs=useMemo(()=>{const out:TrackPoint[][]=[];for(const p of path){const run=out.at(-1);if(run&&p.time-run.at(-1)!.time<1.5/fps)run.push(p);else out.push([p]);}return out.filter(r=>r.length>1);},[path,fps]);
  if(!path.length)return null;
  const span=30/fps,near=path.filter(p=>Math.abs(p.time-frameTime)<=span);
  return <g pointerEvents="none">
    {runs.map((run,i)=><polyline key={i} points={run.map(p=>`${p.x*W},${p.y*H}`).join(' ')} fill="none" stroke="var(--tracker)" strokeOpacity=".45" strokeWidth={1.2*unit} strokeLinejoin="round"/>)}
    {near.map(p=><circle key={p.time} cx={p.x*W} cy={p.y*H} r={(p.flag===1?3.2:2.2)*unit} fill={confidenceColor(p,tracker.minConfidence,tracker.color)} stroke={p.flag===1?'white':'none'} strokeWidth={unit}/>)}
  </g>;
}

/** Another tracker on the same clip, drawn small; click it to edit it instead. */
function OtherTracker({tracker,projectId,time,unit,rows,select}:{tracker:MotionTracker;projectId:string;time:number;unit:number;rows:TrackerRow[];select:()=>void}){
  const samples=useTrackerSamples(projectId,tracker.result?.key);
  const path=useMemo(()=>livePath(tracker,trackerPath(tracker,samples),rows),[tracker,samples,rows]);
  const point=path.find(p=>Math.abs(p.time-time)<.5/tracker.source.fps);
  if(!point)return null;
  const x=point.x*tracker.source.width,y=point.y*tracker.source.height;
  return <g className="motion-tracker-other" onPointerDown={e=>{e.stopPropagation();select();}}>
    <circle cx={x} cy={y} r={9*unit} fill="transparent" stroke={tracker.color} strokeWidth={1.2*unit}/><circle cx={x} cy={y} r={2*unit} fill={tracker.color}/>
    <text x={x+11*unit} y={y-8*unit} fontSize={10*unit} fill={tracker.color} stroke="#0b0f12" strokeWidth={3*unit} paintOrder="stroke" fontFamily="system-ui, sans-serif">{tracker.name}</text>
  </g>;
}
