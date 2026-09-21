import type { SmartMaskPixels } from './smartMaskPreview.ts';
import { acesShader, acesTextures } from './aces.generated.ts';
import { processingStages, sampleCurve, identityCurve, luminanceWeights, interpretation, profiles, hasACES, colorTransform, type Cube } from './color.ts';
import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';

export class ColorPending extends Error {}
/** Immutable viewing LUTs; live corrections are tiny GPU parameters, never rebuilt LUTs. */
export function createColorPreview(onReady:()=>void = ()=>{}) {
  const canvas=document.createElement('canvas'), gl=canvas.getContext('webgl2',{premultipliedAlpha:false,preserveDrawingBuffer:true});
  if(!gl) return createSoftwareColorPreview(onReady);
  const floatLinear=!!gl.getExtension('OES_texture_float_linear');
  const shader=(type:number,source:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)||'Color shader failed.');return s;};
  const program=gl.createProgram()!;
  gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
  out vec2 uv; void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}`));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float; precision highp sampler2D; precision highp sampler3D; precision highp sampler2DArray;
  ${acesShader}
  in vec2 uv; out vec4 pixel;
  uniform sampler2DArray maskAtlas;
  uniform sampler2D picture, parameters, luma, chromaU, chromaV, curves, lutAtlas; uniform sampler3D grade;
  uniform float size, stops, warmth; uniform vec3 domainMin, domainMax; uniform int profile, count, yuvMode; uniform vec4 sourceRect, yuvCoefficients, yuvScale; uniform float fullRange; uniform bool nativeView, managed, displaySRGB;
  float decode(float v, int profile) {
    if(profile==8)return v;
    if(profile==7)return v>.02740668?exp2(v/.07329248-7.)-.0075:v/10.44426855;
    if(profile==9)return sign(v)*pow(abs(v),2.4);
    if(profile==5||profile==6){float x=(v*1023.-64.)/876.;return (x>=.030001222851889303?pow(10.,(x-.646596)/.432699)-.037584:(x-.030001222851889303)/5.)*.9*(profile==5?219./155.:1.);}
    if(profile==1)return v>=171.2102946929/1023.?pow(10.,(v*1023.-420.)/261.5)*.19-.01:(v*1023.-95.)*.01125/(171.2102946929-95.);
    if(profile==2||profile==3){float a=profile==2?.529136:.281863093,b=profile==2?.0730597:.035388128,c=profile==2?10.1596:87.09937546,ire=(v*1023.-64.)/876.;return sign(ire-b)*(pow(10.,abs(ire-b)/a)-1.)/c*.9;}
    if(profile==4){float ire=(v*1023.-64.)/876.;return .9*(ire<.04076162?-(pow(10.,(.07623209-ire)/.42889912)-1.)/14.98325:ire<=.105357102?(ire-.073059361)/2.3069815:(pow(10.,(ire-.069886632)/.42889912)-1.)/14.98325);}
    return pow(max(0.,v),2.4);
  }
  float encode(float v, int profile) {
    if(profile==8)return v;
    if(profile==7)return v>.00262409?(log2(v+.0075)+7.)*.07329248:v*10.44426855;
    if(profile==9)return sign(v)*pow(abs(v),1./2.4);
    if(profile==5||profile==6){float x=v/.9*(profile==5?155./219.:1.);return ((x>=0.?.432699*log(x+.037584)/log(10.)+.646596:x*5.+.030001222851889303)*876.+64.)/1023.;}
    if(profile==1)return v>=.01125?(420.+log((v+.01)/.19)/log(10.)*261.5)/1023.:(v*(171.2102946929-95.)/.01125+95.)/1023.;
    if(profile==2||profile==3){float a=profile==2?.529136:.281863093,b=profile==2?.0730597:.035388128,c=profile==2?10.1596:87.09937546;return ((sign(v)*a*log(c*abs(v)/.9+1.)/log(10.)+b)*876.+64.)/1023.;}
    if(profile==4){float x=v/.9,ire=x<-.014?-.42889912*log(-x*14.98325+1.)/log(10.)+.07623209:x<=.014?2.3069815*x+.073059361:.42889912*log(x*14.98325+1.)/log(10.)+.069886632;return (ire*876.+64.)/1023.;}
    return pow(max(0.,v),1./2.4);
  }
  float decode(float v){return decode(v,profile);}
  float encode(float v){return encode(v,profile);}
  vec3 decodeRGB(vec3 v,int p){return vec3(decode(v.r,p),decode(v.g,p),decode(v.b,p));}
  vec3 encodeRGB(vec3 v,int p){return vec3(encode(v.r,p),encode(v.g,p),encode(v.b,p));}
  float customCurve(float v,int row){
    float x=v*1023.;int i=int(clamp(floor(x),0.,1022.));
    float a=texelFetch(curves,ivec2(i,row),0).r,b=texelFetch(curves,ivec2(i+1,row),0).r;
    return mix(a,b,x-float(i));
  }
  vec3 lutValue(int i){return texelFetch(lutAtlas,ivec2(i%512,i/512),0).rgb;}
  vec4 param(int x,int n){return texelFetch(parameters,ivec2(x,n),0);}
  float curve(float v,vec3 p){float x=clamp(v,0.,1.)*4.;return x<1.?mix(0.,p.x,x):x<2.?mix(p.x,p.y,x-1.):x<3.?mix(p.y,p.z,x-2.):mix(p.z,1.,x-3.);}
  vec3 maskNode(vec3 rgb,vec3 before,vec4 mask,vec2 coord){
    if(mask.w<2.||mask.x<0.)return rgb;
    float alpha=texture(maskAtlas,vec3(coord,mask.x)).r;
    return mix(before,rgb,(mask.z>0.?1.-alpha:alpha)*mask.y);
  }
  void main(){
    vec2 coord=vec2(uv.x,1.-uv.y);vec4 source;
    if(yuvMode>0){
      coord=(coord-sourceRect.xy)/sourceRect.zw;
      if(any(lessThan(coord,vec2(0)))||any(greaterThan(coord,vec2(1)))){pixel=vec4(0);return;}
      float y=texture(luma,coord).r;vec2 chroma=yuvMode==2?texture(chromaU,coord).rg:vec2(texture(chromaU,coord).r,texture(chromaV,coord).r);
      y=(y-yuvScale.x)*yuvScale.y;chroma=(chroma-yuvScale.z)*yuvScale.w;
      source=vec4(y+chroma.y*yuvCoefficients.x,y+dot(chroma,yuvCoefficients.yz),y+chroma.x*yuvCoefficients.w,1.);
    }else source=texture(picture,coord);
    vec3 rgb=source.rgb,nodeInput=source.rgb;vec2 maskCoord=vec2(uv.x,1.-uv.y);
    if(!managed&&(stops!=0.||warmth!=0.)){vec3 linear=vec3(decode(rgb.r),decode(rgb.g),decode(rgb.b))*exp2(stops)*vec3(1.+warmth/10000.,1.,1.-warmth/10000.);rgb=vec3(encode(linear.r),encode(linear.g),encode(linear.b));}
    if(!managed&&!nativeView){vec3 p=(clamp((rgb-domainMin)/(domainMax-domainMin),0.,1.)*(size-1.)+.5)/size;rgb=texture(grade,p).rgb;}
    for(int n=0;n<count;n++){
      vec4 mask=param(12,n);if(mask.w==1.||mask.w==3.)nodeInput=rgb;
      vec4 a=param(0,n),b=param(1,n),c=param(2,n),d=param(3,n),e=param(4,n),f=param(5,n),h=param(6,n),kind=param(7,n);
      if(kind.x==1.){
        vec3 linear=decodeRGB(rgb,int(kind.y));
        linear=vec3(dot(param(8,n).xyz,linear),dot(param(9,n).xyz,linear),dot(param(10,n).xyz,linear));
        if(kind.w==2.){rgb=ocio_aces2(vec4(linear,1.)).rgb;continue;}
        if(kind.w==1.){float peak=max(0.,max(linear.r,max(linear.g,linear.b))),mapped=peak<=.6?peak:.6+.4*(1.-exp(-(peak-.6)/.4));linear*=peak>0.?mapped/peak:1.;}
        if(param(8,n).w>0.){float y=clamp(dot(param(11,n).xyz,linear),0.,1.),amount=1.;for(int i=0;i<3;i++){float delta=linear[i]-y;if(delta>0.)amount=min(amount,(1.-y)/delta);else if(delta<0.)amount=min(amount,-y/delta);}linear=vec3(y)+(linear-y)*amount;}
        rgb=encodeRGB(linear,int(kind.z));continue;
      }
      if(kind.x==2.){
        int size=int(a.y),base=int(a.x);vec3 pos=clamp((rgb-b.xyz)/(c.xyz-b.xyz),0.,1.)*float(size-1),lo=min(floor(pos),vec3(size-2)),fraction=pos-lo,result=vec3(0);
        for(int blue=0;blue<2;blue++)for(int green=0;green<2;green++)for(int red=0;red<2;red++){
          vec3 w=mix(1.-fraction,fraction,vec3(red,green,blue));ivec3 at=ivec3(lo)+ivec3(red,green,blue);result+=lutValue(base+at.z*size*size+at.y*size+at.x)*w.x*w.y*w.z;
        }
        rgb=maskNode(mix(rgb,result,a.z),nodeInput,mask,maskCoord);continue;
      }
      if(managed){
        if(a.x!=0.||c.w!=0.||d.w!=0.)rgb=encodeRGB(decodeRGB(rgb,int(kind.y))*exp2(a.x)*vec3(1.+c.w,1.-d.w,1.-c.w),int(kind.y));
        vec3 v=rgb,x=(v-a.z)*a.y+a.z+b.w+e.xyz;
        rgb=sign(x)*pow(abs(x),vec3(1.)/exp2(b.y+c.xyz))*(b.z+d.xyz)+(b.x+f.xyz)*(1.-v);
        float y=dot(rgb,param(11,n).xyz);rgb=y+(rgb-y)*a.w;
      }else{
        vec3 v=max(vec3(0),rgb*exp2(a.x));
        rgb=pow(max(vec3(0),(v-a.z)*a.y+a.z+b.w+e.xyz),vec3(1.)/exp2(b.y+c.xyz))*(b.z+d.xyz)+(b.x+f.xyz)*(1.-min(vec3(1),v));
        float y=dot(rgb,vec3(.2126,.7152,.0722));rgb=(y+(rgb-y)*a.w)*vec3(1.+c.w,1.-d.w,1.-c.w);
      }
      if(h.w==2.){rgb=vec3(customCurve(rgb.r,n*4),customCurve(rgb.g,n*4),customCurve(rgb.b,n*4));rgb=vec3(customCurve(rgb.r,n*4+1),customCurve(rgb.g,n*4+2),customCurve(rgb.b,n*4+3));}
      else if(h.w==1.)rgb=vec3(curve(rgb.r,h.xyz),curve(rgb.g,h.xyz),curve(rgb.b,h.xyz));
      rgb=maskNode(rgb,nodeInput,mask,maskCoord);
    }
    if(displaySRGB){
      vec3 linear=pow(max(rgb,vec3(0)),vec3(2.4));
      rgb=mix(12.92*linear,1.055*pow(linear,vec3(1./2.4))-.055,greaterThan(linear,vec3(.0031308)));
      // Stable half-code dither at final SDR quantization, never in scene data.
      float noise=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5;
      rgb+=noise/255.;
    }
    pixel=vec4(clamp(rgb,0.,1.),source.a);
  }`));
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'Color pipeline could not initialize.');gl.useProgram(program);
  const acesTables=acesTextures.map((t,i)=>{const texture=gl.createTexture()!;gl.activeTexture(gl.TEXTURE8+i);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage2D(gl.TEXTURE_2D,0,t.channels===1?gl.R32F:gl.RGB32F,t.width,t.height,0,t.channels===1?gl.RED:gl.RGB,gl.FLOAT,new Float32Array(t.values));gl.uniform1i(gl.getUniformLocation(program,t.sampler),8+i);return texture;});
  const maskTexture=gl.createTexture()!,maskUnit=8+acesTables.length;
  const curveTexture=gl.createTexture()!,lutTexture=gl.createTexture()!;
  const picture=gl.createTexture()!, parameters=gl.createTexture()!, planes=[gl.createTexture()!,gl.createTexture()!,gl.createTexture()!];
  const uniform=(name:string)=>gl.getUniformLocation(program,name);
  gl.uniform1i(uniform('maskAtlas'),maskUnit);
  gl.uniform1i(uniform('curves'),6);gl.uniform1i(uniform('lutAtlas'),7);
  gl.uniform1i(uniform('picture'),0);gl.uniform1i(uniform('grade'),1);gl.uniform1i(uniform('parameters'),2);['luma','chromaU','chromaV'].forEach((name,i)=>gl.uniform1i(uniform(name),i+3));
  const settings=(target:number,filter:number=gl.LINEAR)=>{gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,filter);gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);};
  type Look={texture:WebGLTexture;size:number;min:number[];max:number[]};
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,picture);settings(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
  planes.forEach((t,i)=>{gl.activeTexture(gl.TEXTURE3+i);gl.bindTexture(gl.TEXTURE_2D,t);settings(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,1,1,0,gl.RED,gl.UNSIGNED_BYTE,new Uint8Array([0]));});
  gl.activeTexture(gl.TEXTURE0+maskUnit);gl.bindTexture(gl.TEXTURE_2D_ARRAY,maskTexture);settings(gl.TEXTURE_2D_ARRAY);gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.R8,1,1,1,0,gl.RED,gl.UNSIGNED_BYTE,new Uint8Array([0]));
  const neutral:Look={texture:gl.createTexture()!,size:1,min:[0,0,0],max:[1,1,1]};
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,neutral.texture);settings(gl.TEXTURE_3D);gl.texImage3D(gl.TEXTURE_3D,0,gl.RGBA8,1,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
  const looks=new Map<string,Look|Error|null>(), worker=new Worker(new URL('./colorWorker.ts',import.meta.url),{type:'module'});
  worker.onmessage=({data}:{data:{key:string;cube:Cube;error?:string}})=>{
    if(!looks.has(data.key))return;
    if(data.error){looks.set(data.key,new Error(data.error));onReady();return;}
    const existing=looks.get(data.key);if(existing&&!(existing instanceof Error))gl.deleteTexture(existing.texture);
    const cube=data.cube,texture=gl.createTexture()!,rgba=new Float32Array(cube.size**3*4);
    for(let i=0,j=0;i<cube.data.length;i+=3,j+=4){rgba[j]=cube.data[i];rgba[j+1]=cube.data[i+1];rgba[j+2]=cube.data[i+2];rgba[j+3]=1;}
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,texture);settings(gl.TEXTURE_3D);gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D,0,gl.RGBA16F,cube.size,cube.size,cube.size,0,gl.RGBA,gl.FLOAT,rgba);
    looks.set(data.key,{texture,size:cube.size,min:cube.min,max:cube.max});onReady();
  };
  worker.onerror=()=>{for(const [key,look] of looks)if(!look)looks.set(key,new Error('Color worker failed. Reload the editor.'));};
  const preload=(clip:Clip,asset:MediaAsset)=>{
    interpretation(clip,asset);const url=clip.properties.colorPipeline==='nodes-v2'||clip.properties.bypassResolveLook===true?'':String(clip.properties.resolveLookUrl||''),key=url;if(!url)return '';
    if(url&&!/^\/api\/projects\/[a-zA-Z0-9_-]+\/resolve\/[a-zA-Z0-9_-]+\.cube$/.test(url))throw new Error('Invalid Resolve look URL.');
    if(!looks.has(key)){
      // ponytail: sixteen RGBA16F looks use at most 34 MiB; use a byte budget if larger LUTs are supported.
      if(looks.size>=16){const oldest=looks.keys().next().value!;const old=looks.get(oldest);if(old&&!(old instanceof Error))gl.deleteTexture(old.texture);looks.delete(oldest);}
      looks.set(key,null);worker.postMessage({key,url});
    } else {const look=looks.get(key)!;looks.delete(key);looks.set(key,look);}
    return key;
  };
  type Decoded={timestamp:number;data?:Uint8Array;layout?:PlaneLayout[];width:number;height:number;format:string;space:VideoColorSpaceInit;error?:Error};
  const nativeFrames=new WeakSet<HTMLVideoElement>();
  const decoded=new WeakMap<HTMLVideoElement,{pending?:Decoded;ready?:Decoded}>();let lastFrame:Decoded|undefined;
  const frameFor=(video:HTMLVideoElement)=>{
    if(nativeFrames.has(video))return undefined;
    let frame:VideoFrame;
    try { frame=new VideoFrame(video); } catch { nativeFrames.add(video);return undefined; }
    const state=decoded.get(video)??{};
    decoded.set(video,state);
    if(state.pending||state.ready?.timestamp===frame.timestamp){frame.close();return state.ready??state.pending!;}
    const width=frame.visibleRect?.width??frame.codedWidth,height=frame.visibleRect?.height??frame.codedHeight;
    const current:Decoded={timestamp:frame.timestamp,width,height,format:frame.format||'',space:frame.colorSpace.toJSON()};
    if(!['I420','I422','I444','NV12','I420P10','I422P10','I444P10','I420P12','I422P12','I444P12'].includes(current.format)){frame.close();nativeFrames.add(video);return undefined;}
    let buffer:Uint8Array<ArrayBuffer>;
    try { buffer=new Uint8Array(frame.allocationSize()); } catch { frame.close();nativeFrames.add(video);return undefined; }
    state.pending=current;
    // Keep presenting the completed snapshot while the next GPU readback is in flight.
    Promise.resolve().then(()=>frame.copyTo(buffer)).then(layout=>{current.layout=layout;current.data=buffer;}).catch(()=>{nativeFrames.add(video);}).finally(()=>{state.ready=current;state.pending=undefined;frame.close();onReady();});
    return state.ready??current;
  };
  let previousMasks='',previous='',previousLuts='';
  const cubeIds=new WeakMap<object,number>();let nextCube=0;
  const cubeId=(cube:object)=>{if(!cubeIds.has(cube))cubeIds.set(cube,++nextCube);return cubeIds.get(cube)!;};

  return {
    preload,
    prepare(video: HTMLVideoElement) {
      if (typeof VideoFrame !== 'undefined' && video.readyState >= 2 && !video.seeking) frameFor(video);
    },
    draw(source:HTMLCanvasElement,clip:Clip,asset:MediaAsset,nodes:GradeNode[],video?:HTMLVideoElement,masks:Map<string,SmartMaskPixels>|((time:number)=>Map<string,SmartMaskPixels>)=new Map()) {
      const key=preload(clip,asset),look=key?looks.get(key):neutral;
      if(look instanceof Error)throw look;if(!look)throw new ColorPending('Preparing color…');
      const frame=video&&typeof VideoFrame!=='undefined'?frameFor(video):undefined;
      if(frame?.error)throw frame.error;if(frame&&!frame.data)throw new ColorPending('Decoding color…');
      const maskPixels=typeof masks==='function'?masks(frame?frame.timestamp/1e6:video?.currentTime??0):masks;
      const {profile,gamut}=interpretation(clip,asset),stops=Number(clip.properties.inputExposure??0),warmth=Number(clip.properties.inputTemperature??0);
      if(!Number.isFinite(stops)||Math.abs(stops)>8||!Number.isFinite(warmth)||Math.abs(warmth)>2000)throw new Error('Camera exposure or white balance is out of range.');
      gl.useProgram(program);
      const controls=JSON.stringify([clip.id,clip.properties.colorPipeline,profile,gamut,nodes.map(({enabled,order,parameters,curves,effects,mask})=>({enabled,order,parameters,curves,mask,effects:effects?.map(e=>e.type==='lut'?{...e,cube:cubeId(e.cube)}:e)}))]);
      const maskIds=[...new Set(nodes.filter(n=>n.enabled&&n.clipId===clip.id&&n.mask?.enabled).map(n=>n.mask!.id))];
      const maskKey=JSON.stringify([source.width,source.height,maskIds.map(id=>maskPixels.get(id)?.key??id)]);
      if(maskKey!==previousMasks){
        const alpha=new Uint8Array(Math.max(1,maskIds.length)*source.width*source.height);
        maskIds.forEach((id,i)=>{const data=maskPixels.get(id);if(!data){if(nodes.some(n=>n.mask?.id===id&&n.mask.enabled&&n.mask.amount>0))throw new ColorPending('Loading Smart Mask…');return;}alpha.set(data.data,i*source.width*source.height);});
        gl.activeTexture(gl.TEXTURE0+maskUnit);gl.bindTexture(gl.TEXTURE_2D_ARRAY,maskTexture);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.R8,source.width,source.height,Math.max(1,maskIds.length),0,gl.RED,gl.UNSIGNED_BYTE,alpha);previousMasks=maskKey;
      }
      if(controls!==previous){
        const interpreted={...clip,properties:{...clip.properties,inputProfile:profile,inputGamut:gamut}};
        const stages=processingStages(interpreted,nodes),height=Math.max(1,stages.length);if(height*4>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw new Error('Too many correction stages for this GPU.');
        const data=new Float32Array(height*52),curveData=new Float32Array(1024*height*4);
        let lutOffset=0;const lutEffects:Extract<ReturnType<typeof processingStages>[number],{type:'lut'}>[]=[];
        stages.forEach((stage,i)=>{
          const row=i*52,mask=stage.node.mask;data.set([mask?.enabled?maskIds.indexOf(mask.id):-1,(mask?.amount??100)/100,mask?.invert?1:0,(stage.nodeStart?1:0)+(stage.nodeEnd?2:0)],row+48);
          if(stage.type==='cst'){
            const e=stage.effect;data.set([1,profiles.indexOf(e.inputGamma as typeof profiles[number]),profiles.indexOf(e.outputGamma as typeof profiles[number]),e.toneMapping==='aces2'?2:e.toneMapping==='shoulder'?1:0],row+28);
            stage.matrix.forEach((r,j)=>data.set([...r,j===0&&e.gamutMapping==='compress'?1:0],row+32+j*4));data.set(luminanceWeights(e.outputGamut),row+44);
          }else if(stage.type==='lut'){
            const e=stage.effect;data.set([lutOffset,e.cube.size,e.amount,0,...e.cube.min,0,...e.cube.max,0],row);data[row+28]=2;lutOffset+=e.cube.size**3;lutEffects.push(stage);
          }else{
            const {g,extra:p,node}=stage;
            data.set([g.exposure,g.contrast,g.pivot,g.saturation,g.lift,g.gamma,g.gain,g.offset,p.gammaR??0,p.gammaG??0,p.gammaB??0,clip.properties.colorPipeline==='nodes-v2'?g.temperature/10000:Math.max(-.5,Math.min(.5,g.temperature/10000)),p.gainR??0,p.gainG??0,p.gainB??0,clip.properties.colorPipeline==='nodes-v2'?g.tint/200:Math.max(-.5,Math.min(.5,g.tint/200)),p.offsetR??0,p.offsetG??0,p.offsetB??0,0,p.liftR??0,p.liftG??0,p.liftB??0,0,p.curve25??.25,p.curve50??.5,p.curve75??.75,node.curves?2:Object.keys(p).some(k=>k.startsWith('curve'))?1:0,0,profiles.indexOf(stage.gamma as typeof profiles[number]),0,0],row);
            data.set(luminanceWeights(stage.gamut),row+44);
            if(node.curves)for(const [c,key]of ['RGB','R','G','B'].entries()){const curve=node.curves[key as 'RGB']??identityCurve();for(let x=0;x<1024;x++)curveData[(i*4+c)*1024+x]=sampleCurve(x/1023,curve);}
          }
        });
        gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,curveTexture);settings(gl.TEXTURE_2D,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,1024,height*4,0,gl.RED,gl.FLOAT,curveData);
        const lutKey=JSON.stringify(lutEffects.map(s=>cubeId(s.effect.cube)));
        if(lutKey!==previousLuts){
          const lutHeight=Math.max(1,Math.ceil(lutOffset/512));if(lutHeight>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw Error('LUT stack exceeds GPU memory limits.');
          const atlas=new Float32Array(512*lutHeight*4);let at=0;for(const stage of lutEffects){const d=stage.effect.cube.data;for(let j=0;j<d.length;j+=3){atlas.set([d[j],d[j+1],d[j+2],1],at);at+=4;}}
          gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,lutTexture);settings(gl.TEXTURE_2D,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,512,lutHeight,0,gl.RGBA,gl.FLOAT,atlas);previousLuts=lutKey;
        }
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,parameters);settings(gl.TEXTURE_2D,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,13,height,0,gl.RGBA,gl.FLOAT,data);gl.uniform1i(uniform('count'),stages.length);previous=controls;
      }
      gl.uniform1i(uniform('managed'),clip.properties.colorPipeline==='nodes-v2'?1:0);
      gl.uniform1i(uniform('displaySRGB'),hasACES(nodes,clip.id)?1:0);
      gl.uniform1i(uniform('nativeView'),key?0:1);
      gl.uniform1i(uniform('profile'),profiles.indexOf(profile as typeof profiles[number]));gl.uniform1f(uniform('stops'),stops);gl.uniform1f(uniform('warmth'),warmth);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,look.texture);gl.uniform1f(uniform('size'),look.size);gl.uniform3fv(uniform('domainMin'),look.min);gl.uniform3fv(uniform('domainMax'),look.max);
      if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height;}
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.uniform1i(uniform('yuvMode'),frame?frame.format==='NV12'?2:1:0);
      if(frame){
        const fit=Math.min(source.width/video!.videoWidth,source.height/video!.videoHeight),w=video!.videoWidth*fit/source.width,h=video!.videoHeight*fit/source.height;
        gl.uniform4f(uniform('sourceRect'),(1-w)/2,(1-h)/2,w,h);
        // Planar high-depth frames retain source samples; Chromium supplies fallback 601 when camera VUI is absent.
        const sourceMatrix=/P(10|12)$/.test(frame.format)&&asset.colorMatrix!=='auto'?asset.colorMatrix:undefined;
        const matrix=String(clip.properties.yuvMatrix||sourceMatrix||frame.space.matrix||asset.colorMatrix||'bt709').replace('bt2020nc','bt2020-ncl');
        if(!['bt709','smpte170m','bt470bg','bt2020-ncl',null,undefined].includes(matrix))throw new Error('Unsupported decoded YUV matrix. Use a prepared proxy.');
        const kr=matrix==='bt2020-ncl'?.2627:matrix==='smpte170m'||matrix==='bt470bg'?.299:.2126,kb=matrix==='bt2020-ncl'?.0593:matrix==='smpte170m'||matrix==='bt470bg'?.114:.0722,kg=1-kr-kb;
        gl.uniform4f(uniform('yuvCoefficients'),2*(1-kr),-2*kb*(1-kb)/kg,-2*kr*(1-kr)/kg,2*(1-kb));gl.uniform1f(uniform('fullRange'),frame.space.fullRange?1:0);
        const depth=frame.format.endsWith('P10')?10:frame.format.endsWith('P12')?12:8,maxCode=2**depth-1,scale=2**(depth-8);
        const full=clip.properties.dataLevels==='Full'?true:clip.properties.dataLevels==='Video'?false:frame.space.fullRange??asset.colorRange==='pc';
        gl.uniform4f(uniform('yuvScale'),full?0:16*scale/maxCode,full?1:maxCode/(219*scale),128*scale/maxCode,full?1:maxCode/(224*scale));
        if(frame!==lastFrame){
          gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
          frame.layout!.forEach((layout,i)=>{
            const channels=frame.format==='NV12'&&i===1?2:1,w=i&&!frame.format.startsWith('I444')?Math.ceil(frame.width/2):frame.width,h=i&&(frame.format.startsWith('I420')||frame.format==='NV12')?Math.ceil(frame.height/2):frame.height;
            gl.activeTexture(gl.TEXTURE3+i);gl.bindTexture(gl.TEXTURE_2D,planes[i]);settings(gl.TEXTURE_2D);
            if(depth>8){
              const values=new Float32Array(w*h),bytes=new DataView(frame.data!.buffer,frame.data!.byteOffset,frame.data!.byteLength);
              for(let y=0;y<h;y++)for(let x=0;x<w;x++)values[y*w+x]=bytes.getUint16(layout.offset+y*layout.stride+x*2,true)/maxCode;
              gl.pixelStorei(gl.UNPACK_ROW_LENGTH,0);gl.texImage2D(gl.TEXTURE_2D,0,floatLinear?gl.R32F:gl.R16F,w,h,0,gl.RED,gl.FLOAT,values);
            }else{gl.pixelStorei(gl.UNPACK_ROW_LENGTH,layout.stride/channels);gl.texImage2D(gl.TEXTURE_2D,0,channels===2?gl.RG8:gl.R8,w,h,0,channels===2?gl.RG:gl.RED,gl.UNSIGNED_BYTE,frame.data!.subarray(layout.offset));}

          });
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH,0);lastFrame=frame;
        }
      }else{
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,picture);settings(gl.TEXTURE_2D);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      }
      canvas.dataset.colorPrecision=frame?(frame.format.match(/P(10|12)$/)?.[1]??'8')+'-bit YUV':'8-bit RGB fallback';
      canvas.dataset.sourceTimestamp=String(frame?frame.timestamp/1e6:video?Math.floor(video.currentTime*(asset.fps||24)+1e-6)/(asset.fps||24):0);
      gl.drawArrays(gl.TRIANGLES,0,3);
      return canvas;
    },
    dispose(){worker.terminate();gl.deleteTexture(neutral.texture);for(const look of looks.values())if(look&&!(look instanceof Error))gl.deleteTexture(look.texture);gl.deleteTexture(picture);gl.deleteTexture(parameters);gl.deleteTexture(maskTexture);gl.deleteTexture(curveTexture);gl.deleteTexture(lutTexture);planes.forEach(t=>gl.deleteTexture(t));acesTables.forEach(t=>gl.deleteTexture(t));gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();looks.clear();},
  };
}

