import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useEditorStore as store } from '../state/store.ts';
import { isComposition, validateCompositions, retimeTitleClip } from './compositions.ts';
import { intersects, selectionRect, shiftKeyframes } from './selection.ts';
import { getText } from './text.ts';

const original=store.getState();
const s=()=>store.getState();
test('multi-selection moves atomically; composition layers, navigation, duplicate independence and undo survive serialization',()=>{
  try {
    store.setState({...original,clips:[],nodes:[],comments:[],operations:[],locks:[],playhead:0,selectedClipIds:[],selectedClipId:null});
    s().addTitle(0,{},undefined,false);const title=s().selectedClipId!;
    s().setPlayhead(1);s().addShape('rectangle');const shape=s().selectedClipId!;
    s().selectClip(title,true);assert.deepEqual(new Set(s().selectedClipIds),new Set([title,shape]));
    const count=s().operations.length;s().moveClip(title,2);assert.equal(s().operations.length,count+1);assert.equal(s().clips.find(c=>c.id===shape)!.start,3);
    s().createComposition('Two layers');const parent=s().clips.find(c=>isComposition(c))!;
    assert.equal(parent.start,2);assert.equal(parent.duration,6);const childTimeline=String(parent.properties.compositionId);
    assert.deepEqual(s().clips.filter(c=>c.timelineId===childTimeline).map(c=>c.start),[0,1]);
    validateCompositions(s().clips,s().timelines);
    const main=s().timelineId;s().openComposition(parent.id);assert.equal(s().timelineId,childTimeline);assert.equal(s().playhead,0);
    s().leaveComposition();assert.equal(s().timelineId,main);assert.equal(s().selectedClipId,parent.id);
    s().duplicateClip(parent.id);const copy=s().clips.find(c=>c.id===s().selectedClipId)!;
    assert.notEqual(copy.properties.compositionId,parent.properties.compositionId);
    const copiedText=s().clips.find(c=>c.timelineId===copy.properties.compositionId&&c.mediaId==='frameline-title')!;
    const document=getText(copiedText);document.runs[0].text='Independent';s().updateText([{id:copiedText.id,doc:document}]);
    assert.notEqual(getText(s().clips.find(c=>c.id===title)!).runs[0].text,'Independent');
    s().undo();s().undo();assert.equal(s().clips.filter(isComposition).length,1);assert.ok(!s().timelines.some(t=>t.id===copy.properties.compositionId));
    s().undo();assert.equal(s().clips.filter(isComposition).length,0);assert.equal(s().clips.find(c=>c.id===title)!.timelineId,main);
    s().selectClips([title,shape]);s().deleteClip(title);assert.equal(s().clips.length,0);s().undo();assert.equal(s().clips.length,2);
  }finally{store.setState(original,true);}
});

test('title duration stretches holds, compresses short entrances, and updates composition child exits',()=>{
  try {
    store.setState({...original,clips:[],nodes:[],comments:[],operations:[],locks:[],playhead:0,selectedClipIds:[],selectedClipId:null});
    s().addTitle(30);const parent=s().clips.find(c=>c.id===s().selectedClipId)!;
    assert.ok(isComposition(parent));s().trimClip(parent.id,0,8);
    const children=s().clips.filter(c=>c.timelineId===parent.properties.compositionId);
    assert.ok(children.length>2);assert.ok(children.every(c=>c.duration===8));
    assert.ok(children.every(c=>Math.abs(c.keyframes!['properties.opacity'].at(-1)!.time-(8-1/24))<.001));
    const short=retimeTitleClip(children[0],.5,24);assert.ok(Object.values(short.keyframes!).flat().every(k=>k.time>=0&&k.time<.5));
    s().undo();assert.ok(s().clips.filter(c=>c.timelineId===parent.properties.compositionId).every(c=>c.duration===5));
    s().trimClip(parent.id,1,4);const trimmed=s().clips.find(c=>c.id===parent.id)!;
    assert.equal(trimmed.start,1);assert.equal(trimmed.sourceIn,0);
    assert.ok(s().clips.filter(c=>c.timelineId===parent.properties.compositionId).every(c=>c.duration===4&&c.sourceIn===0));
  }finally{store.setState(original,true);}
});

