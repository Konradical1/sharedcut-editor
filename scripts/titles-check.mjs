import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFrameLineServer } from '../server/index.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp = await mkdtemp(join(tmpdir(),'frameline-titles-'));
const app = createFrameLineServer({dataDir:join(temp,'data')});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${app.server.address().port}`;
const browser=await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROME_PATH});
const context=await browser.newContext({viewport:{width:1440,height:1000}}), page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const out=resolve('artifacts/qa');await mkdir(out,{recursive:true});
const state=async()=>(await (await context.request.get(url+'/api/state')).json()).state;
const saved=async()=>{await page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');};
try {
  await page.goto(url);await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('textbox',{name:'Your name'}).fill('Title Designer');await page.getByRole('textbox',{name:'Email address'}).fill('titles@example.test');await page.locator('input[type=password]').fill('Titles-test-password-2026');await page.getByRole('button',{name:'Create account',exact:true}).last().click();
  await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByRole('textbox',{name:'Project name'}).fill('Titles Studio');await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.getByRole('button',{name:'Titles',exact:true}).click();assert.equal(await page.locator('.title-preset').count(),36);
  await page.getByRole('button',{name:'Static',exact:true}).click();
  const titleCard=await page.locator('.title-preset').first().boundingBox(), titleLane=await page.locator('.timeline-track.video .track-lane').first().boundingBox();
  await page.mouse.move(titleCard.x+20,titleCard.y+20);await page.mouse.down();await page.mouse.move(titleLane.x+90,titleLane.y+20,{steps:12});await page.mouse.move(titleLane.x+91,titleLane.y+20);await page.mouse.move(titleLane.x+90,titleLane.y+20);
  await page.locator('.timeline-drop-ghost').waitFor();assert.equal((await state()).clips.length,0);
  await page.screenshot({path:join(out,'title-placement-ghost.png')});await page.mouse.up();await saved();
  const dropped=(await state()).clips[0];assert.equal(dropped.mediaId,'frameline-title');assert.ok(Math.abs(dropped.start-15)<.05);
  await page.getByRole('button',{name:'Undo my action (⌘Z)',exact:true}).click();await saved();
  await page.getByRole('button',{name:'Add Cinematic title',exact:true}).click();await saved();let first=(await state()).clips[0];assert.equal(first.mediaId,'frameline-title');
  const content=page.getByRole('textbox',{name:'Text content',exact:true});await content.fill('Hello world');await content.press('ControlOrMeta+a');await content.press('ArrowLeft');for(let i=0;i<5;i++)await content.press('Shift+ArrowRight');await page.getByText('5 characters selected',{exact:true}).waitFor();
  await page.getByRole('spinbutton',{name:'Size',exact:true}).fill('150');await saved();
  let doc=JSON.parse((await state()).clips.find(c=>c.id===first.id).properties.textDocument);assert.equal(doc.runs[0].text,'Hello');assert.equal(doc.runs[0].style.fontSize,150);assert.equal(doc.runs[1].style.fontSize,112);
  await page.getByRole('button',{name:'Select layer',exact:true}).click();assert.equal(await page.getByRole('spinbutton',{name:'Size',exact:true}).inputValue(),'');
  await page.getByRole('spinbutton',{name:'Size',exact:true}).fill('96');await saved();doc=JSON.parse((await state()).clips[0].properties.textDocument);assert.equal(doc.runs.length,1);
  const size=page.getByRole('spinbutton',{name:'Size',exact:true});await content.click();const sr=await size.boundingBox();await page.mouse.move(sr.x+20,sr.y+10);await page.mouse.down();await page.mouse.move(sr.x+40,sr.y+10,{steps:5});await page.mouse.up();await saved();assert.equal(Number(await size.inputValue()),116);
  console.log('PASS preset insertion, selected-range style, mixed values, whole-layer override, number dragging');
  await page.getByRole('button',{name:'Text tool (T)',exact:true}).click();const frame=await page.locator('.text-overlay').boundingBox();
  await page.mouse.move(frame.x+frame.width*.12,frame.y+frame.height*.62);await page.mouse.down();await page.mouse.move(frame.x+frame.width*.55,frame.y+frame.height*.85,{steps:5});await page.mouse.up();await saved();assert.equal((await state()).clips.length,2);
  let box=page.locator('.text-box.selected');let rect=await box.boundingBox();await page.mouse.move(rect.x+rect.width,rect.y+rect.height);await page.mouse.down();await page.mouse.move(rect.x+rect.width+35,rect.y+rect.height-10,{steps:5});await page.mouse.up();await saved();
  const second=(await state()).clips[1];assert.ok(JSON.parse(second.properties.textDocument).width>.43);
  await box.dblclick();await page.getByRole('textbox',{name:'Edit text on canvas'}).fill('Drawn on the canvas');await page.getByRole('button',{name:'Done',exact:true}).click();await saved();
  await page.getByRole('button',{name:'Select text: AFTER HOURS',exact:true}).click({modifiers:['Shift'],position:{x:50,y:20}});await page.getByRole('spinbutton',{name:'Size',exact:true}).fill('72');await saved();
  assert.ok((await state()).clips.every(c=>JSON.parse(c.properties.textDocument).runs.every(r=>r.style.fontSize===72)));
  console.log('PASS drawing, resizing, canvas text editor, multi-layer formatting');
  const peer=await browser.newContext();await peer.request.post(url+'/api/auth/signup',{data:{name:'Font Peer',email:'peer@example.test',password:'Font-peer-password-2026'}});const peerPage=await peer.newPage();await peerPage.goto(url);await peerPage.getByRole('button',{name:'Open Titles Studio',exact:true}).click();await peerPage.getByRole('button',{name:'Text tool (T)',exact:true}).waitFor();
  await page.locator('.font-picker-trigger').click();await page.getByRole('textbox',{name:'Search fonts'}).fill('Baskerville');assert.ok(await page.getByRole('button',{name:'Baskerville Ag',exact:true}).count());await page.getByRole('textbox',{name:'Search fonts'}).fill('');
  const fontPath=process.env.TEST_FONT_PATH||'/System/Library/Fonts/Supplemental/Arial.ttf';await page.getByLabel('Upload shared font').setInputFiles(fontPath);await page.getByText(/is now available to everyone/).waitFor();await saved();
  const fonts=(await (await context.request.get(url+'/api/fonts')).json()).fonts;assert.equal(fonts.length,1);
  await peerPage.waitForFunction(family=>[...document.fonts].some(f=>f.family===family&&f.status==='loaded'),fonts[0].family,{timeout:22000});assert.equal((await (await peer.request.get(url+'/api/fonts')).json()).fonts[0].id,fonts[0].id);assert.ok((await (await peer.request.get(url+fonts[0].url)).body()).length>1000);
  const guest=await browser.newContext();assert.equal((await guest.request.get(url+'/api/fonts')).status(),401);await guest.close();
  assert.equal((await context.request.post(url+'/api/fonts?name=invalid',{data:Buffer.from('not a font at all'),headers:{'content-type':'application/octet-stream'}})).status(),400);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await saved();const current=await state();const render=await context.request.post(url+'/api/renders',{data:{projectId:current.projects[0].id,name:'Titles test',preset:'Quick Export',settings:{timelineId:current.timelines[0].id,resolution:'640 × 360',fps:'24',codec:'H.264',audio:'Disabled',rangeIn:'0',rangeOut:'1'}}});assert.equal(render.status(),202);const job=(await render.json()).job;
  for(let i=0;i<100;i++){const j=(await state()).renderJobs.find(j=>j.id===job.id);if(j.status==='failed')throw new Error(j.error);if(j.status==='complete')break;await page.waitForTimeout(200);}
  const result=(await state()).renderJobs.find(j=>j.id===job.id);assert.equal(result.status,'complete');assert.ok((await (await context.request.get(url+result.outputUrl)).body()).length>1000);
  await page.screenshot({path:join(out,'titles-studio.png')});await page.reload();await page.getByRole('button',{name:'Text tool (T)',exact:true}).waitFor();await page.getByRole('button',{name:'Titles',exact:true}).click();await page.getByRole('button',{name:'Select text: AFTER HOURS',exact:true}).click({position:{x:50,y:20}});await saved();assert.equal((await state()).clips.length,2);
  console.log('PASS shared font upload, second-account access, validation, real export and reload');assert.deepEqual(errors,[]);await peer.close();
  await app.close();
  const reboot=createFrameLineServer({dataDir:join(temp,'data')});
  try { await new Promise(r=>reboot.server.listen(0,'127.0.0.1',r));const rebootUrl=`http://127.0.0.1:${reboot.server.address().port}`;const restored=await (await context.request.get(rebootUrl+'/api/fonts')).json();assert.equal(restored.fonts[0].id,fonts[0].id);assert.ok((await (await context.request.get(rebootUrl+fonts[0].url)).body()).length>1000);console.log('PASS shared font database survives server restart'); } finally {await reboot.close();}

} catch(error){console.log(await page.locator('body').innerText());await page.screenshot({path:join(out,'titles-failure.png')});throw error;}
finally{await browser.close();if(app.server.listening)await app.close();await rm(temp,{recursive:true,force:true});}
