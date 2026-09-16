import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderOpticalFlow, flowWorker } from './opticalFlow.ts';
import { run, probeMedia, renderTimeline } from './media.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';

test('Mac optical flow synthesizes motion, caches atomically, preserves duration and exports originals', {skip:process.platform!=='darwin',timeout:120000}, async()=>{
  await flowWorker();
  const directory=await mkdtemp(join(tmpdir(),'frameline-flow-check-'));
  try {
    const raw=Buffer.alloc(320*180*3*12);
    for(let frame=0;frame<12;frame++)for(let y=60;y<120;y++)for(let x=30+frame*10;x<90+frame*10;x++)raw.fill(230,(frame*320*180+y*320+x)*3,(frame*320*180+y*320+x)*3+3);
    const inputRaw=join(directory,'source.rgb'),input=join(directory,'original');await writeFile(inputRaw,raw);
    await run('ffmpeg',['-v','error','-f','rawvideo','-pix_fmt','rgb24','-s','320x180','-r','12','-i',inputRaw,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-shortest','-c:a','aac','-c:v','libx264','-crf','10','-f','mp4',input]);
    const asset={id:'source',projectId:'project',kind:'video',name:'Motion',duration:1,fps:12,hasAudio:true,inputProfile:'Rec.709'} as MediaAsset;
    const clip={id:'clip',projectId:'project',timelineId:'timeline',trackId:'track',mediaId:'source',name:'Slow',color:'#95b6a7',start:0,duration:2,sourceIn:0,disabled:false,properties:{speed:50,opticalFlow:true},effects:[]} as Clip;
    const options={clip,asset,input,directory,fps:24};
    const first=await renderOpticalFlow(options),before=await stat(first.output);
    const second=await renderOpticalFlow(options);assert.equal(first.key,second.key);assert.equal((await stat(second.output)).mtimeMs,before.mtimeMs);
    const metadata=await probeMedia(first.output);assert.equal(metadata.fps,24);assert.ok(Math.abs(metadata.duration-2)<.01);
    const picture=await run('ffmpeg',['-v','error','-i',first.output,'-frames:v','4','-pix_fmt','gray','-f','rawvideo','pipe:1'],{binary:true});
    const centers=Array.from({length:4},(_,frame)=>{let sum=0,weight=0;for(let y=65;y<115;y++)for(let x=0;x<320;x++){const value=Math.max(0,picture[frame*320*180+y*320+x]-30);sum+=x*value;weight+=value;}return sum/weight;});
    assert.ok(centers[1]>centers[0]+.5&&centers[1]<centers[0]+5,`Intermediate motion, not duplicate frames: ${centers}`);
    const outputPath=join(directory,'export.mp4');
    await renderTimeline({project:{id:'project',fps:24,resolution:'320 × 180'} as Project,timeline:{id:'timeline',projectId:'project',duration:2,name:'test'},tracks:[{id:'track',timelineId:'timeline',kind:'video',number:1,gain:0,pan:0} as Track],clips:[clip],nodes:[],assets:[{asset,path:input}],settings:{codec:'H.264',audio:'Disabled'},outputPath});
    assert.ok(Math.abs((await probeMedia(outputPath)).duration-2)<.05);
    const audioPath=join(directory,'audio-export.mp4');
    await renderTimeline({project:{id:'project',fps:24,resolution:'320 × 180'} as Project,timeline:{id:'timeline',projectId:'project',duration:.5,name:'test'},tracks:[{id:'track',timelineId:'timeline',kind:'video',number:1,gain:0,pan:0} as Track],clips:[{...clip,duration:.5,keyframes:{'properties.speed':[{id:'a',time:0,value:100,interpolation:'linear'},{id:'b',time:.45,value:50,interpolation:'linear'}]}}],nodes:[],assets:[{asset,path:input}],settings:{codec:'H.264',audio:'AAC · 192 kb/s · 48 kHz'},outputPath:audioPath});
    const audioMetadata=await probeMedia(audioPath);assert.ok(audioMetadata.hasAudio);assert.ok(Math.abs(audioMetadata.duration-.5)<.05);
    const sound=await run('ffmpeg',['-v','error','-i',audioPath,'-map','0:a:0','-ac','1','-f','f32le','pipe:1'],{binary:true});
    assert.ok(Array.from({length:sound.length/4},(_,i)=>Math.abs(sound.readFloatLE(i*4))).some(v=>v>.02),'Retimed export retains audible source sound.');
    const cancelled=new AbortController();cancelled.abort();
    await assert.rejects(renderOpticalFlow({...options,from:0,duration:1,signal:cancelled.signal}));
  }finally{await rm(directory,{recursive:true,force:true});}
});
