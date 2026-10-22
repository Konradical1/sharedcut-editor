import { nodeMaskId, validateNodeMask } from './smartMask.ts';
import type { Clip, GradeNode, MediaAsset, ColorCurve, ColorEffect, ColorTransformEffect } from '../state/models.ts';
import { acesMatrices } from './aces.generated.ts';
import { gradeValues } from './grade.ts';
import { identityCurve, curveSlope, sampleCurve, tonal, chroma, hslCurves, mixer, qualifierAlpha, hasWindow, hasQualifier, filmActive, filmParams, validateGradeParameters, V3_KEYS, CURVE_KEYS, HUE_CURVES } from './grading.ts';
export { identityCurve, curveSlope, sampleCurve };

export const profiles = ['Rec.709', 'S-Log3', 'Canon Log', 'Canon Log 2', 'Canon Log 3', 'S-Log2', 'S-Log', 'DaVinci Intermediate', 'Linear', 'Gamma 2.4'] as const;
export const gamuts = ['Rec.709', 'S-Gamut3.Cine', 'S-Gamut3', 'Cinema Gamut', 'Rec.2020', 'DaVinci Wide Gamut', 'S-Gamut'] as const;
export type Cube = { size: number; data: Float32Array; min: number[]; max: number[] };
const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
/** Legacy (Gamma 2.4 / Rec.709) nodes grade on these luma weights. */
const W709 = [.2126, .7152, .0722];

