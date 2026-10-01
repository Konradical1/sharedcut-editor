// Isolated copy of a real project; the live database and camera originals are never edited.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readWorkspace} from './workspace-db.mjs';
import {createFrameLineServer} from '../server/index.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const temp=await mkdtemp(join(tmpdir(),'frameline-overhaul-')),out=resolve('artifacts/qa/color-reference/ui');await mkdir(out,{recursive:true});
delete process.env.FRAME_LINE_SIGNUP_CODE;
const source=new DatabaseSync('data/frameline.sqlite',{readOnly:true}),live=readWorkspace(source).state;source.close();
const asset=live.media.find(m=>m.name==='C0852.MP4');assert.ok(asset,'Test needs Newspaper C0852.MP4');
const original=live.clips.find(c=>c.mediaId===asset.id),project=structuredClone(live.projects.find(p=>p.id===asset.projectId));
let app=createFrameLineServer({dataDir:temp,distDir:resolve('dist')}),url='';
const listen=async()=>{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${app.server.address().port}`;};await listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
const context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.colorVideos=[];const create=document.createElement.bind(document);document.createElement=(name,...args)=>{const e=create(name,...args);if(name==='video')window.colorVideos.push(e);return e;};const NativeAudio=window.AudioContext;window.AudioContext=class extends NativeAudio{constructor(options={}){super({...options,sinkId:{type:'none'}});}};});
try{
 const signup=await context.request.post(url+'/api/auth/signup',{data:{name:'Color QA',email:'color-overhaul@example.test',password:'FrameLine-Color-Test-2026'}});assert.equal(signup.status(),201);const {user}=await signup.json();await app.close();
 const db=new DatabaseSync(join(temp,'frameline.sqlite'));const row=db.prepare('select state from workspace where id=1').get();const state=row?JSON.parse(row.state):{projects:[],media:[],clips:[],tracks:[],nodes:[],timelines:[],comments:[],operations:[],snapshots:[],renderJobs:[],users:[],currentUserId:'',settings:{}};
 project.members=[{userId:user.id,role:'Owner'}];project.shared=false;
 const clip={...structuredClone(original),start:0,duration:3,sourceIn:3,keyframes:{},properties:{...original.properties,zoom:100,x:0,y:0,opacity:100}};
 Object.assign(state,{projects:[project],media:[{...asset,colorProxyUrl:`/api/media/${asset.id}/files/color-v1.mp4`}],clips:[clip],tracks:live.tracks.filter(t=>t.timelineId===clip.timelineId),timelines:live.timelines.filter(t=>t.id===clip.timelineId).map(t=>({...t,duration:3})),nodes:live.nodes.filter(n=>n.clipId===clip.id),comments:[],operations:[],snapshots:[],renderJobs:[],settings:{...state.settings,performanceMode:'On'}});
 for(const n of state.nodes)for(const e of n.effects??[])if(e.type==='cst'&&e.toneMapping==='aces2'){e.toneMapping='shoulder';e.gamutMapping='compress';}
 db.prepare('insert into workspace(id,revision,state) values(1,1,?) on conflict(id) do update set state=excluded.state').run(JSON.stringify(state));db.close();
 await mkdir(join(temp,'media'));await symlink(resolve('data/media',asset.id),join(temp,'media',asset.id));await mkdir(join(temp,'resolve'));await symlink(resolve('data/resolve',project.id),join(temp,'resolve',project.id));
 app=createFrameLineServer({dataDir:temp,distDir:resolve('dist')});await listen();
 const saved=async()=> (await(await context.request.get(url+'/api/state')).json()).state;
 const settled=()=>page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
 await page.goto(url+'/project/'+project.id);await page.getByRole('navigation',{name:'Editor workspaces'}).getByRole('button',{name:'Color',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.viewer-frame canvas')?.dataset.hasPicture==='true');
 assert.equal(await page.getByLabel('Preview quality').inputValue(),'Color');
 await page.screenshot({path:join(out,'before-upgrade.png')});
 const before=await saved();await page.getByRole('button',{name:'Use ACES 2 output',exact:true}).click();await settled();
 const after=await saved();assert.equal(after.snapshots.length,before.snapshots.length+1);
 for(const n of before.nodes){const updated=after.nodes.find(x=>x.id===n.id);assert.deepEqual(updated.parameters,n.parameters);assert.deepEqual(updated.curves,n.curves);}
 assert.ok(after.nodes.some(n=>n.effects?.some(e=>e.toneMapping==='aces2')));
 await page.waitForTimeout(1000);await page.screenshot({path:join(out,'aces-1600.png')});
 assert.match(await page.locator('.color-status').innerText(),/10-bit YUV/);
 await page.getByRole('slider',{name:'Scrub color footage',exact:true}).fill('1');await page.waitForTimeout(700);
 await page.screenshot({path:join(out,'sky-1600.png')});
 await page.getByRole('button',{name:'Play playback',exact:true}).click();await page.waitForTimeout(1400);await page.getByRole('button',{name:'Pause playback',exact:true}).click();
 assert.match(await page.locator('.color-status').innerText(),/10-bit YUV/);
 for(const width of [1280,1920]){await page.setViewportSize({width,height:1000});await page.screenshot({path:join(out,`aces-${width}.png`)});}
 await page.reload();await page.waitForFunction(()=>document.querySelector('.viewer-frame canvas')?.dataset.hasPicture==='true');assert.ok((await saved()).nodes.some(n=>n.effects?.some(e=>e.toneMapping==='aces2')));
 const payload=await(await context.request.get(url+'/api/state')).json();payload.state.clips[0].properties.opticalFlow=true;payload.state.clips[0].properties.speed=50;payload.state.clips[0].duration=.5;payload.state.timelines[0].duration=.5;
 const write=await context.request.put(url+'/api/state',{data:payload});assert.equal(write.status(),200,await write.text());await page.reload();await page.getByRole('navigation',{name:'Editor workspaces'}).getByRole('button',{name:'Color',exact:true}).click();
 await page.waitForFunction(()=>window.colorVideos.some(v=>v.currentSrc.includes('/api/optical-flow/')&&v.readyState>=2),{},{timeout:60000});
 await page.waitForTimeout(700);assert.match(await page.locator('.color-status').innerText(),/10-bit YUV/);await page.screenshot({path:join(out,'optical-flow.png')});
 console.log('PASS optical-flow cache is actually decoded in Color quality with 10-bit planes.');
 assert.deepEqual(errors,[]);console.log('PASS high-precision default, saved upgrade, correction/curve preservation, 10-bit playback, reload and visual checks at three sizes.');
} catch(error){await page.screenshot({path:join(out,'failure.png')});throw error;}finally{await browser.close();await app.close();await rm(temp,{recursive:true,force:true});}
