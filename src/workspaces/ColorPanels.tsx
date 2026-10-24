import {useState} from 'react';
import {RotateCcw} from 'lucide-react';
import type {Clip,ColorCurves,GradeNode} from '../state/models';
import {colorTransform,defaultCST,primaryDefaults} from '../services/color';
import {HSL_CURVES,PARAM} from '../services/grading';
import {COLOR_LOOKS,lookPatch,type LookGroup} from '../services/colorPresets';
import {IconButton} from '../components/ui';
import {ColorWheel,Curves,GradeSlider,GradeToggle,HSL_INFO,HslCurve,type HslKind} from './ColorTools';

type Update=(p:Record<string,number>)=>void;
const reset=(keys:string[])=>Object.fromEntries(keys.map(k=>[k,PARAM[k].initial]));

// ---- Primaries: wheels beside grouped sliders ------------------------------------------------------------------------------
const WHEELS:[string,string,string][]=[['Shadows','lift','Shadows (DaVinci Lift): moves the dark tones; white stays put'],['Midtones','gamma','Midtones (DaVinci Gamma): bends the middle tones; black and white stay put'],['Highlights','gain','Highlights (DaVinci Gain): scales the bright tones; black stays put'],['Offset','offset','Offset: shifts every level by the same amount']];
const LOG_WHEELS:[string,string,string][]=[['Shadow','logShadow','Log Shadow: below the Low range'],['Midtone','logMid','Log Midtone: between the Low and High ranges'],['Highlight','logHighlight','Log Highlight: above the High range'],WHEELS[3]];
const BALANCE:[string,string[]]=['Balance',['exposure','temperature','tint']],TONE:[string,string[]]=['Tone',['contrast','pivot','shadows','highlights']],COLOR:[string,string[]]=['Color',['saturation','hue','boost','density']];
// Two columns of two groups: side by side on a wide tool area, stacked in two columns on a narrow one. Detail is a row of its own in
// space the base layout leaves free: under the slider groups on a wide tool area, under the wheels on a narrow one.
const GROUPS:[string,string[]][]=[BALANCE,TONE,COLOR,['Range saturation',['saturationShadows','saturationMidtones','saturationHighlights']]],LOG_GROUPS:[string,string[]][]=[BALANCE,TONE,['Log ranges',['logLowRange','logHighRange']],COLOR];
export function PrimariesPanel({node,update,log,pivot}:{node:GradeNode;update:Update;log:boolean;pivot:number}){
  const slider=(k:string)=><GradeSlider key={k} k={k} className={`track-${k}`} value={node.parameters[k]} initial={k==='pivot'?pivot:undefined} onChange={v=>update({[k]:v})}/>;
  return <div className="primaries-tool">
    <div className="color-wheels">{(log?LOG_WHEELS:WHEELS).map(([name,base,title])=><ColorWheel key={base} name={name} base={base} title={title} node={node} update={update}/>)}</div>
    <div className="slider-groups">{[0,2].map(i=><div key={i} className="slider-column">{(log?LOG_GROUPS:GROUPS).slice(i,i+2).map(([title,keys])=><section key={title} className="slider-group"><h4>{title}</h4>{keys.map(slider)}</section>)}</div>)}</div>
    <section className="slider-group detail-group"><h4>Detail</h4>{['dehaze','clarity'].map(slider)}</section>
  </div>;
}

// ---- Curves: custom and the six HSL curves -----------------------------------------------------------------------------------
export type CurveKind='Custom'|HslKind;
const changedCurve=(node:GradeNode,kind:CurveKind)=>kind==='Custom'?(['RGB','R','G','B'] as const).some(k=>{const c=node.curves?.[k];return c&&!(c.points.length===2&&c.points[0].y===0&&c.points[1].y===1&&c.points.every(p=>p.slope===undefined));})||!node.curves&&['curve25','curve50','curve75'].some(k=>node.parameters[k]!==undefined):!!node.curves?.[kind]?.points.some(p=>Math.abs(p.y-.5)>1e-4);
export function CurvesPanel({node,kind,setKind,update}:{node:GradeNode;kind:CurveKind;setKind:(k:CurveKind)=>void;update:(curves:ColorCurves)=>void}){
  return <div className="curves-tool">
    <nav className="curve-kinds" aria-label="Curve type">{(['Custom',...HSL_CURVES] as CurveKind[]).map(k=><button key={k} aria-pressed={kind===k} onClick={()=>setKind(k)}>{k==='Custom'?'Custom':HSL_INFO[k].label}{changedCurve(node,k)&&<i className="in-use" title="Changed on this node"/>}</button>)}</nav>
    {kind==='Custom'?<Curves key={node.id} node={node} update={update}/>:<HslCurve key={`${node.id}-${kind}`} kind={kind} node={node} update={update}/>}
  </div>;
}

