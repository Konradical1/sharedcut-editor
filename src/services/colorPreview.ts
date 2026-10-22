import type { SmartMaskPixels } from './smartMaskPreview.ts';
import { nodeMaskId } from './smartMask.ts';
import { acesShader, acesTextures } from './aces.generated.ts';
import { createCopyProbe } from './copyProbe.ts';
import { processingStages, sampleCurve, identityCurve, luminanceWeights, interpretation, profiles, hasACES, colorTransform, type Cube } from './color.ts';
import { HSL_CURVES, HUE_CURVES, PARAM, filmActive, filmMotion, grainKey, halationTint, hasQualifier, hasWindow, on, periodicCurve, windowAlpha } from './grading.ts';
import { applyFilm } from './filmLook.ts';
import { apply, invert, type Affine } from './colorKeys.ts';
import type { Clip, GradeNode, MediaAsset } from '../state/models.ts';

export class ColorPending extends Error {}
/** What the viewer shows for one node's key (Color page Qualifier/Windows): its grade, the keyed area over grey ('highlight') or the black/white matte. */
export type ColorView = { nodeId: string | null; mode: 'off' | 'highlight' | 'matte' };
export const colorView: ColorView = { nodeId: null, mode: 'off' };
/** Changes the key view and asks the viewer to redraw. */
export function setColorView(next: ColorView) { Object.assign(colorView, next); window.dispatchEvent(new Event('frameline:color-view')); }
/** A qualifier pick waiting for the layer that grades its node to be drawn. */
type Probe = { nodeId: string; px: number; py: number; resolve: (rgb: number[] | null) => void };
const probes = new Set<Probe>();
/** The last successful GPU draw: answers a probe while its textures are bound, false when its clip does not own the node. */
let lastDraw: ((probe: Probe) => boolean) | undefined;
/**
 * The selected node's input colour at picture position (px, py) ∈ [0,1]², in that node's working encoding, averaged over 5×5
 * pixels of its clip's frame; a bypassed node reads the input of the place it holds. The last draw answers when it drew that
 * clip; otherwise the viewer redraws and the clip's own draw answers (a layer above it, a dissolve or picture-in-picture may
 * draw last). null after 2 s without that draw, or without WebGL2.
 */
export function probeNodeInput(nodeId: string, px: number, py: number): Promise<number[] | null> {
  return new Promise(resolve => {
    const probe = { nodeId, px, py, resolve };
    if (lastDraw?.(probe)) return;
    probes.add(probe); window.dispatchEvent(new Event('frameline:color-view'));
    setTimeout(() => { if (probes.delete(probe)) resolve(null); }, 2000);
  });
}
/** A pick waits for one of these nodes: playback grades their clip even with every node bypassed, so its draw can answer. */
export const probeWaiting = (nodes: GradeNode[]) => [...probes].some(p => nodes.some(n => n.id === p.nodeId));

type Stage = ReturnType<typeof processingStages>[number];
type FilmStage = Extract<Stage, { type: 'film' }>;
/** Texels per stage row of the shader's parameter texture, and curve rows per stage (Master R G B, then the six HSL curves). */
export const STAGE_TEXELS = 30, CURVE_ROWS = 10;
/** The source picture's letterboxed rectangle [left, top, width, height] in canvas pixels, as playback fits it (asset "W × H"; the whole canvas when unknown). */
function pictureRect(asset: MediaAsset, width: number, height: number) {
  const m = /(\d+)\s*[×x]\s*(\d+)/i.exec(asset.resolution ?? ''), sw = m ? +m[1] : 0, sh = m ? +m[2] : 0;
  if (!sw || !sh) return [0, 0, width, height];
  const fit = Math.min(width / sw, height / sh);
  return [(width - sw * fit) / 2, (height - sh * fit) / 2, sw * fit, sh * fit];
}
/** Canvas pixels whose centres lie inside the picture: what film passes process. */
const pictureBox = (rect: number[], width: number, height: number) => { const x0 = Math.max(0, Math.ceil(rect[0] - .5)), y0 = Math.max(0, Math.ceil(rect[1] - .5)); return { rect, x0, y0, width: Math.max(0, Math.min(width, Math.ceil(rect[0] + rect[2] - .5)) - x0), height: Math.max(0, Math.min(height, Math.ceil(rect[1] + rect[3] - .5)) - y0) }; };

const TRANSFER = `
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
  vec3 decodeRGB(vec3 v,int p){return vec3(decode(v.r,p),decode(v.g,p),decode(v.b,p));}
  vec3 encodeRGB(vec3 v,int p){return vec3(encode(v.r,p),encode(v.g,p),encode(v.b,p));}
  float sse(float a,float b,float x){return b>a?smoothstep(a,b,x):x>=a?1.:0.;}`;

/**
 * Film stage passes (docs/color-grading-v3.md, filmLook.ts): 0 weave/aberration resample and decode (rgb = linear, a = luma);
 * 1 a 2×2 box halving; 2 one separable Gaussian direction; 3 halation, bloom, breath, vignette, encode and grain. Textures
 * are stored top row first, so pixel (x, y) is the reference's column x, row y. `srcMode` makes a blur read the halation
 * (1) or bloom (2) source straight from the linear picture.
 */
const FILM_SHADER = `#version 300 es
  precision highp float; precision highp int; precision highp sampler2D;
  uniform sampler2D src, glowH, glowB, carry;
  uniform int pass, profile, srcMode, radius, halMode, bloomMode; uniform bool horizontal;
  uniform vec2 size, thresholds, gains; uniform vec3 weights, tint, bloomTint; uniform vec4 motion, vignette, grain; uniform float sigma; uniform uvec4 keys;
  out vec4 pixel;
  ${TRANSFER}
  vec4 at(ivec2 p){vec4 l=texelFetch(src,p,0);return srcMode==1?vec4(max(0.,l.a-thresholds.x)):srcMode==2?vec4(l.rgb*(max(0.,l.a-thresholds.y)/max(l.a,1e-4)),0):l;}
  // Bilinear at normalised q with half-pixel centres and clamped edges, in full float precision (hardware LINEAR weights are ~8-bit).
  vec4 bilinear(sampler2D t,vec2 q){vec2 n=vec2(textureSize(t,0)),p=clamp(q*n-.5,vec2(0),n-1.),f=p-floor(p);ivec2 a=ivec2(p),b=min(a+1,ivec2(n)-1);return mix(mix(texelFetch(t,a,0),texelFetch(t,ivec2(b.x,a.y),0),f.x),mix(texelFetch(t,ivec2(a.x,b.y),0),texelFetch(t,b,0),f.x),f.y);}
  float hash(ivec2 p,uint k){uint h=(uint(p.x)*0x8da6b343u)^(uint(p.y)*0xd8163841u)^(k*0xcb1ab31fu);h^=h>>16u;h*=0x7feb352du;h^=h>>15u;h*=0x846ca68bu;h^=h>>16u;return float(h>>8u)/16777216.;}
  float noise(vec2 p,uint k){vec2 i=floor(p),f=p-i,u=f*f*(3.-2.*f);ivec2 c=ivec2(i);float a=hash(c,k),b=hash(c+ivec2(1,0),k),d=hash(c+ivec2(0,1),k),e=hash(c+ivec2(1),k);a+=(b-a)*u.x;d+=(e-d)*u.x;return a+(d-a)*u.y;}
  float grainAt(vec2 p,uint k){return 1.6*(.7*(2.*noise(p,k)-1.)+.3*(2.*noise(2.37*p+17.1,k^0x68E31DA4u)-1.));}
  void main(){
    ivec2 p=ivec2(gl_FragCoord.xy);vec2 c=gl_FragCoord.xy/size;
    if(pass==0){
      vec3 rgb;
      if(motion.xyz==vec3(0))rgb=texelFetch(src,p,0).rgb;
      else{vec2 d=c-.5,o=.5-motion.xy;rgb=vec3(bilinear(src,o+d*(1.+motion.z)).r,bilinear(src,o+d).g,bilinear(src,o+d*(1.-motion.z)).b);}
      vec3 lin=decodeRGB(rgb,profile);pixel=vec4(lin,dot(weights,lin));return;
    }
    if(pass==1){ivec2 a=2*p,b=min(a+1,textureSize(src,0)-1);pixel=(at(a)+at(ivec2(b.x,a.y))+at(ivec2(a.x,b.y))+at(b))/4.;return;}
    if(pass==2){
      ivec2 n=textureSize(src,0)-1;vec4 sum=vec4(0);float total=0.;
      for(int k=-radius;k<=radius;k++){float w=exp(-float(k*k)/(2.*sigma*sigma));sum+=w*at(horizontal?ivec2(clamp(p.x+k,0,n.x),p.y):ivec2(p.x,clamp(p.y+k,0,n.y)));total+=w;}
      pixel=sum/total;return;
    }
    vec4 l=texelFetch(src,p,0);vec3 o=l.rgb;
    if(halMode>0)o+=gains.x*(halMode==1?max(0.,l.a-thresholds.x):bilinear(glowH,c).r)*tint;
    if(bloomMode>0)o+=gains.y*(bloomMode==1?l.rgb*(max(0.,l.a-thresholds.y)/max(l.a,1e-4)):bilinear(glowB,c).rgb)*bloomTint;
    o*=motion.w;
    if(vignette.w!=0.)o*=exp2(-2.*vignette.w*sse(vignette.y,vignette.y+vignette.z,length(vec2((c.x-.5)*2.*vignette.x,(c.y-.5)*2.))/sqrt(vignette.x*vignette.x+1.)));
    vec3 r=encodeRGB(o,profile);
    if(grain.x>0.){
      float t=clamp(dot(weights,r),0.,1.),g=grain.x*((1.-grain.y)+grain.y*4.*t*(1.-t));vec2 q=gl_FragCoord.xy*grain.w;float mono=grainAt(q,keys.w);
      r+=g*(grain.z!=0.?mono+(vec3(grainAt(q,keys.x),grainAt(q,keys.y),grainAt(q,keys.z))-mono)*grain.z:vec3(mono));
    }
    pixel=vec4(r,texelFetch(carry,p,0).a);
  }`;

