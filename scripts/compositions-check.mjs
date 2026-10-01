import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFrameLineServer } from '../server/index.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
delete process.env.FRAME_LINE_SIGNUP_CODE;
const temp=await mkdtemp(join(tmpdir(),'frameline-compositions-'));await cp(resolve('dist'),join(temp,'dist'),{recursive:true});
const app=createFrameLineServer({dataDir:join(temp,'data'),distDir:join(temp,'dist')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${app.server.address().port}`,browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROME_PATH});
const context=await browser.newContext({viewport:{width:1540,height:1100}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const state=async()=>(await (await context.request.get(url+'/api/state')).json()).state;
const saved=async()=>{await page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');};
const out=resolve('artifacts/qa');await mkdir(out,{recursive:true});
try {
  await page.goto(url);await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('textbox',{name:'Your name'}).fill('Composition QA');await page.getByRole('textbox',{name:'Email address'}).fill('compositions@example.test');await page.locator('input[type=password]').fill('Composition-test-password-2026');await page.getByRole('button',{name:'Create account',exact:true}).last().click();
  await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByRole('textbox',{name:'Project name'}).fill('Graphics Workshop');await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.getByRole('tab',{name:'Titles',exact:true}).click();assert.equal(await page.locator('.title-preset').count(),36);
  await page.getByRole('combobox',{name:'Title category'}).selectOption('News');assert.ok(await page.locator('.title-preset').count()>=3);await page.getByRole('combobox',{name:'Title category'}).selectOption('All');
  const art=page.locator('.title-preset-art').first(),r=await art.boundingBox();await page.mouse.move(r.x+r.width*.03,r.y+r.height*.5);await page.waitForTimeout(80);const early=await art.locator('canvas').evaluate(c=>c.toDataURL());await page.mouse.move(r.x+r.width*.55,r.y+r.height*.5);await page.waitForTimeout(80);assert.ok(await art.locator('canvas').evaluate(c=>c.toDataURL())!==early,'Scrubbing changes the rendered thumbnail');
  await page.getByRole('button',{name:'Static',exact:true}).click();
  await page.getByRole('button',{name:'Add Cinematic title',exact:true}).click();await saved();await page.getByRole('button',{name:'Add Editorial title',exact:true}).click();await saved();
  await page.getByRole('tab',{name:'Shapes',exact:true}).click();await page.getByRole('button',{name:'Add Rectangle shape',exact:true}).click();await saved();
  assert.equal((await state()).clips.length,3);
  const rows=await page.locator('.timeline-track.video .track-lane').all(),top=await rows[0].boundingBox(),bottom=await rows[2].boundingBox();
  const beforeTime=await page.locator('.transport-time').textContent();
  await page.mouse.move(top.x+70,top.y+4);await page.mouse.down();await page.mouse.move(top.x+1,bottom.y+bottom.height-3,{steps:12});assert.equal(await page.locator('.selection-marquee').count(),1);await page.mouse.up();
  assert.equal(await page.locator('.timeline-clip.selected').count(),3);assert.equal(await page.locator('.transport-time').textContent(),beforeTime);
  // Shift toggles selection on every clip type, independent of text formatting selection.
  const selected=page.locator('.timeline-clip').first();await selected.click({modifiers:['Shift']});assert.equal(await page.locator('.timeline-clip.selected').count(),2);await selected.click({modifiers:['Shift']});assert.equal(await page.locator('.timeline-clip.selected').count(),3);
  await selected.click({button:'right'});await page.getByRole('menuitem',{name:'Create composition',exact:true}).click();await saved();
  let current=await state(),parent=current.clips.find(c=>c.mediaId==='frameline-composition');assert.ok(parent);assert.equal(current.clips.filter(c=>c.timelineId===parent.properties.compositionId).length,3);
  assert.equal(await page.locator('.timeline-clip').count(),1);await page.locator('.composition-clip').dblclick();
  assert.equal(await page.locator('.timeline-clip').count(),3);assert.equal(await page.locator('.composition-breadcrumb').count(),1);
  await page.locator('.composition-breadcrumb').getByRole('button',{name:/Back to/}).click();assert.equal(await page.locator('.timeline-clip').count(),1);
  // Reopening must discard the child's zoom and horizontal offset, after zooming out.
  await page.locator('.composition-clip').dblclick();
  const assertFitted=async()=>{
    await page.waitForFunction(()=>{
      const scroll=document.querySelector('.timeline-scroll'),clip=document.querySelector('.timeline-clip');
      return scroll&&clip&&scroll.scrollLeft===0&&Math.abs(parseFloat(clip.style.width)-(scroll.clientWidth-164))<2;
    });
  };
  await assertFitted();
  await page.getByRole('button',{name:'Zoom timeline out',exact:true}).click();
  await page.locator('.timeline-scroll').evaluate(el=>{el.scrollLeft=200;});
  assert.ok(await page.locator('.timeline-scroll').evaluate(el=>el.scrollLeft)>0);
  await page.locator('.composition-breadcrumb').getByRole('button',{name:/Back to/}).click();
  await page.locator('.composition-clip').dblclick();await assertFitted();
  await page.locator('.composition-breadcrumb').getByRole('button',{name:/Back to/}).click();
  await page.locator('.composition-clip').click();await page.keyboard.press('ControlOrMeta+d');await saved();current=await state();const parents=current.clips.filter(c=>c.mediaId==='frameline-composition');assert.equal(parents.length,2);assert.notEqual(parents[0].properties.compositionId,parents[1].properties.compositionId);
  // Add an animated title to test keyframe-only marquee, grouped moves and deletion.
  await page.getByRole('tab',{name:'Titles',exact:true}).click();await page.getByRole('button',{name:'Animated',exact:true}).click();await page.getByRole('button',{name:'Add Cinematic title',exact:true}).click();await saved();
  const animated=(await state()).clips.filter(c=>c.mediaId==='frameline-title'&&c.timelineId===parent.timelineId).at(-1);assert.ok(animated?.keyframes);
  const row=page.locator('.timeline-track').filter({has:page.locator(`[data-clip="${animated.id}"]`)});await row.getByRole('button',{name:/Expand keyframes/}).click();
  await page.locator('.animation-rows').waitFor();const lanes=page.locator('.animation-rows .animation-lane').filter({has:page.locator('.animation-diamond')});const kr=await lanes.first().boundingBox(),ke=await lanes.last().boundingBox();
  const time=await page.locator('.transport-time').textContent();await page.mouse.move(kr.x+60,kr.y+3);await page.mouse.down();await page.mouse.move(kr.x+1,ke.y+ke.height-2,{steps:10});await page.mouse.up();
  const keys=await page.locator('.animation-rows .animation-diamond.selected').count();assert.ok(keys>=4);assert.equal(await page.locator('.transport-time').textContent(),time);assert.equal(await page.locator('.timeline-clip.selected').count(),1);
  await page.screenshot({path:join(out,'compositions-selection.png')});
  const point=page.locator('.animation-rows .animation-diamond.selected').first(),pr=await point.boundingBox();await page.mouse.move(pr.x+pr.width/2,pr.y+pr.height/2);await page.mouse.down();await page.mouse.move(pr.x+pr.width/2+4,pr.y+pr.height/2,{steps:5});await page.mouse.up();await saved();
  await point.focus();await page.keyboard.press('Backspace');await saved();assert.equal(await page.locator(`[data-clip="${animated.id}"]`).count(),1);assert.equal(Object.keys((await state()).clips.find(c=>c.id===animated.id).keyframes).length,0);
  await page.getByRole('button',{name:'Undo my action (⌘Z)',exact:true}).click();await saved();assert.ok(Object.keys((await state()).clips.find(c=>c.id===animated.id).keyframes).length>0);
  await page.reload();await page.getByRole('tab',{name:'Titles',exact:true}).click();await saved();assert.equal((await state()).clips.filter(c=>c.mediaId==='frameline-composition').length,2);
  assert.deepEqual(errors,[]);console.log('PASS 36 titles, filters, scrubbing, independent clip/keyframe marquee, compositions, deep duplicate, undo and reload');
} catch(error){console.log((await page.locator('body').innerText()).slice(-12000));await page.screenshot({path:join(out,'compositions-failure.png')});throw error;}
finally{await browser.close();await app.close();await rm(temp,{recursive:true,force:true});}
