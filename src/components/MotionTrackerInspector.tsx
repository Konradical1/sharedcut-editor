import {useEffect,useMemo,useRef,useState,type CSSProperties} from 'react';
import {ChevronLeft,ChevronRight,Crosshair,PenTool,Trash2,Video,Link2} from 'lucide-react';
import {useEditorStore} from '../state/store';
import type {Clip} from '../state/models';
import {isCaption} from '../services/captions';
import {defaultCameraOptions,defaultLayerOptions,linkApplies,MAX_TRACKERS,trackerPath,type MotionTracker,type MotionTrackerCameraOptions,type MotionTrackerLayerOptions} from '../services/motionTracker';
import {NumberInput} from './ui';
import {attachLayer,followCamera,loadSourceTimes,openTrackerEditor,refreshLinks,runTracker,trackerCapabilities,unlink,useTrackerEditor,useTrackerSamples,type TrackerCapabilities} from '../services/motionTrackerClient';
import './motionTracker.css';

export default function MotionTrackerInspector({clip}:{clip:Clip}){
  // Actions from getState and narrow selectors: a whole-store subscription re-rendered this on every playback frame.
  const s=useEditorStore.getState(),[capability,setCapability]=useState<TrackerCapabilities|null>(null);
  useEffect(()=>{let live=true;void trackerCapabilities().then(value=>{if(live)setCapability(value);});return()=>{live=false;};},[]);
  const trackers=clip.motionTrackers??[],root=useRef<HTMLDivElement>(null);
  // A clip's first frame table read scans the whole original (about 20 s for 4K). Start it once Tracking is open, so
  // the editor rarely waits; a closed section is still mounted, and must not scan every clip that gets selected.
  useEffect(()=>{
    const section=root.current?.closest('details');if(!section||!capability?.available)return;
    const warm=()=>{if(section.open)void loadSourceTimes(clip).catch(()=>{});};
    warm();section.addEventListener('toggle',warm);return()=>section.removeEventListener('toggle',warm);
  },[capability?.available,clip.id,clip.mediaId]);
  const locked=useEditorStore(s=>!!s.tracks.find(t=>t.id===clip.trackId)?.locked||s.locks.some(l=>l.targetId===clip.id&&l.userId!==s.currentUserId&&l.expiresAt>Date.now()&&['*','motionTrackers'].includes(l.field)));
  const add=()=>{const id=s.addMotionTracker(clip.id);if(id)openTrackerEditor(clip.id,id);};
  return <div className="motion-trackers" ref={root}>
    {capability&&!capability.available&&<p className="motion-tracker-warning" role="status">{capability.reason} Trackers and their points are saved.</p>}
    {trackers.map(tracker=><TrackerCard key={tracker.id} clip={clip} tracker={tracker} locked={locked} available={!!capability?.available}/>)}
    <button className="motion-tracker-add" disabled={locked||trackers.length>=MAX_TRACKERS} onClick={add}><Crosshair size={14}/>Add tracker</button>
    {!trackers.length&&<p className="inspector-note">Place a point on something with detail, such as an eye, a logo or a corner. Track it through the shot, then attach text or shapes to it, or make the camera follow it.</p>}
  </div>;
}

