import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportResolveTimeline, importResolve } from './resolve.ts';
import { createFrameLineServer } from './index.ts';
import { makeCube, cubeText } from '../src/services/color.ts';

const manifest={format:'frameline-resolve',version:1,name:'Roundtrip',media:[{id:'m',name:'source.mp4',properties:{'File Path':'/shoot/source.mp4',Type:'Video + Audio',Frames:240,FPS:23.976}}],timelines:[{id:'t',name:'Timeline',startFrame:86400,endFrame:86424,settings:{timelineFrameRate:23.976},tracks:[{kind:'video',number:1,name:'V1',items:[{id:'c',name:'source.mp4',mediaId:'m',startFrame:86400,durationFrames:24,sourceStartFrame:9,sourceEndFrame:32,leftOffset:10,enabled:true,properties:{},nodes:[],lookExported:true,lookFile:'c.cube'}]}]}]};
const otios=[{tracks:{children:[{kind:'Video',children:[{OTIO_SCHEMA:'Clip.2',name:'source.mp4',source_range:{start_time:{value:110,rate:24000/1001},duration:{value:24,rate:24000/1001}},media_references:{DEFAULT_MEDIA:{available_range:{start_time:{value:100,rate:24000/1001}}}},effects:[{metadata:{Resolve_OTIO:{Enabled:true,Parameters:[{'Parameter ID':'videoFaderIn','Parameter Value':12}]}}}]}]}]}}];

