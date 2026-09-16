import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import { maskAnalysis, maskSourceFingerprint } from './smartMask.ts';
import { createSmartMask, smartMaskSignature, type SmartMaskManifest } from '../src/services/smartMask.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';

test('optical-flow masking is rejected before a source is decoded or baked',async()=>{
  const asset={id:'source',projectId:'project',kind:'video',fps:24,duration:1,resolution:'64 × 32'} as MediaAsset;
  const clip={id:'clip',projectId:'project',timelineId:'timeline',trackId:'video',mediaId:asset.id,name:'Subject',color:'red',start:0,sourceIn:0,duration:1,disabled:false,properties:{opticalFlow:true},effects:[{id:'cutout',name:'Smart Mask',enabled:true,amount:100,maskId:'subject'}]} as Clip;
  clip.smartMasks=[createSmartMask(clip,asset,'subject')];
  await assert.rejects(()=>renderTimeline({project:{id:'project',fps:24,resolution:'64 × 32'} as Project,timeline:{id:'timeline',projectId:'project',name:'Test',duration:1},clips:[clip],tracks:[],nodes:[],assets:[{asset,path:'/deliberately-missing-source'}],settings:{fps:'24'},outputPath:'/not-created.mov'}),/shared warped matte/);
});

test('authored alpha survives clip and node export, source trims, reverse and stale guards', {timeout:120_000}, async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'frameline-mask-render-')),ff=process.env.FFMPEG_PATH||'ffmpeg',source=path.join(dir,'source.mkv'),key='f'.repeat(64),cache=path.join(dir,key);
  try{
    await mkdir(path.join(cache,'frames'),{recursive:true});await mkdir(path.join(cache,'source'));
    await run(ff,['-v','error','-y','-f','lavfi','-i','color=c=0x804020:s=64x32:r=4:d=2','-c:v','ffv1',source]);
    const raw=Buffer.alloc(64*32*2*8);
    for(let f=0;f<8;f++)for(let i=0;i<64*32;i++)raw.writeUInt16LE(Math.round((i%64<32?f/8:1-f/8)*65535),(f*64*32+i)*2);
    await writeFile(path.join(dir,'alpha.raw'),raw);
    await run(ff,['-v','error','-y','-f','rawvideo','-pixel_format','gray16le','-video_size','64x32','-framerate','4','-i',path.join(dir,'alpha.raw'),'-start_number','0',path.join(cache,'frames','%d.png')]);
    for(let f=0;f<8;f++)await writeFile(path.join(cache,'source',`${f}.jpg`),'Source image fixture');
    const asset={id:'source',projectId:'project',kind:'video',name:'source',fps:4,duration:2,resolution:'64 × 32',inputProfile:'Rec.709',inputGamut:'Rec.709'} as MediaAsset;
    const clip={id:'clip',projectId:'project',timelineId:'timeline',trackId:'video',mediaId:asset.id,name:'Subject',start:0,sourceIn:0,duration:2,color:'red',disabled:false,properties:{colorPipeline:'nodes-v2',inputProfile:'Gamma 2.4',inputGamut:'Rec.709'},effects:[{id:'cutout',name:'Smart Mask',enabled:true,amount:100,maskId:'subject'}]} as Clip;
    const mask=createSmartMask(clip,asset,'subject');mask.prompts=[{id:'point',time:0,kind:'include',points:[{x:.5,y:.5}],radius:.01}];mask.result={key,signature:smartMaskSignature(mask)};clip.smartMasks=[mask];
    const manifest:SmartMaskManifest={version:1,key,signature:mask.result.signature,projectId:clip.projectId,mediaId:asset.id,sourceFingerprint:maskSourceFingerprint(source),engine:'authored alpha fixture',modelRevision:'fixture',quality:'final',width:64,height:32,sourceTimes:Array.from({length:8},(_,i)=>i/4),range:mask.range,alpha:'gray16',frames:Array.from({length:8},(_,i)=>({index:i,time:i/4,file:`frames/${i}.png`}))};
    await writeFile(path.join(cache,'manifest.json'),JSON.stringify(manifest));await writeFile(path.join(cache,'binding.json'),JSON.stringify({projectId:clip.projectId,clipId:clip.id,maskId:mask.id,signature:mask.result.signature,sourceFingerprint:maskSourceFingerprint(source),analysisIdentity:maskAnalysis(clip,asset).identity,workerIdentity:'fixture'}));
    const workerJob=path.join(dir,'worker.json'),alphaMovie=path.join(dir,'alpha.mkv');
    await writeFile(workerJob,JSON.stringify({input:source,output:path.join(dir,'float.mkv'),ffmpeg:ff,width:64,height:32,fps:4,numericFps:4,seek:0,duration:2,frames:8,frameTimes:manifest.sourceTimes,matrix:'bt709',range:'auto',alpha:true,stages:[],masks:[{document:mask,sourceTimes:manifest.sourceTimes,files:Object.fromEntries(manifest.frames.map(f=>[f.index,path.join(cache,f.file)])),output:alphaMovie}]}));
    await run(process.env.FRAME_LINE_COLOR_PYTHON||path.resolve('.venv-color/bin/python'),[path.resolve('scripts/color-render.py'),workerJob]);
    const recovered=await run(ff,['-v','error','-i',alphaMovie,'-f','rawvideo','-pix_fmt','gray16le','-'],{binary:true});assert.deepEqual(recovered,raw,'Every 16-bit alpha value must survive the float worker without 8-bit quantization.');
    const track={id:'video',timelineId:'timeline',number:1,kind:'video',name:'Video',muted:false,solo:false,hidden:false,locked:false,gain:0,pan:0} as Track;
    const request:RenderRequest={project:{id:'project',fps:4,resolution:'64 × 32'} as Project,timeline:{id:'timeline',projectId:'project',name:'Test',duration:2},clips:[clip],tracks:[track],nodes:[],assets:[{asset,path:source}],settings:{fps:'4',resolution:'64 × 32',codec:'Apple ProRes 422 HQ',audio:'Disabled',rangeIn:'0',rangeOut:'2'},outputPath:path.join(dir,'out.mov'),smartMaskDir:dir};
    const pixels=async(time:number)=>run(ff,['-v','error','-ss',String(time),'-i',request.outputPath,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{binary:true});
    await renderTimeline(request);
    let data=await pixels(.5),left=data[(16*64+12)*3],right=data[(16*64+52)*3];assert.ok(left>20&&left<43&&right>82&&right<110,`Fractional alpha must composite: ${left}, ${right}`);
    await renderTimeline({...request,clips:[{...clip,duration:1,sourceIn:.5,properties:{...clip.properties,reverse:true}}],settings:{...request.settings,rangeOut:'1'}});
    data=await pixels(0);left=data[(16*64+12)*3];assert.ok(left>68&&left<91,`Reverse source frame must carry its own matte: ${left}`);
    const node={id:'grade',projectId:'project',clipId:clip.id,kind:'primary',name:'Selective offset',enabled:true,parameters:{offset:.2},mask:{id:mask.id,enabled:true,invert:false,amount:100}};
    await renderTimeline({...request,clips:[{...clip,effects:[]}],nodes:[node]});data=await pixels(0);left=data[(16*64+12)*3];right=data[(16*64+52)*3];assert.ok(right-left>40,`A node mask must affect just its selected region: ${left}, ${right}`);
    await renderTimeline({...request,clips:[{...clip,duration:1,sourceIn:.5,properties:{...clip.properties,freeze:true}}],settings:{...request.settings,rangeOut:'1'}});data=await pixels(.75);left=data[(16*64+12)*3];assert.ok(left>20&&left<43,'Freeze must hold the selected source matte.');
    await renderTimeline({...request,clips:[{...clip,duration:1},{...clip,id:'duplicate',start:1,duration:1,sourceIn:1}]});data=await pixels(1);left=data[(16*64+12)*3];assert.ok(left>52&&left<75,'Copied effects must use independent stream labels and the copied clip source time.');
    await assert.rejects(()=>renderTimeline({...request,clips:[{...clip,smartMasks:[{...mask,settings:{...mask.settings,edgeRadius:18}}]}]}),/analyze|stale/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});
