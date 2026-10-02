import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Users, Radio, ArrowUpRight, Play, X, MessageSquare, Check, Send, CornerDownRight, Clock3 } from 'lucide-react';
import { useEditorStore, usePanelPlayhead } from '../state/store';
import type { Presence, PresenceCursor } from '../state/models';
import { advanceCursor, type CursorMotion, advancePlayhead, playheadMotion, cursorPosition, presenceCursor } from '../services/presence';
import { api, connection } from '../services/api';
import { Avatar, Badge, IconButton, Button, timecode, EmptyState } from './ui';
import { playheadStrip } from './LiveTimecode';

// Stable content anchors cover controls and whitespace without tying cursors to viewport pixels.
function cursorRoot(hit: Element | null) { return hit?.closest<HTMLElement>('[data-cursor-surface],.panel') ?? null; }
function surfaceId(root: HTMLElement) { return root.dataset.cursorSurface ?? `panel:${Array.from(root.classList).find(c=>c!=='panel')}`; }
function panelContext(root: HTMLElement) { return root.dataset.cursorContext ?? Array.from(root.querySelectorAll('.active[role="tab"], [class$="-tabs"] > .active')).map(e=>e.textContent).join('|'); }
function contentAnchor(hit: Element, root: HTMLElement): HTMLElement {
  const explicit=hit.closest<HTMLElement>('[data-cursor-anchor]');
  if(explicit&&root.contains(explicit))return explicit;
  return (hit.closest<HTMLElement>('input,button,select,textarea,label,summary,p,canvas,svg') ?? hit) as HTMLElement;
}
function contentRect(el: HTMLElement) {
  const rect=el.getBoundingClientRect(), scale=el.offsetWidth?rect.width/el.offsetWidth:1;
  return {left:rect.left-el.scrollLeft*scale,top:rect.top-el.scrollTop*scale,width:Math.max(rect.width,el.scrollWidth*scale),height:Math.max(rect.height,el.scrollHeight*scale)};
}
function anchorId(el: HTMLElement, root: HTMLElement): string {
  if(el.dataset.cursorAnchor)return el.dataset.cursorAnchor;
  const path:number[]=[];let node:Element|null=el;
  while(node&&node!==root){path.unshift(Array.from(node.parentElement!.children).indexOf(node));node=node.parentElement;}
  return `dom:${path.join('.')}`;
}
function findAnchor(root: HTMLElement, id: string): HTMLElement | undefined {
  if(!id.startsWith('dom:'))return Array.from(root.querySelectorAll<HTMLElement>('[data-cursor-anchor]')).find(el=>el.dataset.cursorAnchor===id);
  let node:Element|undefined=root;
  for(const index of id.slice(4).split('.').filter(Boolean))node=node?.children[Number(index)];
  return node as HTMLElement|undefined;
}

const CURSOR_PLAYING_MS = 250, CURSOR_REFRESH_MS = 1000;

/** Move your playhead to a collaborator's (their timeline too), and scroll the timeline to it when it is off screen. */
function jumpToPlayhead(userId: string) {
  const s = useEditorStore.getState(), person = s.presence.find(p => p.userId === userId && p.projectId === s.projectId && p.online);
  if (!person) return;
  if (person.timelineId && person.timelineId !== s.timelineId) s.setTimeline(person.timelineId);
  // A playing collaborator has moved on since their last packet (at most 2 s of it counts, as for their drawn playhead).
  const fps = s.projects.find(p => p.id === s.projectId)?.fps || 24;
  const ahead = person.playing && person.receivedAt !== undefined ? Math.min(2, Math.max(0, (performance.now() - person.receivedAt) / 1000)) : 0;
  s.setPlayhead(Math.round((person.playhead + ahead) * fps) / fps);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const scroll = document.querySelector<HTMLElement>('.timeline-scroll'), line = scroll?.querySelector<HTMLElement>('.local-playhead');
    if (!scroll || !line) return;
    const box = scroll.getBoundingClientRect(), scale = box.width / (scroll.offsetWidth || 1), x = line.getBoundingClientRect().left;
    if (x < box.left + 170 * scale || x > box.right - 20 * scale) scroll.scrollLeft += (x - (box.left + box.width / 2)) / scale;
  }));
}