// ---- RGB mixer --------------------------------------------------------------------------------------------------------------
const MIX=['RR','RG','RB','GR','GG','GB','BR','BG','BB'].map(k=>'mix'+k),CHANNEL={R:'Red',G:'Green',B:'Blue'} as const;
const MIX_PRESETS:[string,number[],number][]=[['Identity',[1,0,0,0,1,0,0,0,1],0],['B&W neutral',[.2126,.7152,.0722,.2126,.7152,.0722,.2126,.7152,.0722],1],['B&W red filter',[.75,.3,-.05,.75,.3,-.05,.75,.3,-.05],1],['Swap R/B',[0,0,1,0,1,0,1,0,0],0]];
export function MixerPanel({node,update}:{node:GradeNode;update:Update}){
  const p=node.parameters,mono=(p.mixMono??0)>=.5;
  return <div className="mixer-tool">
    {(['R','G','B'] as const).map((row,r)=>{const sum=[0,1,2].reduce((s,c)=>s+(p[MIX[r*3+c]]??PARAM[MIX[r*3+c]].initial),0);return <section key={row} className={`slider-group mixer-row${mono&&r?' inactive':''}`}>
      <h4><i className={`swatch-${row}`}/>{CHANNEL[row]} output<span className={Math.abs(sum-1)>.005?'mix-sum off':'mix-sum'} title="A row that adds up to 1 keeps greys neutral">Σ {sum.toFixed(2)}</span></h4>
      {(['R','G','B'] as const).map(col=>{const k=`mix${row}${col}`;return <GradeSlider key={k} k={k} name={`from ${CHANNEL[col]}`} className={`track-from-${col}`} value={p[k]} onChange={v=>update({[k]:v})}/>;})}
    </section>;})}
    <aside className="mixer-side">
      <GradeToggle k="mixMono" value={p.mixMono} onChange={v=>update({mixMono:v})}/>
      <small>{mono?'Every channel takes the Red output row.':'Each output mixes the three inputs.'}</small>
      <div className="mixer-presets">{MIX_PRESETS.map(([name,values,m])=><button key={name} onClick={()=>update({...Object.fromEntries(MIX.map((k,i)=>[k,values[i]])),mixMono:m})}>{name}</button>)}</div>
    </aside>
  </div>;
}

// ---- Film (Dehancer-style) --------------------------------------------------------------------------------------------------
const FILM:{title:string;amounts:string[];details?:string[];toggle?:string}[]=[
  {title:'Halation',amounts:['filmHalation'],details:['filmHalationThreshold','filmHalationRadius','filmHalationHue','filmHalationSat']},
  {title:'Bloom',amounts:['filmBloom'],details:['filmBloomThreshold','filmBloomRadius','filmBloomWarmth']},
  {title:'Grain',amounts:['filmGrain'],details:['filmGrainSize','filmGrainColor','filmGrainResponse','filmGrainSeed'],toggle:'filmGrainStatic'},
  {title:'Vignette',amounts:['filmVignette'],details:['filmVignetteSize','filmVignetteSoftness','filmVignetteRoundness']},
  {title:'Motion',amounts:['filmWeave','filmBreath']},{title:'Aberration',amounts:['filmAberration']},{title:'Density',amounts:['density']},
];
const shortName=(k:string,title:string)=>{const label=PARAM[k].label.replace(new RegExp(`^${title} `,'i'),'');return label[0].toUpperCase()+label.slice(1);};
function FilmSection({title,amounts,details=[],toggle,node,update}:typeof FILM[number]&{node:GradeNode;update:Update}){
  const p=node.parameters,on=amounts.some(k=>(p[k]??0)!==0),keys=[...amounts,...details,...(toggle?[toggle]:[])];
  return <section className={`film-section${on?' on':''}`}>
    <h4><i className="film-led" aria-hidden="true"/>{title}<span className="spacer"/><IconButton label={`Reset ${title}`} disabled={keys.every(k=>p[k]===undefined||p[k]===PARAM[k].initial)} onClick={()=>update(reset(keys))}><RotateCcw size={11}/></IconButton></h4>
    {amounts.map(k=><GradeSlider key={k} k={k} name={amounts.length>1?{filmWeave:'Weave',filmBreath:'Breath'}[k]:'Amount'} className={`film-amount track-${k}`} value={p[k]} onChange={v=>update({[k]:v})}/>)}
    {details.map(k=><GradeSlider key={k} k={k} name={shortName(k,title)} className={`track-${k}`} value={p[k]} onChange={v=>update({[k]:v})}/>)}
    {toggle&&<GradeToggle k={toggle} value={p[toggle]} onChange={v=>update({[toggle]:v})}/>}
  </section>;
}
export function FilmPanel({node,update}:{node:GradeNode;update:Update}){
  const sections=FILM.map(s=><FilmSection key={s.title} {...s} node={node} update={update}/>);
  return <div className="film-tool">
    <div className="film-grid">{sections.slice(0,4)}<div className="film-stack">{sections.slice(4)}</div></div>
    <p className="tool-note">Film works on the whole picture after this node (it is never masked or keyed). It looks most like film on a node just before the Output CST.</p>
  </div>;
}

