import { PanelTabPresence, usePanelTabPresence } from './PanelTabPresence';
import SoundLibrary from './SoundLibrary';
import LinkImport from './LinkImport';
import { api, connection } from '../services/api';
import CaptionLibrary from './CaptionLibrary';
import ShapeLibrary from './ShapeLibrary';
import MediaThumbnail from './MediaThumbnail';
import TitleLibrary from './TitleLibrary';
import TransitionLibrary from './TransitionLibrary';
import { useEffect, useRef, useState } from 'react';
import { Folder, FolderOpen, ChevronRight, Search, LayoutGrid, List, SlidersHorizontal, Upload, Plus, Film, Music2, Check, AlertCircle, LoaderCircle, WandSparkles, Type, X, MoreHorizontal, Play, Pencil, Info, Trash2, RefreshCw, Image as ImageIcon, AudioLines, Captions as CaptionsIcon, Sparkles, FlipHorizontal2, Shapes as ShapesIcon } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { Badge, IconButton, ContextMenu, Modal, Field, Button, EmptyState, durationLabel, fpsLabel } from './ui';
import { effectDefinitions } from '../services/effects';
import { bins } from '../state/demo';
import type { MediaAsset } from '../state/models';

const mediaTabs=[{id:'Media',label:'Media',icon:ImageIcon},{id:'SFX',label:'Sound effects',icon:AudioLines},{id:'Captions',label:'Captions',icon:CaptionsIcon},{id:'Effects',label:'Effects',icon:Sparkles},{id:'Transitions',label:'Transitions',icon:FlipHorizontal2},{id:'Titles',label:'Titles',icon:Type},{id:'Shapes',label:'Shapes',icon:ShapesIcon}];
const statusLabels:Record<string,string>={downloading:'Downloading',uploading:'Uploading',processing:'Preparing media',proxy:'Generating proxy',waveform:'Generating waveform',thumbnails:'Generating thumbnails',ready:'Ready',failed:'Processing failed'};
export default function MediaPanel({onClose}:{onClose:()=>void}) {
  const media=useEditorStore(s=>s.media);
  const projectId=useEditorStore(s=>s.projectId);
  const revealedMediaId=useEditorStore(s=>s.revealedMediaId);
  const clips=useEditorStore(s=>s.clips);
  const selectedClipId=useEditorStore(s=>s.selectedClipId);
  const [showLinkImport,setShowLinkImport]=useState(false);
  const [tab,setTab]=useState('Media');
  usePanelTabPresence('media', tab);
  const [bin,setBin]=useState('all');
  const [query,setQuery]=useState('');
  const [list,setList]=useState(false);
  const [sort,setSort]=useState('name');
  const [filter,setFilter]=useState('all');
  const [usage,setUsage]=useState('all');
  const [showFilters,setShowFilters]=useState(false);
  const [selectedAsset,setSelectedAsset]=useState<string|null>(null);
  const [menu,setMenu]=useState<{id:string;x:number;y:number}|null>(null);
  const [info,setInfo]=useState<MediaAsset|null>(null);
  const [rename,setRename]=useState<MediaAsset|null>(null);
  const [removing,setRemoving]=useState<MediaAsset|null>(null);
  const [name,setName]=useState('');
  const upload=useRef<HTMLInputElement>(null);
  const s=useEditorStore.getState;
  useEffect(()=>{if(!revealedMediaId)return;setTab('Media');setBin('all');setFilter('all');setUsage('all');setQuery('');setSelectedAsset(revealedMediaId);const frame=requestAnimationFrame(()=>{document.getElementById(`media-${revealedMediaId}`)?.scrollIntoView({block:'nearest'});s().revealMedia(null);});return()=>cancelAnimationFrame(frame);},[revealedMediaId]);
  // Footage counts as used when any clip in this project references it, across every timeline —
  // a shot parked on a second sequence is still spent. A Set keeps this O(1) per asset.
  const usedMediaIds=new Set(clips.filter(c=>c.projectId===projectId).map(c=>c.mediaId));
  const assets=media.filter(m=>m.projectId===projectId&&(bin==='all'||m.binId===bin)&&(filter==='all'||m.kind===filter)&&(usage==='all'||usedMediaIds.has(m.id)===(usage==='used'))&&m.name.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sort==='duration'?b.duration-a.duration:a.name.localeCompare(b.name));
  const projectMedia=media.filter(m=>m.projectId===projectId);
  // The bin list is a fixed set, but an import can introduce its own (one per camera, say).
  // Surfacing whatever the project's media actually references keeps those folders working.
  const binList=[...bins.filter(b=>b.id!=='all'),...[...new Set(projectMedia.map(m=>m.binId))].filter(id=>id&&!bins.some(b=>b.id===id)).sort().map(id=>({id,name:id}))];
  const binName=(id:string)=>binList.find(b=>b.id===id)?.name??id;
  const processing=projectMedia.filter(m=>!['ready','failed'].includes(m.status));
  const clickMedia=(m:MediaAsset)=>{setSelectedAsset(m.id);const clip=clips.find(c=>c.mediaId===m.id);if(clip)s().selectClip(clip.id);};
  const handleFiles=(files:FileList|null)=>{if(files?.length)s().uploadMedia(Array.from(files));};
  const libraries:Record<string,{name:string;description:string;icon:typeof WandSparkles}[]>={Effects:Object.entries(effectDefinitions).map(([name,definition])=>({name,description:definition.description,icon:WandSparkles}))};
  return <section className="media-panel panel" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();handleFiles(e.dataTransfer.files);}}>
    <div className="media-tabs" role="tablist" aria-label="Media panel sections">{mediaTabs.map(t=><button key={t.id} role="tab" aria-selected={tab===t.id} aria-label={t.label} title={t.label} className={tab===t.id?'active':''} onClick={()=>{setTab(t.id);setQuery('');}}><t.icon size={15} strokeWidth={1.75} aria-hidden/><PanelTabPresence panel="media" tab={t.id}/></button>)}<span className="media-tabs-divider"/><IconButton label="Hide media panel" onClick={onClose}><X size={12}/></IconButton></div>
    {tab==='Media'?<>
      <div className="media-search"><Search size={14}/><input placeholder="Search media…" aria-label="Search media" value={query} onChange={e=>setQuery(e.target.value)}/><span className="keyboard-hint">⌘ K</span></div>
      <details className="media-bin-picker"><summary>{bin==='all'?'All media':binName(bin)} · {projectMedia.filter(m=>bin==='all'||m.binId===bin).length}</summary><div className="media-bins"><button className={bin==='all'?'active':''} onClick={()=>setBin('all')}><FolderOpen size={14}/><span>All media</span><span>{projectMedia.length}</span></button>{binList.map(b=><button className={bin===b.id?'active':''} key={b.id} onClick={()=>setBin(b.id)}><Folder size={13}/><span>{b.name}</span><span>{projectMedia.filter(m=>m.binId===b.id).length}</span></button>)}</div></details>
      <div className="media-assets-toolbar"><span className="eyebrow">{bin==='all'?'ALL FOOTAGE':binName(bin).toUpperCase()}</span><span className="spacer"/><IconButton label="Media filters and sorting" className={showFilters?'active':''} onClick={()=>setShowFilters(!showFilters)}><SlidersHorizontal size={13}/></IconButton><IconButton label={list?'Grid view':'List view'} onClick={()=>setList(!list)}>{list?<LayoutGrid size={13}/>:<List size={13}/>}</IconButton></div>
      {showFilters&&<div className="media-filter-row"><select aria-label="Filter media type" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All types</option><option value="video">Video</option><option value="audio">Audio</option><option value="image">Images</option></select><select aria-label="Filter by timeline use" value={usage} onChange={e=>setUsage(e.target.value)}><option value="all">Used and unused</option><option value="used">In timeline</option><option value="unused">Not in timeline</option></select><select aria-label="Sort media" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name A–Z</option><option value="duration">Longest first</option></select></div>}
      <div className={`media-assets ${list?'media-list':''}`}>
        {assets.map(m=><div data-cursor-anchor={`media-${m.id}`} id={`media-${m.id}`} key={m.id} role="button" tabIndex={0} aria-label={`Select media ${m.name}`} draggable={m.status==='ready'} onDragEnd={()=>useEditorStore.setState({draggingMediaId:null})} onDragStart={e=>{useEditorStore.setState({draggingMediaId:m.id});e.dataTransfer.setData('application/x-frameline-media',m.id);e.dataTransfer.effectAllowed='copy';setSelectedAsset(m.id);}} className={`media-asset ${selectedAsset===m.id||clips.find(c=>c.id===selectedClipId)?.mediaId===m.id?'active':''}`} onClick={()=>clickMedia(m)} onKeyDown={e=>{if(e.key==='Enter')clickMedia(m);}} onDoubleClick={()=>s().addMediaToTimeline(m.id)} onContextMenu={e=>{e.preventDefault();setMenu({id:m.id,x:e.clientX,y:e.clientY});}}><div className={`media-thumbnail ${m.kind==='audio'?'audio-thumb':''}`}>{m.kind==='audio'&&!m.thumbnail?<><Music2 size={24}/><span className="audio-thumb-lines"/></>:<MediaThumbnail asset={m}/>}<span className="media-duration mono">{durationLabel(m.duration)}</span><span className={`media-state-icon ${m.status}`} title={statusLabels[m.status]}>{m.status==='ready'?<Check size={9}/>:m.status==='failed'?<AlertCircle size={11}/>:<LoaderCircle size={11} className="spin"/>}</span><button className="media-add-button" title={`Add ${m.name} to timeline`} aria-label={`Add ${m.name} to timeline`} onClick={e=>{e.stopPropagation();s().addMediaToTimeline(m.id);}}><Plus size={14}/></button></div><div className="media-asset-meta"><b title={m.name}>{m.name}</b>{m.importLink?.url.includes('open.spotify.com')&&<span title={m.matchedSourceTitle}>Spotify · matched YouTube audio</span>}<span>{m.kind==='audio'?m.resolution:`${m.resolution.includes('3840')?'4K':'HD'} · ${fpsLabel(m.fps)} fps`}</span></div>{m.status!=='ready'&&<div className={`media-progress ${m.status}`}><span title={m.error}>{m.error||statusLabels[m.status]}{m.status!=='failed'&&` · ${Math.round(m.progress)}%`}</span>{m.importLink&&!['ready','failed'].includes(m.status)&&<button onClick={e=>{e.stopPropagation();void api(`/media/${m.id}/cancel`,{method:'POST'}).then(()=>connection.refresh()).catch(error=>s().notify(error.message,'error'));}}>Cancel</button>}{m.status==='failed'?<button onClick={e=>{e.stopPropagation();s().retryMedia(m.id);}}>Retry</button>:<div><i style={{width:`${m.progress}%`}}/></div>}</div>}</div>)}
        {!assets.length&&<EmptyState title="No matching media" description="Try another search or upload your footage."/>}
      </div>
      <input ref={upload} type="file" multiple accept="video/*,audio/*,image/*" className="visually-hidden" aria-label="Upload media files" onChange={e=>{handleFiles(e.target.files);e.target.value='';}}/>
      <footer className="media-footer"><button className="upload-button" onClick={()=>setShowLinkImport(true)}>Import link</button><button className="upload-button" onClick={()=>upload.current?.click()}><Upload size={14}/><span>Upload media</span><Plus size={13}/></button><span className="media-upload-note">{processing.length?`${processing.length} files preparing on the server`:'Drop footage here · Originals stay on your server'}</span></footer>
    </>:tab==='SFX'?<SoundLibrary/>:tab==='Captions'?<CaptionLibrary/>:tab==='Titles'?<TitleLibrary/>:tab==='Shapes'?<ShapeLibrary/>:tab==='Transitions'?<TransitionLibrary/>:<div className="media-library"><div className="media-search"><Search size={14}/><input placeholder={`Search ${tab.toLowerCase()}…`} aria-label={`Search ${tab.toLowerCase()}`} value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button className="search-clear" aria-label="Clear search" onClick={()=>setQuery('')}>×</button>}</div>{libraries[tab]?.filter(item=>item.name.toLowerCase().includes(query.toLowerCase())||item.description.toLowerCase().includes(query.toLowerCase())).map(item=><button className="library-item" key={item.name} draggable title={item.description} onDragStart={e=>{e.dataTransfer.setData('application/x-frameline-effect',item.name);e.dataTransfer.effectAllowed='copy';}} onClick={()=>{if(selectedClipId){s().addEffect(selectedClipId,item.name);}else s().notify('Select a timeline clip first','info');}}><span className={`library-preview library-${tab.toLowerCase()}`}><item.icon size={24}/>{tab==='Titles'&&<strong>Aa</strong>}</span><span>{item.name}</span><Plus size={13}/></button>)}{query&&!libraries[tab]?.some(item=>item.name.toLowerCase().includes(query.toLowerCase())||item.description.toLowerCase().includes(query.toLowerCase()))&&<EmptyState title={`No matching ${tab.toLowerCase()}`} description="Try a shorter word, or clear the search."/>}</div>}
    {menu&&<ContextMenu x={menu.x} y={menu.y} onClose={()=>setMenu(null)}>{[{label:'Add to Timeline',icon:Plus,fn:()=>s().addMediaToTimeline(menu.id)},{label:'Rename',icon:Pencil,fn:()=>{const m=media.find(x=>x.id===menu.id)!;setRename(m);setName(m.name);}},{label:'Create Proxy',icon:RefreshCw,fn:()=>s().retryMedia(menu.id)},{label:'Metadata',icon:Info,fn:()=>setInfo(media.find(x=>x.id===menu.id)!)},{label:'Remove from Project',icon:Trash2,fn:()=>{const m=media.find(x=>x.id===menu.id)!;if(s().settings.confirmDelete===false)s().removeMedia(m.id);else setRemoving(m);}}].map(item=><button role="menuitem" key={item.label} onClick={()=>{item.fn();setMenu(null);}}><item.icon size={14}/>{item.label}</button>)}</ContextMenu>}
    {info&&<Modal title="Media metadata" onClose={()=>setInfo(null)}><div className="modal-body">{info.thumbnail&&<img className="metadata-preview" src={info.thumbnail} alt={info.name}/>}<dl className="metadata-list">{Object.entries({Name:info.name,'Permanent media ID':info.id,Duration:durationLabel(info.duration),Resolution:info.resolution,'Frame rate':`${fpsLabel(info.fps)} fps`,Size:info.size,Camera:info.camera??'Unknown',Status:statusLabels[info.status],...(info.importLink?{'Imported link':info.importLink.url,'Audio/video source':info.matchedSourceUrl??'Not resolved','Source title':info.matchedSourceTitle??'Not resolved'}:{})}).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></div></Modal>}
    {removing&&<Modal title="Remove media" onClose={()=>setRemoving(null)}><div className="modal-body"><p>Remove <b>{removing.name}</b> from this project?</p><p className="muted">Media used in a timeline or snapshot is kept. Originals stay on your server.</p></div><div className="modal-actions"><Button onClick={()=>setRemoving(null)}>Cancel</Button><Button variant="primary" onClick={()=>{s().removeMedia(removing.id);setRemoving(null);}}>Remove</Button></div></Modal>}
    {showLinkImport&&<LinkImport projectId={projectId} onClose={()=>setShowLinkImport(false)}/>}
    {rename&&<Modal title="Rename media" onClose={()=>setRename(null)}><form onSubmit={e=>{e.preventDefault();if(name.trim()){s().renameMedia(rename.id,name.trim());setRename(null);}}}><div className="modal-body"><Field label="Media name"><input autoFocus required value={name} onChange={e=>setName(e.target.value)}/></Field><p className="muted">Timeline references use a permanent media ID and will stay linked.</p></div><div className="modal-actions"><Button onClick={()=>setRename(null)}>Cancel</Button><Button type="submit" variant="primary">Rename</Button></div></form></Modal>}
  </section>;
}
