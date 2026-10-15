'use client';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion, MotionConfig, useReducedMotion } from 'motion/react';
import { ArrowUpRight, AudioLines, Check, ChevronRight, Film, Info, Layers, Maximize2, MousePointer2, Palette, Pause, Play, RotateCcw, Scissors, SkipBack, SkipForward, X } from 'lucide-react';
import { Brand } from '../ui';
import { frameAt, type ReplayFrame, type ReplayPackage, type ReplayMedia } from '../../services/showcaseReplay';
import type { MediaAsset } from '../../state/models';
import { motionTokens, shouldAnimate, springs } from './motion';
import './showcase.css';

const shortName=(name:string)=>name.split(' ')[0].replace(/^./,c=>c.toUpperCase());
const W=1600,H=900;
const timecode=(n:number)=>`${Math.floor(n/60).toString().padStart(2,'0')}:${Math.floor(n%60).toString().padStart(2,'0')}`;
const historicalDate=(n:number)=>new Date(n).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/New_York'});

function Picture({frame,media,film,time,speed,playing,original}:{frame:ReplayFrame;media?:ReplayMedia;film?:string;time:number;speed:number;playing:boolean;original:boolean}){
  const canvas=useRef<HTMLCanvasElement>(null),video=useRef<HTMLVideoElement>(null),image=useRef<HTMLImageElement>(null);
  const current=useRef({frame,media,original});current.current={frame,media,original};
  const [error,setError]=useState(false);
  useEffect(()=>{setError(false);},[media?.id]);
  // The prerendered film follows the replay shot by shot; it rides the replay clock and only seeks when it drifts.
  useEffect(()=>{const v=video.current;if(!v)return;v.playbackRate=speed;if(playing)void v.play().catch(()=>{});else v.pause();},[playing,speed,film]);
  useEffect(()=>{const v=video.current;if(v&&v.readyState&&Math.abs(v.currentTime-time)>(playing?.25:.03))v.currentTime=time;},[time,playing]);
  useEffect(()=>{
    let stopped=false,raf=0,grader:ReturnType<typeof import('../../services/colorPreview')['createColorPreview']>|undefined;
    const source=document.createElement('canvas');source.width=W;source.height=H;const ctx=source.getContext('2d');
    void import('../../services/colorPreview').then(m=>{if(!stopped)grader=m.createColorPreview();}).catch(()=>{});
    let last=0;const draw=(now:number)=>{if(stopped)return;raf=requestAnimationFrame(draw);if(now-last<1000/30)return;last=now;
      const output=canvas.current?.getContext('2d'),v=video.current,img=image.current,p=current.current;
      const input=v&&v.readyState>=2?v:img?.complete&&img.naturalWidth?img:null;if(!ctx||!output||!input||!p.frame.preview||!p.media)return;
      const width=input instanceof HTMLVideoElement?input.videoWidth:input.naturalWidth,height=input instanceof HTMLVideoElement?input.videoHeight:input.naturalHeight;
      const scale=Math.min(W/width,H/height),w=width*scale,h=height*scale;ctx.fillStyle='#000';ctx.fillRect(0,0,W,H);ctx.drawImage(input,(W-w)/2,(H-h)/2,w,h);
      let picture:HTMLCanvasElement=source;
      if(!p.original&&grader){try{picture=grader.draw(source,p.frame.preview.clip,p.media as MediaAsset,p.frame.preview.nodes);}catch{/* Keep source picture while a color LUT initializes. */}}
      output.drawImage(picture,0,0,W,H);
    };raf=requestAnimationFrame(draw);return()=>{stopped=true;cancelAnimationFrame(raf);grader?.dispose();};
  },[]);
  return <div className="sc-picture">
    <canvas ref={canvas} width={W} height={H} aria-label={`Preview of ${media?.name??'the project'}`}/>
    {media?.thumbnail&&<img ref={image} src={media.thumbnail} alt="" className="sc-source" onError={()=>setError(true)}/>}
    {film&&<video ref={video} src={film} muted playsInline preload="auto" className="sc-source"/>}
    {(!media||error&&!film)&&<div className="sc-picture-empty"><Film size={28}/><span>{error?'Footage unavailable':'The first cut starts here'}</span><small>{error?'The timeline replay is still available.':'Watch the timeline come together below.'}</small></div>}
    <div className="sc-picture-caption"><span>{media?.name??'Girls Soccer'}</span><span>{original?'Source':frame.preview?.nodes.length?'Recorded color':'Source footage'}</span></div>
  </div>;
}

