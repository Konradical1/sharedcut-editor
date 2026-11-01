import './components/captions.css';
import './components/phone.css';
import { loadCaptionFonts } from './services/fonts';
import { lazy, useEffect, useRef, useState, type PointerEvent } from 'react';
import { MotionConfig } from 'motion/react';
import { ChevronLeft, ChevronDown, PanelLeft, SlidersHorizontal, Scissors, Palette, AudioLines, ArrowUpRight, History, Camera, Users, MessageSquare, Radio, Settings, Check, Cloud, X, MonitorPlay, NotebookPen, WandSparkles, Lock } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore, initializeEditorServices } from './state/store';
import type { Workspace } from './state/models';
import { Brand, Button, IconButton, timecode } from './components/ui';
import { ServerControl } from './components/AccountControls';
import { RemoteCursors, PeoplePanel, CommentsPanel, Notifications } from './components/Collaboration';
import { LazySuspense } from './components/StaleBuildBanner';
const Dashboard = lazy(() => import('./components/Dashboard'));
const AuthScreen = lazy(() => import('./components/AuthScreen'));
const SettingsDialog = lazy(() => import('./components/SettingsDialog'));
import HistoryPanel, { SnapshotDialog } from './components/HistoryPanel';
import MediaPanel from './components/MediaPanel';
import Viewer from './components/Viewer';
import Timeline from './components/Timeline';
import Inspector from './components/Inspector';
const ColorWorkspace = lazy(() => import('./workspaces/ColorWorkspace'));
const AudioWorkspace = lazy(() => import('./workspaces/AudioWorkspace'));
const DeliverWorkspace = lazy(() => import('./workspaces/DeliverWorkspace'));
const PlanWorkspace = lazy(() => import('./workspaces/PlanWorkspace'));
const DenoiseWorkspace = lazy(() => import('./workspaces/DenoiseWorkspace'));
import { useEditorShortcuts, useFocusRelease } from './shortcuts';
import { connectSession, signOut, resolveSyncConflict, setProjectLock } from './services/sync';
import { startPlaybackReporting } from './services/playbackHealthStart';
import { usePhoneLayout } from './services/device';
const PhoneEditor = lazy(() => import('./components/PhoneEditor'));
// keep the media panel wide enough for every icon tab to stay visible (see .edit-media in styles.css)
const MIN_MEDIA_WIDTH=232;
void loadCaptionFonts();

