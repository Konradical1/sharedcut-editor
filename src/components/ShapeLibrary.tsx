import { useEffect, useRef, useState } from 'react';
import { PenTool, Search, Plus } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { defaultShape, drawShape, shapeKinds } from '../services/shapes';
import './shapes.css';
const names:Record<string,string>={rectangle:'Rectangle',rounded:'Rounded rectangle',ellipse:'Ellipse',triangle:'Triangle',polygon:'Hexagon',star:'Star',line:'Line',arrow:'Arrow',chevron:'Chevron',pen:'Pen path'};
function ShapePreview({kind}:{kind:string}){
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{const canvas=ref.current!,ctx=canvas.getContext('2d')!;ctx.clearRect(0,0,320,180);drawShape(ctx,{...defaultShape(kind),x:.25,y:.18,width:.5,height:.64},320,180,1920,1080);},[kind]);
  return <canvas ref={ref} width={320} height={180} aria-hidden="true"/>;
}
export default function ShapeLibrary(){
  const [query,setQuery]=useState(''),tool=useEditorStore(s=>s.shapeTool);
  return <div className="shape-library"><div className="shape-tools"><button aria-label="Pen tool" className={tool==='pen'?'active':''} aria-pressed={tool==='pen'} onClick={()=>useEditorStore.setState({shapeTool:tool==='pen'?null:'pen',textTool:false,playing:false})}><PenTool size={15}/>Pen tool<kbd>P</kbd></button><select aria-label="Draw a shape" value={tool&&tool!=='pen'?tool:''} onChange={e=>useEditorStore.setState({shapeTool:e.target.value||null,textTool:false,playing:false})}><option value="">Draw shape…</option>{shapeKinds.filter(k=>k!=='pen').map(kind=><option key={kind} value={kind}>{names[kind]}</option>)}</select></div><div className="media-search"><Search size={13}/><input aria-label="Search shapes" placeholder="Find a shape…" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="shape-presets">{shapeKinds.filter(k=>k!=='pen'&&names[k].toLowerCase().includes(query.toLowerCase())).map(kind=><button key={kind} className="shape-preset" draggable aria-label={`Add ${names[kind]} shape`} onClick={()=>useEditorStore.getState().addShape(kind)} onDragStart={e=>{useEditorStore.setState({draggingMediaId:`shape:${kind}`});e.dataTransfer.setData('application/x-frameline-media',`shape:${kind}`);e.dataTransfer.effectAllowed='copy';}} onDragEnd={()=>useEditorStore.setState({draggingMediaId:null})}><div><ShapePreview kind={kind}/><Plus size={14}/></div><b>{names[kind]}</b></button>)}</div></div>;
}
