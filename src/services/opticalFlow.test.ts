import test from 'node:test';
import assert from 'node:assert/strict';
import { flowFrames, flowTiming } from './opticalFlow.ts';
import { graphScale } from './graphScale.ts';
import { animatedSourceOffset, trimAnimation } from './animation.ts';
import type { Clip, Keyframe } from '../state/models.ts';

const keys:Keyframe[]=[{id:'a',time:0,value:100,interpolation:'linear'},{id:'b',time:2,value:50,interpolation:'linear'},{id:'c',time:4,value:50,interpolation:'bezier',curve:[.4,0,.8,1]},{id:'d',time:5,value:500,interpolation:'linear'}];
const clip={id:'clip',mediaId:'source',sourceIn:1,start:10,duration:6,properties:{speed:100,opticalFlow:true},keyframes:{'properties.speed':keys}} as unknown as Clip;
test('optical flow follows integrated ramps, chunk boundaries, trims, freeze and cache identity',()=>{
  const whole=flowFrames(clip,24,24,100),tail=flowFrames(clip,24,24,100,4,2);
  assert.deepEqual(whole.slice(96),tail);
  assert.ok(Math.abs(whole[48].time-2.5)<1e-7);
  for(const [i,frame] of whole.entries())assert.equal(frame.time,clip.sourceIn+animatedSourceOffset(clip,i/24,24));
  const trimmed={...clip,start:12,duration:4,...trimAnimation(clip,12,4)};
  assert.ok(Math.abs(flowFrames(trimmed,24,24,100)[0].time-whole[48].time)<1e-7);
  const frozen={...clip,keyframes:undefined,properties:{speed:50,freeze:true}};
  assert.ok(flowFrames(frozen,24,24,100).every(f=>f.time===1&&!f.interpolate));
  assert.deepEqual(flowTiming({...clip,start:90,properties:{...clip.properties,gain:8}}),flowTiming(clip));
  assert.notDeepEqual(flowTiming({...clip,sourceIn:2}),flowTiming(clip));
  assert.throws(()=>flowFrames(clip,0,24,100));assert.throws(()=>flowFrames(clip,24,24,100,4,3));
});
test('each ramp fits independently and includes overshooting Bézier handles',()=>{
  const first=graphScale(keys,['a','b'],'selection',[0,6]),last=graphScale(keys,['c','d'],'selection',[0,6]);
  assert.equal(first.high-first.low,65);assert.equal(last.high-last.low,585);
  assert.equal(graphScale(keys,['d'],'selection',[0,6]).first,2);
  assert.equal(graphScale(keys,[],'visible',[0,.5]).last,1);
  const overshoot=graphScale([{...keys[0],interpolation:'bezier',curve:[.3,-2,.7,3]},keys[1]],[],'all',[0,2]);
  assert.ok(overshoot.high>200&&overshoot.low< -50);
});
