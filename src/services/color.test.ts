import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorTransform, decodeLog, encodeLog, makeCube, cubeText, parseCube, sampleCube, processingStages, rangeDefaults, starterGrade, profiles, interpretation, defaultCST, validateGradeNode } from './color.ts';
import { acesMatrices } from './aces.generated.ts';
import { venvPython } from '../../server/platform.ts';
import { timecode } from './timecode.ts';
import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';

test('a fractional spatial mask blends the complete node once, including its LUT',()=>{
  const clip={id:'masked',properties:{colorPipeline:'nodes-v2',inputProfile:'Linear',inputGamut:'Rec.709'}} as unknown as Clip;
  const cube=makeCube(rgb=>rgb.map(v=>v*.5),2);
  const node={id:'node',projectId:'project',kind:'primary',clipId:clip.id,enabled:true,name:'Masked',parameters:{offset:.2},mask:{id:'subject',enabled:true,invert:false,amount:100},effects:[{id:'lut',type:'lut',enabled:true,name:'Half',amount:1,inputGamma:'Linear',inputGamut:'Rec.709',cube:{...cube,data:Array.from(cube.data)}}]} as GradeNode;
  assert.throws(()=>colorTransform(clip,undefined,[node])([.2,.4,.6]),/mask/i);
  const original=[.2,.4,.6],full=colorTransform(clip,undefined,[{...node,mask:undefined}])(original);
  const partial=colorTransform(clip,undefined,[node],undefined,()=>.25)(original);
  partial.forEach((v,c)=>assert.ok(Math.abs(v-(original[c]+(full[c]-original[c])*.25))<1e-7));
  assert.deepEqual(colorTransform(clip,undefined,[node],undefined,()=>0)(original),original);
  assert.deepEqual(colorTransform(clip,undefined,[{...node,mask:{...node.mask!,invert:true}}],undefined,()=>1)(original),original);
});

test('Sony/Canon decoding, serial nodes and portable LUT interpolation',()=>{
  assert.equal(timecode(949/(24000/1001),24000/1001),'00:00:39:13');
  assert.equal(timecode(86400/(24000/1001),24000/1001),'01:00:00:00');
  assert.ok(Math.abs(decodeLog(420/1023,'S-Log3')-.18)<1e-12);
  assert.ok(Math.abs(decodeLog(95/1023,'S-Log3'))<1e-12);
  // Canon curves are IRE formulas on code values (0 IRE = 64, 100 IRE = 940): black is code 128 in every Canon container, grey 18% sits at 34.3 IRE for Canon Log 3.
  const canonCode=(ire:number)=>(ire*876+64)/1023;
  for(const [profile,a,b,c] of [['Canon Log',.529136,.0730597,10.1596],['Canon Log 2',.281863093,.035388128,87.09937546]] as const){assert.ok(Math.abs(decodeLog(canonCode(a*Math.log10(c*.18/.9+1)+b),profile)-.18)<1e-9);assert.ok(Math.abs(decodeLog(canonCode(b),profile))<1e-9,profile+' black');}
  assert.ok(Math.abs(decodeLog(128/1023,'Canon Log'))<1e-6,'Canon Log black is code 128');assert.ok(Math.abs(decodeLog(95/1023,'Canon Log 2'))<1e-6,'Canon Log 2 black is code 95');
  assert.ok(Math.abs(decodeLog(canonCode(.42889912*Math.log10(14.98325*.18/.9+1)+.069886632),'Canon Log 3')-.18)<1e-9);
  assert.ok(Math.abs(decodeLog(128/1023,'Canon Log 3'))<1e-9,'Canon Log 3 black is code 128');
  assert.ok(Math.abs(decodeLog(canonCode(.328),'Canon Log 3')-.18)<2e-3,'Canon Log 3 18% grey is 32.8 IRE');
  // ACES IDT (IDT.Canon.C300mk2_CanonLog3_CinemaGamut) constants are the same curve already expressed on code values.
  for(const v of [.1,.13,.2,.4,.6,.9])assert.ok(Math.abs(decodeLog(v,'Canon Log 3')-.9*(v<.097465473?-(10**((.12783901-v)/.36726845)-1)/14.98325:v<=.15277891?(v-.12512219)/1.9754798:(10**((v-.12240537)/.36726845)-1)/14.98325))<1e-6,'ACES IDT '+v);
  const clip={id:'clip',properties:{}} as Clip;
  const node=(order:number,parameters:Record<string,number>)=>({clipId:'clip',enabled:true,order,name:'Test',parameters} as GradeNode);
  const a=node(1,{exposure:1}),b=node(2,{offset:.1});
  assert.ok(Math.abs(colorTransform(clip,undefined,[b,a])([.2,.2,.2])[0]-.5)<1e-9);
  assert.ok(Math.abs(colorTransform(clip,undefined,[{...a,order:2},{...b,order:1}])([.2,.2,.2])[0]-.6)<1e-9,'Node order must affect pixels.');
  const cube=parseCube(cubeText(makeCube(colorTransform(clip,undefined,[node(1,{gainR:.1,curve50:.6})]))));
  assert.ok(sampleCube(cube,[.5,.5,.5])[0]>sampleCube(cube,[.5,.5,.5])[1]);
  assert.throws(()=>parseCube('LUT_3D_SIZE 65\n0 0 NaN'),/Invalid/);
  assert.throws(()=>parseCube('LUT_3D_SIZE 2\n0 0 0'),/Incomplete/);
  assert.throws(()=>decodeLog(.5,'Imaginary Log'),/Unsupported/);
});

