import type {CSSProperties} from 'react';
import {RotateCcw,Wand2} from 'lucide-react';
import {useStoreWithoutPlayhead} from '../state/store';
import type {Clip} from '../state/models';
import {primaryDefaults} from '../services/color';
import {neutralValue} from '../services/colorPresets';
import {colorGroupOf,colorGroups,groupNodeOf} from '../services/colorGroups';
import {Parameter} from '../workspaces/ColorTools';
import {Badge,Button} from './ui';

const CONTROLS=[['Exposure','exposure',-3,3,.01],['Temperature','temperature',-2000,2000,10],['Tint','tint',-50,50,1],['Contrast','contrast',.5,2,.01],['Saturation','saturation',0,200,1]] as const;

/** Color page Groups tab: Normalize & Group the picked shots, and the project's color groups with the shown shot's group's shared grade. */
export default function ColorGroupsPanel({shots,current,gesture,onNormalize}:{shots:Clip[];current?:Clip;gesture:{current:string|undefined};onNormalize:(clipIds:string[],group?:string)=>void}){
  const s=useStoreWithoutPlayhead(),groups=colorGroups(s.clips.filter(c=>c.projectId===s.projectId),s.nodes),mine=colorGroupOf(current);
  const picked=shots.filter(c=>s.selectedClipIds.includes(c.id)).map(c=>c.id),ids=picked.length?picked:current?[current.id]:[];
  // The shown shot stays shown when it is among them; otherwise the first one is shown (the Color page keeps a selection only around the shown shot).
  const select=(clipIds:string[])=>{const list=shots.filter(c=>clipIds.includes(c.id)),first=list.find(c=>c.id===current?.id)??list[0];if(!first)return;s.setPlaying(false);s.selectClips([...list.filter(c=>c!==first).map(c=>c.id),first.id]);
    if(first!==current){const fps=s.projects.find(p=>p.id===s.projectId)?.fps||24;s.setPlayhead(first.start+Math.floor(Math.round(first.duration*fps)/2)/fps);}};
  return <div className="color-groups">
    <p>Balance shots so they look correct and match, then grade them together as a group.</p>
    <Button variant="primary" disabled={!ids.length} onClick={()=>onNormalize(ids)}><Wand2 size={13}/>Normalize & Group {ids.length} shot{ids.length===1?'':'s'}…</Button>
    {ids.length===1&&shots.length>1&&<small className="color-groups-hint">Cmd/Ctrl-click shots to pick more, or <button onClick={()=>select(shots.map(c=>c.id))}>All shots</button></small>}
    {groups.length?<ul className="color-group-list" aria-label="Color groups">{groups.map(g=>{const open=g.id===mine&&g.node,p={...primaryDefaults,...(open&&s.nodes.find(n=>n.clipId===current?.id&&n.group===g.id)||g.node)?.parameters}; // the shown shot's own values, so a slider follows what it changes
      return <li key={g.id} className={open?'open':undefined} style={{'--group-color':g.color} as CSSProperties}>
        <div className="color-group-row"><i className="group-dot" aria-hidden/><input key={g.name} aria-label={`Name of ${g.name}`} defaultValue={g.name} maxLength={60} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){e.currentTarget.value=g.name;e.currentTarget.blur();}}} onBlur={e=>{const name=e.currentTarget.value.trim();if(name&&name!==g.name)s.renameColorGroup(g.id,name);else e.currentTarget.value=g.name;}}/><Badge>{g.clipIds.length} shot{g.clipIds.length===1?'':'s'}</Badge></div>
        <div className="color-group-actions"><button onClick={()=>select(g.clipIds)}>Select shots</button><button onClick={()=>onNormalize(g.clipIds,g.id)}>Re-normalize</button><button onClick={()=>s.setColorGroup(g.clipIds,null)}>Ungroup</button></div>
        {open&&<div className="color-group-controls"><small>Changes all {g.clipIds.length} shots at once.</small>
          {CONTROLS.map(([name,key,min,max,step])=><Parameter key={key} name={name} value={p[key]} min={min} max={max} step={step} onChange={v=>s.updateColorGroup(g.id,{parameters:{[key]:v}},gesture.current)}/>)}
          <div className="color-group-footer"><button onClick={()=>s.updateColorGroup(g.id,{parameters:{...Object.fromEntries(Object.keys(p).map(k=>[k,neutralValue(k)])),...primaryDefaults},curves:{}})}><RotateCcw size={12}/>Reset group</button>
            {current&&<button onClick={()=>{const node=groupNodeOf(current.id,s.nodes);if(node)s.selectNode(node.id);}}>Select group node</button>}</div>
          <small>For wheels and curves, select the “{g.name}” node in the node graph: its changes reach every shot in the group too.</small>
        </div>}
      </li>;})}</ul>:<p className="color-groups-empty">No color groups yet.</p>}
  </div>;
}
