import { createTimelinePreview } from './timelinePreview.ts';
import { createSmartMaskPreview, activeSmartMasks, fittedSmartMask, lumaAlphaFilter, SmartMaskPending, unanalyzedSmartMask, type SmartMaskPixels } from './smartMaskPreview.ts';
import { createMotionPreview } from './motionPreview.ts';
import { transformMotion, drawMotionPose, motionArtwork } from './motionBlur.ts';
import { animatedSourceOffset, evaluateClip, evaluateNodes, fadeLevel, trimAnimation } from './animation.ts';
import { bloomPass, leakRange, isLeakMedia, leakIdOf, timelineTransitions, transitionDefinitions, transitionProgress, type TransitionRecord } from './transitions.ts';
import { drawText, getText, isTitle } from './text.ts';
import { drawShape, getShape, isShape } from './shapes.ts';
import { effectValue, effectEnabled, detailPixels } from './effects.ts';
import type { Clip, GradeNode, MediaAsset, Project, Settings, Timeline, Track } from '../state/models.ts';
import { gradeValues } from './grade.ts';
import { createVideoFrames } from './videoFrames.ts';
import { createColorPreview, ColorPending } from './colorPreview.ts';
import { createFlowPreview } from './flowPreview.ts';
import { createStabilizePreview } from './stabilizePreview.ts';
import { stabilizeEffect, stabilizeLayerTransform, stabilizeRange, stabilizeSettings, stabilizeZoom, type StabilizeSolve } from './stabilize.ts';
import './clipStatus.ts';
import * as footageCache from './footageCache.ts';
import { flowChunkSeconds, type FlowPreview } from './opticalFlow.ts';

export function sourceTime(clip: Clip, playhead: number, fps = 24, duration = Infinity) {
  const elapsed = Math.max(0, Math.min(clip.duration, playhead - clip.start));
  const offset = animatedSourceOffset(clip,elapsed,fps);
  return Math.max(0, Math.min(Math.max(0, duration - 1 / fps), clip.sourceIn + offset));
}

export function projectSize(resolution: string) {
  const [width, height] = resolution.match(/\d+/g)?.map(Number) ?? [];
  return width > 0 && height > 0 ? [width, height] as const : [1920, 1080] as const;
}

type PlaybackState = {
  projectId: string; timelineId: string; playhead: number; playing: boolean; renderPreviewAllowed?: boolean;
  projects: Project[]; timelines?: Timeline[]; clips: Clip[]; tracks: Track[]; media: MediaAsset[]; nodes: GradeNode[]; settings: Settings;
  /** Shared overlay pack served by /api/transitions; absent until the library has loaded. */
  leaks?: { id: string; name: string; url: string; duration: number; fps: number; hasAudio: boolean }[];
};
export type PreviewOptions = { original: boolean; quality: string; volume: number; compare: boolean; fontsRevision?: number };
export type PlaybackStatus = { title: string; detail?: string; error?: boolean; loading?: boolean; fallback?: boolean } | null;

export function efficientPlayback(mode: Settings['performanceMode'] | undefined, device: { hardwareConcurrency?: number; deviceMemory?: number } = typeof navigator === 'undefined' ? {} : navigator) {
  if (mode === 'On') return true;
  if (mode === 'Off') return false;
  return (Number(device.hardwareConcurrency) > 0 && Number(device.hardwareConcurrency) <= 4) || (Number(device.deviceMemory) > 0 && Number(device.deviceMemory) <= 4);
}

export function playbackUrl(asset: MediaAsset, options: Pick<PreviewOptions, 'original' | 'quality'>, visual: boolean) {
  if (options.original) return asset.sourceUrl || asset.proxyUrl;
  if (!visual && asset.audioProxyUrl) return asset.audioProxyUrl;
  if(visual&&options.quality==='Full'&&asset.colorProxyUrl)return asset.colorProxyUrl;
  if(options.quality==='Color')return asset.colorProxyUrl||asset.sourceUrl||asset.proxyUrl;
  // An import that predates the upgrade pass has no streaming variant yet. Half resolution is the
  // closest substitute; falling straight through to the all-intra full proxy would hand a remote
  // viewer an ~80 Mbit/s stream, which is the one thing this quality exists to avoid.
  for (const quality of options.quality === 'Stream' ? ['Stream', '1/2', '1/4'] : [options.quality]) {
    const url = asset.proxyVariants?.[quality];
    if (url) return url;
  }
  return asset.proxyUrl || asset.sourceUrl;
}

/**
 * Stretch a clip over a transition window. Nothing on the timeline moves: the extra frames are
 * read out of the trim handles the edit already left unused, which is why `sourceIn` shifts by
 * exactly the lead time and the animation channels are re-anchored to the new start.
 */
export function extendClip(clip: Clip, start: number, duration: number): Clip {
  if (Math.abs(start - clip.start) < 1e-9 && Math.abs(duration - clip.duration) < 1e-9) return clip;
  const speed = Math.max(.01, Number(clip.properties.speed ?? 100) / 100);
  const lead = clip.start - start;
  // Reversed and frozen clips read their handle from the other end, so the in point stays put.
  const sourceIn = clip.properties.freeze || clip.properties.reverse ? clip.sourceIn : Math.max(0, clip.sourceIn - lead * speed);
  return { ...clip, start, duration, sourceIn, ...trimAnimation(clip, start, duration) };
}

/**
 * The clip the decoders should follow: the extended geometry, but the stored keyframes.
 *
 * Both halves matter. `sourceTime` clamps elapsed time to the clip's own span, so following the
 * stored clip pinned the target for the whole transition window — the element played on, drifted
 * past the sync threshold and was yanked back, over and over, which is the back-and-forth jitter
 * both shots showed through every transition. Keyframes have to come from the stored clip because
 * `evaluateClip` has already flattened a speed ramp to its value at the playhead.
 */
export function syncClip(stored: Clip | undefined, extended: Clip): Clip {
  return stored ? extendClip(stored, extended.start, extended.duration) : extended;
}

/** An expanded leak plays from the shared pack, so its asset is synthesized rather than stored. */
function leakAsset(clip: Clip, leaks: PlaybackState['leaks']): MediaAsset | undefined {
  const leak = leaks?.find(item => item.id === leakIdOf(clip.mediaId));
  if (!leak) return undefined;
  return { id: clip.mediaId, projectId: clip.projectId, name: leak.name, kind: 'audio', binId: '', thumbnail: '',
    duration: leak.duration, resolution: '', fps: leak.fps, size: '', status: 'ready', progress: 100,
    hasAudio: leak.hasAudio, sourceUrl: leak.url, proxyUrl: leak.url, audioProxyUrl: leak.url };
}

/** Timeline bounds a clip occupies once the transitions touching it have borrowed their handles. */
export function clipSpan(clip: Clip, records: TransitionRecord[]) {
  let start = clip.start, end = clip.start + clip.duration;
  for (const record of records) {
    if (record.outgoingId === clip.id) end = Math.max(end, record.end);
    if (record.incomingId === clip.id) start = Math.min(start, record.start);
  }
  return { start, end };
}

export function playbackLayers(state: Pick<PlaybackState, 'clips' | 'tracks' | 'media' | 'projectId' | 'timelineId' | 'playhead'> & { leaks?: PlaybackState['leaks'] }, fps = 24, records: TransitionRecord[] = []) {
  const tracks = state.tracks.filter(t => t.timelineId === state.timelineId);
  const solo = tracks.some(t => t.solo && !t.muted);
  const active = state.clips.filter(c => c.projectId === state.projectId && c.timelineId === state.timelineId).flatMap(clip => {
    const span = clipSpan(clip, records);
    // Imported fractional-rate cuts can differ from the frame clock by a few floating-point bits.
    if (!(span.start <= state.playhead + 1e-7 && span.end > state.playhead + 1e-7)) return [];
    return [evaluateClip(extendClip(clip, span.start, span.end - span.start), state.playhead, fps)];
  }).filter(clip=>!clip.disabled);
  return active.flatMap(clip => {
    const track = tracks.find(t => t.id === clip.trackId), asset = isLeakMedia(clip.mediaId) ? leakAsset(clip, state.leaks) : isTitle(clip) || isShape(clip) || clip.mediaId==='frameline-composition' ? { id: clip.mediaId, hasAudio:clip.mediaId==='frameline-composition', projectId: clip.projectId, name: clip.name, kind: 'image', binId: '', thumbnail: '', duration: clip.duration, resolution: '', fps: 0, size: '', status: 'ready', progress: 100 } as MediaAsset : state.media.find(m => m.id === clip.mediaId);
    if (!track || !asset) return [];
    const separateAudio = active.some(other => other.id !== clip.id && tracks.find(t => t.id === other.trackId)?.kind === 'audio' && other.mediaId === clip.mediaId && other.start === clip.start && other.sourceIn === clip.sourceIn && other.duration === clip.duration);
    return [{ clip, track, asset, visual: track.kind === 'video' && !track.hidden && asset.kind !== 'audio', audible: (asset.kind === 'audio' || !!asset.hasAudio) && !clip.properties.freeze && !track.muted && (!solo || track.solo) && !(track.kind === 'video' && (clip.properties.audioDetached || separateAudio)) }];
  }).sort((a, b) => Number(Boolean(a.track.captionSets))-Number(Boolean(b.track.captionSets)) || a.track.number - b.track.number || a.clip.start - b.clip.start);
}