test('wide-gamut references, reversible transforms, custom curves and complete log grades', async()=>{
  const {encodeLog,gamutMatrix,transformSpace,defaultCST,starterGrade,sampleCurve,identityCurve,validateGradeNode}=await import('./color.ts');
  assert.ok(Math.abs(encodeLog(.18,'DaVinci Intermediate')-.336043)<.000001);
  assert.ok(Math.abs(encodeLog(1,'DaVinci Intermediate')-.513837)<.000001);
  assert.ok(Math.abs(encodeLog(.18,'S-Log2')-.339532524633774)<1e-12);
  assert.ok(Math.abs(encodeLog(.18,'S-Log')-.384970815928670)<1e-12);
  for(const profile of ['S-Log','S-Log2','S-Log3','Canon Log','Canon Log 2','Canon Log 3','DaVinci Intermediate','Gamma 2.4','Linear','Apple Log'])for(const v of [-.01,0,.002,.18,1,5,20])assert.ok(Math.abs(decodeLog(encodeLog(v,profile),profile)-v)<2e-5,`${profile}: ${v}`);
  const m=gamutMatrix('DaVinci Wide Gamut','Rec.709');// Published DWG red XYZ column multiplied by the Rec.709 XYZ-to-RGB matrix.
  assert.ok(Math.abs(m[0][0]-(3.2409699419*.70062239-1.5373831776*.27411851-.4986107603*(-.09896291)))<1e-7);
  const input=defaultCST('in'),output=defaultCST('out','DaVinci Intermediate','DaVinci Wide Gamut','S-Log3','S-Gamut3.Cine');
  for(const rgb of [[.02,.01,.03],[.4,.6,.2],[.95,.85,.8]]){const back=transformSpace(transformSpace(rgb,input),output);back.forEach((v,c)=>assert.ok(Math.abs(v-rgb[c])<2e-6));}
  const curve={mode:'smooth' as const,points:[{id:'a',x:0,y:0},{id:'b',x:.2,y:.12},{id:'c',x:.62,y:.8},{id:'d',x:1,y:1}]};
  curve.points.forEach(p=>assert.ok(Math.abs(sampleCurve(p.x,curve)-p.y)<1e-9));
  assert.equal(sampleCurve(1.4,identityCurve()),1.4);assert.equal(sampleCurve(-.1,identityCurve()),-.1);
  assert.throws(()=>validateGradeNode({curves:{RGB:{...curve,points:[curve.points[0],curve.points[0]]}}}),/point/);
  assert.throws(()=>validateGradeNode({effects:[{...input,outputGamma:'Made up'}]}),/transform/);
  let next=0;const clip={id:'managed',projectId:'p',properties:{inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine',colorPipeline:'nodes-v2'}} as unknown as Clip;
  const nodes=starterGrade(clip,undefined,()=>String(++next));
  const bright=[5,4,3].map(v=>encodeLog(v,'S-Log3'));nodes[1].parameters.exposure=-4;
  const recovered=colorTransform(clip,undefined,nodes)(bright);assert.ok(recovered[0]>.4&&recovered[0]<.9);assert.ok(recovered[0]>recovered[2]);
  nodes[1].curves={RGB:curve};const look=colorTransform(clip,undefined,nodes)([.5,.4,.3]);assert.ok(look.every(Number.isFinite));
  const bypass=colorTransform(clip,undefined,nodes.map(n=>({...n,enabled:false})))([.5,.4,.3]);assert.deepEqual(bypass,[.5,.4,.3]);
});


test('ACES output validates its final display and stays isolated to its own clip',async()=>{
 const {starterGrade,processingStages}=await import('./color.ts');
 const clip={id:'aces-test',properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'}} as unknown as Clip;
 let id=0;const nodes=starterGrade(clip,undefined,()=>String(++id)),baseline=processingStages(clip,nodes);
 const foreign={...structuredClone(nodes[3]),clipId:'other'};if(foreign.effects?.[0].type==='cst'){foreign.effects[0].toneMapping='aces2';foreign.effects[0].gamutMapping='none';}
 assert.deepEqual(processingStages(clip,[...nodes,foreign]),baseline);
 const effect=nodes[3].effects![0];if(effect.type!=='cst')throw Error('Expected output CST');effect.toneMapping='aces2';effect.gamutMapping='none';
 assert.doesNotThrow(()=>processingStages(clip,nodes));
 assert.throws(()=>processingStages({...clip,properties:{...clip.properties,colorPipeline:'legacy'}},nodes),/wide-gamut/);
 effect.outputGamut='Rec.2020';assert.throws(()=>processingStages(clip,nodes),/ACES/);
});

test('ungraded log footage is shown as recorded; only a grade or an imported look converts it',()=>{
  const clip={id:'raw',projectId:'p',properties:{}} as unknown as Clip;
  for(const [inputProfile,inputGamut] of [['S-Log3','S-Gamut3.Cine'],['Canon Log 3','Cinema Gamut'],['Apple Log','Rec.2020']]){
    const transform=colorTransform(clip,{inputProfile,inputGamut} as unknown as MediaAsset,[]);
    for(const rgb of [[128/1023,128/1023,128/1023],[.3,.5,.7],[.9,.2,.4]])assert.deepEqual(transform(rgb),rgb,`${inputProfile} must pass through untouched`);
  }
});

test('range saturation: identity when absent or 100, smoothstep luma weights, legacy and nodes-v2 alike, preview packing matches',async()=>{
  const {rangeSaturation,colorStages,luminanceWeights,processingStages}=await import('./color.ts'),{packStages,STAGE_TEXELS}=await import('./colorPreview.ts');
  const node=(parameters:Record<string,number>)=>({id:'n',clipId:'r',enabled:true,order:1,name:'Range',parameters} as GradeNode);
  const legacy={id:'r',properties:{}} as Clip,managed={id:'r',properties:{colorPipeline:'nodes-v2',inputProfile:'Linear',inputGamut:'Rec.2020'}} as unknown as Clip;
  const colors=[[.02,.05,.01],[.3,.5,.2],[.6,.4,.7],[.95,.9,.6]],near=(a:number,b:number,m:string,e=1e-12)=>assert.ok(Math.abs(a-b)<e,`${m}: ${a} vs ${b}`);
  const range={saturationShadows:150,saturationMidtones:50,saturationHighlights:300},base={exposure:.2,saturation:120,temperature:300,tint:5,gainR:.05},w=[.2126,.7152,.0722];
  for(const clip of [legacy,managed]){
    const plain=colorTransform(clip,undefined,[node(base)]),unity=colorTransform(clip,undefined,[node({...base,saturationShadows:100,saturationMidtones:100,saturationHighlights:100})]);
    for(const rgb of colors)assert.deepEqual(unity(rgb),plain(rgb),'100 everywhere is bit-identical to no keys');
  }
  const grey=[.3,.5,.2];assert.equal(rangeSaturation(grey,w,{}),grey,'absent keys skip the math');
  for(const n of starterGrade(managed,undefined,()=>'s'))assert.ok(!Object.keys(n.parameters).some(k=>k in rangeDefaults),'new grades store no range keys, so builds without them still render them');
  // (ws,wm,wh) = (1,0,0) (.5,.5,0) (0,1,0) (0,.5,.5) (0,0,1) at luma 0 .25 .5 .75 1; beyond 0..1 the weights clamp and the pivot does not.
  for(const [y,ws,wm,wh] of [[0,1,0,0],[.25,.5,.5,0],[.5,0,1,0],[.75,0,.5,.5],[1,0,0,1],[1.3,0,0,1],[-.1,1,0,0]]){
    const chroma=[.1,-.1*w[0]/w[1],0],out=rangeSaturation(chroma.map(c=>y+c),w,range),f=1+ws*.5-wm*.5+wh*2;
    out.forEach((v,c)=>near(v,y+chroma[c]*f,`luma ${y} channel ${c}`));near(w[0]*out[0]+w[1]*out[1]+w[2]*out[2],y,`luma ${y} kept`);
  }
  const expect=(rgb:number[],weights:number[],ranges=[.5,-.5,2])=>{
    const y=weights[0]*rgb[0]+weights[1]*rgb[1]+weights[2]*rgb[2],t=(a:number,b:number)=>{const x=Math.max(0,Math.min(1,(y-a)/(b-a)));return x*x*(3-2*x);},ws=1-t(0,.5),wh=t(.5,1),f=1+ws*ranges[0]+(1-ws-wh)*ranges[1]+wh*ranges[2];
    return rgb.map(v=>Math.max(0,Math.min(1,y+(v-y)*f)));
  };
  for(const rgb of colors){
    // Legacy pivots on Rec.709 luma, before warm/tint; nodes-v2 on the stage gamut's luma (Rec.2020 here).
    colorTransform(legacy,undefined,[node(range)])(rgb).forEach((v,c)=>near(v,expect(rgb,w)[c],'legacy'));
    colorTransform(legacy,undefined,[node({...range,temperature:2000})])(rgb).forEach((v,c)=>near(v,Math.min(1,expect(rgb,w)[c]*[1.2,1,.8][c]),'legacy warm after range'));
    colorTransform(managed,undefined,[node(range)])(rgb).forEach((v,c)=>near(v,expect(rgb,luminanceWeights('Rec.2020'))[c],'nodes-v2',1e-9));
  }
  for(const v of [-1,401,NaN])assert.throws(()=>colorStages(legacy,[node({saturationMidtones:v})]),/saturationMidtones is outside/);
  assert.doesNotThrow(()=>colorStages(legacy,[node({saturationShadows:0,saturationHighlights:400})]));
  // The shader reads texel 8 of a correction row as factor − 1 (0 = identity) and runs the same formula on it.
  for(const clip of [legacy,managed]){
    const stages=processingStages(clip,[node(range),{...node(base),id:'m',order:2}]),{data}=packStages(clip,stages,[]);
    assert.deepEqual([...data.slice(32,35)],[.5,-.5,2]);assert.deepEqual([...data.slice(STAGE_TEXELS*4+32,STAGE_TEXELS*4+35)],[0,0,0],'a node without the keys packs identity');
    const weights=clip===legacy?w:[...data.slice(44,47)];
    for(const rgb of colors)expect(rgb,weights,[...data.slice(32,35)]).forEach((v,c)=>near(v,colorTransform(clip,undefined,[node(range)])(rgb)[c],'packed row drives the same pixels',1e-6));
  }
});

test('preview packing of the v3 tools: flags skip identity exactly where the CPU does; values and curve rows follow grading.ts',async()=>{
  const {packStages,STAGE_TEXELS,CURVE_ROWS}=await import('./colorPreview.ts'),{PARAM,sampleHueCurve}=await import('./grading.ts'),{luminanceWeights}=await import('./color.ts');
  const S=STAGE_TEXELS*4,texel=(data:Float32Array,stage:number,t:number)=>[...data.slice(stage*S+t*4,stage*S+t*4+4)],near=(a:number[],b:number[],m:string)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-6,`${m}[${i}]: ${v} vs ${b[i]}`));
  const managed={id:'k',properties:{colorPipeline:'nodes-v2',inputProfile:'DaVinci Intermediate',inputGamut:'DaVinci Wide Gamut'}} as unknown as Clip,legacy={id:'k',properties:{}} as Clip;
  const curve=(points:[number,number][])=>({mode:'smooth' as const,points:points.map(([x,y],i)=>({id:'p'+i,x,y}))});
  const tools={logShadow:.02,logShadowB:.01,logMidR:-.03,logHighlight:.04,logLowRange:.3,shadows:50,highlights:-40,hue:30,boost:20,density:40,mixRG:.2,mixMono:1,qualOn:1,qualInvert:1,qualHue:120,circOn:1,circAngle:90,rectOn:1,rectW:.5,rectH:.2,rectRound:.5,gradOn:1,gradInvert:1,gradAngle:30};
  const hue=curve([[0,.6],[.4,.3],[1,.6]]),lum=curve([[0,.3],[1,.7]]),lut={id:'l',type:'lut' as const,enabled:true,name:'L',amount:1,inputGamma:'Linear',inputGamut:'Rec.709',cube:{size:2,data:[0,0,0,1,0,0,0,1,0,1,1,0,0,0,1,1,0,1,0,1,1,1,1,1],min:[0,0,0],max:[1,1,1]}};
  const nodes=[{id:'a',clipId:'k',enabled:true,order:1,name:'All',parameters:tools,curves:{HueSat:hue,LumSat:lum},effects:[lut]},{id:'b',clipId:'k',enabled:true,order:2,name:'Plain',parameters:{exposure:.1,filmGrain:20}}] as unknown as GradeNode[];
  for(const clip of [managed,legacy]){
    const stages=processingStages(clip,nodes),{data,curveData}=packStages(clip,stages,[]),w=clip===legacy?[.2126,.7152,.0722]:luminanceWeights('DaVinci Wide Gamut');
    assert.deepEqual(stages.map(s=>s.type),['correction','lut','correction','film']);
    assert.equal(texel(data,0,7)[2],1|2|4|8|16,'every tool on');assert.equal(texel(data,2,7)[2],0,'a plain node skips every v3 step');
    assert.deepEqual([texel(data,0,12)[3],texel(data,1,12)[3],texel(data,2,12)[3]],[1+4,2+4,1+2],'the LUT ends the keyed node and carries the key bit');
    assert.equal(texel(data,3,7)[0],3,'film rows are skipped by the stage loop');
    near(texel(data,0,11).slice(0,3),w,'stage weights');
    near([...texel(data,0,13),...texel(data,0,14),...texel(data,0,15)],[.02,.02,.03,.3,-.03,0,0,PARAM.logHighRange.initial,.04,.04,.04,0],'log wheels: master + channel, ranges');
    near(texel(data,0,16),[1,-.8,Math.cos(Math.PI/6),Math.sin(Math.PI/6)],'tone gains (negative highlights double) and hue rotation');
    near(texel(data,0,17),[.2,.08,Math.atan2(.5,-w[0]/(2*(1-w[2]))),2|8],'boost, density, hue of red, HSL curve mask');
    near([...texel(data,0,18),...texel(data,0,19),...texel(data,0,20)],[1,.2,0,1,0,1,0,0,0,0,1,0],'mixer rows, monochrome');
    near(texel(data,0,21),[2,120,360,20],'qualifier on + inverted, defaults filled');
    near([...texel(data,0,24),...texel(data,0,25)],[1,.5,.5,.1,.3,.3,Math.cos(Math.PI/2),1],'circle');
    near([...texel(data,0,26),...texel(data,0,27)],[1,.5,.5,.05,.25,.1,1,0],'rectangle half sizes');
    near([...texel(data,0,28),...texel(data,0,29)],[.05,2,.5,.5,.5,Math.cos(Math.PI/6),.3,0],'round radius, gradient inverted');
    const row=(stage:number,c:number,x:number)=>curveData[(stage*CURVE_ROWS+c)*1024+x];
    for(const x of [0,100,511,1022,1023]){
      assert.ok(Math.abs(row(0,5,x)-sampleHueCurve(x/1023,hue))<1e-6,'Hue vs Sat samples the periodic curve');assert.ok(Math.abs(row(0,7,x)-lum.points[0].y-(lum.points[1].y-lum.points[0].y)*x/1023)<1e-3,'Lum vs Sat');
      assert.ok(Math.abs(row(0,0,x)-x/1023)<1e-6,'custom curves stay identity');assert.equal(row(0,4,x),0,'an absent HSL curve leaves its row unused');
    }
    assert.ok(Math.abs(row(0,5,1023)-row(0,5,0))<1e-6,'the hue row wraps');
  }
});

const colorPython=process.env.FRAME_LINE_COLOR_PYTHON||venvPython('.venv-color');
test('the export worker (color-render.py) grades range saturation like colorTransform, legacy and nodes-v2',{skip:!existsSync(colorPython)&&'the colour worker (npm run setup:color) is not installed'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'frameline-range-saturation-')),job=join(dir,'job.json'),colors=Array.from({length:64},(_,i)=>[i/63,(i*37%64)/63,(i*11%64)/63]);
  // Planar G,B,R floats in and out, as the export decoder feeds the worker.
  const planar=new Float32Array(colors.length*3);colors.forEach((rgb,i)=>[1,2,0].forEach((c,p)=>{planar[p*colors.length+i]=rgb[c];}));
  try{
    for(const clip of [{id:'r',properties:{}},{id:'r',properties:{colorPipeline:'nodes-v2',inputProfile:'Linear',inputGamut:'Rec.2020'}}] as unknown as Clip[]){
      const nodes=[{id:'n',projectId:'p',kind:'serial',clipId:'r',enabled:true,order:1,name:'Range',parameters:{saturation:110,temperature:300,saturationShadows:60,saturationMidtones:130,saturationHighlights:80}} as GradeNode];
      writeFileSync(job,JSON.stringify({width:colors.length,height:1,stages:processingStages(clip,nodes),managed:clip.properties.colorPipeline==='nodes-v2'}));
      const out=execFileSync(colorPython,[fileURLToPath(new URL('../../scripts/color-render.py',import.meta.url)),job,'--stream'],{input:Buffer.from(planar.buffer),stdio:['pipe','pipe','ignore']});
      const data=new Float32Array(out.buffer,out.byteOffset,out.byteLength/4),cpu=colorTransform(clip,undefined,nodes);
      colors.forEach((rgb,i)=>cpu(rgb).forEach((v,c)=>{const py=Math.min(1,Math.max(0,data[[2,0,1][c]*colors.length+i]));assert.ok(Math.abs(v-py)<1e-5,`${clip.properties.colorPipeline??'legacy'} ${rgb} channel ${c}: ${v} vs ${py}`);}));
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});

// Apple Log Profile white paper (2023): R0, Rt, c, β, γ, δ; P on the video-range scale (code 64 → 0, 940 → 1).
const AL={R0:-.05641088,Rt:.01,c:47.28711236,b:.00964052,g:.08550479,d:.69336945},alP=(v:number)=>(v*1023-64)/876,alCode=(P:number)=>(P*876+64)/1023;
test('Apple Log: the white paper curve on the video-range scale, grey .18 at P .488, monotonic and invertible past both ends',()=>{
  const near=(a:number,b:number,m:string,e=1e-9)=>assert.ok(Math.abs(a-b)<=e*Math.max(1,Math.abs(b)),`${m}: ${a} vs ${b}`);
  near(alP(encodeLog(.18,'Apple Log')),AL.g*Math.log2(.18+AL.b)+AL.d,'grey on the log segment');assert.ok(Math.abs(alP(encodeLog(.18,'Apple Log'))-.488)<5e-4,'18% grey at P .488');
  near(decodeLog(alCode(AL.c*AL.R0**2),'Apple Log'),0,'black at P = c·R0²');assert.ok(Math.abs(encodeLog(0,'Apple Log')*1023-195.8)<.1,'black is code 196');
  for(const R of [AL.R0,-.02,0,.004,.0099])near(alP(encodeLog(R,'Apple Log')),AL.c*(R-AL.R0)**2,`square segment ${R}`);
  for(const R of [.01,.18,1,10])near(alP(encodeLog(R,'Apple Log')),AL.g*Math.log2(R+AL.b)+AL.d,`log segment ${R}`);
  near(decodeLog(alCode(.2085553159546),'Apple Log'),AL.Rt,'the segments meet at Pt = c·(Rt−R0)²',1e-8);
  // Every 10-bit code and well past both ends (footroom below code 64 mirrors the square segment): finite, rising, back where it came from.
  let last=-Infinity;for(let code=-200;code<=1300;code++){const v=code/1023,r=decodeLog(v,'Apple Log');assert.ok(Number.isFinite(r)&&r>last,`rises at code ${code}`);near(encodeLog(r,'Apple Log'),v,`code ${code} round trip`,1e-8);last=r;}
  assert.deepEqual(interpretation({properties:{}} as unknown as Clip,{inputProfile:'Apple Log'} as MediaAsset),{profile:'Apple Log',gamut:'Rec.2020'},'Apple Log defaults to Rec.2020');
  assert.doesNotThrow(()=>validateGradeNode({effects:[defaultCST('in','Apple Log','Rec.2020'),defaultCST('out','DaVinci Intermediate','DaVinci Wide Gamut','Apple Log','Rec.2020'),{id:'lut',type:'lut',enabled:true,name:'Phone LUT',amount:1,inputGamma:'Apple Log',inputGamut:'Rec.2020',cube:{size:2,data:Array(24).fill(.5),min:[0,0,0],max:[1,1,1]}}]}),'the save check takes Apple Log nodes');
  // A wide-gamut grade from Apple Log puts 18% grey where one from S-Log3 does: each Input CST lands it on DaVinci Intermediate .336.
  let id=0;const grade=(inputProfile:string,inputGamut:string)=>{const clip={id:'g',projectId:'p',properties:{colorPipeline:'nodes-v2',inputProfile,inputGamut}} as unknown as Clip;return colorTransform(clip,undefined,starterGrade(clip,undefined,()=>String(++id)))([.18,.18,.18].map(v=>encodeLog(v,inputProfile)));};
  grade('Apple Log','Rec.2020').forEach((v,c)=>near(v,grade('S-Log3','S-Gamut3.Cine')[c],'grey through the starter grade',1e-6));
});

test('the preview shader transfers every profile like decodeLog/encodeLog (Apple Log at index 10)',async()=>{
  const {TRANSFER}=await import('./colorPreview.ts');
  // The two GLSL functions run as JavaScript: the same statements, GLSL's built-ins mapped to Math.
  const glsl=(name:string)=>new Function('v','profile',`const pow=Math.pow,exp2=x=>2**x,log2=Math.log2,log=Math.log,sign=Math.sign,abs=Math.abs,sqrt=Math.sqrt,max=Math.max;${TRANSFER.split(`float ${name}(float v, int profile) {`)[1].split('\n  }')[0].replace(/\bfloat /g,'let ')}`) as (v:number,profile:number)=>number;
  const [decode,encode]=[glsl('decode'),glsl('encode')],near=(a:number,b:number,m:string)=>assert.ok(Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b)),`${m}: ${a} vs ${b}`);
  assert.equal(profiles.indexOf('Apple Log'),10);
  profiles.forEach((profile,p)=>{
    for(const v of [-.05,0,.03,.1,.17,.19,.2,.25,.4,.6,.9,1,1.08])near(decode(v,p),decodeLog(v,profile),`${profile} decode ${v}`);
    for(const r of [-.03,0,.001,.0099,.01,.05,.18,1,6,30])near(encode(r,p),encodeLog(r,profile),`${profile} encode ${r}`);
  });
});