/** Normalized full-range RGB after YCbCr decoding (v = code/1023). Canon curves are IRE formulas; Canon places 0 IRE at code 64 and 100 IRE at 940 in every container, so black sits at 128/1023 (ACES IDT convention), reflection scale. */
export function decodeLog(v: number, profile: string): number {
  if (profile === 'Linear') return v;
  if (profile === 'DaVinci Intermediate') return v > .02740668 ? 2 ** (v / .07329248 - 7) - .0075 : v / 10.44426855;
  // Sony code values (64–940 nominal scale), reflection exposure; see color-overhaul references.
  if (profile === 'S-Log' || profile === 'S-Log2') { const x=(v*1023-64)/876; return (x>=.030001222851889303?10**((x-.646596)/.432699)-.037584:(x-.030001222851889303)/5)*.9*(profile==='S-Log2'?219/155:1); }
  if (profile === 'Gamma 2.4') return Math.sign(v)*Math.abs(v)**2.4;
  if (profile === 'S-Log3') return v >= 171.2102946929 / 1023 ? 10 ** ((v * 1023 - 420) / 261.5) * .19 - .01 : (v * 1023 - 95) * .01125 / (171.2102946929 - 95);
  if (profile === 'Canon Log' || profile === 'Canon Log 2') {
    const [a, b, c] = profile === 'Canon Log' ? [.529136, .0730597, 10.1596] : [.281863093, .035388128, 87.09937546], ire = (v * 1023 - 64) / 876;
    return Math.sign(ire - b) * (10 ** (Math.abs(ire - b) / a) - 1) / c * .9;
  }
  if (profile === 'Canon Log 3') { const ire = (v * 1023 - 64) / 876; return .9 * (ire < .04076162 ? -(10 ** ((.07623209 - ire) / .42889912) - 1) / 14.98325 : ire <= .105357102 ? (ire - .073059361) / 2.3069815 : (10 ** ((ire - .069886632) / .42889912) - 1) / 14.98325); }
  if (profile !== 'Rec.709') throw new Error(`Unsupported input profile: ${profile}`);
  return Math.max(0, v) ** 2.4;
}
export function encodeLog(v: number, profile: string): number {
  if(profile==='Linear')return v;
  if(profile==='DaVinci Intermediate')return v>.00262409?(Math.log2(v+.0075)+7)*.07329248:v*10.44426855;
  if(profile==='S-Log'||profile==='S-Log2'){const x=v/.9*(profile==='S-Log2'?155/219:1);return ((x>=0?.432699*Math.log10(x+.037584)+.646596:x*5+.030001222851889303)*876+64)/1023;}
  if(profile==='Gamma 2.4')return Math.sign(v)*Math.abs(v)**(1/2.4);
  if(profile==='S-Log3')return v>=.01125?(420+Math.log10((v+.01)/.19)*261.5)/1023:(v*(171.2102946929-95)/.01125+95)/1023;
  if(profile==='Canon Log'||profile==='Canon Log 2'){
    const [a,b,c]=profile==='Canon Log'?[.529136,.0730597,10.1596]:[.281863093,.035388128,87.09937546];
    return ((Math.sign(v)*a*Math.log10(c*Math.abs(v)/.9+1)+b)*876+64)/1023;
  }
  if(profile==='Canon Log 3'){const x=v/.9,ire=x<-.014?-.42889912*Math.log10(-x*14.98325+1)+.07623209:x<=.014?2.3069815*x+.073059361:.42889912*Math.log10(x*14.98325+1)+.069886632;return (ire*876+64)/1023;}
  if(profile!=='Rec.709')throw new Error(`Unsupported input profile: ${profile}`);
  return Math.max(0,v)**(1/2.4);
}
const primaries: Record<string, number[][]> = {
  'Rec.709': [[.64,.33],[.3,.6],[.15,.06]], 'Rec.2020': [[.708,.292],[.17,.797],[.131,.046]],
  'S-Gamut3.Cine': [[.766,.275],[.225,.8],[.089,-.087]], 'S-Gamut3': [[.73,.28],[.14,.855],[.1,-.05]],
  'DaVinci Wide Gamut': [[.8,.313],[.1682,.9877],[.079,-.1155]],
  'S-Gamut': [[.73,.28],[.14,.855],[.1,-.05]],
  'Cinema Gamut': [[.74,.27],[.17,1.14],[.08,-.1]],
};
function inverse(m: number[][]) {
  const [[a,b,c],[d,e,f],[g,h,i]] = m, det = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  return [[e*i-f*h,c*h-b*i,b*f-c*e],[f*g-d*i,a*i-c*g,c*d-a*f],[d*h-e*g,b*g-a*h,a*e-b*d]].map(row=>row.map(x=>x/det));
}
const multiply = (m: number[][], v: number[]) => m.map(row=>row.reduce((sum,x,i)=>sum+x*v[i],0));
function rgbToXYZ(name: string) {
  const p = primaries[name]; if (!p) throw new Error(`Unsupported input gamut: ${name}`);
  const m = [0,1,2].map(i=>p.map(([x,y])=>[x/y,1,(1-x-y)/y][i]));
  const s = multiply(inverse(m), [.3127/.329, 1, (1-.3127-.329)/.329]);
  return m.map(row=>row.map((v,i)=>v*s[i]));
}
const to709 = inverse(rgbToXYZ('Rec.709'));
export function gamutTo709(gamut:string){const source=rgbToXYZ(gamut);return to709.map(row=>[0,1,2].map(c=>row.reduce((v,x,i)=>v+x*source[i][c],0)));}
/** Fixed log-to-Rec.709 view with a hue-preserving shoulder, for analysis that needs a display-referred picture (Smart Mask). The viewer never applies it. */
export function logView(profile:string,gamut:string){
  const matrix=gamutTo709(gamut);
  return (input:number[])=>{
    if(profile==='Rec.709')return input;
    const rgb=multiply(matrix,input.map(v=>decodeLog(v,profile))), peak=Math.max(...rgb,0), mapped=peak<=.6?peak:.6+.4*(1-Math.exp(-(peak-.6)/.4));
    return rgb.map(v=>clamp(Math.max(0,v*(peak?mapped/peak:1))**(1/2.4)));
  };
}
export function interpretation(clip: Clip, asset?: MediaAsset) {
  const profile = String(clip.properties.inputProfile ?? asset?.inputProfile ?? 'Rec.709');
  const gamut = String(clip.properties.inputGamut ?? asset?.inputGamut ?? (profile === 'S-Log3' ? 'S-Gamut3.Cine' : profile==='S-Log'||profile==='S-Log2' ? 'S-Gamut' : profile==='DaVinci Intermediate' ? 'DaVinci Wide Gamut' : profile.startsWith('Canon') ? 'Cinema Gamut' : 'Rec.709'));
  if (!(profiles as readonly string[]).includes(profile) || !(gamuts as readonly string[]).includes(gamut)) throw new Error('Choose a supported input profile and gamut.');
  return { profile, gamut };
}
export function parseCube(text: string): Cube {
  if (text.length > 32 * 1024 * 1024) throw new Error('LUT exceeds 32 MB.');
  let size = 0, min = [0,0,0], max = [1,1,1]; const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim(); if (!line || line.startsWith('TITLE')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'LUT_3D_SIZE') { size=Number(rest[0]); if (!Number.isInteger(size) || size<2 || size>65) throw new Error('Use a 3D LUT with 2–65 samples per axis.'); }
    else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') { const row=rest.map(Number); if (row.length!==3 || row.some(v=>!Number.isFinite(v))) throw new Error('Invalid LUT domain.'); if(key==='DOMAIN_MIN') min=row; else max=row; }
    else { const row=line.split(/\s+/).map(Number); if(row.length!==3 || row.some(v=>!Number.isFinite(v) || Math.abs(v)>1e4)) throw new Error('Invalid or unsupported LUT data.'); values.push(...row); }
  }
  if (!size || values.length !== size**3*3 || max.some((v,i)=>v<=min[i])) throw new Error('Incomplete LUT data.');
  return {size,data:new Float32Array(values),min,max};
}
export function sampleCube(cube: Cube, rgb: number[]): number[] {
  const n=cube.size, p=rgb.map((v,i)=>clamp((v-cube.min[i])/(cube.max[i]-cube.min[i]))*(n-1)), lo=p.map(v=>Math.min(n-2,Math.floor(v))), f=p.map((v,i)=>v-lo[i]), out=[0,0,0];
  for(let b=0;b<2;b++)for(let g=0;g<2;g++)for(let r=0;r<2;r++) {
    const weight=(r?f[0]:1-f[0])*(g?f[1]:1-f[1])*(b?f[2]:1-f[2]), index=((lo[2]+b)*n*n+(lo[1]+g)*n+lo[0]+r)*3;
    for(let c=0;c<3;c++) out[c]+=cube.data[index+c]*weight;
  }
  return out;
}
export function curveValue(v: number, p: Record<string,number>) {
  const x=clamp(v)*4, i=Math.min(3,Math.floor(x)), points=[0,p.curve25??.25,p.curve50??.5,p.curve75??.75,1];
  return points[i]+(points[i+1]-points[i])*(x-i);
}
const smoothstep=(a:number,b:number,x:number)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
/** Saturation by luma range (saturationShadows/Midtones/Highlights, percent, 100 = unchanged) after a node's saturation. Shadows fade out by luma .5, highlights fade in from .5; it pivots on the unclamped luma, as saturation does. */
export function rangeSaturation(rgb:number[],weights:number[],p:Record<string,number>){
  const s=(p.saturationShadows??100)/100-1,m=(p.saturationMidtones??100)/100-1,h=(p.saturationHighlights??100)/100-1;
  if(!s&&!m&&!h)return rgb;
  const y=weights[0]*rgb[0]+weights[1]*rgb[1]+weights[2]*rgb[2],ws=1-smoothstep(0,.5,y),wh=smoothstep(.5,1,y),f=1+ws*s+(1-ws-wh)*m+wh*h;
  return rgb.map(v=>y+(v-y)*f);
}
export function colorStages(clip: Clip, nodes: GradeNode[]) {
  const enabled=nodes.filter(n=>n.enabled && n.clipId===clip.id).sort((a,b)=>(a.order??0)-(b.order??0));
  return enabled.map(node=>{
    const extra=Object.fromEntries(Object.entries(node.parameters).filter(([k])=>/^(lift|gamma|gain|offset)[RGB]$|^curve(25|50|75)$|^saturation(Shadows|Midtones|Highlights)$/.test(k)||V3_KEYS.has(k)));
    const g=gradeValues([{...node,parameters:Object.fromEntries(Object.entries(node.parameters).filter(([k])=>!(k in extra)))}]);
    const limits:Record<string,number>={exposure:16,contrast:8,pivot:2,saturation:4,temperature:10000,tint:200,lift:4,gamma:8,gain:8,offset:4};
    for(const [k,v] of Object.entries(g))if(!Number.isFinite(v)||Math.abs(v)>limits[k])throw new Error(`${node.name}: ${k} is outside the supported range.`);
    validateGradeParameters(node.name,extra);
    for(const [k,v] of Object.entries(extra)){if(V3_KEYS.has(k))continue;const [min,max]=k.startsWith('curve')?[0,1]:k.startsWith('saturation')?[0,400]:[-2,2];if(!Number.isFinite(v)||v<min||v>max)throw new Error(`${node.name}: ${k} is outside the supported range.`);}
    return {g,extra,node};
  });
}
export function colorTransform(clip: Clip, asset: MediaAsset | undefined, nodes: GradeNode[], base?: Cube, maskAt?: (id:string)=>number) {
  const {profile}=interpretation(clip,asset);
  if(clip.properties.colorPipeline==='nodes-v2') return managedColorTransform(clip,asset,nodes,maskAt);
  const stages=processingStages(clip,nodes);
  return (input: number[]): number[] => {
    let rgb=input;
    const stops=Number(clip.properties.inputExposure??0), temperature=Number(clip.properties.inputTemperature??0);
    if(!Number.isFinite(stops)||Math.abs(stops)>8||!Number.isFinite(temperature)||Math.abs(temperature)>2000)throw new Error('Camera exposure or white balance is out of range.');
    if(stops||temperature)rgb=rgb.map((v,c)=>encodeLog(decodeLog(v,profile)*2**stops*[1+temperature/10000,1,1-temperature/10000][c],profile));
    // Ungraded footage is shown as recorded, log included; a grade or an imported look does the converting.
    if(base && clip.properties.bypassResolveLook!==true) rgb=sampleCube(base,rgb);
    let nodeInput=rgb,keyed=1;
    for(const stage of stages) {
      if(stage.type==='film')continue;
      if(stage.nodeStart){nodeInput=rgb;keyed=stage.type==='correction'?qualifierAlpha(rgb,W709,stage.extra):1;}
      if(stage.type==='cst'){rgb=transformSpace(rgb,stage.effect);continue;}
      if(stage.type==='lut'){rgb=blendNode(applyLut(rgb,stage.effect),nodeInput,stage,maskAt,keyed);continue;}
      const {g,extra:p,node}=stage;
      rgb=rgb.map((value,c)=>{
        const channel='RGB'[c], v=Math.max(0,value*2**g.exposure);
        return Math.max(0,(v-g.pivot)*g.contrast+g.pivot+g.offset+(p['offset'+channel]??0))**(1/2**(g.gamma+(p['gamma'+channel]??0)))*(g.gain+(p['gain'+channel]??0))+(g.lift+(p['lift'+channel]??0))*(1-Math.min(1,v));
      });
      rgb=tonal(rgb,W709,p,g.pivot);
      const y=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2], warm=clamp(g.temperature/10000,-.5,.5), tint=clamp(g.tint/200,-.5,.5);
      rgb=chroma(rangeSaturation(rgb.map(v=>y+(v-y)*g.saturation),W709,p),W709,p).map((v,c)=>v*[1+warm,1-tint,1-warm][c]);
      if(node.curves)rgb=applyCurves(rgb,node);
      else if(Object.keys(p).some(k=>k.startsWith('curve'))) rgb=rgb.map(v=>curveValue(v,p));
      rgb=blendNode(mixer(hslCurves(rgb,W709,node.curves),p),nodeInput,stage,maskAt,keyed);
    }
    return rgb.map(v=>clamp(v));
  };
}
export function makeCube(transform: (rgb:number[])=>number[], size=33): Cube {
  const data=new Float32Array(size**3*3); let index=0;
  for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++) { const rgb=transform([r/(size-1),g/(size-1),b/(size-1)]); for(const v of rgb)data[index++]=v; }
  return {size,data,min:[0,0,0],max:[1,1,1]};
}
export function cubeText(cube: Cube) {
  const lines=[`LUT_3D_SIZE ${cube.size}`,'DOMAIN_MIN 0 0 0','DOMAIN_MAX 1 1 1'];
  for(let i=0;i<cube.data.length;i+=3) lines.push(`${cube.data[i]} ${cube.data[i+1]} ${cube.data[i+2]}`);
  return lines.join('\n')+'\n';
}