/** Last-resort path for devices where WebGL 2 is unavailable. Uses the same color math as export. */
function createSoftwareColorPreview(onReady:()=>void) {
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true})!;
  const looks=new Map<string,Cube|Error|null>();
  const worker=new Worker(new URL('./colorWorker.ts',import.meta.url),{type:'module'});
  worker.onmessage=({data}:{data:{key:string;cube:Cube;error?:string}})=>{if(looks.has(data.key)){looks.set(data.key,data.error?new Error(data.error):data.cube);onReady();}};
  worker.onerror=()=>{for(const [key,value] of looks)if(!value)looks.set(key,new Error('Color worker failed. Reload the editor.'));onReady();};
  const preload=(clip:Clip,asset:MediaAsset)=>{
    interpretation(clip,asset);
    const key=clip.properties.colorPipeline==='nodes-v2'||clip.properties.bypassResolveLook===true?'':String(clip.properties.resolveLookUrl||'');
    if(key&&!/^\/api\/projects\/[a-zA-Z0-9_-]+\/resolve\/[a-zA-Z0-9_-]+\.cube$/.test(key))throw new Error('Invalid Resolve look URL.');
    if(key&&!looks.has(key)){
      if(looks.size>=16)looks.delete(looks.keys().next().value!);
      looks.set(key,null);worker.postMessage({key,url:key});
    }
    return key;
  };
  return {
    preload,prepare(_video:HTMLVideoElement){},
    draw(source:HTMLCanvasElement,clip:Clip,asset:MediaAsset,nodes:GradeNode[],video?:HTMLVideoElement,masks:Map<string,SmartMaskPixels>|((time:number)=>Map<string,SmartMaskPixels>)=new Map()){
      const key=preload(clip,asset),look=key?looks.get(key):undefined;
      if(look instanceof Error)throw look;if(key&&!look)throw new ColorPending('Preparing color…');
      if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height;}
      context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(source,0,0);
      if(hasACES(nodes,clip.id))throw Error('ACES preview requires WebGL2. Enable browser graphics acceleration or use a supported browser.');
      const maskPixels=typeof masks==='function'?masks(video?.currentTime??0):masks;
      let at=0;const pixels=context.getImageData(0,0,canvas.width,canvas.height),transform=colorTransform(clip,asset,nodes,look??undefined,id=>{const mask=maskPixels.get(id);if(!mask)throw new ColorPending('Loading Smart Mask…');return mask.data[at]/255;});
      // ponytail: exact per-pixel fallback is slow without a GPU; move to a worker if software-only devices are common.
      for(let i=0;i<pixels.data.length;i+=4){at=i/4;if(!pixels.data[i+3])continue;const rgb=transform([pixels.data[i]/255,pixels.data[i+1]/255,pixels.data[i+2]/255]);for(let c=0;c<3;c++)pixels.data[i+c]=rgb[c]*255;}
      context.putImageData(pixels,0,0);
      canvas.dataset.sourceTimestamp=String(video?Math.floor(video.currentTime*(asset.fps||24)+1e-6)/(asset.fps||24):0);
      return canvas;
    },
    dispose(){worker.terminate();looks.clear();},
  };
}
