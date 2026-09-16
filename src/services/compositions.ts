import type { Clip, Timeline } from '../state/models.ts';

export const isComposition = (clip: Clip) => clip.mediaId === 'frameline-composition';

/** Check the graph once at the persistence boundary, including unreachable compositions. */
export function validateCompositions(clips: Clip[], timelines: Timeline[]) {
  const byId = new Map(timelines.map(t => [t.id, t]));
  const children = new Map<string, string[]>();
  for (const clip of clips.filter(isComposition)) {
    const id = clip.properties.compositionId;
    const target = typeof id === 'string' ? byId.get(id) : undefined;
    if (!target?.composition || target.projectId !== clip.projectId) throw new Error('A composition references a missing or inaccessible timeline.');
    children.set(clip.timelineId, [...children.get(clip.timelineId) ?? [], target.id]);
  }
  const active = new Set<string>(), complete = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (active.has(id)) throw new Error('A composition cannot contain itself.');
    if (depth > 16) throw new Error('Compositions support up to 16 nested levels.');
    if (complete.has(id)) return;
    active.add(id);
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
    active.delete(id); complete.add(id);
  };
  for (const t of timelines) visit(t.id, 0);
}

/** Title timing keeps its entrance/exit, stretching only the hold until space runs out. */
export function retimeTitleClip(clip:Clip,duration:number,fps:number):Clip {
  const entrance=Number(clip.properties.animationEntrance??1.4),exit=Number(clip.properties.animationExit??.65);
  const scale=Math.min(1,Math.max(1/fps,duration-1/fps)/(entrance+exit));
  const head=entrance*scale,tail=exit*scale;
  const time=(t:number)=>Math.max(0,Math.min(Math.max(0,duration-1/fps),Math.round((t<=entrance?t*scale:t>=clip.duration-exit?duration-(clip.duration-t)*scale:head+(t-entrance)/Math.max(1/fps,clip.duration-entrance-exit)*(duration-head-tail))*fps)/fps));
  return {...clip,duration,properties:{...clip.properties,animationPresetDuration:duration,animationEntrance:head,animationExit:tail},keyframes:Object.fromEntries(Object.entries(clip.keyframes??{}).map(([path,keys])=>[path,[...new Map(keys.map(key=>[time(key.time),{...key,time:time(key.time)}])).values()].sort((a,b)=>a.time-b.time)]))};
}
