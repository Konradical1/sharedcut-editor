import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../state/models';
import { Film, Image as ImageIcon } from 'lucide-react';
import { playbackUrl } from '../services/playback';

/** Native seeked events coalesce pointer requests to the newest frame, as in the viewer. */
export default function MediaThumbnail({asset}:{asset:MediaAsset}) {
  const [active,setActive]=useState(false),[position,setPosition]=useState(0),[ready,setReady]=useState(false);
  const [failedThumbnail,setFailedThumbnail]=useState('');
  const video=useRef<HTMLVideoElement>(null),desired=useRef(0);
  const url=asset.kind==='video'&&asset.status==='ready'?playbackUrl(asset,{original:false,quality:'1/4'},true):undefined;
  const fps=asset.fps||24;
  const seek=()=>{
    const el=video.current;if(!el||el.readyState<1||el.seeking)return;
    const duration=Number.isFinite(el.duration)?el.duration:asset.duration;
    const target=Math.max(0,Math.min(duration-.001,(Math.floor(desired.current*duration*fps)+.5)/fps));
    if(Math.floor(el.currentTime*fps)!==Math.floor(target*fps))el.currentTime=target;
    else if(el.readyState>=2)setReady(true);
  };
  const scrub=(fraction:number)=>{desired.current=Math.max(0,Math.min(1,fraction));setPosition(desired.current);seek();};
  useEffect(()=>{if(!active)setReady(false);},[active]);
  return <div className="media-scrub-thumbnail" onPointerEnter={e=>{if(url){const r=e.currentTarget.getBoundingClientRect();desired.current=(e.clientX-r.left)/r.width;setPosition(desired.current);setActive(true);}}} onPointerMove={e=>{if(url){const r=e.currentTarget.getBoundingClientRect();scrub((e.clientX-r.left)/r.width);}}} onPointerLeave={()=>setActive(false)}>
    {asset.thumbnail && asset.thumbnail !== failedThumbnail ? <img draggable={false} src={asset.thumbnail} alt={asset.name} loading="lazy" onError={()=>setFailedThumbnail(asset.thumbnail)}/> : <span className="media-thumbnail-placeholder" aria-label={`Preview pending for ${asset.name}`}>{asset.kind==='image'?<ImageIcon size={24}/>:<Film size={24}/>}</span>}
    {active&&url&&<video ref={video} muted playsInline preload="auto" src={url} aria-hidden="true" className={ready?'ready':''} onLoadedMetadata={seek} onLoadedData={seek} onSeeked={()=>{setReady(true);seek();}} onError={()=>setReady(false)}/>}
    {url&&<div className="thumbnail-scrub-control" role="slider" tabIndex={0} aria-label={`Scrub ${asset.name}`} aria-valuemin={0} aria-valuemax={asset.duration} aria-valuenow={Number((position*asset.duration).toFixed(2))} aria-valuetext={`${(position*asset.duration).toFixed(1)} seconds`} onFocus={()=>setActive(true)} onBlur={()=>setActive(false)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();setActive(true);scrub(e.key==='Home'?0:e.key==='End'?1:position+(e.key==='ArrowLeft'?-1:1)/(fps*Math.max(asset.duration,1/fps)));}}/>}
    {active&&url&&<><i className="thumbnail-playhead" style={{left:`${position*100}%`}}/><span className="thumbnail-scrub-time">{(position*asset.duration).toFixed(1)}s</span></>}
  </div>;
}
