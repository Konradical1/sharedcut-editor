import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import type { Clip, Project, Timeline, Track, MediaAsset } from '../src/state/models.ts';
import { defaultShape } from '../src/services/shapes.ts';

test('export blurs layer movement with preserved alpha and unchanged source frames',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-motion-'));
 try {
  const width=128,height=64,project={id:'p',resolution:'128 × 64',fps:8} as Project;
  const timeline={id:'t',projectId:'p',name:'Motion',duration:1} as Timeline;
  const track={id:'v',timelineId:'t',name:'Video',number:1,kind:'video',muted:false,hidden:false,solo:false,locked:false,gain:0,pan:0} as Track;
  const shape:Clip={id:'c',projectId:'p',timelineId:'t',trackId:'v',mediaId:'frameline-shape',name:'Shape',start:0,duration:1,sourceIn:0,color:'#ffffff',disabled:false,effects:[],properties:{motionBlur:true,motionBlurStrength:100,shapeDocument:JSON.stringify({...defaultShape('rectangle'),x:.3125,y:.25,width:.375,height:.5,fill:'#ff0000',outlineWidth:0})},keyframes:{'properties.x':[{id:'a',time:0,value:-80,interpolation:'linear'},{id:'b',time:1,value:80,interpolation:'linear'}]}};
  const request:RenderRequest={project,timeline,tracks:[track],clips:[shape],assets:[],nodes:[],transparent:true,settings:{audio:'Disabled',codec:'Apple ProRes 4444',rangeIn:'.5',rangeOut:'.625'},outputPath:path.join(dir,'blur.mov')};
  await renderTimeline(request);
  const decode=async(file:string)=>(await run(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-i',file,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'],{binary:true}));
  const pixels=await decode(request.outputPath),pixel=(x:number,y:number)=>[...pixels.subarray((y*width+x)*4,(y*width+x)*4+4)];
  assert.ok(pixel(64,32)[0]>240&&pixel(64,32)[3]>245,`Solid centre stays opaque red: ${pixel(64,32)}`);
  assert.ok(pixel(36,32)[0]>230&&pixel(36,32)[3]>10&&pixel(36,32)[3]<240,`Trail keeps colour and partial alpha: ${pixel(36,32)}`);
  assert.ok(pixel(64,10)[3]<3,'Position blur does not soften perpendicular edges.');
  const scaling={...shape,keyframes:{'properties.zoom':[{id:'a',time:0,value:50,interpolation:'linear' as const},{id:'b',time:1,value:150,interpolation:'linear' as const}]}};
  const scalePath=path.join(dir,'scale.mov');await renderTimeline({...request,clips:[scaling],outputPath:scalePath});
  const scaled=await decode(scalePath);
  assert.ok(scaled[(32*width+39)*4+3]>5&&scaled[(32*width+39)*4+3]<245,'Scale blur spreads coverage beyond the current edge.');
  assert.ok(scaled[(32*width+64)*4+3]>245,'Scale blur retains solid interior coverage.');
  const edge={...shape,properties:{...shape.properties,shapeDocument:JSON.stringify({...defaultShape(),x:.5,y:.25,width:.2,height:.5,fill:'#ff0000'})},keyframes:{'shape.x':[{id:'a',time:0,value:.5,interpolation:'linear' as const},{id:'b',time:1,value:1.54,interpolation:'linear' as const}]}};
  const edgePath=path.join(dir,'edge.mov');await renderTimeline({...request,clips:[edge],outputPath:edgePath});
  const edgePixels=await decode(edgePath);assert.ok(edgePixels[(32*width+126)*4+3]>10,'A graphic just outside the frame retains its visible shutter trail.');
  const source=createCanvas(width,height),context=source.getContext('2d');context.fillStyle='#00ff00';context.fillRect(0,0,width,height);for(let i=0;i<8;i++){context.fillStyle=i===4?'#00ff00':'#0000ff';context.fillRect(0,0,width,height);await writeFile(path.join(dir,`source-${i}.png`),await source.encode('png'));}
  const video=path.join(dir,'source.mkv');await run(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-y','-framerate','8','-i',path.join(dir,'source-%d.png'),'-t','1','-c:v','ffv1',video]);
  const asset={id:'media',projectId:'p',name:'Video',kind:'video',duration:1,resolution:'128 × 64',fps:8,hasAudio:false} as MediaAsset;
  const moving={...shape,mediaId:'media',properties:{motionBlur:true,motionBlurStrength:100,zoom:50}};
  const movingPath=path.join(dir,'moving.mov');
  await renderTimeline({...request,clips:[moving],assets:[{asset,path:video}],outputPath:movingPath});
  const movingPixels=await decode(movingPath);
  const centre=(32*width+64)*4;
  assert.ok(movingPixels[centre+1]>240&&movingPixels[centre]<10,'The source frame stays green while the layer moves.');
  assert.ok(movingPixels[centre+2]<10,'Adjacent blue source frames do not enter the shutter exposure.');
  const still={...shape,mediaId:'media',properties:{motionBlur:true},keyframes:undefined};
  for(const enabled of [false,true])await renderTimeline({...request,clips:[{...still,properties:{motionBlur:enabled}}],assets:[{asset,path:video}],outputPath:path.join(dir,`${enabled}.mov`)});
  assert.deepEqual(await decode(path.join(dir,'true.mov')),await decode(path.join(dir,'false.mov')),'Enabling motion blur cannot alter stationary footage.');
 }finally{await rm(dir,{recursive:true,force:true});}
});
