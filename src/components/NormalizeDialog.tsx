import {useEffect,useRef,useState} from 'react';
import {Square,Wand2} from 'lucide-react';
import {useEditorStore,useStoreWithoutPlayhead} from '../state/store';
import type {Clip} from '../state/models';
import {isAdjustment} from '../services/adjustment';
import {colorGroupOf,colorGroups,nextGroupName} from '../services/colorGroups';
import {cancelNormalize,normalizeJob,startNormalize,type NormalizeJob,type NormalizeRequest} from '../services/colorNormalizeClient';
import {Button,Modal} from './ui';

const running=(job:NormalizeJob|null):job is NormalizeJob=>job?.status==='waiting'||job?.status==='running';
const INFO=new Set(['low-confidence','display-referred']);
const MAX_SHOTS=200,MAX_ALL=300; // server/colorNormalize.ts refuses more
/** A shot Normalize can measure: video footage, not a still, graphic or adjustment layer. */
export const normalizable=(clip:Clip,media:{id:string;kind:string}[])=>!isAdjustment(clip)&&media.find(m=>m.id===clip.mediaId)?.kind==='video';
const plural=(n:number,word='shot')=>`${n} ${word}${n===1?'':'s'}`;

/** Starts and follows one Normalize job; `then` runs once with the finished job. Unmounting cancels a job still running and says so with `cancelled`. */
export function useNormalize(cancelled='Normalize cancelled'){
  const projectId=useEditorStore(s=>s.projectId),[job,setJob]=useState<NormalizeJob|null>(null),[error,setError]=useState(''),[starting,setStarting]=useState(false);
  const then=useRef<((job:NormalizeJob)=>void)|null>(null),current=useRef(job),alive=useRef(true);current.current=job;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;const j=current.current;if(running(j)){void cancelNormalize(j.projectId,j.id).catch(()=>{});useEditorStore.getState().notify(cancelled,'info');}};},[]);
  useEffect(()=>{
    if(!running(job))return;let live=true;
    // Server hiccups retry; a 4xx (job gone, access removed) ends the wait with its message.
    const timer=setTimeout(()=>normalizeJob(job.projectId,job.id).then(j=>{if(live)setJob(j);}).catch(e=>{if(!live)return;const status=(e as {status?:number}).status??0;setJob(status>=400&&status<500?{...job,status:'failed',error:(e as Error).message}:{...job});}),700);
    return()=>{live=false;clearTimeout(timer);};
  },[job]);
  useEffect(()=>{if(job?.status==='done'&&then.current){const done=then.current;then.current=null;done(job);}},[job]);
  const start=async(request:NormalizeRequest,done:(job:NormalizeJob)=>void)=>{
    setError('');setStarting(true);
    try{const id=await startNormalize(projectId,request);if(!alive.current){void cancelNormalize(projectId,id).catch(()=>{});useEditorStore.getState().notify(cancelled,'info');return;}then.current=done;setJob({id,projectId,status:'waiting',stage:'Waiting',progress:0,createdAt:Date.now(),skipped:[]});}
    catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setStarting(false);}
  };
  const cancel=()=>{const j=current.current;if(!running(j))return;then.current=null;void cancelNormalize(j.projectId,j.id).then(()=>normalizeJob(j.projectId,j.id)).then(setJob).catch(e=>setError((e as Error).message));};
  return {job,busy:starting||running(job),error:error||(job?.status==='failed'?job.error||'Normalize failed.':''),start,cancel};
}

