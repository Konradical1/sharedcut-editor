import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkMediaFiles, linkedAsset } from './linkMedia.ts';
import { createFrameLineServer } from './index.ts';
import { soundLibrary } from './sfx.ts';
import { execFileSync } from 'node:child_process';

test('linked media owns its URLs and survives removal of its source without copying bytes', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sharedcut-link-'));
  try {
    const a=join(dir,'a'),b=join(dir,'b');await mkdir(join(a,'prepared'),{recursive:true});await writeFile(join(a,'original'),'sound');await writeFile(join(a,'prepared','audio.m4a'),'prepared');
    linkMediaFiles(a,b);assert.equal((await stat(join(a,'original'))).ino,(await stat(join(b,'original'))).ino);
    const asset=linkedAsset({id:'old',projectId:'a',proxyVariants:{half:'/api/media/old/files/half.mp4?v=2'},sourceUrl:'/api/media/old/original'} as any,'new','b');
    assert.equal(asset.proxyVariants!.half,'/api/media/new/files/half.mp4?v=2');assert.equal(asset.projectId,'b');
    await rm(a,{recursive:true});assert.equal(await readFile(join(b,'original'),'utf8'),'sound');assert.equal(await readFile(join(b,'prepared','audio.m4a'),'utf8'),'prepared');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('cross-project media link is authorized, deduplicated, persisted and independently playable', {timeout:60000}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sharedcut-link-http-'));let app:ReturnType<typeof createFrameLineServer>|undefined;
  try{
    const file=join(dir,'hit.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.2',file]);
    const sound=await soundLibrary(dir).add(file,{name:'Hit',category:'Test',tags:[],description:''});
    app=createFrameLineServer({dataDir:dir});await new Promise<void>(r=>app!.server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${(app.server.address() as any).port}`;
    const req=async(path:string,cookie='',body?:any,method=body?'POST':'GET')=>{const res=await fetch(`${base}/api${path}`,{method,headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]??''};};
    const alice=await req('/auth/signup','',{name:'Alice',email:'alice@link.test',password:'clipboard-test-password'}),bob=await req('/auth/signup','',{name:'Bob',email:'bob@link.test',password:'clipboard-test-password'});
    const snap=(await req('/state',alice.cookie)).data;
    for(const id of ['source','dest'])snap.state.projects.push({id,name:id,description:'',shared:false,thumbnail:'',modifiedAt:1,duration:0,resolution:'1920 × 1080',fps:24,status:'In progress',members:[{userId:alice.data.user.id,role:'Owner'}]});
    assert.equal((await req('/state',alice.cookie,snap,'PUT')).status,200);
    const original=(await req(`/sfx/${sound.id}/import`,alice.cookie,{projectId:'source'})).data.asset;
    assert.ok(original?.id);
    const body={projectId:'dest',mediaIds:[original.id]};
    assert.equal((await req('/media/link','',body)).status,401);assert.equal((await req('/media/link',bob.cookie,body)).status,404);
    const linked=await req('/media/link',alice.cookie,body);assert.equal(linked.status,200);const asset=linked.data.assets[0];assert.equal(asset.projectId,'dest');assert.notEqual(asset.id,original.id);
    assert.equal((await req('/media/link',alice.cookie,body)).data.assets[0].id,asset.id);
    assert.equal((await stat(join(dir,'media',original.id,'original'))).ino,(await stat(join(dir,'media',asset.id,'original'))).ino);
    await req('/projects/source',alice.cookie,undefined,'DELETE');
    const res=await fetch(`${base}${asset.sourceUrl}`,{headers:{cookie:alice.cookie}});assert.equal(res.status,200);assert.ok((await res.arrayBuffer()).byteLength>100);
    assert.ok((await req('/state',alice.cookie)).data.state.media.some((m:any)=>m.id===asset.id));
    // A readable source still cannot be pasted into a project where the account is only a viewer.
    assert.equal((await req('/projects/dest',alice.cookie,{access:'people',members:[{userId:bob.data.user.id,role:'Viewer'}]},'PATCH')).status,200);
    assert.equal((await req('/media/link',bob.cookie,{projectId:'dest',mediaIds:[asset.id]})).status,403);
  }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
