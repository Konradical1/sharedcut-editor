import {browserExecutable} from './browser-options.mjs';
// Real GPU-versus-CPU color math, including Canon inputs and multiple correction stages.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({appType:'custom',server:{port:0,host:'127.0.0.1'}});server.middlewares.use('/__color-check',(_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Color verification</title>');});await server.listen();
const browser=await chromium.launch({headless:true,executablePath:browserExecutable(),args:JSON.parse(process.env.QA_BROWSER_ARGS||'[]')});
try{
 const page=await browser.newPage();await page.goto(new URL('/__color-check',server.resolvedUrls.local[0]).href);
 const results=await page.evaluate(async()=>{
  const {createColorPreview,ColorPending}=await import('/src/services/colorPreview.ts'),{colorTransform,profiles,starterGrade,makeCube}=await import('/src/services/color.ts');
  const source=document.createElement('canvas'),read=document.createElement('canvas');source.width=read.width=64;source.height=read.height=1;
  const ctx=source.getContext('2d'),out=read.getContext('2d',{willReadFrequently:true}),image=ctx.createImageData(64,1),results=[];
  for(let i=0;i<64;i++){image.data.set([35+(i*37)%180,35+(i*67)%180,35+(i*97)%180,255],i*4);}ctx.putImageData(image,0,0);
  const NativeFrame=window.VideoFrame,nativeContext=HTMLCanvasElement.prototype.getContext;
  for(const mode of ['gpu','opaque','rgb','constructor-error','allocation-error','copy-error','software']) {
   let closed=0,created=0;const video={currentTime:0,readyState:2,videoWidth:64,videoHeight:1};
   if(!['gpu','software'].includes(mode))window.VideoFrame=class {
    constructor(){if(mode==='constructor-error')throw Error('Hardware frame unavailable');created++;}
    format=mode==='opaque'?null:mode==='rgb'?'RGBX':'I420';timestamp=0;codedWidth=64;codedHeight=1;
    colorSpace={toJSON:()=>({matrix:'bt709'})};
    allocationSize(){if(mode==='allocation-error')throw Error('Cannot read frame');return 96;}
    copyTo(){return Promise.reject(Error('Hardware readback failed'));}
    close(){closed++;}
   };
   if(mode==='software')HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:nativeContext.call(this,type,...args);};
   const renderer=createColorPreview();HTMLCanvasElement.prototype.getContext=nativeContext;
   try{for(const profile of profiles){
   const clip={id:'color',properties:{inputProfile:profile,inputGamut:profile==='S-Log3'?'S-Gamut3.Cine':profile.startsWith('Canon')?'Cinema Gamut':'Rec.709',inputExposure:.3,inputTemperature:170}},asset={inputProfile:profile};
   const nodes=[{clipId:clip.id,enabled:true,name:'Curves',order:2,parameters:{curve25:.19,curve50:.47,curve75:.83,liftR:.01,gammaG:.03,gainB:.02,offsetR:.015}},{clipId:clip.id,enabled:true,name:'Primaries',order:1,parameters:{exposure:.1,contrast:1.08,pivot:.43,saturation:93,temperature:220,tint:7,lift:.01,gamma:.04,gain:1.01,offset:.003}}];
   let rendered;for(let attempt=0;attempt<1000;attempt++){try{rendered=renderer.draw(source,clip,asset,nodes,['gpu','software'].includes(mode)?undefined:video);break;}catch(e){if(!(e instanceof ColorPending))throw e;await new Promise(r=>setTimeout(r,10));}}
   if(!rendered)throw Error('Color preparation timed out');if(mode.includes('gpu')&&!rendered.getContext('webgl2'))throw Error('GPU check fell back to CPU');out.drawImage(rendered,0,0);const actual=out.getImageData(0,0,64,1).data,transform=colorTransform(clip,asset,nodes);let total=0,max=0;
   for(let i=0;i<64;i++){const expected=transform(Array.from(image.data.slice(i*4,i*4+3)).map(x=>x/255));for(let c=0;c<3;c++){const error=Math.abs(actual[i*4+c]-Math.round(expected[c]*255));total+=error;max=Math.max(max,error);}}
   results.push({mode,profile,meanError:total/192,maxError:max});
  }}finally{renderer.dispose();window.VideoFrame=NativeFrame;HTMLCanvasElement.prototype.getContext=nativeContext;}if(created!==closed)throw Error('VideoFrame leaked in '+mode);
  }
  for(const mode of ['managed-gpu','managed-software']){
    if(mode==='managed-software')HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:nativeContext.call(this,type,...args);};
    const renderer=createColorPreview();HTMLCanvasElement.prototype.getContext=nativeContext;
    try{for(const profile of profiles){
      let id=0;const clip={id:'managed',projectId:'test',properties:{colorPipeline:'nodes-v2',inputProfile:profile,inputGamut:profile.startsWith('S-Log')?'S-Gamut3.Cine':profile.startsWith('Canon')?'Cinema Gamut':'Rec.709'}},asset={inputProfile:profile},nodes=starterGrade(clip,asset,()=>String(++id));
      nodes[1].parameters={exposure:-.4,temperature:profile==='Linear'?6000:120,tint:profile==='Linear'?150:3,contrast:1.08,pivot:.336043,saturation:94,lift:.002,gamma:.01,gain:.99,offset:.006};
      nodes[1].curves={RGB:{mode:'smooth',points:[{id:'a',x:0,y:.01},{id:'b',x:.3,y:.27},{id:'c',x:.65,y:.7,slope:.8},{id:'d',x:1,y:1}]},R:{mode:'linear',points:[{id:'a',x:0,y:0},{id:'b',x:.4,y:.41},{id:'d',x:1,y:1}]}};
      const cube=makeCube(rgb=>[rgb[0]*.98,rgb[1],rgb[2]*1.01],5);nodes[2].effects=[{id:'lut',type:'lut',name:'Test',enabled:true,amount:.5,inputGamma:'DaVinci Intermediate',inputGamut:'DaVinci Wide Gamut',cube:{...cube,data:Array.from(cube.data)}}];
      const rendered=renderer.draw(source,clip,asset,nodes);if(mode.includes('gpu')&&!rendered.getContext('webgl2'))throw Error('GPU check fell back to CPU');out.drawImage(rendered,0,0);const actual=out.getImageData(0,0,64,1).data,transform=colorTransform(clip,asset,nodes);let total=0,max=0;
      for(let i=0;i<64;i++){const expected=transform(Array.from(image.data.slice(i*4,i*4+3)).map(x=>x/255));for(let c=0;c<3;c++){const error=Math.abs(actual[i*4+c]-Math.round(expected[c]*255));total+=error;max=Math.max(max,error);}}
      results.push({mode,profile,meanError:total/192,maxError:max});
    }}finally{renderer.dispose();}
  }
  // A fitted source mask must wrap correction + LUT once on GPU, CPU and native YUV paths.
  for(const mode of ['mask-gpu','mask-software','mask-yuv']){
    const picture=document.createElement('canvas'),resultCanvas=document.createElement('canvas');picture.width=resultCanvas.width=64;picture.height=resultCanvas.height=3;
    const context=picture.getContext('2d'),readMask=resultCanvas.getContext('2d',{willReadFrequently:true});context.fillStyle='rgb(102,102,102)';context.fillRect(0,1,64,1);
    const alpha=new Uint8Array(64*3);for(let x=0;x<64;x++)alpha[64+x]=Math.round(x/63*255);
    const masks=new Map([['subject',{width:64,height:3,data:alpha,key:'gradient'}]]),clip={id:'mask',properties:{colorPipeline:'nodes-v2',inputProfile:'Linear',inputGamut:'Rec.709'}},asset={inputProfile:'Linear'};
    const cube=makeCube(rgb=>rgb.map(v=>v*.5),2),node={id:'node',clipId:clip.id,name:'Subject grade',enabled:true,parameters:{offset:.2},mask:{id:'subject',enabled:true,invert:false,amount:100},effects:[{id:'lut',type:'lut',name:'Half',enabled:true,amount:1,inputGamma:'Linear',inputGamut:'Rec.709',cube:{...cube,data:Array.from(cube.data)}}]};
    if(mode==='mask-software')HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:nativeContext.call(this,type,...args);};
    if(mode==='mask-yuv')window.VideoFrame=class{
      format='I444';timestamp=0;codedWidth=64;codedHeight=1;colorSpace={toJSON:()=>({matrix:'bt709',fullRange:true})};allocationSize(){return 192;}
      async copyTo(buffer){buffer.fill(102,0,64);buffer.fill(128,64);return [{offset:0,stride:64},{offset:64,stride:64},{offset:128,stride:64}];}close(){}
    };
    const renderer=createColorPreview();HTMLCanvasElement.prototype.getContext=nativeContext;
    try{
      const maskVideo={currentTime:.75,readyState:2,videoWidth:64,videoHeight:1};let rendered;for(let attempt=0;attempt<20;attempt++){try{rendered=renderer.draw(picture,clip,asset,[node],mode==='mask-yuv'?maskVideo:undefined,sampleTime=>{if(mode==='mask-yuv'&&sampleTime!==0)throw Error('Alpha must use the decoded VideoFrame timestamp, not the moving video clock');return masks;});break;}catch(e){if(!(e instanceof ColorPending))throw e;await new Promise(r=>setTimeout(r,10));}}
      if(!rendered)throw Error('Masked frame never became ready');readMask.drawImage(rendered,0,0);const actual=readMask.getImageData(0,0,64,3).data;
      let total=0,max=0;for(let x=0;x<64;x++){
        const expected=colorTransform(clip,asset,[node],undefined,()=>alpha[64+x]/255)([.4,.4,.4]);
        for(let c=0;c<3;c++){const error=Math.abs(actual[(64+x)*4+c]-Math.round(expected[c]*255));total+=error;max=Math.max(max,error);}
        if(actual[x*4+3]!==0||actual[(128+x)*4+3]!==0)throw Error('A mask shifted outside the native picture fit');
      }
      results.push({mode,profile:'Linear',meanError:total/192,maxError:max});
    }finally{renderer.dispose();window.VideoFrame=NativeFrame;HTMLCanvasElement.prototype.getContext=nativeContext;}
  }
  // Read 10-bit planes before RGB quantization; a tight ramp amplified by exposure exposes early rounding.
  window.VideoFrame=class{
    format='I444P10';timestamp=0;codedWidth=64;codedHeight=1;colorSpace={toJSON:()=>({matrix:'bt709',fullRange:true})};
    allocationSize(){return 64*6;}
    async copyTo(buffer){const v=new DataView(buffer.buffer);for(let x=0;x<64;x++){v.setUint16(x*2,300+x,true);v.setUint16(128+x*2,512,true);v.setUint16(256+x*2,512,true);}return [{offset:0,stride:128},{offset:128,stride:128},{offset:256,stride:128}];}
    close(){}
  };
  const high=createColorPreview();try{
    let id=0;const clip={id:'high',projectId:'test',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}},asset={inputProfile:'S-Log3'},nodes=starterGrade(clip,asset,()=>String(++id)),video={currentTime:0,readyState:2,videoWidth:64,videoHeight:1};nodes[1].parameters.exposure=2;
    let rendered;for(let n=0;n<10;n++){try{rendered=high.draw(source,clip,asset,nodes,video);break;}catch(e){if(!(e instanceof ColorPending))throw e;await new Promise(r=>setTimeout(r,10));}}
    if(!rendered.getContext('webgl2'))throw Error('GPU check fell back to CPU');out.drawImage(rendered,0,0);const actual=out.getImageData(0,0,64,1).data,transform=colorTransform(clip,asset,nodes);let total=0,max=0;
    for(let x=0;x<64;x++){const expected=transform(Array(3).fill((300+x)/1023));for(let c=0;c<3;c++){const error=Math.abs(actual[x*4+c]-Math.round(expected[c]*255));total+=error;max=Math.max(max,error);}}
    results.push({mode:'10-bit-planes',profile:'S-Log3',meanError:total/192,maxError:max});
  }finally{high.dispose();window.VideoFrame=NativeFrame;}
  // A queued picture can be half a second behind the native decoder. Color and masks must
  // consume that exact snapshot, not whichever picture the video element has decoded ahead.
  const queued=createColorPreview(),picture=document.createElement('canvas');picture.width=64;picture.height=2;
  const bytes=new Uint8Array(64*2*1.5);for(let i=0;i<128;i++)bytes[i]=i%64<32?65:180;bytes.fill(128,128);
  const snapshot=new VideoFrame(bytes,{format:'I420',codedWidth:64,codedHeight:2,timestamp:500000});
  try{
    // Worker decoding deliberately leaves the native element unloaded, with zero dimensions.
    const video={currentTime:8,readyState:0,videoWidth:0,videoHeight:0},clip={id:'queued',properties:{inputProfile:'Rec.709',inputGamut:'Rec.709'}},asset={inputProfile:'Rec.709',colorMatrix:'bt709'};
    queued.prepare(video,snapshot);let rendered,maskTime;
    for(let n=0;n<100;n++){try{rendered=queued.draw(picture,clip,asset,[],video,time=>{maskTime=time;return new Map();},snapshot);break;}catch(e){if(!(e instanceof ColorPending))throw e;await new Promise(r=>setTimeout(r,10));}}
    if(!rendered||rendered.dataset.sourceTimestamp!=='0.5'||maskTime!==.5)throw Error('Queued color and mask time followed the decoder instead of the stored picture.');
    const result=document.createElement('canvas');result.width=64;result.height=2;const pixels=result.getContext('2d');pixels.drawImage(rendered,0,0);
    const left=pixels.getImageData(16,1,1,1).data,right=pixels.getImageData(48,1,1,1).data;
    if(left[3]!==255||right[3]!==255||right[0]-left[0]<80)throw Error('Queued YUV picture lost its geometry when the native video had no metadata.');
  }finally{snapshot.close();queued.dispose();}
  return results;
 });
 for(const result of results){console.log(result);assert.ok(result.meanError<1.5&&result.maxError<6,'GPU must match validated CPU camera and correction math.');}
 console.log('PASS Sony/Canon GPU color parity, ordered nodes, channel wheels, curves and camera exposure.');
}finally{await browser.close();await server.close();}
