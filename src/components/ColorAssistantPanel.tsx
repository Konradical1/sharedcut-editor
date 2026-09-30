import {useEffect,useState} from 'react';
import {Info,RotateCw,Sparkles,Square} from 'lucide-react';
import {useEditorStore} from '../state/store';
import type {Clip} from '../state/models';
import {acesOutputUpgrade} from '../services/color';
import {eligibility,type LookOption} from '../services/colorAssistant';
import {assistantJob,cancelAssistant,latestAssistantJob,startAssistant,type AssistantCapabilities,type AssistantJob,type AssistantRequest,type AssistantSkip} from '../services/colorAssistantClient';
import {Button} from './ui';
import './colorAssistant.css';

const INTENSITY={natural:'Natural',bold:'Bold',extreme:'Extreme'} as const;
const running=(job:AssistantJob|null):job is AssistantJob=>job?.status==='waiting'||job?.status==='running';
const MAX_SHOTS=40; // server/colorAssistant.ts refuses more

/** Color page Assistant tab: the model proposes Balance/Look values; SharedCut renders the stills and applies them as normal nodes. */
export default function ColorAssistantPanel({shots,current,capabilities}:{shots:Clip[];current?:Clip;capabilities:AssistantCapabilities}){
  const s=useEditorStore(),projectId=s.projectId,[job,setJob]=useState<AssistantJob|null>(null),[shown,setShown]=useState<AssistantJob|null>(null),[scope,setScope]=useState<'selected'|'timeline'>('selected'),[prompt,setPrompt]=useState(''),[error,setError]=useState(''),[starting,setStarting]=useState(false);
  const selected=shots.filter(c=>s.selectedClipIds.includes(c.id)),picked=selected.length?selected:current?[current]:[],scoped=scope==='timeline'?shots:picked;
  const name=(id:string)=>s.clips.find(c=>c.id===id)?.name??'Removed shot';
  const skips:AssistantSkip[]=scoped.flatMap(c=>{const e=eligibility(c,s.media.find(m=>m.id===c.mediaId),s.nodes);return e.ok?[]:[{clipId:c.id,code:e.code,text:e.text}];});
  const ids=scoped.filter(c=>!skips.some(k=>k.clipId===c.id)).map(c=>c.id),tooMany=ids.length>MAX_SHOTS;
  // Apply touches only the shots the result was made from, never ones the server skipped.
  const used=shown?shown.request.clipIds.filter(id=>!shown.skipped.some(k=>k.clipId===id)):[];
  useEffect(()=>{let live=true;setJob(null);setShown(null);setError('');latestAssistantJob(projectId).then(j=>{if(live)setJob(j);}).catch(e=>{if(live)setError((e as Error).message);});return()=>{live=false;};},[projectId]);
  useEffect(()=>{
    if(!running(job))return;let live=true;
    // Server hiccups retry every second; a 4xx (job gone, access removed) ends the wait with its message.
    const timer=setTimeout(()=>assistantJob(job.projectId,job.id).then(j=>{if(live)setJob(j);}).catch(e=>{if(!live)return;const status=(e as {status?:number}).status??0;if(status>=400&&status<500)setJob({...job,status:'failed',error:(e as Error).message});else setJob({...job});}),1000);
    return()=>{live=false;clearTimeout(timer);};
  },[job]);
  // The last finished looks stay on screen while a new run works, and after it fails or is cancelled.
  useEffect(()=>{if(job?.status==='done'&&job.result?.looks)setShown(job);},[job]);
  const run=async(request:AssistantRequest)=>{setError('');setStarting(true);try{const id=await startAssistant(projectId,request);setJob({id,projectId,mode:request.mode,status:'waiting',stage:'Waiting',progress:0,createdAt:Date.now(),request,skipped:[]});}catch(e){setError((e as Error).message);}finally{setStarting(false);}};
  const cancel=()=>job&&cancelAssistant(job.projectId,job.id).then(()=>assistantJob(job.projectId,job.id)).then(setJob).catch(e=>setError((e as Error).message));
  const busy=starting||running(job),failure=error||(job?.status==='failed'?job.error||'The Color Assistant failed.':'');
  return <div className="color-assistant">
    <div className="assistant-heading"><h3>Assistant</h3><details className="assistant-info"><summary aria-label="What is sent to OpenAI" title="What is sent to OpenAI"><Info size={14}/></summary><div className="assistant-popover">
      <strong>Sent to OpenAI per request</strong><p>Up to about 10 JPEG stills (about 640 px) of graded frames, the measurement numbers, shot names, camera model and log type, and your style prompt.</p>
      <p>Never the original video, audio, other projects or account data. It runs through your ChatGPT (Codex) login, counts against its limits, and OpenAI may use it for training per that account's setting.</p>
      <small>The model only proposes Balance and Look values. SharedCut renders every preview and applies them as editable nodes; the ACES 2 output and camera input are never changed.{capabilities.model?` Model: ${capabilities.model}.`:''}</small>
    </div></details></div>
    <div className="assistant-scope color-tabs" role="group" aria-label="Shots to use">
      <button aria-pressed={scope==='selected'} onClick={()=>setScope('selected')}>Selected shots ({picked.length})</button>
      <button aria-pressed={scope==='timeline'} onClick={()=>setScope('timeline')}>Whole timeline ({shots.length})</button>
    </div>
    <small className="assistant-hint">Cmd-click (Mac) or Ctrl-click, or Shift-click shots in the strip to pick several.</small>
    <SkipList skips={skips} name={name}/>
    <label className="assistant-prompt"><span>Style (optional)</span><textarea maxLength={500} rows={3} placeholder="cool, dramatic night scene" value={prompt} onChange={e=>setPrompt(e.target.value)}/></label>
    {!capabilities.available&&<p className="color-notice" role="alert">{capabilities.reason}</p>}
    <Button variant="primary" className="assistant-generate" disabled={!capabilities.available||busy||!ids.length||tooMany} onClick={()=>void run({mode:'looks',clipIds:ids,...(prompt.trim()?{prompt:prompt.trim()}:{})})}><Sparkles size={14}/>Generate three looks</Button>
    {tooMany&&<small className="assistant-hint">{ids.length} usable shots; the assistant takes at most {MAX_SHOTS}. Select fewer.</small>}
    {running(job)&&<div className="assistant-job"><span role="status">{job.stage||'Waiting for the assistant…'}</span><div><progress aria-label="Color Assistant progress" max={100} value={job.progress}/><span>{Math.round(job.progress)}%</span><button aria-label="Cancel Color Assistant" title="Cancel" onClick={()=>void cancel()}><Square size={12}/></button></div></div>}
    {failure&&<p className="color-notice" role="alert">{failure}</p>}
    {job?.status==='cancelled'&&<small>Cancelled.</small>}
    {shown?.result?.looks&&<section className="assistant-results" aria-label="Three looks">
      <div className="assistant-results-heading"><strong>{used.length} shot{used.length===1?'':'s'}{shown.request.prompt?` · “${shown.request.prompt}”`:''}</strong><Button disabled={busy} onClick={()=>void run(shown.request)}><RotateCw size={13}/>Regenerate</Button></div>
      {shown.skipped.length>0&&<SkipList skips={shown.skipped} name={name} label="Skipped in this result"/>}
      {shown.result.looks.map((option,i)=><OptionCard key={`${shown.id}-${i}`} job={shown} option={option} index={i} name={name} apply={()=>s.applyColorAssistant({mode:shown.mode,...shown.result!},i,used)}/>)}
    </section>}
  </div>;
}