test('Resolve import uses OTIO source frames and authenticated resumable storage',async()=>{
  const imported=importResolve(manifest,'resolve-test','owner',otios);
  assert.equal(imported.project.fps,24000/1001);assert.ok(Math.abs(imported.clips[0].sourceIn-10/(24000/1001))<1e-10);assert.equal(imported.clips[0].properties.speed,100);assert.equal(imported.clips[0].properties.fadeIn,12/(24000/1001));
  assert.throws(()=>importResolve(manifest,'p','u',[]),/Include every/);
  const dir=await mkdtemp(join(tmpdir(),'frameline-resolve-test-'));let app=createFrameLineServer({dataDir:dir});let base='';
  const listen=async()=>{await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;};await listen();
  let cookie='';
  const request=(route:string,method='GET',body?:unknown)=>fetch(base+'/api'+route,{method,headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  try {
    const signup=await request('/auth/signup','POST',{name:'Import Test',email:'import@example.test',password:'frame-import-test-password'});assert.equal(signup.status,201);cookie=signup.headers.get('set-cookie')!.split(';')[0];
    const result=await request('/resolve/import','POST',{projectId:'resolve-test',manifest,otios});assert.equal(result.status,201,await result.clone().text());const data=await result.json();
    const repeat=await request('/resolve/import','POST',{projectId:'resolve-test',manifest,otios});assert.equal(repeat.status,200);
    assert.equal((await fetch(base+'/api/projects/resolve-test/resolve/c.cube')).status,401);
    const lut=cubeText(makeCube(rgb=>rgb,2));const stored=await fetch(base+'/api/projects/resolve-test/resolve/c.cube',{method:'PUT',headers:{cookie},body:lut});assert.equal(stored.status,200);assert.equal(await (await request('/projects/resolve-test/resolve/c.cube')).text(),lut);
    const url=base+'/api/projects/resolve-test/resolve/c.cube';
    const compressed=await fetch(url,{headers:{cookie,'accept-encoding':'gzip'}});
    assert.equal(compressed.headers.get('content-encoding'),'gzip');assert.equal(await compressed.text(),lut);
    assert.equal((await fetch(url,{headers:{cookie,'if-none-match':compressed.headers.get('etag')!}})).status,304);
    assert.equal((await fetch(url,{headers:{'if-none-match':compressed.headers.get('etag')!}})).status,401,'Cache validation still requires project access.');
    const plain=await fetch(url,{headers:{cookie,'accept-encoding':'gzip;q=0'}});
    assert.equal(plain.headers.get('content-encoding'),null);assert.equal(await plain.text(),lut);
    const range=await fetch(url,{headers:{cookie,'accept-encoding':'gzip',range:'bytes=0-9'}});
    assert.equal(range.status,206);assert.equal(range.headers.get('content-encoding'),null);assert.equal(await range.text(),lut.slice(0,10));
    const id=data.media[0].id;
    assert.equal((await request(`/media/${id}/upload`,'POST',{size:6,fingerprint:'source.mp4:6:1'})).status,200);
    const chunk=Buffer.from('abc'),checksum=createHash('sha256').update(chunk).digest('hex');
    assert.equal((await fetch(base+`/api/media/${id}/upload`,{method:'PUT',headers:{cookie,'upload-offset':'0','upload-checksum':'bad'},body:chunk})).status,400);
    assert.equal((await fetch(base+`/api/media/${id}/upload`,{method:'PUT',headers:{cookie,'upload-offset':'0','upload-checksum':checksum},body:chunk})).status,200);
    await app.close();app=createFrameLineServer({dataDir:dir});await listen();
    assert.equal((await (await request(`/media/${id}/upload`)).json()).offset,3);
    assert.equal((await request(`/media/${id}/upload`,'POST',{size:6,fingerprint:'wrong-file'})).status,409);
    assert.equal((await fetch(base+`/api/media/${id}/upload`,{method:'PUT',headers:{cookie,'upload-offset':'0','upload-checksum':checksum},body:chunk})).status,409);
    assert.equal((await fetch(base+`/api/media/${id}/upload`,{method:'PUT',headers:{cookie,'upload-offset':'3','upload-checksum':checksum},body:chunk})).status,202);
    assert.equal(await(await request(`/media/${id}/original`)).text(),'abcabc');
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});


test('Resolve OTIO link groups preserve video/audio identity without filename guessing',()=>{
  const m=structuredClone(manifest),o=structuredClone(otios);
  (o[0].tracks.children[0].children[0] as any).metadata={Resolve_OTIO:{'Link Group ID':7}};
  m.timelines[0].tracks.push({...structuredClone(m.timelines[0].tracks[0]),kind:'audio',items:[{...structuredClone(m.timelines[0].tracks[0].items[0]),id:'audio-c'}]});
  o[0].tracks.children.push({...structuredClone(o[0].tracks.children[0]),kind:'Audio'});
  const result=importResolve(m,'resolve-links','owner',o);
  assert.equal(result.clips[0].properties.linkGroup,result.clips[1].properties.linkGroup);assert.ok(result.clips[0].properties.linkGroup);assert.equal(result.clips[0].properties.audioDetached,true);
});


test('Resolve video fade lengths survive edited OTIO export at fractional frame rates',()=>{
 const imported=importResolve(manifest,'resolve-fades','owner',otios),clip=imported.clips[0];
 clip.properties.fadeIn=18/imported.project.fps;clip.properties.fadeOut=6/imported.project.fps;
 const result=exportResolveTimeline(imported.project,imported.timelines[0],imported.tracks,imported.clips,imported.media,{c:otios[0].tracks.children[0].children[0]});
 const roundtrip=importResolve(manifest,'resolve-fades','owner',[result.otio]);
 assert.equal(roundtrip.clips[0].properties.fadeIn,18/imported.project.fps);
 assert.equal(roundtrip.clips[0].properties.fadeOut,6/imported.project.fps);
 assert.equal(roundtrip.clips[0].duration,clip.duration);assert.equal(roundtrip.clips[0].sourceIn,clip.sourceIn);
 clip.properties.audioFadeIn=.25;
 assert.ok(exportResolveTimeline(imported.project,imported.timelines[0],imported.tracks,imported.clips,imported.media).warnings.some(w=>w.startsWith('Audio fades')));
});


test('SharedCut export branding preserves imports from both studio names',()=>{
 for(const brand of ['FrameLine','SharedCut']) {
  const imported=importResolve({...manifest,name:`Roundtrip — ${brand} Source`},'rebrand','owner',otios);
  assert.equal(imported.project.name,'Roundtrip');
  const {otio}=exportResolveTimeline(imported.project,imported.timelines[0],imported.tracks,imported.clips,imported.media);
  assert.equal(otio.name,'Timeline — SharedCut');
  assert.equal(otio.metadata.SharedCut.version,1);
 }
});


test('Resolve Zoom X/Y import as Zoom and Scale Y; a stretch exports as SharedCut metadata with a warning',()=>{
 const m=structuredClone(manifest);m.timelines[0].tracks[0].items[0].properties={ZoomX:1.25,ZoomY:1};
 const imported=importResolve(m,'resolve-stretch','owner',otios),clip=imported.clips[0];
 assert.deepEqual([clip.properties.zoom,clip.properties.scaleY],[125,80]);assert.ok(!imported.warnings.some(w=>/nonuniform/.test(w)));
 const stretch=/Scale X\/Y stretch/,{otio,warnings}=exportResolveTimeline(imported.project,imported.timelines[0],imported.tracks,imported.clips,imported.media);
 assert.ok(warnings.some(w=>stretch.test(w)));assert.equal(otio.tracks.children[0].children[0].metadata.SharedCut.properties.scaleY,80);
 const plain=importResolve(manifest,'resolve-plain','owner',otios);
 assert.ok(!exportResolveTimeline(plain.project,plain.timelines[0],plain.tracks,plain.clips,plain.media).warnings.some(w=>stretch.test(w)),'no warning without a stretch');
});
