import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createFrameLineServer } from '../server/index.ts';
import { browserExecutable } from './browser-options.mjs';
delete process.env.FRAME_LINE_SIGNUP_CODE; // Isolated test installation; no deployment registration policy is changed.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const run = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'frameline-browser-'));
await cp(resolve(process.env.QA_DIST||'dist'),join(temp,'dist'),{recursive:true});
const app = createFrameLineServer({dataDir:join(temp,'data'),distDir:join(temp,'dist')});
await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({headless:true,executablePath:browserExecutable()});
const context = await browser.newContext({viewport:{width:1440,height:900}});
const page = await context.newPage();
await page.addInitScript(() => {
  // Headless CoreAudio can stop after one quantum; a silent sink still runs the full audio graph.
  const NativeAudio=window.AudioContext;window.AudioContext=class extends NativeAudio{constructor(options={}){super({...options,sinkId:{type:'none'}});}};
  window.qaVideos = []; window.qaSeekTimes = [];
  const create = document.createElement.bind(document);
  document.createElement = (name, ...args) => {
    const element = create(name, ...args);
    if (name === 'video') {
      window.qaVideos.push(element);
      let started;
      element.addEventListener('seeking', () => { started = performance.now(); });
      element.addEventListener('seeked', () => { if (started !== undefined) window.qaSeekTimes.push(performance.now() - started); });
    }
    return element;
  };
});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('response',async response=>{if(response.status()>=400)console.log('HTTP',response.status(),new URL(response.url()).pathname,(await response.text().catch(()=>'' )).slice(0,250));});
page.on('console',message=>{if(message.type()==='error')console.log('BROWSER',message.text());});
const out=resolve('artifacts/qa');
await mkdir(out,{recursive:true});
const state = async()=> (await (await context.request.get(`${url}/api/state`)).json()).state;
try {
  const fixture=join(temp,'Test footage.mp4');
  await run(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',fixture]);
  await page.goto(url);
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('textbox',{name:'Your name'}).fill('QA Editor');
  await page.getByRole('textbox',{name:'Email address'}).fill('qa-editor@example.test');
  await page.locator('input[type=password]').fill('Studio-QA-Password-2026');
  await page.getByRole('button',{name:'Create account',exact:true}).last().click();
  await page.getByRole('button',{name:'New project',exact:true}).waitFor();


  await page.screenshot({path:join(out,'dashboard-1440.png')});
  console.log('PASS account signup and authenticated dashboard');
  await page.getByRole('button',{name:'New project',exact:true}).click();
  await page.getByRole('textbox',{name:'Project name'}).fill('Production workflow check');
  await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.getByLabel('Upload media files').setInputFiles(fixture);
  await page.waitForFunction(()=>document.querySelector('.media-state-icon.ready'),{},{timeout:60000});
  await page.getByRole('button',{name:'Add Test footage.mp4 to timeline',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.timeline-clip'));
  await page.locator('.inspector-tabs button').filter({hasText:'Effects'}).click();
  await page.getByLabel('Add clip effect',{exact:true}).selectOption('Smart Mask');
  // The editor draws over the viewer's own picture of the clip's source; wait for its frame table and a settled picture.
  const settled=()=>page.waitForFunction(()=>{const c=document.querySelector('.viewer-frame > canvas');return document.querySelector('.smart-mask-marks')&&!document.querySelector('.focus-status')?.textContent?.includes('Reading source')&&c?.dataset.buffering==='false'&&c.dataset.sourceTimestamp;},{},{timeout:60000});
  await page.getByRole('button',{name:'Select & refine subject',exact:true}).click();
  await settled();
  const canvas=page.locator('.smart-mask-marks');const box=await canvas.boundingBox();
  assert.ok(Math.abs(box.width/box.height-640/360)<.01,'the picture takes the source shape');
  await page.mouse.click(box.x+box.width*.5,box.y+box.height*.5);
  await page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
  await page.getByRole('button',{name:'Exclude',exact:true}).click();
  const excludeBox=await canvas.boundingBox();
  await page.mouse.move(excludeBox.x+excludeBox.width*.7,excludeBox.y+excludeBox.height*.4);await page.mouse.down();await page.mouse.move(excludeBox.x+excludeBox.width*.8,excludeBox.y+excludeBox.height*.6,{steps:8});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
  await page.screenshot({path:join(out,'smart-mask-guides.png')});
  const before=await page.locator('.viewer-focus-strip .focus-frame').getAttribute('title');
  await page.getByRole('button',{name:'Next frame',exact:true}).click();
  await page.waitForFunction(title=>document.querySelector('.viewer-focus-strip .focus-frame')?.getAttribute('title')!==title,before);await settled();
  await page.getByRole('button',{name:'Restore',exact:true}).click();
  await page.mouse.click(box.x+box.width*.6,box.y+box.height*.5);
  await page.waitForTimeout(1000);
  const saved=await state(),video=saved.clips.find(c=>c.effects.some(e=>e.name==='Smart Mask')),mask=video.smartMasks[0];
  assert.equal(mask.prompts.length,2);assert.equal(mask.prompts[1].kind,'exclude');assert.ok(mask.prompts[1].points.length>1);assert.equal(mask.repairs.length,1);assert.ok(mask.repairs[0].time>mask.prompts[0].time);
  await page.getByLabel('Viewer zoom',{exact:true}).selectOption('200');
  await page.locator('.viewer-stage').evaluate(el=>{el.scrollLeft=150;el.scrollTop=100;});
  const zoomBox=await canvas.boundingBox(),viewport=await page.locator('.viewer-stage').boundingBox();
  assert.equal(Math.round(zoomBox.width),1280);assert.equal(Math.round(zoomBox.height),720);
  const click={x:viewport.x+100,y:viewport.y+90},expected={x:(click.x-zoomBox.x)/zoomBox.width,y:(click.y-zoomBox.y)/zoomBox.height};
  await page.getByRole('button',{name:'Include',exact:true}).click();await page.mouse.click(click.x,click.y);await page.waitForTimeout(800);
  const zoomState=await state(),last=zoomState.clips.find(c=>c.id===video.id).smartMasks[0].prompts.at(-1).points[0];
  assert.ok(Math.abs(last.x-expected.x)<.002&&Math.abs(last.y-expected.y)<.002,'Zoom/pan source coordinates remain accurate');
  assert.ok(await page.locator('.viewer-stage').evaluate(el=>el.scrollLeft>0&&el.scrollWidth>el.clientWidth),'Zoomed in, the picture scrolls to pan');
  await page.screenshot({path:join(out,'smart-mask-editor-200.png')});
  await page.getByLabel('Viewer zoom',{exact:true}).selectOption('Fit');
  await page.screenshot({path:join(out,'smart-mask-editor.png')});
  await page.getByRole('button',{name:'Close mask editor',exact:true}).click();
  await page.screenshot({path:join(out,'smart-mask-inspector.png')});
  // The first engine probe starts the model worker; the editor no longer waits on the server, so give it time here.
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Analyze range'&&!b.disabled),{},{timeout:180000}).catch(async cause=>{console.log('INSPECTOR',await page.locator('.smart-mask-inspector').innerText());throw cause;});
  await page.getByRole('button',{name:'Analyze range',exact:true}).click();
  await page.getByRole('progressbar',{name:'Mask analysis progress',exact:true}).waitFor();
  await page.getByRole('progressbar',{name:'Mask analysis progress',exact:true}).waitFor({state:'hidden',timeout:180000});
  await page.waitForFunction(()=>document.querySelector('.smart-mask-status.ready'),{},{timeout:10000});
  assert.ok((await state()).clips.find(c=>c.id===video.id).smartMasks[0].result?.key);
  // --- The analyzed matte plays live with the picture in every view: overlay, matte, black and white.
  await page.getByRole('button',{name:'Select & refine subject',exact:true}).click();
  await settled();
  const views={};
  for(const [label,view] of [['Black','black'],['White','white'],['Matte','alpha'],['Overlay','overlay']]){
    await page.getByRole('button',{name:label,exact:true}).click();
    views[view]=await page.evaluate(async view=>{
      const picture=document.querySelector('.viewer-frame > canvas'),matte=document.querySelector('.focus-matte');
      // What the matte canvas holds: how much of it is opaque, and whether any of it is transparent.
      const read=()=>{const ctx=matte.getContext('2d');if(!matte.width||!matte.height)return null;const d=ctx.getImageData(0,0,matte.width,matte.height).data;let opaque=0,clear=0,light=0;for(let i=0;i<d.length;i+=16){if(d[i+3]>250)opaque++;else if(d[i+3]<5)clear++;if(d[i]>200)light++;}const n=d.length/16;return {opaque:opaque/n,clear:clear/n,light:light/n};};
      const seen=new Set(),reads=[];let drawn=0,samples=0;
      const onFrame=()=>requestAnimationFrame(()=>{samples++;seen.add(picture.dataset.sourceTimestamp);const r=read();if(r&&r.clear<.999)drawn++;if(samples%6===0&&r)reads.push(r);});
      window.addEventListener('frameline:frame',onFrame);
      document.querySelector('[aria-label="Play playback"]').click();
      await new Promise(r=>setTimeout(r,3000));
      document.querySelector('[aria-label="Pause playback"]').click();
      window.removeEventListener('frameline:frame',onFrame);
      const mean=key=>reads.reduce((a,r)=>a+r[key],0)/Math.max(1,reads.length);
      return {view,samples,distinct:seen.size,drawn,opaque:mean('opaque'),clear:mean('clear'),light:mean('light')};
    },view);
    await page.waitForTimeout(300);
    await page.screenshot({path:join(out,'smart-mask-live-'+view+'.png')});
  }
  console.log('Live mask views',JSON.stringify(views));
  for(const v of Object.values(views)){
    assert.ok(v.distinct>=30,v.view+': the picture plays under the mask editor ('+v.distinct+' frames)');
    assert.ok(v.drawn/v.samples>.9,v.view+': the matte is drawn on the frames as they play');
  }
  assert.ok(views.alpha.opaque>.99,'Matte view is the opaque grey matte');
  assert.ok(views.black.opaque>.05&&views.black.clear>.02&&views.black.light<.01,'Black view covers what is not the subject in black and leaves the subject clear');
  assert.ok(views.white.opaque>.05&&views.white.clear>.02&&views.white.light>.05,'White view covers what is not the subject in white');
  assert.ok(views.overlay.opaque<.01,'Overlay view only tints');
  await page.getByRole('button',{name:'Close mask editor',exact:true}).click();
  assert.deepEqual(errors,[]);
  console.log('PASS Smart Mask UI drawing, strokes, repairs, persistence and real model analysis; screenshots artifacts/qa/smart-mask-*.png');
} finally { await browser.close(); await app.close(); await rm(temp,{recursive:true,force:true}); }
