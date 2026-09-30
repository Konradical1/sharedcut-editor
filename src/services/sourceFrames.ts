/** Loaded source frames by URL, newest last, shared by the frame editors (Smart Mask, motion tracker): stepping back
 *  and forth redraws from memory. A busy server answers 429, so a failure retries a few times before it is reported. */
export const frameImages=new Map<string,Promise<HTMLImageElement>>();
export function frameImage(url:string):Promise<HTMLImageElement>{
  const known=frameImages.get(url);if(known){frameImages.delete(url);frameImages.set(url,known);return known;}
  const load=(attempt:number):Promise<HTMLImageElement>=>new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.decoding='async';image.onload=()=>resolve(image);image.onerror=()=>reject(Error('Image unavailable.'));image.src=url;})
    .catch(error=>attempt<3?new Promise(wait=>setTimeout(wait,400*(attempt+1))).then(()=>load(attempt+1)):Promise.reject(error));
  const entry=load(0);frameImages.set(url,entry);
  entry.catch(()=>{if(frameImages.get(url)===entry)frameImages.delete(url);});
  while(frameImages.size>60)frameImages.delete(frameImages.keys().next().value!);
  return entry;
}
