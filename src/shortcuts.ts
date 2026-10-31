import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { useEditorStore } from './state/store';
import { fieldOwnsKey, typingSurface } from './services/focus';
export const shortcuts = [ ['Space','Play / pause'], ['← / →','Previous / next frame'], ['⌘ / Ctrl + Z','Undo my eligible action'], ['⌘ / Ctrl + Shift + Z, Ctrl + Y','Redo what I undid'], ['⌘ / Ctrl + S','Save snapshot'], ['⌘ / Ctrl + B','Split selected at playhead'], ['⌘ / Ctrl + C','Copy selected clip'], ['⌘ / Ctrl + X','Cut selected clip'], ['⌘ / Ctrl + V','Paste clip at playhead'], ['⌘ / Ctrl + Shift + V','Paste and push later clips right (insert)'], ['⌘ / Ctrl + drop','Insert media instead of overwriting'], [', / .','Insert / overwrite the selected bin media at the playhead'], ['I / O','Mark In / Out'], ['V / B / A','Selection / blade / select forward tool'], ['R / E / Y / U','Ripple trim / roll / slip / slide tool'], ['J / K / L','Play backward / stop / play forward (press again for 2×, 4×, 8×)'], ['K + J / K + L','Step one frame back / forward'], ['F','Match frame: show the clip’s media in the bin'], ['T','Draw text box'], ['S / P','Shape / pen tool'], ['Shift + click / drag','Select clips or keyframes'], ['N','Toggle snapping'], ['M','Add marker at playhead'], ['Right-click ruler','Add marker here, paste markers'], ['Delete','Delete selected clip'], ['Shift + Delete','Ripple delete: delete and close the gap'], ['Enter','Script: next element'], ['Shift + Enter','Script: line break'], ['Tab / Shift + Tab','Script: change element'], ['Backspace at line start','Script: join with the line above'], ['Space + drag','Board: pan'], ['Shift + drag','Board: select an area'], ['⌘ / Ctrl + D','Board: duplicate the selected cards'], ['Arrows / Shift + arrows','Board: nudge cards 1 / 10 px'], ['⌘ / Ctrl + wheel or pinch','Board: zoom'] ];
/** A click is an action, not a focus grab. Editing apps keep the keyboard on the app, so Space plays
 *  instead of replaying the last button touched — and nothing sits there wearing a focus ring. */
