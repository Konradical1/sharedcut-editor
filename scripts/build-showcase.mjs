// node scripts/build-showcase.mjs <private-bundle-dir> <public-output-dir> [slug]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { compileReplay } from '../src/services/showcaseReplay.ts';
const [input,output,slug='girls-soccer']=process.argv.slice(2);
if(!input||!output||!/^[a-z0-9-]+$/.test(slug))throw Error('Usage: node scripts/build-showcase.mjs <private-bundle> <public-output> [slug]');
const source=resolve(input),dest=resolve(output);
const bundle=JSON.parse(readFileSync(join(source,'project.json'),'utf8')), users=JSON.parse(readFileSync(join(source,'authors.json'),'utf8'));
const {replay,verification}=compileReplay(bundle,users,{slug});mkdirSync(dest,{recursive:true});
function asset(path,extension){const hash=createHash('sha256').update(readFileSync(path)).digest('hex').slice(0,24),name=`asset-${hash}.${extension}`;if(!existsSync(join(dest,name)))copyFileSync(path,join(dest,name));return `/api/showcase/${slug}/${name}`;}
const counts=new Map();for(const f of replay.frames)if(f.preview){const id=f.preview.clip.mediaId;counts.set(id,(counts.get(id)??0)+1);}
const videos=new Set([...counts].sort((a,b)=>b[1]-a[1]).slice(0,14).map(([id])=>id));let thumbnails=0,previews=0;
for(const media of replay.media){const dir=join(source,'media',media.id,'prepared'),thumb=join(dir,'thumbnail.jpg');if(existsSync(thumb)){media.thumbnail=asset(thumb,'jpg');thumbnails++;}if(videos.has(media.id)){const video=['stream-low-v2.mp4','stream-low-v1.mp4','stream-v2.mp4','stream-v1.mp4'].map(n=>join(dir,n)).find(p=>existsSync(p)&&statSync(p).size<50_000_000);if(video){media.video=asset(video,'mp4');previews++;}}}
writeFileSync(join(dest,'replay.json'),JSON.stringify(replay));
writeFileSync(join(source,'replay-verification.json'),JSON.stringify(verification,null,2));
console.log(JSON.stringify({title:replay.title,authors:replay.authors.length,frames:replay.frames.length,thumbnails,previews,checkpointCorrections:verification.differences.length,manifestBytes:statSync(join(dest,'replay.json')).size,output:dest}));
