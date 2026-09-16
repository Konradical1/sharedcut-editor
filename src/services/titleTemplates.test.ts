import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import type { Clip } from '../state/models.ts';
import { createTitleTemplate, titleTemplates, type TitleLayer } from './titleTemplates.ts';
import { defaultTextEffects, drawText, getText, presetDocument, replaceText, typingCount, textLocalPoint, validateText } from './text.ts';
import { drawShape, getShape, validateShape } from './shapes.ts';
import { animationProperties, evaluateClip, animatedSourceOffset, typingBudget, typingReveal, trimAnimation, validateKeyframes } from './animation.ts';
const clip = (layer: TitleLayer, duration: number): Clip => ({ id: 'preview', projectId: '', timelineId: '', trackId: '', mediaId: layer.text ? 'frameline-title' : 'frameline-shape', name: layer.name, start: 0, duration, sourceIn: 0, color: '', disabled: false, effects: [], properties: { ...layer.properties, ...(layer.text ? { textDocument: JSON.stringify(layer.text) } : { shapeDocument: JSON.stringify(layer.shape) }) }, keyframes: layer.keyframes });

test('all 36 titles retain editable layers, animate in and out, render, and have independent static variants', () => {
  assert.equal(titleTemplates.length, 36);
  assert.equal(new Set(titleTemplates.map(p => p.name)).size, 36);
  for (let index = 0; index < titleTemplates.length; index++) {
    const animated = createTitleTemplate(index), still = createTitleTemplate(index, false);
    assert.ok(animated.layers.length);
    assert.equal(still.layers.length, animated.layers.length);
    const canvas = createCanvas(480,270), ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    animated.layers.forEach((layer, i) => {
      if (layer.text) validateText(layer.text); else validateShape(layer.shape);
      validateKeyframes(layer.keyframes);
      const ids = Object.values(layer.keyframes!).flat().map(key => key.id);
      assert.equal(new Set(ids).size, ids.length, 'Key IDs are unique across channels');
      assert.equal(still.layers[i].keyframes, undefined);
      if (still.layers[i].text) assert.equal(still.layers[i].text!.typingEnabled, false);
      const source = clip(layer, animated.duration), start = evaluateClip(source,0), hold = evaluateClip(source,animated.duration / 2), end = evaluateClip(source,animated.duration - 1/24);
      assert.equal(start.properties.opacity, 0);
      assert.equal(hold.properties.opacity, 100);
      assert.equal(end.properties.opacity, 0);
      if (layer.text) drawText(ctx,getText(hold),480,270,1920,1080,animated.duration / 2);
      else drawShape(ctx,getShape(hold),480,270,1920,1080);
    });
    assert.ok(ctx.getImageData(0,0,480,270).data.some((v,i) => i % 4 === 3 && v > 0), titleTemplates[index].name);
    const another = createTitleTemplate(index);
    animated.layers[0].name = 'Changed';
    assert.notEqual(another.layers[0].name, 'Changed');
  }
});

test('typing is deterministic, respects graphemes and progress, and exposes validated effects as keyframe channels', () => {
  const text = { ...replaceText(presetDocument(), 'A👩‍💻éB'), typingEnabled:true, typingSpeed:2, typingRandomness:0, typingCursor:false };
  assert.equal(typingCount(text,0),0);
  assert.equal(typingCount(text,.5),1);
  assert.equal(typingCount(text,1),2);
  assert.equal(typingCount(text,2),4);
  assert.equal(typingCount({...text,typingProgress:50},8),2);
  const random = {...text,typingRandomness:100};
  assert.deepEqual(Array.from({length:30},(_,i)=>typingCount(random,i/10)),Array.from({length:30},(_,i)=>typingCount(random,i/10)));
  assert.throws(() => validateText({...text,blur:Infinity}));
  assert.throws(() => validateText({...text,shadowColor:'red'}));
  assert.throws(() => validateText({...text,typingSpeed:0}));
  const source = clip({name:'Text',text},5), paths = animationProperties(source).map(p=>p.path);
  for(const key of Object.keys(defaultTextEffects)) assert.ok(paths.includes(`text.${key}`),key);
  const canvas = createCanvas(480,270), ctx=canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  drawText(ctx,text,480,270,1920,1080,0);
  assert.ok(!ctx.getImageData(0,0,480,270).data.some(v=>v));
  drawText(ctx,{...text,shadowOpacity:80,outlineWidth:3,blur:2},480,270,1920,1080,2);
  assert.ok(ctx.getImageData(0,0,480,270).data.some(v=>v));
});

