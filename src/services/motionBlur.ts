import type { Clip } from '../state/models.ts';
import { boundedAnimationValue, sampleKeyframes } from './animation.ts';
import { getShape, isShape } from './shapes.ts';
import { getText, isTitle } from './text.ts';

export type MotionPose = { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
const paths = ['properties.x','properties.y','properties.zoom','properties.scaleX','properties.scaleY','text.x','text.y','shape.x','shape.y','shape.width','shape.height'];
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min,Math.min(max,value)) : fallback;
export function validateMotionBlur(clip: Clip) {
  const p=clip.properties;
  if(p.motionBlur!==undefined&&typeof p.motionBlur!=='boolean')throw new Error('Invalid motion blur toggle.');
  for(const [key,min,max] of [['motionBlurStrength',0,100],['motionBlurSamples',8,64]] as const)if(p[key]!==undefined&&(typeof p[key]!=='number'||!Number.isFinite(p[key])||Number(p[key])<min||Number(p[key])>max))throw new Error(`Invalid ${key}.`);
}

/** Sample only geometry. Footage, text content, effects, rotation and opacity stay at the current frame. */
export function transformMotion(clip: Clip, time: number, fps: number, width: number, height: number): MotionPose[] {
  const p=clip.properties,shape=isShape(clip)?getShape(clip):undefined,text=isTitle(clip)?getText(clip):undefined;
  const local=time-clip.start,rotation=Number(p.rotation??0)*Math.PI/180,c=Math.cos(rotation),s=Math.sin(rotation);
  const value=(path:string,t:number,fallback:number)=>{const keys=clip.keyframes?.[path];return keys?.length?Number(boundedAnimationValue(path,sampleKeyframes(keys,t))):fallback;};
  const pose=(t:number,centred=false):MotionPose=>{
    const zoom=value('properties.zoom',t,Number(p.zoom??100))/100,kx=value('properties.scaleX',t,Number(p.scaleX??100))/100,ky=value('properties.scaleY',t,Number(p.scaleY??100))/100;
    const sx=shape?value('shape.width',t,shape.width)/shape.width:1,sy=shape?value('shape.height',t,shape.height)/shape.height:1;
    const doc=shape??text,prefix=shape?'shape':'text';
    const bx=doc?(centred&&doc.width<=1?(1-doc.width)/2:doc.x):0,by=doc?(centred&&doc.height<=1?(1-doc.height)/2:doc.y):0;
    const dx=doc?value(`${prefix}.x`,t,doc.x)-bx*sx:0,dy=doc?value(`${prefix}.y`,t,doc.y)-by*sy:0;
    const ax=Number(p.anchorX??0)+(shape?(value('shape.x',t,shape.x)+value('shape.width',t,shape.width)/2-.5)*width:0);
    const ay=Number(p.anchorY??0)+(shape?(value('shape.y',t,shape.y)+value('shape.height',t,shape.height)/2-.5)*height:0);
    const lx=((sx-1)/2+dx)*width-ax,ly=((sy-1)/2+dy)*height-ay;
    return {x:value('properties.x',t,Number(p.x??0))+ax+zoom*(c*kx*lx-s*ky*ly),y:value('properties.y',t,Number(p.y??0))+ay+zoom*(s*kx*lx+c*ky*ly),scaleX:zoom*kx*sx,scaleY:zoom*ky*sy,rotation};
  };
  const current=pose(local),strength=bounded(p.motionBlurStrength,50,0,100);
  if(p.motionBlur!==true||!strength||!paths.some(path=>clip.keyframes?.[path]?.length))return [current];
  const exposure=strength/100/Math.max(1,fps);
  let start=Math.max(0,local-exposure/2),end=Math.min(clip.duration,local+exposure/2);
  // A hold key is a cut, not physical travel. Never smear across that discontinuity.
  for(const path of paths){const keys=clip.keyframes?.[path]??[];for(let i=1;i<keys.length;i++)if(keys[i-1].interpolation==='hold'){const cut=keys[i].time;if(cut<=local)start=Math.max(start,cut);else end=Math.min(end,cut);}}
  if(end<=start)return [current];
  const first=pose(start),last=pose(end-1e-10),middle=pose((start+end)/2);
  const distance=(a:MotionPose,b:MotionPose)=>Math.hypot(a.x-b.x,a.y-b.y)+Math.hypot((a.scaleX-b.scaleX)*width,(a.scaleY-b.scaleY)*height)/2;
  const travel=distance(first,middle)+distance(middle,last);
  if(travel<.01)return [current];
  // ponytail: bounded spatial supersampling; an analytic shutter integrator is the upgrade for extreme travel.
  const count=Math.min(Math.round(bounded(p.motionBlurSamples,32,8,64)),Math.max(8,2**Math.ceil(Math.log2(Math.max(1,travel)))));
  return Array.from({length:count},(_,i)=>pose(start+(i+.5)*(end-start)/count,true));
}

export function drawMotionPose(target:CanvasRenderingContext2D, source:CanvasImageSource, pose:MotionPose, clip:Clip, width:number,height:number,projectWidth:number,projectHeight:number) {
  target.save();
  target.translate(width/2+pose.x*width/projectWidth,height/2+pose.y*height/projectHeight);
  target.rotate(pose.rotation);target.scale(pose.scaleX,pose.scaleY);target.translate(-width/2,-height/2);
  const p=clip.properties,left=Number(p.cropLeft??0)*width/projectWidth,top=Number(p.cropTop??0)*height/projectHeight;
  target.beginPath();target.rect(left,top,Math.max(0,width-left-Number(p.cropRight??0)*width/projectWidth),Math.max(0,height-top-Number(p.cropBottom??0)*height/projectHeight));target.clip();
  target.drawImage(source,0,0,width,height);target.restore();
}

/** Keep moving graphics on the source canvas until after shutter transforms, including at frame edges. */
export function motionArtwork(clip:Clip):Clip {
  const doc=isShape(clip)?getShape(clip):isTitle(clip)?getText(clip):undefined;
  if(!doc)return clip;
  return {...clip,properties:{...clip.properties,[isShape(clip)?'shapeDocument':'textDocument']:JSON.stringify({...doc,x:doc.width<=1?(1-doc.width)/2:doc.x,y:doc.height<=1?(1-doc.height)/2:doc.y})}};
}

/** Accurate software fallback; accumulate premultiplied channels before quantizing once. */
export function drawMotionBlur(target:CanvasRenderingContext2D,source:CanvasImageSource,poses:MotionPose[],clip:Clip,width:number,height:number,projectWidth:number,projectHeight:number,scratch:CanvasRenderingContext2D) {
  const sum=new Float32Array(width*height*4);
  for(const pose of poses){
    scratch.clearRect(0,0,width,height);drawMotionPose(scratch,source,pose,clip,width,height,projectWidth,projectHeight);
    const pixels=scratch.getImageData(0,0,width,height).data;
    for(let i=0;i<pixels.length;i+=4){const alpha=pixels[i+3]/255;sum[i]+=pixels[i]*alpha;sum[i+1]+=pixels[i+1]*alpha;sum[i+2]+=pixels[i+2]*alpha;sum[i+3]+=alpha;}
  }
  const image=target.createImageData(width,height);
  for(let i=0;i<sum.length;i+=4){const alpha=sum[i+3];if(alpha){image.data[i]=sum[i]/alpha;image.data[i+1]=sum[i+1]/alpha;image.data[i+2]=sum[i+2]/alpha;image.data[i+3]=255*alpha/poses.length;}}
  target.putImageData(image,0,0);
}