/** Immutable viewing LUTs; live corrections are tiny GPU parameters, never rebuilt LUTs. */
export function createColorPreview(onReady:()=>void = ()=>{}) {
  const canvas=document.createElement('canvas'), gl=canvas.getContext('webgl2',{premultipliedAlpha:false,preserveDrawingBuffer:true});
  if(!gl) return createSoftwareColorPreview(onReady);
  const floatLinear=!!gl.getExtension('OES_texture_float_linear');
  // Film passes render into float targets (read with texelFetch, so no float filtering needed); 8-bit only where neither renders.
  const floatRender=!!gl.getExtension('EXT_color_buffer_float'),halfRender=floatRender||!!gl.getExtension('EXT_color_buffer_half_float');
  const targetFormat=floatRender?gl.RGBA32F:halfRender?gl.RGBA16F:gl.RGBA8,byteTargets=targetFormat===gl.RGBA8;
  const shader=(type:number,source:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)||'Color shader failed.');return s;};
  const vertex=shader(gl.VERTEX_SHADER,`#version 300 es
  out vec2 uv; void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}`);
  const link=(fragment:string)=>{const p=gl.createProgram()!;gl.attachShader(p,vertex);gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p)||'Color pipeline could not initialize.');return p;};
  const program=link(`#version 300 es
  precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D; precision highp sampler2DArray;
  ${acesShader}
  out vec4 pixel;
  uniform sampler2DArray maskAtlas;
  uniform sampler2D picture, parameters, luma, chromaU, chromaV, curves, lutAtlas, film; uniform sampler3D grade;
  uniform float size, stops, warmth; uniform vec3 domainMin, domainMax; uniform int profile, first, count, yuvMode, viewStage, viewMode; uniform vec4 sourceRect, yuvCoefficients, yuvScale, pictureRect; uniform vec2 canvasSize; uniform ivec2 origin, region; uniform float fullRange; uniform mat3 unwarp; uniform bool nativeView, managed, displaySRGB, fromFilm, toCanvas;
  ${TRANSFER}
  float decode(float v){return decode(v,profile);}
  float encode(float v){return encode(v,profile);}
  float customCurve(float v,int row){
    float x=v*1023.;int i=int(clamp(floor(x),0.,1022.));
    float a=texelFetch(curves,ivec2(i,row),0).r,b=texelFetch(curves,ivec2(i+1,row),0).r;
    return mix(a,b,x-float(i));
  }
  vec3 lutValue(int i){return texelFetch(lutAtlas,ivec2(i%512,i/512),0).rgb;}
  vec4 param(int x,int n){return texelFetch(parameters,ivec2(x,n),0);}
  vec3 rangeSaturation(vec3 rgb,vec3 w,vec3 r){if(r==vec3(0))return rgb;float y=dot(rgb,w),ws=1.-smoothstep(0.,.5,y),wh=smoothstep(.5,1.,y);return y+(rgb-y)*(1.+dot(vec3(ws,1.-ws-wh,wh),r));}
  float curve(float v,vec3 p){float x=clamp(v,0.,1.)*4.;return x<1.?mix(0.,p.x,x):x<2.?mix(p.x,p.y,x-1.):x<3.?mix(p.y,p.z,x-2.):mix(p.z,1.,x-3.);}
  // Color page v3 (grading.ts): opponent space y/cb/cr on the stage's luma weights; texel 17.z holds the hue of pure red.
  vec3 opponent(vec3 c,vec3 w){float y=dot(w,c);return vec3(y,(c.b-y)/(2.*(1.-w.b)),(c.r-y)/(2.*(1.-w.r)));}
  vec3 fromOpponent(float y,vec2 c,vec3 w){float r=y+2.*(1.-w.r)*c.y,b=y+2.*(1.-w.b)*c.x;return vec3(r,(y-w.r*r-w.b*b)/w.g,b);}
  float hueOf(vec2 c,float red){return 2.*length(c)<1e-6?0.:fract((atan(c.y,c.x)-red)/6.283185307179586);}
  vec2 turn(vec2 c,float co,float si){return vec2(c.x*co-c.y*si,c.x*si+c.y*co);}
  vec3 tonal(vec3 rgb,vec3 w,float pivot,int flags,int n){
    if((flags&1)!=0){vec4 s=param(13,n),m=param(14,n);float t=clamp(dot(w,rgb),0.,1.),ws=1.-smoothstep(s.w-.1,s.w+.1,t),wh=smoothstep(m.w-.1,m.w+.1,t);rgb+=ws*s.xyz+max(0.,1.-ws-wh)*m.xyz+wh*param(15,n).xyz;}
    if((flags&2)!=0){vec2 k=param(16,n).xy;float t=clamp(dot(w,rgb),0.,1.),m=clamp(pivot,.05,.95),u=t<m?t/m:(1.-t)/(1.-m),bump=u*(1.-u)*(1.-u);rgb+=t<m?k.x*m*bump:t>m?k.y*(1.-m)*bump:0.;}
    return rgb;
  }
  vec3 chroma(vec3 rgb,vec3 w,int flags,int n){
    if((flags&4)==0)return rgb;
    vec4 h=param(16,n),k=param(17,n);vec3 o=opponent(rgb,w);vec2 c=turn(o.yz,h.z,h.w);float s=clamp(2.*length(c),0.,1.);
    return fromOpponent(o.x-k.y*s,c*(1.+k.x*(1.-s)),w);
  }
  vec3 hslCurves(vec3 rgb,vec3 w,int flags,int n){
    if((flags&8)==0)return rgb;
    vec4 k=param(17,n);int m=int(k.w),row=n*${CURVE_ROWS};vec3 o=opponent(rgb,w);vec2 c=o.yz;float s0=2.*length(c),s=clamp(s0,0.,1.),h0=hueOf(c,k.z);
    float hh=(m&1)!=0?customCurve(h0,row+4):.5,hs=(m&2)!=0?customCurve(h0,row+5):.5,hl=(m&4)!=0?customCurve(h0,row+6):.5,ls=(m&8)!=0?customCurve(clamp(o.x,0.,1.),row+7):.5,ss=(m&16)!=0?customCurve(s,row+8):.5,sl=(m&32)!=0?customCurve(s,row+9):.5;
    float t=(hh-.5)*6.283185307179586;if(t!=0.)c=turn(c,cos(t),sin(t));
    return fromOpponent(o.x+(hl-.5)*.5*smoothstep(0.,.15,s0)+(sl-.5)*.5,c*(2.*hs*2.*ls*2.*ss),w);
  }
  vec3 mixer(vec3 rgb,int flags,int n){if((flags&16)==0)return rgb;vec4 r=param(18,n);vec3 o=vec3(dot(r.xyz,rgb),dot(param(19,n).xyz,rgb),dot(param(20,n).xyz,rgb));return r.w>0.?o.xxx:o;}
  float band(float x,vec3 r){return (r.x<=0.?1.:sse(r.x-r.z,r.x,x))*(r.y>=100.?1.:1.-sse(r.y,r.y+r.z,x));}
  float qualifier(vec3 c,vec3 w,int n){
    vec4 q=param(21,n);if(q.x==0.)return 1.;
    vec3 o=opponent(c,w);float kh=1.;
    if(q.z<360.){float d=mod(abs(hueOf(o.yz,param(17,n).z)*360.-q.y),360.);kh=1.-sse(q.z/2.,q.z/2.+q.w,min(d,360.-d));}
    float a=kh*band(clamp(2.*length(o.yz),0.,1.)*100.,param(22,n).xyz)*band(clamp(o.x,0.,1.)*100.,param(23,n).xyz);
    return q.x==2.?1.-a:a;
  }
  vec2 local(vec2 d,vec2 cs){return vec2(d.x*cs.x+d.y*cs.y,-d.x*cs.y+d.y*cs.x);}
  float windows(vec2 p,int n){
    float keep=1.,aspect=pictureRect.z/pictureRect.w,a;bool any=false;
    vec4 c=param(24,n);if(c.x!=0.){vec4 s=param(25,n);float k=c.w/min(s.x,s.y);a=1.-sse(1.-k/2.,1.+k/2.,length(local(vec2((p.x-c.y)*aspect,p.y-c.z),s.zw)/s.xy));keep*=1.-(c.x==2.?1.-a:a);any=true;}
    vec4 r=param(26,n);if(r.x!=0.){vec4 s=param(27,n);float rr=param(28,n).x;vec2 q=abs(local(vec2((p.x-r.y)*aspect,p.y-r.z),s.zw))-s.xy+rr;a=1.-sse(-r.w/2.,r.w/2.,length(max(q,0.))+min(max(q.x,q.y),0.)-rr);keep*=1.-(r.x==2.?1.-a:a);any=true;}
    vec4 g=param(28,n);if(g.y!=0.){vec4 s=param(29,n);a=sse(-s.z/2.,s.z/2.,(p.x-g.z)*aspect*s.x-(p.y-g.w)*s.y);keep*=1.-(g.y==2.?1.-a:a);any=true;}
    return any?1.-keep:1.;
  }
  // A node's end: blend over its input by mask × windows × qualifier (keyed); the key view reads that alpha.
  vec3 endNode(vec3 rgb,vec3 before,vec4 mask,int n,float keyed,vec2 coord,inout float viewAlpha){
    int se=int(mask.w);if((se&2)==0)return rgb;
    float alpha=keyed;if(mask.x>=0.){float m=texture(maskAtlas,vec3(coord,mask.x)).r;alpha*=(mask.z>0.?1.-m:m)*mask.y;}
    if(n==viewStage)viewAlpha=alpha;
    return mask.x>=0.||(se&4)!=0?mix(before,rgb,alpha):rgb;
  }
  void main(){
    // Canvas pixel centre, top row first; float targets cover the picture box from \`origin\`, also top row first. A Stabilize
    // warp (\`unwarp\`: stabilized → original layer pixels) moves where the picture and its mattes are read, never the windows or film.
    vec2 pixelAt=toCanvas?vec2(gl_FragCoord.x,canvasSize.y-gl_FragCoord.y):vec2(origin)+gl_FragCoord.xy;
    vec2 coord=(unwarp*vec3(pixelAt,1.)).xy/canvasSize,maskCoord=coord,picturePos=(pixelAt-pictureRect.xy)/pictureRect.zw,frame=yuvMode>0?(coord-sourceRect.xy)/sourceRect.zw:coord;vec4 source;float viewAlpha=1.;
    bool inside=all(greaterThanEqual(frame,vec2(0)))&&all(lessThanEqual(frame,vec2(1)));
    if(fromFilm){
      ivec2 t=ivec2(pixelAt)-origin;if(any(lessThan(t,ivec2(0)))||any(greaterThanEqual(t,region))){pixel=vec4(0);return;}
      // Film changes colour only: the layer keeps the source's alpha (a title, alpha video, a picture warped off the frame).
      vec4 v=texelFetch(film,t,0);source=vec4(v.rgb,!inside?0.:yuvMode>0?1.:texture(picture,coord).a);viewAlpha=v.a;
    }else if(!inside){pixel=vec4(0);return;}
    else if(yuvMode>0){
      float y=texture(luma,frame).r;vec2 chroma=yuvMode==2?texture(chromaU,frame).rg:vec2(texture(chromaU,frame).r,texture(chromaV,frame).r);
      y=(y-yuvScale.x)*yuvScale.y;chroma=(chroma-yuvScale.z)*yuvScale.w;
      source=vec4(y+chroma.y*yuvCoefficients.x,y+dot(chroma,yuvCoefficients.yz),y+chroma.x*yuvCoefficients.w,1.);
    }else source=texture(picture,coord);
    vec3 rgb=source.rgb,nodeInput=source.rgb;float keyed=1.;
    if(!fromFilm&&!managed&&(stops!=0.||warmth!=0.)){vec3 linear=vec3(decode(rgb.r),decode(rgb.g),decode(rgb.b))*exp2(stops)*vec3(1.+warmth/10000.,1.,1.-warmth/10000.);rgb=vec3(encode(linear.r),encode(linear.g),encode(linear.b));}
    if(!fromFilm&&!managed&&!nativeView){vec3 p=(clamp((rgb-domainMin)/(domainMax-domainMin),0.,1.)*(size-1.)+.5)/size;rgb=texture(grade,p).rgb;}
    for(int n=first;n<first+count;n++){
      vec4 kind=param(7,n);if(kind.x==3.)continue;
      vec4 mask=param(12,n);int se=int(mask.w);vec3 w=param(11,n).xyz;
      if((se&1)!=0){nodeInput=rgb;keyed=(se&4)!=0?qualifier(rgb,w,n)*windows(picturePos,n):1.;}
      vec4 a=param(0,n),b=param(1,n),c=param(2,n),d=param(3,n),e=param(4,n),f=param(5,n),h=param(6,n);
      if(kind.x==1.){
        vec3 linear=decodeRGB(rgb,int(kind.y));
        linear=vec3(dot(param(8,n).xyz,linear),dot(param(9,n).xyz,linear),dot(param(10,n).xyz,linear));
        if(kind.w==2.){rgb=ocio_aces2(vec4(linear,1.)).rgb;continue;}
        if(kind.w==1.){float peak=max(0.,max(linear.r,max(linear.g,linear.b))),mapped=peak<=.6?peak:.6+.4*(1.-exp(-(peak-.6)/.4));linear*=peak>0.?mapped/peak:1.;}
        if(param(8,n).w>0.){float y=clamp(dot(w,linear),0.,1.),amount=1.;for(int i=0;i<3;i++){float delta=linear[i]-y;if(delta>0.)amount=min(amount,(1.-y)/delta);else if(delta<0.)amount=min(amount,-y/delta);}linear=vec3(y)+(linear-y)*amount;}
        rgb=encodeRGB(linear,int(kind.z));continue;
      }
      if(kind.x==2.){
        int size=int(a.y),base=int(a.x);vec3 pos=clamp((rgb-b.xyz)/(c.xyz-b.xyz),0.,1.)*float(size-1),lo=min(floor(pos),vec3(size-2)),fraction=pos-lo,result=vec3(0);
        for(int blue=0;blue<2;blue++)for(int green=0;green<2;green++)for(int red=0;red<2;red++){
          vec3 wt=mix(1.-fraction,fraction,vec3(red,green,blue));ivec3 at=ivec3(lo)+ivec3(red,green,blue);result+=lutValue(base+at.z*size*size+at.y*size+at.x)*wt.x*wt.y*wt.z;
        }
        rgb=endNode(mix(rgb,result,a.z),nodeInput,mask,n,keyed,maskCoord,viewAlpha);continue;
      }
      int flags=int(kind.z);
      if(managed){
        if(a.x!=0.||c.w!=0.||d.w!=0.)rgb=encodeRGB(decodeRGB(rgb,int(kind.y))*exp2(a.x)*vec3(1.+c.w,1.-d.w,1.-c.w),int(kind.y));
        vec3 v=rgb,x=(v-a.z)*a.y+a.z+b.w+e.xyz;
        rgb=sign(x)*pow(abs(x),vec3(1.)/exp2(b.y+c.xyz))*(b.z+d.xyz)+(b.x+f.xyz)*(1.-v);
        rgb=tonal(rgb,w,a.z,flags,n);
        float y=dot(rgb,w);rgb=chroma(rangeSaturation(y+(rgb-y)*a.w,w,param(8,n).xyz),w,flags,n);
      }else{
        vec3 v=max(vec3(0),rgb*exp2(a.x));
        rgb=pow(max(vec3(0),(v-a.z)*a.y+a.z+b.w+e.xyz),vec3(1.)/exp2(b.y+c.xyz))*(b.z+d.xyz)+(b.x+f.xyz)*(1.-min(vec3(1),v));
        rgb=tonal(rgb,w,a.z,flags,n);
        float y=dot(rgb,vec3(.2126,.7152,.0722));rgb=chroma(rangeSaturation(y+(rgb-y)*a.w,vec3(.2126,.7152,.0722),param(8,n).xyz),w,flags,n)*vec3(1.+c.w,1.-d.w,1.-c.w);
      }
      int row=n*${CURVE_ROWS};
      if(h.w==2.){rgb=vec3(customCurve(rgb.r,row),customCurve(rgb.g,row),customCurve(rgb.b,row));rgb=vec3(customCurve(rgb.r,row+1),customCurve(rgb.g,row+2),customCurve(rgb.b,row+3));}
      else if(h.w==1.)rgb=vec3(curve(rgb.r,h.xyz),curve(rgb.g,h.xyz),curve(rgb.b,h.xyz));
      rgb=endNode(mixer(hslCurves(rgb,w,flags,n),flags,n),nodeInput,mask,n,keyed,maskCoord,viewAlpha);
    }
    // Between passes the signal stays unclamped, with the key view's alpha carried in a.
    if(!toCanvas){pixel=vec4(rgb,viewAlpha);return;}
    if(viewMode==2){pixel=vec4(vec3(clamp(viewAlpha,0.,1.)),source.a);return;}
    if(displaySRGB){
      vec3 linear=pow(max(rgb,vec3(0)),vec3(2.4));
      rgb=mix(12.92*linear,1.055*pow(linear,vec3(1./2.4))-.055,greaterThan(linear,vec3(.0031308)));
      // Stable half-code dither at final SDR quantization, never in scene data.
      float noise=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5;
      rgb+=noise/255.;
    }
    if(viewMode==1)rgb=mix(vec3(.5),rgb,viewAlpha);
    pixel=vec4(clamp(rgb,0.,1.),source.a);
  }`),filmProgram=link(FILM_SHADER);
  gl.useProgram(program);
  const acesTables=acesTextures.map((t,i)=>{const texture=gl.createTexture()!;gl.activeTexture(gl.TEXTURE8+i);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage2D(gl.TEXTURE_2D,0,t.channels===1?gl.R32F:gl.RGB32F,t.width,t.height,0,t.channels===1?gl.RED:gl.RGB,gl.FLOAT,new Float32Array(t.values));gl.uniform1i(gl.getUniformLocation(program,t.sampler),8+i);return texture;});
  const maskTexture=gl.createTexture()!,maskUnit=8+acesTables.length,filmUnit=maskUnit+1,passUnit=filmUnit+1;
  const curveTexture=gl.createTexture()!,lutTexture=gl.createTexture()!;
  const picture=gl.createTexture()!, parameters=gl.createTexture()!, planes=[gl.createTexture()!,gl.createTexture()!,gl.createTexture()!],blank=gl.createTexture()!;
  const locate=(p:WebGLProgram)=>{const cache=new Map<string,WebGLUniformLocation|null>();return (name:string)=>{if(!cache.has(name))cache.set(name,gl.getUniformLocation(p,name));return cache.get(name)!;};};
  const uniform=locate(program),filmUniform=locate(filmProgram);
  gl.uniform1i(uniform('maskAtlas'),maskUnit);gl.uniform1i(uniform('film'),filmUnit);
  gl.uniform1i(uniform('curves'),6);gl.uniform1i(uniform('lutAtlas'),7);
  gl.uniform1i(uniform('picture'),0);gl.uniform1i(uniform('grade'),1);gl.uniform1i(uniform('parameters'),2);['luma','chromaU','chromaV'].forEach((name,i)=>gl.uniform1i(uniform(name),i+3));
  gl.useProgram(filmProgram);['src','glowH','glowB','carry'].forEach((name,i)=>gl.uniform1i(filmUniform(name),passUnit+i));gl.useProgram(program);
  const settings=(target:number,filter:number=gl.LINEAR)=>{gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,filter);gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);};
  type Look={texture:WebGLTexture;size:number;min:number[];max:number[]};
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,picture);settings(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
  planes.forEach((t,i)=>{gl.activeTexture(gl.TEXTURE3+i);gl.bindTexture(gl.TEXTURE_2D,t);settings(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,1,1,0,gl.RED,gl.UNSIGNED_BYTE,new Uint8Array([0]));});
  gl.activeTexture(gl.TEXTURE0+maskUnit);gl.bindTexture(gl.TEXTURE_2D_ARRAY,maskTexture);settings(gl.TEXTURE_2D_ARRAY);gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.R8,1,1,1,0,gl.RED,gl.UNSIGNED_BYTE,new Uint8Array([0]));
  // Unused pass inputs read a blank texture, never a picture the pass renders into.
  gl.activeTexture(gl.TEXTURE0+filmUnit);gl.bindTexture(gl.TEXTURE_2D,blank);settings(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
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
  type Decoded={timestamp:number;data?:Uint8Array;layout?:PlaneLayout[];width:number;height:number;displayWidth:number;displayHeight:number;format:string;space:VideoColorSpaceInit;error?:Error;requestedAt?:number;demand?:boolean};
  const nativeFrames=new WeakSet<HTMLVideoElement>();
  const snapshots=new WeakMap<VideoFrame,{pending?:Decoded;ready?:Decoded}>();
  const decoded=new WeakMap<HTMLVideoElement,{pending?:Decoded;ready?:Decoded}>();let lastFrame:Decoded|undefined;
  // Measurement only: how long each raw-plane copy took, and how often a draw had to ask for one itself (no earlier prepare) or wait.
  const probe=createCopyProbe();
  let started=0;
  const frameFor=(video:HTMLVideoElement,snapshot?:VideoFrame,demand=false)=>{
    if(nativeFrames.has(video))return undefined;
    // A picture already copied or being copied needs neither a clone nor a lookup: its timestamp never changes.
    if(snapshot){const known=snapshots.get(snapshot);if(known&&(known.pending||known.ready))return known.ready??known.pending!;}
    let frame:VideoFrame;
    try { frame=snapshot?snapshot.clone():new VideoFrame(video); } catch { nativeFrames.add(video);return undefined; }
    const state=(snapshot?snapshots.get(snapshot):decoded.get(video))??{};
    if(snapshot)snapshots.set(snapshot,state);else decoded.set(video,state);
    if(state.pending||state.ready?.timestamp===frame.timestamp){frame.close();return state.ready??state.pending!;}
    const width=frame.visibleRect?.width??frame.codedWidth,height=frame.visibleRect?.height??frame.codedHeight;
    const current:Decoded={timestamp:frame.timestamp,width,height,displayWidth:frame.displayWidth||width,displayHeight:frame.displayHeight||height,format:frame.format||'',space:frame.colorSpace.toJSON()};
    if(!['I420','I422','I444','NV12','I420P10','I422P10','I444P10','I420P12','I422P12','I444P12'].includes(current.format)){frame.close();nativeFrames.add(video);return undefined;}
    let buffer:Uint8Array<ArrayBuffer>;
    try { buffer=new Uint8Array(frame.allocationSize()); } catch { frame.close();nativeFrames.add(video);return undefined; }
    state.pending=current;started++;
    current.requestedAt=performance.now();current.demand=demand;
    // Keep presenting the completed snapshot while the next GPU readback is in flight.
    Promise.resolve().then(()=>frame.copyTo(buffer)).then(layout=>{current.layout=layout;current.data=buffer;}).catch(()=>{nativeFrames.add(video);}).finally(()=>{probe.copied(performance.now()-current.requestedAt!,!!current.demand);state.ready=current;state.pending=undefined;frame.close();onReady();});
    return state.ready??current;
  };
  let previousMasks='',previous='',previousLuts='';
  const cubeIds=new WeakMap<object,number>();let nextCube=0;
  const cubeId=(cube:object)=>{if(!cubeIds.has(cube))cubeIds.set(cube,++nextCube);return cubeIds.get(cube)!;};
  // The stages behind the parameter texture, the last draw's clip and nodes (bypassed ones too), its picture box and film frame number.
  let planned:Stage[]=[],drawn:GradeNode[]=[],drawnClip='',box=pictureBox([0,0,1,1],1,1),filmFrame=0,shownLook:Look=neutral;
  type Target={texture:WebGLTexture;fbo:WebGLFramebuffer;width:number;height:number};
  const targets=new Map<string,Target>();
  /** A float render target kept by name; a new one only when its size changes. */
  // ponytail: one target per name, so two film pictures of different shapes in one frame (a transition) reallocate each frame; key by size if that shows up.
  const target=(name:string,width:number,height:number)=>{
    const old=targets.get(name);if(old&&old.width===width&&old.height===height)return old;
    if(old){gl.deleteTexture(old.texture);gl.deleteFramebuffer(old.fbo);}
    const texture=gl.createTexture()!,fbo=gl.createFramebuffer()!;
    gl.activeTexture(gl.TEXTURE0+passUnit);gl.bindTexture(gl.TEXTURE_2D,texture);settings(gl.TEXTURE_2D,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,targetFormat,width,height,0,gl.RGBA,byteTargets?gl.UNSIGNED_BYTE:gl.FLOAT,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteTexture(texture);gl.deleteFramebuffer(fbo);throw new Error('This GPU cannot render the film stage.');}
    const made={texture,fbo,width,height};targets.set(name,made);return made;
  };
  const into=(out:Target|null)=>{gl.bindFramebuffer(gl.FRAMEBUFFER,out?out.fbo:null);gl.viewport(0,0,out?out.width:canvas.width,out?out.height:canvas.height);};
  /** Correction stages [first, first+count) from the source (or a film output) into a float target or, when `out` is null, the canvas. */
  const grade=(first:number,count:number,input:Target|null,out:Target|null,viewStage:number,viewMode:number)=>{
    gl.useProgram(program);into(out);
    gl.activeTexture(gl.TEXTURE0+filmUnit);gl.bindTexture(gl.TEXTURE_2D,input?input.texture:blank);
    gl.uniform1i(uniform('first'),first);gl.uniform1i(uniform('count'),count);gl.uniform1i(uniform('fromFilm'),input?1:0);gl.uniform1i(uniform('toCanvas'),out?0:1);gl.uniform1i(uniform('viewStage'),viewStage);gl.uniform1i(uniform('viewMode'),viewMode);
    gl.drawArrays(gl.TRIANGLES,0,3);
  };
  /** One film stage on a whole picture (`input`, the box size); returns the target holding its encoded result. */
  const film=(stage:FilmStage,input:Target)=>{
    const {p,weights}=stage,{width,height}=input,u=filmUniform,{ox,oy,breath}=filmMotion(p,filmFrame),L=target('L',width,height),B=target('B',width,height);
    const pass=(index:number,out:Target,src:Target,srcMode=0,glowH=blank,glowB=blank,carry=blank)=>{
      [src.texture,glowH,glowB,carry].forEach((t,i)=>{gl.activeTexture(gl.TEXTURE0+passUnit+i);gl.bindTexture(gl.TEXTURE_2D,t);});
      into(out);gl.uniform1i(u('pass'),index);gl.uniform1i(u('srcMode'),srcMode);gl.drawArrays(gl.TRIANGLES,0,3);
    };
    gl.useProgram(filmProgram);
    gl.uniform1i(u('profile'),profiles.indexOf(stage.gamma as typeof profiles[number]));gl.uniform3fv(u('weights'),weights);gl.uniform2f(u('size'),width,height);
    gl.uniform2f(u('thresholds'),.18*2**p.filmHalationThreshold,.18*2**p.filmBloomThreshold);gl.uniform4f(u('motion'),ox/(width/height),oy,.004*p.filmAberration/100,2**breath);
    pass(0,L,input);
    // filmBlur: box halvings until σ' < 8, a separable Gaussian there; the final pass upsamples it bilinearly. σ < .5 is no blur.
    const blur=(name:string,sigma:number,mode:number)=>{
      if(sigma<.5)return null;
      const levels=Math.max(0,Math.floor(Math.log2(sigma/4)));let src=L,srcMode=mode;
      for(let level=0;level<levels;level++){const out=target(name+level,Math.ceil(src.width/2),Math.ceil(src.height/2));pass(1,out,src,srcMode);src=out;srcMode=0;}
      const s=sigma/2**levels,across=target(name+'x',src.width,src.height),down=target(name+'y',src.width,src.height);
      gl.uniform1f(u('sigma'),s);gl.uniform1i(u('radius'),Math.ceil(3*s));
      gl.uniform1i(u('horizontal'),1);pass(2,across,src,srcMode);gl.uniform1i(u('horizontal'),0);pass(2,down,across);
      return down;
    };
    const halation=p.filmHalation>0?blur('h',p.filmHalationRadius/100*height,1):undefined,bloom=p.filmBloom>0?blur('b',p.filmBloomRadius/100*height,2):undefined;
    const warm=.3*p.filmBloomWarmth/100,frame=p.filmGrainStatic>=.5?0:filmFrame,keys=[0,1,2,3].map(c=>grainKey(p.filmGrainSeed,frame,c));
    gl.uniform1i(u('halMode'),halation===undefined?0:halation?2:1);gl.uniform1i(u('bloomMode'),bloom===undefined?0:bloom?2:1);
    gl.uniform2f(u('gains'),p.filmHalation/100*.25,p.filmBloom/100*.5);gl.uniform3fv(u('tint'),halationTint(p));gl.uniform3f(u('bloomTint'),1+warm,1,1-warm);
    gl.uniform4f(u('vignette'),1+(width/height-1)*p.filmVignetteRoundness/100,p.filmVignetteSize/100,Math.max(.01,p.filmVignetteSoftness/100),p.filmVignette/100);
    gl.uniform4f(u('grain'),p.filmGrain>0?.1*p.filmGrain/100:0,p.filmGrainResponse/100,p.filmGrainColor/100,1080/p.filmGrainSize/height);gl.uniform4ui(u('keys'),keys[0],keys[1],keys[2],keys[3]);
    pass(3,B,L,0,halation?.texture??blank,bloom?.texture??blank,input.texture);
    return B;
  };
  /** Stages [0, end): segments between film stages into float targets, film passes between them, the last segment into `out` (null = canvas). */
  const render=(end:number,out:Target|null,viewStage=-1,viewMode=0)=>{
    let input:Target|null=null,at=0;
    if(box.width&&box.height)for(let i=0;i<end;i++){const stage=planned[i];if(stage.type!=='film')continue;const a=target('A',box.width,box.height);grade(at,i-at,input,a,viewStage,0);input=film(stage,a);at=i+1;}
    grade(at,end-at,input,out,viewStage,viewMode);
  };
  /** Where `nodeId`'s input is among the planned stages: its first one; for a bypassed node of the drawn clip, the first of the
   *  next enabled node after it (the end when none follows); -1 when the drawn clip does not own the node. */
  const inputAt=(nodeId:string)=>{
    const start=planned.findIndex(s=>s.type!=='film'&&s.node.id===nodeId&&s.nodeStart),node=drawn.find(n=>n.id===nodeId&&n.clipId===drawnClip&&!n.enabled);
    if(start>=0||!node)return start;
    const next=planned.findIndex(s=>s.type!=='film'&&s.nodeStart&&(s.node.order??0)>(node.order??0));return next<0?planned.length:next;
  };
  /** The output of stages [0, start) (film included) at picture position (px, py), averaged over 5×5 pixels. */
  const probeInput=(start:number,px:number,py:number)=>{
    const {rect,x0,y0,width,height}=box;
    if(!width||!height||!Number.isFinite(px)||!Number.isFinite(py))return null;
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,shownLook.texture);
    const a=target('A',width,height);render(start,a);
    const w=Math.min(5,width),h=Math.min(5,height),x=Math.max(0,Math.min(width-w,Math.floor(rect[0]+px*rect[2])-x0-2)),y=Math.max(0,Math.min(height-h,Math.floor(rect[1]+py*rect[3])-y0-2));
    const values=byteTargets?new Uint8Array(w*h*4):new Float32Array(w*h*4);gl.bindFramebuffer(gl.FRAMEBUFFER,a.fbo);gl.readPixels(x,y,w,h,gl.RGBA,byteTargets?gl.UNSIGNED_BYTE:gl.FLOAT,values);into(null);
    const sum=[0,0,0];for(let i=0;i<w*h;i++)for(let c=0;c<3;c++)sum[c]+=values[i*4+c];
    return sum.map(v=>v/(w*h)/(byteTargets?255:1));
  };
  /** Answers `probe` from the current draw when its clip owns the node; a failed read asks to pick again. */
  const answer=(probe:Probe)=>{
    const start=inputAt(probe.nodeId);if(start<0)return false;
    let rgb:number[]|null=null;try{rgb=probeInput(start,probe.px,probe.py);}catch{/* null: pick again */}
    probe.resolve(rgb);return true;
  };

  return {
    preload,
    probe:probe.read,
    /** Starts the raw-plane copy of this picture if none is under way; true when it started one. */
    prepare(video: HTMLVideoElement, snapshot?: VideoFrame): boolean {
      const before = started;
      if (typeof VideoFrame !== 'undefined' && (snapshot || video.readyState >= 2 && !video.seeking)) frameFor(video,snapshot);
      return started !== before;
    },
    /** `filmAt`: the film stage's frame number when the picture has no source clock (a still, title or adjustment clip), as export counts it.
     *  `warp`: the layer's Stabilize warp (setTransform arguments, original → stabilized layer pixels); the grade then reads the
     *  stabilized picture and mattes, as export grades the stabilized bake, and the result needs no further warp. */
    draw(source:HTMLCanvasElement,clip:Clip,asset:MediaAsset,nodes:GradeNode[],video?:HTMLVideoElement,masks:Map<string,SmartMaskPixels>|((time:number)=>Map<string,SmartMaskPixels>)=new Map(),snapshot?:VideoFrame,filmAt?:number,warp?:Affine) {
      if(lastDraw===answer)lastDraw=undefined;
      const key=preload(clip,asset),look=key?looks.get(key):neutral;
      if(look instanceof Error)throw look;if(!look)throw new ColorPending('Preparing color…');
      const frame=video&&typeof VideoFrame!=='undefined'?frameFor(video,snapshot,true):undefined;
      if(frame?.error)throw frame.error;if(frame&&!frame.data){probe.waited(!!frame.demand);throw new ColorPending('Decoding color…');}
      const maskPixels=typeof masks==='function'?masks(snapshot?snapshot.timestamp/1e6:frame?frame.timestamp/1e6:video?.currentTime??0):masks;
      const {profile,gamut}=interpretation(clip,asset),stops=Number(clip.properties.inputExposure??0),warmth=Number(clip.properties.inputTemperature??0);
      if(!Number.isFinite(stops)||Math.abs(stops)>8||!Number.isFinite(warmth)||Math.abs(warmth)>2000)throw new Error('Camera exposure or white balance is out of range.');
      gl.useProgram(program);
      // Node ids too: a pasted grade (new ids, same values) must re-plan, or the probe and key view look for the old nodes.
      const controls=JSON.stringify([clip.id,clip.properties.colorPipeline,profile,gamut,nodes.map(({id,enabled,order,parameters,curves,effects,mask})=>({id,enabled,order,parameters,curves,mask,effects:effects?.map(e=>e.type==='lut'?{...e,cube:cubeId(e.cube)}:e)}))]);
      const maskIds=[...new Set(nodes.filter(n=>n.enabled&&n.clipId===clip.id&&n.mask?.enabled).map(n=>nodeMaskId(n)!))];
      const maskKey=JSON.stringify([source.width,source.height,maskIds.map(id=>maskPixels.get(id)?.key??id)]);
      if(maskKey!==previousMasks){
        const alpha=new Uint8Array(Math.max(1,maskIds.length)*source.width*source.height);
        maskIds.forEach((id,i)=>{const data=maskPixels.get(id);if(!data){if(nodes.some(n=>n.enabled&&nodeMaskId(n)===id&&n.mask!.enabled&&n.mask!.amount>0))throw new ColorPending('Loading Smart Mask…');return;}alpha.set(data.data,i*source.width*source.height);});
        gl.activeTexture(gl.TEXTURE0+maskUnit);gl.bindTexture(gl.TEXTURE_2D_ARRAY,maskTexture);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.R8,source.width,source.height,Math.max(1,maskIds.length),0,gl.RED,gl.UNSIGNED_BYTE,alpha);previousMasks=maskKey;
      }
      if(controls!==previous){
        const interpreted={...clip,properties:{...clip.properties,inputProfile:profile,inputGamut:gamut}};
        const stages=processingStages(interpreted,nodes),height=Math.max(1,stages.length);if(height*CURVE_ROWS>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw new Error('Too many correction stages for this GPU.');
        const {data,curveData,lutOffset,lutEffects}=packStages(clip,stages,maskIds);
        gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,curveTexture);settings(gl.TEXTURE_2D,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,1024,height*CURVE_ROWS,0,gl.RED,gl.FLOAT,curveData);
        const lutKey=JSON.stringify(lutEffects.map(s=>cubeId(s.effect.cube)));
        if(lutKey!==previousLuts){
          const lutHeight=Math.max(1,Math.ceil(lutOffset/512));if(lutHeight>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw Error('LUT stack exceeds GPU memory limits.');
          const atlas=new Float32Array(512*lutHeight*4);let at=0;for(const stage of lutEffects){const d=stage.effect.cube.data;for(let j=0;j<d.length;j+=3){atlas.set([d[j],d[j+1],d[j+2],1],at);at+=4;}}
          gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,lutTexture);settings(gl.TEXTURE_2D,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,512,lutHeight,0,gl.RGBA,gl.FLOAT,atlas);previousLuts=lutKey;
        }
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,parameters);settings(gl.TEXTURE_2D,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,STAGE_TEXELS,height,0,gl.RGBA,gl.FLOAT,data);planned=stages;previous=controls;
      }
      gl.uniform1i(uniform('managed'),clip.properties.colorPipeline==='nodes-v2'?1:0);
      gl.uniform1i(uniform('displaySRGB'),hasACES(nodes,clip.id)?1:0);
      gl.uniform1i(uniform('nativeView'),key?0:1);
      gl.uniform1i(uniform('profile'),profiles.indexOf(profile as typeof profiles[number]));gl.uniform1f(uniform('stops'),stops);gl.uniform1f(uniform('warmth'),warmth);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,look.texture);gl.uniform1f(uniform('size'),look.size);gl.uniform3fv(uniform('domainMin'),look.min);gl.uniform3fv(uniform('domainMax'),look.max);shownLook=look;
      if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height;}
      let rect=pictureRect(asset,canvas.width,canvas.height);
      gl.uniform1i(uniform('yuvMode'),frame?frame.format==='NV12'?2:1:0);
      if(frame){
        // Worker-decoded frames have their own display geometry; the unused video element has no metadata.
        const fit=Math.min(source.width/frame.displayWidth,source.height/frame.displayHeight),w=frame.displayWidth*fit/source.width,h=frame.displayHeight*fit/source.height;
        gl.uniform4f(uniform('sourceRect'),(1-w)/2,(1-h)/2,w,h);rect=[(1-w)/2*canvas.width,(1-h)/2*canvas.height,w*canvas.width,h*canvas.height];
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
      const time=snapshot?snapshot.timestamp/1e6:frame?frame.timestamp/1e6:video?Math.floor(video.currentTime*(asset.fps||24)+1e-6)/(asset.fps||24):0;
      canvas.dataset.sourceTimestamp=String(time);filmFrame=filmAt??Math.round(time*(asset.fps||24));
      box=pictureBox(rect,canvas.width,canvas.height);
      gl.uniform4fv(uniform('pictureRect'),rect);gl.uniform2f(uniform('canvasSize'),canvas.width,canvas.height);gl.uniform2i(uniform('origin'),box.x0,box.y0);gl.uniform2i(uniform('region'),box.width,box.height);
      const u=warp?invert(warp):[1,0,0,1,0,0];gl.uniformMatrix3fv(uniform('unwarp'),false,[u[0],u[1],0,u[2],u[3],0,u[4],u[5],1]);
      // Key view: the selected node's alpha as a matte (stages up to that node only), or the grade over grey where it is 0.
      const viewed=colorView.mode!=='off'&&nodes.some(n=>n.id===colorView.nodeId&&n.enabled&&n.clipId===clip.id)?planned.findIndex(s=>s.type!=='film'&&s.node.id===colorView.nodeId&&s.nodeEnd):-1;
      const viewMode=viewed<0?0:colorView.mode==='matte'?2:1;
      render(viewMode===2?viewed+1:planned.length,null,viewed,viewMode);
      // Picks waiting for this clip's nodes read this frame while its textures are bound.
      drawn=nodes;drawnClip=clip.id;for(const probe of probes)if(answer(probe))probes.delete(probe);
      lastDraw=answer;
      return canvas;
    },
    dispose(){if(lastDraw===answer)lastDraw=undefined;worker.terminate();gl.deleteTexture(neutral.texture);for(const look of looks.values())if(look&&!(look instanceof Error))gl.deleteTexture(look.texture);for(const t of targets.values()){gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.fbo);}targets.clear();gl.deleteTexture(picture);gl.deleteTexture(parameters);gl.deleteTexture(maskTexture);gl.deleteTexture(curveTexture);gl.deleteTexture(lutTexture);gl.deleteTexture(blank);planes.forEach(t=>gl.deleteTexture(t));acesTables.forEach(t=>gl.deleteTexture(t));gl.deleteProgram(program);gl.deleteProgram(filmProgram);gl.getExtension('WEBGL_lose_context')?.loseContext();looks.clear();},
  };
}

