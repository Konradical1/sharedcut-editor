import type { Clip, Track } from '../state/models.ts';

export interface CaptionWord { text: string; start: number; end: number; uncertain?: boolean }
/** `accent` overrides the preset's highlight color (and turns the highlight on); `wordPop` pops each word as it is spoken. */
export interface CaptionData { words: CaptionWord[]; preset: string; duration: number; entranceDuration?: number; exitDuration?: number; accent?: string; wordPop?: boolean }
export interface CaptionSet { id: string; start: number; end: number; signature: string; trackIds: string[]; wordsPerLine: number; preset: string; jobId: string }
export interface CaptionJob { wordsPerLine?: number; preset?: string; replaceSet?: string; removeSets?: string[]; id: string; projectId: string; timelineId: string; status: 'waiting'|'running'|'complete'|'failed'|'cancelled'; stage: string; progress: number; start: number; end: number; trackIds: string[]; signature: string; words?: CaptionWord[]; error?: string }
export const captionPresets = [
  { id:'movie', name:'Movie', group:'Cinema', font:'TikTok Sans', weight:500, color:'#ffffff', accent:'#ffffff', motion:'none', highlight:false, outline:0, backing:false },
  { id:'soft-cinema', name:'Soft cinema', group:'Cinema', font:'TikTok Sans', weight:500, color:'#fff3dc', accent:'#fff3dc', motion:'fade', highlight:false, outline:0, backing:false },
  { id:'documentary', name:'Documentary', group:'Cinema', font:'TikTok Sans', weight:600, color:'#ffffff', accent:'#ffffff', motion:'none', highlight:false, outline:0, backing:true },
  { id:'silver', name:'Silver fade', group:'Cinema', font:'Montserrat', weight:500, color:'#edf0f5', accent:'#edf0f5', motion:'fade', highlight:false, outline:0, backing:false },
  { id:'highlight', name:'Lime highlight', group:'Social', font:'TikTok Sans', weight:800, color:'#ffffff', accent:'#c7ff59', motion:'pop', highlight:true, outline:3, backing:false },
  { id:'sunshine', name:'Sunshine', group:'Social', font:'Montserrat', weight:800, color:'#ffffff', accent:'#ffe354', motion:'rise', highlight:true, outline:3, backing:false },
  { id:'punch', name:'White punch', group:'Social', font:'Barlow Condensed', weight:700, color:'#ffffff', accent:'#ffffff', motion:'pop', highlight:false, outline:4, backing:false },
  { id:'pull-in', name:'Electric pull-in', group:'Social', font:'Montserrat', weight:800, color:'#ffffff', accent:'#67e8ff', motion:'pull', highlight:true, outline:3, backing:false },
  { id:'blur-reveal', name:'Blur reveal', group:'Social', font:'TikTok Sans', weight:800, color:'#ffffff', accent:'#ffffff', motion:'blur', highlight:false, outline:2, backing:false },
  { id:'pink-bounce', name:'Pink bounce', group:'Social', font:'Montserrat', weight:800, color:'#ffffff', accent:'#ff75b5', motion:'bounce', highlight:true, outline:3, backing:false },
  { id:'violet', name:'Violet rush', group:'Social', font:'TikTok Sans', weight:800, color:'#ffffff', accent:'#c3a2ff', motion:'pull', highlight:true, outline:3, backing:false },
  { id:'mint', name:'Mint lift', group:'Social', font:'TikTok Sans', weight:700, color:'#ffffff', accent:'#72ffd2', motion:'rise', highlight:true, outline:2, backing:true },
  { id:'orange', name:'Orange impact', group:'Social', font:'Barlow Condensed', weight:700, color:'#ffb35b', accent:'#ffffff', motion:'pop', highlight:true, outline:4, backing:false },
  { id:'blue', name:'Blue focus', group:'Social', font:'Montserrat', weight:800, color:'#ffffff', accent:'#81bcff', motion:'blur', highlight:true, outline:3, backing:false },
  { id:'lemon', name:'Lemon bounce', group:'Social', font:'Barlow Condensed', weight:700, color:'#ffe354', accent:'#ffffff', motion:'bounce', highlight:true, outline:4, backing:false },
  { id:'clean-sync', name:'Clean sync', group:'Social', font:'TikTok Sans', weight:700, color:'#d6dae2', accent:'#ffffff', motion:'none', highlight:true, outline:1, backing:true },
  { id:'reel', name:'Reel snap', group:'Social', font:'Montserrat', weight:900, color:'#ffffff', accent:'#c4f876', motion:'snap', highlight:true, outline:8, backing:false },
] as const;
export const captionPreset = (id: string) => captionPresets.find(p=>p.id===id) ?? captionPresets[0];
export const isCaption = (clip: Clip) => typeof clip.properties.captionSet === 'string';
export function validateWords(words: unknown, limit=100000): asserts words is CaptionWord[] {
  if(!Array.isArray(words)||words.length>limit)throw new Error('Invalid caption words.');
  let previous=-1;
  for(const word of words) {
    if(!word||typeof word.text!=='string'||!word.text.trim()||word.text.length>200||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<=word.start||word.end>604800||word.start<previous||word.uncertain!==undefined&&typeof word.uncertain!=='boolean')throw new Error('Invalid word text or timing.');
    previous=word.start;
  }
}
export function validateCaption(data: CaptionData) {
  if(!data||!captionPresets.some(p=>p.id===data.preset)||!Number.isFinite(data.duration)||data.duration<=0||data.duration>604800)throw new Error('Invalid caption style or duration.');
  for(const value of [data.entranceDuration,data.exitDuration])if(value!==undefined&&(!Number.isFinite(value)||value<0||value>5))throw new Error('Caption animation duration must be between 0 and 5 seconds.');
  if(data.accent!==undefined&&(typeof data.accent!=='string'||!/^#[\da-f]{6}$/i.test(data.accent)))throw new Error('Caption highlight color must be a #rrggbb color.');
  if(data.wordPop!==undefined&&typeof data.wordPop!=='boolean')throw new Error('Invalid caption word pop.');
  validateWords(data.words,1000);
}
export function validateCaptionSets(sets: CaptionSet[]) {
  if(!Array.isArray(sets)||sets.length>200)throw new Error('Invalid caption sets.');
  const ids=new Set();
  for(const s of sets) {
    if(!s||typeof s.id!=='string'||!s.id||s.id.length>160||ids.has(s.id)||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<=s.start||s.end>21600||typeof s.signature!=='string'||s.signature.length>100||!Array.isArray(s.trackIds)||s.trackIds.length>1000||s.trackIds.some(id=>typeof id!=='string'||id.length>160)||!Number.isInteger(s.wordsPerLine)||s.wordsPerLine<1||s.wordsPerLine>15||!captionPresets.some(p=>p.id===s.preset)||typeof s.jobId!=='string'||s.jobId.length>160)throw new Error('Invalid caption set.');
    ids.add(s.id);
  }
}
/** Group word timings, never invent new timings when line length changes. */
export function groupCaptionWords(words: CaptionWord[], maxWords: number): CaptionWord[][] {
  validateWords(words);
  if(!Number.isInteger(maxWords)||maxWords<1||maxWords>15)throw new Error('Choose 1–15 words per line.');
  const lines:CaptionWord[][]=[];let line:CaptionWord[]=[];
  for(const word of words) {
    const previous=line.at(-1);
    if(line.length&&(line.length>=maxWords||word.start-previous!.end>.45||/[.!?]["”']?$/.test(previous!.text)||line.map(w=>w.text).join(' ').length+word.text.length>42)) {lines.push(line);line=[];}
    line.push({...word});
  }
  if(line.length)lines.push(line);
  return lines;
}
/** A content fingerprint, not a security hash. Visual edits do not invalidate speech. */
export function captionSignature(clips: Clip[], tracks: Track[], timelineId: string, start: number, end: number, trackIds: string[]=[]): string {
  const audioKeys=['speed','reverse','freeze','gain','pan','normalize','audioDetached','audioFadeIn','audioFadeOut','fadeDuration','fadeOrigin','compositionId'];
  const visit=(id:string,from:number,to:number,depth=0):unknown[]=>{
    if(depth>16)return ['cycle'];
    const localTracks=tracks.filter(t=>t.timelineId===id&&!t.captionSets).sort((a,b)=>a.id.localeCompare(b.id));
    return [localTracks.map(t=>[t.id,t.kind,t.muted,t.solo,t.gain,t.pan]),clips.filter(c=>c.timelineId===id&&!isCaption(c)&&c.mediaId!=='frameline-title'&&c.mediaId!=='frameline-shape'&&c.start<to&&c.start+c.duration>from&&(!trackIds.length||depth>0||trackIds.includes(c.trackId))).sort((a,b)=>a.id.localeCompare(b.id)).map(c=>[c.id,c.mediaId,c.trackId,c.start,c.duration,c.sourceIn,c.disabled,audioKeys.map(k=>c.properties[k]??null),c.effects.filter(e=>['EQ','Compressor','Limiter','Noise Reduction'].includes(e.name)),Object.entries(c.keyframes??{}).filter(([k])=>audioKeys.some(p=>k===`properties.${p}`)||k.startsWith('effects.')).sort(),c.mediaId==='frameline-composition'?visit(String(c.properties.compositionId),0,Infinity,depth+1):null])];
  };
  const value=JSON.stringify(visit(timelineId,start,end));let a=2166136261,b=5381;
  for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b,33)^value.charCodeAt(i);}
  return (a>>>0).toString(16)+(b>>>0).toString(16);
}
export interface SubtitleCue { start: number; end: number; text: string }
/**
 * Caption lines on a timeline, the compositions on it included, cut to [from, to) and timed from `from`
 * (the export's first frame). A disabled line or composition is left out, as the export leaves it out.
 */
export function subtitleCues(clips: Clip[], timelineId: string, from: number, to: number, depth = 0): SubtitleCue[] {
  if (depth > 16) return [];
  const cues = clips.filter(c => c.timelineId === timelineId && !c.disabled && c.start < to && c.start + c.duration > from).flatMap((c): SubtitleCue[] => {
    if (isCaption(c)) { const text = (JSON.parse(String(c.properties.textDocument)) as { runs: { text: string }[] }).runs.map(run => run.text).join('').trim(); return text ? [{ start: c.start, end: c.start + c.duration, text }] : []; }
    // Inside a composition, time runs from the clip's source in at its speed; a reversed or frozen one has no readable order.
    if (c.mediaId !== 'frameline-composition' || c.properties.reverse || c.properties.freeze) return [];
    const rate = Number(c.properties.speed || 100) / 100;
    return subtitleCues(clips, String(c.properties.compositionId), c.sourceIn, c.sourceIn + c.duration * rate, depth + 1).map(q => ({ ...q, start: c.start + q.start / rate, end: c.start + q.end / rate }));
  });
  return cues.map(q => ({ ...q, start: Math.max(q.start, from) - from, end: Math.min(q.end, to) - from })).filter(q => q.end > q.start).sort((a, b) => a.start - b.start || a.end - b.end);
}
const stamp = (ms: number, separator: string) => `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
/** SRT (00:00:01,500, numbered) or WebVTT (00:00:01.500). Overlapping cues stay as they are: players show both. */
export function subtitleFile(cues: SubtitleCue[], format: 'srt' | 'vtt') {
  const blocks = cues.map(q => ({ start: Math.round(q.start * 1000), end: Math.round(q.end * 1000), text: q.text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n') })).filter(q => q.end > q.start && q.text)
    .map((q, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${stamp(q.start, format === 'srt' ? ',' : '.')} --> ${stamp(q.end, format === 'srt' ? ',' : '.')}\n${format === 'vtt' ? q.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : q.text}`);
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}
/** Speech reads as on-time when the highlight lands just after the word starts; earlier feels rushed. */
export const captionHighlightLead = .05;
export const demoCaptionWords:CaptionWord[]='Make every word feel alive'.split(' ').map((text,i)=>({text,start:i*.46,end:i*.46+.4}));

export function captionDocument(words: CaptionWord[], presetId: string, duration: number): import('./text.ts').TextDocument {
  const p=captionPreset(presetId);
  return {caption:{words,preset:p.id,duration},runs:[{text:words.map(w=>w.text).join(' '),style:{fontFamily:p.font,fontSize:p.group==='Cinema'?52:76,fontWeight:p.weight,italic:false,underline:false,letterSpacing:0,color:p.color}}],x:.08,y:.78,width:.84,height:.18,align:'center',lineHeight:1.15,opacity:100,outlineColor:'#101116',outlineWidth:p.outline,shadowColor:'#000000',shadowOpacity:75,shadowBlur:8,shadowX:0,shadowY:4};
}

export function captionTiming(data: CaptionData) {
  const motion=captionPreset(data.preset).motion;
  return {entranceDuration:data.entranceDuration??(motion==='none'?0:motion==='fade'?.055:motion==='snap'?.18:.16),exitDuration:data.exitDuration??(motion==='none'?0:.065)};
}

/** Scale for a snap pop: 0.8 → 1.06 → 1.0 on an easeOutBack whose overshoot is exactly that 6%. */
export function snapZoom(progress: number) {
  const u=Math.max(0,Math.min(1,progress)),c1=3.39,x=u-1;
  return .8+.2*(1+(c1+1)*x**3+c1*x*x);
}
/** How long a spoken word's own pop lasts when `wordPop` is on. */
export const wordPopDuration=.18;

/**
 * Switch a line's preset without losing what the editor changed: any style the line holds that differs
 * from its old preset's default (font, size, color, outline, shadow, placement) carries over.
 */
export function restyleCaption(doc: import('./text.ts').TextDocument, presetId: string): import('./text.ts').TextDocument {
  const data=doc.caption!,before=captionDocument(data.words,data.preset,data.duration),next=captionDocument(data.words,presetId,data.duration);
  const effects=(['outlineColor','outlineWidth','shadowColor','shadowOpacity','shadowBlur','shadowX','shadowY'] as const).filter(key=>doc[key]!==undefined&&doc[key]!==before[key]);
  const was=before.runs[0].style,style=doc.runs[0].style;
  const custom=Object.fromEntries(Object.entries(style).filter(([key,value])=>value!==was[key as keyof typeof was]));
  return {...next,...Object.fromEntries(effects.map(key=>[key,doc[key]])),x:doc.x,y:doc.y,width:doc.width,height:doc.height,
    runs:next.runs.map(run=>({...run,style:{...run.style,...custom}})),
    caption:{...next.caption!,entranceDuration:data.entranceDuration,exitDuration:data.exitDuration,accent:data.accent,wordPop:data.wordPop}};
}