export function useFocusRelease() {
  useEffect(()=>{
    const release=(event:PointerEvent)=>{
      const target=event.target as Element|null;
      // A native dropdown owns its popup: blurring it closes the menu before you can pick.
      // Space is still safe over one — the handler below cancels the key before the popup opens.
      // [data-keep-focus]: toolbar buttons beside a text field (the script's element picker) act on it without taking its caret.
      if(typingSurface(target)||target?.closest('label,select,[role="combobox"],[aria-haspopup],[data-keep-focus]'))return;
      const active=document.activeElement;
      // Keep timeline lanes focused so selected gaps receive Delete.
      if(active instanceof HTMLElement&&(typingSurface(active)||active.matches('button,input,select')))active.blur();
    };
    // Commit typed values before a timeline click changes the frame they belong to.
    document.addEventListener('pointerdown',release,true);
    document.addEventListener('pointerup',release);
    return()=>{document.removeEventListener('pointerdown',release,true);document.removeEventListener('pointerup',release);};
  },[]);
}
// J/K/L shuttle. Forward at 1× is ordinary playback; faster or backwards steps the paused playhead a frame at a time on the
// display clock (playback only runs forward at 1×). Anything else moving the playhead, a click or Space, takes over.
let shuttleRate=0,shuttleFrame=0,kHeld=false;
export function shuttle(rate:number) {
  cancelAnimationFrame(shuttleFrame);shuttleRate=0;
  const s=useEditorStore.getState();
  if(rate===1){s.setPlaying(true);return;}
  if(s.playing)s.setPlaying(false);
  if(!rate)return;
  shuttleRate=rate;
  let time=s.playhead,last=performance.now(),shown=s.playhead;
  const step=(now:number)=>{
    const s=useEditorStore.getState(),fps=s.projects.find(p=>p.id===s.projectId)?.fps||24;
    if(s.playing||s.playhead!==shown){shuttleRate=0;return;}
    time+=(now-last)/1000*rate;last=now;
    const frame=Math.max(0,Math.round(time*fps)/fps);
    if(frame!==shown){s.setPlayhead(frame);shown=useEditorStore.getState().playhead;}
    // Stops at either end: time zero, or where setPlayhead clamped it.
    if(time<=0||shown!==frame){shuttleRate=0;return;}
    shuttleFrame=requestAnimationFrame(step);
  };
  shuttleFrame=requestAnimationFrame(step);
}
function shuttleKey(key:string) {
  const s=useEditorStore.getState(),speed=shuttleRate||(s.playing?1:0);
  if(key==='k'){kHeld=true;shuttle(0);return;}
  if(kHeld){shuttle(0);s.setPlayhead(s.playhead+(key==='l'?1:-1)/(s.projects.find(p=>p.id===s.projectId)?.fps||24));return;}
  shuttle(key==='l'?(speed>0?Math.min(8,speed*2):1):(speed<0?Math.max(-8,speed*2):-1));
}
export function useEditorShortcuts(enabled: boolean) {
  useEffect(()=>{
    if(!enabled)return;
    const keyup=(e:KeyboardEvent)=>{if(e.key.toLowerCase()==='k')kHeld=false;};
    const blur=()=>{kHeld=false;};
    const keydown=(e:KeyboardEvent)=>{
      const target=e.target as HTMLElement;
      if(e.defaultPrevented)return;
      if(fieldOwnsKey(target,e.key))return;
      const s=useEditorStore.getState();const command=e.metaKey||e.ctrlKey;
      // Plan has no clips, bins or playhead on screen: only undo, redo and the snapshot stay, so Delete or Space never act out of sight.
      if(s.workspace==='plan'&&!(command&&['s','z','y'].includes(e.key.toLowerCase())))return;
      if(s.workspace==='color'&&command&&['c','v'].includes(e.key.toLowerCase())){e.preventDefault();if(s.selectedClipId){if(e.key.toLowerCase()==='c')s.copyGrade(s.selectedClipId);else s.pasteGrade(s.selectedClipId);}return;}
      if(s.workspace==='color'&&((command&&e.key.toLowerCase()==='d')||e.key==='Backspace'||e.key==='Delete')){e.preventDefault();const node=s.nodes.find(n=>n.id===s.selectedNodeId&&n.clipId===s.selectedClipId);if(node){if(command)s.updateNode(node.id,{enabled:!node.enabled});else s.removeNode(node.id);}return;}
      // Selected markers own Delete and ⌘C; copied markers own ⌘V until a clip is copied.
      if(s.selectedMarkerIds.length&&(e.key==='Delete'||e.key==='Backspace')){e.preventDefault();s.deleteMarkers(s.selectedMarkerIds);return;}
      if(s.selectedMarkerIds.length&&command&&e.key.toLowerCase()==='c'){e.preventDefault();s.copyMarkers(s.selectedMarkerIds);return;}
      if(s.selectedMarkerIds.length&&command&&e.key.toLowerCase()==='x'){e.preventDefault();s.copyMarkers(s.selectedMarkerIds);s.deleteMarkers(s.selectedMarkerIds);return;}
      if(s.markerClipboard&&command&&e.key.toLowerCase()==='v'){e.preventDefault();s.pasteMarkers();return;}
      if(s.selectedMarkerIds.length&&e.key==='Escape'){useEditorStore.setState({selectedMarkerIds:[]});return;}
      if(command&&e.key.toLowerCase()==='s'){e.preventDefault();s.setModal('snapshot');}
      else if(command&&e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey)s.redo();else s.undo();}
      else if(e.ctrlKey&&!e.metaKey&&e.key.toLowerCase()==='y'){e.preventDefault();s.redo();}
      else if(command&&e.key.toLowerCase()==='b'&&s.selectedClipId){e.preventDefault();s.splitClip(s.selectedClipId);}
      else if(command&&e.key.toLowerCase()==='c'&&s.selectedMediaIds.length){e.preventDefault();s.copyMedia(s.selectedMediaIds);}
      else if(command&&e.key.toLowerCase()==='c'&&s.selectedClipId){e.preventDefault();s.copyClip(s.selectedClipId);}
      else if(command&&e.key.toLowerCase()==='x'&&s.selectedClipId){e.preventDefault();s.copyClip(s.selectedClipId);s.deleteClip(s.selectedClipId);}
      else if(command&&e.key.toLowerCase()==='v'){e.preventDefault();s.pasteClip(e.shiftKey);}
      else if(command&&e.key.toLowerCase()==='d'&&s.selectedClipId){e.preventDefault();s.duplicateClip(s.selectedClipId);}
      else if(command&&e.key.toLowerCase()==='t'){e.preventDefault();s.applyTransitionAtPlayhead();}
      else if(e.code==='Space'){e.preventDefault();if(s.liveMode!=='following')s.setPlaying(!s.playing);}
      // From the bin: `,` inserts at the playhead (later clips move right), `.` overwrites, on the first unlocked track with its linked sound.
      else if(!command&&!e.altKey&&(e.key===','||e.key==='.')&&s.workspace==='edit'&&s.media.some(m=>s.selectedMediaIds.includes(m.id)&&m.projectId===s.projectId)){e.preventDefault();if(!e.repeat)s.addMediaToTimeline(s.selectedMediaIds.filter(id=>s.media.some(m=>m.id===id&&m.projectId===s.projectId)),s.playhead,undefined,e.key===',');}
      else if(!command&&!e.altKey&&['j','k','l'].includes(e.key.toLowerCase())&&s.liveMode!=='following'){e.preventDefault();if(!e.repeat)shuttleKey(e.key.toLowerCase());}
      // Match frame: the clip under the playhead (or the selected one) shows its media in the bin.
      else if(!command&&!e.altKey&&e.key.toLowerCase()==='f'&&s.workspace==='edit'){const clip=s.clips.find(c=>c.id===s.selectedClipId)??s.clips.filter(c=>c.timelineId===s.timelineId&&!c.disabled&&c.start<=s.playhead&&c.start+c.duration>s.playhead&&s.tracks.find(t=>t.id===c.trackId)?.kind==='video').sort((a,b)=>(s.tracks.find(t=>t.id===b.trackId)?.number??0)-(s.tracks.find(t=>t.id===a.trackId)?.number??0))[0];if(clip){e.preventDefault();s.revealMedia(null);s.revealMedia(clip.mediaId);}}
      else if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&s.liveMode!=='following'){e.preventDefault();s.setPlayhead(s.playhead+(e.key==='ArrowRight'?1:-1)/(s.projects.find(p=>p.id===s.projectId)?.fps||24));}
      else if((e.key==='Delete'||e.key==='Backspace')&&s.selectedTransition){e.preventDefault();s.removeTransition(s.selectedTransition.clipId,s.selectedTransition.side);}
      else if((e.key==='Delete'||e.key==='Backspace')&&s.selectedClipId){e.preventDefault();s.deleteClip(s.selectedClipId,e.shiftKey);}
    };
    document.addEventListener('keydown',keydown);document.addEventListener('keyup',keyup);window.addEventListener('blur',blur);
    return()=>{document.removeEventListener('keydown',keydown);document.removeEventListener('keyup',keyup);window.removeEventListener('blur',blur);};
  },[enabled]);
}

