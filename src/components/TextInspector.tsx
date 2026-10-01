import { animationProperties, evaluateClip } from '../services/animation';
import './text.css';
import { useEffect, useRef, useState } from 'react';
import { AlignLeft, AlignCenter, AlignRight, Bold, Italic, Underline, Upload, Search, Type, Monitor, Globe, ChevronDown, Diamond } from 'lucide-react';
import { useEditorStore, usePanelPlayhead } from '../state/store';
import { commonStyle, getText, isTitle, replaceText, textContent, defaultTextEffects, type TextStyle, type TextDocument } from '../services/text';
import { browseLocalFonts, uploadFont, useFonts } from '../services/fonts';
import { Property, MotionBlurControl } from './Inspector';
import { Modal, IconButton } from './ui';

export function TextContentEditor({ clipId, inline = false, onDone }: { clipId: string; inline?: boolean; onDone?: () => void }) {
  const clip = useEditorStore(s => s.clips.find(c => c.id === clipId));
  // Re-renders the text at the playhead; only animated text changes with time.
  usePanelPlayhead(Object.keys(clip?.keyframes ?? {}).length > 0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const gesture = useRef('');
  const lease = useRef<ReturnType<typeof setInterval>|undefined>(undefined);
  useEffect(() => {
    if (!inline) return;
    ref.current?.focus(); ref.current?.select();
  }, [inline]);
  useEffect(() => () => { clearInterval(lease.current); useEditorStore.getState().releaseLock(clipId, 'textDocument'); }, [clipId]);
  if (!clip || !isTitle(clip)) return null;
  const doc = getText(evaluateClip(clip,useEditorStore.getState().playhead)), state = useEditorStore.getState;
  const selection = (el: HTMLTextAreaElement) => useEditorStore.setState({ textSelection: { clipId, start: el.selectionStart, end: el.selectionEnd } });
  return <textarea ref={ref} id={inline ? undefined : 'title-content'} className={inline ? 'inline-text-editor' : 'title-content'} aria-label={inline ? 'Edit text on canvas' : 'Text content'} spellCheck maxLength={10000} value={textContent(doc)} onFocus={e => { gesture.current = crypto.randomUUID(); if (!state().acquireLock(clipId, 'textDocument')) e.currentTarget.blur(); else { clearInterval(lease.current); lease.current = setInterval(() => state().renewLock(clipId, 'textDocument'), 3000); } }} onSelect={e => selection(e.currentTarget)} onChange={e => { const el = e.currentTarget; state().renewLock(clipId, 'textDocument'); state().updateText([{ id: clipId, doc: replaceText(getText(evaluateClip(state().clips.find(c => c.id === clipId)!, state().playhead)), el.value) }], gesture.current); selection(el); }} onBlur={() => { clearInterval(lease.current); state().releaseLock(clipId, 'textDocument'); }} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); onDone?.(); e.currentTarget.blur(); } }}/>
}