export function RemoteCursors() {
  const users = useEditorStore(s => s.users);
  const currentUserId = useEditorStore(s => s.currentUserId);
  const showCursors = useEditorStore(s => s.settings.showCursors !== false);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let pointer: { x: number; y: number } | null = null, frame = 0, hitDue = false, hitAt = 0, remoteAt = 0, shown = false;
    const motions = new WeakMap<HTMLElement, { context: string; layout: string; value: CursorMotion }>();
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const move = (e: globalThis.PointerEvent) => { pointer = { x: e.clientX, y: e.clientY }; hitDue = true; };
    const stale = () => { hitDue = true; };
    const clear = () => { pointer = null; useEditorStore.setState({ cursor: null }); };
    const leave = (e: globalThis.PointerEvent) => { if (!e.relatedTarget) clear(); };
    // elementFromPoint forces a layout and hit-tests every timeline element. The answer only changes when the pointer or
    // the content under it moves (scroll, resize), so test then, at most 4 Hz while playing, plus a slow refresh while
    // paused for anything else that shifts the page (playback itself moves no layout).
    const hitTest = (state: ReturnType<typeof useEditorStore.getState>) => {
      const hit = pointer && !document.hidden ? document.elementFromPoint(pointer.x, pointer.y) : null;
      const surface = cursorRoot(hit);
      const anchor = hit&&surface?contentAnchor(hit,surface):null;
      let cursor: PresenceCursor | null = null;
      if (pointer && anchor && surface && !state.modal) {
        cursor = presenceCursor({ surface: surfaceId(surface), anchor: anchorId(anchor,surface), context: panelContext(surface), fallback: anchor.closest<HTMLElement>('[data-cursor-fallback]')?.dataset.cursorFallback,
          clipId: surface.dataset.cursorClip, ...cursorPosition(pointer.x, pointer.y, contentRect(anchor),
            surface.dataset.cursorSurface === 'timeline' && anchor.dataset.timeSpan ? Number(anchor.dataset.timeSpan) : undefined) });
      }
      if (JSON.stringify(cursor) !== JSON.stringify(state.cursor)) useEditorStore.setState({ cursor });
    };
    const draw = () => {
      const now = performance.now(), paints: (() => void)[] = [];
      const state = useEditorStore.getState(), wait = state.playing ? CURSOR_PLAYING_MS : 0;
      if (pointer && (hitDue && now - hitAt >= wait || !state.playing && now - hitAt >= CURSOR_REFRESH_MS)) { hitDue = false; hitAt = now; hitTest(state); }
      // Alone in the project there is nothing to place; one more pass after the last collaborator leaves hides them.
      const remote = state.presence.some(p => p.online && p.userId !== state.currentUserId && p.projectId === state.projectId);
      const container = (remote || shown) && now - remoteAt >= wait ? layer.current : null;
      if (container) {
        remoteAt = now; shown = remote;
        const bounds = container.getBoundingClientRect(), scale = bounds.width / container.offsetWidth;
        for (const node of container.querySelectorAll<HTMLElement>('[data-remote-user]')) {
          const glow=node.querySelector<HTMLElement>('.remote-panel-glow')!;glow.style.display='none';
          const hide = () => { motions.delete(node); paints.push(() => { node.style.opacity = '0'; if (state.settings.reducedMotion || preference.matches) node.style.display = 'none'; }); };
          const person = state.presence.find(p => p.userId === node.dataset.remoteUser);
          const c = presenceCursor(person?.cursor);
          if (!person || !c || !person.online || person.userId === state.currentUserId || person.projectId !== state.projectId ||
              person.timelineId !== state.timelineId || person.activity !== state.workspace || state.modal || (person.receivedAt !== undefined && now - person.receivedAt > 8000)) { hide(); continue; }
          const root = Array.from(document.querySelectorAll<HTMLElement>('[data-cursor-surface],.panel')).find(el=>surfaceId(el)===c.surface) ?? (c.surface==='inspector'?document.querySelector<HTMLElement>('.inspector.panel'):null);
          if (!root) { hide(); continue; }
          const panel=root.closest<HTMLElement>('.panel')??root, panelRect=panel.getBoundingClientRect();
          const sameContent=(root.dataset.cursorClip===c.clipId)&&(c.context===undefined||panelContext(root)===c.context);
          let target=sameContent?findAnchor(root,c.anchor!):undefined;
          const exact=!!target&&!!target.getClientRects().length;
          if(!exact)target=c.fallback?findAnchor(root,c.fallback):undefined;
          const viewport=root.getBoundingClientRect(), rect=target?contentRect(target):undefined;
          const x=rect?rect.left+(exact?c.x/(c.surface==='timeline'&&target?.dataset.timeSpan?Number(target.dataset.timeSpan):1):.5)*rect.width:0;
          const y=rect?rect.top+(exact?c.y:.5)*rect.height:0;
          const hitAt=rect?document.elementFromPoint(x,y):null;
          const visible=!!target&&!!hitAt&&x>=viewport.left&&x<viewport.right&&y>=viewport.top&&y<viewport.bottom&&
            (target===hitAt||target.contains(hitAt))&&(!exact||contentAnchor(hitAt,root)===target);
          const marker=node.firstElementChild as HTMLElement;
          marker.style.visibility=visible&&exact?'visible':'hidden';
          const label=glow.firstElementChild as HTMLElement;
          label.style.top=`${2+18*Math.max(0,state.presence.filter(p=>p.online&&p.cursor?.surface===c.surface).findIndex(p=>p.userId===person.userId))}px`;
          label.textContent=`${state.users.find(u=>u.id===person.userId)?.name??'Collaborator'} · ${!sameContent?'viewing different content':!exact&&c.fallback?'hovering keyframes':'here'}`;
          Object.assign(glow.style,{display:'block',left:`${(panelRect.left-viewport.left)/scale}px`,top:`${(panelRect.top-viewport.top)/scale}px`,width:`${panelRect.width/scale}px`,height:`${panelRect.height/scale}px`});
          const context = JSON.stringify([person.projectId, person.timelineId, person.activity, c.surface, c.clipId]);
          // Local layout changes reproject immediately; remote moves (including track/field changes) ease continuously.
          const layout = [scale, viewport.x, viewport.y, viewport.width, viewport.height, root.scrollLeft, root.scrollTop,
            root.scrollWidth, root.scrollHeight, root.querySelector('.timeline-ruler')?.getBoundingClientRect().width,
            root.querySelector('.track-lane')?.getBoundingClientRect().height].join(':');
          const previous = motions.get(node);
          const value = advanceCursor(!state.settings.reducedMotion && !preference.matches && previous?.context === context && previous.layout === layout ? previous.value : undefined,
            (x-viewport.left)/scale, (y-viewport.top)/scale, now);
          motions.set(node, { context, layout, value });
          paints.push(() => {
            Object.assign(node.style, { display: 'block', opacity: '1', left: `${(viewport.left-bounds.left)/scale}px`, top: `${(viewport.top-bounds.top)/scale}px`,
              overflow:'visible', width: `${viewport.width/scale}px`, height: `${viewport.height/scale}px` });
            const marker = node.firstElementChild as HTMLElement;
            marker.style.transform = `translate(${value.x}px, ${value.y}px)`;
          });
        }
      }
      paints.forEach(paint => paint());
      frame = requestAnimationFrame(draw);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerout', leave);
    document.addEventListener('visibilitychange', clear);
    document.addEventListener('scroll', stale, { capture: true, passive: true });
    window.addEventListener('resize', stale);
    window.addEventListener('blur', clear);
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointermove', move); document.removeEventListener('pointerout', leave);
      document.removeEventListener('visibilitychange', clear); document.removeEventListener('scroll', stale, { capture: true }); window.removeEventListener('resize', stale);
      window.removeEventListener('blur', clear); clear(); };
  }, []);
  return <div className="remote-cursor-layer" ref={layer} aria-hidden="true">{showCursors && users.filter(user => user.id !== currentUserId).map(user => {
    return <div className="remote-cursor-layer" data-remote-user={user.id} key={user.id} style={{display:'none',opacity:0,'--user-color':user.color} as CSSProperties} onTransitionEnd={e => {
      if (e.target === e.currentTarget && e.propertyName === 'opacity' && e.currentTarget.style.opacity === '0') e.currentTarget.style.display = 'none';
    }}>
      <div className="remote-cursor" style={{'--user-color':user?.color} as CSSProperties}>
        <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="M0 0 7 22 11 12 21 8Z"/></svg><span>{user?.name}</span>
      </div><div className="remote-panel-glow"><span title={`Go to ${user.name}'s playhead`} onPointerDown={e => e.stopPropagation()} onClick={() => jumpToPlayhead(user.id)}/></div>
    </div>;
  })}</div>;
}

