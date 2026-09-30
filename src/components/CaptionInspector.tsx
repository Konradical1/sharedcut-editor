import { useEffect, useState } from 'react';
import { useEditorStore } from '../state/store';
import { captionTiming, captionPresets, captionPreset, captionSignature, restyleCaption, type CaptionWord } from '../services/captions';
import { useFonts } from '../services/fonts';
import { getText, type TextDocument } from '../services/text';
import { Field, Button, Modal, NumberInput } from './ui';

/** One row per property a line can lend to its set; adding a property here is the only step. */
const setProperties = [
  { id: 'preset', label: 'Preset', value: (doc: TextDocument) => captionPreset(doc.caption!.preset).name },
  { id: 'timing', label: 'Entrance & exit', value: (doc: TextDocument) => { const t = captionTiming(doc.caption!); return `${t.entranceDuration.toFixed(2)}s / ${t.exitDuration.toFixed(2)}s`; } },
  { id: 'color', label: 'Text color', value: (doc: TextDocument) => doc.runs[0].style.color.toUpperCase() },
  { id: 'size', label: 'Caption size', value: (doc: TextDocument) => `${Math.round(doc.runs[0].style.fontSize)} px` },
  { id: 'position', label: 'Vertical position', value: (doc: TextDocument) => `${Math.round(doc.y * 100)}%` },
  { id: 'shadow', label: 'Shadow strength', value: (doc: TextDocument) => `${Math.round(doc.shadowOpacity ?? 75)}%` },
  { id: 'font', label: 'Font', value: (doc: TextDocument) => `${doc.runs[0].style.fontFamily} ${doc.runs[0].style.fontWeight}` },
  { id: 'outline', label: 'Outline', value: (doc: TextDocument) => `${doc.outlineWidth ?? 0} ${(doc.outlineColor ?? '#101116').toUpperCase()}` },
  { id: 'accent', label: 'Highlight & word pop', value: (doc: TextDocument) => `${doc.caption!.accent?.toUpperCase() ?? 'Preset'}${doc.caption!.wordPop ? ' · pop' : ''}` },
] as const;

