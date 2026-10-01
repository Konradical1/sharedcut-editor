import type { Clip, Track } from '../state/models.ts';
export interface SelectionRect { x:number; y:number; width:number; height:number }
export const selectionRect = (x:number,y:number,toX:number,toY:number):SelectionRect => ({x:Math.min(x,toX),y:Math.min(y,toY),width:Math.abs(toX-x),height:Math.abs(toY-y)});
export const intersects = (a:SelectionRect,b:SelectionRect) => a.x<=b.x+b.width&&a.x+a.width>=b.x&&a.y<=b.y+b.height&&a.y+a.height>=b.y;
/** All selected points retain their spacing; occupied frames reject the entire move. */
export function shiftKeyframes(channels:NonNullable<Clip['keyframes']>,ids:string[],delta:number,duration:number,fps:number) {
  const selected=Object.values(channels).flat().filter(k=>ids.includes(k.id));
  if(!selected.length)return channels;
  const shift=Math.round(Math.max(-Math.min(...selected.map(k=>k.time)),Math.min(duration-1/fps-Math.max(...selected.map(k=>k.time)),delta))*fps)/fps;
  const next=Object.fromEntries(Object.entries(channels).map(([path,keys])=>[path,keys.map(k=>ids.includes(k.id)?{...k,time:Math.round((k.time+shift)*fps)/fps}:k).sort((a,b)=>a.time-b.time)]));
  if(Object.values(next).some(keys=>keys.some((k,i)=>i>0&&k.time-keys[i-1].time<.5/fps)))return channels;
  return next;
}
/** The Select Forward tool: every clip on an unlocked track of the timeline that starts at or after `at`,
 *  and the clips that run across `at` and so stay behind. Half a frame of slack absorbs drift in stored
 *  times — a caption ending a hair past a cut does not cross it, a clip starting a hair before still counts.
 *  With `linked` a clip drags its link group along, so one whose partner sits on a locked track is left alone like it. */
export function forwardSelection(clips: readonly Clip[], tracks: readonly Track[], timelineId: string, at: number, fps: number, linked = false) {
  const slack = .5 / (fps || 24), open = new Set(tracks.filter(t => t.timelineId === timelineId && !t.locked).map(t => t.id));
  const pinned = new Set(linked ? clips.filter(c => c.timelineId === timelineId && !open.has(c.trackId) && c.properties.linkGroup !== undefined).map(c => c.properties.linkGroup) : []);
  const ids: string[] = [], crossing: string[] = [];
  for (const c of clips) {
    if (c.timelineId !== timelineId || !open.has(c.trackId) || pinned.has(c.properties.linkGroup)) continue;
    if (c.start >= at - slack) ids.push(c.id);
    else if (c.start + c.duration > at + slack) crossing.push(c.id);
  }
  return { ids, crossing };
}
/** How far the moving clips can slide left before one meets a clip that stays behind on its own track,
 *  or time zero — so dragging a forward selection back closes a gap instead of overwriting the edit. */
export function forwardRoom(clips: readonly Clip[], moving: readonly string[]) {
  const ids = new Set(moving); let room = Infinity;
  for (const c of clips) if (ids.has(c.id)) {
    room = Math.min(room, c.start);
    for (const other of clips) if (!ids.has(other.id) && other.trackId === c.trackId && other.timelineId === c.timelineId && other.start < c.start) room = Math.min(room, c.start - other.start - other.duration);
  }
  return Number.isFinite(room) ? Math.max(0, room) : 0;
}
