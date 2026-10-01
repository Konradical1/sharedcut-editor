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

test('a caption holding its pose repaints its last composite instead of laying the words out again', async () => {
  const { captionDocument } = await import('./captions.ts');
  const words = [{ text: 'Hold', start: 0, end: .8 }, { text: 'still', start: .8, end: 1.6 }];
  const doc = captionDocument(words, 'highlight', 2), canvas = createCanvas(320, 180), ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const paint = (d: typeof doc, time: number) => { ctx.clearRect(0, 0, 320, 180); drawText(ctx, d, 320, 180, 1920, 1080, time); return Buffer.from(canvas.getContext('2d').getImageData(0, 0, 320, 180).data).toString('base64'); };
  const held = paint(doc, .5);
  // The same document object in the same pose is not laid out again. The engine hands in a new document
  // object whenever the text changes; an in-place edit (which nothing makes) is how this test sees the cache.
  doc.caption!.words[0].text = 'Changed';
  assert.equal(paint(doc, .6), held, 'same pose, same document object: the cached composite');
  assert.notEqual(paint(structuredClone(doc), .6), held, 'a new document object is drawn from scratch');
  doc.caption!.words[0].text = 'Hold';
  assert.equal(paint(structuredClone(doc), .6), held, 'and matches the cached picture when its content is the same');
  assert.notEqual(paint(doc, 1.2), held, 'the highlight moving to the next word is a new pose');
  // Live playback draws a moving caption once, at the frame's own time; paused frames and exports keep the shutter.
  const live = (d: typeof doc, time: number) => { ctx.clearRect(0, 0, 320, 180); drawText(ctx, d, 320, 180, 1920, 1080, time, undefined, false); return Buffer.from(canvas.getContext('2d').getImageData(0, 0, 320, 180).data).toString('base64'); };
  const entering = structuredClone(doc);
  assert.notEqual(live(entering, .08), paint(structuredClone(doc), .08), 'mid-entrance the shutter smears the motion');
  assert.equal(live(structuredClone(doc), .5), held, 'a held pose is the same picture either way');
  const popping = { ...doc, caption: { ...doc.caption!, wordPop: true } };
  assert.notEqual(live(popping, .9), live(popping, .95), 'a word popping in is a new pose every frame, even drawn once');
  const fresh = (d: typeof doc, time: number) => live(structuredClone(d), time);
  assert.equal(live(popping, .97), fresh(popping, .97), 'and each one matches a drawing from scratch');
});

test('live playback exposes a popping or entering caption through the same shutter, drawn from one raster per word', async () => {
  const { captionDocument } = await import('./captions.ts');
  const words = [{ text: 'Pop', start: 0, end: .5 }, { text: 'goes', start: .5, end: 1 }, { text: 'here', start: 1, end: 1.6 }];
  const doc = captionDocument(words, 'highlight', 2); doc.caption = { ...doc.caption!, wordPop: true };
  const canvas = createCanvas(640, 360), ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const draw = (shutter: boolean | 'live', time: number, d = structuredClone(doc)) => { ctx.clearRect(0, 0, 640, 360); drawText(ctx, d, 640, 360, 1920, 1080, time, undefined, shutter); return canvas.getContext('2d').getImageData(0, 0, 640, 360).data; };
  // Mean difference over the caption's own pixels.
  const distance = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let sum = 0, n = 0; for (let i = 0; i < a.length; i++) if (a[i] || b[i]) { sum += Math.abs(a[i] - b[i]); n++; } return sum / Math.max(1, n); };
  // "goes" early in its pop, and the line early in its entrance: the export draws the vector shutter there.
  for (const [time, margin] of [[.56, 3], [.06, 1.5]]) {
    const exact = draw(true, time), live = draw('live', time), single = draw(false, time);
    assert.ok(distance(live, exact) < distance(single, exact) / margin, `at ${time} s live is ${distance(live, exact).toFixed(2)} from the export, one sample ${distance(single, exact).toFixed(2)}`);
  }
  // Over every frame of the entrance and of one pop, not just their first: live is closer to the export than one sample.
  const frames = [...Array.from({ length: 6 }, (_, i) => i / 30), ...Array.from({ length: 6 }, (_, i) => .55 + i / 30 + .001)];
  const mean = (shutter: 'live' | false) => frames.reduce((sum, t) => sum + distance(draw(shutter, t), draw(true, t)), 0) / frames.length;
  const [live, single] = [mean('live'), mean(false)];
  assert.ok(live < single, `mean over the motion: live ${live.toFixed(2)} from the export, one sample ${single.toFixed(2)}`);
  // Rasters are kept per document: the next frame of the same pop reuses them and draws what a fresh document draws.
  const same = structuredClone(doc);
  assert.deepEqual(draw('live', .62, same), draw('live', .62, same));
  assert.deepEqual(draw('live', .62, same), draw('live', .62));
});

test('live caption rasters are released once the pop ends', async () => {
  const { captionDocument } = await import('./captions.ts');
  const words = [{ text: 'Pop', start: 0, end: .5 }, { text: 'goes', start: .5, end: 1 }, { text: 'here', start: 1, end: 1.6 }];
  const doc = captionDocument(words, 'highlight', 2); doc.caption = { ...doc.caption!, wordPop: true };
  // Off the page, drawing makes its canvases with the target's own constructor: count them there.
  const canvas = createCanvas(640, 360), Element = canvas.constructor as new (w: number, h: number) => object;
  let made = 0;
  Object.defineProperty(canvas, 'constructor', { value: function (w: number, h: number) { made++; return new Element(w, h); } });
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const draw = (time: number) => { const before = made; drawText(ctx, doc, 640, 360, 1920, 1080, time, undefined, 'live'); return made - before; };
  draw(.62); assert.equal(draw(.62), 0, 'the same pop reuses its rasters');
  draw(.9);
  assert.ok(draw(.62) > 0, 'after the pop they were let go, so a later pop rasterizes again');
});