/**
 * A collaborator's playhead. Still, it is this element. Moving (they play, scrub, or it is easing to a new spot) the element
 * hides and the line and name tag are drawn into a canvas strip instead (playheadStrip): moving the element re-layerized the
 * whole page every time it reached the next pixel, so watching someone play cost this machine more than playing itself.
 */
export function RemotePlayhead({ person, pixels, color, name, scroller }: { person: Presence; pixels: number; color?: string; name?: string; scroller: RefObject<HTMLDivElement | null> }) {
  const element = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ person, pixels }); latest.current = { person, pixels };
  const reducedMotion = useEditorStore(s => s.settings.reducedMotion);
  useEffect(() => {
    const line = element.current, label = line?.firstElementChild as HTMLElement | null, surface = canvas.current, scroll = scroller.current;
    if (!line || !label || !surface || !scroll) return;
    let frame = 0, shown = NaN, origin = 0, strip: ReturnType<typeof playheadStrip> | undefined;
    const motion = playheadMotion(latest.current.person, performance.now());
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    // The element's own box and name tag (border-radius 3px 3px 3px 0), styled and laid out as it is now: the tag is as
    // narrow as its longest word, so a name wraps a word to a line, and each line is drawn where layout put it.
    const painter = () => {
      const css = getComputedStyle(label), fill = css.backgroundColor, ink = css.color, font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      const text = label.firstChild, box = label.getBoundingClientRect(), zoom = box.width / (label.offsetWidth || 1), range = document.createRange(), lines: [string, number, number][] = [];
      for (const word of text?.textContent?.matchAll(/\S+/g) ?? []) {
        range.setStart(text!, word.index); range.setEnd(text!, word.index + word[0].length);
        const r = range.getBoundingClientRect(), y = (r.top + r.height / 2 - box.top) / zoom, last = lines.at(-1);
        if (last && Math.abs(last[2] - y) < 1) last[0] += ` ${word[0]}`; else lines.push([word[0], (r.left - box.left) / zoom, y]);
      }
      return (context: CanvasRenderingContext2D, x: number, top: number) => {
        const y = top + line.offsetTop, lx = x + label.offsetLeft, ly = y + label.offsetTop;
        context.fillStyle = fill; context.fillRect(x, y, line.offsetWidth, line.offsetHeight);
        context.beginPath(); context.roundRect(lx, ly, label.offsetWidth, label.offsetHeight, [3, 3, 3, 0]); context.fill();
        context.fillStyle = ink; context.font = font; context.textBaseline = 'middle';
        for (const [words, wx, wy] of lines) context.fillText(words, lx + wx, ly + wy);
      };
    };
    const draw = () => {
      const { person, pixels } = latest.current;
      const position = advancePlayhead(motion, person, performance.now()), reduced = reducedMotion || preference.matches;
      // On whole device pixels, so a slow line redraws only when it visibly moves.
      const x = Math.round((reduced ? person.playhead : position) * pixels * devicePixelRatio) / devicePixelRatio;
      if (person.playing || !reduced && (motion.velocity !== 0 || motion.position !== motion.target)) {
        // The strip keeps room on the right for the name tag (and a pixel for its anti-aliased edge).
        if (!strip) { line.style.visibility = 'hidden'; surface.hidden = false; strip = playheadStrip(surface, scroll, line.offsetParent as HTMLElement, painter(), label.offsetLeft + label.offsetWidth + 1); origin = line.offsetLeft; shown = NaN; }
        strip.draw(origin + x);
      } else {
        if (strip) { strip.dispose(); strip = undefined; surface.hidden = true; }
        if (x !== shown) { shown = x; line.style.visibility = 'visible'; line.style.transform = `translateX(${x}px)`; }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); strip?.dispose(); surface.hidden = true; };
  }, [reducedMotion, scroller]);
  return <>
    <div ref={element} className="remote-playhead" style={{left:164,visibility:'hidden','--user-color':color} as CSSProperties}><span>{name}</span></div>
    <canvas ref={canvas} className="remote-playhead-canvas" hidden aria-hidden="true"/>
  </>;
}
export function PeoplePanel() {
  const presence=useEditorStore(s=>s.presence);
  const users=useEditorStore(s=>s.users);
  const currentUserId=useEditorStore(s=>s.currentUserId);
  const projectId=useEditorStore(s=>s.projectId);
  const project=useEditorStore(s=>s.projects.find(p=>p.id===s.projectId));
  const liveMode=useEditorStore(s=>s.liveMode);
  const [expanded,setExpanded]=useState<string|null>('ashley');
  const s=useEditorStore.getState;
  return <section className="collaboration-panel panel"><header className="panel-header"><Users size={15}/><h2>People</h2><Badge>{project?.members.length??1}</Badge><span className="spacer"/><IconButton label="Close people panel" onClick={()=>s().setSidePanel(null)}><X size={14}/></IconButton></header><div className="people-intro"><p>Everyone has their own playhead. Join a live session to watch together.</p></div><div className="people-list">{users.filter(user=>project?.members.some(m=>m.userId===user.id)).map(user=>{const p=presence.find(x=>x.userId===user.id&&x.projectId===projectId);const member=project?.members.find(m=>m.userId===user.id);return <div key={user.id} className={`person ${expanded===user.id?'expanded':''}`}><button className="person-main" onClick={()=>setExpanded(expanded===user.id?null:user.id)}><Avatar user={user} size={33}/><div><b>{user.name}{user.id===currentUserId&&<span className="muted"> (you)</span>}</b><span><i className="status-dot" style={{background:user.color}}/>{user.id===currentUserId?'Editing':p?.online?p.activity:'Offline'}{p&&<span className="mono"> · {timecode(p.playhead).slice(3)}</span>}</span></div><Badge>{project?.members.find(m=>m.userId===user.id)?.role??'Editor'}</Badge></button>{expanded===user.id&&user.id!==currentUserId&&<motion.div initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} className="person-actions"><Button variant="ghost" disabled={!p?.online} onClick={()=>s().setLiveMode('following',user.id)}><Play size={12}/>Follow playhead</Button><Button variant="ghost" onClick={()=>{if(p?.selectedClipId){s().selectClip(p.selectedClipId);s().setSidePanel('inspector');}else s().notify(`${user.name} has no selection`,'info');}}><ArrowUpRight size={13}/>View selection</Button>{project?.shared&&member?.role!=='Owner'&&project.members.some(m=>m.userId===currentUserId&&m.role==='Owner')&&<label className="person-role">Role<select aria-label={`Role for ${user.name}`} value={member?.role} onChange={e=>{const role=e.target.value;void connection.flush().then(()=>api(`/projects/${encodeURIComponent(project.id)}/members/${encodeURIComponent(user.id)}`,{method:'PATCH',body:JSON.stringify({role})})).then(()=>connection.refresh()).catch(error=>s().notify(error.message,'error'));}}>{['Editor','Commenter','Viewer'].map(role=><option key={role}>{role}</option>)}</select></label>}</motion.div>}</div>;})}</div><div className="people-live-card"><Radio size={22}/><b>Live playback</b><p>Lead a classroom review with synchronized playback.</p><Button variant="primary" onClick={()=>s().setLiveMode(liveMode==='presenting'?'independent':'presenting')}>{liveMode==='presenting'?'Stop presenting':'Present Project'}</Button></div><footer className="panel-footnote"><span className="status-dot"/>Live studio sessions</footer></section>;
}
export function CommentsPanel() {
  const comments=useEditorStore(s=>s.comments);
  const users=useEditorStore(s=>s.users);
  const projectId=useEditorStore(s=>s.projectId);
  const playhead=usePanelPlayhead();
  const selectedClipId=useEditorStore(s=>s.selectedClipId);
  const [text,setText]=useState('');
  const [attachment,setAttachment]=useState('timestamp');
  const [showResolved,setShowResolved]=useState(false);
  const [replyId,setReplyId]=useState<string|null>(null);
  const [reply,setReply]=useState('');
  const s=useEditorStore.getState;
  const filtered=comments.filter(c=>c.projectId===projectId&&(showResolved||!c.resolved));
  return <section className="comments-panel panel"><header className="panel-header"><MessageSquare size={15}/><h2>Comments</h2><Badge>{comments.filter(c=>c.projectId===projectId&&!c.resolved).length}</Badge><span className="spacer"/><IconButton label="Close comments" onClick={()=>s().setSidePanel(null)}><X size={14}/></IconButton></header><div className="comments-filter"><span>Comments</span><label><input type="checkbox" checked={showResolved} onChange={e=>setShowResolved(e.target.checked)}/> Resolved</label></div><div className="comments-list">{filtered.length===0&&<EmptyState icon={<MessageSquare size={25}/>} title="No comments" description="Add a comment at the playhead."/>}{filtered.map(c=>{const user=users.find(u=>u.id===c.userId)??users[0];return <article className={`comment ${c.resolved?'resolved':''}`} key={c.id}><div className="comment-heading"><Avatar user={user} size={26}/><b>{user.name}</b><span className="spacer"/><IconButton label={`${c.resolved?'Reopen':'Resolve'} comment by ${user.name}`} className={c.resolved?'active':''} onClick={()=>s().resolveComment(c.id)}><Check size={13}/></IconButton></div><button className="comment-time mono" onClick={()=>{if(c.timelineId&&c.timelineId!==s().timelineId)s().setTimeline(c.timelineId);s().setPlayhead(c.time);}}><Clock3 size={11}/>{timecode(c.time)}{c.range&&` – ${timecode(c.range[1])}`}{c.clipId&&<span> · Clip</span>}</button><p>{c.text}</p>{c.replies.map(r=>{const ru=users.find(u=>u.id===r.userId)??users[0];return <div className="comment-reply" key={r.id}><CornerDownRight size={12}/><div><b style={{color:ru.color}}>{ru.name}</b><p>{r.text}</p></div></div>;})}{replyId===c.id?<form className="reply-form" onSubmit={e=>{e.preventDefault();if(reply.trim()){s().replyComment(c.id,reply.trim());setReply('');setReplyId(null);}}}><input autoFocus aria-label="Reply text" value={reply} onChange={e=>setReply(e.target.value)} placeholder="Write a reply…"/><IconButton label="Post reply" type="submit" disabled={!reply.trim()}><Send size={13}/></IconButton></form>:<button className="text-button comment-reply-button" onClick={()=>setReplyId(c.id)}>Reply{c.resolved?' · Resolved':''}</button>}</article>;})}</div><form className="comment-composer" onSubmit={e=>{e.preventDefault();if(text.trim()){s().addComment(text.trim(),attachment==='clip'&&selectedClipId?{clipId:selectedClipId}:attachment==='range'?{range:[s().playhead,s().playhead+5]}:undefined);setText('');}}}><div className="comment-composer-meta"><span className="mono">{timecode(playhead)}</span><select aria-label="Comment attachment" value={attachment} onChange={e=>setAttachment(e.target.value)}><option value="timestamp">At playhead</option><option value="clip" disabled={!selectedClipId}>Selected clip</option><option value="range">Next 5 seconds</option></select></div><textarea aria-label="Comment text" placeholder="Add a comment…" rows={3} value={text} onChange={e=>setText(e.target.value)}/><Button variant="primary" type="submit" disabled={!text.trim()}><Send size={12}/>Post comment</Button></form></section>;
}
export function Notifications() {
  const notifications=useEditorStore(s=>s.notifications);
  return <div className="toast-stack" aria-live="polite" aria-relevant="additions"><AnimatePresence>{notifications.slice(-4).map(n=><motion.div layout initial={{opacity:0,y:14,scale:.97}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,x:24}} transition={{duration:.2}} className={`toast toast-${n.kind}`} key={n.id}><span className="toast-symbol">{n.kind==='success'?<Check size={16}/>:<Radio size={16}/>}</span><div><b>{n.title}</b>{n.detail&&<p>{n.detail}</p>}</div><IconButton label="Dismiss notification" onClick={()=>useEditorStore.getState().dismissNotification(n.id)}><X size={13}/></IconButton></motion.div>)}</AnimatePresence></div>;
}
