import SmartMaskInspector from '../components/SmartMaskInspector';
import { DepthKeyInspector } from '../components/DepthInspector';
import NoiseReductionInspector from '../components/NoiseReductionInspector';
import { acceptsEffect, effectEnabled } from '../services/effects';
import { isDepthKey } from '../services/smartMask';
import { isAdjustment } from '../services/adjustment';
import { adjacentShot } from '../services/selection';
import {memo,useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type PointerEvent,type ReactNode} from 'react';
import {Plus,RotateCcw,Trash2,ChevronUp,ChevronDown,Power,Search,PanelRightClose,PanelRightOpen,Sparkles,GitBranch,SlidersHorizontal,Spline,ArrowRightLeft,Layers2,Wand2,Ungroup,Images,Maximize2,Minimize2,X,Pipette,CircleDashed,Blend,Film,Palette,Aperture} from 'lucide-react';
import {createId} from '../services';
import {useEditorStore,usePanelPlayhead,usePausedPlayhead,useStoreWithoutPlayhead} from '../state/store';
import {onPicture} from '../components/LiveTimecode';
import type {Clip,ColorEffect,ColorTransformEffect,GradeNode} from '../state/models';
import {profiles,gamuts,interpretation,primaryDefaults,rangeDefaults,defaultCST,parseCube,processingStages,acesOutputUpgrade} from '../services/color';
import {assistantCapabilities,type AssistantCapabilities} from '../services/colorAssistantClient';
import ColorAssistantPanel from '../components/ColorAssistantPanel';
import ColorGroupsPanel from '../components/ColorGroupsPanel';
import NormalizeDialog,{normalizable,useNormalize} from '../components/NormalizeDialog';
import {colorGroupOf,colorGroups,groupColor} from '../services/colorGroups';
import {evaluateNodes} from '../services/animation';
import {PARAM} from '../services/grading';
import {Button,ContextMenu,EmptyState,IconButton,timecode} from '../components/ui';
import Viewer from '../components/Viewer';
import {ColorNodes,type NodeKind} from './ColorNodes';
import {Parameter,ScopeDisplay,WHEEL_RING,scopes,type Scope} from './ColorTools';
import {CurvesPanel,FilmPanel,LooksLibrary,MixerPanel,PrimariesPanel,type CurveKind} from './ColorPanels';
import {QualifierPanel} from './ColorQualifier';
import {WindowsPanel} from './ColorWindows';
import {COLOR_TOOLS,useColorUi,type ColorTool} from './colorUi';
import {CameraRawPanel} from './CameraRaw';
import './workspaces.css';
import './color.css';
const presets=[
  ['Sony S-Log3 / S-Gamut3.Cine','S-Log3','S-Gamut3.Cine'],['Sony S-Log3 / S-Gamut3','S-Log3','S-Gamut3'],['Sony S-Log2 / S-Gamut','S-Log2','S-Gamut'],['Sony S-Log / S-Gamut','S-Log','S-Gamut'],
  ['Canon R6 / R6 II · C-Log3 / Cinema Gamut','Canon Log 3','Cinema Gamut'],['Canon R6 / R6 II · C-Log3 / BT.2020','Canon Log 3','Rec.2020'],['Canon R6 / R6 II · C-Log3 / BT.709','Canon Log 3','Rec.709'],['Canon R6 · C-Log / BT.709','Canon Log','Rec.709'],['Canon R6 · C-Log / BT.2020','Canon Log','Rec.2020'],['iPhone 15 Pro and later · Apple Log / BT.2020','Apple Log','Rec.2020'],['DaVinci Wide Gamut / Intermediate','DaVinci Intermediate','DaVinci Wide Gamut'],['Rec.709 / Gamma 2.4','Gamma 2.4','Rec.709'],
];
function ColorSelect({label,value,options,change}:{label:string;value:string;options:readonly string[];change:(v:string)=>void}){return <label className="color-select"><span>{label}</span><select aria-label={label} value={value} onChange={e=>change(e.target.value)}>{options.map(p=><option key={p} value={p}>{p==='Rec.709'&&options===profiles?'Rec.709 (legacy Gamma 2.4)':p==='none'?'None':p==='aces2'?'ACES 2 · SDR 100 nits':p==='shoulder'?'Legacy SDR shoulder':p==='compress'?'Saturation compression':p}</option>)}</select></label>;}
function CSTSettings({effect,change}:{effect:ColorTransformEffect;change:(e:ColorEffect)=>void}){
  const patch=(p:Partial<ColorTransformEffect>)=>change({...effect,...p});
  return <div className="cst-settings"><label className="color-select"><span>Input preset</span><select aria-label="CST input preset" value="" onChange={e=>{const p=presets[Number(e.target.value)];patch({inputGamma:p[1],inputGamut:p[2]});}}><option value="" disabled>Choose camera / working space…</option>{presets.map((p,i)=><option key={p[0]} value={i}>{p[0]}</option>)}</select></label>
    <ColorSelect label="Input Color Space" value={effect.inputGamut} options={gamuts} change={inputGamut=>patch({inputGamut})}/><ColorSelect label="Input Gamma" value={effect.inputGamma} options={profiles} change={inputGamma=>patch({inputGamma})}/>
    {effect.inputGamut==='S-Gamut'&&<small>Nominal D65 S-Gamut. Camera-specific 3200K/4300K matrices require a matching camera LUT.</small>}<div className="cst-divider"><ArrowRightLeft size={13}/><button onClick={()=>patch({inputGamma:effect.outputGamma,inputGamut:effect.outputGamut,outputGamma:effect.inputGamma,outputGamut:effect.inputGamut})}>Swap input / output</button></div>
    <ColorSelect label="Output Color Space" value={effect.outputGamut} options={gamuts} change={outputGamut=>patch({outputGamut,...(effect.toneMapping==='aces2'&&outputGamut!=='Rec.709'?{toneMapping:'none' as const}:{})})}/><ColorSelect label="Output Gamma" value={effect.outputGamma} options={profiles} change={outputGamma=>patch({outputGamma,...(effect.toneMapping==='aces2'&&outputGamma!=='Gamma 2.4'?{toneMapping:'none' as const}:{})})}/>
    <details open><summary>Tone mapping</summary><ColorSelect label="Tone Mapping Method" value={effect.toneMapping} options={['none','aces2','shoulder']} change={toneMapping=>patch(toneMapping==='aces2'?{toneMapping:'aces2',outputGamma:'Gamma 2.4',outputGamut:'Rec.709',gamutMapping:'none'}:{toneMapping:toneMapping as 'none'})}/><small>{effect.toneMapping==='aces2'?'OpenColorIO / ACES 2; includes tone and gamut rendering.':effect.toneMapping==='shoulder'?'SDR shoulder rolls bright highlights into display range.':'Technical conversion; highlights remain available downstream.'}</small></details>
    <details open><summary>Gamut mapping</summary><ColorSelect label="Gamut Mapping Method" value={effect.gamutMapping} options={effect.toneMapping==='aces2'?['none']:['none','compress']} change={gamutMapping=>patch({gamutMapping:gamutMapping as 'none'})}/><small>{effect.gamutMapping==='compress'?'Compresses out-of-gamut colors toward neutral for SDR output.':'Keeps the transformed gamut until a later output stage.'}</small></details>
  </div>;
}
// The scrub bar is this workspace's transport readout. Paused, React places it; playing, it follows each presented picture
// directly: a render per store tick re-laid-out the page at the display's rate, twice or more per picture. Memoized, so the
// workspace's quarter-second steps leave it alone.
const ColorScrub=memo(function ColorScrub({clip,fps}:{clip?:Clip;fps:number}){
  const paused=usePausedPlayhead(),playing=paused<0,following=useEditorStore(s=>s.liveMode==='following'),s=useEditorStore.getState;
  // A render while playing (a new shot) takes the live playhead, so the bar never steps back to where playback started.
  const playhead=playing?s().playhead:paused,start=clip?.start??0,input=useRef<HTMLInputElement>(null),time=useRef<HTMLSpanElement>(null);
  // Playing, the timecode is written here; keyed on `playing`, the span is a fresh one on pause, so React never diffs against it.
  useLayoutEffect(()=>{if(!playing)return;let shown='';return onPicture(p=>{const text=timecode(Math.max(0,p-start),fps);if(text===shown)return;shown=text;if(input.current)input.current.value=String(p);if(time.current)time.current.textContent=text;});},[playing,start,fps]);
  return <div className="color-scrub"><span className="scrub-clip-name" title={clip?.name}>{clip?.name??'No clip selected'}</span><input ref={input} type="range" aria-label="Scrub color footage" aria-valuetext={timecode(playhead,fps)} disabled={!clip||following} min={start} max={Math.max(start,start+(clip?.duration??0)-1/fps)} step={1/fps} value={playhead} onPointerDown={()=>s().setPlaying(false)} onChange={e=>{s().setPlaying(false);s().setPlayhead(Number(e.target.value));}}/><span ref={time} key={String(playing)} className="mono">{timecode(Math.max(0,playhead-start),fps)}</span></div>;
});
// Noise Reduction cleans the camera original before the grade, so it sits above Source & workflow. It is the clip's one effect,
// the same the Inspector edits; adding it here stays on the Color page.
function NoiseSettings({clip,kind}:{clip:Clip;kind?:string}){
  const s=useEditorStore.getState,effect=clip.effects.find(e=>e.name==='Noise Reduction');
  if(!effect&&!acceptsEffect(clip,kind,'Noise Reduction'))return null;
  const on=!!effect&&effectEnabled(clip,effect);
  return <details className="source-settings noise-settings" open={!!effect}><summary>Noise Reduction{effect&&<span className={`noise-state ${on?'on':''}`}>{on?'On':'Off'}</span>}</summary>
    {effect?<section className={`node-effect ${on?'':'bypassed'}`}><div className="effect-heading"><IconButton label={on?'Bypass Noise Reduction':'Turn on Noise Reduction'} aria-pressed={on} onClick={()=>s().updateEffect(clip.id,effect.id,{enabled:!on})}><Power size={14}/></IconButton><strong>Camera original · before the grade</strong><IconButton label="Remove Noise Reduction" onClick={()=>s().updateEffect(clip.id,effect.id,null)}><Trash2 size={13}/></IconButton></div><NoiseReductionInspector clip={clip} effect={effect}/></section>
      :<><p>Removes sensor noise from the camera original before the grade, measured for this camera. The Inspector shows the same effect.</p><Button onClick={()=>s().addEffect(clip.id,'Noise Reduction',false)}><Plus size={13}/>Add Noise Reduction</Button></>}
  </details>;
}
const timelineShots=(s:Pick<ReturnType<typeof useEditorStore.getState>,'clips'|'tracks'|'media'|'timelineId'>)=>s.clips.filter(c=>c.timelineId===s.timelineId&&s.tracks.find(t=>t.id===c.trackId)?.kind==='video'&&(isAdjustment(c)||s.media.some(m=>m.id===c.mediaId))).sort((a,b)=>a.start-b.start);
// The viewer's Next/Previous edit step shot to shot and show that shot's grade. Module-level, so the memoized viewer keeps its props.
const stepShot=(direction:number)=>{const s=useEditorStore.getState(),shot=adjacentShot(timelineShots(s),s.tracks,s.playhead,direction,s.projects.find(p=>p.id===s.projectId)?.fps||24);if(shot){s.selectClip(shot.id);s.setPlayhead(shot.start);}};
// A mood-board picture (Plan → Board → Compare on Color page) to match the grade by eye. Not the viewer's 'Compare reference',
// which is the ungraded shot. Memoized with its own selector: the workspace re-renders on nearly every store change.
const ColorReference=memo(function ColorReference(){
  const asset=useEditorStore(s=>s.colorReference?s.media.find(m=>m.id===s.colorReference&&m.projectId===s.projectId&&(m.kind==='image'||m.kind==='video')):undefined),[large,setLarge]=useState(false);
  if(!asset)return null;
  const src=(asset.kind==='image'&&asset.proxyUrl)||asset.thumbnail;
  return <aside className={`color-reference${large?' large':''}`} aria-label="Mood board reference picture"><header><Images size={12}/><span title={asset.name}>Reference</span><span className="spacer"/><IconButton label={large?'Smaller reference':'Larger reference'} onClick={()=>setLarge(!large)}>{large?<Minimize2 size={12}/>:<Maximize2 size={12}/>}</IconButton><IconButton label="Close reference picture" onClick={()=>useEditorStore.getState().setColorReference(null)}><X size={13}/></IconButton></header>{src?<img src={src} alt={asset.name} title={asset.name} draggable={false}/>:<p>Preparing the picture…</p>}</aside>;
});
const TOOL_ICONS:Record<ColorTool,ReactNode>={'Camera Raw':<Aperture size={14}/>,Primaries:<SlidersHorizontal size={14}/>,Curves:<Spline size={14}/>,Qualifier:<Pipette size={14}/>,Windows:<CircleDashed size={14}/>,Mixer:<Blend size={14}/>,Film:<Film size={14}/>};
const TOOL_HINTS:Record<ColorTool,string>={'Camera Raw':'Blackmagic RAW decode: ISO, white balance, exposure, gamma and gamut, as in DaVinci Resolve',Primaries:'Wheels, exposure, white balance, contrast and saturation',Curves:'Custom curves, and hue, saturation and luma curves',Qualifier:'Grade one range of colours (HSL key)',Windows:'Grade inside or outside a circle, rectangle or gradient',Mixer:'RGB mixer and black and white',Film:'Halation, bloom, grain, vignette, gate weave and breath'};
/** New Node's kinds: starting parameters (over the primaries defaults) and the tool each one opens. */
const NODE_KINDS:Record<NodeKind,[Record<string,number>,ColorTool|null]>={Correction:[{},null],Window:[{circOn:1},'Windows'],Qualifier:[{qualOn:1,qualHueWidth:40},'Qualifier'],Film:[{filmGrain:20,filmHalation:15,filmVignette:10},'Film']};
// The tool area's height is this browser's own (a laptop and a desktop want different splits), so it lives in localStorage.
const TOOLS_KEY='frameline.colorToolsHeight';
const storedTools=()=>{try{const v=Number(localStorage.getItem(TOOLS_KEY));return v>=140&&v<=4000?v:null;}catch{return null;}};
const storeTools=(v:number|null)=>{try{if(v===null)localStorage.removeItem(TOOLS_KEY);else localStorage.setItem(TOOLS_KEY,String(v));}catch{/* storage blocked: the height is not remembered */}};
/** A node that grades (no enabled colour-space transform): where tools and looks belong. */
const gradingNode=(n:GradeNode)=>!n.effects?.some(e=>e.enabled&&e.type==='cst');
export default function ColorWorkspace(){
  // Shot choice and animated grades follow the playhead in quarter-second steps while playing, not every frame.
  const s={...useStoreWithoutPlayhead(),playhead:usePanelPlayhead()},gesture=useRef<string|undefined>(undefined),field=useRef<string|undefined>(undefined),fileInput=useRef<HTMLInputElement>(null),fileTarget=useRef<string>(''),root=useRef<HTMLDivElement>(null),bottom=useRef<HTMLDivElement>(null);
  const tool=useColorUi(u=>u.tool),chooseTool=(t:ColorTool)=>useColorUi.setState({tool:t,picking:false});
  const [scope,setScope]=useState<Scope>('RGB Parade'),[rightTab,setRightTab]=useState<'Library'|'Settings'|'Groups'|'Assistant'>('Settings'),[rightOpen,setRightOpen]=useState(false),[search,setSearch]=useState('');
  const [log,setLog]=useState(false),[curveKind,setCurveKind]=useState<CurveKind>('Custom'),[toolsHeight,setToolsHeight]=useState(storedTools);
  const [shotMenu,setShotMenu]=useState<{id:string;x:number;y:number}|null>(null),[assistant,setAssistant]=useState<AssistantCapabilities|null>(null),[normalizing,setNormalizing]=useState<{ids:string[];group?:string}|null>(null);
  useEffect(()=>{let live=true;void assistantCapabilities().then(c=>{if(live)setAssistant(c);});return()=>{live=false;};},[]);
  const [precision,setPrecision]=useState('Decoding source…');
  useEffect(()=>{const update=()=>setPrecision(document.querySelector<HTMLCanvasElement>('.viewer-frame canvas')?.dataset.colorPrecision??'8-bit RGB fallback');window.addEventListener('frameline:frame',update);return()=>window.removeEventListener('frameline:frame',update);},[]);
  const [rightWidth,setRightWidth]=useState(290),[scopeWidth,setScopeWidth]=useState(320);
  const resize=useRef<{kind:'inspector'|'scopes'|'tools';x:number;y:number;value:number}|null>(null);
  const shots=timelineShots(s);
  const visible=shots.filter(c=>c.start<=s.playhead&&c.start+c.duration>s.playhead&&!c.disabled&&!s.tracks.find(t=>t.id===c.trackId)?.hidden);
  const active=visible.find(c=>c.id===s.selectedClipId)||visible.sort((a,b)=>(s.tracks.find(t=>t.id===b.trackId)?.number??0)-(s.tracks.find(t=>t.id===a.trackId)?.number??0))[0];
  const clip=active||shots.find(c=>c.id===s.selectedClipId)||shots[0],asset=s.media.find(m=>m.id===clip?.mediaId),source=clip?interpretation(clip,asset):{profile:'Rec.709',gamut:'Rec.709'};
  // With no node picked on this shot, the tools work on its first grading node, not on the Input CST (a camera conversion).
  const nodes=s.nodes.filter(n=>n.clipId===clip?.id).sort((a,b)=>(a.order??0)-(b.order??0)),stored=nodes.find(n=>n.id===s.selectedNodeId)||nodes.find(gradingNode)||nodes[0];
  const evaluated=stored&&clip?evaluateNodes([stored],clip,s.playhead)[0]:stored;
  const node=evaluated?{...evaluated,parameters:Object.fromEntries(Object.entries(evaluated.parameters).map(([k,v])=>[k.toLowerCase() in primaryDefaults?k.toLowerCase():k,v]))}:undefined;
  const managed=clip?.properties.colorPipeline==='nodes-v2',imported=Boolean(clip?.properties.resolveLookUrl)&&!managed;
  const inputCST=managed?nodes.filter(n=>n.enabled).flatMap(n=>n.effects??[]).find(e=>e.enabled&&e.type==='cst'):undefined;
  const legacyOutput=clip&&acesOutputUpgrade(clip,s.nodes);
  const defaults:Record<string,number>={...primaryDefaults,pivot:managed?.336043:.5};
  // Moving within a multi-selection keeps it; landing on any other shot selects just that one.
  useEffect(()=>{if(active&&s.selectedClipId!==active.id)s.selectClips(s.selectedClipIds.includes(active.id)?[...s.selectedClipIds.filter(id=>id!==active.id),active.id]:[active.id]);},[active?.id]);
  const update=(p:Record<string,number>)=>{if(node)s.updateNode(node.id,{parameters:Object.fromEntries(Object.entries(p).map(([k,v])=>[Object.keys(stored.parameters).find(key=>key.toLowerCase()===k.toLowerCase())||k,v]))},gesture.current);};
  const patchNode=(patch:Partial<GradeNode>)=>{if(node)s.updateNode(node.id,patch,gesture.current);};
  const property=(key:string,value:string|number|boolean)=>{if(clip)s.updateProperty(clip.id,key,value,gesture.current);};
  const add=(kind:NodeKind='Correction')=>{if(!clip)return;if(s.selectedClipId!==clip.id)s.selectClip(clip.id);const [extra,opens]=NODE_KINDS[kind];s.addNode(kind,{...defaults,...extra});if(opens)chooseTool(opens);};
  // A look goes on the selected node; a shot without nodes gets a Look node for it first. Returns the node it went on.
  const applyLook=(lookId:string,strength:number)=>{
    // Never inside a colour-space conversion: a CST node hands the look to the Look node (or the first grading node).
    if(!clip)return;let target=node&&gradingNode(node)?node.id:(nodes.find(n=>n.name==='Look'&&gradingNode(n))??nodes.find(gradingNode))?.id;
    if(!target){if(s.selectedClipId!==clip.id)s.selectClip(clip.id);s.addNode('Look',{...defaults});target=useEditorStore.getState().selectedNodeId??undefined;if(!target||!useEditorStore.getState().nodes.some(n=>n.id===target&&n.clipId===clip.id))return;}
    useEditorStore.getState().applyColorLook(target,lookId,strength);return target;
  };
  const neutral=(k:string)=>defaults[k]??PARAM[k]?.initial??rangeDefaults[k]??({curve25:.25,curve50:.5,curve75:.75} as Record<string,number>)[k]??0;
  const addEffect=(id:string,type:string)=>{
    if(type==='smart-mask'){if(clip?.smartMasks?.length)s.attachSmartMask(clip.id,clip.smartMasks[0].id,id);else s.addSmartMask(clip!.id,id);setRightTab('Settings');setRightOpen(true);return;}
    // Grade only the background by default: the farther half of the shot, eased in over a tenth of the scale.
    if(type==='depth-key'){if(!s.nodes.some(n=>n.id===id))return;s.selectNode(id);s.updateNode(id,{mask:{source:'depth',enabled:true,invert:false,amount:100,near:50,far:100,softness:10}});setRightTab('Settings');setRightOpen(true);return;}
    if(!['cst','lut'].includes(type))return;const n=s.nodes.find(n=>n.id===id);if(!n)return;s.selectNode(id);setRightTab('Settings');setRightOpen(true);
    if(type==='lut'){fileTarget.current=id;fileInput.current?.click();return;}
    let inputGamma=managed?source.profile:'Gamma 2.4',inputGamut=managed?source.gamut:'Rec.709';
    for(const stage of processingStages(clip!,nodes)){if(stage.type==='correction'&&stage.node.id===id)break;if(stage.type==='cst'){inputGamma=stage.effect.outputGamma;inputGamut=stage.effect.outputGamut;}}
    for(const e of n.effects??[])if(e.enabled&&e.type==='cst'){inputGamma=e.outputGamma;inputGamut=e.outputGamut;}
    s.updateNode(id,{effects:[...(n.effects??[]),defaultCST(createId('fx'),inputGamma,inputGamut,inputGamma,inputGamut)]});
  };
  const changeEffect=(effect:ColorEffect)=>patchNode({effects:(node?.effects??[]).map(e=>e.id===effect.id?effect:e)});
  // Ctrl/Cmd-click toggles a shot, Shift-click takes the range from the shown shot; the shown shot and its selected node stay.
  const pick=(id:string,range:boolean)=>{if(!clip)return choose(id);const from=shots.findIndex(c=>c.id===clip.id),to=shots.findIndex(c=>c.id===id),base=s.selectedClipIds.filter(x=>x!==clip.id&&shots.some(c=>c.id===x));
    const ids=range?shots.slice(Math.min(from,to),Math.max(from,to)+1).map(c=>c.id).filter(x=>x!==clip.id):id===clip.id?base:base.includes(id)?base.filter(x=>x!==id):[...base,id];s.selectClips([...ids,clip.id]);s.selectNode(node?.id??null);};
  const choose=(id:string)=>{s.setPlaying(false);s.selectClip(id);const shot=shots.find(c=>c.id===id)!;const fps=s.projects.find(p=>p.id===s.projectId)?.fps||24;s.setPlayhead(shot.start+Math.floor(Math.round(shot.duration*fps)/2)/fps);};
  const startResize=(e:PointerEvent<HTMLDivElement>,kind:'inspector'|'scopes'|'tools',value:number)=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);resize.current={kind,x:e.clientX,y:e.clientY,value};};
  const separator=(kind:'inspector'|'scopes',value:number)=><div role="separator" tabIndex={0} aria-label={`Resize ${kind}`} aria-orientation="vertical" className="color-resizer" onPointerDown={e=>startResize(e,kind,value)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const next=value+(['ArrowLeft','ArrowUp'].includes(e.key)?10:-10);if(kind==='inspector')setRightWidth(Math.max(260,Math.min(460,next)));else setScopeWidth(Math.max(220,Math.min(480,next)));}}/>;
  // The top keeps room for the viewer and nodes; the tools keep room for one row of controls.
  const toolsLimit=(v:number)=>Math.round(Math.max(150,Math.min((root.current?.clientHeight??800)-250,v)));
  const resizeTools=(v:number|null)=>{const next=v===null?null:toolsLimit(v);setToolsHeight(next);storeTools(next);};
  const fps=s.projects.find(p=>p.id===s.projectId)?.fps||24;
  const thumb=String(clip?.properties.resolveReferenceUrl||asset?.thumbnail||'');
  const groups=colorGroups(s.clips.filter(c=>c.projectId===s.projectId),s.nodes),groupOf=(c?:Clip)=>groups.find(g=>g.id===colorGroupOf(c)),groupSize=node?.group?s.nodes.filter(n=>n.group===node.group).length:0;
  // Auto balance: Normalize without touching group membership. The rest of a shot's group is measured too, so the group stays level.
  const balance=useNormalize('Auto balance cancelled: leaving the Color page stops it'),picked=shots.filter(c=>s.selectedClipIds.includes(c.id)),targets=(picked.length?picked:clip?[clip]:[]).filter(c=>normalizable(c,s.media));
  useEffect(()=>{if(balance.error)s.notify('Auto balance failed','error',balance.error);},[balance.error]);
  // The server measures at most 200 shots a run (server/colorNormalize.ts); more is refused, never cut short.
  const tooMany=targets.length>200,autoBalance=()=>{if(balance.busy)return balance.cancel();if(tooMany)return;const ids=targets.map(c=>c.id),inGroups=new Set(targets.map(colorGroupOf)),contextIds=groups.filter(g=>inGroups.has(g.id)).flatMap(g=>g.clipIds).filter(id=>!ids.includes(id)).slice(0,300-ids.length);
    void balance.start({clipIds:ids,...(contextIds.length?{contextIds}:{})},job=>{const st=useEditorStore.getState();if(job.result)st.normalizeColorGroup(job.result);
      if(job.skipped.length)st.notify(`Skipped ${job.skipped.length} shot${job.skipped.length===1?'':'s'}`,'info',job.skipped.map(k=>`${st.clips.find(c=>c.id===k.clipId)?.name??'Removed shot'}: ${k.text}`).join(' · '));});};
  const autoButton=<Button className="auto-balance" disabled={!balance.busy&&(!targets.length||tooMany)} title={balance.busy?'Cancel auto balance':tooMany?'Pick at most 200 shots for Auto balance':!targets.length?'Pick a video shot':balance.where?.available===false?balance.where.reason:`Set exposure, white balance and black level of ${targets.length===1?'this shot':`${targets.length} shots`} automatically${balance.where?.remote?' on sharedcut.com':''}`} onClick={autoBalance}><Wand2 size={13}/><span>{balance.busy?`Balancing… ${Math.round(balance.job?.progress??0)}%`:'Auto balance'}</span></Button>;
  const nodeIndex=node?nodes.findIndex(n=>n.id===node.id)+1:0;
  const toolBody=tool==='Camera Raw'&&asset?.braw?<CameraRawPanel key={asset.id} asset={asset}/>:!node||!clip?<EmptyState icon={<Palette size={22}/>} title="Shape this shot" description="Start a wide-gamut grade or add a correction node." action={<div className="empty-actions"><Button disabled={!clip} onClick={()=>s.initializeColorGrade(clip!.id)}>Start wide-gamut grade</Button><Button disabled={!clip} onClick={()=>add()}>Add correction</Button>{autoButton}</div>}/>
    :tool==='Primaries'||tool==='Camera Raw'?<PrimariesPanel node={node} update={update} log={log} pivot={defaults.pivot}/>
    :tool==='Curves'?<CurvesPanel node={node} kind={curveKind} setKind={setCurveKind} update={curves=>patchNode({curves})}/>
    :tool==='Qualifier'?<QualifierPanel node={node} clip={clip} update={update}/>
    :tool==='Windows'?<WindowsPanel node={node} clip={clip} update={update}/>
    :tool==='Mixer'?<MixerPanel node={node} update={update}/>:<FilmPanel node={node} update={update}/>;
  return <div ref={root} className={`color-workspace color-overhaul ${rightOpen?'':'inspector-closed'}`} style={{'--color-inspector':`${rightWidth}px`,'--color-scopes':`${scopeWidth}px`,'--wheel-ring':WHEEL_RING,...(toolsHeight?{'--color-tools':`${toolsHeight}px`}:{})}as CSSProperties}
    onPointerDownCapture={e=>{if((e.target as Element).closest('input[type=range],.color-wheel,.curve-editor,[data-grade-gesture]'))gesture.current=createId('grade');}}
    onPointerUp={e=>{const r=resize.current;if(r?.kind==='tools'&&Math.abs(e.clientY-r.y)>1)resizeTools(r.value-(e.clientY-r.y));gesture.current=undefined;resize.current=null;}} onPointerCancel={()=>{gesture.current=undefined;resize.current=null;}}
    onFocusCapture={e=>{if((e.target as Element).matches('input[inputmode=decimal]'))gesture.current=field.current=createId('grade');}}
    // A number field's gesture lasts while it has focus; a drag's lasts until pointer up. A wheel or node card losing focus to
    // the slider being pressed must not end the drag's gesture, or one drag becomes many undo steps. A field that loses focus
    // ends only the gesture it started: pressing a slider in a <label> blurs the field after the drag's gesture began.
    onBlurCapture={e=>{if((e.target as Element).matches('input[inputmode=decimal]')&&gesture.current===field.current)gesture.current=undefined;}}
    onKeyDownCapture={e=>{if((e.target as Element).closest('input[inputmode=decimal],input[type=range]')&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.stopPropagation();gesture.current=undefined;s.undo();}}}
    onPointerMove={e=>{const r=resize.current;if(!r)return;if(r.kind==='tools')setToolsHeight(toolsLimit(r.value-(e.clientY-r.y)));else if(r.kind==='inspector')setRightWidth(Math.max(260,Math.min(460,r.value+r.x-e.clientX)));else setScopeWidth(Math.max(220,Math.min(480,r.value+r.x-e.clientX)));}}>
    <input hidden type="file" accept=".cube" ref={fileInput} onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;const id=fileTarget.current;try{if(file.size>32*1024*1024)throw Error('Use a LUT smaller than 32 MB.');const cube=parseCube(await file.text()),state=useEditorStore.getState(),n=state.nodes.find(n=>n.id===id);if(!n)return;state.updateNode(id,{effects:[...(n.effects??[]),{id:createId('lut'),type:'lut',enabled:true,name:file.name.slice(0,100),amount:1,inputGamma:managed?'DaVinci Intermediate':'Gamma 2.4',inputGamut:managed?'DaVinci Wide Gamut':'Rec.709',cube:{...cube,data:Array.from(cube.data)}}]});}catch(error){s.notify((error as Error).message,'error');}}}/>
    <main className="color-main"><div className="color-viewer"><Viewer compact colorAccurate onNavigateEdit={stepShot}/><ColorScrub clip={clip} fps={fps}/><ColorReference/></div><ColorNodes key={clip?.id} nodes={nodes} clipId={clip?.id} selected={node?.id} thumbnail={thumb} onAdd={add} onEffect={addEffect} toolbar={<><Button className="assistant-open" aria-pressed={rightOpen&&rightTab==='Assistant'} title="Color Assistant: three looks for your shots" onClick={()=>{setRightOpen(!(rightOpen&&rightTab==='Assistant'));setRightTab('Assistant');}}><Sparkles size={13}/><span>Assistant</span></Button><IconButton label={rightOpen?'Hide effects panel':'Show effects panel'} onClick={()=>setRightOpen(!rightOpen)}>{rightOpen?<PanelRightClose size={16}/>:<PanelRightOpen size={16}/>}</IconButton></>}/>
    <section className="panel shot-browser"><div className="shot-strip-label"><Layers2 size={15}/><span>{shots.length} shots</span></div><div className="shot-browser-list">{shots.map((shot,i)=>{const m=s.media.find(m=>m.id===shot.mediaId);return <button key={shot.id} aria-pressed={clip?.id===shot.id||s.selectedClipIds.includes(shot.id)} className={`shot-card ${clip?.id===shot.id?'selected':s.selectedClipIds.includes(shot.id)?'picked':''}`} onClick={e=>{setShotMenu(null);if(e.ctrlKey||e.metaKey||e.shiftKey)pick(shot.id,e.shiftKey);else choose(shot.id);}} onContextMenu={e=>{e.preventDefault();if(!s.selectedClipIds.includes(shot.id))choose(shot.id);setShotMenu({id:shot.id,x:e.clientX,y:e.clientY});}} aria-label={`Shot ${i+1}: ${shot.name}${groupOf(shot)?`, group ${groupOf(shot)!.name}`:''}`}><div className="shot-image">{groupOf(shot)&&<i className="shot-group" style={{background:groupOf(shot)!.color}} title={groupOf(shot)!.name}/>}{isAdjustment(shot)?<SlidersHorizontal size={22} aria-hidden/>:<img src={String(shot.properties.resolveReferenceUrl||m?.thumbnail||'')} alt=""/>}<span>{String(i+1).padStart(2,'0')}</span></div><span>{shot.name}</span></button>;})}</div></section></main>
    <div role="separator" tabIndex={0} aria-label="Resize tool area" aria-orientation="horizontal" title="Drag to resize the tools · Double-click for the default height" className="color-row-resizer"
      onPointerDown={e=>startResize(e,'tools',bottom.current?.offsetHeight??300)} onDoubleClick={()=>resizeTools(null)} onKeyDown={e=>{if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return;e.preventDefault();resizeTools((bottom.current?.offsetHeight??300)+(e.key==='ArrowUp'?16:-16));}}/>
    <div ref={bottom} className="color-bottom"><section className="panel grade-controls" data-cursor-clip={clip?.id} data-cursor-context={node?.id}>
      <div className="panel-header tool-header"><div className="color-tabs tool-tabs" aria-label="Color tools">{(asset?.braw?['Camera Raw' as const,...COLOR_TOOLS]:COLOR_TOOLS).map(t=><button key={t} aria-pressed={tool===t} title={TOOL_HINTS[t]} onClick={()=>chooseTool(t)}>{TOOL_ICONS[t]}<span>{t}</span></button>)}</div>
        {node&&tool==='Primaries'&&<div className="segmented" role="group" aria-label="Wheel mode" title="Primary wheels work on the whole tonal range; Log wheels work on separate shadow, midtone and highlight ranges"><button aria-pressed={!log} onClick={()=>setLog(false)}>Primary</button><button aria-pressed={log} onClick={()=>setLog(true)}>Log</button></div>}
        <span className="spacer"/>
        {node&&<>{!managed&&<Button className="start-grade" onClick={()=>s.initializeColorGrade(clip!.id)} title="Rebuild this shot as Input CST, Balance, Look and Output CST nodes (a snapshot keeps the current grade)">Start wide-gamut grade</Button>}{autoButton}{legacyOutput&&<Button onClick={()=>s.useAcesOutput(clip!.id)} title="This log grade has no highlight roll-off, so bright areas clip. ACES 2 renders them into SDR; a snapshot keeps the current grade.">Use ACES 2 output</Button>}
          {node.group?<span className="group-scope" title="A color group's shared grade: a change here changes every shot in the group"><i className="group-dot" style={{background:groupColor(node.group)}}/>Group · {node.name} — changes all {groupSize} shot{groupSize===1?'':'s'}</span>:<span className="selected-node-label" title="The node these tools change"><b>{String(nodeIndex).padStart(2,'0')}</b>{node.name}</span>}
          <IconButton label="Reset node corrections" onClick={()=>{patchNode({parameters:{...Object.fromEntries(Object.keys(node.parameters).map(k=>[k,neutral(k)])),...defaults},curves:{}});}}><RotateCcw size={14}/></IconButton></>}</div>
      <div className="grade-tool-body" data-tool={tool}>{toolBody}</div>
    </section>{separator('scopes',scopeWidth)}<section className="panel color-scopes"><div className="panel-header"><strong>Scopes</strong><span className="scope-live">● Live</span><span className="spacer"/><select aria-label="Video scope" value={scope} onChange={e=>setScope(e.target.value as Scope)}>{scopes.map(n=><option key={n}>{n}</option>)}</select></div><ScopeDisplay type={scope}/><div className="scope-meta"><span>Graded output · Every presented frame</span><span>8-bit display samples</span></div></section></div>
    {rightOpen&&<aside className="color-effects-panel">{separator('inspector',rightWidth)}<div className="color-effects-content"><div className="color-tabs inspector-tabs">{(['Library','Settings','Groups','Assistant']as const).map(t=><button key={t} className={t==='Assistant'?'assistant-tab':undefined} aria-pressed={rightTab===t} onClick={()=>setRightTab(t)}>{t==='Assistant'&&<Sparkles size={13}/>}{t}</button>)}<IconButton label="Close effects panel" onClick={()=>setRightOpen(false)}><PanelRightClose size={15}/></IconButton></div>
      {rightTab==='Groups'?<ColorGroupsPanel shots={shots} current={clip} gesture={gesture} onNormalize={(ids,group)=>setNormalizing({ids,group})}/>:rightTab==='Assistant'?<ColorAssistantPanel shots={shots} current={clip} capabilities={assistant??{available:false,reason:'Checking the Color Assistant…'}}/>:rightTab==='Library'?<div className="effects-library"><label className="effect-search"><Search size={15}/><input aria-label="Search color effects" placeholder="Search effects and looks…" value={search} onChange={e=>setSearch(e.target.value)}/></label><h3>Color</h3>{[['smart-mask','Smart Mask','Select, track, and refine a subject for this correction.'],['depth-key','Depth Key','Limit this correction by distance: near, far and softness on the shot depth.'],['cst','Color Space Transform','Convert camera log, working spaces and display output.'],['lut','3D LUT','Load a .cube look into the selected node.']].filter(([,name])=>name.toLowerCase().includes(search.toLowerCase())).map(([type,name,description])=><button key={type} className="effect-library-card" draggable onDragStart={e=>e.dataTransfer.setData('application/frameline-color-effect',type)} disabled={!node} onClick={()=>node&&addEffect(node.id,type)}><span><GitBranch size={20}/><strong>{name}</strong><Plus size={14}/></span><small>{description}</small></button>)}<p>Drag onto any node, or click to add to the selected node.</p>
        <LooksLibrary search={search} nodeId={node?.id} disabled={!clip} apply={applyLook}/>
        <div className="library-tools"><strong>Node tools</strong>{COLOR_TOOLS.map(t=><button key={t} onClick={()=>chooseTool(t)}>{t} <span>{TOOL_HINTS[t]}</span></button>)}</div></div>:<div className="effect-inspector">
        {node?<><div className="inspector-node-heading"><input aria-label="Node name" value={node.name} onChange={e=>patchNode({name:e.target.value})}/><IconButton label="Toggle selected node" onClick={()=>patchNode({enabled:!node.enabled})}><Power size={15}/></IconButton></div>{!node.enabled&&<p className="color-notice">This node is bypassed. Its settings are preserved.</p>}<small className="effect-order-note">Primaries, curves, mixer → effects below → window, qualifier and mask blend → film → next node</small>
          {node.mask&&clip&&(isDepthKey(node.mask)?<DepthKeyInspector clip={clip} nodeId={node.id} mask={node.mask} change={mask=>patchNode({mask})}/>:<SmartMaskInspector clip={clip} maskId={node.mask.id} targetId={node.id} node/>)}
          {(node.effects??[]).map((effect,i)=><section key={effect.id} className={`node-effect ${effect.enabled?'':'bypassed'}`}><div className="effect-heading"><IconButton label={`Toggle effect ${i+1}`} onClick={()=>changeEffect({...effect,enabled:!effect.enabled})}><Power size={14}/></IconButton><strong>{effect.type==='cst'?'Color Space Transform':effect.name}</strong><span className="spacer"/><IconButton label={`Move effect ${i+1} earlier`} disabled={i===0} onClick={()=>{const effects=[...node.effects!];[effects[i-1],effects[i]]=[effects[i],effects[i-1]];patchNode({effects});}}><ChevronUp size={12}/></IconButton><IconButton label={`Move effect ${i+1} later`} disabled={i===node.effects!.length-1} onClick={()=>{const effects=[...node.effects!];[effects[i+1],effects[i]]=[effects[i],effects[i+1]];patchNode({effects});}}><ChevronDown size={12}/></IconButton><IconButton label={`Remove effect ${i+1}`} onClick={()=>patchNode({effects:node.effects!.filter(e=>e.id!==effect.id)})}><Trash2 size={13}/></IconButton></div>
          {effect.type==='cst'?<CSTSettings effect={effect} change={changeEffect}/>:<div className="lut-settings"><Parameter name="LUT amount" value={effect.amount} min={0} max={1} onChange={amount=>changeEffect({...effect,amount})}/><ColorSelect label="LUT expected gamma" value={effect.inputGamma} options={profiles} change={inputGamma=>changeEffect({...effect,inputGamma})}/><ColorSelect label="LUT expected gamut" value={effect.inputGamut} options={gamuts} change={inputGamut=>changeEffect({...effect,inputGamut})}/><small>{effect.cube.size}³ LUT. Place a CST before this effect if its expected input differs from the current signal. These labels do not apply a hidden conversion.</small></div>}
          <button className="effect-reset" onClick={()=>changeEffect(effect.type==='cst'?defaultCST(effect.id,effect.inputGamma,effect.inputGamut,effect.outputGamma,effect.outputGamut):{...effect,amount:1,enabled:true})}><RotateCcw size={12}/>Reset effect</button></section>)}
          {!node.effects?.length&&<div className="no-effects"><Spline size={22}/><p>This node uses the grading tools below.</p><button onClick={()=>setRightTab('Library')}>Add an effect or a look from the library</button></div>}</>:<p>Select a node to inspect its effects.</p>}
      </div>}
      {rightTab!=='Assistant'&&rightTab!=='Groups'&&clip&&<NoiseSettings clip={clip} kind={asset?.kind}/>}
      {rightTab!=='Assistant'&&rightTab!=='Groups'&&<details className="source-settings"><summary>Source & workflow</summary><Button disabled={!clip} onClick={()=>{s.initializeColorGrade(clip!.id);setRightTab('Settings');}}>Start wide-gamut grade</Button>{autoButton}<p>{asset?.colorEvidence||'Choose the recording gamma and gamut below.'}</p><ColorSelect label="Source gamma" value={source.profile} options={profiles} change={v=>property('inputProfile',v)}/><ColorSelect label="Source gamut" value={source.gamut} options={gamuts} change={v=>property('inputGamut',v)}/><ColorSelect label="Data levels" value={String(clip?.properties.dataLevels||'Auto')} options={['Auto','Full','Video']} change={v=>property('dataLevels',v)}/>{!managed&&<><Parameter name="Camera exposure" min={-6} max={6} value={Number(clip?.properties.inputExposure??0)} onChange={v=>property('inputExposure',v)}/><Parameter name="Camera warmth" min={-2000} max={2000} step={10} value={Number(clip?.properties.inputTemperature??0)} onChange={v=>property('inputTemperature',v)}/></>}{imported&&<><label><input type="checkbox" checked={clip?.properties.bypassResolveLook===true} onChange={e=>property('bypassResolveLook',e.target.checked)}/>Bypass imported Resolve look</label><a href={`/api/projects/${s.projectId}/resolve/project.drp?download`}>Original Resolve project</a></>}<p>Start wide-gamut grade creates Input CST, Balance, Look and Output CST nodes. Auto balance sets the Balance node from the footage. A snapshot preserves the previous grade.</p>{managed&&<small>Source labels describe the recording. The editable CST nodes perform all conversions.</small>}</details>}
    </div></aside>}
    {shotMenu&&(()=>{const menuShots=s.selectedClipIds.includes(shotMenu.id)?shots.filter(c=>s.selectedClipIds.includes(c.id)):shots.filter(c=>c.id===shotMenu.id),grouped=menuShots.filter(c=>colorGroupOf(c)),act=(run:()=>void)=>{setShotMenu(null);run();};
      return <ContextMenu x={shotMenu.x} y={shotMenu.y} onClose={()=>setShotMenu(null)}><button role="menuitem" onClick={()=>act(()=>s.copyGrade(shotMenu.id))}>Copy grade <kbd>⌘C</kbd></button><button role="menuitem" disabled={!s.gradeClipboard} onClick={()=>act(()=>s.pasteGrade(shotMenu.id))}>Paste grade · Replace all <kbd>⌘V</kbd></button>
        <div className="divider"/><button role="menuitem" onClick={()=>act(()=>setNormalizing({ids:menuShots.map(c=>c.id)}))}><Wand2/>Normalize & Group…</button>{grouped.length>0&&<button role="menuitem" onClick={()=>act(()=>s.setColorGroup(grouped.map(c=>c.id),null))}><Ungroup/>Remove from group</button>}</ContextMenu>;})()}
    {normalizing&&<NormalizeDialog clipIds={normalizing.ids} group={normalizing.group} onClose={()=>setNormalizing(null)}/>}
    <footer className="color-status"><span>{inputCST?.type==='cst'?`${inputCST.inputGamma} / ${inputCST.inputGamut}`:`${source.profile} / ${source.gamut}`}{!asset?.inputProfile?' · source unverified':''}</span><span>{managed?'Explicit node transforms':imported?'Imported Resolve look preserved':source.profile!=='Rec.709'?'Camera log shown as recorded':'Compatible SDR pipeline'} · Originals retained</span><span>{precision} → 8-bit display · {s.saveStatus}</span></footer>
  </div>;
}
