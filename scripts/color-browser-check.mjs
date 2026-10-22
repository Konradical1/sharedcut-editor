import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
import {mkdtemp,readFile,rm,mkdir,writeFile,copyFile,cp} from 'node:fs/promises';
import {copyFolder,linkMediaFolder} from './media-copy.mjs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFrameLineServer} from '../server/index.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const imported=JSON.parse(await readFile(process.argv[2],'utf8')),sourceData=resolve(process.argv[3]||'data');
const temp=await mkdtemp(join(tmpdir(),'frameline-color-browser-'));delete process.env.FRAME_LINE_SIGNUP_CODE;
await cp(resolve('dist'),join(temp,'dist'),{recursive:true});
let app=createFrameLineServer({dataDir:temp,distDir:join(temp,'dist')}),url='';const listen=async()=>{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${app.server.address().port}`;};await listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}),a=await browser.newContext({viewport:{width:1512,height:982}}),b=await browser.newContext({viewport:{width:1280,height:900}});
try {
  const register=async(context,name)=>{const r=await context.request.post(url+'/api/auth/signup',{data:{name,email:name.toLowerCase()+'@example.test',password:'FrameLine-color-QA-2026'}});assert.equal(r.status(),201);return(await r.json()).user;};
  const owner=await register(a,'ColorOwner'),peer=await register(b,'ColorPeer');await app.close();
  const db=new DatabaseSync(join(temp,'frameline.sqlite'));const row=db.prepare('select state from workspace where id=1').get(),state=row?JSON.parse(row.state):{projects:[],media:[],timelines:[],tracks:[],clips:[],nodes:[],comments:[],operations:[],snapshots:[],renderJobs:[],users:[],currentUserId:'',settings:{}};
  imported.project.shared=true;imported.project.members=[{userId:owner.id,role:'Owner'},{userId:peer.id,role:'Editor'}];
  state.projects=[imported.project];for(const k of ['media','timelines','tracks','clips','nodes'])state[k]=imported[k];
  db.prepare('insert into workspace(id,revision,state) values(1,1,?) on conflict(id) do update set state=excluded.state').run(JSON.stringify(state));db.close();
  await mkdir(join(temp,'media'));await mkdir(join(temp,'resolve'));
  for(const asset of imported.media)await linkMediaFolder(join(sourceData,'media',asset.id),join(temp,'media',asset.id));
  await copyFolder(join(sourceData,'resolve',imported.project.id),join(temp,'resolve',imported.project.id));
  app=createFrameLineServer({dataDir:temp,distDir:join(temp,'dist')});await listen();
  // Cookies are host scoped and survive a change of localhost port.
  const page=await a.newPage(),second=await b.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/project/'+imported.project.id);await page.getByRole('navigation',{name:'Editor workspaces'}).getByRole('button',{name:'Color',exact:true}).click();
  await page.getByRole('button',{name:'Shot 18: C0973.MP4',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.viewer-frame canvas')?.dataset.hasPicture==='true');
  await page.waitForTimeout(1200);
  await mkdir('artifacts/qa',{recursive:true});
  const shots=imported.clips.filter(c=>c.properties.resolveLookUrl).sort((a,b)=>a.start-b.start),comparisons=[];
  for(const [i,shot] of shots.entries()){
    await page.getByRole('button',{name:`Shot ${i+1}: ${shot.name}`,exact:true}).click();
    const target=shot.sourceIn+Number(shot.properties.resolveReferenceTime)-shot.start;
    try { await page.waitForFunction(({id,target})=>{const c=document.querySelector('.viewer-frame canvas');return c?.dataset.sourceClip===id&&Math.abs(Number(c.dataset.sourceTimestamp)-target)<.002;},{id:shot.id,target},{timeout:20000}); }
    catch (error) { console.log('Reference seek failed', { shot:i+1, target, actual:await page.locator('.viewer-frame canvas').evaluate(c=>({...c.dataset})), status:await page.locator('.viewer-stage').innerText() }); throw error; }
    await page.waitForTimeout(120);
    const frameFile=join(temp,`browser-shot-${i+1}.png`);
    await writeFile(frameFile,Buffer.from(await page.locator('.viewer-frame canvas').evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
    const referenceFile=join(sourceData,'resolve',imported.project.id,String(shot.properties.resolveReferenceUrl).split('/').at(-1));
    // Use the same area resampling for both full-resolution images; browser downsampling varies by GPU.
    const pixels=async file=>(await run('ffmpeg',['-v','error','-i',file,'-vf','scale=160:90:flags=area','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:2e6})).stdout;
    const [p,r]=await Promise.all([pixels(frameFile),pixels(referenceFile)]);let error=0,light=0,bias=[0,0,0];for(let n=0;n<p.length;n++){error+=Math.abs(p[n]-r[n]);light+=p[n];bias[n%3]+=p[n]-r[n];}
    const compare={meanError:error/p.length,meanSignal:light/p.length,bias:bias.map(v=>v/(p.length/3))};
    if(i===0)await copyFile(frameFile,'artifacts/qa/newspaper-first-corrected.png');
    assert.ok(compare.meanSignal>10,'Managed preview must contain real picture.');assert.ok(compare.meanError<2.5,JSON.stringify({shot:i+1,...compare}));comparisons.push({shot:i+1,...compare});
    if(i===1){await page.screenshot({path:'artifacts/qa/newspaper-first-shots.png'});await writeFile('artifacts/qa/newspaper-matched-frame.png',Buffer.from(await page.locator('.viewer-frame canvas').evaluate(c=>c.toDataURL().split(',')[1]),'base64'));}
  }
  await writeFile('artifacts/qa/newspaper-browser-color.json',JSON.stringify(comparisons,null,2));console.log('PASS all 25 proxy / Resolve reference frames', {worstMeanRGBError:Math.max(...comparisons.map(c=>c.meanError))});
  await page.getByRole('button',{name:'Shot 18: C0973.MP4',exact:true}).click();await page.waitForTimeout(500);await page.screenshot({path:'artifacts/qa/newspaper-color.png'});
  // A real pointer gesture crosses a server save before its final value. One Ctrl-Z must undo all of it.
  const wheel=page.getByRole('group',{name:'Shadows color balance; use RGB fields for keyboard control'}),box=await wheel.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.4);await page.waitForTimeout(700);
  await page.evaluate(()=>{window.gradeFrames=[];window.gradeDurations=[];window.gradeListener=()=>window.gradeFrames.push(performance.now());window.addEventListener('frameline:frame',window.gradeListener);});
  const timings=[];
  for(let i=0;i<40;i++){const start=performance.now();await page.mouse.move(box.x+box.width*(.6+.18*Math.sin(i/10)),box.y+box.height*(.4+.15*Math.cos(i/10)));timings.push(performance.now()-start);await page.waitForTimeout(16);}
  await page.mouse.up();await page.waitForTimeout(500);
  const performanceResult=await page.evaluate(()=>{window.removeEventListener('frameline:frame',window.gradeListener);const t=window.gradeFrames;return {frames:t.length,duration:t.at(-1)-t[0],intervals:t.slice(1).map((v,i)=>v-t[i])};});
  const sorted=timings.sort((a,b)=>a-b);console.log('Color pointer performance',{p95InputMs:sorted[Math.floor(sorted.length*.95)],updates:performanceResult.frames,measuredFps:1000*(performanceResult.frames-1)/performanceResult.duration});assert.ok(sorted[Math.floor(sorted.length*.95)]<100,'Color drag must not block each input for a LUT rebuild.');
  await page.keyboard.press('Control+z');await page.waitForTimeout(500);assert.equal(await page.getByLabel('Shadows R',{exact:true}).inputValue(),'0');assert.equal(await page.getByLabel('Shadows G',{exact:true}).inputValue(),'0');console.log('PASS pointer drag undo across sync saves');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  const gpuTiming=await page.evaluate(async()=>{
    const wheel=document.querySelector('.color-wheel'),box=wheel.getBoundingClientRect(),costs=[],latencies=[],times=[];let lastInput=0;
    const painted=()=>{if(lastInput){latencies.push(performance.now()-lastInput);times.push(performance.now());}};window.addEventListener('frameline:frame',painted);
    await new Promise(resolve=>{let i=0;const tick=()=>{const start=performance.now();lastInput=start;wheel.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,buttons:1,clientX:box.x+box.width*(.5+.2*Math.sin(i/15)),clientY:box.y+box.height*(.5+.2*Math.cos(i/15))}));costs.push(performance.now()-start);if(++i<120)requestAnimationFrame(tick);else requestAnimationFrame(resolve);};requestAnimationFrame(tick);});window.removeEventListener('frameline:frame',painted);
    const quantile=(a,q)=>a.sort((x,y)=>x-y)[Math.floor((a.length-1)*q)];const gl=document.createElement('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return {gpu:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),p95HandlerMs:quantile(costs,.95),p95PaintLatencyMs:quantile(latencies,.95),paintFps:(times.length-1)*1000/(times.at(-1)-times[0])};
  });await page.mouse.up();await page.keyboard.press('Control+z');console.log('RAF color drag benchmark',gpuTiming);await writeFile('artifacts/qa/color-performance.json',JSON.stringify(gpuTiming,null,2));assert.ok(gpuTiming.p95HandlerMs<20,'Pointer handling must remain responsive.');
  const exposure=page.getByLabel('Exposure',{exact:true}),range=await exposure.boundingBox();await page.mouse.move(range.x+range.width*.5,range.y+range.height*.5);await page.mouse.down();await page.mouse.move(range.x+range.width*.55,range.y+range.height*.5);await page.waitForTimeout(500);await page.mouse.move(range.x+range.width*.6,range.y+range.height*.5);await page.mouse.up();await page.keyboard.press('Control+z');assert.equal(await page.getByLabel('Exposure value',{exact:true}).inputValue(),'0');
  await page.getByLabel('Exposure value',{exact:true}).fill('0.7');await page.waitForTimeout(500);await page.keyboard.press('Control+z');assert.equal(await page.getByLabel('Exposure value',{exact:true}).inputValue(),'0');await page.getByRole('button',{name:'Shot 18: C0973.MP4',exact:true}).click();console.log('PASS focused sliders and numeric fields undo');
  const curve=page.locator('.color-curves circle').nth(1),point=await curve.boundingBox();await page.mouse.move(point.x+point.width/2,point.y+point.height/2);await page.mouse.down();await page.mouse.move(point.x+point.width/2,point.y-8);await page.waitForTimeout(600);await page.mouse.move(point.x+point.width/2,point.y-25);await page.mouse.up();await page.keyboard.press('Control+z');assert.equal(await page.getByLabel('Midtones value',{exact:true}).inputValue(),'0.5');
  await page.getByRole('button',{name:'Shot 1: C0961.MP4',exact:true}).click();await page.waitForTimeout(1200);
  const loading=[];await page.exposeFunction('recordLoading',text=>loading.push(text));await page.evaluate(()=>{window.colorObserver=new MutationObserver(()=>{const t=document.querySelector('.viewer-playback-status')?.textContent;if(t&&/Loading|Preparing|Decoding/.test(t))window.recordLoading(t);});window.colorObserver.observe(document.querySelector('.viewer-frame'),{subtree:true,childList:true,characterData:true});});
  await page.getByRole('button',{name:'Play playback',exact:true}).click();await page.waitForTimeout(6500);await page.getByRole('button',{name:'Pause playback',exact:true}).click();await page.evaluate(()=>window.colorObserver.disconnect());assert.deepEqual(loading,[]);console.log('PASS continuous playback across five edits without loading overlays');
  await page.getByRole('button',{name:'Shot 18: C0973.MP4',exact:true}).click();
  await second.goto(url+'/project/'+imported.project.id);await second.getByRole('navigation',{name:'Editor workspaces'}).getByRole('button',{name:'Color',exact:true}).click();await second.getByRole('button',{name:'Shot 18: C0973.MP4',exact:true}).click();
  await Promise.all([page.getByLabel('Exposure value',{exact:true}).fill('0.4'),second.getByLabel('Contrast value',{exact:true}).fill('1.15')]);
  const id=imported.clips.filter(c=>c.properties.resolveLookUrl)[17].id;
  await page.waitForTimeout(1600);const saved=(await(await a.request.get(url+'/api/state')).json()).state.nodes.find(n=>n.clipId===id);assert.equal(saved.parameters.exposure,.4);assert.equal(saved.parameters.contrast,1.15);
  assert.equal(await page.getByLabel('Contrast value',{exact:true}).inputValue(),'1.15');assert.equal(await second.getByLabel('Exposure value',{exact:true}).inputValue(),'0.4');console.log('PASS two clients preserve simultaneous grade fields');
  await page.getByRole('button',{name:'Add correction node',exact:true}).click();await page.getByLabel('Offset R',{exact:true}).fill('0.05');await page.getByLabel('Shadows value',{exact:true}).fill('20');await page.getByRole('button',{name:'Move node earlier',exact:true}).click();await page.waitForTimeout(800);
  const changed=(await(await a.request.get(url+'/api/state')).json()).state.nodes.filter(n=>n.clipId===id).sort((a,b)=>a.order-b.order);assert.equal(changed[0].parameters.offsetR,.05);assert.equal(changed[0].parameters.shadows,20);console.log('PASS RGB wheel channels, curve and node order persist');
  await page.setViewportSize({width:1100,height:800});await page.screenshot({path:'artifacts/qa/newspaper-color-1100.png'});
  const fit=await page.evaluate(()=>{const root=document.querySelector('.resolve-color'),viewer=document.querySelector('.color-viewer');return {overflow:document.documentElement.scrollWidth>innerWidth,viewerWidth:viewer.getBoundingClientRect().width,rootWidth:root.getBoundingClientRect().width};});assert.equal(fit.overflow,false);assert.ok(fit.viewerWidth>fit.rootWidth*.5);assert.deepEqual(errors,[]);console.log('PASS color layout, renderer and browser errors',fit);
  const compatibility=await a.newPage();await compatibility.addInitScript(()=>{Object.defineProperty(window,'VideoFrame',{value:undefined});Object.defineProperty(crypto,'randomUUID',{value:undefined});});
  await compatibility.goto(url+'/project/'+imported.project.id);await compatibility.getByRole('navigation',{name:'Editor workspaces'}).getByRole('button',{name:'Color',exact:true}).click();await compatibility.getByRole('button',{name:'Shot 2: C0961.MP4',exact:true}).click();await compatibility.waitForFunction(()=>document.querySelector('.viewer-frame canvas')?.dataset.hasPicture==='true');await compatibility.waitForTimeout(600);
  const compatibilityPng=join(temp,'compatibility.png');await writeFile(compatibilityPng,Buffer.from(await compatibility.locator('.viewer-frame canvas').evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
  const rgb=async file=>(await run('ffmpeg',['-v','error','-i',file,'-vf','scale=160:90:flags=area','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:2e6})).stdout;
  const [compatPixels,refPixels]=await Promise.all([rgb(compatibilityPng),rgb(join(sourceData,'resolve',imported.project.id,String(shots[1].properties.resolveReferenceUrl).split('/').at(-1)))]);const compatibilityError=compatPixels.reduce((sum,v,i)=>sum+Math.abs(v-refPixels[i]),0)/compatPixels.length;assert.ok(compatibilityError<2.5,String(compatibilityError));
  await compatibility.getByLabel('Exposure value',{exact:true}).fill('0.3');await compatibility.keyboard.press('Control+z');assert.equal(await compatibility.getByLabel('Exposure value',{exact:true}).inputValue(),'0');await compatibility.close();console.log('PASS browser compatibility without secure-context VideoFrame/randomUUID',compatibilityError);
  const bundle=join(temp,'bundle');await mkdir(bundle);
  const manifest=JSON.parse(await readFile(join(sourceData,'resolve',imported.project.id,'project.frameline.json'),'utf8'));
  const otio=JSON.parse(await readFile(join(sourceData,'resolve',imported.project.id,'timeline-1.otio'),'utf8'));
  const originalTrack=manifest.timelines[0].tracks.find(t=>t.kind==='video'), first=originalTrack.items[0];
  manifest.name='Newspaper Import QA';manifest.timelines=[{...manifest.timelines[0],endFrame:first.endFrame,tracks:[{...originalTrack,items:[first]}]}];manifest.media=manifest.media.filter(m=>m.id===first.mediaId);
  otio.tracks.children=[{...otio.tracks.children[0],children:[otio.tracks.children[0].children.find(c=>c.OTIO_SCHEMA.startsWith('Clip.'))]}];
  await writeFile(join(bundle,'project.frameline.json'),JSON.stringify(manifest));await writeFile(join(bundle,'timeline-1.otio'),JSON.stringify(otio));
  for(const file of ['project.drp',first.lookFile,first.referenceFile])await copyFile(join(sourceData,'resolve',imported.project.id,file),join(bundle,file));
  const media=imported.media.find(m=>m.name===first.name);await copyFile(join(sourceData,'media',media.id,'original'),join(bundle,first.name));
  const importPage=await a.newPage();await importPage.goto(url);await importPage.getByRole('button',{name:'Import Resolve',exact:true}).click();
  await importPage.getByLabel('Resolve manifest',{exact:true}).setInputFiles(join(bundle,'project.frameline.json'));
  await importPage.getByLabel('Resolve bundle and media folders',{exact:true}).setInputFiles(bundle);
  await importPage.getByRole('button',{name:'Import project',exact:true}).click();
  await importPage.getByText('Timeline and originals uploaded. Proxies are processing on the server.',{exact:true}).waitFor({timeout:120000});
  await importPage.getByRole('button',{name:'Open project',exact:true}).click();
  await importPage.getByRole('navigation',{name:'Editor workspaces'}).getByRole('button',{name:'Color',exact:true}).click();
  await importPage.getByRole('button',{name:'Shot 1: C0961.MP4',exact:true}).click();
  await importPage.waitForFunction(()=>document.querySelector('.viewer-frame canvas')?.dataset.hasPicture==='true',{},{timeout:120000});
  const after=(await(await a.request.get(url+'/api/state')).json()).state;
  const newProject=after.projects.find(p=>p.name==='Newspaper Import QA');assert.ok(newProject);assert.equal(newProject.shared,false);
  const newAssets=after.media.filter(m=>m.projectId===newProject.id);assert.equal(newAssets.length,1);
  for(let tries=0;tries<120;tries++){const latest=(await(await a.request.get(url+'/api/state')).json()).state.media.find(m=>m.id===newAssets[0].id);if(latest.status==='ready'){assert.equal(latest.inputProfile,'S-Log3');break;}assert.notEqual(latest.status,'failed',latest.error);assert.ok(tries<119);await importPage.waitForTimeout(500);}
  console.log('PASS Resolve import UI uploads a real Sony original, LUT and reference in resumable chunks');
}finally{await browser.close();await app.close();await rm(temp,{recursive:true,force:true});}