test('text hit testing reverses translation, scale, and rotation in project pixel coordinates', () => {
  const properties = {x:80,y:-20,anchorX:40,anchorY:30,zoom:150,rotation:90};
  const local = {x:.2,y:.3}, width=1920,height=1080,pivot={x:width/2+40,y:height/2+30};
  const dx=local.x*width-pivot.x,dy=local.y*height-pivot.y;
  const world={x:(pivot.x+80-dy*1.5)/width,y:(pivot.y-20+dx*1.5)/height};
  const result=textLocalPoint(world,properties,width,height);
  assert.ok(Math.abs(result.x-local.x)<1e-9);assert.ok(Math.abs(result.y-local.y)<1e-9);
});

test('keyframed typing speed accumulates work across slowdowns, trims, replay, and deliberate reverse/progress', () => {
  const doc={...replaceText(presetDocument(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),typingEnabled:true,typingSpeed:20,typingRandomness:60,typingCursor:false};
  const source=clip({name:'Typing',text:doc,keyframes:{'text.typingSpeed':[{id:'fast',time:0,value:20,interpolation:'hold'},{id:'slow',time:1,value:1,interpolation:'linear'},{id:'recover',time:4,value:4,interpolation:'bezier',curve:[.2,.1,.6,1]}]}},5);
  const count=(clip:Clip,time:number)=>{const evaluated=evaluateClip(clip,clip.start+time);return Number(evaluated.properties.animationTypingCount);};
  const counts=Array.from({length:121},(_,i)=>count(source,i/30));
  assert.ok(counts.every((value,i)=>i===0||value>=counts[i-1]),'A slowdown cannot erase revealed glyphs.');
  assert.deepEqual(counts,Array.from({length:121},(_,i)=>count(source,i/30)));
  assert.ok(typingBudget(source,1)>19.999&&typingBudget(source,1)<20.001);
  assert.ok(typingBudget(source,2)>21.49&&typingBudget(source,2)<21.51);
  const cut={...source,...trimAnimation(source,1,4),sourceIn:1,start:1,duration:4};
  assert.equal(count(cut,1),count(source,2),'Trimming preserves already accumulated typing.');
  const reversed={...source,properties:{...source.properties,reverse:true}};
  assert.ok(count(reversed,0)>=count(reversed,3),'Reverse playback may deliberately remove glyphs.');
  const sampled=evaluateClip(reversed,reversed.start,8);
  assert.equal(sampled.properties.animationTypingCount,typingReveal(reversed,getText(sampled),reversed.sourceIn+animatedSourceOffset(reversed,0,8)),'Reverse typing uses the render frame rate.');
  const evaluated=evaluateClip(source,2);
  assert.equal(typingCount({...getText(evaluated),typingProgress:0},2,typingBudget(source,2)),0);
  assert.equal(source.properties.animationTypingCount,undefined,'Transient sampling state does not mutate stored clips.');
  const varying={...source,keyframes:{...source.keyframes,'text.typingRandomness':[{id:'none',time:0,value:0,interpolation:'hold' as const},{id:'random',time:.5,value:100,interpolation:'linear' as const}],'text.typingSeed':[{id:'seed1',time:0,value:1,interpolation:'hold' as const},{id:'seed2',time:.9,value:2718,interpolation:'hold' as const}]}};
  const forward=Array.from({length:61},(_,i)=>count(varying,i/15));
  assert.ok(forward.every((value,i)=>i===0||value>=forward[i-1]),'Animated randomness/seed cannot erase revealed glyphs.');
  assert.deepEqual(forward,[...Array.from({length:61},(_,i)=>count(varying,(60-i)/15))].reverse(),'Seeking backwards and forwards reveals exactly the same characters.');
  assert.equal(typingReveal(varying,getText(varying),2),count(varying,2));
});
