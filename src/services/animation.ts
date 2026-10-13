import type { Clip, GradeNode, Keyframe, KeyframeValue } from '../state/models.ts';
import { defaultProperties } from '../state/demo.ts';
import { effectDefinitions, effectValue } from './effects.ts';
import { getText, isTitle, typingCost, typingCount, validateText, type TextDocument } from './text.ts';
import { getShape, isShape, validateShape } from './shapes.ts';

export const linearCurve: [number, number, number, number] = [1/3, 1/3, 2/3, 2/3];
export const frameTime = (time: number, fps: number) => Math.round(time * fps) / fps;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export function ease(progress: number, curve = linearCurve) {
  const cubic = (t: number, a: number, b: number) => 3*(1-t)**2*t*a + 3*(1-t)*t*t*b + t**3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 28; i++) { const mid = (lo + hi)/2; if (cubic(mid, curve[0], curve[2]) < progress) lo = mid; else hi = mid; }
  return cubic((lo + hi)/2, curve[1], curve[3]);
}
export function sampleKeyframes(keys: Keyframe[], time: number): KeyframeValue {
  if (time <= keys[0].time) return keys[0].value;
  const index = keys.findIndex(key => key.time > time);
  if (index < 0) return keys.at(-1)!.value;
  const a = keys[index - 1], b = keys[index];
  if (a.interpolation === 'hold' || typeof a.value !== typeof b.value) return a.value;
  const t = a.interpolation === 'bezier' ? ease((time-a.time)/(b.time-a.time), a.curve) : (time-a.time)/(b.time-a.time);
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value-a.value)*t;
  if (typeof a.value === 'string' && typeof b.value === 'string' && /^#[a-f\d]{6}$/i.test(a.value) && /^#[a-f\d]{6}$/i.test(b.value)) {
    return '#' + [1,3,5].map(i => Math.round(parseInt(a.value.toString().slice(i,i+2),16)*(1-t)+parseInt(b.value.toString().slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('');
  }
  return a.value;
}
const safePath = (path: string) => path.length < 400 && !path.split('.').some(p => ['__proto__','constructor','prototype'].includes(p));
export function validateKeyframes(channels: unknown): asserts channels is NonNullable<Clip['keyframes']> {
  if (!channels || typeof channels !== 'object' || Array.isArray(channels) || Object.keys(channels).length > 1000) throw new Error('Invalid animation channels.');
  let count = 0;
  for (const [path, keys] of Object.entries(channels)) {
    if (!safePath(path) || !/^(properties|effects|text|shape|nodes)\./.test(path) || !Array.isArray(keys) || !keys.length) throw new Error('Invalid animation property.');
    let previous = -Infinity; const ids = new Set();
    for (const key of keys) {
      if (++count > 20000 || !key || typeof key.id !== 'string' || key.id.length > 160 || ids.has(key.id) || !Number.isFinite(key.time) || Math.abs(key.time) > 86400 || key.time <= previous || !['number','string','boolean'].includes(typeof key.value) || typeof key.value === 'number' && (!Number.isFinite(key.value) || Math.abs(key.value) > 1e9) || typeof key.value === 'string' && key.value.length > 10000 || !['linear','hold','bezier'].includes(key.interpolation)) throw new Error('Invalid keyframe.');
      if (key.curve !== undefined && (!Array.isArray(key.curve) || key.curve.length !== 4 || key.curve.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10) || key.curve[0] < 0 || key.curve[0] > 1 || key.curve[2] < 0 || key.curve[2] > 1)) throw new Error('Invalid Bézier handles.');
      ids.add(key.id); previous = key.time;
    }
  }
}
export type AnimationProperty = { path: string; label: string; value: KeyframeValue };
// Timeline lanes list every keyframed clip's properties on each playhead move; an unchanged pose
// (evaluateClip returns the same object) with the same grade nodes lists them once.
const listed = new WeakMap<Clip, { nodes: GradeNode[]; properties: AnimationProperty[] }>();
export function animationProperties(clip: Clip, nodes: GradeNode[] = []): AnimationProperty[] {
  const own = nodes.filter(n => n.clipId === clip.id), cached = listed.get(clip);
  if (cached && cached.nodes.length === own.length && cached.nodes.every((node, i) => node === own[i])) return cached.properties;
  const properties = listProperties(clip, own);
  listed.set(clip, { nodes: own, properties });
  return properties;
}
function listProperties(clip: Clip, nodes: GradeNode[]): AnimationProperty[] {
  if(clip.properties.captionSet)return [];
  const result: AnimationProperty[] = [];
  const flatten = (value: object, prefix: string, label = '') => {
    for (const [key, item] of Object.entries(value)) {
      const path = `${prefix}.${key}`, name = label ? `${label} · ${key}` : key;
      if (item && typeof item === 'object') flatten(item, path, name);
      else if (['number','string','boolean'].includes(typeof item)) result.push({ path, label: name.replace(/([a-z])([A-Z])/g,'$1 $2'), value: item });
    }
  };
  const hidden = /^(textDocument|shapeDocument|compositionId|resolve|linkGroup|colorGroup|audioDetached|animation|fadeOrigin|fadeDuration|opticalFlow|motionBlur)/;
  flatten(Object.fromEntries(Object.entries({...defaultProperties, fadeIn:0,fadeOut:0,audioFadeIn:0,audioFadeOut:0,disabled:clip.disabled,...clip.properties}).filter(([key]) => !hidden.test(key))), 'properties');
  for (const effect of clip.effects) {
    flatten({enabled:effect.enabled,amount:effect.amount},`effects.${effect.id}`,effect.name);
    flatten(Object.fromEntries((effectDefinitions[effect.name]?.parameters ?? []).filter(p=>p.key!=='amount').map(p=>[p.key,effectValue(clip,effect,p.key)])),`effects.${effect.id}.parameters`,effect.name);
  }
  if (isTitle(clip)) flatten(getText(clip), 'text', 'Text');
  if (isShape(clip)) flatten(getShape(clip), 'shape', 'Shape');
  // A color group node holds one value for the whole group (store: updateColorGroup), so it is never keyed.
  for (const node of nodes.filter(n=>n.clipId===clip.id&&!n.group)) flatten({enabled:node.enabled,parameters:node.parameters},`nodes.${node.id}`,node.name);
  const names:Record<string,string>={x:'Position X',y:'Position Y',fontSize:'Size',fontWeight:'Weight',text:'Content'};
  return result.map(property=>{const leaf=property.path.split('.').at(-1)!,name=names[leaf]??leaf.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,s=>s.toUpperCase());const run=/^text\.runs\.(\d+)\./.exec(property.path);return {...property,label:run?`Text ${Number(run[1])+1} · ${name}`:property.path.startsWith('properties.')?name:property.path.startsWith('text.')?`Text · ${name}`:property.label.replace(' · parameters','').replace(/[^·]+$/,name)};});
}
export function boundedAnimationValue(path:string,value:KeyframeValue):KeyframeValue {
  if(typeof value!=='number')return value;
  const property=path.split('.').at(-1)!;
  const bounds:Record<string,[number,number]>=path.startsWith('text.')?{x:[-4,4],y:[-4,4],width:[.01,1],height:[.01,1],lineHeight:[.5,4],opacity:[0,100],fontSize:[4,600],fontWeight:[100,900],letterSpacing:[-10,100],outlineWidth:[0,100],shadowOpacity:[0,100],shadowBlur:[0,200],shadowX:[-1000,1000],shadowY:[-1000,1000],blur:[0,100],typingSpeed:[1,120],typingRandomness:[0,100],typingProgress:[0,100],typingSeed:[0,2147483647]}:path.startsWith('shape.')?{x:[-4,4],y:[-4,4],width:[.001,8],height:[.001,8],opacity:[0,100],fillOpacity:[0,100],outlineWidth:[0,600],shadowOpacity:[0,100],shadowBlur:[0,600],shadowX:[-2000,2000],shadowY:[-2000,2000],cornerRadius:[0,600]}:path.startsWith('properties.')?{motionBlurStrength:[0,100],motionBlurSamples:[8,64],opacity:[0,100],zoom:[1,800],scaleX:[1,800],scaleY:[1,800],speed:[1,800],rotation:[-360,360],gain:[-60,12],pan:[-100,100],cropLeft:[0,16384],cropRight:[0,16384],cropTop:[0,16384],cropBottom:[0,16384],fadeIn:[0,86400],fadeOut:[0,86400],audioFadeIn:[0,86400],audioFadeOut:[0,86400]}:{};
  const range=bounds[property];return range?clamp(value,range[0],range[1]):value;
}
export function setAnimatedValue(clip: Clip, path: string, value: KeyframeValue): Clip {
  if (!safePath(path)) return clip;
  const next = structuredClone(clip), parts = path.split('.');
  let target: any;
  if (parts[0] === 'properties') target = next.properties;
  else if (parts[0] === 'effects') target = next.effects.find(e=>e.id===parts[1]);
  else if (parts[0] === 'text' && isTitle(next)) target = getText(next);
  else if (parts[0] === 'shape' && isShape(next)) target = getShape(next);
  else return clip;
  const root = target;
  for (const part of parts.slice(parts[0]==='effects'?2:1,-1)) { if (!target || typeof target !== 'object') return clip; target = target[part] ??= {}; }
  if (!target || typeof target !== 'object') return clip;
  target[parts.at(-1)!] = boundedAnimationValue(path,value);
  if(path==='properties.disabled')next.disabled=Boolean(value);
  if (parts[0] === 'text') { try { validateText(root); } catch { return clip; } next.properties.textDocument = JSON.stringify(root); }
  if (parts[0] === 'shape') { try { validateShape(root); } catch { return clip; } next.properties.shapeDocument = JSON.stringify(root); }
  return next;
}
/**
 * Every channel applied to one copy of the clip: only the objects on an animated path are copied, and the
 * text or shape document is parsed and written once, where applying the channels one at a time deep-cloned
 * the whole clip per channel on every frame. A text document that fails validation replays channel by
 * channel so exactly the offending channel is dropped, as before.
 */
