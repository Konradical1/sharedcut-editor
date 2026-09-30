import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useEditorStore as store } from '../state/store.ts';
import { animationProperties, animatedSourceOffset, copyAnimatedNodes, ease, evaluateClip, evaluateNodes, fadeLevel, sampleKeyframes, trimAnimation, validateKeyframes } from './animation.ts';
import { edgeScrollVelocity, rulerStep, timelineZoom } from './timeline.ts';
import type { Keyframe } from '../state/models.ts';
const keys=(a:number,b:number):Keyframe[]=>[{id:'a',time:0,value:a,interpolation:'linear'},{id:'b',time:2,value:b,interpolation:'linear'}];

test('animation evaluation, text/effect discovery, Bézier handles, holds and split timing',()=>{
 const baseline=store.getState();try {
 store.setState({locks:[],operations:[],notifications:[]});const s=store.getState;
 const original=s().clips.find(c=>c.id==='c3')!;
 const clip={...original,start:10,duration:4,keyframes:{'properties.opacity':keys(0,100)}};
 assert.equal(evaluateClip(clip,11).properties.opacity,50);
 assert.equal(evaluateClip(clip,9).properties.opacity,0);
 assert.equal(evaluateClip(clip,14).properties.opacity,100);
 assert.ok(Math.abs(ease(.5,[.42,0,.58,1])-.5)<1e-6);
 assert.ok(ease(.25,[.1,.8,.3,1])>.6);
 assert.equal(sampleKeyframes([{...keys(0,1)[0],interpolation:'hold'},keys(0,1)[1]],1.9),0);
 assert.equal(sampleKeyframes([{...keys(0,1)[0],value:'#000000'}, {...keys(0,1)[1],value:'#ffffff'}],1),'#808080');
 const trimmed={...clip,...trimAnimation(clip,11),start:11,duration:3};assert.equal(evaluateClip(trimmed,11.5).properties.opacity,75);
 const fades={...clip,properties:{fadeIn:2,fadeOut:1,audioFadeIn:2,audioFadeOut:1}};
 assert.equal(fadeLevel(fades,11),.5);assert.equal(fadeLevel(fades,13.5,true),.5);
 assert.equal(fadeLevel({...fades,...trimAnimation(fades,11),start:11,duration:3},11),.5);
 assert.equal(animatedSourceOffset({...clip,keyframes:{'properties.speed':keys(100,200)}},2),3);
 const reversing={...clip,properties:{speed:100,reverse:true},keyframes:{'properties.speed':keys(100,200)}};
 const cut={...reversing,...trimAnimation(reversing,11,3),start:11,duration:3};
 assert.ok(Math.abs(cut.sourceIn+animatedSourceOffset(cut,1)-reversing.sourceIn-animatedSourceOffset(reversing,2))<1e-6);
 assert.equal(fadeLevel({...clip,properties:{fadeIn:4,fadeOut:4}},12),.25);
 assert.throws(()=>validateKeyframes({'properties.opacity':[{...keys(0,1)[0],curve:[1,0,1.2,1]}]}));
 assert.throws(()=>validateKeyframes({'properties.__proto__.x':keys(0,1)}));
 assert.throws(()=>validateKeyframes({'properties.opacity':[keys(0,1)[0],keys(0,1)[0]]}));
 store.setState({clips:s().clips.map(c=>c.id===clip.id?clip:c),playhead:11});s().updateProperty(clip.id,'opacity',25);
 assert.equal(evaluateClip(s().clips.find(c=>c.id===clip.id)!,11).properties.opacity,25);
 assert.equal(s().clips.find(c=>c.id===clip.id)!.duration,4);
 s().undo();assert.equal(evaluateClip(s().clips.find(c=>c.id===clip.id)!,11).properties.opacity,50);
 s().setPlayhead(12);s().splitClip(clip.id);const right=s().clips.find(c=>c.id===s().selectedClipId)!;assert.equal(evaluateClip(right,12).properties.opacity,100);
 s().addTitle();const title=s().clips.find(c=>c.id===s().selectedClipId)!;assert.ok(animationProperties(title).some(p=>p.path==='text.runs.0.style.fontSize'));
 s().keyframeProperty(title.id,'text.runs.0.style.fontSize',100);s().setPlayhead(title.start+1);s().formatText({fontSize:200});assert.equal(evaluateClip(s().clips.find(c=>c.id===title.id)!,title.start+.5).properties.textDocument && JSON.parse(String(evaluateClip(s().clips.find(c=>c.id===title.id)!,title.start+.5).properties.textDocument)).runs[0].style.fontSize,150);
 const node={id:'n',projectId:clip.projectId,clipId:clip.id,name:'Correction',kind:'balance',enabled:true,parameters:{exposure:0}};
 const copy={...clip,keyframes:{'nodes.n.parameters.exposure':keys(0,2)}};copyAnimatedNodes(copy,[node],()=>"new-node");assert.ok(copy.keyframes['nodes.new-node.parameters.exposure' as keyof typeof copy.keyframes]);
 assert.equal(evaluateNodes([node],{...clip,keyframes:{'nodes.n.parameters.exposure':keys(0,2)}},11)[0].parameters.exposure,1);
 } finally {store.setState(baseline,true);}
});
test('timeline reaches 15-frame view, keeps frame ticks legible and accelerates at either edge',()=>{
 assert.equal(timelineZoom(1e8,1200,180,24),1920);
 assert.equal(1200/timelineZoom(960,1200,180,24)*24,30);
 assert.equal(rulerStep(960,24),2/24);
 assert.equal(edgeScrollVelocity(600,164,1400),0);
 assert.ok(Math.abs(edgeScrollVelocity(1380,164,1400))<Math.abs(edgeScrollVelocity(1399,164,1400)));
 assert.equal(edgeScrollVelocity(164,164,1400),-1200);
});