export function gradePixels(pixels: Uint8ClampedArray, grade: ReturnType<typeof gradeValues>) {
  const exposure = 2 ** grade.exposure, gamma = 1 / 2 ** grade.gamma;
  const warm = Math.max(-.5, Math.min(.5, grade.temperature / 10000)), tint = Math.max(-.5, Math.min(.5, grade.tint / 200));
  const transform = (value: number) => {
    const v = Math.max(0, value / 255 * exposure);
    return (Math.max(0, (v - grade.pivot) * grade.contrast + grade.pivot + grade.offset) ** gamma) * grade.gain + grade.lift * (1 - Math.min(1, v));
  };
  const lut = Array.from({ length: 256 }, (_, value) => transform(value));
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const r = lut[pixels[i]], g = lut[pixels[i + 1]], b = lut[pixels[i + 2]];
    const luma = .2126 * r + .7152 * g + .0722 * b;
    pixels[i] = 255 * ((luma + (r - luma) * grade.saturation) * (1 + warm));
    pixels[i + 1] = 255 * ((luma + (g - luma) * grade.saturation) * (1 - tint));
    pixels[i + 2] = 255 * ((luma + (b - luma) * grade.saturation) * (1 - warm));
  }
}

type AudioRoute = {
  source?: AudioNode; gain?: GainNode; pan?: StereoPannerNode; analyser?: AnalyserNode; samples?: Float32Array<ArrayBuffer>;
  filters: AudioNode[]; effectKey?: string; destination?: AudioNode;
};
type Decoder = AudioRoute & {
  url: string; element: HTMLMediaElement | HTMLImageElement; image: boolean; pending: boolean; blocked: boolean;
  frames?: ReturnType<typeof createVideoFrames>; framesFailed?: boolean; lastUsed: number; waitingSince?: number; error?: string; audioOnly: boolean; videoCallback?: number;
};

