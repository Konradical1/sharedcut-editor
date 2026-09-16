import type { MotionPose } from '../src/services/motionBlur.ts';

/** Average premultiplied RGBA, so transparent edges retain their colour and coverage. */
export function motionBlurFilters(input:string,output:string,poses:MotionPose[],width:number,height:number,projectWidth:number,projectHeight:number,fps:number,duration:number) {
  const filters:string[]=[],tag=`mb${output}`;
  filters.push(`[${input}]split=${poses.length}${poses.map((_,i)=>`[${tag}s${i}]`).join('')}`);
  poses.forEach((pose,i)=>{
    const w=Math.max(2,Math.round(width*pose.scaleX/2)*2),h=Math.max(2,Math.round(height*pose.scaleY/2)*2);
    if(w*h>64_000_000)throw new Error('Motion blur scale requires too much memory. Reduce scale or strength.');
    const rotation=pose.rotation?`,rotate=${pose.rotation}:ow=rotw(${pose.rotation}):oh=roth(${pose.rotation}):c=none`:'';
    filters.push(`[${tag}s${i}]format=gbrap16le,premultiply=inplace=1,scale=${w}:${h}${rotation},unpremultiply=inplace=1,format=yuva444p10le[${tag}t${i}]`);
    filters.push(`color=c=black@0:s=${width}x${height}:r=${fps}:d=${duration},format=yuva444p10le[${tag}b${i}]`);
    filters.push(`[${tag}b${i}][${tag}t${i}]overlay=x='(W-w)/2+${pose.x*width/projectWidth}':y='(H-h)/2+${pose.y*height/projectHeight}':format=yuv444p10:alpha=straight:shortest=1,format=gbrap16le,premultiply=inplace=1[${tag}p${i}]`);
    if(i)filters.push(`[${i===1?`${tag}p0`:`${tag}a${i-1}`}][${tag}p${i}]blend=all_expr='A*${i/(i+1)}+B/${i+1}':shortest=1[${tag}a${i}]`);
  });
  filters.push(`[${tag}a${poses.length-1}]unpremultiply=inplace=1[${output}]`);
  return filters;
}