function applyChannels(clip: Clip, changes: [string, KeyframeValue][]): Clip {
  const copies = new Set<object>();
  const own = <T extends object>(value: T): T => { if (copies.has(value)) return value; const copy = (Array.isArray(value) ? [...value] : { ...value }) as T; copies.add(copy); return copy; };
  const next: Clip = { ...clip, properties: own(clip.properties) };
  let text: (TextDocument & object) | undefined, shape: ReturnType<typeof getShape> | undefined, textSet = false, shapeSet = false;
  for (const [path, value] of changes) {
    if (!safePath(path)) continue;
    const parts = path.split('.');
    let target: any;
    if (parts[0] === 'properties') target = next.properties;
    else if (parts[0] === 'effects') { const index = next.effects.findIndex(e => e.id === parts[1]); if (index < 0) continue; next.effects = own(next.effects); target = next.effects[index] = own(next.effects[index]); }
    else if (parts[0] === 'text' && isTitle(next)) { text ??= getText(clip); target = text; }
    else if (parts[0] === 'shape' && isShape(next)) { shape ??= getShape(clip); target = shape; }
    else continue;
    // A freshly parsed document is already this evaluation's own copy.
    const parsed = target === text || target === shape;
    let valid = true;
    for (const part of parts.slice(parts[0] === 'effects' ? 2 : 1, -1)) {
      if (!target || typeof target !== 'object') { valid = false; break; }
      const child = target[part] ?? {};
      target = target[part] = child && typeof child === 'object' && !parsed ? own(child) : child;
    }
    if (!valid || !target || typeof target !== 'object') continue;
    target[parts.at(-1)!] = boundedAnimationValue(path, value);
    if (path === 'properties.disabled') next.disabled = Boolean(value);
    if (parts[0] === 'text') textSet = true;
    if (parts[0] === 'shape') shapeSet = true;
  }
  const replay = () => changes.reduce((result, [path, value]) => setAnimatedValue(result, path, value), clip);
  if (textSet) { try { validateText(text); } catch { return replay(); } next.properties.textDocument = JSON.stringify(text); }
  if (shapeSet) { try { validateShape(shape); } catch { return replay(); } next.properties.shapeDocument = JSON.stringify(shape); }
  return next;
}
const channelLists = new WeakMap<NonNullable<Clip['keyframes']>, [string, Keyframe[]][]>();
// The last pose per stored clip: while no channel moves (outside its keys, on a hold) every caller gets the same object.
const poses = new WeakMap<Clip, { values: KeyframeValue[]; keyframes: Clip['keyframes']; properties: Clip['properties']; clip: Clip }>();
export function evaluateClip(clip: Clip, playhead: number, fps = 24): Clip {
  if (!clip.keyframes) return clip;
  let channels = channelLists.get(clip.keyframes);
  if (!channels) { channels = Object.entries(clip.keyframes).filter(([path, keys]) => keys.length && !path.startsWith('nodes.')); channelLists.set(clip.keyframes, channels); }
  const typing = isTitle(clip) && ['typingSpeed','typingRandomness','typingSeed'].some(key=>clip.keyframes![`text.${key}`]?.length);
  if (!channels.length && !typing) return clip;
  const values = channels.map(([, keys]) => sampleKeyframes(keys, playhead - clip.start)), last = poses.get(clip);
  if (!typing && last && last.keyframes === clip.keyframes && last.properties === clip.properties && last.values.every((value, i) => value === values[i])) return last.clip;
  let next = channels.length ? applyChannels(clip, channels.map(([path], i) => [path, values[i]])) : clip;
  if (typing) next = {...next,properties:{...next.properties,animationTypingCount:typingReveal(clip,getText(next),clip.sourceIn+animatedSourceOffset(clip,Math.max(0,playhead-clip.start),fps))}};
  else poses.set(clip, { values, keyframes: clip.keyframes, properties: clip.properties, clip: next });
  return next;
}
export function evaluateNodes(nodes: GradeNode[], clip: Clip, playhead: number): GradeNode[] {
  if (!Object.keys(clip.keyframes ?? {}).some(path => path.startsWith('nodes.'))) return [...nodes];
  return nodes.map(node => {
    if (node.group) return node;
    let next = node;
    for (const [path, keys] of Object.entries(clip.keyframes ?? {})) {
      const prefix = `nodes.${node.id}.`;
      if (!path.startsWith(prefix) || !keys.length) continue;
      const field = path.slice(prefix.length), value = sampleKeyframes(keys,playhead-clip.start);
      if (field === 'enabled') next = {...next,enabled:!!value};
      else if (field.startsWith('parameters.') && typeof value === 'number') next = {...next,parameters:{...next.parameters,[field.slice(11)]:value}};
    }
    return next;
  });
}
export function fadeLevel(clip: Clip, time: number, audio = false) {
  const p = clip.properties, elapsed = time - clip.start + Number(p.fadeOrigin ?? 0), duration = Number(p.fadeDuration ?? clip.duration);
  const fadeIn = Number(p[audio?'audioFadeIn':'fadeIn'] ?? 0), fadeOut = Number(p[audio?'audioFadeOut':'fadeOut'] ?? 0);
  return clamp(fadeIn > 0 ? elapsed/fadeIn : 1,0,1)*clamp(fadeOut > 0 ? (duration-elapsed)/fadeOut : 1,0,1);
}
/** Needs per-frame baking on export: any keyframe but a plain gain ramp (that renders as a volume expression), or typing. */
export const isAnimated = (clip: Clip) => Boolean(Object.keys(clip.keyframes ?? {}).some(key => key !== 'properties.gain') || isTitle(clip) && getText(clip).typingEnabled);
export const hasAnimatedTiming=(clip:Clip)=>['speed','freeze','reverse'].some(p=>clip.keyframes?.[`properties.${p}`]);
export function trimAnimation(clip: Clip, start: number, duration=clip.duration-(start-clip.start)): Pick<Clip, 'keyframes' | 'properties'> & Partial<Pick<Clip,'sourceIn'>> {
  const delta = start - clip.start;
  const next={...clip,start,duration,keyframes:Object.fromEntries(Object.entries(clip.keyframes ?? {}).map(([path,keys])=>[path,keys.map(key=>({...key,time:key.time-delta}))])),properties:{...clip.properties,fadeOrigin:Number(clip.properties.fadeOrigin ?? 0)+delta,fadeDuration:Number(clip.properties.fadeDuration ?? clip.duration)}};
  return {keyframes:next.keyframes,properties:next.properties,...(hasAnimatedTiming(clip)?{sourceIn:clip.sourceIn+animatedSourceOffset(clip,delta)-animatedSourceOffset(next,0)}:{})};
}
// Integrate retiming instead of multiplying the current speed by elapsed time.
export function animatedSourceOffset(clip: Clip, elapsed: number, fps=24) {
  const end = Math.max(0, elapsed);
  if (!hasAnimatedTiming(clip)) {const rate=Math.max(.01,Number(clip.properties.speed??100)/100);return clip.properties.freeze?0:clip.properties.reverse?Math.max(0,clip.duration*rate-end*rate-1/fps):end*rate;}
  const integrate=(end:number)=>{
    const boundaries = [...new Set([0,end,...Object.entries(clip.keyframes ?? {}).filter(([p])=>['properties.speed','properties.freeze','properties.reverse'].includes(p)).flatMap(([,k])=>k.map(k=>k.time)).filter(t=>t>0&&t<end)])].sort((a,b)=>a-b);
    let offset = 0;
    // Simpson integration per key interval; 32 samples resolve cubic easing without frame-rate dependence.
    for(let i=1;i<boundaries.length;i++) {
      const a=boundaries[i-1],b=boundaries[i],step=(b-a)/32;
      const at=(t:number)=>{const value=(name:string)=>{const keys=clip.keyframes?.[`properties.${name}`];return keys?.length?boundedAnimationValue(`properties.${name}`,sampleKeyframes(keys,t)):clip.properties[name];};return value('freeze')?0:(value('reverse')?-1:1)*Math.max(.01,Number(value('speed')??100)/100);};
      for(let j=0;j<32;j++) { const t=a+j*step;offset+=step*(at(t+1e-9)+4*at(t+step/2)+at(t+step-1e-9))/6; }
    }
    return offset;
  };
  const reverseKeys=clip.keyframes?.['properties.reverse'];
  const mayReverse=clip.properties.reverse||reverseKeys?.some(k=>k.value);
  const minimum=mayReverse?Math.min(0,...[clip.duration,...reverseKeys?.map(k=>k.time).filter(t=>t>0&&t<clip.duration)??[]].map(integrate)):0;
  return Math.max(0,integrate(end)-minimum-((reverseKeys?.length?sampleKeyframes(reverseKeys,end):clip.properties.reverse)?1/fps:0));
}

