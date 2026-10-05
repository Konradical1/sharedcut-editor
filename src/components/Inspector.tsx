import SmartMaskInspector from './SmartMaskInspector';
import DepthInspector from './DepthInspector';
import MotionTrackerInspector from './MotionTrackerInspector';
import { PanelTabPresence, usePanelTabPresence } from './PanelTabPresence';
import CaptionInspector from './CaptionInspector';
import { isCaption } from '../services/captions';
import { isComposition } from '../services/compositions';
import { isAdjustment } from '../services/adjustment';
import TransitionInspector from './TransitionInspector';
import { transitionName } from '../services/transitions';
import { evaluateClip, frameTime } from '../services/animation';
import TextInspector from './TextInspector';
import ShapeInspector from './ShapeInspector';
import { isShape } from '../services/shapes';
import { isTitle } from '../services/text';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent } from 'react';
import { Shapes, Type, SlidersHorizontal, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Diamond, Plus, Film, Crop, Gauge, WandSparkles, Volume2, Layers, LockKeyhole, Info, X, Trash2, ArrowUp, ArrowDown, Crosshair } from 'lucide-react';
import { useEditorStore, usePanelPlayhead } from '../state/store';
import { effectDefinitions, effectValue, effectEnabled, acceptsEffect, initialAmount, loudnessTargets, loudnessTarget } from '../services/effects';
import { IconButton, EmptyState, NumberInput, durationLabel, fpsLabel } from './ui';
import { api } from '../services/api';
import { blendModeNames } from '../services/blendModes';
import type { FlowPreview } from '../services/opticalFlow';
import type { StabilizePreview } from '../services/stabilize';
import type { Clip } from '../state/models';

function StabilizeStatus({clipId,lock}:{clipId:string;lock:number}) {
  const [capability,setCapability]=useState<{available:boolean;reason?:string}>();
  const [status,setStatus]=useState<StabilizePreview>();
  useEffect(()=>{let active=true;void api<{available:boolean;reason?:string}>('/stabilize/capabilities').then(value=>{if(active)setCapability(value);}).catch(error=>{if(active)setCapability({available:false,reason:error.message});});return()=>{active=false;};},[]);
  useEffect(()=>{setStatus(undefined);const changed=(event:Event)=>{const detail=(event as CustomEvent).detail;if(detail.clipId===clipId)setStatus(previous=>JSON.stringify(previous)===JSON.stringify(detail)?previous:detail);};window.addEventListener('frameline:stabilize',changed);return()=>window.removeEventListener('frameline:stabilize',changed);},[clipId]);
  return <p className="inspector-note" role="status">{capability?.available===false?capability.reason:!capability?'Checking stabilizer…':status?.status==='ready'?'Ready · stabilized preview':status?.status==='failed'?status.error:`Analyzing camera motion${status?.progress?` · ${status.progress}%`:''}. The whole clip plays stabilized as soon as this finishes.`}<br/>{status?.zoom?`Picture zoomed ${status.zoomMin&&status.zoomMin<status.zoom-.0005?`${((status.zoomMin-1)*100).toFixed(1)}–`:''}${((status.zoom-1)*100).toFixed(1)}%. `:''}{lock>=.5?'Locked to the first frame; the zoom grows with the drift. ':'Crop is the budget per side; pans are followed, shake inside the budget is removed. '}Analysis runs once on the original and is cached; the picture is warped in the browser, so grades, Smart Mask and quality switches never re-render it. Values are read at the clip start; keyframes do not animate them.</p>;
}