export default function TextInspector() {
  const clips = useEditorStore(s => s.clips), ids = useEditorStore(s => s.selectedTextIds), selectedId = useEditorStore(s => s.selectedClipId), selection = useEditorStore(s => s.textSelection);
  const timelineId = useEditorStore(s => s.timelineId);
  const selected = clips.filter(c => c.timelineId === timelineId && isTitle(c) && (ids.length ? ids.includes(c.id) : c.id === selectedId));
  const playhead=usePanelPlayhead(selected.some(c => Object.keys(c.keyframes ?? {}).length > 0));
  const fonts = useFonts();
  const [picker, setPicker] = useState(false), [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  if (!selected.length) return null;
  const docs = selected.map(clip => ({ doc: getText(evaluateClip(clip,useEditorStore.getState().playhead)), range: selected.length === 1 && selection?.clipId === clip.id ? selection : undefined }));
  const style = commonStyle(docs), doc = docs[0].doc, s = useEditorStore.getState;
  const range = selected.length === 1 && selection?.clipId === selected[0].id && selection.end > selection.start;
  const scope = range ? `${selection.end - selection.start} characters selected` : selected.length > 1 ? `${selected.length} text layers selected` : 'Entire text layer';
  const patchBox = (patch: Partial<TextDocument>, preview = false) => {
    const documents = selected.map(clip => ({ id: clip.id, doc: { ...getText(evaluateClip(clip,useEditorStore.getState().playhead)), ...patch } }));
    if (preview) useEditorStore.setState({ textPreview: selected.map((clip,i) => ({ ...evaluateClip(clip,playhead), keyframes:undefined, properties: { ...evaluateClip(clip,playhead).properties, textDocument: JSON.stringify(documents[i].doc) } })) });
    else s().updateText(documents);
  };
  const keyButton = (field: string, label: string, runStyle = false) => {
    const channels = selected.flatMap((clip, i) => {
      let offset = 0;
      const runIds = docs[i].doc.runs.flatMap((run, index) => { const start = offset; offset += run.text.length; return !docs[i].range || docs[i].range!.start === docs[i].range!.end || start < docs[i].range!.end && offset > docs[i].range!.start ? [index] : []; });
      return animationProperties(evaluateClip(clip, playhead)).filter(p => runStyle ? runIds.some(index => p.path === `text.runs.${index}.style.${field}`) : field === 'content' ? /^text\.runs\.\d+\.text$/.test(p.path) : p.path === `text.${field}`).map(p => ({ clip, ...p }));
    });
    const active = channels.length > 0 && channels.every(({ clip, path }) => clip.keyframes?.[path]?.some(k => Math.abs(k.time - (playhead - clip.start)) < .5 / (s().projects.find(p => p.id === clip.projectId)?.fps ?? 24)));
    return <button className={`text-keyframe ${active ? 'active' : ''}`} aria-label={`Add ${label} keyframe`} title={`Add ${label} keyframe at the playhead`} onClick={() => channels.forEach(({ clip, path, value }) => s().keyframeProperty(clip.id, path, value))}><Diamond size={12} fill={active ? 'currentColor' : 'none'}/></button>;
  };
  const number = (key: keyof TextStyle, label: string, initial: number, min: number, max: number, step = 1, suffix = '') => <div className="text-animated-row"><Property name={`text-${key}`} label={label} initial={initial} min={min} max={max} step={step} suffix={suffix} control={{ value: style[key] as number | undefined, change: value => s().formatText({ [key]: value }), preview: value => s().formatText({ [key]: value }, true) }}/>{keyButton(key,label,true)}</div>;
  type NumericDocumentKey = 'lineHeight' | 'opacity' | 'x' | 'y' | 'width' | 'height' | 'outlineWidth' | 'shadowOpacity' | 'shadowBlur' | 'shadowX' | 'shadowY' | 'blur' | 'typingSpeed' | 'typingRandomness' | 'typingProgress';
  const boxNumber = (key: NumericDocumentKey, label: string, min: number, max: number, step: number, scale = 1, suffix = '') => <div className="text-animated-row"><Property name={`text-${key}`} label={label} initial={Number(doc[key]) * scale} min={min} max={max} step={step} suffix={suffix} control={{ value: docs.every(d => d.doc[key] === doc[key]) ? Number((Number(doc[key]) * scale).toFixed(3)) : undefined, change: value => patchBox({ [key]: value / scale }), preview: value => patchBox({ [key]: value / scale }, true) }}/>{keyButton(key,label)}</div>;
  const effectColor = (key: 'outlineColor' | 'shadowColor', label: string) => <div className="text-effect-row"><label><span>{label}</span><input type="color" aria-label={label} value={doc[key] ?? defaultTextEffects[key]} onChange={e => patchBox({ [key]: e.target.value })}/></label>{keyButton(key,label)}</div>;
  const effectToggle = (key: 'typingEnabled' | 'typingCursor', label: string) => <div className="text-effect-row"><label><input type="checkbox" checked={Boolean(doc[key])} onChange={e => patchBox({ [key]: e.target.checked })}/><span>{label}</span></label>{keyButton(key,label)}</div>;
  const fontName = fonts.shared.find(f => f.family === style.fontFamily)?.name ?? style.fontFamily;
  return <div className="text-inspector">
    <div className="text-scope"><Type size={13}/><span>{scope}</span>{range&&<button onClick={() => useEditorStore.setState({ textSelection: null })}>Select layer</button>}</div>
    {selected.length === 1 && <div className="text-content-section"><label htmlFor="title-content">Text content {keyButton('content','Text content')}</label><TextContentEditor key={selected[0].id} clipId={selected[0].id}/></div>}
    <section className="text-controls"><h3>Typography</h3>
      <div className="text-animated-row"><button className={`font-picker-trigger ${!fontName?'mixed-value':''}`} onClick={() => setPicker(true)}><span className="font-sample">Aa</span><span><b>{fontName ?? 'Mixed fonts'}</b><small>Browse fonts</small></span><ChevronDown size={13}/></button>{keyButton('fontFamily','Font',true)}</div>
      <div className="text-style-buttons">{([{key:'fontWeight', label:'Bold', icon:Bold, active:style.fontWeight !== undefined && style.fontWeight >= 700, value:style.fontWeight !== undefined && style.fontWeight >= 700?400:700}, {key:'italic',label:'Italic',icon:Italic,active:style.italic,value:!style.italic}, {key:'underline',label:'Underline',icon:Underline,active:style.underline,value:!style.underline}] as const).map(item=><button key={item.key} aria-label={item.label} aria-pressed={style[item.key]===undefined?'mixed':Boolean(item.active)} className={item.active?'active':style[item.key]===undefined?'mixed-value':''} onClick={()=>s().formatText({[item.key]:item.value})}><item.icon size={15}/>{style[item.key]===undefined&&<span>—</span>}</button>)}<span className="spacer"/><label className="text-color" title="Text color"><input type="color" aria-label="Text color" value={style.color??'#ffffff'} onChange={e=>s().formatText({color:e.target.value})}/><span className={!style.color?'mixed-value':''}>{style.color?.toUpperCase()??'Mixed'}</span></label>{keyButton('color','Text color',true)}</div><div className="text-style-keyframes">{(['italic','underline'] as const).map(key=><span key={key}>{key}{keyButton(key,key,true)}</span>)}</div>
      {number('fontSize','Size',96,4,600,1,'px')}{number('fontWeight','Weight',400,100,900,100)}{number('letterSpacing','Letter spacing',0,-10,100,.1,'px')}
      <p className="inspector-note">Drag a value left or right. Shift for fine adjustments. — means mixed.</p>
    </section>
    <section className="text-controls"><h3>Text box <small>Whole layer</small></h3><div className="text-alignment">{([{value:'left',icon:AlignLeft},{value:'center',icon:AlignCenter},{value:'right',icon:AlignRight}] as const).map(item=><IconButton key={item.value} label={`Align text ${item.value}`} className={docs.every(d=>d.doc.align===item.value)?'active':''} onClick={()=>patchBox({align:item.value})}><item.icon size={15}/></IconButton>)}{keyButton('align','Alignment')}</div>
      {boxNumber('lineHeight','Line height',.5,4,.05,1,'×')}{boxNumber('x','Position X',-400,400,.1,100,'%')}{boxNumber('y','Position Y',-400,400,.1,100,'%')}{boxNumber('width','Box width',1,100,.1,100,'%')}{boxNumber('height','Box height',1,100,.1,100,'%')}{boxNumber('opacity','Opacity',0,100,1,1,'%')}
    </section>
    <section className="text-controls"><h3>Transform</h3><Property name="zoom" label="Scale" initial={100} min={1} max={800} suffix="%"/><Property name="rotation" label="Rotation" min={-360} max={360} suffix="°"/><MotionBlurControl/></section>
    <section className="text-controls"><h3>Outline & blur</h3>{effectColor('outlineColor','Outline color')}{boxNumber('outlineWidth','Outline width',0,100,.5,1,'px')}{boxNumber('blur','Gaussian blur',0,100,.5,1,'px')}</section>
    <section className="text-controls"><h3>Drop shadow</h3>{effectColor('shadowColor','Shadow color')}{boxNumber('shadowOpacity','Shadow opacity',0,100,1,1,'%')}{boxNumber('shadowBlur','Shadow softness',0,200,.5,1,'px')}{boxNumber('shadowX','Shadow X',-1000,1000,1,1,'px')}{boxNumber('shadowY','Shadow Y',-1000,1000,1,1,'px')}</section>
    <section className="text-controls"><h3>Typewriter</h3>{effectToggle('typingEnabled','Type text on')}{boxNumber('typingSpeed','Typing speed',1,120,1,1,'/s')}{boxNumber('typingRandomness','Randomness',0,100,1,1,'%')}{effectToggle('typingCursor','Blinking cursor')}{boxNumber('typingProgress','Reveal progress',0,100,1,1,'%')}</section>
    {picker&&<Modal title="Font library" onClose={()=>setPicker(false)}><div className="font-library"><div className="font-search"><Search size={15}/><input autoFocus placeholder="Find a font…" aria-label="Search fonts" value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="font-library-actions"><button disabled={busy} onClick={async()=>{try{setMessage('');await browseLocalFonts();}catch(error){setMessage((error as Error).message);}}}><Monitor size={14}/>Browse this computer</button><button disabled={busy} onClick={()=>upload.current?.click()}><Upload size={14}/>{busy?'Uploading…':'Add shared font'}</button><input ref={upload} type="file" className="visually-hidden" aria-label="Upload shared font" accept=".ttf,.otf,.ttc,.woff,.woff2" onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;setBusy(true);setMessage('');try{const font=await uploadFont(file);s().formatText({fontFamily:font.family});setMessage(`${font.name} is now available to everyone on this server.`);}catch(error){setMessage((error as Error).message);}finally{setBusy(false);}}}/></div>
      {(message||fonts.error)&&<p role="status" className="font-message">{message||fonts.error}</p>}
      <p className="font-library-note">System fonts use your installed collection. Upload fonts you can share to make them available to everyone and to exports.</p>
      <div className="font-list">{([{name:'Shared fonts',icon:Globe,items:fonts.shared.map(f=>({family:f.family,name:f.name}))},{name:'System fonts',icon:Monitor,items:fonts.local.map(f=>({family:f,name:f}))}]).map(group=><div key={group.name}><h4><group.icon size={12}/>{group.name}</h4>{group.items.filter(f=>f.name.toLowerCase().includes(search.toLowerCase())).map(f=><button key={f.family} className={f.family===style.fontFamily?'active':''} onClick={()=>{s().formatText({fontFamily:f.family});setPicker(false);}}><span>{f.name}</span><b style={{fontFamily:`"${f.family}"`}}>Ag</b></button>)}{!group.items.length&&<p>No shared fonts yet. Add the first one.</p>}</div>)}</div>
    </div></Modal>}
  </div>;
}