/**
 * Length that plays the same footage after a speed edit, stopped at the next clip on the track so
 * a slow-down never overlaps it. A keyframed reverse or freeze keeps its length: the footage span
 * is no longer a forward integral to preserve.
 */
export function retimedDuration(before: Clip, after: Clip, clips: Clip[]) {
  const rate=(c:Clip)=>Math.max(.01,Number(c.properties.speed??100)/100);
  let high=before.duration*rate(before)/rate(after);
  if(hasAnimatedTiming(before)||hasAnimatedTiming(after)) {
    const still=(c:Clip)=>c.properties.reverse||c.properties.freeze||['properties.reverse','properties.freeze'].some(p=>c.keyframes?.[p]?.some(k=>k.value));
    if(still(before)||still(after))return before.duration;
    const span=animatedSourceOffset(before,before.duration);
    // Offset grows monotonically with elapsed time here; 1% speed is the slowest, so 100× bounds it.
    let low=0;high=before.duration*100;
    for(let i=0;i<48;i++){const mid=(low+high)/2;if(animatedSourceOffset(after,mid)<span)low=mid;else high=mid;}
  }
  const next=Math.min(Infinity,...clips.filter(c=>c.id!==before.id&&c.timelineId===before.timelineId&&c.trackId===before.trackId&&c.start>=before.start+before.duration-1e-6).map(c=>c.start));
  return Math.max(.01,Math.min(high,next-before.start));
}

