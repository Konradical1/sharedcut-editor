// Independent OCIO/native reference versus the actual WebGL color renderer.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join,resolve}from'node:path';
import {createServer} from 'vite';
import {colorTransform,processingStages,starterGrade,profiles,defaultCST} from '../src/services/color.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const temp=await mkdtemp(join(tmpdir(),'color-reference-')),out=resolve('artifacts/qa/color-reference');await mkdir(out,{recursive:true});
const source=Array.from({length:256},(_,i)=>[i,(i*37)%256,(i*73)%256]);
const planar=new Float32Array(source.length*3);for(let i=0;i<source.length;i++)for(const [p,c]of[1,2,0].entries())planar[p*source.length+i]=source[i][c]/255;
const cases=[];
try{
 // Independent camera-to-display processor: does not use FrameLine camera equations or matrices.
 {
  const clip={id:'camera',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}};let id=0;
  const nodes=starterGrade(clip,undefined,()=>String(++id));Object.assign(nodes.at(-1).effects[0],{toneMapping:'aces2',gamutMapping:'none'});
  const job=join(temp,'camera.json');await writeFile(job,JSON.stringify({stages:processingStages(clip,nodes)}));
  const check=execFileSync(process.env.FRAME_LINE_COLOR_PYTHON||'.venv-color/bin/python',['-c',`
import importlib.util,json,numpy as np,sys
spec=importlib.util.spec_from_file_location('renderer','scripts/color-render.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rng=np.random.default_rng(42);x=np.concatenate([rng.uniform(.1,1,(4096,3)),np.repeat(np.linspace(0,1,1024)[:,None],3,axis=1)]).astype(np.float32)
a=m.grade(x.copy(),json.load(open(sys.argv[1]))['stages'])
p=m.config.getProcessor('S-Log3 S-Gamut3.Cine','Rec.1886 Rec.709 - Display',m.VIEW,m.ocio.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor();b=x.copy();p.applyRGB(b)
e=np.abs(a-b);print(json.dumps({'camera':'S-Log3 S-Gamut3.Cine','samples':len(x),'mean':float(e.mean()),'max':float(e.max())}));assert e.max()<.002
`,job],{encoding:'utf8'});console.log(check.trim());await writeFile(join(out,'camera-reference.json'),check);
 }
 for(const profile of profiles){
  const clip={id:'reference',projectId:'p',properties:{colorPipeline:'nodes-v2',inputProfile:profile,inputGamut:profile.startsWith('S-Log')?'S-Gamut3.Cine':profile.startsWith('Canon')?'Cinema Gamut':'Rec.709'}};
  for(const aces of [false,true]){
   let id=0;const nodes=starterGrade(clip,undefined,()=>String(++id));
   nodes[1].parameters={...nodes[1].parameters,exposure:-.7,contrast:1.12,temperature:150,tint:3};
   nodes[1].curves={RGB:{mode:'smooth',points:[{id:'a',x:0,y:0},{id:'b',x:.3,y:.26},{id:'c',x:.7,y:.74},{id:'d',x:1,y:1}]}};
   if(aces)Object.assign(nodes.at(-1).effects[0],{toneMapping:'aces2',gamutMapping:'none'});
   const job=join(temp,'job.json');await writeFile(job,JSON.stringify({width:256,height:1,stages:processingStages(clip,nodes)}));
   const bytes=execFileSync(process.env.FRAME_LINE_COLOR_PYTHON||'.venv-color/bin/python',['scripts/color-render.py',job,'--stream'],{input:Buffer.from(planar.buffer),maxBuffer:1e6});
   const data=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),expected=source.map((_,i)=>[data[512+i],data[i],data[256+i]]);
   if(!aces){const cpu=colorTransform(clip,undefined,nodes);let max=0;for(let i=0;i<source.length;i++){const value=cpu(source[i].map(v=>v/255));for(let c=0;c<3;c++)max=Math.max(max,Math.abs(value[c]-Math.max(0,Math.min(1,expected[i][c]))));}assert.ok(max<.0001,`${profile} native operations differ: ${max}`);}
   cases.push({profile,aces,clip,nodes,expected});
  }
 }
 const server=await createServer({server:{port:0,host:'127.0.0.1'}});await server.listen();
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);
  const measurements=await page.evaluate(async({cases,source})=>{
   const {createColorPreview}=await import('/src/services/colorPreview.ts');
   const input=document.createElement('canvas'),read=document.createElement('canvas');input.width=read.width=256;input.height=read.height=1;
   const ctx=input.getContext('2d'),r=read.getContext('2d',{willReadFrequently:true}),pixels=ctx.createImageData(256,1);source.forEach((v,i)=>pixels.data.set([...v,255],i*4));ctx.putImageData(pixels,0,0);
   const renderer=createColorPreview(),results=[];
   try{for(const test of cases){
    const canvas=renderer.draw(input,test.clip,{},test.nodes);r.drawImage(canvas,0,0);const actual=r.getImageData(0,0,256,1).data;let total=0,max=0;
    for(let i=0;i<256;i++)for(let c=0;c<3;c++){
     let value=test.expected[i][c];if(test.aces){value=Math.max(0,value)**2.4;value=value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055;}
     const error=Math.abs(actual[i*4+c]-Math.round(Math.max(0,Math.min(1,value))*255));total+=error;max=Math.max(max,error);
    }
    results.push({profile:test.profile,aces:test.aces,mean:total/768,max});
   }}finally{renderer.dispose();}return results;
  },{cases,source});
  await writeFile(join(out,'native-gpu.json'),JSON.stringify(measurements,null,2));
  for(const m of measurements){console.log(m);assert.ok(m.mean<1&&m.max<=4,'Native/GPU mismatch '+JSON.stringify(m));}
 }finally{await browser.close();await server.close();}
 console.log('PASS independent native processing, ACES output, full GPU pipeline and sRGB display boundary.');
}finally{await rm(temp,{recursive:true,force:true});}
