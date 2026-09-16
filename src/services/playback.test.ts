import assert from 'node:assert/strict';
import test from 'node:test';
import type { Clip, MediaAsset, Track } from '../state/models.ts';
import { gradeValues } from './grade.ts';
import { efficientPlayback, gradePixels, playbackLayers, playbackUrl, projectSize, sourceTime } from './playback.ts';

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
    media: [{ id: 'm', kind: 'video', sourceUrl: '/test.mp4', duration: 5, fps: 24 }], nodes: [], settings: {},
  };
  const statuses: unknown[] = [];
  const playback = attachPlayback(canvas as unknown as HTMLCanvasElement, () => state as unknown as ReturnType<Parameters<typeof attachPlayback>[1]>, () => ({ original: false, quality: 'Full', volume: 0, compare: false }), status => statuses.push(status));
  try {
    nextFrame(); assert.equal(canvas.dataset.hasPicture, 'true'); assert.equal(videos.length, 1);
    state.settings = { performanceMode: 'On' }; state.playing = true;
    const initialPaints = canvas.paints;
    now = 10; nextFrame(); assert.equal(canvas.paints, initialPaints, 'Efficient playback skips duplicate refreshes within a timeline frame.');
    now = 43; nextFrame(); assert.equal(canvas.paints, initialPaints + 1);
    assert.equal(canvas.width, 320); assert.equal(canvas.height, 180, 'Efficient mode retains preview resolution.');
    state.playing = false; nextFrame();
    now = 60_000; state.playhead = 1; nextFrame();
    const painted = canvas.paints;
    state.playhead = 2; nextFrame(); state.playhead = 3; nextFrame();
    assert.equal(canvas.paints, painted, 'A seek must leave the last completed picture intact.');
    assert.deepEqual(videos[0].seeks, [1+.5/24], 'A pending decode is not repeatedly canceled.');
    assert.ok(!statuses.some(status => JSON.stringify(status).includes('Loading media')), 'Idle time before scrubbing is not a slow load.');
    now += 701; nextFrame(); assert.deepEqual(statuses.at(-1), { title: 'Loading media…' }, 'A genuinely slow decode is reported.');
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