/**
 * Each stage as one STAGE_TEXELS-texel row of the shader's parameter texture, plus its CURVE_ROWS curve rows. Texel 7 is
 * [kind (0 correction, 1 CST, 2 LUT, 3 film), gamma, v3 flags (1 log wheels, 2 Shadows/Highlights, 4 hue/boost/density,
 * 8 HSL curves, 16 mixer), 0]; texel 8 holds range saturation as factor − 1; texel 11 the stage's luma weights; texel 12
 * [mask layer, amount, invert, 1 node start + 2 node end + 4 qualifier or window]; texels 13–29 the v3 tools.
 */
export function packStages(clip:Clip,stages:ReturnType<typeof processingStages>,maskIds:string[]){
  const height=Math.max(1,stages.length),S=STAGE_TEXELS*4,data=new Float32Array(height*S),curveData=new Float32Array(1024*height*CURVE_ROWS);
  let lutOffset=0;const lutEffects:Extract<ReturnType<typeof processingStages>[number],{type:'lut'}>[]=[];
  stages.forEach((stage,i)=>{
    const row=i*S;
    if(stage.type==='film'){data[row+28]=3;return;}
    const mask=stage.node.mask,keyed=hasWindow(stage.node.parameters)||hasQualifier(stage.node.parameters);
    data.set([mask?.enabled?maskIds.indexOf(nodeMaskId(stage.node)!):-1,(mask?.amount??100)/100,mask?.invert?1:0,(stage.nodeStart?1:0)+(stage.nodeEnd?2:0)+(keyed?4:0)],row+48);
    if(stage.type==='cst'){
      const e=stage.effect;data.set([1,profiles.indexOf(e.inputGamma as typeof profiles[number]),profiles.indexOf(e.outputGamma as typeof profiles[number]),e.toneMapping==='aces2'?2:e.toneMapping==='shoulder'?1:0],row+28);
      stage.matrix.forEach((r,j)=>data.set([...r,j===0&&e.gamutMapping==='compress'?1:0],row+32+j*4));data.set(luminanceWeights(e.outputGamut),row+44);
    }else if(stage.type==='lut'){
      const e=stage.effect;data.set([lutOffset,e.cube.size,e.amount,0,...e.cube.min,0,...e.cube.max,0],row);data[row+28]=2;lutOffset+=e.cube.size**3;lutEffects.push(stage);
    }else if(stage.type==='correction'){
      const {g,extra:p,node}=stage,w=stage.weights,v=(k:string)=>p[k]??PARAM[k].initial;
      data.set([(p.saturationShadows??100)/100-1,(p.saturationMidtones??100)/100-1,(p.saturationHighlights??100)/100-1],row+32);
      data.set([g.exposure,g.contrast,g.pivot,g.saturation,g.lift,g.gamma,g.gain,g.offset,p.gammaR??0,p.gammaG??0,p.gammaB??0,clip.properties.colorPipeline==='nodes-v2'?g.temperature/10000:Math.max(-.5,Math.min(.5,g.temperature/10000)),p.gainR??0,p.gainG??0,p.gainB??0,clip.properties.colorPipeline==='nodes-v2'?g.tint/200:Math.max(-.5,Math.min(.5,g.tint/200)),p.offsetR??0,p.offsetG??0,p.offsetB??0,0,p.liftR??0,p.liftG??0,p.liftB??0,0,p.curve25??.25,p.curve50??.5,p.curve75??.75,node.curves?2:Object.keys(p).some(k=>k.startsWith('curve'))?1:0,0,profiles.indexOf(stage.gamma as typeof profiles[number]),0,0],row);
      data.set(w,row+44);
      // v3 tools (grading.ts), with identity skipped by the flags exactly where the CPU skips it.
      const range=(r:string)=>['R','G','B'].map(c=>(p[`log${r}`]??0)+(p[`log${r}${c}`]??0)),shadow=range('Shadow'),mid=range('Mid'),high=range('Highlight');
      const sh=p.shadows??0,hl=p.highlights??0,hue=(p.hue??0)*Math.PI/180,boost=p.boost??0,density=p.density??0,mono=on(p.mixMono);
      const mix=['RR','RG','RB','GR','GG','GB','BR','BG','BB'].map(k=>v('mix'+k)),curves=HSL_CURVES.reduce((m,k,j)=>node.curves?.[k]?m|1<<j:m,0);
      data[row+30]=([...shadow,...mid,...high].some(Boolean)?1:0)|(sh||hl?2:0)|(p.hue||boost||density?4:0)|(curves?8:0)|(mono||mix.some((x,j)=>x!==(j%4===0?1:0))?16:0);
      const angle=(k:string)=>v(k)*Math.PI/180,mode=(k:string)=>on(p[k+'On'])?on(p[k+'Invert'])?2:1:0,hw=v('rectW')/2,hh=v('rectH')/2;
      data.set([
        ...shadow,v('logLowRange'),...mid,v('logHighRange'),...high,0,
        sh/100*(sh>0?2:1),hl/100*(hl<0?2:1),Math.cos(hue),Math.sin(hue),boost/100,density/100*.2,Math.atan2(.5,-w[0]/(2*(1-w[2]))),curves,
        mix[0],mix[1],mix[2],mono?1:0,mix[3],mix[4],mix[5],0,mix[6],mix[7],mix[8],0,
        mode('qual'),v('qualHue'),v('qualHueWidth'),v('qualHueSoft'),v('qualSatLow'),v('qualSatHigh'),v('qualSatSoft'),0,v('qualLumLow'),v('qualLumHigh'),v('qualLumSoft'),0,
        mode('circ'),v('circX'),v('circY'),v('circSoft'),v('circW'),v('circH'),Math.cos(angle('circAngle')),Math.sin(angle('circAngle')),
        mode('rect'),v('rectX'),v('rectY'),v('rectSoft'),hw,hh,Math.cos(angle('rectAngle')),Math.sin(angle('rectAngle')),
        v('rectRound')*Math.min(hw,hh),mode('grad'),v('gradX'),v('gradY'),Math.sin(angle('gradAngle')),Math.cos(angle('gradAngle')),v('gradSoft'),0,
      ],row+52);
      if(node.curves)for(const [c,key]of ['RGB','R','G','B',...HSL_CURVES].entries()){
        const own=node.curves[key as 'RGB'];if(c>3&&!own)continue;
        // Hue curves are periodic: sample j/1023 wraps to 0 at j = 1023, so the shader's plain linear read wraps too.
        const curve=c<4?own??identityCurve():HUE_CURVES.includes(key)?periodicCurve(own!):own!,hueRow=HUE_CURVES.includes(key);
        for(let x=0;x<1024;x++){const at=x/1023;curveData[(i*CURVE_ROWS+c)*1024+x]=sampleCurve(hueRow?at-Math.floor(at):at,curve);}
      }
    }
  });
  return {data,curveData,lutOffset,lutEffects};
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
    preload,probe:createCopyProbe().read,prepare(_video:HTMLVideoElement,_snapshot?:VideoFrame):boolean{return false;},
    draw(source:HTMLCanvasElement,clip:Clip,asset:MediaAsset,nodes:GradeNode[],video?:HTMLVideoElement,masks:Map<string,SmartMaskPixels>|((time:number)=>Map<string,SmartMaskPixels>)=new Map(),snapshot?:VideoFrame,filmAt?:number,warp?:Affine){
      const key=preload(clip,asset),look=key?looks.get(key):undefined;
      if(look instanceof Error)throw look;if(key&&!look)throw new ColorPending('Preparing color…');
      if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height;}
      context.clearRect(0,0,canvas.width,canvas.height);if(warp)context.setTransform(...warp);context.drawImage(source,0,0);context.setTransform(1,0,0,1,0,0);
      if(hasACES(nodes,clip.id))throw Error('ACES preview requires WebGL2. Enable browser graphics acceleration or use a supported browser.');
      const maskPixels=typeof masks==='function'?masks(snapshot?snapshot.timestamp/1e6:video?.currentTime??0):masks;
      const W=canvas.width,H=canvas.height,rect=pictureRect(asset,W,H),windows=new Map(nodes.map(n=>[`window:${n.id}`,n.parameters])),back=warp&&invert(warp);
      // Windows read the pixel's picture position; Smart Masks their fitted alpha, where a warped pixel came from.
      const from=(i:number)=>{if(!back)return i;const q=apply(back,i%W+.5,Math.floor(i/W)+.5),x=Math.floor(q.x),y=Math.floor(q.y);return x<0||y<0||x>=W||y>=H?-1:y*W+x;};
      let at=0;const maskAt=(id:string)=>{const p=windows.get(id);if(p)return windowAlpha((at%W+.5-rect[0])/rect[2],(Math.floor(at/W)+.5-rect[1])/rect[3],rect[2]/rect[3],p);const mask=maskPixels.get(id);if(!mask)throw new ColorPending('Loading Smart Mask…');return (mask.data[from(at)]??0)/255;};
      const pixels=context.getImageData(0,0,W,H),data=pixels.data,{profile,gamut}=interpretation(clip,asset);
      // Film stages split the nodes: each part grades per pixel, applyFilm runs on the whole picture between parts.
      const films=processingStages({...clip,properties:{...clip.properties,inputProfile:profile,inputGamut:gamut}},nodes).filter((s):s is FilmStage=>s.type==='film'),parts:GradeNode[][]=[[]];
      for(const n of nodes.filter(n=>n.enabled&&n.clipId===clip.id).sort((a,b)=>(a.order??0)-(b.order??0))){parts.at(-1)!.push(n);if(filmActive(n.parameters))parts.push([]);}
      const transforms=parts.map((part,k)=>k?colorTransform({...clip,properties:{...clip.properties,inputProfile:films[k-1].gamma,inputGamut:films[k-1].gamut,inputExposure:0,inputTemperature:0}},asset,part,undefined,maskAt):colorTransform(clip,asset,part,look??undefined,maskAt));
      const box=pictureBox(rect,W,H);
      if(!films.length||!box.width||!box.height){
        // ponytail: exact per-pixel fallback is slow without a GPU; move to a worker if software-only devices are common.
        const all=(rgb:number[])=>transforms.reduce((v,t)=>t(v),rgb);
        for(let i=0;i<data.length;i+=4){at=i/4;if(!data[i+3])continue;const rgb=all([data[i]/255,data[i+1]/255,data[i+2]/255]);for(let c=0;c<3;c++)data[i+c]=rgb[c]*255;}
      }else{
        const {x0,y0,width,height}=box,each=(f:(i:number)=>void)=>{for(let y=0;y<height;y++)for(let x=0;x<width;x++){at=(y0+y)*W+x0+x;f(y*width+x);}};
        let rgb:Float32Array=new Float32Array(width*height*3);each(i=>rgb.set(transforms[0]([data[at*4]/255,data[at*4+1]/255,data[at*4+2]/255]),i*3));
        const time=snapshot?snapshot.timestamp/1e6:video?Math.floor(video.currentTime*(asset.fps||24)+1e-6)/(asset.fps||24):0;
        films.forEach((film,k)=>{const filmed=applyFilm(rgb,width,height,film,filmAt??Math.round(time*(asset.fps||24)));each(i=>filmed.set(transforms[k+1](Array.from(filmed.subarray(i*3,i*3+3))),i*3));rgb=filmed;});
        // Film changes colour only: each pixel keeps the source's alpha.
        each(i=>{for(let c=0;c<3;c++)data[at*4+c]=rgb[i*3+c]*255;});
      }
      context.putImageData(pixels,0,0);
      canvas.dataset.sourceTimestamp=String(snapshot?snapshot.timestamp/1e6:video?Math.floor(video.currentTime*(asset.fps||24)+1e-6)/(asset.fps||24):0);
      return canvas;
    },
    dispose(){worker.terminate();looks.clear();},
  };
}
