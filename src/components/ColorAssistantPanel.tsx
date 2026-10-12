import {useEffect,useState,type CSSProperties,type PointerEvent} from 'react';
import {Check,Info,RotateCw,Sparkles,Square} from 'lucide-react';
import {useStoreWithoutPlayhead} from '../state/store';
import type {Clip} from '../state/models';
import {acesOutputUpgrade} from '../services/color';
import {eligibility,type BalanceValues,type LookOption,type ShotNote} from '../services/colorAssistant';
import {RECIPES} from '../services/colorLooks';
import {assistantJob,cancelAssistant,latestAssistantJob,startAssistant,type AssistantCapabilities,type AssistantJob,type AssistantRequest,type AssistantSkip} from '../services/colorAssistantClient';
import {Button} from './ui';
import './colorAssistant.css';

const INTENSITY={natural:'Natural',bold:'Bold',extreme:'Strong'} as const;
const STYLES=['Warm film','Teal and orange','Moody night','Bleach bypass','Soft pastel'];
const running=(job:AssistantJob|null):job is AssistantJob=>job?.status==='waiting'||job?.status==='running';
const MAX_SHOTS=40; // server/colorAssistant.ts refuses more
/** claude-opus-5-5 → Claude Opus 5.5; other ids as they are. */
const modelName=(id='')=>{const parts=id.split('-'),n=parts.findIndex(p=>/^\d+$/.test(p));return id.startsWith('claude-')&&n>0?`${parts.slice(0,n).map(p=>p[0].toUpperCase()+p.slice(1)).join(' ')} ${parts.slice(n).join('.')}`:id;};

/** Color page Assistant tab: the model proposes Balance/Look values; SharedCut renders the stills and applies them as normal nodes. */
export default function ColorAssistantPanel({shots,current,capabilities}:{shots:Clip[];current?:Clip;capabilities:AssistantCapabilities}){
  const s=useStoreWithoutPlayhead(),projectId=s.projectId,[job,setJob]=useState<AssistantJob|null>(null),[shown,setShown]=useState<AssistantJob|null>(null),[scope,setScope]=useState<'selected'|'timeline'>('selected'),[prompt,setPrompt]=useState(''),[error,setError]=useState(''),[starting,setStarting]=useState(false);
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
  const claude=capabilities.provider==='anthropic',vendor=claude?'Anthropic':'OpenAI';
  return <div className="color-assistant">
    <header className="assistant-hero">
      <span className="assistant-mark" aria-hidden><Sparkles size={15}/></span>
      <div><h3>Color Assistant</h3><p>Balances every shot, then offers three looks from natural to strong. Preview them on your footage and apply one as editable nodes.</p></div>
      <details className="assistant-info"><summary aria-label={`What is sent to ${vendor}`} title={`What is sent to ${vendor}`}><Info size={14}/></summary><div className="assistant-popover">
        <strong>Sent to {vendor} per request</strong><p>Up to about 10 JPEG stills (about 640 px) of graded frames, the measurement numbers, shot names, camera model and log type, and your style prompt.</p>
        <p>Never the original video, audio, other projects or account data. {claude?'It runs on this server\'s Anthropic API key. Anthropic does not train on API data by default.':'It runs through your ChatGPT (Codex) login, counts against its limits, and OpenAI may use it for training per that account\'s setting.'}</p>
        <small>The model only proposes Balance and Look values. SharedCut renders every preview and applies them as editable nodes; the ACES 2 output and camera input are never changed.</small>
      </div></details>
      {capabilities.model&&<span className="assistant-model">{modelName(capabilities.model)}</span>}
    </header>
    <div className="assistant-field">
      <span>Shots</span>
      <div className="assistant-scope color-tabs" role="group" aria-label="Shots to use">
        <button aria-pressed={scope==='selected'} onClick={()=>setScope('selected')}>Selected shots ({picked.length})</button>
        <button aria-pressed={scope==='timeline'} onClick={()=>setScope('timeline')}>Whole timeline ({shots.length})</button>
      </div>
      {scope==='selected'&&<small className="assistant-hint">Cmd-click (Mac), Ctrl-click or Shift-click shots in the strip to pick several.</small>}
    </div>
    <SkipList skips={skips} name={name}/>
    <label className="assistant-field assistant-prompt"><span>Style <small>optional</small></span><textarea maxLength={500} rows={2} placeholder="cool, dramatic night scene" value={prompt} onChange={e=>setPrompt(e.target.value)}/></label>
    <div className="assistant-styles" role="group" aria-label="Style ideas">{STYLES.map(style=><button key={style} aria-pressed={prompt===style} onClick={()=>setPrompt(prompt===style?'':style)}>{style}</button>)}</div>
    {!capabilities.available&&<p className="color-notice" role="alert">{capabilities.reason}</p>}
    <Button variant="primary" className="assistant-generate" disabled={!capabilities.available||busy||!ids.length||tooMany} onClick={()=>void run({mode:'looks',clipIds:ids,...(prompt.trim()?{prompt:prompt.trim()}:{})})}><Sparkles size={14}/>Generate three looks</Button>
    {tooMany&&<small className="assistant-hint">{ids.length} usable shots; the assistant takes at most {MAX_SHOTS}. Select fewer.</small>}
    {running(job)&&<div className="assistant-job"><div><span role="status">{job.stage||'Waiting for the assistant…'}</span><span>{Math.round(job.progress)}%</span><button aria-label="Cancel Color Assistant" title="Cancel" onClick={()=>void cancel()}><Square size={11}/></button></div><progress aria-label="Color Assistant progress" max={100} value={job.progress}/><small>Usually about a minute. You can keep grading meanwhile.</small></div>}
    {failure&&<p className="color-notice" role="alert">{failure}</p>}
    {job?.status==='cancelled'&&<small>Cancelled.</small>}
    {shown?.result?.looks&&<section className="assistant-results" aria-label="Three looks">
      <div className="assistant-results-heading"><strong>{used.length} shot{used.length===1?'':'s'}{shown.request.prompt?`, “${shown.request.prompt}”`:''}</strong><Button variant="ghost" disabled={busy} onClick={()=>void run(shown.request)}><RotateCw size={13}/>Regenerate</Button></div>
      {shown.skipped.length>0&&<SkipList skips={shown.skipped} name={name} label="Skipped in this result"/>}
      {shown.result.shots&&shown.result.shots.length>0&&<BalanceList notes={shown.result.shots} name={name}/>}
      {shown.result.looks.map((option,i)=><OptionCard key={`${shown.id}-${i}`} job={shown} option={option} index={i} name={name} apply={()=>s.applyColorAssistant({mode:shown.mode,...shown.result!},i,used)}/>)}
    </section>}
  </div>;
}

