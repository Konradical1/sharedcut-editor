import assert from 'node:assert/strict';
import test from 'node:test';
import type { Clip, MediaAsset, Track } from '../state/models.ts';
import { gradeValues } from './grade.ts';
import { efficientPlayback, focusClip, gradePixels, playbackLayers, playbackUrl, projectSize, sourceTime, upcomingClips } from './playback.ts';

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
  // Storage v3: Full and Color share full-v3, 1/2 is the Stream file and 1/4 the low stream. Every quality is a field.
  const v3 = { sourceUrl: '/original', proxyUrl: '/full-v3.mp4?v=1', colorProxyUrl: '/full-v3.mp4?v=1', audioProxyUrl: '/audio-v1.m4a', proxyVariants: { Stream: '/stream-v2.mp4', '1/2': '/stream-v2.mp4', StreamLow: '/stream-low-v2.mp4?v=1', '1/4': '/stream-low-v2.mp4?v=1' } } as unknown as MediaAsset;
  for (const [quality, url] of [['Full', '/full-v3.mp4?v=1'], ['Color', '/full-v3.mp4?v=1'], ['1/2', '/stream-v2.mp4'], ['Stream', '/stream-v2.mp4'], ['1/4', '/stream-low-v2.mp4?v=1']] as const) assert.equal(playbackUrl(v3, { original: false, quality }, true), url, quality);
  assert.equal(playbackUrl(v3, { original: false, quality: 'Color' }, false), '/audio-v1.m4a');
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

test('warm-up opens the next cuts on every layer within the horizon, soonest first, and fewer in efficient mode', () => {
  const track = (id: string, kind: string, extra = {}) => ({ id, timelineId: 't', kind, number: 1, muted: false, hidden: false, ...extra });
  const tracks = [track('v1', 'video'), track('v2', 'video'), track('v3', 'video', { hidden: true }), track('a1', 'audio'), track('a2', 'audio', { muted: true })] as Track[];
  const clip = (id: string, trackId: string, start: number, mediaId = 'm') => ({ id, projectId: 'p', timelineId: 't', trackId, mediaId, start, duration: .3, sourceIn: 0, properties: {}, effects: [], disabled: false }) as unknown as Clip;
  const clips = [clip('on-screen', 'v1', 0), clip('v1-a', 'v1', 10.3), clip('v1-b', 'v1', 10.6), clip('v1-c', 'v1', 10.9), clip('title', 'v1', 10.1, 'frameline-title'),
    clip('v2-a', 'v2', 11), clip('v2-far', 'v2', 15), clip('hidden', 'v3', 10.5), clip('a1-a', 'a1', 10.2), clip('a1-b', 'a1', 10.4), clip('a1-c', 'a1', 13), clip('muted', 'a2', 10.1)];
  const state = { projectId: 'p', timelineId: 't', playhead: 10, playing: true, tracks, clips, media: [{ id: 'm', kind: 'video' }] as MediaAsset[] };
  const ids = (list: Clip[]) => list.map(c => c.id);
  const open = new Set(['on-screen']);
  assert.deepEqual(ids(upcomingClips(state, open, false)), ['a1-a', 'v1-a', 'a1-b', 'v1-b', 'v2-a'], 'the next two per visible or audible layer; hidden, muted, far and media-less clips wait');
  assert.deepEqual(ids(upcomingClips(state, open, false, new Set(['v2-a']))), ['v2-a', 'a1-a', 'v1-a', 'a1-b', 'v1-b'], 'a clip in an upcoming transition goes first');
  assert.deepEqual(ids(upcomingClips({ ...state, playing: false }, open, false)), ['v1-a', 'v1-b', 'v2-a'], 'paused, only pictures within two seconds');
  assert.deepEqual(ids(upcomingClips(state, open, true)), ['a1-a', 'v1-a', 'v2-a'], 'efficient mode: one per layer, two pictures');
  assert.deepEqual(ids(upcomingClips(state, new Set(['v1-a']), false)).slice(0, 3), ['a1-a', 'a1-b', 'v1-b'], 'a clip already open is not warmed again');
  // Part 1 v2 has three picture and nine sound layers: without an overall cap that is 24 streams opening at once.
  const dense = Array.from({ length: 12 }, (_, lane) => track(`d${lane}`, lane < 5 ? 'video' : 'audio')) as Track[];
  const denseClips = dense.flatMap((lane, n) => [0, 1, 2].map(k => clip(`${lane.id}-${k}`, lane.id, 10.05 + n * .01 + k * .3)));
  const warm = upcomingClips({ ...state, tracks: dense, clips: denseClips }, new Set(), false);
  const kind = (list: Clip[], video: boolean) => list.filter(c => Number(c.trackId.slice(1)) < 5 === video);
  assert.deepEqual([kind(warm, true).length, kind(warm, false).length], [6, 4], 'at most six pictures and four sounds are warmed');
  assert.ok(warm.every((c, i) => !i || warm[i - 1].start <= c.start), 'soonest first');
  const stalled = upcomingClips({ ...state, tracks: dense, clips: denseClips }, new Set(), false, new Set(), true);
  assert.deepEqual(ids(kind(stalled, true)), ['d0-0', 'd1-0', 'd2-0', 'd3-0', 'd4-0'], 'during a stall only the next cut per layer is warmed');
  assert.equal(kind(stalled, false).length, 4);
  const lean = upcomingClips({ ...state, tracks: dense, clips: denseClips }, new Set(), true);
  assert.deepEqual([kind(lean, true).length, kind(lean, false).length], [2, 4], 'efficient mode keeps two pictures but still warms the next sounds');
});

