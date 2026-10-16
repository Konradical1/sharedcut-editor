import type { Clip, GradeNode, MediaAsset, Operation, Project, ProjectState, Track, User } from '../state/models.ts';

export interface ReplayAuthor { id: string; name: string; color: string; actions: number }
export interface ReplayClip { id: string; track: string; media: string; name: string; start: number; duration: number; sourceIn: number; color: string }
export interface ReplayFrame {
  at: number; timestamp: number; actionCount: number; author: string; action: string; type: string;
  focus: string | null; clips: ReplayClip[]; tracks: Pick<Track, 'id' | 'name' | 'kind' | 'number'>[];
  preview: { clip: Clip; nodes: GradeNode[] } | null;
}
export interface ReplayMedia { id: string; name: string; kind: string; thumbnail?: string; video?: string; duration: number; fps: number; inputProfile?: string; inputGamut?: string; waveform: number[] }
export interface ReplayPackage {
  version: 1; slug: string; title: string; duration: number; timelineWindow: number; sourceActions: number;
  sourceAssets: number; sourceClips: number; firstTimestamp: number; lastTimestamp: number;
  authors: ReplayAuthor[]; media: ReplayMedia[]; frames: ReplayFrame[];
  chapters: { at: number; label: string }[];
  /** One prerendered film that follows the replay shot by shot. */
  film?: string;
  provenance: { cursorMotion: 'illustrated'; idleTime: 'compressed'; preview: 'source-and-recorded-color'; checkpointCorrections: number };
}
export interface HistoryBundle extends ProjectState { project: Project; media: MediaAsset[]; operations: Operation[] }
interface Change { collection: keyof ProjectState; id: string; value: Record<string, unknown> | null; replace?: boolean; unset?: string[] }
const collections = ['clips', 'tracks', 'nodes', 'comments', 'timelines'] as const;
// Plan rows (script, shot list, mood board) are not part of the cut a replay shows, so their history is skipped, not refused.
const planCollections: readonly string[] = ['scripts', 'scriptBlocks', 'shots', 'boardItems'];
const clone = <T>(v: T): T => structuredClone(v);
const safeParts = (key: string) => { const parts=key.split('.'); if(parts.some(p=>['__proto__','constructor','prototype'].includes(p)))throw Error('Unsafe history field');return parts; };

/** Apply a historical operation, including explicit undo records. The undone flag is not an instruction to skip history. */
export function applyReplayChanges(state: ProjectState, raw: unknown) {
  if(!Array.isArray(raw))throw Error('Invalid historical changes');
  for(const change of raw as Change[]) {
    if(planCollections.includes(change.collection))continue;
    if(!collections.includes(change.collection)||typeof change.id!=='string')throw Error('Invalid historical collection');
    const items=(state[change.collection]??=[]) as unknown as Record<string, unknown>[];
    const index=items.findIndex(x=>x.id===change.id);
    if(change.value===null){if(index>=0)items.splice(index,1);continue;}
    if(change.replace){if(index<0)items.push(clone(change.value));else items[index]=clone(change.value);continue;}
    if(index<0)continue;
    for(const[key,value]of Object.entries(change.value)){
      const parts=safeParts(key);let target=items[index];
      for(const part of parts.slice(0,-1)){if(!target[part]||typeof target[part]!=='object')target[part]={};target=target[part] as Record<string,unknown>;}
      target[parts.at(-1)!]=clone(value);
    }
    for(const key of change.unset??[]){const parts=safeParts(key);let target:Record<string,unknown>|undefined=items[index];for(const part of parts.slice(0,-1))target=target?.[part] as typeof target;if(target)delete target[parts.at(-1)!];}
  }
}

export function orderedHistory(operations: Operation[]) {
  return operations.map((operation,index)=>({operation,index})).sort((a,b)=>a.operation.timestamp-b.operation.timestamp||b.index-a.index).map(x=>x.operation);
}