export const isHdrTransfer = (transfer?: string) => transfer === 'arib-std-b67' || transfer === 'smpte2084';
/**
 * BT.2020 HLG/PQ R'G'B' to Rec.709 SDR R'G'B', the same math as FFmpeg's
 * `zscale=t=linear:npl → zscale=p=bt709 → tonemap=hable:desat=0 → zscale=t=bt709` chain, sampled
 * into a LUT so it runs on FFmpeg builds without zimg (Homebrew has none). `npl` is the nits that
 * map to linear 1.0: 100 is brighter, 203 puts HLG reference white at 1.0.
 */
export function hdrToSdr(transfer: string, npl = 100) {
  const hlg = transfer === 'arib-std-b67', matrix = gamutTo709('Rec.2020'), peak = 1000 / npl;
  const hable = (x: number) => (x*(.15*x+.05)+.004)/(x*(.15*x+.5)+.06)-.02/.3, white = hable(peak);
  const hlgScene = (v: number) => v <= .5 ? v*v/3 : (Math.exp((v-.55991073)/.17883277)+.28466892)/12;
  const pqNits = (v: number) => { const p = Math.max(0, v)**(1/78.84375); return 10000*(Math.max(p-.8359375, 0)/(18.8515625-18.6875*p))**(1/.1593017578125); };
  const oetf = (v: number) => v < .018 ? 4.5*v : 1.099*v**.45-.099;
  return (input: number[]): number[] => {
    let nits: number[];
    if (hlg) { const scene = input.map(v => hlgScene(clamp(v))), y = .2627*scene[0]+.678*scene[1]+.0593*scene[2]; nits = scene.map(v => 1000*y**.2*v); }
    else nits = input.map(pqNits);
    const linear = multiply(matrix, nits.map(v => v/npl)).map(v => Math.max(0, v)), signal = Math.max(...linear, 1e-6);
    const scale = hable(signal)/white/signal;
    return linear.map(v => clamp(oetf(clamp(v*scale))));
  };
}

