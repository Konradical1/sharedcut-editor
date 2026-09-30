import assert from 'node:assert/strict';
import test from 'node:test';
import type { Clip, MediaAsset, Track } from '../state/models.ts';
import { gradeValues } from './grade.ts';
import { efficientPlayback, focusClip, gradePixels, playbackLayers, playbackUrl, projectSize, sourceTime } from './playback.ts';

test('preview quality selects a smaller stream, audio selects its own stream, and old imports fall back', () => {
  const asset = { sourceUrl: '/original', proxyUrl: '/full', proxyVariants: { '1/2': '/half', '1/4': '/quarter' }, audioProxyUrl: '/audio' } as unknown as MediaAsset;
  assert.equal(playbackUrl(asset, { original: false, quality: '1/4' }, true), '/quarter');
  assert.equal(playbackUrl(asset, { original: false, quality: '1/2' }, true), '/half');
  assert.equal(playbackUrl(asset, { original: false, quality: 'Full' }, true), '/full');
  const precise={...asset,colorProxyUrl:'/precise'};
  assert.equal(playbackUrl(precise,{original:false,quality:'Color'},true),'/precise');
  assert.equal(playbackUrl(precise,{original:false,quality:'Full'},true),'/precise');
  assert.equal(playbackUrl(asset,{original:false,quality:'Color'},true),'/original');
  assert.equal(playbackUrl(precise,{original:false,quality:'Color'},false),'/audio');
  assert.equal(playbackUrl(asset, { original: false, quality: '1/4' }, false), '/audio');
  assert.equal(playbackUrl(asset, { original: true, quality: '1/4' }, true), '/original');
  assert.equal(playbackUrl({ ...asset, proxyVariants: undefined }, { original: false, quality: '1/4' }, true), '/full');
  const streamed = { ...asset, proxyVariants: { ...asset.proxyVariants, Stream: '/stream' } } as unknown as MediaAsset;
  assert.equal(playbackUrl(streamed, { original: false, quality: 'Stream' }, true), '/stream');
  // An import that has not been through the upgrade pass must step down, never up: the all-intra
  // full proxy is the ~80 Mbit/s stream this quality exists to keep off a remote viewer's link.
  assert.equal(playbackUrl(asset, { original: false, quality: 'Stream' }, true), '/half');
  assert.equal(playbackUrl({ ...asset, proxyVariants: { '1/4': '/quarter' } } as unknown as MediaAsset, { original: false, quality: 'Stream' }, true), '/quarter');
  assert.equal(playbackUrl({ ...asset, proxyVariants: undefined }, { original: false, quality: 'Stream' }, true), '/full');
  assert.equal(playbackUrl(streamed, { original: false, quality: 'Stream' }, false), '/audio');
});

test('timeline preview obeys source trims, speed, reverse, freeze, routing, and SDR values', () => {
  const clip = { id: 'picture', projectId: 'project', timelineId: 'timeline', trackId: 'v1', mediaId: 'media', start: 10, duration: 4, sourceIn: 3, disabled: false, properties: { speed: 200 }, effects: [] } as unknown as Clip;
  assert.equal(sourceTime(clip, 11), 5);
  assert.ok(Math.abs(sourceTime({ ...clip, properties: { speed: 200, reverse: true } }, 11, 24) - (9 - 1 / 24)) < 1e-9);
  assert.equal(sourceTime({ ...clip, properties: { freeze: true } }, 12), 3);
  assert.equal(sourceTime(clip, 14, 24, 6), 6 - 1 / 24);
  assert.deepEqual(projectSize('1080 × 1920'), [1080, 1920]);
  assert.deepEqual(projectSize('invalid'), [1920, 1080]);
  const tracks = [{ id: 'v1', timelineId: 'timeline', kind: 'video', number: 1, muted: false, hidden: false, solo: false }, { id: 'a1', timelineId: 'timeline', kind: 'audio', number: 1, muted: false, solo: true }] as Track[];
  const audio = { ...clip, id: 'audio', trackId: 'a1' };
  const state = { projectId: 'project', timelineId: 'timeline', playhead: 11, tracks, clips: [clip, audio], media: [{ id: 'media', kind: 'video', hasAudio: true } as MediaAsset] };
  const layers = playbackLayers(state);
  assert.equal(layers.find(l => l.clip.id === 'picture')?.audible, false);
  assert.equal(layers.find(l => l.clip.id === 'audio')?.audible, true);
  assert.equal(playbackLayers({ ...state, playhead: 14 }).length, 0);
  assert.equal(playbackLayers({ ...state, clips: [{ ...clip, disabled: true }] }).length, 0);
  assert.equal(playbackLayers({ ...state, tracks: tracks.map(t => ({ ...t, hidden: true })) })[0].visual, false);
  const pixels = new Uint8ClampedArray([50, 100, 150, 255]);
  gradePixels(pixels, gradeValues([])); assert.deepEqual([...pixels], [50, 100, 150, 255]);
  gradePixels(pixels, gradeValues([{ name: 'Exposure', enabled: true, parameters: { exposure: 1 } }])); assert.deepEqual([...pixels], [100, 200, 255, 255]);
});

