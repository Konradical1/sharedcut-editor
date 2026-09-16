// Read-only Newspaper samples: original-media export versus the CPU preview equations.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {renderTimeline} from '../server/media.ts';
import {starterGrade,colorTransform,makeCube,sampleCube} from '../src/services/color.ts';
const run=promisify(execFile),temp=await mkdtemp(join(tmpdir(),'frameline-color-export-'));
const db=new DatabaseSync('data/frameline.sqlite',{readOnly:true});
const state=JSON.parse(db.prepare('select state from workspace where id=1').get().state);db.close();
const results=[];
const ffmpeg=async args=>(await run('ffmpeg',['-v','error',...args],{encoding:'buffer',maxBuffer:64*1024*1024})).stdout;
try {
 for(const name of ['C0965.MP4','C0973.MP4']){
  const asset=state.media.find(m=>m.name===name);assert.ok(asset,`Missing ${name}`);
  const original=state.clips.find(c=>c.mediaId===asset.id)??state.clips.find(c=>c.projectId===asset.projectId),project={...state.projects.find(p=>p.id===asset.projectId),resolution:'640 × 360'};
  const clip={...structuredClone(original),mediaId:asset.id,start:0,duration:1/project.fps,sourceIn:0,keyframes:{},effects:[],properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine',zoom:100,opacity:100}};
  const track={...state.tracks.find(t=>t.id===clip.trackId),hidden:false,muted:false};
  const timeline={...state.timelines.find(t=>t.id===clip.timelineId),duration:clip.duration};
  let id=0;const nodes=starterGrade(clip,asset,()=>`export-${++id}`);
  nodes[1].parameters.exposure=-.6;nodes[1].parameters.temperature=120;
  nodes[2].curves={RGB:{mode:'smooth',points:[{id:'a',x:0,y:0},{id:'b',x:.3,y:.28},{id:'c',x:.65,y:.68},{id:'d',x:1,y:1}]}};
  const transform=colorTransform(clip,asset,nodes),cube=makeCube(transform,65);
  const source=resolve('data/media',asset.id,'original'),output=join(temp,`${name}.mov`);
  await renderTimeline({project,timeline,clips:[clip],tracks:[track],nodes,assets:[{asset,path:source}],settings:{resolution:'640 × 360',codec:'Apple ProRes 4444',audio:'Disabled'},outputPath:output});
  // Reduced source samples retain float RGB. Spatial resampling before versus after grading
  // contributes to the image error; LUT error is measured separately on identical inputs.
  const pixels=await ffmpeg(['-ss',String(clip.sourceIn),'-i',source,'-vf','scale=640:360:in_color_matrix=bt709,format=gbrpf32le','-frames:v','1','-f','rawvideo','-']);
  const count=640*360,expected=Buffer.alloc(count*3),lutErrors=[];
  for(let i=0;i<count;i++){
   const input=[pixels.readFloatLE((count*2+i)*4),pixels.readFloatLE(i*4),pixels.readFloatLE((count+i)*4)],rgb=transform(input);
   for(let c=0;c<3;c++)expected[i*3+c]=Math.round(rgb[c]*255);
   if(i%31===0){const sampled=sampleCube(cube,input);for(let c=0;c<3;c++)lutErrors.push(Math.abs(sampled[c]-rgb[c])*255);}
  }
  const raw=join(temp,'expected.rgb');await writeFile(raw,expected);
  const a=await ffmpeg(['-i',output,'-vf','scale=160:90:flags=area','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-']);
  const b=await ffmpeg(['-f','rawvideo','-pix_fmt','rgb24','-s','640x360','-i',raw,'-vf','scale=160:90:flags=area','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-']);
  assert.equal(a.length,b.length);
  const errors=Array.from(a,(v,i)=>Math.abs(v-b[i])).sort((a,b)=>a-b);lutErrors.sort((a,b)=>a-b);
  const result={name,meanRGBError:errors.reduce((a,b)=>a+b,0)/errors.length,p99RGBError:errors[Math.floor(errors.length*.99)],meanLUTError:lutErrors.reduce((a,b)=>a+b,0)/lutErrors.length,p99LUTError:lutErrors[Math.floor(lutErrors.length*.99)],maxLUTError:lutErrors.at(-1)};
  console.log(result);results.push(result);
  assert.ok(result.meanRGBError<3&&result.p99RGBError<12,'Original export must agree with preview equations.');
  assert.ok(result.meanLUTError<1&&result.p99LUTError<4,'65-cube interpolation must preserve this grade.');
 }
 await mkdir('artifacts/qa/color-overhaul',{recursive:true});await writeFile('artifacts/qa/color-overhaul/export-parity.json',JSON.stringify(results,null,2));
 console.log('PASS original 10-bit Sony footage, custom grade, ProRes export and LUT interpolation.');
}finally{await rm(temp,{recursive:true,force:true});}