export default function CaptionInspector({id}:{id:string}) {
  const clip=useEditorStore(s=>s.clips.find(c=>c.id===id))!,tracks=useEditorStore(s=>s.tracks),clips=useEditorStore(s=>s.clips),doc=getText(clip),data=doc.caption!,timing=captionTiming(data);
  const meta=tracks.find(t=>t.id===clip.trackId)?.captionSets?.find(s=>s.id===clip.properties.captionSet);
  const [text,setText]=useState(doc.runs.map(r=>r.text).join('')),[count,setCount]=useState(meta?.wordsPerLine??5),[picks,setPicks]=useState<string[]|null>(null);
  const s=useEditorStore.getState;
  useEffect(()=>{setText(doc.runs.map(r=>r.text).join(''));setCount(meta?.wordsPerLine??5);},[id,clip.properties.textDocument,meta?.wordsPerLine]);
  const update=(next:TextDocument)=>s().updateText([{id,doc:next}]);
  const fonts=useFonts();
  const setStyle=(patch:Partial<TextDocument['runs'][number]['style']>)=>update({...doc,runs:doc.runs.map(r=>({...r,style:{...r.style,...patch}}))});
  const save=()=>{
    const tokens=text.trim().split(/\s+/).filter(Boolean);if(!tokens.length){setText(doc.runs[0].text);return;}
    if(tokens.join(' ')===data.words.map(w=>w.text).join(' '))return;
    const from=data.words[0]?.start??0,to=data.words.at(-1)?.end??clip.duration;
    s().updateCaption(id,tokens.map((word,n)=>tokens.length===data.words.length?{...data.words[n],text:word}:{text:word,start:from+(to-from)*n/tokens.length,end:from+(to-from)*(n+1)/tokens.length,uncertain:true}));
  };
  const wordTime=(index:number,key:'start'|'end',value:number)=>{const words:CaptionWord[]=data.words.map((w,i)=>i===index?{...w,[key]:value,uncertain:false}:w);s().updateCaption(id,words);};
  // Preset styling rewrites each document, so the remaining properties are copied onto the restyled lines.
  const applyToSet=(chosen:string[])=>{
    const setId=String(clip.properties.captionSet),picked=new Set(chosen);
    if(picked.has('preset'))s().styleCaptions(setId,data.preset);
    if(chosen.some(key=>key!=='preset'))s().updateText(s().clips.filter(c=>c.timelineId===clip.timelineId&&c.properties.captionSet===clip.properties.captionSet).map(c=>{
      const next=getText(c),style=next.runs[0].style;
      return {id:c.id,doc:{...next,
        ...(picked.has('position')?{y:doc.y}:{}),
        ...(picked.has('shadow')?{shadowOpacity:doc.shadowOpacity??75}:{}),
        ...(picked.has('outline')?{outlineWidth:doc.outlineWidth,outlineColor:doc.outlineColor}:{}),
        runs:next.runs.map(r=>({...r,style:{...r.style,color:picked.has('color')?doc.runs[0].style.color:style.color,fontSize:picked.has('size')?doc.runs[0].style.fontSize:style.fontSize,...(picked.has('font')?{fontFamily:doc.runs[0].style.fontFamily,fontWeight:doc.runs[0].style.fontWeight}:{})}})),
        caption:{...next.caption!,...(picked.has('timing')?timing:{}),...(picked.has('accent')?{accent:data.accent,wordPop:data.wordPop}:{})}}};
    }));
  };
  return <div className="caption-inspector">
    {meta&&meta.signature!==captionSignature(clips,tracks,clip.timelineId,meta.start,meta.end,meta.trackIds)&&<p role="status" className="caption-warning">Captions are out of date. Open Captions → Regenerate to update this set.</p>}
    <Field label="Caption text"><textarea aria-label="Caption text" value={text} maxLength={2000} rows={3} onChange={e=>setText(e.target.value)} onBlur={save}/></Field>
    <div className="caption-timing"><Field label="Line start (seconds)"><NumberInput aria-label="Line start (seconds)" min={0} step={.01} decimals={2} value={clip.start} onCommit={value=>s().moveClip(id,value)}/></Field><Field label="Line duration (seconds)"><NumberInput aria-label="Line duration (seconds)" min={.04} step={.01} decimals={2} value={clip.duration} onCommit={value=>s().trimClip(id,clip.start,value)}/></Field></div>
    <Field label="Line preset"><select value={data.preset} onChange={e=>update(restyleCaption(doc,e.target.value))}>{captionPresets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <div className="caption-timing">{(['entranceDuration','exitDuration'] as const).map(key=><Field key={key} label={key==='entranceDuration'?'Entrance (seconds)':'Exit (seconds)'}><NumberInput aria-label={key==='entranceDuration'?'Entrance (seconds)':'Exit (seconds)'} min={0} max={5} step={.01} decimals={2} value={timing[key]} onCommit={value=>update({...doc,caption:{...data,[key]:value}})}/></Field>)}</div>
    <Field label="Caption size"><NumberInput aria-label="Caption size" min={20} max={300} value={doc.runs[0].style.fontSize} onCommit={value=>update({...doc,runs:doc.runs.map(r=>({...r,style:{...r.style,fontSize:value}}))})}/></Field>
    <Field label="Text color"><input type="color" value={doc.runs[0].style.color} onChange={e=>update({...doc,runs:doc.runs.map(r=>({...r,style:{...r.style,color:e.target.value}}))})}/></Field>
    <Field label="Vertical position"><input type="range" min={.05} max={.9} step={.01} value={doc.y} onChange={e=>update({...doc,y:Number(e.target.value)})}/></Field>
    <Field label="Shadow strength"><input type="range" min={0} max={100} value={doc.shadowOpacity??75} onChange={e=>update({...doc,shadowOpacity:Number(e.target.value)})}/></Field>
    <div className="caption-timing"><Field label="Font"><select aria-label="Caption font" value={doc.runs[0].style.fontFamily} onChange={e=>setStyle({fontFamily:e.target.value})}>{[...new Set([doc.runs[0].style.fontFamily,...captionPresets.map(p=>p.font)])].map(f=><option key={f} value={f}>{f}</option>)}{fonts.shared.map(f=><option key={f.id} value={f.family}>{f.name}</option>)}</select></Field><Field label="Weight"><NumberInput aria-label="Caption weight" min={100} max={900} step={100} decimals={0} value={doc.runs[0].style.fontWeight} onCommit={value=>setStyle({fontWeight:Math.round(value/100)*100})}/></Field></div>
    <div className="caption-timing"><Field label="Outline width"><NumberInput aria-label="Outline width" min={0} max={60} decimals={0} value={doc.outlineWidth??0} onCommit={value=>update({...doc,outlineWidth:value})}/></Field><Field label="Outline color"><input type="color" aria-label="Outline color" value={doc.outlineColor??'#101116'} onChange={e=>update({...doc,outlineColor:e.target.value})}/></Field></div>
    <div className="caption-timing"><Field label="Highlight color"><input type="color" aria-label="Highlight color" value={data.accent??captionPreset(data.preset).accent} onChange={e=>update({...doc,caption:{...data,accent:e.target.value}})}/></Field><label className="inspector-checks"><input type="checkbox" aria-label="Pop each word" checked={Boolean(data.wordPop)} onChange={e=>update({...doc,caption:{...data,wordPop:e.target.checked}})}/>Pop each word</label></div>
    <Button onClick={()=>setPicks(setProperties.map(p=>p.id))}>Apply to set…</Button>
    {data.words.some(w=>w.uncertain)&&<p className="caption-warning">Some word timings need review. Check the timings below.</p>}
    <details><summary>Word timing</summary><p className="caption-hint">Seconds from this line’s original start.</p><div className="caption-word-times">{data.words.map((word,n)=><div key={n}><span title={word.uncertain?'Approximate timing':undefined}>{word.text}{word.uncertain?' *':''}</span>{(['start','end'] as const).map(key=><NumberInput key={key} aria-label={`${word.text} ${key} ${n+1}`} min={0} step={.01} decimals={2} value={word[key]} onCommit={value=>wordTime(n,key,value)}/>)}</div>)}</div></details>
    {meta&&<details><summary>Line grouping</summary><Field label="Words per line"><NumberInput aria-label="Words per line" min={1} max={15} decimals={0} value={count} onCommit={value=>setCount(Math.round(value))}/></Field><p className="caption-hint">Regroups this set using edited words and existing timings. Resets individual line styles and manual breaks.</p><Button onClick={()=>s().regroupCaptions(meta.id,count)}>Regroup lines</Button></details>}
    {picks&&<Modal title="Apply to caption set" onClose={()=>setPicks(null)}>
      <div className="modal-body caption-apply">
        <p className="caption-hint">Copies the checked properties from this line to every line in this set.</p>
        <label className="caption-apply-all"><input type="checkbox" aria-label="Select all properties" checked={picks.length===setProperties.length} onChange={e=>setPicks(e.target.checked?setProperties.map(p=>p.id):[])}/><span>Select all</span></label>
        {setProperties.map(property=><label className="caption-apply-row" key={property.id}>
          <input type="checkbox" aria-label={property.label} checked={picks.includes(property.id)} onChange={e=>setPicks(e.target.checked?[...picks,property.id]:picks.filter(key=>key!==property.id))}/>
          <span>{property.label}</span><small>{property.value(doc)}</small>
        </label>)}
      </div>
      <div className="modal-actions"><Button onClick={()=>setPicks(null)}>Cancel</Button><Button variant="primary" disabled={!picks.length} onClick={()=>{applyToSet(picks);setPicks(null);}}>Apply</Button></div>
    </Modal>}
  </div>;
}