function OpticalFlowControl({clipId,enabled}:{clipId:string;enabled:boolean}) {
  const [capability,setCapability]=useState<{available:boolean;error?:string}>();
  const [status,setStatus]=useState<FlowPreview>();
  useEffect(()=>{let active=true;void api<{available:boolean;error?:string}>('/optical-flow/capabilities').then(value=>{if(active)setCapability(value);}).catch(error=>{if(active)setCapability({available:false,error:error.message});});return()=>{active=false;};},[]);
  useEffect(()=>{setStatus(undefined);const changed=(event:Event)=>{const detail=(event as CustomEvent).detail;if(detail.clipId===clipId)setStatus(previous=>JSON.stringify(previous)===JSON.stringify(detail)?previous:detail);};window.addEventListener('frameline:optical-flow',changed);return()=>window.removeEventListener('frameline:optical-flow',changed);},[clipId,enabled]);
  return <><label className="inspector-checks"><input aria-label="Optical flow" type="checkbox" checked={enabled} disabled={!enabled&&!capability?.available} onChange={e=>useEditorStore.getState().updateProperty(clipId,'opticalFlow',e.target.checked)}/>Optical flow</label>
    <p className="inspector-note" role="status">{capability?.available===false?capability.error:!capability?'Checking Mac processor…':enabled?status?.status==='ready'?'Ready · Apple optical flow':status?.status==='failed'?status.error:`Preparing optical flow${status?.progress?` · ${status.progress}%`:''}. Playback updates as sections finish.`:'Generate intermediate frames for smooth slow motion. Processed on your Mac.'}</p></>;
}

