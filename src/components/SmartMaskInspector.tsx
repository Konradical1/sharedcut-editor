import {useEffect,useState} from 'react';
import {PenTool,ScanLine,ChevronLeft,ChevronRight,Square,Plus,Undo2,Trash2} from 'lucide-react';
import {useEditorStore} from '../state/store';
import type {Clip} from '../state/models';
import {smartMaskSignature} from '../services/smartMask';
import {api} from '../services/api';
import {analyzeMask,cancelMask,openMaskEditor,useMaskEditor,type MaskCapabilities} from '../services/smartMaskClient';
import './smartMask.css';

export default function SmartMaskInspector({clip,maskId,targetId,node=false}:{clip:Clip;maskId?:string;targetId:string;node?:boolean}){
  const s=useEditorStore(),editor=useMaskEditor(),[capability,setCapability]=useState<MaskCapabilities|null>(null),[loading,setLoading]=useState(false);
  useEffect(()=>{let current=true;void api<MaskCapabilities>('/smart-masks/capabilities').then(value=>{if(current)setCapability(value);}).catch(()=>{if(current)setCapability({available:false,preserveMotionBlur:false,finalQuality:false,reason:'Connect to the analysis server to track this mask.'});});return()=>{current=false;};},[]);
  const mask=clip.smartMasks?.find(m=>m.id===maskId),job=mask&&editor.jobs[`${clip.id}:${mask.id}`],busy=loading||job?.status==='queued'||job?.status==='processing';
  const locked=s.tracks.find(t=>t.id===clip.trackId)?.locked||s.locks.some(l=>l.targetId===clip.id&&l.userId!==s.currentUserId&&l.expiresAt>Date.now()&&['*','smartMasks'].includes(l.field));
  const patch=(value:Parameters<typeof s.updateSmartMask>[2])=>mask&&s.updateSmartMask(clip.id,mask.id,value);
  const nodeMask=s.nodes.find(n=>n.id===targetId)?.mask;
  const current=mask?.result?.signature=== (mask?smartMaskSignature(mask):'');
  const cannotAnalyze=busy||!capability?.available||(mask?.settings.quality==='final'&&!capability.finalQuality)||(mask?.settings.preserveMotionBlur&&!capability.preserveMotionBlur)||!mask?.prompts.some(p=>p.kind==='include');
  const run=async(direction:'forward'|'backward'|'both')=>{if(!mask)return;setLoading(true);await analyzeMask(clip.id,mask.id,direction,editor.maskId===mask.id?editor.time:mask.range.start);setLoading(false);};
  return <fieldset className="smart-mask-inspector" disabled={locked} aria-label="Smart Mask settings">
    <div className="smart-mask-heading"><ScanLine size={16}/><strong>Smart Mask</strong>{node&&<button aria-label="Remove node mask" title="Remove node mask attachment" onClick={()=>s.updateNode(targetId,{mask:undefined})}><Trash2 size={12}/></button>}<span className={`smart-mask-status ${current?'ready':''}`}>{busy?'Analyzing':current?'Ready':mask?.result?'Needs analysis':'Select subject'}</span></div>
    <label className="inspector-select-row"><span>Subject</span><select aria-label="Shared subject mask" value={mask?.id??''} onChange={e=>s.attachSmartMask(clip.id,e.target.value,targetId)}><option value="" disabled>Select a mask…</option>{clip.smartMasks?.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    {!mask?<button className="smart-mask-primary" onClick={()=>s.addSmartMask(clip.id,node?targetId:undefined)}><Plus size={14}/>New subject mask</button>:<>
      <input className="smart-mask-name" aria-label="Subject name" value={mask.name} onChange={e=>patch({name:e.target.value})}/>
      <button className={`smart-mask-primary ${editor.maskId===mask.id&&editor.clipId===clip.id?'active':''}`} onClick={()=>openMaskEditor(clip.id,mask.id)}><PenTool size={15}/>Select & refine subject</button>
      <p className="inspector-note">Click or draw over your subject. Exclude removes unwanted areas; Paint repairs one frame.</p>
      {node&&nodeMask&&<div className="smart-mask-inline"><label><input type="checkbox" checked={nodeMask.enabled} onChange={e=>s.updateNode(targetId,{mask:{...nodeMask,enabled:e.target.checked}})}/>Enable</label><label><input type="checkbox" checked={nodeMask.invert} onChange={e=>s.updateNode(targetId,{mask:{...nodeMask,invert:e.target.checked}})}/>Invert</label></div>}
      {node&&nodeMask&&<label className="inspector-select-row"><span>Node influence %</span><input type="number" aria-label="Masked node influence" min={0} max={100} value={nodeMask.amount} onChange={e=>s.updateNode(targetId,{mask:{...nodeMask,amount:Number(e.target.value)}})}/></label>}
      <div className="smart-mask-range"><label>Source In<input type="number" aria-label="Mask range start" min={0} max={mask.range.end-1/mask.source.fps} step={1/mask.source.fps} value={mask.range.start} onChange={e=>patch({range:{...mask.range,start:Number(e.target.value)}})}/></label><label>Source Out<input type="number" aria-label="Mask range end" min={mask.range.start+1/mask.source.fps} max={mask.source.duration} step={1/mask.source.fps} value={mask.range.end} onChange={e=>patch({range:{...mask.range,end:Number(e.target.value)}})}/></label></div>
      <button className="smart-mask-text" onClick={()=>patch({range:{start:0,end:mask.source.duration}})}>Use whole source video</button>
      <label className="smart-mask-check"><input type="checkbox" checked={mask.settings.preserveMotionBlur} onChange={e=>patch({settings:{...mask.settings,preserveMotionBlur:e.target.checked}})}/>Preserve source motion blur</label>
      {mask.settings.preserveMotionBlur&&capability&&!capability.preserveMotionBlur&&<p className="smart-mask-warning">The connected engine cannot recover source motion blur.</p>}
      <label className="inspector-select-row"><span>Quality</span><select aria-label="Mask analysis quality" value={mask.settings.quality} onChange={e=>patch({settings:{...mask.settings,quality:e.target.value as 'preview'|'final'}})}><option value="preview">Preview · review required</option><option value="final" disabled={!capability?.finalQuality}>Final{!capability?.finalQuality?' · engine required':''}</option></select></label>
      {capability?.available&&!capability.finalQuality&&<div className="smart-mask-warning"><p>Selection preview only. This engine does not recover fine hair or source motion blur.</p>{(mask.settings.quality==='final'||mask.settings.preserveMotionBlur)&&<button onClick={()=>patch({settings:{...mask.settings,quality:'preview',preserveMotionBlur:false}})}>Use selection preview</button>}</div>}
      {!capability?.available&&<p className="smart-mask-warning" role="status">{capability?.reason??'Checking analysis engine…'} Your selections are saved.</p>}
      <div className="smart-mask-analysis"><button title="Analyze backward from the selected source frame" aria-label="Analyze mask backward" disabled={cannotAnalyze} onClick={()=>void run('backward')}><ChevronLeft size={14}/></button><button disabled={cannotAnalyze} onClick={()=>void run('both')}><ScanLine size={14}/>Analyze range</button><button title="Analyze forward from the selected source frame" aria-label="Analyze mask forward" disabled={cannotAnalyze} onClick={()=>void run('forward')}><ChevronRight size={14}/></button></div>
      {busy&&<div className="smart-mask-job"><progress aria-label="Mask analysis progress" max={100} value={job?.progress??0}/><span>{Math.round(job?.progress??0)}%</span><button aria-label="Cancel mask analysis" disabled={!job?.key} onClick={()=>void cancelMask(job!.key,clip.projectId)}><Square size={12}/></button></div>}
      {job?.status==='failed'&&<p className="smart-mask-warning" role="alert">{job.error}</p>}
      <div className="smart-mask-footer"><span>{mask.prompts.length} guides · {mask.repairs.length} repairs</span><button aria-label="Undo last edit" title="Undo last edit" onClick={()=>s.undo()}><Undo2 size={13}/></button></div>
    </>}
  </fieldset>;
}
