// Depth effects on the editor's GPU: docs/superpowers/specs/2026-10-03-depth-fx-math.md, sections 0-6, exactly.
// scripts/depth-fx.py runs the same math for export; the parity check feeds both the same pixels (depthFxPixels).
import { effectDefinitions } from './effects.ts';

export type DepthFxParams = Record<'amount' | 'blur' | 'focus' | 'range' | 'nearBlur' | 'bokeh' | 'fog' | 'fogStart' | 'fogDensity' | 'fogHue' | 'fogSaturation' | 'fogBrightness' | 'fogHorizon' | 'glow' | 'glowThreshold' | 'glowRadius' | 'glowStart' | 'light' | 'lightStart' | 'lightSoftness' | 'bgExposure' | 'bgSaturation' | 'bgWarmth' | 'bgContrast', number>;
export const depthFxKeys = effectDefinitions.Depth.parameters.map(p => p.key) as (keyof DepthFxParams)[];
export type DepthFxInput = {
  params: DepthFxParams;
  /** Stored depth, 0..255 per sample (R8), `key` changes when the pixels do. */
  depth: { data: Uint8Array; width: number; height: number; key: string };
  near: number; far: number;
  /** The original's size: depth sits in its letterboxed box, never the proxy's. */
  sourceWidth: number; sourceHeight: number;
  /** The Stabilize warp as setTransform arguments (original layer px to output px); depth is sampled through it. */
  warp?: readonly [number, number, number, number, number, number];
  /** Gather tap budget N. */
  taps: number;
  view?: 'effect' | 'map';
  /** Interleaved-gradient dither of the 8-bit depth inside Fog; off for parity checks. */
  dither?: boolean;
};

const MAX_TAPS = 128, MAX_GLOW = 64;
/** Preview tap budget: 16 at 1/4, 32 at Stream or 1/2, 48 at Full and above; half as many again while paused. */
export function depthTapBudget(quality: string, original: boolean, playing: boolean) {
  const base = original || quality === 'Full' || quality === 'Color' ? 48 : quality === '1/4' ? 16 : 32;
  return playing ? base : Math.round(base * 1.5);
}
/** Section 4's gather points in working pixels: [dx, dy, r] per tap, golden-angle spiral; empty when Rb < 1. */
export function depthTaps(Rb: number, N: number): [number, number, number][] {
  if (!(Rb >= 1) || !(N > 0)) return [];
  const RS = Math.max(.5, Rb * Rb / (2 * N)), taps: [number, number, number][] = [];
  for (let r = RS, ang = 0; r < Rb && taps.length < MAX_TAPS; ang += 2.39996323, r += RS / r) taps.push([Math.cos(ang) * r, Math.sin(ang) * r, r]);
  return taps;
}
/** Circle of confusion in output pixels for distance D (0..1) on a W-wide picture. */
export function depthCoc(D: number, p: Pick<DepthFxParams, 'blur' | 'focus' | 'range' | 'nearBlur'>, W: number) {
  const R = p.blur / 100 * .025 * W, delta = D - p.focus / 100;
  return R * Math.min(1, Math.max(0, (Math.abs(delta) - p.range / 100 * .5) / .35)) * (delta < 0 ? p.nearBlur / 100 : 1);
}
/** Normalised one-sided Gaussian weights (centre first), truncated at 3σ. */
export function glowWeights(sigma: number) {
  const radius = Math.min(MAX_GLOW - 1, Math.floor(3 * sigma)), weights = Array.from({ length: radius + 1 }, (_, i) => sigma > 0 ? Math.exp(-i * i / (2 * sigma * sigma)) : Number(i === 0));
  const total = weights.reduce((sum, w, i) => sum + (i ? 2 * w : w), 0);
  return weights.map(w => w / total);
}
function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

