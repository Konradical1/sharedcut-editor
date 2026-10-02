import { trimAnimation } from './animation.ts';
import { snapTime } from './snapping.ts';
import type { Clip, Marker, Timeline, Track } from '../state/models.ts';

// Preserve source timing on both sides of an overwrite, including retimed media.
export function uncoveredParts(clip: Clip, start: number, end: number): Clip[] {
  const clipEnd = clip.start + clip.duration;
  if (end <= clip.start || start >= clipEnd) return [clip];
  return [[clip.start, Math.min(start, clipEnd)], [Math.max(end, clip.start), clipEnd]]
    // A remnant shorter than a frame is not an edit, it is float residue from the drop: leaving it
    // behind puts an invisible clip on the track that still counts as the neighbour at the cut, so
    // transitions there find no handles. 1/120s is under one frame at every rate we support.
    .filter(([a, b]) => b - a > 1 / 120)
    .map(([a, b]) => ({ ...clip, start: a, duration: b - a, sourceIn: clip.sourceIn + (clip.properties.freeze ? 0 : (clip.properties.reverse ? clipEnd - b : a - clip.start) * Number(clip.properties.speed || 100) / 100), ...trimAnimation(clip,a,b-a) }));
}

export function timelineZoom(pixels: number, viewport: number, duration: number, fps: number) {
  return Math.max(Math.min(6,viewport/Math.max(duration,1)),Math.min(viewport*fps/15,pixels));
}
export function edgeScrollVelocity(x: number, left: number, right: number) {
  const edge=Math.min(64,(right-left)/4);
  if(x<left+edge)return -1200*Math.min(1,(left+edge-x)/edge)**2;
  if(x>right-edge)return 1200*Math.min(1,(x-right+edge)/edge)**2;
  return 0;
}
export function rulerStep(pixels: number, fps: number) {
  const candidates=[1,2,5,10,15,30,60,120,300,600,1200,3000,6000,12000,30000];
  return (candidates.find(frames=>frames/fps*pixels>=65)??60000)/fps;
}

// Only bounded gaps can be closed; the trailing empty canvas has no duration.
export function trackGap(clips: Pick<Clip,'start'|'duration'>[], time:number) {
  if(!Number.isFinite(time)||time<0)return null;
  let start=0;
  for(const clip of [...clips].sort((a,b)=>a.start-b.start)) {
    if(time<clip.start)return {start,end:clip.start};
    start=Math.max(start,clip.start+clip.duration);
    if(time<start)return null;
  }
  return null;
}

/** Delete Gaps: stretches between `from` and `to` empty on every track `clips` sit on at once (a hole on V1 under a
 *  clip on A1 is not a gap, closing it would break sync), earliest first. */
export function commonGaps(clips: Pick<Clip,'start'|'duration'>[], from: number, to: number) {
  const gaps: {start:number;end:number}[] = [];
  let at = from;
  for (const clip of [...clips].sort((a,b)=>a.start-b.start)) {
    if (clip.start >= to) break;
    if (clip.start > at + 1e-6) gaps.push({ start: at, end: clip.start });
    at = Math.max(at, clip.start + clip.duration);
  }
  return gaps;
}
/** How far `time` moves left once `gaps` close; a time inside a gap lands on its start. */
export const closedShift = (gaps: {start:number;end:number}[], time: number) => gaps.reduce((shift, g) => shift + Math.min(Math.max(time - g.start, 0), g.end - g.start), 0);

/** Markers with an id each: ones saved before ids existed get a stable positional one until their next edit. */
export const markersOf = (timeline?: Pick<Timeline,'markers'>) => (timeline?.markers ?? []).map((m, i) => m.id ? m as Marker & {id:string} : { ...m, id: `marker-${i}` });

// How much room a trim has on its track. Extending an edge is a trim, not an overwrite: it stops at
// the neighbour instead of eating it, so only the move drag overwrites. Clips in `group` move with
// the trim and are not neighbours to it.
export function trimRoom(clip: Pick<Clip,'trackId'|'timelineId'|'start'|'duration'>, clips: Pick<Clip,'id'|'trackId'|'timelineId'|'start'|'duration'>[], group: string[]) {
  const others = clips.filter(o => o.trackId === clip.trackId && o.timelineId === clip.timelineId && !group.includes(o.id));
  return {
    floor: Math.max(0, ...others.filter(o => o.start + o.duration <= clip.start).map(o => o.start + o.duration)),
    ceiling: Math.min(Infinity, ...others.filter(o => o.start >= clip.start + clip.duration).map(o => o.start)),
  };
}

export function companionAudioTrack(tracks: Track[], target: Track): Track {
  return tracks.filter(t=>t.timelineId===target.timelineId&&t.kind==='audio'&&!t.locked).sort((a,b)=>Math.abs(a.number-target.number)-Math.abs(b.number-target.number))[0] ?? {id:'pending-audio',timelineId:target.timelineId,name:'Audio',kind:'audio',number:Math.max(0,...tracks.filter(t=>t.timelineId===target.timelineId&&t.kind==='audio').map(t=>t.number))+1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0};
}

/**
 * One tile per slice of a clip on screen, each carrying the sprite frame for that slice's source
 * time, so a filmstrip reads as the shot rather than one still repeated. Trim, speed, reverse and
 * freeze all move where a slice lands in the source. `tile` is the nominal on-screen width; wide
 * clips widen their tiles instead of growing the DOM past `maxTiles`.
 */
export function filmstripTiles(clip: Pick<Clip, 'duration' | 'sourceIn' | 'properties'>, source: { duration: number; frames: number }, pixels: number, tileWidth = 80, maxTiles = 240) {
  const width = Math.max(1, clip.duration * pixels);
  const tile = Math.max(tileWidth, width / maxTiles);
  const speed = Number(clip.properties.speed || 100) / 100;
  const last = source.frames - 1;
  return Array.from({ length: Math.max(1, Math.ceil(width / tile)) }, (_, index) => {
    const into = Math.min(clip.duration, (index + .5) * tile / pixels);
    const time = clip.sourceIn + (clip.properties.freeze ? 0 : (clip.properties.reverse ? clip.duration - into : into) * speed);
    return { tile, frame: Math.min(last, Math.max(0, Math.round(time / source.duration * last))) };
  });
}

/** Where a Select Forward click on empty lane space lands: exactly on a nearby edit point when snapping found one (a stored cut
 *  may sit off the frame grid, and the half-frame slack in forwardSelection absorbs that), else on the nearest frame. */
export function forwardClickTime(time: number, boundaries: number[] | null, tolerance: number, fps: number) {
  const hit = boundaries && snapTime([time], boundaries, tolerance);
  return Math.max(0, hit ? hit.at : Math.round(time * fps) / fps);
}