function SkipList({skips,name,label='Will be skipped'}:{skips:AssistantSkip[];name:(id:string)=>string;label?:string}){
  const s=useEditorStore();if(!skips.length)return null;
  const fix=({clipId,code}:AssistantSkip)=>{const clip=s.clips.find(c=>c.id===clipId);if(!clip)return null;
    if(code==='not-aces'&&acesOutputUpgrade(clip,s.nodes))return <button onClick={()=>s.useAcesOutput(clipId)}>Use ACES 2 output</button>;
    if(code==='legacy-pipeline')return <button onClick={()=>s.initializeColorGrade(clipId)}>Start wide-gamut grade</button>;return null;};
  return <div className="assistant-skips" role="group" aria-label={label}><small>{label}</small><ul>{skips.map(skip=><li key={skip.clipId}><span><strong>{name(skip.clipId)}</strong> {skip.text}</span>{fix(skip)}</li>)}</ul></div>;
}

function OptionCard({job,option,index,name,apply}:{job:AssistantJob;option:LookOption;index:number;name:(id:string)=>string;apply:()=>void}){
  const [held,setHeld]=useState(false),[toggled,setToggled]=useState(false),before=held||toggled;
  // One still per shot, three shots at most: enough to judge the look without a wall of images.
  const stills=(job.result?.stills??[]).filter((still,i,all)=>all.findIndex(o=>o.clipId===still.clipId)===i).slice(0,3);
  return <article className="assistant-option" aria-label={`Look ${index+1}: ${option.name}`}>
    <header><strong>{option.name}</strong><span className={`assistant-intensity ${option.intensity}`}>{INTENSITY[option.intensity]}</span></header>
    {option.description&&<p>{option.description}</p>}
    {stills.length>0&&<div className="assistant-stills" title="Press and hold to see before" onPointerDown={()=>setHeld(true)} onPointerUp={()=>setHeld(false)} onPointerLeave={()=>setHeld(false)} onPointerCancel={()=>setHeld(false)}>
      {stills.map(still=><img key={still.clipId} draggable={false} src={before?still.before:still.after[index]??still.before} alt={`${name(still.clipId)}, ${before?'before':`with ${option.name}`}`}/>)}
    </div>}
    {option.shots.length>0&&<ul className="assistant-notes">{option.shots.map(note=><li key={note.clipId} title={note.rationale}>
      <span><strong>{name(note.clipId)}</strong><em className={note.confidence<.5?'low':''}>{Math.round(note.confidence*100)}% confident</em></span>
      {note.warnings.map((w,j)=><p key={j} className="color-notice">{w.text||w.code}</p>)}
    </li>)}</ul>}
    <div className="assistant-actions"><Button aria-pressed={toggled} onClick={()=>setToggled(!toggled)}>Before</Button><Button variant="primary" onClick={apply} aria-label={`Apply ${option.name}`}>Apply</Button></div>
  </article>;
}