/** attachPlayback against fake media elements, a manual clock and a manual frame pump. */
async function fakeBrowser(state: Record<string, any>, quality = 'Full', extraGlobals: Record<string, unknown> = {}, preferLowStream?: (url: string) => boolean | undefined) {
  const { attachPlayback } = await import('./playback.ts');
  class Media extends EventTarget {
    readyState = 2; seeking = false; paused = true; duration = 10; videoWidth = 320; videoHeight = 180; preload = '';
    src = ''; muted = true; playbackRate = 1; currentTime = 0; onerror?: () => void; error?: { code: number }; created = 0;
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; } load() {}
  }
  class Canvas {
    width = 300; height = 150; dataset: Record<string, string> = {};
    getContext() { return new Proxy({}, { get: () => () => {} }); }
  }
  const media: Media[] = [], statuses: any[] = [], health: { loading: boolean; error: string }[] = [], clock = { now: 0, frame: () => {} };
  const replacements: Record<string, unknown> = {
    document: { fonts: new EventTarget(), createElement: (name: string) => { if (name === 'canvas') return new Canvas(); const element = Object.assign(new Media(), { created: media.length }); media.push(element); return element; } },
    window: new EventTarget(), HTMLVideoElement: Media, performance: { now: () => clock.now },
    requestAnimationFrame: (callback: () => void) => { clock.frame = callback; return 1; }, cancelAnimationFrame: () => {}, ...extraGlobals,
  };
  const originals = Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  (globalThis.window as EventTarget).addEventListener('frameline:playback-health', event => health.push((event as CustomEvent).detail));
  let current = quality;
  const playback = attachPlayback(new Canvas() as unknown as HTMLCanvasElement, () => state as any, () => ({ original: false, quality: current, volume: 0, compare: false }), status => statuses.push(status), preferLowStream);
  const live = (src: string) => media.filter(element => element.src === src);
  const restore = () => { playback.dispose(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); };
  return { playback, media, live, statuses, health, clock, restore, setQuality: (next: string) => { current = next; }, tick: (ms = 34) => { clock.now += ms; clock.frame(); } };
}
const layerFixture = (id: string, name: string, number: number, kind = 'video', asset: Record<string, unknown> = {}) => ({
  clip: { id, name, projectId: 'p', timelineId: 't', trackId: `${kind[0]}${number}`, mediaId: `m-${id}`, start: 0, duration: 5, sourceIn: 0, properties: {}, effects: [] },
  track: { id: `${kind[0]}${number}`, timelineId: 't', kind, number, muted: false, hidden: false, gain: 0, pan: 0 },
  media: { id: `m-${id}`, name, kind: 'video', sourceUrl: `/${id}.mp4`, duration: 10, fps: 24, ...asset },
});
const timelineState = (layers: ReturnType<typeof layerFixture>[], extra: Record<string, unknown> = {}) => ({ projectId: 'p', timelineId: 't', playhead: 0, playing: false, renderPreviewAllowed: false,
  projects: [{ id: 'p', resolution: '320 × 180', fps: 24 }], clips: layers.map(l => l.clip), tracks: layers.map(l => l.track), media: layers.map(l => l.media), nodes: [], settings: {}, ...extra });