const VERTEX = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;
const COMMON = `#version 300 es
precision highp float;precision highp sampler2D;
float lum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 lin(vec3 c){return pow(max(c,vec3(0)),vec3(2.2));}
vec3 enc(vec3 c){return pow(max(c,vec3(0)),vec3(1./2.2));}
float sstep(float a,float b,float t){b=max(b,a+1e-4);float x=clamp((t-a)/(b-a),0.,1.);return x*x*(3.-2.*x);}
`;
// Every pass but the last renders into a texture whose row 0 is the picture's top row, so gl_FragCoord is the
// top-left pixel coordinate (pixel centres at i+.5) there; the last pass flips onto the canvas.
const PREP = `${COMMON}
uniform sampler2D image,depthMap;uniform vec2 size,depthSize,nearFar;uniform vec4 box,lightA,lightB,fogA,lens;uniform mat3 unwarp,warp;uniform vec3 fogColour;uniform float dither;
layout(location=0) out vec4 colour;layout(location=1) out vec4 aux;
float dist(float s){return clamp((nearFar.x-s)/max(nearFar.x-nearFar.y,1e-4),0.,1.);}
float depthAt(ivec2 t){return texelFetch(depthMap,t,0).r;}
void main(){
  vec2 p=gl_FragCoord.xy;vec4 src=texture(image,p/size);vec3 I=src.rgb;
  vec2 P=(unwarp*vec3(p,1.)).xy-box.xy;
  float inside=float(P.x>=0.&&P.y>=0.&&P.x<box.z&&P.y<box.w),D=0.;
  if(inside>0.){
    vec2 q=P*depthSize/box.zw-.5,f=floor(q);ivec2 last=ivec2(depthSize)-1;
    float g=lum(I),sw=0.,sd=0.;
    for(int j=-1;j<=2;j++)for(int i=-1;i<=2;i++){
      ivec2 t=clamp(ivec2(f)+ivec2(i,j),ivec2(0),last);vec2 d=q-vec2(t);
      vec2 at=(warp*vec3((vec2(t)+.5)*box.zw/depthSize+box.xy,1.)).xy;
      float gt=lum(texture(image,at/size).rgb),w=exp(-dot(d,d)*.5)*exp(-(g-gt)*(g-gt)/.02);
      sw+=w;sd+=w*dist(depthAt(t));
    }
    if(sw<1e-6){
      ivec2 a=clamp(ivec2(f),ivec2(0),last),b=clamp(ivec2(f)+1,ivec2(0),last);vec2 r=q-f;
      D=dist(mix(mix(depthAt(a),depthAt(ivec2(b.x,a.y)),r.x),mix(depthAt(ivec2(a.x,b.y)),depthAt(b),r.x),r.y));
    }else D=sd/sw;
  }
  vec3 L0=lin(I),L=L0;
  if(lightA.x>0.&&inside>0.){
    float a=lightA.x*sstep(lightA.y,lightA.y+max(lightA.z,.01),D);
    vec3 c=L0*exp2(lightA.w);
    c*=vec3(1.+.12*lightB.x,1.+.02*lightB.x,1.-.12*lightB.x);
    c=.18*pow(max(c,vec3(1e-10))/.18,vec3(lightB.y));
    float Y=lum(c);c=Y+(c-Y)*lightB.z;
    L=mix(L0,max(c,vec3(0)),a);
  }
  if(fogA.x>0.&&inside>0.){
    float n=fract(52.9829189*fract(dot(floor(p),vec2(.06711056,.00583715))));
    float Df=clamp(D+(n-.5)*dither,0.,1.),base=1.-exp(-fogA.z*max(0.,Df-fogA.y)/max(1.-fogA.y,.05));
    float v=p.y/size.y,hz=1.+2.*fogA.w*(1.-v)*(1.-v);
    L=mix(L,fogColour,clamp(fogA.x*base*hz,0.,1.));
  }
  float delta=D-lens.y;
  colour=vec4(L,src.a);
  aux=vec4(D,inside*lens.x*clamp((abs(delta)-lens.z)/.35,0.,1.)*(delta<0.?lens.w:1.),inside,0);
}`;
/** Area filter onto a smaller grid; `bright` (glow) runs section 5's bright pass on every source pixel first. */
const area = (glow: boolean) => `${COMMON}
uniform sampler2D colourTex,auxTex;uniform vec2 size,small;uniform float s;uniform vec2 glowA;
layout(location=0) out vec4 colour;${glow ? '' : 'layout(location=1) out vec4 aux;'}
void main(){
  vec2 k=size/small,a=(gl_FragCoord.xy-.5)*k,b=a+k;ivec2 lo=ivec2(floor(a)),hi=min(ivec2(ceil(b))-1,ivec2(size)-1);
  vec4 c=vec4(0),x=vec4(0);float total=0.;
  for(int y=lo.y;y<=hi.y;y++)for(int i=lo.x;i<=hi.x;i++){
    vec2 o=min(b,vec2(i,y)+1.)-max(a,vec2(i,y));float w=o.x*o.y;
    vec4 L=texelFetch(colourTex,ivec2(i,y),0),A=texelFetch(auxTex,ivec2(i,y),0);
    ${glow ? 'L.rgb*=clamp((lum(enc(L.rgb))-glowA.x)/max(1.-glowA.x,.01),0.,1.)*sstep(glowA.y,glowA.y+.15,A.x)*A.z;' : ''}
    c+=L*w;x+=A*w;total+=w;
  }
  colour=c/total;${glow ? '' : 'aux=vec4(x.x/total,x.y/total*s,x.z/total,0);'}
}`;
const GATHER = `${COMMON}
uniform sampler2D colourTex,auxTex;uniform vec2 small;uniform vec4 taps[${MAX_TAPS}];uniform int count;uniform float bokeh;
out vec4 colour;
float hw(vec3 c){return 1.+bokeh*8.*max(lum(c)-.7,0.);}
void main(){
  vec2 c=gl_FragCoord.xy;vec3 L=texelFetch(colourTex,ivec2(c),0).rgb;vec2 A=texelFetch(auxTex,ivec2(c),0).xy;
  float h=hw(L),wsum=h;vec3 acc=L*h;
  for(int i=0;i<${MAX_TAPS};i++){
    if(i>=count)break;
    vec2 uv=(c+taps[i].xy)/small;vec3 Ls=texture(colourTex,uv).rgb;vec2 As=texture(auxTex,uv).xy;
    float sc=As.y;if(As.x>A.x)sc=min(sc,2.*A.y);
    float r=taps[i].z,m=smoothstep(r-.5,r+.5,sc),w=hw(Ls);
    acc+=mix(acc/wsum*w,Ls*w,m);wsum+=w;
  }
  colour=vec4(acc/wsum,1);
}`;
const COMPOSITE = `${COMMON}
uniform sampler2D colourTex,auxTex,blurTex;uniform vec2 size;uniform float s;out vec4 colour;
void main(){ivec2 p=ivec2(gl_FragCoord.xy);vec4 c=texelFetch(colourTex,p,0);colour=vec4(mix(c.rgb,texture(blurTex,gl_FragCoord.xy/size).rgb,clamp(texelFetch(auxTex,p,0).y*s,0.,1.)),c.a);}`;
const BLUR = `${COMMON}
uniform sampler2D tex;uniform ivec2 dir;uniform float weights[${MAX_GLOW}];uniform int radius;out vec4 colour;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy),last=textureSize(tex,0)-1;vec3 sum=texelFetch(tex,p,0).rgb*weights[0];
  for(int i=1;i<${MAX_GLOW};i++){if(i>radius)break;sum+=(texelFetch(tex,clamp(p+dir*i,ivec2(0),last),0).rgb+texelFetch(tex,clamp(p-dir*i,ivec2(0),last),0).rgb)*weights[i];}
  colour=vec4(sum,1);
}`;
const FINAL = `${COMMON}
uniform sampler2D image,colourTex,auxTex,glowTex;uniform vec2 size;uniform float amount,glow;uniform int view;out vec4 colour;
void main(){
  vec2 p=vec2(gl_FragCoord.x,size.y-gl_FragCoord.y);ivec2 ip=ivec2(p);vec4 src=texture(image,p/size),A=texelFetch(auxTex,ip,0);vec3 O;
  if(view==1)O=mix(src.rgb,vec3(1.-A.x),A.z);
  else O=clamp(mix(src.rgb,enc(texelFetch(colourTex,ip,0).rgb+glow*1.5*texture(glowTex,p/size).rgb),amount),0.,1.);
  colour=vec4(O*src.a,src.a);
}`;

