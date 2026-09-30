import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFrameLineServer } from '../server/index.ts';
import { speechFixture } from './speech-fixture.mjs';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const exec=promisify(execFile),temp=await mkdtemp(join(tmpdir(),'frameline-caption-qa-'));
delete process.env.FRAME_LINE_SIGNUP_CODE;
const app=createFrameLineServer({dataDir:join(temp,'data'),distDir:resolve('dist')});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${app.server.address().port}`,browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const out=resolve('artifacts/captions-qa');await mkdir(out,{recursive:true});
const snapshot=async()=>(await(await context.request.get(url+'/api/state')).json());
const saved=async()=>page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
try {
  await page.goto(url);await page.getByRole('button',{name:'Create account',exact:true}).click();await page.getByRole('textbox',{name:'Your name'}).fill('Caption Editor');await page.getByRole('textbox',{name:'Email address'}).fill('caption@example.test');await page.locator('input[type=password]').fill('Caption-test-password-2026');await page.getByRole('button',{name:'Create account',exact:true}).last().click();
  await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByRole('textbox',{name:'Project name'}).fill('Caption Studio');await page.getByRole('button',{name:'Create project',exact:true}).click();await saved();
  await speechFixture(join(temp,'speech.wav'),'Make every word feel alive. These captions follow the entire timeline. Five words per line, with natural breaks.');
  await page.getByLabel('Upload media files').setInputFiles(join(temp,'speech.wav'));
  await page.getByRole('button',{name:'Add speech.wav to timeline',exact:true}).waitFor();
  for(let i=0;i<100;i++){const state=(await snapshot()).state;if(state.media[0]?.status==='ready')break;await new Promise(r=>setTimeout(r,200));}
  await page.getByRole('button',{name:'Add speech.wav to timeline',exact:true}).click();await saved();
  let snap=await snapshot();let source=snap.state.clips.find(c=>c.mediaId===snap.state.media[0].id);assert.ok(source);
  source.start=2;snap.state.projects[0].resolution='640 × 360';
  let response=await context.request.put(url+'/api/state',{data:snap});assert.equal(response.status(),200,await response.text());
  await page.reload();await page.getByRole('tab',{name:'Captions',exact:true}).click();
  assert.equal(await page.locator('.caption-preset').count(),17);
  const card=page.getByRole('button',{name:'Select Electric pull-in captions',exact:true}),art=card.locator('.caption-art');await art.scrollIntoViewIfNeeded();const box=await art.boundingBox();
  await page.mouse.move(box.x+box.width*.1,box.y+box.height/2);await page.waitForTimeout(100);const first=await art.locator('canvas').evaluate(c=>c.toDataURL());
  await page.mouse.move(box.x+box.width*.3,box.y+box.height/2);await page.waitForTimeout(100);assert.notEqual(await art.locator('canvas').evaluate(c=>c.toDataURL()),first);
  assert.equal(await page.locator('.caption-preset input[type=range]').count(),0);
  await card.click();await page.getByRole('dialog',{name:'Generate captions',exact:true}).waitFor();
  assert.ok(await page.locator('.caption-audio-selection').count());
  const handle=page.getByRole('button',{name:'Caption range start',exact:true}),h=await handle.boundingBox();
  await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+35,h.y+h.height/2);await page.mouse.up();
  assert.ok(Number(await page.getByLabel('Start (seconds)',{exact:true}).inputValue())>0);
  await page.screenshot({path:join(out,'caption-generation.png')});
  assert.ok((await page.getByRole('dialog').boundingBox()).height<600);
  await page.getByLabel('Start (seconds)',{exact:true}).fill('2');await page.getByLabel('End (seconds)',{exact:true}).fill(String(Number((2+source.duration).toFixed(2))));await page.getByLabel('Maximum words per line',{exact:true}).fill('5');await page.getByRole('button',{name:'Generate',exact:true}).click();
  await page.getByRole('progressbar',{name:'Transcription progress'}).waitFor();
  await page.getByLabel('Caption text',{exact:true}).waitFor({timeout:180000});await saved();
  snap=await snapshot();let captions=snap.state.clips.filter(c=>c.properties.captionSet);assert.ok(captions.length>=4);assert.ok(captions.every(c=>c.start>=2));assert.ok(captions.every(c=>JSON.parse(c.properties.textDocument).caption.words.length<=5));
  assert.match(captions.map(c=>c.name).join(' '),/Make every word feel alive/i);
  await page.getByLabel('Caption text',{exact:true}).fill('Let every word feel alive.');await page.getByLabel('Caption text',{exact:true}).blur();await saved();
  await page.getByText('Line grouping',{exact:true}).click();await page.getByLabel('Words per line',{exact:true}).fill('3');await page.getByRole('button',{name:'Regroup lines',exact:true}).click();await saved();
  snap=await snapshot();captions=snap.state.clips.filter(c=>c.properties.captionSet);assert.ok(captions.every(c=>JSON.parse(c.properties.textDocument).caption.words.length<=3));assert.match(captions[0].name,/Let/);
  await page.screenshot({path:join(out,'captions-1600.png')});
  for(const [width,height] of [[1280,800],[900,700]]){await page.setViewportSize({width,height});await page.screenshot({path:join(out,`captions-${width}.png`)});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No window overflow');}
  await page.setViewportSize({width:1600,height:1000});
  snap=await snapshot();snap.state.clips.find(c=>c.id===source.id).start+=.5;response=await context.request.put(url+'/api/state',{data:snap});assert.equal(response.status(),200,await response.text());
  await page.getByText('Captions are out of date',{exact:true}).waitFor();
  await page.screenshot({path:join(out,'captions-outdated.png')});
  const previousSet=(await snapshot()).state.tracks.find(t=>t.captionSets?.length).captionSets[0];
  await page.getByRole('button',{name:'Regenerate',exact:true}).click();await page.getByRole('button',{name:'Generate',exact:true}).click();await page.getByRole('progressbar',{name:'Transcription progress'}).waitFor();
  await page.getByText('Captions are out of date',{exact:true}).waitFor({state:'hidden',timeout:180000});await saved();
  const regenerated=(await snapshot()).state.tracks.find(t=>t.captionSets?.length).captionSets[0];assert.equal(regenerated.id,previousSet.id);assert.notEqual(regenerated.jobId,previousSet.jobId);assert.equal(regenerated.wordsPerLine,3);

  await page.getByLabel('Entrance (seconds)',{exact:true}).fill('0.03');
  await page.getByLabel('Exit (seconds)',{exact:true}).fill('0.02');
  await page.getByLabel('Caption size',{exact:true}).fill('64');await page.getByLabel('Caption size',{exact:true}).blur();
  await page.getByRole('button',{name:'Apply to set…',exact:true}).click();
  await page.getByRole('dialog',{name:'Apply to caption set',exact:true}).waitFor();
  await page.getByLabel('Select all properties',{exact:true}).uncheck();
  for(const property of ['Entrance & exit','Caption size'])await page.getByRole('checkbox',{name:property,exact:true}).check();
  await page.screenshot({path:join(out,'caption-apply-to-set.png')});
  await page.getByRole('button',{name:'Apply',exact:true}).click();await saved();
  snap=await snapshot();assert.ok(snap.state.clips.filter(c=>c.properties.captionSet===regenerated.id).every(c=>{const d=JSON.parse(c.properties.textDocument);return d.caption.entranceDuration===.03&&d.caption.exitDuration===.02&&d.runs[0].style.fontSize===64;}));
  await page.screenshot({path:join(out,'caption-animation-timing.png')});
  const size=page.getByLabel('Caption size',{exact:true});
  await size.fill('');assert.equal(await page.getByRole('alert').count(),0,'Clearing a number field waits instead of failing validation');
  await size.fill('020');await size.blur();assert.equal(await size.inputValue(),'20');
  await size.fill('0');await size.blur();assert.equal(await size.inputValue(),'20','Out-of-range values settle to the limit without a browser warning');
  await saved();
  await page.getByRole('button',{name:'Generate captions',exact:true}).click();
  const existing=page.getByLabel('Existing captions',{exact:true});await existing.waitFor();
  await existing.selectOption('keep');await existing.selectOption('replace');
  await page.screenshot({path:join(out,'caption-overlap-choice.png')});
  await page.getByRole('button',{name:'Cancel',exact:true}).click();

  // One line exports with a custom highlight color and per-word pop, through the same drawCaption as the preview.
  snap=await snapshot();{const line=snap.state.clips.find(c=>c.properties.captionSet),doc=JSON.parse(line.properties.textDocument);doc.caption={...doc.caption,accent:'#c4f876',wordPop:true};doc.outlineWidth=20;line.properties.textDocument=JSON.stringify(doc);response=await context.request.put(url+'/api/state',{data:snap});assert.equal(response.status(),200,await response.text());}
  snap=await snapshot();const project=snap.state.projects[0],timeline=snap.state.timelines[0];
  response=await context.request.post(url+'/api/renders',{data:{projectId:project.id,name:'Caption QA',preset:'Custom',settings:{timelineId:timeline.id,rangeIn:'2',rangeOut:String(2+source.duration),codec:'H.264',audio:'AAC · 320 kb/s · 48 kHz',resolution:'640 × 360'}}});assert.equal(response.status(),202,await response.text());
  const job=(await response.json()).job;
  let rendered;
  for(let i=0;i<180;i++){const jobs=(await(await context.request.get(url+'/api/renders')).json()).jobs;rendered=jobs.find(j=>j.id===job.id);if(['complete','failed'].includes(rendered.status))break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(rendered.status,'complete',rendered.error);assert.equal((await context.request.get(url+rendered.outputUrl)).status(),200);
  const oldLines=(await snapshot()).state.clips.filter(c=>c.properties.captionSet).map(c=>c.id);
  await page.getByRole('button',{name:'Generate captions',exact:true}).click();await page.getByLabel('Existing captions',{exact:true}).selectOption('replace');await page.getByRole('button',{name:'Generate',exact:true}).click();
  await page.getByRole('progressbar',{name:'Transcription progress'}).waitFor();
  assert.ok((await snapshot()).state.clips.some(c=>oldLines.includes(c.id)),'Keep existing lines while transcribing');
  await page.getByRole('progressbar',{name:'Transcription progress'}).waitFor({state:'hidden',timeout:180000});await saved();
  snap=await snapshot();assert.ok(!snap.state.clips.some(c=>oldLines.includes(c.id)),'Successful overlap replacement removes previous lines');assert.equal(snap.state.tracks.flatMap(t=>t.captionSets??[]).length,1);
  await page.reload();await page.getByRole('tab',{name:'Captions',exact:true}).click();assert.ok((await snapshot()).state.tracks.some(t=>t.captionSets?.length));assert.deepEqual(errors,[]);

  const remaining=(await snapshot()).state.clips.filter(c=>c.properties.captionSet);
  for(let i=0;i<remaining.length;i++){
    const line=page.locator(`[data-clip="${remaining[i].id}"]`).first();await line.focus();await line.press('Enter');await line.press('Delete');await saved();
    assert.equal((await snapshot()).state.tracks.flatMap(t=>t.captionSets??[]).length,i===remaining.length-1?0:1,'Only deleting the last line clears registration');
  }
  await page.getByRole('button',{name:'Generate captions',exact:true}).click();assert.equal(await page.getByLabel('Existing captions',{exact:true}).count(),0);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  console.log('PASS caption timing controls, apply-to-set property picker, number field editing, overlap choice; real local transcription, nonzero range, 17 scrubbable presets, accent and word-pop export, per-line editing, regrouping, stale warning, regeneration, real export, reload and responsive layout');
} catch(error){await page.screenshot({path:join(out,'failure.png')});console.log((await page.locator('body').innerText()).slice(-8000));throw error;}
finally{await browser.close();await app.close();await rm(temp,{recursive:true,force:true});}
