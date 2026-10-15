// node scripts/build-showcase.mjs <private-bundle-dir> <public-output-dir> [slug]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compileReplay } from '../src/services/showcaseReplay.ts';
const [input,output,slug='girls-soccer']=process.argv.slice(2);
if(!input||!output||!/^[a-z0-9-]+$/.test(slug))throw Error('Usage: node scripts/build-showcase.mjs <private-bundle> <public-output> [slug]');
const source=resolve(input),dest=resolve(output);
const bundle=JSON.parse(readFileSync(join(source,'project.json'),'utf8')), users=JSON.parse(readFileSync(join(source,'authors.json'),'utf8'));
const {replay,verification}=compileReplay(bundle,users,{slug});mkdirSync(dest,{recursive:true});
function asset(path,extension){const hash=createHash('sha256').update(readFileSync(path)).digest('hex').slice(0,24),name=`asset-${hash}.${extension}`;if(!existsSync(join(dest,name)))copyFileSync(path,join(dest,name));return `/api/showcase/${slug}/${name}`;}
let thumbnails=0;
for(const media of replay.media){const thumb=join(source,'media',media.id,'prepared','thumbnail.jpg');if(existsSync(thumb)){media.thumbnail=asset(thumb,'jpg');thumbnails++;}}
// The viewer plays one film that follows the replay shot by shot, cut from the 1080p footage: no per-shot loading, no low-res proxies.
// It stays ungraded; the browser applies each moment's recorded grade on top.
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',fps=30,work=mkdtempSync(join(tmpdir(),'showcase-')),shots=[],parts=[];
replay.frames.forEach((f,i)=>{const end=replay.frames[i+1]?.at??replay.duration,clip=f.preview?.clip,last=shots.at(-1);if(last&&last.clip?.id===clip?.id)last.end=end;else shots.push({start:f.at,end,clip});});
const run=args=>{const r=spawnSync(ffmpeg,['-v','error','-y',...args],{stdio:['ignore','ignore','pipe']});if(r.status!==0)throw Error(`ffmpeg failed: ${r.stderr}`);};
const encode=['-vf',`fps=${fps},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,setsar=1,format=yuv420p`,'-an','-c:v','libx264','-preset','medium','-crf','20','-g',String(fps)];
shots.forEach((shot,i)=>{
  const frames=Math.round(shot.end*fps)-Math.round(shot.start*fps);if(frames<1)return;
  const part=join(work,`${i}.mp4`),dir=shot.clip&&join(source,'media',shot.clip.mediaId,'prepared'),footage=dir&&['full-v3.mp4','stream-v2.mp4'].map(n=>join(dir,n)).find(p=>existsSync(p));
  if(footage)run(['-stream_loop','-1','-ss',Math.max(0,shot.clip.sourceIn).toFixed(3),'-i',footage,'-frames:v',String(frames),...encode,part]);
  else run(['-f','lavfi','-i',`color=black:s=1920x1080:r=${fps}`,'-frames:v',String(frames),...encode,part]);
  parts.push(part);
});
const list=join(work,'parts.txt'),film=join(work,'film.mp4');
writeFileSync(list,parts.map(p=>`file '${p.replace(/'/g,"'\\''")}'`).join('\n'));
run(['-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',film]);
replay.film=asset(film,'mp4');rmSync(work,{recursive:true,force:true});
writeFileSync(join(dest,'replay.json'),JSON.stringify(replay));
writeFileSync(join(source,'replay-verification.json'),JSON.stringify(verification,null,2));
const share=Object.fromEntries(replay.authors.map(a=>[a.name,replay.frames.filter(f=>f.author===a.id).length]));
console.log(JSON.stringify({title:replay.title,frames:replay.frames.length,share,shots:parts.length,thumbnails,filmBytes:statSync(join(dest,replay.film.split('/').at(-1))).size,checkpointCorrections:verification.differences.length,output:dest}));
