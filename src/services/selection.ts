import type { Clip } from '../state/models.ts';
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
