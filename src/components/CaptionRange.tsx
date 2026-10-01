import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../state/store';
import { Button, Field, NumberInput } from './ui';

export function CaptionRange({start,end,source,onChange}:{start:number;end:number;source:string;onChange:(start:number,end:number)=>void}) {
  // Only the fields it draws: a whole-store subscription re-rendered it on every playback frame.
  const state=useEditorStore(useShallow(s=>({clips:s.clips,media:s.media,projectId:s.projectId,projects:s.projects,rangeIn:s.rangeIn,rangeOut:s.rangeOut,timelineId:s.timelineId,tracks:s.tracks}))), rail=useRef<HTMLDivElement>(null), drag=useRef<{mode:string;x:number;start:number;end:number}|null>(null);
  const tracks=state.tracks.filter(t=>t.timelineId===state.timelineId&&!t.captionSets),clips=state.clips.filter(c=>c.timelineId===state.timelineId&&!c.properties.captionSet);
  const duration=Math.max(1,...clips.map(c=>c.start+c.duration)),minimum=1/(state.projects.find(t=>t.id===state.projectId)?.fps||24);
  const solo=tracks.some(t=>t.solo&&!t.muted&&(!source||source===t.id));
  const range=(a:number,b:number)=>{const from=Math.max(0,Math.min(duration-minimum,a));onChange(from,Math.max(from+minimum,Math.min(duration,b)));};
  return <section className="caption-range" aria-label="Transcription range">
    <div className="caption-range-toolbar"><b>Timeline range</b><div><Button onClick={()=>range(0,duration)}>Entire timeline</Button><Button onClick={()=>range(state.rangeIn,state.rangeOut)}>Marked range</Button></div></div>
    <div className="caption-range-overview"><div className="caption-range-labels">{tracks.map(t=><span key={t.id} title={t.name}>{t.name}</span>)}</div>
      <div className="caption-range-rail" ref={rail} onPointerMove={e=>{const d=drag.current;if(!d||!rail.current)return;const delta=(e.clientX-d.x)/rail.current.getBoundingClientRect().width*duration;if(d.mode==='move'){const shift=Math.max(-d.start,Math.min(duration-d.end,delta));onChange(d.start+shift,d.end+shift);}else if(d.mode==='start')range(Math.min(d.end-minimum,d.start+delta),d.end);else range(d.start,Math.max(d.start+minimum,d.end+delta));}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}>
      {tracks.map(track=><div className="caption-range-track" key={track.id}>{clips.filter(c=>c.trackId===track.id).map(c=>{
        const duplicate=track.kind==='video'&&clips.some(other=>other.id!==c.id&&tracks.find(t=>t.id===other.trackId)?.kind==='audio'&&other.mediaId===c.mediaId&&other.start===c.start&&other.sourceIn===c.sourceIn&&other.duration===c.duration);
        const audible=!c.disabled&&!c.properties.freeze&&!track.muted&&(!source||source===track.id)&&(!solo||track.solo)&&!(track.kind==='video'&&(c.properties.audioDetached||duplicate))&&(c.mediaId==='frameline-composition'||state.media.find(m=>m.id===c.mediaId)?.hasAudio);
        const from=Math.max(start,c.start),to=Math.min(end,c.start+c.duration);
        return <div className="caption-range-clip" key={c.id} title={c.name} style={{left:`${c.start/duration*100}%`,width:`${c.duration/duration*100}%`}}>{audible&&to>from&&<i className="caption-audio-selection" style={{left:`${(from-c.start)/c.duration*100}%`,width:`${(to-from)/c.duration*100}%`}}/>}<span>{c.name}</span></div>;
      })}</div>)}
      <div className="caption-range-selection" style={{left:`${start/duration*100}%`,width:`${(end-start)/duration*100}%`}}>
        {['start','move','end'].map(mode=><button type="button" key={mode} className={`caption-range-${mode}`} aria-label={mode==='move'?'Move caption range':`Caption range ${mode}`} onPointerDown={e=>{e.preventDefault();drag.current={mode,x:e.clientX,start,end};e.currentTarget.setPointerCapture(e.pointerId);}} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const delta=(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:.01);if(mode==='move'){const shift=Math.max(-start,Math.min(duration-end,delta));onChange(start+shift,end+shift);}else if(mode==='start')range(Math.min(end-minimum,start+delta),end);else range(start,Math.max(start+minimum,end+delta));}}/>)}
      </div></div></div>
    <div className="caption-range-values"><Field label="Start (seconds)"><NumberInput aria-label="Start (seconds)" min={0} max={Number((end-minimum).toFixed(2))} step={.1} decimals={2} value={start} onCommit={value=>range(value,end)}/></Field><Field label="End (seconds)"><NumberInput aria-label="End (seconds)" min={Number((start+minimum).toFixed(2))} max={Number(duration.toFixed(2))} step={.1} decimals={2} value={end} onCommit={value=>range(start,value)}/></Field><small><i/>Selected audio · {(end-start).toFixed(2)}s</small></div>
  </section>;
}