function TrackerCard({clip,tracker,locked,available}:{clip:Clip;tracker:MotionTracker;locked:boolean;available:boolean}){
  const s=useEditorStore.getState(),clips=useEditorStore(s=>s.clips),editor=useTrackerEditor(),samples=useTrackerSamples(clip.projectId,tracker.result?.key);
  const [panel,setPanel]=useState<'layer'|'camera'|null>(null),[busy,setBusy]=useState(false);
  const path=useMemo(()=>trackerPath(tracker,samples),[tracker,samples]);
  const job=editor.job?.clipId===clip.id&&editor.job.trackerIds.includes(tracker.id)?editor.job:null,running=!!job&&['starting','queued','running'].includes(job.status);
  const doubtful=path.filter(p=>p.flag!==1&&p.confidence<tracker.minConfidence).length,bridged=path.filter(p=>p.flag===2).length;
  const tracked=path.filter(p=>p.flag!==1).length;
  const summary=!path.length?'Not placed yet.':`${tracked} frame${tracked===1?'':'s'} tracked · ${tracker.keys.length} placed${bridged?` · ${bridged} bridged`:''}${doubtful?` · ${doubtful} doubtful`:''}`;
  const quick=(direction:1|-1)=>{openTrackerEditor(clip.id,tracker.id);void runTracker([tracker.id],direction);};
  const links=(tracker.links??[]).filter(link=>linkApplies(clip,link,clips));
  const run=async(action:()=>Promise<unknown>)=>{setBusy(true);try{await action();}finally{setBusy(false);}};
  return <div className="motion-tracker-card" style={{'--tracker':tracker.color} as CSSProperties}>
    <div className="motion-tracker-card-head"><Crosshair size={13} color={tracker.color}/><input aria-label="Tracker name" value={tracker.name} disabled={locked} onChange={e=>{if(e.target.value.trim())s.updateMotionTracker(clip.id,tracker.id,{name:e.target.value.slice(0,80)},`rename-${tracker.id}`);}}/>
      <button aria-label={`Edit ${tracker.name}`} title="Open the frame editor: place, check and correct the point" onClick={()=>openTrackerEditor(clip.id,tracker.id)}><PenTool size={13}/></button>
      <button aria-label={`Delete ${tracker.name}`} title="Delete this tracker (layers it moved keep their keyframes)" disabled={locked||running} onClick={()=>s.deleteMotionTracker(clip.id,tracker.id)}><Trash2 size={13}/></button></div>
    <p className="motion-tracker-summary">{running?`Tracking · ${job!.rows.filter(r=>r[0]===tracker.id).length} frames`:summary}</p>
    <div className="motion-tracker-row"><button aria-label={`Track ${tracker.name} backward`} title="Track backward from the playhead" disabled={locked||running||!available||!path.length} onClick={()=>quick(-1)}><ChevronLeft size={14}/></button><button disabled={!path.length} onClick={()=>openTrackerEditor(clip.id,tracker.id)}>Review frames</button><button aria-label={`Track ${tracker.name} forward`} title="Track forward from the playhead" disabled={locked||running||!available||!path.length} onClick={()=>quick(1)}><ChevronRight size={14}/></button></div>
    <div className="motion-tracker-apply"><button aria-pressed={panel==='layer'} disabled={!path.length} onClick={()=>setPanel(panel==='layer'?null:'layer')}><Link2 size={13}/>Attach layer</button><button aria-pressed={panel==='camera'} disabled={!path.length} onClick={()=>setPanel(panel==='camera'?null:'camera')}><Video size={13}/>Camera follow</button></div>
    {panel==='layer'&&<LayerForm clip={clip} tracker={tracker} busy={busy} run={run}/>}
    {panel==='camera'&&<CameraForm clip={clip} tracker={tracker} busy={busy} run={run}/>}
    {links.length>0&&<ul className="motion-tracker-links" aria-label={`Layers ${tracker.name} moves`}>{links.map(link=>{const target=clips.find(c=>c.id===link.clipId)!;return <li key={link.clipId}><span title={target.name}>{link.target==='camera'?'This clip · camera follow':`${target.name} · attached`}</span>
      <button disabled={busy||locked} title="Apply the current track again" onClick={()=>void run(()=>link.target==='camera'?followCamera(clip.id,tracker.id,link.camera!):attachLayer(clip.id,tracker.id,link.clipId,link.layer!))}>Update</button>
      <button disabled={busy||locked} title="Stop following the track; the keyframes stay" onClick={()=>unlink(clip.id,tracker.id,link.clipId)}>Unlink</button></li>;})}</ul>}
    {links.length>1&&<button disabled={busy||locked} onClick={()=>void run(()=>refreshLinks(clip.id,tracker.id))}>Update all linked layers</button>}
  </div>;
}

