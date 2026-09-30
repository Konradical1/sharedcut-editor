import {browserExecutable} from './browser-options.mjs';
import {venvPython} from '../server/platform.ts';
// Color Assistant stills (color-assistant.py: cached working-space frame + stages from Balance on + viewer sRGB) versus the live WebGL preview.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from 'vite';
import {processingStages,starterGrade,gamutMatrix,luminanceWeights} from '../src/services/color.ts';
import {neutralLook,proposedNodes} from '../src/services/colorAssistant.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const python=process.env.FRAME_LINE_COLOR_PYTHON||venvPython('.venv-color'),ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',worker=join(import.meta.dirname,'color-assistant.py');
// 8-bit input: grey ramp, smooth two-color ramp, 8x8 blocks of scattered colors (JPEG-block aligned).
const W=256,H=64,source=new Uint8Array(W*H*3);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const cell=(y>>3)*32+(x>>3);source.set(y<16?[x,x,x]:y<32?[x,255-x,(y-16)*16+8]:[(cell*37)%256,(cell*73+91)%256,(cell*151+17)%256],(y*W+x)*3);}
// Proposals applied the way Apply does it; 'full' is strong: Balance, Look with split toning and a curve, two extra look nodes before ACES 2.
const clip={id:'assistant',projectId:'p',name:'Preview check',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}};
let id=0;const nodes=starterGrade(clip,undefined,()=>String(++id));Object.assign(nodes.at(-1).effects[0],{toneMapping:'aces2',gamutMapping:'none'});
const rgb=(r,g,b)=>({r,g,b}),look=patch=>({...neutralLook(),...patch}),curves=patch=>({rgb:[],r:[],g:[],b:[],...patch});
const balance={exposure:.4,temperature:600,tint:-10,lift:rgb(.02,0,-.02),gamma:rgb(0,.03,-.03),gain:rgb(.05,0,-.04),offset:rgb(-.01,0,.01)};
const strong=look({contrast:1.3,saturation:130,liftRgb:rgb(-.03,.01,.05),gainRgb:rgb(.06,.02,-.05),curves:curves({rgb:[{x:0,y:0},{x:.3,y:.24},{x:.7,y:.78},{x:1,y:1}]})});
const extraNodes=[look({gain:.95,curves:curves({b:[{x:0,y:.04},{x:.5,y:.5},{x:1,y:.96}]})}),look({saturation:90,offsetRgb:rgb(.01,-.005,-.01)})];
const cases=Object.entries({neutral:{},balance:{balance},look:{look:{look:strong,extraNodes:[]}},full:{balance,look:{look:strong,extraNodes}}}).map(([name,change])=>{
 const {next}=proposedNodes(clip,nodes,change,prefix=>`${prefix}-${++id}`),stages=processingStages(clip,next),cut=stages.findIndex(s=>s.node.id===next.find(n=>n.name==='Balance').id);
 assert.ok(cut>0&&stages.at(-1).effect?.toneMapping==='aces2',`${name}: proposal did not land between Balance and the ACES 2 output`);
 return {name,nodes:next,pre:stages.slice(0,cut),post:stages.slice(cut)};
});
assert.ok(cases.every(c=>JSON.stringify(c.pre)===JSON.stringify(cases[0].pre))&&cases.at(-1).nodes.length===6,'the cached split must not depend on the proposal');
const temp=await mkdtemp(join(tmpdir(),'color-assistant-preview-'));
try{
 const input=join(temp,'input.ppm'),cacheDir=join(temp,'cache'),jpeg=join(temp,'full.jpg');
 // 16-bit PPM (v*257/65535 = v/255, what the GPU samples): FFmpeg 8.1 turns 8-bit rgb24 into float with a half-code bias.
 const wide=Buffer.alloc(source.length*2);source.forEach((v,i)=>wide.writeUInt16BE(v*257,i*2));await writeFile(input,Buffer.concat([Buffer.from(`P6\n${W} ${H}\n65535\n`),wide]));
 const run=async(command,job)=>{const file=join(temp,`${command}.json`);await writeFile(file,JSON.stringify(job));return JSON.parse(execFileSync(python,[worker,command,file],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));};
 // The worker's public commands: measure decodes + grades to Balance and caches; render grades the cache from Balance on. PNG keeps the exact codes.
 const shot=(await run('measure',{ffmpeg,cacheDir,width:W,weights:luminanceWeights('DaVinci Wide Gamut'),toRec709:gamutMatrix('DaVinci Wide Gamut','Rec.709'),
  shots:[{clipId:clip.id,key:'preview',input,matrix:'bt709',range:'pc',times:[0],preStages:cases[0].pre}]})).shots[0];
 assert.ok(shot.width===W&&shot.height===H&&shot.frames===1,'measure returned the wrong frame size '+JSON.stringify(shot));
 const stills=[...cases.map(c=>({key:'preview',frame:0,stages:c.post,out:join(temp,`${c.name}.png`)})),{key:'preview',frame:0,stages:cases.at(-1).post,out:jpeg}];
 await run('render',{ffmpeg,cacheDir,stills});
 const pixels=file=>{const b=execFileSync(ffmpeg,['-v','error','-i',file,'-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:1e7});assert.equal(b.length,W*H*3,file);return b;};
 const server=await createServer({appType:'custom',server:{port:0,host:'127.0.0.1'}});server.middlewares.use('/__color-check',(_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Color Assistant verification</title>');});await server.listen();
 const browser=await chromium.launch({headless:true,executablePath:browserExecutable()});
 let previews;
 try{
  const page=await browser.newPage();await page.goto(new URL('/__color-check',server.resolvedUrls.local[0]).href);
  previews=await page.evaluate(async({clip,cases,source,W,H})=>{
   const {createColorPreview}=await import('/src/services/colorPreview.ts');
   const input=document.createElement('canvas'),read=document.createElement('canvas');input.width=read.width=W;input.height=read.height=H;
   const ctx=input.getContext('2d'),r=read.getContext('2d',{willReadFrequently:true}),image=ctx.createImageData(W,H);for(let i=0;i<W*H;i++)image.data.set([source[i*3],source[i*3+1],source[i*3+2],255],i*4);ctx.putImageData(image,0,0);
   const renderer=createColorPreview();try{return cases.map(nodes=>{r.drawImage(renderer.draw(input,clip,{},nodes),0,0);return Array.from(r.getImageData(0,0,W,H).data);});}finally{renderer.dispose();}
  },{clip,cases:cases.map(c=>c.nodes),source:Array.from(source),W,H});
 }finally{await browser.close();await server.close();}
 const compare=(a,b)=>{let total=0,max=0,over=0,worst;for(let i=0;i<W*H*3;i++){const e=Math.abs(a(i)-b[i]);total+=e;over+=e>4;if(e>max){max=e;const p=Math.floor(i/3);worst={x:p%W,y:Math.floor(p/W),source:[...source.subarray(p*3,p*3+3)],still:[...b.subarray(p*3,p*3+3)],other:[0,1,2].map(c=>a(p*3+c))};}}return {mean:+(total/(W*H*3)).toFixed(4),max,over,worst:JSON.stringify(worst)};};
 const results=cases.map((c,n)=>{const still=pixels(join(temp,`${c.name}.png`));return {name:c.name,stages:c.pre.length+c.post.length,...compare(i=>previews[n][Math.floor(i/3)*4+i%3],still),still};});
 const compressed=pixels(jpeg),loss=compare(i=>compressed[i],results.at(-1).still);
 for(const {still,...r} of results)console.log(r);console.log({jpeg:loss});
 for(const r of results)assert.ok(r.mean<1&&r.max<=4,`${r.name}: Assistant still differs from the live preview `+JSON.stringify({...r,still:undefined}));
 assert.ok(loss.mean<2,'JPEG still lost too much '+JSON.stringify(loss));
 console.log('PASS Color Assistant stills equal the live preview (cached split pipeline, sRGB viewer encoding, JPEG).');
}finally{await rm(temp,{recursive:true,force:true});}