/** The timeline consumes prepared frames; native media remains the audio/compatibility path. */
export function attachPlayback(canvas: HTMLCanvasElement, getState: () => PlaybackState, getOptions: () => PreviewOptions, onStatus: (status: PlaybackStatus) => void) {
  const output = canvas.getContext('2d', { alpha: false })!;
  const composite = document.createElement('canvas');
  const context = composite.getContext('2d', { alpha: false })!;
  let motion:ReturnType<typeof createMotionPreview>|undefined;
  const timelinePreview=createTimelinePreview(()=>{dirty=true;});
  let expensiveFrames=0, expensiveUntil=-Infinity;
  const layer = document.createElement('canvas'), reference = document.createElement('canvas');
  const layerContext = layer.getContext('2d')!, referenceContext = reference.getContext('2d')!;
  // Each side of a cut is rendered whole before the transition composites them, so a transition
  // never has to know how its two shots were produced.
  // Transitions composite on their own alpha-capable canvases. The main composite is `alpha:false`,
  // so a wipe's destination-in mask would resolve to opaque black there instead of transparency —
  // and a transition into nothing has to be able to leave the frame actually empty.
  const blend = document.createElement('canvas'), blendContext = blend.getContext('2d')!;
  type Sides = { out: HTMLCanvasElement; in: HTMLCanvasElement; outContext: CanvasRenderingContext2D; inContext: CanvasRenderingContext2D; hasOut: boolean; hasIn: boolean; lastUsed: number };
  const sideCanvases = new Map<string, Sides>();
  const sidesFor = (key: string): Sides => {
    let entry = sideCanvases.get(key);
    if (!entry) {
      const out = document.createElement('canvas'), incoming = document.createElement('canvas');
      entry = { out, in: incoming, outContext: out.getContext('2d')!, inContext: incoming.getContext('2d')!, hasOut: false, hasIn: false, lastUsed: 0 };
      sideCanvases.set(key, entry);
    }
    if (entry.out.width !== blend.width || entry.out.height !== blend.height) {
      entry.out.width = entry.in.width = blend.width; entry.out.height = entry.in.height = blend.height;
      entry.hasOut = entry.hasIn = false;
    }
    entry.lastUsed = performance.now();
    return entry;
  };
  const resetSide = (context: CanvasRenderingContext2D) => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.filter = 'none';
    context.clearRect(0, 0, blend.width, blend.height);
  };
  const leaks = new Map<string, { element: HTMLVideoElement; source?: MediaElementAudioSourceNode; gain?: GainNode; lastUsed: number }>();
  const decoders = new Map<string, Decoder>();
  const streamFallbacks = new Map<string, string>();
  const automaticStreams = new Map<string,string>();
  const selectedUrl = (asset: MediaAsset, options: PreviewOptions, visual: boolean) => {
    const url = playbackUrl(asset, options, visual);
    return url ? streamFallbacks.get(url) ?? (visual&&!options.original&&options.quality==='Stream'?automaticStreams.get(asset.id):undefined) ?? url : url;
  };
  const groups = new Map<string, { canvas: HTMLCanvasElement; reference: HTMLCanvasElement; audio: AudioRoute }>();
  let color: ReturnType<typeof createColorPreview> | undefined;
  let audio: AudioContext | undefined, master: GainNode | undefined, masterAnalyser: AnalyserNode | undefined;
  let frame = 0, disposed = false, dirty = true, previous: unknown[] = [], statusKey = '', meterTime = 0;
  const flowPreview = createFlowPreview(() => { dirty = true; });
  const maskPreview=createSmartMaskPreview(()=>{dirty=true;}),fittedMasks=new Map<string,SmartMaskPixels>(),maskCuts=new Map<string,HTMLCanvasElement>();
  const flowStatuses = new Map<string,string>();
  const stabilizePreview = createStabilizePreview(() => { dirty = true; });
  const stabilizeStatuses = new Map<string,string>();
  // Warping the layer in place needs the picture it is about to overwrite; one scratch canvas serves every clip.
  const warpScratch = document.createElement('canvas');
  let stalled = false;
  let renderSlot = -1;
  let frameRevision=0;
  const fontsChanged = () => { dirty = true; };
  window.addEventListener('frameline:request-scope',fontsChanged);
  document.fonts.addEventListener('loadingdone', fontsChanged);
  const status = (value: PlaybackStatus) => { const key = JSON.stringify(value); if (key !== statusKey) { statusKey = key; onStatus(value); } };
  const cleanup = (decoder: Decoder) => {
    decoder.frames?.dispose();
    decoder.element.onload = null; decoder.element.onerror = null;
    if (!decoder.image) { const media = decoder.element as HTMLMediaElement; if (decoder.videoCallback !== undefined) (media as HTMLVideoElement).cancelVideoFrameCallback(decoder.videoCallback); media.pause(); media.removeAttribute('src'); media.load(); }
    decoder.source?.disconnect(); decoder.filters.forEach(node => node.disconnect()); decoder.gain?.disconnect(); decoder.pan?.disconnect(); decoder.analyser?.disconnect();
  };
  const decoderFor = (clip: Clip, asset: MediaAsset, visual: boolean, options: PreviewOptions) => {
    const requestedUrl = playbackUrl(asset, options, visual);
    // Pick at decoder creation, not on each throughput sample: no quality oscillation mid-shot.
    if(visual&&!options.original&&options.quality==='Stream'&&!decoders.has(clip.id)&&asset.proxyVariants?.StreamLow&&requestedUrl&&![...decoders.values()].some(decoder=>decoder.url===requestedUrl&&!decoder.audioOnly)&&footageCache.preferLowStream(requestedUrl))automaticStreams.set(asset.id,asset.proxyVariants.StreamLow);
    const url = selectedUrl(asset, options, visual), audioOnly = !visual || asset.kind === 'audio';
    const fallback = !url && visual && asset.thumbnail;
    if (!url && !fallback) return;
      let decoder = decoders.get(clip.id);
      if (decoder && (decoder.url !== (url || fallback) || decoder.audioOnly !== audioOnly)) { cleanup(decoder); decoders.delete(clip.id); decoder = undefined; }
      if (!decoder) {
        const image = asset.kind === 'image' || !!fallback;
        const element = image ? new Image() : document.createElement(audioOnly ? 'audio' : 'video');
        decoder = { url: String(url || fallback), element, image, audioOnly, pending: false, blocked: false, filters: [], lastUsed: performance.now() };
        const current = decoder;
        element.crossOrigin = 'anonymous'; element.onerror = () => {
          const stream = getState().media.find(item => item.id === asset.id)?.proxyVariants?.Stream;
          if (!image && stream && stream !== current.url && requestedUrl) streamFallbacks.set(requestedUrl, stream);
          else current.error = `${asset.name}: ${!image && (element as HTMLMediaElement).error?.code === 2 ? 'download failed' : 'source could not be decoded'}. Retry playback.`;
          dirty = true;
        };
        if (image) element.onload = () => { dirty = true; };
        else {
          const media = element as HTMLMediaElement; media.preload = visual && !options.original && typeof VideoDecoder !== 'undefined' && typeof Worker !== 'undefined' ? 'none' : 'auto'; media.addEventListener('loadedmetadata', () => { dirty = true; }); media.addEventListener('loadeddata', () => { dirty = true; }); media.addEventListener('seeked', () => { dirty = true; });
          if (media instanceof HTMLVideoElement) {
            media.playsInline = true;
            const decodedFrame = () => { if (!disposed && media.src) { dirty = true; current.videoCallback = media.requestVideoFrameCallback?.(decodedFrame); } };
            current.videoCallback = media.requestVideoFrameCallback?.(decodedFrame);
          }
        }
        element.src = current.url; decoders.set(clip.id, current);
      }
    decoder.lastUsed = performance.now();
    // Undo the idle downgrade below: a decoder asked for by name is on screen or about to be.
    if (!decoder.image && decoder.audioOnly && (decoder.element as HTMLMediaElement).preload !== 'auto') (decoder.element as HTMLMediaElement).preload = 'auto';
    return decoder;
  };
  const connect = (decoder: AudioRoute, clip: Clip, source: () => AudioNode, destination = master as AudioNode | undefined) => {
    if (!audio || !destination) return;
    if (!decoder.source) {
      decoder.source = source();
      decoder.gain = audio.createGain(); decoder.pan = audio.createStereoPanner(); decoder.analyser = audio.createAnalyser();
      decoder.analyser.fftSize = 256; decoder.samples = new Float32Array(256);
      decoder.analyser.connect(decoder.gain).connect(decoder.pan);
    }
    if(decoder.destination!==destination) {decoder.pan!.disconnect();decoder.pan!.connect(destination);decoder.destination=destination;}
    const effectKey = JSON.stringify([clip.effects,Object.fromEntries(Object.entries(clip.properties).filter(([key])=>clip.effects.some(e=>key.startsWith(e.name+'_'))))]);
    if (decoder.effectKey === effectKey) return;
    decoder.effectKey = effectKey; decoder.source.disconnect(); decoder.filters.forEach(node => node.disconnect()); decoder.filters = [];
    let end: AudioNode = decoder.source;
    const add = (node: AudioNode) => { end.connect(node); end = node; decoder.filters.push(node); };
    for (const effect of clip.effects.filter(e => effectEnabled(clip,e))) {
      const number = (key: string, fallback: number) => effectValue(clip,effect,key.slice(effect.name.length+1));
      if (effect.name === 'EQ') {
        const low = audio.createBiquadFilter(); low.type = 'highpass'; low.frequency.value = number('EQ_Low cut', 80); add(low);
        const presence = audio.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 3000; presence.Q.value = 1; presence.gain.value = number('EQ_Presence', 2); add(presence);
        const air = audio.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 10000; air.gain.value = number('EQ_Air', 1); add(air);
      } else if (effect.name === 'Compressor' || effect.name === 'Limiter') {
        const limiter = effect.name === 'Limiter';
        if (limiter) { const makeup = audio.createGain(); makeup.gain.value = 10 ** (-number('Limiter_Threshold', -6) / 20); add(makeup); }
        const compressor = audio.createDynamicsCompressor();
        compressor.threshold.value = number(`${effect.name}_${limiter ? 'Ceiling' : 'Threshold'}`, limiter ? -1 : -18);
        compressor.ratio.value = limiter ? 20 : number('Compressor_Ratio', 3); compressor.knee.value = limiter ? 0 : 6;
        compressor.attack.value = limiter ? .003 : number('Compressor_Attack', 15) / 1000; compressor.release.value = number(`${effect.name}_Release`, limiter ? 80 : 120) / 1000; add(compressor);
      }
    }
    end.connect(decoder.analyser!);
  };
  const play = (decoder: Decoder) => {
    const media = decoder.element as HTMLMediaElement;
    if (decoder.pending || decoder.blocked || !media.paused || media.readyState < 2) return;
    decoder.pending = true;
    void media.play().catch(error => {
      if (disposed || error.name === 'AbortError') return;
      decoder.blocked = true;
      decoder.error = error.name === 'NotAllowedError' ? 'Click Play to enable audio playback.' : 'This source could not play. Try the proxy preview.';
      dirty = true;
    }).finally(() => { decoder.pending = false; });
  };
  const buffered = (decoder: Decoder, clip: Clip, fps: number) => {
    const media=decoder.element;
    const cacheEnabled=getState().settings.footageCache!==false;
    if(decoder.frames&&decoder.frames.cacheEnabled!==cacheEnabled){decoder.frames.dispose();decoder.frames=undefined;}
    if(decoder.frames?.failed){decoder.frames.dispose();decoder.frames=undefined;decoder.framesFailed=true;}
    if (decoder.framesFailed || !(media instanceof HTMLVideoElement) || typeof VideoDecoder==='undefined' || typeof Worker==='undefined' || !/\.mp4(?:\?|$)/i.test(decoder.url) || clip.properties.reverse || clip.properties.freeze || Number(clip.properties.speed??100)>200) return undefined;
    media.pause(); media.preload='none';
    return decoder.frames??=createVideoFrames(decoder.url,fps,()=>{dirty=true;},cacheEnabled);
  };
  const draw = (target: CanvasRenderingContext2D, clip: Clip, width: number, height: number, projectWidth: number, projectHeight: number, time = getState().playhead) => {
    const p=clip.properties,project=getState().projects.find(p=>p.id===clip.projectId);
    const poses=transformMotion(clip,time,project?.fps??24,projectWidth,projectHeight);
    target.save();target.globalAlpha=Math.max(0,Math.min(1,Number(p.opacity??100)/100))*fadeLevel(clip,time);
    target.globalCompositeOperation=({Normal:'source-over',Multiply:'multiply',Screen:'screen',Overlay:'overlay','Soft light':'soft-light',Add:'lighter'} as Record<string,GlobalCompositeOperation>)[String(p.blendMode)]??'source-over';
    if(poses.length===1)drawMotionPose(target,layer,poses[0],clip,width,height,projectWidth,projectHeight);
    else {
      motion??=createMotionPreview();
      const result=motion.draw(layer,poses,clip,width,height,projectWidth,projectHeight);
      canvas.dataset.motionBlurBackend=result.dataset.motionBlurBackend;target.drawImage(result,0,0);
    }
    target.restore();
  };
  const tick = () => {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    let state = getState();
    const options = getOptions(), project = state.projects.find(p => p.id === state.projectId);
    footageCache.update(state, options, (asset, visual) => selectedUrl(asset, options, visual));
    const efficient = efficientPlayback(state.settings.performanceMode);
    // 'Match timeline' leaves the cap at the sequence rate; an explicit rate overrides it.
    const previewFps = parseFloat(String(state.settings.playbackFrameRate)) || project?.fps || 24;
    const slot = Math.floor((state.playing&&!stalled?state.playhead:performance.now()/1000) * previewFps + 1e-6);
    // Compositing faster than the timeline's frame rate produces frames nothing will ever show: a
    // 24 fps sequence on a 120 Hz display was doing five times the grade and effect work per frame.
    // A 60 fps source sets `dirty` on every decoded frame, so the cap cannot defer to it here.
    if (state.playing && slot === renderSlot) return;
    // A stalled tick composites the whole frame and throws it away, so retrying one per timeline
    // frame is as often as it can possibly pay off. `dirty` is the escape hatch: a decoder that has
    // just finished seeking paints immediately rather than waiting out the slot.
    if (stalled && !dirty && slot === renderSlot) return;
    if(state.playing)state={...state,playhead:Math.floor(state.playhead*previewFps+1e-6)/previewFps};
    const renderStarted=performance.now();
    const dependencies = [state.timelineId, state.timelines, state.playhead, state.playing, state.clips, state.tracks, state.media, state.leaks, state.nodes, state.settings, project, options.original, options.quality, options.volume, options.compare, options.fontsRevision];
    if (!dirty && !stalled && dependencies.every((value, i) => value === previous[i])) return;
    previous = dependencies; dirty = false; renderSlot = slot;

    const [projectWidth, projectHeight] = projectSize(project?.resolution ?? '1920 × 1080');
    flowPreview.retain(new Set(state.clips.filter(c=>c.properties.opticalFlow&&!c.disabled).map(c=>c.id)));
    stabilizePreview.retain(new Set(state.clips.filter(c=>stabilizeEffect(c)&&!c.disabled).map(c=>c.id)));
    const divisor = options.quality === '1/4' ? 4 : options.quality === '1/2' || options.quality === 'Stream' ? 2 : 1;
    // Browser proxy preview is capped at 1920px; original-media exports retain the chosen resolution.
    const ratio = Math.min(1 / divisor, 1920 / projectWidth);
    const width = Math.max(2, Math.round(projectWidth * ratio)), height = Math.max(2, Math.round(projectHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = composite.width = layer.width = reference.width = blend.width = width; canvas.height = composite.height = layer.height = reference.height = blend.height = height; }
    context.fillStyle = '#000'; context.fillRect(0, 0, width, height); referenceContext.clearRect(0, 0, width, height);
    const seeks: [HTMLMediaElement, number][] = [];
    const layers = playbackLayers(state,project?.fps||24), activeIds = new Set<string>(), warmIds = new Set<string>(), activeGroups = new Set<string>(), trackLevels: Record<string, number> = {};
    let sourceClip = '', sourceTimestamp = '', engine = ''; let decodedAhead = Infinity;
    let missing = false, loading = false, picture = false, error = '', warning = '';
    if (master && audio) master.gain.setTargetAtTime((state.settings.masterMuted || state.settings.monitorAudio === false ? 0 : 10 ** (Number(state.settings.masterGain ?? 0) / 20)) * options.volume / 100, audio.currentTime, .015);
    const updateAudio = (route:AudioRoute,clip:Clip,track:Track,time:number,audible:boolean) => {
      if(!audio||!route.gain||!route.pan||!route.analyser||!route.samples)return;
      route.analyser.getFloatTimeDomainData(route.samples);
      const rms=Math.sqrt(route.samples.reduce((sum,value)=>sum+value*value,0)/route.samples.length);
      let gain=audible?10**((track.gain+Number(clip.properties.gain??0))/20)*fadeLevel(clip,time,true):0;
      const noises=clip.effects.filter(e=>e.name==='Noise Reduction'&&effectEnabled(clip,e));
      for(const noise of noises){
        // ponytail: realtime noise gate; FFmpeg uses spectral denoising for final exports.
        if(rms<10**((-70+effectValue(clip,noise,'Sensitivity')*.5)/20))gain*=1-effectValue(clip,noise,'Reduction')/100;
      }
      route.gain.gain.setTargetAtTime(gain,audio.currentTime,noises.length?.005+Math.max(...noises.map(n=>effectValue(clip,n,'Smoothing')))/1000:.015);
      route.pan.pan.setTargetAtTime(Math.max(-1,Math.min(1,(track.pan+Number(clip.properties.pan??0))/100)),audio.currentTime,.015);
      trackLevels[track.id]=Math.max(trackLevels[track.id]||0,rms*gain);
    };
    /**
     * Decode the overlay clip for a light-leak transition. Its sound rides the master bus, so a
     * muted master silences it, and expanding the sound to a track mutes this copy instead.
     */
    const leakFrame = (record:TransitionRecord,raw:number,_time:number,wantAudio:boolean):CanvasImageSource|null => {
      const id=String(record.params.leak??'');
      const leak=state.leaks?.find(item=>item.id===id);
      if(!id||!leak)return null;
      let entry=leaks.get(id);
      if(!entry) {
        const element=document.createElement('video');
        element.preload='auto';element.playsInline=true;element.muted=true;element.src=leak.url;
        element.addEventListener('loadeddata',()=>{dirty=true;});
        element.addEventListener('seeked',()=>{dirty=true;});
        entry={element,lastUsed:0};leaks.set(id,entry);
      }
      entry.lastUsed=performance.now();
      const element=entry.element,range=leakRange(record.params,leak.duration||record.duration);
      const wanted=Math.max(range.start,Math.min(range.end-1e-3,range.start+raw*range.duration));
      const silent=!!record.audioClipId||!wantAudio||!leak.hasAudio;
      const level=silent?0:10**(Math.max(-60,Math.min(12,Number(record.params.leakGain??-6)))/20);
      if(audio&&!entry.source&&leak.hasAudio) {
        try { entry.source=audio.createMediaElementSource(element);entry.gain=audio.createGain();entry.source.connect(entry.gain);entry.gain.connect(master!); }
        catch { /* An element accepts only one media source node; keep the muted copy. */ }
      }
      if(audio&&entry.gain)entry.gain.gain.setTargetAtTime(level,audio.currentTime,.02);
      element.muted=!entry.gain;
      if(element.readyState<2){loading=true;return null;}
      element.playbackRate=Math.max(.0625,Math.min(16,range.duration/record.duration));
      if(state.playing&&element.currentTime<range.end&&element.paused)void element.play().catch(()=>{/* Autoplay needs a gesture. */});
      else if((!state.playing||element.currentTime>=range.end)&&!element.paused)element.pause();
      if(!element.seeking&&(element.currentTime<range.start||element.currentTime>=range.end||Math.abs(element.currentTime-wanted)>(state.playing?.3:.02)))element.currentTime=wanted;
      if(element.seeking){loading=true;return null;}
      return element;
    };
    const renderLayers = (timelineId:string,time:number,target:CanvasRenderingContext2D,referenceTarget:CanvasRenderingContext2D,show=true,hear=true,destination:AudioNode|undefined=master,rate=1,ancestry:string[]=[]):void => {
    if(ancestry.includes(timelineId)||ancestry.length>=32){error='Composition nesting contains a cycle or exceeds 32 levels.';return;}
    const records=timelineTransitions(state.clips,timelineId,state.media).filter(record=>transitionProgress(record,time));
    const items=playbackLayers({...state,timelineId,playhead:time},project?.fps||24,records);
    // A transition composites once both of its sides have been drawn, which keeps it in the
    // same z-position the plain cut would have occupied.
    const roleOf=(clipId:string)=>{for(const record of records){if(record.outgoingId===clipId)return {record,role:'outgoing' as const};if(record.incomingId===clipId)return {record,role:'incoming' as const};}return null;};
    const recordKey=(record:TransitionRecord)=>`${record.clipId}:${record.side}`;
    const finalIndex=new Map<TransitionRecord,number>();
    items.forEach((item,index)=>{const found=roleOf(item.clip.id);if(!found||!(show&&item.visual))return;finalIndex.set(found.record,index);});
    const flushed=new Set<TransitionRecord>();
    const flush=(before:number)=>{
      for(const record of records) {
        const last=finalIndex.get(record);
        if(last===undefined||last>=before||flushed.has(record))continue;
        flushed.add(record);
        const definition=transitionDefinitions[record.name],progress=transitionProgress(record,time);
        if(!definition||!progress)continue;
        const sides=sidesFor(recordKey(record));
        resetSide(blendContext);
        try {
          definition.draw({
            target:blendContext,
            // A side whose decoder is mid-seek keeps the frame it last produced. Dropping to an
            // empty canvas for a frame or two is what made the incoming shot appear to jitter.
            outgoing:sides.hasOut?sides.out:null,
            incoming:sides.hasIn?sides.in:null,
            overlay:definition.overlay?leakFrame(record,progress.raw,time,hear&&state.playing):null,
            progress:progress.eased,raw:progress.raw,
            params:{...record.params,__cutPoint:(record.cut-record.start)/record.duration,__curve:record.curve.join(','),__duration:record.duration,__fps:project?.fps||24},
            width,height,
          });
        } catch(cause) { error=cause instanceof Error?cause.message:`${record.name} could not be drawn.`; }
        target.save();
        target.setTransform(1,0,0,1,0,0);
        target.globalAlpha=1;
        target.globalCompositeOperation='source-over';
        target.drawImage(blend,0,0);
        target.restore();
        picture=true;
      }
    };
    for (const [index,item] of items.entries()) {
      flush(index);
      const {clip,asset,track}=item,visual=show&&item.visual,audible=hear&&item.audible;
      const participation=visual?roleOf(clip.id):null;
      const participationSides=participation?sidesFor(recordKey(participation.record)):null;
      const layerTarget=participationSides?(participation!.role==='outgoing'?participationSides.outContext:participationSides.inContext):target;
      // The side canvas is cleared immediately before it is drawn into, never on the way in, so a
      // layer that bails out on a loading decoder leaves the last good frame in place.
      const beginSide=()=>{if(!participationSides)return;resetSide(layerTarget);if(participation!.role==='outgoing')participationSides.hasOut=true;else participationSides.hasIn=true;};
      const original=syncClip(state.clips.find(c=>c.id===clip.id),clip);
      if (!visual && (!audible || !state.playing)) continue;
      if(clip.mediaId==='frameline-composition') {
        activeGroups.add(clip.id);
        let group=groups.get(clip.id);
        if(!group){group={canvas:document.createElement('canvas'),reference:document.createElement('canvas'),audio:{filters:[]}};groups.set(clip.id,group);}
        if(group.canvas.width!==width||group.canvas.height!==height){group.canvas.width=group.reference.width=width;group.canvas.height=group.reference.height=height;}
        const groupContext=group.canvas.getContext('2d')!,groupReference=group.reference.getContext('2d')!;
        groupContext.clearRect(0,0,width,height);groupReference.clearRect(0,0,width,height);
        const compositionId=String(clip.properties.compositionId??''),nested=state.timelines?.find(t=>t.id===compositionId);
        if(!compositionId||state.timelines&&!nested){error=`${clip.name}: composition timeline is missing.`;continue;}
        connect(group.audio,clip,()=>audio!.createGain(),destination);
        updateAudio(group.audio,clip,track,time,audible&&state.playing);
        const nestedTime=sourceTime(original,time,project?.fps||24,nested?.duration??Infinity);
        renderLayers(compositionId,nestedTime,groupContext,groupReference,visual,audible,group.audio.source,rate*(clip.properties.freeze?0:clip.properties.reverse?-1:1)*Number(clip.properties.speed??100)/100,[...ancestry,timelineId]);
        if(!visual)continue;
        layerContext.clearRect(0,0,width,height);layerContext.drawImage(group.reference,0,0);
        if(options.compare)draw(referenceTarget,clip,width,height,projectWidth,projectHeight,time);
        layerContext.clearRect(0,0,width,height);layerContext.drawImage(group.canvas,0,0);
        beginSide();finishLayer(clip,asset,time,layerTarget,undefined);
        continue;
      }
      if(isTitle(clip)||isShape(clip)) {
        if(!visual)continue;
        layerContext.clearRect(0,0,width,height);
        const artwork=transformMotion(clip,time,project?.fps??24,projectWidth,projectHeight).length>1?motionArtwork(clip):clip;
        if(isTitle(clip))drawText(layerContext,getText(artwork),width,height,projectWidth,projectHeight,sourceTime(original,time,project?.fps||24),clip.properties.animationTypingCount as number | undefined);
        else drawShape(layerContext,getShape(artwork),width,height,projectWidth,projectHeight);
        if(options.compare)draw(referenceTarget,clip,width,height,projectWidth,projectHeight,time);
        picture=true;beginSide();finishLayer(clip,asset,time,layerTarget,undefined);continue;
      }
      const flow = visual && asset.kind === 'video' && original.properties.opticalFlow
        ? flowPreview.get(original,time,project?.fps || 24,options.original?'Original':options.quality) : undefined;
      if (visual && original.properties.opticalFlow) {
        warning = flow?.status === 'ready' ? 'Optical flow · Ready' : flow?.status === 'failed' ? `Optical flow unavailable · ${flow.error}` : `Optical flow · Preparing ${flow?.progress ?? 0}%`;
        const detail={clipId:clip.id,...flow,status:flow?.status??'preparing'},signature=`${Math.floor(performance.now()/1000)}:${JSON.stringify(detail)}`;
        if(flowStatuses.get(clip.id)!==signature){flowStatuses.set(clip.id,signature);window.dispatchEvent(new CustomEvent('frameline:optical-flow',{detail}));}
      }
      const flowDecoder = (record: FlowPreview | undefined) => {
        if(record?.status!=='ready'||!record.url)return undefined;
        const id=`${clip.id}:flow:${record.key}`;
        const synthetic={...asset,hasAudio:false,colorProxyUrl:record.url,sourceUrl:record.url,proxyUrl:record.url,proxyVariants:{},duration:record.duration,fps:record.fps};
        const decoder=decoderFor({...clip,id},synthetic,true,{...options,original:false});
        if(decoder){activeIds.add(id);(decoder.element as HTMLMediaElement).preload='auto';}
        return decoder;
      };
      // Stabilize is a per-frame warp of the picture this clip already decodes: no substitute media, so
      // speed, reverse, freeze, the colour pipeline and Smart Mask all keep reading real source time.
      const stabilizeFx = visual && asset.kind === 'video' && !original.properties.opticalFlow ? stabilizeEffect(original) : undefined;
      const sourceFps = asset.fps || project?.fps || 24;
      let stabilizeSolveFor: StabilizeSolve | undefined;
      if (stabilizeFx) {
        let stabilizedRange;
        try { stabilizedRange = stabilizeRange(original, sourceFps, asset.duration || Infinity); } catch { stabilizedRange = undefined; }
        const solved = stabilizedRange ? stabilizePreview.get(original, stabilizedRange, stabilizeSettings(original, stabilizeFx), sourceFps) : undefined;
        stabilizeSolveFor = solved?.status === 'ready' ? solved.solve : undefined;
        warning = solved?.status === 'ready' ? 'Stabilize · Ready' : solved?.status === 'failed' ? `Stabilize unavailable · ${solved.error}` : `Stabilize · Analyzing ${solved?.progress ?? 0}%`;
        const detail={clipId:clip.id,status:solved?.status??'preparing',progress:solved?.progress??0,zoom:solved?.zoom,zoomMin:solved?.zoomMin,error:solved?.error};
        const signature=`${Math.floor(performance.now()/1000)}:${JSON.stringify(detail)}`;
        if(stabilizeStatuses.get(clip.id)!==signature){stabilizeStatuses.set(clip.id,signature);window.dispatchEvent(new CustomEvent('frameline:stabilize',{detail}));}
      }
      const interpolated = flowDecoder(flow);
      if(original.properties.opticalFlow&&visual&&time-original.start+flowChunkSeconds<original.duration) {
        const next=flowPreview.get(original,time+flowChunkSeconds,project?.fps||24,options.original?'Original':options.quality);
        const warm=flowDecoder(next); if(warm)(warm.element as HTMLVideoElement).pause();
      }
      const flowReady=interpolated && (interpolated.element as HTMLVideoElement).readyState>=2;
      const url = playbackUrl(asset, options, visual && !flowReady);
      const fallback = !url && visual && asset.thumbnail;
      if (!url) missing = true;
      if (!url && !fallback) continue;
      const decoderId=!visual&&asset.kind==='video'?`${clip.id}:audio`:clip.id;
      const decoder = flowReady && !audible ? interpolated : decoderFor(decoderId===clip.id?clip:{...clip,id:decoderId}, asset, visual && !flowReady, options);
      if (!decoder) continue;
      if(decoder!==interpolated)activeIds.add(decoderId);
      if (decoder.error) { error = decoder.error; footageCache.setDecoderStatus(clip.id, decoder.url, decoder.error, true); continue; }
      const frames=visual&&!flowReady&&rate>0&&rate*Number(clip.properties.speed??100)/100<=2?buffered(decoder,clip,asset.fps||24):undefined;
      if(!frames&&decoder.frames){decoder.frames.dispose();decoder.frames=undefined;}
      let queuedFrame:VideoFrame|undefined;
      if(frames){
        const media=decoder.element as HTMLVideoElement,targetTime=sourceTime(original,time,asset.fps||24,Number.isFinite(media.duration)?media.duration:asset.duration||Infinity);
        if(decoder.gain&&audio)decoder.gain.gain.setValueAtTime(0,audio.currentTime);
        media.muted=true;
        frames.update(targetTime);queuedFrame=frames.frame(targetTime);engine='webcodecs';decodedAhead=Math.min(decodedAhead,frames.ahead);
        // Picture decodes ahead; sound stays on the timeline clock and must never leak during pre-roll.
        if(audible){
          const sound=decoderFor({...clip,id:`${clip.id}:audio`},asset,false,options);
          if(sound){
            activeIds.add(`${clip.id}:audio`);const element=sound.element as HTMLMediaElement;
            const running=state.playing&&!stalled;
            if(!running)element.pause();
            if(element.readyState>=1&&!element.seeking&&Math.abs(element.currentTime-targetTime)>(running?.12:1/(asset.fps||24)))seeks.push([element,targetTime]);
            element.playbackRate=Math.max(.0625,Math.min(8,rate*Number(clip.properties.speed??100)/100));
            connect(sound,clip,()=>audio!.createMediaElementSource(element),destination);updateAudio(sound,clip,track,time,running);element.muted=!sound.gain;
            if(running)play(sound);if(sound.error)error=sound.error;
          }
        }
        for(const frame of frames.prepare(targetTime,Math.max(.001,rate*Number(clip.properties.speed??100)/100)/previewFps))color?.prepare(media,frame);
        if(!queuedFrame){
          decoder.waitingSince??=performance.now();
          if(options.quality==='Stream'&&!options.original&&performance.now()-decoder.waitingSince>1200&&asset.proxyVariants?.StreamLow&&decoder.url!==asset.proxyVariants.StreamLow){automaticStreams.set(asset.id,asset.proxyVariants.StreamLow);dirty=true;}
          // Failed codecs switch through buffered() immediately. A network timeout remains visible.
          if(performance.now()-decoder.waitingSince>30000){decoder.framesFailed=true;frames.dispose();decoder.frames=undefined;dirty=true;}
          loading=true;footageCache.setDecoderStatus(clip.id,decoder.url,`${asset.name} · ${frames.ahead?'Decoding requested frame':'Buffering video'}`);continue;
        }
        decoder.waitingSince=undefined;
        footageCache.setDecoderStatus(clip.id,decoder.url);
      }
      if (!decoder.image && !frames) {
        if(visual)engine='native';
        const media = decoder.element as HTMLMediaElement;
        media.preload='auto';
        if (media.readyState < 2 || media.seeking) {
          decoder.waitingSince ??= performance.now();
          const waited = performance.now() - decoder.waitingSince;
          const stream = asset.proxyVariants?.Stream, requested = playbackUrl(asset, options, visual);
          if (waited > 8000 && stream && stream !== decoder.url && requested) { streamFallbacks.set(requested, stream); dirty = true; }
          if (waited > 30000) { decoder.error = `${asset.name}: playback stalled. Check the connection and retry.`; dirty = true; }
          footageCache.setDecoderStatus(clip.id, decoder.url, `${asset.name} · ${media.seeking ? 'Seeking frame' : media.readyState < 1 ? 'Loading media metadata' : 'Buffering / decoding frame'}`);
        } else { decoder.waitingSince = undefined; footageCache.setDecoderStatus(clip.id, decoder.url); }
      }
      if (!decoder.image && decoder!==interpolated && !frames) {
        const media = decoder.element as HTMLMediaElement;
        const fps = asset.fps || project?.fps || 24;
        const targetTime = sourceTime(original, time, fps, Number.isFinite(media.duration) ? media.duration : asset.duration || Infinity);
        const speed = rate * Number(clip.properties.speed ?? 100) / 100;
        const normalPlayback = state.playing && !stalled && !clip.properties.reverse && !clip.properties.freeze && speed >= .0625 && speed <= 8;
        if (!normalPlayback) media.pause();
        // Paint the completed seek before starting the newest request; never queue stale pointer positions.
        const drift = media.readyState >= 1 ? media.currentTime - targetTime : 0;
        if (media.readyState >= 1 && !media.seeking && (normalPlayback ? Math.abs(drift)>.45 : Math.floor(media.currentTime*fps+1e-6)!==Math.floor(targetTime*fps+1e-6))) seeks.push([media, Math.min(Number.isFinite(media.duration)?Math.max(0,media.duration-.001):Infinity,(Math.floor(targetTime*fps+1e-6)+.5)/fps)]);
        // While playing, close small drift by nudging the rate rather than seeking. A heavy
        // composite lets the decoder run a frame or two ahead of the timeline, and a seek backwards
        // is a visible jump where a few per cent of rate is not; only a stall or a scrub past the
        // tolerance is worth a hard seek. Proportional, so it converges in about a second.
        const corrected = Math.max(.0625, Math.min(8, speed * (normalPlayback ? 1 - Math.max(-.08, Math.min(.08, drift)) : 1)));
        // Only write it when it actually moves: assigning a fractionally different rate every frame
        // makes the decoder reconfigure its pipeline for nothing.
        if (Math.abs(media.playbackRate - corrected) > .004) media.playbackRate = corrected;
        connect(decoder, clip,()=>audio!.createMediaElementSource(decoder.element as HTMLMediaElement),destination);
        updateAudio(decoder,clip,track,time,audible&&normalPlayback);
        media.muted=!decoder.gain;
        if (normalPlayback) play(decoder);
        if (audible && clip.properties.reverse) warning = 'Reverse video preview · reversed audio is included in export.';
        else if (audible && (speed < .25 || speed > 4)) warning = 'Extreme-speed preview may mute audio · export retains retimed audio.';
        if (media.readyState < 2 || media.seeking) {
          // A transition side that already holds a frame is not worth stalling the whole output
          // for; the composite reuses it and playback stays smooth through the window.
          const stale = participationSides && (participation!.role === 'outgoing' ? participationSides.hasOut : participationSides.hasIn);
          if (visual && !stale && !flowReady) loading = true;
          if(!flowReady)continue;
        }
      } else if (decoder.image && (!(decoder.element as HTMLImageElement).complete || !(decoder.element as HTMLImageElement).naturalWidth)) { loading = true; footageCache.setDecoderStatus(clip.id, decoder.url, `${asset.name} · Loading image`); continue; }
      else if (decoder.image) footageCache.setDecoderStatus(clip.id, decoder.url);
      if (!visual) continue;
      picture = true;
      const element = (flowReady ? interpolated.element : decoder.element) as HTMLVideoElement | HTMLImageElement;
      if(flowReady&&flow) {
        const media=element as HTMLVideoElement,target=Math.max(0,Math.min(flow.duration-1/flow.fps,time-original.start-flow.from));
        const playing=state.playing&&rate>0,drift=media.currentTime-target;
        media.muted=true;media.playbackRate=Math.max(.0625,Math.min(8,Math.abs(rate)));
        if(playing)play(interpolated);else media.pause();
        if(!media.seeking&&Math.abs(drift)>(playing?.12:.5/flow.fps))seeks.push([media,target]);
        if(media.seeking){loading=true;continue;}
      }
      sourceClip = clip.id;
      sourceTimestamp = String(queuedFrame?queuedFrame.timestamp/1e6:element instanceof HTMLVideoElement ? Math.floor(element.currentTime * (asset.fps || 24) + 1e-6) / (asset.fps || 24) : 0);
      const sourceWidth = queuedFrame?.displayWidth ?? (element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth);
      const sourceHeight = queuedFrame?.displayHeight ?? (element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight);
      if (!sourceWidth || !sourceHeight) continue;
      layerContext.clearRect(0, 0, width, height);
      const fit = Math.min(width / sourceWidth, height / sourceHeight);
      layerContext.drawImage(queuedFrame??element, (width - sourceWidth * fit) / 2, (height - sourceHeight * fit) / 2, sourceWidth * fit, sourceHeight * fit);
      if (options.compare) draw(referenceTarget, clip, width, height, projectWidth, projectHeight,time);
      // While the analysis runs, hold the original at the crop the solve will apply so the framing never jumps.
      const framed = stabilizeFx && !stabilizeSolveFor ? {...clip, properties:{...clip.properties, zoom: Number(clip.properties.zoom ?? 100) * stabilizeZoom(stabilizeSettings(original, stabilizeFx))}} : clip;
      const warp = stabilizeSolveFor ? {solve:stabilizeSolveFor,time:sourceTime(original,time,sourceFps,asset.duration||Infinity),sourceWidth,sourceHeight} : undefined;
      beginSide();finishLayer(framed,asset,time,layerTarget,element instanceof HTMLVideoElement?element:undefined,warp,queuedFrame);
    }
    flush(Infinity);
    };
    type LayerWarp = { solve:StabilizeSolve; time:number; sourceWidth:number; sourceHeight:number };
    /** The stabilize warp in this layer's pixels. Picture and matte take the same one, which is what puts the
     *  matte on the stabilized frame instead of the original framing. */
    const warpTransform = (warp:LayerWarp) => stabilizeLayerTransform(warp.solve,warp.time,width,height,warp.sourceWidth,warp.sourceHeight);
    const finishLayer = (clip:Clip,asset:MediaAsset,time:number,target:CanvasRenderingContext2D,element?:HTMLVideoElement,warp?:LayerWarp,snapshot?:VideoFrame) => {
      let masks=new Map<string,SmartMaskPixels>();
      try {
        const nodes = evaluateNodes(state.nodes.filter(node => node.clipId === clip.id),clip,time).filter(node=>node.enabled);
        const maskCount=activeSmartMasks(clip,nodes).length;
        if(maskCount&&clip.properties.opticalFlow)throw Error('Smart Mask and optical-flow retiming need a shared warped matte. Disable optical flow for this clip.');
        const loadMasks=(sampleTime:number)=>{
          masks=new Map<string,SmartMaskPixels>();
          for(const [id,mask] of maskPreview.read(clip,nodes,sampleTime,asset)){
            // Only a WebGL node mask needs layer-fitted pixels; the clip effect composites the matte canvas directly.
            if(!nodes.some(n=>n.mask?.id===id&&n.mask.enabled)){masks.set(id,mask);continue;}
            // A node limited to a subject that is not found yet grades nothing (or everything, inverted), never the whole frame.
            if(mask===unanalyzedSmartMask)warning='Smart Mask · not analyzed here yet · masked grade is off';
            const matte=mask===unanalyzedSmartMask?{...mask,data:new Uint8Array([0])}:mask;
            const doc=clip.smartMasks!.find(m=>m.id===id)!,key=`${mask.key}:${width}:${height}:${doc.source.width}:${doc.source.height}`;
            let fitted=fittedMasks.get(key);if(!fitted){while(fittedMasks.size>=24)fittedMasks.delete(fittedMasks.keys().next().value!);fitted={width,height,key,data:fittedSmartMask(matte,width,height,doc.source.width,doc.source.height)};fittedMasks.set(key,fitted);}masks.set(id,fitted);
          }
          return masks;
        };
        if(maskCount || nodes.length || clip.properties.resolveLookUrl || Number(clip.properties.inputExposure) || Number(clip.properties.inputTemperature) || clip.properties.yuvMatrix || clip.properties.dataLevels&&clip.properties.dataLevels!=='Auto') {
          color ??= createColorPreview(()=>{dirty=true;});
          const previewAsset=element?.src.includes('/files/')?{...asset,colorMatrix:'bt709'}:asset;
          const result = color.draw(layer,clip,previewAsset,nodes,element,sampleTime=>loadMasks(element?sampleTime:sourceTime(clip,time,asset.fps||24,asset.duration)),snapshot);
          if(element)sourceTimestamp=result.dataset.sourceTimestamp ?? '';
          canvas.dataset.colorPrecision=result.dataset.colorPrecision??'8-bit RGB fallback';
          layerContext.clearRect(0,0,width,height); layerContext.drawImage(result,0,0);
        }
      } catch (cause) { if(cause instanceof ColorPending||cause instanceof SmartMaskPending){loading=true;footageCache.setDecoderStatus(clip.id,asset.proxyUrl??'',`${asset.name} · ${cause instanceof ColorPending?'Preparing color frame':'Preparing mask'}`);const pending=seeks.findIndex(([media])=>media===element);if(pending>=0)seeks.splice(pending,1);}else {error=cause instanceof Error?cause.message:'Color preview unavailable.';footageCache.setDecoderStatus(clip.id,asset.proxyUrl??'',`${asset.name}: ${error}`,true);} layerContext.clearRect(0,0,width,height);return; }
      // Stabilize goes first. Grading and node masks read the frame the camera shot; from here on every
      // screen-space effect below, and the Smart Mask cut, sees the stabilized picture.
      if(warp) {
        if(warpScratch.width!==width||warpScratch.height!==height){warpScratch.width=width;warpScratch.height=height;}
        const scratch=warpScratch.getContext('2d')!;
        scratch.setTransform(1,0,0,1,0,0);scratch.globalCompositeOperation='copy';scratch.drawImage(layer,0,0);
        layerContext.save();layerContext.globalCompositeOperation='copy';
        layerContext.setTransform(...warpTransform(warp));layerContext.drawImage(warpScratch,0,0);
        layerContext.restore();
      }
      for (const effect of clip.effects.filter(e=>effectEnabled(clip,e))) {
        const amount=effectValue(clip,effect,'amount');
        if(!amount)continue;
        if(effect.name==='Smart Mask') {
          const mask=masks.get(effect.maskId!);if(!mask){loading=true;layerContext.clearRect(0,0,width,height);return;}
          if(mask===unanalyzedSmartMask){warning='Smart Mask · not analyzed here yet · showing the full picture';continue;}
          const doc=clip.smartMasks!.find(m=>m.id===effect.maskId)!,invert=!!effect.parameters?.invert;
          const fit=Math.min(width/doc.source.width,height/doc.source.height),fitWidth=doc.source.width*fit,fitHeight=doc.source.height*fit,left=(width-fitWidth)/2,top=(height-fitHeight)/2;
          const filter=mask.canvas?lumaAlphaFilter(amount,invert):null;
          if(filter){
            // Gray matte to alpha on the GPU, composited in one draw; nothing per pixel in JavaScript.
            // The matte tracks the original frame, so it rides the same warp the picture just took.
            layerContext.save();layerContext.globalCompositeOperation='destination-in';layerContext.filter=filter;
            if(warp)layerContext.setTransform(...warpTransform(warp));
            layerContext.drawImage(mask.canvas!,left,top,fitWidth,fitHeight);layerContext.restore();
          } else {
            // ponytail: Safari has no canvas filter yet; build one alpha canvas per matte frame instead.
            const cutKey=`${mask.key}:${width}:${height}:${amount}:${invert?1:0}`;
            let cut=maskCuts.get(cutKey);
            if(!cut){
              while(maskCuts.size>=24)maskCuts.delete(maskCuts.keys().next().value!);
              const data=mask.width===width&&mask.height===height?mask.data:fittedSmartMask(mask,width,height,doc.source.width,doc.source.height);
              cut=document.createElement('canvas');cut.width=width;cut.height=height;
              const cutContext=cut.getContext('2d')!,image=cutContext.createImageData(width,height),keep=1-amount/100,scale=amount/100;
              for(let i=0;i<data.length;i++){const alpha=data[i]/255;image.data[i*4+3]=Math.round(255*(keep+scale*(invert?1-alpha:alpha)));}
              cutContext.putImageData(image,0,0);maskCuts.set(cutKey,cut);
            }
            layerContext.save();layerContext.globalCompositeOperation='destination-in';
            if(warp)layerContext.setTransform(...warpTransform(warp));
            layerContext.drawImage(cut,0,0);layerContext.restore();
          }
        } else if(effect.name==='Gaussian blur') {
          layerContext.filter=`blur(${amount/100*effectValue(clip,effect,'radius')*ratio}px)`;
          layerContext.globalCompositeOperation='copy';layerContext.drawImage(layer,0,0);layerContext.globalCompositeOperation='source-over';layerContext.filter='none';
        } else if(effect.name==='Bloom') {
          bloomPass(layerContext,width,height,effectValue(clip,effect,'threshold'),amount/100);
        } else if(effect.name==='Vignette') {
          const x=width*effectValue(clip,effect,'centerX')/100,y=height*effectValue(clip,effect,'centerY')/100;
          const gradient=layerContext.createRadialGradient(x,y,Math.min(width,height)*.15,x,y,Math.max(width,height)*.65);
          gradient.addColorStop(0,'transparent');gradient.addColorStop(1,`rgba(0,0,0,${amount/100})`);
          layerContext.globalCompositeOperation='source-atop';layerContext.fillStyle=gradient;layerContext.fillRect(0,0,width,height);layerContext.globalCompositeOperation='source-over';
        } else if(['Film grain','Sharpen','Noise Reduction'].includes(effect.name)) {
          const pixels=layerContext.getImageData(0,0,width,height);
          detailPixels(pixels.data,width,height,clip,effect,Math.floor(time*(project?.fps||24)));
          layerContext.putImageData(pixels,0,0);
        }
      }
      draw(target,clip,width,height,projectWidth,projectHeight,time);
    };
    const prepared=state.renderPreviewAllowed!==false&&!options.compare&&!options.original&&options.quality==='Stream'?timelinePreview.get(state,state.playhead,width,height,performance.now()<expensiveUntil):undefined;
    if(prepared){
      renderLayers(state.timelineId,state.playhead,context,referenceContext,false,true);
      context.drawImage(prepared.frame,0,0,width,height);picture=true;engine='render-cache';warning='Rendered preview · ready';sourceClip=`preview:${prepared.key}`;sourceTimestamp=String(state.playhead);
    }else renderLayers(state.timelineId,state.playhead,context,referenceContext);
    if(!prepared&&!loading&&state.playing&&performance.now()-renderStarted>1000/previewFps*.7){
      if(++expensiveFrames>=6){expensiveUntil=performance.now()+15000;expensiveFrames=0;}
    }else expensiveFrames=Math.max(0,expensiveFrames-1);
    // Warm upcoming pictures and their looks independently of the audio clips.
    const upcoming=timelineTransitions(state.clips,state.timelineId,state.media).filter(record=>record.start>state.playhead&&record.start-state.playhead<1.5);
    // Every warmed decoder is another preload="auto" stream competing for the same link. Off the
    // LAN that is what made the first pass stall: several of them pulling clips minutes away while
    // the clip on screen was still starving. Nothing past the horizon is worth opening, and while
    // the picture is loading retain prepared decoders without opening additional streams.
    const horizon = state.playing ? 5 : 2;
    const candidates=state.clips.filter(clip=>state.media.some(asset=>asset.id===clip.mediaId)&&clip.timelineId===state.timelineId&&clip.projectId===state.projectId&&!clip.disabled&&!activeIds.has(clip.id)&&clip.start>state.playhead&&clip.start-state.playhead<horizon&&state.tracks.some(t=>t.id===clip.trackId&&(t.kind==='video'?!t.hidden:!t.muted)))
      .sort((a,b)=>(upcoming.some(r=>r.incomingId===b.id||r.outgoingId===b.id)?1:0)-(upcoming.some(r=>r.incomingId===a.id||r.outgoingId===a.id)?1:0)||a.start-b.start);
    const nearby=[...candidates.filter(c=>state.tracks.find(t=>t.id===c.trackId)?.kind==='video').slice(0,efficient?1:3),...(state.playing?candidates.filter(c=>state.tracks.find(t=>t.id===c.trackId)?.kind==='audio').slice(0,efficient?1:2):[])];
    for (const clip of nearby) {
      if (loading && !decoders.has(clip.id)) continue;
      const asset = state.media.find(asset => asset.id === clip.mediaId);
      if (!asset) continue;
      if(state.tracks.find(t=>t.id===clip.trackId)?.kind==='video'&&(clip.properties.resolveLookUrl||state.nodes.some(node=>node.clipId===clip.id&&node.enabled)||Number(clip.properties.inputExposure)||Number(clip.properties.inputTemperature)||clip.properties.yuvMatrix||clip.properties.dataLevels&&clip.properties.dataLevels!=='Auto')) {try{color??=createColorPreview(()=>{dirty=true;});color.preload(clip,asset);}catch{/* The active clip reports an invalid transform. */}}
      const decoder = decoderFor(clip, asset, state.tracks.find(t=>t.id===clip.trackId)?.kind==='video' && asset.kind !== 'audio', options);
      warmIds.add(clip.id);
      if (decoder && !decoder.image) {
        const media = decoder.element as HTMLMediaElement;
        const window = upcoming.find(record => record.incomingId === clip.id || record.outgoingId === clip.id);
        const warmSpan = window ? clipSpan(clip, [window]) : null;
        const warmClip = warmSpan ? extendClip(clip, warmSpan.start, warmSpan.end - warmSpan.start) : clip;
        const time = sourceTime(warmClip, Math.max(state.playhead, warmClip.start), asset.fps || project?.fps || 24, asset.duration || Infinity);
        const track=state.tracks.find(t=>t.id===clip.trackId);
        const frames=track?.kind==='video'?buffered(decoder,clip,asset.fps||24):undefined;
        if(frames){
          if(asset.hasAudio&&!clip.properties.audioDetached&&!track?.muted){
            const sound=decoderFor({...clip,id:`${clip.id}:audio`},asset,false,options);
            if(sound){warmIds.add(`${clip.id}:audio`);const element=sound.element as HTMLMediaElement;element.pause();element.muted=true;if(element.readyState>=1&&!element.seeking&&Math.abs(element.currentTime-time)>.05)seeks.push([element,time]);}
          }
          media.muted=true;frames.update(time);
          for(const frame of frames.prepare(time,Math.max(.001,Number(clip.properties.speed??100)/100)/previewFps))color?.prepare(media as HTMLVideoElement,frame);
          continue;
        }
        media.preload='auto';
        if (media.readyState >= 1 && !media.seeking && Math.abs(media.currentTime - time) > .05) seeks.push([media, Math.min(Number.isFinite(media.duration)?Math.max(0,media.duration-.001):Infinity,(Math.floor(time*(asset.fps||project?.fps||24)+1e-6)+.5)/(asset.fps||project?.fps||24))]);
        // Have the first color snapshot ready at the cut, as well as its decoder and LUT.
        if (media instanceof HTMLVideoElement && !seeks.some(([element]) => element === media)) {
          try { color?.prepare(media); } catch { /* The active clip reports a decode error. */ }
        }
      }
    }
    for (const [id, decoder] of decoders) if (!activeIds.has(id)) {
      footageCache.setDecoderStatus(id, decoder.url);
      // Pausing stops playback but NOT the fetch: preload='auto' keeps filling the buffer, so a pool
      // of idle decoders quietly competes with the clip on screen for the same uplink. Only the warm
      // set (the next cuts) is worth buffering ahead; everything else drops back to metadata.
      if (!decoder.image) { const media = decoder.element as HTMLMediaElement; if(!decoder.frames||!warmIds.has(id))media.pause(); const want = decoder.frames ? 'none' : warmIds.has(id) ? 'auto' : 'metadata'; if (media.preload !== want) media.preload = want; }
      if (!state.clips.some(clip => clip.id === id || id===`${clip.id}:audio` || id.startsWith(`${clip.id}:flow:`))) { cleanup(decoder); decoders.delete(id); }
    }
    for(const [key,entry] of sideCanvases)if(performance.now()-entry.lastUsed>5000)sideCanvases.delete(key);
    for(const [id,entry] of leaks)if(performance.now()-entry.lastUsed>8000){entry.gain?.disconnect();entry.source?.disconnect();entry.element.pause();entry.element.removeAttribute('src');entry.element.load();leaks.delete(id);}
    for(const [id,group] of groups)if(!activeGroups.has(id)){group.audio.source?.disconnect();group.audio.filters.forEach(n=>n.disconnect());group.audio.analyser?.disconnect();group.audio.gain?.disconnect();group.audio.pan?.disconnect();groups.delete(id);}
    for (const [id, decoder] of [...decoders].filter(([id]) => !activeIds.has(id) && !warmIds.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      // Every retained decoder is a live hardware decode session and a buffer competing for the
      // uplink. Never evict the next cuts we just prepared: recreating them each tick
      // discards their seek and decoded frame before the cut. Only idle spares can be evicted.
      if (decoders.size <= Math.max(efficient?2:4, activeIds.size)) break;
      cleanup(decoder); decoders.delete(id);
    }
    if(!loading){canvas.dataset.frameRevision=String(++frameRevision);composite.dataset.frameRevision=canvas.dataset.frameRevision;window.dispatchEvent(new CustomEvent('frameline:scope-frame',{detail:composite}));}
    if (options.compare) context.drawImage(reference, 0, 0, width / 2, height, 0, 0, width / 2, height);
    if (!loading) {
      output.drawImage(composite, 0, 0);
      canvas.dataset.hasPicture = String(picture);
      canvas.dataset.sourceClip = sourceClip; canvas.dataset.sourceTimestamp = sourceTimestamp;
      window.dispatchEvent(new CustomEvent('frameline:frame', { detail: canvas }));
    }
    for (const [media, time] of seeks) media.currentTime = time;
    if (seeks.length) dirty = true;
    if (loading) for (const decoder of decoders.values()) if (!decoder.image && !decoder.frames) (decoder.element as HTMLMediaElement).pause();
    stalled = loading;
    canvas.dataset.playbackEngine=engine;canvas.dataset.decodedAhead=String(Number.isFinite(decodedAhead)?decodedAhead:0);canvas.dataset.buffering=String(loading);
    window.dispatchEvent(new CustomEvent('frameline:playback-health',{detail:{playing:state.playing,playhead:state.playhead,loading,error,engine,reason:loading?[...activeIds].map(id=>footageCache.clipFootageStatus(id).playback?.detail).filter(Boolean).join('; '):'',decodedAhead:Number.isFinite(decodedAhead)?decodedAhead:0}}));


    if (performance.now() - meterTime > 80) {
      meterTime = performance.now(); let rms = 0;
      if (masterAnalyser && state.playing) { const samples = new Float32Array(masterAnalyser.fftSize); masterAnalyser.getFloatTimeDomainData(samples); rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); }
      window.dispatchEvent(new CustomEvent('frameline:meters', { detail: { tracks: trackLevels, master: rms } }));
    }
    const blocker = [...activeIds].map(id => footageCache.clipFootageStatus(id)).map(item => item.playback).find(Boolean);
    const automaticLow=[...activeIds].some(id=>{const decoder=decoders.get(id);return decoder&&[...automaticStreams.values()].includes(decoder.url);});
    const fallbackActive = [...activeIds].some(id => { const decoder = decoders.get(id); return decoder && [...streamFallbacks.values()].includes(decoder.url); });
    status(error ? { title: 'Playback unavailable', detail: error, error: true } : loading ? { title: 'Loading picture…', detail: blocker?.detail ?? 'Preparing required layers', loading: true } : missing ? { title: 'Original media offline', detail: 'Import the source files to play this timeline.' } : !picture && !layers.some(l => l.audible) ? { title: 'No picture at playhead' } : fallbackActive ? { title: 'Stream fallback', detail: 'The selected source could not play smoothly. Showing the compatible Stream preview with reduced precision; exports still use originals.', fallback: true } : automaticLow ? { title: 'Auto preview · reduced bandwidth', detail: 'Using the smaller streaming preview to keep playback moving. Originals and export quality are unchanged.' } : warning ? { title: warning } : null);
  };
  frame = requestAnimationFrame(tick);
  return {
    retry() {
      streamFallbacks.clear(); automaticStreams.clear(); footageCache.retryFootage();
      for (const [id, decoder] of decoders) { cleanup(decoder); footageCache.setDecoderStatus(id, decoder.url); }
      decoders.clear(); dirty = true;
    },
    resume() {
      if (disposed) return;
      if (!audio) { audio = new AudioContext(); master = audio.createGain(); masterAnalyser = audio.createAnalyser(); masterAnalyser.fftSize = 256; master.connect(masterAnalyser).connect(audio.destination); }
      void audio.resume().catch(() => { if (!disposed) status({ title: 'Audio unavailable', detail: 'Allow audio playback in your browser.' }); });
      for (const decoder of decoders.values()) decoder.blocked = false;
      dirty = true;
    },
    dispose() { disposed = true; timelinePreview.dispose();maskPreview.dispose();fittedMasks.clear();maskCuts.clear();motion?.dispose(); flowPreview.dispose(); stabilizePreview.dispose(); document.fonts.removeEventListener('loadingdone', fontsChanged);window.removeEventListener('frameline:request-scope',fontsChanged); color?.dispose(); cancelAnimationFrame(frame); for (const [id, decoder] of decoders) { cleanup(decoder); footageCache.setDecoderStatus(id, decoder.url); } decoders.clear(); for(const entry of leaks.values()){entry.gain?.disconnect();entry.source?.disconnect();entry.element.pause();entry.element.removeAttribute('src');entry.element.load();}leaks.clear(); for(const group of groups.values()){group.audio.source?.disconnect();group.audio.filters.forEach(n=>n.disconnect());group.audio.analyser?.disconnect();group.audio.gain?.disconnect();group.audio.pan?.disconnect();}groups.clear(); if (audio) void audio.close(); },
  };
}