test('camera audio on a sound layer is warmed under the id that plays it, so the warmed element is the one heard at the cut', async () => {
  const dialogue = layerFixture('dialogue', 'Camera A', 1, 'audio', { hasAudio: true, audioProxyUrl: '/camera-audio.m4a' });
  const picture = { ...layerFixture('dialogue-picture', 'Camera A', 1), media: dialogue.media };
  const state = timelineState([dialogue, picture], { playing: true });
  // The picture carries the same camera file linked to the sound layer, so its embedded sound is not the one heard.
  Object.assign(state.clips[0], { start: 1, duration: 2 }); Object.assign(state.clips[1], { mediaId: dialogue.media.id, start: 1, duration: 2 });
  state.media = [dialogue.media];
  const fake = await fakeBrowser(state);
  try {
    for (let i = 0; i < 10; i++) { state.playhead += 1 / 24; fake.tick(); }
    assert.equal(fake.live('/camera-audio.m4a').length, 1, 'one sound element is warmed before the cut');
    for (let i = 0; i < 20; i++) { state.playhead += 1 / 24; fake.tick(); }
    assert.ok(state.playhead > 1);
    const sounds = fake.live('/camera-audio.m4a');
    assert.equal(sounds.length, 1, 'the cut plays the warmed element instead of opening a second one');
    assert.equal(sounds[0].paused, false);
  } finally { fake.restore(); }
});

/** A WebCodecs decode worker that answers each seek with one picture covering any time, except in the `stalled` files. */
const decodeWorker = (stalled: Set<string>) => class {
  onmessage?: (event: { data: unknown }) => void; onerror = null; path = '';
  postMessage(message: { type: string; url?: string; generation?: number }) {
    if (message.type === 'open') this.path = new URL(message.url!).pathname;
    else if (message.type === 'seek' && !stalled.has(this.path)) this.onmessage?.({ data: { type: 'frame', generation: message.generation, frame: { timestamp: 0, duration: 1e9, displayWidth: 320, displayHeight: 180, allocationSize: () => 1, close() {} } } });
  }
  terminate() {}
};
/** Two clips of one asset with a Stream file and its low stream, the second past the warm horizon at first. */
async function streamChoice(settings: Record<string, unknown> = {}, stalled = new Set<string>()) {
  const shot = layerFixture('shot', 'Wide', 1, 'video', { proxyVariants: { Stream: '/stream.mp4', StreamLow: '/low.mp4' } });
  Object.assign(shot.clip, { duration: 8 });
  const state = timelineState([shot], { playing: true, settings });
  state.clips = [...state.clips, { ...shot.clip, id: 'shot-2', start: 8, duration: 2 }];
  // undefined is footageCache's "nothing measures the line" (cache off, no controlling worker, no rate yet).
  const answer: { slow: boolean | undefined } = { slow: false };
  const fake = await fakeBrowser(state, 'Stream', { VideoDecoder: class {}, Worker: decodeWorker(stalled), location: { href: 'http://localhost/' } }, () => answer.slow);
  return { ...fake, state, answer, play: (to: number) => { state.playhead = to; fake.tick(); fake.tick(); } };
}

