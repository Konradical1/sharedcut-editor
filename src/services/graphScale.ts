import type { Keyframe } from '../state/models.ts';

export function graphScale(keys: Keyframe[], selection: string[], mode: 'selection' | 'visible' | 'all', visible: [number,number]) {
  let indices=keys.map((_,i)=>i);
  if(mode==='selection') {
    indices=indices.filter(i=>selection.includes(keys[i].id));
    if(!indices.length)indices=[0];
    if(indices.length===1&&keys.length>1)indices.push(indices[0]===keys.length-1?indices[0]-1:indices[0]+1);
  } else if(mode==='visible') {
    indices=indices.filter(i=>keys[i].time>=visible[0]&&keys[i].time<=visible[1] || i+1<keys.length&&keys[i].time<visible[0]&&keys[i+1].time>visible[0] || i>0&&keys[i].time>visible[1]&&keys[i-1].time<visible[1]);
    if(!indices.length)indices=[visible[0]>keys.at(-1)!.time?keys.length-1:0];
  }
  const first=Math.min(...indices),last=Math.max(...indices),values=keys.slice(first,last+1).map(k=>Number(k.value));
  // The Bézier curve lies inside its control hull; include handles so neither editing nor overshoot clips.
  for(let i=first;i<last;i++)if(keys[i].interpolation==='bezier'&&keys[i].curve){const a=Number(keys[i].value),delta=Number(keys[i+1].value)-a;values.push(a+delta*keys[i].curve![1],a+delta*keys[i].curve![3]);}
  const min=Math.min(...values),max=Math.max(...values),span=Math.max(1,max-min);
  return {low:min-span*.15,high:max+span*.15,first,last};
}
export function graphStep(range:number) {
  const raw=range/4,unit=10**Math.floor(Math.log10(raw));
  return ([1,2,5,10].find(n=>n*unit>=raw)??10)*unit;
}
