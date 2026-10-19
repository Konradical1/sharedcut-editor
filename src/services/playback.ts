import { createTimelinePreview } from './timelinePreview.ts';
import { createSmartMaskPreview, activeSmartMasks, fittedSmartMask, lumaAlphaFilter, SmartMaskPending, unanalyzedSmartMask, type SmartMaskPixels } from './smartMaskPreview.ts';
import { createMotionPreview } from './motionPreview.ts';
import { createDepthPreview, depthFocusTrack, depthKeyMatte, depthUi, forgetDepth, noDepthKey, rememberDepth, subscribeDepth } from './depthPreview.ts';
import { depthFocusAt, depthFrameAt } from './depth.ts';
import { activeDepthKeys, nodeMaskId, smartMaskSignature } from './smartMask.ts';
import { createDepthFx, depthFxKeys, depthTapBudget, type DepthFxInput, type DepthFxParams } from './depthFx.ts';
import { blendModeOf } from './blendModes.ts';
import { transformMotion, drawMotionPose, motionArtwork } from './motionBlur.ts';
import { animatedSourceOffset, evaluateClip, evaluateNodes, fadeLevel, trimAnimation } from './animation.ts';
import { bloomPass, leakRange, isLeakMedia, leakIdOf, timelineTransitions, transitionDefinitions, transitionProgress, type TransitionRecord } from './transitions.ts';
import { drawText, getText, isTitle } from './text.ts';
import { drawShape, getShape, isShape } from './shapes.ts';
import { adjustmentAsset, isAdjustment } from './adjustment.ts';
import { effectValue, effectEnabled, detailPixels, loudnessTarget } from './effects.ts';
import { eqBiquads, kWeighting, loudnessWindow } from './audioDsp.ts';
import type { Clip, GradeNode, MediaAsset, Project, Settings, Timeline, Track } from '../state/models.ts';
import { gradeValues } from './grade.ts';
import { createVideoFrames, NEAR_PICTURES } from './videoFrames.ts';
import { createScrubFrames } from './scrubFrames.ts';
import { createColorPreview, ColorPending } from './colorPreview.ts';
import { createFlowPreview } from './flowPreview.ts';
import { createStabilizePreview } from './stabilizePreview.ts';
import { stabilizeEffect, stabilizeLayerTransform, stabilizeRange, stabilizeSettings, stabilizeZoom, type StabilizeSolve } from './stabilize.ts';
import './clipStatus.ts';
import * as footageCache from './footageCache.ts';
import { flowChunkSeconds, type FlowPreview } from './opticalFlow.ts';
import { shownSourceTime, sourceSize } from './motionTracker.ts';
import { denoiseEffect, type DenoisePreview } from './denoise.ts';
import { createDenoisePreview, denoiseStatus, denoiseStatusText, noiseUi, subscribeDenoise } from './denoisePreview.ts';
import { isPhone } from './device.ts';

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
  /** A frame editor's clip: shown alone, whole and untransformed, at source seconds `time` (the playhead's while playing). */
  focus?: { clipId: string; time: number } | null;
};

/**
 * The focused clip reduced to its source picture: no transform, effects or stabilize, and timed so that timeline
 * second t reads source second t·speed/100. Its grade and input interpretation stay, so it looks like the timeline.
 * `speed` is the rate playback moves through the source now, so the decoder reads ahead at that rate instead of seeking;
 * by default the clip's own constant speed, or 100% for a reversed, frozen or ramped clip.
 */
export function focusClip(clip: Clip, asset: Pick<MediaAsset, 'duration'>, speed?: number): Clip {
  const p = clip.properties, ramped = Object.keys(clip.keyframes ?? {}).some(path => ['properties.speed', 'properties.reverse', 'properties.freeze'].includes(path));
  const rate = Math.max(1, Math.min(1000, speed ?? (p.reverse || p.freeze || ramped ? 100 : Number(p.speed ?? 100))));
  return { ...clip, start: 0, sourceIn: 0, duration: (asset.duration + 1) * 100 / rate, disabled: false, effects: [], keyframes: undefined, properties: { ...p, speed: rate, reverse: false, freeze: false, opticalFlow: false } };
}
export type PreviewOptions = { original: boolean; quality: string; volume: number; compare: boolean; fontsRevision?: number };
export type PlaybackStatus = { title: string; detail?: string; error?: boolean; loading?: boolean; fallback?: boolean; skipped?: boolean } | null;
/** How long a paused seek may take before the viewer admits it is loading. */
const QUIET_SEEK_MS = 600;
/** A failed layer is reopened in the background after this pause, doubling per failure up to the cap. */
const LAYER_RETRY_MS = 2000, LAYER_RETRY_MAX_MS = 30000;
/** Paused scrub decoders kept open, least recently used first out. */
const SCRUB_POOL = 6;
/** New look-ahead colour copies a tick may start beyond the next three pictures, across all layers (a burst of GPU readbacks would stall the tick). */
const MAX_AHEAD_COPIES = 2;
/** Longest side of a phone's preview picture, in pixels. */
const PHONE_PREVIEW_EDGE = 640;
/**
 * Smooth playback: a device that cannot composite live plays the server's rendered preview. Chunks asked for ahead of a
 * playing playhead, the longest wait for one before the live picture takes over, and the longest side rendered.
 */
const SMOOTH_AHEAD = 4, SMOOTH_HOLD_MS = 8000, SMOOTH_EDGE = 960;
const SMOOTH_REASON = 'Smooth playback · buffering rendered preview';

export function efficientPlayback(mode: Settings['performanceMode'] | undefined, device: { hardwareConcurrency?: number; deviceMemory?: number } = typeof navigator === 'undefined' ? {} : navigator) {
  if (mode === 'On') return true;
  if (mode === 'Off') return false;
  return (Number(device.hardwareConcurrency) > 0 && Number(device.hardwareConcurrency) <= 4) || (Number(device.deviceMemory) > 0 && Number(device.deviceMemory) <= 4);
}

export function playbackUrl(asset: MediaAsset, options: Pick<PreviewOptions, 'original' | 'quality'>, visual: boolean) {
  if (options.original) return asset.sourceUrl || asset.proxyUrl;
  if (!visual && asset.audioProxyUrl) return asset.audioProxyUrl;
  // A graphic's grading proxy (if an older import made one) is opaque, and its ProRes original will not play in a browser.
  if(asset.hasAlpha&&(options.quality==='Full'||options.quality==='Color'))return asset.proxyUrl||asset.sourceUrl;
  if(visual&&options.quality==='Full'&&asset.colorProxyUrl)return asset.colorProxyUrl;
  if(options.quality==='Color')return asset.colorProxyUrl||asset.sourceUrl||asset.proxyUrl;
  // An import that predates the upgrade pass has no streaming variant yet. Half resolution is the
  // closest substitute; falling straight through to the 1920 full-v3 file would hand a remote viewer
  // a 10-bit stream several times Stream's bitrate, which is the one thing this quality exists to avoid.
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

// Per-frame lookups, rebuilt only when the store replaces the array they index (it never edits one in place).
const idMaps = new WeakMap<object, Map<string, unknown>>();
export function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  let map = idMaps.get(items) as Map<string, T> | undefined;
  if (!map) { map = new Map(items.map(item => [item.id, item])); idMaps.set(items, map); }
  return map;
}
const nodeMaps = new WeakMap<GradeNode[], Map<string, GradeNode[]>>();
function nodesOf(nodes: GradeNode[], clipId: string): GradeNode[] {
  let map = nodeMaps.get(nodes);
  if (!map) { map = new Map(); for (const node of nodes) map.set(node.clipId, [...map.get(node.clipId) ?? [], node]); nodeMaps.set(nodes, map); }
  return map.get(clipId) ?? [];
}
const laneMaps = new WeakMap<Clip[], Map<string, Clip[]>>();
function timelineClips(clips: Clip[], projectId: string, timelineId: string): Clip[] {
  let map = laneMaps.get(clips);
  if (!map) { map = new Map(); laneMaps.set(clips, map); }
  const key = `${projectId}\n${timelineId}`;
  let list = map.get(key);
  if (!list) { list = clips.filter(c => c.projectId === projectId && c.timelineId === timelineId); map.set(key, list); }
  return list;
}
const transitionMaps = new WeakMap<Clip[], Map<string, { media: MediaAsset[]; records: TransitionRecord[] }>>();
function transitionsOf(clips: Clip[], timelineId: string, media: MediaAsset[]): TransitionRecord[] {
  let map = transitionMaps.get(clips);
  if (!map) { map = new Map(); transitionMaps.set(clips, map); }
  let entry = map.get(timelineId);
  if (!entry || entry.media !== media) { entry = { media, records: timelineTransitions(clips, timelineId, media) }; map.set(timelineId, entry); }
  return entry.records;
}

export function playbackLayers(state: Pick<PlaybackState, 'clips' | 'tracks' | 'media' | 'projectId' | 'timelineId' | 'playhead'> & { leaks?: PlaybackState['leaks'] }, fps = 24, records: TransitionRecord[] = []) {
  const tracks = byId(state.tracks), media = byId(state.media);
  const trackOf = (clip: Clip) => { const track = tracks.get(clip.trackId); return track?.timelineId === state.timelineId ? track : undefined; };
  const solo = state.tracks.some(t => t.timelineId === state.timelineId && t.solo && !t.muted);
  const active = timelineClips(state.clips, state.projectId, state.timelineId).flatMap(clip => {
    const span = clipSpan(clip, records);
    // Imported fractional-rate cuts can differ from the frame clock by a few floating-point bits.
    if (!(span.start <= state.playhead + 1e-7 && span.end > state.playhead + 1e-7)) return [];
    return [evaluateClip(extendClip(clip, span.start, span.end - span.start), state.playhead, fps)];
  }).filter(clip=>!clip.disabled);
  return active.flatMap(clip => {
    const track = trackOf(clip), asset = isLeakMedia(clip.mediaId) ? leakAsset(clip, state.leaks) : isAdjustment(clip) ? adjustmentAsset(clip) : isTitle(clip) || isShape(clip) || clip.mediaId==='frameline-composition' ? { id: clip.mediaId, hasAudio:clip.mediaId==='frameline-composition', projectId: clip.projectId, name: clip.name, kind: 'image', binId: '', thumbnail: '', duration: clip.duration, resolution: '', fps: 0, size: '', status: 'ready', progress: 100 } as MediaAsset : media.get(clip.mediaId);
    if (!track || !asset) return [];
    const separateAudio = active.some(other => other.id !== clip.id && trackOf(other)?.kind === 'audio' && other.mediaId === clip.mediaId && other.start === clip.start && other.sourceIn === clip.sourceIn && other.duration === clip.duration);
    return [{ clip, track, asset, visual: track.kind === 'video' && !track.hidden && asset.kind !== 'audio', audible: (asset.kind === 'audio' || !!asset.hasAudio) && !clip.properties.freeze && !track.muted && (!solo || track.solo) && !(track.kind === 'video' && (clip.properties.audioDetached || separateAudio)) }];
  }).sort((a, b) => Number(Boolean(a.track.captionSets))-Number(Boolean(b.track.captionSets)) || a.track.number - b.track.number || a.clip.start - b.clip.start);
}

/** Seconds ahead the decoders for upcoming cuts are opened, playing and paused. */
const WARM_HORIZON = { playing: 4, paused: 2 };
/**
 * Warm streams in all: each is a preload="auto" download, and each MP4 picture holds up to 32 MiB of decoded frames.
 * A sound holds no decoded frames, so efficient mode keeps four: with one, dialogue cuts opened cold and started
 * 0.3–0.7 s late (measured on Part 1 v2 with Performance mode on).
 */
const WARM_CAP = { video: 6, audio: 4 }, EFFICIENT_WARM_CAP = { video: 2, audio: 4 };
/**
 * The upcoming cuts to open now, soonest first: the next two on every visible picture layer and, while playing,
 * on every audible sound layer, up to WARM_CAP. A dense edit cuts every few frames on several layers at once; a
 * single "next three" across the timeline left most layers opening their decoder at the cut itself.
 * `first` (clips in an upcoming transition) sort ahead. Efficient mode, and a stall (the link is already behind),
 * take one per layer.
 */
