import { Waveform } from './Waveform';
import SaveSoundEffect from './SaveSoundEffect';
import { draggingSound, insertSound } from '../services/sfxBrowser';
import { captionSignature } from '../services/captions';
import { isComposition } from '../services/compositions';
import { isShape, defaultShape } from '../services/shapes';
import { createTitleTemplate, titleTemplates } from '../services/titleTemplates';
import { intersects, selectionRect, type SelectionRect } from '../services/selection';
import { api, connection } from '../services/api';
import KeyframeLanes from './KeyframeLanes';
import ClipFades from './ClipFades';
import TransitionChips from './TransitionChips';
import { alignShare, bestAlign, maximumDuration, nearestCut, transitionDefinitions } from '../services/transitions';
import { isTitle, titlePresets } from '../services/text';
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type DragEvent } from 'react';
import { Shapes, PenTool, Layers, ArrowLeft, ArrowRightLeft, Type, MousePointer2, Scissors, Magnet, Link2, Flag, Plus, Minus, ChevronDown, LockKeyhole, LockKeyholeOpen, Eye, EyeOff, Volume2, VolumeX, Film, AudioLines, Copy, Trash2, Gauge, Palette, Music2, FolderSearch, Info, Clipboard, Undo2, GripVertical, ChevronUp, Diamond } from 'lucide-react';
import { useEditorStore, TRACK_THUMBNAIL_HEIGHT } from '../state/store';
import { useShallow } from 'zustand/react/shallow';
import { useTimelineShortcuts } from '../shortcuts';
import { ContextMenu, IconButton, timecode, Badge, fpsLabel } from './ui';
import { companionAudioTrack, edgeScrollVelocity, rulerStep, timelineZoom, uncoveredParts, trackGap, filmstripTiles } from '../services/timeline';
import { snapTime, SNAP_PIXELS } from '../services/snapping';
import { RemotePlayhead } from './Collaboration';
import { acceptsEffect } from '../services/effects';
import { useClipActivity, watchSmartMaskJobs, useActivityVersion } from '../services/clipStatus';
import { clipFootageStatus, useFootageVersion } from '../services/footageCache';
import { barSegments, type BarState } from '../services/renderBar';
import { useMaskEditor } from '../services/smartMaskClient';
import type { Clip, MediaAsset } from '../state/models';

/** Snap radius for a dropped transition, in screen pixels. */
const CUT_SNAP = 55;

/** Prepared sprite frames are 96 × 54; keep their aspect ratio as tracks resize. */
const FRAME_ASPECT = 96 / 54, MAX_FRAMES = 240;

/**
 * One tile per slice of the clip, each showing the source frame at that slice's time, so the strip
 * reads as the shot rather than the same still repeated. Falls back to the poster frame for media
 * imported before filmstrips existed (the server backfills those on its next start).
 */
function ClipFilmstrip({ asset, clip, pixels }: { asset?: MediaAsset; clip: Pick<Clip,'duration'|'sourceIn'|'properties'>; pixels: number }) {
  const strip = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(45);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    setHeight(element.clientHeight);
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const frames = asset?.filmstripFrames ?? 0;
  if (!asset?.filmstrip || frames < 2 || !(asset.duration > 0)) return <div ref={strip} className="clip-filmstrip" style={{ backgroundImage: asset?.thumbnail ? `url(${asset.thumbnail})` : undefined }}/>;
  const image = `url(${asset.filmstrip})`;
  return <div ref={strip} className="clip-filmstrip clip-filmstrip-tiled">
    {filmstripTiles(clip, { duration: asset.duration, frames }, pixels, Math.max(1, height * FRAME_ASPECT), MAX_FRAMES).map(({ tile, frame }, i) =>
      <i key={i} style={{ flexBasis: tile, backgroundImage: image, backgroundSize: `${frames * 100}% auto`, backgroundPositionY: 'center', backgroundPositionX: `${frame / (frames - 1) * 100}%` }}/>)}
  </div>;
}


function TimelineTime({ fps, color }: { fps?: number; color: string }) {
  const label = useEditorStore(s => timecode(s.playhead, fps));
  return <span className="timeline-time mono" style={{ color }}>{label}</span>;
}

function TimelinePlayheads({ pixels, color, scrub, scrubMove }: { pixels: number; color: string; scrub: (e: PointerEvent<HTMLDivElement>) => void; scrubMove: (e: PointerEvent<HTMLDivElement>) => void }) {
  const s = useEditorStore(useShallow(s => ({ playhead: s.playhead, presence: s.presence, users: s.users, timelineId: s.timelineId, projectId: s.projectId, workspace: s.workspace, currentUserId: s.currentUserId, showPlayheads: s.settings.showPlayheads !== false })));
  return <>
    {s.showPlayheads && s.presence.filter(p => p.activity === s.workspace && p.projectId === s.projectId && (!p.timelineId || p.timelineId === s.timelineId) && p.userId !== s.currentUserId && p.online).map(p => { const user = s.users.find(u => u.id === p.userId); return <RemotePlayhead key={`${p.userId}:${s.timelineId}`} person={p} pixels={pixels} color={user?.color} name={user?.name}/>; })}
    <div className="local-playhead" onPointerDown={scrub} onPointerMove={scrubMove} style={{ left: 164, transform: `translateX(${s.playhead * pixels}px)`, '--user-color': color } as CSSProperties}><span/></div>
  </>;
}

watchSmartMaskJobs(useMaskEditor);

// The footage cache notifies on every chunk and decoder update (~12/s while playing), which re-rendered all ~400 clip
// badges each time. One relay forwards it, at most FOOTAGE_RELAY_MS apart while playing; each badge then re-renders
// only when its own text changes.
const FOOTAGE_RELAY_MS=250,footageListeners=new Set<()=>void>();
let footageRelayed=0,relayAt=0,relayTimer:ReturnType<typeof setTimeout>|undefined;
const subscribeFootage=(listener:()=>void)=>{footageListeners.add(listener);return()=>{footageListeners.delete(listener);};};
const relayFootage=()=>{relayTimer=undefined;relayAt=performance.now();footageRelayed++;footageListeners.forEach(listener=>listener());};
function FootageRelay(){
  const version=useFootageVersion();
  useEffect(()=>{
    if(relayTimer!==undefined)return;
    const wait=useEditorStore.getState().playing?FOOTAGE_RELAY_MS-(performance.now()-relayAt):0;
    if(wait>0)relayTimer=setTimeout(relayFootage,wait);else relayFootage();
  },[version]);
  return null;
}
const footageBadge=(clipId:string)=>{const s=clipFootageStatus(clipId);return `${s.state}|${s.progress}|${s.detail}|${s.playback?.detail??''}`;};

/** Picture coverage in the editor; audio coverage in the audio workspace. */
function RenderBar({pixels,audioOnly}:{pixels:number;audioOnly:boolean}){
  useSyncExternalStore(subscribeFootage,()=>footageRelayed);useActivityVersion();
  const clips=useEditorStore(s=>s.clips),media=useEditorStore(s=>s.media),timelineId=useEditorStore(s=>s.timelineId),projectId=useEditorStore(s=>s.projectId);
  const tracks=useEditorStore(s=>s.tracks);
  const segments=barSegments(clips.filter(c=>c.timelineId===timelineId&&c.projectId===projectId&&!c.disabled&&tracks.some(t=>t.id===c.trackId&&(audioOnly?t.kind==='audio'&&!t.muted:t.kind==='video'&&!t.hidden))).map(clip=>{
    const asset=media.find(m=>m.id===clip.mediaId);
    const local=clipFootageStatus(clip.id);
    const state:BarState=local.state==='red'||asset?.status==='failed'?'red':asset&&asset.status!=='ready'?'yellow':isTitle(clip)||isShape(clip)?'green':local.state;
    return {start:clip.start,end:clip.start+clip.duration,state};
  }));
  return <div className="render-bar" role="img" aria-label="Footage on this computer: gray queued, blue downloading, amber preparing a download, green saved locally, red failed">{segments.map((seg,i)=><i key={i} className={seg.state} style={{left:seg.start*pixels,width:Math.max(1,(seg.end-seg.start)*pixels)}}/>)}</div>;
}