function SkipList({skips,name,label='Will be skipped'}:{skips:AssistantSkip[];name:(id:string)=>string;label?:string}){
  const s=useStoreWithoutPlayhead();if(!skips.length)return null;
  const fix=({clipId,code}:AssistantSkip)=>{const clip=s.clips.find(c=>c.id===clipId);if(!clip)return null;
    if(code==='not-aces'&&acesOutputUpgrade(clip,s.nodes))return <button onClick={()=>s.useAcesOutput(clipId)}>Use ACES 2 output</button>;
    if(code==='legacy-pipeline')return <button onClick={()=>s.initializeColorGrade(clipId)}>Start wide-gamut grade</button>;return null;};
  return <div className="assistant-skips" role="group" aria-label={label}><small>{label}</small><ul>{skips.map(skip=><li key={skip.clipId}><span><strong>{name(skip.clipId)}</strong> {skip.text}</span>{fix(skip)}</li>)}</ul></div>;
}

const sign=(v:number,digits=1)=>`${v>0?'+':''}${+v.toFixed(digits)}`;
/** What Apply sets on a shot's Balance node, in words a colorist reads. */
const balanceText=(b?:BalanceValues)=>!b?'Keeps its own balance':[b.exposure?`exposure ${sign(b.exposure)}`:'',b.temperature?`${b.temperature>0?'warmer':'cooler'} ${Math.abs(Math.round(b.temperature))}`:'',b.tint?`tint ${sign(b.tint,0)}`:''].filter(Boolean).join(', ')||'Balance reset to neutral';
function BalanceList({notes,name}:{notes:(ShotNote&{balance?:BalanceValues})[];name:(id:string)=>string}){
  const warnings=notes.reduce((n,note)=>n+note.warnings.length,0),changed=notes.filter(note=>note.balance).length;
  return <details className="assistant-balance"><summary><span>Balance</span><small>{changed} of {notes.length} shot{notes.length===1?'':'s'} corrected first{warnings>0&&<em>{warnings} to check</em>}</small></summary><ul>{notes.map(note=><li key={note.clipId}>
    <span><strong>{name(note.clipId)}</strong><em>{balanceText(note.balance)}</em></span>
    {note.rationale&&<p>{note.rationale}</p>}
    {note.warnings.map((w,j)=><p key={j} className="color-notice">{w.text||w.code}</p>)}
  </li>)}</ul></details>;
}