test('gap deletion is track-only, atomic, undoable and respects locks; timing animates linked media',()=>{
 const baseline=store.getState();try {
 const s=store.getState,original=s().clips.find(c=>c.id==='c3')!;
 const a={...original,start:2,duration:2,properties:{...original.properties,linkGroup:'pair'},keyframes:undefined};
 const b={...a,id:'after',start:7,sourceIn:3};
 const partner={...a,id:'partner',trackId:s().tracks.find(t=>t.timelineId===a.timelineId&&t.id!==a.trackId)!.id};
 store.setState({locks:[],operations:[],clips:[a,b,partner],playhead:2,tracks:s().tracks.map(t=>({...t,locked:false})),settings:{...s().settings,linkSelection:true}});
 s().deleteGap(a.trackId,4,7);assert.equal(s().clips.find(c=>c.id==='after')!.start,4);assert.equal(s().clips.find(c=>c.id==='after')!.sourceIn,3);assert.equal(s().clips.find(c=>c.id==='partner')!.start,2);
 s().undo();assert.equal(s().clips.find(c=>c.id==='after')!.start,7);
 store.setState({tracks:s().tracks.map(t=>t.id===a.trackId?{...t,locked:true}:t)});s().deleteGap(a.trackId,4,7);assert.equal(s().clips.find(c=>c.id==='after')!.start,7);
 store.setState({tracks:s().tracks.map(t=>({...t,locked:false})),clips:[a,partner]});
 s().keyframeProperty(a.id,'properties.speed',100);s().setPlayhead(3);s().updateProperty(a.id,'speed',200);
 const picture=s().clips.find(c=>c.id===a.id)!,audio=s().clips.find(c=>c.id===partner.id)!;
 assert.equal(evaluateClip(picture,2.5).properties.speed,150);assert.equal(animatedSourceOffset(picture,1),1.5);assert.equal(animatedSourceOffset(audio,1),1.5);
 // Same 2 s of footage: 1.5 s by t=1, the last 0.5 s at 200% → 1.25 s, linked sound in step.
 assert.ok(Math.abs(picture.duration-1.25)<1e-6);assert.ok(Math.abs(audio.duration-1.25)<1e-6);
 s().setKeyframes(a.id,'properties.speed',[]);assert.equal(s().clips.find(c=>c.id===partner.id)!.keyframes?.['properties.speed'],undefined);
 } finally {store.setState(baseline,true);}
});

test('easeInOutCubic and easeOutBack handles validate, keep time monotonic and overshoot where drawn',()=>{
 for(const curve of [[.65,0,.35,1],[.68,-.6,.32,1.6],[.34,1.56,.64,1]] as [number,number,number,number][]) {
  assert.doesNotThrow(()=>validateKeyframes({'properties.zoom':[{id:'a',time:0,value:100,interpolation:'bezier',curve},{id:'b',time:1,value:120,interpolation:'linear'}]}));
  const x=(t:number)=>3*(1-t)**2*t*curve[0]+3*(1-t)*t*t*curve[2]+t**3;
  for(let i=1;i<=100;i++)assert.ok(x(i/100)>=x((i-1)/100)-1e-12,'time never runs backwards');
  assert.ok(Math.abs(ease(0,curve))<1e-6&&Math.abs(ease(1,curve)-1)<1e-6);
 }
 const inOut=Array.from({length:101},(_,i)=>ease(i/100,[.65,0,.35,1]));
 assert.ok(inOut.every((v,i)=>!i||v>=inOut[i-1]-1e-9),'easeInOutCubic is monotonic');
 assert.ok(Array.from({length:99},(_,i)=>ease((i+1)/100,[.34,1.56,.64,1])).some(v=>v>1.02),'easeOutBack overshoots');
 assert.throws(()=>validateKeyframes({'properties.zoom':[{id:'a',time:0,value:1,interpolation:'bezier',curve:[1.2,0,.5,1]},{id:'b',time:1,value:2,interpolation:'linear'}]}));
});