type Summary={count:number;job:NormalizeJob;into?:string};
/** Normalize & Group: measures the shots on the server, then gives each an automatic Balance and, if chosen, one shared color group. */
export default function NormalizeDialog({clipIds,group:preset,onClose}:{clipIds:string[];group?:string;onClose:()=>void}){
  const s=useStoreWithoutPlayhead(),clips=s.clips.filter(c=>c.projectId===s.projectId),groups=colorGroups(clips,s.nodes);
  const picked=clipIds.map(id=>clips.find(c=>c.id===id)).filter((c):c is Clip=>Boolean(c)),shots=picked.filter(c=>normalizable(c,s.media)),others=picked.filter(c=>!shots.includes(c));
  const common=colorGroupOf(shots[0]),[choice,setChoice]=useState(()=>preset??(common&&shots.every(c=>colorGroupOf(c)===common)?common:'new'));
  const [name,setName]=useState(()=>nextGroupName(groups)),[clean,setClean]=useState(false),[summary,setSummary]=useState<Summary|null>(null);
  const {job,busy,error,start,cancel}=useNormalize(),chosen=groups.find(g=>g.id===choice),leaving=choice==='none'?shots.filter(c=>colorGroupOf(c)).length:0;
  const label=(id:string)=>s.clips.find(c=>c.id===id)?.name??'Removed shot';
  const run=()=>{
    const targets=shots.map(c=>c.id),contextIds=(chosen?.clipIds??[]).filter(id=>!targets.includes(id)).slice(0,MAX_ALL-targets.length);
    const into=choice==='none'?undefined:chosen?.name??(name.trim()||nextGroupName(groups)),group=choice==='none'?null:chosen?{id:chosen.id}:{name:into},options={group,clean};
    setSummary(null);
    void start({clipIds:targets,...(contextIds.length?{contextIds}:{}),...(clean?{clean}:{})},done=>setSummary({count:done.result?useEditorStore.getState().normalizeColorGroup(done.result,options):0,job:done,into}));
  };
  // A warned shot: select it, show it and get out of the way, so the editor can check it right away (the notice keeps the list).
  const show=(id:string)=>{const st=useEditorStore.getState(),clip=st.clips.find(c=>c.id===id),fps=st.projects.find(p=>p.id===st.projectId)?.fps||24;if(!clip)return;st.setPlaying(false);st.selectClip(id);st.setPlayhead(clip.start+Math.floor(Math.round(clip.duration*fps)/2)/fps);onClose();};
  // Only what needs a look goes in the list; "kept the camera's white balance" and "gentle on phone footage" are one line each.
  const shotsDone=summary?.job.result?.shots??[],check=(w:{code:string})=>!INFO.has(w.code),warned=shotsDone.filter(shot=>shot.warnings.some(check)),kept=shotsDone.filter(shot=>shot.warnings.some(w=>w.code==='low-confidence')).length,gentle=shotsDone.filter(shot=>shot.warnings.some(w=>w.code==='display-referred')).length,skipped=[...others.map(c=>({clipId:c.id,text:isAdjustment(c)?'Adjustment layer':'Still or graphic, not video'})),...(summary?.job.skipped??job?.skipped??[])];
  return <Modal title="Normalize & Group" onClose={onClose}><div className="modal-body normalize-dialog">
    {!summary&&<p>{shots.length?`Balances ${plural(shots.length)}: exposure, white balance and black level, so they look correct and match.`:'None of these shots is video footage.'}</p>}
    {shots.length>MAX_SHOTS&&<p className="danger-text" role="alert">Pick at most {MAX_SHOTS} shots at a time.</p>}
    {!summary&&<><fieldset className="normalize-groups" disabled={busy}><legend>Color group</legend>
      <div className="normalize-option"><label><input type="radio" name="normalize-group" checked={choice==='new'} onChange={()=>setChoice('new')}/>New group</label><input aria-label="New group name" maxLength={60} value={name} onFocus={()=>setChoice('new')} onChange={e=>setName(e.target.value)}/></div>
      {groups.map(g=><div key={g.id} className="normalize-option"><label><input type="radio" name="normalize-group" checked={choice===g.id} onChange={()=>setChoice(g.id)}/><i className="group-dot" style={{background:g.color}}/>{g.name}</label><small>{plural(g.clipIds.length)}</small></div>)}
      <div className="normalize-option"><label><input type="radio" name="normalize-group" checked={choice==='none'} onChange={()=>setChoice('none')}/>No group (just balance)</label></div>
      {leaving>0&&<small>Takes {plural(leaving)} out of {leaving===1?'its':'their'} group.</small>}
    </fieldset>
    <label className="normalize-clean"><input type="checkbox" checked={clean} disabled={busy} onChange={e=>setClean(e.target.checked)}/><span>Start clean: replace each shot's current grade<small>A snapshot keeps the old grades. One undo reverts everything.</small></span></label></>}
    {running(job)&&<div className="normalize-progress"><div><span role="status">{job.stage||'Waiting…'}</span><span>{Math.round(job.progress)}%</span></div><progress aria-label="Normalize progress" max={100} value={job.progress}/></div>}
    {error&&<p className="danger-text" role="alert">{error}</p>}
    {job?.status==='cancelled'&&!summary&&<small>Cancelled.</small>}
    {summary&&<p role="status"><strong>{summary.count?`Balanced ${plural(summary.count)}${summary.into?` into ${summary.into}`:''}.`:'No shot could be balanced.'}</strong></p>}
    {(kept>0||gentle>0)&&<small>{[kept&&`${plural(kept)} kept the camera's white balance: no clear white or grey in the picture.`,gentle&&`${plural(gentle)} from phones or finished video got a gentler mid-tone lift.`].filter(Boolean).join(' ')}</small>}
    {warned.length>0&&<div className="normalize-list"><small>Check these shots</small><ul>{warned.map(shot=><li key={shot.clipId}><button onClick={()=>show(shot.clipId)}>{label(shot.clipId)}</button> {shot.warnings.filter(check).map(w=>w.text).join(' ')}</li>)}</ul></div>}
    {skipped.length>0&&<div className="normalize-list"><small>{summary?'Skipped':'Will be skipped'}</small><ul>{skipped.map(k=><li key={k.clipId}><strong>{label(k.clipId)}</strong> {k.text}</li>)}</ul></div>}
  </div><div className="modal-actions">
    {summary?<Button variant="primary" onClick={onClose}>Done</Button>:running(job)?<Button onClick={cancel}><Square size={11}/>Cancel</Button>:<><Button onClick={onClose}>Close</Button><Button variant="primary" disabled={busy||!shots.length||shots.length>MAX_SHOTS} onClick={run}><Wand2 size={13}/>Normalize</Button></>}
  </div></Modal>;
}