export function useTimelineShortcuts(setTool: Dispatch<SetStateAction<string>>, setSnapping: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || fieldOwnsKey(e.target as Element, e.key)) return;
      const s = useEditorStore.getState();
      const k = e.key.toLowerCase();
      if (k === 'v') { setTool('select'); useEditorStore.setState({textTool:false,shapeTool:null}); }
      if (k === 't') { useEditorStore.setState({textTool:!s.textTool,shapeTool:null,playing:false}); }
      if (k === 'b') {setTool('blade');useEditorStore.setState({textTool:false,shapeTool:null});}
      if (k === 'a') {setTool('forward');useEditorStore.setState({textTool:false,shapeTool:null});}
      const trim = ({ r: 'ripple', e: 'roll', y: 'slip', u: 'slide' } as Record<string, string>)[k];
      if (trim) {setTool(trim);useEditorStore.setState({textTool:false,shapeTool:null});}
      if (k === 's' || k === 'p') {setTool('select');useEditorStore.setState({shapeTool:k==='p'?'pen':'rectangle',textTool:false,playing:false});}
      if (k === 'n') setSnapping(value => !value);
      if (k === 'm' && !e.repeat) s.addMarker();
      if (k === 'i') s.setRange(s.playhead, s.rangeOut);
      if (k === 'o') s.setRange(s.rangeIn, s.playhead);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [setTool, setSnapping]);
}
