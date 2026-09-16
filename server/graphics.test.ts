import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import type { Clip, Project, Track, Timeline, MediaAsset } from '../src/state/models.ts';
import { defaultShape } from '../src/services/shapes.ts';
import { presetDocument } from '../src/services/text.ts';
import { renderTimeline, type RenderRequest } from './media.ts';

const exec=promisify(execFile);
const ff=(args:string[])=>exec(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-y',...args],{encoding:'buffer',maxBuffer:4e6});
const project={id:'p',resolution:'64 × 64',fps:8} as Project;
const timeline=(id:string,duration=1):Timeline=>({id,projectId:'p',name:id,duration});
const track=(id:string,timelineId:string,number=1,kind:'video'|'audio'='video'):Track=>({id,timelineId,name:id,number,kind,muted:false,hidden:false,solo:false,locked:false,gain:0,pan:0});
const clip=(id:string,timelineId:string,trackId:string,mediaId:string,properties:Clip['properties']={}):Clip=>({id,projectId:'p',timelineId,trackId,mediaId,name:id,start:0,duration:1,sourceIn:0,disabled:false,color:'#ffffff',properties,effects:[]});
const asset=(id:string,kind:'image'|'audio'):MediaAsset=>({id,projectId:'p',name:id,kind,binId:'',thumbnail:'',duration:1,resolution:'64 × 64',fps:0,size:'',status:'ready',progress:100,hasAudio:kind==='audio'});

test('nested compositions preserve alpha, parent transforms, source trims, and audio gain',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-composition-check-'));
 try {
  const red=path.join(dir,'red.png'),tone=path.join(dir,'tone.wav');
  const canvas=createCanvas(64,64),ctx=canvas.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,64,64);await writeFile(red,await canvas.encode('png'));
  await ff(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-ac','2',tone]);
  const shape=clip('shape','inner','iv','frameline-shape',{rotation:90,shapeDocument:JSON.stringify({...defaultShape(),x:.125,y:.25,width:.25,height:.5,fill:'#0000ff'})});
  const sound=clip('sound','inner','ia','tone',{gain:-6});sound.start=.25;sound.duration=.5;
  const inner=clip('inner-parent','middle','mv','frameline-composition',{compositionId:'inner',x:8,gain:-6});
  const outer=clip('outer-parent','main','over','frameline-composition',{compositionId:'middle',x:8,opacity:50,gain:-6});outer.sourceIn=.25;outer.duration=.5;
  const request:RenderRequest={project:{...project,fps:24},timeline:timeline('main',.5),timelines:[timeline('main',.5),timeline('middle'),timeline('inner')],tracks:[track('base','main'),track('over','main',2),track('mv','middle'),track('iv','inner'),track('ia','inner',1,'audio')],clips:[{...clip('red','main','base','red'),duration:.5},outer,inner,shape,sound],assets:[{asset:asset('red','image'),path:red},{asset:asset('tone','audio'),path:tone}],nodes:[],settings:{codec:'Apple ProRes 4444',audio:'Linear PCM · 24-bit · 48 kHz'},outputPath:path.join(dir,'result.mov')};
  await renderTimeline(request);
  const pixels=(await ff(['-i',request.outputPath,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  const rgb=(x:number,y:number)=>[...pixels.subarray((y*64+x)*3,(y*64+x)*3+3)];
  assert.ok(rgb(3,3)[0]>245&&rgb(3,3)[2]<8,`Transparent corners preserve the red background: ${rgb(3,3)}`);
  assert.ok(rgb(30,30)[0]>110&&rgb(30,30)[0]<145&&rgb(30,30)[2]>110,`Parent opacity composites once after both position offsets: ${rgb(30,30)}`);
  assert.ok(rgb(42,30)[2]>110,'Shape rotation uses its own center before parent transforms.');
  assert.ok(rgb(12,30)[0]>245&&rgb(12,30)[2]<8,'Nested transforms move the original shape position.');
  const pcm=(await ff(['-i',request.outputPath,'-map','0:a','-f','f32le','-ac','1','pipe:1'])).stdout;
  const samples=new Float32Array(pcm.buffer.slice(pcm.byteOffset,pcm.byteOffset+pcm.length));
  const rms=Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);
  assert.ok(rms>.005&&rms<.013,`Composition audio survives source trim and three -6 dB gains: ${rms}`);
  assert.equal(samples.length,24000,'Nested audio ends at the outer composition trim.');
  const animated={...shape,keyframes:{'properties.opacity':[{id:'zero',time:0,value:0,interpolation:'linear' as const},{id:'full',time:.5,value:100,interpolation:'linear' as const}]}};
  const blurred={...outer,sourceIn:0,effects:[{id:'blur',name:'Gaussian blur',enabled:true,amount:100,parameters:{radius:4}}]};
  const moving={...request,clips:request.clips.map(c=>c.id===shape.id?animated:c.id===outer.id?blurred:c),outputPath:path.join(dir,'animated.mov')};
  await renderTimeline(moving);
  const frames=(await ff(['-i',moving.outputPath,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout,size=64*64*3,last=frames.length-size;
  assert.ok(frames[2]<8,'Nested animation begins fully transparent.');
  assert.ok(frames[last+(30*64+30)*3+2]>70,`Nested keyframes survive transparent baking and the parent blur: ${frames[last+(30*64+30)*3+2]}, frame bytes ${frames.length}`);
  assert.ok(frames[last+(30*64+13)*3+2]>5,`Gaussian blur spreads the composition alpha beyond the shape edge: ${frames[last+(30*64+13)*3+2]}`);
  const animatedPcm=(await ff(['-i',moving.outputPath,'-map','0:a','-f','f32le','-ac','1','pipe:1'])).stdout;
  const animatedSamples=new Float32Array(animatedPcm.buffer.slice(animatedPcm.byteOffset,animatedPcm.byteOffset+animatedPcm.length));
  assert.equal(animatedSamples.length,24000,'Animation preserves sample-accurate composition duration.');
  assert.ok(animatedSamples.subarray(0,12000).every(v=>Math.abs(v)<.0001),`Animated composition audio retains its source start: onset ${animatedSamples.findIndex(v=>Math.abs(v)>.0001)}, samples ${animatedSamples.length}`);
  assert.ok(Math.sqrt(animatedSamples.subarray(12000).reduce((sum,v)=>sum+v*v,0)/12000)>.005,'Animated compositions retain continuous audio at 24 fps.');
  await assert.rejects(renderTimeline({...request,clips:request.clips.map(c=>c.id===shape.id?{...c,properties:{shapeDocument:JSON.stringify({...defaultShape(),width:9})}}:c)}),/shape size/i);
  await assert.rejects(renderTimeline({...request,clips:[...request.clips,{...shape,mediaId:'frameline-composition',properties:{compositionId:'main'}}]}),/cycle/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('typing renders deterministically without requiring a keyframe channel',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-typing-check-'));
 try {
  const doc=presetDocument();
  Object.assign(doc,{x:0,y:0,width:1,height:1,typingEnabled:true,typingSpeed:8,typingRandomness:0,typingCursor:false});
  doc.runs=[{text:'HI',style:{...doc.runs[0].style,fontFamily:GlobalFonts.has('Arial')?'Arial':GlobalFonts.families[0].family,fontSize:30,color:'#ffffff'}}];
  const request:RenderRequest={project,timeline:timeline('main',.5),tracks:[track('v','main')],clips:[{...clip('typing','main','v','frameline-title',{textDocument:JSON.stringify(doc)}),duration:.5}],assets:[],nodes:[],settings:{audio:'Disabled'},outputPath:path.join(dir,'typing.mp4')};
  await renderTimeline(request);
  const pixels=(await ff(['-i',request.outputPath,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  const size=64*64*3;
  assert.equal(pixels.length,4*size);
  assert.ok(pixels.subarray(0,size).every(v=>v<10),'Typing starts empty.');
  assert.ok(pixels.subarray(3*size).some(v=>v>180),'Typing reveals glyphs by the final frame.');
  const slowed={...request,outputPath:path.join(dir,'typing-speed.mp4'),clips:request.clips.map(c=>({...c,keyframes:{'text.typingSpeed':[{id:'fast',time:0,value:8,interpolation:'hold' as const},{id:'slow',time:.25,value:1,interpolation:'hold' as const}],'text.typingRandomness':[{id:'steady',time:0,value:0,interpolation:'hold' as const},{id:'random',time:.25,value:100,interpolation:'hold' as const}]}}))};
  await renderTimeline(slowed);
  const slowPixels=(await ff(['-i',slowed.outputPath,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  const visible=Array.from({length:4},(_,i)=>slowPixels.subarray(i*size,(i+1)*size).filter(v=>v>180).length);
  assert.ok(visible[1]>0&&visible[3]>=visible[1],'Animated typing speed and randomness preserve already revealed glyphs in export.');
 } finally {await rm(dir,{recursive:true,force:true});}
});