const ClipActivityBar=memo(function ClipActivityBar({clipId,cacheable}:{clipId:string;cacheable:boolean}) {
  const activity=useClipActivity(clipId);
  useSyncExternalStore(subscribeFootage,()=>cacheable&&!activity?footageBadge(clipId):'');
  if(!activity) {
    if(!cacheable)return null;
    const local=clipFootageStatus(clipId);
    const label=local.state==='green'?'Cached':local.state==='red'?'Cache failed':local.state==='yellow'?'Waiting':local.state==='blue'?`Caching ${local.progress}%`:local.progress?`Cached ${local.progress}%`:'Queued';
    return <div className={`clip-cache ${local.state}`} title={`${local.detail}${local.playback?` · ${local.playback.detail}`:""}`} aria-label={`${label}: ${local.detail}`} style={{'--progress':`${local.progress}%`} as CSSProperties}><span>{label}</span></div>;
  }
  return <div className={`clip-preparing ${activity.status}`} role="status" title={activity.error??`${activity.kind} preparing`} style={{'--progress':`${Math.max(4,activity.progress)}%`} as CSSProperties}><span>{activity.status==='failed'?`${activity.kind} failed`:`${activity.kind} · ${activity.progress}%`}</span></div>;
});

// Memoized so the editor shell re-rendering (presence, save status) does not redraw ~400 clip rows.
export default memo(Timeline);
function Timeline({ audioOnly = false }: { audioOnly?: boolean }) {
  const timelineId = useEditorStore(s=>s.timelineId);
  const rangeIn = useEditorStore(s=>s.rangeIn);
  const rangeOut = useEditorStore(s=>s.rangeOut);
  const project = useEditorStore(s=>s.projects.find(p=>p.id===s.projectId));
  const timelines = useEditorStore(s=>s.timelines);
  const projectId = useEditorStore(s=>s.projectId);
  const savedTracks = useEditorStore(s=>s.tracks);
  const remotePreviews = useEditorStore(useShallow(s => s.presence.filter(p => p.userId !== s.currentUserId && p.projectId === s.projectId && p.timelineId === s.timelineId && p.preview)));
  const [previewTime, setPreviewTime] = useState(() => performance.now());
  useEffect(() => { if (!remotePreviews.length) return; const timer = setInterval(() => setPreviewTime(performance.now()), 250); return () => clearInterval(timer); }, [remotePreviews.length]);
  const livePreviews = remotePreviews.filter(p => p.receivedAt !== undefined && Math.max(previewTime, performance.now()) - p.receivedAt < 2000);
  const [heightDraft, setHeightDraft] = useState<{id: string; height: number} | null>(null);
  const tracks = savedTracks.map(track => { const preview = heightDraft?.id === track.id ? heightDraft : livePreviews.flatMap(p => p.preview?.tracks ?? []).find(t => t.id === track.id); return preview ? { ...track, height: preview.height } : track; });
  const clips = useEditorStore(s=>s.clips);
  const draggingMediaId = useEditorStore(s=>s.draggingMediaId);
  // A multi-select drag from the bin carries its ids newline-joined; everything downstream of the
  // first id only cares about how much time the drop will take up.
  const draggingIds = draggingMediaId?.split('\n') ?? [];
  const draggingFirst = draggingIds[0] ?? null;
  const media = useEditorStore(s=>s.media);
  const textTool = useEditorStore(s=>s.textTool);
  const selectedIds = useEditorStore(s=>s.selectedClipIds);
  const shapeTool = useEditorStore(s=>s.shapeTool);
  const trail=useEditorStore(s=>s.compositionTrail);
  const selectedId = useEditorStore(s=>s.selectedClipId);
  const selectedBy = useEditorStore(useShallow(s => Object.fromEntries(s.presence.filter(p => p.selectedClipId && p.userId !== s.currentUserId).map(p => [p.selectedClipId, p.userId]))));
  const users = useEditorStore(s=>s.users);
  const currentUserId = useEditorStore(s=>s.currentUserId);
  const locks = useEditorStore(s=>s.locks);
  const density = useEditorStore(s=>s.settings.timelineDensity);
  const timeline = timelines.find(t=>t.id===timelineId);
  const [zoom, setZoom] = useState(1);
  const [expandedTracks,setExpandedTracks]=useState<string[]>([]);
  const [renaming,setRenaming]=useState<{id:string;value:string}|null>(null);
  const trackResize=useRef<{id:string;top:number;scale:number;gesture:string;height:number}|null>(null);
  useEffect(() => { const timer = setInterval(() => { if (trackResize.current) actions().renewLock(trackResize.current.id, '*'); }, 2000); return () => { clearInterval(timer); if (trackResize.current) actions().releaseLock(trackResize.current.id, '*'); }; }, []);
  const cancelRename=useRef(false);
  const [timelineMenu,setTimelineMenu]=useState<{x:number;y:number}|null>(null);
  const [trackMenu,setTrackMenu]=useState<{x:number;y:number;id:string}|null>(null);
  const [viewport,setViewport]=useState({left:0,width:1200});
  const timelineViews=useRef(new Map<string,number>());
  const centerZoom=useRef(false),zoomRef=useRef(zoom);zoomRef.current=zoom;
  const scrubPointer=useRef<number|null>(null);
  const [snapping, setSnapping] = useState(useEditorStore.getState().settings.defaultSnapping!==false);
  const linked = useEditorStore(s=>s.settings.linkSelection!==false);
  const setLinked=(value:boolean)=>useEditorStore.getState().setSettings({linkSelection:value});
  const [tool, setTool] = useState('select');
  const [gap,setGap]=useState<{trackId:string;start:number;end:number}|null>(null);
  useEffect(()=>setGap(null),[clips,timelineId]);
  useEffect(()=>{if(selectedId)setGap(null);},[selectedId]);
  const markers = (timeline?.markers ?? []) as {time:number;name:string;color:string}[];
  const setMarkers = (markers: {time:number;name:string;color:string}[]) => useEditorStore.setState(s => ({timelines:s.timelines.map(t=>t.id===timelineId?{...t,markers}:t)}));
  const [saveSound, setSaveSound] = useState<Clip | null>(null);
  const [menu, setMenu] = useState<{x:number;y:number;id:string}|null>(null);
  const [draft, setDraft] = useState<{id:string;start:number;duration:number;trackId?:string;snap?:number}|null>(null);
  const [pendingSounds,setPendingSounds] = useState<{id:string;trackId:string;start:number;duration:number;name:string}[]>([]);
  const [dropDraft,setDropDraft]=useState<{trackId:string;start:number;duration:number;name:string;snap?:number}|null>(null);
  const [effectTarget,setEffectTarget]=useState<string|null>(null);
  const [cutTarget,setCutTarget]=useState<{trackId:string;start:number;duration:number;name:string;fits:boolean}|null>(null);
  const draggingTransition=useEditorStore(s=>s.draggingTransition);
  useEffect(()=>{if(!draggingTransition)setCutTarget(null);},[draggingTransition]);
  useEffect(()=>{if(!draggingMediaId)setDropDraft(null);},[draggingMediaId]);
  useEffect(()=>{setDraft(null);setDropDraft(null);},[timelineId]);
  const draftRef=useRef<typeof draft>(null);
  const previewFrame = useRef(0);
  const publishFrame = (draw: () => void) => { cancelAnimationFrame(previewFrame.current); previewFrame.current = requestAnimationFrame(draw); };
  const saveGesture = () => {
    const preview = actions().dragPreview;
    return connection.flush().catch(error => actions().notify(error.message, 'error')).finally(() => {
      if (actions().dragPreview === preview) useEditorStore.setState({ dragPreview: null });
    });
  };
  useEffect(() => () => { cancelAnimationFrame(previewFrame.current); useEditorStore.setState({ dragPreview: null }); }, [timelineId]);

  const drag = useRef<{ids:string[];id:string;x:number;y:number;pointerX:number;pointerY:number;scrollLeft:number;start:number;duration:number;mode:'move'|'left'|'right';locked:boolean;changed:boolean;renewedAt:number}|null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragHandlers = useRef({ move: moveDrag, finish: finishDrag });
  dragHandlers.current = { move: moveDrag, finish: finishDrag };
  const boxStart=useRef<{x:number;y:number;ids:string[]}|null>(null);
  const [box,setBox]=useState<SelectionRect|null>(null);
  const pixels = 6 * zoom;
  const length = timeline?.duration ?? 180;
  const width = Math.max(length, ...clips.filter(c=>c.timelineId===timelineId).map(c=>c.start+c.duration)) * pixels + viewport.width/2;
  const ownColor = users.find(u=>u.id===currentUserId)?.color ?? '#ec7b77';
  const audioPreview=dropDraft&&draggingIds.some(id=>{const m=media.find(a=>a.id===id);return m?.hasAudio&&m.kind==='video';})?companionAudioTrack(tracks,tracks.find(t=>t.id===dropDraft.trackId)!):null;
  const visibleTracks = [...tracks,...(audioPreview?.id==='pending-audio'?[audioPreview]:[])].filter(t=>t.timelineId===timelineId&&(!audioOnly||t.kind==='audio')).sort((a,b)=>Number(Boolean(b.captionSets))-Number(Boolean(a.captionSets))||(a.kind!==b.kind?(a.kind==='video'?-1:1):a.kind==='video'?b.number-a.number:a.number-b.number));
  const staleCaptions=new Set(tracks.filter(t=>t.timelineId===timelineId).flatMap(t=>t.captionSets??[]).filter(meta=>meta.signature!==captionSignature(clips,tracks,timelineId,meta.start,meta.end,meta.trackIds)).map(s=>s.id));
  const actions = useEditorStore.getState;
  useTimelineShortcuts(setTool, setSnapping);
  const screenPixels = () => pixels * ((scrollRef.current?.querySelector('.timeline-ruler')?.getBoundingClientRect().width ?? width) / width);
  const fps=project?.fps||24, usable=Math.max(100,viewport.width-164);
  const changeZoom=(next:number)=>{centerZoom.current=true;const value=timelineZoom(next*6,usable,length,fps)/6;zoomRef.current=value;setZoom(value);};
  useLayoutEffect(()=>{
    const el=scrollRef.current;
    centerZoom.current=false;
    const value=timeline?.composition
      ? Math.max(100,(el?.clientWidth??viewport.width)-164)/(Math.max(length,1)*6)
      : timelineViews.current.get(timelineId)??1;
    zoomRef.current=value;
    setZoom(value);
    if(el){el.scrollLeft=0;setViewport({left:0,width:el.clientWidth});}
    return()=>{timelineViews.current.set(timelineId,zoomRef.current);};
  },[timelineId]);
  useLayoutEffect(()=>{if(centerZoom.current&&scrollRef.current){scrollRef.current.scrollLeft=Math.max(0,actions().playhead*pixels-usable/2);centerZoom.current=false;}},[pixels,usable]);
  useEffect(()=>{
    const el=scrollRef.current;if(!el)return;
    const resize=new ResizeObserver(()=>setViewport({left:el.scrollLeft,width:el.clientWidth}));resize.observe(el);
    let gestureZoom=zoomRef.current;
    const wheel=(event:WheelEvent)=>{if(!event.metaKey&&!event.ctrlKey)return;event.preventDefault();const amount=(event.deltaY||event.deltaX)*(event.deltaMode===1?16:event.deltaMode===2?el.clientWidth:1);changeZoom(zoomRef.current*Math.exp(-Math.max(-300,Math.min(300,amount))*.006));};
    const begin=(event:Event)=>{event.preventDefault();gestureZoom=zoomRef.current;};
    const gesture=(event:Event)=>{event.preventDefault();const scale=(event as Event & {scale:number}).scale;if(Number.isFinite(scale))changeZoom(gestureZoom*scale);};
    el.addEventListener('wheel',wheel,{passive:false});el.addEventListener('gesturestart',begin,{passive:false});el.addEventListener('gesturechange',gesture,{passive:false});
    return()=>{resize.disconnect();el.removeEventListener('wheel',wheel);el.removeEventListener('gesturestart',begin);el.removeEventListener('gesturechange',gesture);};
  },[usable,length,fps]);
  useEffect(()=>{
    let frame=0,last=performance.now();
    const stop=()=>{scrubPointer.current=null;};
    const tick=(now:number)=>{const elapsed=Math.min(.05,(now-last)/1000);last=now;const el=scrollRef.current;
      if(scrubPointer.current!==null&&el&&actions().liveMode!=='following') {const rect=el.getBoundingClientRect(),scale=el.querySelector('.timeline-ruler')!.getBoundingClientRect().width/width,left=rect.left+164*scale,right=rect.right;
        el.scrollLeft+=edgeScrollVelocity(scrubPointer.current,left,right)*elapsed/scale;
        const ruler=el.querySelector('.timeline-ruler')!.getBoundingClientRect();actions().setPlayhead(Math.round((Math.max(left,Math.min(right,scrubPointer.current))-ruler.left)/(pixels*scale)*fps)/fps);
      }
      const d=drag.current;
      if(d?.changed&&el){
        const rect=el.getBoundingClientRect(),scale=el.querySelector('.timeline-ruler')!.getBoundingClientRect().width/width;
        const before=el.scrollLeft;
        el.scrollLeft+=edgeScrollVelocity(d.pointerX,rect.left+164*scale,rect.right)*elapsed/scale;
        if(el.scrollLeft!==before)dragHandlers.current.move({clientX:d.pointerX,clientY:d.pointerY},true);
      }
      frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);window.addEventListener('blur',stop);
    return()=>{cancelAnimationFrame(frame);stop();window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);window.removeEventListener('blur',stop);};
  },[pixels,fps,timelineId,width]);
  useEffect(()=>{
    const cancel=()=>dragHandlers.current.finish(true);
    window.addEventListener('blur',cancel);
    return()=>{window.removeEventListener('blur',cancel);cancel();};
  },[timelineId]);
  const step=rulerStep(pixels,fps),firstTick=Math.max(0,Math.floor((viewport.left-164)/pixels/step)),lastTick=Math.ceil((viewport.left+viewport.width)/pixels/step);

  function startDrag(e:PointerEvent<HTMLDivElement>,clip:Clip,mode:'move'|'left'|'right') {
    if(e.button!==0)return;
    setGap(null);e.preventDefault(); e.stopPropagation(); if(e.shiftKey){actions().selectClip(clip.id,true);return;}if(!actions().selectedClipIds.includes(clip.id))actions().selectClip(clip.id);
    if(tool==='blade' && mode==='move'){const r=e.currentTarget.getBoundingClientRect();actions().setPlayhead(clip.start+(e.clientX-r.left)/screenPixels());actions().splitClip(clip.id);return;}
    if(tracks.find(t=>t.id===clip.trackId)?.locked){actions().notify('Track is locked','info','Unlock the track to move or trim its clips.');return;}
    const selected=mode==='move'?actions().selectedClipIds:[clip.id],links=clips.filter(c=>selected.includes(c.id)).map(c=>c.properties.linkGroup).filter(Boolean);const ids=clips.filter(c=>c.timelineId===timelineId&&(selected.includes(c.id)||linked&&links.includes(c.properties.linkGroup))).map(c=>c.id);
    if(clips.some(c=>ids.includes(c.id)&&tracks.find(t=>t.id===c.trackId)?.locked))return;
    drag.current={ids,id:clip.id,x:e.clientX,y:e.clientY,pointerX:e.clientX,pointerY:e.clientY,scrollLeft:scrollRef.current!.scrollLeft,start:clip.start,duration:clip.duration,mode,locked:false,changed:false,renewedAt:0};
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function finishTrackResize(cancel = false) {
    const resize = trackResize.current; if (!resize) return;
    cancelAnimationFrame(previewFrame.current); trackResize.current = null;
    if (!cancel) { actions().updateTrack(resize.id, { height: resize.height }, resize.gesture); void saveGesture().finally(() => actions().releaseLock(resize.id, '*')); }
    else { useEditorStore.setState({ dragPreview: null }); actions().releaseLock(resize.id, '*'); }
    setHeightDraft(null);
  }
  function moveDrag(e:Pick<PointerEvent<HTMLDivElement>,'clientX'|'clientY'>,immediate=false) {
    const d=drag.current;if(!d||Math.hypot(e.clientX-d.x,e.clientY-d.y)<3&&!d.changed)return;
    if(!d.locked||Date.now()-d.renewedAt>2000){if(!clips.filter(c=>d.ids.includes(c.id)).every(c=>actions().acquireLock(c.id,'manipulation'))){finishDrag(true);actions().notify('This clip is being edited','info','You can inspect it while your collaborator finishes.');return;}d.locked=true;d.renewedAt=Date.now();}
    d.changed=true;d.pointerX=e.clientX;d.pointerY=e.clientY;
    // Include canvas travel so a stationary pointer keeps moving the clip during edge scrolling.
    const delta=(e.clientX-d.x)/screenPixels()+(scrollRef.current!.scrollLeft-d.scrollLeft)/pixels;
    let start=d.start,duration=d.duration;
    if(d.mode==='move')start=d.start+Math.max(-Math.min(...clips.filter(c=>d.ids.includes(c.id)).map(c=>c.start)),delta);
    if(d.mode==='left'){start=Math.max(0,Math.min(d.start+d.duration-1/fps,d.start+delta));duration=d.start+d.duration-start;}
    if(d.mode==='right')duration=Math.max(1/fps,d.duration+delta);
    // Clamp a trim where the commit clamps it, so the edge visibly stops at the source boundary or
    // the neighbour instead of stretching and jumping back when the pointer is released.
    if(d.mode!=='move'){const fit=actions().fitTrim(d.id,Math.round(start*fps)/fps,Math.round(duration*fps)/fps);if(!fit)return;start=fit.start;duration=fit.duration;}
    let snapped:number|undefined;
    if(snapping&&d.mode==='move'){
      // Both edges of the clip look for the nearest edit point, so it sticks to a neighbour's end
      // as readily as to its start — and the match is kept so the lane can draw the line.
      const boundaries=[0,actions().playhead,...markers.map(m=>m.time),...clips.filter(c=>!d.ids.includes(c.id)&&c.timelineId===timelineId).flatMap(c=>[c.start,c.start+c.duration])];
      const hit=snapTime([start,start+d.duration],boundaries,SNAP_PIXELS/screenPixels());
      if(hit){start+=hit.shift;snapped=hit.at;}
    }
    if(d.mode==='move')start=Math.max(d.start-Math.min(...clips.filter(c=>d.ids.includes(c.id)).map(c=>c.start)),start);
    const hovered=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-track]')?.getAttribute('data-track');
    const sourceTrack=tracks.find(t=>t.id===clips.find(c=>c.id===d.id)?.trackId);
    const target=tracks.find(t=>t.id===hovered&&!t.locked&&t.kind===sourceTrack?.kind);
    if(d.mode==='move'&&target&&clips.filter(c=>d.ids.includes(c.id)).some(c=>{const original=tracks.find(t=>t.id===c.trackId)!;return original.kind===sourceTrack?.kind&&!tracks.some(t=>t.timelineId===timelineId&&t.kind===original.kind&&!t.locked&&t.number===original.number+target.number-sourceTrack.number);})){draftRef.current=null;setDraft(null);useEditorStore.setState({dragPreview:null});return;}
    if(d.mode==='move'&&hovered&&!target){draftRef.current=null;setDraft(null);useEditorStore.setState({dragPreview:null});return;}
    const align=(value:number)=>d.mode==='move'?Math.round(value*fps)/fps:value;
    draftRef.current={id:d.id,trackId:d.mode==='move'?target?.id:undefined,start:align(start),duration:align(duration),snap:snapped};
    const draw = () => {
      const final = draftRef.current; if (!final || !drag.current) return;
      setDraft(final);
      const offset = (tracks.find(t => t.id === final.trackId)?.number ?? sourceTrack!.number) - sourceTrack!.number;
      useEditorStore.setState({ dragPreview: { clips: clips.filter(c => d.ids.includes(c.id)).map(c => ({ id: c.id, start: Math.max(0, c.start + final.start - d.start), duration: Math.max(1/fps, c.duration + final.duration - d.duration), trackId: d.mode === 'move' && tracks.find(t => t.id === c.trackId)?.kind === sourceTrack!.kind ? tracks.find(t => t.timelineId === timelineId && t.kind === tracks.find(t => t.id === c.trackId)?.kind && t.number === tracks.find(t => t.id === c.trackId)!.number + offset)?.id ?? c.trackId : c.trackId })) } });
    };
    if(immediate){cancelAnimationFrame(previewFrame.current);draw();}else publishFrame(draw);
  }
  function finishDrag(cancel=false) {
    const d=drag.current;if(!d)return;
    cancelAnimationFrame(previewFrame.current);
    const final=draftRef.current;
    const release = () => { for(const id of d.ids)actions().releaseLock(id,'manipulation'); };
    if(!cancel&&final&&d.changed){if(d.mode==='move')actions().moveClip(d.id,final.start,final.trackId);else actions().trimClip(d.id,final.start,final.duration);void saveGesture().finally(release);}else {useEditorStore.setState({dragPreview:null});release();}
    drag.current=null;draftRef.current=null;setDraft(null);
  }
  useEffect(()=>{const cancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){finishTrackResize(true);finishDrag(true);boxStart.current=null;setBox(null);}};window.addEventListener('keydown',cancel);return()=>window.removeEventListener('keydown',cancel);});
  function scrub(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || actions().liveMode === 'following') return;
    e.preventDefault();
    actions().setPlaying(false);scrubPointer.current=e.clientX;
    const rect = scrollRef.current!.querySelector('.timeline-ruler')!.getBoundingClientRect();
    actions().setPlayhead(Math.round((e.clientX - rect.left) / screenPixels()*fps)/fps);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function scrubMove(e: PointerEvent<HTMLDivElement>) {
    if (e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId) && !drag.current && actions().liveMode !== 'following') {
      e.preventDefault();scrubPointer.current=e.clientX;
      actions().setPlayhead(Math.round((e.clientX - scrollRef.current!.querySelector('.timeline-ruler')!.getBoundingClientRect().left) / screenPixels()*fps)/fps);
    }
  }
  function mediaPlacement(e:DragEvent<HTMLDivElement>,trackId:string) {
    const titleIndex=draggingFirst?.startsWith('title:')?Number(draggingFirst.split(':')[1]):-1,shapeKind=draggingFirst?.startsWith('shape:')?draggingFirst.slice(6):null;
    const asset=titleTemplates[titleIndex]?{kind:'image',status:'ready',duration:createTitleTemplate(titleIndex,!draggingFirst?.endsWith(':static'),fps).duration,name:titleTemplates[titleIndex].name}:shapeKind?{kind:'image',status:'ready',duration:5,name:shapeKind}:draggingSound && draggingSound.id===draggingFirst?{...draggingSound,kind:'audio'}:media.find(m=>m.id===draggingFirst),track=tracks.find(t=>t.id===trackId);
    if(!asset||asset.status!=='ready'||track?.locked||track?.kind!==(asset.kind==='audio'?'audio':'video'))return null;
    const still=parseFloat(String(actions().settings.stillDuration))||5;
    const lengthOf=(a:{kind?:string;duration:number})=>a.kind==='image'?still:a.duration;
    const duration=titleIndex>=0||shapeKind?asset.duration:draggingIds.reduce((total,id)=>{const m=media.find(a=>a.id===id);return total+(m?lengthOf(m):0);},0)||lengthOf(asset);
    let start=Math.max(0,(e.clientX-e.currentTarget.getBoundingClientRect().left)/screenPixels());
    let snapped:number|undefined;
    if(snapping){const boundaries=[0,actions().playhead,...markers.map(m=>m.time),...clips.filter(c=>c.timelineId===timelineId).flatMap(c=>[c.start,c.start+c.duration])];const hit=snapTime([start,start+duration],boundaries,SNAP_PIXELS/screenPixels());if(hit&&start+hit.shift>=0){start+=hit.shift;snapped=hit.at;}}
    start=Math.round(start*(project?.fps||24))/(project?.fps||24);
    return {trackId,start,duration,name:draggingIds.length>1?`${draggingIds.length} clips`:asset.name,snap:snapped};
  }
  const moved=clips.find(c=>c.id===draft?.id);
  const movePlacements=draft&&moved&&drag.current?.mode==='move'?clips.filter(c=>drag.current!.ids.includes(c.id)).map(c=>{const source=tracks.find(t=>t.id===moved.trackId)!,target=tracks.find(t=>t.id===(draft.trackId??moved.trackId))!,original=tracks.find(t=>t.id===c.trackId)!;return {...c,start:c.start+draft.start-moved.start,trackId:original.kind===source.kind?tracks.find(t=>t.timelineId===timelineId&&t.kind===original.kind&&t.number===original.number+target.number-source.number)?.id??c.trackId:c.trackId};}):[];
  const placement=dropDraft??(draft&&moved?{...draft,trackId:draft.trackId??moved.trackId,name:moved.name}:null);
  const snapLine=draft?.snap??dropDraft?.snap;
  const menuClip=clips.find(c=>c.id===menu?.id);
  const menuAction=(fn:()=>void)=>{fn();setMenu(null);};
  return <section className={`timeline panel ${audioOnly?'timeline-audio':''} ${density==='compact'?'timeline-dense':''}`} aria-label={audioOnly?'Audio timeline':'Timeline'} onKeyDownCapture={e=>{if(gap&&(e.key==='Delete'||e.key==='Backspace')&&!(e.target as HTMLElement).closest('input,select,textarea')){e.preventDefault();e.stopPropagation();actions().deleteGap(gap.trackId,gap.start,gap.end);setGap(null);}}}>
    {timelineMenu&&<ContextMenu {...timelineMenu} onClose={()=>setTimelineMenu(null)}><button role="menuitem" onClick={()=>{setTimelineMenu(null);actions().setModal('timeline-settings');}}>Timeline settings…</button></ContextMenu>}
    <div className="timeline-toolbar">{trail.length>0&&<nav className="composition-breadcrumb" aria-label="Composition navigation">{trail.map((entry,i)=><button key={i} onClick={()=>actions().leaveComposition(i)} aria-label={`Back to ${timelines.find(t=>t.id===entry.timelineId)?.name}`}><ArrowLeft size={12}/>{timelines.find(t=>t.id===entry.timelineId)?.name}</button>)}<b><Layers size={13}/>{timeline?.name}</b></nav>}<div className="timeline-tabs" hidden={trail.length>0}>{timelines.filter(t=>t.projectId===projectId&&!t.composition).map(t=><button key={t.id} className={t.id===timelineId?'active':''} onContextMenu={e=>{e.preventDefault();actions().setTimeline(t.id);setTimelineMenu({x:e.clientX,y:e.clientY});}} onClick={()=>actions().setTimeline(t.id)}><Film size={13}/>{t.name}{t.id===timelineId&&<span className="timeline-tab-dot"/>}</button>)}</div><span className="spacer"/><button className="text-button" onClick={async()=>{try{await connection.flush();const result=await api(`/projects/${projectId}/resolve-export?timelineId=${encodeURIComponent(timelineId)}`);const url=URL.createObjectURL(new Blob([JSON.stringify(result.otio,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='SharedCut-timeline.otio';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);actions().notify('Resolve timeline exported','info',result.warnings.join(' '));}catch(error){actions().notify('Resolve export failed','error',(error as Error).message);}}}>Resolve OTIO</button><button title="Timeline settings" className="timeline-format mono text-button" onClick={()=>actions().setModal('timeline-settings')}>{project?.resolution} <span>·</span> {fpsLabel(project?.fps)} fps</button><IconButton label="Add track" onClick={()=>actions().createTrack(audioOnly?'audio':'video')}><Plus size={15}/></IconButton></div>
    <div className="timeline-tools"><TimelineTime fps={project?.fps} color={ownColor}/><div className="tool-group"><IconButton label="Selection tool (V)" className={tool==='select'&&!textTool&&!shapeTool?'active':''} onClick={()=>{setTool('select');useEditorStore.setState({textTool:false,shapeTool:null});}}><MousePointer2 size={15}/></IconButton><IconButton label="Blade tool (B)" className={tool==='blade'?'active':''} onClick={()=>{setTool('blade');useEditorStore.setState({textTool:false,shapeTool:null});}}><Scissors size={15}/></IconButton><IconButton label="Text tool (T)" className={textTool?'active':''} onClick={()=>useEditorStore.setState({textTool:!textTool,shapeTool:null,playing:false})}><Type size={15}/></IconButton><IconButton label="Shape tool (S)" className={shapeTool&&shapeTool!=='pen'?'active':''} onClick={()=>useEditorStore.setState({shapeTool:shapeTool==='rectangle'?null:'rectangle',textTool:false,playing:false})}><Shapes size={15}/></IconButton><IconButton label="Pen tool (P)" className={shapeTool==='pen'?'active':''} onClick={()=>useEditorStore.setState({shapeTool:shapeTool==='pen'?null:'pen',textTool:false,playing:false})}><PenTool size={15}/></IconButton><span className="tool-separator"/><IconButton label="Snapping (N)" className={snapping?'active':''} onClick={()=>setSnapping(!snapping)}><Magnet size={15}/></IconButton><IconButton title="Select and edit linked audio/video together" label="Linked selection" className={linked?'active':''} onClick={()=>{setLinked(!linked);actions().notify(linked?'Linked selection off':'Linked selection on','info');}}><Link2 size={15}/></IconButton><IconButton label="Add marker at playhead" onClick={()=>setMarkers([...markers,{time:actions().playhead,name:`Marker ${markers.length+1}`,color:ownColor}])}><Flag size={14}/></IconButton><button className="range-mark-button" title="Mark In (I)" aria-label="Mark In at playhead" onClick={()=>actions().setRange(actions().playhead,rangeOut)}>[</button><button className="range-mark-button" title="Mark Out (O)" aria-label="Mark Out at playhead" onClick={()=>actions().setRange(rangeIn,actions().playhead)}>]</button><span className="tool-separator"/><IconButton label="Undo my action (⌘Z)" onClick={()=>actions().undo()}><Undo2 size={15}/></IconButton></div><span className="spacer"/><span className="timeline-hint">{placement?`Place at ${timecode(placement.start,project?.fps)} · release to overwrite`:'Shift-click or drag to select · ruler to scrub'}</span><div className="timeline-zoom"><IconButton label="Zoom timeline out" onClick={()=>changeZoom(zoom/1.4)}><Minus size={13}/></IconButton><input aria-label="Timeline zoom" aria-valuetext={`${Math.round(usable/pixels*fps)} frames visible`} title="Pinch or Command-scroll to zoom around the playhead" type="range" min={Math.log2(Math.min(6,usable/Math.max(length,1))/6)} max={Math.log2(usable*fps/15/6)} step="0.02" value={Math.log2(zoom)} onChange={e=>changeZoom(2**Number(e.target.value))}/><IconButton label="Zoom timeline in" onClick={()=>changeZoom(zoom*1.4)}><Plus size={13}/></IconButton><button className="text-button mono" onClick={()=>changeZoom(usable/(length*6))}>Fit</button><button className="text-button mono" onClick={()=>changeZoom(usable*fps/60/6)}>60f</button><button className="text-button mono" onClick={()=>changeZoom(usable*fps/30/6)}>30f</button></div></div>
    <div className="timeline-scroll" data-cursor-surface="timeline" ref={scrollRef} onScroll={e=>setViewport({left:e.currentTarget.scrollLeft,width:e.currentTarget.clientWidth})}>
      <div className="timeline-content" style={{minWidth:width+164}}>
        <div className="timeline-ruler-row"><div className="timeline-track-heading"><span>TRACKS</span><ChevronDown size={12}/></div><div className="timeline-ruler" data-cursor-anchor="ruler" data-time-span={width/pixels} style={{width}} onPointerDown={scrub} onPointerMove={scrubMove}>
          <div className="timeline-range" title="Marked export range" style={{left:rangeIn*pixels,width:(rangeOut-rangeIn)*pixels}}/>
          <FootageRelay/><RenderBar pixels={pixels} audioOnly={audioOnly}/>
          {Array.from({length:Math.max(0,lastTick-firstTick+1)},(_,index)=>{const i=index+firstTick;return <div key={i} className="ruler-tick major" style={{left:i*step*pixels}}><span className="mono">{timecode(i*step,fps)}</span></div>;})}
          {markers.map((m,i)=><button key={i} className="timeline-marker" style={{left:m.time*pixels,color:m.color}} title={m.name} aria-label={`Go to marker: ${m.name}`} onClick={e=>{e.stopPropagation();actions().setPlayhead(m.time);}}><Flag size={12} fill="currentColor"/></button>)}
        </div></div>
        <div className="timeline-track-area" onPointerDown={e=>{
          if(e.button!==0||(e.target as Element).closest('.timeline-clip,.animation-rows,.track-label'))return;
          e.preventDefault();e.currentTarget.focus();boxStart.current={x:e.clientX,y:e.clientY,ids:e.shiftKey?actions().selectedClipIds:[]};if(!e.shiftKey)actions().selectClip(null);e.currentTarget.setPointerCapture(e.pointerId);
        }} onPointerMove={e=>{
          const start=boxStart.current;if(!start)return;const rect=selectionRect(start.x,start.y,e.clientX,e.clientY);if(rect.width<3&&rect.height<3)return;setGap(null);
          const r=e.currentTarget.getBoundingClientRect(),scale=r.width/e.currentTarget.offsetWidth;
          setBox({x:(rect.x-r.left)/scale,y:(rect.y-r.top)/scale,width:rect.width/scale,height:rect.height/scale});
          const ids=Array.from(e.currentTarget.querySelectorAll('[data-clip]')).filter(el=>{const r=el.getBoundingClientRect();return intersects(rect,{x:r.left,y:r.top,width:r.width,height:r.height});}).map(el=>el.getAttribute('data-clip')!);actions().selectClips([...new Set([...start.ids,...ids])]);
        }} onPointerUp={()=>{boxStart.current=null;setBox(null);}} onPointerCancel={()=>{boxStart.current=null;setBox(null);}} onLostPointerCapture={()=>{boxStart.current=null;setBox(null);}}>
          {box&&<div className="selection-marquee" style={{left:box.x,top:box.y,width:box.width,height:box.height}}/>}
          {visibleTracks.map(track=>{const siblings=visibleTracks.filter(t=>t.kind===track.kind&&Boolean(t.captionSets)===Boolean(track.captionSets)),position=siblings.indexOf(track);const lanePlacement=audioPreview?.id===track.id&&dropDraft?{...dropDraft,trackId:track.id,name:`${dropDraft.name} · Audio`}:placement;return <Fragment key={track.id}><div className={`timeline-track ${track.kind} ${track.hidden?'track-hidden':''} ${track.height&&track.height<TRACK_THUMBNAIL_HEIGHT?'track-short':''}`} key={track.id} style={track.height?{height:track.height}:undefined}>
            <div className="track-label" data-cursor-anchor={`track-label-${track.id}`} onContextMenu={e=>{e.preventDefault();setTrackMenu({x:e.clientX,y:e.clientY,id:track.id});}}><div className="track-id">{track.kind==='video'?<Film size={12}/>:<AudioLines size={13}/>}<b>{track.kind==='video'?'V':'A'}{track.number}</b></div><div className="track-label-body">{renaming?.id===track.id?<input className="track-rename" autoFocus aria-label={`Rename ${track.name}`} value={renaming.value} maxLength={80} onChange={e=>setRenaming({id:track.id,value:e.target.value})} onFocus={e=>e.currentTarget.select()} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){cancelRename.current=true;e.currentTarget.blur();}}} onBlur={()=>{if(!cancelRename.current)actions().updateTrack(track.id,{name:renaming.value});cancelRename.current=false;setRenaming(null);}}/>:<button className="track-name" title={track.captionSets?.some(s=>staleCaptions.has(s.id))?'Captions are out of date. Regenerate in Captions.':`Rename ${track.name}`} onClick={()=>setRenaming({id:track.id,value:track.name})}>{track.name}{track.captionSets?.some(s=>staleCaptions.has(s.id))&&' ⚠'}</button>}<div className="track-controls"><IconButton className="track-move" label={`Move ${track.name} up`} disabled={position<=0} onClick={()=>actions().moveTrack(track.id,'up')}><ChevronUp size={11}/></IconButton><IconButton className="track-move" label={`Move ${track.name} down`} disabled={position<0||position>=siblings.length-1} onClick={()=>actions().moveTrack(track.id,'down')}><ChevronDown size={11}/></IconButton><IconButton className={`track-keys ${expandedTracks.includes(track.id)?'active':''}`} label={`${expandedTracks.includes(track.id)?'Collapse':'Expand'} keyframes for ${track.name}`} aria-expanded={expandedTracks.includes(track.id)} onClick={()=>setExpandedTracks(expandedTracks.includes(track.id)?expandedTracks.filter(id=>id!==track.id):[...expandedTracks,track.id])}><Diamond size={10} fill={expandedTracks.includes(track.id)?'currentColor':'none'}/></IconButton><IconButton label={`${track.locked?'Unlock':'Lock'} ${track.name}`} className={track.locked?'active':''} onClick={()=>actions().updateTrack(track.id,{locked:!track.locked})}>{track.locked?<LockKeyhole size={10}/>:<LockKeyholeOpen size={10}/>}</IconButton>{track.kind==='video'?<IconButton label={`${track.hidden?'Show':'Hide'} ${track.name}`} onClick={()=>actions().updateTrack(track.id,{hidden:!track.hidden})}>{track.hidden?<EyeOff size={11}/>:<Eye size={11}/>}</IconButton>:<><IconButton label={`${track.muted?'Unmute':'Mute'} ${track.name}`} className={track.muted?'active':''} onClick={()=>actions().updateTrack(track.id,{muted:!track.muted})}>M</IconButton><IconButton label={`Solo ${track.name}`} className={`track-solo ${track.solo?'solo-active':''}`} onClick={()=>actions().updateTrack(track.id,{solo:!track.solo})}>S</IconButton></>}</div></div>
              <div role="separator" aria-label={`Resize ${track.name}`} aria-orientation="horizontal" tabIndex={0} className="panel-resizer horizontal track-resizer"
                onPointerDown={e=>{
                  if(e.button!==0||!actions().acquireLock(track.id,'*'))return;
                  const row=e.currentTarget.closest('.timeline-track') as HTMLElement,rect=row.getBoundingClientRect();
                  // Height follows the pointer against the row's fixed top edge, so the drag never drifts.
                  trackResize.current={id:track.id,top:rect.top,scale:rect.height/row.offsetHeight,height:track.height??row.offsetHeight,gesture:`track-height:${track.id}:${Date.now()}`};
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={e=>{const r=trackResize.current;if(r){r.height=Math.round(Math.max(24,Math.min(200,(e.clientY-r.top)/r.scale)));publishFrame(()=>{setHeightDraft({id:r.id,height:r.height});useEditorStore.setState({dragPreview:{tracks:[{id:r.id,height:r.height}]}});});}}}
                onPointerUp={()=>finishTrackResize()} onPointerCancel={()=>finishTrackResize(true)} onLostPointerCapture={()=>{if(trackResize.current)finishTrackResize(true);}}
                onKeyDown={e=>{const step=e.key==='ArrowUp'?-6:e.key==='ArrowDown'?6:0;if(!step)return;e.preventDefault();actions().updateTrack(track.id,{height:(track.height??(e.currentTarget.closest('.timeline-track') as HTMLElement).offsetHeight)+step});}}/>
            </div>
            <div className="track-lane" tabIndex={0} data-track={track.id} data-cursor-anchor={track.id} data-time-span={width/pixels} style={{width}} onPointerDown={e=>{if(e.target===e.currentTarget){const found=trackGap(clips.filter(c=>c.trackId===track.id),(e.clientX-e.currentTarget.getBoundingClientRect().left)/screenPixels());setGap(found?{trackId:track.id,...found}:null);e.currentTarget.focus();}}} onDragOver={e=>{
              if(e.dataTransfer.types.includes('application/x-frameline-transition')){
                e.preventDefault();
                const time=(e.clientX-e.currentTarget.getBoundingClientRect().left)/screenPixels();
                const cut=track.kind==='video'&&!track.locked?nearestCut(clips,track.id,timelineId,time,CUT_SNAP/screenPixels()):null;
                e.dataTransfer.dropEffect=cut?'copy':'none';
                // The ghost shows the real name, the real length after the handles clamp it, and
                // where it will sit across the cut — not just a line saying "somewhere near here".
                setCutTarget(cut?(()=>{
                  const name=draggingTransition?.name??'Transition';
                  const preferred=Number(String(actions().settings.defaultTransitionDuration??'').match(/[\d.]+/)?.[0]);
                  const wanted=Number.isFinite(preferred)&&preferred>0?preferred:transitionDefinitions[name]?.defaultDuration??1;
                  // Preview the alignment the drop will actually pick, so a cut whose handles are
                  // one-sided shows the window sitting where it fits instead of straddling the cut.
                  const align=bestAlign(clips,cut.clip,cut.side,media,wanted);
                  const room=maximumDuration(clips,cut.clip,cut.side,align,media,true);
                  const duration=Math.max(1/48,Math.min(wanted,room||wanted));
                  return {trackId:track.id,name,duration,start:Math.max(0,cut.cut-duration*alignShare(align)),fits:room>=1/48};
                })():null);
                return;
              }
              if(!e.dataTransfer.types.includes('application/x-frameline-media'))return;e.preventDefault();const preview=mediaPlacement(e,track.id);e.dataTransfer.dropEffect=preview?'copy':'none';setDropDraft(preview);}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node)){setDropDraft(null);setCutTarget(null);}}} onDrop={e=>{
              const dropped=e.dataTransfer.getData('application/x-frameline-transition');
              if(dropped){
                e.preventDefault();e.stopPropagation();setCutTarget(null);
                const time=(e.clientX-e.currentTarget.getBoundingClientRect().left)/screenPixels();
                const cut=nearestCut(clips,track.id,timelineId,time,CUT_SNAP/screenPixels());
                if(!cut){actions().notify('Drop a transition on a cut between clips, or on the open end of one','info');return;}
                try {
                  const payload=JSON.parse(dropped) as {name:string;params?:Record<string,number|string>};
                  if(transitionDefinitions[payload.name])actions().addTransition(cut.clip.id,cut.side,payload.name,{params:payload.params});
                } catch { actions().notify('That transition could not be read','error'); }
                return;
              }
              const id=e.dataTransfer.getData('application/x-frameline-media');if(!id)return;e.preventDefault();e.stopPropagation();const preview=mediaPlacement(e,track.id);setDropDraft(null);if(preview){if(id.startsWith('title:'))actions().addTitle(Number(id.split(':')[1]),{},preview,!id.endsWith(':static'));else if(id.startsWith('shape:'))actions().addShape(id.slice(6),{},preview);else if(id.startsWith('sfx-')){const pending={...preview,id:crypto.randomUUID()};setPendingSounds(items=>[...items,pending]);void insertSound(id,preview.start,track.id).finally(()=>setPendingSounds(items=>items.filter(item=>item.id!==pending.id)));}else actions().addMediaToTimeline(id.split('\n'),preview.start,track.id);}useEditorStore.setState({draggingMediaId:null});}}>
              {livePreviews.flatMap(person => (person.preview?.clips ?? []).filter(c => c.trackId === track.id).map(c => <div key={`remote-${person.userId}-${c.id}`} className="timeline-drop-ghost" data-remote-preview={c.id} style={{left:c.start*pixels,width:Math.max(12,c.duration*pixels),pointerEvents:'none'}}><span>{users.find(u=>u.id===person.userId)?.name} · {clips.find(clip=>clip.id===c.id)?.name}</span></div>))}
              {pendingSounds.filter(item=>item.trackId===track.id).map(item=><div key={item.id} className="timeline-drop-ghost" role="status" style={{left:item.start*pixels,width:Math.max(12,item.duration*pixels)}}><AudioLines size={12}/><span>{item.name}<small>Adding sound…</small></span></div>)}
              {gap?.trackId===track.id&&<div className="timeline-gap" aria-label="Selected gap; Delete to close" style={{left:gap.start*pixels,width:(gap.end-gap.start)*pixels}}/>}
              {clips.filter(c=>c.trackId===track.id).flatMap(clip=>(!drag.current?.ids.includes(clip.id)&&clip.id!==draft?.id?(movePlacements.length?movePlacements.filter(c=>c.trackId===track.id):lanePlacement?.trackId===track.id?[lanePlacement]:[]).reduce<Clip[]>((parts,p)=>parts.flatMap(part=>uncoveredParts(part,p.start,p.start+p.duration)),[clip]):[clip]).map((part,index)=>({clip,part,index}))).map(({clip,part,index})=>{const asset=media.find(m=>m.id===clip.mediaId);const primary=clips.find(c=>c.id===draft?.id),partner=draft&&drag.current?.mode==='move'&&drag.current.ids.includes(clip.id)&&clip.id!==draft.id||linked&&draft&&primary?.properties.linkGroup&&primary.properties.linkGroup===clip.properties.linkGroup;const position=draft?.id===clip.id?(draft.trackId&&draft.trackId!==clip.trackId?clip:draft):partner?{...part,start:clip.start+draft.start-primary!.start,duration:clip.duration+draft.duration-primary!.duration}:part;const predicted=movePlacements.find(c=>c.id===clip.id);const selected=selectedId===clip.id||selectedIds.includes(clip.id);const linkedSelected=linked&&clip.properties.linkGroup&&clip.properties.linkGroup===clips.find(c=>c.id===selectedId)?.properties.linkGroup;const collaborator=users.find(u=>u.id===selectedBy[clip.id]);const owner=locks.find(l=>l.targetId===clip.id&&l.field==='manipulation');const color=selected||linkedSelected?ownColor:collaborator?.color;return <div key={`${clip.id}-${index}`} data-clip={clip.id} role="button" tabIndex={0} aria-label={`${clip.name}, ${timecode(clip.start)}, ${Math.round(clip.duration)} seconds`} aria-pressed={selected} className={`timeline-clip ${staleCaptions.has(String(clip.properties.captionSet))?'caption-stale':''} ${track.kind} ${selected?'selected':''} ${linkedSelected?'linked-selected':''} ${draft?.id===clip.id?'dragging':''} ${predicted&&predicted.trackId!==clip.trackId||draft?.id===clip.id&&draft.trackId&&draft.trackId!==clip.trackId?'drag-origin':''} ${isComposition(clip)?'composition-clip':''} ${isShape(clip)?'shape-clip':''} ${clip.disabled?'clip-disabled':''} ${owner?'owned':''} ${effectTarget===clip.id?'effect-drop-target':''}`} style={{left:(predicted&&predicted.trackId!==clip.trackId?clip.start:position.start)*pixels,width:Math.max(12,position.duration*pixels),'--clip-color':clip.color,'--selection-color':color??'transparent'} as CSSProperties} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-frameline-effect')){e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=track.locked?'none':'copy';if(!track.locked)setEffectTarget(clip.id);}}} onDragLeave={()=>setEffectTarget(null)} onDrop={e=>{const name=e.dataTransfer.getData('application/x-frameline-effect');if(!name)return;e.preventDefault();e.stopPropagation();setEffectTarget(null);if(!track.locked&&acceptsEffect(clip,asset?.kind,name))actions().addEffect(clip.id,name);}} onPointerDown={e=>startDrag(e,clip,'move')} onPointerMove={moveDrag} onPointerUp={()=>finishDrag()} onPointerCancel={()=>finishDrag(true)} onLostPointerCapture={()=>{if(drag.current)finishDrag(true);}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();if(e.key==='Enter'&&isComposition(clip))actions().openComposition(clip.id);else actions().selectClip(clip.id);}if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();actions().moveClip(clip.id,clip.start+(e.key==='ArrowRight'?1:-1)/(project?.fps||24));}}} onDoubleClick={e=>{e.stopPropagation();if(isComposition(clip))actions().openComposition(clip.id);}} onContextMenu={e=>{e.preventDefault();if(!actions().selectedClipIds.includes(clip.id))actions().selectClip(clip.id);setMenu({x:e.clientX,y:e.clientY,id:clip.id});}}>
                {track.kind==='video'&&!isTitle(clip)&&!isShape(clip)&&!isComposition(clip)&&asset?.kind!=='audio'&&<ClipFilmstrip asset={asset} clip={clip} pixels={pixels}/>}
                <div className="clip-label">{isTitle(clip)?<Type size={10}/>:isShape(clip)?<Shapes size={10}/>:isComposition(clip)?<Layers size={10}/>:track.kind==='audio'?<AudioLines size={10}/>:<Film size={10}/>}<span>{clip.name}</span>{clip.properties.linkGroup&&<Link2 size={10} aria-label="Linked audio/video"/>}{collaborator&&!selected&&<span className="clip-remote-name" style={{color:collaborator.color}}>{collaborator.name}</span>}{owner&&<span className="clip-activity" style={{background:users.find(u=>u.id===owner.userId)?.color}}/>}</div>
                <ClipActivityBar clipId={clip.id} cacheable={!!asset&&asset.kind!=='image'&&!clip.disabled&&(track.kind==='video'?!track.hidden:!track.muted)}/>
                {track.kind==='audio'&&<Waveform samples={asset?.waveform} from={clip.sourceIn/(asset?.duration||1)} to={(clip.sourceIn+clip.duration*Number(clip.properties.speed||100)/100)/(asset?.duration||1)} reverse={Boolean(clip.properties.reverse)}/>}
                {Object.keys(clip.keyframes??{}).length>0&&<KeyframeLanes inline clips={[clip]} pixels={pixels} width={clip.duration*pixels} visibleStart={0} visibleEnd={clip.duration*pixels}/>}
                <ClipFades clip={clip} audio={track.kind==='audio'} pixels={pixels} fps={fps}/>
<div className="trim-handle trim-left" title="Trim start" onPointerDown={e=>startDrag(e,clip,'left')}/><div className="trim-handle trim-right" title="Trim end" onPointerDown={e=>startDrag(e,clip,'right')}/>
              </div>;})}
              {movePlacements.filter(c=>c.id!==draft?.id&&c.trackId===track.id&&c.trackId!==clips.find(original=>original.id===c.id)?.trackId).map(c=><div key={`ghost-${c.id}`} className="timeline-drop-ghost" aria-label={`Place ${c.name} at ${timecode(c.start,project?.fps)}`} style={{left:c.start*pixels,width:Math.max(12,c.duration*pixels)}}><Layers size={12}/><span>{c.name}<small>{timecode(c.start,project?.fps)}</small></span></div>)}
              {lanePlacement&&lanePlacement.trackId===track.id&&(dropDraft||draft?.trackId&&draft.trackId!==moved?.trackId)&&<div className="timeline-drop-ghost" aria-label={`Place ${lanePlacement.name} at ${timecode(lanePlacement.start,project?.fps)}`} style={{left:lanePlacement.start*pixels,width:Math.max(12,lanePlacement.duration*pixels)}}>{track.kind==='audio'?<AudioLines size={12}/>:draggingMediaId?.startsWith('title:')||moved&&isTitle(moved)?<Type size={12}/>:<Film size={12}/>}<span>{lanePlacement.name}<small>{timecode(lanePlacement.start,project?.fps)} · {lanePlacement.duration.toFixed(2)}s</small></span></div>}
              {track.kind==='video'&&<TransitionChips trackId={track.id} timelineId={timelineId} pixels={pixels}/>}
              {cutTarget?.trackId===track.id&&<div className={`transition-chip ghost ${cutTarget.fits?'':'clamped'}`} style={{left:cutTarget.start*pixels,width:Math.max(10,cutTarget.duration*pixels)}} aria-hidden="true"><span className="transition-chip-bowtie"/><span className="transition-chip-label">{cutTarget.fits?cutTarget.name:'No handles'}</span></div>}
            </div>
          </div>{expandedTracks.includes(track.id)&&<KeyframeLanes clips={clips.filter(c=>c.trackId===track.id)} pixels={pixels} width={width} visibleStart={Math.max(0,viewport.left-164)} visibleEnd={Math.min(width,viewport.left+viewport.width-164)}/>}</Fragment>;})}
          {snapLine!==undefined&&<div className="timeline-snap-line" aria-hidden="true" style={{left:164,transform:`translateX(${snapLine*pixels}px)`}}/>}
          <TimelinePlayheads pixels={pixels} color={ownColor} scrub={scrub} scrubMove={scrubMove}/>
        </div>
      </div>
    </div>
    {trackMenu&&(()=>{const t=tracks.find(t=>t.id===trackMenu.id);if(!t)return null;const act=(run:()=>void)=>{setTrackMenu(null);run();};return <ContextMenu x={trackMenu.x} y={trackMenu.y} onClose={()=>setTrackMenu(null)}>
      <span className="menu-heading">{t.kind==='video'?'V':'A'}{t.number} · {t.name}</span>
      <button role="menuitem" onClick={()=>act(()=>setRenaming({id:t.id,value:t.name}))}><Type/>Rename track</button>
      <button role="menuitem" onClick={()=>act(()=>actions().moveTrack(t.id,'up'))}><ChevronUp/>Move up</button>
      <button role="menuitem" onClick={()=>act(()=>actions().moveTrack(t.id,'down'))}><ChevronDown/>Move down</button>
      <div className="divider"/>
      <button role="menuitem" onClick={()=>act(()=>actions().createTrack(t.kind))}><Plus/>Add {t.kind} track</button>
      <button role="menuitem" className="danger-text" onClick={()=>act(()=>actions().deleteTrack(t.id))}><Trash2/>Delete track</button>
    </ContextMenu>;})()}
    {menu&&menuClip&&<ContextMenu x={menu.x} y={menu.y} onClose={()=>setMenu(null)}><span className="menu-heading">{selectedIds.length>1?`${selectedIds.length} clips`:menuClip.name}</span><button role="menuitem" onClick={()=>menuAction(()=>actions().createComposition(`Composition ${timelines.filter(t=>t.composition).length+1}`))}><Layers/>Create composition</button>{isComposition(menuClip)&&<button role="menuitem" onClick={()=>menuAction(()=>actions().openComposition(menuClip.id))}><Layers/>Open composition</button>}<div className="divider"/><button role="menuitem" onClick={()=>menuAction(()=>{actions().copyClip(menuClip.id);actions().deleteClip(menuClip.id);})}><Scissors/>Cut<kbd>⌘X</kbd></button><button role="menuitem" onClick={()=>menuAction(()=>actions().copyClip(menuClip.id))}><Copy/>Copy<kbd>⌘C</kbd></button><button role="menuitem" onClick={()=>menuAction(()=>actions().duplicateClip(menuClip.id))}><Clipboard/>Duplicate<kbd>⌘D</kbd></button><div className="divider"/><button role="menuitem" onClick={()=>menuAction(()=>actions().splitClip(menuClip.id))}><Scissors/>Split at playhead<kbd>⌘B</kbd></button><button role="menuitem" onClick={()=>menuAction(()=>actions().applyTransitionAtPlayhead())}><ArrowRightLeft/>Add transition at nearest cut<kbd>⌘T</kbd></button><button role="menuitem" onClick={()=>menuAction(()=>{actions().setSidePanel('inspector');requestAnimationFrame(()=>document.getElementById('property-speed')?.focus());})}><Gauge/>Change speed</button><button role="menuitem" onClick={()=>menuAction(()=>actions().updateProperty(menuClip.id,'disabled',!menuClip.disabled))}><EyeOff/>{menuClip.disabled?'Enable':'Disable'} clip</button><div className="divider"/><button role="menuitem" onClick={()=>menuAction(()=>menuClip.properties.linkGroup?actions().unlinkClip(menuClip.id):actions().linkClip(menuClip.id))}><Link2/>{menuClip.properties.linkGroup?'Unlink audio/video':'Link matching audio/video'}</button><button role="menuitem" onClick={()=>menuAction(()=>actions().setWorkspace('color'))}><Palette/>Color</button>{tracks.find(t=>t.id===menuClip.trackId)?.kind==='audio'&&media.some(m=>m.id===menuClip.mediaId&&m.hasAudio)&&<button role="menuitem" onClick={()=>menuAction(()=>setSaveSound(structuredClone(menuClip)))}><AudioLines/>Save as Sound Effect</button>}<button role="menuitem" onClick={()=>menuAction(()=>actions().setWorkspace('audio'))}><Music2/>Audio</button><button role="menuitem" onClick={()=>menuAction(()=>{actions().revealMedia(menuClip.mediaId);})}><FolderSearch/>Reveal in Media</button><button role="menuitem" onClick={()=>menuAction(()=>actions().setSidePanel('inspector'))}><Info/>Clip properties</button><div className="divider"/><button role="menuitem" className="danger-text" onClick={()=>menuAction(()=>actions().deleteClip(menuClip.id))}><Trash2/>Delete<kbd>⌫</kbd></button></ContextMenu>}
    {saveSound&&<SaveSoundEffect clip={saveSound} onClose={()=>setSaveSound(null)}/>}
  </section>;
}