function OptionCard({job,option,index,name,apply}:{job:AssistantJob;option:LookOption;index:number;name:(id:string)=>string;apply:()=>void}){
  const [toggled,setToggled]=useState(false),[wipe,setWipe]=useState<number|null>(null),[pick,setPick]=useState(0),[applied,setApplied]=useState(false);
  useEffect(()=>{if(!applied)return;const timer=setTimeout(()=>setApplied(false),2000);return()=>clearTimeout(timer);},[applied]);
  // One still per shot, three shots at most: enough to judge the look without a wall of images.
  const stills=(job.result?.stills??[]).filter((still,i,all)=>all.findIndex(o=>o.clipId===still.clipId)===i).slice(0,3),still=stills[Math.min(pick,stills.length-1)];
  // Split-screen wipe: before left of the line, the look right of it. Hover or drag moves it; Before shows the whole frame ungraded.
  const split=toggled?100:wipe??0,move=(e:PointerEvent<HTMLDivElement>)=>{const box=e.currentTarget.getBoundingClientRect();setWipe(Math.max(0,Math.min(100,(e.clientX-box.left)/box.width*100)));};
  const warnings=option.shots.reduce((n,note)=>n+note.warnings.length,0),level=index+1;
  return <article className="assistant-option" aria-label={`Look ${level}: ${option.name}`}>
    {still&&<div className="assistant-compare" data-view={toggled?'before':wipe===null?'look':'split'} style={{'--wipe':`${split}%`} as CSSProperties} title="Move across the picture to compare with before" onPointerMove={move} onPointerDown={move} onPointerLeave={()=>setWipe(null)}>
      <img draggable={false} src={still.after[index]??still.before} alt={`${name(still.clipId)} with ${option.name}`}/>
      <img draggable={false} className="assistant-before" src={still.before} alt={`${name(still.clipId)} before`}/>
      {split>0&&split<100&&<i className="assistant-wipe" aria-hidden/>}
      {split>0&&<span className="assistant-tag" aria-hidden>Before</span>}
    </div>}
    {stills.length>1&&<div className="assistant-thumbs" role="group" aria-label="Shot to preview">{stills.map((item,i)=><button key={item.clipId} aria-pressed={item===still} aria-label={`Preview ${name(item.clipId)}`} title={name(item.clipId)} onClick={()=>setPick(i)}><img draggable={false} src={item.after[index]??item.before} alt=""/></button>)}</div>}
    <header><strong>{option.name}</strong><span className={`assistant-intensity ${option.intensity}`} aria-label={`Intensity ${level} of 3: ${INTENSITY[option.intensity]}`}><span aria-hidden>{[1,2,3].map(n=><i key={n} className={n<=level?'on':''}/>)}</span>{INTENSITY[option.intensity]}</span></header>
    {option.recipe&&<small className="assistant-recipe">{RECIPES.find(r=>r.id===option.recipe)?.name??option.recipe} at {Math.round((option.strength??1)*100)}%{option.warmth?`, ${option.warmth>0?'warmer':'cooler'}`:''}</small>}
    {option.description&&<p>{option.description}</p>}
    {option.shots.length>0&&<details className="assistant-notes"><summary>{option.shots.length} shot note{option.shots.length===1?'':'s'}{warnings>0&&<em>{warnings} to check</em>}</summary><ul>{option.shots.map(note=><li key={note.clipId}>
      <span><strong>{name(note.clipId)}</strong><em className={note.confidence<.5?'low':''}>{Math.round(note.confidence*100)}% confident</em></span>
      {note.rationale&&<p>{note.rationale}</p>}
      {note.warnings.map((w,j)=><p key={j} className="color-notice">{w.text||w.code}</p>)}
    </li>)}</ul></details>}
    <div className="assistant-actions"><Button variant="ghost" aria-pressed={toggled} onClick={()=>setToggled(!toggled)}>Before</Button><Button variant="primary" onClick={()=>{apply();setApplied(true);}} aria-label={`Apply ${option.name}`}>{applied?<><Check size={13}/>Applied</>:'Apply look'}</Button></div>
  </article>;
}