/** Layers that are on screen while the tracked clip plays, text and shapes first. */
function useTargets(clip:Clip){
  const clips=useEditorStore(s=>s.clips),tracks=useEditorStore(s=>s.tracks),graphic=(c:Clip)=>Number(c.mediaId==='frameline-title'||c.mediaId==='frameline-shape');
  return clips.filter(c=>c.id!==clip.id&&c.timelineId===clip.timelineId&&!isCaption(c)&&tracks.find(t=>t.id===c.trackId)?.kind==='video'&&c.start<clip.start+clip.duration&&c.start+c.duration>clip.start)
    .sort((a,b)=>graphic(b)-graphic(a)||a.start-b.start);
}

function LayerForm({clip,tracker,busy,run}:{clip:Clip;tracker:MotionTracker;busy:boolean;run:(action:()=>Promise<unknown>)=>Promise<void>}){
  const targets=useTargets(clip);
  const [targetId,setTargetId]=useState(()=>{const playhead=useEditorStore.getState().playhead;return targets.find(c=>c.start<=playhead&&c.start+c.duration>playhead)?.id??targets[0]?.id??'';});
  const link=tracker.links?.find(l=>l.clipId===targetId&&l.target==='layer');
  const [options,setOptions]=useState<MotionTrackerLayerOptions>(()=>link?.layer??defaultLayerOptions);
  useEffect(()=>{setOptions(tracker.links?.find(l=>l.clipId===targetId&&l.target==='layer')?.layer??defaultLayerOptions);},[targetId]);
  const similarity=tracker.model==='similarity';
  if(!targets.length)return <div className="motion-tracker-form"><p className="inspector-note">Put a title, shape or other clip on a track above this one, over the frames you tracked, then attach it here.</p></div>;
  const set=(patch:Partial<MotionTrackerLayerOptions>)=>setOptions(value=>({...value,...patch}));
  return <div className="motion-tracker-form">
    <label className="inspector-select-row"><span>Layer</span><select aria-label="Layer to attach" value={targetId} onChange={e=>setTargetId(e.target.value)}>{targets.map(c=><option key={c.id} value={c.id}>{c.name}{tracker.links?.some(l=>l.clipId===c.id)?' · attached':''}</option>)}</select></label>
    <div className="motion-tracker-checks"><label title={similarity?'Grow and shrink with the subject':'Set the tracker to Position, scale & rotation first'}><input type="checkbox" disabled={!similarity} checked={similarity&&options.scale} onChange={e=>set({scale:e.target.checked})}/>Scale</label><label title={similarity?'Turn with the subject':'Set the tracker to Position, scale & rotation first'}><input type="checkbox" disabled={!similarity} checked={similarity&&options.rotation} onChange={e=>set({rotation:e.target.checked})}/>Rotation</label></div>
    <label className="inspector-select-row" title="Evens out jitter in the track, in frames"><span>Smoothing</span><input type="range" aria-label="Attach smoothing" min={0} max={15} step={.5} value={options.smoothing} onChange={e=>set({smoothing:Number(e.target.value)})}/><span>{options.smoothing}</span></label>
    <label className="inspector-select-row"><span>Offset X px</span><NumberInput aria-label="Offset X" value={options.offsetX} min={-100000} max={100000} decimals={1} onCommit={value=>set({offsetX:value})}/></label>
    <label className="inspector-select-row"><span>Offset Y px</span><NumberInput aria-label="Offset Y" value={options.offsetY} min={-100000} max={100000} decimals={1} onCommit={value=>set({offsetY:value})}/></label>
    <p className="inspector-note">{link?'Updates the attached layer with the current track.':'The layer keeps where it is at the playhead and moves with the point from there. Offsets shift it on top of that.'}</p>
    <button className="motion-tracker-go" disabled={busy||!targetId} onClick={()=>void run(()=>attachLayer(clip.id,tracker.id,targetId,{...options,scale:similarity&&options.scale,rotation:similarity&&options.rotation}))}><Link2 size={13}/>{link?'Update layer':'Attach to track'}</button>
  </div>;
}

