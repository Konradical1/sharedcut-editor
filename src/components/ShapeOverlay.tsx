import { memo, useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { useEditorStore, usePausedPlayhead } from '../state/store';
import type { Clip } from '../state/models';
import { evaluateClip } from '../services/animation';
import { projectSize } from '../services/playback';
import { defaultShape, fitPenPoints, getShape, isShape, shapePath, type ShapeDocument, type ShapePoint } from '../services/shapes';
import { scales } from '../services/text';
import { lockedAxis, overlayBoxes, shapeBox, snapBox, SNAP_PIXELS, type SnapBox, type SnapGuide } from '../services/snapping';
import './shapes.css';

type XY={x:number;y:number};
type Drag={id?:string;mode:string;start:XY;doc:ShapeDocument;clip?:Clip;next?:ShapeDocument;rotation:number;nextRotation?:number;index?:number;renewed:number;targets?:SnapBox[]};
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n));
// Memoized and off the moving playhead: the Viewer re-renders every playback frame, and shapes are not editable while playing.
export default memo(ShapeOverlay);
function ShapeOverlay(){
  const clips=useEditorStore(s=>s.clips),tracks=useEditorStore(s=>s.tracks),timelineId=useEditorStore(s=>s.timelineId),selectedId=useEditorStore(s=>s.selectedClipId),tool=useEditorStore(s=>s.shapeTool),textTool=useEditorStore(s=>s.textTool),playhead=usePausedPlayhead(),playing=useEditorStore(s=>s.playing),preview=useEditorStore(s=>s.clipPreview),project=useEditorStore(s=>s.projects.find(p=>p.id===s.projectId));
  const [editing,setEditing]=useState<string|null>(null),[selectedPoint,setSelectedPoint]=useState<number|null>(null),[draft,setDraft]=useState<ShapeDocument|null>(null),[pen,setPen]=useState<ShapePoint[]>([]),[guides,setGuides]=useState<SnapGuide[]>([]);
  const root=useRef<SVGSVGElement>(null),drag=useRef<Drag|null>(null),penRef=useRef<ShapePoint[]>([]),s=useEditorStore.getState;
  const [width,height]=projectSize(project?.resolution??'1920 × 1080');
  // Handles are sized from the on-screen canvas width at render; memoized, so re-measure when the canvas resizes or the viewer zooms (a transform on the frame).
  const [,remeasure]=useState(0);
  useEffect(()=>{const el=root.current;if(!el)return;const bump=()=>remeasure(n=>n+1),resize=new ResizeObserver(bump),zoom=new MutationObserver(bump),frame=el.closest('.viewer-frame');resize.observe(el);if(frame)zoom.observe(frame,{attributes:true,attributeFilter:['style']});return()=>{resize.disconnect();zoom.disconnect();};},[]);
  const selectedShape=clips.find(c=>c.id===selectedId&&isShape(c));
  const visible=clips.filter(c=>c.timelineId===timelineId&&isShape(c)&&!c.disabled&&c.start<=playhead&&c.start+c.duration>playhead&&!tracks.find(t=>t.id===c.trackId)?.hidden).sort((a,b)=>(tracks.find(t=>t.id===b.trackId)?.number??0)-(tracks.find(t=>t.id===a.trackId)?.number??0));
  const framePoint=(e:{clientX:number;clientY:number}):XY=>{const p=root.current!.createSVGPoint();p.x=e.clientX;p.y=e.clientY;const q=p.matrixTransform(root.current!.getScreenCTM()!.inverse());return{x:q.x/width,y:q.y/height};};
  const pivot=(clip:Clip,doc:ShapeDocument)=>({x:(doc.x+doc.width/2)*width+Number(clip.properties.anchorX??0),y:(doc.y+doc.height/2)*height+Number(clip.properties.anchorY??0)});
  const transform=(clip:Clip,doc:ShapeDocument)=>{const p=pivot(clip,doc);return `translate(${p.x+Number(clip.properties.x??0)} ${p.y+Number(clip.properties.y??0)}) rotate(${Number(clip.properties.rotation??0)}) scale(${scales(clip).join(' ')}) translate(${-p.x} ${-p.y})`;};
  const localPoint=(e:{clientX:number;clientY:number},clip:Clip,doc:ShapeDocument):XY=>{
    const pt=framePoint(e),p=pivot(clip,doc),r=-Number(clip.properties.rotation??0)*Math.PI/180,[zx,zy]=scales(clip),dx=pt.x*width-p.x-Number(clip.properties.x??0),dy=pt.y*height-p.y-Number(clip.properties.y??0);
    return {x:((dx*Math.cos(r)-dy*Math.sin(r))/zx+p.x)/width,y:((dx*Math.sin(r)+dy*Math.cos(r))/zy+p.y)/height};
  };
  const setPenPoints=(points:ShapePoint[])=>{penRef.current=points;setPen(points);};
  const finishPen=(closed:boolean)=>{
    const points=penRef.current;
    if(points.length>=(closed?3:2)){const doc=fitPenPoints(points,closed);s().addShape('pen',doc);setPenPoints([]);useEditorStore.setState({shapeTool:null});}
  };
  const end=(cancel=false)=>{
    const d=drag.current;if(!d)return;drag.current=null;
    if(d.mode==='pen'){if(cancel)setPenPoints(penRef.current.slice(0,-1));return;}
    if(!cancel){
      if(d.id){if(d.next)s().updateShape(d.id,d.next);if(d.nextRotation!==undefined)s().updateProperty(d.id,'rotation',d.nextRotation);}
      else {const doc=d.next&&d.next.width>.005&&d.next.height>.005?d.next:{...defaultShape(d.doc.kind),x:clamp(d.start.x,0,.75),y:clamp(d.start.y,0,.75),width:.25,height:.25};s().addShape(doc.kind,doc);useEditorStore.setState({shapeTool:null});}
    }
    if(d.id)s().releaseLock(d.id,d.mode==='rotate'?'rotation':'shapeDocument');setDraft(null);setGuides([]);useEditorStore.setState({clipPreview:null});
  };
  useEffect(()=>{setEditing(null);setSelectedPoint(null);end(true);},[timelineId]);
  useEffect(()=>{if(editing&&editing!==selectedId){setEditing(null);setSelectedPoint(null);}},[selectedId]);
  useEffect(()=>{if(tool!=='pen')setPenPoints([]);},[tool]);
  useEffect(()=>()=>{const d=drag.current;if(d?.id)s().releaseLock(d.id,d.mode==='rotate'?'rotation':'shapeDocument');useEditorStore.setState({clipPreview:null});},[]);
  useEffect(()=>{
    const key=(e:globalThis.KeyboardEvent)=>{
      if((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]'))return;
      if(e.key==='Escape'){end(true);setEditing(null);setSelectedPoint(null);setPenPoints([]);useEditorStore.setState({shapeTool:null});}
      if(tool==='pen'&&penRef.current.length&&e.key==='Enter'){e.preventDefault();finishPen(false);}
    };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  });
  const begin=(e:PointerEvent,clip?:Clip,mode='move',index?:number)=>{
    if(e.button!==0||playing||textTool)return;
    e.preventDefault();e.stopPropagation();
    if(!clip&&!tool)return;
    if(clip){
      if(e.shiftKey){s().selectClip(clip.id,true);return;}
      s().selectClip(clip.id);
      if(tracks.find(t=>t.id===clip.trackId)?.locked||!s().acquireLock(clip.id,mode==='rotate'?'rotation':'shapeDocument'))return;
      const doc=getShape(clip),p=mode==='move'?framePoint(e):localPoint(e,clip,doc);
      drag.current={id:clip.id,mode,start:p,doc,clip,rotation:Number(clip.properties.rotation??0),index,renewed:Date.now(),targets:mode==='move'?overlayBoxes(s(),width,height,clip.id):undefined};
      if(index!==undefined)setSelectedPoint(index);else if(mode==='move')setEditing(null);
    }else{
      const p=framePoint(e);p.x=clamp(p.x,0,1);p.y=clamp(p.y,0,1);
      if(tool==='pen'){
        const points=penRef.current,scale=root.current!.getBoundingClientRect().width/width;
        const near=(a:XY,b:XY)=>Math.hypot((a.x-b.x)*width,(a.y-b.y)*height)*scale<8;
        if(points.length>=3&&near(p,points[0])){finishPen(true);return;}
        if(points.length&&near(p,points.at(-1)!))return;
        setPenPoints([...points,p]);drag.current={mode:'pen',start:p,doc:defaultShape('pen'),rotation:0,index:points.length,renewed:Date.now()};
      }else drag.current={mode:'draw',start:p,doc:defaultShape(tool!),rotation:0,renewed:Date.now()};
    }
    s().setPlaying(false);e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move=(e:PointerEvent)=>{
    const d=drag.current;if(!d)return;
    const p=d.clip&&d.mode!=='move'?localPoint(e,d.clip,d.doc):framePoint(e);
    if(d.mode==='pen'){
      const dx=p.x-d.start.x,dy=p.y-d.start.y;
      if(Math.hypot(dx*width,dy*height)<3)return;
      setPenPoints(penRef.current.map((pt,i)=>i===d.index?{...pt,outX:clamp(d.start.x+dx,0,1),outY:clamp(d.start.y+dy,0,1),inX:clamp(d.start.x-dx,0,1),inY:clamp(d.start.y-dy,0,1)}:pt));return;
    }
    if(!d.id){const x=clamp(p.x,0,1),y=clamp(p.y,0,1);d.next={...d.doc,x:Math.min(x,d.start.x),y:Math.min(y,d.start.y),width:Math.max(.001,Math.abs(x-d.start.x)),height:Math.max(.001,Math.abs(y-d.start.y))};setDraft(d.next);return;}
    if(Date.now()-d.renewed>2000){if(!s().renewLock(d.id,d.mode==='rotate'?'rotation':'shapeDocument')){end(true);return;}d.renewed=Date.now();}
    let doc={...d.doc},dx=p.x-d.start.x,dy=p.y-d.start.y;
    if(d.mode==='rotate'){
      const center=pivot(d.clip!,doc),q=framePoint(e),angle=Math.atan2(q.y*height-center.y-Number(d.clip!.properties.y??0),q.x*width-center.x-Number(d.clip!.properties.x??0))*180/Math.PI+90;
      d.nextRotation=clamp(e.shiftKey?Math.round(angle/15)*15:angle,-360,360);useEditorStore.setState({clipPreview:{...d.clip!,keyframes:undefined,properties:{...d.clip!.properties,rotation:d.nextRotation}}});return;
    }
    if(d.mode==='move'){
      // Shift locks the drag to its dominant direction; Alt suspends snapping for fine placement.
      const axis=e.shiftKey?lockedAxis(dx*width,dy*height):null;
      let x=doc.x+(axis==='y'?0:dx),y=doc.y+(axis==='x'?0:dy);
      if(e.altKey)setGuides([]);
      else {
        const rect=root.current!.getBoundingClientRect();
        const snap=snapBox(shapeBox(d.clip!,{...doc,x,y},width,height),d.targets??[],{x:SNAP_PIXELS/rect.width,y:SNAP_PIXELS/rect.height},{x:axis!=='y',y:axis!=='x'});
        x+=snap.dx;y+=snap.dy;setGuides(snap.guides);
      }
      doc.x=clamp(x,-4,4);doc.y=clamp(y,-4,4);
    }
    else if(['point','in','out'].includes(d.mode)&&d.index!==undefined){
      const point={...doc.points[d.index]};
      if(d.mode==='point'){
        point.x=clamp(point.x+dx/doc.width,-8,8);point.y=clamp(point.y+dy/doc.height,-8,8);
        for(const side of ['in','out'] as const)if(point[`${side}X`]!==undefined){point[`${side}X`]=clamp(point[`${side}X`]!+dx/doc.width,-8,8);point[`${side}Y`]=clamp(point[`${side}Y`]!+dy/doc.height,-8,8);}
      }else{const side=d.mode as 'in'|'out';point[`${side}X`]=clamp((p.x-doc.x)/doc.width,-8,8);point[`${side}Y`]=clamp((p.y-doc.y)/doc.height,-8,8);if(e.shiftKey){const opposite=side==='in'?'out':'in';point[`${opposite}X`]=clamp(point.x*2-point[`${side}X`]!,-8,8);point[`${opposite}Y`]=clamp(point.y*2-point[`${side}Y`]!,-8,8);}}
      doc.points=doc.points.map((p,i)=>i===d.index?point:p);
    }else{
      const {x,y,width:w,height:h}=doc;
      if(d.mode.includes('e'))doc.width=clamp(w+dx,.001,8);
      if(d.mode.includes('s'))doc.height=clamp(h+dy,.001,8);
      if(d.mode.includes('w')){doc.x=clamp(x+dx,-4,x+w-.001);doc.width=clamp(x+w-doc.x,.001,8);}
      if(d.mode.includes('n')){doc.y=clamp(y+dy,-4,y+h-.001);doc.height=clamp(y+h-doc.y,.001,8);}
      if(e.shiftKey){const ratio=w/h;if(d.mode==='n'||d.mode==='s')doc.width=clamp(doc.height*ratio,.001,8);else doc.height=clamp(doc.width/ratio,.001,8);}
      const cx=(doc.x+doc.width/2-x-w/2)*width,cy=(doc.y+doc.height/2-y-h/2)*height,r=d.rotation*Math.PI/180,[zx,zy]=scales(d.clip!);
      doc.x=clamp(doc.x+(zx*cx*Math.cos(r)-zy*cy*Math.sin(r)-cx)/width,-4,4);doc.y=clamp(doc.y+(zx*cx*Math.sin(r)+zy*cy*Math.cos(r)-cy)/height,-4,4);
    }
    d.next=doc;useEditorStore.setState({clipPreview:{...d.clip!,keyframes:undefined,properties:{...d.clip!.properties,shapeDocument:JSON.stringify(doc)}}});
  };
  const pointKey=(e:KeyboardEvent,clip:Clip,doc:ShapeDocument,index:number,side:'point'|'in'|'out')=>{
    if(e.key==='Delete'||e.key==='Backspace'){
      e.preventDefault();e.stopPropagation();if(side==='point'&&doc.points.length>(doc.closed?3:2)){s().editShapePoint(clip.id,index,'delete');setSelectedPoint(null);}return;
    }
    if(!e.key.startsWith('Arrow'))return;e.preventDefault();e.stopPropagation();
    const amount=e.shiftKey?10:1,dx=(e.key==='ArrowRight'?amount:e.key==='ArrowLeft'?-amount:0)/(doc.width*width),dy=(e.key==='ArrowDown'?amount:e.key==='ArrowUp'?-amount:0)/(doc.height*height),p={...doc.points[index]};
    if(side==='point'){p.x=clamp(p.x+dx,-8,8);p.y=clamp(p.y+dy,-8,8);for(const handle of ['in','out'] as const)if(p[`${handle}X`]!==undefined){p[`${handle}X`]=clamp(p[`${handle}X`]!+dx,-8,8);p[`${handle}Y`]=clamp(p[`${handle}Y`]!+dy,-8,8);}}
    else{p[`${side}X`]=clamp((p[`${side}X`]??p.x)+dx,-8,8);p[`${side}Y`]=clamp((p[`${side}Y`]??p.y)+dy,-8,8);}
    s().updateShape(clip.id,{...doc,points:doc.points.map((pt,i)=>i===index?p:pt)});
  };
  return <div className={`shape-overlay ${tool?'drawing-shape':''} ${selectedShape?'shape-active':''} ${playing||textTool?'shape-inactive':''}`}><svg ref={root} viewBox={`0 0 ${width} ${height}`} aria-label="Shape canvas" onPointerDown={e=>begin(e)} onPointerMove={move} onPointerUp={()=>end()} onPointerCancel={()=>end(true)} onLostPointerCapture={()=>{if(drag.current)end(true);}} onDoubleClick={e=>{if(tool==='pen'){e.preventDefault();finishPen(false);}}}>
    {!playing&&!tool&&visible.map(original=>{
      const clip=preview?.id===original.id?preview:evaluateClip(original,playhead),doc=getShape(clip),selected=clip.id===selectedId,edit=editing===clip.id,box={x:doc.x*width,y:doc.y*height,width:doc.width*width,height:doc.height*height};
      const handleSize=8*width/(root.current?.getBoundingClientRect().width||640);
      return <g key={clip.id} transform={transform(clip,doc)}><path className={`shape-hit ${selected?'selected':''}`} d={shapePath(doc,box.width,box.height)} transform={`translate(${box.x} ${box.y})`} fill={doc.closed?'transparent':'none'} stroke="transparent" strokeWidth={Math.max(doc.outlineWidth,handleSize*2)} role="button" tabIndex={0} aria-label={`Select shape: ${clip.name}`} aria-pressed={selected} onPointerDown={e=>begin(e,clip)} onDoubleClick={e=>{e.stopPropagation();if(doc.kind==='pen'){setEditing(clip.id);setSelectedPoint(0);}}} onKeyDown={e=>{if(e.key==='Enter'){s().selectClip(clip.id);if(doc.kind==='pen'){setEditing(clip.id);setSelectedPoint(0);}}else if(e.key.startsWith('Arrow')){e.preventDefault();e.stopPropagation();const amount=e.shiftKey?10:1;s().updateShape(clip.id,{...doc,x:clamp(doc.x+(e.key==='ArrowRight'?amount:e.key==='ArrowLeft'?-amount:0)/width,-4,4),y:clamp(doc.y+(e.key==='ArrowDown'?amount:e.key==='ArrowUp'?-amount:0)/height,-4,4)});}}}/>
        {selected&&<><rect {...box} className="shape-bounds" fill="transparent" onPointerDown={e=>begin(e,clip)} onDoubleClick={e=>{e.stopPropagation();if(doc.kind==='pen'){setEditing(clip.id);setSelectedPoint(0);}}} style={{pointerEvents:edit?'none':undefined}}/>{!edit&&<><line x1={box.x+box.width/2} y1={box.y} x2={box.x+box.width/2} y2={box.y-handleSize*3} className="shape-curve-guide"/><circle cx={box.x+box.width/2} cy={box.y-handleSize*3} r={handleSize*.65} className="shape-handle shape-rotate" role="button" tabIndex={0} aria-label="Rotate shape" onPointerDown={e=>begin(e,clip,'rotate')} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();s().updateProperty(clip.id,'rotation',clamp(Number(clip.properties.rotation??0)+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?15:1),-360,360));}}}/>{(['nw','n','ne','e','se','s','sw','w'] as const).map(handle=>{const x=box.x+(handle.includes('e')?box.width:handle.includes('w')?0:box.width/2),y=box.y+(handle.includes('s')?box.height:handle.includes('n')?0:box.height/2);return <rect key={handle} x={x-handleSize/2} y={y-handleSize/2} width={handleSize} height={handleSize} className={`shape-handle shape-resize-${handle}`} role="button" tabIndex={0} aria-label={`Resize shape ${handle}`} onPointerDown={e=>begin(e,clip,handle)} onKeyDown={e=>{if(!e.key.startsWith('Arrow'))return;e.preventDefault();e.stopPropagation();const amount=e.shiftKey?10:1;s().updateShape(clip.id,{...doc,width:clamp(doc.width+(e.key==='ArrowRight'?amount:e.key==='ArrowLeft'?-amount:0)/width,.001,8),height:clamp(doc.height+(e.key==='ArrowDown'?amount:e.key==='ArrowUp'?-amount:0)/height,.001,8)});}}/>;})}</>}
          {edit&&doc.points.map((point,index)=>{
            const x=box.x+point.x*box.width,y=box.y+point.y*box.height;
            return <g key={index}>{selectedPoint===index&&(['in','out'] as const).map(side=>{const other=doc.points[(index+(side==='in'?-1:1)+doc.points.length)%doc.points.length],hx=box.x+(point[`${side}X`]??(point.x+(other.x-point.x)/3))*box.width,hy=box.y+(point[`${side}Y`]??(point.y+(other.y-point.y)/3))*box.height;return <g key={side}><line x1={x} y1={y} x2={hx} y2={hy} className="shape-curve-guide"/><circle cx={hx} cy={hy} r={handleSize*.6} className="shape-handle shape-curve-handle" role="button" tabIndex={0} aria-label={`Point ${index+1} ${side==='in'?'incoming':'outgoing'} curve`} onPointerDown={e=>begin(e,clip,side,index)} onKeyDown={e=>pointKey(e,clip,doc,index,side)}/></g>;})}<circle cx={x} cy={y} r={handleSize*.65} className={`shape-handle shape-point ${selectedPoint===index?'selected':''}`} role="button" tabIndex={0} aria-label={`Shape point ${index+1}`} onFocus={()=>setSelectedPoint(index)} onPointerDown={e=>begin(e,clip,'point',index)} onKeyDown={e=>pointKey(e,clip,doc,index,'point')}/></g>;
          })}</>}
      </g>;
    })}
    {guides.map((g,i)=><line key={i} className="snap-guide" x1={g.axis==='x'?g.at*width:0} y1={g.axis==='x'?0:g.at*height} x2={g.axis==='x'?g.at*width:width} y2={g.axis==='x'?height:g.at*height}/>)}
    {draft&&<path className="shape-draft" d={shapePath(draft,draft.width*width,draft.height*height)} transform={`translate(${draft.x*width} ${draft.y*height})`}/>}
    {pen.length>0&&<><path className="shape-draft" d={shapePath({...defaultShape('pen'),points:pen,closed:false},width,height)} fill="none"/>{pen.map((p,i)=><circle key={i} cx={p.x*width} cy={p.y*height} r={5*width/(root.current?.getBoundingClientRect().width||640)} className="shape-pen-point"/>)}</>}
  </svg>{tool&&<div className="shape-tool-hint">{tool==='pen'?<>Click to add points · Drag for curves · Click first point to close{pen.length>=2&&<button onClick={()=>finishPen(false)}>Finish open path</button>}</>:<>Drag to draw · Esc to cancel</>}</div>}{editing&&selectedShape&&<div className="shape-point-toolbar"><span>Drag points or curve handles · Shift links handles</span>{selectedPoint!==null&&<><button onClick={()=>{s().editShapePoint(editing,selectedPoint,'corner');}}>Corner</button><button disabled={getShape(selectedShape).points.length<=(getShape(selectedShape).closed?3:2)} onClick={()=>{s().editShapePoint(editing,selectedPoint,'delete');setSelectedPoint(null);}}>Delete point</button></>}<button onClick={()=>{setEditing(null);setSelectedPoint(null);}}>Done</button></div>}</div>;
}
