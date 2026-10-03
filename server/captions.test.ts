import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { renderTimeline, type RenderRequest } from './media.ts';
import { transcribeTimeline } from './captions.ts';
import { gpuJob } from './workQueue.ts';
import { captionDocument, captionPresets, demoCaptionWords } from '../src/services/captions.ts';
import { drawText } from '../src/services/text.ts';
const exec=promisify(execFile);

test('caption renderer is deterministic, scrubbable, and exports more than 128 lines',async()=>{
  const canvas=createCanvas(480,270),ctx=canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const frame=(preset:string,t:number)=>{ctx.clearRect(0,0,480,270);drawText(ctx,captionDocument(demoCaptionWords,preset,3),480,270,1920,1080,t);return Buffer.from(ctx.getImageData(0,0,480,270).data);};
  for(const preset of captionPresets){const a=frame(preset.id,.08);assert.ok(a.some(v=>v>0),`${preset.id} draws`);frame(preset.id,2);assert.deepEqual(frame(preset.id,.08),a,`${preset.id} scrubs deterministically`);}
  assert.notDeepEqual(frame('highlight',.25),frame('highlight',.65),'Spoken word highlighting advances');
  const directory=await mkdtemp(join(tmpdir(),'caption-render-test-'));
  try {
    const count=132,fps=24,duration=count/fps;
    const clips=Array.from({length:count},(_,i)=>({id:`line-${i}`,projectId:'p',timelineId:'t',trackId:'captions',mediaId:'frameline-title',name:'Caption',start:i/fps,duration:1/fps,sourceIn:0,color:'#888888',disabled:false,effects:[],properties:{captionSet:'set',textDocument:JSON.stringify(captionDocument([{text:`Line ${i}`,start:0,end:1/fps}],'movie',1/fps))}}));
    const request={project:{id:'p',name:'Captions',description:'',shared:false,thumbnail:'',modifiedAt:0,duration,resolution:'480 × 270',fps,status:'In progress',members:[]},timeline:{id:'t',projectId:'p',name:'Timeline',duration},clips,tracks:[{id:'captions',timelineId:'t',name:'Captions',kind:'video',number:1,muted:true,solo:false,locked:false,hidden:false,gain:0,pan:0}],assets:[],nodes:[],settings:{codec:'H.264',audio:'Disabled'},outputPath:join(directory,'captions.mp4')} as RenderRequest;
    await renderTimeline(request);
    const {stdout}=await exec(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-ss','3','-i',request.outputPath,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',maxBuffer:10e6});
    assert.ok(stdout.some(v=>v>180),'Caption survives actual export after line 72');
    const probe=await exec(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',request.outputPath]);
    assert.ok(Math.abs(Number(probe.stdout)-duration)<.1);
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('custom caption animation durations change rendered frames and reject invalid input',async()=>{
  const {validateCaption}=await import('../src/services/captions.ts');
  const doc=captionDocument(demoCaptionWords,'pull-in',2.7),canvas=createCanvas(640,360),ctx=canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const frame=()=>{ctx.clearRect(0,0,640,360);drawText(ctx,doc,640,360,1920,1080,.04);return canvas.toBuffer('image/png');};
  const original=frame();doc.caption!.entranceDuration=.02;assert.notDeepEqual(frame(),original);
  doc.caption!.entranceDuration=0;doc.caption!.exitDuration=0;const instant=frame();
  ctx.clearRect(0,0,640,360);drawText(ctx,doc,640,360,1920,1080,.08);assert.deepEqual(canvas.toBuffer('image/png'),instant,'Zero duration has no entrance motion or shutter trail');
  for(const value of [-1,6,NaN,Infinity]){doc.caption!.entranceDuration=value;assert.throws(()=>validateCaption(doc.caption!));}
});

test('a transcription leaves the media queue before it waits for the GPU',{skip:process.platform==='win32'&&'the speech stand-in is a shebang script'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'frameline-caption-gpu-')),speech=join(directory,'speech');
  // Stands in for the speech worker: `python transcribe.py <audio> <words.json>` writes no words.
  writeFileSync(speech,`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv[4],JSON.stringify({words:[]}));\n`);chmodSync(speech,0o755);
  process.env.FRAME_LINE_CAPTION_PYTHON=speech;
  let freeGpu=()=>{},left=false;
  // A depth run holds the GPU.
  const depthRun=gpuJob(()=>new Promise<void>(resolve=>{freeGpu=resolve;}));
  try {
    const timeline={id:'t',projectId:'p',name:'t',duration:1};
    const words=transcribeTimeline({project:{id:'p',resolution:'16 × 16',fps:24} as RenderRequest['project'],timeline,timelines:[timeline],clips:[],tracks:[],nodes:[],assets:[],settings:{rangeIn:'0',rangeOut:'1'},outputPath:'',signal:new AbortController().signal},[],()=>{},()=>{left=true;});
    for(let i=0;i<600&&!left;i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(left,'the media slot is handed back once the audio is rendered, while the GPU is still busy');
    freeGpu();
    assert.deepEqual(await words,[]);
  } finally { freeGpu();await depthRun;delete process.env.FRAME_LINE_CAPTION_PYTHON;await rm(directory,{recursive:true,force:true}); }
});
