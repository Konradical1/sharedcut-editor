import {browserExecutable} from './browser-options.mjs';
// Color page v3 on the real GPU against the CPU reference (docs/color-grading-v3.md): every new per-pixel tool on legacy and
// nodes-v2 clips, windows on full, letterboxed and YUV pictures, film passes against applyFilm (transparent layers keep their
// alpha), a spatial grade under a Stabilize warp, the key view, the node-input probe (layers drawn after the shot, bypassed
// nodes, pasted grades), Dehaze/Clarity against gradePicture (k = 0, 1, 2, film, windows, masks, letterbox, no float targets),
// and the frame time of 1920×1080 film and detail grades.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({appType:'custom',server:{port:0,host:'127.0.0.1'}});server.middlewares.use('/__color-v3-check',(_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Color v3 verification</title>');});await server.listen();
const browser=await chromium.launch({headless:true,executablePath:browserExecutable(),args:JSON.parse(process.env.QA_BROWSER_ARGS||'[]')});
try{
 const page=await browser.newPage();await page.goto(new URL('/__color-v3-check',server.resolvedUrls.local[0]).href);
 const report=await page.evaluate(async()=>{
  const {createColorPreview,ColorPending,setColorView,probeNodeInput}=await import('/src/services/colorPreview.ts');
  const {colorTransform,starterGrade,processingStages}=await import('/src/services/color.ts');
  const {windowAlpha,qualifierAlpha,filmActive}=await import('/src/services/grading.ts');
  const {applyFilm}=await import('/src/services/filmLook.ts');
  const nativeContext=HTMLCanvasElement.prototype.getContext,NativeFrame=window.VideoFrame,W709=[.2126,.7152,.0722];
  const software=()=>{HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:nativeContext.call(this,type,...args);};try{return createColorPreview();}finally{HTMLCanvasElement.prototype.getContext=nativeContext;}};
  const draw=async(renderer,...args)=>{for(let i=0;i<500;i++){try{return renderer.draw(...args);}catch(e){if(!(e instanceof ColorPending))throw e;await new Promise(r=>setTimeout(r,10));}}throw Error('Color preparation timed out');};
  const canvasOf=(width,height,paint)=>{const c=document.createElement('canvas');c.width=width;c.height=height;paint(c.getContext('2d'));return c;};
  const pixelsOf=canvas=>{const c=document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(canvas,0,0);return x.getImageData(0,0,c.width,c.height).data;};
  const sourceOf=canvas=>{const d=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data;return {d,rgb:i=>[d[i*4]/255,d[i*4+1]/255,d[i*4+2]/255]};};
  // 8-bit result against float expectations: undefined skips a pixel, null means it must stay transparent.
  const compare=(actual,expected)=>{let total=0,max=0,n=0,leaks=0;expected.forEach((rgb,i)=>{if(rgb===undefined)return;if(rgb===null){if(actual[i*4+3]!==0)leaks++;return;}if(actual[i*4+3]!==255)leaks++;for(let c=0;c<3;c++){const e=Math.abs(actual[i*4+c]-Math.round(Math.min(1,Math.max(0,rgb[c]))*255));total+=e;max=Math.max(max,e);n++;}});return {meanError:+(total/Math.max(1,n)).toFixed(4),maxError:max,leaks,channels:n};};
  const curve=points=>({mode:'smooth',points:points.map(([x,y],i)=>({id:'p'+i,x,y}))});
  const results=[];let gpuName='';

  // ---- Per-pixel tools: greys, near-primaries and a scatter of the RGB cube ----
  const palette=canvasOf(64,16,ctx=>{const image=ctx.createImageData(64,16);for(let i=0;i<1024;i++)image.data.set([...(i<32?[i*8,i*8,i*8]:i<96?[[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255]][i%6].map(v=>v?190+(i%4)*20:(i%5)*12):[(i*37+11)%256,(i*67+29)%256,(i*97+53)%256]),255],i*4);ctx.putImageData(image,0,0);});
  const hsl={HueHue:curve([[0,.5],[.15,.6],[.45,.42],[.7,.55],[1,.5]]),HueSat:curve([[0,.75],[.2,.5],[.5,.3],[.8,.6],[1,.75]]),HueLum:curve([[0,.6],[.3,.45],[.6,.55],[1,.6]]),LumSat:curve([[0,.3],[.5,.6],[1,.4]]),SatSat:curve([[0,.5],[.4,.7],[1,.45]]),SatLum:curve([[0,.5],[.5,.42],[1,.55]])};
  const grade={saturation:130,offset:.02,gainR:.04,liftB:.01},key={qualOn:1,qualHue:25,qualHueWidth:70,qualHueSoft:40,qualSatLow:12,qualSatSoft:10,qualLumLow:8,qualLumHigh:88,qualLumSoft:12};
  const cases=[
   ['log wheels',{logShadow:.03,logShadowR:-.02,logShadowB:.025,logMid:-.015,logMidG:.02,logHighlight:.02,logHighlightB:-.03,logLowRange:.3,logHighRange:.62}],
   ['shadows+ highlights-',{shadows:70,highlights:-60}],['shadows- highlights+',{shadows:-45,highlights:80}],
   ['hue boost density',{hue:35,boost:45,density:60}],['hue -120',{hue:-120}],['boost -60',{boost:-60}],
   ...Object.entries(hsl).map(([k,c])=>[k,{},{[k]:c}]),['all HSL curves',{},hsl],
   ['mixer',{mixRR:.85,mixRG:.2,mixRB:-.05,mixGR:.1,mixGG:.8,mixGB:.1,mixBR:-.1,mixBG:.25,mixBB:.9}],['monochrome',{mixRR:.3,mixRG:.6,mixRB:.1,mixMono:1}],
   ['qualifier',{...grade,...key}],['qualifier inverted',{...grade,...key,qualInvert:1}],['qualifier hue only',{...grade,qualOn:1,qualHue:200,qualHueWidth:40,qualHueSoft:30}],
   ['everything',{...grade,...key,logMidR:.01,shadows:30,highlights:-20,hue:10,boost:20,density:30,mixRG:.1,mixGB:-.05},hsl],
  ];
  const source=sourceOf(palette);
  for(const pipeline of ['legacy','nodes-v2']){
   const renderer=createColorPreview();
   try{for(const [name,parameters,curves] of cases){
    let clip,asset,nodes;
    if(pipeline==='legacy'){clip={id:'v3',projectId:'p',properties:{}};asset={inputProfile:'Rec.709',resolution:'64 × 16'};nodes=[{id:'a',clipId:'v3',projectId:'p',kind:'serial',name:'A',enabled:true,order:1,parameters:{exposure:.1,contrast:1.05}},{id:'b',clipId:'v3',projectId:'p',kind:'serial',name:'B',enabled:true,order:2,parameters,...(curves?{curves}:{})}];}
    else{let id=0;clip={id:'v3m',projectId:'p',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}};asset={inputProfile:'S-Log3',resolution:'64 × 16'};nodes=starterGrade(clip,asset,()=>'m'+ ++id);nodes[1].parameters={...nodes[1].parameters,exposure:.4,...parameters};if(curves)nodes[1].curves=curves;}
    const rendered=await draw(renderer,palette,clip,asset,nodes);if(!rendered.getContext('webgl2'))throw Error('GPU check fell back to CPU');
    if(!gpuName){const gl=rendered.getContext('webgl2'),info=gl.getExtension('WEBGL_debug_renderer_info');gpuName=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}
    const transform=colorTransform(clip,asset,nodes);
    results.push({group:'per-pixel',pipeline,name,...compare(pixelsOf(rendered),Array.from({length:1024},(_,i)=>transform(source.rgb(i))))});
   }}finally{renderer.dispose();}
  }

  // ---- Windows at the pixel's picture position: full frame, letterboxed (fractional edges), pillarboxed, and YUV ----
  const windowKeys={offset:.08,saturation:150,gainB:.1,circOn:1,circX:.4,circY:.45,circW:.25,circH:.18,circAngle:20,circSoft:.08,rectOn:1,rectX:.7,rectY:.6,rectW:.4,rectH:.25,rectAngle:-15,rectSoft:.05,rectRound:.3,gradOn:1,gradX:.5,gradY:.3,gradAngle:160,gradSoft:.25,gradInvert:1};
  const windowGrade=(pipeline,resolution)=>{
   if(pipeline==='legacy'){const clip={id:'win',projectId:'p',properties:{}};return {clip,asset:{inputProfile:'Rec.709',resolution},nodes:[{id:'w',clipId:'win',projectId:'p',kind:'serial',name:'Window',enabled:true,order:1,parameters:windowKeys}],node:'w'};}
   let id=0;const clip={id:'winm',projectId:'p',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}},asset={inputProfile:'S-Log3',resolution},nodes=starterGrade(clip,asset,()=>'w'+ ++id);
   nodes[1].parameters={...nodes[1].parameters,...windowKeys,offset:.03};return {clip,asset,nodes,node:nodes[1].id};
  };
  for(const [label,width,height,resolution] of [['full',96,54,'1920 × 1080'],['letterbox',97,61,'1920 × 1080'],['pillarbox',90,60,'1080 × 1080']])for(const pipeline of ['legacy','nodes-v2'])for(const mode of ['gpu','software']){
   const {clip,asset,nodes,node}=windowGrade(pipeline,resolution),[sw,sh]=resolution.split(' × ').map(Number),fit=Math.min(width/sw,height/sh),pw=sw*fit,ph=sh*fit,left=(width-pw)/2,top=(height-ph)/2;
   const picture=canvasOf(width,height,ctx=>ctx.drawImage(palette,left,top,pw,ph)),input=sourceOf(picture),params=nodes.find(n=>n.id===node).parameters;
   const renderer=mode==='gpu'?createColorPreview():software();
   try{
    const rendered=await draw(renderer,picture,clip,asset,nodes),expected=[];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x,a=input.d[i*4+3];expected.push(a===0?null:a<255?undefined:colorTransform(clip,asset,nodes,undefined,id=>{if(id!=='window:'+node)throw Error('unexpected mask '+id);return windowAlpha((x+.5-left)/pw,(y+.5-top)/ph,pw/ph,params);})(input.rgb(i)));}
    results.push({group:'windows',pipeline,name:label+' '+mode,...compare(pixelsOf(rendered),expected)});
   }finally{renderer.dispose();}
  }
  // A worker-decoded YUV frame letterboxed by its own display size (64×16 picture in a 64×32 layer).
  window.VideoFrame=class{format='I444';timestamp=0;codedWidth=64;codedHeight=16;colorSpace={toJSON:()=>({matrix:'bt709',fullRange:true})};allocationSize(){return 64*16*3;}async copyTo(buffer){buffer.fill(102,0,1024);buffer.fill(128,1024);return [{offset:0,stride:64},{offset:1024,stride:64},{offset:2048,stride:64}];}close(){}};
  for(const pipeline of ['legacy','nodes-v2']){
   const {clip,asset,nodes,node}=windowGrade(pipeline,'64 × 16'),params=nodes.find(n=>n.id===node).parameters,renderer=createColorPreview(),layer=canvasOf(64,32,()=>{});
   try{
    const rendered=await draw(renderer,layer,clip,asset,nodes,{currentTime:0,readyState:2,videoWidth:64,videoHeight:16}),expected=[];
    for(let y=0;y<32;y++)for(let x=0;x<64;x++)expected.push(y<8||y>=24?null:colorTransform(clip,asset,nodes,undefined,()=>windowAlpha((x+.5)/64,(y-8+.5)/16,4,params))([.4,.4,.4]));
    results.push({group:'windows',pipeline,name:'yuv letterbox',...compare(pixelsOf(rendered),expected)});
   }finally{renderer.dispose();}
  }
  window.VideoFrame=NativeFrame;

  // ---- Film stage against applyFilm. Segments stay unclamped between passes (as color-render.py), while colorTransform clamps
  // each part, so the oracle counts the values it had to clamp before a film stage: the data keeps that at 0. ----
  // `rgbAt(i)` overrides the picture's pixels (a warped float picture), `alphaAt(i, id)` gives windows and mattes per pixel.
  const cpuChain=(clip,asset,nodes,picture,frame,rgbAt=sourceOf(picture).rgb,alphaAt)=>{
   const {width,height}=picture,films=processingStages(clip,nodes).filter(s=>s.type==='film'),parts=[[]];let clamped=0,at=0;const maskAt=alphaAt&&(id=>alphaAt(at,id));
   for(const n of [...nodes].filter(n=>n.enabled).sort((a,b)=>a.order-b.order)){parts.at(-1).push(n);if(filmActive(n.parameters))parts.push([]);}
   let rgb=new Float32Array(width*height*3);for(let i=0;i<width*height;i++)rgb.set(rgbAt(i),i*3);
   const run=(transform,beforeFilm)=>{for(let i=0;i<width*height;i++){at=i;const out=transform(Array.from(rgb.subarray(i*3,i*3+3)));if(beforeFilm)clamped+=out.filter(v=>v<=0||v>=1).length;rgb.set(out,i*3);}};
   run(colorTransform(clip,asset,parts[0],undefined,maskAt),films.length>0);
   films.forEach((film,k)=>{rgb=applyFilm(rgb,width,height,film,frame);run(colorTransform({...clip,properties:{...clip.properties,inputProfile:film.gamma,inputGamut:film.gamut,inputExposure:0,inputTemperature:0}},asset,parts[k+1],undefined,maskAt),k+1<films.length);});
   return {clamped,expected:Array.from({length:width*height},(_,i)=>Array.from(rgb.subarray(i*3,i*3+3)))};
  };
  // A gradient with lamps; `tame` keeps S-Log3 colours inside DaVinci Wide Gamut (a saturated S-Gamut3.Cine red is not).
  const lamps=(width,height,tame)=>canvasOf(width,height,ctx=>{
   const image=ctx.createImageData(width,height);
   for(let y=0;y<height;y++)for(let x=0;x<width;x++)image.data.set(tame?[Math.round(60+90*x/width),Math.round(70+80*y/height),Math.round(110-40*x/width),255]:[Math.round(40+150*x/width),Math.round(30+120*y/height),Math.round(160-100*x/width),255],(y*width+x)*4);
   for(const [cx,cy,r,c] of [[30,25,3,[255,255,255]],[120,70,4,[255,240,200]],[160,20,2,tame?[250,215,180]:[255,80,40]],[70,85,5,[250,250,255]],[188,104,3,[255,255,255]]])for(let y=cy-r;y<=cy+r;y++)for(let x=cx-r;x<=cx+r;x++)if(x>=0&&y>=0&&x<width&&y<height&&(x-cx)**2+(y-cy)**2<=r*r)image.data.set([...c,255],(y*width+x)*4);
   ctx.putImageData(image,0,0);
  });
  const film={filmHalation:70,filmHalationThreshold:0,filmHalationRadius:2,filmHalationHue:15,filmHalationSat:85,filmBloom:60,filmBloomThreshold:.5,filmBloomRadius:15,filmBloomWarmth:30,filmGrain:45,filmGrainSize:1.3,filmGrainColor:40,filmGrainResponse:60,filmGrainSeed:7,filmVignette:40,filmVignetteSize:45,filmVignetteSoftness:60,filmVignetteRoundness:30,filmWeave:100,filmAberration:100,filmBreath:60};
  const legacyFilm=(parameters,resolution)=>({clip:{id:'film',projectId:'p',properties:{}},asset:{inputProfile:'Rec.709',resolution},nodes:[{id:'f',clipId:'film',projectId:'p',kind:'serial',name:'Film',enabled:true,order:1,parameters}]});
  const managedFilm=(name,first,second={},resolution='1920 × 1080')=>{let id=0;const clip={id:name,projectId:'p',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}},asset={inputProfile:'S-Log3',resolution},nodes=starterGrade(clip,asset,()=>name+ ++id);nodes[1].parameters={...nodes[1].parameters,...first};nodes[2].parameters={...nodes[2].parameters,...second};return {clip,asset,nodes};};
  const filmCases=[
   ['legacy 192×108',192,108,false,()=>legacyFilm({offset:-.02,gainR:.01,...film},'1920 × 1080')],
   ['legacy 190×107 (odd halvings)',190,107,false,()=>legacyFilm({offset:-.02,...film,filmBloomRadius:20,filmHalationRadius:6},'190 × 107')],
   ['legacy 192×108 grain only, static, mono',192,108,false,()=>legacyFilm({offset:-.02,filmGrain:100,filmGrainStatic:1,filmGrainColor:0,filmGrainSize:.6,filmGrainSeed:9999},'1920 × 1080')],
   ['nodes-v2 S-Log3, film between CSTs',192,108,true,()=>managedFilm('fm',{exposure:.6,...film})],
   ['nodes-v2, two film stages',192,108,true,()=>managedFilm('fn',{filmHalation:50,filmBloom:40,filmBloomRadius:8},{saturation:90,filmGrain:60,filmGrainColor:0,filmVignette:-30,filmWeave:60,filmBreath:100,filmGrainSeed:3})],
  ];
  const oracle=[];
  for(const [name,width,height,tame,make] of filmCases)for(const mode of ['gpu','software']){
   const {clip,asset,nodes}=make(),picture=lamps(width,height,tame),renderer=mode==='gpu'?createColorPreview():software();
   try{
    // A fake element sends the RGB path at source frame 5 (24 fps): VideoFrame refuses it.
    const rendered=await draw(renderer,picture,clip,asset,nodes,{currentTime:5/24+1e-4,readyState:2,videoWidth:width,videoHeight:height});
    if(rendered.dataset.sourceTimestamp!==String(5/24))throw Error('Film frame was not 5: '+rendered.dataset.sourceTimestamp);
    const {clamped,expected}=cpuChain(clip,asset,nodes,picture,5);if(mode==='gpu')oracle.push({name,clamped});
    results.push({group:'film',pipeline:clip.properties.colorPipeline??'legacy',name:name+' '+mode,...compare(pixelsOf(rendered),expected)});
   }finally{renderer.dispose();}
  }
  // A transparent layer (a title: an opaque and a half-transparent box on nothing) through film. Film changes colour only, so every
  // pixel keeps the source's alpha (the viewer showed an opaque box) and the opaque pixels' colour matches applyFilm.
  {
   const title=canvasOf(96,54,ctx=>{ctx.fillStyle='rgb(200,150,60)';ctx.fillRect(20,12,40,16);ctx.fillStyle='rgba(60,120,190,.5)';ctx.fillRect(50,30,30,14);}),{d}=sourceOf(title);
   const {clip,asset,nodes}=legacyFilm({offset:.04,saturation:110,filmGrain:40,filmGrainSeed:3,filmVignette:40,filmHalation:60,filmHalationThreshold:-1,filmHalationRadius:3,filmBloom:40,filmBloomRadius:6},'96 × 54');
   for(const mode of ['gpu','software']){
    const renderer=mode==='gpu'?createColorPreview():software();
    try{
     const rendered=pixelsOf(await draw(renderer,title,clip,asset,nodes,undefined,new Map(),undefined,5)),{clamped,expected}=cpuChain(clip,asset,nodes,title,5);
     let alphaChanged=0;for(let i=0;i<96*54;i++)if(Math.abs(rendered[i*4+3]-d[i*4+3])>1)alphaChanged++;
     if(mode==='gpu')oracle.push({name:'transparent title',clamped});
     results.push({group:'film',pipeline:'legacy',name:'transparent title keeps its alpha '+mode,...compare(rendered,expected.map((rgb,i)=>d[i*4+3]===255?rgb:d[i*4+3]?undefined:null)),alphaChanged});
    }finally{renderer.dispose();}
   }
  }
  // Stabilize with a spatial grade: export grades the stabilized bake, so the picture and its Smart Mask are read through the warp
  // (bilinear, original → stabilized layer pixels) while windows and film stay on the output frame. A warp off the frame leaves
  // the uncovered pixels transparent.
  {
   const {invert,apply}=await import('/src/services/colorKeys.ts'),W=128,H=72;
   const picture=canvasOf(W,H,ctx=>{const image=ctx.createImageData(W,H);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const blob=Math.exp(-((x-40)**2+(y-30)**2)/50)+.8*Math.exp(-((x-95)**2+(y-50)**2)/30);image.data.set([50+120*x/W+55*blob,45+110*y/H+55*blob,150-70*x/W+50*blob,255].map(Math.round),(y*W+x)*4);}ctx.putImageData(image,0,0);});
   const {d}=sourceOf(picture),matte=new Uint8Array(W*H);for(let i=0;i<W*H;i++)matte[i]=Math.round(255*(.15+.7*(i%W)/W*(.4+.6*Math.floor(i/W)/H)));
   const bilinear=(data,channels,c,x,y)=>{const u=Math.max(0,Math.min(W-1,x-.5)),v=Math.max(0,Math.min(H-1,y-.5)),x0=Math.floor(u),y0=Math.floor(v),x1=Math.min(W-1,x0+1),y1=Math.min(H-1,y0+1),fx=u-x0,fy=v-y0,at=(X,Y)=>data[(Y*W+X)*channels+c];return (at(x0,y0)*(1-fx)+at(x1,y0)*fx)*(1-fy)+(at(x0,y1)*(1-fx)+at(x1,y1)*fx)*fy;};
   const s=1.1,phi=Math.PI/180,a=s*Math.cos(phi),b=s*Math.sin(phi),zoom=[a,b,-b,a,W/2+2.25-a*W/2+b*H/2,H/2-1.25-b*W/2-a*H/2],shift=[1,0,0,1,5,3];
   const windowed={offset:.03,saturation:120,circOn:1,circX:.35,circY:.45,circW:.22,circH:.18,circSoft:.1,gradOn:1,gradAngle:25,gradSoft:.3};
   const clip={id:'stab',projectId:'p',properties:{}},asset={inputProfile:'Rec.709',resolution:`${W} × ${H}`},masks=new Map([['m1',{key:'m1-k',data:matte,width:W,height:H}]]);
   const node=(id,order,parameters,mask)=>({id,clipId:'stab',projectId:'p',kind:'serial',name:id,enabled:true,order,parameters,...mask?{mask:{id:'m1',enabled:true,invert:false,amount:80}}:{}});
   for(const [name,warp,nodes,film] of [['windows + matte',zoom,[node('w',1,windowed,true)],false],['windows + matte + film',zoom,[node('w',1,windowed,true),node('f',2,{gain:1.05,filmVignette:45,filmGrain:35,filmGrainSeed:4,filmHalation:50,filmHalationThreshold:-1,filmHalationRadius:3})],true],['shifted off the frame',shift,[node('w',1,windowed,true)],false]]){
    const back=invert(warp),q=i=>apply(back,i%W+.5,Math.floor(i/W)+.5),outside=i=>{const p=q(i);return p.x<0||p.y<0||p.x>W||p.y>H;};
    const {expected,clamped}=cpuChain(clip,asset,nodes,picture,5,i=>{const p=q(i);return [0,1,2].map(c=>bilinear(d,4,c,p.x,p.y)/255);},(i,id)=>{if(id==='m1'){const p=q(i);return bilinear(matte,1,0,p.x,p.y)/255;}return windowAlpha((i%W+.5)/W,(Math.floor(i/W)+.5)/H,W/H,nodes.find(n=>'window:'+n.id===id).parameters);});
    if(film)oracle.push({name:'stabilize warp, '+name,clamped});
    for(const mode of ['gpu','software']){
     const renderer=mode==='gpu'?createColorPreview():software();
     try{results.push({group:film?'film':'windows',pipeline:'legacy',name:`stabilize warp, ${name} ${mode}`,...compare(pixelsOf(await draw(renderer,picture,clip,asset,nodes,undefined,masks,undefined,5,warp)),expected.map((rgb,i)=>outside(i)?null:rgb))});}finally{renderer.dispose();}
    }
   }
  }
  // A film stage that changes nothing (vignette outside the frame) must hand on out-of-range values untouched: the
  // saturated palette leaves DaVinci Wide Gamut and goes above 1, and the grade must equal the single pass (CPU skips film).
  for(const pipeline of ['legacy','nodes-v2']){
   const still={filmVignette:100,filmVignetteSize:100,filmVignetteSoftness:1},{clip,asset,nodes}=pipeline==='legacy'?legacyFilm({saturation:160,gain:1.2,...still},'64 × 16'):managedFilm('fo',{exposure:1,saturation:150,...still},{},'64 × 16'),renderer=createColorPreview();
   try{const transform=colorTransform(clip,asset,nodes);results.push({group:'film',pipeline,name:'neutral film stage keeps unclamped values',...compare(pixelsOf(await draw(renderer,palette,clip,asset,nodes)),Array.from({length:1024},(_,i)=>transform(source.rgb(i))))});}finally{renderer.dispose();}
  }

  // ---- Key view: matte = mask × windows × qualifier as grey; highlight = the grade over mid grey by that alpha ----
  const moderate=canvasOf(64,16,ctx=>{const image=ctx.createImageData(64,16);for(let i=0;i<1024;i++)image.data.set([35+(i*37)%180,35+(i*67)%180,35+(i*97)%180,255],i*4);ctx.putImageData(image,0,0);}),mid=sourceOf(moderate);
  let events=0;const onView=()=>events++;window.addEventListener('frameline:color-view',onView);
  {
   const clip={id:'view',projectId:'p',properties:{}},asset={inputProfile:'Rec.709',resolution:'64 × 16'};
   const first={id:'va',clipId:'view',projectId:'p',kind:'serial',name:'A',enabled:true,order:1,parameters:{offset:-.02}},keyed={id:'vb',clipId:'view',projectId:'p',kind:'serial',name:'B',enabled:true,order:2,parameters:{...key,saturation:115,offset:.02,circOn:1,circX:.5,circY:.5,circW:.3,circH:.3,circSoft:.2}};
   const alpha=i=>qualifierAlpha(colorTransform(clip,asset,[first])(mid.rgb(i)),W709,keyed.parameters)*windowAlpha((i%64+.5)/64,(Math.floor(i/64)+.5)/16,4,keyed.parameters);
   const windowAt=i=>()=>windowAlpha((i%64+.5)/64,(Math.floor(i/64)+.5)/16,4,keyed.parameters);
   for(const withFilm of [false,true]){
    const nodes=[first,keyed,...withFilm?[{id:'vc',clipId:'view',projectId:'p',kind:'serial',name:'C',enabled:true,order:3,parameters:{filmVignette:50,filmBreath:40,filmGrainSeed:2}}]:[]],renderer=createColorPreview();
    try{
     const graded=withFilm?(()=>{const film=processingStages(clip,nodes).find(s=>s.type==='film'),rgb=new Float32Array(1024*3);for(let i=0;i<1024;i++)rgb.set(colorTransform(clip,asset,[first,keyed],undefined,windowAt(i))(mid.rgb(i)),i*3);const out=applyFilm(rgb,64,16,film,0);return i=>Array.from(out.subarray(i*3,i*3+3));})():i=>colorTransform(clip,asset,nodes,undefined,windowAt(i))(mid.rgb(i));
     setColorView({nodeId:'vb',mode:'matte'});
     results.push({group:'key view',pipeline:'legacy',name:'matte'+(withFilm?' before a film stage':''),...compare(pixelsOf(await draw(renderer,moderate,clip,asset,nodes)),Array.from({length:1024},(_,i)=>Array(3).fill(alpha(i))))});
     setColorView({nodeId:'vb',mode:'highlight'});
     results.push({group:'key view',pipeline:'legacy',name:'highlight'+(withFilm?' carried through a film stage':''),...compare(pixelsOf(await draw(renderer,moderate,clip,asset,nodes)),Array.from({length:1024},(_,i)=>graded(i).map(v=>.5+(Math.min(1,Math.max(0,v))-.5)*alpha(i))))});
     setColorView({nodeId:'elsewhere',mode:'matte'});
     results.push({group:'key view',pipeline:'legacy',name:'other clip\'s node shows the grade'+(withFilm?' (film)':''),...compare(pixelsOf(await draw(renderer,moderate,clip,asset,nodes)),Array.from({length:1024},(_,i)=>graded(i)))});
     setColorView({nodeId:null,mode:'off'});
    }finally{renderer.dispose();}
   }
   // A pasted grade (new ids, same values) re-plans, so the key view finds the new node.
   const renderer=createColorPreview();
   try{
    await draw(renderer,moderate,clip,asset,[first,keyed]);
    setColorView({nodeId:'xb',mode:'matte'});
    results.push({group:'key view',pipeline:'legacy',name:'matte of a pasted grade',...compare(pixelsOf(await draw(renderer,moderate,clip,asset,[{...first,id:'xa'},{...keyed,id:'xb'}])),Array.from({length:1024},(_,i)=>Array(3).fill(alpha(i))))});
    setColorView({nodeId:null,mode:'off'});
   }finally{renderer.dispose();}
  }
  window.removeEventListener('frameline:color-view',onView);

  // ---- Probe: the node's input in its working encoding, read back as floats ----
  const probes=[],near=(name,actual,expected)=>probes.push({name,actual,expected,error:actual&&expected?Math.max(...actual.map((v,c)=>Math.abs(v-expected[c]))):actual===expected?0:Infinity});
  {
   const flat=canvasOf(32,18,ctx=>{ctx.fillStyle='rgb(90,140,200)';ctx.fillRect(0,0,32,18);}),rgb=[90/255,140/255,200/255],renderer=createColorPreview();
   try{
    const clip={id:'probe',projectId:'p',properties:{}},asset={inputProfile:'Rec.709',resolution:'1920 × 1080'};
    const nodes=[{id:'p1',clipId:'probe',projectId:'p',kind:'serial',name:'One',enabled:true,order:1,parameters:{offset:.05,saturation:80}},{id:'p2',clipId:'probe',projectId:'p',kind:'serial',name:'Two',enabled:true,order:2,parameters:{qualOn:1}}];
    await draw(renderer,flat,clip,asset,nodes);
    near('legacy second node',await probeNodeInput('p2',.5,.5),colorTransform(clip,asset,[nodes[0]])(rgb));
    near('legacy first node',await probeNodeInput('p1',.5,.5),rgb);near('legacy corner (5×5 kept inside)',await probeNodeInput('p1',0,1),rgb);
    // A layer drawn after the shot (a graded adjustment above, picture-in-picture, a dissolve) leaves the pick to the shot's own
    // next draw, which the viewer is asked for once.
    let asked=0;const ask=()=>asked++;window.addEventListener('frameline:color-view',ask);
    const other={id:'above',projectId:'p',properties:{}},above=[{id:'up',clipId:'above',projectId:'p',kind:'serial',name:'Up',enabled:true,order:1,parameters:{saturation:130}}];
    await draw(renderer,flat,other,asset,above);
    const waiting=probeNodeInput('p2',.5,.5);await draw(renderer,flat,clip,asset,nodes);await draw(renderer,flat,other,asset,above);
    near('under a layer drawn after it',await waiting,colorTransform(clip,asset,[nodes[0]])(rgb));
    window.removeEventListener('frameline:color-view',ask);near('a waiting pick asks for one redraw',[asked],[1]);
    // A bypassed node reads the input of the place it holds: the next enabled node's input, or the whole grade when it is last.
    const three={id:'p3',clipId:'probe',projectId:'p',kind:'serial',name:'Three',enabled:true,order:3,parameters:{gain:.9}},off=(id,order)=>({...nodes[1],id,order,enabled:false});
    await draw(renderer,flat,clip,asset,[nodes[0],off('pb',2),three,off('pl',4)]);
    near('bypassed node between two',await probeNodeInput('pb',.5,.5),colorTransform(clip,asset,[nodes[0]])(rgb));
    near('bypassed last node',await probeNodeInput('pl',.5,.5),colorTransform(clip,asset,[nodes[0],three])(rgb));
    await draw(renderer,flat,clip,asset,[off('pb',1)]);near('every node bypassed',await probeNodeInput('pb',.5,.5),rgb);
    // A pasted grade (new ids, same values) re-plans, so the pick finds the new node.
    await draw(renderer,flat,clip,asset,nodes);await draw(renderer,flat,clip,asset,nodes.map(n=>({...n,id:'pasted-'+n.id})));
    near('pasted grade',await probeNodeInput('pasted-p2',.5,.5),colorTransform(clip,asset,[nodes[0]])(rgb));
    let id=0;const managed={id:'probem',projectId:'p',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}},log={inputProfile:'S-Log3',resolution:'1920 × 1080'},graded=starterGrade(managed,log,()=>'q'+ ++id);
    graded[1].parameters={...graded[1].parameters,exposure:.5,saturation:120};
    await draw(renderer,flat,managed,log,graded);
    near('nodes-v2 Balance (DaVinci Intermediate)',await probeNodeInput(graded[1].id,.3,.6),colorTransform(managed,log,graded.slice(0,1))(rgb));
    near('nodes-v2 Output CST',await probeNodeInput(graded[3].id,.3,.6),colorTransform(managed,log,graded.slice(0,3))(rgb));
    near('the earlier clip is no longer drawn',await probeNodeInput('p2',.5,.5),null);
    graded[1].parameters={...graded[1].parameters,filmBreath:100,filmGrainSeed:5};
    await draw(renderer,flat,managed,log,graded);
    const film=processingStages(managed,graded).find(s=>s.type==='film'),before=new Float32Array(16*3);for(let i=0;i<16;i++)before.set(colorTransform(managed,log,graded.slice(0,2))(rgb),i*3);
    near('after a film stage (breath)',await probeNodeInput(graded[2].id,.5,.5),Array.from(applyFilm(before,4,4,film,0).subarray(0,3)));
   }finally{renderer.dispose();}
   near('disposed renderer',await probeNodeInput('p2',.5,.5),null);
  }

  // ---- Dehaze/Clarity against gradePicture (maps from the node input over the picture box, H = its height): k = 0, 1, 2 ----
  const {gradePicture,encodeLog}=await import('/src/services/color.ts');
  // final_detail.pattern (linear sky, a 1.6 cloud, a hazy textured ridge) and a hazy, noisy "footage" frame with deep shadows and a lamp.
  const pattern=(H,W,i,j)=>{const v=(i+.5)/H,u=(j+.5)/W,ridge=.38+.06*Math.sin(6.1*u)+.02*Math.sin(31*u),fade=1-.6*Math.min(Math.max(v-ridge,0),1),tex=2**(.8*Math.sin(53*u+3*v)*Math.sin(41*v-2*u)+.4*Math.sin(170*u)*Math.sin(150*v));return (u-.3)**2*(W/H)**2+(v-.18)**2<.07**2?[1.6,1.6,1.6]:v<ridge?[.2,.28,.55].map(c=>c*(1+.25*v)):[1,.95,.86].map((c,k)=>.045*tex*c*.5+[.3,.33,.38][k]*.5*fade);};
  const hash=(x,y,k)=>{let n=Math.imul(x,0x8da6b343)^Math.imul(y,0xd8163841)^Math.imul(k,0xcb1ab31f);n^=n>>>16;n=Math.imul(n,0x7feb352d);n^=n>>>15;return (n>>>8)/16777216;};
  const footage=(H,W,i,j)=>{const v=(i+.5)/H,u=(j+.5)/W,haze=.3*(1-v)**2,tex=2**(1.2*Math.sin(23*u+7*Math.sin(5*v))*Math.sin(19*v+3*u)+.5*Math.sin(97*u)*Math.sin(83*v));if((u-.7)**2*(W/H)**2+(v-.6)**2<.015**2)return [3,2.8,2.4];const c=v<.3+.05*Math.sin(9*u)?[.35,.45,.7]:[.12,.1,.07].map(x=>x*tex*(v>.8?.25:1));return c.map((x,k)=>(x*(1-haze)+haze*[.8,.85,.95][k])*(1+.08*(hash(j,i,k)-.5)));};
  const encoded=(width,height,lin,gamma,box={x0:0,y0:0,width,height})=>canvasOf(width,height,ctx=>{const image=ctx.createImageData(width,height);for(let y=0;y<box.height;y++)for(let x=0;x<box.width;x++)image.data.set([...lin(box.height,box.width,y,x).map(v=>Math.round(255*Math.min(1,Math.max(0,encodeLog(v,gamma))))),255],((box.y0+y)*width+box.x0+x)*4);ctx.putImageData(image,0,0);});
  // gradePicture over `box` of a layer; `alphaAt(i, id)` answers masks and windows at layer pixel i; pixels outside the box stay transparent.
  const cpuPicture=(clip,asset,nodes,picture,box={x0:0,y0:0,width:picture.width,height:picture.height},alphaAt,rgbAt=sourceOf(picture).rgb)=>{
   const {x0,y0,width,height}=box,layer=i=>(y0+Math.floor(i/width))*picture.width+x0+i%width,rgb=new Float32Array(width*height*3);for(let i=0;i<width*height;i++)rgb.set(rgbAt(layer(i)),i*3);
   const out=gradePicture(clip,asset,nodes,rgb,width,height,{maskAt:alphaAt&&((id,i)=>alphaAt(layer(i),id)),frame:0}),expected=Array(picture.width*picture.height).fill(null);
   for(let i=0;i<width*height;i++)expected[layer(i)]=Array.from(out.subarray(i*3,i*3+3));return expected;
  };
  const detailLegacy=(parameters,resolution,more=[])=>{const clip={id:'dl',projectId:'p',properties:{}},node=(id,order,p)=>({id,clipId:'dl',projectId:'p',kind:'serial',name:id,enabled:true,order,parameters:p});return {clip,asset:{inputProfile:'Rec.709',resolution},nodes:[node('da',1,{exposure:.1,contrast:1.05}),node('db',2,{saturation:110,...parameters}),...more.map((p,i)=>node('dc'+i,3+i,p))]};};
  // nodes-v2 in DaVinci Intermediate / Wide Gamut: detail on Balance runs at G = its exposure/temperature/tint gain.
  const detailManaged=(balance,look={},resolution)=>{let id=0;const clip={id:'dm',projectId:'p',properties:{colorPipeline:'nodes-v2',inputProfile:'DaVinci Intermediate',inputGamut:'DaVinci Wide Gamut'}},asset={inputProfile:'DaVinci Intermediate',resolution},nodes=starterGrade(clip,asset,()=>'dm'+ ++id);nodes[1].parameters={...nodes[1].parameters,exposure:.3,temperature:400,tint:-8,...balance};nodes[2].parameters={...nodes[2].parameters,contrast:1.1,...look};return {clip,asset,nodes};};
  const gpuDraw=async(picture,{clip,asset,nodes},...rest)=>{const renderer=createColorPreview();try{const rendered=await draw(renderer,picture,clip,asset,nodes,...rest);if(!rendered.getContext('webgl2'))throw Error('Detail check fell back to CPU');return pixelsOf(rendered);}finally{renderer.dispose();}};
  const detailCase=async(name,pipeline,picture,grade,expected,...rest)=>results.push({group:'detail',pipeline,name,...compare(await gpuDraw(picture,grade,...rest),expected??cpuPicture(grade.clip,grade.asset,grade.nodes,picture))});
  const settings=[[60,0],[-50,0],[0,60],[0,-60],[100,100],[35,-40]];
  for(const [size,W,H] of [['k=1 641×401',641,401],['k=0 161×97',161,97]])for(const [frame,lin] of [['pattern',pattern],['footage',footage]])for(const [dehaze,clarity] of size.startsWith('k=0')?[[100,100],[-60,-60]]:settings){
   const label=`${frame} ${size} dehaze ${dehaze} clarity ${clarity}`,resolution=`${W} × ${H}`;
   await detailCase(label,'legacy',encoded(W,H,lin,'Gamma 2.4'),detailLegacy({dehaze,clarity},resolution));
   await detailCase(label,'nodes-v2',encoded(W,H,lin,'DaVinci Intermediate'),detailManaged({dehaze,clarity},{},resolution));
  }
  for(const [frame,lin,dehaze,clarity] of [['pattern',pattern,60,30],['footage',footage,100,100],['footage',footage,-50,-40]]){
   await detailCase(`${frame} k=2 1920×1080 dehaze ${dehaze} clarity ${clarity}`,'nodes-v2',encoded(1920,1080,lin,'DaVinci Intermediate'),detailManaged({dehaze,clarity},{},'1920 × 1080'));
   if(dehaze===100)await detailCase(`${frame} k=2 1920×1080 dehaze ${dehaze} clarity ${clarity}`,'legacy',encoded(1920,1080,lin,'Gamma 2.4'),detailLegacy({dehaze,clarity},'1920 × 1080'));
  }
  {
   const W=641,H=401,resolution=`${W} × ${H}`,v2=encoded(W,H,footage,'DaVinci Intermediate'),old=encoded(W,H,footage,'Gamma 2.4');
   // Two detail points in a row (N0 → N1), one right after a film node (its output is the maps' input) and one on a film node itself.
   await detailCase('dehaze on Balance, clarity on Look','nodes-v2',v2,detailManaged({dehaze:70},{clarity:40},resolution));
   await detailCase('after a film node','nodes-v2',v2,detailManaged({filmHalation:60,filmHalationRadius:2,filmBloom:40,filmBloomRadius:6,filmVignette:30},{dehaze:60,clarity:30},resolution));
   await detailCase('detail and film on one node','legacy',old,detailLegacy({dehaze:60,clarity:-30,filmVignette:40,filmGrain:30,filmGrainSeed:3},resolution,[{dehaze:-40}]));
   // A gradient window and a Smart Mask limit both tools (the node blend), the qualifier keys on the pre-detail input.
   const matte=new Uint8Array(W*H);for(let i=0;i<W*H;i++)matte[i]=Math.round(255*(.2+.8*(i%W)/W));const masks=new Map([['dmask',{key:'dmask',data:matte,width:W,height:H}]]);
   for(const pipeline of ['legacy','nodes-v2']){
    const keys={dehaze:80,clarity:50,gradOn:1,gradAngle:30,gradSoft:.4,qualOn:1,qualLumLow:5,qualLumHigh:95,qualLumSoft:10},grade=pipeline==='legacy'?detailLegacy(keys,resolution):detailManaged({},keys,resolution),picture=pipeline==='legacy'?old:v2;
    grade.nodes.find(n=>n.parameters.gradOn).mask={id:'dmask',enabled:true,invert:false,amount:90};
    await detailCase('gradient window + Smart Mask + qualifier',pipeline,picture,grade,cpuPicture(grade.clip,grade.asset,grade.nodes,picture,undefined,(i,id)=>id==='dmask'?matte[i]/255:windowAlpha((i%W+.5)/W,(Math.floor(i/W)+.5)/H,W/H,grade.nodes.find(n=>'window:'+n.id===id).parameters)),undefined,masks);
   }
   // Letterboxed 2.39:1 in 1280×720 (fractional edges): the maps cover the picture box only, H = its 536 rows.
   const rect=[0,(720-1280*803/1920)/2,1280,1280*803/1920],box={x0:0,y0:Math.ceil(rect[1]-.5),width:1280,height:Math.ceil(rect[1]+rect[3]-.5)-Math.ceil(rect[1]-.5)};
   for(const pipeline of ['legacy','nodes-v2']){const picture=encoded(1280,720,footage,pipeline==='legacy'?'Gamma 2.4':'DaVinci Intermediate',box),grade=pipeline==='legacy'?detailLegacy({dehaze:60,clarity:40},'1920 × 803'):detailManaged({dehaze:60,clarity:40},{},'1920 × 803');await detailCase(`letterbox 1280×720 (box ${box.width}×${box.height})`,pipeline,picture,grade,cpuPicture(grade.clip,grade.asset,grade.nodes,picture,box));}
  }
  {
   // A transparent title keeps its alpha; under Stabilize the maps see the stabilized picture (export grades the stabilized bake).
   const title=canvasOf(96,54,ctx=>{ctx.fillStyle='rgb(200,150,60)';ctx.fillRect(20,12,40,16);ctx.fillStyle='rgba(60,120,190,.5)';ctx.fillRect(50,30,30,14);}),{d}=sourceOf(title),grade=detailLegacy({dehaze:60,clarity:50},'96 × 54');
   const got=await gpuDraw(title,grade,undefined,new Map(),undefined,5),expected=cpuPicture(grade.clip,grade.asset,grade.nodes,title);let alphaChanged=0;for(let i=0;i<96*54;i++)if(Math.abs(got[i*4+3]-d[i*4+3])>1)alphaChanged++;
   results.push({group:'detail',pipeline:'legacy',name:'transparent title keeps its alpha',...compare(got,expected.map((rgb,i)=>d[i*4+3]===255?rgb:d[i*4+3]?undefined:null)),alphaChanged});
   const {invert,apply}=await import('/src/services/colorKeys.ts'),W=256,H=144,picture=encoded(W,H,footage,'Gamma 2.4'),{d:src}=sourceOf(picture),s=1.1,phi=Math.PI/180,a=s*Math.cos(phi),b=s*Math.sin(phi),warp=[a,b,-b,a,W/2+2.25-a*W/2+b*H/2,H/2-1.25-b*W/2-a*H/2],back=invert(warp);
   const bilinear=(x,y,c)=>{const u=Math.max(0,Math.min(W-1,x-.5)),v=Math.max(0,Math.min(H-1,y-.5)),x0=Math.floor(u),y0=Math.floor(v),x1=Math.min(W-1,x0+1),y1=Math.min(H-1,y0+1),fx=u-x0,fy=v-y0,at=(X,Y)=>src[(Y*W+X)*4+c];return ((at(x0,y0)*(1-fx)+at(x1,y0)*fx)*(1-fy)+(at(x0,y1)*(1-fx)+at(x1,y1)*fx)*fy)/255;};
   const stab=detailLegacy({dehaze:70,clarity:40,circOn:1,circX:.4,circY:.5,circW:.3,circH:.25,circSoft:.1},`${W} × ${H}`),circle=stab.nodes[1].parameters;
   results.push({group:'detail',pipeline:'legacy',name:'stabilize warp + window',...compare(await gpuDraw(picture,stab,undefined,new Map(),undefined,5,warp),cpuPicture(stab.clip,stab.asset,stab.nodes,picture,undefined,i=>windowAlpha((i%W+.5)/W,(Math.floor(i/W)+.5)/H,W/H,circle),i=>{const q=apply(back,i%W+.5,Math.floor(i/W)+.5);return [0,1,2].map(c=>bilinear(q.x,q.y,c));}))});
  }
  {
   // Key view of a detail node: the matte is its window, the highlight the full grade over grey by it (the lamp is mixed unclamped: skipped).
   const W=161,H=97,picture=encoded(W,H,footage,'Gamma 2.4'),grade=detailLegacy({dehaze:60,clarity:40,circOn:1,circX:.5,circY:.5,circW:.3,circH:.3,circSoft:.2},`${W} × ${H}`,[{gain:.95}]),p=grade.nodes[1].parameters,alpha=i=>windowAlpha((i%W+.5)/W,(Math.floor(i/W)+.5)/H,W/H,p);
   const graded=cpuPicture(grade.clip,grade.asset,grade.nodes,picture),renderer=createColorPreview();
   try{
    setColorView({nodeId:'db',mode:'matte'});results.push({group:'detail',pipeline:'legacy',name:'key view matte',...compare(pixelsOf(await draw(renderer,picture,grade.clip,grade.asset,grade.nodes)),graded.map((_,i)=>Array(3).fill(alpha(i))))});
    setColorView({nodeId:'db',mode:'highlight'});results.push({group:'detail',pipeline:'legacy',name:'key view highlight',...compare(pixelsOf(await draw(renderer,picture,grade.clip,grade.asset,grade.nodes)),graded.map((rgb,i)=>rgb.some(v=>v>=1)?undefined:rgb.map(v=>.5+(Math.max(0,v)-.5)*alpha(i))))});
    setColorView({nodeId:null,mode:'off'});
    // The probe of the node after it reads the detailed picture (5×5 mean, unclamped); of the detail node itself, its input.
    const block=(rows,px,py)=>{const x=Math.max(0,Math.min(W-5,Math.floor(px*W)-2)),y=Math.max(0,Math.min(H-5,Math.floor(py*H)-2)),sum=[0,0,0];for(let j=0;j<5;j++)for(let i=0;i<5;i++)rows[(y+j)*W+x+i].forEach((v,c)=>sum[c]+=v/25);return sum;};
    near('after a detail node',await probeNodeInput('dc0',.3,.6),block(cpuPicture(grade.clip,grade.asset,grade.nodes.slice(0,2),picture),.3,.6));
    near('a detail node\'s own input',await probeNodeInput('db',.7,.4),block(cpuPicture(grade.clip,grade.asset,grade.nodes.slice(0,1),picture),.7,.4));
   }finally{renderer.dispose();}
  }
  {
   // Without float render targets a detail picture takes the exact software preview; other pictures stay on the GPU.
   const native=WebGL2RenderingContext.prototype.getExtension;WebGL2RenderingContext.prototype.getExtension=function(name){return name==='EXT_color_buffer_float'?null:native.call(this,name);};
   let renderer;try{renderer=createColorPreview();}finally{WebGL2RenderingContext.prototype.getExtension=native;}
   try{
    const picture=encoded(161,97,footage,'DaVinci Intermediate'),grade=detailManaged({dehaze:60,clarity:40},{},'161 × 97'),soft=await draw(renderer,picture,grade.clip,grade.asset,grade.nodes);
    results.push({group:'detail',pipeline:'nodes-v2',name:'no float targets: software preview',...compare(pixelsOf(soft),cpuPicture(grade.clip,grade.asset,grade.nodes,picture)),wrongPath:!!soft.getContext('webgl2')});
    const plain=detailManaged({},{},'161 × 97'),gpu=await draw(renderer,picture,plain.clip,plain.asset,plain.nodes);results.push({group:'detail',pipeline:'nodes-v2',name:'no float targets: no detail stays on the GPU',...compare(pixelsOf(gpu),cpuPicture(plain.clip,plain.asset,plain.nodes,picture)),wrongPath:!gpu.getContext('webgl2')});
   }finally{renderer.dispose();}
  }

  // ---- Frame time at 1920×1080 (each draw re-uploads the picture, as the RGB path does) ----
  const big=canvasOf(1920,1080,ctx=>{const g=ctx.createLinearGradient(0,0,1920,1080);g.addColorStop(0,'#203040');g.addColorStop(1,'#d0b080');ctx.fillStyle=g;ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#fff';for(let i=0;i<40;i++){ctx.beginPath();ctx.arc((i*373)%1920,(i*211)%1080,6+i%5*3,0,7);ctx.fill();}});
  const timing=[],filmAll={filmHalation:50,filmHalationRadius:1,filmBloom:40,filmBloomRadius:4,filmGrain:40,filmVignette:30,filmWeave:50,filmAberration:50,filmBreath:30};
  for(const [name,parameters,curves] of [['primaries only',{saturation:110,offset:.01}],['v3 per-pixel (log, tone, chroma, HSL, mixer, qualifier, windows)',{saturation:110,logMid:.01,shadows:20,highlights:-20,hue:5,boost:20,density:20,mixRG:.05,...key,circOn:1,rectOn:1,gradOn:1},hsl],['film (halation, bloom, grain, vignette, weave, aberration, breath)',{saturation:110,offset:.01,...filmAll}],['film + v3 per-pixel',{saturation:110,shadows:20,hue:5,boost:20,...key,circOn:1,...filmAll},hsl],['Dehaze + Clarity (primaries only + maps, split, apply)',{saturation:110,offset:.01,dehaze:60,clarity:40}]]){
   const renderer=createColorPreview(),clip={id:'perf',projectId:'p',properties:{}},asset={inputProfile:'Rec.709',resolution:'1920 × 1080'},nodes=[{id:'perf',clipId:'perf',projectId:'p',kind:'serial',name:'Perf',enabled:true,order:1,parameters,...curves?{curves}:{}}];
   try{
    const rendered=await draw(renderer,big,clip,asset,nodes),gl=rendered.getContext('webgl2'),pixel=new Uint8Array(4),sync=()=>gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    for(let i=0;i<5;i++){renderer.draw(big,clip,asset,nodes);sync();}
    const times=[];for(let i=0;i<100;i++){const t=performance.now();renderer.draw(big,clip,asset,nodes);sync();times.push(performance.now()-t);}
    times.sort((a,b)=>a-b);timing.push({name,medianMs:+times[50].toFixed(2),p90Ms:+times[90].toFixed(2)});
   }finally{renderer.dispose();}
  }
  return {gpuName,results,probes,timing,events,oracle};
 });
 console.log('GPU:',report.gpuName);
 for(const r of report.results)console.log(`${r.group.padEnd(9)} ${r.pipeline.padEnd(8)} ${r.name.padEnd(48)} mean ${String(r.meanError).padEnd(7)} max ${r.maxError}${r.leaks?` LEAKS ${r.leaks}`:''}`);
 for(const p of report.probes)console.log(`probe     ${p.name.padEnd(58)} error ${p.error.toExponential(2)}`);
 for(const t of report.timing)console.log(`1920×1080 ${t.name.padEnd(70)} median ${t.medianMs} ms  p90 ${t.p90Ms} ms`);
 for(const o of report.oracle){console.log(`oracle    ${o.name.padEnd(58)} clamped ${o.clamped}`);assert.equal(o.clamped,0,`${o.name}: the CPU oracle clamped values before a film stage; keep the test picture in range`);}
 for(const r of report.results){
  assert.equal(r.leaks,0,`${r.group} ${r.name}: pixels outside the picture must stay transparent and pixels inside opaque`);
  assert.equal(r.alphaChanged??0,0,`${r.name}: every pixel keeps the source's alpha`);assert.ok(!r.wrongPath,`${r.name}: drawn by the wrong renderer`);
  if(r.group==='detail')assert.ok(r.meanError<=.5&&r.maxError<=2,`${r.pipeline} ${r.name}: Dehaze/Clarity must match gradePicture (mean ≤ .5, max ≤ 2 codes)`);
  else if(r.group==='film'&&!r.name.startsWith('neutral'))assert.ok(r.meanError<=1&&r.maxError<=6,`${r.name}: film must match applyFilm (mean ≤ 1, max ≤ 6 codes)`);
  else assert.ok(r.maxError<=2,`${r.group} ${r.pipeline} ${r.name}: GPU must match the CPU reference within 2 codes`);
 }
 for(const p of report.probes)assert.ok(p.error<=2e-3,`probe ${p.name}: ${JSON.stringify(p.actual)} vs ${JSON.stringify(p.expected)}`);
 assert.equal(report.events,10,'setColorView announces every change');
 console.log('PASS Color v3 GPU parity: log wheels, Shadows/Highlights, hue/boost/density, HSL curves, mixer, qualifier, windows, film, Dehaze/Clarity, key view and probe.');
}finally{await browser.close();await server.close();}
