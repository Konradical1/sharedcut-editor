import type { Clip } from '../state/models.ts';

export const shapeKinds = ['rectangle','rounded','ellipse','triangle','polygon','star','line','arrow','chevron','pen'] as const;
export type ShapeKind = typeof shapeKinds[number];
export interface ShapePoint { x:number; y:number; inX?:number; inY?:number; outX?:number; outY?:number }
export interface ShapeDocument {
  kind:ShapeKind; x:number; y:number; width:number; height:number;
  fill:string; fillMode:'solid'|'linear'; gradientEnd:string; gradientAngle:number; opacity:number; fillOpacity:number;
  outlineColor:string; outlineWidth:number; shadowColor:string; shadowOpacity:number; shadowBlur:number; shadowX:number; shadowY:number;
  cornerRadius:number; closed:boolean; points:ShapePoint[];
}
export function defaultShape(kind:string='rectangle'):ShapeDocument {
  return {kind:shapeKinds.includes(kind as ShapeKind)?kind as ShapeKind:'rectangle',x:.3,y:.3,width:.4,height:.4,fill:'#a9b9ff',fillMode:'solid',gradientEnd:'#eea6db',gradientAngle:45,opacity:100,fillOpacity:100,outlineColor:'#ffffff',outlineWidth:kind==='line'?10:0,shadowColor:'#000000',shadowOpacity:0,shadowBlur:24,shadowX:0,shadowY:12,cornerRadius:32,closed:kind!=='line',points:[]};
}
export const isShape=(clip:Clip)=>clip.mediaId==='frameline-shape'||typeof clip.properties.shapeDocument==='string';
export function getShape(clip:Clip):ShapeDocument {
  try { const doc=JSON.parse(String(clip.properties.shapeDocument));validateShape(doc);return doc; } catch { return defaultShape(); }
}
export function validateShape(value:unknown):asserts value is ShapeDocument {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid shape.');
  const doc=value as ShapeDocument;
  const finite=(n:unknown,min:number,max:number)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
  if(!shapeKinds.includes(doc.kind)||!['solid','linear'].includes(doc.fillMode)||typeof doc.closed!=='boolean'||!Array.isArray(doc.points)||doc.points.length>1000)throw new Error('Invalid shape path.');
  for(const key of ['fill','gradientEnd','outlineColor','shadowColor'] as const)if(typeof doc[key]!=='string'||!/^#[a-f\d]{6}$/i.test(doc[key]))throw new Error('Invalid shape color.');
  for(const key of ['x','y'] as const)if(!finite(doc[key],-4,4))throw new Error('Invalid shape position.');
  for(const key of ['width','height'] as const)if(!finite(doc[key],.001,8))throw new Error('Invalid shape size.');
  for(const key of ['opacity','shadowOpacity','fillOpacity'] as const)if(!finite(doc[key],0,100))throw new Error('Invalid shape opacity.');
  for(const key of ['outlineWidth','shadowBlur','cornerRadius'] as const)if(!finite(doc[key],0,600))throw new Error('Invalid shape appearance.');
  for(const key of ['shadowX','shadowY','gradientAngle'] as const)if(!finite(doc[key],-2000,2000))throw new Error('Invalid shape offset.');
  for(const p of doc.points){
    if(!p||!finite(p.x,-8,8)||!finite(p.y,-8,8))throw new Error('Invalid path point.');
    for(const axis of ['in','out'] as const)if((p[`${axis}X`]!==undefined||p[`${axis}Y`]!==undefined)&&(!finite(p[`${axis}X`],-8,8)||!finite(p[`${axis}Y`],-8,8)))throw new Error('Invalid curve handle.');
  }
}

type Command=['M'|'L',number,number]|['C',number,number,number,number,number,number]|['Z'];
function commands(doc:ShapeDocument,w:number,h:number):Command[] {
  const polygon=(points:number[][]):Command[]=>[...points.map(([x,y],i)=>[i?'L':'M',x*w,y*h] as Command),['Z']];
  switch(doc.kind){
    case 'ellipse':{const k=.5522847498,rx=w/2,ry=h/2;return [['M',rx,0],['C',rx+k*rx,0,w,ry-k*ry,w,ry],['C',w,ry+k*ry,rx+k*rx,h,rx,h],['C',rx-k*rx,h,0,ry+k*ry,0,ry],['C',0,ry-k*ry,rx-k*rx,0,rx,0],['Z']];}
    case 'rounded':{const r=Math.min(doc.cornerRadius,w/2,h/2),k=.5522847498;return [['M',r,0],['L',w-r,0],['C',w-r+k*r,0,w,r-k*r,w,r],['L',w,h-r],['C',w,h-r+k*r,w-r+k*r,h,w-r,h],['L',r,h],['C',r-k*r,h,0,h-r+k*r,0,h-r],['L',0,r],['C',0,r-k*r,r-k*r,0,r,0],['Z']];}
    case 'triangle':return polygon([[.5,0],[1,1],[0,1]]);
    case 'polygon':return polygon(Array.from({length:6},(_,i)=>[.5+.5*Math.cos(i*Math.PI/3),.5+.5*Math.sin(i*Math.PI/3)]));
    case 'star':return polygon(Array.from({length:10},(_,i)=>[.5+(i%2?.22:.5)*Math.cos(i*Math.PI/5-Math.PI/2),.5+(i%2?.22:.5)*Math.sin(i*Math.PI/5-Math.PI/2)]));
    case 'line':return [['M',0,h/2],['L',w,h/2]];
    case 'arrow':return polygon([[0,.32],[.6,.32],[.6,0],[1,.5],[.6,1],[.6,.68],[0,.68]]);
    case 'chevron':return polygon([[0,0],[.65,0],[1,.5],[.65,1],[0,1],[.35,.5]]);
    case 'pen':{
      if(!doc.points.length)return [];
      const result:Command[]=[['M',doc.points[0].x*w,doc.points[0].y*h]];
      for(let i=1;i<doc.points.length+(doc.closed?1:0);i++){
        const a=doc.points[i-1],b=doc.points[i%doc.points.length];
        result.push(a.outX!==undefined||b.inX!==undefined?['C',(a.outX??a.x)*w,(a.outY??a.y)*h,(b.inX??b.x)*w,(b.inY??b.y)*h,b.x*w,b.y*h]:['L',b.x*w,b.y*h]);
      }
      if(doc.closed)result.push(['Z']);return result;
    }
    default:return polygon([[0,0],[1,0],[1,1],[0,1]]);
  }
}
export const shapePath=(doc:ShapeDocument,width:number,height:number)=>commands(doc,width,height).map(c=>c.join(' ')).join(' ');
type ShapeCanvas=Pick<CanvasRenderingContext2D,'save'|'restore'|'scale'|'translate'|'beginPath'|'moveTo'|'lineTo'|'bezierCurveTo'|'closePath'|'fill'|'stroke'|'createLinearGradient'|'fillStyle'|'strokeStyle'|'lineWidth'|'lineJoin'|'lineCap'|'globalAlpha'|'shadowColor'|'shadowBlur'|'shadowOffsetX'|'shadowOffsetY'>;
export function drawShape(ctx:ShapeCanvas,doc:ShapeDocument,width:number,height:number,projectWidth=width,projectHeight=height){
  ctx.save();ctx.scale(width/projectWidth,height/projectHeight);ctx.translate(doc.x*projectWidth,doc.y*projectHeight);
  ctx.globalAlpha*=doc.opacity/100;
  const w=doc.width*projectWidth,h=doc.height*projectHeight;
  ctx.beginPath();for(const c of commands(doc,w,h)){if(c[0]==='M')ctx.moveTo(c[1],c[2]);else if(c[0]==='L')ctx.lineTo(c[1],c[2]);else if(c[0]==='C')ctx.bezierCurveTo(c[1],c[2],c[3],c[4],c[5],c[6]);else ctx.closePath();}
  ctx.fillStyle=doc.fill;
  if(doc.fillMode==='linear'){
    const angle=doc.gradientAngle*Math.PI/180,dx=Math.cos(angle)*w/2,dy=Math.sin(angle)*h/2;
    const gradient=ctx.createLinearGradient(w/2-dx,h/2-dy,w/2+dx,h/2+dy);gradient.addColorStop(0,doc.fill);gradient.addColorStop(1,doc.gradientEnd);ctx.fillStyle=gradient;
  }
  ctx.shadowColor=`${doc.shadowColor}${Math.round(doc.shadowOpacity*2.55).toString(16).padStart(2,'0')}`;
  ctx.shadowBlur=doc.shadowBlur*width/projectWidth;ctx.shadowOffsetX=doc.shadowX*width/projectWidth;ctx.shadowOffsetY=doc.shadowY*height/projectHeight;
  if(doc.closed&&doc.kind!=='line'){const alpha=ctx.globalAlpha;ctx.globalAlpha*=doc.fillOpacity/100;ctx.fill();ctx.globalAlpha=alpha;}
  if(doc.outlineWidth>0){if(doc.closed&&doc.kind!=='line'&&doc.fillOpacity>0)ctx.shadowColor='transparent';ctx.lineWidth=doc.outlineWidth;ctx.strokeStyle=doc.outlineColor;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();}
  ctx.restore();
}

export function fitPenPoints(points:ShapePoint[],closed:boolean):ShapeDocument {
  if(points.length<2)throw new Error('A path needs at least two points.');
  const xs=points.flatMap(p=>[p.x,p.inX??p.x,p.outX??p.x]),ys=points.flatMap(p=>[p.y,p.inY??p.y,p.outY??p.y]),x=Math.min(...xs),y=Math.min(...ys),width=Math.max(.001,Math.max(...xs)-x),height=Math.max(.001,Math.max(...ys)-y);
  return {...defaultShape('pen'),x,y,width,height,closed,outlineWidth:closed?0:6,points:points.map(p=>({x:(p.x-x)/width,y:(p.y-y)/height,...(p.inX!==undefined?{inX:(p.inX-x)/width,inY:(p.inY!-y)/height}:{}),...(p.outX!==undefined?{outX:(p.outX-x)/width,outY:(p.outY!-y)/height}:{})}))};
}
