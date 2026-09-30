import {useEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {frameImage} from '../services/sourceFrames';
import './focus.css';

/** Where a frame editor puts its chrome: the bar above the picture and the strip below it, both owned by the viewer. */
export type FocusSlots={bar:HTMLElement|null;strip:HTMLElement|null};
export function Slot({into,children}:{into:HTMLElement|null;children:ReactNode}){return into?createPortal(children,into):null;}

/** Rendered width of an element, in CSS pixels; `mounted` changes when the element comes and goes. */
export function useWidth(ref:RefObject<Element|null>,mounted:unknown=true){
  const [width,setWidth]=useState(1);
  useEffect(()=>{const el=ref.current;if(!el)return;const observer=new ResizeObserver(entries=>setWidth(Math.max(1,entries[0].contentRect.width)));observer.observe(el);return()=>observer.disconnect();},[ref,mounted]);
  return width;
}

/**
 * One cell per source frame of the clip, coloured by `cell` (colour, height 0–1), with the frame on screen marked.
 * Click or drag along it to move through the clip; the picture follows at scrub speed.
 */
export function FrameStrip({count,current,cell,seek,label,version}:{count:number;current:number;cell:(index:number)=>readonly [string,number]|undefined;seek:(index:number)=>void;label:string;version:unknown}){
  const ref=useRef<HTMLCanvasElement>(null),width=useWidth(ref);
  useEffect(()=>{
    const el=ref.current;if(!el)return;
    const dpr=window.devicePixelRatio||1,w=Math.max(1,Math.round(width*dpr)),h=Math.max(1,Math.round(el.clientHeight*dpr));el.width=w;el.height=h;
    const ctx=el.getContext('2d')!,total=Math.max(1,count);
    ctx.fillStyle='#1b2125';ctx.fillRect(0,0,w,h);
    for(let i=0;i<count;i++){const c=cell(i);if(!c)continue;ctx.fillStyle=c[0];ctx.fillRect(Math.floor(i/total*w),Math.round(h*(1-c[1])),Math.max(1,Math.ceil(w/total)),h);}
    ctx.fillStyle='#fff';ctx.fillRect(Math.round((current+.5)/total*w)-Math.round(dpr),0,Math.max(2,Math.round(2*dpr)),h);
  },[count,current,version,width]);
  const at=(clientX:number)=>{const box=ref.current!.getBoundingClientRect();return Math.min(count-1,Math.max(0,Math.floor((clientX-box.left)/box.width*count)));};
  return <canvas ref={ref} className="focus-strip" role="slider" aria-label={label} aria-valuemin={1} aria-valuemax={Math.max(1,count)} aria-valuenow={current+1} tabIndex={0}
    onKeyDown={e=>{const to={ArrowLeft:current-1,ArrowRight:current+1,Home:0,End:count-1}[e.key];if(to===undefined||e.altKey||e.shiftKey||e.metaKey||e.ctrlKey)return;e.preventDefault();seek(Math.max(0,Math.min(count-1,to)));}}
    onPointerDown={e=>{if(e.button!==0||count<1)return;e.currentTarget.setPointerCapture(e.pointerId);seek(at(e.clientX));}}
    onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))seek(at(e.clientX));}}/>;
}

/**
 * True when the original's frames are not evenly spaced (phones record variable frame rate). The proxies are constant
 * rate, so their picture can be a neighbouring frame; paused, the editors show the original's own frame instead.
 */
export function variableRate(times:number[]|null|undefined){
  if(!times||times.length<3)return false;
  const step=(times[times.length-1]-times[0])/(times.length-1);
  return times.some((t,i)=>Math.abs(t-times[0]-i*step)>step*.25);
}

/**
 * The original's own pixels for a paused, zoomed-in frame: the streaming picture is a proxy, soft at 200% and beyond.
 * Hidden until this frame has loaded, so a step never shows the previous frame's still.
 */
export function SourceStill({url,show}:{url:string;show:boolean}){
  const ref=useRef<HTMLCanvasElement>(null),[shown,setShown]=useState('');
  useEffect(()=>{
    if(!show||!url)return;
    let live=true;
    // Stepping is quick and the proxy frame is already there: wait for the step to settle before fetching a still.
    const timer=setTimeout(()=>{void frameImage(url).then(picture=>{
      const el=ref.current;if(!live||!el)return;
      el.width=picture.naturalWidth;el.height=picture.naturalHeight;el.getContext('2d')!.drawImage(picture,0,0);setShown(url);
    }).catch(()=>{/* The streaming picture stays underneath. */});},120);
    return()=>{live=false;clearTimeout(timer);};
  },[url,show]);
  return <canvas ref={ref} className="focus-still" hidden={!show||shown!==url} aria-hidden="true"/>;
}
