import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { useEditorStore } from './state/store';
import { fieldOwnsKey, typingSurface } from './services/focus';
export const shortcuts = [ ['Space','Play / pause'], ['← / →','Previous / next frame'], ['⌘ / Ctrl + Z','Undo my eligible action'], ['⌘ / Ctrl + S','Save snapshot'], ['⌘ / Ctrl + B','Split selected at playhead'], ['⌘ / Ctrl + C','Copy selected clip'], ['⌘ / Ctrl + V','Paste clip at playhead'], ['I / O','Mark In / Out'], ['V / B / A','Selection / blade / select forward tool'], ['T','Draw text box'], ['S / P','Shape / pen tool'], ['Shift + click / drag','Select clips or keyframes'], ['N','Toggle snapping'], ['Delete','Delete selected clip'] ];
/** A click is an action, not a focus grab. Editing apps keep the keyboard on the app, so Space plays
 *  instead of replaying the last button touched — and nothing sits there wearing a focus ring. */
export function useFocusRelease() {
  useEffect(()=>{
    const release=(event:PointerEvent)=>{
      const target=event.target as Element|null;
      // A native dropdown owns its popup: blurring it closes the menu before you can pick.
      // Space is still safe over one — the handler below cancels the key before the popup opens.
      if(typingSurface(target)||target?.closest('label,select,[role="combobox"],[aria-haspopup]'))return;
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
export function useEditorShortcuts(enabled: boolean) {
  useEffect(()=>{
    if(!enabled)return;
    const keydown=(e:KeyboardEvent)=>{
      const target=e.target as HTMLElement;
      if(e.defaultPrevented)return;
      if(fieldOwnsKey(target,e.key))return;
      const s=useEditorStore.getState();const command=e.metaKey||e.ctrlKey;
      if(s.workspace==='color'&&command&&['c','v'].includes(e.key.toLowerCase())){e.preventDefault();if(s.selectedClipId){if(e.key.toLowerCase()==='c')s.copyGrade(s.selectedClipId);else s.pasteGrade(s.selectedClipId);}return;}
      if(s.workspace==='color'&&((command&&e.key.toLowerCase()==='d')||e.key==='Backspace'||e.key==='Delete')){e.preventDefault();const node=s.nodes.find(n=>n.id===s.selectedNodeId&&n.clipId===s.selectedClipId);if(node){if(command)s.updateNode(node.id,{enabled:!node.enabled});else s.removeNode(node.id);}return;}
      if(command&&e.key.toLowerCase()==='s'){e.preventDefault();s.setModal('snapshot');}
      else if(command&&e.key.toLowerCase()==='z'){e.preventDefault();s.undo();}
      else if(command&&e.key.toLowerCase()==='b'&&s.selectedClipId){e.preventDefault();s.splitClip(s.selectedClipId);}
      else if(command&&e.key.toLowerCase()==='c'&&s.selectedClipId){e.preventDefault();s.copyClip(s.selectedClipId);}
      else if(command&&e.key.toLowerCase()==='v'){e.preventDefault();s.pasteClip();}
      else if(command&&e.key.toLowerCase()==='d'&&s.selectedClipId){e.preventDefault();s.duplicateClip(s.selectedClipId);}
      else if(command&&e.key.toLowerCase()==='t'){e.preventDefault();s.applyTransitionAtPlayhead();}
      else if(e.code==='Space'){e.preventDefault();if(s.liveMode!=='following')s.setPlaying(!s.playing);}
      else if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&s.liveMode!=='following'){e.preventDefault();s.setPlayhead(s.playhead+(e.key==='ArrowRight'?1:-1)/(s.projects.find(p=>p.id===s.projectId)?.fps||24));}
      else if((e.key==='Delete'||e.key==='Backspace')&&s.selectedTransition){e.preventDefault();s.removeTransition(s.selectedTransition.clipId,s.selectedTransition.side);}
      else if((e.key==='Delete'||e.key==='Backspace')&&s.selectedClipId){e.preventDefault();s.deleteClip(s.selectedClipId);}
    };
    document.addEventListener('keydown',keydown);return()=>document.removeEventListener('keydown',keydown);
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
      if (k === 's' || k === 'p') {setTool('select');useEditorStore.setState({shapeTool:k==='p'?'pen':'rectangle',textTool:false,playing:false});}
      if (k === 'n') setSnapping(value => !value);
      if (k === 'i') s.setRange(s.playhead, s.rangeOut);
      if (k === 'o') s.setRange(s.rangeIn, s.playhead);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [setTool, setSnapping]);
}
