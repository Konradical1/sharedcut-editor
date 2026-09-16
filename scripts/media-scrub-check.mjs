import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createFrameLineServer } from '../server/index.ts';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp=await mkdtemp(join(tmpdir(),'frameline-media-scrub-'));
await cp(resolve('dist'),join(temp,'dist'),{recursive:true});
const app=createFrameLineServer({dataDir:join(temp,'data'),distDir:join(temp,'dist')});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${app.server.address().port}`,browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROME_PATH}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.thumbnailPlayEvents=0;document.addEventListener('play',event=>{if(event.target.closest?.('.media-scrub-thumbnail'))window.thumbnailPlayEvents++;},true);});
const out=resolve('artifacts/qa');await mkdir(out,{recursive:true});
const state=async()=>(await(await context.request.get(url+'/api/state')).json()).state;
const saved=async()=>page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
const snapshot=()=>page.locator('.media-scrub-thumbnail video').evaluate(video=>{
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,160,90);const data=ctx.getImageData(0,0,160,90).data;let hash=0;for(let i=0;i<data.length;i+=17)hash=(hash+data[i]*(i+1))>>>0;
  return {currentTime:video.currentTime,duration:video.duration,paused:video.paused,muted:video.muted,hash,playEvents:window.thumbnailPlayEvents};
});
try{
  const fixture=join(temp,'Scrub source.mp4');await promisify(execFile)(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libx264','-g','48','-pix_fmt','yuv420p','-c:a','aac','-shortest',fixture]);
  await page.goto(url);await page.getByRole('button',{name:'Create account',exact:true}).click();await page.getByRole('textbox',{name:'Your name'}).fill('Scrub Editor');await page.getByRole('textbox',{name:'Email address'}).fill('scrub@example.test');await page.locator('input[type=password]').fill('Scrub-test-password-2026');await page.getByRole('button',{name:'Create account',exact:true}).last().click();
  await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByRole('textbox',{name:'Project name'}).fill('Thumbnail scrub');await page.getByRole('button',{name:'Create project',exact:true}).click();await page.getByLabel('Upload media files').setInputFiles(fixture);await page.waitForFunction(()=>document.querySelector('.media-state-icon.ready'),{},{timeout:45000});await saved();
  assert.equal((await state()).clips.length,0);
  const thumbnail=page.locator('.media-scrub-thumbnail'),box=await thumbnail.boundingBox(),timelineBefore=await page.locator('.transport-time').textContent(),slider=page.getByRole('slider',{name:'Scrub Scrub source.mp4',exact:true});
  const hover=async fraction=>{await page.mouse.move(box.x+box.width*fraction,box.y+box.height*.5);await page.waitForFunction(expected=>{const v=document.querySelector('.media-scrub-thumbnail video');return v?.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-v.duration*expected)<1/24+.01;},fraction);};
  await hover(.02);const start=await snapshot();assert.ok(start.currentTime<.2);assert.ok(start.paused&&start.muted);await page.locator('.thumbnail-playhead').waitFor();
  await hover(.97);const end=await snapshot();assert.ok(end.currentTime>5.7);assert.notEqual(start.hash,end.hash,'Hover decodes different video frames');assert.equal(end.playEvents,0);assert.ok(end.paused&&end.muted);
  const line=await page.locator('.thumbnail-playhead').evaluate(el=>({color:getComputedStyle(el).backgroundColor,visible:el.getBoundingClientRect().height>20,left:el.style.left}));const rgb=line.color.match(/\d+/g).map(Number);assert.ok(rgb[0]>200&&rgb[1]<120&&rgb[2]<120,'Scrub playhead is red');assert.ok(line.visible);assert.ok(Math.abs(parseFloat(line.left)-97)<1);
  for(const fraction of [.13,.88,.21,.77,.06,.92])await page.mouse.move(box.x+box.width*fraction,box.y+box.height*.5);
  await page.waitForFunction(()=>{const v=document.querySelector('.media-scrub-thumbnail video');return v?.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-v.duration*.92)<1/24+.01;});assert.equal(await page.locator('.transport-time').textContent(),timelineBefore);
  await page.mouse.move(box.x+box.width+30,box.y+box.height+30);await slider.focus();await slider.press('Home');await page.waitForFunction(()=>{const v=document.querySelector('.media-scrub-thumbnail video');return v?.readyState>=2&&!v.seeking&&v.currentTime<1/24;});
  await slider.press('ArrowRight');await page.waitForFunction(()=>{const v=document.querySelector('.media-scrub-thumbnail video');return v?.readyState>=2&&!v.seeking&&v.currentTime>=1/24&&v.currentTime<2/24;});assert.ok(Math.abs(Number(await slider.getAttribute('aria-valuenow'))-1/24)<.01);
  await slider.press('End');await page.waitForFunction(()=>{const v=document.querySelector('.media-scrub-thumbnail video');return v?.readyState>=2&&!v.seeking&&v.currentTime>v.duration-1/24;});const keyboard=await snapshot();assert.ok(keyboard.paused&&keyboard.muted);assert.equal(keyboard.playEvents,0);assert.equal(await page.locator('.transport-time').textContent(),timelineBefore);await page.screenshot({path:join(out,'media-thumbnail-scrub.png')});await slider.blur();
  const lane=await page.locator('.timeline-track.video .track-lane').first().boundingBox();await page.mouse.move(box.x+box.width*.4,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(lane.x+75,lane.y+20,{steps:12});await page.mouse.move(lane.x+76,lane.y+20);await page.mouse.move(lane.x+75,lane.y+20);await page.locator('.timeline-drop-ghost').first().waitFor();assert.equal((await state()).clips.length,0,'Drag hover is only a placement preview');assert.equal(await page.locator('.timeline-drop-ghost').count(),2,'Video and audio both retain drop previews');await page.mouse.up();await saved();assert.equal((await state()).clips.length,2);assert.deepEqual(errors,[]);
  console.log('PASS real video hover scrubbing, latest-request seek, visible playhead, silent paused decode, keyboard frames, independent timeline, drag/drop ghosts');
}catch(error){console.log(await page.locator('body').innerText());await page.screenshot({path:join(out,'media-scrub-failure.png')});throw error;}
finally{await browser.close();await app.close();await rm(temp,{recursive:true,force:true});}
