import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { commonStyle, getText, isTitle, presetDocument, replaceText, styleText, textContent, validateText, drawText, titlePresets } from './text.ts';
import { useEditorStore as store } from '../state/store.ts';
import { evaluateClip } from './animation.ts';
import { playbackLayers } from './playback.ts';

test('title presets, selection formatting, replacement, multi-layer undo, locks and rendering', () => {
  titlePresets.forEach((_, i) => validateText(presetDocument(i)));
  const doc = replaceText(presetDocument(), 'Hello world');
  const red = styleText(doc, { color: '#ff0000' }, { start: 0, end: 5 });
  assert.equal(textContent(red), 'Hello world'); assert.equal(red.runs[0].text, 'Hello'); assert.equal(red.runs[1].style.color, '#ffffff');
  assert.equal(commonStyle([{ doc: red }]).color, undefined);
  assert.equal(commonStyle([{ doc: red, range: {clipId:'x',start:0,end:5} }]).color, '#ff0000');
  const inserted = replaceText(red, 'Hello brave world');
  assert.equal(inserted.runs[0].style.color, '#ff0000'); assert.equal(inserted.runs.at(-1)!.text, ' brave world');
  assert.equal(styleText(red, {color:'#00ff00'}).runs.length, 1);
  assert.equal(replaceText(red, '').runs.length, 1);
  assert.throws(() => validateText({...doc,width:Infinity}));
  assert.throws(() => validateText({...doc,runs:[{text:'x',style:{...doc.runs[0].style,fontFamily:'bad"font'}}]}));
  const canvas = createCanvas(320,180);drawText(canvas.getContext('2d') as unknown as CanvasRenderingContext2D, red, 320,180,1920,1080);
  assert.ok(canvas.getContext('2d').getImageData(0,0,320,180).data.some((v,i)=>i%4===3&&v>0));
  const original = store.getState();
  try {
    store.setState({ locks:[],operations:[],selectedTextIds:[] });
    const before = store.getState().clips.length;store.getState().addTitle(0);const a = store.getState().selectedClipId!;
    store.getState().addTitle(3);const b = store.getState().selectedClipId!;
    assert.equal(store.getState().clips.length,before+2);assert.ok(store.getState().clips.find(c=>c.id===a)!.trackId!==store.getState().clips.find(c=>c.id===b)!.trackId);
    assert.ok(playbackLayers(store.getState()).filter(l=>isTitle(l.clip)).length===2);
    store.getState().selectText(a,true);store.getState().formatText({fontSize:50,color:'#123456'});
    for (const id of [a,b]) assert.ok(getText(store.getState().clips.find(c=>c.id===id)!).runs.every(run=>run.style.fontSize===50&&run.style.color==='#123456'));
    store.getState().undo();assert.equal(getText(store.getState().clips.find(c=>c.id===a)!).runs[0].style.fontSize,112);
    store.getState().selectText(a);store.getState().copyClip(a);store.getState().setPlayhead(60);store.getState().pasteClip();assert.equal(store.getState().clips.length,before+3);assert.deepEqual(store.getState().selectedTextIds,[store.getState().selectedClipId]);const pasted=store.getState().selectedClipId;store.getState().setPlayhead(62);store.getState().splitClip(pasted!);assert.deepEqual(store.getState().selectedTextIds,[store.getState().selectedClipId]);store.getState().formatText({fontSize:33});assert.equal(getText(store.getState().clips.find(c=>c.id===pasted)!).runs[0].style.fontSize,112);
    store.getState().selectText(a);store.setState({textSelection:{clipId:a,start:0,end:5}});store.getState().formatText({color:'#ff0000'});
    assert.equal(getText(store.getState().clips.find(c=>c.id===a)!).runs[0].text,'AFTER');
    store.setState({locks:[{id:'lock',projectId:store.getState().projectId,targetId:a,field:'textDocument',userId:'ashley',expiresAt:Date.now()+5000}]});
    const old = store.getState().clips;store.getState().formatText({fontSize:99});assert.equal(store.getState().clips,old);
  } finally { store.setState(original,true); }
});

test('word formatting keeps animated styles attached through split, merged, and edited text runs', () => {
  const original=store.getState(),s=store.getState;
  try {
    store.setState({clips:[],nodes:[],comments:[],operations:[],locks:[],selectedClipId:null,selectedClipIds:[],selectedTextIds:[],playhead:0});
    s().addTitle(0,{},undefined,false);const id=s().selectedClipId!;
    const doc=replaceText(getText(s().clips.find(c=>c.id===id)!), 'Hello world');s().updateText([{id,doc}]);
    s().keyframeProperty(id,'text.runs.0.style.fontSize',100);s().setPlayhead(2);s().keyframeProperty(id,'text.runs.0.style.fontSize',200);s().setPlayhead(1);
    store.setState({textSelection:{clipId:id,start:0,end:5}});s().formatText({color:'#ff0000'});
    let clip=s().clips.find(c=>c.id===id)!;
    assert.deepEqual(getText(evaluateClip(clip,1)).runs.map(r=>r.style.fontSize),[150,150]);
    assert.deepEqual(getText(evaluateClip(clip,0)).runs.map(r=>r.style.fontSize),[100,100]);
    assert.equal(clip.keyframes!['text.runs.0.style.fontSize'].length,2);
    assert.equal(clip.keyframes!['text.runs.1.style.fontSize'].length,2);
    s().formatText({fontSize:250});clip=s().clips.find(c=>c.id===id)!;
    assert.deepEqual(getText(evaluateClip(clip,1)).runs.map(r=>r.style.fontSize),[250,150]);
    assert.deepEqual(getText(evaluateClip(clip,2)).runs.map(r=>r.style.fontSize),[200,200]);
    store.setState({textSelection:null});s().formatText({fontSize:300,color:'#ffffff'});clip=s().clips.find(c=>c.id===id)!;
    assert.equal(getText(clip).runs.length,2,'Different animation spans cannot merge away');
    assert.deepEqual(getText(evaluateClip(clip,0)).runs.map(r=>r.style.fontSize),[100,100]);
    assert.deepEqual(getText(evaluateClip(clip,1)).runs.map(r=>r.style.fontSize),[300,300]);
    s().updateText([{id,doc:replaceText(getText(evaluateClip(clip,1)),'Hello brave world')}]);clip=s().clips.find(c=>c.id===id)!;
    assert.equal(textContent(getText(clip)),'Hello brave world');
    assert.ok(getText(evaluateClip(clip,2)).runs.every(r=>r.style.fontSize===200));
    s().undo();assert.equal(textContent(getText(s().clips.find(c=>c.id===id)!)),'Hello world');
  } finally {store.setState(original,true);}
});