function CameraForm({clip,tracker,busy,run}:{clip:Clip;tracker:MotionTracker;busy:boolean;run:(action:()=>Promise<unknown>)=>Promise<void>}){
  const link=tracker.links?.find(l=>l.clipId===clip.id&&l.target==='camera');
  const [options,setOptions]=useState<MotionTrackerCameraOptions>(()=>link?.camera??defaultCameraOptions);
  const set=(patch:Partial<MotionTrackerCameraOptions>)=>setOptions(value=>({...value,...patch}));
  const similarity=tracker.model==='similarity';
  return <div className="motion-tracker-form">
    <label className="inspector-select-row"><span>Framing</span><select aria-label="Camera framing" value={options.framing} onChange={e=>set({framing:e.target.value as MotionTrackerCameraOptions['framing']})}><option value="keep">Keep it where it is now</option><option value="center">Centre it</option></select></label>
    <label className="inspector-select-row" title="0 locks the point exactly; higher values move the camera like an operator, ignoring small jitter"><span>Follow smoothing</span><input type="range" aria-label="Camera smoothing" min={0} max={30} step={1} value={options.smoothing} onChange={e=>set({smoothing:Number(e.target.value)})}/><span>{options.smoothing}</span></label>
    <label className="inspector-select-row" title="Dynamic zooms only as far as each moment needs to hide the edges; Steady holds one zoom for the whole clip; Off never zooms (edges may show)"><span>Auto zoom</span><select aria-label="Camera zoom" value={options.zoom} onChange={e=>set({zoom:e.target.value as MotionTrackerCameraOptions['zoom']})}><option value="dynamic">Dynamic · no edges</option><option value="steady">Steady · no edges</option><option value="off">Off</option></select></label>
    <label className="inspector-select-row"><span>Least zoom %</span><NumberInput aria-label="Least zoom" min={1} max={800} decimals={1} value={options.minZoom} onCommit={value=>set({minZoom:value,maxZoom:Math.max(value,options.maxZoom)})}/></label>
    <label className="inspector-select-row" title="Past this zoom the point is allowed off its mark instead of showing an edge"><span>Most zoom %</span><NumberInput aria-label="Most zoom" min={1} max={800} decimals={1} value={options.maxZoom} onCommit={value=>set({maxZoom:value,minZoom:Math.min(options.minZoom,value)})}/></label>
    {similarity&&<div className="motion-tracker-checks" title="Turn the picture against the subject's rotation, so it stays level"><label><input type="checkbox" checked={options.rotation} onChange={e=>set({rotation:e.target.checked})}/>Hold the subject level</label></div>}
    <label className="inspector-select-row"><span>Offset X px</span><NumberInput aria-label="Framing offset X" value={options.offsetX} min={-100000} max={100000} decimals={1} onCommit={value=>set({offsetX:value})}/></label>
    <label className="inspector-select-row"><span>Offset Y px</span><NumberInput aria-label="Framing offset Y" value={options.offsetY} min={-100000} max={100000} decimals={1} onCommit={value=>set({offsetY:value})}/></label>
    <p className="inspector-note">Keyframes this clip's position and zoom so the point stays on its mark. The zoom never uncovers an edge of the picture.</p>
    <button className="motion-tracker-go" disabled={busy} onClick={()=>void run(()=>followCamera(clip.id,tracker.id,{...options,rotation:similarity&&options.rotation}))}><Video size={13}/>{link?'Update camera follow':'Follow this point'}</button>
  </div>;
}
