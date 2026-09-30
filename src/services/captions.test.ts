import assert from 'node:assert/strict';
import test from 'node:test';
import { captionDocument, captionSignature, groupCaptionWords, demoCaptionWords, validateWords } from './captions.ts';
import { useEditorStore } from '../state/store.ts';
import { getText } from './text.ts';

test('caption grouping preserves word times; editing, regrouping, undo and source invalidation',()=>{
  const words=[...demoCaptionWords,{text:'Again.',start:4,end:4.6}];
  assert.deepEqual(groupCaptionWords(words,5).map(g=>g.length),[5,1]);
  assert.deepEqual(groupCaptionWords(words,3).flat(),words);
  assert.throws(()=>validateWords([{text:'bad',start:2,end:1}]));
  const before=useEditorStore.getState(),project=before.projects.find(p=>p.id===before.projectId)!;
  const signature=captionSignature(before.clips,before.tracks,before.timelineId,0,10);
  assert.equal(captionSignature(before.clips.map(c=>({...c,properties:{...c.properties,x:80}})),before.tracks,before.timelineId,0,10),signature);
  // An emptied captions track stays out of the fingerprint, or the next set is stale the moment it lands.
  assert.equal(captionSignature(before.clips,[...before.tracks,{...before.tracks[0],id:'empty-captions',captionSets:[]}],before.timelineId,0,10),signature);
  try {
    useEditorStore.setState({currentUserId:project.members.find(m=>m.role==='Owner')!.userId,locks:[]});
    const s=useEditorStore.getState;
    s().installCaptions({id:'job-test',projectId:before.projectId,timelineId:before.timelineId,status:'complete',stage:'Ready',progress:100,start:0,end:10,trackIds:[],signature,words},5,'highlight');
    const track=s().tracks.find(t=>t.captionSets)!,set=track.captionSets![0],lines=s().clips.filter(c=>c.properties.captionSet===set.id);
    assert.equal(lines.length,2);assert.equal(s().selectedClipId,lines[0].id);
    assert.equal(captionSignature(s().clips,s().tracks,before.timelineId,0,10),signature,'Adding captions does not invalidate them');
    const original=getText(lines[0]).caption!.words;
    s().updateCaption(lines[0].id,original.map((w,i)=>i? w:{...w,text:'Let'}));
    s().regroupCaptions(set.id,3);
    assert.equal(s().clips.filter(c=>c.properties.captionSet===set.id).length,3);
    assert.equal(getText(s().clips.find(c=>c.properties.captionSet===set.id)!).caption!.words[0].text,'Let');
    s().undo();assert.equal(s().clips.filter(c=>c.properties.captionSet===set.id).length,2);
    const clip=s().clips.find(c=>c.id===lines[0].id)!;s().trimClip(clip.id,clip.start,clip.duration+1);
    assert.equal(getText(s().clips.find(c=>c.id===clip.id)!).caption!.duration,clip.duration+1);
    const source=before.clips.find(c=>c.start<10&&!c.properties.captionSet);
    if(source)assert.notEqual(captionSignature(before.clips.map(c=>c===source?{...c,start:c.start+.5}:c),before.tracks,before.timelineId,0,10),signature);
    s().installCaptions({id:'second-job',projectId:before.projectId,timelineId:before.timelineId,status:'complete',stage:'Ready',progress:100,start:20,end:25,trackIds:[],signature,words:demoCaptionWords.map(w=>({...w,start:w.start+20,end:w.end+20}))},5,'movie');
    const second=s().clips.find(c=>c.start>=20&&c.properties.captionSet)!;assert.ok(second);
    s().installCaptions({id:'replacement-job',projectId:before.projectId,timelineId:before.timelineId,status:'complete',stage:'Ready',progress:100,start:0,end:10,trackIds:[],signature,words},5,'movie',set.id);
    assert.ok(s().clips.some(c=>c.id===second.id),'Regeneration preserves other sets');
    s().regroupCaptions(set.id,0);assert.match(s().notifications.at(-1)!.title,/1–15/,'Invalid grouping is reported without throwing');
    assert.equal(captionDocument(words,'movie',10).caption!.preset,'movie');
  } finally {useEditorStore.setState(before);}
});

test('preview scrubbing gives entrances and exits room without reversing time', async()=>{
  const {previewTime}=await import('./timecode.ts');
  assert.equal(previewTime(.4,2.7,.19,.1),.19);
  assert.ok(Math.abs(previewTime(.6,2.7,.19,.1)-2.6)<1e-10);
  assert.equal(previewTime(1,2.7,.19,.1),2.7);
  let previous=-1;for(let i=0;i<=100;i++){const current=previewTime(i/100,5,1,.65);assert.ok(current>=previous);previous=current;}
});


