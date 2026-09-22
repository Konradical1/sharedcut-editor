// Real imported media, isolated accounts/database; never edits the live project.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --experimental-strip-types scripts/newspaper-playback-check.mjs [data] [report.json]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { Transform } from 'node:stream';
import { createFrameLineServer } from '../server/index.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sourceData = resolve(process.argv[2] || 'data');
const sourceDb = new DatabaseSync(join(sourceData, 'frameline.sqlite'), { readOnly: true });
const source = JSON.parse(sourceDb.prepare('SELECT state FROM workspace WHERE id=1').get().state); sourceDb.close();
const project = source.projects.find(p => p.name.toLowerCase() === 'newspaper');
assert.ok(project, 'This benchmark needs the imported Newspaper footage.');
const imported = { project, ...Object.fromEntries(['media', 'timelines', 'tracks', 'clips', 'nodes'].map(k => [k, source[k].filter(x => x.projectId === project.id || k === 'tracks' && source.timelines.some(t => t.projectId === project.id && t.id === x.timelineId))])) };
if(process.env.QA_LONG_CLIP==='1'){
  const asset=imported.media.find(m=>m.name==='C1064.MP4');
  const clip=imported.clips.find(c=>c.mediaId===asset.id&&imported.tracks.some(t=>t.id===c.trackId&&t.kind==='video'));
  imported.clips=[{...clip,start:0,sourceIn:0,duration:asset.duration,properties:{...clip.properties,audioDetached:true}}];
  imported.media=[asset];imported.nodes=imported.nodes.filter(n=>n.clipId===clip.id);
}
if(process.env.QA_EMBEDDED_AUDIO==='1'){
  const first=imported.clips.find(c=>c.name==='C0961.MP4'&&imported.tracks.some(t=>t.id===c.trackId&&t.kind==='video'));
  imported.clips=imported.clips.filter(c=>c.mediaId!==first.mediaId||!imported.tracks.some(t=>t.id===c.trackId&&t.kind==='audio')).map(c=>c.mediaId===first.mediaId?{...c,properties:{...c.properties,audioDetached:false}}:c);
}
if (process.env.QA_BYPASS_LOOK === '1') imported.clips = imported.clips.map(c => ({ ...c, properties: { ...c.properties, bypassResolveLook: true } }));
const temp = await realpath(await mkdtemp(join(tmpdir(), 'frameline-playback-')));
await cp(resolve('dist'), join(temp, 'dist'), { recursive: true });
delete process.env.FRAME_LINE_SIGNUP_CODE;
let app = createFrameLineServer({ dataDir: temp, distDir: join(temp, 'dist') });
const listen = async () => { await new Promise(r => app.server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${app.server.address().port}`; };
let apiUrl = await listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: JSON.parse(process.env.QA_BROWSER_ARGS || '[]') });
let proxy; let sentBytes=0, nextByteAt=0, blockMedia=false, blockedMedia=0;
try {
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const registration = await context.request.post(apiUrl + '/api/auth/signup', { data: { name: 'Playback QA', email: 'playback@example.test', password: 'FrameLine-playback-QA-2026' } });
  assert.equal(registration.status(), 201); const owner = (await registration.json()).user;
  await app.close();
  const db = new DatabaseSync(join(temp, 'frameline.sqlite'));
  const state = JSON.parse(db.prepare('SELECT state FROM workspace WHERE id=1').get().state);
  state.projects = [{ ...project, members: [{ userId: owner.id, role: 'Owner' }] }];
  for (const k of ['media', 'timelines', 'tracks', 'clips', 'nodes']) state[k] = imported[k];
  db.prepare('UPDATE workspace SET state=?, revision=revision+1 WHERE id=1').run(JSON.stringify(state)); db.close();
  await mkdir(join(temp, 'media'), { recursive: true }); await mkdir(join(temp, 'resolve'), { recursive: true });
  for (const asset of imported.media) {
    const original = join(sourceData, 'media', asset.id), local = join(temp, 'media', asset.id);
    await mkdir(join(local, 'prepared'), { recursive: true });
    await cp(join(original, 'original'), join(local, 'original'), { mode: constants.COPYFILE_FICLONE });
    for (const file of await readdir(join(original, 'prepared'))) if (!file.startsWith('.')) await cp(join(original, 'prepared', file), join(local, 'prepared', file), { mode: constants.COPYFILE_FICLONE });
  }
  await cp(join(sourceData, 'resolve', project.id), join(temp, 'resolve', project.id), { recursive:true, mode:constants.COPYFILE_FICLONE });
  app = createFrameLineServer({ dataDir: temp, distDir: join(temp, 'dist') }); apiUrl = await listen();
  if (process.env.QA_BASELINE !== '1') {
    const deadline = Date.now() + 180000;
    for (;;) {
      const current = (await (await context.request.get(apiUrl + '/api/state')).json()).state;
      if (current.media.filter(m => m.kind === 'video').every(m => m.proxyVariants?.StreamLow)) break;
      assert.ok(Date.now() < deadline, 'Existing imports must acquire smaller preview streams.');
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error=>errors.push(error.message));
  page.on('response', response=>{if(/\.(mp4|m4a)(\?|$)/.test(response.url()))requests.push({url:response.url(),status:response.status(),worker:response.fromServiceWorker()});});
  await page.addInitScript(()=>{
    window.qaMedia=[];window.qaFrames=[];window.qaWaiting=[];window.qaHealth=[];
    window.addEventListener('frameline:playback-health',event=>window.qaHealth.push({at:performance.now(),...event.detail}));
    const create=document.createElement.bind(document);
    document.createElement=(name,...args)=>{const e=create(name,...args);if(name==='video'||name==='audio'){window.qaMedia.push(e);for(const type of ['play','playing','waiting','seeking','seeked','loadeddata','error'])e.addEventListener(type,()=>window.qaWaiting.push({at:performance.now(),type,url:e.src,time:e.currentTime}));}return e;};
    window.addEventListener('frameline:frame', event=>{const c=event.detail;window.qaFrames.push({at:performance.now(),clip:c.dataset.sourceClip,time:c.dataset.sourceTimestamp});});
  });
  const upstream=apiUrl;
  proxy=httpServer((req,res)=>{
    if(blockMedia&&/\.(mp4|m4a)(\?|$)/.test(req.url)){blockedMedia++;res.writeHead(503);res.end('Media origin deliberately unavailable for cache replay');return;}
    const call=httpRequest(upstream+req.url,{method:req.method,headers:req.headers},reply=>{
      res.writeHead(reply.statusCode,reply.headers);
      if(/\.(mp4|m4a)(\?|$)/.test(req.url)&&process.env.QA_DOWNLOAD_MBPS){
        const rate=Number(process.env.QA_DOWNLOAD_MBPS)*125000;
        const throttle=new Transform({transform(chunk,encoding,done){const now=Date.now();nextByteAt=Math.max(now,nextByteAt)+chunk.length/rate*1000;setTimeout(()=>{sentBytes+=chunk.length;done(null,chunk);},Math.max(0,nextByteAt-now));}});
        reply.pipe(throttle).pipe(res);res.on('close',()=>{reply.destroy();throttle.destroy();});
      }else reply.pipe(res);
    });call.on('error',()=>res.destroy());req.pipe(call);res.on('close',()=>call.destroy());
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));apiUrl=`http://127.0.0.1:${proxy.address().port}`;
  await page.goto(apiUrl+'/project/'+project.id);
  if(process.env.QA_QUALITY)await page.getByRole('combobox',{name:'Preview quality',exact:true}).selectOption(process.env.QA_QUALITY);
  if(process.env.QA_CPU_RATE){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:Number(process.env.QA_CPU_RATE)});}
  await page.locator('.footage-loading summary').click();
  const snapshot=()=>page.evaluate(async()=>({panel:document.querySelector('.footage-loading')?.innerText,cache:(await (await caches.open('footage-v3')).keys()).length,worker:navigator.serviceWorker.controller?.scriptURL,status:document.querySelector('.viewer-playback-status')?.textContent,time:document.querySelector('.transport-time')?.textContent,media:window.qaMedia.filter(e=>e.src).map(e=>({url:e.src,time:e.currentTime,ready:e.readyState,seeking:e.seeking,preload:e.preload}))}));
  await page.waitForTimeout(5000);const initial=await snapshot();console.log('AFTER5',JSON.stringify(initial));
  assert.ok(await page.locator('.clip-cache').count(),'Timeline clips show their local cache progress.');
  await page.waitForTimeout(Number(process.env.QA_WAIT_CACHE||0)*1000);
  await page.locator('.footage-loading summary').click();
  if(process.env.QA_OFFLINE_REPLAY==='1'){await page.waitForFunction(()=>{const text=document.querySelector('.footage-loading summary')?.textContent??'';const m=/(\d+)\/(\d+) cached/.exec(text);return m&&m[1]===m[2];},{},{timeout:120000});blockMedia=true;}
  if(process.env.QA_REOPEN==='1'||process.env.QA_OFFLINE_REPLAY==='1'){await page.reload();if(process.env.QA_QUALITY)await page.getByRole('combobox',{name:'Preview quality',exact:true}).selectOption(process.env.QA_QUALITY);await page.waitForFunction(()=>document.querySelector('.viewer canvas')?.dataset.hasPicture==='true');assert.ok((await snapshot()).cache>=initial.cache,'Saved footage survives reopening the project.');}
  const seek=time=>page.evaluate(start=>{const r=document.querySelector('.timeline-ruler'),box=r.getBoundingClientRect(),pixels=box.width/Number(r.dataset.timeSpan);r.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,button:0,buttons:1,clientX:box.left+start*pixels,clientY:box.top+5}));window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1}));},time);
  if(process.env.QA_VERIFY_PICTURES==='1'){
    await seek(6.1);
    const pictures=[];
    for(const workspace of ['Edit','Color']){
      await page.getByRole('navigation',{name:'Editor workspaces'}).getByRole('button',{name:workspace,exact:true}).click();
      for(const quality of ['Stream','1/4','1/2','Full','Color']){
        await page.getByRole('combobox',{name:'Preview quality',exact:true}).selectOption(quality);
        await page.waitForTimeout(500);
        await page.waitForFunction(()=>{const c=document.querySelector('.viewer-frame canvas');return c?.dataset.playbackEngine==='webcodecs'&&c.dataset.buffering==='false'&&c.dataset.hasPicture==='true';},{},{timeout:30000});
        const pixels=await page.evaluate(()=>{
          const c=document.querySelector('.viewer-frame canvas'),sample=document.createElement('canvas');sample.width=64;sample.height=36;
          const context=sample.getContext('2d');context.drawImage(c,0,0,64,36);const data=context.getImageData(0,0,64,36).data;
          let lit=0;for(let i=0;i<data.length;i+=4)if(data[i]+data[i+1]+data[i+2]>45)lit++;
          return {lit:lit/(64*36),clip:c.dataset.sourceClip,precision:c.dataset.colorPrecision,engine:c.dataset.playbackEngine};
        });
        pictures.push({workspace,quality,...pixels});console.log('PICTURE',JSON.stringify(pictures.at(-1)));
        await mkdir('artifacts/qa',{recursive:true});await writeFile(process.argv[3]||'artifacts/qa/newspaper-pictures.json',JSON.stringify(pictures,null,2));
        assert.ok(pixels.lit>.2,`${workspace} ${quality} must show the camera picture, not black with text overlays.`);
      }
    }
    assert.deepEqual(errors,[]);console.log('PASS visible camera pixels in every preview quality in Edit and Color.');
  }else{
  await seek(Number(process.env.QA_START||5.2));
  await page.waitForTimeout(1500);
  await page.evaluate(()=>{window.qaFrames=[];window.qaWaiting=[];window.qaHealth=[];});
  await page.getByRole('button',{name:'Play playback',exact:true}).click();
  await page.waitForTimeout(Number(process.env.QA_PLAY_SECONDS||20)*1000);
  await page.getByRole('button',{name:'Pause playback',exact:true}).click();
  const result=await page.evaluate(()=>{
    const frames=window.qaFrames.filter((f,i,a)=>!i||!f.clip||f.clip!==a[i-1].clip||f.time!==a[i-1].time),gaps=frames.slice(1).map((f,i)=>f.at-frames[i].at),cuts=frames.flatMap((f,i)=>i&&f.clip!==frames[i-1].clip?[{clip:f.clip,gap:f.at-frames[i-1].at,firstFrames:frames.slice(i,i+6).map((next,j)=>({time:next.time,gap:j?next.at-frames[i+j-1].at:0,clip:next.clip}))}]:[]);
    const gl=document.createElement('canvas').getContext('webgl2'),debug=gl?.getExtension('WEBGL_debug_renderer_info');
    return {health:window.qaHealth,frames:frames.length,maxGapMs:Math.max(0,...gaps),cuts,slowFrames:frames.slice(1).flatMap((f,i)=>f.at-frames[i].at>100?[{...f,gap:f.at-frames[i].at}]:[]),renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'unavailable',waits:window.qaWaiting};
  });
  result.blockedMedia=blockedMedia;result.initial=initial;result.snapshot=await snapshot();result.errors=errors;result.sentBytes=sentBytes;result.network=requests;
  await mkdir('artifacts/qa',{recursive:true});await writeFile(process.argv[3]||'artifacts/qa/newspaper-playback.json',JSON.stringify(result,null,2));
  // Completing the whole timeline cache is separate from instant/current playback readiness.
  await page.waitForFunction(()=>{const text=document.querySelector('.footage-loading summary')?.textContent??'';const match=/(\d+)\/(\d+) cached/.exec(text);return match&&Number(match[1])>0&&match[1]===match[2];},{},{timeout:120000});
  result.completedCache=await snapshot();
  await mkdir('artifacts/qa',{recursive:true});await writeFile(process.argv[3]||'artifacts/qa/newspaper-playback.json',JSON.stringify(result,null,2));
  console.log('RESULT',JSON.stringify({...result,network:requests.length,waits:result.waits.length,health:result.health.length}));
  await page.screenshot({path:'artifacts/qa/newspaper-playback.png'});
  await page.waitForTimeout(350);
  const paused=await page.locator('.viewer canvas').getAttribute('data-source-timestamp');
  await page.waitForTimeout(200);assert.equal(await page.locator('.viewer canvas').getAttribute('data-source-timestamp'),paused,'Decoding ahead must not move the paused picture.');
  await seek(6.1);
  const seekClip=imported.clips.find(c=>(process.env.QA_LONG_CLIP==='1'||c.name==='C0961.MP4')&&c.start<=6.1&&c.start+c.duration>6.1&&imported.tracks.some(t=>t.id===c.trackId&&t.kind==='video'));
  await page.waitForFunction(id=>document.querySelector('.viewer canvas')?.dataset.sourceClip===id,seekClip.id);
  await page.waitForTimeout(300);
  const seekTime=Number(await page.locator('.viewer canvas').getAttribute('data-source-timestamp'));
  assert.ok(Math.abs(seekTime-(seekClip.sourceIn+6.1-seekClip.start))<2/project.fps,'Seeking back selects a frame at the requested source time.');
  if(process.env.QA_EMBEDDED_AUDIO==='1'){
    const soundUrl=imported.media.find(m=>m.id===seekClip.mediaId).audioProxyUrl;
    assert.ok(await page.evaluate(url=>window.qaMedia.some(e=>e.tagName==='AUDIO'&&e.src.endsWith(url)),soundUrl),'Embedded sound uses a separate timeline decoder.');
    assert.ok(result.waits.some(event=>event.type==='playing'&&event.url.endsWith(soundUrl)),'The embedded sound decoder actually played.');
  }
  assert.deepEqual(errors,[]);
  if(process.env.QA_OFFLINE_REPLAY==='1')assert.equal(blockedMedia,0,'Cached playback must not need the media origin.');
  const playingHealth=result.health.filter(h=>h.playing);
  assert.ok(playingHealth.some(h=>h.engine==='webcodecs'),'Exercise direct frame decoding, not a silent fallback.');
  assert.equal(playingHealth.filter(h=>h.loading).length,0,'Continuous playback must not repeatedly enter the loading state.');
  assert.equal(playingHealth.filter(h=>h.error).length,0,'Playback errors cannot masquerade as successful non-loading frames.');
  assert.ok(result.snapshot.cache>=initial.cache&&result.snapshot.cache>1,'Playback retains and fills the persistent cache.');
  const cuts=result.cuts.filter(c=>c.clip).map(c=>c.gap).sort((a,b)=>a-b);
  if(process.env.QA_LONG_CLIP!=='1')assert.ok(cuts.length>=5,'Exercise multiple real cuts.');
  assert.ok(result.maxGapMs<Number(process.env.QA_MAX_FRAME_GAP||250),'No long visual freeze during playback.');
  const motion=result.cuts.filter(c=>c.clip&&c.firstFrames[1]?.clip===c.clip).map(c=>c.firstFrames[1].gap).sort((a,b)=>a-b);
  if(motion.length)assert.ok(motion.at(-1)<70,'Motion must continue immediately after the first picture at every cut.');
  assert.ok(result.frames>=Number(process.env.QA_PLAY_SECONDS||20)*project.fps*.92,'Deliver at least 92% of timeline frames.');
  if(cuts.length)assert.ok(cuts.at(-1)<Number(process.env.QA_MAX_CUT_GAP||70),'Every cut should complete within the cut-gap budget.');
  }
} finally {await browser.close();if(proxy)await new Promise(resolve=>proxy.close(resolve));await app.close();await rm(temp,{recursive:true,force:true});}