test('a long wait moves a Stream picture to the low stream only on a line too slow for it, or one nothing measures', async () => {
  const fake = await streamChoice({}, new Set(['/stream.mp4']));
  try {
    fake.tick(); fake.tick(1300); fake.tick(50);
    assert.deepEqual([fake.live('/stream.mp4').length, fake.live('/low.mp4').length], [1, 0], 'a cold start or slow decode on a line that carries the file is waited out at full quality');
    fake.answer.slow = true; fake.tick(50); fake.tick(50);
    assert.deepEqual([fake.live('/stream.mp4').length, fake.live('/low.mp4').length], [0, 1], 'too slow a line with unsaved bytes ahead: the stalled picture moves');
    assert.equal(fake.statuses.at(-1)?.title, 'Auto preview · reduced bandwidth');
  } finally { fake.restore(); }
  // The cache off, or on with no controlling footage worker (blocked, first load, unsupported) or no rate yet.
  for (const settings of [{ footageCache: false }, {}]) {
    const off = await streamChoice(settings, new Set(['/stream.mp4']));
    try {
      off.answer.slow = undefined;
      off.tick(); off.tick(1300); off.tick(50);
      assert.equal(off.live('/low.mp4').length, 1, `nothing measures the line (${JSON.stringify(settings)}): the 1.2 s wait is the signal`);
      const [low] = off.live('/low.mp4');
      off.play(4.5); off.play(8.5);
      assert.deepEqual(off.live('/stream.mp4'), [], 'and its low stream stands for the next clip, rather than stalling on Stream again');
      assert.equal(off.live('/low.mp4').length, 2); assert.ok(off.live('/low.mp4').includes(low));
    } finally { off.restore(); }
  }
});

test('reduced bandwidth is reported only for a picture the automatic rule moved, never for an alpha graphic\'s own 1/4 file', async () => {
  // An alpha graphic's StreamLow is its 1/4 WebM: 1/4 asks for it by name, and Stream falls back to it without a Stream file.
  for (const quality of ['1/4', 'Stream']) {
    const graphic = layerFixture('graphic', 'Lower third', 1, 'video', { hasAlpha: true, proxyVariants: { '1/4': '/graphic-quarter.webm', StreamLow: '/graphic-quarter.webm' } });
    const fake = await fakeBrowser(timelineState([graphic], { playing: true }), quality);
    try {
      fake.tick(); fake.tick();
      assert.equal(fake.live('/graphic-quarter.webm').length, 1);
      assert.equal(fake.statuses.at(-1), null, `${quality}: the graphic plays the file asked for`);
    } finally { fake.restore(); }
  }
});

test('switching from 1/4 to Auto moves an alpha graphic to its Stream file: its 1/4 file is not a low stream the automatic rule chose', async () => {
  // An alpha graphic's StreamLow is the same file as its 1/4. Held as if the automatic rule had picked it, the graphic stayed
  // on 1/4 until its clip ended and showed a false reduced-bandwidth note.
  const graphic = layerFixture('graphic', 'Lower third', 1, 'video', { hasAlpha: true, proxyVariants: { '1/2': '/graphic-half.webm', '1/4': '/graphic-quarter.webm', Stream: '/graphic-half.webm', StreamLow: '/graphic-quarter.webm' } });
  const state = timelineState([graphic], { playing: true }), fake = await fakeBrowser(state, '1/4', {}, () => false);
  try {
    fake.tick(); fake.tick();
    assert.equal(fake.live('/graphic-quarter.webm').length, 1);
    // Playing composites once per timeline frame, so the switch shows from the next picture.
    fake.setQuality('Stream'); state.playhead = .5; fake.tick(); fake.tick();
    assert.equal(fake.live('/graphic-half.webm').length, 1, 'Auto plays the graphic\'s Stream file');
    assert.equal(fake.live('/graphic-quarter.webm').length, 0);
    assert.notEqual(fake.statuses.at(-1)?.title, 'Auto preview · reduced bandwidth');
  } finally { fake.restore(); }
});