test('keyframe box selection supports both directions and group moves preserve spacing and reject occupied frames',()=>{
  assert.ok(intersects(selectionRect(80,60,20,10),{x:30,y:20,width:10,height:10}));
  assert.ok(!intersects(selectionRect(80,60,20,10),{x:100,y:20,width:10,height:10}));
  const channels={'properties.x':[{id:'a',time:0,value:0,interpolation:'linear' as const},{id:'b',time:1,value:10,interpolation:'linear' as const},{id:'c',time:3,value:30,interpolation:'linear' as const}]};
  assert.deepEqual(shiftKeyframes(channels,['a','b'],1,5,24)['properties.x'].map(k=>k.time),[1,2,3]);
  assert.equal(shiftKeyframes(channels,['a','b'],2,5,24),channels);
  assert.deepEqual(shiftKeyframes(channels,['a','b'],-5,5,24)['properties.x'].map(k=>k.time),[0,1,3]);
});

test('composition graph rejects cycles and cross-project content',()=>{
  const clip={...original.clips[0],mediaId:'frameline-composition',properties:{compositionId:'nested'}};
  const timeline={...original.timelines[0],id:'nested',composition:true};
  assert.throws(()=>validateCompositions([clip],[{...timeline,projectId:'elsewhere'}]));
  assert.throws(()=>validateCompositions([{...clip,timelineId:'nested'}],[timeline]),/itself/);
});

test('group overwrites subtract every selected interval once and undo restores all fragments',()=>{
  try {
    store.setState({...original,clips:[],nodes:[],comments:[],operations:[],locks:[],playhead:0,selectedClipIds:[],selectedClipId:null});
    s().addTitle(0,{},undefined,false);const source=s().clips[0],track=source.trackId;
    const target={...source,id:'target',start:0,duration:20},a={...source,id:'a',trackId:track,start:22,duration:2},b={...source,id:'b',trackId:track,start:28,duration:2};
    store.setState({clips:[target,a,b],operations:[]});s().selectClips(['a','b']);s().moveClip('a',2);
    assert.deepEqual(s().clips.filter(c=>!['a','b'].includes(c.id)).sort((a,b)=>a.start-b.start).map(c=>[c.start,c.duration]),[[0,2],[4,4],[10,10]]);
    assert.equal(s().operations.length,1);s().undo();assert.deepEqual(s().clips.map(c=>[c.id,c.start,c.duration]),[['target',0,20],['a',22,2],['b',28,2]]);
    s().selectClips(['a','b']);s().duplicateClip('a');assert.ok(s().clips.filter(c=>s().selectedClipIds.includes(c.id)).every(c=>!c.properties.linkGroup));
    assert.equal(s().clips.find(c=>c.id==='b')!.start,28);
  }finally{store.setState(original,true);}
});

test('grouping preserves solo routing and inferred audio detachment across the boundary',()=>{
  try {
    const videoTrack=original.tracks.find(t=>t.timelineId===original.timelineId&&t.kind==='video')!,audioTrack=original.tracks.find(t=>t.timelineId===original.timelineId&&t.kind==='audio')!;
    const asset=original.media.find(m=>m.kind==='video')!,base=original.clips[0];
    const video={...base,id:'v',timelineId:original.timelineId,trackId:videoTrack.id,mediaId:asset.id,start:0,duration:2,sourceIn:0,properties:{}},audio={...video,id:'a',trackId:audioTrack.id};
    store.setState({...original,media:original.media.map(m=>m.id===asset.id?{...m,hasAudio:true}:m),clips:[video,audio],nodes:[],comments:[],operations:[],locks:[],playhead:0,selectedClipIds:[],selectedClipId:null,tracks:original.tracks.map(t=>t.id===audioTrack.id?{...t,solo:true}:t),settings:{...original.settings,linkSelection:false}});
    s().selectClip('a');s().createComposition();const parent=s().clips.find(isComposition)!;
    assert.equal(s().tracks.find(t=>t.id===parent.trackId)!.solo,true);assert.equal(s().clips.find(c=>c.id==='v')!.properties.audioDetached,true);
    s().openComposition(parent.id);s().undo();assert.equal(s().timelineId,original.timelineId);assert.equal(s().clips.find(c=>c.id==='v')!.properties.audioDetached,undefined);
  }finally{store.setState(original,true);}
});
