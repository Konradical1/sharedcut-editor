import {venvPython} from '../server/platform.ts';
// Read-only source-media check of the native ACES export, including audio and frozen footage.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {processingStages,starterGrade} from '../src/services/color.ts';
import {DatabaseSync} from 'node:sqlite';
import {readWorkspace} from './workspace-db.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {renderTimeline,probeMedia,run} from '../server/media.ts';
const out=resolve('artifacts/qa/color-reference/export');await mkdir(out,{recursive:true});
const db=new DatabaseSync('data/frameline.sqlite',{readOnly:true});const s=readWorkspace(db).state;db.close();
const results=[];
const preferred=['C0852.MP4','C0363.MP4'].filter(name=>s.media.some(m=>m.name===name));
const samples=process.argv.slice(2).length?process.argv.slice(2):preferred.length?preferred:s.media.filter(m=>m.kind==='video'&&s.clips.some(c=>c.mediaId===m.id)).slice(0,2).map(m=>m.name);
assert.ok(samples.length,'Import a camera clip before running this source-media check.');
for(const name of samples){
 const asset=s.media.find(m=>m.name===name);assert.ok(asset,`Missing source: ${name}`);
 const original=s.clips.find(c=>c.mediaId===asset.id);assert.ok(original,`Add ${name} to a timeline first.`);
 const sourceIn=Math.max(0,Math.min(asset.duration-.2,name==='C0852.MP4'?4:8));
 const project={...s.projects.find(p=>p.id===asset.projectId),resolution:'1920 × 1080'},fps=project.fps;
 const clip={...structuredClone(original),start:0,duration:2/fps,sourceIn,keyframes:{},effects:[],properties:{...original.properties,colorPipeline:'nodes-v2',bypassResolveLook:true,inputProfile:original.properties.inputProfile||asset.inputProfile||'Rec.709',inputGamut:original.properties.inputGamut||asset.inputGamut||'Rec.709',opticalFlow:false,speed:100,reverse:false,freeze:false,audioDetached:false,zoom:100,opacity:100}};
 let nodes=structuredClone(s.nodes.filter(n=>n.clipId===clip.id));if(original.properties.colorPipeline!=='nodes-v2'){let id=0;nodes=starterGrade(clip,asset,()=>`check-${id++}`);}for(const n of nodes)for(const e of n.effects??[])if(e.type==='cst'&&e.toneMapping==='shoulder')Object.assign(e,{toneMapping:'aces2',gamutMapping:'none'});
 const track={...s.tracks.find(t=>t.id===clip.trackId),hidden:false,muted:false},timeline={...s.timelines.find(t=>t.id===clip.timelineId),duration:clip.duration};
 for(const freeze of [false,true]){
  clip.properties.freeze=freeze;const output=join(out,name.replace('.MP4','')+(freeze?'-freeze':'')+'.mov');
  await renderTimeline({project,timeline,clips:[clip],tracks:[track],nodes,assets:[{asset,path:resolve('data/media',asset.id,'original')}],settings:{resolution:project.resolution,codec:'Apple ProRes 4444',audio:'Linear PCM · 24-bit · 48 kHz'},outputPath:output});
  const info=await probeMedia(output);assert.equal(info.width,1920);assert.equal(info.height,1080);assert.ok(Math.abs(info.duration-clip.duration)<.06);assert.equal(info.hasAudio,true); // The timeline retains its silent audio bed on frozen frames.
  await run('ffmpeg',['-v','error','-y','-i',output,'-frames:v','1',join(out,name.replace('.MP4','')+(freeze?'-freeze':'')+'.png')]);
  if(!freeze){
   // Compare encoded output against float processing of source samples. Downsampling before
   // versus after the nonlinear grade contributes error, so this is a bounded image check.
   // Match output frame-rate sampling before comparing moving footage.
   const pixels=await run('ffmpeg',['-v','error','-ss',String(sourceIn),'-i',resolve('data/media',asset.id,'original'),'-vf',`setpts=PTS-STARTPTS,fps=${fps},scale=320:180:in_color_matrix=${asset.colorMatrix||'auto'},format=gbrpf32le`,'-frames:v','1','-f','rawvideo','-'],{binary:true});
   const job=join(out,'sample-job.json');await writeFile(job,JSON.stringify({width:320,height:180,stages:processingStages(clip,nodes)}));
   const expected=execFileSync(process.env.FRAME_LINE_COLOR_PYTHON||venvPython('.venv-color'),['scripts/color-render.py',job,'--stream'],{input:pixels,maxBuffer:2e6});
   const actual=await run('ffmpeg',['-v','error','-i',output,'-vf','scale=320:180','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'],{binary:true});
   const errors=[];for(let i=0;i<320*180;i++)for(let c=0;c<3;c++)errors.push(Math.abs(actual[i*3+c]-Math.round(Math.max(0,Math.min(1,expected.readFloatLE(([2,0,1][c]*320*180+i)*4)))*255)));
   errors.sort((a,b)=>a-b);const error={mean:errors.reduce((a,b)=>a+b,0)/errors.length,p99:errors[Math.floor(errors.length*.99)]};
   console.log(name,'encoded pixel error',error);assert.ok(error.mean<3&&error.p99<12,JSON.stringify(error));info.pixelError=error;
  }
  results.push({name,freeze,...info});console.log(name,freeze,info.duration,info.hasAudio);
 }
}
await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));console.log('PASS native ACES source export, preserved audio, freeze, dimensions and timing.');