let warned = false;
const warnOnce = (message: string) => { if (!warned) { warned = true; console.warn(message); } };

/** One WebGL2 context for every Depth clip. `render` returns undefined (draw the layer unchanged) without WebGL2. */
export function createDepthFx() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
  type Program = { program: WebGLProgram; at: (name: string) => WebGLUniformLocation | null };
  type Resources = { programs: Record<'prep' | 'down' | 'glowDown' | 'gather' | 'composite' | 'blur' | 'final', Program>; image: WebGLTexture; depth: WebGLTexture; black: WebGLTexture; framebuffer: WebGLFramebuffer; targets: Map<string, { texture: WebGLTexture; width: number; height: number }>; depthKey?: string };
  let resources: Resources | undefined, lost = false;
  const init = (): Resources | undefined => {
    if (!gl || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return undefined;
    const compile = (type: number, source: string) => { const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`Depth shader: ${gl.getShaderInfoLog(shader)}`); return shader; };
    let vertex: WebGLShader;
    const link = (source: string): Program => {
      const program = gl.createProgram()!, fragment = compile(gl.FRAGMENT_SHADER, source);
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`Depth program: ${gl.getProgramInfoLog(program)}`);
      const locations = new Map<string, WebGLUniformLocation | null>();
      return { program, at: name => { if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name)); return locations.get(name)!; } };
    };
    try {
      vertex = compile(gl.VERTEX_SHADER, VERTEX);
      const programs = { prep: link(PREP), down: link(area(false)), glowDown: link(area(true)), gather: link(GATHER), composite: link(COMPOSITE), blur: link(BLUR), final: link(FINAL) };
      gl.deleteShader(vertex);
      const texture = (filter: number) => { const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t); for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value); return t; };
      const black = texture(gl.NEAREST); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return { programs, image: texture(gl.LINEAR), depth: texture(gl.NEAREST), black, framebuffer: gl.createFramebuffer()!, targets: new Map() };
    } catch (error) { warnOnce((error as Error).message); return undefined; }
  };
  if (gl) {
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); lost = true; resources = undefined; });
    canvas.addEventListener('webglcontextrestored', () => { lost = false; resources = init(); });
    resources = init();
  }
  const target = (name: string, width: number, height: number) => {
    let entry = resources!.targets.get(name);
    if (!entry || entry.width !== width || entry.height !== height) {
      if (entry) gl!.deleteTexture(entry.texture);
      const texture = gl!.createTexture()!; gl!.bindTexture(gl!.TEXTURE_2D, texture);
      for (const [key, value] of [[gl!.TEXTURE_MIN_FILTER, gl!.LINEAR], [gl!.TEXTURE_MAG_FILTER, gl!.LINEAR], [gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE], [gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE]]) gl!.texParameteri(gl!.TEXTURE_2D, key, value);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA16F, width, height, 0, gl!.RGBA, gl!.HALF_FLOAT, null);
      entry = { texture, width, height }; resources!.targets.set(name, entry);
    }
    return entry.texture;
  };
  /** One fullscreen draw: `inputs` bound to units in order, `outputs` attached (none = the canvas). */
  const pass = (program: Program, width: number, height: number, inputs: [string, WebGLTexture][], outputs: WebGLTexture[], set: (at: Program['at']) => void) => {
    const g = gl!;
    g.useProgram(program.program);
    inputs.forEach(([name, texture], unit) => { g.activeTexture(g.TEXTURE0 + unit); g.bindTexture(g.TEXTURE_2D, texture); g.uniform1i(program.at(name), unit); });
    if (outputs.length) {
      g.bindFramebuffer(g.FRAMEBUFFER, resources!.framebuffer);
      for (let i = 0; i < 2; i++) g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0 + i, g.TEXTURE_2D, outputs[i] ?? null, 0);
      g.drawBuffers(outputs.map((_, i) => g.COLOR_ATTACHMENT0 + i));
    } else g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, width, height); set(program.at); g.drawArrays(g.TRIANGLES, 0, 3);
    // Nothing stays bound as a sampler, so the next pass may render into any of these.
    inputs.forEach((_, unit) => { g.activeTexture(g.TEXTURE0 + unit); g.bindTexture(g.TEXTURE_2D, null); });
  };
  return {
    get available() { return !!resources && !lost && !gl!.isContextLost(); },
    render(image: TexImageSource & { width: number; height: number }, input: DepthFxInput): HTMLCanvasElement | undefined {
      if (!gl || lost || gl.isContextLost() || (!resources && !(resources = init()))) { warnOnce('Depth effects need WebGL2 with float render targets; the picture plays without them. Export is not affected.'); return undefined; }
      const W = image.width, H = image.height, p = input.params, { depth } = input;
      if (!W || !H || !depth.width || !depth.height) return undefined;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const r = resources;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, r.image); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      if (r.depthKey !== depth.key) {
        gl.bindTexture(gl.TEXTURE_2D, r.depth); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, depth.width, depth.height, 0, gl.RED, gl.UNSIGNED_BYTE, depth.data); r.depthKey = depth.key;
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      const fit = Math.min(W / input.sourceWidth, H / input.sourceHeight), boxW = input.sourceWidth * fit, boxH = input.sourceHeight * fit;
      const [a, b, c, d, e, f] = input.warp ?? [1, 0, 0, 1, 0, 0], det = a * d - b * c;
      const forward = [a, b, 0, c, d, 0, e, f, 1], inverse = [d / det, -b / det, 0, -c / det, a / det, 0, (c * f - d * e) / det, (b * e - a * f) / det, 1];
      const map = input.view === 'map', R = p.blur / 100 * .025 * W, Wb = Math.min(W, 960), s = Wb / W, Hb = Math.max(1, Math.round(H * s));
      const fog = hsv(((p.fogHue % 360) + 360) % 360, p.fogSaturation / 100, p.fogBrightness / 100).map(v => v ** 2.2);
      const C1 = target('C1', W, H), A1 = target('A1', W, H);
      pass(r.programs.prep, W, H, [['image', r.image], ['depthMap', r.depth]], [C1, A1], at => {
        gl.uniform2f(at('size'), W, H); gl.uniform2f(at('depthSize'), depth.width, depth.height); gl.uniform2f(at('nearFar'), input.near, input.far);
        gl.uniform4f(at('box'), (W - boxW) / 2, (H - boxH) / 2, boxW, boxH);
        gl.uniformMatrix3fv(at('unwarp'), false, inverse); gl.uniformMatrix3fv(at('warp'), false, forward);
        gl.uniform4f(at('lightA'), map ? 0 : p.light / 100, p.lightStart / 100, p.lightSoftness / 100, p.bgExposure);
        gl.uniform4f(at('lightB'), p.bgWarmth / 100, p.bgContrast / 100, p.bgSaturation / 100, 0);
        gl.uniform4f(at('fogA'), map ? 0 : p.fog / 100, p.fogStart / 100, 1 + 9 * p.fogDensity / 100, p.fogHorizon / 100);
        gl.uniform3f(at('fogColour'), fog[0], fog[1], fog[2]);
        gl.uniform1f(at('dither'), input.dither === false ? 0 : 1 / 255 / Math.max(input.near - input.far, 1e-4));
        gl.uniform4f(at('lens'), R, p.focus / 100, p.range / 100 * .5, p.nearBlur / 100);
      });
      let L3 = C1;
      if (!map && p.blur > 0) {
        const C2 = target('C2', Wb, Hb), A2 = target('A2', Wb, Hb);
        pass(r.programs.down, Wb, Hb, [['colourTex', C1], ['auxTex', A1]], [C2, A2], at => { gl.uniform2f(at('size'), W, H); gl.uniform2f(at('small'), Wb, Hb); gl.uniform1f(at('s'), s); });
        const taps = depthTaps(R * s, input.taps);
        let blurred = C2;
        if (taps.length) {
          blurred = target('B', Wb, Hb);
          const packed = new Float32Array(MAX_TAPS * 4); taps.forEach((tap, i) => packed.set(tap, i * 4));
          pass(r.programs.gather, Wb, Hb, [['colourTex', C2], ['auxTex', A2]], [blurred], at => { gl.uniform2f(at('small'), Wb, Hb); gl.uniform4fv(at('taps[0]'), packed); gl.uniform1i(at('count'), taps.length); gl.uniform1f(at('bokeh'), p.bokeh / 100); });
        }
        L3 = target('C3', W, H);
        pass(r.programs.composite, W, H, [['colourTex', C1], ['auxTex', A1], ['blurTex', blurred]], [L3], at => { gl.uniform2f(at('size'), W, H); gl.uniform1f(at('s'), s); });
      }
      let glowTexture = r.black;
      if (!map && p.glow > 0) {
        const Wq = Math.min(W, 480), Hq = Math.max(1, Math.round(H * Wq / W)), G1 = target('G1', Wq, Hq), G2 = target('G2', Wq, Hq);
        pass(r.programs.glowDown, Wq, Hq, [['colourTex', L3], ['auxTex', A1]], [G1], at => { gl.uniform2f(at('size'), W, H); gl.uniform2f(at('small'), Wq, Hq); gl.uniform2f(at('glowA'), p.glowThreshold / 100, p.glowStart / 100); });
        const weights = glowWeights(p.glowRadius / 100 * .04 * W * (Wq / W)), packed = new Float32Array(MAX_GLOW); packed.set(weights);
        for (const [from, to, dir] of [[G1, G2, [1, 0]], [G2, G1, [0, 1]]] as const)
          pass(r.programs.blur, Wq, Hq, [['tex', from]], [to], at => { gl.uniform2i(at('dir'), dir[0], dir[1]); gl.uniform1fv(at('weights[0]'), packed); gl.uniform1i(at('radius'), weights.length - 1); });
        glowTexture = G1;
      }
      pass(r.programs.final, W, H, [['image', r.image], ['colourTex', L3], ['auxTex', A1], ['glowTex', glowTexture]], [], at => {
        gl.uniform2f(at('size'), W, H); gl.uniform1f(at('amount'), p.amount / 100); gl.uniform1f(at('glow'), p.glow / 100); gl.uniform1i(at('view'), map ? 1 : 0);
      });
      return canvas;
    },
    dispose() { gl?.getExtension('WEBGL_lose_context')?.loseContext(); resources = undefined; },
  };
}

