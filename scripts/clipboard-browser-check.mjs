import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createFrameLineServer} from '../server/index.ts';
import {soundLibrary} from '../server/sfx.ts';
import {defaultProperties} from '../src/state/demo.ts';
import {chromium} from 'playwright';
delete process.env.FRAME_LINE_SIGNUP_CODE;
const dir=await mkdtemp(join(tmpdir(),'sharedcut-clipboard-browser-'));
let app,browser;
try{
  const file=join(dir,'sound.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2',file]);
  const sound=await soundLibrary(dir).add(file,{name:'Clipboard Sound',category:'Test',tags:[],description:''});
  app=createFrameLineServer({dataDir:dir,distDir:resolve('dist')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const request=async(path,body,method=body?'POST':'GET')=>{const response=await context.request.fetch(`${base}/api${path}`,{method,data:body});assert.ok(response.ok(),`${path}: ${await response.text()}`);return response.json();};
  const user=(await request('/auth/signup',{name:'Clipboard Test',email:'clipboard@browser.test',password:'clipboard-browser-test'})).user;
  let snap=await request('/state');for(const id of ['from','to']){
    snap.state.projects.push({id,name:id==='from'?'Copy Source':'Paste Destination',description:'',shared:false,thumbnail:'',modifiedAt:1,duration:0,resolution:'1920 × 1080',fps:24,status:'In progress',members:[{userId:user.id,role:'Owner'}]});
    snap.state.timelines.push({id:`${id}-tl`,projectId:id,name:'Timeline',duration:180});snap.state.tracks.push({id:`${id}-a1`,timelineId:`${id}-tl`,name:'Audio 1',kind:'audio',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0});
  }
  await request('/state',snap,'PUT');const asset=(await request(`/sfx/${sound.id}/import`,{projectId:'from'})).asset;
  snap=await request('/state');snap.state.clips.push({id:'copied-sound',projectId:'from',timelineId:'from-tl',trackId:'from-a1',mediaId:asset.id,name:'Clipboard Sound',start:0,duration:2,sourceIn:0,color:'#427A68',disabled:false,properties:{...defaultProperties,gain:-4},effects:[]});await request('/state',snap,'PUT');
  await page.goto(`${base}/project/from`);await page.locator('[data-clip="copied-sound"]').click();await page.keyboard.press('Control+c');
  await page.getByRole('button',{name:'Back to projects',exact:true}).click();await page.getByText('Paste Destination',{exact:true}).first().dblclick();
  await page.waitForURL('**/project/to');await page.reload();await page.getByRole('button',{name:'Back to projects',exact:true}).waitFor();
  const links=[];page.on('request',r=>{if(r.url().includes('/api/media/link'))links.push(r);});await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>document.querySelectorAll('[data-clip]').length===1);
  let saved;for(let i=0;i<50;i++){saved=(await request('/state')).state;if(saved.clips.some(c=>c.projectId==='to'))break;await new Promise(r=>setTimeout(r,100));}
  const pasted=saved.clips.find(c=>c.projectId==='to');assert.ok(pasted);assert.equal(pasted.properties.gain,-4);assert.notEqual(pasted.mediaId,asset.id);assert.equal(links.length,1);assert.ok(saved.media.some(m=>m.projectId==='to'&&m.id===pasted.mediaId));
  await page.reload();await page.locator(`[data-clip="${pasted.id}"]`).waitFor();assert.deepEqual(errors,[]);
  console.log('PASS browser: copy → Home → different project → reload → paste → saved clip and linked media → reload; no page errors');
}finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