/** In-memory only. Never mutates the project being showcased. */
export function reconstructHistory(bundle: HistoryBundle) {
  const current:ProjectState=Object.fromEntries(collections.map(k=>[k,clone(bundle[k]??[])])) as unknown as ProjectState;
  const baseline=clone(current), operations=orderedHistory(bundle.operations);
  for(const op of [...operations].reverse())applyReplayChanges(baseline,op.oldState);
  const replay=clone(baseline);for(const op of operations)applyReplayChanges(replay,op.newState);
  const stable=(value:unknown):string=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
  const differences=collections.flatMap(k=>{const a=current[k]??[],b=replay[k]??[],ids=new Set([...a,...b].map(x=>x.id));return[...ids].filter(id=>stable(a.find(x=>x.id===id))!==stable(b.find(x=>x.id===id))).map(id=>`${k}:${id}`);});
  return { baseline, operations, differences };
}

const verbs:Record<string,string>={ClipAdded:'adds footage',ClipMoved:'moves a shot',ClipTrimmed:'finds the cut',ClipDeleted:'tightens the edit',PropertyChanged:'refines a shot',GradeNodeChanged:'shapes the color',GradeNodeAdded:'builds a grade',EffectAdded:'adds an effect',TrackCreated:'adds a track',TrackChanged:'balances a track',MarkerChanged:'marks a moment',CommentAdded:'leaves feedback',CommentChanged:'reviews feedback',SnapshotRestored:'restores an edit'};
const colorKeys=['colorPipeline','inputProfile','inputGamut','inputExposure','inputTemperature','exposure','contrast','saturation'];

