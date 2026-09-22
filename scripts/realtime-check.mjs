import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFrameLineServer } from '../server/index.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp = await mkdtemp(join(tmpdir(), 'frameline-realtime-browser-'));
const app = createFrameLineServer({dataDir:temp,distDir:resolve('dist')});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${app.server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
const errors=[],contexts=[],pages=[],writes=[];
const result={};
try {
  for(let i=0;i<5;i++) {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
    const response=await context.request.post(`${url}/api/auth/signup`,{data:{name:`Editor ${i}`,email:`editor${i}@example.test`,password:'realtime-browser-password'}});assert.equal(response.status(),201);
    const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
    page.on('response',async r=>{if(r.url().includes('/api/')&&r.status()>=400)console.log('HTTP',r.status(),new URL(r.url()).pathname);});
    page.on('request',r=>{if(r.url().endsWith('/api/state')&&['PATCH','PUT'].includes(r.method()))writes.push({client:i,method:r.method(),bytes:Buffer.byteLength(r.postData()??''),keys:Object.keys(JSON.parse(r.postData()??'{}').delta??{})});});
  }
  const [actor,...observers]=pages;
  await actor.goto(url);
  await actor.getByRole('button',{name:'New project',exact:true}).click();
  await actor.getByRole('textbox',{name:'Project name'}).fill('Realtime performance');
  await actor.getByRole('button',{name:'Create project',exact:true}).click();
  await actor.getByRole('tab',{name:'Shapes',exact:true}).click();
  await actor.getByRole('button',{name:'Add Rectangle shape',exact:true}).click();
  await actor.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
  const projectUrl=actor.url();
  // Stop browser saves before seeding a large server snapshot directly.
  await actor.goto('about:blank');
  const snapshot=await (await contexts[0].request.get(`${url}/api/state`)).json();
  const template=snapshot.state.operations[0];
  snapshot.state.operations.push(...Array.from({length:2298},(_,i)=>({...template,id:`load-history-${i}`,description:'x'.repeat(3500),oldState:[],newState:[]})));
  result.workspaceBytes=Buffer.byteLength(JSON.stringify(snapshot.state));
  assert.equal((await contexts[0].request.put(`${url}/api/state`,{data:snapshot})).status(),200);
  await actor.goto(projectUrl);
  await Promise.all(observers.map(p=>p.goto(projectUrl)));
  await Promise.all(pages.map(p=>p.locator('.timeline-track').first().waitFor()));
  await Promise.all(pages.map(p=>p.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved')));
  await new Promise(resolve=>setTimeout(resolve,1200));
  await actor.bringToFront();
  const clip=snapshot.state.clips[0],track=snapshot.state.tracks.find(t=>t.id===clip.trackId);
  const row=actor.locator(`[data-track="${track.id}"]`).locator('..');
  const handle=row.getByRole('separator');
  const box=await handle.boundingBox();assert.ok(box);
  const before=(await row.boundingBox()).height;
  let renderId;
  if(process.env.REALTIME_RENDER==='1') {
    const response=await contexts[0].request.post(`${url}/api/renders`,{data:{projectId:snapshot.state.projects[0].id,name:'Realtime load check',preset:'Custom',settings:{timelineId:clip.timelineId,resolution:'3840 × 2160',fps:'24',codec:'H.264',audio:'Disabled',rangeIn:'0',rangeOut:'5'}}});
    assert.equal(response.status(),202);renderId=(await response.json()).job.id;
    const job=(await(await contexts[0].request.get(`${url}/api/renders`)).json()).jobs.find(j=>j.id===renderId);
    assert.equal(job.status,'rendering');result.renderAtStart=job.status;
  }

  await actor.evaluate(()=>{window.frameTimes=[];let last=performance.now();window.sampleFrames=true;const sample=now=>{if(!window.sampleFrames)return;window.frameTimes.push(now-last);last=now;requestAnimationFrame(sample);};requestAnimationFrame(sample);});
  writes.length=0;
  await actor.mouse.move(box.x+box.width/2,box.y+box.height/2);await actor.mouse.down();
  for(let i=1;i<=12;i++)await actor.mouse.move(box.x+box.width/2,box.y+box.height/2+i*3);
  const previewStarted=performance.now();
  await Promise.all(observers.map(p=>p.waitForFunction(({id,before})=>document.querySelector(`[data-track="${id}"]`)?.parentElement.getBoundingClientRect().height>before+20,{id:track.id,before},{timeout:1500})));
  result.heightPreviewMs=Math.round(performance.now()-previewStarted);
  assert.equal(writes.length,0,`Height motion must not write persistent state: ${JSON.stringify(writes)}`);
  const remoteCommits = observers.map(p => p.waitForResponse(async response => { if (!response.url().includes('/api/state?')) return false; const data = await response.json(); return data.delta?.tracks?.upsert?.some(t => t.id === track.id && t.height > before + 20); }, {timeout:3000}).then(() => performance.now()));
  const released=performance.now();await actor.mouse.up();
  await actor.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
  result.heightSavedMs=Math.round(performance.now()-released);
  if(renderId)result.renderAfterSave=(await(await contexts[1].request.get(`${url}/api/renders`)).json()).jobs.find(j=>j.id===renderId).status;
  result.remoteCommitMs=Math.round(Math.max(...await Promise.all(remoteCommits))-released);
  const frameTimes=await actor.evaluate(()=>{window.sampleFrames=false;return window.frameTimes;});
  result.frameP95Ms=Math.round(frameTimes.sort((a,b)=>a-b)[Math.floor(frameTimes.length*.95)]);
  const updated=await (await contexts[0].request.get(`${url}/api/state`)).json();
  assert.equal(updated.state.operations.length,snapshot.state.operations.length+1,'A height drag creates one history entry.');
  assert.ok(updated.state.tracks.find(t=>t.id===track.id).height>before+20);
  result.heightWriteBytes=writes.map(w=>w.bytes);
  assert.ok(writes.every(w=>w.method==='PATCH'&&w.bytes<10000),'Edits must not send saved history.');
  const ruler = await actor.locator('.timeline-ruler').boundingBox();
  await actor.mouse.move(ruler.x+30,ruler.y+10);
  const cursorSelector = `[data-remote-user="${snapshot.state.currentUserId}"] .remote-cursor`;
  await observers[0].waitForFunction(selector => document.querySelector(selector)?.style.visibility === 'visible', cursorSelector);
  const previous = await observers[0].locator(cursorSelector).evaluate(el=>el.style.transform);
  const cursorStarted = performance.now(); await actor.mouse.move(ruler.x+100,ruler.y+10);
  await observers[0].waitForFunction(({selector,previous})=>document.querySelector(selector)?.style.transform !== previous,{selector:cursorSelector,previous},{timeout:500});
  result.idleObserverCursorMs = Math.round(performance.now()-cursorStarted);
  // A live clip ghost reaches observers before mouse-up, then disappears after commit.
  const clipBox=await actor.locator(`[data-clip="${clip.id}"]`).first().boundingBox();assert.ok(clipBox);
  await actor.mouse.move(clipBox.x+clipBox.width/2,clipBox.y+clipBox.height/2);await actor.mouse.down();
  await actor.mouse.move(clipBox.x+clipBox.width/2+55,clipBox.y+clipBox.height/2,{steps:8});
  await Promise.all(observers.map(p=>p.locator(`[data-remote-preview="${clip.id}"]`).waitFor({timeout:1500})));
  await actor.mouse.up();
  await Promise.all(observers.map(p=>p.locator(`[data-remote-preview="${clip.id}"]`).waitFor({state:'detached',timeout:3000})));
  // A lost sender cannot leave a permanent preview.
  const moved=await actor.locator(`[data-clip="${clip.id}"]`).first().boundingBox();
  await actor.mouse.move(moved.x+moved.width/2,moved.y+moved.height/2);await actor.mouse.down();
  await actor.mouse.move(moved.x+moved.width/2+40,moved.y+moved.height/2,{steps:8});
  await observers[0].locator(`[data-remote-preview="${clip.id}"]`).waitFor({timeout:1500});
  await contexts[0].setOffline(true);
  await Promise.all(observers.map(p=>p.locator(`[data-remote-preview="${clip.id}"]`).waitFor({state:'detached',timeout:3500})));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(result,null,2));
  await writeFile(resolve(process.env.REALTIME_RENDER==='1'?'artifacts/realtime-performance-rendering.json':'artifacts/realtime-performance.json'),JSON.stringify(result,null,2)+'\n');
} catch(error) { console.log('ERRORS',errors);console.log(await pages[0]?.locator('body').innerText());throw error; } finally {await browser.close();await app.close();await rm(temp,{recursive:true,force:true});}