export function Section({ title, icon, children, open = true }: { title: string; icon?: ReactNode; children: ReactNode; open?: boolean }) {
  return <details className="inspector-section" open={open}><summary data-cursor-anchor={`section-${title}`}>{icon}<span>{title}</span><ChevronDown size={13}/></summary><div className="inspector-section-content">{children}</div></details>;
}
export function Property({ name, label, initial=0, min, max, step=1, suffix, effectId, clipId, control, animatable=true }: {name:string;animatable?:boolean;label:string;initial?:number;min?:number;max?:number;step?:number;suffix?:string;effectId?:string;clipId?:string;control?:{value:number|undefined;change:(value:number)=>void;preview:(value:number)=>void}}) {
  const clip=useEditorStore(s=>s.clips.find(c=>c.id===(clipId??s.selectedTransition?.clipId??s.selectedClipId)));
  const path=effectId?`effects.${effectId}.${name==='amount'?'amount':`parameters.${name}`}`:control?`text.${name.slice(5)}`:`properties.${name}`;
  // Only a keyframed property changes with time, and while playing a 4 Hz readout is enough.
  const playhead=usePanelPlayhead(!!clip?.keyframes?.[path]?.length);
  const fps=useEditorStore(s=>s.projects.find(p=>p.id===clip?.projectId)?.fps??24);
  const locks=useEditorStore(s=>s.locks);
  const users=useEditorStore(s=>s.users);
  const currentUserId=useEditorStore(s=>s.currentUserId);
  const drag = useRef<{ x: number; value: number; next: number; moved: boolean } | null>(null);
  const [draft,setDraft]=useState<number|null>(null);
  const lease = useRef<ReturnType<typeof setInterval>|undefined>(undefined);
  const field=control?(name.startsWith('__transition')?'transition':'textDocument'):effectId?'effects':name;
  useEffect(()=>()=>{clearInterval(lease.current);if(clip)useEditorStore.getState().releaseLock(clip.id,field);useEditorStore.setState({clipPreview:null,textPreview:[]});},[clip?.id,field]);
  if(!clip)return null;
  const evaluated=evaluateClip(clip,playhead);
  const effect=evaluated.effects.find(e=>e.id===effectId);
  const keys=(clip.keyframes?.[path]??[]).filter(k=>k.time>=0&&k.time<clip.duration);
  const frame=Math.round((playhead-clip.start)*fps);
  const onKeyframe=playhead>=clip.start&&playhead<clip.start+clip.duration&&keys.some(k=>Math.round(k.time*fps)===frame);
  const previous=keys.filter(k=>Math.round(k.time*fps)<frame).at(-1), next=keys.find(k=>Math.round(k.time*fps)>frame);
  const lock=locks.find(l=>l.targetId===clip.id&&(l.field===field||l.field==='*')&&l.expiresAt>Date.now());
  const owner=users.find(u=>u.id===lock?.userId);
  const locked=!!owner&&owner.id!==currentUserId;
  const value=control?(control.value??initial):effect?effectValue(clip,effect,name):Number(evaluated.properties[name]??initial);
  const store=useEditorStore.getState;
  const inputId=effectId?`effect-${effectId}-${name}`:`property-${name}`;
  const begin = () => {
    if (!store().acquireLock(clip.id, field)) return false;
    clearInterval(lease.current);
    lease.current = setInterval(() => store().renewLock(clip.id, field), 3000);
    return true;
  };
  const change = (next: number) => {
    if (!Number.isFinite(next)) return;
    next=Math.min(max??Infinity,Math.max(min??-Infinity,next));
    if(control)control.change(next);
    else if(effectId)store().updateEffect(clip.id,effectId,name==='amount'?{amount:next}:{parameters:{[name]:next}});
    else store().updateProperty(clip.id,name,next);
  };
  const end = (commit=false) => {
    const current=drag.current;drag.current=null;setDraft(null);useEditorStore.setState({clipPreview:null,textPreview:[]});
    if(commit&&current?.moved)change(current.next);
    clearInterval(lease.current);store().releaseLock(clip.id,field);
  };
  const start = (e: PointerEvent<HTMLElement>) => {
    if(e.button!==0||locked)return;
    if(e.currentTarget instanceof HTMLInputElement&&document.activeElement===e.currentTarget)return;
    e.preventDefault();if(!begin())return;
    drag.current={x:e.clientX,value,next:value,moved:false};e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const current=drag.current;if(!current||Math.abs(e.clientX-current.x)<3&&!current.moved)return;
    current.moved=true;
    current.next=Math.min(max??Infinity,Math.max(min??-Infinity,Number((current.value+(e.clientX-current.x)*step*(e.shiftKey?.1:1)).toFixed(4))));
    setDraft(current.next);
    if(control){control.preview(current.next);return;}
    if(clip.keyframes?.[path]) {
      const fps=store().projects.find(p=>p.id===clip.projectId)?.fps??24,time=frameTime(Math.max(0,Math.min(clip.duration-1/fps,store().playhead-clip.start)),fps),keys=clip.keyframes[path],existing=keys.find(k=>Math.abs(k.time-time)<.5/fps);
      useEditorStore.setState({clipPreview:{...clip,keyframes:{...clip.keyframes,[path]:[...keys.filter(k=>k!==existing),{id:existing?.id??'preview',time,value:current.next,interpolation:existing?.interpolation??'linear',...(existing?.curve?{curve:existing.curve}:{})}].sort((a,b)=>a.time-b.time)}}});return;
    }
    // `playhead` is a constant 0 for an unkeyframed property; the frozen preview must pose the clip's other animation at the real playhead.
    const live=evaluateClip(clip,store().playhead);
    useEditorStore.setState({clipPreview:effectId?{...live,keyframes:undefined,effects:live.effects.map(e=>e.id===effectId?{...e,...(name==='amount'?{amount:current.next}:{parameters:{...e.parameters,[name]:current.next}})}:e)}:{...live,keyframes:undefined,properties:{...live.properties,[name]:current.next}}});
  };
  const finish = (e: PointerEvent<HTMLElement>) => {
    if(!drag.current)return;move(e);const moved=drag.current.moved;end(true);
    if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
    if(!moved){const input=document.getElementById(inputId) as HTMLInputElement;input?.focus();input?.select();}
  };
  const scrub={onPointerDown:start,onPointerMove:move,onPointerUp:finish,onPointerCancel:()=>end(),onLostPointerCapture:()=>{if(drag.current)end();}};
  return <div className={`property-row ${owner?'property-owned':''}`} style={owner?{'--owner-color':owner.color} as CSSProperties:undefined}>
    <label data-cursor-anchor={`${inputId}-label`} className="scrub-label" title="Drag to adjust; Shift for fine control" htmlFor={inputId} {...scrub}>{label}</label>
    <div className="property-input-wrap"><NumberInput data-cursor-anchor={inputId} id={inputId} className="scrub-number" aria-label={effect?`${effect.name} ${name==='amount'?'amount':label}`:label} title="Drag left or right to adjust; click to type; Shift for fine control" value={control&&control.value===undefined&&draft===null?undefined:draft??value} decimals={suffix==='s'||step>=.01?2:4} placeholder={control?'—':undefined} data-mixed={control?.value===undefined&&!!control||undefined} min={min} max={max} step={step} disabled={locked} {...scrub} onFocus={e=>{if(!begin())e.currentTarget.blur();}} onBlur={()=>end()} onCommit={change}/>{suffix&&<span>{suffix}</span>}</div>
    {!control&&animatable&&<div className="property-keyframes">
      <button aria-label={`Previous ${label} keyframe`} title={`Previous ${label} keyframe`} disabled={!previous} onClick={()=>previous&&store().setPlayhead(clip.start+previous.time)}><ChevronLeft size={11}/></button>
      <button className={`keyframe-toggle ${onKeyframe?'active':''}`} aria-label={`Add ${label} keyframe`} title="Add keyframe at playhead; subsequent edits animate" disabled={locked} onClick={()=>store().keyframeProperty(clip.id,path,value)}><Diamond size={11} fill={onKeyframe?'currentColor':'none'}/></button>
      <button aria-label={`Next ${label} keyframe`} title={`Next ${label} keyframe`} disabled={!next} onClick={()=>next&&store().setPlayhead(clip.start+next.time)}><ChevronRight size={11}/></button>
    </div>}
    {owner&&(!control||locked)&&<span className="property-owner"><i/>{owner.id===currentUserId?'You':owner.name} editing{locked&&<LockKeyhole size={9}/>}</span>}
  </div>;
}
export function MotionBlurControl() {
  const clip=useEditorStore(s=>s.clips.find(c=>c.id===s.selectedClipId));
  const tracks=useEditorStore(s=>s.tracks),locks=useEditorStore(s=>s.locks),user=useEditorStore(s=>s.currentUserId);
  if(!clip)return null;
  const enabled=clip.properties.motionBlur===true,store=useEditorStore.getState;
  const locked=tracks.find(t=>t.id===clip.trackId)?.locked||locks.some(l=>l.targetId===clip.id&&l.expiresAt>Date.now()&&l.userId!==user&&(l.field==='*'||l.field.startsWith('motionBlur')));
  return <fieldset className="motion-blur-control" disabled={locked} aria-label="Transform motion blur"><label className="inspector-checks"><input type="checkbox" aria-label="Motion blur" aria-controls="motion-blur-settings" checked={enabled} disabled={locked} onChange={e=>store().updateProperty(clip.id,'motionBlur',e.target.checked)}/>Motion blur</label>
    {enabled&&<div id="motion-blur-settings"><Property name="motionBlurStrength" animatable={false} label="Strength" initial={50} min={0} max={100} suffix="%"/>
      <label className="inspector-select-row"><span>Quality</span><select aria-label="Motion blur quality" disabled={locked} value={Number(clip.properties.motionBlurSamples??32)} onChange={e=>store().updateProperty(clip.id,'motionBlurSamples',Number(e.target.value))}><option value={16}>Standard</option><option value={32}>High</option><option value={64}>Maximum</option></select></label>
      <p className="inspector-note">Softens animated position and scale only. 50% gives a natural half-frame shutter; higher quality smooths fast movement.</p>
    </div>}
  </fieldset>;
}
function NormalizeControl({clip,loudness}:{clip:Clip;loudness?:number}) {
  const on=Boolean(clip.properties.normalize),target=loudnessTarget(clip),s=useEditorStore.getState;
  return <><label className="inspector-checks"><input type="checkbox" aria-label="Normalize loudness" checked={on} onChange={e=>s().updateProperty(clip.id,'normalize',e.target.checked)}/> Normalize loudness</label>
    {on&&<label className="inspector-select-row"><span>Target</span><select aria-label="Loudness target" value={target} onChange={e=>s().updateProperty(clip.id,'normalizeTarget',Number(e.target.value))}>{loudnessTargets.map(t=><option key={t.lufs} value={t.lufs}>{t.lufs} LUFS · {t.label}</option>)}</select></label>}
    {on&&<p className="inspector-note">{loudness===undefined?'Export measures this clip and sets it to the target. Preview plays it unchanged: this file has no loudness measurement (media imported before it existed, or silent).':`Export measures this clip and sets it to ${target} LUFS. Preview applies the whole file's measured ${loudness.toFixed(1)} LUFS → ${(target-loudness).toFixed(1)} dB, an approximation.`}</p>}</>;
}
export default function Inspector() {
  // A selected transition is its own subject: it no longer selects the clip it is stored on, so
  // the panel resolves that clip itself rather than lighting it up on the timeline.
  const selected=useEditorStore(s=>s.clips.find(c=>c.id===(s.selectedTransition?.clipId??s.selectedClipId)));
  const asset=useEditorStore(s=>s.media.find(m=>m.id===selected?.mediaId));
  const storedTab=useEditorStore(s=>s.inspectorTab);
  const caption=selected&&isCaption(selected);
  const title = selected && isTitle(selected);
  const shape = selected && isShape(selected);
  const adjustment = selected && isAdjustment(selected);
  const hasTransition = !!selected && (!!transitionName(selected,'in') || !!transitionName(selected,'out'));
  const storedOrDefault = storedTab==='Transition' && !hasTransition ? 'Video' : storedTab;
  const tab = caption ? 'Caption' : storedOrDefault==='Transition' ? 'Transition' : title ? (storedOrDefault==='Effects'?'Effects':'Text') : shape && !['Shape','Effects'].includes(storedOrDefault) ? 'Shape' : adjustment && !['Video','Effects','Transition'].includes(storedOrDefault) ? 'Video' : storedOrDefault;
  usePanelTabPresence('inspector', selected ? tab : undefined);
  const setTab=(inspectorTab:string)=>useEditorStore.setState({inspectorTab});
  const s=useEditorStore.getState;
  return <section className="inspector panel" data-cursor-clip={selected?.id}><header className="panel-header"><SlidersHorizontal size={15}/><h2>Inspector</h2><span className="spacer"/><IconButton label="Close inspector" onClick={()=>s().setSidePanel(null)}><X size={14}/></IconButton></header>{!selected?<EmptyState icon={<SlidersHorizontal size={26}/>} title="Make a selection" description="Select a timeline clip to see its properties."/>:<>
    <div className="inspector-clip"><span className="inspector-clip-icon">{title?<Type size={13}/>:shape?<Shapes size={13}/>:adjustment?<SlidersHorizontal size={13}/>:<Film size={13}/>}</span><b title={selected.name}>{selected.name}</b><span className="inspector-clip-meta" title={`${asset?.resolution??'1920 × 1080'} · ${fpsLabel(asset?.fps)} fps`}>{asset?.resolution??'1920 × 1080'} · {fpsLabel(asset?.fps)} fps</span></div>
    <div className="inspector-tabs">{[...(caption?['Caption']:title?['Text','Effects']:shape?['Shape','Effects']:adjustment?['Video','Effects']:['Video','Audio','Effects','Info']),...(hasTransition?['Transition']:[])].map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}<PanelTabPresence panel="inspector" tab={t} clipId={selected.id}/></button>)}</div>
    <div className="inspector-scroll" data-cursor-surface="inspector" data-cursor-clip={selected.id} data-cursor-context={tab}>
      {tab==='Caption'&&<CaptionInspector key={selected.id} id={selected.id}/>}
      {tab==='Transition'&&<TransitionInspector/>}
      {tab==='Text'&&title&&<TextInspector/>}{isComposition(selected)&&<button className="composition-open" onClick={()=>s().openComposition(selected.id)}><Layers size={14}/>Open composition</button>}
      {tab==='Shape'&&<ShapeInspector/>}
      {tab==='Video'&&adjustment&&<p className="inspector-note">Everything on the tracks below this clip takes its transform, effects and color. Grade it in Color like any shot.</p>}
      {tab==='Video'&&<>
        <Section title="Transform" icon={<SlidersHorizontal size={12}/>}><Property name="x" label="Position X" suffix="px"/><Property name="y" label="Position Y" suffix="px"/><Property name="zoom" label="Zoom" initial={100} min={1} max={800} suffix="%"/><Property name="rotation" label="Rotation" min={-360} max={360} suffix="°"/><Property name="anchorX" label="Anchor X" suffix="px"/><Property name="anchorY" label="Anchor Y" suffix="px"/><label className="inspector-checks" data-cursor-anchor="flipH"><input type="checkbox" aria-label="Flip horizontal" checked={Boolean(selected.properties.flipH)} onChange={e=>s().updateProperty(selected.id,'flipH',e.target.checked)}/>Flip horizontal</label><MotionBlurControl/></Section>
        {asset?.kind==='video'&&!isComposition(selected)&&<Section title="Tracking" icon={<Crosshair size={12}/>} open={!!selected.motionTrackers?.length}><MotionTrackerInspector clip={selected}/></Section>}
        <Section title="Crop" icon={<Crop size={12}/>} open={false}>{['Left','Right','Top','Bottom'].map(side=><Property key={side} name={`crop${side}`} label={side} min={0} max={1920} suffix="px"/>)}</Section>
        <Section title="Composite" icon={<Layers size={12}/>}><Property name="opacity" label="Opacity" initial={100} min={0} max={100} suffix="%"/><Property name="fadeIn" label="Fade in" min={0} max={selected.duration} step={1/(asset?.fps||24)} suffix="s"/><Property name="fadeOut" label="Fade out" min={0} max={selected.duration} step={1/(asset?.fps||24)} suffix="s"/><label className="inspector-select-row"><span>Blend mode</span><select data-cursor-anchor="blend-mode" aria-label="Blend mode" value={String(selected.properties.blendMode??'Normal')} onChange={e=>s().updateProperty(selected.id,'blendMode',e.target.value)}>{blendModeNames.map(x=><option key={x}>{x}</option>)}</select></label></Section>
        {!adjustment&&<Section title="Speed" icon={<Gauge size={12}/>}><Property name="speed" label="Speed" initial={100} min={1} max={800} suffix="%"/>
          {asset?.kind==='video'&&<OpticalFlowControl clipId={selected.id} enabled={Boolean(selected.properties.opticalFlow)}/>}
          <p className="inspector-note">Without keyframes, Speed changes the whole clip and its duration. Add a diamond, move the playhead, then change Speed to create a ramp within the clip.</p><div className="inspector-checks">{[['reverse','Reverse'],['freeze','Freeze frame']].map(([key,label])=><label data-cursor-anchor={key} key={key}><input type="checkbox" checked={Boolean(selected.properties[key])} onChange={e=>s().updateProperty(selected.id,key,e.target.checked)}/>{label}</label>)}</div></Section>}
      </>}
      {tab==='Audio'&&<><Section title="Clip audio" icon={<Volume2 size={12}/>}><Property name="gain" label="Gain" initial={0} min={-60} max={12} step={.5} suffix="dB"/><Property name="pan" label="Pan" initial={0} min={-100} max={100}/><Property name="audioFadeIn" label="Audio fade in" min={0} max={selected.duration} step={1/(asset?.fps||24)} suffix="s"/><Property name="audioFadeOut" label="Audio fade out" min={0} max={selected.duration} step={1/(asset?.fps||24)} suffix="s"/><NormalizeControl clip={selected} loudness={(asset as {loudness?:number}|undefined)?.loudness}/></Section><div className="inspector-audio-preview"><Volume2 size={28}/><p>Shape your sound in the Audio workspace.</p><button className="button button-secondary" onClick={()=>s().setWorkspace('audio')}>Open mixer</button></div></>}
      {tab==='Effects'&&<>
        {selected.effects.length===0?<p className="inspector-note">No effects added to this clip yet.</p>:selected.effects.map((effect,index)=><details className={`effect-stack ${effectEnabled(selected,effect)?'':'is-off'}`} key={effect.id} open>
          <summary data-cursor-anchor={`effect-${effect.id}`} className="effect-stack-item"><ChevronDown size={12}/><span>{effect.name}</span></summary>
          <div data-cursor-anchor={`effect-controls-${effect.id}`} className="effect-stack-controls"><label><input type="checkbox" aria-label={`Enable ${effect.name}`} checked={effectEnabled(selected,effect)} onChange={e=>s().updateEffect(selected.id,effect.id,{enabled:e.target.checked})}/>Enabled</label><span className="spacer"/>
            <IconButton label={`Move ${effect.name} up`} disabled={index===0} onClick={()=>s().reorderEffect(selected.id,effect.id,-1)}><ArrowUp size={12}/></IconButton><IconButton label={`Move ${effect.name} down`} disabled={index===selected.effects.length-1} onClick={()=>s().reorderEffect(selected.id,effect.id,1)}><ArrowDown size={12}/></IconButton>
            <IconButton label={`Reset ${effect.name}`} onClick={()=>s().updateEffect(selected.id,effect.id,{amount:initialAmount(effect.name),parameters:Object.fromEntries((effectDefinitions[effect.name]?.parameters??[]).filter(p=>p.key!=='amount').map(p=>[p.key,p.initial]))})}><RotateCcw size={12}/></IconButton>
            <IconButton label={`Delete ${effect.name}`} onClick={()=>s().updateEffect(selected.id,effect.id,null)}><Trash2 size={12}/></IconButton>
          </div><p className="inspector-note">{effectDefinitions[effect.name]?.description}</p>
          {effect.name==='Smart Mask'&&<SmartMaskInspector clip={selected} maskId={effect.maskId} targetId={effect.id}/>}
          {effect.name==='Stabilize'&&<StabilizeStatus clipId={selected.id} lock={effect.parameters?.lock??0}/>}
          {effect.name==='Depth'?<DepthInspector clip={selected} effect={effect}/>:(effectDefinitions[effect.name]?.parameters??[]).map(p=><Property key={p.key} effectId={effect.id} name={p.key} label={p.label} initial={p.initial} min={p.min} max={p.max} step={p.step} suffix={p.suffix}/>)}
          {effect.name==='Noise Reduction'&&<p className="inspector-note">Temporal picture smoothing is applied during export. Audio preview uses a noise gate.</p>}
        </details>)}<label className="form-field effect-add"><span>Add an effect</span><select data-cursor-anchor="add-effect" aria-label="Add clip effect" defaultValue="" onChange={e=>{if(e.target.value)s().addEffect(selected.id,e.target.value);e.target.value='';}}><option value="">Choose effect…</option>{Object.keys(effectDefinitions).filter(name=>acceptsEffect(selected,asset?.kind,name)).map(name=><option key={name}>{name}</option>)}</select></label></>}
      {tab==='Info'&&<Section title="Source metadata" icon={<Info size={12}/>}><dl className="metadata-list"><dt>File</dt><dd>{asset?.name}</dd><dt>Media ID</dt><dd className="mono">{selected.mediaId}</dd><dt>Duration</dt><dd>{durationLabel(selected.duration)}</dd><dt>Resolution</dt><dd>{asset?.resolution}</dd><dt>Frame rate</dt><dd>{fpsLabel(asset?.fps)} fps</dd><dt>Camera</dt><dd>{asset?.camera??'Camera original'}</dd><dt>Proxy</dt><dd className="accent-text">{asset?.status==='ready'?'Ready · linked':asset?.status}</dd></dl></Section>}
    </div></>}
  </section>;
}