test('caption registration follows the last line; overlaps and replacements remain undoable',()=>{
  const before=useEditorStore.getState(),s=useEditorStore.getState,project=before.projects.find(p=>p.id===before.projectId)!;
  try {
    useEditorStore.setState({currentUserId:project.members.find(m=>m.role==='Owner')!.userId,locks:[],selectedClipIds:[]});
    const job={id:'first-overlap',projectId:before.projectId,timelineId:before.timelineId,status:'complete' as const,stage:'Ready',progress:100,start:0,end:3,trackIds:[],signature:'test',words:demoCaptionWords};
    s().installCaptions(job,3,'pull-in');
    const first=s().tracks.flatMap(t=>t.captionSets??[]).find(m=>m.jobId===job.id)!,lines=s().clips.filter(c=>c.properties.captionSet===first.id);
    s().installCaptions({...job,id:'keep-overlap'},3,'movie');
    const second=s().tracks.flatMap(t=>t.captionSets??[]).find(m=>m.jobId==='keep-overlap')!;
    assert.ok(second,'Overlapping sets can coexist');
    s().selectClip(lines[0].id);s().deleteClip(lines[0].id);
    assert.ok(s().tracks.some(t=>t.captionSets?.some(m=>m.id===first.id)),'Partial deletion preserves registration');
    s().selectClip(lines[1].id);s().deleteClip(lines[1].id);
    assert.ok(!s().tracks.some(t=>t.captionSets?.some(m=>m.id===first.id)),'Last deletion removes registration');
    assert.ok(s().tracks.some(t=>t.captionSets?.some(m=>m.id===second.id)));
    s().undo();assert.ok(s().clips.some(c=>c.id===lines[1].id));assert.ok(s().tracks.some(t=>t.captionSets?.some(m=>m.id===first.id)),'Undo restores registration with its line');
    s().installCaptions({...job,id:'replace-overlap',removeSets:[first.id]},3,'highlight');
    assert.ok(!s().clips.some(c=>c.properties.captionSet===first.id));assert.ok(!s().tracks.some(t=>t.captionSets?.some(m=>m.id===first.id)));
    assert.ok(s().clips.some(c=>c.properties.captionSet===second.id),'Replacement preserves sets not chosen for removal');
    s().undo();assert.ok(s().clips.some(c=>c.id===lines[1].id));
    const doc=getText(s().clips.find(c=>c.id===lines[1].id)!);doc.caption={...doc.caption!,entranceDuration:.03,exitDuration:0};
    s().updateText([{id:lines[1].id,doc}]);s().styleCaptions(first.id,'pink-bounce');
    assert.equal(getText(s().clips.find(c=>c.id===lines[1].id)!).caption!.entranceDuration,.03,'Preset changes retain custom timing');
    assert.equal(getText(s().clips.find(c=>c.id===lines[1].id)!).caption!.exitDuration,0);
  } finally {useEditorStore.setState(before);}
});

test('reel captions: accent, snap pop with motion blur, thick outline and restyle that keeps custom styling', async()=>{
  const {validateCaption,snapZoom,restyleCaption,captionPreset}=await import('./captions.ts');
  const {drawText}=await import('./text.ts');
  const {createCanvas,GlobalFonts}=await import('@napi-rs/canvas');
  GlobalFonts.registerFromPath('public/fonts/Montserrat.ttf','Montserrat');
  const words=[{text:'SHOT',start:0,end:.4},{text:'TRACKER',start:.4,end:.9}];
  assert.throws(()=>validateCaption({words,preset:'reel',duration:1,accent:'lime'}),/#rrggbb/);
  assert.throws(()=>validateCaption({words,preset:'reel',duration:1,wordPop:'yes' as unknown as boolean}));
  validateCaption({words,preset:'reel',duration:1,accent:'#c4f876',wordPop:true});
  assert.ok(Math.abs(snapZoom(0)-.8)<1e-9&&Math.abs(snapZoom(1)-1)<1e-9);
  const peak=Math.max(...Array.from({length:201},(_,i)=>snapZoom(i/200)));assert.ok(Math.abs(peak-1.06)<.003,`overshoot peaks at 1.06, got ${peak}`);

  const custom={...captionDocument(words,'movie',1),outlineWidth:25,y:.62};custom.runs[0].style={...custom.runs[0].style,fontFamily:'FL-montserrat-black',fontSize:190};
  custom.caption={...custom.caption!,accent:'#c4f876',wordPop:true};
  const reel=restyleCaption(custom,'reel');
  assert.equal(reel.caption!.preset,'reel');assert.equal(reel.outlineWidth,25);assert.equal(reel.y,.62);
  assert.equal(reel.runs[0].style.fontFamily,'FL-montserrat-black');assert.equal(reel.runs[0].style.fontSize,190);
  assert.equal(reel.runs[0].style.fontWeight,captionPreset('reel').weight,'untouched style follows the new preset');
  assert.equal(reel.caption!.accent,'#c4f876');assert.equal(reel.caption!.wordPop,true);

  const doc={...captionDocument(words,'reel',1),y:.6,outlineWidth:25};doc.runs[0].style={...doc.runs[0].style,fontSize:170};doc.caption={...doc.caption!,accent:'#c4f876',wordPop:true};
  const frame=(time:number)=>{const canvas=createCanvas(540,960),ctx=canvas.getContext('2d');drawText(ctx as unknown as CanvasRenderingContext2D,doc,540,960,1080,1920,time);return ctx.getImageData(0,0,540,960).data;};
  const settled=frame(.8),popping=frame(.47);
  let accent=0,dark=0,partial=0;
  for(let i=0;i<settled.length;i+=4){const [r,g,b,a]=[settled[i],settled[i+1],settled[i+2],settled[i+3]];if(a>200&&Math.abs(r-0xc4)<20&&Math.abs(g-0xf8)<20&&Math.abs(b-0x76)<20)accent++;if(a>200&&r<40&&g<40&&b<40)dark++;}
  for(let i=3;i<popping.length;i+=4)if(popping[i]>20&&popping[i]<200)partial++;
  assert.ok(accent>500,`the active word takes the accent color (${accent} px)`);
  assert.ok(dark>2000,`a thick outline surrounds the letters (${dark} px)`);
  let changed=0;for(let i=0;i<settled.length;i++)if(Math.abs(settled[i]-popping[i])>30)changed++;
  assert.ok(changed>1000,'the spoken word is mid-pop');assert.ok(partial>1500,`temporal samples blur the pop (${partial} soft px)`);
});