test('scrubbing retains decoded pictures and reuses decoders while coalescing seeks', async () => {
  const { attachPlayback } = await import('./playback.ts');
  const globals = ['document', 'window', 'HTMLVideoElement', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const;
  const original = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const videos: Video[] = [];
  let nextFrame = () => {}, now = 0;
  class Video extends EventTarget {
    readyState = 2; seeking = false; paused = true; duration = 5; videoWidth = 320; videoHeight = 180;
    src = ''; muted = true; playbackRate = 1; time = 0; seeks: number[] = [];
    get currentTime() { return this.time; }
    set currentTime(time: number) { this.time = time; this.seeking = true; this.seeks.push(time); }
    finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() {} load() {}
  }
  class Canvas {
    width = 300; height = 150; dataset: Record<string, string> = {}; paints = 0;
    getContext() { return new Proxy({}, { get: (_, key) => key === 'drawImage' ? () => this.paints++ : () => {} }); }
  }
  const replacements = {
    document: { fonts: new EventTarget(), createElement: (name: string) => { if (name === 'canvas') return new Canvas(); const video = new Video(); videos.push(video); return video; } },
    window: new EventTarget(), HTMLVideoElement: Video, performance: { now: () => now },
    requestAnimationFrame: (callback: () => void) => { nextFrame = callback; return 1; }, cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: replacements[key] });
  const canvas = new Canvas();
  const state = {
    projectId: 'p', timelineId: 't', playhead: 0, playing: false,
    projects: [{ id: 'p', resolution: '320 × 180', fps: 24 }],
    clips: [{ id: 'c', projectId: 'p', timelineId: 't', trackId: 'v', mediaId: 'm', start: 0, duration: 5, sourceIn: 0, properties: {}, effects: [] }],
    tracks: [{ id: 'v', timelineId: 't', kind: 'video', number: 1 }],
    media: [{ id: 'm', name: 'Test video', kind: 'video', sourceUrl: '/test.mp4', duration: 5, fps: 24 }], nodes: [], settings: {},
  };
  const statuses: unknown[] = [];
  const playback = attachPlayback(canvas as unknown as HTMLCanvasElement, () => state as unknown as ReturnType<Parameters<typeof attachPlayback>[1]>, () => ({ original: false, quality: 'Full', volume: 0, compare: false }), status => statuses.push(status));
  try {
    nextFrame(); assert.equal(canvas.dataset.hasPicture, 'true'); assert.equal(videos.length, 1);
    state.settings = { performanceMode: 'On' }; state.playing = true;
    const initialPaints = canvas.paints;
    now = 10; nextFrame(); assert.equal(canvas.paints, initialPaints, 'Efficient playback skips duplicate refreshes within a timeline frame.');
    now = 43; state.playhead=1/24; nextFrame(); assert.equal(canvas.paints, initialPaints + 1);
    assert.equal(canvas.width, 320); assert.equal(canvas.height, 180, 'Efficient mode retains preview resolution.');
    state.playing = false; nextFrame(); videos[0].finishSeek(); videos[0].seeks=[];
    now = 60_000; state.playhead = 1; nextFrame();
    const painted = canvas.paints;
    state.playhead = 2; nextFrame(); state.playhead = 3; nextFrame();
    assert.equal(canvas.paints, painted, 'A seek must leave the last completed picture intact.');
    assert.deepEqual(videos[0].seeks, [1+.5/24], 'A pending decode is not repeatedly canceled.');
    assert.equal(statuses.at(-1), null, 'A quick paused seek is a scrub, not buffering: the viewer stays clean.');
    now += 701; nextFrame(); assert.deepEqual(statuses.at(-1), { title: 'Loading picture…', detail: 'Test video · Seeking frame', loading: true }, 'A slow decode continues to report the blocking clip.');
    videos[0].finishSeek(); nextFrame();
    assert.equal(canvas.paints, painted + 1, 'Paint the completed frame before seeking again.');
    assert.deepEqual(videos[0].seeks, [1+.5/24, 3+.5/24], 'Skip superseded targets and decode the newest playhead.');
    videos[0].finishSeek(); nextFrame();
    state.playhead = 6; nextFrame(); assert.equal(canvas.dataset.hasPicture, 'false', 'Timeline gaps really are empty.');
    state.playhead = 1; nextFrame(); assert.equal(videos.length, 1, 'Returning across an edit reuses the warm decoder.');
    assert.equal(statuses.at(-1), null);
    videos[0].finishSeek();nextFrame();
    const child={...state.clips[0],timelineId:'child',trackId:'child-v'};
    const parent={...state.clips[0],id:'parent',mediaId:'frameline-composition',duration:3,sourceIn:1,properties:{compositionId:'child'}};
    state.clips=[parent,child];state.tracks=[...state.tracks,{...state.tracks[0],id:'child-v',timelineId:'child'}];state.playhead=0;nextFrame();
    assert.equal(videos.length,1,'Grouping a clip retains the same warm source decoder.');
    state.playhead=1;nextFrame();const pending=videos[0].seeks.length;
    state.playhead=2;nextFrame();assert.equal(videos[0].seeks.length,pending,'Nested composition scrubs coalesce pending seeks.');
    videos[0].finishSeek();nextFrame();assert.equal(videos[0].seeks.at(-1),3+.5/24,'The newest nested seek includes the composition source trim.');
    videos[0].finishSeek();nextFrame();state.timelineId='child';state.playhead=3;nextFrame();
    assert.equal(videos.length,1,'Opening the composition keeps its completed media decoder.');
    state.clips=[child,{...child,id:'upcoming-title',mediaId:'frameline-title',start:3.5},{...child,id:'upcoming-video',start:4}];nextFrame();
    assert.equal(videos.length,2,'A title must not consume the efficient-mode video preload slot.');
    // Two active layers plus three rapid upcoming cuts exceed the old four-decoder cap.
    state.settings={performanceMode:'Off'};state.playing=true;state.playhead=0;
    state.clips=Array.from({length:5},(_,i)=>({...child,id:`cut-${i}`,start:i<2?0:i-1,duration:i<2?1:.8,sourceIn:1}));
    now+=50;nextFrame();videos.forEach(v=>v.finishSeek());now+=50;nextFrame();
    videos.forEach(v=>v.finishSeek());now+=50;nextFrame();
    const prepared=videos.length;
    for(let i=0;i<4;i++){now+=50;state.playhead+=1/24;nextFrame();videos.forEach(v=>v.finishSeek());}
    assert.equal(videos.length,prepared,'Upcoming decoders survive the spare decoder cap.');
    const active=videos.slice(-5,-3);active.forEach(v=>{v.seeking=true;});
    now+=50;state.playhead+=1/24;nextFrame();active.forEach(v=>v.finishSeek());now+=50;nextFrame();
    assert.equal(videos.length,prepared,'A buffering frame must not discard the prepared next cuts.');
    state.media=state.media.map(m=>Object.assign({...m},{proxyVariants:{Stream:'/prepared-later.mp4'}}));
    (videos.at(-1) as any).onerror();now+=50;state.playhead+=1/24;nextFrame();
    assert.ok(videos.some(v=>v.src==='/prepared-later.mp4'),'A decoder sees Stream proxies published after it was created.');

  } finally {
    playback.dispose();
    globals.forEach((key, index) => { if (original[index]) Object.defineProperty(globalThis, key, original[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
});

test('detached video never resurrects its embedded audio after an unlink or audio deletion',()=>{
  const clip={id:'v',projectId:'p',timelineId:'t',trackId:'v1',mediaId:'m',start:0,duration:5,sourceIn:0,properties:{audioDetached:true},effects:[],disabled:false} as any;
  const layer=playbackLayers({projectId:'p',timelineId:'t',playhead:1,clips:[clip],tracks:[{id:'v1',timelineId:'t',kind:'video',number:1,muted:false}] as any,media:[{id:'m',kind:'video',hasAudio:true}] as any})[0];
  assert.equal(layer.visual,true);assert.equal(layer.audible,false);
});

test('composition preview groups transparent layers at local source time and catches cycles',async()=>{
  const { attachPlayback }=await import('./playback.ts'),{createCanvas}=await import('@napi-rs/canvas'),{defaultShape}=await import('./shapes.ts');
  const globals=['document','window','HTMLVideoElement','requestAnimationFrame','cancelAnimationFrame'] as const;
  const originals=globals.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  let nextFrame=()=>{};
  const makeCanvas=()=>Object.assign(createCanvas(64,64),{dataset:{} as Record<string,string>});
  const replacements={document:{fonts:new EventTarget(),createElement:()=>makeCanvas()},window:new EventTarget(),HTMLVideoElement:class {},requestAnimationFrame:(f:()=>void)=>{nextFrame=f;return 1;},cancelAnimationFrame:()=>{}};
  for(const key of globals)Object.defineProperty(globalThis,key,{configurable:true,value:replacements[key]});
  const shape=(id:string,timelineId:string,number:number,properties:Clip['properties'])=>({id,projectId:'p',timelineId,trackId:`${timelineId}${number}`,mediaId:'frameline-shape',name:id,start:0,duration:4,sourceIn:0,color:'#fff',disabled:false,properties,effects:[]} as Clip);
  const red=shape('red','main',1,{shapeDocument:JSON.stringify({...defaultShape(),x:0,y:0,width:1,height:1,fill:'#ff0000'})});
  const blue=shape('blue','inner',1,{rotation:90,shapeDocument:JSON.stringify({...defaultShape(),x:.125,y:.25,width:.25,height:.5,fill:'#0000ff'})});blue.start=1;blue.duration=1;
  const nested={...shape('nested','middle',1,{compositionId:'inner',x:8}),mediaId:'frameline-composition'};
  const parent={...shape('parent','main',2,{compositionId:'middle',x:8,opacity:50}),mediaId:'frameline-composition',sourceIn:1,duration:1};
  const state={projectId:'p',timelineId:'main',playhead:0,playing:false,projects:[{id:'p',resolution:'64 × 64',fps:8}],timelines:['main','middle','inner'].map(id=>({id,projectId:'p',name:id,duration:4})),clips:[red,parent,nested,blue],tracks:[['main',1],['main',2],['middle',1],['inner',1]].map(([timelineId,number])=>({id:`${timelineId}${number}`,timelineId,number,kind:'video',muted:false,hidden:false,solo:false,gain:0,pan:0})),media:[],nodes:[],settings:{}};
  const canvas=makeCanvas(),statuses:unknown[]=[];
  const playback=attachPlayback(canvas as unknown as HTMLCanvasElement,()=>state as any,()=>({original:false,quality:'Full',volume:0,compare:false}),s=>statuses.push(s));
  try {
    nextFrame();
    const pixel=(x:number,y:number)=>[...canvas.getContext('2d').getImageData(x,y,1,1).data];
    assert.deepEqual(pixel(3,3),[255,0,0,255],'Transparent composition corners retain underlying footage.');
    assert.ok(pixel(30,30).every((v,i)=>Math.abs(v-[127,0,128,255][i])<=1),'A composition source trim displays its own local-time layers.');
    assert.ok(pixel(42,30).every((v,i)=>Math.abs(v-[127,0,128,255][i])<=1),'Shape rotation pivots at the shape center before parent transforms.');
    assert.deepEqual(pixel(12,30),[255,0,0,255],'Nested transforms apply once each.');
    assert.equal(canvas.dataset.hasPicture,'true');
    assert.equal(statuses.at(-1),null);
    state.clips=[red,parent,nested,{...blue,mediaId:'frameline-composition',properties:{compositionId:'main'}}];nextFrame();
    assert.match(JSON.stringify(statuses.at(-1)),/cycle/);
    state.timelineId='inner';state.clips=[red,parent,nested,blue];state.playhead=1;nextFrame();
    assert.deepEqual(pixel(3,3),[0,0,0,255],'Opening the composition displays only its own timeline.');
    assert.deepEqual(pixel(16,32),[0,0,255,255]);
  } finally {playback.dispose();globals.forEach((key,i)=>{if(originals[i])Object.defineProperty(globalThis,key,originals[i]!);else Reflect.deleteProperty(globalThis,key);});}
});

test('efficient playback auto detection respects overrides and missing hardware hints', () => {
  assert.equal(efficientPlayback(undefined, { hardwareConcurrency: 4 }), true);
  assert.equal(efficientPlayback('Auto', { hardwareConcurrency: 8, deviceMemory: 4 }), true);
  assert.equal(efficientPlayback('Auto', { hardwareConcurrency: 8, deviceMemory: 8 }), false);
  assert.equal(efficientPlayback('Auto', {}), false);
  assert.equal(efficientPlayback('Auto', { hardwareConcurrency: 0, deviceMemory: 0 }), false);
  assert.equal(efficientPlayback('Off', { hardwareConcurrency: 2 }), false);
  assert.equal(efficientPlayback('On', { hardwareConcurrency: 16, deviceMemory: 16 }), true);
});


test('a fractional-frame cut selects the incoming picture on the cut, without repeating the outgoing frame',()=>{
  const clip={id:'out',projectId:'p',timelineId:'t',trackId:'v',mediaId:'m',start:13.888874999999999,duration:1.1261250000000027,sourceIn:0,properties:{},effects:[]} as unknown as Clip;
  const incoming={...clip,id:'in',start:15.015000000000002,duration:1};
  const state={projectId:'p',timelineId:'t',playhead:360/(24000/1001),clips:[clip,incoming],tracks:[{id:'v',timelineId:'t',kind:'video',number:1}] as Track[],media:[{id:'m',kind:'video'}] as MediaAsset[]};
  assert.deepEqual(playbackLayers(state,24000/1001).map(l=>l.clip.id),['in']);
  assert.deepEqual(playbackLayers({...state,playhead:state.playhead-1/(24000/1001)},24000/1001).map(l=>l.clip.id),['out']);
});

test("a frame editor reads its clip untransformed at any source second, playing through at the clip's own rate", () => {
  const asset = { duration: 20, fps: 60 } as MediaAsset;
  const clip = { id: 'c', projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'm', start: 10, duration: 4, sourceIn: 3, disabled: true, properties: { speed: 50, x: 300, zoom: 180 }, effects: [{ name: 'Smart Mask' }], keyframes: { 'properties.x': [] } } as unknown as Clip;
  // The engine asks for source second t at timeline second t·100/speed.
  const focus = focusClip(clip, asset), at = (source: number) => sourceTime(focus, source * 100 / Number(focus.properties.speed), 60, asset.duration);
  for (const source of [0, 1 / 60, 7.25, 19.9]) assert.ok(Math.abs(at(source) - source) < 1e-9, `source ${source} reads itself`);
  assert.equal(focus.properties.speed, 50, 'a constant speed keeps its rate so playback runs through without seeking');
  assert.deepEqual([focus.effects, focus.keyframes, focus.disabled, focus.properties.x], [[], undefined, false, 300]);
  for (const properties of [{ speed: 50, reverse: true }, { speed: 300, freeze: true }] as Clip['properties'][]) assert.equal(focusClip({ ...clip, properties }, asset).properties.speed, 100, 'reversed or frozen clips read forward at 100%');
  assert.equal(focusClip({ ...clip, keyframes: { 'properties.speed': [] } } as unknown as Clip, asset).properties.speed, 100, 'a speed ramp reads at 100%');
  const ramp = focusClip({ ...clip, keyframes: { 'properties.speed': [] } } as unknown as Clip, asset, 400);
  assert.equal(ramp.properties.speed, 400, 'playing a ramp, the rate it has reached drives the decoder');
  assert.ok(Math.abs(sourceTime(ramp, 7.25 * 100 / 400, 60, asset.duration) - 7.25) < 1e-9, 'and still reads the asked source second');
});

test('a flipped clip mirrors after its effects, as the export does, so an off-center vignette follows the picture',async()=>{
  const { attachPlayback }=await import('./playback.ts'),napi=await import('@napi-rs/canvas');
  const globals=['document','window','HTMLVideoElement','Image','requestAnimationFrame','cancelAnimationFrame'] as const;
  const originals=globals.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  let nextFrame=()=>{};
  const makeCanvas=()=>Object.assign(napi.createCanvas(64,64),{dataset:{} as Record<string,string>});
  // Source: red left half, blue right half.
  const source=napi.createCanvas(64,64),paint=source.getContext('2d');paint.fillStyle='#ff0000';paint.fillRect(0,0,32,64);paint.fillStyle='#0000ff';paint.fillRect(32,0,32,64);
  const url=`data:image/png;base64,${(await source.encode('png')).toString('base64')}`;
  const TestImage=class extends (napi.Image as any) { set src(value:string){super.src=Buffer.from(value.split(',')[1],'base64');queueMicrotask(()=>(this as any).onload?.());} get src(){return url;} };
  const replacements={document:{fonts:new EventTarget(),createElement:()=>makeCanvas()},window:new EventTarget(),HTMLVideoElement:class {},Image:TestImage,requestAnimationFrame:(f:()=>void)=>{nextFrame=f;return 1;},cancelAnimationFrame:()=>{}};
  for(const key of globals)Object.defineProperty(globalThis,key,{configurable:true,value:replacements[key]});
  const clip={id:'c',projectId:'p',timelineId:'main',trackId:'v1',mediaId:'m',name:'selfie',start:0,duration:4,sourceIn:0,color:'#fff',disabled:false,properties:{flipH:true},
    effects:[{id:'v',name:'Vignette',enabled:true,amount:100,parameters:{centerX:0,centerY:50}}]} as unknown as Clip;
  const state={projectId:'p',timelineId:'main',playhead:0,playing:false,projects:[{id:'p',resolution:'64 × 64',fps:8}],timelines:[{id:'main',projectId:'p',name:'main',duration:4}],clips:[clip],
    tracks:[{id:'v1',timelineId:'main',number:1,kind:'video',muted:false,hidden:false,solo:false,gain:0,pan:0}],media:[{id:'m',projectId:'p',name:'still',kind:'image',status:'ready',duration:4,fps:0,proxyUrl:url,thumbnail:url}],nodes:[],settings:{}};
  const canvas=makeCanvas();
  const playback=attachPlayback(canvas as unknown as HTMLCanvasElement,()=>state as any,()=>({original:false,quality:'Full',volume:0,compare:false}),()=>{});
  try {
    for(let i=0;i<5;i++){nextFrame();await new Promise(r=>setTimeout(r,5));}
    const pixel=(x:number)=>[...canvas.getContext('2d').getImageData(x,32,1,1).data];
    // Export: vignette centered on the source's left (red) edge, then hflip -> bright red on the right, dark blue on the left.
    assert.ok(pixel(62)[0]>200&&pixel(62)[2]<40,`the red half is mirrored to the right and keeps the vignette's bright center, got ${pixel(62)}`);
    assert.ok(pixel(1)[2]<150&&pixel(1)[0]<40,`the blue half is mirrored to the left and darkened, got ${pixel(1)}`);
  } finally {playback.dispose();globals.forEach((key,i)=>{if(originals[i])Object.defineProperty(globalThis,key,originals[i]!);else Reflect.deleteProperty(globalThis,key);});}
});