export function copyAnimatedNodes(clip:Clip,source:GradeNode[],newId:()=>string):GradeNode[] {
  const copies=source.map(node=>({...structuredClone(node),id:newId(),clipId:clip.id,projectId:clip.projectId}));
  if(clip.keyframes)clip.keyframes=Object.fromEntries(Object.entries(clip.keyframes).map(([path,keys])=>{const index=source.findIndex(n=>path.startsWith(`nodes.${n.id}.`));return [index<0?path:path.replace(`nodes.${source[index].id}.`,`nodes.${copies[index].id}.`),keys];}));
  return copies;
}

/** Integrate typing work so a speed change cannot erase characters already revealed. */
export function typingBudget(clip: Clip, sourceElapsed: number) {
  const end=Math.max(0,sourceElapsed),keys=clip.keyframes?.['text.typingSpeed'],initial=getText(clip).typingSpeed;
  if(!keys?.length)return end*initial;
  const sourceIn=clip.sourceIn||0;
  const boundaries=[...new Set([0,end,...keys.map(key=>key.time+sourceIn).filter(time=>time>0&&time<end)])].sort((a,b)=>a-b);
  const speed=(time:number)=>Number(boundedAnimationValue('text.typingSpeed',sampleKeyframes(keys,time-sourceIn)));
  let budget=0;
  for(let i=1;i<boundaries.length;i++){
    const a=boundaries[i-1],b=boundaries[i],segment=keys.filter(key=>key.time<=(a+b)/2-sourceIn).at(-1);
    if(segment?.interpolation!=='bezier'){budget+=(b-a)*(speed(a+1e-9)+speed(b-1e-9))/2;continue;}
    const step=(b-a)/32;
    for(let j=0;j<32;j++){const t=a+j*step;budget+=step*(speed(t+1e-9)+4*speed(t+step/2)+speed(t+step-1e-9))/6;}
  }
  return Math.max(0,budget);
}

/** Each glyph samples randomness at its own reveal start, never at the current frame. */
export function typingReveal(clip: Clip, doc: TextDocument, sourceElapsed: number) {
  const initial=getText(clip),available=typingBudget(clip,sourceElapsed),limit=typingCount({...doc,typingEnabled:false,typingProgress:100},Infinity);
  const sample=(field:'typingRandomness'|'typingSeed',time:number)=>{const keys=clip.keyframes?.[`text.${field}`];return keys?.length?Number(boundedAnimationValue(`text.${field}`,sampleKeyframes(keys,time-clip.sourceIn))):initial[field];};
  let work=0,time=0,count=0;
  while(count<limit){
    const cost=typingCost(count,sample('typingRandomness',time),sample('typingSeed',time));
    work+=cost;if(work>available+1e-9)break;
    // Typing speed is at least one character per second, so this bracket is frame-independent.
    let low=time,high=time+cost;
    for(let i=0;i<32;i++){const mid=(low+high)/2;if(typingBudget(clip,mid)<work)low=mid;else high=mid;}
    time=Math.round((low+high)/2*1e9)/1e9;count++;
  }
  return count;
}