function Replay({data}:{data:ReplayPackage}){
  const reduced=useReducedMotion(),animate=shouldAnimate(reduced);
  const [time,setTime]=useState(0),[playing,setPlaying]=useState(!reduced),[speed,setSpeed]=useState(1),[original,setOriginal]=useState(false),[info,setInfo]=useState(false),[selected,setSelected]=useState('');
  const [rowH,setRowH]=useState(30),[width,setWidth]=useState(900),stage=useRef<HTMLDivElement>(null),timeline=useRef<HTMLDivElement>(null);
  const index=frameAt(data,time),frame=data.frames[index],author=data.authors.find(a=>a.id===frame.author);
  const media=useMemo(()=>new Map(data.media.map(m=>[m.id,m])),[data]);
  const currentMedia=frame.preview?media.get(frame.preview.clip.mediaId):undefined;
  const tracks=useMemo(()=>frame.tracks.filter(t=>frame.clips.some(c=>c.track===t.id)||['Main picture','Dialogue','Music'].includes(t.name)),[frame]);
  const active=useMemo(()=>data.authors.flatMap(a=>{const recent=data.frames.slice(Math.max(0,index-8),index+1).reverse().find(f=>f.author===a.id&&frame.timestamp-f.timestamp<180_000);if(!recent?.focus)return[];const clip=frame.clips.find(c=>c.id===recent.focus)??recent.clips.find(c=>c.id===recent.focus),row=tracks.findIndex(t=>t.id===clip?.track);return clip&&row>=0?[{author:a,clip,row,current:a.id===frame.author}]:[];}),[data,index,frame,tracks]);
  // Track rows shrink on short screens so the whole replay fits without scrolling.
  useEffect(()=>{const fit=()=>setRowH(innerHeight<700?18:innerHeight<800?21:innerHeight<900?24:innerHeight<1000?27:30);fit();addEventListener('resize',fit);return()=>removeEventListener('resize',fit);},[]);
  useEffect(()=>{document.title='SharedCut — Behind the edit';},[]);
  useEffect(()=>{if(reduced)setPlaying(false);},[reduced]);
  useEffect(()=>{const el=timeline.current;if(!el)return;const observer=new ResizeObserver(([entry])=>setWidth(entry.contentRect.width));observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>{const hide=()=>{if(document.hidden)setPlaying(false);};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);},[]);
  useEffect(()=>{if(!playing)return;let raf=0,last=performance.now();const tick=(now:number)=>{const delta=Math.min(.1,(now-last)/1000)*speed;last=now;setTime(t=>{const next=Math.min(data.duration,t+delta);if(next>=data.duration)setPlaying(false);return next;});raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[playing,speed,data.duration]);
  const seek=(value:number)=>{setTime(Math.max(0,Math.min(data.duration,value)));};
  const toggle=()=>{if(time>=data.duration)seek(0);setPlaying(p=>!p);};
  const jumpAuthor=(id:string)=>{setSelected(id===selected?'':id);const next=data.frames.find(f=>f.at>time+.2&&f.author===id)??data.frames.find(f=>f.author===id);if(next){setPlaying(false);seek(next.at);}};
  const completed=Math.round(frame.actionCount/data.sourceActions*100),date=historicalDate(frame.timestamp);
  const dayChapters=data.chapters.filter((c,i,a)=>i===0||c.at-a[i-1].at>2||i===a.length-1);
  const primaryMedia=data.media.filter(m=>m.thumbnail&&m.kind==='video').slice(0,10);
  return <MotionConfig reducedMotion={reduced?'always':'user'}><main className="sc-showcase">
    <nav className="sc-nav"><a href="/" aria-label="SharedCut home"><Brand/></a><span className="sc-nav-divider"/><span className="sc-nav-label">Behind the edit</span><a className="sc-open" href="/login">Open SharedCut <ArrowUpRight size={15}/></a></nav>
    <header className="sc-intro"><h1>Watch {data.authors.length} friends edit {data.title} together, in a browser.</h1><p>{data.sourceActions.toLocaleString()} real edits over {Math.max(1,Math.round((data.lastTimestamp-data.firstTimestamp)/604_800_000))} weeks, replayed in {Math.round(data.duration)} seconds. Each cursor is a real person, at the shot they changed.</p></header>
    <div className="sc-editor" ref={stage}>
      <div className="sc-toolbar"><div className="sc-project"><span className="sc-project-icon"><Film size={17}/></span><div><b>{data.title}</b><span>Editing replay</span></div><ChevronRight size={14}/></div><div className="sc-workspaces"><span className={!frame.type.startsWith('Grade')?'active':''}><Scissors size={13}/> Edit</span><span className={frame.type.startsWith('Grade')?'active':''}><Palette size={13}/> Color</span><span><AudioLines size={13}/> Audio</span></div><div className="sc-top-right"><span className="sc-replay-dot"/> REPLAY <button title="About this replay" aria-label="About this replay" onClick={()=>setInfo(true)}><Info size={15}/></button><button title="Fullscreen replay" aria-label="Fullscreen replay" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void stage.current?.requestFullscreen().catch(()=>{});}}><Maximize2 size={15}/></button></div></div>
      <div className="sc-upper">
        <aside className="sc-bin"><div className="sc-panel-title"><span>Media pool</span><span>{data.sourceAssets}</span></div><div className="sc-bin-heading"><Layers size={13}/> Match day <span>▾</span></div><div className="sc-media-grid">{primaryMedia.map((m,i)=><div key={m.id} className={`sc-media-tile ${currentMedia?.id===m.id?'selected':''}`}><img src={m.thumbnail} alt="" loading={i>3?'lazy':'eager'}/><span>{m.name}</span><small>{timecode(m.duration)}</small></div>)}</div><div className="sc-bin-bottom"><Check size={11}/> Original footage, ready to edit</div></aside>
        <section className="sc-viewer" aria-label="Project preview"><div className="sc-panel-title"><span>Viewer <span className="sc-dim">/ {data.title}</span></span><button className={original?'sc-compare active':'sc-compare'} onClick={()=>setOriginal(p=>!p)} aria-pressed={original}>{original?'Show grade':'Compare original'}</button></div><Picture frame={frame} media={currentMedia} film={data.film} time={time} speed={speed} playing={playing} original={original}/><div className="sc-viewer-footer"><span><span className="sc-tiny-dot"/> {frame.preview?.nodes.length?'Color grading in your browser':'A shared edit, taking shape'}</span><span>1920 × 1080 <b>·</b> 30 FPS</span></div></section>
        <aside className="sc-activity"><div className="sc-panel-title"><span>The people behind it</span><span>{data.authors.length}</span></div><div className="sc-people">{data.authors.map(a=><button key={a.id} className={`sc-person ${a.id===frame.author?'active':''} ${selected===a.id?'selected':''}`} onClick={()=>jumpAuthor(a.id)} title={`Jump to ${shortName(a.name)}'s next edit`} style={{'--person':a.color} as CSSProperties}><span className="sc-avatar">{a.name.split(' ').map(s=>s[0]).slice(0,2).join('').toUpperCase()}</span><span><b>{shortName(a.name)}</b><small>{a.actions.toLocaleString()} recorded edits</small></span><MousePointer2 size={14}/></button>)}</div><div className="sc-current"><div className="sc-action-icon" style={{color:author?.color??'var(--accent)'}}>{frame.type.startsWith('Grade')?<Palette size={20}/>:<Scissors size={20}/>}</div><p><strong style={{color:author?.color}}>{author?shortName(author.name):'Girls Soccer'}</strong><br/>{frame.action}</p><span>{date} <span className="sc-dim">·</span> {new Date(frame.timestamp).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})}</span></div><div className="sc-color-nodes">{frame.preview?.nodes.slice(0,4).map((n,i)=><div className={n.enabled?'enabled':''} key={n.id}><span>{String(i+1).padStart(2,'0')}</span><b>{n.name}</b><div/></div>)}</div></aside>
      </div>
      <section className="sc-timeline" aria-label="Timeline reconstruction"><div className="sc-timeline-toolbar"><span><Scissors size={13}/><b>{data.title}</b><span className="sc-dim">/ Main timeline</span></span><span className="sc-timeline-count">{frame.clips.length} clips in view</span></div>
        <div className="sc-track-area" style={{'--row':`${rowH}px`} as CSSProperties}><div className="sc-track-labels"><div className="sc-track-ruler-label">TIMELINE</div>{tracks.map(t=><div key={t.id}><span>{t.kind==='video'?'V':'A'}{t.number}</span><b>{t.name}</b><span>{t.kind==='video'?<Film size={11}/>:<AudioLines size={11}/>}</span></div>)}</div><div className="sc-track-content" ref={timeline}><div className="sc-ruler">{Array.from({length:9},(_,i)=><span key={i} style={{left:`${i*12.5}%`}}>{timecode(data.timelineWindow*i/8)}</span>)}</div><div className="sc-lanes" style={{height:tracks.length*rowH}}>{tracks.map(t=><div className={`sc-lane ${t.kind}`} key={t.id} style={{height:rowH}}/>) }
          {frame.clips.map(c=>{const row=tracks.findIndex(t=>t.id===c.track);if(row<0)return null;const m=media.get(c.media),audio=tracks[row].kind==='audio',isFocus=c.id===frame.focus;return <div key={c.id} className={`sc-clip ${audio?'audio':'video'} ${isFocus?'focused':''}`} style={{left:`${Math.max(0,c.start)/data.timelineWindow*100}%`,width:`${Math.max(.12,Math.min(c.duration,data.timelineWindow-c.start)/data.timelineWindow*100)}%`,top:row*rowH+3,height:rowH-6,'--clip-color':c.color||'#4977a0','--edit-color':author?.color??'#bce8c7'} as CSSProperties} title={`${c.name} · ${c.start.toFixed(2)}s`}>
            {!audio&&m?.thumbnail&&<img src={m.thumbnail} alt=""/>}<span>{c.name}</span>{audio&&<svg preserveAspectRatio="none" viewBox="0 0 100 12" aria-hidden="true"><path d={(m?.waveform?.length?m.waveform:Array(20).fill(.08)).map((v,i,a)=>`M${i/a.length*100} ${6-Math.max(.5,v*5)}v${Math.max(1,v*10)}`).join(' ')}/></svg>}
          </div>})}
          {animate&&active.map(({author:a,clip,row,current})=>{const x=Math.max(4,Math.min(width-18,(clip.start+Math.min(clip.duration*.3,1))/data.timelineWindow*width));return <motion.div className={`sc-cursor ${current?'current':''} ${x>width-90?'flip':''}`} key={a.id} initial={false} animate={{x,y:row*rowH+rowH/2-4,opacity:current?1:.65}} transition={springs.gentle} style={{color:a.color}}><svg viewBox="0 0 24 28"><path d="M3 2 L21 17 L12 18 L8 26 Z" fill="currentColor" stroke="#101519" strokeWidth="2" strokeLinejoin="round"/></svg><span style={{background:a.color}}>{shortName(a.name)}</span></motion.div>;})}
        </div></div></div>
      </section>
      <div className="sc-replay-controls"><div className="sc-controls-top"><button className="sc-play" onClick={toggle} aria-label={playing?'Pause replay':'Play replay'}>{playing?<Pause size={17} fill="currentColor"/>:<Play size={17} fill="currentColor"/>}</button><button onClick={()=>{seek(0);setPlaying(false);}} aria-label="Restart replay" title="Restart replay"><RotateCcw size={15}/></button><button onClick={()=>{seek(data.frames[Math.max(0,index-1)].at);setPlaying(false);}} aria-label="Previous recorded edit"><SkipBack size={14}/></button><button onClick={()=>{seek(data.frames[Math.min(data.frames.length-1,index+1)].at);setPlaying(false);}} aria-label="Next recorded edit"><SkipForward size={14}/></button><span className="sc-clock">{timecode(time)} <span>/ {timecode(data.duration)}</span></span><span className="sc-replay-label">{date} <span>→</span> {frame.actionCount.toLocaleString()} edits</span><label className="sc-speed"><span className="sr-only">Replay speed</span><select aria-label="Replay speed" value={speed} onChange={e=>setSpeed(Number(e.target.value))}><option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label></div><input type="range" min={0} max={data.duration} step={.05} value={time} onChange={e=>{seek(Number(e.target.value));setPlaying(false);}} aria-label="Scrub editing history" aria-valuetext={`${timecode(time)} of ${timecode(data.duration)}, ${date}`} style={{'--progress':`${time/data.duration*100}%`} as CSSProperties}/><div className="sc-chapters">{dayChapters.map(c=><button key={c.at} onClick={()=>{seek(c.at);setPlaying(false);}} className={date===c.label?'active':''}>{c.label}</button>)}<span>{completed}% of the edits</span></div></div>
    </div>
    
    {info&&<div className="sc-info-backdrop" onClick={e=>{if(e.target===e.currentTarget)setInfo(false);}}><section className="sc-info" role="dialog" aria-modal="true" aria-labelledby="sc-info-heading" onKeyDown={e=>{if(e.key==='Escape')setInfo(false);}}><button className="sc-info-close" aria-label="Close replay information" onClick={()=>setInfo(false)} autoFocus><X size={20}/></button><h2 id="sc-info-heading">Every edit came from someone.</h2><p>This is a reconstruction of {data.sourceActions.toLocaleString()} saved edits by {data.authors.length} people. Long pauses are compressed, and small adjustments are grouped so you can follow the story.</p><p>The names and edit targets come from the history. Cursor paths between them are illustrated. The viewer shows source footage with recorded color adjustments; it is not a full export of the film.</p><p>{data.provenance.checkpointCorrections?'Some older changes were not completely recorded. The last frame uses the saved project checkpoint.':'The recorded changes reconstruct the current timeline.'} This replay never edits the original project.</p><button className="sc-info-done" onClick={()=>setInfo(false)}>Back to the edit <ChevronRight size={14}/></button></section></div>}
  </main></MotionConfig>;
}

export default function Showcase(){
  const[data,setData]=useState<ReplayPackage|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{const controller=new AbortController();setError('');fetch('/api/showcase/girls-soccer/replay.json',{signal:controller.signal}).then(async r=>{if(!r.ok)throw Error(r.status===404?'This replay is being prepared.':'The replay could not load.');const value=await r.json() as ReplayPackage;if(value.version!==1||!value.frames?.length||!value.authors?.length)throw Error('This replay has no recorded frames.');setData(value);}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[attempt]);
  if(!data)return <main className="sc-loading"><Brand/><div className="sc-loading-editor"><div/><div/><div/></div><h1>{error||'Gathering the story…'}</h1><p>{error?'Your studio and projects are still available.':'Loading the footage, people, and decisions behind Girls Soccer.'}</p>{error&&<div><button onClick={()=>setAttempt(v=>v+1)}>Try again</button><a href="/login">Open SharedCut</a></div>}</main>;
  return <Replay data={data}/>;
}
