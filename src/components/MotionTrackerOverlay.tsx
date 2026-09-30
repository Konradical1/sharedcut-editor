import {useMemo} from 'react';
import {useEditorStore} from '../state/store';
import type {Clip} from '../state/models';
import {projectSize} from '../services/playback';
import {stabilizeEffect} from '../services/stabilize';
import {sourceSize,trackOnCanvas,trackerPath,type MotionTracker} from '../services/motionTracker';
import {useTrackerEditor,useTrackerSamples} from '../services/motionTrackerClient';
import {confidenceColor} from './MotionTrackerEditor';

/** The tracked points on the program picture at the playhead: for the selected clip's trackers, or the tracker a
 *  selected layer is attached to. The same mapping the attach arithmetic uses, so what is drawn is what is applied. */
export default function MotionTrackerOverlay(){
  const selectedId=useEditorStore(s=>s.selectedClipId),clips=useEditorStore(s=>s.clips),timelineId=useEditorStore(s=>s.timelineId),playhead=useEditorStore(s=>s.playhead);
  const project=useEditorStore(s=>s.projects.find(p=>p.id===s.projectId)),editing=useTrackerEditor(s=>!!s.clipId);
  const entries=useMemo(()=>{
    const selected=clips.find(c=>c.id===selectedId);
    if(!selected||editing)return [];
    const owners=selected.motionTrackers?.length?[selected]:clips.filter(c=>c.motionTrackers?.some(t=>t.links?.some(l=>l.clipId===selected.id)));
    // A stabilized picture is warped by a solve only the playback engine holds; draw nothing rather than a wrong point.
    return owners.filter(c=>c.timelineId===timelineId&&!c.disabled&&c.start<=playhead&&playhead<c.start+c.duration&&!stabilizeEffect(c))
      .flatMap(c=>(c.motionTrackers??[]).filter(t=>c.id===selected.id||t.links?.some(l=>l.clipId===selected.id)).map(tracker=>({clip:c,tracker})));
  },[clips,selectedId,timelineId,playhead,editing]);
  if(!project||!entries.length)return null;
  const [width,height]=projectSize(project.resolution);
  return <svg className="motion-tracker-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    {entries.map(({clip,tracker})=><Point key={`${clip.id}:${tracker.id}`} clip={clip} tracker={tracker} project={[width,height]} fps={project.fps||24} playhead={playhead}/>)}
  </svg>;
}

function Point({clip,tracker,project,fps,playhead}:{clip:Clip;tracker:MotionTracker;project:readonly [number,number];fps:number;playhead:number}){
  const asset=useEditorStore(s=>s.media.find(m=>m.id===clip.mediaId));
  const samples=useTrackerSamples(clip.projectId,tracker.result?.key);
  const path=useMemo(()=>trackerPath(tracker,samples),[tracker,samples]);
  if(!asset)return null;
  const hit=trackOnCanvas(path,clip,asset,sourceSize(asset),project,playhead,fps);
  if(!hit)return null;
  const unit=project[0]/1280,{x,y}=hit.canvas,color=confidenceColor(hit.point,tracker.minConfidence,tracker.color);
  return <g>
    <circle cx={x} cy={y} r={11*unit} fill="none" stroke="#0b0f12" strokeOpacity=".7" strokeWidth={3.5*unit}/>
    <circle cx={x} cy={y} r={11*unit} fill="none" stroke={tracker.color} strokeWidth={1.6*unit}/>
    <path d={`M${x-17*unit} ${y}h${10*unit}M${x+7*unit} ${y}h${10*unit}M${x} ${y-17*unit}v${10*unit}M${x} ${y+7*unit}v${10*unit}`} stroke={tracker.color} strokeWidth={1.6*unit}/>
    <circle cx={x} cy={y} r={2.2*unit} fill={color}/>
    <text x={x+15*unit} y={y-13*unit} fontSize={12*unit} fill="white" stroke="#0b0f12" strokeWidth={3*unit} paintOrder="stroke" fontFamily="system-ui, sans-serif" fontWeight="600">{tracker.name}</text>
  </g>;
}
