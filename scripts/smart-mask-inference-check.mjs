// Real installed model, native worker, persisted artifacts and an actual masked export.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { run, renderTimeline, probeMedia } from '../server/media.ts';
import { smartMaskService, smartMaskCapabilities } from '../server/smartMask.ts';
import { createSmartMask, smartMaskSignature } from '../src/services/smartMask.ts';

const directory = await mkdtemp(join(tmpdir(), 'SharedCut mask inference '));
const cache = join(directory, 'masks'); await mkdir(cache);
const service = smartMaskService(cache);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const report = { capabilities: await smartMaskCapabilities(), checks: [] };
const W = 320, H = 192, FPS = 4, COUNT = 8;
try {
  assert.equal(report.capabilities.available, true);
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  for (let i = 0; i < COUNT; i++) {
    ctx.fillStyle = '#589bcc'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#7a914f'; ctx.fillRect(0, 168, W, 24);
    ctx.fillStyle = '#e84828'; ctx.fillRect(105+i*3, 62, 54, 76);
    ctx.fillStyle = '#edbd95'; ctx.beginPath(); ctx.arc(132+i*3, 44, 22, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#242c39'; ctx.fillRect(108+i*3, 136, 20, 32); ctx.fillRect(140+i*3, 136, 18, 32);
    await writeFile(join(directory, `${i}.png`), canvas.toBuffer('image/png'));
  }
  const source = join(directory, 'Original subject.mp4');
  await run(ffmpeg, ['-v','error','-framerate',String(FPS),'-i',join(directory,'%d.png'),'-c:v','libx264','-pix_fmt','yuv420p',source]);
  const asset = { id:'source',projectId:'project',kind:'video',name:'Subject',fps:FPS,duration:2,resolution:`${W} x ${H}`,hasAudio:false,inputProfile:'Rec.709',inputGamut:'Rec.709' };
  const clip = { id:'clip',projectId:'project',timelineId:'timeline',trackId:'video',mediaId:asset.id,name:'Subject',start:0,sourceIn:0,duration:2,color:'red',disabled:false,properties:{},effects:[{id:'cutout',name:'Smart Mask',enabled:true,amount:100,maskId:'subject'}] };
  const mask = createSmartMask(clip,asset,'subject');
  mask.prompts = [{id:'include',time:0,kind:'include',points:[{x:132/W,y:94/H}],radius:.01}];
  clip.smartMasks = [mask];
  const preview = await service.preview(clip,asset,source,mask,0,mask.prompts);
  assert.ok((await readFile(preview)).length > 100);
  report.checks.push('Interactive model preview');
  const analyze = async (direction, anchorTime) => {
    const job = await service.enqueue({clip,asset,mask,sourcePath:source,signature:smartMaskSignature(mask),direction,anchorTime});
    const deadline = Date.now()+180000;
    while (Date.now()<deadline) {
      const state=service.get(clip.projectId,job.key);
      if(state.status==='failed')throw Error(state.error);
      if(state.status==='ready') {mask.result={key:job.key,signature:job.signature};return JSON.parse(await readFile(service.file(clip.projectId,job.key,'manifest'),'utf8'));}
      await new Promise(r=>setTimeout(r,250));
    }
    throw Error('Model analysis exceeded three minutes');
  };
  let manifest = await analyze('both',0);
  assert.equal(manifest.frames.length,COUNT); assert.equal(manifest.quality,'preview');
  const alpha = await run(ffmpeg,['-v','error','-i',service.file('project',mask.result.key,'frames',4),'-f','rawvideo','-pix_fmt','gray16le','-'],{binary:true});
  assert.ok(alpha.readUInt16LE((90*W+144)*2)>40000,'Tracked subject remains included');
  assert.ok(alpha.readUInt16LE((30*W+280)*2)<1000,'Background remains excluded');
  report.checks.push('CUDA range tracking and native 16-bit subject/background separation');
  mask.repairs=[{id:'repair',time:1,kind:'background',radius:.025,points:[{x:144/W,y:90/H}]}];
  await analyze('both',0);
  const repaired=await run(ffmpeg,['-v','error','-i',service.file('project',mask.result.key,'frames',4),'-f','rawvideo','-pix_fmt','gray16le','-'],{binary:true});
  assert.equal(repaired.readUInt16LE((90*W+144)*2),0);
  report.checks.push('Repair-only revision preserves the original matte');
  const outputPath=join(directory,'Masked export.mp4');
  await renderTimeline({project:{id:'project',fps:FPS,resolution:`${W} x ${H}`},timeline:{id:'timeline',projectId:'project',name:'Test',duration:2},clips:[clip],tracks:[{id:'video',timelineId:'timeline',number:1,kind:'video',gain:0,pan:0}],nodes:[],assets:[{asset,path:source}],settings:{fps:String(FPS),resolution:`${W} x ${H}`,codec:'H.264',audio:'Disabled',rangeIn:'0',rangeOut:'2'},outputPath,smartMaskDir:cache});
  assert.ok(Math.abs((await probeMedia(outputPath)).duration-2)<.1);
  const picture=await run(ffmpeg,['-v','error','-i',outputPath,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{binary:true});
  assert.ok(picture[(90*W+132)*3]>80);assert.ok(picture[(30*W+280)*3]<15,'Export removes background');
  report.checks.push('Tracked-selection H.264 export with visible subject and removed background');
  mask.prompts=[{...mask.prompts[0],time:1,points:[{x:144/W,y:94/H}]}];mask.repairs=[];
  manifest=await analyze('backward',1);assert.equal(manifest.frames.length,5);
  report.checks.push('Backward propagation');
  await mkdir(resolve('artifacts/windows'),{recursive:true});
  await writeFile(resolve('artifacts/windows/mask-inference.json'),JSON.stringify(report,null,2));
  console.log('PASS',JSON.stringify(report));
} finally { await service.close(); await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:250}); }