/** Compile a public, visual-only package. Account email, comments, paths, and raw history never enter it. */
export function compileReplay(bundle: HistoryBundle, users: User[], options: { slug?: string; seconds?: number; window?: number; frames?: number }={}) {
  const {baseline,operations,differences}=reconstructHistory(bundle);
  if(!operations.length)throw Error('This project has no recorded editing history');
  const byId=new Map(users.map(u=>[u.id,u])), canonical=new Map<string,string>(), authors:ReplayAuthor[]=[];
  // First names only leave the history, and every editor gets a cursor color nobody else has.
  const palette=['#F06A70','#B298F5','#78AAEF','#EBC876','#87C9AC','#ED99C4'];
  for(const op of operations){const user=byId.get(op.userId),full=user?.name==='Test'?'Konrad':user?.name??'Editor',name=full.split(' ')[0].replace(/^./,c=>c.toUpperCase());let author=authors.find(a=>a.name===name);if(!author){const wanted=users.find(u=>u.name===full)?.color??user?.color??palette[0],taken=(c:string)=>authors.some(a=>a.color.toLowerCase()===c.toLowerCase());author={id:`editor-${authors.length+1}`,name,color:taken(wanted)?palette.find(c=>!taken(c))??wanted:wanted,actions:0};authors.push(author);}author.actions++;canonical.set(op.userId,author.id);}
  const timeline=bundle.timelines?.filter(t=>!t.composition).sort((a,b)=>bundle.clips.filter(c=>c.timelineId===b.id).length-bundle.clips.filter(c=>c.timelineId===a.id).length)[0];
  if(!timeline)throw Error('No main timeline to replay');
  const window=options.window??125, mediaById=new Map(bundle.media.map(m=>[m.id,m]));
  const state=clone(baseline),frames:ReplayFrame[]=[];
  const snapshot=(op:Operation|undefined,index:number)=>{
    const visible=state.clips.filter(c=>c.timelineId===timeline.id&&c.start<window&&c.start+c.duration>0);
    const touched=(op?.newState as Change[]|undefined)?.flatMap(c=>c.collection==='clips'?[c.id]:c.collection==='nodes'?[state.nodes.find(n=>n.id===c.id)?.clipId??'']:[])??[];
    const video=(c:Clip)=>mediaById.get(c.mediaId)?.kind==='video'&&state.tracks.find(t=>t.id===c.trackId)?.kind==='video';
    const focus=visible.find(c=>touched.includes(c.id)&&video(c))??visible.find(c=>touched.includes(c.id))??visible.filter(video)[Math.min(Math.floor(index/Math.max(1,operations.length)*visible.filter(video).length),Math.max(0,visible.filter(video).length-1))];
    const picture=focus&&video(focus)?focus:visible.find(video);
    const tracks=state.tracks.filter(t=>t.timelineId===timeline.id).sort((a,b)=>a.kind===b.kind?a.number-b.number:a.kind==='video'?-1:1).map(({id,name,kind,number})=>({id,name,kind,number}));
    const nodes=picture?state.nodes.filter(n=>n.clipId===picture.id&&!n.mask).map(n=>({id:n.id,projectId:'showcase',clipId:picture.id,name:n.name,kind:n.kind,enabled:n.enabled,order:n.order,parameters:clone(n.parameters),...(n.curves?{curves:clone(n.curves)}:{}),...(n.effects?{effects:clone(n.effects.filter(e=>e.type==='cst'))}:{} )})):[];
    const preview=picture?{clip:{id:picture.id,projectId:'showcase',timelineId:timeline.id,trackId:picture.trackId,mediaId:picture.mediaId,name:picture.name,start:picture.start,duration:picture.duration,sourceIn:picture.sourceIn,color:picture.color,disabled:false,properties:Object.fromEntries(colorKeys.filter(k=>k in picture.properties).map(k=>[k,picture.properties[k]])),effects:[]},nodes}:null;
    frames.push({at:0,timestamp:op?.timestamp??operations[0].timestamp,actionCount:index,author:op?canonical.get(op.userId)!:'',action:op?verbs[op.type]??'refines the edit':'The starting timeline',type:op?.type??'Start',focus:focus?.id??null,tracks,preview,clips:visible.map(c=>({id:c.id,track:c.trackId,media:c.mediaId,name:c.name,start:c.start,duration:c.duration,sourceIn:c.sourceIn,color:c.color}))});
  };
  snapshot(undefined,0);
  // Screen time follows the square root of each person's real edits: the busiest editor still leads, everyone else is seen
  // doing their own edits (all of them when they made only a few). Authorship is never moved between people.
  const counts=new Map<string,number>();for(const op of operations){const a=canonical.get(op.userId)!;counts.set(a,(counts.get(a)??0)+1);}
  const roots=[...counts.values()].reduce((s,n)=>s+Math.sqrt(n),0),target=options.frames??220;
  const strides=new Map([...counts].map(([a,n])=>[a,Math.max(1,Math.round(n/Math.max(target*Math.sqrt(n)/roots,Math.min(n,12))))]));
  const done=new Map<string,number>();
  operations.forEach((op,i)=>{applyReplayChanges(state,op.newState);const author=canonical.get(op.userId)!,n=done.get(author)??0;done.set(author,n+1);if(n%(strides.get(author)??1)!==0&&i<operations.length-1)return;snapshot(op,i+1);});
  // Old versions omitted some cleanup/rebuilds. Finish on the saved checkpoint without inventing authorship.
  for(const key of collections)Object.assign(state,{[key]:clone(bundle[key]??[])});
  snapshot(undefined,operations.length);Object.assign(frames.at(-1)!,{action:'The saved project',type:'Checkpoint',timestamp:bundle.project.modifiedAt});
  const duration=options.seconds??45;
  frames.forEach((f,i)=>f.at=i/(frames.length-1)*duration);
  const media:ReplayMedia[]=bundle.media.map(m=>({id:m.id,name:m.name,kind:m.kind,duration:m.duration,fps:m.fps,inputProfile:m.inputProfile,inputGamut:m.inputGamut,waveform:(m.waveform??[]).filter((_,i,a)=>i%Math.max(1,Math.ceil(a.length/48))===0).slice(0,48)}));
  const dates=new Set<string>(),chapters:ReplayPackage['chapters']=[];
  for(const frame of frames){const label=new Date(frame.timestamp).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/New_York'});if(!dates.has(label)){dates.add(label);chapters.push({at:frame.at,label});}}
  const replay:ReplayPackage={version:1,slug:options.slug??'girls-soccer',title:bundle.project.name,duration,timelineWindow:window,sourceActions:operations.length,sourceAssets:bundle.media.length,sourceClips:bundle.clips.length,firstTimestamp:operations[0].timestamp,lastTimestamp:operations.at(-1)!.timestamp,authors:authors.sort((a,b)=>b.actions-a.actions),media,frames,chapters,provenance:{cursorMotion:'illustrated',idleTime:'compressed',preview:'source-and-recorded-color',checkpointCorrections:differences.length}};
  return {replay,verification:{differences,baselineClips:baseline.clips.length,frames:frames.length}};
}

export function frameAt(replay:ReplayPackage,seconds:number) {
  let lo=0,hi=replay.frames.length-1;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(replay.frames[mid].at<=seconds)lo=mid;else hi=mid-1;}
  return lo;
}