test('Apple Log decodes like OpenColorIO\'s ACES input transform (P = (code − 64)/876, Rec.2020 into ACES2065-1)',{skip:!existsSync(colorPython)&&'the colour worker (npm run setup:color) is not installed'},()=>{
  const samples=[[0,0,0],[.1505,.1505,.1505],[.2,.21,.2085],[.488,.3,.6],[.8,.5,.25],[1,.6,.1],[1.09,1,.9]];
  const script="import json,sys,PyOpenColorIO as o\np=o.Config.CreateFromBuiltinConfig('studio-config-v4.0.0_aces-v2.0_ocio-v2.5').getProcessor('Apple Log','ACES2065-1').getDefaultCPUProcessor()\nprint(json.dumps([p.applyRGB(s) for s in json.loads(sys.argv[1])]))";
  const ocio=JSON.parse(execFileSync(colorPython,['-c',script,JSON.stringify(samples)]).toString()) as number[][];
  samples.forEach((P,i)=>{
    const linear=P.map(x=>decodeLog(alCode(x),'Apple Log')),ours=acesMatrices['Rec.2020'].map(row=>row.reduce((s,k,c)=>s+k*linear[c],0)),scale=Math.max(...ours.map(Math.abs));
    // OCIO samples the curve through a half-float 1D table, so it agrees to about 1e-5 of the signal.
    ours.forEach((v,c)=>assert.ok(Math.abs(v-ocio[i][c])<=1e-6+2e-5*scale,`P ${P} channel ${c}: ${v} vs OCIO ${ocio[i][c]}`));
  });
});
