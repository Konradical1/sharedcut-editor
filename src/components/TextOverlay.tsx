import { isCaption } from '../services/captions';
import { projectSize } from '../services/playback';
import type { Clip } from '../state/models';
import { evaluateClip } from '../services/animation';
import { memo, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useEditorStore, usePausedPlayhead } from '../state/store';
import { getText, isTitle, defaultTextStyle, textLocalPoint, type TextDocument } from '../services/text';
import { lockedAxis, overlayBoxes, snapBox, textBox, SNAP_PIXELS, type SnapBox, type SnapGuide } from '../services/snapping';
import { TextContentEditor } from './TextInspector';

// Memoized and off the moving playhead: the Viewer re-renders every playback frame, and text boxes hide while playing.
export default memo(TextOverlay);
function TextOverlay() {
  const timelineId = useEditorStore(s=>s.timelineId), clips = useEditorStore(s=>s.clips), tracks = useEditorStore(s=>s.tracks), playhead = usePausedPlayhead(), tool = useEditorStore(s=>s.textTool), playing = useEditorStore(s=>s.playing), ids = useEditorStore(s=>s.selectedTextIds), preview = useEditorStore(s=>s.textPreview);
  const shapeTool=useEditorStore(s=>s.shapeTool), clipPreview=useEditorStore(s=>s.clipPreview), project=useEditorStore(s=>s.projects.find(p=>p.id===s.projectId));
  const [projectWidth,projectHeight]=projectSize(project?.resolution??'1920 × 1080');
  const [draft, setDraft] = useState<Partial<TextDocument>|null>(null), [editing, setEditing] = useState<string|null>(null), [guides, setGuides] = useState<SnapGuide[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id?: string; mode: string; x: number; y: number; doc?: TextDocument; clip?: Clip; next?: TextDocument; renewed: number; targets?: SnapBox[] }|null>(null);
  const s = useEditorStore.getState;
  const visible = clips.filter(c=>c.timelineId===timelineId&&isTitle(c)&&!c.disabled&&c.start<=playhead&&c.start+c.duration>playhead&&!tracks.find(t=>t.id===c.trackId)?.hidden).sort((a,b)=>Number(isCaption(a))-Number(isCaption(b))||(tracks.find(t=>t.id===a.trackId)?.number??0)-(tracks.find(t=>t.id===b.trackId)?.number??0));
  const point = (e: PointerEvent) => { const r=root.current!.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}; };
  const finish = (cancel = false) => {
    const d=drag.current;if(!d)return;
    if(!cancel) {
      if(d.id&&d.next)s().updateText([{id:d.id,doc:d.next}]);
      else if(!d.id) { const rect = draft && (draft.width??0)>.01&&(draft.height??0)>.01 ? draft : {x:Math.min(.75,d.x),y:Math.min(.75,d.y),width:.25,height:.15};s().addTitle(0,{...rect,runs:[{text:'Your text',style:{...defaultTextStyle,fontSize:64}}],align:'left'},undefined,false); }
    }
    if(d.id)s().releaseLock(d.id,'textDocument');drag.current=null;setDraft(null);setGuides([]);useEditorStore.setState({textPreview:[]});
  };
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){finish(true);setEditing(null);useEditorStore.setState({textTool:false});}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);});
  useEffect(()=>{setEditing(null);return()=>{const d=drag.current;if(d?.id)s().releaseLock(d.id,'textDocument');useEditorStore.setState({textPreview:[]});};},[timelineId]);
  const begin = (e:PointerEvent, id?: string, mode='move') => {
    if(e.button!==0||playing||shapeTool)return;
    e.preventDefault();e.stopPropagation();const evaluated=id?evaluateClip(clips.find(c=>c.id===id)!,playhead):undefined,frame=point(e),p=evaluated?textLocalPoint(frame,evaluated.properties,projectWidth,projectHeight):{x:Math.max(0,Math.min(1,frame.x)),y:Math.max(0,Math.min(1,frame.y))};
    if(id) { if(e.shiftKey){s().selectText(id,true);return;}s().selectText(id);if(tracks.find(t=>t.id===clips.find(c=>c.id===id)?.trackId)?.locked||!s().acquireLock(id,'textDocument'))return; }
    else if(!tool){s().selectClip(null);setEditing(null);return;}
    setEditing(null);s().setPlaying(false);drag.current={...p,id,mode,renewed:Date.now(),doc:evaluated?getText(evaluated):undefined,clip:evaluated,targets:id&&mode==='move'?overlayBoxes(s(),projectWidth,projectHeight,id):undefined};e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move=(e:PointerEvent)=>{
    const d=drag.current;if(!d)return;const frame=point(e),p=d.clip?textLocalPoint(frame,d.clip.properties,projectWidth,projectHeight):{x:Math.max(0,Math.min(1,frame.x)),y:Math.max(0,Math.min(1,frame.y))};
    if(!d.id){setDraft({x:Math.min(d.x,p.x),y:Math.min(d.y,p.y),width:Math.abs(p.x-d.x),height:Math.abs(p.y-d.y)});return;}
    if(Date.now()-d.renewed>2000){if(!s().renewLock(d.id,'textDocument')){finish(true);return;}d.renewed=Date.now();}
    const doc=d.doc!,dx=p.x-d.x,dy=p.y-d.y;let {x,y,width,height}=doc;
    if(d.mode==='move'){
      // Shift locks the drag to its dominant direction; Alt suspends snapping for fine placement.
      // The pointer delta is already in document space, so a snap measured on screen divides by zoom.
      const zoom=Math.max(.01,Number(d.clip!.properties.zoom??100)/100),axis=e.shiftKey?lockedAxis(dx*projectWidth,dy*projectHeight):null;
      let nx=x+(axis==='y'?0:dx),ny=y+(axis==='x'?0:dy);
      if(e.altKey)setGuides([]);
      else {
        const rect=root.current!.getBoundingClientRect();
        const snap=snapBox(textBox(d.clip!,{...doc,x:nx,y:ny},projectWidth,projectHeight),d.targets??[],{x:SNAP_PIXELS/rect.width,y:SNAP_PIXELS/rect.height},{x:axis!=='y',y:axis!=='x'});
        nx+=snap.dx/zoom;ny+=snap.dy/zoom;setGuides(snap.guides);
      }
      x=Math.max(-4,Math.min(4,nx));y=Math.max(-4,Math.min(4,ny));
    }
    else { if(d.mode.includes('e'))width=Math.max(.01,Math.min(1,width+dx));if(d.mode.includes('s'))height=Math.max(.01,Math.min(1,height+dy));if(d.mode.includes('w')){x=Math.max(doc.x+doc.width-1,Math.min(doc.x+doc.width-.01,doc.x+dx));width=doc.x+doc.width-x;}if(d.mode.includes('n')){y=Math.max(doc.y+doc.height-1,Math.min(doc.y+doc.height-.01,doc.y+dy));height=doc.y+doc.height-y;} }
    d.next={...doc,x,y,width,height};const clip=d.clip!;useEditorStore.setState({textPreview:[{...clip,keyframes:undefined,properties:{...clip.properties,textDocument:JSON.stringify(d.next)}}]});
  };
  return <div ref={root} className={`text-overlay ${tool?'drawing-text':''} ${playing?'text-playing':''}`} aria-label="Text canvas" onPointerDown={e=>begin(e)} onPointerMove={move} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onLostPointerCapture={()=>{if(drag.current)finish(true);}}>
    {!playing&&visible.map(clip=>{const evaluated=preview.find(c=>c.id===clip.id)??evaluateClip(clipPreview?.id===clip.id?clipPreview:clip,playhead),doc=getText(evaluated),p=evaluated.properties,selected=ids.includes(clip.id);return <div key={clip.id} role="button" tabIndex={tool?-1:0} aria-label={`Select text: ${clip.name}`} aria-pressed={selected} className={`text-box ${selected?'selected':''}`} style={{left:`${doc.x*100}%`,top:`${doc.y*100}%`,width:`${doc.width*100}%`,height:`${doc.height*100}%`,transform:`translate(${Number(p.x??0)/projectWidth/doc.width*100}%, ${Number(p.y??0)/projectHeight/doc.height*100}%) rotate(${Number(p.rotation??0)}deg) scale(${Math.max(.01,Number(p.zoom??100)/100)})`,transformOrigin:`${(.5+Number(p.anchorX??0)/projectWidth-doc.x)/doc.width*100}% ${(.5+Number(p.anchorY??0)/projectHeight-doc.y)/doc.height*100}%`,pointerEvents:tool||shapeTool?'none':undefined}} onPointerDown={e=>begin(e,clip.id)} onDoubleClick={e=>{e.stopPropagation();s().selectText(clip.id);if(!isCaption(clip))setEditing(clip.id);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();s().selectText(clip.id);if(!isCaption(clip))setEditing(clip.id);}}}>
      {selected&&<><span className="text-box-label">T · {clip.name.slice(0,28)}</span>{['nw','n','ne','e','se','s','sw','w'].map(handle=><button key={handle} className={`text-resize text-resize-${handle}`} aria-label={`Resize text ${handle}`} onPointerDown={e=>begin(e,clip.id,handle)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();s().updateText([{id:clip.id,doc:{...doc,width:Math.max(.01,Math.min(1,doc.width+(e.key==='ArrowRight'?.005:e.key==='ArrowLeft'?-.005:0))),height:Math.max(.01,Math.min(1,doc.height+(e.key==='ArrowDown'?.005:e.key==='ArrowUp'?-.005:0)))}}]);}}/>)}</>}
    </div>;})}
    {guides.map((g,i)=><div key={i} className={`snap-guide snap-guide-${g.axis}`} style={g.axis==='x'?{left:`${g.at*100}%`}:{top:`${g.at*100}%`}}/>)}
    {draft&&<div className="text-box text-box-draft" style={{left:`${(draft.x??0)*100}%`,top:`${(draft.y??0)*100}%`,width:`${(draft.width??0)*100}%`,height:`${(draft.height??0)*100}%`}}/>}
    {tool&&<span className="text-tool-hint">Drag to draw a text box · Esc to cancel</span>}
    {editing&&visible.some(c=>c.id===editing)&&<div className="canvas-text-popover" onPointerDown={e=>e.stopPropagation()}><header><b>Edit text</b><button onClick={()=>setEditing(null)}>Done</button></header><TextContentEditor clipId={editing} inline onDone={()=>setEditing(null)}/><small>Highlight words, then adjust them in the inspector.</small></div>}
  </div>;
}
