// Cold browser cache, real prepared video, isolated account and database.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createFrameLineServer } from '../server/index.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temp = await mkdtemp(join(tmpdir(), 'frameline-cold-loading-'));
delete process.env.FRAME_LINE_SIGNUP_CODE;
await cp(resolve('dist'), join(temp, 'dist'), { recursive: true });
const app = createFrameLineServer({ dataDir: join(temp, 'data'), distDir: join(temp, 'dist') });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH, args:JSON.parse(process.env.QA_BROWSER_ARGS||'[]') });
let context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
const out = resolve('artifacts/qa'); await mkdir(out, { recursive: true });
const errors = [];
try {
  const fixture = join(temp, 'Cold start.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=24:duration=12','-c:v','libx264','-g','48','-pix_fmt','yuv420p','-movflags','+faststart',fixture]);
  await page.goto(origin);
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('textbox',{name:'Your name'}).fill('Cold Editor');
  await page.getByRole('textbox',{name:'Email address'}).fill('cold@example.test');
  await page.locator('input[type=password]').fill('Cold-start-test-password-2026');
  await page.getByRole('button',{name:'Create account',exact:true}).last().click();
  await page.getByRole('button',{name:'New project',exact:true}).click();
  await page.getByRole('textbox',{name:'Project name'}).fill('Remote loading');
  await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.getByLabel('Upload media files').setInputFiles(fixture);
  await page.waitForFunction(()=>document.querySelector('.media-state-icon.ready'),{},{timeout:45000});
  const box = await page.locator('.media-scrub-thumbnail').boundingBox();
  const lane = await page.locator('.timeline-track.video .track-lane').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(lane.x + 5, lane.y + 20, {steps:12}); await page.mouse.move(lane.x+6,lane.y+20);
  await page.locator('.timeline-drop-ghost').first().waitFor(); await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='Saved');
  const envelope = await (await context.request.get(origin+'/api/state')).json();
  assert.ok(envelope.state.clips.length);
  envelope.state.clips.forEach(clip=>clip.start=0);
  assert.equal((await context.request.put(origin+'/api/state',{data:{revision:envelope.revision,state:envelope.state}})).status(),200);
  // Ready is published before the background Stream variant; this test explicitly exercises that fallback.
  const deadline=Date.now()+45000;
  while(!(await (await context.request.get(origin+'/api/state')).json()).state.media.every(m=>m.proxyVariants?.Stream)){
    assert.ok(Date.now()<deadline,'Stream fallback fixture must finish preparing.');await page.waitForTimeout(200);
  }
  const project = envelope.state.projects[0], cookies = await context.cookies();
  // A second browser context gets authentication only, never the first computer's cache.
  await context.close();
  context = await browser.newContext({ viewport: { width:1440,height:1000 } }); await context.addCookies(cookies);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(()=>{ window.qaMedia=[]; const create=document.createElement.bind(document); document.createElement=(name,...args)=>{const element=create(name,...args);if(name==='video')window.qaMedia.push(element);return element;}; });
  // This checks cache correctness; newspaper-playback-check throttles the media origin.
  const started = Date.now();
  await page.goto(`${origin}/project/${project.id}`);
  await page.waitForFunction(()=>document.querySelector('.viewer canvas')?.dataset.hasPicture==='true',{}, {timeout:30000});
  const firstFrameMs = Date.now()-started;
  await page.waitForFunction(()=>document.querySelector('.render-bar .green'),{}, {timeout:30000});
  await page.locator('.footage-loading summary').click();
  await page.screenshot({path:join(out,'media-cold-loading.png')});
  const bytes = await page.evaluate(async()=>{const cache=await caches.open('footage-v3');return (await cache.keys()).length;});
  assert.ok(bytes>1, 'second computer actually stored proxy bytes');
  await context.setOffline(true);
  const replayed = await page.evaluate(async()=>{
    const cache=await caches.open('footage-v3'), keys=await cache.keys();
    const request=keys.find(request=>new URL(request.url).searchParams.get('fc')==='1');
    const url=new URL(request.url); url.searchParams.delete('fc');
    const response=await fetch(url,{headers:{Range:'bytes=1048576-1048675'}});
    return {status:response.status,bytes:(await response.arrayBuffer()).byteLength};
  });
  assert.deepEqual(replayed,{status:206,bytes:100},'a cached non-header range replays without the server');
  await context.setOffline(false);
  // Original decode errors must move to Stream, with a visible precision notice.
  await page.locator('.footage-loading summary').click();
  await page.getByTitle('Toggle proxy / original').click();
  await page.waitForFunction(()=>window.qaMedia.some(v=>v.src.endsWith('/original')));
  await page.evaluate(()=>window.qaMedia.find(v=>v.src.endsWith('/original')).dispatchEvent(new Event('error')));
  await page.waitForFunction(()=>document.querySelector('.viewer-demo-note')?.textContent.includes('Stream fallback'),{}, {timeout:30000});
  assert.equal(await page.locator('.viewer canvas').getAttribute('data-has-picture'),'true');
  if(process.env.QA_RENDER_PREVIEW==='1'){
    await page.getByTitle('Toggle proxy / original').click();
    // Simulate sustained compositor pressure; the app must request server previews automatically.
    await page.evaluate(()=>{
      window.qaSlow=true;const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(...args){if(window.qaSlow){const until=performance.now()+15;while(performance.now()<until){}}return draw.apply(this,args);};
    });
    await page.getByRole('button',{name:'Play playback',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.viewer canvas')?.dataset.playbackEngine==='render-cache',{},{timeout:20000});
    await page.evaluate(()=>window.qaSlow=false);
    await page.getByRole('button',{name:'Pause playback',exact:true}).click();
    const before=await page.locator('.viewer canvas').getAttribute('data-source-clip');
    assert.ok(before.startsWith('preview:'),'The finished server preview is actually being displayed.');
    const edit=await(await context.request.get(origin+'/api/state')).json();edit.state.clips[0].properties.opacity=40;
    assert.equal((await context.request.put(origin+'/api/state',{data:edit})).status(),200);
    await page.waitForFunction(old=>document.querySelector('.viewer canvas')?.dataset.sourceClip!==old,before,{timeout:10000});
    console.log('PASS automatic server rendering, displayed preview, and stale-preview invalidation after an edit.');
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ result:'PASS', firstFrameMs, coldCacheEntries:bytes, networkProfile:'local (unthrottled)', checks:['cold frame','verified local cache','offline range replay','visible download panel','original-to-Stream fallback'] }));
} catch(error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({path:join(out,'media-cold-loading-failure.png')}); throw error;
} finally { await browser.close(); await app.close(); await rm(temp,{recursive:true,force:true}); }
