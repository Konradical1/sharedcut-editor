import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import type { Clip, Keyframe } from '../state/models.ts';
import { evaluateClip, trimAnimation } from './animation.ts';
import { transformMotion, drawMotionBlur, validateMotionBlur } from './motionBlur.ts';
import { defaultShape } from './shapes.ts';
import { presetDocument } from './text.ts';
const keys=(a:number,b:number):Keyframe[]=>[{id:'a',time:0,value:a,interpolation:'linear'},{id:'b',time:1,value:b,interpolation:'linear'}];
const base:Clip={id:'c',projectId:'p',timelineId:'t',trackId:'v',mediaId:'image',name:'Test',start:0,duration:2,sourceIn:0,color:'#ffffff',disabled:false,effects:[],properties:{motionBlur:true,motionBlurStrength:100},keyframes:{'properties.x':keys(-100,100)}};
const sample=(clip=base,time=.5)=>transformMotion(evaluateClip(clip,time),time,24,1920,1080);
test('shutter samples only moving geometry; static, disabled, zero strength, holds, stops and trim timing stay sharp',()=>{
 const poses=sample();assert.ok(poses.length>1);assert.ok(poses[0].x<0&&poses.at(-1)!.x>0);assert.ok(Math.abs(poses.reduce((n,p)=>n+p.x,0))<1e-8);
 for(const clip of ([{...base,keyframes:undefined},{...base,properties:{motionBlur:false}},{...base,properties:{motionBlur:true,motionBlurStrength:0}},{...base,keyframes:{'properties.opacity':keys(0,100),'properties.rotation':keys(0,90)}}] as Clip[]))assert.equal(sample(clip).length,1);
 assert.equal(sample(base,1.5).length,1);
 const hold={...base,keyframes:{'properties.x':keys(0,100).map(k=>({...k,interpolation:'hold' as const}))}};
 assert.equal(sample(hold,.999).length,1);assert.equal(sample(hold,1).length,1);
 const trimmed={...base,...trimAnimation(base,.25),start:.25,duration:1.75};assert.ok(sample(trimmed).every((p,i)=>Math.abs(p.x-poses[i].x)<1e-9));
 const fast={...base,keyframes:{'properties.x':keys(-10000,10000)},properties:{...base.properties,motionBlurSamples:64}};assert.equal(sample(fast).length,64);
 assert.throws(()=>validateMotionBlur({...base,properties:{motionBlurStrength:Infinity}}));assert.throws(()=>validateMotionBlur({...base,properties:{motionBlur:'yes'}}));
});
test('text position and shape size use the frozen current artwork, with position and scale in the same shutter',()=>{
 const title={...base,mediaId:'frameline-title',properties:{...base.properties,textDocument:JSON.stringify(presetDocument())},keyframes:{'text.x':keys(0,1)}};
 const text=sample(title);assert.ok(text.at(-1)!.x-text[0].x>60);assert.ok(text.every(p=>p.scaleX===1));
 const shape={...base,mediaId:'frameline-shape',properties:{...base.properties,shapeDocument:JSON.stringify(defaultShape())},keyframes:{'shape.width':keys(.1,.5),'properties.zoom':keys(50,150)}};
 const size=sample(shape);assert.ok(size[0].scaleX<1&&size.at(-1)!.scaleX>1);assert.ok(size[0].scaleY<1&&size.at(-1)!.scaleY>1);
});
test('additive shutter preserves opaque interiors, coloured transparent edges and a crisp static layer',()=>{
 const source=createCanvas(128,64),ctx=source.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(40,16,48,32);
 const clip={...base,keyframes:{'properties.x':keys(-240,240)}};
 const poses=transformMotion(evaluateClip(clip,.5),.5,24,128,64),output=createCanvas(128,64),target=output.getContext('2d'),scratch=createCanvas(128,64).getContext('2d') as unknown as CanvasRenderingContext2D;
 drawMotionBlur(target as unknown as CanvasRenderingContext2D,source as unknown as CanvasImageSource,poses,clip,128,64,128,64,scratch);
 const pixel=(x:number,y:number)=>[...target.getImageData(x,y,1,1).data];
 assert.ok(pixel(64,32)[3]>=250,`Opaque centre: ${pixel(64,32)}`);assert.ok(pixel(37,32)[0]>245&&pixel(37,32)[3]>0&&pixel(37,32)[3]<255,`Coloured trail: ${pixel(37,32)}`);assert.equal(pixel(64,10)[3],0,'Horizontal travel does not blur vertically.');
 ctx.fillStyle='#a9b9ff';ctx.fillRect(40,16,48,32);
 for(const count of [8,16,32,64]){
   const samples=Array.from({length:count},(_,i)=>({...poses[0],x:-8+16*i/count}));
   drawMotionBlur(target as unknown as CanvasRenderingContext2D,source as unknown as CanvasImageSource,samples,clip,128,64,128,64,scratch);
   assert.ok(pixel(64,32).every((v,i)=>Math.abs(v-[169,185,255,255][i])<=3),`Colour stays unchanged at ${count} samples: ${pixel(64,32)}`);
 }

});
test('Scale X/Y stretch in the clip axes before rotation, about the anchor; an unstretched pose is unchanged',()=>{
 const still=(properties:Clip['properties'])=>transformMotion({...base,keyframes:undefined,properties},0,24,1920,1080)[0];
 const pose=still({x:10,y:20,zoom:150,scaleX:200,scaleY:50,rotation:90,anchorX:100,anchorY:40});
 const near=(a:number,b:number)=>Math.abs(a-b)<1e-9;
 assert.ok(near(pose.x,140)&&near(pose.y,-240)&&pose.scaleX===3&&pose.scaleY===.75,JSON.stringify(pose));
 // The anchor point (100, 40 from the centre) stays put at position + anchor.
 const c=Math.cos(pose.rotation),s=Math.sin(pose.rotation);
 assert.ok(near(pose.x+c*pose.scaleX*100-s*pose.scaleY*40,110)&&near(pose.y+s*pose.scaleX*100+c*pose.scaleY*40,60));
 // Bit for bit what the pose was before Scale X/Y existed: C + X + A + zoom·R·(−A).
 const p={x:-37,y:12.5,zoom:137,rotation:21,anchorX:300,anchorY:-40},r=21*Math.PI/180,z=1.37;
 const old={x:-37+300+z*(Math.cos(r)*-300-Math.sin(r)*40),y:12.5-40+z*(Math.sin(r)*-300+Math.cos(r)*40),scaleX:z,scaleY:z,rotation:r};
 assert.deepEqual(still(p),old);assert.deepEqual(still({...p,scaleX:100,scaleY:100}),old);
 const keyed={...base,keyframes:{'properties.scaleX':keys(100,300)}};
 assert.ok(sample(keyed).length>1&&sample(keyed).every(q=>q.scaleY===1),'a keyed stretch gets shutter samples on its own axis');
});