// ---- Looks (right panel Library) ---------------------------------------------------------------------------------------------
const LOOK_GROUPS:LookGroup[]=['Looks','Film stocks','Black & white'];
// Shadow, skin, foliage, grey, sky and highlight as a Rec.709 camera records them.
const SAMPLES=[[.06,.06,.07],[.78,.56,.45],[.32,.5,.2],[.45,.45,.45],[.36,.56,.86],[.93,.91,.87]],swatches=new Map<string,string[]>();
/** A look's colour at a glance: the samples through Input CST → the look → Output CST, as a wide-gamut grade renders them (film effects aside). */
function swatch(id:string){
  if(!swatches.has(id)){
    const node=(order:number,extra:Partial<GradeNode>)=>({id:`n${order}`,clipId:'c',projectId:'p',name:'Look',kind:'serial',enabled:true,order,parameters:{...primaryDefaults},...extra}) as GradeNode;
    let colors:string[]=[];
    try{const {parameters,curves}=lookPatch(id),grade=colorTransform({id:'c',properties:{colorPipeline:'nodes-v2',inputProfile:'Gamma 2.4',inputGamut:'Rec.709'}} as unknown as Clip,undefined,[node(1,{effects:[defaultCST('in','Gamma 2.4','Rec.709')]}),node(2,{parameters:{...primaryDefaults,...parameters},curves}),node(3,{effects:[defaultCST('out','DaVinci Intermediate','DaVinci Wide Gamut','Gamma 2.4','Rec.709')]})]);
      colors=SAMPLES.map(c=>`rgb(${grade(c).map(v=>Math.round(v*255)).join(' ')})`);}catch{/* drawn without a swatch */}
    swatches.set(id,colors);
  }
  return swatches.get(id)!;
}
/** The look library (services/colorPresets.ts). A click applies at the strength shown; changing the strength re-applies the look last clicked on this node. */
export function LooksLibrary({search,nodeId,disabled,apply}:{search:string;nodeId?:string;disabled:boolean;apply:(lookId:string,strength:number)=>string|undefined}){
  const [strength,setStrength]=useState(100),[last,setLast]=useState<{node?:string;look:string}|null>(null);
  const q=search.trim().toLowerCase(),looks=COLOR_LOOKS.filter(l=>!q||`${l.name} ${l.about} ${l.group}`.toLowerCase().includes(q)),active=last&&last.node===nodeId?last.look:null;
  const again=()=>{if(active)apply(active,strength/100);};
  return <div className="looks-library">
    <label className="look-strength" title="How strongly a look is applied. Changing it re-applies the look you last clicked."><span>Strength</span><input type="range" aria-label="Look strength" min={0} max={100} step={1} value={strength} onChange={e=>setStrength(Number(e.target.value))} onPointerUp={again} onKeyUp={e=>{if(e.key.startsWith('Arrow')||e.key==='Home'||e.key==='End')again();}}/><span className="mono">{strength}%</span></label>
    {LOOK_GROUPS.map(group=>{const list=looks.filter(l=>l.group===group);return list.length>0&&<section key={group}><h3>{group}</h3>{list.map(l=><button key={l.id} className={`look-card${active===l.id?' active':''}`} disabled={disabled} aria-pressed={active===l.id} onClick={()=>{const node=apply(l.id,strength/100);if(node)setLast({node,look:l.id});}}>{swatch(l.id).length>0&&<span className="look-swatch" aria-hidden="true">{swatch(l.id).map((c,i)=><i key={i} style={{background:c}}/>)}</span>}<strong>{l.name}</strong><small>{l.about}</small></button>)}</section>;})}
    {!looks.length&&<p>No look matches “{search}”.</p>}
  </div>;
}