test('an asset back from the low stream opens Stream at its next decoder, never mid-shot', async () => {
  const fake = await streamChoice();
  try {
    fake.answer.slow = true; fake.play(0);
    const [low] = fake.live('/low.mp4');
    assert.ok(low && !fake.live('/stream.mp4').length, 'a slow line with nothing saved opens the low stream');
    fake.answer.slow = false; fake.play(2); fake.play(4);
    assert.deepEqual(fake.live('/low.mp4'), [low], 'the clip on screen keeps its stream when the background fill catches up');
    assert.deepEqual(fake.live('/stream.mp4'), []);
    assert.equal(fake.statuses.at(-1)?.title, 'Auto preview · reduced bandwidth');
    fake.play(4.5);
    assert.equal(fake.live('/stream.mp4').length, 1, 'the next clip of the asset asks again and opens Stream before its cut');
    assert.deepEqual(fake.live('/low.mp4'), [low], 'while the shot on screen still plays the low stream');
    fake.play(8.5);
    assert.equal(fake.statuses.at(-1), null, 'full quality after the cut');
  } finally { fake.restore(); }
});

test('a clip of a file another decoder plays on Stream still asks, and opens low without moving the one on screen', async () => {
  const fake = await streamChoice();
  try {
    fake.play(0);
    const [stream] = fake.live('/stream.mp4');
    assert.ok(stream && !fake.live('/low.mp4').length);
    fake.answer.slow = true; fake.play(4.5);
    assert.equal(fake.live('/low.mp4').length, 1, 'the warmed next clip opens the low stream instead of freezing 1.2 s on unsaved Stream bytes');
    assert.deepEqual(fake.live('/stream.mp4'), [stream], 'the shot on screen keeps Stream');
    assert.equal(fake.statuses.at(-1), null);
    fake.play(8.5);
    assert.equal(fake.statuses.at(-1)?.title, 'Auto preview · reduced bandwidth');
  } finally { fake.restore(); }
});

test('paused, a failed layer is retried in the background; Retry reopens only failed layers; a load failure says so', async () => {
  const base = layerFixture('base', 'Interview', 1), graphic = layerFixture('graphic', 'Lower third', 2);
  const state = timelineState([base, graphic]);
  const fake = await fakeBrowser(state);
  try {
    fake.tick(); fake.tick();
    const [graphicElement] = fake.live('/graphic.mp4');
    Object.assign(graphicElement, { readyState: 0, error: { code: 4 } }); graphicElement.onerror!();
    fake.tick();
    assert.deepEqual(fake.statuses.at(-1), { title: 'Showing without 1 layer', detail: 'Lower third (could not be loaded)', skipped: true }, 'a 404 is not a decode error, and nothing is playing');
    for (let i = 0; i < 3; i++) fake.tick(1000);
    const reopened = fake.live('/graphic.mp4');
    assert.ok(reopened.length === 1 && reopened[0] !== graphicElement, 'reopened without a seek or play to wake the viewer');
    assert.equal(fake.statuses.at(-1), null);
    // Playing: the notice's Retry reopens the failed layer at once and leaves the healthy one alone.
    state.playing = true;
    const [baseElement] = fake.live('/base.mp4');
    Object.assign(reopened[0], { readyState: 0 }); reopened[0].onerror!();
    state.playhead += 1 / 24; fake.tick();
    assert.equal(fake.statuses.at(-1)?.title, 'Playing without 1 layer');
    fake.playback.retryLayers(); state.playhead += 1 / 24; fake.tick();
    assert.equal(fake.live('/graphic.mp4').length, 1); assert.notEqual(fake.live('/graphic.mp4')[0], reopened[0]);
    assert.deepEqual(fake.live('/base.mp4'), [baseElement], 'the healthy layer keeps its decoder');
    assert.equal(fake.health.at(-1)!.loading, false);
    assert.equal(fake.statuses.at(-1), null);
  } finally { fake.restore(); }
});