export function upcomingClips(state: Pick<PlaybackState, 'clips' | 'tracks' | 'media' | 'projectId' | 'timelineId' | 'playhead' | 'playing'>, open: Set<string>, efficient: boolean, first: Set<string> = new Set(), stalled = false): Clip[] {
  const tracks = byId(state.tracks), media = byId(state.media), horizon = state.playing ? WARM_HORIZON.playing : WARM_HORIZON.paused;
  const lanes = new Map<string, Clip[]>();
  // A composition's own cuts are warmed too, timed on this timeline (renderLayers plays them under their own ids):
  // with only the outer timeline looked at, a composition's footage opened cold at its cut and stalled it.
  const visit = (timelineId: string, offset: number, rate: number, from: number, until: number, ancestry: string[]) => {
    for (const nested of timelineClips(state.clips, state.projectId, timelineId)) {
      const track = tracks.get(nested.trackId);
      if (nested.disabled || !track) continue;
      // Outer-timeline span, cut to the composition clip that shows it.
      const natural = offset + nested.start / rate, start = Math.max(from, natural), end = Math.min(until, offset + (nested.start + nested.duration) / rate);
      if (end <= start) continue;
      if (nested.mediaId === 'frameline-composition') {
        const id = String(nested.properties.compositionId ?? ''), speed = Number(nested.properties.speed ?? 100) / 100;
        // ponytail: reversed or frozen compositions are not looked into; they open at the cut as before.
        if (!id || ancestry.includes(id) || ancestry.length >= 32 || track.hidden || nested.properties.reverse || nested.properties.freeze || !(speed > 0)) continue;
        if (start < state.playhead + horizon && end > state.playhead) visit(id, offset + nested.start / rate - nested.sourceIn / (rate * speed), rate * speed, start, end, [...ancestry, timelineId]);
        continue;
      }
      if (open.has(nested.id) || !(start > state.playhead && start - state.playhead < horizon) || !media.has(nested.mediaId)) continue;
      if (track.kind === 'video' ? track.hidden : track.muted || !state.playing) continue;
      // A clip already running when its composition starts is warmed from the source second shown there.
      const skipped = (start - natural) * rate;
      lanes.set(track.id, [...lanes.get(track.id) ?? [], start === nested.start ? nested : { ...nested, start, duration: nested.duration - skipped, sourceIn: nested.sourceIn + skipped * Number(nested.properties.speed ?? 100) / 100 }]);
    }
  };
  visit(state.timelineId, 0, 1, -Infinity, Infinity, []);
  const order = (a: Clip, b: Clip) => Number(first.has(b.id)) - Number(first.has(a.id)) || a.start - b.start;
  const video = (clip: Clip) => tracks.get(clip.trackId)!.kind === 'video';
  const chosen = [...lanes.values()].flatMap(lane => lane.sort((a, b) => a.start - b.start).slice(0, efficient || stalled ? 1 : 2)).sort(order);
  const cap = efficient ? EFFICIENT_WARM_CAP : WARM_CAP;
  return [...chosen.filter(video).slice(0, cap.video), ...chosen.filter(clip => !video(clip)).slice(0, cap.audio)].sort(order);
}

/** Does this clip's picture go through the colour pipeline: a grade, a look, or an input interpretation? */
export function usesColor(clip: Clip, nodes: GradeNode[]): boolean {
  const p = clip.properties;
  return !!p.resolveLookUrl || nodes.some(node => node.enabled) || !!Number(p.inputExposure) || !!Number(p.inputTemperature) || !!p.yuvMatrix || (!!p.dataLevels && p.dataLevels !== 'Auto');
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
  /** Opened on StreamLow by the automatic rule, not asked for by name (an alpha graphic's 1/4 file is also its StreamLow). */
  automaticLow?: boolean;
};