let shared: ReturnType<typeof createDepthFx> | undefined;
/**
 * Test hook for the parity check: straight RGBA pixels and 8-bit depth in, rendered RGBA out (sections 0-6, no
 * dither). Also on `window.frameLineDepthFx` so headless Chrome can call it on the built app.
 */
export function depthFxPixels(rgba: Uint8ClampedArray | number[], width: number, height: number, depth: Uint8Array | number[], depthWidth: number, depthHeight: number, params: Partial<DepthFxParams>, options: { near?: number; far?: number; taps?: number; sourceWidth?: number; sourceHeight?: number; view?: 'effect' | 'map' } = {}) {
  const image = document.createElement('canvas'); image.width = width; image.height = height;
  image.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from(rgba), width, height), 0, 0);
  const full = Object.fromEntries(effectDefinitions.Depth.parameters.map(p => [p.key, params[p.key as keyof DepthFxParams] ?? p.initial])) as DepthFxParams;
  shared ??= createDepthFx();
  const result = shared.render(image, { params: full, depth: { data: Uint8Array.from(depth), width: depthWidth, height: depthHeight, key: `test:${Math.random()}` }, near: options.near ?? 1, far: options.far ?? 0, sourceWidth: options.sourceWidth ?? width, sourceHeight: options.sourceHeight ?? height, taps: options.taps ?? 48, view: options.view, dither: false });
  if (!result) return undefined;
  const out = document.createElement('canvas'); out.width = width; out.height = height;
  const context = out.getContext('2d', { willReadFrequently: true })!; context.drawImage(result, 0, 0);
  return Array.from(context.getImageData(0, 0, width, height).data);
}
if (typeof window !== 'undefined') (window as unknown as { frameLineDepthFx: typeof depthFxPixels }).frameLineDepthFx = depthFxPixels;