test('a failed layer is drawn around, named with a retry and reopened in the background; the playhead never waits for it', async () => {
  const { attachPlayback } = await import('./playback.ts');
  const globals = ['document', 'window', 'HTMLVideoElement', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const;
  const original = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const videos: Video[] = [];
  let nextFrame = () => {}, now = 0;
  class Video extends EventTarget {
    static ready = 2;
    readyState = Video.ready; seeking = false; paused = true; duration = 5; videoWidth = 320; videoHeight = 180;
    src = ''; muted = true; playbackRate = 1; currentTime = 0; onerror?: () => void; rejectPlay?: string;
    play() { if (this.rejectPlay && !this.muted) return Promise.reject(Object.assign(new Error('blocked'), { name: this.rejectPlay })); this.paused = false; return Promise.resolve(); }
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
  const canvas = new Canvas(), statuses: unknown[] = [], health: { loading: boolean; error: string }[] = [];
  const layer = (id: string, name: string, number: number) => ({ clip: { id, name, projectId: 'p', timelineId: 't', trackId: `v${number}`, mediaId: `m-${id}`, start: 0, duration: 5, sourceIn: 0, properties: {}, effects: [] }, track: { id: `v${number}`, timelineId: 't', kind: 'video', number }, media: { id: `m-${id}`, name, kind: 'video', sourceUrl: `/${id}.mp4`, duration: 5, fps: 24 } });
  const base = layer('base', 'Interview', 1), graphic = layer('graphic', 'Lower third', 2);
  const state = { projectId: 'p', timelineId: 't', playhead: 0, playing: true, projects: [{ id: 'p', resolution: '320 × 180', fps: 24 }],
    clips: [base.clip, graphic.clip], tracks: [base.track, graphic.track], media: [base.media, graphic.media], nodes: [], settings: {} };
  window.addEventListener('frameline:playback-health', event => health.push((event as CustomEvent).detail));
  const playback = attachPlayback(canvas as unknown as HTMLCanvasElement, () => state as unknown as ReturnType<Parameters<typeof attachPlayback>[1]>, () => ({ original: false, quality: 'Full', volume: 0, compare: false }), status => statuses.push(status));
  const step = (ms = 42) => { now += ms; state.playhead += 1 / 24; nextFrame(); };
  const graphicVideos = () => videos.filter(v => v.src === '/graphic.mp4');
  try {
    step(); assert.equal(graphicVideos().length, 1);
    graphicVideos()[0].onerror!();
    const painted = canvas.paints;
    step();
    assert.deepEqual(statuses.at(-1), { title: 'Playing without 1 layer', detail: 'Lower third (source could not be decoded)', skipped: true }, 'the failed layer is named, not blocking');
    assert.equal(health.at(-1)!.loading, false, 'the playhead is not held for a failed layer');
    assert.ok(canvas.paints > painted && canvas.dataset.hasPicture === 'true', 'the rest of the picture is still drawn');
    // After the pause the layer is reopened in the background; while it loads it is still drawn around.
    Video.ready = 0; step(2100); step();
    assert.equal(graphicVideos().length, 2, 'a fresh decoder replaces the failed one');
    assert.deepEqual(statuses.at(-1), { title: 'Playing without 1 layer', detail: 'Lower third (reconnecting)', skipped: true });
    assert.equal(health.at(-1)!.loading, false, 'a reconnecting layer is not waited for either');
    graphicVideos()[1].readyState = 2; step();
    assert.equal(statuses.at(-1), null, 'once it has a picture the layer is back and the notice clears');
    // A genuinely new layer that is not ready yet still holds the picture, as before.
    state.clips = [...state.clips, { ...layer('late', 'B-roll', 3).clip }]; state.tracks = [...state.tracks, layer('late', 'B-roll', 3).track]; state.media = [...state.media, layer('late', 'B-roll', 3).media];
    step();
    assert.equal(health.at(-1)!.loading, true, 'an unready layer that has not failed is loading, not skipped');
    videos.filter(v => v.src === '/late.mp4').forEach(v => { v.readyState = 2; });
    Video.ready = 2;
    // Autoplay refused: the picture keeps running muted instead of failing the layer.
    const refusing = videos.filter(v => v.src === '/base.mp4');
    refusing.forEach(v => { v.rejectPlay = 'NotAllowedError'; v.paused = true; });
    step(); await new Promise(resolve => setTimeout(resolve, 0)); step(); step();
    assert.ok(refusing.every(v => !v.paused && v.muted), 'the refused element plays muted');
    assert.equal(health.at(-1)!.error, '', 'autoplay policy is not a layer failure');
    playback.retry(); step();
    assert.equal(statuses.at(-1), null);
  } finally {
    playback.dispose();
    globals.forEach((key, index) => { if (original[index]) Object.defineProperty(globalThis, key, original[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
});
