import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { animatedWindows, cachedLut, releaseLuts, retimeSchedule, getMediaCapabilities, prepareMedia, probeMedia, renderPasses, renderTimeline } from './media.ts';
import type { RenderRequest } from './media.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';
import { gradeValues } from '../src/services/grade.ts';

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ff = (args: string[]) => exec(ffmpeg, ['-v', 'error', '-y', '-threads', '2', '-filter_complex_threads', '1', ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });

test('real media preparation and timeline export preserve picture, sound, timing, and validation', { timeout: 120000 }, async () => {
  assert.equal((await getMediaCapabilities()).available, true, 'Install FFmpeg and FFprobe before running integration checks.');
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-media-'));
  try {
    const source = path.join(dir, 'source.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    let earlyThumbnail = false;
    const prepared = await prepareMedia({ inputPath: source, outputDir: path.join(dir, 'prepared'), baseUrl: '/api/media/test/files', onThumbnail: url => { earlyThumbnail = true; assert.equal(url, '/api/media/test/files/thumbnail.jpg'); }, onProgress: percent => { if (percent > 5) assert.ok(earlyThumbnail, 'The source still must be published before proxy encoding progresses.'); } });
    assert.equal(prepared.kind, 'video'); assert.equal(prepared.hasAudio, true); assert.equal(prepared.fps, 24);
    assert.ok(Math.abs(prepared.duration - 3) < .05); assert.equal(prepared.resolution, '320 × 180');
    assert.ok(prepared.waveform.length >= 600); assert.equal(prepared.waveformVersion, 2); assert.ok(Math.max(...prepared.waveform) > .03, 'Waveform must capture the actual audible tone.');
    assert.ok((await stat(path.join(dir, 'prepared', 'thumbnail.jpg'))).size > 100);
    assert.ok((await probeMedia(path.join(dir, 'prepared', 'proxy.mp4'))).hasAudio);
    for (const [quality, url] of Object.entries(prepared.proxyVariants!)) {
      const file = path.join(dir, 'prepared', path.basename(url));
      const variant = await probeMedia(file);
      assert.equal(variant.fps, prepared.fps);
      assert.ok(Math.abs(variant.duration - prepared.duration) < .05);
      assert.ok(variant.width! <= (quality === '1/2' ? 960 : 480));
      assert.equal(variant.colorRange, prepared.colorRange === 'pc' ? 'pc' : 'tv');
      assert.ok(variant.hasAudio, 'Embedded sound must survive lower-resolution preview.');
      const frames = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', file]);
      const keys = frames.stdout.trim().split(/\s+/).map(frame => frame.replace(',', ''));
      assert.ok(quality.startsWith('Stream') ? keys.includes('0') : keys.every(frame => frame === '1'));
    }
    assert.equal((await probeMedia(path.join(dir, 'prepared', path.basename(prepared.audioProxyUrl!)))).kind, 'audio');
    const keyframes = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', path.join(dir, 'prepared', 'proxy.mp4')]);
    assert.ok(keyframes.stdout.trim().split(/\s+/).every(frame => frame.replace(',', '') === '1'), 'Every proxy frame must be independently seekable.');
    const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'source.mp4', kind: 'video', binId: 'all', duration: 3, fps: 24, resolution: '320 × 180', size: '10 KB', status: 'ready', progress: 100, thumbnail: prepared.thumbnail, hasAudio: true };
    const project = { id: 'project', resolution: '320 × 180', fps: 24 } as Project;
    const track = (id: string, number: number, kind: 'video' | 'audio' = 'video'): Track => ({ id, timelineId: 'timeline', number, kind, name: id, muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 });
    const clip = (id: string, trackId: string, start: number, duration: number, sourceIn = 0): Clip => ({ id, projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: id, trackId, start, duration, sourceIn, color: 'red', disabled: false, properties: { ...defaultProperties }, effects: [] });
    const outputPath = path.join(dir, 'output.mp4');
    const request: RenderRequest = { project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 4 }, tracks: [track('base', 1), track('top', 2)], clips: [clip('base', 'base', .5, 2), clip('top', 'top', 1, .5, 1.5)], nodes: [], assets: [{ asset, path: source }], settings: { resolution: '320 × 180', fps: '24', codec: 'H.264', rangeIn: '0', rangeOut: '3', audio: 'AAC · 192 kb/s · 48 kHz' }, outputPath };
    const progress: number[] = [];
    await renderTimeline({ ...request, onProgress: value => progress.push(value) });
    assert.equal(progress.at(-1), 100);
    const output = await probeMedia(outputPath); assert.ok(Math.abs(output.duration - 3) < .05); assert.equal(output.hasAudio, true);
    const pixel = async (file: string, seconds: number) => [...(await ff(['-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])).stdout];
    assert.ok((await pixel(outputPath, .1)).every(channel => channel < 10), 'Gap before first clip should stay black.');
    const red = await pixel(outputPath, .7); assert.ok(red[0] > 220 && red[2] < 25, 'Source trim should begin on red.');
    const blue = await pixel(outputPath, 1.2); assert.ok(blue[2] > 220 && blue[0] < 25, 'Higher-numbered track must composite on top.');
    assert.ok((await pixel(outputPath, 2.8)).every(channel => channel < 10), 'Last source frame must not bleed into a gap.');
    const sound = (await ff(['-ss', '0.6', '-i', outputPath, '-t', '0.1', '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1'])).stdout;
    assert.ok(Array.from({ length: sound.length / 4 }, (_, i) => Math.abs(sound.readFloatLE(i * 4))).some(value => value > .02), 'Export must contain audible original sound.');
    await renderTimeline({ ...request, settings: { ...request.settings, rangeIn: '3', rangeOut: '4' } });
    assert.ok((await pixel(outputPath, .5)).every(value => value < 10), 'A selected gap should export black and silence.');

    const reverse = clip('reverse', 'base', 0, 2); reverse.properties.reverse = true;
    await renderTimeline({ ...request, clips: [reverse], settings: { ...request.settings, rangeIn: '1', rangeOut: '2' } });
    const reverseRed = await pixel(outputPath, .3); assert.ok(reverseRed[0] > 220, 'Selected range must use the matching reversed source offset.');
    const freeze = clip('freeze', 'base', 0, 2, .2); freeze.properties.freeze = true;
    await renderTimeline({ ...request, clips: [freeze], settings: { ...request.settings, rangeOut: '2' } });
    assert.ok((await pixel(outputPath, 1.5))[0] > 220, 'Freeze frame must hold beyond a single source frame.');
    const fast = clip('fast', 'base', 0, 1); fast.properties.speed = 200;
    await renderTimeline({ ...request, clips: [fast], settings: { ...request.settings, rangeOut: '1' } });
    assert.ok((await pixel(outputPath, .7))[2] > 220, 'Speed changes must advance original picture.');

    const imageSource = path.join(dir, 'still.bin');
    await ff(['-f', 'lavfi', '-i', 'color=c=green:s=320x180', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', imageSource]);
    const still = await prepareMedia({ inputPath: imageSource, outputDir: path.join(dir, 'still-prepared'), baseUrl: '/still' });
    assert.equal(still.kind, 'image'); assert.equal(still.hasAudio, false);
    await renderTimeline({ ...request, clips: [clip('still', 'base', 0, 2)], assets: [{ asset: { ...asset, kind: 'image', duration: still.duration, hasAudio: false }, path: imageSource }], settings: { ...request.settings, rangeOut: '2' } });
    assert.ok((await pixel(outputPath, 1.5))[1] > 100, 'An image must hold for its timeline duration even without a file extension.');
    const audioSource = path.join(dir, 'audio.wav');
    await ff(['-i', source, '-vn', '-c:a', 'pcm_s16le', audioSource]);
    const audioPrepared = await prepareMedia({ inputPath: audioSource, outputDir: path.join(dir, 'audio-prepared'), baseUrl: '/audio' });
    assert.equal(audioPrepared.kind, 'audio'); assert.ok(audioPrepared.waveform.some(value => value > .03));
    const audioClip = clip('audio', 'audio', 0, 1); audioClip.effects = ['EQ', 'Compressor', 'Limiter', 'Noise Reduction'].map(name => ({ id: name, name, amount: 50, enabled: true }));
    await renderTimeline({ ...request, clips: [audioClip], tracks: [track('audio', 1, 'audio')], assets: [{ asset: { ...asset, kind: 'audio' }, path: audioSource }], settings: { ...request.settings, rangeOut: '1' } });
    assert.ok((await pixel(outputPath, .5)).every(value => value < 10), 'Audio-only exports use a black video canvas.');
    const treated = clip('treated', 'base', 0, 1);
    treated.properties = { ...treated.properties, zoom: 110, rotation: 4, cropLeft: 3, opacity: 80, anchorX: 2, x: 3 };
    treated.effects = ['Film grain', 'Vignette', 'Gaussian blur', 'Sharpen', 'Noise Reduction'].map(name => ({ id: name, name, amount: 10, enabled: true }));
    treated.effects.forEach(effect => { effect.parameters = effect.name === 'Vignette' ? {centerX:35,centerY:65} : effect.name === 'Gaussian blur' ? {radius:12} : effect.name === 'Sharpen' ? {radius:3} : effect.name === 'Film grain' ? {seed:42} : {temporal:8}; });
    const grade = { id: 'grade', projectId: 'project', clipId: 'treated', name: 'Balance', kind: 'balance', enabled: true, parameters: { Exposure: .1, Contrast: 1.1, Pivot: .45, Saturation: 90, Temperature: 200, Tint: 2, lift: .01, gamma: .1, gain: 1.01, offset: .01 } };
    await renderTimeline({ ...request, clips: [treated], nodes: [grade], settings: { ...request.settings, rangeOut: '1' } });
    assert.ok((await probeMedia(outputPath)).duration >= 1);
    for (const codec of ['H.265 / HEVC', 'Apple ProRes 422 HQ', 'Apple ProRes 4444']) {
      const codecOutput = path.join(dir, codec.includes('ProRes') ? 'codec.mov' : 'codec.mp4');
      await renderTimeline({ ...request, clips: [clip('codec', 'base', 0, .5)], outputPath: codecOutput, settings: { ...request.settings, codec, rangeOut: '0.5', audio: codec.includes('ProRes') ? 'Linear PCM · 24-bit · 48 kHz' : request.settings.audio } });
      assert.ok((await probeMedia(codecOutput)).duration >= .49);
    }
    const panned = clip('panned', 'base', 0, 1); panned.properties.pan = 100; panned.properties.gain = -6;
    const quietTrack = { ...track('base', 1), gain: -6 };
    await renderTimeline({ ...request, clips: [panned], tracks: [quietTrack], settings: { ...request.settings, rangeOut: '1' } });
    const channels = (await ff(['-ss', '0.2', '-i', outputPath, '-t', '0.1', '-map', '0:a:0', '-ac', '2', '-f', 'f32le', 'pipe:1'])).stdout;
    let leftPeak = 0, rightPeak = 0;
    for (let i = 0; i < channels.length; i += 8) { leftPeak = Math.max(leftPeak, Math.abs(channels.readFloatLE(i))); rightPeak = Math.max(rightPeak, Math.abs(channels.readFloatLE(i + 4))); }
    assert.ok(leftPeak < .001 && rightPeak > .01 && rightPeak < .1, 'Clip and track gain plus hard-right pan must reach the exported samples.');
    await renderTimeline({ ...request, clips: [panned], settings: { ...request.settings, rangeOut: '1', masterMuted: 'true' } });
    const muted = (await ff(['-ss', '0.2', '-i', outputPath, '-t', '0.1', '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1'])).stdout;
    assert.ok(Array.from({ length: muted.length / 4 }, (_, i) => Math.abs(muted.readFloatLE(i * 4))).every(value => value < .0001), 'Master mute must produce silent exported audio.');

    const bad = clip('bad', 'base', 0, 1); bad.properties.zoom = NaN;
    await assert.rejects(renderTimeline({ ...request, clips: [bad] }), /zoom must be/);
    await assert.rejects(renderTimeline({ ...request, settings: { ...request.settings, subtitles: 'Burn into video' } }), /Subtitle export/);
    await assert.rejects(renderTimeline({ ...request, assets: [] }), /original media is missing/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareMedia({ inputPath: source, outputDir: path.join(dir, 'cancel'), baseUrl: '/cancel', signal: controller.signal }), /Canceled/);
    const playlist = path.join(dir, 'evil.ffconcat'); await writeFile(playlist, `ffconcat version 1.0\nfile '${source}'\n`);
    await assert.rejects(probeMedia(playlist), /whitelist/);
    const running = new AbortController();
    const canceled = renderTimeline({ ...request, signal: running.signal, clips: [clip('long', 'base', 0, 3)], settings: { ...request.settings, resolution: '3840 × 2160' } });
    setTimeout(() => running.abort(), 20);
    await assert.rejects(canceled, /Canceled/);
    await assert.rejects(stat(outputPath), /ENOENT/, 'Canceled renders must remove their incomplete output.');
    assert.equal(gradeValues([{ name: 'Balance', enabled: true, parameters: { Exposure: 1, Gain: 1, Saturation: 80 } }]).saturation, .8);
    assert.throws(() => gradeValues([{ name: 'Bad', enabled: true, parameters: { Protection: 85 } }]), /not supported/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('text titles export at their timeline range with visible colored glyphs', async () => {
  const { presetDocument, styleText } = await import('../src/services/text.ts');
  const { GlobalFonts } = await import('@napi-rs/canvas');
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-titles-render-'));
  try {
    const doc = styleText(presetDocument(), {fontFamily:GlobalFonts.has('Arial')?'Arial':GlobalFonts.families[0].family,fontSize:130,color:'#ff0000',letterSpacing:0});
    const outputPath = path.join(dir,'title.mp4');
    const project = {id:'p',resolution:'320 × 180',fps:24} as Project;
    const track = {id:'t',timelineId:'tl',kind:'video',number:1,hidden:false,muted:false,solo:false} as Track;
    const clip: Clip = {id:'title',projectId:'p',timelineId:'tl',trackId:'t',mediaId:'frameline-title',name:'Title',start:1,duration:1,sourceIn:0,color:'#ffffff',disabled:false,properties:{textDocument:JSON.stringify({...doc,x:.05,y:.2,width:.9,height:.6,runs:[{...doc.runs[0],text:'HI',style:{...doc.runs[0].style,fontSize:70}}]})},effects:[]};
    await renderTimeline({project,timeline:{id:'tl',projectId:'p',duration:3,name:'Test'},tracks:[track],clips:[clip],nodes:[],assets:[],settings:{resolution:'320 × 180',rangeIn:'0',rangeOut:'3',audio:'Disabled'},outputPath});
    const pixels = async (time: number) => (await ff(['-ss',String(time),'-i',outputPath,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
    assert.ok((await pixels(.5)).every(v=>v<10));
    const title = await pixels(1.5);assert.ok(title.some((v,i)=>i%3===0&&v>150&&title[i+1]<60&&title[i+2]<60),'Export contains red title glyphs.');
    assert.ok((await pixels(2.5)).every(v=>v<10),'Title disappears at its out point.');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('full-range untagged Sony proxies preserve range and RGB balance',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'frameline-log-range-'));
  try{
    const source=path.join(dir,'log.mp4');
    await ff(['-f','lavfi','-i','nullsrc=s=320x180:r=24:d=0.25','-vf',"format=yuv444p10le,geq=lum='400+100*X/W':cb='490+20*Y/H':cr='540-30*X/W'",'-c:v','libx264','-crf','0','-color_range','pc','-metadata','comment=S-Log3/S-Gamut3.Cine',source]);
    const metadata=await prepareMedia({inputPath:source,outputDir:path.join(dir,'prepared'),baseUrl:'/files'});
    assert.equal(metadata.inputProfile,'S-Log3');assert.equal(metadata.colorMatrix,'bt709');
    assert.equal((await probeMedia(path.join(dir,'prepared/proxy.mp4'))).colorRange,'pc');
    const pixels=async(file:string)=>(await ff(['-i',file,'-vf','scale=in_color_matrix=bt709,format=gbrpf32le,scale=32:18:flags=area','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])).stdout;
    const [a,b]=await Promise.all([pixels(source),pixels(path.join(dir,'prepared/proxy.mp4'))]);const bias=[0,0,0];for(let i=0;i<a.length;i++)bias[i%3]+=b[i]-a[i];
    for(const channel of bias)assert.ok(Math.abs(channel/(a.length/3))<.8,`Proxy channel bias: ${bias.map(x=>x/(a.length/3))}`);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('animated opacity exports changing frames through the shared renderer',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-keyframes-'));
 try {
  const fixture=path.join(dir,'white.png');
  await exec(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-f','lavfi','-i','color=white:s=64x64','-frames:v','1',fixture]);
  const project={id:'p',name:'Animation',description:'',shared:false,thumbnail:'',modifiedAt:0,duration:.25,resolution:'64 × 64',fps:24,status:'In progress',members:[]} as any;
  const track={id:'t',timelineId:'tl',name:'Video',kind:'video',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0} as any;
  const asset={id:'a',projectId:'p',name:'White',kind:'image',duration:1,status:'ready',progress:100,binId:'',thumbnail:'',fps:24,resolution:'64 × 64',size:''} as any;
  const clip={id:'c',projectId:'p',timelineId:'tl',trackId:'t',mediaId:'a',name:'Fade',start:0,duration:.25,sourceIn:0,color:'#fff',disabled:false,properties:{},effects:[],keyframes:{'properties.opacity':[{id:'a',time:0,value:0,interpolation:'linear'},{id:'b',time:5/24,value:100,interpolation:'linear'}]}} as any;
  const output=path.join(dir,'animated.mp4');
  await renderTimeline({project,timeline:{id:'tl',projectId:'p',name:'Main',duration:.25},tracks:[track],clips:[clip],assets:[{asset,path:fixture}],nodes:[],settings:{audio:'Disabled',codec:'H.264',resolution:'64 × 64',fps:'24'},outputPath:output});
  const pixels=(await exec(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-i',output,'-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:1e6})).stdout;
  assert.equal(pixels.length,6*64*64*3);assert.ok(pixels[0]<10);assert.ok(pixels.at(-1)!>230);assert.ok(pixels[3*64*64*3]>100);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('a lone keyframed clip bakes only its own frames and splices back into one composite',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-animation-window-'));
 try {
  const ffmpegPath=process.env.FFMPEG_PATH||'ffmpeg';
  const fixture=async(colour:string)=>{const file=path.join(dir,`${colour}.png`);await exec(ffmpegPath,['-v','error','-f','lavfi','-i',`color=${colour}:s=64x64`,'-frames:v','1',file]);return file;};
  const [red,white,blue]=await Promise.all([fixture('red'),fixture('white'),fixture('blue')]);
  const project={id:'p',name:'Windows',description:'',shared:false,thumbnail:'',modifiedAt:0,duration:2,resolution:'64 × 64',fps:24,status:'In progress',members:[]} as any;
  const track={id:'t',timelineId:'tl',name:'Video',kind:'video',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0} as any;
  const image=(id:string)=>({id,projectId:'p',name:id,kind:'image',duration:4,status:'ready',progress:100,binId:'',thumbnail:'',fps:24,resolution:'64 × 64',size:''} as any);
  const clip=(id:string,mediaId:string,start:number,duration:number,keyframes?:unknown)=>({id,projectId:'p',timelineId:'tl',trackId:'t',mediaId,name:id,start,duration,sourceIn:0,color:'#fff',disabled:false,properties:{},effects:[],...(keyframes?{keyframes}:{})} as any);
  const fade={'properties.opacity':[{id:'k0',time:0,value:0,interpolation:'linear'},{id:'k1',time:.25,value:100,interpolation:'linear'}]};
  const clips=[clip('a','red',0,.75),clip('b','white',.75,.25,fade),clip('c','blue',1,1)];

  // The whole point of the window: six frames are baked one at a time, not all forty-eight.
  assert.deepEqual(animatedWindows(clips,'tl',24,0,48),[{from:18,to:24}],'only the animated clip’s own frames are baked');
  assert.deepEqual(animatedWindows(clips,'tl',24,1,24),[],'an animated clip outside the export range costs nothing');
  assert.deepEqual(animatedWindows([...clips,clip('d','red',.9,.3,fade)],'tl',24,0,48),[{from:18,to:29}],'overlapping windows merge into one bake');
  assert.deepEqual(animatedWindows([{...clips[1],disabled:true} as any],'tl',24,0,48),[],'a disabled clip is not animation');

  const output=path.join(dir,'spliced.mp4');
  await renderTimeline({project,timeline:{id:'tl',projectId:'p',name:'Main',duration:2},tracks:[track],clips,
   assets:[{asset:image('red'),path:red},{asset:image('white'),path:white},{asset:image('blue'),path:blue}],
   nodes:[],settings:{audio:'Disabled',codec:'H.264',resolution:'64 × 64',fps:'24',rangeIn:'0',rangeOut:'2'},outputPath:output});
  const pixels=(await exec(ffmpegPath,['-v','error','-i',output,'-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:4e6})).stdout;
  const frame=(index:number)=>{const at=index*64*64*3;return [pixels[at],pixels[at+1],pixels[at+2]];};
  assert.equal(pixels.length,48*64*64*3,'the spliced timeline is still exactly the requested range');
  const [r0,g0,b0]=frame(0);assert.ok(r0>200&&g0<48&&b0<48,`static frames before the window stay untouched, got ${[r0,g0,b0]}`);
  const [r17]=frame(17);assert.ok(r17>200,'the frame at the window edge still belongs to the clip before it');
  assert.ok(frame(18).every(v=>v<24),'the animated window starts at zero opacity');
  assert.ok(frame(23)[0]>150,'the animated window ramps up inside the bake');
  const [r24,g24,b24]=frame(24);assert.ok(b24>200&&r24<48&&g24<48,`the clip after the window is composited normally, got ${[r24,g24,b24]}`);
  assert.ok(frame(47)[2]>200,'the tail of the timeline survives the splice');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('audio envelopes fade gain and preserve their position in partial exports',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-audio-fades-'));
 try {
  const fixture=path.join(dir,'tone.wav');await exec(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-ac','2',fixture]);
  const project={id:'p',name:'Audio',description:'',shared:false,thumbnail:'',modifiedAt:0,duration:2,resolution:'64 × 64',fps:24,status:'In progress',members:[]} as any;
  const track={id:'t',timelineId:'tl',name:'Audio',kind:'audio',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0} as any;
  const asset={id:'a',projectId:'p',name:'Tone',kind:'audio',hasAudio:true,duration:2,status:'ready',progress:100,binId:'',thumbnail:'',fps:0,resolution:'',size:''} as any;
  const clip={id:'c',projectId:'p',timelineId:'tl',trackId:'t',mediaId:'a',name:'Tone',start:0,duration:2,sourceIn:0,color:'#fff',disabled:false,properties:{audioFadeIn:1,audioFadeOut:1},effects:[]} as any;
  const request={project,timeline:{id:'tl',projectId:'p',name:'Main',duration:2},tracks:[track],clips:[clip],assets:[{asset,path:fixture}],nodes:[],settings:{audio:'Linear PCM · 24-bit · 48 kHz',codec:'Apple ProRes 4444',resolution:'64 × 64',fps:'24'},outputPath:path.join(dir,'faded.mov')};
  await renderTimeline(request);
  const samples=async(file:string)=>{const data=(await exec(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-i',file,'-map','0:a','-f','f32le','-ac','1','-'],{encoding:'buffer',maxBuffer:1e6})).stdout;return new Float32Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));};
  const full=await samples(request.outputPath),rms=(data:Float32Array,start:number,length:number)=>Math.sqrt(data.slice(start,start+length).reduce((s,v)=>s+v*v,0)/length);
  assert.ok(rms(full,0,2400)<rms(full,24000,2400)*.12);assert.ok(rms(full,93600,2400)<rms(full,48000,2400)*.12);
  const partial=path.join(dir,'partial.mov');await renderTimeline({...request,outputPath:partial,settings:{...request.settings,rangeIn:'.5',rangeOut:'1'}});
  assert.ok(Math.abs(rms(await samples(partial),0,2400)-rms(full,24000,2400))<.003);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('playable footage is published before color preparation and survives a later failure', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-early-ready-'));
  const controller = new AbortController();
  let playable = false;
  const stages: string[] = [];
  try {
    const source = path.join(dir, 'source.mp4'), outputDir = path.join(dir, 'prepared');
    await ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=1','-c:v','libx264','-pix_fmt','yuv420p',source]);
    await assert.rejects(prepareMedia({ inputPath: source, outputDir, baseUrl: '/media', signal: controller.signal,
      onPlayable: asset => { playable = true; assert.equal(asset.duration, 1); assert.equal(asset.proxyUrl, '/media/proxy.mp4'); assert.ok(!stages.includes('Creating high-precision color preview')); },
      onStage: stage => { stages.push(stage); if (stage === 'Creating high-precision color preview') { assert.ok(playable); controller.abort(); } }
    }), /Canceled/);
    assert.ok((await stat(path.join(outputDir, 'proxy.mp4'))).size > 0, 'background failure must preserve the playable preview');
    assert.ok(stages.includes('Creating smaller playback previews'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a speed-ramped clip exports continuous sound, not per-frame chops',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-ramp-audio-'));
 try {
  const ffmpegPath=process.env.FFMPEG_PATH||'ffmpeg';
  const tone=path.join(dir,'tone.wav');
  await exec(ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-ac','2',tone]);
  const ramp={'properties.speed':[{id:'k0',time:0,value:100,interpolation:'linear'},{id:'k1',time:2,value:50,interpolation:'linear'}]};
  const clip={id:'a',projectId:'p',timelineId:'tl',trackId:'t',mediaId:'tone',name:'Tone',start:0,duration:2,sourceIn:0,color:'#fff',disabled:false,properties:{},effects:[],keyframes:ramp} as any;
  assert.ok(retimeSchedule(clip)!.commands.length>10,'the ramp is scheduled as a curve, not one tempo');
  assert.equal(retimeSchedule({...clip,keyframes:undefined,properties:{speed:100,reverse:true}}),null,'reverse falls back');
  const project={id:'p',name:'Ramp',description:'',shared:false,thumbnail:'',modifiedAt:0,duration:2,resolution:'64 × 64',fps:24,status:'In progress',members:[]} as any;
  const track={id:'t',timelineId:'tl',name:'Audio',kind:'audio',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0} as any;
  const asset={id:'tone',projectId:'p',name:'tone',kind:'audio',duration:6,status:'ready',progress:100,binId:'',thumbnail:'',fps:0,resolution:'',size:'',hasAudio:true} as any;
  const out=path.join(dir,'out.mov');
  await renderTimeline({project,timeline:{id:'tl',projectId:'p',name:'Ramp',duration:2},clips:[clip],tracks:[track],nodes:[],assets:[{asset,path:tone}],settings:{codec:'Apple ProRes 422 HQ',audio:'Linear PCM · 24-bit · 48 kHz',resolution:'64 × 64'},outputPath:out} as any);
  // A steady tone must stay steady: per-frame atempo leaves dropouts in 10 ms windows.
  const {stdout}=await exec(ffmpegPath,['-v','error','-i',out,'-af','atrim=start=0.1:end=1.9,asetnsamples=n=480:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-']);
  const levels=[...stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map(m=>Number(m[1]==='-inf'?-200:m[1]));
  assert.ok(levels.length>100,'measured the tone');
  assert.ok(Math.min(...levels)>Math.max(...levels)-6,`tone level stays within 6 dB (min ${Math.min(...levels)}, max ${Math.max(...levels)})`);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('the LUT cache never deletes a table a running render still holds',async()=>{
  const held:string[]=[],table=await cachedLut(['held-table-check',0],async file=>{await writeFile(file,'LUT_3D_SIZE 2\n');},held);
  for(let i=1;i<=70;i++){const claim:string[]=[];await cachedLut(['held-table-check',i],async file=>{await writeFile(file,'x');},claim);releaseLuts(claim);}
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok((await stat(table.file)).size>0,'the held table outlives seventy newer ones');
  releaseLuts(held);
});

test('an export splits at its own cuts, never inside a transition, with few pictures per pass',()=>{
  const shots=Array.from({length:30},(_,i)=>({from:i*29,to:(i+1)*29})),held=(pass:{from:number;to:number})=>shots.filter(s=>s.from<pass.to&&s.to>pass.from).length;
  const passes=renderPasses(shots,[],870,6);
  assert.deepEqual(passes.map(p=>p.from),[0,174,348,522,696],'six shots to a pass, cut on the edit');
  assert.equal(passes.at(-1)!.to,870);assert.ok(passes.every(p=>held(p)<=6));
  assert.ok(renderPasses(shots,[{from:170,to:180}],870,6).every(p=>!(p.from>170&&p.from<180)),'no pass starts inside a transition window');
  assert.deepEqual(renderPasses([{from:0,to:1000}],[],1000,6,240).map(p=>p.from),[0,240,480,720,960],'one long shot still renders side by side');
  assert.deepEqual(renderPasses([{from:0,to:1000}],[{from:230,to:250}],1000,6,240).map(p=>p.from).slice(0,2),[0,250],'a split lands after the window it would cut');
  assert.deepEqual(renderPasses(Array.from({length:10},()=>({from:0,to:100})),[],100,6),[{from:0,to:100}],'stacked layers stay one pass');
});

test('a split export joins its parts frame for frame and mixes one continuous sound',{timeout:120000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-split-'));
 try {
  const colors=['red','lime','blue','yellow','magenta','cyan','white','gray'],expected=[[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255],[255,255,255],[128,128,128]];
  const images=await Promise.all(colors.map(async color=>{const file=path.join(dir,`${color}.png`);await ff(['-f','lavfi','-i',`color=${color}:s=64x64`,'-frames:v','1',file]);return file;}));
  const tone=path.join(dir,'tone.wav');await ff(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-ac','2',tone]);
  const video={id:'v',timelineId:'tl',name:'Video',kind:'video',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0} as any,sound={...video,id:'a',name:'Audio',kind:'audio'};
  const asset=(id:string,kind:string,duration:number)=>({id,projectId:'p',name:id,kind,duration,status:'ready',progress:100,binId:'',thumbnail:'',fps:24,resolution:'64 × 64',size:'',hasAudio:kind==='audio'} as any);
  const clip=(id:string,trackId:string,mediaId:string,start:number,duration:number)=>({id,projectId:'p',timelineId:'tl',trackId,mediaId,name:id,start,duration,sourceIn:0,color:'#fff',disabled:false,properties:{},effects:[]} as any);
  // Eight quarter-second shots: more pictures than one pass holds, under one tone that spans the seam.
  const stages:string[]=[],output=path.join(dir,'split.mov');
  await renderTimeline({project:{id:'p',name:'Split',resolution:'64 × 64',fps:24} as any,timeline:{id:'tl',projectId:'p',name:'Main',duration:2},tracks:[video,sound],nodes:[],
   clips:[...colors.map((color,i)=>clip(`c${i}`,'v',color,i*.25,.25)),clip('music','a','tone',0,2)],
   assets:[...colors.map((color,i)=>({asset:asset(color,'image',10),path:images[i]})),{asset:asset('tone','audio',3),path:tone}],
   settings:{resolution:'64 × 64',fps:'24',codec:'Apple ProRes 422 HQ',audio:'Linear PCM · 24-bit · 48 kHz'},outputPath:output,onStage:stage=>stages.push(stage)});
  assert.ok(stages.includes('Rendering video · 0/2 parts'),`rendered in two parts: ${stages.join(' | ')}`);
  const pixels=(await exec(ffmpeg,['-v','error','-i',output,'-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:8e6})).stdout;
  assert.equal(pixels.length,48*64*64*3,'the joined picture is exactly the range');
  for(let f=0;f<48;f++){const at=(f*64*64+32*64+32)*3,want=expected[Math.floor(f/6)];assert.ok(want.every((v,c)=>Math.abs(pixels[at+c]-v)<24),`frame ${f} shows shot ${Math.floor(f/6)}, got ${[...pixels.subarray(at,at+3)]}`);}
  const {stdout}=await exec(ffmpeg,['-v','error','-i',output,'-af','atrim=start=0.02:end=1.98,asetnsamples=n=480:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-']);
  const levels=[...stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map(m=>Number(m[1]==='-inf'?-200:m[1]));
  assert.ok(levels.length>150&&Math.min(...levels)>Math.max(...levels)-1,`tone stays level across the join (min ${Math.min(...levels)}, max ${Math.max(...levels)})`);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('keyframes on a clip nobody can hear do not force a render per frame',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-unseen-'));
 try {
  const still=path.join(dir,'still.png'),tone=path.join(dir,'tone.wav');
  await ff(['-f','lavfi','-i','color=blue:s=64x64','-frames:v','1',still]);await ff(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-ac','2',tone]);
  const video={id:'v',timelineId:'tl',name:'Video',kind:'video',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0} as any,muted={...video,id:'a',name:'Audio',kind:'audio',muted:true};
  const ramp={'properties.speed':[{id:'k0',time:0,value:100,interpolation:'linear'},{id:'k1',time:1,value:50,interpolation:'linear'}]};
  const stages:string[]=[];
  await renderTimeline({project:{id:'p',name:'Unseen',resolution:'64 × 64',fps:24} as any,timeline:{id:'tl',projectId:'p',name:'Main',duration:1},tracks:[video,muted],nodes:[],
   clips:[{id:'s',projectId:'p',timelineId:'tl',trackId:'v',mediaId:'still',name:'Still',start:0,duration:1,sourceIn:0,color:'#fff',disabled:false,properties:{},effects:[]},
    {id:'r',projectId:'p',timelineId:'tl',trackId:'a',mediaId:'tone',name:'Ramp',start:0,duration:1,sourceIn:0,color:'#fff',disabled:false,properties:{},effects:[],keyframes:ramp}] as any,
   assets:[{asset:{id:'still',projectId:'p',name:'still',kind:'image',duration:10,status:'ready',progress:100,binId:'',thumbnail:'',fps:24,resolution:'64 × 64',size:''} as any,path:still},{asset:{id:'tone',projectId:'p',name:'tone',kind:'audio',duration:2,hasAudio:true,status:'ready',progress:100,binId:'',thumbnail:'',fps:0,resolution:'',size:''} as any,path:tone}],
   settings:{resolution:'64 × 64',fps:'24',codec:'Apple ProRes 422 HQ',audio:'Linear PCM · 24-bit · 48 kHz'},outputPath:path.join(dir,'out.mov'),onStage:stage=>stages.push(stage)});
  assert.ok(!stages.some(stage=>stage.startsWith('Rendering animation')),`a muted ramp renders in one pass: ${stages.join(' | ')}`);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('a keyframed clip exports the same source frames as the plain clip, with its sound once',{timeout:180000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'frameline-frame-rule-'));
 try {
  // Every source frame has its own brightness, so the picture says which frame the export chose.
  const source=path.join(dir,'numbered.mp4');
  await ff(['-f','lavfi','-i','color=black:s=64x64:r=24:d=3,format=gray,geq=lum=16+N*4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-map','0:v','-map','1:a','-c:v','libx264','-qp','0','-pix_fmt','yuv420p','-c:a','aac',source]);
  const asset={id:'n',projectId:'p',name:'numbered',kind:'video',duration:3,fps:24,resolution:'64 × 64',hasAudio:true,status:'ready',progress:100,binId:'',thumbnail:'',size:''} as MediaAsset;
  const track:Track={id:'t',timelineId:'tl',name:'Video',kind:'video',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0};
  const read=async(file:string)=>({picture:[...(await ff(['-i',file,'-vf','scale=1:1,format=gray','-f','rawvideo','-pix_fmt','gray','pipe:1'])).stdout],sound:(await ff(['-i',file,'-map','0:a:0','-ac','1','-f','f32le','pipe:1'])).stdout});
  const loudness=(pcm:Buffer)=>Math.sqrt(Array.from({length:pcm.length/4},(_,i)=>pcm.readFloatLE(i*4)**2).reduce((a,b)=>a+b,0)/(pcm.length/4));
  for(const speed of [100,50]) {
   const clip:Clip={id:'c',projectId:'p',timelineId:'tl',trackId:'t',mediaId:'n',name:'Numbered',start:0,duration:20/30,sourceIn:.1,color:'#fff',disabled:false,properties:{...defaultProperties,speed},effects:[]};
   const request=(clips:Clip[],name:string):RenderRequest=>({project:{id:'p',resolution:'64 × 64',fps:30} as Project,timeline:{id:'tl',projectId:'p',name:'Main',duration:20/30},tracks:[track],clips,nodes:[],assets:[{asset,path:source}],settings:{resolution:'64 × 64',fps:'30',codec:'Apple ProRes 422 HQ',audio:'Linear PCM · 24-bit · 48 kHz',rangeIn:'0',rangeOut:String(20/30)},outputPath:path.join(dir,`${name}-${speed}.mov`)});
   const still=request([clip],'plain'),moving=request([{...clip,keyframes:{'properties.opacity':[{id:'a',time:0,value:100,interpolation:'linear'},{id:'b',time:.5,value:100,interpolation:'linear'}]}}],'keyed');
   await renderTimeline(still);await renderTimeline(moving);
   const plain=await read(still.outputPath),keyed=await read(moving.outputPath);
   assert.equal(keyed.picture.length,20);
   assert.deepEqual(keyed.picture.map(v=>Math.round(v/4)),plain.picture.map(v=>Math.round(v/4)),`${speed}%: every keyed frame shows the plain export's source frame`);
   const ratio=loudness(keyed.sound)/loudness(plain.sound);
   assert.ok(ratio>.8&&ratio<1.25,`${speed}%: the sound plays once, got ${ratio.toFixed(2)}× the plain export`);
  }
 } finally {await rm(dir,{recursive:true,force:true});}
});
