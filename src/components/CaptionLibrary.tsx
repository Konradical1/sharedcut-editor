import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, AlertTriangle } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { api, connection } from '../services/api';
import { captionPresets, captionDocument, captionSignature, demoCaptionWords, type CaptionJob, type CaptionSet } from '../services/captions';
import { previewTime } from '../services/timecode';
import { CaptionRange } from './CaptionRange';
import { drawText } from '../services/text';
import { Button, Field, Modal, NumberInput } from './ui';
import './captions.css';

export function CaptionPreview({preset,selected,onSelect}:{preset:string;selected:boolean;onSelect:()=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null),[position,setPosition]=useState(.5);
  const time=previewTime(position,2.7,.19,.1);
  useEffect(()=>{let alive=true;const paint=()=>{if(!alive||!canvas.current)return;const ctx=canvas.current.getContext('2d')!;ctx.clearRect(0,0,480,180);const doc=captionDocument(demoCaptionWords,preset,2.7);doc.y=.28;doc.x=.04;doc.width=.92;doc.runs[0].style.fontSize=180;drawText(ctx,doc,480,180,1920,720,time);};paint();void document.fonts.ready.then(paint);return()=>{alive=false;};},[preset,time]);
  return <div className={`caption-preset ${selected?'selected':''}`}>
    <button aria-label={`Select ${captionPresets.find(p=>p.id===preset)!.name} captions`} aria-pressed={selected} onClick={onSelect} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setPosition(p=>Math.max(0,Math.min(1,p+(e.key==='ArrowRight'?.025:-.025))));}}}>
      <div className="caption-art" onPointerMove={e=>{const r=e.currentTarget.getBoundingClientRect();setPosition(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)));}}><canvas ref={canvas} width={480} height={180} aria-hidden="true"/><i className="caption-scrub-line" style={{left:`${position*100}%`}}/><i className="caption-add"><Plus size={15}/></i></div><span>{captionPresets.find(p=>p.id===preset)!.name}</span>
    </button>
  </div>;
}
export default function CaptionLibrary() {
  const projectId=useEditorStore(s=>s.projectId),timelineId=useEditorStore(s=>s.timelineId),clips=useEditorStore(s=>s.clips),tracks=useEditorStore(s=>s.tracks);
  const [preset,setPreset]=useState('highlight'),[group,setGroup]=useState('All'),[form,setForm]=useState<{start:number;end:number;words:number;source:string;replace?:string;overlap?:'keep'|'replace'}|null>(null),[jobs,setJobs]=useState<CaptionJob[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const submitted=useRef<{id:string;words:number;preset:string;replace?:string;removing:string[];before?:string}|null>(null),applying=useRef(false);
  const s=useEditorStore.getState;
  const sets=tracks.filter(t=>t.timelineId===timelineId).flatMap(t=>t.captionSets??[]).filter(meta=>clips.some(c=>c.properties.captionSet===meta.id));
  const overlaps=form?sets.filter(meta=>meta.id!==form.replace&&clips.some(c=>c.properties.captionSet===meta.id&&c.start<form.end&&c.start+c.duration>form.start)):[];
  const show=(meta?:CaptionSet)=>{setError('');if(meta)setPreset(meta.preset);setForm({start:meta?.start??0,end:meta?.end??Math.max(1,...clips.filter(c=>c.timelineId===timelineId&&!c.properties.captionSet).map(c=>c.start+c.duration)),words:meta?.wordsPerLine??5,source:meta?.trackIds[0]??'',replace:meta?.id});};
  async function apply(jobId:string,words?:number,style?:string,replace?:string) {
    if(applying.current)return;applying.current=true;
    try{await connection.flush();const {job}=await api<{job:CaptionJob}>(`/captions/${jobId}`);if(!job.words?.length){setError('No speech was detected in this range.');return;}s().installCaptions(job,words??job.wordsPerLine??5,style??job.preset??preset,replace);await connection.flush();}catch(e){setError((e as Error).message);}finally{applying.current=false;}
  }
  useEffect(()=>{
    let alive=true;submitted.current=null;setJobs([]);setForm(null);
    const poll=async()=>{try{const result=await api<{jobs:CaptionJob[]}>(`/captions?projectId=${encodeURIComponent(projectId)}`);if(!alive)return;setJobs(result.jobs.filter(j=>j.timelineId===timelineId));const pending=submitted.current,job=pending&&result.jobs.find(j=>j.id===pending.id);if(pending&&job?.status==='complete'){submitted.current=null;if(pending.removing.length&&pending.before!==JSON.stringify(s().clips.filter(c=>pending.removing.includes(String(c.properties.captionSet))))){setError('Caption lines changed while transcribing. Your edits are preserved; review the ready transcript before replacing this set.');return;}await apply(job.id,pending.words,pending.preset,pending.replace);}}catch(e){if(alive)setError((e as Error).message);}};
    void poll();const timer=setInterval(()=>void poll(),1500);return()=>{alive=false;clearInterval(timer);};
  },[projectId,timelineId]);
  const generate=async()=>{
    if(!form)return;if(overlaps.length&&!form.overlap){setError('Choose whether to keep or replace the existing captions.');return;}setBusy(true);setError('');
    const removeSets=form.overlap==='replace'?overlaps.map(meta=>meta.id):[],removing=[...removeSets,...(form.replace?[form.replace]:[])];
    try{await connection.flush();const trackIds=form.source?[form.source]:[];
    const {job}=await api<{job:CaptionJob}>('/captions',{method:'POST',body:JSON.stringify({projectId,timelineId,start:form.start,end:form.end,trackIds,wordsPerLine:form.words,preset,replaceSet:form.replace,removeSets,signature:captionSignature(clips,tracks,timelineId,form.start,form.end,trackIds)})});
    s().notify(form.replace?'Regenerating captions':'Generating captions','info','Transcribing in the background. Keep editing — the lines appear when it finishes.');submitted.current={id:job.id,words:form.words,preset,replace:form.replace,removing,before:JSON.stringify(s().clips.filter(c=>removing.includes(String(c.properties.captionSet))))};setJobs(j=>[job,...j]);setForm(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const unapplied=jobs.filter((j,i)=>(i===0||['waiting','running'].includes(j.status))&&!sets.some(set=>set.jobId===j.id));
  return <div className="caption-library">
    <Button variant="primary" onClick={()=>show()}>Generate captions</Button>
    {error&&<p role="alert" className="caption-warning">{error}</p>}
    {unapplied.slice(0,3).map(job=><div className="caption-job" key={job.id}>
      <div role="status"><b>{job.stage}</b><small>{job.start.toFixed(2)}–{job.end.toFixed(2)}s · English</small></div>
      {['waiting','running'].includes(job.status)?<><progress aria-label="Transcription progress" max={100} value={job.progress}/><small>{Math.floor(job.progress)}% · Runs on the server</small><button onClick={()=>void api(`/captions/${job.id}`,{method:'DELETE'}).catch(e=>setError(e.message))}>Cancel</button></>:job.status==='complete'?<>{(job.replaceSet||job.removeSets?.length)&&<p className="caption-hint">Replaces this set’s current lines and corrections. Undo is available.</p>}<Button onClick={()=>void apply(job.id,undefined,undefined,job.replaceSet)}>{job.replaceSet||job.removeSets?.length?'Replace caption sets':'Add captions'}</Button></>:<><p className="caption-warning">{job.error||job.stage}</p><Button onClick={()=>{setForm({start:job.start,end:job.end,words:5,source:job.trackIds[0]??''});}}>Retry</Button></>}
    </div>)}
    {sets.map(meta=>{const stale=meta.signature!==captionSignature(clips,tracks,timelineId,meta.start,meta.end,meta.trackIds);return <div className="caption-set" key={meta.id}><b>{meta.start.toFixed(2)}–{meta.end.toFixed(2)}s</b><span>{clips.filter(c=>c.properties.captionSet===meta.id).length} lines · up to {meta.wordsPerLine} words</span>{stale&&<p role="status" className="caption-warning"><AlertTriangle size={13}/>Captions are out of date</p>}<div><button onClick={()=>s().styleCaptions(meta.id,preset)}>Apply selected preset</button><button onClick={()=>show(meta)}><RefreshCw size={12}/>Regenerate</button></div></div>;})}
    <div className="caption-filters" aria-label="Caption preset categories">{['All','Cinema','Social'].map(g=><button aria-pressed={group===g} className={group===g?'active':''} key={g} onClick={()=>setGroup(g)}>{g}</button>)}</div>
    <p className="caption-hint">Move across a preview to scrub its animation.</p>
    <div className="caption-presets">{captionPresets.filter(p=>group==='All'||p.group===group).map(p=><CaptionPreview key={p.id} preset={p.id} selected={preset===p.id} onSelect={()=>{setPreset(p.id);show();}}/>)}</div>
    {form&&<Modal title={form.replace?'Regenerate captions':'Generate captions'} onClose={()=>!busy&&setForm(null)}><form onSubmit={e=>{e.preventDefault();void generate();}}><div className="modal-body caption-form">
      
      <CaptionRange start={form.start} end={form.end} source={form.source} onChange={(start,end)=>setForm({...form,start,end,overlap:undefined})}/>
      <div className="caption-form-grid">
      <Field label="Audio source"><select value={form.source} onChange={e=>setForm({...form,source:e.target.value})}><option value="">Audible timeline mix</option>{tracks.filter(t=>t.timelineId===timelineId&&!t.captionSets).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <Field label="Maximum words per line"><NumberInput aria-label="Maximum words per line" min={1} max={15} decimals={0} value={form.words} onCommit={value=>setForm({...form,words:Math.round(value)})}/></Field>

      <Field label="Caption preset"><select value={preset} onChange={e=>setPreset(e.target.value)}>{captionPresets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      </div>
      {overlaps.length>0&&<Field label="Existing captions"><select aria-label="Existing captions" required value={form.overlap??''} onChange={e=>setForm({...form,overlap:e.target.value as 'keep'|'replace'})}><option value="" disabled>Keep or replace overlapping captions?</option><option value="keep">Keep both</option><option value="replace">Replace {overlaps.length} overlapping caption {overlaps.length===1?'set':'sets'}</option></select></Field>}
      {overlaps.length>0&&form.overlap==='replace'&&<p className="caption-warning">All lines in those sets will be replaced after transcription succeeds, including lines outside this range. You can undo this.</p>}
      {form.replace&&<p className="caption-warning">This replaces this set’s lines and manual corrections. Other caption sets stay intact. You can undo the replacement.</p>}
      {error&&<p role="alert" className="caption-warning">{error}</p>}
    </div><div className="modal-actions"><Button onClick={()=>setForm(null)} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" disabled={busy}>{busy?'Starting…':'Generate'}</Button></div></form></Modal>}
  </div>;
}