export const transferFunctions = profiles.filter(p=>p!=='Rec.709');
export const primaryDefaults:Record<string,number>={exposure:0,temperature:0,tint:0,contrast:1,pivot:.336043,saturation:100,lift:0,gamma:0,gain:1,offset:0};
// Kept out of primaryDefaults so only nodes that use them store them: absent = identity, and builds before range saturation refuse to render a node carrying them.
export const rangeDefaults:Record<string,number>={saturationShadows:100,saturationMidtones:100,saturationHighlights:100};
export function gamutMatrix(input:string,output:string){const source=rgbToXYZ(input),target=inverse(rgbToXYZ(output));return target.map(row=>[0,1,2].map(c=>row.reduce((v,x,i)=>v+x*source[i][c],0)));}
// OCIO camera transforms include their reference chromatic adaptation to ACES D60.
// Legacy D65-only CSTs retain their original matrix for existing saved grades.
function acesGamutMatrix(input:string,output:string){
  const multiplyMatrix=(a:number[][],b:number[][])=>a.map(row=>[0,1,2].map(c=>row.reduce((v,x,i)=>v+x*b[i][c],0)));
  const toACES=(name:string)=>acesMatrices[name]??multiplyMatrix(acesMatrices['Rec.709'],gamutMatrix(name,'Rec.709'));
  return multiplyMatrix(inverse(toACES(output)),toACES(input));
}
export function luminanceWeights(gamut:string){return rgbToXYZ(gamut)[1];}
export function defaultCST(id:string,inputGamma='S-Log3',inputGamut='S-Gamut3.Cine',outputGamma='DaVinci Intermediate',outputGamut='DaVinci Wide Gamut'):ColorTransformEffect {
  return {id,type:'cst',enabled:true,inputGamma,inputGamut,outputGamma,outputGamut,toneMapping:'none',gamutMapping:'none'};
}
export function starterGrade(clip:Clip,asset:MediaAsset|undefined,id:()=>string):GradeNode[]{
  const {profile,gamut}=interpretation(clip,asset);
  return ['Input CST','Balance','Look','Output CST'].map((name,i)=>({id:id(),clipId:clip.id,projectId:clip.projectId,name,kind:'serial',enabled:true,order:i+1,position:{x:60+i*170,y:80},parameters:{...primaryDefaults},effects:i===0?[defaultCST(id(),profile,gamut)]:i===3?[{...defaultCST(id(),'DaVinci Intermediate','DaVinci Wide Gamut','Gamma 2.4','Rec.709'),toneMapping:'shoulder',gamutMapping:'compress'}]:[]}));
}
/** A nodes-v2 grade whose display output still clips highlights, and that node's effects with ACES 2 output instead. */
export function acesOutputUpgrade(clip:Clip,nodes:GradeNode[]):{node:GradeNode;effects:ColorEffect[]}|undefined{
  if(clip.properties.colorPipeline!=='nodes-v2')return;
  const own=nodes.filter(n=>n.clipId===clip.id).sort((a,b)=>(a.order??0)-(b.order??0)),input=own.filter(n=>n.enabled).flatMap(n=>n.effects??[]).find(e=>e.enabled&&e.type==='cst');
  // A log input that ends in a technical Rec.709 conversion hard-clips everything above scene linear 1.0.
  const log=input?.type==='cst'&&!['Rec.709','Gamma 2.4'].includes(input.inputGamma);
  const unmapped=(e:ColorEffect)=>e.enabled&&e.type==='cst'&&e.outputGamma==='Gamma 2.4'&&e.outputGamut==='Rec.709'&&(e.toneMapping==='shoulder'||e.toneMapping==='none'&&log);
  const node=[...own].reverse().find(n=>n.enabled&&n.effects?.some(unmapped));
  return node&&{node,effects:node.effects!.map(e=>unmapped(e)?{...e,toneMapping:'aces2' as const,gamutMapping:'none' as const}:e)};
}
function applyCurves(rgb:number[],node:GradeNode){return rgb.map((v,c)=>{const master=node.curves?.RGB,channel=node.curves?.[['R','G','B'][c] as 'R'];return channel?sampleCurve(master?sampleCurve(v,master):v,channel):master?sampleCurve(v,master):v;});}
export function validateGradeNode(node:Partial<GradeNode>){
  if(node.mask){validateNodeMask(node.mask);if(node.mask.enabled&&node.effects?.some(e=>e.enabled&&e.type==='cst'))throw Error('Keep color-space transforms on an unmasked node.');}
  if((hasWindow(node.parameters)||hasQualifier(node.parameters))&&node.effects?.some(e=>e.enabled&&e.type==='cst'))throw Error('Keep color-space transforms on a node without windows or a qualifier.');
  const finite=(v:unknown,min=-1e4,max=1e4)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  if(node.position&&(!finite(node.position.x,-1e5,1e5)||!finite(node.position.y,-1e5,1e5)))throw Error('Invalid node position.');
  if(node.order!==undefined&&!finite(node.order,-1e6,1e6))throw Error('Invalid node order.');
  if(node.group!==undefined&&(typeof node.group!=='string'||!/^cg-[A-Za-z0-9-]{1,80}$/.test(node.group)))throw Error('Invalid color group.');
  if(node.group&&node.effects?.length)throw Error('A color group node holds a grade only; put transforms and LUTs on another node.');
  if(node.curves!==undefined){
    if(!node.curves||typeof node.curves!=='object'||Array.isArray(node.curves))throw Error('Invalid curves.');
    for(const [key,curve]of Object.entries(node.curves)){
      if(!CURVE_KEYS.includes(key))throw Error(`Unknown curve "${key}": use ${CURVE_KEYS.join(', ')}.`);
      if(!curve||!['smooth','linear'].includes(curve.mode)||!Array.isArray(curve.points)||curve.points.length<2||curve.points.length>64)throw Error('Use 2–64 points per curve.');
      const ids=new Set<string>();
      curve.points.forEach((p,i)=>{if(!p||typeof p.id!=='string'||!p.id.length||p.id.length>100||ids.has(p.id)||!finite(p.x,0,1)||!finite(p.y,0,1)||i>0&&p.x-curve.points[i-1].x<.0001||p.slope!==undefined&&!finite(p.slope,-20,20))throw Error('Invalid curve point.');ids.add(p.id);});
      if(curve.points[0].x!==0||curve.points.at(-1)!.x!==1)throw Error('Curve endpoints must stay at 0 and 1.');
      if(HUE_CURVES.includes(key)&&Math.abs(curve.points[0].y-curve.points.at(-1)!.y)>1e-6)throw Error('A hue curve wraps around: its last point must have the same y as its first.');
    }
  }
  if(node.effects!==undefined){
    if(!Array.isArray(node.effects)||node.effects.length>16)throw Error('Use at most 16 effects per node.');
    const ids=new Set<string>();
    for(const e of node.effects){
      if(!e||typeof e.id!=='string'||!e.id.length||e.id.length>100||ids.has(e.id)||typeof e.enabled!=='boolean'||!['cst','lut'].includes(e.type))throw Error('Invalid node effect.');ids.add(e.id);
      if(!(profiles as readonly string[]).includes(e.inputGamma)||!(gamuts as readonly string[]).includes(e.inputGamut))throw Error('Unsupported effect input color space.');
      if(e.type==='cst'){
        if(!(profiles as readonly string[]).includes(e.outputGamma)||!(gamuts as readonly string[]).includes(e.outputGamut)||!['none','shoulder','aces2'].includes(e.toneMapping)||!['none','compress'].includes(e.gamutMapping))throw Error('Invalid color space transform.');
        if(e.toneMapping==='aces2'&&(e.outputGamma!=='Gamma 2.4'||e.outputGamut!=='Rec.709'||e.gamutMapping!=='none'))throw Error('ACES 2 output requires Rec.709 / Gamma 2.4 and includes its own gamut mapping.');
      }else{
        const c=e.cube;if(typeof e.name!=='string'||e.name.length>100||!finite(e.amount,0,1)||!c||!Number.isInteger(c.size)||c.size<2||c.size>65||!Array.isArray(c.data)||c.data.length!==c.size**3*3||c.data.some(v=>!finite(v))||!Array.isArray(c.min)||!Array.isArray(c.max)||c.min.length!==3||c.max.length!==3||c.min.some((v,i)=>!finite(v)||!finite(c.max[i])||v>=c.max[i]))throw Error('Invalid 3D LUT.');
      }
    }
  }
}
export function transformSpace(rgb:number[],effect:ColorTransformEffect,matrix=gamutMatrix(effect.inputGamut,effect.outputGamut),weights=luminanceWeights(effect.outputGamut)){
  if(effect.toneMapping==='aces2')throw Error('ACES 2 requires the OpenColorIO renderer.');
  let linear=multiply(matrix,rgb.map(v=>decodeLog(v,effect.inputGamma)));
  if(effect.toneMapping==='shoulder'){
    const peak=Math.max(...linear,0),mapped=peak<=.6?peak:.6+.4*(1-Math.exp(-(peak-.6)/.4));
    linear=linear.map(v=>v*(peak>0?mapped/peak:1));
  }
  if(effect.gamutMapping==='compress'){
    const y=clamp(multiply([weights],linear)[0]);let amount=1;
    for(const v of linear){const delta=v-y;if(delta>0)amount=Math.min(amount,(1-y)/delta);else if(delta<0)amount=Math.min(amount,-y/delta);}
    linear=linear.map(v=>y+(v-y)*amount);
  }
  return linear.map(v=>encodeLog(v,effect.outputGamma));
}
function applyLut(rgb:number[],e:Extract<ColorEffect,{type:'lut'}>){const out=sampleCube({...e.cube,data:e.cube.data as unknown as Float32Array},rgb);return rgb.map((v,c)=>v+(out[c]-v)*e.amount);}
export function processingStages(clip:Clip,nodes:GradeNode[]){
  type Correction=ReturnType<typeof colorStages>[number]&{type:'correction';gamma:string;gamut:string;weights:number[]};
  /** Film runs on whole frames after its node's blend (docs/color-grading-v3.md); `p` holds every film key. */
  type Film={type:'film';node:GradeNode;p:Record<string,number>;gamma:string;gamut:string;weights:number[]};
  type Stage=Correction|{type:'cst';node:GradeNode;effect:ColorTransformEffect;matrix:number[][];weights:number[]}|{type:'lut';node:GradeNode;effect:Extract<ColorEffect,{type:'lut'}>}|Film;
  const stages:Stage[]=[],managed=clip.properties.colorPipeline==='nodes-v2';let gamma=String(clip.properties.inputProfile||'Gamma 2.4'),gamut=String(clip.properties.inputGamut||'Rec.709');
  if(!managed){gamma='Gamma 2.4';gamut='Rec.709';}
  const weightsOf=(name:string)=>managed?luminanceWeights(name):W709;
  for(const correction of colorStages(clip,nodes)){
    validateGradeNode(correction.node);
    stages.push({...correction,type:'correction',gamma,gamut,weights:weightsOf(gamut)});
    for(const effect of correction.node.effects??[]){if(!effect.enabled)continue;
      if(effect.type==='cst'){stages.push({type:'cst',node:correction.node,effect,matrix:hasACES(nodes,clip.id)?acesGamutMatrix(effect.inputGamut,effect.outputGamut):gamutMatrix(effect.inputGamut,effect.outputGamut),weights:luminanceWeights(effect.outputGamut)});gamma=effect.outputGamma;gamut=effect.outputGamut;}
      else stages.push({type:'lut',node:correction.node,effect});
    }
    if(filmActive(correction.node.parameters))stages.push({type:'film',node:correction.node,p:filmParams(correction.node.parameters),gamma,gamut,weights:weightsOf(gamut)});
  }
  if(stages.some(s=>s.type==='cst'&&s.effect.toneMapping==='aces2')){
    if(clip.properties.colorPipeline!=='nodes-v2')throw Error('Start a wide-gamut grade before using ACES output.');
    if(gamma!=='Gamma 2.4'||gamut!=='Rec.709')throw Error('ACES SDR output must finish in Rec.709 / Gamma 2.4.');
    if(stages.filter(s=>s.type==='cst'&&s.effect.toneMapping==='aces2').length>1)throw Error('Use one ACES output transform per grade.');
  }
  // A node's start and end ignore its film stage: the blend comes before film, and film never restarts a node.
  const graded=stages.filter(s=>s.type!=='film');
  return stages.map(stage=>{if(stage.type==='film')return {...stage,nodeStart:false,nodeEnd:false};const i=graded.indexOf(stage);return {...stage,nodeStart:i===0||graded[i-1].node!==stage.node,nodeEnd:i===graded.length-1||graded[i+1].node!==stage.node};});
}
/** The node's output blended over its input by mask × windows × qualifier (`keyed`, from the node input). */
function blendNode(rgb:number[],input:number[],stage:{node:GradeNode;nodeEnd:boolean},maskAt?: (id:string)=>number,keyed=1){
  const node=stage.node,mask=node.mask,windows=hasWindow(node.parameters);if(!stage.nodeEnd||!mask?.enabled&&!windows&&keyed===1)return rgb;
  let amount=keyed;
  if(mask?.enabled){
    if(!mask.amount)return input;
    if(!maskAt)throw Error('A spatial node mask requires per-pixel alpha; it cannot be baked into an RGB LUT.');
    const alpha=maskAt(nodeMaskId(node)!);if(!Number.isFinite(alpha))throw Error('Invalid spatial mask alpha.');
    amount*=(mask.invert?1-clamp(alpha):clamp(alpha))*mask.amount/100;
  }
  if(windows){
    if(!maskAt)throw Error('A window needs pixel positions; it cannot be baked into an RGB LUT.');
    const alpha=maskAt(`window:${node.id}`);if(!Number.isFinite(alpha))throw Error('Invalid window alpha.');amount*=clamp(alpha);
  }
  return input.map((v,c)=>v+(rgb[c]-v)*amount);
}
function managedColorTransform(clip:Clip,asset:MediaAsset|undefined,nodes:GradeNode[],maskAt?: (id:string)=>number){
  const source=interpretation(clip,asset),stages=processingStages({...clip,properties:{...clip.properties,inputProfile:source.profile,inputGamut:source.gamut}},nodes);
  return(input:number[])=>{
    let rgb=input,nodeInput=input,keyed=1;
    for(const stage of stages){
      if(stage.type==='film')continue;
      if(stage.nodeStart){nodeInput=rgb;keyed=stage.type==='correction'?qualifierAlpha(rgb,stage.weights,stage.extra):1;}
      if(stage.type==='cst'){rgb=transformSpace(rgb,stage.effect,stage.matrix,stage.weights);continue;}
      if(stage.type==='lut'){rgb=blendNode(applyLut(rgb,stage.effect),nodeInput,stage,maskAt,keyed);continue;}
      const {g,extra:p,node,gamma}=stage,w=stage.weights;
      if(g.exposure||g.temperature||g.tint)rgb=rgb.map((v,c)=>encodeLog(decodeLog(v,gamma)*2**g.exposure*[1+g.temperature/10000,1-g.tint/200,1-g.temperature/10000][c],gamma));
      rgb=rgb.map((v,c)=>{const ch='RGB'[c],x=(v-g.pivot)*g.contrast+g.pivot+g.offset+(p['offset'+ch]??0);return Math.sign(x)*Math.abs(x)**(1/2**(g.gamma+(p['gamma'+ch]??0)))*(g.gain+(p['gain'+ch]??0))+(g.lift+(p['lift'+ch]??0))*(1-v);});
      rgb=tonal(rgb,w,p,g.pivot);
      const y=multiply([w],rgb)[0];rgb=chroma(rangeSaturation(rgb.map(v=>y+(v-y)*g.saturation),w,p),w,p);
      if(node.curves)rgb=applyCurves(rgb,node);
      else if(Object.keys(p).some(k=>k.startsWith('curve')))rgb=rgb.map(v=>curveValue(v,p));
      rgb=blendNode(mixer(hslCurves(rgb,w,node.curves),p),nodeInput,stage,maskAt,keyed);
    }
    return rgb.map(v=>clamp(v));
  };
}

export function hasACES(nodes:GradeNode[],clipId:string){return nodes.some(n=>n.clipId===clipId&&n.enabled&&n.effects?.some(e=>e.enabled&&e.type==='cst'&&e.toneMapping==='aces2'));}
