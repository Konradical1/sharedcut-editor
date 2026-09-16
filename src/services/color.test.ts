import test from 'node:test';
import assert from 'node:assert/strict';
import { colorTransform, decodeLog, makeCube, cubeText, parseCube, sampleCube } from './color.ts';
import { timecode } from './timecode.ts';
import type { Clip, GradeNode } from '../state/models.ts';

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
  for(const [profile,a,b,c] of [['Canon Log',.529136,.0730597,10.1596],['Canon Log 2',.281863093,.035388128,87.09937546]] as const)assert.ok(Math.abs(decodeLog(a*Math.log10(c*.18/.9+1)+b,profile)-.18)<1e-9);
  assert.ok(Math.abs(decodeLog(.42889912*Math.log10(14.98325*.18/.9+1)+.069886632,'Canon Log 3')-.18)<1e-9);
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
  for(const profile of ['S-Log','S-Log2','S-Log3','Canon Log','Canon Log 2','Canon Log 3','DaVinci Intermediate','Gamma 2.4','Linear'])for(const v of [-.01,0,.002,.18,1,5,20])assert.ok(Math.abs(decodeLog(encodeLog(v,profile),profile)-v)<2e-5,`${profile}: ${v}`);
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
