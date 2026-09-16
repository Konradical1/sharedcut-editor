// Usage: node --experimental-strip-types scripts/verify-resolve.mjs /path/to/bridge-folder
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {importResolve} from '../server/resolve.ts';
import {renderTimeline} from '../server/media.ts';
const run=promisify(execFile),dir=resolve(process.argv[2]||''),manifest=JSON.parse(await readFile(join(dir,'project.frameline.json'),'utf8'));
const otios=await Promise.all(manifest.timelines.map((_,i)=>readFile(join(dir,`timeline-${i+1}.otio`),'utf8').then(JSON.parse)));
const project=importResolve(manifest,'resolve-verification','verification',otios),out=join(dir,'verification');await mkdir(out,{recursive:true});
const shots=project.clips.filter(c=>c.properties.resolveReferenceUrl),results=[];
for(const [index,clip] of shots.entries()) {
  const t=Number(clip.properties.resolveReferenceTime),file=join(out,`shot-${index+1}.mov`),timeline=project.timelines.find(t=>t.id===clip.timelineId);
  await renderTimeline({project:project.project,timeline,clips:project.clips,tracks:project.tracks,nodes:project.nodes,assets:project.media.map(asset=>({asset,path:asset.sourcePath})),resolveDir:dir,settings:{resolution:'640 × 360',fps:String(project.project.fps),codec:'Apple ProRes 4444',audio:'Disabled',rangeIn:String(t),rangeOut:String(t+1/project.project.fps)},outputPath:file});
  const pixels=async path=>(await run('ffmpeg',['-v','error','-i',path,'-vf','scale=160:90','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:2e6})).stdout;
  const a=await pixels(file),b=await pixels(join(dir,String(clip.properties.resolveReferenceUrl).split('/').at(-1)));
  let total=0,large=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);total+=d;if(d>10)large++;}
  const result={shot:index+1,name:clip.name,referenceTime:t,meanAbsoluteRGBError:total/a.length,percentChannelsOver10:large/a.length*100};results.push(result);console.log(JSON.stringify(result));
}
await writeFile(join(out,'comparison.json'),JSON.stringify({timelineFrames:Math.round(project.project.duration*project.project.fps),results},null,2));