/** The timeline consumes prepared frames; native media remains the audio/compatibility path. */
export function attachPlayback(canvas: HTMLCanvasElement, getState: () => PlaybackState, getOptions: () => PreviewOptions, onStatus: (status: PlaybackStatus) => void, preferLowStream = footageCache.preferLowStream) {
  const output = canvas.getContext('2d', { alpha: false })!;
  const composite = document.createElement('canvas');
  const context = composite.getContext('2d', { alpha: false })!;
  let motion:ReturnType<typeof createMotionPreview>|undefined;
  const timelinePreview=createTimelinePreview(()=>{dirty=true;});
  let expensiveFrames=0, expensiveUntil=-Infinity;
  // A phone always plays smooth; a computer once it has twice running shown it cannot keep up live (for this page's life).
  let slowDevice=false, strikes=0, paceFrom=0, paceCount=0, holdSince:number|undefined;
  const strike=(bad:boolean)=>{if(!bad){strikes=0;return;}if(++strikes>=2)slowDevice=true;};
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
  const leaks = new Map<string, { element: HTMLMediaElement; decoded: boolean; frames?: ReturnType<typeof createVideoFrames>; canvas?: HTMLCanvasElement; source?: MediaElementAudioSourceNode; gain?: GainNode; lastUsed: number }>();
  const decoders = new Map<string, Decoder>();
  // Paused only: 480 px stand-ins (the 1/4 file) while a playback decoder seeks. Dropped the moment playback starts.
  const scrubs = new Map<string, { frames: ReturnType<typeof createScrubFrames>; media: HTMLVideoElement }>();
  let loadingSince: number | undefined;
  const streamFallbacks = new Map<string, string>();
  // Assets the automatic rule moved to their low stream. The address is read from the row each time: the storage migration
  // gives StreamLow a new one, and the old file is deleted.
  const automaticStreams = new Set<string>();
  const selectedUrl = (asset: MediaAsset, options: PreviewOptions, visual: boolean) => {
    const url = playbackUrl(asset, options, visual);
    return url ? streamFallbacks.get(url) ?? (visual&&!options.original&&options.quality==='Stream'&&automaticStreams.has(asset.id)?asset.proxyVariants?.StreamLow:undefined) ?? url : url;
  };
  const groups = new Map<string, { canvas: HTMLCanvasElement; reference: HTMLCanvasElement; audio: AudioRoute }>();
  let color: ReturnType<typeof createColorPreview> | undefined;
  // Read by the playback checks (never by the editor): raw-plane copy timings since the last reset.
  Object.assign(canvas, { colorProbe: (reset?: boolean) => color?.probe(reset) });
  // `master` is the programme (the mix and master gain, as exported, which the meters read); `monitor` is what you hear.
  let audio: AudioContext | undefined, master: GainNode | undefined, monitor: GainNode | undefined, masterAnalyser: AnalyserNode | undefined;
  // BS.1770 meter: per channel, the K-weighted and the plain master, read as new samples arrive (see the meter block in tick).
  let loudnessTaps: { weighted: AnalyserNode; plain: AnalyserNode }[] = [], loudness: ReturnType<typeof loudnessWindow> | undefined, meterAudioTime = 0;
  const meterSamples = new Float32Array(8192);
  let frame = 0, disposed = false, dirty = true, previous: unknown[] = [], statusKey = '', meterTime = 0;
  const flowPreview = createFlowPreview(() => { dirty = true; });
  const maskPreview=createSmartMaskPreview(()=>{dirty=true;}),fittedMasks=new Map<string,SmartMaskPixels>(),maskCuts=new Map<string,HTMLCanvasElement>();
  const flowStatuses = new Map<string,string>();
  const stabilizePreview = createStabilizePreview(() => { dirty = true; });
  const stabilizeStatuses = new Map<string,string>();
  // Noise Reduction: denoised chunks for this viewer; a retry or "Show removed noise" draws again.
  const denoisePreview = createDenoisePreview(() => { dirty = true; });
  const unsubscribeDenoise = subscribeDenoise(() => { dirty = true; });
  // Depth: decoded depth frames for this viewer, its WebGL pass, and a repaint whenever an analysis moves on.
  const depthFrames = createDepthPreview(() => { dirty = true; });
  let depthFx: ReturnType<typeof createDepthFx> | undefined;
  const unsubscribeDepth = subscribeDepth(() => { dirty = true; });
  // Warping the layer in place needs the picture it is about to overwrite; one scratch canvas serves every clip.
  const warpScratch = document.createElement('canvas');
  let stalled = false;
  // Set while the focused clip is drawn: its layer goes on the picture as decoded, with no transform, and its grade
  // animates on the real clip at the real playhead.
  let focusing: { clip: Clip; time: number } | undefined;
  let renderSlot = -1;
  let frameRevision=0;
  let retained: Clip[] | undefined;
  // Keyed by decoder id: a layer whose decoder failed is drawn around, not waited for, until a background reopen succeeds.
  const failures = new Map<string, { count: number; retryAt: number }>();
  /** A decoder in error is skipped; after a pause that grows per failure it is closed so the next tick reopens it. */
  const failedDecoder = (id: string, decoder: Decoder) => {
    if (!decoder.error) return false;
    const now = performance.now(), failure = failures.get(id);
    if (!failure?.retryAt) { const count = (failure?.count ?? 0) + 1; failures.set(id, { count, retryAt: now + Math.min(LAYER_RETRY_MAX_MS, LAYER_RETRY_MS * 2 ** (count - 1)) }); }
    // By identity: an optical-flow decoder stands in for its clip's layer under its own key.
    else if (now >= failure.retryAt) { cleanup(decoder); for (const [key, open] of decoders) if (open === decoder) decoders.delete(key); failure.retryAt = 0; dirty = true; }
    return true;
  };
  // Paused, nothing else wakes the tick when a failed layer's pause runs out.
  const retryDue = () => { const now = performance.now(); for (const failure of failures.values()) if (failure.retryAt && now >= failure.retryAt) return true; return false; };
  // One parsed document per title clip object, so a caption holding its pose repaints its cached composite.
  // A font arriving changes the pictures, so it starts a fresh cache.
  let textDocuments = new WeakMap<Clip, ReturnType<typeof getText>>(), fontsRevision: number | undefined;
  const textOf = (clip: Clip) => { let doc = textDocuments.get(clip); if (!doc) { doc = getText(clip); textDocuments.set(clip, doc); } return doc; };
  const fontsChanged = () => { dirty = true; textDocuments = new WeakMap(); };
  const scopeRequested = () => { dirty = true; };
  window.addEventListener('frameline:request-scope',scopeRequested);
  document.fonts.addEventListener('loadingdone', fontsChanged);
  const status = (value: PlaybackStatus) => { const key = JSON.stringify(value); if (key !== statusKey) { statusKey = key; onStatus(value); } };
  const cleanup = (decoder: Decoder) => {
    decoder.frames?.dispose();
    decoder.element.onload = null; decoder.element.onerror = null;
    if (!decoder.image) { const media = decoder.element as HTMLMediaElement; if (decoder.videoCallback !== undefined) (media as HTMLVideoElement).cancelVideoFrameCallback(decoder.videoCallback); media.pause(); media.removeAttribute('src'); media.load(); }
    decoder.source?.disconnect(); decoder.filters.forEach(node => node.disconnect()); decoder.gain?.disconnect(); decoder.pan?.disconnect(); decoder.analyser?.disconnect();
  };
  const decoderFor = (clip: Clip, asset: MediaAsset, visual: boolean, options: PreviewOptions) => {
    const requestedUrl = playbackUrl(asset, options, visual), low = asset.proxyVariants?.StreamLow, open = decoders.get(clip.id);
    const automatic = visual && !options.original && options.quality === 'Stream' && !!low && !!requestedUrl && low !== requestedUrl && !streamFallbacks.has(requestedUrl);
    // Every picture decoder asks as it opens, never on a throughput sample, and keeps its stream until it closes: no
    // quality change mid-shot; only its own stall moves it (tick). So a clip of a file a sibling already plays on Stream
    // still opens low on a slow line, and the asset is back on Stream at its next decoder once the background fill has
    // saved what that one reads. While nothing measures the line (no answer: cache off, no controlling footage worker, no
    // rate yet) a stall's low stream stands.
    if (automatic && !open) { const slow = preferLowStream(requestedUrl); if (slow) automaticStreams.add(asset.id); else if (slow === false) automaticStreams.delete(asset.id); }
    const url = automatic && (open?.url === requestedUrl || open?.url === low && open.automaticLow) ? open!.url : selectedUrl(asset, options, visual), audioOnly = !visual || asset.kind === 'audio';
    const fallback = !url && visual && asset.thumbnail;
    if (!url && !fallback) return;
      let decoder = decoders.get(clip.id);
      if (decoder && (decoder.url !== (url || fallback) || decoder.audioOnly !== audioOnly)) { cleanup(decoder); decoders.delete(clip.id); decoder = undefined; }
      if (!decoder) {
        const image = asset.kind === 'image' || !!fallback;
        const element = image ? new Image() : document.createElement(audioOnly ? 'audio' : 'video');
        decoder = { url: String(url || fallback), element, image, audioOnly, pending: false, blocked: false, filters: [], lastUsed: performance.now(), automaticLow: automatic && url === low };
        const current = decoder;
        element.crossOrigin = 'anonymous'; element.onerror = () => {
          const stream = byId(getState().media).get(asset.id)?.proxyVariants?.Stream, media = image ? undefined : element as HTMLMediaElement;
          if (media && stream && stream !== current.url && requestedUrl) streamFallbacks.set(requestedUrl, stream);
          // Chrome reports a 404 as MEDIA_ERR_SRC_NOT_SUPPORTED, not a network error; failing before any metadata is a load failure.
          else current.error = media?.error?.code === 2 ? 'download failed' : !media || media.readyState < 1 ? 'could not be loaded' : 'source could not be decoded';
          dirty = true;
        };
        if (image) element.onload = () => { dirty = true; };
        else {
          // Only an MP4 picture is decoded by WebCodecs; anything else (an alpha WebM graphic) is this element's own
          // picture, so it starts loading now rather than at the cut.
          const media = element as HTMLMediaElement; media.preload = visual && !options.original && typeof VideoDecoder !== 'undefined' && typeof Worker !== 'undefined' && /\.mp4(?:\?|$)/i.test(current.url) ? 'none' : 'auto'; media.addEventListener('loadedmetadata', () => { dirty = true; }); media.addEventListener('loadeddata', () => { dirty = true; }); media.addEventListener('seeked', () => { dirty = true; });
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
  const effectKeys = new WeakMap<Clip, string>();
  const connect = (decoder: AudioRoute, clip: Clip, source: () => AudioNode, destination = master as AudioNode | undefined) => {
    if (!audio || !destination) return;
    if (!decoder.source) {
      decoder.source = source();
      decoder.gain = audio.createGain(); decoder.pan = audio.createStereoPanner(); decoder.analyser = audio.createAnalyser();
      decoder.analyser.fftSize = 256; decoder.samples = new Float32Array(256);
      decoder.analyser.connect(decoder.gain).connect(decoder.pan);
    }
    if(decoder.destination!==destination) {decoder.pan!.disconnect();decoder.pan!.connect(destination);decoder.destination=destination;}
    let effectKey = effectKeys.get(clip);
    if (effectKey === undefined) { effectKey = JSON.stringify([clip.effects,Object.fromEntries(Object.entries(clip.properties).filter(([key])=>clip.effects.some(e=>key.startsWith(e.name+'_'))))]); effectKeys.set(clip, effectKey); }
    if (decoder.effectKey === effectKey) return;
    decoder.effectKey = effectKey; decoder.source.disconnect(); decoder.filters.forEach(node => node.disconnect()); decoder.filters = [];
    let end: AudioNode = decoder.source;
    const add = (node: AudioNode) => { end.connect(node); end = node; decoder.filters.push(node); };
    for (const effect of clip.effects.filter(e => effectEnabled(clip,e))) {
      const number = (key: string, fallback: number) => effectValue(clip,effect,key.slice(effect.name.length+1));
      if (effect.name === 'EQ') {
        // The export's exact coefficients (audioDsp.eqBiquads), so what plays is what renders and what the graph draws.
        for (const [b0, b1, b2, a1, a2] of eqBiquads(number('EQ_Low cut', 80), number('EQ_Presence', 2), number('EQ_Air', 1), audio.sampleRate)) add(audio.createIIRFilter([b0, b1, b2], [1, a1, a2]));
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
    if (decoder.pending || decoder.blocked && decoder.audioOnly || !media.paused || media.readyState < 2) return;
    // Autoplay refused without a gesture: the picture keeps moving muted, the sound waits for resume().
    if (decoder.blocked) media.muted = true;
    decoder.pending = true;
    void media.play().catch(error => {
      if (disposed || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') decoder.blocked = true;
      else decoder.error = 'this source could not play';
      dirty = true;
    }).finally(() => { decoder.pending = false; });
  };
  const buffered = (decoder: Decoder, clip: Clip, fps: number, cacheEnabled: boolean) => {
    const media=decoder.element;
    if(decoder.frames&&decoder.frames.cacheEnabled!==cacheEnabled){decoder.frames.dispose();decoder.frames=undefined;}
    if(decoder.frames?.failed){decoder.frames.dispose();decoder.frames=undefined;decoder.framesFailed=true;}
    if (decoder.framesFailed || !(media instanceof HTMLVideoElement) || typeof VideoDecoder==='undefined' || typeof Worker==='undefined' || !/\.mp4(?:\?|$)/i.test(decoder.url) || clip.properties.reverse || clip.properties.freeze || Number(clip.properties.speed??100)>200) return undefined;
    media.pause(); media.preload='none';
    // A graded layer's picture is copied for the colour pipeline as it lands, not at the next tick. Arrival shares aheadCount's time and byte budget
    // (videoFrames.ts), not tick's MAX_AHEAD_COPIES cap; the pictures beyond that are copied by tick.
    return decoder.frames??=createVideoFrames(decoder.url,fps,()=>{dirty=true;},cacheEnabled,frame=>{
      const now=getState(),current=byId(now.clips).get(clip.id)??clip;
      if(now.playing&&color&&usesColor(current,nodesOf(now.nodes,clip.id)))color.prepare(media,frame);
    });
  };
  const draw = (target: CanvasRenderingContext2D, clip: Clip, width: number, height: number, projectWidth: number, projectHeight: number, time: number, fps: number) => {
    const p=clip.properties;
    const poses=transformMotion(clip,time,fps,projectWidth,projectHeight);
    target.save();target.globalAlpha=Math.max(0,Math.min(1,Number(p.opacity??100)/100))*fadeLevel(clip,time);
    // W3C Compositing; the export reproduces each mode in FFmpeg (media.ts blendFilters).
    target.globalCompositeOperation=blendModeOf(p.blendMode)?.canvas??'source-over';
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
    let options = getOptions();
    const project = state.projects.find(p => p.id === state.projectId);
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
    const dependencies = [state.timelineId, state.timelines, state.playhead, state.playing, state.clips, state.tracks, state.media, state.leaks, state.nodes, state.settings, project, options.original, options.quality, options.volume, options.compare, options.fontsRevision, state.focus?.clipId, state.focus?.time];
    if (!dirty && !stalled && !retryDue() && dependencies.every((value, i) => value === previous[i])) return;
    previous = dependencies; dirty = false; renderSlot = slot; forgetDepth();

    const [projectWidth, projectHeight] = projectSize(project?.resolution ?? '1920 × 1080');
    if (retained !== state.clips) {
      retained = state.clips;
      flowPreview.retain(new Set(state.clips.filter(c=>c.properties.opticalFlow&&!c.disabled).map(c=>c.id)));
      stabilizePreview.retain(new Set(state.clips.filter(c=>stabilizeEffect(c)&&!c.disabled).map(c=>c.id)));
      denoisePreview.retain(new Set(state.clips.filter(c=>denoiseEffect(c)&&!c.disabled).map(c=>c.id)));
    }
    if (options.fontsRevision !== fontsRevision) { fontsRevision = options.fontsRevision; textDocuments = new WeakMap(); }
    const divisor = options.quality === '1/4' ? 4 : options.quality === '1/2' || options.quality === 'Stream' ? 2 : 1;
    const focusedClip = state.focus ? [byId(state.clips).get(state.focus.clipId)].find(c => c && c.projectId === state.projectId && c.timelineId === state.timelineId) : undefined;
    const focusedAsset = focusedClip && [byId(state.media).get(focusedClip.mediaId)].find(m => m?.kind === 'video');
    const focusedTrack = focusedClip && byId(state.tracks).get(focusedClip.trackId);
    const focused = focusedClip && focusedAsset && focusedTrack ? { clip: focusedClip, asset: focusedAsset, track: focusedTrack } : undefined;
    // The ungraded split compares timeline pictures; a lone source picture has nothing to split against.
    if (focused && options.compare) options = { ...options, compare: false };
    // A frame editor draws in source pixels, so the picture takes the source's shape instead of the sequence's.
    const [frameWidth, frameHeight] = focused ? sourceSize(focused.asset) : [projectWidth, projectHeight];
    // Browser proxy preview is capped at 1920px; original-media exports retain the chosen resolution. A phone shows the
    // picture a few hundred points wide: 640 px on the long side is sharp there, and every composite, grade and
    // server-rendered chunk costs under half of Stream's 960.
    const ratio = Math.min(1 / divisor, isPhone() ? PHONE_PREVIEW_EDGE / Math.max(frameWidth, frameHeight) : 1920 / frameWidth);
    const width = Math.max(2, Math.round(frameWidth * ratio)), height = Math.max(2, Math.round(frameHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = composite.width = layer.width = reference.width = blend.width = width; canvas.height = composite.height = layer.height = reference.height = blend.height = height; }
    context.fillStyle = '#000'; context.fillRect(0, 0, width, height); referenceContext.clearRect(0, 0, width, height);
    const seeks: [HTMLMediaElement, number][] = [];
    const activeIds = new Set<string>(), warmIds = new Set<string>(), activeGroups = new Set<string>(), trackLevels: Record<string, number> = {};
    let sourceClip = '', sourceTimestamp = '', engine = ''; let decodedAhead = Infinity;
    // One `clip@time` per layer that shows footage (nested compositions included). sourceClip/sourceTimestamp name only the
    // layer drawn last, which a logo or title on top pins; the picture counters read this instead.
    const pictureStamps: string[] = [];
    let missing = false, loading = false, picture = false, warning = '', autoplayBlocked = false;
    // Playing, a graded layer copies the raw planes of the next pictures (0.25 s of display) ahead of the clock, so the copy is done
    // when the picture is drawn; at most MAX_AHEAD_COPIES new ones a tick across all layers. The next three always are, as before.
    let aheadCopies = 0;
    const deepFor = (clip: Clip) => state.playing && !!color && usesColor(clip, nodesOf(state.nodes, clip.id));
    const prepareColor = (media: HTMLVideoElement, list: VideoFrame[]) => {
      for (const [index, frame] of list.entries()) {
        const ahead = index >= NEAR_PICTURES;
        if (ahead && aheadCopies >= MAX_AHEAD_COPIES) break;
        if (color?.prepare(media, frame) && ahead) aheadCopies++;
      }
    };
    // Layers drawn around this frame because they failed, by decoder or transition: the rest of the picture and
    // the sound carry on, and the viewer names them with a Retry instead of stopping the playhead.
    const skipped = new Map<string, string>();
    const scrubIds = new Set<string>();
    /**
     * While paused, the 480 px stream-low-v2 (the asset's 1/4) stands in for a playback decoder that is still
     * seeking: full-v3 and Stream decode a GOP of 1920 or 960 frames first. Opened for every visible clip so a
     * scrub answers on its first move, but asked for a frame only on a miss; each ask decodes one small GOP.
     * Only for files from the same pass, all BT.709 video range; camera originals are interpreted differently,
     * and Color keeps its 10-bit picture (and precision label) rather than flash 8-bit stand-ins.
     */
    const scrubFor = (clip: Clip, asset: MediaAsset, decoder: Decoder) => {
      const url = asset.proxyVariants?.['1/4'];
      // The scrub worker demuxes MP4 only; an alpha WebM seeks through its video element instead.
      if (url && !/\.mp4(?:\?|$)/i.test(url)) return undefined;
      // A frame editor loops one clip: each lap starts with a backward seek, which the stand-in covers while playing too.
      if (state.playing && !focusing || !url || options.quality === 'Color' || decoder.url === url || (decoder.url !== asset.proxyUrl && !Object.values(asset.proxyVariants ?? {}).includes(decoder.url)) || typeof VideoDecoder === 'undefined' || typeof Worker === 'undefined') return undefined;
      // Keyed by file: pictures are source frames, so every cut from one take shares a decoder.
      // A graded clip reads each picture back through the colour pipeline; start that copy as it lands.
      const scrub = scrubs.get(url) ?? { media: decoder.element as HTMLVideoElement, frames: createScrubFrames(url, asset.fps || 24, frame => { dirty = true; if (frame && color) color.prepare(scrub.media, frame); }, state.settings.footageCache !== false) };
      // Follow the clip on screen now; a shared file must not pin an element from an earlier cut.
      scrub.media = decoder.element as HTMLVideoElement;
      scrubs.delete(url); scrubs.set(url, scrub);
      scrubIds.add(url);
      return scrub.frames;
    };
    if (master && monitor && audio) { master.gain.setTargetAtTime(state.settings.masterMuted ? 0 : 10 ** (Number(state.settings.masterGain ?? 0) / 20), audio.currentTime, .015); monitor.gain.setTargetAtTime(state.settings.monitorAudio === false ? 0 : options.volume / 100, audio.currentTime, .015); }
    const updateAudio = (route:AudioRoute,clip:Clip,track:Track,time:number,audible:boolean) => {
      if(!audio||!route.gain||!route.pan||!route.analyser||!route.samples)return;
      route.analyser.getFloatTimeDomainData(route.samples);
      const rms=Math.sqrt(route.samples.reduce((sum,value)=>sum+value*value,0)/route.samples.length);
      // Normalize loudness: the source's measured loudness brought to the target. The export measures the clip itself.
      const loudness=clip.properties.normalize?(byId(state.media).get(clip.mediaId) as MediaAsset&{loudness?:number}|undefined)?.loudness:undefined;
      let gain=audible?10**((track.gain+Number(clip.properties.gain??0)+(loudness===undefined?0:loudnessTarget(clip)-loudness))/20)*fadeLevel(clip,time,true):0;
      const noises=clip.effects.filter(e=>e.name==='Audio Noise Reduction'&&effectEnabled(clip,e));
      for(const noise of noises){
        // ponytail: realtime noise gate; FFmpeg uses spectral denoising for final exports.
        if(rms<10**((-70+effectValue(clip,noise,'Sensitivity')*.5)/20))gain*=1-effectValue(clip,noise,'Reduction')/100;
      }
      route.gain.gain.setTargetAtTime(gain,audio.currentTime,noises.length?.005+Math.max(...noises.map(n=>effectValue(clip,n,'Smoothing')))/1000:.015);
      route.pan.pan.setTargetAtTime(Math.max(-1,Math.min(1,(track.pan+Number(clip.properties.pan??0))/100)),audio.currentTime,.015);
      trackLevels[track.id]=Math.max(trackLevels[track.id]||0,rms*gain);
    };
    /**
     * A light leak's picture is decoded by WebCodecs, as clips are; the element only plays its sound. Drawing a fresh
     * <video> onto a canvas blocks Safari for a whole second until its first frame, at every leak.
     */
    const leakEntry = (record:TransitionRecord) => {
      const id=String(record.params.leak??''),leak=state.leaks?.find(item=>item.id===id);
      if(!id||!leak)return null;
      let entry=leaks.get(id);
      if(!entry) {
        const decoded=typeof VideoDecoder!=='undefined'&&typeof Worker!=='undefined';
        const element=document.createElement(decoded?'audio':'video');
        element.preload='auto';element.muted=true;element.src=leak.url;
        if(element instanceof HTMLVideoElement)element.playsInline=true;
        element.addEventListener('loadeddata',()=>{dirty=true;});
        element.addEventListener('seeked',()=>{dirty=true;});
        entry={element,decoded,lastUsed:0};leaks.set(id,entry);
      }
      entry.lastUsed=performance.now();
      // The picture decoder opens on the first picture asked for: smooth playback only plays a leak's sound.
      const frames=()=>entry.decoded?entry.frames??=createVideoFrames(leak.url,leak.fps||30,()=>{dirty=true;}):undefined;
      return {entry,leak,frames,range:leakRange(record.params,leak.duration||record.duration)};
    };
    /**
     * The overlay picture for a light-leak transition. Its sound rides the master bus, so a
     * muted master silences it, and expanding the sound to a track mutes this copy instead.
     */
    const leakFrame = (record:TransitionRecord,raw:number,_time:number,wantAudio:boolean,picture=true):CanvasImageSource|null => {
      const found=leakEntry(record);
      if(!found)return null;
      const {entry,leak,range}=found,element=entry.element;
      const wanted=Math.max(range.start,Math.min(range.end-1e-3,range.start+raw*range.duration));
      const silent=!!record.audioClipId||!wantAudio||!leak.hasAudio;
      const level=silent?0:10**(Math.max(-60,Math.min(12,Number(record.params.leakGain??-6)))/20);
      if(audio&&!entry.source&&leak.hasAudio) {
        try { entry.source=audio.createMediaElementSource(element);entry.gain=audio.createGain();entry.source.connect(entry.gain);entry.gain.connect(master!); }
        catch { /* An element accepts only one media source node; keep the muted copy. */ }
      }
      if(audio&&entry.gain)entry.gain.gain.setTargetAtTime(level,audio.currentTime,.02);
      element.muted=!entry.gain;
      const follow=()=>{
        element.playbackRate=Math.max(.0625,Math.min(16,range.duration/record.duration));
        if(state.playing&&element.currentTime<range.end&&element.paused)void element.play().catch(()=>{/* Autoplay needs a gesture. */});
        else if((!state.playing||element.currentTime>=range.end)&&!element.paused)element.pause();
        if(!element.seeking&&(element.currentTime<range.start||element.currentTime>=range.end||Math.abs(element.currentTime-wanted)>(state.playing?.3:.02)))element.currentTime=wanted;
      };
      if(!picture){if(silent){if(!element.paused)element.pause();}else if(element.readyState>=2)follow();return null;}
      const frames=found.frames();
      if(frames&&!frames.failed){
        // The sound never holds the picture: it joins when it is ready.
        if(silent){if(!element.paused)element.pause();}else if(element.readyState>=2)follow();
        frames.update(wanted);
        // A file's first picture can start a frame in and its last end early: there the overlay is left out, never waited for.
        const frame=frames.frame(wanted)??frames.frame(wanted+1/(leak.fps||30));
        if(!frame){if(!frames.ahead&&!frames.ended)loading=true;return null;}
        // Safari ignores the blend mode when it draws a VideoFrame (Screen comes out as Normal): the transition gets a canvas.
        const scale=Math.min(1,width/frame.displayWidth),w=Math.max(1,Math.round(frame.displayWidth*scale)),h=Math.max(1,Math.round(frame.displayHeight*scale));
        const copy=entry.canvas??=document.createElement('canvas');
        if(copy.width!==w||copy.height!==h){copy.width=w;copy.height=h;}
        copy.getContext('2d')!.drawImage(frame,0,0,w,h);
        return copy;
      }
      if(!(element instanceof HTMLVideoElement))return null;
      if(element.readyState<2){loading=true;return null;}
      follow();
      if(element.seeking){loading=true;return null;}
      return element;
    };
    const renderLayers = (timelineId:string,time:number,target:CanvasRenderingContext2D,referenceTarget:CanvasRenderingContext2D,show=true,hear=true,destination:AudioNode|undefined=master,rate=1,ancestry:string[]=[]):void => {
    if(ancestry.includes(timelineId)||ancestry.length>=32){skipped.set(`nesting:${timelineId}`,'Composition nesting contains a cycle or exceeds 32 levels.');return;}
    const records=transitionsOf(state.clips,timelineId,state.media).filter(record=>transitionProgress(record,time));
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
        } catch(cause) { skipped.set(recordKey(record),`${record.name} transition: ${cause instanceof Error?cause.message:'could not be drawn'}`); }
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
      const original=syncClip(byId(state.clips).get(clip.id),clip);
      if (!visual && (!audible || !state.playing)) continue;
      if(clip.mediaId==='frameline-composition') {
        activeGroups.add(clip.id);
        let group=groups.get(clip.id);
        if(!group){group={canvas:document.createElement('canvas'),reference:document.createElement('canvas'),audio:{filters:[]}};groups.set(clip.id,group);}
        if(group.canvas.width!==width||group.canvas.height!==height){group.canvas.width=group.reference.width=width;group.canvas.height=group.reference.height=height;}
        const groupContext=group.canvas.getContext('2d')!,groupReference=group.reference.getContext('2d')!;
        groupContext.clearRect(0,0,width,height);groupReference.clearRect(0,0,width,height);
        const compositionId=String(clip.properties.compositionId??''),nested=state.timelines?.find(t=>t.id===compositionId);
        if(!compositionId||state.timelines&&!nested){skipped.set(clip.id,`${clip.name}: composition timeline is missing`);continue;}
        connect(group.audio,clip,()=>audio!.createGain(),destination);
        updateAudio(group.audio,clip,track,time,audible&&state.playing);
        const nestedTime=sourceTime(original,time,project?.fps||24,nested?.duration??Infinity);
        renderLayers(compositionId,nestedTime,groupContext,groupReference,visual,audible,group.audio.source,rate*(clip.properties.freeze?0:clip.properties.reverse?-1:1)*Number(clip.properties.speed??100)/100,[...ancestry,timelineId]);
        if(!visual)continue;
        layerContext.clearRect(0,0,width,height);layerContext.drawImage(group.reference,0,0);
        if(options.compare)draw(referenceTarget,clip,width,height,projectWidth,projectHeight,time,project?.fps??24);
        layerContext.clearRect(0,0,width,height);layerContext.drawImage(group.canvas,0,0);
        beginSide();finishLayer(clip,asset,time,layerTarget,undefined);
        continue;
      }
      if(isAdjustment(clip)) {
        if(!visual)continue;
        // Everything below is already in `target`: that composite is this layer's picture. A transition side still
        // reads it, so an adjustment dissolving in or out fades its look, as Premiere's does.
        if(options.compare){layerContext.clearRect(0,0,width,height);layerContext.drawImage(referenceTarget.canvas,0,0);draw(referenceTarget,clip,width,height,projectWidth,projectHeight,time,project?.fps??24);}
        layerContext.clearRect(0,0,width,height);layerContext.drawImage(target.canvas,0,0);
        picture=true;beginSide();finishLayer(clip,asset,time,layerTarget,undefined);continue;
      }
      if(isTitle(clip)||isShape(clip)) {
        if(!visual)continue;
        layerContext.clearRect(0,0,width,height);
        const artwork=transformMotion(clip,time,project?.fps??24,projectWidth,projectHeight).length>1?motionArtwork(clip):clip;
        if(isTitle(clip))drawText(layerContext,textOf(artwork),width,height,projectWidth,projectHeight,sourceTime(original,time,project?.fps||24),clip.properties.animationTypingCount as number | undefined,!state.playing||(efficient?false:'live'));
        else drawShape(layerContext,getShape(artwork),width,height,projectWidth,projectHeight);
        if(options.compare)draw(referenceTarget,clip,width,height,projectWidth,projectHeight,time,project?.fps??24);
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
      // Under optical flow that picture is the interpolated one, warped by the matrices around its source time.
      const stabilizeFx = visual && asset.kind === 'video' ? stabilizeEffect(original) : undefined;
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
      // Noise Reduction: the server's denoised chunk of source frames stands in for the proxy once its decoder has this
      // picture, through the same decode path, so speed, reverse, freeze, WebCodecs, Stabilize, masks, Depth and the grade
      // read it as they read the proxy. Its media time 0 is source second `from`. Optical flow wins (denoisePreview).
      const denoiseFx = visual && asset.kind === 'video' ? denoiseEffect(original) : undefined;
      let denoised: { decoder: Decoder; id: string; asset: MediaAsset; clip: Clip; from: number; noise: boolean } | undefined;
      if (denoiseFx) {
        const at = sourceTime(original, time, sourceFps, asset.duration || Infinity), shownAt = state.playing ? at : Math.max(at, Math.min((asset.duration || Infinity) - 1 / sourceFps, shownSourceTime(original, time, at, project?.fps || 24, sourceFps)));
        const noise = noiseUi.showRemoved(denoiseFx.id), speed = rate * Number(clip.properties.speed ?? 100) / 100;
        // The clip's last shown source time in playing order (its out point, or its in point reversed): nothing past it is prepared.
        const endAt = sourceTime(original, original.start + original.duration - 1e-6, sourceFps, asset.duration || Infinity);
        const chunk = denoisePreview.get(original, asset, shownAt, options.original ? 'Original' : options.quality, noise ? 'noise' : 'denoised', endAt), status = denoiseStatus(clip.id);
        if (status && (status.status !== 'ready' || !warning)) warning = `Noise Reduction · ${denoiseStatusText(status)}`;
        const open = (record: DenoisePreview | undefined) => {
          if (record?.status !== 'ready' || !record.url) return undefined;
          // Its own asset id: a chunk that fails to load fails (failedDecoder) and the clip's proxy plays, rather than the
          // decoder's error fallback swapping in the original's Stream proxy at the chunk's clock (the wrong part of the take).
          const id = `${clip.id}:nr:${record.key}`, chunkAsset: MediaAsset = { ...asset, id: `${asset.id}:nr:${record.key}`, hasAudio: false, colorProxyUrl: record.url, sourceUrl: record.url, proxyUrl: record.url, proxyVariants: {}, duration: record.duration, fps: record.fps };
          const decoder = decoderFor({ ...clip, id }, chunkAsset, true, options);
          // First failure of this chunk (the server restarted and forgot it, or trimmed it): ask the server again. It
          // re-registers a file it still has, or prepares it again; failedDecoder's backoff then reopens the decoder.
          if (decoder?.error && !failures.has(id)) denoisePreview.forget(record.key);
          if (!decoder || failedDecoder(id, decoder)) return undefined;
          const frames = rate > 0 && speed <= 2 ? buffered(decoder, clip, asset.fps || 24, state.settings.footageCache !== false) : undefined;
          // Natively decoded (reverse, freeze, over 2x, WebCodecs failed): nothing else loads a preload='none' element.
          if (!frames) (decoder.element as HTMLMediaElement).preload = 'auto';
          return { decoder, id, asset: chunkAsset, clip: { ...original, sourceIn: original.sourceIn - record.from }, from: record.from, frames };
        };
        const current = open(chunk);
        if (current) {
          activeIds.add(current.id);
          // The proxy plays on until the chunk's decoder has this picture, so a chunk arriving never stalls the viewer.
          const local = Math.max(0, shownAt - current.from), media = current.decoder.element as HTMLVideoElement; current.frames?.update(local);
          // ponytail: decoded natively (reverse, over 2x, no WebCodecs) a forward audible clip keeps the proxy, which carries its sound.
          // Native: ready once it has a picture, and through its own seeks (Chrome drops readyState to 1 while seeking).
          if (current.frames ? current.frames.frame(local) : (media.readyState >= 2 || media.seeking) && (!audible || clip.properties.reverse)) {
            // A native chunk not at this picture (warmed at 0, or left elsewhere) seeks now. `seeking` is then true, so the main
            // path holds the layer's last frame instead of drawing this one. Its tolerance playing is the main path's own.
            if (!current.frames && !media.seeking && (state.playing ? Math.abs(media.currentTime - local) > .45 : Math.floor(media.currentTime * sourceFps + 1e-6) !== Math.floor(local * sourceFps + 1e-6))) media.currentTime = (Math.floor(local * sourceFps + 1e-6) + .5) / sourceFps;
            denoised = { ...current, noise };
          }
        }
        // Playing, the next chunk's decoder opens early, as the next cut's does, so a chunk boundary never waits.
        const upcoming = state.playing && denoised ? open(denoisePreview.next(clip.id)) : undefined;
        if (upcoming) { warmIds.add(upcoming.id); upcoming.frames?.update(0); }
        // Until the next chunk is open, the proxy follows the clock through the chunk's last second, so a late chunk falls back
        // to a warm proxy at the boundary instead of a stale or evicted one.
        else if (denoised && state.playing && rate > 0 && !clip.properties.reverse && !clip.properties.freeze && endAt > denoised.from + denoised.asset.duration && shownAt - denoised.from > denoised.asset.duration - 1) {
          const proxy = decoderFor(clip, asset, true, options);
          if (proxy && !proxy.error) {
            warmIds.add(clip.id);
            const frames = speed <= 2 ? buffered(proxy, clip, asset.fps || 24, state.settings.footageCache !== false) : undefined;
            if (frames) frames.update(at);
            else { const element = proxy.element as HTMLVideoElement; element.preload = 'auto'; if (element.readyState >= 1 && !element.seeking && Math.abs(element.currentTime - at) > .25) seeks.push([element, at]); }
          }
        }
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
      const decoderId=denoised?.id??(!visual&&asset.kind==='video'?`${clip.id}:audio`:clip.id);
      const decoder = flowReady && !audible ? interpolated : denoised?.decoder ?? decoderFor(decoderId===clip.id?clip:{...clip,id:decoderId}, asset, visual && !flowReady, options);
      // The picture's own media and clock: a denoised chunk's, or the clip's. Sound always plays the clip's source.
      const pictureAsset = denoised?.asset ?? asset, pictureClip = denoised?.clip ?? original, offset = denoised?.from ?? 0;
      if (!decoder) continue;
      if(decoder!==interpolated)activeIds.add(decoderId);
      if (failedDecoder(decoderId, decoder)) { skipped.set(decoderId, `${clip.name} (${decoder.error})`); footageCache.setDecoderStatus(clip.id, decoder.url, `${asset.name}: ${decoder.error}`, true); continue; }
      // Reopened after a failure: drawn around until it has a picture, never waited for.
      const retrying = failures.has(decoderId), holdLayer = () => { if (retrying) skipped.set(decoderId, `${clip.name} (reconnecting)`); else loading = true; };
      const frames=visual&&!flowReady&&rate>0&&rate*Number(clip.properties.speed??100)/100<=2?buffered(decoder,clip,asset.fps||24,state.settings.footageCache!==false):undefined;
      if(!frames&&decoder.frames){decoder.frames.dispose();decoder.frames=undefined;}
      let queuedFrame:VideoFrame|undefined;
      if(frames){
        const media=decoder.element as HTMLVideoElement,sourceEnd=Number.isFinite(media.duration)?media.duration:pictureAsset.duration||Infinity,targetTime=sourceTime(pictureClip,time,asset.fps||24,sourceEnd);
        // Paused, show the frame the export delivers here (they differ when the rates do: 59.94 fps on a 30 fps
        // timeline); playing, the picture keeps the clock's own frame so nothing about playback changes.
        const pictureTime=state.playing||focusing?targetTime:Math.max(targetTime,Math.min(sourceEnd-1/(asset.fps||24),shownSourceTime(pictureClip,time,targetTime,project?.fps||24,asset.fps||24)));
        if(decoder.gain&&audio)decoder.gain.gain.setValueAtTime(0,audio.currentTime);
        media.muted=true;
        const scrub=scrubFor(clip,asset,decoder);
        frames.update(pictureTime);queuedFrame=frames.frame(pictureTime)??scrub?.frame(pictureTime);engine='webcodecs';decodedAhead=Math.min(decodedAhead,frames.ahead);
        // Picture decodes ahead; sound stays on the timeline clock and must never leak during pre-roll.
        if(audible){
          const soundId=`${clip.id}:audio`,sound=decoderFor({...clip,id:soundId},asset,false,options);
          if(sound)activeIds.add(soundId);
          if(sound&&failedDecoder(soundId,sound))skipped.set(soundId,`${clip.name} sound (${sound.error})`);
          else if(sound){
            const element=sound.element as HTMLMediaElement;
            const running=state.playing&&!stalled;
            if(!running)element.pause();
            if(element.readyState>=1&&!element.seeking&&Math.abs(element.currentTime-targetTime-offset)>(running?.12:1/(asset.fps||24)))seeks.push([element,targetTime+offset]);
            element.playbackRate=Math.max(.0625,Math.min(8,rate*Number(clip.properties.speed??100)/100));
            connect(sound,clip,()=>audio!.createMediaElementSource(element),destination);updateAudio(sound,clip,track,time,running);element.muted=!sound.gain||sound.blocked;
            if(running)play(sound);
            if(sound.blocked)autoplayBlocked=true;
            if(element.readyState>=2)failures.delete(soundId);
          }
        }
        prepareColor(media,frames.prepare(pictureTime,Math.max(.001,rate*Number(clip.properties.speed??100)/100)/previewFps,deepFor(clip)));
        if(!queuedFrame){
          decoder.waitingSince??=performance.now();
          // Only a link too slow for the file is a reason for the smaller one (preferLowStream knows the line and what is
          // saved). A slow decode, or a cold start on a fast line, would trade quality for nothing: that wait used to drop
          // any not-yet-cached clip to the low stream. While nothing measures the line (no answer: cache off, no controlling
          // footage worker, no rate yet) the wait is the signal.
          if(options.quality==='Stream'&&!options.original&&performance.now()-decoder.waitingSince>1200&&pictureAsset.proxyVariants?.StreamLow&&decoder.url!==pictureAsset.proxyVariants.StreamLow&&preferLowStream(decoder.url)!==false){automaticStreams.add(asset.id);cleanup(decoder);decoders.delete(decoderId);dirty=true;holdLayer();continue;}
          // Failed codecs switch through buffered() immediately. A network timeout remains visible.
          if(performance.now()-decoder.waitingSince>30000){decoder.framesFailed=true;frames.dispose();decoder.frames=undefined;dirty=true;}
          holdLayer();footageCache.setDecoderStatus(clip.id,decoder.url,`${asset.name} · ${frames.ahead?'Decoding requested frame':'Buffering video'}`);continue;
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
          const stream = pictureAsset.proxyVariants?.Stream, requested = playbackUrl(pictureAsset, options, visual);
          if (waited > 8000 && stream && stream !== decoder.url && requested) { streamFallbacks.set(requested, stream); dirty = true; }
          if (waited > 30000) { decoder.error = 'playback stalled'; dirty = true; }
          footageCache.setDecoderStatus(clip.id, decoder.url, `${asset.name} · ${media.seeking ? 'Seeking frame' : media.readyState < 1 ? 'Loading media metadata' : 'Buffering / decoding frame'}`);
        } else { decoder.waitingSince = undefined; footageCache.setDecoderStatus(clip.id, decoder.url); }
      }
      if (!decoder.image && decoder!==interpolated && !frames) {
        const media = decoder.element as HTMLMediaElement;
        const fps = asset.fps || project?.fps || 24;
        const sourceEnd = Number.isFinite(media.duration) ? media.duration : pictureAsset.duration || Infinity;
        const targetTime = sourceTime(pictureClip, time, fps, sourceEnd);
        const speed = rate * Number(clip.properties.speed ?? 100) / 100;
        const normalPlayback = state.playing && !stalled && !clip.properties.reverse && !clip.properties.freeze && speed >= .0625 && speed <= 8;
        // Paused, the frame the export delivers here; see the WebCodecs path above.
        const pictureTime = normalPlayback || focusing ? targetTime : Math.max(targetTime, Math.min(sourceEnd - 1 / fps, shownSourceTime(pictureClip, time, targetTime, project?.fps || 24, fps)));
        if (!normalPlayback) media.pause();
        // Paint the completed seek before starting the newest request; never queue stale pointer positions.
        const drift = media.readyState >= 1 ? media.currentTime - targetTime : 0;
        if (media.readyState >= 1 && !media.seeking && (normalPlayback ? Math.abs(drift)>.45 : Math.floor(media.currentTime*fps+1e-6)!==Math.floor(pictureTime*fps+1e-6))) seeks.push([media, Math.min(Number.isFinite(media.duration)?Math.max(0,media.duration-.001):Infinity,(Math.floor(pictureTime*fps+1e-6)+.5)/fps)]);
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
        media.muted=!decoder.gain||decoder.blocked;
        if (normalPlayback) play(decoder);
        if (decoder.blocked && audible) autoplayBlocked = true;
        if (audible && clip.properties.reverse) warning = 'Reverse video preview · reversed audio is included in export.';
        else if (audible && (speed < .25 || speed > 4)) warning = 'Extreme-speed preview may mute audio · export retains retimed audio.';
        const scrub = visual && !flowReady ? scrubFor(clip, asset, decoder) : undefined;
        const standIn = media.readyState < 2 || media.seeking ? scrub?.frame(pictureTime) : undefined;
        if (standIn) queuedFrame = standIn;
        else if (media.readyState < 2 || media.seeking) {
          // A transition side that already holds a frame is not worth stalling the whole output
          // for; the composite reuses it and playback stays smooth through the window.
          const stale = participationSides && (participation!.role === 'outgoing' ? participationSides.hasOut : participationSides.hasIn);
          if (visual && !stale && !flowReady) holdLayer();
          if(!flowReady)continue;
        }
      } else if (decoder.image && (!(decoder.element as HTMLImageElement).complete || !(decoder.element as HTMLImageElement).naturalWidth)) { holdLayer(); footageCache.setDecoderStatus(clip.id, decoder.url, `${asset.name} · Loading image`); continue; }
      else if (decoder.image) footageCache.setDecoderStatus(clip.id, decoder.url);
      failures.delete(decoderId);
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
      sourceTimestamp = String(offset+(queuedFrame?queuedFrame.timestamp/1e6:element instanceof HTMLVideoElement ? Math.floor(element.currentTime * (asset.fps || 24) + 1e-6) / (asset.fps || 24) : 0));
      const sourceWidth = queuedFrame?.displayWidth ?? (element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth);
      const sourceHeight = queuedFrame?.displayHeight ?? (element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight);
      if (!sourceWidth || !sourceHeight) continue;
      const stampAt = queuedFrame || element instanceof HTMLVideoElement ? pictureStamps.push(`${clip.id}@${sourceTimestamp}`) - 1 : -1;
      layerContext.clearRect(0, 0, width, height);
      const fit = Math.min(width / sourceWidth, height / sourceHeight);
      layerContext.drawImage(queuedFrame??element, (width - sourceWidth * fit) / 2, (height - sourceHeight * fit) / 2, sourceWidth * fit, sourceHeight * fit);
      // The export flips after grade, masks, stabilize and effects (all in source orientation) and before crop and zoom.
      const flip = Boolean(clip.properties.flipH);
      if (options.compare) { if (flip) mirrorLayer(); draw(referenceTarget, clip, width, height, projectWidth, projectHeight, time, project?.fps ?? 24); if (flip) mirrorLayer(); }
      // While the analysis runs, hold the original at the crop the solve will apply so the framing never jumps.
      const framed = stabilizeFx && !stabilizeSolveFor ? {...clip, properties:{...clip.properties, zoom: Number(clip.properties.zoom ?? 100) * stabilizeZoom(stabilizeSettings(original, stabilizeFx))}} : clip;
      const warp = stabilizeSolveFor ? {solve:stabilizeSolveFor,time:sourceTime(original,time,sourceFps,asset.duration||Infinity),sourceWidth,sourceHeight,blend:decoder===interpolated} : undefined;
      beginSide();finishLayer(framed,asset,time,layerTarget,element instanceof HTMLVideoElement?element:undefined,warp,queuedFrame,flip,stampAt,denoised);
    }
    flush(Infinity);
    // Without the picture (smooth playback shows the server's render) a light leak's own sound still plays.
    if(!show&&hear&&state.playing)for(const record of records)if(transitionDefinitions[record.name]?.overlay){const progress=transitionProgress(record,time);if(progress)leakFrame(record,progress.raw,time,true,false);}
    };
    type LayerWarp = { solve:StabilizeSolve; time:number; sourceWidth:number; sourceHeight:number; blend:boolean };
    /** The stabilize warp in this layer's pixels. Picture and matte take the same one, which is what puts the
     *  matte on the stabilized frame instead of the original framing. */
    const warpTransform = (warp:LayerWarp) => stabilizeLayerTransform(warp.solve,warp.time,width,height,warp.sourceWidth,warp.sourceHeight,warp.blend);
    const mirrorLayer = () => { layerContext.save(); layerContext.setTransform(-1, 0, 0, 1, width, 0); layerContext.globalCompositeOperation = 'copy'; layerContext.drawImage(layer, 0, 0); layerContext.restore(); };
    /** `denoised`: the picture is a Noise Reduction chunk whose media time 0 is source second `from`; `noise` (Show removed
     *  noise) draws it as decoded, with no grade or effects. */
    const finishLayer = (clip:Clip,asset:MediaAsset,time:number,target:CanvasRenderingContext2D,element?:HTMLVideoElement,warp?:LayerWarp,snapshot?:VideoFrame,flip=false,stampAt=-1,denoised?:{from:number;noise:boolean}) => {
      let masks=new Map<string,SmartMaskPixels>();
      const offset=denoised?.from??0;
      try {
        const nodes = evaluateNodes(nodesOf(state.nodes, clip.id),focusing?.clip??clip,focusing?.time??time).filter(node=>node.enabled);
        const maskCount=activeSmartMasks(clip,nodes).length,depthKeys=activeDepthKeys(clip,nodes);
        if(maskCount&&clip.properties.opticalFlow)throw Error('Smart Mask and optical-flow retiming need a shared warped matte. Disable optical flow for this clip.');
        if(depthKeys.length&&clip.properties.opticalFlow)throw Error('A depth key cannot follow optical-flow retiming yet. Disable optical flow for this clip.');
        /** Source-box alpha letterboxed onto the layer, as the source RGB is; one entry per frame, matte and layer size. */
        const fit=(matte:SmartMaskPixels,sourceWidth:number,sourceHeight:number)=>{
          const key=`${matte.key}:${width}:${height}:${sourceWidth}:${sourceHeight}`;
          let fitted=fittedMasks.get(key);if(!fitted){while(fittedMasks.size>=24)fittedMasks.delete(fittedMasks.keys().next().value!);fitted={width,height,key,data:fittedSmartMask(matte,width,height,sourceWidth,sourceHeight)};fittedMasks.set(key,fitted);}
          return fitted;
        };
        const loadMasks=(sampleTime:number)=>{
          masks=new Map<string,SmartMaskPixels>();
          for(const [id,mask] of maskPreview.read(clip,nodes,sampleTime,asset)){
            // Only a WebGL node mask needs layer-fitted pixels; the clip effect composites the matte canvas directly.
            if(!nodes.some(n=>nodeMaskId(n)===id&&n.mask!.enabled)){masks.set(id,mask);continue;}
            // A node limited to a subject that is not found yet grades nothing (or everything, inverted), never the whole frame.
            if(mask===unanalyzedSmartMask)warning='Smart Mask · not analyzed here yet · masked grade is off';
            const matte=mask===unanalyzedSmartMask?{...mask,data:new Uint8Array([0])}:mask;
            const doc=clip.smartMasks!.find(m=>m.id===id)!;masks.set(id,fit(matte,doc.source.width,doc.source.height));
          }
          // A depth key reads the depth of this very frame (one frame old at most); before analysis reaches it the node
          // grades nothing, like a subject not found yet.
          for(const node of depthKeys){
            const depth=depthFrames.frame(clip.id,sampleTime);
            if(depth.state==='loading')throw new SmartMaskPending('Loading depth…');
            if(depth.state!=='ready')warning=depth.state==='failed'?`Depth key · ${depth.error} · masked grade is off`:'Depth key · analyzing depth · masked grade is off';
            const [sourceWidth,sourceHeight]=sourceSize(asset);
            masks.set(nodeMaskId(node)!,fit(depth.state==='ready'?depthKeyMatte(depth.pixels,depth.run,node.mask):noDepthKey,sourceWidth,sourceHeight));
          }
          return masks;
        };
        if(!denoised?.noise && (maskCount || nodes.length || clip.properties.resolveLookUrl || Number(clip.properties.inputExposure) || Number(clip.properties.inputTemperature) || clip.properties.yuvMatrix || clip.properties.dataLevels&&clip.properties.dataLevels!=='Auto')) {
          color ??= createColorPreview(()=>{dirty=true;});
          const previewAsset=element?.src.includes('/files/')?{...asset,colorMatrix:'bt709'}:asset;
          const result = color.draw(layer,clip,previewAsset,nodes,element,sampleTime=>loadMasks(element?sampleTime+offset:sourceTime(clip,time,asset.fps||24,asset.duration)),snapshot);
          // The copy shown can lag the element (native path): the picture counters follow what was drawn, so re-stamp this layer's entry.
          if(element){const drawn=result.dataset.sourceTimestamp;sourceTimestamp=drawn?String(+drawn+offset):'';if(stampAt>=0)pictureStamps[stampAt]=`${clip.id}@${sourceTimestamp}`;}
          canvas.dataset.colorPrecision=result.dataset.colorPrecision??'8-bit RGB fallback';
          layerContext.clearRect(0,0,width,height); layerContext.drawImage(result,0,0);
          // Show key (viewer only): where the node grades, white where it grades fully (Invert included).
          const shown=depthKeys.find(n=>depthUi.showKey(n.id)),key=shown&&masks.get(nodeMaskId(shown)!);
          if(key){const image=layerContext.createImageData(width,height),flip=shown.mask.invert?255:0;for(let i=0;i<key.data.length;i++){image.data[i*4]=image.data[i*4+1]=image.data[i*4+2]=Math.abs(flip-key.data[i]);image.data[i*4+3]=255;}layerContext.putImageData(image,0,0);}
        }
      } catch (cause) { if(cause instanceof ColorPending||cause instanceof SmartMaskPending){loading=true;footageCache.setDecoderStatus(clip.id,asset.proxyUrl??'',`${asset.name} · ${cause instanceof ColorPending?'Preparing color frame':'Preparing mask'}`);const pending=seeks.findIndex(([media])=>media===element);if(pending>=0)seeks.splice(pending,1);}else {const message=cause instanceof Error?cause.message:'Color preview unavailable.';skipped.set(clip.id,`${clip.name} (${message})`);footageCache.setDecoderStatus(clip.id,asset.proxyUrl??'',`${asset.name}: ${message}`,true);} layerContext.clearRect(0,0,width,height);return; }
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
      for (const effect of denoised?.noise ? [] : clip.effects.filter(e=>effectEnabled(clip,e))) {
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
        } else if(effect.name==='Depth') {
          // After colour and Stabilize, before flip and transform; frames the analysis has not reached play plain.
          if(clip.properties.opticalFlow){warning='Depth cannot follow optical-flow retiming yet · disable optical flow for this clip';continue;}
          const depth=depthFrames.frame(clip.id,Number(sourceTimestamp)||0);
          if(depth.state==='failed'){warning=`Depth unavailable · ${depth.error}`;continue;}
          if(depth.state==='none'||depth.state==='analyzing'){warning='Analyzing depth';continue;}
          if(depth.state==='loading')continue;
          const [sourceWidth,sourceHeight]=sourceSize(asset),matrix=warp?warpTransform(warp):undefined;
          const params=Object.fromEntries(depthFxKeys.map(key=>[key,effectValue(clip,effect,key)])) as DepthFxParams;
          // The Smart Mask subject (section 7): Lens blur keeps it sharp and, following it, focuses on it. Only its current
          // analysis counts, as in the export; without one the picture plays unprotected with a note.
          const subject=params.blur>0&&effect.maskId?clip.smartMasks?.find(m=>m.id===effect.maskId):undefined;
          let matte:DepthFxInput['matte'];
          if(subject){
            if(!subject.result||subject.result.signature!==smartMaskSignature(subject))warning=subject.result?'Depth · the subject mask was edited · analyze it again before exporting':'Depth · analyze the subject mask before exporting';
            else{
              try{
                const pixels=maskPreview.readDoc(clip,subject,Number(sourceTimestamp)||0,asset);
                if(pixels===unanalyzedSmartMask)warning='Depth · subject not analyzed at this frame · edges unprotected';
                else if(pixels.key!=='empty')matte={key:pixels.key,width:pixels.width,height:pixels.height,...pixels.canvas?{canvas:pixels.canvas}:{data:pixels.data}};
              }catch(cause){if(!(cause instanceof SmartMaskPending))warning=`Depth · subject unavailable · ${cause instanceof Error?cause.message:cause}`;}
              if(params.followSubject>=.5){
                const follow=depthFocusTrack(clip,subject.result.key),focus=follow.state==='ready'?depthFocusAt(follow.track,depthFrameAt(depth.run,Number(sourceTimestamp)||0)):undefined;
                if(focus!==undefined)params.focus=focus;
                else warning=follow.state==='failed'?`Depth · Follow subject · ${follow.error}`:follow.state==='ready'?'Depth · subject not found in its mask · Focus applies':'Depth · measuring the subject to follow it';
              }
            }
          }
          depthFx??=createDepthFx();
          const result=depthFx.render(layer,{params,depth:depth.pixels,matte,near:depth.run.near,far:depth.run.far,sourceWidth,sourceHeight,warp:matrix,taps:depthTapBudget(options.quality,options.original,state.playing),view:depthUi.showMap(effect)?'map':'effect'});
          if(!result){warning='Depth preview needs WebGL2 · export is not affected';continue;}
          layerContext.save();layerContext.globalCompositeOperation='copy';layerContext.drawImage(result,0,0);layerContext.restore();
          // The focus picker: viewer pixel → layer (undo the transform and flip) → original frame (undo Stabilize) → source box.
          const poses=transformMotion(clip,time,project?.fps??24,projectWidth,projectHeight),pose=poses[poses.length>>1];
          const fit=Math.min(width/sourceWidth,height/sourceHeight),boxWidth=sourceWidth*fit,boxHeight=sourceHeight*fit,[a,b,c,d,e,f]=matrix??[1,0,0,1,0,0],det=a*d-b*c;
          rememberDepth(clip.id,{pixels:depth.pixels,near:depth.run.near,far:depth.run.far,toSource:(x,y)=>{
            const dx=x-width/2-pose.x*width/projectWidth,dy=y-height/2-pose.y*height/projectHeight,cos=Math.cos(pose.rotation),sin=Math.sin(pose.rotation);
            const lx=flip?width/2-(cos*dx+sin*dy)/pose.scaleX:(cos*dx+sin*dy)/pose.scaleX+width/2,ly=(cos*dy-sin*dx)/pose.scaleY+height/2;
            return [((d*(lx-e)-c*(ly-f))/det-(width-boxWidth)/2)/boxWidth,((a*(ly-f)-b*(lx-e))/det-(height-boxHeight)/2)/boxHeight];
          }});
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
        } else if(['Film grain','Sharpen'].includes(effect.name)) {
          const pixels=layerContext.getImageData(0,0,width,height);
          detailPixels(pixels.data,width,height,clip,effect,Math.floor(time*(project?.fps||24)));
          layerContext.putImageData(pixels,0,0);
        }
      }
      // A frame editor (mask strokes, tracker boxes) works on the source picture, so it stays unmirrored.
      if(focusing)target.drawImage(layer,0,0);
      else {if(flip)mirrorLayer();draw(target,clip,width,height,projectWidth,projectHeight,time,project?.fps??24);}
    };
    const smooth=isPhone()||slowDevice,shrink=smooth?Math.min(1,SMOOTH_EDGE/Math.max(width,height)):1;
    const preview=!focused&&state.renderPreviewAllowed!==false&&!options.compare&&!options.original&&options.quality==='Stream'
      ?timelinePreview.get(state,state.playhead,Math.round(width*shrink/2)*2,Math.round(height*shrink/2)*2,smooth||performance.now()<expensiveUntil,smooth&&state.playing?SMOOTH_AHEAD:1):undefined;
    const prepared=preview?.frame?preview:undefined;
    // Smooth playback waits for its chunk, as a video site buffers, rather than composite live at a few pictures a second.
    // A chunk that takes longer than SMOOTH_HOLD_MS (a busy server) gives way to the live picture.
    holdSince=smooth&&state.playing&&preview&&!prepared?holdSince??performance.now():undefined;
    const renderHold=holdSince!==undefined&&performance.now()-holdSince<SMOOTH_HOLD_MS;
    // Its pictures come from the server: only the sound of the next cuts is made ready here.
    const skipPictures=smooth&&(!!prepared||renderHold);
    if(focused){
      // The timeline's sound keeps playing under a frame editor; the picture is the focused clip's source alone,
      // through the same decoders, stand-ins and colour pipeline as timeline playback.
      if(state.playing)renderLayers(state.timelineId,state.playhead,context,referenceContext,false,true);
      // Playing a speed ramp, the decoder reads ahead at the rate it has reached. Reversed or frozen, the rate goes to
      // the picture pass as the timeline's own does, which seeks frame by frame rather than decoding forward.
      const fps=focused.asset.fps||project?.fps||24,live=state.playing?evaluateClip(focused.clip,state.playhead,project?.fps||24).properties:undefined;
      const neutral=focusClip(focused.clip,focused.asset,live&&!live.reverse&&!live.freeze?Number(live.speed??100):undefined);
      const rate=live?.freeze?0:live?.reverse?-1:1;
      const time=state.playing?sourceTime(focused.clip,state.playhead,fps,focused.asset.duration):state.focus!.time;
      const timeline=state;
      state={...timeline,clips:[neutral],tracks:[{...focused.track,hidden:false,muted:true,solo:false}],renderPreviewAllowed:false};
      focusing={clip:focused.clip,time:Math.max(focused.clip.start,Math.min(focused.clip.start+focused.clip.duration-1e-6,timeline.playhead))};
      try{renderLayers(timeline.timelineId,time*100/Number(neutral.properties.speed),context,referenceContext,true,false,master,rate);}
      finally{state=timeline;focusing=undefined;}
    }else if(prepared){
      renderLayers(state.timelineId,state.playhead,context,referenceContext,false,true);
      context.drawImage(prepared.frame,0,0,width,height);picture=true;engine='render-cache';warning='Rendered preview · ready';sourceClip=`preview:${prepared.key}`;sourceTimestamp=String(state.playhead);pictureStamps.push(`${sourceClip}@${sourceTimestamp}`);
    }else if(renderHold){renderLayers(state.timelineId,state.playhead,context,referenceContext,false,true);loading=true;}
    else renderLayers(state.timelineId,state.playhead,context,referenceContext);
    // Every drawn Noise Reduction clip asked for its chunk above; the rest stop preparing, so the one on screen never queues.
    denoisePreview.sweep();
    if(!prepared&&!loading&&state.playing&&performance.now()-renderStarted>1000/previewFps*.7){
      if(++expensiveFrames>=6){expensiveUntil=performance.now()+15000;expensiveFrames=0;strike(true);}
    }else if(!loading)expensiveFrames=Math.max(0,expensiveFrames-1);
    // Pictures shown per 3 s of unhindered live playback: under 70% of the frame rate is a strike against this computer.
    if(!smooth&&state.playing&&!prepared&&!loading){
      if(!paceFrom){paceFrom=performance.now();paceCount=0;}
      else if(performance.now()-paceFrom>=3000){strike(paceCount/((performance.now()-paceFrom)/1000)<previewFps*.7);paceFrom=performance.now();paceCount=0;}
      paceCount++;
    }else paceFrom=0;
    // Warm upcoming pictures and their looks independently of the audio clips.
    const upcoming=transitionsOf(state.clips,state.timelineId,state.media).filter(record=>record.start>state.playhead&&record.start-state.playhead<1.5);
    // A light leak's first picture is decoded before its transition starts.
    if(!skipPictures)for(const record of upcoming)if(transitionDefinitions[record.name]?.overlay){const found=leakEntry(record);found?.frames()?.update(found.range.start);}
    // Every warmed decoder is another preload="auto" stream competing for the same link, so nothing past the
    // horizon is opened (upcomingClips). Warming carries on through a stall: the cuts after a slow one are the
    // next thing to stall on.
    // A frame editor stays on one clip: warming the next cuts would only compete with it for the link.
    const nearby=focused?[]:upcomingClips(state,activeIds,efficient,new Set(upcoming.flatMap(record=>[record.incomingId,record.outgoingId]).filter((id):id is string=>!!id)),loading);
    const mediaById=byId(state.media),trackById=byId(state.tracks);
    /** Linked camera sound plays from its own sound-layer clip (playbackLayers' separateAudio), never from the picture's clip. */
    const linkedSound=(clip:Clip)=>timelineClips(state.clips,state.projectId,state.timelineId).some(other=>other.mediaId===clip.mediaId&&other.start===clip.start&&other.sourceIn===clip.sourceIn&&other.duration===clip.duration&&trackById.get(other.trackId)?.kind==='audio');
    for (const clip of nearby) {
      const asset = mediaById.get(clip.mediaId), track = trackById.get(clip.trackId);
      if (!asset || !track) continue;
      if(skipPictures&&track.kind==='video'&&asset.kind!=='audio'){
        const id=`${clip.id}:audio`;
        if(!asset.hasAudio||clip.properties.audioDetached||track.muted||linkedSound(clip))continue;
        const sound=decoderFor({...clip,id},asset,false,options);
        if(!sound||failedDecoder(id,sound))continue;
        warmIds.add(id);
        const element=sound.element as HTMLMediaElement,time=sourceTime(clip,Math.max(state.playhead,clip.start),asset.fps||project?.fps||24,asset.duration||Infinity);
        element.pause();if(element.readyState>=1&&!element.seeking&&Math.abs(element.currentTime-time)>.05)seeks.push([element,time]);
        continue;
      }
      if(track.kind==='video'&&(clip.properties.resolveLookUrl||nodesOf(state.nodes,clip.id).some(node=>node.enabled)||Number(clip.properties.inputExposure)||Number(clip.properties.inputTemperature)||clip.properties.yuvMatrix||clip.properties.dataLevels&&clip.properties.dataLevels!=='Auto')) {try{color??=createColorPreview(()=>{dirty=true;});color.preload(clip,asset);}catch{/* The active clip reports an invalid transform. */}}
      // Under the id renderLayers plays it by: camera sound on a sound layer is `${clip.id}:audio`.
      const visual = track.kind==='video' && asset.kind !== 'audio', id = !visual && asset.kind === 'video' ? `${clip.id}:audio` : clip.id;
      const decoder = decoderFor(id === clip.id ? clip : { ...clip, id }, asset, visual, options);
      warmIds.add(id);
      // A cut that fails before it is reached is reopened in the background like one on screen.
      if (decoder && failedDecoder(id, decoder)) continue;
      if (decoder && !decoder.image) {
        const media = decoder.element as HTMLMediaElement;
        const window = upcoming.find(record => record.incomingId === clip.id || record.outgoingId === clip.id);
        const warmSpan = window ? clipSpan(clip, [window]) : null;
        const warmClip = warmSpan ? extendClip(clip, warmSpan.start, warmSpan.end - warmSpan.start) : clip;
        const time = sourceTime(warmClip, Math.max(state.playhead, warmClip.start), asset.fps || project?.fps || 24, asset.duration || Infinity);
        const frames=track.kind==='video'?buffered(decoder,clip,asset.fps||24,state.settings.footageCache!==false):undefined;
        if(frames){
          // Linked camera sound plays from its own sound-layer clip (playbackLayers' separateAudio), never from the picture.
          if(asset.hasAudio&&!clip.properties.audioDetached&&!track.muted&&!linkedSound(clip)){
            const sound=decoderFor({...clip,id:`${clip.id}:audio`},asset,false,options);
            if(sound){warmIds.add(`${clip.id}:audio`);const element=sound.element as HTMLMediaElement;element.pause();element.muted=true;if(element.readyState>=1&&!element.seeking&&Math.abs(element.currentTime-time)>.05)seeks.push([element,time]);}
          }
          media.muted=true;frames.update(time);
          prepareColor(media as HTMLVideoElement,frames.prepare(time,Math.max(.001,Number(clip.properties.speed??100)/100)/previewFps,deepFor(clip)));
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
    // A failed layer that left the screen keeps its failure but no due retry, so a paused viewer does not repaint every
    // frame for it; failedDecoder schedules the next retry if it comes back.
    for (const [id, failure] of failures) if (failure.retryAt && performance.now() >= failure.retryAt) failures.set(id, { ...failure, retryAt: 0 });
    for (const [id, decoder] of decoders) if (!activeIds.has(id)) {
      footageCache.setDecoderStatus(id, decoder.url);
      // Pausing stops playback but NOT the fetch: preload='auto' keeps filling the buffer, so a pool
      // of idle decoders quietly competes with the clip on screen for the same uplink. Only the warm
      // set (the next cuts) is worth buffering ahead; everything else drops back to metadata.
      if (!decoder.image) { const media = decoder.element as HTMLMediaElement; if(!decoder.frames||!warmIds.has(id))media.pause(); const want = decoder.frames ? 'none' : warmIds.has(id) ? 'auto' : 'metadata'; if (media.preload !== want) media.preload = want; }
      if (!byId(state.clips).has(id.endsWith(':audio') ? id.slice(0, -6) : id.includes(':flow:') ? id.slice(0, id.indexOf(':flow:')) : id.includes(':nr:') ? id.slice(0, id.indexOf(':nr:')) : id)) { cleanup(decoder); decoders.delete(id); failures.delete(id); }
    }
    // Recently scrubbed files stay open while paused, so crossing back over a cut is instant.
    for (const [url, scrub] of scrubs) if (state.playing && !focused || scrubs.size > SCRUB_POOL && !scrubIds.has(url)) { scrub.frames.dispose(); scrubs.delete(url); }
    for(const [key,entry] of sideCanvases)if(performance.now()-entry.lastUsed>5000)sideCanvases.delete(key);
    for(const [id,entry] of leaks)if(performance.now()-entry.lastUsed>8000){entry.frames?.dispose();entry.gain?.disconnect();entry.source?.disconnect();entry.element.pause();entry.element.removeAttribute('src');entry.element.load();leaks.delete(id);}
    for(const [id,group] of groups)if(!activeGroups.has(id)){group.audio.source?.disconnect();group.audio.filters.forEach(n=>n.disconnect());group.audio.analyser?.disconnect();group.audio.gain?.disconnect();group.audio.pan?.disconnect();groups.delete(id);}
    for (const [id, decoder] of [...decoders].filter(([id]) => !activeIds.has(id) && !warmIds.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      // Every retained decoder is a live hardware decode session and a buffer competing for the
      // uplink. Never evict the next cuts we just prepared: recreating them each tick
      // discards their seek and decoded frame before the cut. Only idle spares can be evicted.
      if (decoders.size <= Math.max(efficient?2:4, activeIds.size)) break;
      cleanup(decoder); decoders.delete(id); failures.delete(id);
    }
    if(!loading){canvas.dataset.frameRevision=String(++frameRevision);composite.dataset.frameRevision=canvas.dataset.frameRevision;window.dispatchEvent(new CustomEvent('frameline:scope-frame',{detail:composite}));}
    if (options.compare) context.drawImage(reference, 0, 0, width / 2, height, 0, 0, width / 2, height);
    if (!loading) {
      output.drawImage(composite, 0, 0);
      canvas.dataset.hasPicture = String(picture);
      canvas.dataset.sourceClip = sourceClip; canvas.dataset.sourceTimestamp = sourceTimestamp;
      canvas.dataset.pictureStamp = pictureStamps.join('|');
      window.dispatchEvent(new CustomEvent('frameline:frame', { detail: canvas }));
    }
    for (const [media, time] of seeks) media.currentTime = time;
    if (seeks.length) dirty = true;
    if (loading) for (const decoder of decoders.values()) if (!decoder.image && !decoder.frames) (decoder.element as HTMLMediaElement).pause();
    stalled = loading;
    canvas.dataset.playbackEngine=engine;canvas.dataset.decodedAhead=String(Number.isFinite(decodedAhead)?decodedAhead:0);canvas.dataset.buffering=String(loading);
    const skippedLayers = [...skipped.values()], error = skippedLayers.join('; ');
    window.dispatchEvent(new CustomEvent('frameline:playback-health',{detail:{playing:state.playing,playhead:state.playhead,loading,error,engine,reason:loading?[...activeIds].map(id=>footageCache.clipFootageStatus(id).playback?.detail).filter(Boolean).join('; ')||(renderHold?SMOOTH_REASON:''):'',decodedAhead:Number.isFinite(decodedAhead)?decodedAhead:0}}));


    if (performance.now() - meterTime > 80) {
      meterTime = performance.now(); let rms = 0;
      if (masterAnalyser && state.playing) { const samples = new Float32Array(masterAnalyser.fftSize); masterAnalyser.getFloatTimeDomainData(samples); rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); }
      // Only the samples since the last read: the window then covers the sound once, whatever the frame rate.
      if (audio && loudness && state.playing) {
        const fresh = Math.min(meterSamples.length, Math.round((audio.currentTime - meterAudioTime) * audio.sampleRate));
        let energy = 0, peak = 0;
        for (const tap of loudnessTaps) {
          tap.weighted.getFloatTimeDomainData(meterSamples); for (let i = meterSamples.length - fresh; i < meterSamples.length; i++) energy += meterSamples[i] * meterSamples[i];
          tap.plain.getFloatTimeDomainData(meterSamples); for (let i = meterSamples.length - fresh; i < meterSamples.length; i++) peak = Math.max(peak, Math.abs(meterSamples[i]));
        }
        if (meterAudioTime) loudness.push(energy, fresh, peak);
        meterAudioTime = audio.currentTime;
      } else { loudness?.reset(); meterAudioTime = 0; }
      window.dispatchEvent(new CustomEvent('frameline:meters', { detail: { tracks: trackLevels, master: rms, ...loudness?.read() } }));
    }
    const blocker = loading ? [...activeIds].map(id => footageCache.clipFootageStatus(id)).map(item => item.playback).find(Boolean) : undefined;
    // Only a picture the automatic rule moved, by the clip's own asset (a decoder keeps its low stream to the end of its
    // shot after the asset is back on Stream). An alpha graphic's StreamLow is its 1/4 file, which it may be asked for by name.
    const clipById=byId(state.clips);
    const automaticLow=options.quality==='Stream'&&!options.original&&[...activeIds].some(id=>{const decoder=decoders.get(id),asset=mediaById.get(clipById.get(id)?.mediaId??''),low=asset?.proxyVariants?.StreamLow;return !!decoder?.automaticLow&&!!low&&decoder.url===low&&playbackUrl(asset!,options,true)!==low;});
    canvas.dataset.automaticLow=String(automaticLow);
    const fallbackActive = [...activeIds].some(id => { const decoder = decoders.get(id); return decoder && [...streamFallbacks.values()].includes(decoder.url); });
    loadingSince = loading ? loadingSince ?? performance.now() : undefined;
    // A paused seek that lands within a moment is a scrub, not buffering: hold the last picture quietly.
    // A failed layer never blocks: it is named, with Retry, while the playhead keeps moving.
    if (!loading || state.playing || performance.now() - loadingSince! > QUIET_SEEK_MS) status(loading ? { title: 'Loading picture…', detail: blocker?.detail ?? (renderHold ? SMOOTH_REASON : 'Preparing required layers'), loading: true } : skippedLayers.length ? { title: `${state.playing ? 'Playing' : 'Showing'} without ${skippedLayers.length} layer${skippedLayers.length === 1 ? '' : 's'}`, detail: skippedLayers.join(' · '), skipped: true } : missing ? { title: 'Original media offline', detail: 'Import the source files to play this timeline.' } : !picture && !playbackLayers(state, project?.fps || 24).some(l => l.audible) ? { title: 'No picture at playhead' } : autoplayBlocked ? { title: 'Click anywhere to hear playback', detail: 'The browser blocked sound until you interact with the page.' } : fallbackActive ? { title: 'Stream fallback', detail: 'The selected source could not play smoothly. Showing the compatible Stream preview with reduced precision; exports still use originals.', fallback: true } : automaticLow ? { title: 'Auto preview · reduced bandwidth', detail: 'Using the smaller streaming preview to keep playback moving. Originals and export quality are unchanged.' } : warning ? { title: warning } : null);
  };
  frame = requestAnimationFrame(tick);
  return {
    retry() {
      streamFallbacks.clear(); automaticStreams.clear(); footageCache.retryFootage();
      for (const scrub of scrubs.values()) scrub.frames.dispose();
      scrubs.clear();
      for (const [id, decoder] of decoders) { cleanup(decoder); footageCache.setDecoderStatus(id, decoder.url); }
      decoders.clear(); failures.clear(); dirty = true;
    },
    /** The skipped-layer notice's Retry: reopen the failed layers now, still drawn around until they have a picture. */
    retryLayers() {
      for (const [id, decoder] of decoders) if (decoder.error) { cleanup(decoder); decoders.delete(id); }
      for (const id of failures.keys()) failures.set(id, { count: 0, retryAt: 0 });
      dirty = true;
    },
    resume() {
      if (disposed) return;
      if (!audio) {
        audio = new AudioContext(); master = audio.createGain(); monitor = audio.createGain(); masterAnalyser = audio.createAnalyser(); masterAnalyser.fftSize = 256; master.connect(masterAnalyser); master.connect(monitor).connect(audio.destination);
        const weighted = audio.createChannelSplitter(2), plain = audio.createChannelSplitter(2);
        kWeighting(audio.sampleRate).reduce<AudioNode>((node, [b0, b1, b2, a1, a2]) => node.connect(audio!.createIIRFilter([b0, b1, b2], [1, a1, a2])), master).connect(weighted);
        master.connect(plain);
        loudnessTaps = [0, 1].map(channel => { const tap = { weighted: audio!.createAnalyser(), plain: audio!.createAnalyser() }; tap.weighted.fftSize = tap.plain.fftSize = meterSamples.length; weighted.connect(tap.weighted, channel); plain.connect(tap.plain, channel); return tap; });
        loudness = loudnessWindow(audio.sampleRate);
      }
      void audio.resume().catch(() => { if (!disposed) status({ title: 'Audio unavailable', detail: 'Allow audio playback in your browser.' }); });
      for (const decoder of decoders.values()) decoder.blocked = false;
      dirty = true;
    },
    dispose() { disposed = true; for (const scrub of scrubs.values()) scrub.frames.dispose(); scrubs.clear(); timelinePreview.dispose();maskPreview.dispose();depthFrames.dispose();depthFx?.dispose();unsubscribeDepth();fittedMasks.clear();maskCuts.clear();motion?.dispose(); flowPreview.dispose(); stabilizePreview.dispose(); denoisePreview.dispose(); unsubscribeDenoise(); document.fonts.removeEventListener('loadingdone', fontsChanged);window.removeEventListener('frameline:request-scope',scopeRequested); color?.dispose(); cancelAnimationFrame(frame); for (const [id, decoder] of decoders) { cleanup(decoder); footageCache.setDecoderStatus(id, decoder.url); } decoders.clear(); for(const entry of leaks.values()){entry.gain?.disconnect();entry.source?.disconnect();entry.element.pause();entry.element.removeAttribute('src');entry.element.load();}leaks.clear(); for(const group of groups.values()){group.audio.source?.disconnect();group.audio.filters.forEach(n=>n.disconnect());group.audio.analyser?.disconnect();group.audio.gain?.disconnect();group.audio.pan?.disconnect();}groups.clear(); if (audio) void audio.close(); },
  };
}