const workspaceItems: {id:Workspace;name:string;icon:typeof Scissors}[]=[{id:'edit',name:'Edit',icon:Scissors},{id:'color',name:'Color',icon:Palette},{id:'audio',name:'Audio',icon:AudioLines},{id:'denoise',name:'Denoise',icon:WandSparkles},{id:'deliver',name:'Deliver',icon:ArrowUpRight}];
function EditorStatus() {
  const ready=useEditorStore(s=>s.media.filter(m=>m.projectId===s.projectId).every(m=>m.status==='ready'));
  const clips=useEditorStore(s=>s.clips.filter(c=>c.timelineId===s.timelineId).length);
  const tracks=useEditorStore(s=>s.tracks.filter(t=>t.timelineId===s.timelineId&&(s.workspace!=='audio'||t.kind==='audio')).length);
  const rangeIn=useEditorStore(s=>s.rangeIn), rangeOut=useEditorStore(s=>s.rangeOut);
  return <><span className="media-link-status">{ready?'All media linked':'Media processing'}</span><span className="timeline-counts muted">{clips} clips · {tracks} tracks</span><span className="statusbar-range mono">IN {timecode(rangeIn)} / OUT {timecode(rangeOut)}</span></>;
}
function Editor({onHome}:{onHome:()=>void}) {
  // Every presence packet is a new array; select only what the toolbar shows so the shell (and everything under it)
  // does not re-render several times a second.
  const people=useEditorStore(useShallow(s=>s.presence.filter(p=>p.online&&p.projectId===s.projectId&&p.userId!==s.currentUserId).map(p=>`${p.userId}\n${p.activity}`)));
  const online=useEditorStore(s=>s.presence.filter(p=>p.online).length);
  const presenter=useEditorStore(s=>s.presence.find(p=>p.online&&p.presenting)?.userId);
  const syncConflict=useEditorStore(s=>s.syncConflict);
  const project=useEditorStore(s=>s.projects.find(p=>p.id===s.projectId)), currentUserId=useEditorStore(s=>s.currentUserId);
  const workspace=useEditorStore(s=>s.workspace);
  const sidePanel=useEditorStore(s=>s.sidePanel);
  const saveStatus=useEditorStore(s=>s.saveStatus);
  const revealedMediaId=useEditorStore(s=>s.revealedMediaId);
  useEffect(()=>{if(revealedMediaId)setMediaVisible(true);},[revealedMediaId]);
  // One playback report collector for as long as the editor is open; its reports ride on the presence heartbeat.
  useEffect(()=>startPlaybackReporting(),[]);
  const users=useEditorStore(s=>s.users);
  const liveMode=useEditorStore(s=>s.liveMode);
  const followUserId=useEditorStore(s=>s.followUserId);
  const settings=useEditorStore(s=>s.settings);
  // Phones get their own editor, one page: the other workspaces need a desk.
  const phone=usePhoneLayout();
  useEffect(()=>{if(phone&&workspace!=='edit')useEditorStore.getState().setWorkspace('edit');},[phone,workspace]);
  const [mediaVisible,setMediaVisible]=useState(window.innerWidth >= 1000);
  const [leftWidth,setLeftWidth]=useState(Math.max(MIN_MEDIA_WIDTH,Number(settings.mediaPanelWidth)||270));
  const [rightWidth,setRightWidth]=useState(Number(settings.inspectorPanelWidth)||284);
  const [split,setSplit]=useState(Number(settings.editorSplit)||.55);
  useEffect(()=>{const query=window.matchMedia('(max-width: 760px)');const adapt=()=>{if(query.matches){setMediaVisible(false);useEditorStore.getState().setSidePanel(null);}};adapt();query.addEventListener('change',adapt);return()=>query.removeEventListener('change',adapt);},[]);
  const s=useEditorStore.getState;
  const togglePanel=(panel:'inspector'|'people'|'history'|'comments')=>{if(window.innerWidth<=760)setMediaVisible(false);s().setSidePanel(sidePanel===panel?null:panel);};
  function resize(e:PointerEvent<HTMLDivElement>,side:'left'|'right'|'vertical') {
    e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
    const initial=e.clientX, initialY=e.clientY, value=side==='left'?leftWidth:rightWidth;
    const total=e.currentTarget.parentElement!.getBoundingClientRect().height;
    const move=(event:globalThis.PointerEvent)=>{if(side==='vertical')setSplit(Math.max(.35,Math.min(.7,split+(event.clientY-initialY)/total)));else{const width=Math.max(side==='left'?MIN_MEDIA_WIDTH:220,Math.min(420,value+(event.clientX-initial)*(side==='left'?1:-1)));if(side==='left')setLeftWidth(width);else setRightWidth(width);}};
    const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
  }
  useEffect(()=>{const timer=setTimeout(()=>s().setSettings({mediaPanelWidth:leftWidth,inspectorPanelWidth:rightWidth,editorSplit:split}),300);return()=>clearTimeout(timer);},[leftWidth,rightWidth,split]);
  const dots=(id:Workspace,name:string)=><span className="workspace-people">{people.map(p=>p.split('\n')).filter(([,activity])=>activity===id).map(([userId])=>{const user=users.find(u=>u.id===userId);return <i key={userId} style={{background:user?.color}} title={`${user?.name??'Collaborator'} is in ${name}`}/>;})}</span>;
  if(phone)return <LazySuspense fallback={<div className="workspace-loading page-loading"><Brand/><span>Loading…</span></div>}><PhoneEditor onHome={onHome} landscape={phone==='landscape'}/></LazySuspense>;
  const rightPanel=sidePanel==='people'?<PeoplePanel/>:sidePanel==='history'?<HistoryPanel/>:sidePanel==='comments'?<CommentsPanel/>:<Inspector/>;
  return <div className="editor-app">
    <header className="app-toolbar"><div className="project-navigation"><IconButton label="Back to projects" onClick={onHome}><ChevronLeft size={17}/></IconButton><button className="brand-home" aria-label="SharedCut dashboard" onClick={onHome}><Brand compact/></button><span className="project-divider"/><div className="project-title"><b>{project?.name??'Project'}</b>{project?.lock?<span className="project-locked" title="Read-only for everyone until its owner unlocks it"><Lock size={9}/>Locked{project.lock.note?` · ${project.lock.note}`:''}{project.lock.userId===currentUserId&&<button onClick={()=>void setProjectLock(project.id,false).catch(error=>s().notify(error.message,'error'))}>Unlock</button>}</span>:<span><i className="status-dot"/>{project?.shared?'Class project':(project?.members.length ?? 0)>1?'Shared project':'Private project'}</span>}</div></div>
      <nav className="workspace-nav" aria-label="Editor workspaces">{workspaceItems.map(w=><button key={w.id} className={workspace===w.id?'active':''} aria-label={w.name} aria-current={workspace===w.id?'page':undefined} onClick={()=>s().setWorkspace(w.id)}><w.icon size={15}/>{w.name}{dots(w.id,w.name)}</button>)}
        {/* Plan is pre-production, not a fifth editing stage: one quiet icon after the four, not another labelled tab. */}
        <span className="workspace-nav-divider" aria-hidden="true"/><button className={`workspace-plan ${workspace==='plan'?'active':''}`} aria-label="Plan" title="Plan: script, shot list, mood board" aria-current={workspace==='plan'?'page':undefined} onClick={()=>s().openPlan(s().planTab)}><NotebookPen size={15}/>{dots('plan','Plan')}</button></nav>
      <div className="toolbar-right">
        <IconButton label={mediaVisible?'Hide media':'Show media'} className={mediaVisible?'active':''} onClick={()=>{if(window.innerWidth<=760)s().setSidePanel(null);setMediaVisible(!mediaVisible);s().setWorkspace('edit');}}><PanelLeft size={15}/></IconButton>
        <div className="live-controls">{liveMode==='independent'?<button className="live-join" aria-label="Join Live Playback" disabled={!presenter} title={presenter?'Follow the presenter':'No one is presenting'} onClick={()=>presenter&&s().setLiveMode('following',presenter)}><span className="live-pulse"/><Radio size={13}/><span>Join Live Playback</span><ChevronDown size={11}/></button>:<button className="live-join is-live" onClick={()=>s().setLiveMode('independent')}><Radio size={13}/><b>LIVE</b>{liveMode==='following'?`Following ${users.find(u=>u.id===followUserId)?.name??'Ashley'}`:`Presenting · ${online} online`}<X size={12}/></button>}<IconButton label={liveMode==='presenting'?'Stop presenting':'Present Project'} onClick={()=>s().setLiveMode(liveMode==='presenting'?'independent':'presenting')}><MonitorPlay size={15}/></IconButton></div>
        <IconButton label="Save snapshot" onClick={()=>s().setModal('snapshot')}><Camera size={15}/></IconButton>
        <IconButton label="History" className={sidePanel==='history'?'active':''} onClick={()=>togglePanel('history')}><History size={15}/></IconButton>
        <IconButton label="People" className={sidePanel==='people'?'active':''} onClick={()=>togglePanel('people')}><Users size={15}/></IconButton>
        <IconButton label="Comments" className={sidePanel==='comments'?'active':''} onClick={()=>togglePanel('comments')}><MessageSquare size={15}/></IconButton>
        <IconButton label="Inspector" className={sidePanel==='inspector'?'active':''} onClick={()=>togglePanel('inspector')}><SlidersHorizontal size={15}/></IconButton>
      </div>
    </header>
    <main className="editor-main">
      <LazySuspense key={workspace} fallback={<div className="workspace-loading"><Brand compact/><span>Loading workspace…</span></div>}>{workspace==='edit'?<div className="edit-workspace" style={{gridTemplateRows:`minmax(0, ${split}fr) 1px minmax(0, ${1-split}fr)`}}>
        <div className="edit-upper">{mediaVisible&&<><div className="edit-media" style={{width:leftWidth}}><MediaPanel onClose={()=>setMediaVisible(false)}/></div><div role="separator" aria-label="Resize media panel" aria-orientation="vertical" tabIndex={0} className="panel-resizer" onPointerDown={e=>resize(e,'left')} onKeyDown={e=>{if(e.key==='ArrowRight')setLeftWidth(Math.min(420,leftWidth+10));if(e.key==='ArrowLeft')setLeftWidth(Math.max(MIN_MEDIA_WIDTH,leftWidth-10));}}/></>}<Viewer/>{sidePanel&&<><div role="separator" aria-label="Resize side panel" aria-orientation="vertical" tabIndex={0} className="panel-resizer" onPointerDown={e=>resize(e,'right')} onKeyDown={e=>{if(e.key==='ArrowLeft')setRightWidth(Math.min(420,rightWidth+10));if(e.key==='ArrowRight')setRightWidth(Math.max(220,rightWidth-10));}}/><aside className="edit-inspector" style={{width:rightWidth}}>{rightPanel}</aside></>}</div>
        <div role="separator" aria-label="Resize timeline" aria-orientation="horizontal" tabIndex={0} className="panel-resizer horizontal" onPointerDown={e=>resize(e,'vertical')} onKeyDown={e=>{if(e.key==='ArrowUp')setSplit(Math.max(.35,split-.03));if(e.key==='ArrowDown')setSplit(Math.min(.7,split+.03));}}/>
        <Timeline/>
      </div>:workspace==='color'?<ColorWorkspace/>:workspace==='audio'?<AudioWorkspace/>:workspace==='plan'?<PlanWorkspace/>:workspace==='denoise'?<DenoiseWorkspace/>:<DeliverWorkspace/>}</LazySuspense>
      {workspace!=='edit'&&sidePanel&&sidePanel!=='inspector'&&<aside className="floating-side-panel">{rightPanel}</aside>}
      <RemoteCursors/>
    </main>
    {syncConflict.length>0&&<div className="sync-conflict" role="alert"><span>Another editor changed {syncConflict.length} of the same fields. Your draft is preserved.</span><Button onClick={()=>resolveSyncConflict(false)}>Use server edits</Button><Button onClick={()=>resolveSyncConflict(true)}>Keep my edits</Button></div>}
    <footer className="app-statusbar"><ServerControl/><span className="statusbar-divider"/><EditorStatus/><span className="spacer"/><span className={`save-status ${saveStatus==='Save failed'?'danger-text':''}`}>{saveStatus==='Saved'?<Check size={12}/>:<Cloud size={13}/>}{saveStatus}</span><button className="statusbar-settings" onClick={()=>s().setModal('settings')}><Settings size={12}/><span>Settings</span></button></footer>
  </div>;
}
export default function App() {
  const session=useEditorStore(s=>s.session);
  const [connectionError,setConnectionError]=useState('');
  const [route,setRoute]=useState(window.location.pathname);
  // The importer's "Sign in" link is /login?next=/importer: once signed in, go back there. Only that exact value, so it is no open redirect.
  const [next]=useState(()=>new URLSearchParams(window.location.search).get('next')==='/importer');
  const modal=useEditorStore(s=>s.modal);
  const settings=useEditorStore(s=>s.settings);
  const projects=useEditorStore(s=>s.projects);
  const isEditor=route.startsWith('/project/');
  let projectId:string|null=null;try{projectId=isEditor?decodeURIComponent(route.slice('/project/'.length)):null;}catch{/* Invalid routes return to the dashboard. */}
  const knownProject=projects.some(p=>p.id===projectId);
  const navigate=(path:string)=>{window.history.pushState({},'',path);setRoute(path);};
  useEffect(()=>{const change=()=>setRoute(window.location.pathname);window.addEventListener('popstate',change);return()=>window.removeEventListener('popstate',change);},[]);
  useEffect(()=>initializeEditorServices(),[]);
  useEffect(()=>{if(next&&session==='ready')window.location.assign('/importer');},[next,session]);
  useEffect(()=>{void connectSession().catch(error=>{setConnectionError(error.message);useEditorStore.setState({session:'error'});});},[]);
  useEffect(()=>{if(projectId&&knownProject){useEditorStore.getState().openProject(projectId);useEditorStore.getState().setSettings({lastProjectId:projectId});}},[projectId,knownProject]);
  // Resume the last project once, when the project list first arrives. Later navigation is the editor's own.
  const resumed=useRef(false);
  useEffect(()=>{if(resumed.current||session!=='ready'||!projects.length)return;resumed.current=true;const last=String(settings.lastProjectId??'');if(!isEditor&&settings.startPage==='Last opened project'&&projects.some(p=>p.id===last))navigate(`/project/${encodeURIComponent(last)}`);},[session,projects,isEditor,settings.startPage,settings.lastProjectId]);
  useEffect(()=>{document.documentElement.dataset.reducedMotion=String(settings.reducedMotion);document.documentElement.dataset.density=String(settings.timelineDensity);const scale=parseFloat(String(settings.uiScale));document.documentElement.style.setProperty('--ui-scale',String(Number.isFinite(scale)?scale/100:1));},[settings.reducedMotion,settings.timelineDensity,settings.uiScale]);
  useEffect(()=>{document.title=isEditor?`${projects.find(p=>p.id===projectId)?.name??'Project'} — SharedCut`:'SharedCut — Projects';},[isEditor,projectId,projects]);
  useEditorShortcuts(isEditor&&knownProject);
  useFocusRelease();
  const home=()=>{useEditorStore.getState().setPlaying(false);useEditorStore.getState().setLiveMode('independent');navigate('/');};
  const logout=()=>{void signOut().then(()=>navigate('/login')).catch(error=>useEditorStore.getState().notify(error.message,'error'));};
  return <MotionConfig reducedMotion={settings.reducedMotion?'always':'user'}><div className="app-root">
    <LazySuspense fallback={<div className="workspace-loading page-loading"><Brand/><span>Loading…</span></div>}>{session==='loading'||next&&session==='ready'?<div className="workspace-loading page-loading"><Brand/><span>Connecting to server…</span></div>:session==='error'?<div className="workspace-loading page-loading"><Brand/><span>Could not connect to your studio server.</span><p>{connectionError}</p><Button onClick={()=>window.location.reload()}>Retry connection</Button></div>:session==='signedOut'?<AuthScreen onDone={home}/>:isEditor&&knownProject?<Editor onHome={home}/>:<Dashboard onOpenProject={id=>navigate(`/project/${encodeURIComponent(id)}`)} onOpenAuth={logout}/>}</LazySuspense>
    <LazySuspense fallback={null} quiet>{(modal==='settings'||modal==='timeline-settings')&&<SettingsDialog initialCategory={modal==='timeline-settings'?'Timeline':'General'} onClose={()=>useEditorStore.getState().setModal(null)}/>}</LazySuspense><SnapshotDialog/><Notifications/>
  </div></MotionConfig>;
}
